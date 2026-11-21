import type { ProfileTheme } from "./profileLook";

export type ThemeEdit = { theme: ProfileTheme | null; target: string };

type Deps = {
  apply: (theme: ProfileTheme | null) => void;
  showing: () => string;
  draft: (edit: ThemeEdit | null) => void;
  requestFrame: (run: () => void) => number;
  cancelFrame: (handle: number) => void;
};

export function themeGesture(deps: Deps) {
  let pending: ThemeEdit | undefined;
  let frame: number | null = null;
  let gesture: string | null = null;
  let cancelled = false;
  const stopFrame = () => {
    if (frame !== null) deps.cancelFrame(frame);
    frame = null;
  };
  const flush = () => {
    frame = null;
    const edit = pending;
    pending = undefined;
    if (edit && edit.target === deps.showing()) deps.apply(edit.theme);
  };
  const drop = () => {
    stopFrame();
    pending = undefined;
    deps.draft(null);
  };
  return {
    begin(target: string) {
      gesture ??= target;
    },
    change(theme: ProfileTheme | null, target: string, settle = false) {
      gesture ??= target;
      if (cancelled || gesture !== target || deps.showing() !== target) {
        drop();
        cancelled = true;
        if (settle) {
          gesture = null;
          cancelled = false;
        }
        return;
      }
      pending = { theme, target };
      deps.draft(settle ? null : pending);
      if (settle) {
        stopFrame();
        flush();
        gesture = null;
      } else if (frame === null) frame = deps.requestFrame(flush);
    },
    selectionChanged() {
      if (gesture === null) return;
      drop();
      cancelled = true;
    },
    cancel() {
      drop();
      cancelled = gesture !== null;
      if (!cancelled) gesture = null;
    },
    dispose: stopFrame,
  };
}
