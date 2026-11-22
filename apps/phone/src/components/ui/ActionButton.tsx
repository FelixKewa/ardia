import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { usePressStyle } from "./pressFeedback";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { useTheme, type Theme } from "./theme";
import { actionLayout, ink, overlayInk, smoothCorners, type ActionSize } from "./tokens";

export type ActionVariant = "filled" | "outlined" | "plain";

export type ActionTone = "accent" | "neutral" | "overlay";

export type ActionInk = { fill: string; label: string; edge: string };

export function actionInk(theme: Pick<Theme, "spaceAccent" | "spaceAccentInk" | "onSpaceAccent" | "secondaryFill" | "label" | "separator">, variant: ActionVariant, tone: ActionTone): ActionInk {
  if (tone === "overlay") {
    if (variant === "filled") return { fill: overlayInk.fill, label: overlayInk.onFill, edge: ink.clear };
    return { fill: ink.clear, label: overlayInk.label, edge: variant === "outlined" ? overlayInk.edge : ink.clear };
  }
  if (variant === "filled") return tone === "accent" ? { fill: theme.spaceAccent, label: theme.onSpaceAccent, edge: ink.clear } : { fill: theme.secondaryFill, label: theme.label, edge: ink.clear };
  const label = tone === "accent" ? theme.spaceAccentInk : theme.label;
  return { fill: ink.clear, label, edge: variant === "outlined" ? (tone === "accent" ? theme.spaceAccentInk : theme.separator) : ink.clear };
}

export type ActionButtonProps = {
  title: string;
  onPress: () => void;
  variant?: ActionVariant;
  tone?: ActionTone;
  size?: ActionSize;
  icon?: SymbolName;
  busy?: boolean;
  disabled?: boolean;
  hint?: string;
  stretch?: boolean;
  testID?: string;
};

export function ActionButton({ title, onPress, variant = "filled", tone = "accent", size = "regular", icon, busy = false, disabled = false, hint, stretch = false, testID }: ActionButtonProps) {
  const theme = useTheme();
  const colors = actionInk(theme, variant, tone);
  const box = {
    minHeight: actionLayout.height[size],
    borderRadius: actionLayout.radius[size],
    paddingHorizontal: actionLayout.sidePadding[size],
    backgroundColor: colors.fill,
    borderColor: colors.edge,
    borderWidth: variant === "outlined" ? actionLayout.edge : 0,
  };
  const pressStyle = usePressStyle(variant === "filled" ? "filled" : "text", { disabled, style: [styles.button, box, stretch ? styles.stretch : null] });
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={pressStyle}
    >
      <View style={[styles.content, busy ? styles.hidden : null]}>
        {icon ? <Symbol name={icon} size={actionLayout.icon[size]} color={colors.label} /> : null}
        <Text style={[actionLayout.label[size], styles.label, { color: colors.label }]}>{title}</Text>
      </View>
      {busy ? <ActivityIndicator testID={testID ? `${testID}Busy` : undefined} color={colors.label} style={StyleSheet.absoluteFill} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: "center", justifyContent: "center", paddingVertical: actionLayout.verticalPadding, ...smoothCorners },
  stretch: { alignSelf: "stretch" },
  content: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: actionLayout.iconGap },
  hidden: { opacity: 0 },
  label: { fontWeight: actionLayout.labelWeight, textAlign: "center", flexShrink: 1 },
});
