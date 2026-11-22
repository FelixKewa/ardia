#import "ardia/core/ac_vault_sign_in_internal.h"

#include <algorithm>

namespace ardiacore {
namespace vault_internal {

void VaultSignIn::MaybePasskeyOnly() {
  if (phase_ == Phase::kDone || !passkey_requested_ || !page_loaded_ ||
      filling_) {
    return;
  }
  const std::vector<LoginForm> forms = Usable();
  if (std::ranges::any_of(forms, [](const LoginForm& f) {
        return !f.password.is_null();
      })) {
    return;
  }
  if (phase_ == Phase::kStart &&
      std::ranges::any_of(forms, [](const LoginForm& f) {
        return !f.username.is_null();
      })) {
    return;
  }
  Conclude("needs_passkey");
}

void VaultSignIn::NoForm() {
  Conclude(passkey_requested_ ? "needs_passkey" : "no_form");
}

void VaultSignIn::MaybeNoForm() {
  if (phase_ != Phase::kStart || submitted_ || filling_ || awaiting_code_ ||
      !credential_ready_ || !page_ready_) {
    return;
  }
  const std::vector<LoginForm> forms = Usable();
  if (std::ranges::any_of(forms, [](const LoginForm& f) {
        return !f.password.is_null() ||
               (!f.username.is_null() && f.code.is_null());
      })) {
    no_form_.Stop();
    return;
  }
  if (SignUpOnly()) {
    Conclude("no_form");
    return;
  }
  if (!no_form_.IsRunning()) {
    no_form_.Start(FROM_HERE, kNoFormAfterLoad,
                   base::BindOnce(&VaultSignIn::NoFormTimedOut,
                                  base::Unretained(this)));
  }
}

void VaultSignIn::NoFormTimedOut() {
  if (phase_ != Phase::kStart || submitted_ || filling_ || awaiting_code_) {
    return;
  }
  NoForm();
}

void VaultSignIn::OnFetchCompleted() {
  if (phase_ == Phase::kDone || credential_ready_) {
    return;
  }
  const std::string realm =
      password_manager_util::GetSignonRealm(request_.origin.GetURL());
  bool elsewhere = false;
  for (const password_manager::StoredCredential& match :
       fetcher_->GetNonFederatedMatches()) {
    if (match.username_value != request_.username) {
      continue;
    }
    if (match.signon_realm == realm &&
        password_manager_util::GetMatchType(match) ==
            password_manager_util::GetLoginMatchType::kExact) {
      password_ = match.password_value;
      credential_ready_ = true;
      break;
    }
    elsewhere = true;
  }
  if (!credential_ready_) {
    Conclude(elsewhere ? "cross_origin" : "no_login");
    return;
  }
  Advance();
  MaybeNoForm();
}

void VaultSignIn::FormsChanged(content::RenderFrameHost* frame) {
  if (phase_ == Phase::kDone) {
    return;
  }
  Advance();
  MaybeNoForm();
}

std::optional<LoginForm> VaultSignIn::Pick(
    const std::vector<LoginForm>& forms,
    base::FunctionRef<bool(const LoginForm&)> wanted) const {
  std::optional<LoginForm> picked;
  for (const LoginForm& form : forms) {
    if (wanted(form) && (!picked || (form.main_frame && !picked->main_frame))) {
      picked = form;
    }
  }
  return picked;
}

std::vector<LoginForm> VaultSignIn::Usable() {
  if (!forms_) {
    return {};
  }
  const base::TimeTicks started = base::TimeTicks::Now();
  std::vector<LoginForm> forms = forms_->Forms(request_.origin);
  std::erase_if(forms, [](const LoginForm& form) {
    return !form.same_origin_ancestors || form.sign_up;
  });
  scan_ += base::TimeTicks::Now() - started;
  return forms;
}

void VaultSignIn::Advance() {
  if (phase_ == Phase::kDone || filling_ || awaiting_code_ ||
      !credential_ready_) {
    return;
  }
  const std::vector<LoginForm> forms = Usable();
  if (forms.empty() &&
      (phase_ == Phase::kStart || phase_ == Phase::kUsernameSent) &&
      ElsewhereOnly()) {
    Conclude("cross_origin");
    return;
  }
  if (phase_ == Phase::kStart || phase_ == Phase::kUsernameSent) {
    if (std::optional<LoginForm> form = Pick(forms, [](const LoginForm& f) {
          return !f.password.is_null();
        })) {
      Dispatch(*form, true, true, false, Phase::kPasswordSent);
      return;
    }
    if (phase_ == Phase::kStart) {
      if (std::optional<LoginForm> form = Pick(forms, [](const LoginForm& f) {
            return !f.username.is_null() && f.code.is_null();
          })) {
        Dispatch(*form, true, false, false, Phase::kUsernameSent);
      }
    }
    return;
  }
  if (phase_ == Phase::kPasswordSent && request_.code_provider &&
      Pick(forms, [](const LoginForm& f) {
        return !f.code.is_null() && f.password.is_null();
      })) {
    AskForCode();
  }
}

void VaultSignIn::AskForCode() {
  awaiting_code_ = true;
  code_wait_.Start(FROM_HERE, kCodeWait,
                   base::BindOnce(&VaultSignIn::Conclude,
                                  base::Unretained(this), "needs_human"));
  request_.code_provider.Run(
      base::BindOnce(&VaultSignIn::CodeArrived, weak_factory_.GetWeakPtr()));
}

void VaultSignIn::CodeArrived(std::optional<std::u16string> code) {
  if (!awaiting_code_ || phase_ == Phase::kDone) {
    return;
  }
  awaiting_code_ = false;
  code_wait_.Stop();
  if (!code || code->empty()) {
    Conclude("needs_human");
    return;
  }
  std::optional<LoginForm> form = Pick(Usable(), [](const LoginForm& f) {
    return !f.code.is_null() && f.password.is_null();
  });
  if (!form) {
    Advance();
    return;
  }
  code_ = std::move(code);
  Dispatch(*form, false, false, true, Phase::kCodeSent);
  code_.reset();
}

void VaultSignIn::Dispatch(const LoginForm& form,
              bool username,
              bool password,
              bool code,
              Phase next) {
  if (phase_ == Phase::kDone) {
    return;
  }
  content::RenderFrameHost* frame = content::RenderFrameHost::FromID(form.frame);
  if (!frame) {
    return;
  }
  if (steps_ >= kMostSteps) {
    reason_ = "steps";
    Conclude("failed");
    return;
  }
  retry_.Stop();
  const base::TimeTicks now = base::TimeTicks::Now();
  if (ready_.is_null()) {
    ready_ = now;
  }
  dispatched_ = now;
  filled_node_ = frame->GetFrameTreeNodeId();
  filling_ = true;
  settle_.Stop();
  if (password || code) {
    armed_[frame->GetGlobalId()] = frame->GetFrameTreeNodeId();
    PublishArmed();
  }
  filler_.reset();
  frame->GetRemoteAssociatedInterfaces()->GetInterface(&filler_);
  filler_.set_disconnect_handler(base::BindOnce(
      &VaultSignIn::FillerGone, base::Unretained(this), next));
  auto step = mojom::ACVaultFillStep::New();
  step->form = form.form.value();
  step->username_field = username ? form.username.value() : 0;
  step->password_field = password ? form.password.value() : 0;
  step->code_field = code ? form.code.value() : 0;
  if (username) {
    step->username = request_.username;
  }
  if (password) {
    step->password = password_.value();
  }
  if (code && code_) {
    step->code = *code_;
  }
  step->submit = true;
  filler_->Fill(request_.origin, std::move(step),
                base::BindOnce(&VaultSignIn::Filled,
                               weak_factory_.GetWeakPtr(), next));
}

void VaultSignIn::Filled(Phase next, mojom::ACVaultFillOutcome outcome) {
  if (!filling_) {
    return;
  }
  filling_ = false;
  filler_.reset();
  if (phase_ == Phase::kDone) {
    return;
  }
  using Outcome = mojom::ACVaultFillOutcome;
  switch (outcome) {
    case Outcome::kSubmitted:
    case Outcome::kFilled:
      fill_ = std::max(fill_, base::TimeTicks::Now() - dispatched_);
      ++steps_;
      retries_ = 0;
      submitted_at_ = base::TimeTicks::Now();
      submitted_ = true;
      navigated_since_submit_ = false;
      phase_ = next;
      settle_.Start(FROM_HERE, kSettleWithoutNavigation,
                    base::BindOnce(&VaultSignIn::Judge,
                                   base::Unretained(this)));
      Advance();
      return;
    case Outcome::kDestinationRefused:
    case Outcome::kOriginChanged:
      Conclude("cross_origin");
      return;
    case Outcome::kSubmitterRefused:
      Conclude("no_form");
      return;
    case Outcome::kFieldMissing:
    case Outcome::kFieldChanged:
      if (!reason_) {
        reason_ = outcome == Outcome::kFieldMissing ? "field_missing"
                                                    : "field_changed";
      }
      ++refills_;
      if (++retries_ > kMostRetries) {
        Conclude("failed");
        return;
      }
      reason_ = nullptr;
      retry_.Start(FROM_HERE, kRetryAfter,
                   base::BindOnce(&VaultSignIn::Advance,
                                  base::Unretained(this)));
      return;
  }
}

void VaultSignIn::LoginSucceeded() {
  if (phase_ == Phase::kDone || !submitted_) {
    return;
  }
  if (phase_ == Phase::kPasswordSent && request_.code_provider) {
    return;
  }
  if (phase_ == Phase::kPasswordSent || phase_ == Phase::kCodeSent) {
    Conclude("signed_in");
  }
}

void VaultSignIn::Judge() {
  if (phase_ == Phase::kDone || filling_ || awaiting_code_) {
    return;
  }
  const std::vector<LoginForm> forms = Usable();
  const bool password_form = std::ranges::any_of(
      forms, [](const LoginForm& f) { return !f.password.is_null(); });
  const bool code_form = std::ranges::any_of(
      forms, [](const LoginForm& f) { return !f.code.is_null(); });
  if (phase_ == Phase::kUsernameSent) {
    Conclude(passkey_requested_      ? "needs_passkey"
             : navigated_since_submit_ ? "needs_human"
                                       : "still_on_login");
    return;
  }
  if (password_form) {
    Conclude("still_on_login");
    return;
  }
  if (phase_ == Phase::kPasswordSent && code_form) {
    Conclude("needs_human");
    return;
  }
  Conclude(navigated_since_submit_ ? "signed_in" : "submitted");
}

void VaultSignIn::DeadlinePassed() {
  if (phase_ == Phase::kDone) {
    return;
  }
  if (!submitted_) {
    if (credential_ready_) {
      NoForm();
    } else {
      Conclude("failed");
    }
    return;
  }
  filling_ = false;
  awaiting_code_ = false;
  Judge();
}

void VaultSignIn::FillerGone(Phase next) {
  reason_ = "unreachable";
  Filled(next, mojom::ACVaultFillOutcome::kFieldMissing);
}

bool VaultSignIn::ElsewhereOnly() {
  if (!forms_) {
    return false;
  }
  for (const LoginForm& form : forms_->Forms(std::nullopt)) {
    if (!form.sign_up && !form.password.is_null() &&
        (!form.same_origin_ancestors ||
         !form.origin.IsSameOriginWith(request_.origin))) {
      return true;
    }
  }
  return false;
}

bool VaultSignIn::SignUpOnly() {
  if (!forms_) {
    return false;
  }
  for (const LoginForm& form : forms_->Forms(request_.origin)) {
    if (form.sign_up) {
      return true;
    }
  }
  return false;
}

void VaultSignIn::DOMContentLoaded(content::RenderFrameHost* frame) {
  if (phase_ != Phase::kDone && !submitted_ && frame->IsInPrimaryMainFrame()) {
    page_ready_ = true;
    MaybeNoForm();
    return;
  }
  if (phase_ == Phase::kDone || !submitted_ || !navigated_since_submit_ ||
      filling_ || awaiting_code_ || !IsDecidingFrame(frame) ||
      (phase_ != Phase::kPasswordSent && phase_ != Phase::kCodeSent) ||
      net::SchemefulSite(frame->GetLastCommittedOrigin()) !=
          net::SchemefulSite(request_.origin)) {
    return;
  }
  probe_.reset();
  frame->GetRemoteAssociatedInterfaces()->GetInterface(&probe_);
  probe_->ProbeDocument(base::BindOnce(&VaultSignIn::Probed,
                                       weak_factory_.GetWeakPtr(),
                                       frame->GetGlobalId()));
}

void VaultSignIn::Probed(content::GlobalRenderFrameHostId frame,
                         bool password_field,
                         bool text_field) {
  probe_.reset();
  content::RenderFrameHost* host = content::RenderFrameHost::FromID(frame);
  if (phase_ == Phase::kDone || filling_ || awaiting_code_ || !host ||
      !IsDecidingFrame(host)) {
    return;
  }
  if (password_field) {
    Conclude("still_on_login");
    return;
  }
  if (phase_ == Phase::kPasswordSent && request_.code_provider && text_field) {
    return;
  }
  Conclude("signed_in");
}

void VaultSignIn::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (!navigation->HasCommitted() || navigation->IsSameDocument()) {
    return;
  }
  Disarm(navigation->GetPreviousRenderFrameHostId());
  const bool main_frame = navigation->IsInPrimaryMainFrame();
  if (!main_frame && navigation->GetFrameTreeNodeId() != filled_node_) {
    return;
  }
  if (main_frame) {
    page_loaded_ = false;
    passkey_requested_ = false;
    if (!submitted_) {
      page_ready_ = false;
      no_form_.Stop();
    }
  }
  if (submitted_) {
    navigated_since_submit_ = true;
    settle_.Start(FROM_HERE, kSettleWithoutNavigation,
                  base::BindOnce(&VaultSignIn::Judge,
                                 base::Unretained(this)));
  }
}

bool VaultSignIn::IsDecidingFrame(content::RenderFrameHost* frame) const {
  return frame->IsInPrimaryMainFrame() ||
         (frame->IsActive() && frame->GetFrameTreeNodeId() == filled_node_);
}

void VaultSignIn::RenderFrameDeleted(content::RenderFrameHost* frame) {
  Disarm(frame->GetGlobalId());
}

void VaultSignIn::Disarm(content::GlobalRenderFrameHostId frame) {
  if (armed_.erase(frame)) {
    PublishArmed();
  }
}

void VaultSignIn::PublishArmed() {
  if (!policy_) {
    return;
  }
  std::set<content::FrameTreeNodeId> frames;
  for (const auto& [document, node] : armed_) {
    frames.insert(node);
  }
  policy_->SetArmed(std::move(frames));
}

void VaultSignIn::DidStopLoading() {
  if (phase_ == Phase::kDone) {
    return;
  }
  const bool first_load = !page_loaded_;
  page_loaded_ = true;
  if (load_ms_.is_zero() && !load_started_.is_null()) {
    load_ms_ = base::TimeTicks::Now() - load_started_;
  }
  MaybePasskeyOnly();
  if (phase_ == Phase::kDone) {
    return;
  }
  if (submitted_ && navigated_since_submit_) {
    const bool next_step_expected =
        phase_ == Phase::kUsernameSent ||
        (phase_ == Phase::kPasswordSent && request_.code_provider);
    settle_.Start(FROM_HERE,
                  next_step_expected ? kNextStepAfterLoad : kSettleAfterLoad,
                  base::BindOnce(&VaultSignIn::Judge,
                                 base::Unretained(this)));
    return;
  }
  if (!submitted_) {
    page_ready_ = true;
    if (first_load) {
      no_form_.Stop();
    }
    MaybeNoForm();
  }
}

void VaultSignIn::PrimaryMainFrameRenderProcessGone(
    base::TerminationStatus status) {
  Conclude("failed");
}

}
}
