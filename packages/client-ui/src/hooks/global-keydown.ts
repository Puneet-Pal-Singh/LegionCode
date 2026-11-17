/** Focused controls and active IME composition own their keyboard events. */
export function shouldIgnoreGlobalKeyDown(event: KeyboardEvent): boolean {
  return event.defaultPrevented || event.isComposing || event.keyCode === 229;
}
