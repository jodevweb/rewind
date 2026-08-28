/**
 * Anchor extraction (ADR 0002 D-14).
 *
 * An anchor is a distinctive identifier that recurs across applications. Extracting them well is the
 * single highest-leverage thing the context engine does — it is what lets a Slack window, a Linear
 * window, a Figma document and a Git branch be recognised as one piece of work, including for
 * contexts that touch no code at all.
 *
 * This is the TypeScript reference implementation. Its job is to be scored against the golden set
 * *before* the Rust port, so the heuristics arrive in Rust already validated rather than guessed.
 */

import type { GoldenEvent } from '@rewind/fixtures/authoring';

export type AnchorType =
  'issue' | 'project' | 'repository' | 'branch' | 'worktree' | 'document' | 'url' | 'keyword';

export interface Anchor {
  type: AnchorType;
  value: string;
  normalizedValue: string;
  confidence: number;
  source: string;
}

/**
 * Strength tiers. This ordering is the load-bearing design decision of the whole engine.
 *
 * `repository` is deliberately *weak*: GS-04 puts two unrelated tasks in one repository, and GS-07
 * has a repository appear an hour into a nine-application session. A repository says "these could be
 * related"; an issue id says "these are the same work".
 *
 * `document` is *medium*, not strong — a correction the benchmark forced. Treating a shared file as
 * strong evidence collapsed GS-04's two tasks into one, because they share `src/auth/user.ts`. Two
 * pieces of work touching the same file is common; two pieces of work under the same issue id is not.
 */
export const STRONG: AnchorType[] = ['issue', 'worktree'];
export const MEDIUM: AnchorType[] = ['branch', 'project', 'document'];
export const WEAK: AnchorType[] = ['repository', 'url', 'keyword'];

export function strength(type: AnchorType): 'strong' | 'medium' | 'weak' {
  if (STRONG.includes(type)) return 'strong';
  if (MEDIUM.includes(type)) return 'medium';
  return 'weak';
}

/** Lower-case, strip accents, collapse punctuation. "Sideproject" and "sideproject" must match. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const ISSUE_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

/** Shapes that look like issue ids but are not. */
const ISSUE_DENYLIST = new Set([
  'UTF-8',
  'UTF-16',
  'HTTP-2',
  'SHA-1',
  'SHA-256',
  'ISO-8601',
  'RFC-3339',
]);

/** Application-name suffixes that every window title carries and that carry no context. */
const APP_SUFFIXES = [
  'Slack',
  'Linear',
  'Figma',
  'Notes',
  'Mail',
  'Finder',
  'Terminal',
  'iTerm2',
  'Google Chrome',
  'Chrome',
  'Safari',
  'Cockpit',
  'Aperçu',
  'Preview',
  'Visual Studio Code',
  'Windows Terminal',
];

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'into',
  'your',
  'you',
  'are',
  'was',
  'were',
  'has',
  'have',
  'new',
  'all',
  'out',
  'how',
  'why',
  'what',
  'when',
  'where',
  'which',
  'who',
  'open',
  'close',
  'file',
  'files',
  'page',
  'home',
  'main',
  'app',
  'apps',
  'http',
  'https',
  'www',
  'com',
  'org',
  'net',
  'run',
  'runs',
  'test',
  'tests',
  'les',
  'des',
  'une',
  'pour',
  'avec',
  'dans',
  'sur',
  'par',
  'aux',
  'est',
  'sont',
  'vous',
  'nous',
  'plus',
  'tout',
  'documentation',
  'docs',
  'reference',
  'guide',
  'issue',
  'pull',
  'request',
  'commit',
  'branch',
  'error',
  'failed',
  'passed',
  'review',
  'draft',
  'untitled',
  'window',
  'tab',
  'search',
  'settings',
  'general',
  'random',
]);

function stripAppSuffix(title: string): string {
  let out = title;
  for (const app of APP_SUFFIXES) {
    // Titles are "<content> — <App>" or "<content> - <App>".
    const re = new RegExp(`\\s*[—–-]\\s*${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    out = out.replace(re, '');
  }
  return out;
}

function pushAnchor(list: Anchor[], a: Anchor): void {
  if (!a.normalizedValue || a.normalizedValue.length < 2) return;
  if (list.some((x) => x.type === a.type && x.normalizedValue === a.normalizedValue)) return;
  list.push(a);
}

function issuesFrom(text: string, source: string, out: Anchor[]): void {
  for (const m of text.matchAll(ISSUE_RE)) {
    const value = m[1]!;
    if (ISSUE_DENYLIST.has(value)) continue;
    pushAnchor(out, {
      type: 'issue',
      value,
      normalizedValue: normalize(value),
      confidence: 0.95,
      source,
    });
  }
}

/** Anchors visible in a single event, before the cross-application recurrence pass. */
export function extractAnchors(event: GoldenEvent): Anchor[] {
  const out: Anchor[] = [];
  const meta = event.metadata as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof meta[k] === 'string' ? (meta[k] as string) : undefined;

  // 1. Declared anchors from a Level 2 source. It knows its own domain; trust it.
  if (Array.isArray(meta['anchors'])) {
    for (const raw of meta['anchors'] as { type?: string; value?: string }[]) {
      if (!raw?.type || !raw?.value) continue;
      pushAnchor(out, {
        type: raw.type as AnchorType,
        value: raw.value,
        normalizedValue: normalize(raw.value),
        confidence: 0.98,
        source: 'external',
      });
    }
  }

  // 2. Structured identifiers, wherever they appear.
  if (event.title) issuesFrom(event.title, 'window_title', out);
  for (const key of ['to', 'branch', 'messageRedacted', 'commandRedacted', 'mission', 'url']) {
    const v = str(key);
    if (v) issuesFrom(v, key === 'url' ? 'url' : 'branch', out);
  }

  // 3. Git and worktree identity.
  const branch = str('to') ?? str('branch');
  if (branch) {
    pushAnchor(out, {
      type: 'branch',
      value: branch,
      normalizedValue: normalize(branch),
      confidence: 0.85,
      source: 'branch',
    });
  }
  const worktree = str('worktree') ?? str('projectPath') ?? str('workspacePath');
  if (worktree) {
    pushAnchor(out, {
      type: 'worktree',
      value: worktree,
      normalizedValue: normalize(worktree.split(/[/\\]/).slice(-2).join('-')),
      confidence: 0.9,
      source: 'path',
    });
  }
  if (event.repositoryId) {
    pushAnchor(out, {
      type: 'repository',
      value: event.repositoryId,
      normalizedValue: normalize(event.repositoryId),
      confidence: 0.5,
      source: 'path',
    });
  }
  const project = str('project');
  if (project) {
    pushAnchor(out, {
      type: 'project',
      value: project,
      normalizedValue: normalize(project),
      confidence: 0.9,
      source: 'external',
    });
  }

  // 4a. A working directory or workspace is a *container*, not a document. Emitting it as a
  // document made "myapp" a medium-strength anchor shared by every task in the repository, which
  // merged GS-04's two tasks. It is repository-class evidence: weak.
  for (const key of ['cwd', 'workspacePath']) {
    const v = str(key);
    if (!v) continue;
    const leaf = v.split(/[/\\]/).filter(Boolean).pop();
    if (!leaf) continue;
    pushAnchor(out, {
      type: 'repository',
      value: leaf,
      normalizedValue: normalize(leaf),
      confidence: 0.45,
      source: 'path',
    });
  }

  // 4b. Documents the user actually opened, and Finder directories — the anchor that carries
  // administrative and design work, where no repository exists at all.
  for (const key of ['path', 'toPath', 'fromPath', 'directory']) {
    const v = str(key);
    if (!v) continue;
    const leaf = v.split(/[/\\]/).filter(Boolean).pop();
    if (!leaf) continue;
    pushAnchor(out, {
      type: 'document',
      value: leaf,
      normalizedValue: normalize(leaf.replace(/\.[a-z0-9]{1,6}$/i, '')),
      confidence: key === 'directory' ? 0.7 : 0.8,
      source: 'path',
    });
  }

  // 5. URL host — weak on its own, useful in combination.
  const host = str('host');
  if (host && host !== 'localhost') {
    pushAnchor(out, {
      type: 'url',
      value: host,
      normalizedValue: normalize(host),
      confidence: 0.4,
      source: 'url',
    });
  }

  return out;
}

/** Candidate keyword phrases from a window title, once the application name is removed. */
export function titlePhrases(title: string): string[] {
  const cleaned = stripAppSuffix(title)
    .replace(ISSUE_RE, ' ')
    .replace(/[|·•/\\()[\]{}#@]/g, ' ')
    .replace(/\s*[—–-]\s*/g, ' ');
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(normalize(w)) && !/^\d+$/.test(w));

  const phrases: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    if (w.length >= 4) phrases.push(w);
    // Bigrams matter: "checkout redesign" and "project alpha" are the anchors, not "home" or "alpha".
    if (i + 1 < words.length) phrases.push(`${w} ${words[i + 1]!}`);
  }
  return phrases;
}

/**
 * Keyword anchors, decided across the whole session rather than per event.
 *
 * The rule that makes this work: **a phrase becomes an anchor only if it recurs in at least two
 * different applications.** A word repeated inside one app is that app's vocabulary; a word crossing
 * from Slack to Linear to Figma is the subject of the work. This is D-15 expressed as an extraction
 * rule rather than as a scoring weight.
 */
export function keywordAnchors(events: GoldenEvent[]): Map<string, Anchor> {
  const appsByPhrase = new Map<string, Set<string>>();
  const displayByPhrase = new Map<string, string>();

  for (const e of events) {
    if (!e.title) continue;
    const app = e.app ?? 'unknown';
    for (const phrase of titlePhrases(e.title)) {
      const key = normalize(phrase);
      if (key.length < 4) continue;
      const set = appsByPhrase.get(key) ?? new Set<string>();
      set.add(app);
      appsByPhrase.set(key, set);
      if (!displayByPhrase.has(key)) displayByPhrase.set(key, phrase);
    }
  }

  const out = new Map<string, Anchor>();
  for (const [key, apps] of appsByPhrase) {
    if (apps.size < 2) continue;
    out.set(key, {
      type: 'keyword',
      value: displayByPhrase.get(key) ?? key,
      normalizedValue: key,
      // A phrase seen in more applications is more likely to be the subject.
      confidence: Math.min(0.8, 0.4 + 0.12 * apps.size),
      source: 'window_title',
    });
  }
  return out;
}

/** Anchors for every event, including the session-wide keyword pass. */
export function anchorsForSession(events: GoldenEvent[]): Map<string, Anchor[]> {
  const keywords = keywordAnchors(events);
  const byRef = new Map<string, Anchor[]>();

  for (const e of events) {
    const anchors = extractAnchors(e);
    if (e.title) {
      for (const phrase of titlePhrases(e.title)) {
        const hit = keywords.get(normalize(phrase));
        if (hit) pushAnchor(anchors, hit);
      }
    }
    byRef.set(e.ref, anchors);
  }
  return byRef;
}

/**
 * Do two anchors refer to the same thing?
 *
 * Exact normalised equality is too literal for real titles: "Facture août" in Mail, "Facturation
 * août" in Notes and "facture-aout.pdf" in Preview are one subject and three different strings. So
 * loose types (keyword, document, project) also match on a shared significant token.
 *
 * Structured types — issue, branch, worktree, repository, url — stay exact. A near-match on an issue
 * id would be a false merge, and those are the expensive kind.
 */
const LOOSE: AnchorType[] = ['keyword', 'document', 'project'];
const MIN_TOKEN = 4;

function tokens(value: string): string[] {
  return value.split('-').filter((t) => t.length >= MIN_TOKEN);
}

export function anchorsMatch(a: Anchor, b: Anchor): boolean {
  if (a.normalizedValue === b.normalizedValue && (a.type === b.type || LOOSE.includes(a.type))) {
    return true;
  }
  if (!LOOSE.includes(a.type) || !LOOSE.includes(b.type)) return false;
  const ta = new Set(tokens(a.normalizedValue));
  if (ta.size === 0) return false;
  return tokens(b.normalizedValue).some((t) => ta.has(t));
}

/** Anchors of `a` that match something in `b`. */
export function matchingAnchors(a: Anchor[], b: Anchor[]): Anchor[] {
  return a.filter((x) => b.some((y) => anchorsMatch(x, y)));
}
