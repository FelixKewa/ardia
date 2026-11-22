import { capsule, floatingBarLayout, font, glyphSlot, space, stroke } from "../ui/tokens";

export const searchPanel = {
  fieldHeight: 44,
  fieldInset: space.l,
  fieldLeading: space.xl,
  fieldTrailing: space.s,
  fieldEdge: stroke.chrome,
  maxTextScale: floatingBarLayout.maxTextScale,
  rowsTop: 5,
  rowPitch: 51,
  rowsShown: 4,
  bottom: space.s,
  rowInset: 6,
  rowLeading: 10,
  rowTrailing: 10,
  iconSlot: glyphSlot.field,
  iconGap: 9,
  glyph: 19,
  trailingGlyph: 15,
  titleSize: font.body.fontSize,
  detailSize: font.subheadline.fontSize,
  captionSize: font.callout.fontSize,
  incognitoLabel: font.footnote.fontSize,
  eyes: 26,
  eyesGap: 5,
  light: { tint: "rgba(255,255,255,0.62)", solid: "#F2F2F4", field: "rgba(118,118,128,0.17)", fieldEdge: "rgba(0,0,0,0.07)" },
  dark: { tint: "rgba(30,30,32,0.6)", solid: "#1C1C1E", field: "rgba(118,118,128,0.3)", fieldEdge: "rgba(255,255,255,0.05)" },
  incognito: { tint: "rgba(14,14,16,0.86)", solid: "#121214", field: "rgba(118,118,128,0.28)", fieldEdge: "rgba(255,255,255,0.05)", caption: "rgba(235,235,245,0.5)", label: "rgba(235,235,245,0.55)" },
} as const;

export const searchFieldScale = (fontScale: number) => Math.min(Math.max(fontScale, 1), searchPanel.maxTextScale);

export const searchFieldHeight = (fontScale: number) => searchPanel.fieldHeight * searchFieldScale(fontScale);

export const searchPanelRadius = (fieldHeight: number) => capsule(fieldHeight) + searchPanel.fieldInset;

export const searchPanelHeight = (fieldHeight: number, fontScale: number) => searchPanel.fieldInset + fieldHeight + searchPanel.rowsTop + searchPanel.rowsShown * searchPanel.rowPitch * fontScale + searchPanel.bottom;

export const searchPanelFieldBlock = (fieldHeight: number) => searchPanel.fieldInset + fieldHeight + searchPanel.rowsTop;

export const searchPanelFieldCenter = (fieldHeight: number) => searchPanel.fieldInset + fieldHeight / 2;

export const searchPanelInk = (incognito: boolean, dark: boolean) => (incognito ? searchPanel.incognito : dark ? searchPanel.dark : searchPanel.light);
