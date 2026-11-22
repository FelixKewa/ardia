#include "ardia/core/renderer/ac_vault_filler.h"

#include <map>
#include <optional>
#include <vector>
#include <string>
#include <tuple>
#include <utility>

#include "ardia/core/mojom/ardiacore.mojom.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "components/autofill/content/renderer/form_autofill_util.h"
#include "components/autofill/core/common/unique_ids.h"
#include "content/public/renderer/render_frame.h"
#include "content/public/renderer/render_frame_observer.h"
#include "mojo/public/cpp/bindings/associated_receiver_set.h"
#include "base/strings/string_util.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/mojom/forms/form_control_type.mojom-shared.h"
#include "third_party/blink/public/platform/web_security_origin.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/platform/web_url.h"
#include "third_party/blink/public/web/web_autofill_state.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_form_control_element.h"
#include "third_party/blink/public/web/web_form_element.h"
#include "third_party/blink/public/web/web_frame.h"
#include "third_party/blink/public/web/web_input_element.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/url_constants.h"

namespace ardiacore {

namespace {

using Outcome = mojom::ACVaultFillOutcome;

enum class FieldKind { kUsername, kPassword, kCode };

class VaultFiller;

std::map<content::RenderFrame*, VaultFiller*>& Fillers() {
  static base::NoDestructor<std::map<content::RenderFrame*, VaultFiller*>>
      fillers;
  return *fillers;
}

bool MarkedVault(blink::WebFrame* frame);

class VaultFiller : public content::RenderFrameObserver,
                    public mojom::ACVaultFiller {
 public:
  explicit VaultFiller(content::RenderFrame* frame)
      : content::RenderFrameObserver(frame), frame_(frame) {
    Fillers()[frame] = this;
    frame->GetAssociatedInterfaceRegistry()->AddInterface<mojom::ACVaultFiller>(
        base::BindRepeating(&VaultFiller::Bind, weak_factory_.GetWeakPtr()));
  }

  ~VaultFiller() override { Fillers().erase(frame_); }

  void OnDestruct() override { delete this; }

  bool vault() const { return vault_; }

  void Fill(const url::Origin& expected_origin,
            mojom::ACVaultFillStepPtr step,
            FillCallback callback) override {
    std::move(callback).Run(Run(expected_origin, *step));
  }

  void MarkVaultFrame() override { vault_ = true; }

  void ProbeDocument(ProbeDocumentCallback callback) override {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    if (!frame || frame->GetDocument().IsNull()) {
      std::move(callback).Run(false, false);
      return;
    }
    blink::WebDocument document = frame->GetDocument();
    const bool password = !document
                               .QuerySelector(blink::WebString::FromAscii(
                                   "input[type=password i]"))
                               .IsNull();
    const bool text = !document
                           .QuerySelector(blink::WebString::FromAscii(
                               "input:not([type]), input[type=text i], "
                               "input[type=email i], input[type=tel i], "
                               "input[type=number i]"))
                           .IsNull();
    std::move(callback).Run(password, text);
  }

  void ClearFilledPasswords() override {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    if (!frame || frame->GetDocument().IsNull()) {
      return;
    }
    blink::WebDocument document = frame->GetDocument();
    std::vector<blink::WebFormControlElement> controls =
        document.UnassociatedFormControls();
    for (const blink::WebFormElement& form : document.Forms()) {
      for (const blink::WebFormControlElement& control :
           form.GetFormControlElements()) {
        controls.push_back(control);
      }
    }
    for (blink::WebFormControlElement& control : controls) {
      if (control.FormControlTypeForAutofill() !=
          blink::mojom::FormControlType::kInputPassword) {
        continue;
      }
      if (!control.SuggestedValue().IsEmpty()) {
        control.SetSuggestedValue(blink::WebString());
      }
      if (control.GetAutofillState() != blink::WebAutofillState::kNotFilled) {
        control.SetValue(blink::WebString(), true);
        control.SetAutofillState(blink::WebAutofillState::kNotFilled);
      }
    }
  }

 private:
  void Bind(mojo::PendingAssociatedReceiver<mojom::ACVaultFiller> receiver) {
    receivers_.Add(this, std::move(receiver));
  }

  Outcome Run(const url::Origin& expected_origin,
              const mojom::ACVaultFillStep& step) {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    if (!frame || frame->GetDocument().IsNull()) {
      return Outcome::kOriginChanged;
    }
    const url::Origin origin(frame->GetDocument().GetSecurityOrigin());
    const GURL document_url(frame->GetDocument().Url());
    if (origin.opaque() || !origin.IsSameOriginWith(expected_origin) ||
        !document_url.SchemeIsHTTPOrHTTPS() ||
        !url::Origin::Create(document_url).IsSameOriginWith(expected_origin)) {
      return Outcome::kOriginChanged;
    }
    blink::WebInputElement username;
    blink::WebInputElement password;
    blink::WebInputElement code;
    for (auto [id, kind, slot] :
         {std::tuple(step.username_field, FieldKind::kUsername, &username),
          std::tuple(step.password_field, FieldKind::kPassword, &password),
          std::tuple(step.code_field, FieldKind::kCode, &code)}) {
      if (!id) {
        continue;
      }
      std::optional<Outcome> refused = Resolve(frame, step.form, id, kind, slot);
      if (refused) {
        return *refused;
      }
    }
    if (!username && !password && !code) {
      return Outcome::kFieldMissing;
    }
    const bool carries_secret = password || code;
    for (const blink::WebInputElement* field : {&username, &password, &code}) {
      if (*field &&
          !DestinationAllowed(frame, expected_origin, *field, carries_secret)) {
        return Outcome::kDestinationRefused;
      }
    }
    blink::WebInputElement last;
    for (auto [field, value] :
         {std::pair(&username, &step.username),
          std::pair(&password, &step.password), std::pair(&code, &step.code)}) {
      if (!*field) {
        continue;
      }
      field->SetAutofillValue(blink::WebString::FromUtf16(*value));
      if (field->Value().Utf16() != *value) {
        return Outcome::kFieldChanged;
      }
      last = *field;
    }
    if (step.submit &&
        !SubmitterAllowed(frame, expected_origin, last, carries_secret)) {
      return Outcome::kSubmitterRefused;
    }
    if (!step.submit) {
      return Outcome::kFilled;
    }
    last.DispatchSimulatedEnter();
    return Outcome::kSubmitted;
  }

  std::optional<Outcome> Resolve(blink::WebLocalFrame* frame,
                                 uint64_t form,
                                 uint64_t id,
                                 FieldKind kind,
                                 blink::WebInputElement* slot) {
    blink::WebFormControlElement control =
        autofill::form_util::GetFormControlByRendererId(
            autofill::FieldRendererId(id));
    blink::WebInputElement input =
        control ? control.DynamicTo<blink::WebInputElement>()
                : blink::WebInputElement();
    if (!input || input.GetDocument().GetFrame() != frame) {
      return Outcome::kFieldMissing;
    }
    if (!input.IsEnabled() || input.IsReadOnly() || !input.IsConnected()) {
      return Outcome::kFieldChanged;
    }
    if (autofill::form_util::GetFormRendererId(
            input.GetOwningFormForAutofill()) != autofill::FormRendererId(form)) {
      return Outcome::kFieldChanged;
    }
    const bool is_password = input.FormControlTypeForAutofill() ==
                             blink::mojom::FormControlType::kInputPassword;
    if ((kind == FieldKind::kPassword && !is_password) ||
        (kind == FieldKind::kUsername && (is_password || !input.IsTextField())) ||
        (kind == FieldKind::kCode && !input.IsTextField() && !is_password)) {
      return Outcome::kFieldChanged;
    }
    *slot = input;
    return std::nullopt;
  }

  static bool TargetsSelf(const blink::WebString& target) {
    const std::string name(base::TrimWhitespaceASCII(target.Utf8(), base::TRIM_ALL));
    return name.empty() || base::EqualsCaseInsensitiveASCII(name, "_self");
  }

  static bool SameOriginURL(blink::WebLocalFrame* frame,
                            const blink::WebString& value,
                            const url::Origin& expected_origin) {
    const GURL destination =
        value.IsEmpty() ? GURL(frame->GetDocument().Url())
                        : GURL(frame->GetDocument().CompleteURL(value));
    return destination.is_valid() && destination.SchemeIsHTTPOrHTTPS() &&
           url::Origin::Create(destination).IsSameOriginWith(expected_origin);
  }

  bool SubmitterAllowed(blink::WebLocalFrame* frame,
                        const url::Origin& expected_origin,
                        const blink::WebInputElement& field,
                        bool carries_secret) {
    blink::WebFormElement form = field.GetOwningFormForAutofill();
    if (!form) {
      return true;
    }
    blink::WebFormControlElement submitter;
    for (const blink::WebFormControlElement& control :
         form.GetFormControlElements()) {
      const blink::mojom::FormControlType type = control.FormControlType();
      if (type == blink::mojom::FormControlType::kButtonSubmit ||
          type == blink::mojom::FormControlType::kInputSubmit ||
          type == blink::mojom::FormControlType::kInputImage) {
        submitter = control;
        break;
      }
    }
    blink::WebString target = form.GetAttribute(blink::WebString::FromAscii("target"));
    if (target.IsEmpty()) {
      blink::WebElement base = frame->GetDocument().QuerySelector(
          blink::WebString::FromAscii("base[target]"));
      if (base) {
        target = base.GetAttribute(blink::WebString::FromAscii("target"));
      }
    }
    const blink::WebString form_target = blink::WebString::FromAscii("formtarget");
    if (submitter && submitter.HasAttribute(form_target)) {
      target = submitter.GetAttribute(form_target);
    }
    if (!TargetsSelf(target)) {
      return false;
    }
    if (!submitter) {
      return true;
    }
    const blink::WebString form_action = blink::WebString::FromAscii("formaction");
    return !submitter.HasAttribute(form_action) ||
           SameOriginURL(frame, submitter.GetAttribute(form_action),
                         expected_origin);
  }

  bool DestinationAllowed(blink::WebLocalFrame* frame,
                          const url::Origin& expected_origin,
                          const blink::WebInputElement& field,
                          bool carries_secret) {
    blink::WebFormElement form = field.GetOwningFormForAutofill();
    if (!form) {
      return true;
    }
    return SameOriginURL(frame, form.Action(), expected_origin);
  }

  raw_ptr<content::RenderFrame> frame_;
  bool vault_ = false;
  mojo::AssociatedReceiverSet<mojom::ACVaultFiller> receivers_;
  base::WeakPtrFactory<VaultFiller> weak_factory_{this};
};

bool MarkedVault(blink::WebFrame* frame) {
  if (!frame || !frame->IsWebLocalFrame()) {
    return false;
  }
  content::RenderFrame* render_frame =
      content::RenderFrame::FromWebFrame(frame->ToWebLocalFrame());
  auto filler = render_frame ? Fillers().find(render_frame) : Fillers().end();
  return filler != Fillers().end() && filler->second->vault();
}

}

void AttachVaultFiller(content::RenderFrame* frame) {
  new VaultFiller(frame);
}

bool IsVaultFrame(content::RenderFrame* render_frame) {
  static const bool vault_process =
      base::CommandLine::ForCurrentProcess()->HasSwitch(kVaultRendererSwitch);
  if (vault_process) {
    return true;
  }
  blink::WebLocalFrame* frame =
      render_frame ? render_frame->GetWebFrame() : nullptr;
  for (blink::WebFrame* step = frame; step; step = step->Parent()) {
    if (MarkedVault(step) || MarkedVault(step->Opener())) {
      return true;
    }
  }
  return false;
}

}
