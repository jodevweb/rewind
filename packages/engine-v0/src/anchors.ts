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
  | 'issue'
  | 'project'
  | 'repository'
  | 'branch'
  | 'worktree'
  | 'document'
  | 'url'
  | 'keyword'
  /**
   * What the work is about, read from what recurs distinctively across window titles.
   *
   * Naming only. It never reaches the grouping code, and `strength` never sees it — see
   * subjectAnchors below for why that separation is load-bearing.
   */
  | 'subject';

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

  // 3. Git and worktree identity. `gitBranch` comes from Claude Code sessions, where it is present
  // on every record — a branch name carries the ticket id, so this is an anchor for free.
  // `HEAD` is a detached head, not a branch, and every repository reports the same one — so it is
  // an anchor shared by unrelated work, which is the one thing an anchor must never be. Claude Code
  // writes it while a checkout is in flight; the collector now drops it, and this drops it again so
  // the events already stored keep their contexts apart rather than collapsing into one.
  const rawBranch = str('to') ?? str('branch') ?? str('gitBranch');
  const branch = rawBranch === 'HEAD' ? undefined : rawBranch;
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

  // 4a-bis. Files an agent touched are as much evidence as files a person opened.
  const touched = meta['filesTouched'];
  if (Array.isArray(touched)) {
    for (const raw of touched.slice(0, 25)) {
      if (typeof raw !== 'string') continue;
      const name = raw.split(/[/\\]/).filter(Boolean).pop();
      if (!name) continue;
      pushAnchor(out, {
        type: 'document',
        value: name,
        normalizedValue: normalize(name.replace(/.[a-z0-9]{1,6}$/i, '')),
        confidence: 0.8,
        source: 'agent',
      });
    }
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

/**
 * `feat(ui): `, `fix: `, `chore(deps): ` — the type of a commit, not its subject.
 *
 * A day of commits in one repository repeats its type on every message, so the type is the most
 * recurrent phrase in the whole context and wins the name: a real project came back called "Feat".
 * The prefix is a convention about the message, and what the work was about starts after it.
 */
const COMMIT_TYPE_RE =
  /^(?:feat|fix|chore|refactor|docs|test|style|perf|build|ci|revert|wip)(?:\([^)]*\))?!?:\s*/i;

/**
 * Titles REWIND writes itself, which are not evidence of what the work was about.
 *
 * `git.status.summary` reads `16 fichier(s) non commités · beta` and is emitted every time the
 * count changes, so across a day it is the phrase the context repeats most — our own bookkeeping,
 * winning the name over the work. A real project came back called "CommitéS Beta".
 *
 * A commit message is the opposite case and stays: it is written by the person, about the work.
 */
const GENERATED_TITLE_TYPES = new Set(['git.status.summary']);

/** Whether an event's title may contribute a subject. Used when ranking and when counting. */
export function offersASubject(event: GoldenEvent): boolean {
  return Boolean(event.title) && !GENERATED_TITLE_TYPES.has(event.type);
}

/** Candidate keyword phrases from a window title, once the application name is removed. */
export function titlePhrases(title: string): string[] {
  const cleaned = stripAppSuffix(title)
    .replace(COMMIT_TYPE_RE, ' ')
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

/**
 * What each piece of work is ABOUT, for naming it. Grouping never sees this.
 *
 * Contexts used to be named by `namedFrom` reaching for a `project` anchor first — derived from
 * a working directory or a workspace path — and then a filename. So they were named after where
 * the work happened: "Importer.Ts", "Travail dans rewind-desktop". An engine whose founding
 * claim is that the application and the location are never the reason cannot name its contexts
 * after the location.
 *
 * This is deliberately kept OUT of grouping. Subjects were tried as grouping anchors first and
 * cost eight points of F1: window titles are full of repository and organisation names, so the
 * "subject" quietly became the location again, promoted from weak evidence to medium, and false
 * merges on the chaotic-day fixture went from 2.6 % to 17.5 %. Naming and grouping are different
 * jobs with different tolerances — a label that is occasionally vague costs a reader a moment,
 * while a grouping key that is occasionally wrong silently rewrites the history of a day.
 *
 * Distinctiveness rather than mere recurrence: a phrase identifies work when it is frequent in
 * one part of the day and rare across the rest of it. "importer" in six titles out of two
 * hundred is a subject; "Chrome" in ninety is furniture. Nothing here is language-specific — a
 * word that is common in your day is demoted by the statistics whatever language it is in.
 */
export function subjectAnchors(events: GoldenEvent[]): Map<string, Anchor> {
  const titled = events.filter(offersASubject);
  if (titled.length === 0) return new Map();

  // Values that name a PLACE. None of them may become a subject, or the rename achieves
  // nothing: "myapp" and "acme" are exactly the words this is meant to stop showing.
  const places = new Set<string>();
  for (const e of events) {
    if (e.app) places.add(normalize(e.app));
    if (e.appDisplay) places.add(normalize(e.appDisplay));
    for (const anchor of extractAnchors(e)) {
      if (anchor.type !== 'repository' && anchor.type !== 'project' && anchor.type !== 'worktree') {
        continue;
      }
      places.add(anchor.normalizedValue);
      for (const part of anchor.normalizedValue.split('-')) {
        if (part.length >= 4) places.add(part);
      }
    }
  }

  const titlesByPhrase = new Map<string, number>();
  const appsByPhrase = new Map<string, Set<string>>();
  const displayByPhrase = new Map<string, string>();

  for (const e of titled) {
    const app = e.app ?? 'unknown';
    // Per title, not per occurrence: a phrase repeated inside one long title is not more of a
    // subject for it.
    const seen = new Set<string>();
    for (const phrase of titlePhrases(e.title!)) {
      const key = normalize(phrase);
      if (key.length < 4 || seen.has(key) || places.has(key)) continue;
      seen.add(key);
      titlesByPhrase.set(key, (titlesByPhrase.get(key) ?? 0) + 1);
      const apps = appsByPhrase.get(key) ?? new Set<string>();
      apps.add(app);
      appsByPhrase.set(key, apps);
      if (!displayByPhrase.has(key)) displayByPhrase.set(key, phrase);
    }
  }

  const out = new Map<string, Anchor>();
  for (const [key, titleCount] of titlesByPhrase) {
    // Seen once is an accident, not a subject.
    if (titleCount < 2) continue;
    // Present in half the day: furniture, whatever it says.
    if (titleCount / titled.length > 0.5) continue;

    const idf = Math.log(titled.length / titleCount);
    const distinctiveness = Math.min(1, idf / Math.log(titled.length));
    const support = Math.min(1, (titleCount - 1) / 3);
    // Crossing applications remains the strongest sign that a phrase names the work rather than
    // the tool, which is what the older keyword rule required outright.
    const crossApp = Math.min(1, ((appsByPhrase.get(key)?.size ?? 1) - 1) / 2);

    const confidence = 0.35 + 0.25 * distinctiveness + 0.2 * support + 0.2 * crossApp;
    if (confidence < 0.5) continue;

    out.set(key, {
      type: 'subject',
      value: displayByPhrase.get(key) ?? key,
      normalizedValue: key,
      confidence: Math.min(0.9, confidence),
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
