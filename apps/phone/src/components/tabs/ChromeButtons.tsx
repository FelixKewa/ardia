import { StyleSheet, type ViewProps } from "react-native";
import { haptics } from "../../state/app/haptics";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { newIncognitoTab, newRegularTab, newTab, reopenLastClosed } from "../../state/browse/store";
import { actionWords } from "../../lib/sharedWords";
import { BarPlusGlyph, capsule, ChromeSurface, controlSize, iconRoles, PressScale, rolesFor, smoothCorners, startLayout, Symbol, SystemGlyph, type MenuItem, type SymbolName } from "../ui";

const CIRCLE_SYSTEM_NAMES: Partial<Record<SymbolName, string>> = {
  ellipsis: "ellipsis",
  gearshape: "gearshape",
  magnifyingglass: "magnifyingglass",
  squareOnSquare: "square.on.square",
  squareStack: "square.stack",
  squareGrid2x2: "square.grid.2x2",
};

const CIRCLE_SYSTEM_GLYPH = 16;

export function plusMenuItems(incognito: boolean, canReopen: boolean): MenuItem[] {
  return [
    ...(incognito
      ? [
          { label: actionWords.newTab, icon: iconRoles.newTab, onPress: newRegularTab },
          { label: actionWords.newIncognitoTab, icon: "eyes" as const, onPress: newTab },
        ]
      : [{ label: actionWords.newIncognitoTab, icon: "eyes" as const, onPress: newIncognitoTab }]),
    ...(canReopen ? [{ label: "Reopen Closed Tab", icon: "arrowUturnBackward" as const, onPress: reopenLastClosed }] : []),
  ];
}

type Look = { dark: boolean; incognito?: boolean };

export type GlyphFade = { readonly value: number };

export type ChromeFade = { glassShown?: boolean; glassShownMs?: number; glyphFade?: GlyphFade };

export function FadingGlyphs({ fade, style, ...rest }: ViewProps & { fade?: GlyphFade }) {
  const faded = useAnimatedStyle(() => (fade ? { opacity: fade.value } : {}));
  return <Animated.View {...rest} style={fade ? [style, faded] : style} />;
}

export type GlassButtonFace = { kind: "circle" } | { kind: "rounded"; corner: number };

const CIRCLE_FACE: GlassButtonFace = { kind: "circle" };

export function GlassCircleButton({ icon, label, testID, diameter = controlSize.bar, face = CIRCLE_FACE, dark, incognito = false, glassShown, glassShownMs, glyphFade, onPress }: Look & ChromeFade & { icon: SymbolName; label: string; testID: string; diameter?: number; face?: GlassButtonFace; onPress: () => void }) {
  const size = { width: diameter, height: diameter };
  const rounded = face.kind === "rounded";
  return (
    <PressScale label={label} onPress={onPress} onPressIn={haptics.barPress} style={[styles.centered, size]}>
      <ChromeSurface testID={testID} shape={rounded ? "rounded" : "circle"} cornerRadius={rounded ? face.corner : capsule(diameter)} incognito={incognito} dark={dark} shown={glassShown} shownMs={glassShownMs} style={[styles.centered, size, rounded ? smoothCorners : null]}>
        <FadingGlyphs testID={`${testID}Glyph`} pointerEvents="none" fade={glyphFade}>
          {CIRCLE_SYSTEM_NAMES[icon] ? (
            <SystemGlyph systemName={CIRCLE_SYSTEM_NAMES[icon]} pointSize={CIRCLE_SYSTEM_GLYPH} weight="medium" name={icon} size={startLayout.circleGlyph} color={rolesFor(dark).label} />
          ) : (
            <Symbol name={icon} size={startLayout.circleGlyph} color={rolesFor(dark).label} />
          )}
        </FadingGlyphs>
      </ChromeSurface>
    </PressScale>
  );
}

export function GlassPlusButton({ width, label, testID, dark, incognito = false, glassShown, glassShownMs, glyphFade, onPress, onLongPress }: Look & ChromeFade & { width: number; label: string; testID: string; onPress: () => void; onLongPress: () => void }) {
  const size = { width, height: controlSize.bar };
  return (
    <PressScale label={label} hint="Touch and hold for more options." onPress={onPress} onLongPress={onLongPress} onPressIn={haptics.barPress} style={size}>
      <ChromeSurface testID={testID} shape={width === size.height ? "circle" : "capsule"} cornerRadius={capsule(size.height)} incognito={incognito} dark={dark} shown={glassShown} shownMs={glassShownMs} style={[styles.centered, size]}>
        <FadingGlyphs testID={`${testID}Glyph`} pointerEvents="none" fade={glyphFade}>
          <BarPlusGlyph color={rolesFor(dark).label} />
        </FadingGlyphs>
      </ChromeSurface>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", justifyContent: "center" },
});
