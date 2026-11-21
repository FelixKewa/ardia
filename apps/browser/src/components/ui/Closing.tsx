import { createContext, use, useCallback, useEffect, useRef, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";
import { Animated, type TextInput } from "react-native";

const ClosingContext = createContext(false);

export const useClosing = () => use(ClosingContext);

export function ClosingScope({ closing, children }: { closing: boolean; children: ReactNode }) {
  const outer = useClosing();
  return <ClosingContext value={closing || outer}>{children}</ClosingContext>;
}

export function ClosingView({ closing, pointerEvents, children, ...props }: Omit<ComponentPropsWithRef<typeof Animated.View>, "children"> & { closing: boolean; children?: ReactNode }) {
  const outer = useClosing();
  const dead = closing || outer;
  const cutoff = {
    pointerEvents: dead ? ("none" as const) : pointerEvents,
    accessibilityElementsHidden: dead,
    importantForAccessibility: dead ? ("no-hide-descendants" as const) : ("auto" as const),
    inert: dead || undefined,
  };
  return (
    <Animated.View {...props} {...cutoff}>
      <ClosingContext value={dead}>{children}</ClosingContext>
    </Animated.View>
  );
}

const IGNORED = () => {};
const ALWAYS_OPEN = () => true;

export const whileOpen =
  (closing: boolean, stillOpen: () => boolean = ALWAYS_OPEN) =>
  <A extends unknown[]>(action: (...args: A) => unknown): ((...args: A) => void) =>
    closing
      ? IGNORED
      : (...args: A) => {
          if (stillOpen()) action(...args);
        };

export function useStillOpen(open: boolean) {
  const latest = useRef(open);
  latest.current = open;
  return useCallback(() => latest.current, []);
}

export function useClosingField(inputRef?: Ref<TextInput>) {
  const closing = useClosing();
  const field = useRef<TextInput | null>(null);
  const outer = useRef(inputRef);
  outer.current = inputRef;
  useEffect(() => {
    if (closing) field.current?.blur();
  }, [closing]);
  const ref = useCallback((node: TextInput | null) => {
    field.current = node;
    const target = outer.current;
    if (typeof target === "function") target(node);
    else if (target) target.current = node;
  }, []);
  return { closing, ref };
}
