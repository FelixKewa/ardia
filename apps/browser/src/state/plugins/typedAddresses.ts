import { urlParts } from "../../lib/urlParts";
import { isLocalOrigin, switchOrigin } from "../../lib/pluginPageBar";
import { pageBarsWanted } from "./chrome";
import { consentNow, type ConsentToken } from "../telemetry/choice";

const TYPED_INTENT_MS = 20_000;
const typed = new Map<string, { url: string; origin: string; at: number; consent: ConsentToken | null }>();

function documentUrl(url: string): string {
  const origin = switchOrigin(url);
  const parts = urlParts(url);
  return origin && parts ? `${origin}${parts.path || "/"}${parts.query}` : url.replace(/#.*$/, "");
}

function dropExpired(now: number) {
  for (const [tabId, intent] of typed) if (now - intent.at > TYPED_INTENT_MS) typed.delete(tabId);
}

export function noteTypedAddress(tabId: string, url: string, now = Date.now()) {
  dropExpired(now);
  const origin = pageBarsWanted() ? switchOrigin(url) : null;
  if (origin && isLocalOrigin(origin)) typed.set(tabId, { url: documentUrl(url), origin, at: now, consent: consentNow() });
  else typed.delete(tabId);
}

export const dropTypedAddress = (tabId: string) => void typed.delete(tabId);

export const dropAllTypedAddresses = () => typed.clear();

export const typedAddressCount = () => typed.size;

export function takeTypedAddress(tabId: string, committedUrl: string, committedAt: number, now = Date.now()): { origin: string; consent: ConsentToken | null } | null {
  const intent = typed.get(tabId);
  if (!intent || !(committedAt > 0) || committedAt < intent.at) return null;
  typed.delete(tabId);
  if (now - intent.at > TYPED_INTENT_MS || documentUrl(committedUrl) !== intent.url || switchOrigin(committedUrl) !== intent.origin) return null;
  return { origin: intent.origin, consent: intent.consent };
}
