import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { listWords } from "../../lib/sharedWords";
import { ActionButton } from "./ActionButton";
import { iconRoles } from "./iconRoles";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { useTheme } from "./theme";
import { emptyStateLayout, font } from "./tokens";

type EmptyStateProps = {
  title: string;
  glyph?: SymbolName;
  message?: string;
  action?: { title: string; onPress: () => void };
  testID?: string;
};

export function EmptyState({ title, glyph, message, action, testID }: EmptyStateProps) {
  const theme = useTheme();
  return (
    <View testID={testID} style={styles.column}>
      {glyph ? (
        <View style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Symbol name={glyph} size={emptyStateLayout.glyph} color={theme.secondaryLabel} />
        </View>
      ) : null}
      <Text accessibilityRole="header" style={[font.title3, styles.title, { color: theme.label }]}>
        {title}
      </Text>
      {message ? <Text style={[font.subheadline, styles.message, { color: theme.secondaryLabel }]}>{message}</Text> : null}
      {action ? (
        <View style={styles.action}>
          <ActionButton title={action.title} onPress={action.onPress} variant="plain" tone="accent" size="compact" />
        </View>
      ) : null}
    </View>
  );
}

export function NoResultsState({ query, onClear, clearTitle, testID }: { query: string; onClear?: () => void; clearTitle?: string; testID?: string }) {
  return <EmptyState testID={testID} title={listWords.noResults} glyph={iconRoles.noResults} message={listWords.noResultsCue(query)} action={onClear && clearTitle ? { title: clearTitle, onPress: onClear } : undefined} />;
}

export function LoadingState({ label = listWords.loading, testID }: { label?: string; testID?: string }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={styles.column} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }} accessibilityLiveRegion="polite">
      <ActivityIndicator color={theme.secondaryLabel} />
      <Text style={[font.subheadline, styles.message, { color: theme.secondaryLabel }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { alignSelf: "center", alignItems: "center", maxWidth: emptyStateLayout.maxWidth, padding: emptyStateLayout.pad, gap: emptyStateLayout.gap },
  glyph: { marginBottom: emptyStateLayout.glyphGap - emptyStateLayout.gap },
  title: { fontWeight: "600", textAlign: "center" },
  message: { textAlign: "center" },
  action: { marginTop: emptyStateLayout.actionGap - emptyStateLayout.gap },
});
