import { type ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useReduceMotion } from "./contrast";
import { pressMotion } from "./motion";
import { screenReaderActions } from "./screenReaderActions";
import { press } from "./tokens";

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
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

export function PressScale({ label, hint, value, longPressLabel, actions, onPress, onLongPress, onPressIn, disabled, checked, grow, style, children }: Props) {
  const scale = useSharedValue(1);
  const reduceMotion = useReduceMotion();
  const scaled = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const exposed = actions
    ? screenReaderActions([{ name: "activate", run: onPress }, ...(onLongPress ? [{ name: "longpress", label: longPressLabel, run: onLongPress }] : []), ...actions])
    : {};
  const to = (target: number) => {
    scale.value = reduceMotion ? 1 : withSpring(target, pressMotion.spring);
  };
  return (
    <Pressable
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
      onPressIn={() => {
        onPressIn?.();
        to(pressMotion.scale);
      }}
      onPressOut={() => to(1)}
    >
      {({ pressed }) => <Animated.View style={[style, scaled, reduceMotion && pressed ? styles.dimmed : null]}>{children}</Animated.View>}
    </Pressable>
  );
}

const styles = StyleSheet.create({ grow: { flex: 1 }, dimmed: { opacity: press.iconOpacity } });
