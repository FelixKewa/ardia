import type { ReactNode } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { Checkbox } from "./Field";

export function CheckTarget({
  value,
  onChange,
  label,
  hint,
  disabled,
  style,
  children,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={() => onChange(!value)}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      style={style}
    >
      {children}
    </Pressable>
  );
}

export function CheckMark({ value, disabled }: { value: boolean; disabled?: boolean }) {
  return (
    <View pointerEvents="none" aria-hidden>
      <Checkbox value={value} disabled={disabled} />
    </View>
  );
}
