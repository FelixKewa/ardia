import { View } from "react-native";
import { activateWebKitExtension, openWebKitExtensionMenu, useWebKitToolbarLayout, useWebKitToolbarRefresh } from "../../state/extensions/webKit";
import { usePages } from "../../state/tabs/pageState";
import { TOOLBAR_TRAILING } from "../../lib/toolbarRow";
import { Button, useToolbarRowContext } from "../ui";
import type { ToolbarPalette } from "../ui/toolbarColors";

export function WebKitToolbarExtensions({ windowId, tabId, palette, top, right, limit = Infinity, onActivate }: {
  windowId: string;
  tabId: string;
  palette: ToolbarPalette;
  top: number;
  right: number;
  limit?: number;
  onActivate?: () => void;
}) {
  useWebKitToolbarRefresh(windowId, tabId);
  const button = useToolbarRowContext().extensionButton;
  const { visible, overflow, width } = useWebKitToolbarLayout(windowId, limit, button, tabId);
  const ready = usePages((s) => typeof s.ready[tabId] === "number" && s.ready[tabId]! > 0);
  return (
    <View style={{ position: "absolute", top, right, width, flexDirection: "row", gap: TOOLBAR_TRAILING.itemGap }}>
      {visible.map((extension) => (
        <Button key={extension.id} variant="icon" toolbar look="extension" image={extension.icon} icon="puzzlepiece.extension" palette={palette} tooltip={extension.name} disabled={!ready} onPress={() => {
          onActivate?.();
          void activateWebKitExtension(windowId, tabId, extension.id, extension.fingerprint);
        }} />
      ))}
      <Button variant="icon" toolbar look="extension" icon="puzzlepiece.extension" palette={palette} tooltip={overflow.length ? "More WebKit Extensions" : "Manage WebKit Extensions"} onPress={() => {
        onActivate?.();
        void openWebKitExtensionMenu(windowId, tabId, limit);
      }} />
    </View>
  );
}
