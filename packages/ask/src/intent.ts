/**
 * What kind of question this is (SEARCH §2).
 *
 * Seven intents, classified by ordered rules, first match wins. Rules rather than a model, and not
 * only because there is no model here to run: the classification has to be explainable in the
 * interface — the reader sees which intent fired and can change it — and a rule can be shown, argued
 * with, and fixed by whoever disagrees with it.
 *
 * Misclassification is deliberately cheap. `retrieval` is the default and always returns evidence,
 * so the worst outcome of a wrong guess is a list where a rollup would have read better, never an
 * empty screen.
 */

export type Intent =
  'resume' | 'temporal' | 'retrieval' | 'causal' | 'summary' | 'navigation' | 'comparison';

export interface Classification {
  intent: Intent;
  /** The words that decided it, so the interface can show why — and so a test can pin the reason. */
  because: string;
}

/**
 * Fold accents, case, and every shape of apostrophe.
 *
 * The apostrophe matters more than it looks: macOS types `’` and a keyboard types `'`, so a pattern
 * written with one silently never matches what the other produces. "où j'en étais" is exactly the
 * kind of phrase this product has to understand, and it contains one.
 */
const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019\u02bc`]/g, "'")
    .toLowerCase()
    .trim();

const RESUME =
  /\b(reprendre|reprends|ou j'en etais|ou en etais-?je|sur quoi (je|j')|je (bossais|travaillais|faisais) quoi|resume|where was i|what was i (doing|working)|pick up)\b/;
const CAUSAL = /^(pourquoi|why)\b/;
const NAVIGATION = /^(ouvre|ouvrir|va a|va au|va sur|montre|affiche|open|go to|show me the)\b/;
const RETRIEVAL =
  /\b(trouve|retrouve|ou est|ou etait|quelle page|ce doc|ce lien|le lien|find|where is|where was|which page|that doc|the link)\b/;
const SUMMARY = /\b(resume de|recap|recapitulatif|bilan|apercu|summar|overview)\b/;
const COMPARISON = /\b(compare|comparer|comparaison|difference|different|versus|vs)\b/;

/** Verbs that turn a date into a question about work done, rather than a date mentioned in passing. */
const ACTION =
  /\b(fait|fais|bosse|bossais|travaille|travaillais|did|do|worked|working|was|were|been)\b/;

/**
 * Classify, in the order the specification lays down.
 *
 * `hasTimeExpression` is passed rather than re-detected because the temporal resolver already did
 * the work and is the authority on it. Two independent notions of "mentions a time" is exactly the
 * kind of drift that makes a classifier disagree with the window it produced.
 */
export function classify(query: string, hasTimeExpression: boolean): Classification {
  const text = fold(query);
  const first = (pattern: RegExp): string | null => pattern.exec(text)?.[0] ?? null;

  const resume = first(RESUME);
  if (resume) return { intent: 'resume', because: resume };

  const causal = first(CAUSAL);
  if (causal) return { intent: 'causal', because: causal };

  const action = first(ACTION);
  if (hasTimeExpression && action) return { intent: 'temporal', because: action };

  const navigation = first(NAVIGATION);
  if (navigation) return { intent: 'navigation', because: navigation };

  const retrieval = first(RETRIEVAL);
  if (retrieval) return { intent: 'retrieval', because: retrieval };

  const summary = first(SUMMARY);
  if (summary) return { intent: 'summary', because: summary };

  const comparison = first(COMPARISON);
  if (comparison) return { intent: 'comparison', because: comparison };

  // A bare time expression with no verb — "hier", "la semaine dernière" — is a request for the
  // rollup of that window. It is the shape of question a reader types into a box that just opened,
  // and answering it with a ranked event list would be a worse reading of a clear intent.
  if (hasTimeExpression) return { intent: 'summary', because: 'time' };

  return { intent: 'retrieval', because: 'default' };
}
