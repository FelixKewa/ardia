import { Platform } from "react-native";
import { ActionButton } from "./ActionButton";
import { settingsLayout } from "./tokens";

export const primaryButtonHeight = (os: string = Platform.OS) => (os === "ios" ? settingsLayout.primaryButton.height.ios : settingsLayout.primaryButton.height.android);

export function PrimaryButton({ title, onPress, busy, disabled, testID }: { title: string; onPress: () => void; busy?: boolean; disabled?: boolean; testID?: string }) {
  return <ActionButton title={title} onPress={onPress} variant="filled" tone="accent" size="hero" busy={busy} disabled={disabled} testID={testID} />;
}
