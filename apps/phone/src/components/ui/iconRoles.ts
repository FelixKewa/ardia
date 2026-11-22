import type { SymbolName } from "./symbolPaths";

export const iconRoles = {
  copyLink: "link",
  copyText: "docOnDoc",
  share: "squareAndArrowUp",
  textSize: "textformatSize",
  sidebar: "sidebarLeft",
  newTab: "plus",
  more: "ellipsis",
  clearText: "xmarkCircleFill",
  voice: "mic",
  reload: "arrowClockwise",
  stopLoading: "xmark",
  noResults: "magnifyingglass",
} as const satisfies Record<string, SymbolName>;

export type IconRole = keyof typeof iconRoles;
