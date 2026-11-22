import { StyleSheet } from "react-native";
import { press } from "../components/ui";
import { act } from "react-test-renderer";
import { ToastHost } from "../components/toasts/ToastHost";
import { showToast, useToasts } from "../state/toasts/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  useToasts.setState({ toast: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const toastNode = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => node.props.testID === "toast" && typeof node.type === "string")[0]!;
const symbols = (root: ReturnType<typeof renderSurface>) => root.root.findAll((node) => typeof node.props.name === "string" && typeof node.props.size === "number" && typeof node.type !== "string").map((node) => node.props.name as string);

test("a toast without an action is an alert with no press, and swiping it away has a named screen reader action", () => {
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Copied Link", "link"));
  const toast = toastNode(root);
  expect(toast.props.accessibilityRole).toBe("alert");
  expect(toast.props.onPress).toBeUndefined();
  expect(toast.props.accessibilityActions.map((action: { name: string }) => action.name)).toEqual(["escape", "dismiss"]);
  expect(root.root.findAll((node) => node.props.testID === "toastAction")).toHaveLength(0);
  act(() => toast.props.onAccessibilityAction({ nativeEvent: { actionName: "dismiss" } }));
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});

test("a toast with an action is a button that dims on press with the shared look, names its action in words and to screen readers, and runs it on tap", () => {
  const tapped = jest.fn();
  const root = renderSurface(<ToastHost />);
  act(() => showToast("Downloaded otter.pdf", "download", 3000, { label: "Open", run: tapped }));
  const toast = root.root.findAll((node) => node.props.testID === "toast" && typeof node.props.style === "function")[0]!;
  expect(toast.props.accessibilityRole).toBe("button");
  expect(toast.props.accessibilityLabel).toBe("Downloaded otter.pdf, Open");
  expect(toast.props.accessibilityActions.map((action: { name: string }) => action.name)).toEqual(["escape", "dismiss"]);
  expect(root.root.findAll((node) => node.props.testID === "toastAction" && typeof node.type === "string")[0]!.props.children).toBe("Open");
  expect(symbols(root)).not.toContain("chevronRight");
  expect(StyleSheet.flatten(toast.props.style({ pressed: false })).opacity).toBeUndefined();
  expect(StyleSheet.flatten(toast.props.style({ pressed: true })).opacity).toBe(press.filledOpacity);
  act(() => toast.props.onPress());
  expect(tapped).toHaveBeenCalledTimes(1);
  expect(useToasts.getState().toast).toBeNull();
  unmount(root);
});
