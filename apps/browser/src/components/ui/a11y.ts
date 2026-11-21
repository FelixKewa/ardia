type KeyPress = { nativeEvent: { key?: string }; preventDefault?: () => void };

export function radioA11y(checked: boolean, label?: string) {
  return {
    accessibilityRole: "radio",
    accessibilityLabel: label,
    accessibilityState: { checked, selected: checked },
    "aria-checked": checked,
  } as const;
}

export function checkboxA11y(checked: boolean | "mixed", disabled?: boolean, label?: string) {
  return {
    accessibilityRole: "checkbox",
    accessibilityLabel: label,
    accessibilityState: { checked, disabled: !!disabled },
    "aria-checked": checked,
    "aria-disabled": !!disabled,
  } as const;
}

export function switchA11y(on: boolean, disabled?: boolean, label?: string) {
  return {
    accessibilityRole: "switch",
    accessibilityLabel: label,
    accessibilityState: { checked: on, disabled: !!disabled },
    "aria-checked": on,
    "aria-disabled": !!disabled,
  } as const;
}

export const spaceActivates =
  <E extends KeyPress>(activate: (e: E) => void) =>
  (e: E) => {
    if (e.nativeEvent.key !== " ") return;
    e.preventDefault?.();
    activate(e);
  };
