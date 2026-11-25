import { View } from "react-native";
import { openWebKitExtensionMenu } from "../../state/extensions/webKit";
import { Button } from "../ui";
import type { ToolbarPalette } from "../ui/toolbarColors";

export function WebKitToolbarExtensions({ windowId, tabId, palette, top, right, onActivate }: {
  windowId: string;
  tabId: string;
  palette: ToolbarPalette;
  top: number;
  right: number;
  onActivate?: () => void;
}) {
  return (
    <View style={{ position: "absolute", top, right }}>
      <Button variant="icon" toolbar look="extension" icon="puzzlepiece.extension" palette={palette} tooltip="WebKit Extensions" onPress={() => {
        onActivate?.();
        void openWebKitExtensionMenu(windowId, tabId);
      }} />
    </View>
  );
}
