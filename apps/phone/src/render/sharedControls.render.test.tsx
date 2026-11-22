import { createRef } from "react";
import { StyleSheet, Text, View, type ViewInstance } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { getAnimatedStyle } from "react-native-reanimated";
import { ActionButton, EmptyState, FieldAccessory, LoadingLine, LoadingState, ModalOverlay, overlayInk, press, PressScale, Tappable, Toggle, ToggleIconButton, ToggleRow, useTheme, type Theme } from "../components/ui";
import { renderSurface, unmount } from "../../test/render/harness";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

beforeEach(() => {
  jest.useFakeTimers();
  mockMotion.reduced = false;
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const host = (node: ReactTestInstance | undefined) => node!;

const pressableNamed = (root: ReturnType<typeof renderSurface>, label: string) => host(root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]);

const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;

const pressedStyleOf = (node: ReactTestInstance, pressed: boolean) => flat(typeof node.props.style === "function" ? node.props.style({ pressed, hovered: false }) : node.props.style);

let theme: Theme;
function ThemeProbe() {
  theme = useTheme();
  return null;
}

test("a busy action keeps its spoken name, shows progress and takes no second press", () => {
  const onPress = jest.fn();
  const root = renderSurface(<ActionButton title="Try Again" onPress={onPress} busy testID="retry" />);
  const button = pressableNamed(root, "Try Again");
  expect(button.props.accessibilityRole).toBe("button");
  expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
  expect(button.props.disabled).toBe(true);
  expect(root.root.findAll((node) => node.props.testID === "retryBusy").length).toBeGreaterThan(0);
  unmount(root);
});

test("pressing an action dims it in place: no scale, no movement", () => {
  const root = renderSurface(<ActionButton title="Continue" onPress={() => undefined} />);
  const pressed = pressedStyleOf(pressableNamed(root, "Continue"), true);
  expect(pressed.opacity).toBe(press.filledOpacity);
  expect(pressed.transform).toBeUndefined();
  expect(pressedStyleOf(pressableNamed(root, "Continue"), false).opacity).toBeUndefined();
  unmount(root);
});

test("a filled action on an always-dark overlay pairs dark ink with its white fill, whatever the app's scheme", () => {
  const root = renderSurface(<ActionButton title="Open Settings" onPress={() => undefined} tone="overlay" />);
  const button = pressableNamed(root, "Open Settings");
  expect(pressedStyleOf(button, false).backgroundColor).toBe(overlayInk.fill);
  const label = host(button.findAll((node) => node.type === Text)[0]);
  expect(flat(label.props.style).color).toBe(overlayInk.onFill);
  unmount(root);
});

test("a filled accent action draws the accent fill with on-accent ink", () => {
  const root = renderSurface(
    <>
      <ThemeProbe />
      <ActionButton title="Get Started" onPress={() => undefined} size="hero" />
    </>,
  );
  const button = pressableNamed(root, "Get Started");
  expect(pressedStyleOf(button, false).backgroundColor).toBe(theme.spaceAccent);
  expect(pressedStyleOf(button, false).borderCurve).toBe("continuous");
  const label = host(button.findAll((node) => node.type === Text)[0]);
  expect(flat(label.props.style).color).toBe(theme.onSpaceAccent);
  unmount(root);
});

test("a tappable shares the press and disabled treatment: text dims on press, disabled reads as disabled", () => {
  const root = renderSurface(
    <>
      <Tappable kind="text" label="Cancel" onPress={() => undefined}>
        <Text>Cancel</Text>
      </Tappable>
      <Tappable kind="row" label="Row" onPress={() => undefined}>
        <Text>Row</Text>
      </Tappable>
      <Tappable kind="icon" label="Off" disabled onPress={() => undefined}>
        <Text>Off</Text>
      </Tappable>
      <ThemeProbe />
    </>,
  );
  expect(pressedStyleOf(pressableNamed(root, "Cancel"), true).opacity).toBe(press.textOpacity);
  expect(pressedStyleOf(pressableNamed(root, "Row"), true).backgroundColor).toBe(theme.rowPressed);
  const off = pressableNamed(root, "Off");
  expect(off.props.accessibilityState).toEqual({ disabled: true, busy: false });
  expect(pressedStyleOf(off, false).opacity).toBe(press.disabledOpacity);
  unmount(root);
});

test("the form switch is a checked switch whose off track is the system's off fill", () => {
  const onChange = jest.fn();
  const root = renderSurface(
    <>
      <ThemeProbe />
      <Toggle label="Block Ads" value={false} onChange={onChange} />
    </>,
  );
  const control = pressableNamed(root, "Block Ads");
  expect(control.props.accessibilityRole).toBe("switch");
  expect(control.props.accessibilityState).toEqual({ checked: false, disabled: false });
  act(() => control.props.onPress());
  expect(onChange).toHaveBeenCalledWith(true);
  const track = host(root.root.findAll((node) => node.props.testID === "toggleTrack" && typeof node.type === "string")[0]);
  const channels = (color: unknown) => String(color).replace(/[^\d.,]/g, "").split(",").map((value) => Math.round(Number(value) * 100) / 100);
  expect(channels(getAnimatedStyle(track).backgroundColor)).toEqual(channels(theme.switchOff));
  unmount(root);
});

test("a switch row is pressable as a whole, or only at the knob when asked", () => {
  const root = renderSurface(
    <>
      <ToggleRow testID="whole" label="Night Shade" value onChange={() => undefined} />
      <ToggleRow testID="knob" press="knob" label="Desktop Site" value={false} onChange={() => undefined} />
    </>,
  );
  const whole = pressableNamed(root, "Night Shade");
  expect(whole.props.accessibilityRole).toBe("switch");
  expect(flat(whole.props.style({ pressed: false })).flexDirection).toBe("row");
  const knob = pressableNamed(root, "Desktop Site");
  expect(knob.props.accessibilityRole).toBe("switch");
  expect(flat(typeof knob.props.style === "function" ? knob.props.style({ pressed: false }) : knob.props.style)?.flexDirection).toBeUndefined();
  expect(root.root.findAll((node) => node.props.accessibilityLabel === "Desktop Site").filter((node) => typeof node.props.onPress === "function").length).toBe(1);
  unmount(root);
});

test("field accessories and toggled icons get a 44-point target around a smaller glyph", () => {
  const root = renderSurface(
    <>
      <FieldAccessory icon="xmarkCircleFill" label="Clear Text" color="#000000" onPress={() => undefined} />
      <ToggleIconButton label="Incognito" checked onChange={() => undefined}>
        <View />
      </ToggleIconButton>
      <ToggleIconButton label="Grid" role="button" checked={false} onChange={() => undefined} layout="slop" visual={24}>
        <View />
      </ToggleIconButton>
    </>,
  );
  const clear = pressedStyleOf(pressableNamed(root, "Clear Text"), false);
  expect(clear.width).toBe(44);
  expect(clear.height).toBe(44);
  const incognito = pressableNamed(root, "Incognito");
  expect(incognito.props.accessibilityRole).toBe("switch");
  expect(incognito.props.accessibilityState).toEqual({ checked: true, disabled: false });
  const grid = pressableNamed(root, "Grid");
  expect(grid.props.accessibilityState).toEqual({ selected: false, disabled: false });
  expect(grid.props.hitSlop).toEqual({ top: 10, bottom: 10, left: 10, right: 10 });
  unmount(root);
});

test("a modal overlay is modal and escapable while open, and dead to touch and hidden the moment it starts closing", () => {
  const onDismiss = jest.fn();
  const focus = createRef<ViewInstance>();
  const view = (closing: boolean) => (
    <ModalOverlay testID="overlay" open closing={closing} onDismiss={onDismiss} focus={focus}>
      <View ref={focus} />
    </ModalOverlay>
  );
  const root = renderSurface(view(false));
  const open = host(root.root.findAll((node) => node.props.testID === "overlay" && typeof node.type === "string")[0]);
  expect(open.props.accessibilityViewIsModal).toBe(true);
  expect(open.props.pointerEvents).toBe("auto");
  act(() => open.props.onAccessibilityEscape());
  expect(onDismiss).toHaveBeenCalledTimes(1);
  act(() => root.update(view(true)));
  const closing = host(root.root.findAll((node) => node.props.testID === "overlay" && typeof node.type === "string")[0]);
  expect(closing.props.pointerEvents).toBe("none");
  expect(closing.props.accessibilityElementsHidden).toBe(true);
  expect(closing.props.importantForAccessibility).toBe("no-hide-descendants");
  expect(closing.props.onAccessibilityEscape).toBeUndefined();
  expect(closing.props.accessibilityViewIsModal).toBe(false);
  unmount(root);
});

test("with Reduce Motion a press-scale control dims in place instead of shrinking", () => {
  mockMotion.reduced = true;
  const root = renderSurface(
    <PressScale label="Tabs" onPress={() => undefined}>
      <View />
    </PressScale>,
  );
  const control = pressableNamed(root, "Tabs");
  act(() => control.props.onPressIn());
  act(() => jest.advanceTimersByTime(500));
  const face = host(control.findAll((node) => typeof node.type === "string" && node.props.style !== undefined)[0]);
  expect(getAnimatedStyle(face).transform).toEqual([{ scale: 1 }]);
  const dimmed = flat(control.props.children({ pressed: true }).props.style);
  expect(dimmed.opacity).toBe(press.iconOpacity);
  unmount(root);
});

test("without Reduce Motion a press-scale control settles at the shared press scale with no overshoot", () => {
  const root = renderSurface(
    <PressScale label="Tabs" onPress={() => undefined}>
      <View />
    </PressScale>,
  );
  const control = pressableNamed(root, "Tabs");
  act(() => control.props.onPressIn());
  const face = host(control.findAll((node) => typeof node.type === "string" && node.props.style !== undefined)[0]);
  let lowest = 1;
  for (let step = 0; step < 40; step++) {
    act(() => jest.advanceTimersByTime(8));
    lowest = Math.min(lowest, (getAnimatedStyle(face).transform as { scale: number }[])[0]!.scale);
  }
  expect(lowest).toBeGreaterThanOrEqual(0.93 - 1e-3);
  expect((getAnimatedStyle(face).transform as { scale: number }[])[0]!.scale).toBeCloseTo(0.93, 2);
  unmount(root);
});

test("empty and loading states give a heading, a glyph and a busy announcement", () => {
  const root = renderSurface(
    <>
      <EmptyState title="No Matching Tabs" glyph="magnifyingglass" message="Try a different word." action={{ title: "Clear Search", onPress: () => undefined }} />
      <LoadingState />
    </>,
  );
  expect(root.root.findAll((node) => node.props.accessibilityRole === "header" && typeof node.type !== "string").length).toBe(1);
  const loading = host(root.root.findAll((node) => node.props.accessibilityRole === "progressbar" && typeof node.type !== "string")[0]);
  expect(loading.props.accessibilityState).toEqual({ busy: true });
  expect(loading.props.accessibilityLabel).toBe("Loading…");
  unmount(root);
});

test("the page loading line draws the readable accent ink on every layout", () => {
  const root = renderSurface(
    <>
      <ThemeProbe />
      <LoadingLine watch={() => () => undefined} />
    </>,
  );
  const line = host(root.root.findAll((node) => node.props.testID === "loadingLine" && typeof node.type !== "string")[0]);
  const bar = host(line.findAll((node) => typeof node.type !== "string" && node.props.style)[1]);
  expect(flat(bar.props.style).backgroundColor).toBe(theme.spaceAccentInk);
  unmount(root);
});
