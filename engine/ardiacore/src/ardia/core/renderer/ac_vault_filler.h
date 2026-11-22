#ifndef ARDIA_CORE_RENDERER_AC_VAULT_FILLER_H_
#define ARDIA_CORE_RENDERER_AC_VAULT_FILLER_H_

namespace content {
class RenderFrame;
}

namespace ardiacore {

inline constexpr char kVaultRendererSwitch[] = "ardiacore-vault-renderer";

void AttachVaultFiller(content::RenderFrame* frame);
bool IsVaultFrame(content::RenderFrame* frame);

}

#endif
