/**
 * Tokenisation — the part that decides whether a code-shaped query works at all (SEARCH §4.1).
 *
 * The specification asks for `unicode61` with `remove_diacritics 2` plus a pre-tokenisation pass that
 * splits identifiers, and it is right about why: without that pass, `stripe.webhook.ts` does not match
 * `webhook` and `feature/auth-session` does not match `session`, which is most of what a developer
 * actually types into a search box. This is that pass, in TypeScript, so the ranking can be tuned
 * against the golden sessions before any of it is ported to Rust and FTS5.
 *
 * Folding is deliberately aggressive in one direction only: a query loses accents and case so that
 * `déploiement` finds `deploiement`, and nothing is ever folded back. There is no stemmer. A stemmer
 * for one language mangles the other, and this product is bilingual by default (§147) — prefix
 * matching covers the plural-and-conjugation cases that a stemmer would, without deciding which
 * language a token belongs to.
 */

/**
 * Words that carry no retrieval signal in either language. Query-side only — see `terms`.
 *
 * The conjugated verbs at the end of each language's block are here for a specific failure: "sur
 * quoi je travaillais ?" is a question about nothing in particular, and leaving `travaillais` in
 * turns it into a search for the word "travaillais", which appears nowhere and refuses to answer a
 * question that was perfectly clear. The interrogative verbs belong to the question, not to what is
 * being asked about.
 */
const STOPWORDS = new Set([
  // French
  'a',
  'ai',
  'au',
  'aux',
  'avec',
  'ce',
  'ces',
  'cet',
  'cette',
  'dans',
  'de',
  'des',
  'du',
  'elle',
  'en',
  'est',
  'et',
  'etait',
  'etais',
  'ete',
  'eu',
  'faire',
  'fait',
  'il',
  'j',
  'je',
  'l',
  'la',
  'le',
  'les',
  'leur',
  'lui',
  'ma',
  'mais',
  'me',
  'mes',
  'moi',
  'mon',
  'ne',
  'nos',
  'notre',
  'nous',
  'on',
  'ou',
  'par',
  'pas',
  'pour',
  'qu',
  'que',
  'quel',
  'quelle',
  'qui',
  'sa',
  'se',
  'ses',
  'son',
  'sur',
  'ta',
  'te',
  'tes',
  'toi',
  'ton',
  'tu',
  'un',
  'une',
  'vers',
  'sans',
  'sous',
  'entre',
  'chez',
  'y',
  'quoi',
  'comment',
  'quand',
  'combien',
  'avais',
  'avait',
  'bosse',
  'bossais',
  'bosser',
  'faisais',
  'faisait',
  'travaille',
  'travaillais',
  'travailler',
  // English
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
  'about',
  'doing',
  'working',
  'worked',
]);

/** Lowercase, accents removed. `Déploiement` and `deploiement` are the same word to a reader. */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Every token a string contributes, identifiers taken apart.
 *
 * `src/auth/session.ts` yields `src auth session ts`, and `firstPaymentAt` additionally yields
 * `first payment at` **as well as** the whole identifier — the whole form is kept because someone
 * searching `firstPaymentAt` verbatim must rank above someone searching `at`.
 */
export function tokenize(value: string): string[] {
  const out: string[] = [];
  for (const chunk of fold(value).split(/[^\p{L}\p{N}]+/u)) {
    if (chunk.length < 2) continue;
    out.push(chunk);
  }
  // camelCase is split on the original string: folding to lowercase first would destroy the boundary.
  for (const chunk of value.split(/[^\p{L}\p{N}]+/u)) {
    if (!/[a-z][A-Z]/.test(chunk)) continue;
    for (const part of chunk.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const folded = fold(part);
      if (folded.length >= 2) out.push(folded);
    }
  }
  return out;
}

/** Query-side tokens: tokenised, stopwords dropped, duplicates collapsed, order preserved. */
export function terms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(query)) {
    if (STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Does a document token satisfy a query term?
 *
 * Prefix rather than equality, and only in that direction: typing `deploy` should find `deployment`,
 * while typing `deployment` must not be satisfied by `deploy`. Three characters is the floor —
 * below it a prefix matches half the corpus and the score stops meaning anything.
 */
export function matches(term: string, token: string): boolean {
  return token === term || (term.length >= 3 && token.startsWith(term));
}
