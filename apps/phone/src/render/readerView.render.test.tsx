import { Image, StyleSheet } from "react-native";
import { FadeIn, getAnimatedStyle, SlideInDown } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";
import { ReaderView, useLeavingReader } from "../components/browsing/ReaderView";
import { DesignProvider, TextSizeGlyph } from "../components/ui";
import * as pageActions from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { readerBodySize } from "../state/page/pagePrompts";
import { usePreferences } from "../state/settings/store";

const mockMotion = { reduced: false };

jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const ARTICLE = { url: "https://news.example/a", title: "A Story", siteName: "News", byline: null, excerpt: null, leadImage: "https://news.example/a.jpg", language: "en", paragraphs: ["One.", "Two."], html: "", wordCount: 2, isArticle: true };

beforeEach(() => {
  mockMotion.reduced = false;
  jest.useFakeTimers();
  withTabs(1);
  jest.spyOn(pageActions, "readableContent").mockResolvedValue(ARTICLE as never);
  jest.spyOn(Image, "getSize").mockResolvedValue({ width: 800, height: 400 } as never);
  act(() => usePreferences.setState({ readerStep: 2, readerSerif: true, readerTheme: "light" } as never));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const host = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0];

async function reader(closing = false) {
  const root = renderSurface(
    <DesignProvider design="redesigned">
      <ReaderView tabId="t0" closing={closing} />
    </DesignProvider>,
  );
  await act(async () => undefined);
  return root;
}

test("the Reader is a modal for screen readers: it hides the page under it, puts first focus on Done, and the escape gesture closes it", async () => {
  act(() => usePageUi.setState({ readerTabId: "t0" }));
  const root = await reader();
  const overlay = host(root, "readerOverlay")!;
  expect(overlay.props.accessibilityViewIsModal).toBe(true);
  expect(overlay.props.pointerEvents).toBe("auto");
  expect(host(root, "readerDone")!.props.accessibilityLabel).toBe("Done");
  act(() => overlay.props.onAccessibilityEscape());
  expect(usePageUi.getState().readerTabId).toBeNull();
  unmount(root);
});

test("once the Reader starts leaving, its Done and Text Appearance take no touch and nothing in it is read", async () => {
  const root = await reader(true);
  const overlay = host(root, "readerOverlay")!;
  expect(overlay.props.pointerEvents).toBe("none");
  expect(overlay.props.accessibilityElementsHidden).toBe(true);
  expect(overlay.props.importantForAccessibility).toBe("no-hide-descendants");
  expect(overlay.props.accessibilityViewIsModal).toBe(false);
  expect(overlay.props.onAccessibilityEscape).toBeUndefined();
  unmount(root);
});

test("closing the Reader renders it once gated as leaving before it unmounts, so its outgoing copy is never live", () => {
  const seen: { shown: string | null; closing: boolean }[] = [];
  function Probe() {
    const id = usePageUi((state) => state.readerTabId);
    const presence = useLeavingReader(id);
    seen.push(presence);
    return null;
  }
  act(() => usePageUi.setState({ readerTabId: "t0" }));
  const root = renderSurface(<Probe />);
  expect(seen.at(-1)).toEqual({ shown: "t0", closing: false });
  act(() => usePageUi.setState({ readerTabId: null }));
  expect(seen).toContainEqual({ shown: "t0", closing: true });
  expect(seen.at(-1)).toEqual({ shown: null, closing: false });
  unmount(root);
});

test("the Reader's text-size glyph is the shared one, drawn the same way round as Page Zoom's", async () => {
  const root = await reader();
  expect(root.root.findAll((node) => node.type === TextSizeGlyph)).toHaveLength(1);
  const mirrored = root.root.findAll((node) => typeof node.type === "string" && ((StyleSheet.flatten(node.props.style)?.transform as { scaleX?: number }[] | undefined)?.some((step) => step.scaleX === -1) ?? false));
  expect(mirrored).toHaveLength(0);
  unmount(root);
});

test("the Reader's lead image clips with the continuous curve", async () => {
  const root = await reader();
  await act(async () => undefined);
  const image = root.root.findAll((node) => typeof node.type === "string" && node.props.source?.uri === ARTICLE.leadImage)[0]!;
  expect(StyleSheet.flatten(image.props.style)).toMatchObject({ borderCurve: "continuous" });
  unmount(root);
});

const sizeOf = (root: Root) => {
  const paragraph = root.root.findAll((node) => typeof node.type === "string" && node.props.children === "One.")[0] as ReactTestInstance;
  return { ...StyleSheet.flatten(paragraph.props.style), ...getAnimatedStyle(paragraph) }.fontSize as number;
};

test("with Reduce Motion the Reader fades in instead of sliding, and a text-size change lands at once instead of springing", async () => {
  mockMotion.reduced = true;
  const root = await reader();
  const sheet = root.root.findAll((node) => node.props.testID === "readerView" && node.props.entering !== undefined)[0]!;
  expect(sheet.props.entering).toBeInstanceOf(FadeIn);
  act(() => usePreferences.setState({ readerStep: 4 } as never));
  act(() => jest.advanceTimersByTime(16));
  expect(sizeOf(root)).toBeCloseTo(readerBodySize(4), 3);
  unmount(root);
});

test("without Reduce Motion the Reader slides up and a text-size change springs to its size", async () => {
  const root = await reader();
  const sheet = root.root.findAll((node) => node.props.testID === "readerView" && node.props.entering !== undefined)[0]!;
  expect(sheet.props.entering).toBeInstanceOf(SlideInDown);
  const before = sizeOf(root);
  act(() => usePreferences.setState({ readerStep: 4 } as never));
  act(() => jest.advanceTimersByTime(16));
  expect(sizeOf(root)).toBeGreaterThan(before);
  expect(sizeOf(root)).toBeLessThan(readerBodySize(4) - 0.01);
  for (let frame = 0; frame < 60; frame++) act(() => jest.advanceTimersByTime(16));
  expect(sizeOf(root)).toBeCloseTo(readerBodySize(4), 3);
  unmount(root);
});
