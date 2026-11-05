/**
 * Questions that name a kind of thing rather than a thing.
 *
 * "Quelle commande a échoué ?" contains no searchable content at all. Every word in it is either a
 * question word or the name of a category, and a purely lexical search answers it with a refusal —
 * correctly, and uselessly, since it is one of the canonical queries in SEARCH §10 and the answer is
 * sitting right there in the corpus.
 *
 * So category words are lifted out of the query and become a filter over row kinds instead of terms
 * to match. "La doc stripe" then searches for `stripe` among URLs, which is both narrower and more
 * accurate than searching for the two words together.
 *
 * The filter is applied hard and then abandoned if it empties the result set. A reader who says
 * "fichier" while the match is a commit message is better served by the commit than by nothing, and
 * a category word is a hint about what they are looking for, not a constraint they typed on purpose.
 */

import type { RowKind } from './rows.js';
import { tokenize } from './text.js';

const WORDS: Record<string, RowKind[]> = {
  // A command and a failed command are different rows; someone asking about commands means both.
  commande: ['command', 'error'],
  commandes: ['command', 'error'],
  command: ['command', 'error'],
  commands: ['command', 'error'],
  terminal: ['command', 'error'],

  fichier: ['file'],
  fichiers: ['file'],
  file: ['file'],
  files: ['file'],
  dossier: ['file'],
  folder: ['file'],

  commit: ['commit'],
  commits: ['commit'],
  branche: ['commit'],
  branch: ['commit'],

  page: ['url'],
  pages: ['url'],
  lien: ['url'],
  liens: ['url'],
  link: ['url'],
  url: ['url'],
  doc: ['url'],
  docs: ['url'],
  documentation: ['url'],
  site: ['url'],

  erreur: ['error'],
  erreurs: ['error'],
  echec: ['error'],
  echoue: ['error'],
  echoues: ['error'],
  error: ['error'],
  errors: ['error'],
  failed: ['error'],
  failure: ['error'],
  plante: ['error'],

  note: ['note'],
  notes: ['note'],

  agent: ['agent'],
  claude: ['agent'],

  fenetre: ['window'],
  window: ['window'],
  onglet: ['window'],
};

export interface KindScope {
  kinds: Set<RowKind>;
  /** The words that named them, so they can be taken out of the search terms. */
  words: Set<string>;
}

/** The row kinds a question names, if any. */
export function scopeOf(query: string): KindScope {
  const kinds = new Set<RowKind>();
  const words = new Set<string>();
  for (const token of tokenize(query)) {
    const found = WORDS[token];
    if (!found) continue;
    words.add(token);
    for (const kind of found) kinds.add(kind);
  }
  return { kinds, words };
}
