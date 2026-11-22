import { useEffect, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useReduceMotion } from "./contrast";
import { useDesign } from "./design";
import { MaterialSwitchTrack } from "./MaterialSurfaces";
import { motionAliases } from "./motion";
import { usePressStyle } from "./pressFeedback";
import { useTheme } from "./theme";
import { capsule, font, ink, press, shadowRadius, space, toggleLayout } from "./tokens";

const TRAVEL = toggleLayout.width - toggleLayout.knob - toggleLayout.inset * 2;

const KNOB_SLOP = space.s;

export type TogglePress = "row" | "knob";

type ToggleProps = { value: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string; hint?: string; testID?: string };

export function Toggle({ value, disabled, onChange, label, hint, testID }: ToggleProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={KNOB_SLOP}
      onPress={() => onChange(!value)}
    >
      <ToggleTrack value={value} disabled={disabled} />
    </Pressable>
  );
}

type ToggleRowProps = ToggleProps & { press?: TogglePress; detail?: string; children?: ReactNode; style?: StyleProp<ViewStyle> };

export function ToggleRow({ value, disabled = false, onChange, label, hint, detail, press: pressMode = "row", testID, children, style }: ToggleRowProps) {
  const theme = useTheme();
  const rowStyle = usePressStyle("row", { style: [styles.row, style] });
  const words = (
    <View style={styles.words} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {children ?? <Text style={[font.body, { color: disabled ? theme.disabled : theme.label }]}>{label}</Text>}
      {detail ? <Text style={[font.footnote, { color: theme.secondaryLabel }]}>{detail}</Text> : null}
    </View>
  );
  if (pressMode === "knob") {
    return (
      <View style={[styles.row, style]}>
        {words}
        <Toggle testID={testID} value={value} disabled={disabled} onChange={onChange} label={detail ? `${label}, ${detail}` : label} hint={hint} />
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={rowStyle}
    >
      {words}
      <ToggleTrack value={value} disabled={disabled} />
    </Pressable>
  );
}

export function ToggleTrack({ value, disabled }: { value: boolean; disabled?: boolean }) {
  if (useDesign() === "material") return <MaterialSwitchTrack value={value} disabled={disabled} />;
  return <ClassicToggleTrack value={value} disabled={disabled} />;
}

function ClassicToggleTrack({ value, disabled }: { value: boolean; disabled?: boolean }) {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const position = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    position.value = reduceMotion ? withTiming(value ? 1 : 0, { duration: motionAliases.toggleKnobReducedMs }) : withSpring(value ? 1 : 0, motionAliases.toggleKnob);
  }, [position, value, reduceMotion]);
  const off = theme.switchOff;
  const on = theme.switchOn;
  const trackStyle = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(position.value, [0, 1], [off, on]) }), [off, on]);
  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: position.value * TRAVEL }] }));
  return (
    <Animated.View testID="toggleTrack" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.track, trackStyle, disabled ? styles.disabled : null]}>
      <Animated.View style={[styles.knob, knobStyle]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m },
  words: { flex: 1, gap: space.tight },
  track: { width: toggleLayout.width, height: toggleLayout.height, borderRadius: capsule(toggleLayout.height), padding: toggleLayout.inset, justifyContent: "center" },
  knob: {
    width: toggleLayout.knob,
    height: toggleLayout.knob,
    borderRadius: capsule(toggleLayout.knob),
    backgroundColor: ink.white,
    elevation: 2,
    shadowColor: ink.knobShadow,
    shadowOpacity: 1,
    shadowRadius: shadowRadius.knob,
    shadowOffset: { width: 0, height: 1 },
  },
  disabled: { opacity: press.disabledOpacity },
});
