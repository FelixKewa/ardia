import { useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { reduceMotion, Text, ThemeSwatch, useTheme } from "../ui";
import { nativeLoop } from "../ui/motion";
import { monoFace, radius, space, tracking } from "../ui/tokens";
import { flatColors } from "../../lib/profileLook";
import { parseColor } from "../../lib/color";
import { upcomingInstallId, useTelemetry } from "../../state/telemetry/client";
import { anonIdentity } from "./anonIdentity";
import { useOnboardingColors } from "./Parts";
import { anonCard, onboardingType } from "./tokens";

const SHARED = "Crash reports, error types, feature counts, speed and memory, daily opens";
const SHARED_OFF = "Only how many days Ardia opens";
const NEVER = "Sites you visit, what you type, your tabs, your name";

const floats = (color: string) => {
  const [r, g, b, a] = parseColor(color);
  return [r / 255, g / 255, b / 255, a];
};

const issued = () => new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" }).toUpperCase();

function Glare({ t }: { t: Animated.Value }) {
  const travel = anonCard.width + anonCard.sheenWidth * 2;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: -anonCard.height / 2,
        left: -anonCard.sheenWidth,
        width: anonCard.sheenWidth,
        height: anonCard.height * 2,
        backgroundColor: anonCard.sheen,
        opacity: t.interpolate({ inputRange: FLOAT_STEPS, outputRange: [0.35, 1, 0.35, 1, 0.35] }),
        transform: [{ translateX: t.interpolate({ inputRange: FLOAT_STEPS, outputRange: [travel / 2, travel, travel / 2, 0, travel / 2] }) }, { rotate: "20deg" }],
      }}
    />
  );
}

const FLOAT_STEPS = [0, 0.25, 0.5, 0.75, 1];

function useFloat() {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion()) return;
    const run = nativeLoop(t, [{ to: 1, ms: anonCard.floatMs, easing: anonCard.floatEase }]);
    run.start();
    return () => run.stop();
  }, []);
  return t;
}

function Row({ label, value }: { label: string; value: string }) {
  const colors = useOnboardingColors();
  return (
    <View style={{ gap: space.xs }}>
      <Text size="tiny" weight="bold" color={colors.subtitle} style={[monoFace(), { letterSpacing: tracking.wide }]}>
        {label.toUpperCase()}
      </Text>
      <Text size="small" color={colors.title} lines={3}>
        {value}
      </Text>
    </View>
  );
}

function Stamp() {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: space.s,
        paddingVertical: space.xs,
        borderWidth: 1.5,
        borderRadius: radius.hair,
        borderColor: anonCard.stamp,
        backgroundColor: theme.dark ? anonCard.panel.dark : anonCard.panel.light,
        transform: [{ rotate: anonCard.stampTilt }],
      }}
    >
      <Text color={anonCard.stamp} style={[onboardingType.receiptStamp, monoFace()]}>
        VERIFIED ANON
      </Text>
    </View>
  );
}

export function AnonCard({ on }: { on: boolean }) {
  const theme = useTheme();
  const colors = useOnboardingColors();
  const installId = useTelemetry((s) => s.installId) ?? upcomingInstallId();
  const me = useMemo(() => anonIdentity(installId), [installId]);
  const foil = theme.custom ? flatColors(theme.custom) : [...floats(theme.accent), ...anonCard.foil.flatMap(floats)];
  const mono = monoFace();
  const t = useFloat();
  const [left, flat, right] = anonCard.swing;
  const [down, level, up] = anonCard.lift;
  return (
    <Animated.View
      style={{
        width: anonCard.width,
        height: anonCard.height,
        transform: [
          { perspective: anonCard.perspective },
          { rotateY: t.interpolate({ inputRange: FLOAT_STEPS, outputRange: [flat, right, flat, left, flat] }) },
          { rotateX: t.interpolate({ inputRange: FLOAT_STEPS, outputRange: [up, level, down, level, up] }) },
        ],
      }}
      accessibilityLabel={`Anonymous ID card for ${me.name}`}
    >
      <View style={{ flex: 1, borderRadius: anonCard.radius, overflow: "hidden", opacity: on ? 1 : anonCard.offOpacity }}>
        <ThemeSwatch colors={foil} angle={150} grain={0.3} style={StyleSheet.absoluteFill} />
        <View
          style={[
            StyleSheet.absoluteFill,
            { margin: anonCard.inset, borderRadius: anonCard.radius - anonCard.inset, padding: space.l, gap: space.m, backgroundColor: theme.dark ? anonCard.panel.dark : anonCard.panel.light },
          ]}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text size="tiny" weight="bold" color={colors.title} style={[mono, { letterSpacing: tracking.wide }]}>
              ARDIA · ANON ID
            </Text>
            <Text size="tiny" color={theme.accent}>
              {"★".repeat(me.rarity) + "☆".repeat(3 - me.rarity)}
            </Text>
          </View>
          <View style={{ height: anonCard.artHeight, borderRadius: radius.control, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
            <ThemeSwatch colors={foil} angle={30} grain={0.5} style={StyleSheet.absoluteFill} />
            <Text style={{ fontSize: anonCard.artGlyph, lineHeight: anonCard.artGlyph * 1.2 }}>{me.art}</Text>
            {on ? (
              <View style={{ position: "absolute", right: space.m, bottom: space.m }}>
                <Stamp />
              </View>
            ) : null}
          </View>
          <View style={{ gap: space.xs }}>
            <Text size="large" weight="semibold" color={colors.title} lines={1}>
              {on ? me.name : "Anonymous"}
            </Text>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text size="tiny" color={colors.subtitle} style={mono}>
                {on ? `№ ${me.serial}` : "№ ----·----"}
              </Text>
              <Text size="tiny" color={colors.subtitle} style={mono}>
                ISSUED {issued()}
              </Text>
            </View>
          </View>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.rowBorder }} />
          <Row label="Shares" value={on ? SHARED : SHARED_OFF} />
          <Row label="Never shares" value={NEVER} />
          <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}>
            <Text size="tiny" weight="bold" color={colors.title} style={mono}>
              PERSONAL DATA
            </Text>
            <Text size="tiny" weight="bold" color={colors.title} style={mono}>
              0.00
            </Text>
          </View>
        </View>
        {on ? <Glare t={t} /> : null}
      </View>
    </Animated.View>
  );
}
