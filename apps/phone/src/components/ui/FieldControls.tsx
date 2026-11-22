import type { ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { slopToReach, slotAround } from "./hitTarget";
import { usePressStyle } from "./pressFeedback";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { glyphSlot } from "./tokens";

export type SlotLayout = "slot" | "slop";

type SlotProps = { visual?: number; layout?: SlotLayout; style?: StyleProp<ViewStyle> };

function slotPlacement(visual: number, layout: SlotLayout) {
  return layout === "slot" ? { box: slotAround(visual), slop: undefined } : { box: { width: visual, height: visual, alignItems: "center" as const, justifyContent: "center" as const }, slop: slopToReach(visual) };
}

type FieldAccessoryProps = SlotProps & {
  icon: SymbolName;
  label: string;
  color: string;
  onPress: () => void;
  hint?: string;
  disabled?: boolean;
  glyph?: number;
  testID?: string;
};

export function FieldAccessory({ icon, label, color, onPress, hint, disabled = false, glyph = glyphSlot.field, visual = glyph, layout = "slot", style, testID }: FieldAccessoryProps) {
  const { box, slop } = slotPlacement(visual, layout);
  const pressStyle = usePressStyle("icon", { disabled, style: [box, style] });
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled }} disabled={disabled} hitSlop={slop} onPress={onPress} style={pressStyle}>
      <Symbol name={icon} size={glyph} color={color} />
    </Pressable>
  );
}

export type ToggleIconRole = "switch" | "button";

type ToggleIconButtonProps = SlotProps & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  role?: ToggleIconRole;
  disabled?: boolean;
  testID?: string;
  children: ReactNode;
};

export function ToggleIconButton({ checked, onChange, label, hint, role = "switch", disabled = false, visual = glyphSlot.icon, layout = "slot", style, testID, children }: ToggleIconButtonProps) {
  const { box, slop } = slotPlacement(visual, layout);
  const pressStyle = usePressStyle("icon", { disabled, style: [box, style] });
  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={role === "switch" ? { checked, disabled } : { selected: checked, disabled }}
      disabled={disabled}
      hitSlop={slop}
      onPress={() => onChange(!checked)}
      style={pressStyle}
    >
      {children}
    </Pressable>
  );
}
