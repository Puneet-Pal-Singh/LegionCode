export interface ComposerPreferences {
  readonly plainTextComposer: boolean;
  readonly sendShortcut: "enter" | "modifier_enter";
  readonly followUpBehavior: "queue" | "steer";
}

export type ComposerDelivery = "queue" | "steer";

export type ComposerKeyboardAction =
  | { readonly type: "ignore" }
  | { readonly type: "submit"; readonly delivery?: ComposerDelivery };

export function resolveComposerKeyboardAction(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey?: boolean;
  readonly isComposing: boolean;
  readonly isActive: boolean;
  readonly preferences: Pick<
    ComposerPreferences,
    "sendShortcut" | "followUpBehavior"
  >;
}): ComposerKeyboardAction {
  if (
    input.key !== "Enter" ||
    input.shiftKey ||
    input.isComposing ||
    input.altKey
  ) {
    return { type: "ignore" };
  }

  const modifierPressed = input.metaKey || input.ctrlKey;
  if (input.isActive) {
    return {
      type: "submit",
      delivery: modifierPressed ? "steer" : "queue",
    };
  }

  const shouldSubmit =
    input.preferences.sendShortcut === "enter"
      ? true
      : modifierPressed;
  if (!shouldSubmit) {
    return { type: "ignore" };
  }

  return {
    type: "submit",
  };
}
