import type { ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { CheckBoxFace } from "./Checkbox";
import { checkboxA11y, spaceActivates } from "./a11y";
import { useClosing } from "./Closing";

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
  const closing = useClosing();
  const live = !disabled && !closing;
  const toggle = () => onChange(!value);
  return (
    <Pressable
      disabled={!live}
      focusable={live}
      onPress={toggle}
      onKeyDown={live ? spaceActivates(toggle) : undefined}
      {...checkboxA11y(value, disabled, label)}
      accessibilityHint={hint}
      style={style}
    >
      {children}
    </Pressable>
  );
}

export function CheckMark({ value, disabled }: { value: boolean; disabled?: boolean }) {
  return <CheckBoxFace on={value} disabled={disabled} />;
}
