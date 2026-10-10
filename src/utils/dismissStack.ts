/**
 * The open surfaces that Escape and Android's Back button can dismiss, in the
 * order they opened. Only the topmost one is dismissed per press, so a window
 * opened on top of another (a picker over a form, a confirm over a list)
 * closes first and the one beneath stays open.
 *
 * Surfaces register through useEscapeKey; the keyboard listener there and
 * the hardware Back listener in native/backButton.ts both call dismissTop.
 */
const stack: Array<() => void> = []

/** Register a surface's dismiss action. Returns the unregister function. */
export function pushDismiss(handler: () => void): () => void {
  stack.push(handler)
  return () => {
    const i = stack.lastIndexOf(handler)
    if (i !== -1) stack.splice(i, 1)
  }
}

/** Dismiss the topmost surface. False when nothing is open. */
export function dismissTop(): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  top()
  return true
}
