/**
 * Tokenization, kept deliberately dumb.
 *
 * No stemming, no stopword list, no synonyms. §8 chose structural retrieval over semantic
 * for one stated reason — when a query returns the wrong thing you can see exactly why —
 * and every clever transform here is a place where the answer stops being explicable. A
 * miss you can read the tokens of is worth more than a hit you cannot account for.
 *
 * Diacritics are folded because "café" and "cafe" are the same word to someone typing
 * quickly; that is the one normalization that pays for itself.
 */

const SPLIT = /[^\p{L}\p{N}]+/u;

export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(SPLIT)
    .filter((token) => token.length > 1);
}

/** Query terms get the same treatment as indexed text — asymmetry here is a silent miss. */
export function tokenizeQuery(text: string): string[] {
  return [...new Set(tokenize(text))];
}
