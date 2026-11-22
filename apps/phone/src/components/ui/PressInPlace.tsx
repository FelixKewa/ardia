import { type ReactNode, type Ref } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import { pressedLook, type PressKind } from "./pressFeedback";
import { screenReaderActions } from "./screenReaderActions";
import { useTheme } from "./theme";

type Props = {
  label: string;
  hint?: string;
  value?: string;
  longPressLabel?: string;
  actions?: { name: string; label: string; run: () => void }[];
  onPress: () => void;
  onLongPress?: () => void;
  onPressIn?: () => void;
  disabled?: boolean;
  checked?: boolean;
  grow?: boolean;
  kind?: PressKind;
  ref?: Ref<ViewInstance>;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

export function PressInPlace({ label, hint, value, longPressLabel, actions, onPress, onLongPress, onPressIn, disabled, checked, grow, kind = "icon", ref, style, children }: Props) {
  const { rowPressed } = useTheme();
  const exposed = actions
    ? screenReaderActions([{ name: "activate", run: onPress }, ...(onLongPress ? [{ name: "longpress", label: longPressLabel, run: onLongPress }] : []), ...actions])
    : {};
  return (
    <Pressable
      ref={ref}
      accessibilityRole={checked === undefined ? "button" : "switch"}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityValue={value ? { text: value } : undefined}
      {...exposed}
      accessibilityState={checked === undefined ? { disabled: Boolean(disabled) } : { disabled: Boolean(disabled), checked }}
      disabled={disabled}
      style={grow ? styles.grow : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={onPressIn}
    >
      {({ pressed }) => <View style={[style, pressedLook(kind, pressed && !disabled, false, rowPressed)]}>{children}</View>}
    </Pressable>
  );
}

const styles = StyleSheet.create({ grow: { flex: 1 } });
