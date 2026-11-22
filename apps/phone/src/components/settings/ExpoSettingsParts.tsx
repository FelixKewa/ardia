import type { ReactNode } from "react";
import { PlatformColor } from "react-native";
import { Button, HStack, Image, ProgressView, Section, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { accessibilityAddTraits, accessibilityHidden, accessibilityValue, buttonBorderShape, buttonStyle, controlSize, disabled, fixedSize, font, foregroundStyle, frame, labelStyle, listRowBackground, listRowInsets, tint } from "@expo/ui/swift-ui/modifiers";
import { listWords } from "../../lib/sharedWords";
import { primaryActionRoles, type PrimaryActionRole } from "../ui/tokens";
import { CheckmarkLabel, space, SettingsHeroContent, settingsUIAvailable, SetupStepRow, useTheme, type SettingsTintName, type SetupProgress } from "../ui";

const PAGE_INSET = 16;
const FILL = Number.MAX_SAFE_INTEGER;
const CHECKMARK_INK = PlatformColor("systemBlue");

type HeroProps = { title: string; subtitle: string; warning?: boolean; systemImage: string; tint: SettingsTintName; children?: ReactNode };

export function ExpoHero({ title, subtitle, warning = false, systemImage, tint, children }: HeroProps) {
  return (
    <Section modifiers={[listRowBackground("clear"), listRowInsets({ top: 0, leading: PAGE_INSET, bottom: 0, trailing: PAGE_INSET })]}>
      {settingsUIAvailable() ? (
        <SettingsHeroContent title={title} subtitle={subtitle} subtitleIsWarning={warning} systemImage={systemImage} tint={tint}>
          {children}
        </SettingsHeroContent>
      ) : (
        <VStack spacing={12}>
          <Text>{title}</Text>
          <Text>{subtitle}</Text>
          {children}
        </VStack>
      )}
    </Section>
  );
}

type StepProps = { number: number; title: string; detail: string; progress: SetupProgress; children?: ReactNode };

export function ExpoStep({ number, title, detail, progress, children }: StepProps) {
  if (settingsUIAvailable()) {
    return (
      <SetupStepRow number={number} title={title} detail={detail} progress={progress}>
        {children}
      </SetupStepRow>
    );
  }
  return (
    <VStack alignment="leading" spacing={4}>
      <Text>{title}</Text>
      <Text>{detail}</Text>
      {children}
    </VStack>
  );
}

export type SettingsActionSize = Exclude<PrimaryActionRole, "hero">;

export type SettingsActionEmphasis = "primary" | "secondary";

export function useSettingsActionModifiers(size: SettingsActionSize, emphasis: SettingsActionEmphasis = "primary") {
  const theme = useTheme();
  const role = primaryActionRoles[size];
  const shape = buttonBorderShape("roundedRectangle", role.radius);
  const fill = emphasis === "primary" ? [buttonStyle("borderedProminent"), tint(theme[role.fill]), foregroundStyle(theme[role.ink])] : [buttonStyle("bordered")];
  const sizing = [controlSize(role.nativeControlSize), ...(size === "compact" ? [labelStyle("titleAndIcon")] : []), fixedSize({ horizontal: false, vertical: role.wraps })];
  return [...fill, shape, ...sizing];
}

type ActionProps = { title: string; onPress: () => void; size: SettingsActionSize; emphasis?: SettingsActionEmphasis; systemImage?: string; isDisabled?: boolean; busy?: boolean; busyValue?: string };

export function ExpoSettingsAction({ title, onPress, size, emphasis = "primary", systemImage, isDisabled = false, busy = false, busyValue = listWords.loading }: ActionProps) {
  const modifiers = [...useSettingsActionModifiers(size, emphasis), disabled(isDisabled || busy), ...(busy ? [accessibilityValue(busyValue)] : [])];
  const button =
    size === "full" ? (
      <Button onPress={onPress} modifiers={modifiers}>
        <Text modifiers={[frame({ maxWidth: FILL })]}>{title}</Text>
      </Button>
    ) : (
      <Button label={title} systemImage={systemImage as never} onPress={onPress} modifiers={modifiers} />
    );
  if (!busy) return button;
  return (
    <HStack spacing={space.s}>
      {button}
      <ProgressView modifiers={[accessibilityHidden(true)]} />
    </HStack>
  );
}

export function ExpoChoiceRow({ title, checked, onPress }: { title: string; checked: boolean; onPress: () => void }) {
  return (
    <Button onPress={onPress} modifiers={[tint("primary"), accessibilityAddTraits(checked ? ["isButton", "isSelected"] : ["isButton"])]}>
      {settingsUIAvailable() ? (
        <CheckmarkLabel title={title} isChecked={checked} />
      ) : (
        <HStack>
          <Text>{title}</Text>
          <Spacer />
          {checked ? <Image systemName="checkmark" modifiers={[font({ textStyle: "body", weight: "semibold" }), foregroundStyle(CHECKMARK_INK), accessibilityHidden(true)]} /> : null}
        </HStack>
      )}
    </Button>
  );
}

type BusyProps = { title: string; busy: boolean; onPress: () => void; role?: "destructive"; isDisabled?: boolean; busyValue?: string };

export function ExpoBusyButton({ title, busy, onPress, role, isDisabled = false, busyValue = listWords.loading }: BusyProps) {
  return (
    <Button role={role} onPress={onPress} modifiers={[disabled(busy || isDisabled), ...(busy ? [accessibilityValue(busyValue)] : [])]}>
      <HStack>
        <Text>{title}</Text>
        <Spacer />
        {busy ? <ProgressView modifiers={[accessibilityHidden(true)]} /> : null}
      </HStack>
    </Button>
  );
}

export function ExpoBusyToolbarAction({ title, busy, ready, prominent = false, onPress }: { title: string; busy: boolean; ready: boolean; prominent?: boolean; onPress: () => void }) {
  return (
    <HStack spacing={space.s}>
      {busy ? <ProgressView modifiers={[accessibilityHidden(true)]} /> : null}
      <Button label={title} onPress={onPress} modifiers={[...(prominent ? [buttonStyle("glassProminent")] : []), disabled(busy || !ready), ...(busy ? [accessibilityValue(listWords.loading)] : [])]} />
    </HStack>
  );
}
