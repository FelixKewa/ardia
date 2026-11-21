export type LinuxControlsState = { pageFullScreen: boolean; hidden: boolean; utility: boolean; windowMenu: boolean; shown?: boolean };

export const windowButtonsRendered = ({ placed, pageFullScreen }: { placed: boolean; pageFullScreen: boolean }): boolean => placed && !pageFullScreen;

export const trafficLightsShown = ({ style, pageFullScreen, windowFullScreen }: { style: string; pageFullScreen: boolean; windowFullScreen: boolean }): boolean =>
  style === "trafficLights" && !pageFullScreen && !windowFullScreen;

export const linuxControlsBehaviour = ({ pageFullScreen, hidden, utility, windowMenu, shown = true }: LinuxControlsState) => {
  const rendered = windowButtonsRendered({ placed: true, pageFullScreen });
  return { rendered, inert: hidden, takesInput: rendered && !hidden && shown, windowMenuOnRightClick: windowMenu && !utility };
};

const CAPTION_BUTTON = '[role="button"]';
const TRAFFIC_LIGHT = ".ardia-window-control";

const primaryPressOn = (selector: string) => (event: { button: number; target: unknown }): boolean =>
  event.button === 0 && !!event.target && typeof event.target === "object" && "closest" in event.target && !!(event.target as Element).closest(selector);

export const pressKeepsFocusWhereItWas = primaryPressOn(CAPTION_BUTTON);

export const lightPressKeepsFocusWhereItWas = primaryPressOn(TRAFFIC_LIGHT);
