/**
 * Whether a Playwright key could insert a character into a protected field.
 * Modifiers do not make the argument safe to persist: Shift+X, Shift+Space
 * and combinations with several modifiers still carry the character.
 * Shared by browser confirmation and runner event redaction so they agree
 * before the runner has access to the focused element.
 */
export function keyInsertsText(key: string): boolean {
  const last = key.split('+').at(-1) ?? ''
  return key === '+' || key.endsWith('++') || last.length === 1 || last === 'Space'
}
