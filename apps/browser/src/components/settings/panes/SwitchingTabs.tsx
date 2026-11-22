import { Box, Button, space, Text } from "../../ui";
import { Anchor, FormField, SectionHeader } from "../Form";
import { PictureChoice } from "../PictureChoice";
import { CtrlTabPreview } from "../ChoicePreviews";
import { setting } from "../settingsIndex";
import { chooseCtrlTab, ctrlTabCustomQuery, useCtrlTabChoice } from "../../../state/commands/commandShortcuts";
import { CTRL_TAB_CHOICES } from "../ctrlTabChoices";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { setShortcutsQuery } from "../../../state/settings/searchState";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";

const CTRL_TAB_KEY = PLATFORM_TERMS.switchTabsKey;

export function SwitchingTabsSection() {
  const choice = useCtrlTabChoice();
  return (
    <>
      <SectionHeader title="Switching tabs" />
      <Anchor id="appearance.ctrlTab" shape="card">
        <FormField label={setting("appearance.ctrlTab").title}>
          <Box row gap="xl" accessibilityRole="radiogroup">
            {CTRL_TAB_CHOICES.map((c) => (
              <PictureChoice key={c.value} title={c.title} caption={c.caption} selected={choice === c.value} onPress={() => chooseCtrlTab(c.value)} size="l">
                <CtrlTabPreview preset={c.value} />
              </PictureChoice>
            ))}
          </Box>
          {choice === "custom" && <CustomCtrlTabNote />}
        </FormField>
      </Anchor>
    </>
  );
}

function CustomCtrlTabNote() {
  const showKeys = () => {
    setShortcutsQuery(ctrlTabCustomQuery());
    goToSettingsPane("shortcuts");
  };
  return (
    <Box row gap="s" style={CUSTOM_NOTE}>
      <Text size="caption" tone="textSecondary" style={FILL}>
        {`Custom: you set your own keys for ${CTRL_TAB_KEY} in Shortcuts. Pick one above to use it instead.`}
      </Text>
      <Button title="Show in Shortcuts" onPress={showKeys} />
    </Box>
  );
}

const FILL = { flex: 1 } as const;
const CUSTOM_NOTE = { alignItems: "center", marginTop: space.l } as const;
