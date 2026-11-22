import { StyleSheet, type ViewStyle } from "react-native";
import { haptics } from "../../state/app/haptics";
import { newTab } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { useCanReopen, useIncognito } from "../../state/tabs/hooks";
import { barGlyphLayout, BarPlusGlyph, capsule, ChromeSurface, controlSize, PressScale, rolesFor, SystemGlyph, type SymbolName } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";
import { SF_SYMBOL_NAMES } from "../ui/sfSymbolNames";
import { plusMenu } from "../tabs/DeckBottomBar";

type StartBarLook = { dark: boolean; incognito: boolean };

export function StartCircleButton({ icon, label, testID, diameter = controlSize.bar, dark, incognito, onPress }: StartBarLook & { icon: SymbolName; label: string; testID: string; diameter?: number; onPress: () => void }) {
  const size = { width: diameter, height: diameter };
  const { pointSize, weight, side } = barGlyphLayout.circle;
  return (
    <PressScale label={label} onPress={onPress} onPressIn={haptics.barPress} style={[styles.centered, size]}>
      <ChromeSurface testID={testID} shape="circle" cornerRadius={capsule(diameter)} incognito={incognito} dark={dark} style={[styles.centered, size]}>
        <SystemGlyph testID={`${testID}Glyph`} systemName={SF_SYMBOL_NAMES[icon] ?? "circle"} pointSize={pointSize} weight={weight} name={icon} size={side} color={rolesFor(dark).label} />
      </ChromeSurface>
    </PressScale>
  );
}

export function StartPlusButton({ width, label, testID, dark, incognito, place, menusShown }: StartBarLook & { width: number; label: string; testID: string; place: ViewStyle; menusShown: boolean }) {
  const tabIncognito = useIncognito();
  const canReopen = useCanReopen();
  const size = { width, height: controlSize.bar };
  return (
    <MenuTrigger items={plusMenu(tabIncognito, canReopen)} trigger="longPress" haptic={menuOpenedHaptic} disabled={!menusShown} place={place} style={size}>
      {({ onLongPress }) => (
        <PressScale label={label} hint={PLUS_HINT} onPress={newTab} onLongPress={onLongPress ?? noop} onPressIn={haptics.barPress} style={size}>
          <ChromeSurface testID={testID} shape={width === size.height ? "circle" : "capsule"} cornerRadius={capsule(size.height)} incognito={incognito} dark={dark} style={[styles.centered, size]}>
            <BarPlusGlyph testID={`${testID}Glyph`} color={rolesFor(dark).label} />
          </ChromeSurface>
        </PressScale>
      )}
    </MenuTrigger>
  );
}

const PLUS_HINT = "Touch and hold for more options.";

const noop = () => undefined;

const styles = StyleSheet.create({
  centered: { alignItems: "center", justifyContent: "center" },
});
