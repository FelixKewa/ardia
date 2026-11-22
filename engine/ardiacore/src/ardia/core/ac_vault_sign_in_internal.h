#ifndef ARDIA_CORE_AC_VAULT_SIGN_IN_INTERNAL_H_
#define ARDIA_CORE_AC_VAULT_SIGN_IN_INTERNAL_H_

#import <Foundation/Foundation.h>

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_login_forms.h"
#include "ardia/core/ac_vault_sign_in.h"
#include "ardia/core/ac_vault_request_guard.h"
#include "ardia/core/ac_vault_transfer.h"
#include "ardia/core/mojom/ardiacore.mojom.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/functional/function_ref.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/scoped_multi_source_observation.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "chrome/browser/ardia/ac_cli_visible_tabs.h"
#include "chrome/browser/password_manager/chrome_password_manager_client.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_destroyer.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/ui/autofill/chrome_autofill_client.h"
#include "components/password_manager/core/browser/form_fetcher.h"
#include "components/password_manager/core/browser/form_fetcher_impl.h"
#include "components/password_manager/core/browser/password_form.h"
#include "components/password_manager/core/browser/password_form_digest.h"
#include "components/password_manager/core/browser/password_manager_util.h"
#include "components/password_manager/core/browser/password_store/stored_credential.h"
#include "components/password_manager/core/browser/password_string.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/site_instance.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_observer.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "net/base/schemeful_site.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "ui/base/page_transition_types.h"
#include "ui/gfx/geometry/size.h"

namespace ardiacore {
namespace vault_internal {

inline constexpr char kVaultProfilePrefix[] = "Ardia::Vault";
inline constexpr base::TimeDelta kDeadline = base::Seconds(25);
inline constexpr base::TimeDelta kSeedWait = base::Seconds(2);
inline constexpr int kMostPerProfile = 4;
inline constexpr int kMostRetries = 6;
inline constexpr base::TimeDelta kRetryAfter = base::Milliseconds(150);
inline constexpr base::TimeDelta kNoFormAfterLoad = base::Seconds(3);
inline constexpr base::TimeDelta kSettleAfterLoad = base::Milliseconds(750);
inline constexpr base::TimeDelta kNextStepAfterLoad = base::Seconds(3);
inline constexpr base::TimeDelta kSettleWithoutNavigation = base::Seconds(6);
inline constexpr base::TimeDelta kCodeWait = base::Seconds(5);
inline constexpr base::TimeDelta kTransferWait = base::Seconds(3);
inline constexpr int kMostSteps = 4;
inline constexpr NSInteger kWidth = 1280;
inline constexpr NSInteger kHeight = 800;

enum class Phase { kStart, kUsernameSent, kPasswordSent, kCodeSent, kDone };

class VaultSignIn;

class VaultContentsDelegate : public content::WebContentsDelegate {
 public:
  void CanDownload(const GURL& url,
                   const std::string& request_method,
                   base::OnceCallback<void(bool)> callback) override {
    std::move(callback).Run(false);
  }
};

std::set<VaultSignIn*>& Running();
VaultSignIn* RunningFor(const content::WebContents* contents);

class VaultSignIn : public content::WebContentsObserver,
                    public password_manager::FormFetcher::Consumer,
                    public ProfileObserver {
 public:
  VaultSignIn(Profile* profile, VaultSignInRequest request, VaultSignInDone done);
  ~VaultSignIn() override;
  void Start();
  void Cancel();
  bool Shows(const content::WebContents* contents) const;
  bool Uses(content::BrowserContext* context) const;
  const url::Origin& origin() const;
  base::WeakPtr<VaultRequestPolicy> policy() const;
  base::WeakPtr<VaultSignIn> GetWeakPtr();
  void PasskeyRequested();

 private:
  void TearDown();
  void StopTimers();
  void Conclude(const char* status);
  void Abort(const char* status);
  void AfterConclusion();
  void Transferred(VaultTransferCounts counts);
  void TransferTimedOut();
  void DestroyVaultProfile();
  void Settle(const char* status);
  void Load();
  void Mark(content::RenderFrameHost* frame);
  void RenderFrameCreated(content::RenderFrameHost* frame) override;
  void ReadyToCommitNavigation(content::NavigationHandle* navigation) override;
  void RequestRefused();
  void MaybePasskeyOnly();
  void NoForm();
  void MaybeNoForm();
  void NoFormTimedOut();
  void OnFetchCompleted() override;
  void FormsChanged(content::RenderFrameHost* frame);
  std::optional<LoginForm> Pick(
      const std::vector<LoginForm>& forms,
      base::FunctionRef<bool(const LoginForm&)> wanted) const;
  std::vector<LoginForm> Usable();
  void Advance();
  void AskForCode();
  void CodeArrived(std::optional<std::u16string> code);
  void Dispatch(const LoginForm& form,
                bool username,
                bool password,
                bool code,
                Phase next);
  void Filled(Phase next, mojom::ACVaultFillOutcome outcome);
  void LoginSucceeded();
  void Judge();
  void DeadlinePassed();
  void DidFinishNavigation(content::NavigationHandle* navigation) override;
  void DidStopLoading() override;
  void DOMContentLoaded(content::RenderFrameHost* frame) override;
  void Probed(content::GlobalRenderFrameHostId frame,
              bool password_field,
              bool text_field);
  void FillerGone(Phase next);
  bool ElsewhereOnly();
  bool IsDecidingFrame(content::RenderFrameHost* frame) const;
  bool SignUpOnly();
  void RenderFrameDeleted(content::RenderFrameHost* frame) override;
  void Disarm(content::GlobalRenderFrameHostId frame);
  void PublishArmed();
  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override;
  void OnProfileWillBeDestroyed(Profile* profile) override;

  raw_ptr<Profile> profile_;
  VaultSignInRequest request_;
  VaultSignInDone done_;
  const base::TimeTicks start_;
  raw_ptr<Profile> vault_profile_ = nullptr;
  std::unique_ptr<VaultTransfer> transfer_op_;
  std::unique_ptr<VaultRequestPolicy> policy_;
  std::unique_ptr<content::WebContents> contents_;
  std::unique_ptr<LoginFormIndex> forms_;
  std::unique_ptr<password_manager::FormFetcherImpl> fetcher_;
  mojo::AssociatedRemote<mojom::ACVaultFiller> filler_;
  mojo::AssociatedRemote<mojom::ACVaultFiller> probe_;
  const char* reason_ = nullptr;
  int retries_ = 0;
  int refills_ = 0;
  content::FrameTreeNodeId filled_node_;
  base::TimeTicks submitted_at_;
  base::TimeDelta decide_;
  base::OneShotTimer retry_;
  base::ScopedClosureRunner capture_;
  password_manager::PasswordString password_;
  std::optional<std::u16string> code_;
  std::map<content::GlobalRenderFrameHostId, content::FrameTreeNodeId> armed_;
  const char* decided_ = "failed";
  bool credential_ready_ = false;
  bool filling_ = false;
  bool awaiting_code_ = false;
  bool submitted_ = false;
  bool navigated_since_submit_ = false;
  bool passkey_requested_ = false;
  bool page_loaded_ = false;
  bool page_ready_ = false;
  bool profile_gone_ = false;
  bool settled_ = false;
  int steps_ = 0;
  Phase phase_ = Phase::kStart;
  base::TimeTicks ready_;
  base::TimeTicks dispatched_;
  base::TimeTicks transfer_started_;
  base::TimeTicks transfer_done_;
  base::TimeDelta fill_;
  base::TimeDelta profile_ms_;
  base::TimeDelta seed_ms_;
  base::TimeDelta load_ms_;
  base::TimeTicks seed_started_;
  base::TimeTicks load_started_;
  base::OneShotTimer seed_wait_;
  VaultContentsDelegate contents_delegate_;
  base::TimeDelta scan_;
  VaultTransferCounts transfer_;
  const char* transfer_state_ = "none";
  base::OneShotTimer deadline_;
  base::OneShotTimer settle_;
  base::OneShotTimer no_form_;
  base::OneShotTimer code_wait_;
  base::OneShotTimer transfer_wait_;
  base::ScopedMultiSourceObservation<Profile, ProfileObserver> profiles_{this};
  base::WeakPtrFactory<VaultSignIn> weak_factory_{this};
};

}
}

#endif
