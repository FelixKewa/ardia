#import "ardia/core/ac_vault_sign_in_internal.h"

#import <AppKit/AppKit.h>

#include <algorithm>
#include <set>
#include <sstream>
#include <string_view>

#include "base/strings/string_util.h"

namespace ardiacore {
namespace vault_internal {

namespace {

NSNumber* Milliseconds(base::TimeDelta delta) {
  return @(std::max<int64_t>(0, delta.InMilliseconds()));
}

bool CarriesSession(const char* status) {
  const std::string_view outcome(status);
  return outcome == "signed_in";
}

}

std::set<VaultSignIn*>& Running() {
  static base::NoDestructor<std::set<VaultSignIn*>> running;
  return *running;
}

VaultSignIn::VaultSignIn(Profile* profile, VaultSignInRequest request, VaultSignInDone done)
    : profile_(profile),
      request_(std::move(request)),
      done_(std::move(done)),
      start_(base::TimeTicks::Now()) {
  Running().insert(this);
  profiles_.AddObservation(profile);
}

VaultSignIn::~VaultSignIn() {
  Running().erase(this);
  TearDown();
  transfer_op_.reset();
  DestroyVaultProfile();
}

void VaultSignIn::Start() {
  int same_profile = 0;
  const net::SchemefulSite site(request_.origin);
  for (VaultSignIn* other : Running()) {
    if (other == this || other->settled_ || other->profile_ != profile_) {
      continue;
    }
    if (++same_profile >= kMostPerProfile ||
        net::SchemefulSite(other->request_.origin) == site) {
      Abort("busy");
      return;
    }
  }
  vault_profile_ = profile_->GetOffTheRecordProfile(
      Profile::OTRProfileID::CreateUnique(kVaultProfilePrefix), true);
  profile_ms_ = base::TimeTicks::Now() - start_;
  if (!vault_profile_) {
    Abort("failed");
    return;
  }
  profiles_.AddObservation(vault_profile_);
  transfer_op_ = std::make_unique<VaultTransfer>(profile_, request_.origin);
  policy_ = std::make_unique<VaultRequestPolicy>(
      request_.origin, base::BindRepeating(&VaultSignIn::RequestRefused,
                                           weak_factory_.GetWeakPtr()));
  content::WebContents::CreateParams params(vault_profile_);
  params.initially_hidden = true;
  contents_ = content::WebContents::Create(params);
  contents_->SetDelegate(&contents_delegate_);
  autofill::ChromeAutofillClient::CreateForWebContents(contents_.get());
  ChromePasswordManagerClient::CreateForWebContents(contents_.get());
  NSView* view = contents_->GetNativeView().GetNativeNSView();
  view.frame = NSMakeRect(0, 0, kWidth, kHeight);
  capture_ = contents_->IncrementCapturerCount(
      gfx::Size(kWidth, kHeight), false, false, false);
  Observe(contents_.get());
  forms_ = std::make_unique<LoginFormIndex>(contents_.get());
  forms_->SetChanged(base::BindRepeating(&VaultSignIn::FormsChanged,
                                         weak_factory_.GetWeakPtr()));
  forms_->SetLoginSucceeded(base::BindRepeating(&VaultSignIn::LoginSucceeded,
                                                weak_factory_.GetWeakPtr()));
  auto* client = ChromePasswordManagerClient::FromWebContents(contents_.get());
  if (!client) {
    Abort("failed");
    return;
  }
  const GURL realm_url = request_.origin.GetURL();
  fetcher_ = std::make_unique<password_manager::FormFetcherImpl>(
      password_manager::PasswordFormDigest(
          password_manager::PasswordForm::Scheme::kHtml,
          password_manager_util::GetSignonRealm(realm_url), realm_url),
      client, false);
  fetcher_->AddConsumer(this);
  fetcher_->Fetch();
  deadline_.Start(FROM_HERE, kDeadline,
                  base::BindOnce(&VaultSignIn::DeadlinePassed,
                                 base::Unretained(this)));
  seed_started_ = base::TimeTicks::Now();
  seed_wait_.Start(FROM_HERE, kSeedWait,
                   base::BindOnce(&VaultSignIn::Load, base::Unretained(this)));
  transfer_op_->Seed(vault_profile_, base::BindOnce(&VaultSignIn::Load,
                                                    weak_factory_.GetWeakPtr()));
}

void VaultSignIn::Load() {
  if (!contents_ || !load_started_.is_null()) {
    return;
  }
  seed_wait_.Stop();
  load_started_ = base::TimeTicks::Now();
  seed_ms_ = load_started_ - seed_started_;
  content::NavigationController::LoadURLParams load(request_.url);
  load.transition_type = ui::PAGE_TRANSITION_AUTO_TOPLEVEL;
  contents_->GetController().LoadURLWithParams(load);
}

void VaultSignIn::Cancel() { Abort("cancelled"); }

bool VaultSignIn::Shows(const content::WebContents* contents) const {
  return contents && contents_ && contents == contents_.get();
}

bool VaultSignIn::Uses(content::BrowserContext* context) const {
  return context && vault_profile_ &&
         context == static_cast<content::BrowserContext*>(vault_profile_.get());
}

const url::Origin& VaultSignIn::origin() const { return request_.origin; }

base::WeakPtr<VaultRequestPolicy> VaultSignIn::policy() const {
  return policy_ ? policy_->GetWeakPtr() : nullptr;
}

base::WeakPtr<VaultSignIn> VaultSignIn::GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

void VaultSignIn::PasskeyRequested() {
  if (phase_ == Phase::kDone) {
    return;
  }
  passkey_requested_ = true;
  MaybePasskeyOnly();
}

void VaultSignIn::TearDown() {
  password_.clear();
  code_.reset();
  filler_.reset();
  probe_.reset();
  if (fetcher_) {
    fetcher_->RemoveConsumer(this);
    fetcher_.reset();
  }
  forms_.reset();
  Observe(nullptr);
  capture_.RunAndReset();
  if (contents_) {
    contents_->SetDelegate(nullptr);
  }
  contents_.reset();
  seed_wait_.Stop();
}

void VaultSignIn::DestroyVaultProfile() {
  Profile* vault = vault_profile_.get();
  vault_profile_ = nullptr;
  if (!vault) {
    return;
  }
  if (profiles_.IsObservingSource(vault)) {
    profiles_.RemoveObservation(vault);
  }
  if (!profile_gone_) {
    ProfileDestroyer::DestroyOTRProfileWhenAppropriate(vault);
  }
}

void VaultSignIn::StopTimers() {
  retry_.Stop();
  deadline_.Stop();
  settle_.Stop();
  no_form_.Stop();
  code_wait_.Stop();
}

void VaultSignIn::Conclude(const char* status) {
  if (phase_ == Phase::kDone) {
    return;
  }
  phase_ = Phase::kDone;
  decided_ = status;
  if (submitted_) {
    decide_ = base::TimeTicks::Now() - submitted_at_;
  }
  StopTimers();
  password_.clear();
  code_.reset();
  filler_.reset();
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&VaultSignIn::AfterConclusion,
                                weak_factory_.GetWeakPtr()));
}

void VaultSignIn::Abort(const char* status) {
  if (settled_) {
    return;
  }
  if (transfer_op_ && transfer_op_->sent()) {
    transfer_ = transfer_op_->counts();
    transfer_state_ = "sent";
  }
  phase_ = Phase::kDone;
  decided_ = status;
  StopTimers();
  TearDown();
  Settle(status);
}

void VaultSignIn::AfterConclusion() {
  if (settled_) {
    return;
  }
  TearDown();
  if (!CarriesSession(decided_) || !transfer_op_ || !vault_profile_ ||
      profile_gone_) {
    Settle(decided_);
    return;
  }
  transfer_started_ = base::TimeTicks::Now();
  transfer_wait_.Start(FROM_HERE, kTransferWait,
                       base::BindOnce(&VaultSignIn::TransferTimedOut,
                                      base::Unretained(this)));
  transfer_op_->Run(vault_profile_, base::BindOnce(&VaultSignIn::Transferred,
                                                   weak_factory_.GetWeakPtr()));
}

void VaultSignIn::Transferred(VaultTransferCounts counts) {
  transfer_ = counts;
  transfer_state_ = counts.failed ? "partial" : "complete";
  transfer_done_ = base::TimeTicks::Now();
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::WeakPtr<VaultSignIn> sign_in) {
            if (sign_in) {
              sign_in->Settle(sign_in->decided_);
            }
          },
          weak_factory_.GetWeakPtr()));
}

void VaultSignIn::TransferTimedOut() {
  if (transfer_op_) {
    transfer_ = transfer_op_->counts();
  }
  transfer_state_ = transfer_op_ && transfer_op_->sent() ? "sent" : "timed_out";
  transfer_done_ = base::TimeTicks::Now();
  Settle(decided_);
}

void VaultSignIn::Settle(const char* status) {
  if (settled_) {
    return;
  }
  settled_ = true;
  transfer_wait_.Stop();
  TearDown();
  transfer_op_.reset();
  DestroyVaultProfile();
  const base::TimeTicks now = base::TimeTicks::Now();
  NSDictionary* result = @{
    @"status" : @(status),
    @"readyMs" : ready_.is_null() ? @(-1) : Milliseconds(ready_ - start_),
    @"fillMs" : submitted_ ? Milliseconds(fill_) : @(-1),
    @"totalMs" : Milliseconds(now - start_),
    @"decideMs" : submitted_ ? Milliseconds(decide_) : @(-1),
    @"reason" : reason_ ? @(reason_) : @"",
    @"refills" : @(refills_),
    @"profileMs" : Milliseconds(profile_ms_),
    @"seedMs" : Milliseconds(seed_ms_),
    @"loadMs" : load_ms_.is_zero() ? @(-1) : Milliseconds(load_ms_),
    @"scanMs" : Milliseconds(scan_),
    @"transferMs" : transfer_started_.is_null()
        ? @(-1)
        : Milliseconds((transfer_done_.is_null() ? now : transfer_done_) -
                       transfer_started_),
    @"transfer" : @(transfer_state_),
    @"cookies" : @(transfer_.cookies),
    @"conflicts" : @(transfer_.conflicts),
    @"localStorage" : @(transfer_.local_storage),
    @"transferFailed" : @(transfer_.failed),
    @"blockedRequests" : @(policy_ ? policy_->blocked() : 0),
  };
  auto runner = base::SingleThreadTaskRunner::GetCurrentDefault();
  runner->PostTask(FROM_HERE, base::BindOnce(std::move(done_), result));
  runner->DeleteSoon(FROM_HERE, this);
}

void VaultSignIn::Mark(content::RenderFrameHost* frame) {
  if (!frame || !frame->IsRenderFrameLive()) {
    return;
  }
  mojo::AssociatedRemote<mojom::ACVaultFiller> filler;
  frame->GetRemoteAssociatedInterfaces()->GetInterface(&filler);
  filler->MarkVaultFrame();
}

void VaultSignIn::RenderFrameCreated(content::RenderFrameHost* frame) {
  Mark(frame);
}

void VaultSignIn::ReadyToCommitNavigation(content::NavigationHandle* navigation) {
  Mark(navigation->GetRenderFrameHost());
}

void VaultSignIn::RequestRefused() { Conclude("cross_origin"); }

void VaultSignIn::OnProfileWillBeDestroyed(Profile* profile) {
  if (profile == vault_profile_.get()) {
    profiles_.RemoveObservation(profile);
    vault_profile_ = nullptr;
  } else {
    profiles_.RemoveAllObservations();
    profile_gone_ = true;
    vault_profile_ = nullptr;
    profile_ = nullptr;
  }
  const char* status = phase_ == Phase::kDone ? decided_ : "failed";
  phase_ = Phase::kDone;
  StopTimers();
  transfer_wait_.Stop();
  TearDown();
  Settle(status);
}

VaultSignIn* RunningFor(const content::WebContents* contents) {
  for (VaultSignIn* sign_in : Running()) {
    if (sign_in->Shows(contents)) {
      return sign_in;
    }
  }
  return nullptr;
}

}

using vault_internal::Running;
using vault_internal::RunningFor;
using vault_internal::VaultSignIn;

VaultSignInRequest::VaultSignInRequest() = default;
VaultSignInRequest::VaultSignInRequest(VaultSignInRequest&&) = default;
VaultSignInRequest& VaultSignInRequest::operator=(VaultSignInRequest&&) =
    default;
VaultSignInRequest::~VaultSignInRequest() = default;

base::OnceClosure StartVaultSignIn(Profile* profile,
                                   VaultSignInRequest request,
                                   VaultSignInDone done) {
  auto* sign_in = new VaultSignIn(profile, std::move(request), std::move(done));
  base::OnceClosure cancel =
      base::BindOnce(&VaultSignIn::Cancel, sign_in->GetWeakPtr());
  sign_in->Start();
  return cancel;
}

bool IsVaultBrowserContext(content::BrowserContext* context) {
  Profile* profile = context ? Profile::FromBrowserContext(context) : nullptr;
  if (!profile || !profile->IsOffTheRecord() || profile->IsPrimaryOTRProfile()) {
    return false;
  }
  std::ostringstream id;
  id << profile->GetOTRProfileID();
  return base::StartsWith(id.str(), vault_internal::kVaultProfilePrefix);
}

bool IsVaultSignInFrame(content::RenderFrameHost* frame) {
  return frame && IsVaultBrowserContext(frame->GetBrowserContext());
}

base::WeakPtr<VaultRequestPolicy> VaultRequestPolicyFor(
    content::BrowserContext* context) {
  for (VaultSignIn* sign_in : Running()) {
    if (sign_in->Uses(context)) {
      return sign_in->policy();
    }
  }
  return nullptr;
}

void ClearFilledPasswords(content::WebContents* contents) {
  if (!contents) {
    return;
  }
  contents->ForEachRenderFrameHost([](content::RenderFrameHost* frame) {
    if (!frame->IsRenderFrameLive()) {
      return;
    }
    mojo::AssociatedRemote<mojom::ACVaultFiller> filler;
    frame->GetRemoteAssociatedInterfaces()->GetInterface(&filler);
    filler->ClearFilledPasswords();
  });
}

void NoteVaultPasskeyRequest(content::RenderFrameHost* frame) {
  content::WebContents* contents =
      frame ? content::WebContents::FromRenderFrameHost(frame) : nullptr;
  if (VaultSignIn* sign_in = contents ? RunningFor(contents) : nullptr) {
    sign_in->PasskeyRequested();
  }
}

}
