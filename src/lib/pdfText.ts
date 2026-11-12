/**
 * Text for PDFs made with pdf-lib's standard fonts (Helvetica). Those fonts can only print the WinAnsi character set:
 * one character outside it (₹, ≥, a Devanagari name…) makes pdf-lib throw and the whole PDF fails (QT-13). So every
 * piece of text goes through `printable` first: common symbols get a readable stand-in (₹ → "Rs."), accented letters
 * lose the accent, and anything else that still cannot be printed becomes "?". `wrap` splits text into lines that fit
 * a width, so long feature values stay inside their column.
 */
import type { PDFFont } from 'pdf-lib';

const STAND_INS: Record<string, string> = {
  '₹': 'Rs.', '≥': '>=', '≤': '<=', '≠': '!=', '×': 'x', '÷': '/', '→': '->', '←': '<-', '⇒': '=>', '✓': 'Yes', '✔': 'Yes', '✗': 'No', '✘': 'No',
  '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ', '\u200b': '', '\t': ' ', '\r': '', '\n': ' ',
};

const cache = new WeakMap<PDFFont, Map<string, boolean>>();
function canPrint(font: PDFFont, ch: string) {
  let known = cache.get(font);
  if (!known) { known = new Map(); cache.set(font, known); }
  let ok = known.get(ch);
  if (ok === undefined) {
    try { font.widthOfTextAtSize(ch, 10); ok = true; } catch { ok = false; }
    known.set(ch, ok);
  }
  return ok;
}

/** The text with every character the font can print; never throws. */
export function printable(font: PDFFont, value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const ch of text) {
    if (STAND_INS[ch] !== undefined) { out += STAND_INS[ch]; continue; }
    if (canPrint(font, ch)) { out += ch; continue; }
    const plain = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); // é → e
    out += plain && [...plain].every((c) => canPrint(font, c)) ? plain : '?';
  }
  return out;
}

/**
 * Lines of at most `maxWidth` points. Spacing inside a line is kept as written (some PDFs separate items with three
 * spaces); spaces at a line break are dropped; a word longer than the width is cut. Always at least one line.
 */
export function wrap(font: PDFFont, value: unknown, size: number, maxWidth: number): string[] {
  const tokens = printable(font, value).trim().split(/( +)/).filter(Boolean); // words and the spaces between them
  const lines: string[] = [];
  let cur = '';
  const fits = (t: string) => font.widthOfTextAtSize(t, size) <= maxWidth;
  for (let t of tokens) {
    if (t.startsWith(' ')) { if (cur) cur += t; continue; } // spaces: kept unless at the start of a line
    while (!fits(t)) { // a very long word: cut it to the width
      let n = t.length - 1;
      while (n > 1 && !fits(t.slice(0, n))) n--;
      if (cur.trim()) lines.push(cur.trimEnd());
      cur = '';
      lines.push(t.slice(0, n)); t = t.slice(n);
    }
    if (fits(cur + t)) cur += t; else { lines.push(cur.trimEnd()); cur = t; }
  }
  if (cur.trim() || !lines.length) lines.push(cur.trimEnd());
  return lines;
}