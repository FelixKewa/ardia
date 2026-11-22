import { takeLongHoverHolds } from "../../platform/focus";
import { isSharing, onConsentPeriodChange, type ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

let inWebKit = 0;

export function noteTabSwitcherOpenedInWebKit() {
  inWebKit++;
}

export function takeTabSwitcherOpensInWebKit(): number {
  const taken = inWebKit;
  inWebKit = 0;
  return taken;
}

let rowCloses = 0;

export function noteTabSwitcherRowClosed(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void rowCloses++);
}

export function takeTabSwitcherRowCloses(): number {
  const taken = rowCloses;
  rowCloses = 0;
  return taken;
}

let menuReleases = 0;

onConsentPeriodChange(() => (menuReleases = 0));

export function noteTabSwitcherReleasedInMenu() {
  if (isSharing()) menuReleases++;
}

export function takeTabSwitcherMenuReleases(): number {
  const taken = menuReleases;
  menuReleases = 0;
  return taken;
}

const scrollCounts = { overflowOpens: 0, overflowClicks: 0, wheelScrolls: 0, picturesLate: 0, hoverClipped: 0 };

export function noteTabSwitcherOverflowOpened() {
  scrollCounts.overflowOpens++;
}

export function noteTabSwitcherOverflowClick() {
  scrollCounts.overflowClicks++;
}

export function noteTabSwitcherWheelScrolled() {
  scrollCounts.wheelScrolls++;
}

export function noteTabSwitcherPictureLate() {
  scrollCounts.picturesLate++;
}

export function noteTabSwitcherHoverClipped() {
  scrollCounts.hoverClipped++;
}

export function takeTabSwitcherScrollCounts() {
  const taken = {
    tab_switcher_overflow_opens: scrollCounts.overflowOpens,
    tab_switcher_overflow_clicks: scrollCounts.overflowClicks,
    tab_switcher_wheel_scrolls: scrollCounts.wheelScrolls,
    tab_switcher_pictures_late: scrollCounts.picturesLate,
    tab_switcher_hover_clipped_skips: scrollCounts.hoverClipped,
    hover_holds_over_300ms: takeLongHoverHolds(),
  };
  scrollCounts.overflowOpens = scrollCounts.overflowClicks = scrollCounts.wheelScrolls = scrollCounts.picturesLate = scrollCounts.hoverClipped = 0;
  return taken;
}
