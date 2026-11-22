import { mobileClean } from "@ardia/core/src/mobile.ts";
import { copiedLinkWords } from "../../lib/sharedWords.ts";

export function linkToCopy(url: string) {
  const text = mobileClean(url);
  return { text, acknowledgement: copiedLinkWords(text !== url) };
}
