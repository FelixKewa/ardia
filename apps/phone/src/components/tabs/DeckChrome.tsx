import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { capsule, controlSize, EmptyState, font, IncognitoSpecs, NoResultsState, space, tabsInk, tabsLayout } from "../ui";

export function deckEmptyWords(incognito: boolean): { title: string; detail: string } {
  if (incognito) return { title: "No Incognito Tabs", detail: "Incognito tabs aren’t saved to your history or the Archive." };
  return { title: "No Open Tabs", detail: "Tabs you open appear here. Inactive tabs move to the Archive." };
}

export const DECK_OPEN_ARCHIVE = "Open Archive";

export function DeckEmpty({ centerY, showsArchive, onArchive, query = "", incognito = false }: { centerY: number; showsArchive: boolean; onArchive: () => void; query?: string; incognito?: boolean }) {
  const words = deckEmptyWords(incognito);
  return (
    <View testID="deckEmpty" pointerEvents="box-none" style={[styles.empty, { top: centerY - space.huge * 2 }]}>
      {query ? (
        <NoResultsState testID="deckNoResults" query={query} />
      ) : (
        <EmptyState title={words.title} message={words.detail} action={showsArchive && !incognito ? { title: DECK_OPEN_ARCHIVE, onPress: onArchive } : undefined} />
      )}
    </View>
  );
}

export function IncognitoChip({ count, top, onPress }: { count: number; top: number; onPress: () => void }) {
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.chipRow, { top, width }]} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Incognito, ${count} ${count === 1 ? "tab" : "tabs"}`}
        accessibilityHint="Shows the option to close incognito tabs."
        onPress={onPress}
        style={[styles.chip, { backgroundColor: tabsInk.incognitoOnLight, borderRadius: capsule(tabsLayout.chipHeight) }]}
      >
        <IncognitoSpecs size={tabsLayout.specsChip} color={tabsInk.onDark} />
        <Text style={[font.subheadline, styles.bold, styles.chipText]}>Incognito</Text>
        <Text style={[font.subheadline, styles.bold, { color: tabsInk.onDarkChip }]}>{count}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  bold: { fontWeight: "600" },
  chipRow: { position: "absolute", left: 0, height: controlSize.hitTarget, alignItems: "center", justifyContent: "center" },
  chip: { flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: tabsLayout.chipHeight, paddingHorizontal: space.m },
  chipText: { color: tabsInk.onDark },
});
