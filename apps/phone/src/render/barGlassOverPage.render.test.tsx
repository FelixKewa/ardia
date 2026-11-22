import { act } from "react-test-renderer";
import { FloatingBar } from "../components/browsing/FloatingBar";
import { ChromeSurface, rolesFor } from "../components/ui";
import { currentTabs } from "../state/tabs/store";
import { deckOrder } from "../state/tabs/tabsState";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

const noop = () => undefined;

function bar(anchors: boolean) {
  const order = deckOrder(currentTabs());
  const tab = order[order.length - 1]!;
  const root = renderSurface(<FloatingBar tab={tab} order={order} roles={rolesFor(false)} dark={false} showsPlus anchors={anchors} onTabs={noop} onTabsMenu={noop} onStep={noop} onAddress={noop} onPlus={noop} onMore={noop} />);
  const glass = root.root.findAll((node) => node.type === ChromeSurface).map((node) => node.props.overPage as string | undefined);
  return { root, tab, glass };
}

test("the live bar's tabs, address and + glass sit over its page, so the page's scroll edge blurs under them; a deck card's ghost bar claims no page", () => {
  const live = bar(true);
  expect(live.glass).toEqual([live.tab.id, live.tab.id, live.tab.id]);
  unmount(live.root);
  const ghost = bar(false);
  expect(ghost.glass).toEqual([undefined, undefined, undefined]);
  unmount(ghost.root);
});
