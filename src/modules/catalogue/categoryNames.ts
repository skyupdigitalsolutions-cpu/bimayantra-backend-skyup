/**
 * Two category names mean the same category when they match after: lower case, "&" → "and", punctuation and extra
 * spaces removed, and the words insurance / cover / plan / policy dropped. So "Health", "health insurance",
 * "Health  Cover" and "HEALTH-plan" are one category; "Health" and "Critical illness" are not.
 */
export function categoryKey(name: string | null | undefined): string {
  const words = String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !['insurance', 'insurances', 'cover', 'covers', 'plan', 'plans', 'policy', 'policies'].includes(w));
  // "Health insurance" alone must not collapse to nothing
  return words.join(' ') || String(name ?? '').toLowerCase().trim();
}