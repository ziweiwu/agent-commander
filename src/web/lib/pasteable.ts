/**
 * Which text can reach an agent as text (INV-2).
 *
 * Bracketed paste is a wrapper, not a sanitiser: tmux puts `ESC[200~` and
 * `ESC[201~` around a paste and passes whatever is inside straight through, so
 * a terminator inside the text ends the paste early and the rest arrives as
 * keypresses — an Enter, the interrupt, the mode cycle. The server refuses such
 * text in `pane::check_paste`, and this is the same rule, checked first so the
 * refusal can be said in the reader's language and the draft kept.
 *
 * Tab and both line breaks pass. `\r` has to: xterm's own paste turns line
 * breaks into CR, and the Attach view sends xterm's data as a paste.
 */

/** The control characters a paste carries as text. */
const KEPT = new Set(['\t', '\n', '\r'])
/** The last of the C0 controls; ESC is among them. */
const LAST_C0 = 0x1f
/** DEL, the first of the run that ends with the C1 controls. */
const DEL = 0x7f
const LAST_C1 = 0x9f
const HEX = 16
/** `U+001B`, never `U+1B`: the server spells the code point the same way. */
const CODE_DIGITS = 4

function isControl(code: number): boolean {
  return code <= LAST_C0 || (code >= DEL && code <= LAST_C1)
}

/**
 * The first character in `text` that would not arrive as text, as the hex
 * digits of its code point (`"001B"`), or `null` when there is none.
 */
export function controlCharacterIn(text: string): string | null {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (isControl(code) && !KEPT.has(ch)) {
      return code.toString(HEX).toUpperCase().padStart(CODE_DIGITS, '0')
    }
  }
  return null
}
