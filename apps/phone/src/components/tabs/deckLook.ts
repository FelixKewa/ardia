import { capsule, deckChromeLayout, shape } from "../ui";

export const deckLook = {
  switcherHeight: deckChromeLayout.headerCircle,
  switcherCorner: shape.control,
  switcherLead: 14,
  switcherTrail: 16,
  moreCorner: shape.control,
  fieldCorner: capsule(deckChromeLayout.barCircle),
  darkDepth: ["rgba(0,0,0,0.5)", "rgba(0,0,0,0.3)", "rgba(0,0,0,0.42)"],
} as const;
