#ifndef ARDIA_CORE_AC_EXTENSION_VIEW_H_
#define ARDIA_CORE_AC_EXTENSION_VIEW_H_

#include <string>

class Browser;
class BrowserWindowInterface;
class GURL;

namespace content {
class WebContents;
}

namespace gfx {
class Size;
}

namespace ardiacore {

enum class ExtensionViewKind { kPopup, kSidePanel };

content::WebContents* OpenExtensionView(Browser* browser,
                                        const GURL& url,
                                        ExtensionViewKind kind);

void RememberExtensionPopupSource(BrowserWindowInterface* browser,
                                  const std::string& extension_id,
                                  content::WebContents* source);

bool CloseExtensionView(content::WebContents* contents);

void CloseAllExtensionViews();

gfx::Size ExtensionPopupPreferredSize(content::WebContents* contents);

void InstallActionPopupHook();

}

#endif
