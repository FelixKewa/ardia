import { Platform } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { closeSettings, openSettings, openSettingsPage, pushSettings, settingsNav } from "../state/settings/nav";
import { connectIsStackRoot, scannerPresentation } from "../components/settings/ExpoSyncConnectPage";
import * as syncActions from "../state/sync/actions";
import { setConnectPhrase } from "../state/sync/connectDraft";
import * as scan from "../state/sync/scan";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;

const WORDS = Array.from({ length: 24 }, (_, index) => `word${index}`).join(" ");

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  setConnectPhrase("");
  jest.spyOn(scan, "canScanCodes").mockReturnValue(true);
  jest.spyOn(syncActions, "canPickSyncFolderFirst").mockReturnValue(false);
  jest.spyOn(syncActions, "checkPhrase").mockImplementation((phrase: string) => {
    const count = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
    return { wordCount: count, counterText: `${count}/24 words`, isTooLong: count > 24, problem: null, isValid: count === 24 };
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const destination = (root: Root, value: string) => root.root.findAll((node) => typeof node.type === "string" && node.props.name === "destination" && (node.props.extraProps as { value?: string } | undefined)?.value === value)[0]!;
const within = (node: ReactTestInstance, has: (props: Record<string, unknown>) => boolean) => node.findAll((inner) => typeof inner.type === "string" && has(inner.props));
const texts = (node: ReactTestInstance) => within(node, (props) => typeof props.text === "string").map((inner) => inner.props.text as string);
const byLabel = (node: ReactTestInstance, label: string) => within(node, (props) => props.label === label)[0]!;
const disabledOf = (node: ReactTestInstance) => ((node.props.modifiers as { $type: string; disabled?: boolean }[] | undefined) ?? []).find((modifier) => modifier.$type === "disabled")?.disabled;
const press = async (node: ReactTestInstance) => act(async () => void (node.props.onButtonPress ?? node.props.onPress)({ nativeEvent: {} }));

onIos("on iPhone Connect to Your Mac is main's two steps on Expo UI; Enter Words pushes main's phrase page, whose Use Phrase brings 24 good words back as the first step done", async () => {
  openSettings({ page: "syncConnect" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(root, "syncConnect");
  expect(texts(connect())).toEqual(expect.arrayContaining(["Show the code on your Mac", "Choose the Ardia Sync folder"]));
  expect(byLabel(connect(), "Scan Code")).toBeTruthy();
  await press(byLabel(connect(), "Enter Recovery Phrase"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncWords" });
  const words = () => destination(root, "syncWords");
  expect(disabledOf(byLabel(words(), "Use Phrase"))).toBe(true);
  const field = within(words(), (props) => props.placeholder === "Enter your 24-word recovery phrase")[0]!;
  await act(async () => field.props.onTextChange({ nativeEvent: { value: WORDS } }));
  expect(disabledOf(byLabel(words(), "Use Phrase"))).toBe(false);
  expect(texts(words())).toContain("24/24 words");
  await press(byLabel(words(), "Use Phrase"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncConnect" });
  expect(within(connect(), (props) => props.title === "Recovery phrase added")).toHaveLength(1);
  expect(byLabel(connect(), "Change")).toBeTruthy();
  unmount(root);
});

onIos("on iPhone Scan Code presents the scanner as a full-screen cover over the Settings sheet, as main does, instead of pushing a page into the sheet", async () => {
  openSettings({ page: "syncConnect" });
  const root = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(root, "syncConnect");
  await press(byLabel(connect(), "Scan Code"));
  expect(settingsNav().stack.at(-1)).toEqual({ page: "syncConnect" });
  unmount(root);
});

const root = (rendered: Root) => rendered.root.findAll((node) => typeof node.type === "string" && node.props.name !== "destination" && within(node, (props) => props.title === "Show the code on your Mac" || props.text === "Show the code on your Mac").length > 0)[0]!;

onIos("opened on its own, as onboarding opens it, the connect page is the stack's root with Cancel instead of Done; Cancel closes Settings", async () => {
  openSettingsPage({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  expect(connectIsStackRoot(settingsNav().stack)).toBe(true);
  const page = root(rendered);
  expect(within(page, (props) => props.label === "Cancel")).toHaveLength(1);
  expect(within(rendered.root, (props) => props.text === "Done")).toHaveLength(0);
  await press(byLabel(page, "Cancel"));
  expect(settingsNav().open).toBe(false);
  unmount(rendered);
});

onIos("while connecting, Cancel, Change and the step's actions are locked and the page cannot be swiped away, as they are in Settings", async () => {
  jest.spyOn(syncActions, "connectSync").mockReturnValue(new Promise(() => undefined));
  setConnectPhrase(WORDS);
  openSettingsPage({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const page = () => root(rendered);
  expect(disabledOf(byLabel(page(), "Change"))).toBe(false);
  await press(byLabel(page(), "Choose Folder…"));
  expect(disabledOf(byLabel(page(), "Cancel"))).toBe(true);
  expect(disabledOf(byLabel(page(), "Change"))).toBe(true);
  act(() => closeSettings());
  unmount(rendered);
});

test("pushed from Sync With Mac the connect page keeps Back, not Cancel, and the scanner slides in only without Reduce Motion", () => {
  openSettings({ page: "sync" });
  pushSettings({ page: "syncConnect" });
  expect(connectIsStackRoot(settingsNav().stack)).toBe(false);
  expect(scannerPresentation(false)).toBe("slide");
  expect(scannerPresentation(true)).toBe("fade");
  closeSettings();
});

onIos("while it connects, Choose Folder stays on the page with its name, locked, with Connecting as its busy value, as the other Settings operations do", async () => {
  let finish: (value: never) => void = () => undefined;
  jest.spyOn(syncActions, "connectSync").mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);
  setConnectPhrase(WORDS);
  openSettings({ page: "syncConnect" });
  const rendered = renderSurface(<SettingsView />);
  await act(async () => undefined);
  const connect = () => destination(rendered, "syncConnect");
  const choose = () => within(connect(), (props) => props.label === "Choose Folder…")[0];
  expect(disabledOf(choose()!)).toBe(false);
  await press(choose()!);
  expect(choose()).toBeDefined();
  expect(disabledOf(choose()!)).toBe(true);
  expect(((choose()!.props.modifiers as { $type: string; value?: string }[]) ?? []).find((modifier) => modifier.$type === "accessibilityValue")?.value).toBe("Connecting…");
  expect(texts(connect())).not.toContain("Connecting…");
  await act(async () => finish({ result: "failed" } as never));
  unmount(rendered);
});
