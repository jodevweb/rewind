/**
 * Context Engine V0 — deterministic, no embeddings, no LLM (ADR 0002, CONTEXT_ENGINE §2–4).
 *
 * TypeScript reference implementation. Its purpose is to have the heuristics validated against the
 * golden benchmark *before* the Rust port, so the Rust engine starts from measured numbers rather
 * than from a guess. It is a predictor for `@rewind/eval`, and the Fake Collector's brain for the
 * studio. Per ADR 0001 D-4 the production engine is Rust; this exists to be ported, not to ship.
 */

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';

import {
  anchorsForSession,
  matchingAnchors,
  strength,
  normalize,
  STRONG,
  type AnchorType,
  subjectAnchors,
  titlePhrases,
  type Anchor,
} from './anchors.js';

export interface Activity {
  id: string;
  label: string;
  startTimestamp: number;
  endTimestamp: number;
  eventRefs: string[];
  apps: string[];
  anchors: Anchor[];
  contextId?: string;
}

export interface EngineContext {
  id: string;
  label: string;
  activityIds: string[];
  eventRefs: string[];
  startTimestamp: number;
  endTimestamp: number;
  /** Active time, idle excluded — the only duration the product is allowed to show. */
  activeMs: number;
  /** Applications in first-touch order: the "Slack → Linear → Figma" chain. */
  appChain: string[];
  anchors: Anchor[];
  /**
   * Where the work happened: repository, branch, declared project.
   *
   * Separate from `label` on purpose. These used to BE the label, which is how every context
   * ended up called after a folder. They belong under the name, not in it.
   */
  place: { repository?: string; branch?: string; project?: string };
  confidence: number;
  /**
   * When this context last saw an activity that actually carried identity.
   *
   * Drift is measured from here rather than from `endTimestamp`, which anchorless attachment itself
   * keeps advancing. That was a ratchet: each anchorless activity attached, moved the end forward,
   * and thereby made the next one "nearby" too, so an evening of gaming accreted onto an afternoon
   * of work with nothing to stop it. A context's identity comes from its anchors, so unlabelled
   * activity may hang off it for a while after the last real evidence — not forever after the last
   * thing it swallowed.
   */
  lastAnchoredTimestamp: number;
  /**
   * True when no anchor was good enough to name the context, so `label` is a placeholder the UI
   * should replace with a translated one. The engine has no business inventing prose (§147).
   */
  labelIsFallback: boolean;
}

export interface EngineResult {
  activities: Activity[];
  contexts: EngineContext[];
  /** Events the engine assigned to nothing. */
  unassigned: string[];
  anchorsByRef: Map<string, Anchor[]>;
}

export interface EngineConfig {
  activityGapMs: number;
  /** Hard cap so a long stretch in one application still yields granular activities. */
  activityMaxMs: number;
  /**
   * How long an activity with no anchors at all will still attach to nearby work. Beyond this it
   * starts its own context. This is the only grouping signal available at Level 1, where a window
   * title is all there is.
   */
  driftMs: number;
  assignThreshold: number;
  recencyHalfLifeMs: number;
  minContextEvents: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  activityGapMs: 90_000,
  activityMaxMs: 20 * 60 * 1000,
  driftMs: 10 * 60 * 1000,
  assignThreshold: 0.22,
  recencyHalfLifeMs: 3 * 60 * 60 * 1000,
  minContextEvents: 2,
};

const APP_NAMES: Record<string, string> = {
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.linear': 'Linear',
  'com.figma.Desktop': 'Figma',
  'com.apple.Notes': 'Notes',
  'com.apple.mail': 'Mail',
  'com.apple.finder': 'Finder',
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm2',
  'com.google.Chrome': 'Chrome',
  'com.apple.Safari': 'Safari',
  'com.acme.cockpit': 'Cockpit',
  'com.apple.Preview': 'Preview',
  'com.microsoft.VSCode': 'VS Code',
  'Code.exe': 'VS Code',
  'chrome.exe': 'Chrome',
  'WindowsTerminal.exe': 'Terminal',
  'slack.exe': 'Slack',
  'Teams.exe': 'Teams',
  'olk.exe': 'Outlook',
  'explorer.exe': 'Finder',
  'Spotify.exe': 'Spotify',
};

export function appName(event: GoldenEvent): string {
  if (event.source === 'agent') return 'Claude Code';
  if (event.source === 'external') return 'Cockpit';
  if (event.source === 'terminal') return 'Terminal';
  if (event.source === 'git') return 'Git';
  if (!event.app) return event.appDisplay ?? 'System';
  return APP_NAMES[event.app] ?? event.appDisplay ?? event.app;
}

const overlap = matchingAnchors;

function mergeAnchors(into: Anchor[], from: Anchor[]): Anchor[] {
  const out = [...into];
  for (const a of from) {
    const existing = out.find((x) => x.type === a.type && x.normalizedValue === a.normalizedValue);
    if (existing) existing.confidence = Math.max(existing.confidence, a.confidence);
    else out.push({ ...a });
  }
  return out;
}

const HARD_BOUNDARY = new Set([
  'system.idle.start',
  'system.session.lock',
  'system.power.sleep',
  'system.capture.paused',
]);

/** Stage A — activities: contiguous runs of coherent events. */
function buildActivities(
  events: GoldenEvent[],
  anchorsByRef: Map<string, Anchor[]>,
  config: EngineConfig,
): Activity[] {
  const activities: Activity[] = [];
  let current: Activity | null = null;
  let n = 0;

  const close = () => {
    current = null;
  };

  for (const e of events) {
    const anchors = anchorsByRef.get(e.ref) ?? [];
    const end = e.endTimestamp ?? e.timestamp;

    if (HARD_BOUNDARY.has(e.type)) {
      close();
      continue;
    }

    if (current) {
      const gapped = e.timestamp - current.endTimestamp > config.activityGapMs;
      const tooLong = end - current.startTimestamp > config.activityMaxMs;

      // Compare against the anchors of the events immediately preceding, NOT the activity's whole
      // accumulated set. An activity's anchor set only grows, so testing against all of it turns the
      // activity into a magnet: one weak anchor like `repository:myapp` present throughout a session
      // keeps it open forever, and GS-04's whole day collapsed into a single activity.
      const recent = recentAnchors(current, anchorsByRef, 3);
      const heldByAnchor = overlap(anchors, recent).length > 0;
      // An activity legitimately moves between applications and back — edit, run tests, edit again —
      // so membership in the activity is the test, not the immediately previous application.
      // Requiring the last application shattered every fixture (recall fell to 10 %).
      const sameApp = current.apps.includes(appName(e));

      // A conflicting identity ends the activity outright: a different issue id, or a different
      // branch, is different work — even one second later in the same application.
      const conflicting = identityConflict(anchors, recent);

      if (gapped || tooLong || conflicting || (!heldByAnchor && !sameApp)) close();
    }

    if (!current) {
      n += 1;
      current = {
        id: `a${n}`,
        label: '',
        startTimestamp: e.timestamp,
        endTimestamp: end,
        eventRefs: [],
        apps: [],
        anchors: [],
      };
      activities.push(current);
    }

    current.eventRefs.push(e.ref);
    current.endTimestamp = Math.max(current.endTimestamp, end);
    current.anchors = mergeAnchors(current.anchors, anchors);
    const app = appName(e);
    if (!current.apps.includes(app)) current.apps.push(app);
  }

  for (const a of activities) a.label = labelActivity(a);
  return activities;
}

/**
 * The anchor types that answer "which piece of work is this?".
 *
 * `branch` is here and is only medium evidence elsewhere, and the difference is deliberate: a branch
 * is weak evidence that two things belong *together* — plenty of unrelated work happens on `main` —
 * and strong evidence that they do not, because nobody does two tasks on two branches by accident.
 * GS-06 turns on it: reviewing a colleague's pagination PR and building an empty state are the same
 * repository, the same checkout and the same afternoon, and the only thing that separates them is
 * which branch was checked out.
 */
const IDENTITY: AnchorType[] = [...STRONG, 'branch'];

/**
 * Do two sets of anchors positively disagree about which work this is?
 *
 * Comparison is **within a type**, and that is the whole point. `issue` and `worktree` are both
 * strong, so a set carrying one and a set carrying the other can never share an anchor — and the
 * plain "both sides are strong and nothing matches" test read that as evidence of different work.
 * It is evidence of nothing: they are not comparable. An issue id and a worktree path are two ways
 * of saying which task this is, and every day they named the same task, this rule cut it in half.
 * It cost eight points of pairwise F1 and most of the false split, in three places at once — the
 * activity boundary, the assignment score and the merge pass all asked the same wrong question.
 *
 * This is the principle the engine already applies to weak evidence, applied where it was being
 * quietly ignored: **absence of evidence is not evidence of difference.**
 *
 * Two different issue ids are a real disagreement, and that is what keeps GS-04's two tasks in one
 * repository apart.
 */
function identityConflict(a: Anchor[], b: Anchor[]): boolean {
  return IDENTITY.some((type) => {
    const here = a.filter((x) => x.type === type);
    const there = b.filter((x) => x.type === type);
    return here.length > 0 && there.length > 0 && overlap(here, there).length === 0;
  });
}

/** Anchors of the last `n` events of an activity — the local context, not the whole history. */
function recentAnchors(
  activity: Activity,
  anchorsByRef: Map<string, Anchor[]>,
  n: number,
): Anchor[] {
  const out: Anchor[] = [];
  for (const ref of activity.eventRefs.slice(-n)) {
    for (const a of anchorsByRef.get(ref) ?? []) {
      if (!out.some((x) => x.type === a.type && x.normalizedValue === a.normalizedValue))
        out.push(a);
    }
  }
  return out;
}

function labelActivity(a: Activity): string {
  const strong = a.anchors.filter((x) => strength(x.type) === 'strong');
  const medium = a.anchors.filter((x) => strength(x.type) === 'medium');
  const keyword = a.anchors.filter((x) => x.type === 'keyword');
  const best = strong[0] ?? medium[0] ?? keyword[0];
  const where = a.apps[0] ?? 'System';
  return best ? `${best.value} — ${where}` : where;
}

/** Score an activity against a candidate context. Weights follow CONTEXT_ENGINE §4.2. */
function score(
  activity: Activity,
  context: EngineContext,
  config: EngineConfig,
  previousContextId: string | undefined,
  previousApp: string | undefined,
): { total: number; shared: Anchor[] } {
  const shared = overlap(activity.anchors, context.anchors);
  const strongHit = shared.some((a) => strength(a.type) === 'strong');
  const mediumHit = shared.some((a) => strength(a.type) === 'medium');
  // Weak hits are deduplicated by value: "myapp" arriving as both a repository and a keyword is one
  // piece of evidence, not two.
  const weakHits = new Set(
    shared.filter((a) => strength(a.type) === 'weak').map((a) => a.normalizedValue),
  ).size;

  // Conflicting identity. If both sides carry a strong anchor and none of them match, that is
  // positive evidence of *different* work — two issue ids are two pieces of work, however adjacent
  // in time and however many files they share. This is what keeps GS-04 apart.
  if (!strongHit && identityConflict(activity.anchors, context.anchors)) {
    return { total: 0, shared };
  }

  const anchorStrong = strongHit ? 1 : mediumHit ? 0.7 : 0;
  const anchorWeak = Math.min(1, weakHits / 2);
  const appAffinity = activity.apps.some((x) => context.appChain.includes(x)) ? 1 : 0;

  const gap = Math.max(0, activity.startTimestamp - context.endTimestamp);
  const recency = Math.pow(0.5, gap / config.recencyHalfLifeMs);
  // How far an unlabelled activity sits from what this context is actually made of.
  //
  // The ratchet only matters when unlabelled material accretes onto IDENTIFIED work, so the two
  // cases are measured differently:
  //
  //   - A context with anchors is measured from its last real evidence, to the activity's END. What
  //     matters is how far past the evidence the activity reaches, not where it began: a stretch
  //     starting eight minutes after a commit and running half an hour is not a tail of that commit.
  //   - A context with no anchors at all has no evidence to drift from, and cannot be corrupted by
  //     unlabelled material because that is all it is. Consecutive unlabelled activity is one
  //     stretch of unlabelled time, so it is measured from the context's end to the activity's
  //     start — otherwise an evening fragments into a context per half hour.
  const driftGap =
    context.anchors.length > 0
      ? Math.max(0, activity.endTimestamp - context.lastAnchoredTimestamp)
      : Math.max(0, activity.startTimestamp - context.endTimestamp);

  // The rule that keeps GS-03 and GS-04 apart: **no shared anchor, no assignment.** Being adjacent
  // in time and using the same applications is not evidence of the same work — that is exactly what
  // ADR 0002 D-15 says. The single exception is a direct continuation: same application, under two
  // minutes apart, which is one interaction split across two activities rather than a new subject.
  if (shared.length === 0) {
    // Absence of evidence is not evidence of difference, and treating them alike is what made real
    // Level 1 capture unusable: window titles carry no paths, branches or tickets, so most
    // activities have no anchors at all, every one became its own context, and the whole day landed
    // outside any context.
    //
    // So the two cases are separated. An activity that carries NO identity cannot contradict
    // anything: it joins what surrounds it, with the confidence that deserves. An activity that
    // carries identity and shares none of it starts something new — that is GS-04's protection and
    // it is untouched.
    const activityHasAnchors = activity.anchors.length > 0;
    if (!activityHasAnchors) {
      // Attaching to nearby work is what a person does with an unlabelled stretch of their day:
      // "between nine and ten you were on something", rather than forty orphans.
      const nearby = driftGap < config.driftMs;
      return {
        total: nearby ? config.assignThreshold * (1 - driftGap / config.driftMs) : 0,
        shared,
      };
    }

    // It has identity and shares none: only a direct continuation of the previous activity, in the
    // same application, within two minutes.
    const continuation =
      previousContextId === context.id &&
      previousApp !== undefined &&
      activity.apps[0] === previousApp &&
      gap < 120_000;
    return { total: continuation ? config.assignThreshold : 0, shared };
  }

  // Semantic (0.20) is absent in V0 — no embeddings. Its weight is redistributed onto anchors,
  // which is honest: without embeddings the engine leans harder on explicit identifiers.
  const raw = 0.5 * anchorStrong + 0.28 * anchorWeak + 0.14 * recency + 0.04 * appAffinity;

  // An anchor match survives a long gap; without a strong one, recency still matters.
  const total = strongHit ? raw : raw * (0.4 + 0.6 * recency);
  return { total, shared };
}

/** Stage C — context assignment, then a merge pass over shared strong anchors. */
export function runEngine(
  session: GoldenSession,
  config: EngineConfig = DEFAULT_CONFIG,
): EngineResult {
  const events = session.events;
  const byRef = new Map(events.map((e) => [e.ref, e]));
  const anchorsByRef = anchorsForSession(events);
  const activities = buildActivities(events, anchorsByRef, config);

  const contexts: EngineContext[] = [];
  let n = 0;

  let previousContextId: string | undefined;
  let previousApp: string | undefined;

  for (const activity of activities) {
    let best: EngineContext | null = null;
    let bestScore = 0;
    for (const context of contexts) {
      const { total } = score(activity, context, config, previousContextId, previousApp);
      if (total > bestScore) {
        bestScore = total;
        best = context;
      }
    }

    if (best && bestScore >= config.assignThreshold) {
      attach(best, activity, byRef);
      previousContextId = best.id;
      previousApp = activity.apps[activity.apps.length - 1];
    } else {
      n += 1;
      const created: EngineContext = {
        id: `c${n}`,
        label: '',
        activityIds: [],
        eventRefs: [],
        startTimestamp: activity.startTimestamp,
        endTimestamp: activity.endTimestamp,
        activeMs: 0,
        appChain: [],
        anchors: [],
        place: {},
        confidence: 0,
        lastAnchoredTimestamp: activity.startTimestamp,
        labelIsFallback: false,
      };
      contexts.push(created);
      attach(created, activity, byRef);
      previousContextId = created.id;
      previousApp = activity.apps[activity.apps.length - 1];
    }
  }

  // Merge pass. Work returns to a subject hours later (GS-06, GS-08); a shared strong anchor is
  // enough to reunite the pieces, and recency deliberately is not.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < contexts.length; i += 1) {
      for (let j = i + 1; j < contexts.length; j += 1) {
        const a = contexts[i]!;
        const b = contexts[j]!;
        const shared = overlap(a.anchors, b.anchors);
        if (shared.length === 0) continue;

        // Work returns to a subject hours later (GS-06 spans three blocks across a day, GS-08 two).
        // Recency deliberately plays no part here — a shared anchor is a shared anchor whenever it
        // appears. The guard is the mirror of the assignment conflict rule: merge on any shared
        // anchor UNLESS both sides carry strong identities that disagree. That keeps GS-04's two
        // tasks apart (auth-221 vs perm-88) while reuniting GS-09's billing pieces, which have no
        // strong anchor at all.
        if (!identityConflict(a.anchors, b.anchors)) {
          absorb(a, b);
          contexts.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  // Unlabelled time *inside* a piece of work is part of that work.
  //
  // The assignment stage already holds that absence of evidence is not evidence of difference, but
  // it can only say so forward: an anchorless activity that lands past the drift window opens a
  // context of its own, and every anchorless activity after it joins that one. When the identified
  // work resumes, the day carries a nameless island between two halves of one subject. That island
  // is most of the false split — the sessions it shows up in are administration, communication and
  // the chaotic day, which is to say the ones made of window titles and nothing else.
  //
  // The rule reaches nowhere. A context is absorbed only when it sits *entirely* inside the span of
  // another and carries no anchor above weak — no issue, no branch, no project, no document. Weak
  // anchors are a host and a repository name; they say where something happened, never what it was,
  // and a stretch of the afternoon identified only by two billing hostnames is not a second piece of
  // work, it is a detour inside the first.
  //
  // Two fixtures are the guard rails. GS-08 interleaves two projects, and a project anchor is
  // medium, so neither can be swallowed by the other's span. GS-11's evening is never contained by
  // anything, because nothing follows it — which is what that fixture exists to prove.
  let bracketed = true;
  while (bracketed) {
    bracketed = false;
    for (let i = 0; i < contexts.length; i += 1) {
      const island = contexts[i]!;
      if (island.anchors.some((a) => strength(a.type) !== 'weak')) continue;
      const host = contexts.find(
        (c) =>
          c !== island &&
          c.anchors.length > 0 &&
          c.startTimestamp < island.startTimestamp &&
          c.endTimestamp > island.endTimestamp,
      );
      if (!host) continue;
      absorb(host, island);
      contexts.splice(i, 1);
      bracketed = true;
      break;
    }
  }

  // Contexts too small to be real are released back to noise rather than shown as work.
  const unassigned: string[] = [];
  const kept = contexts.filter((c) => {
    if (c.eventRefs.length >= config.minContextEvents) return true;
    unassigned.push(...c.eventRefs);
    return false;
  });

  const subjects = subjectAnchors(session.events);
  for (const c of kept) {
    const named = namedFrom(c, subjects, byRef);
    c.label = named ?? c.appChain[0] ?? '';
    c.labelIsFallback = named === null;
    c.confidence = confidenceOf(c);
  }
  // Active time, measured once the contexts are settled, as the time actually covered rather than
  // the sum of what covered it. See `coveredMs`.
  const activityById = new Map(activities.map((a) => [a.id, a]));
  for (const c of kept) {
    c.activeMs = coveredMs(
      c.activityIds.map((id) => activityById.get(id)).filter((a): a is Activity => Boolean(a)),
    );
  }

  kept.sort((a, b) => b.activeMs - a.activeMs);
  return { activities, contexts: kept, unassigned, anchorsByRef };
}

/**
 * How much time a set of activities actually covers.
 *
 * The union of their intervals, not the sum of their lengths — and the difference is not academic.
 * A day of real capture read 31.5 hours of "active time" inside 23.7 hours of wall clock, because
 * activities overlap: one Claude Code session spanning nine hours sits on top of two hundred window
 * focus spans, and adding both counts the same afternoon twice.
 *
 * Gaps between activities are still never counted, which was the point of summing in the first
 * place (§69) — a union preserves that exactly and stops the double count as well. A duration that
 * exceeds the day it is in destroys trust in every other number on the screen.
 *
 * The 30-second floor per activity survives: a single instantaneous event is a moment of work, not
 * zero. It is applied to each interval before the union, so two instants a second apart do not
 * become a minute.
 */
export function coveredMs(activities: Activity[]): number {
  if (activities.length === 0) return 0;
  const spans = activities
    .map((a) => [a.startTimestamp, Math.max(a.endTimestamp, a.startTimestamp + 30_000)] as const)
    .sort((x, y) => x[0] - y[0]);

  let total = 0;
  let [start, end] = spans[0]!;
  for (const [from, to] of spans.slice(1)) {
    if (from > end) {
      total += end - start;
      start = from;
      end = to;
    } else if (to > end) {
      end = to;
    }
  }
  return total + (end - start);
}

function attach(context: EngineContext, activity: Activity, byRef: Map<string, GoldenEvent>): void {
  activity.contextId = context.id;
  context.activityIds.push(activity.id);
  context.eventRefs.push(...activity.eventRefs);
  context.startTimestamp = Math.min(context.startTimestamp, activity.startTimestamp);
  context.endTimestamp = Math.max(context.endTimestamp, activity.endTimestamp);
  if (activity.anchors.length > 0) {
    context.lastAnchoredTimestamp = Math.max(context.lastAnchoredTimestamp, activity.endTimestamp);
  }
  context.anchors = mergeAnchors(context.anchors, activity.anchors);
  // Active time is summed per activity, so gaps between activities — meetings, lunch, other work —
  // are never counted (§69). This is what stops durations inflating into a time report.
  context.activeMs += Math.max(activity.endTimestamp - activity.startTimestamp, 30_000);
  for (const ref of activity.eventRefs) {
    const e = byRef.get(ref);
    if (!e) continue;
    const app = appName(e);
    if (!context.appChain.includes(app)) context.appChain.push(app);
  }
}

function absorb(into: EngineContext, other: EngineContext): void {
  into.activityIds.push(...other.activityIds);
  into.eventRefs.push(...other.eventRefs);
  into.startTimestamp = Math.min(into.startTimestamp, other.startTimestamp);
  into.endTimestamp = Math.max(into.endTimestamp, other.endTimestamp);
  into.lastAnchoredTimestamp = Math.max(into.lastAnchoredTimestamp, other.lastAnchoredTimestamp);
  into.activeMs += other.activeMs;
  into.anchors = mergeAnchors(into.anchors, other.anchors);
  for (const app of other.appChain) if (!into.appChain.includes(app)) into.appChain.push(app);
}

/** Returns a real name, or null when nothing in the context is distinctive enough to name it. */
/**
 * What to call a context, and where to say it happened.
 *
 * The order used to be `project ?? keyword ?? document ?? branch`. `project` and the paths
 * behind it are locations; `document` is a filename. So contexts were named "Importer.Ts" and
 * "Travail dans rewind-desktop" — where the work was, never what it was. The one genuinely
 * subject-shaped anchor came third.
 *
 * Now the subject leads, and location is not consulted for the name at all: it is collected
 * separately into `place`, for the interface to show underneath. A branch outranks a filename
 * because branches are usually named after the task and filenames after an artefact of it.
 *
 * When nothing names the work, the caller falls back to the application and marks the label a
 * placeholder. That is honest, and better than a confident wrong name.
 */
function namedFrom(
  c: EngineContext,
  subjects: Map<string, Anchor>,
  byRef: Map<string, GoldenEvent>,
): string | null {
  const byConfidence = [...c.anchors].sort((a, b) => b.confidence - a.confidence);
  const issue = byConfidence.find((a) => a.type === 'issue');
  const doc = byConfidence.find((a) => a.type === 'document');
  const branch = byConfidence.find((a) => a.type === 'branch');

  // Where it happened, for display. Never part of the name.
  const repository = byConfidence.find((a) => a.type === 'repository')?.value;
  const project = byConfidence.find((a) => a.type === 'project')?.value;
  c.place.repository = repository;
  // A declared project that merely repeats the repository name says nothing twice.
  c.place.project = project === repository ? undefined : project;
  c.place.branch = branch?.value;

  // The subject that best covers THIS context: the most confident one appearing in its own
  // titles. Session-wide subjects are ranked across the whole day, so the top one overall is
  // often about some other piece of work entirely.
  const topic = bestSubject(c, subjects, byRef);

  // No keyword fallback. Keywords are the same raw material as subjects but without the
  // place filter, so they were the route by which "Myapp" and "Acme" — a repository and an
  // organisation — still arrived as context names. A subject is strictly better evidence from
  // the same source, and where there is none, a branch or a filename is more honest than an
  // unfiltered phrase.
  const subject = topic ?? branch ?? doc;
  const pretty = (s: string) =>
    s
      .replace(/^(fix|feat|chore|refactor|investigate)\//, '')
      .replace(/[-_/]+/g, ' ')
      .replace(/\b\w/g, (m) => m.toUpperCase());

  if (issue && subject) return `${pretty(subject.value)} (${issue.value})`;
  if (issue) return issue.value;
  if (subject) return pretty(subject.value);
  return null;
}

/** Subjects appearing in this context's own window titles, and how many of its events carry them. */
function subjectsIn(
  c: EngineContext,
  subjects: Map<string, Anchor>,
  byRef: Map<string, GoldenEvent>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ref of c.eventRefs) {
    const title = byRef.get(ref)?.title;
    if (!title) continue;
    const seen = new Set<string>();
    for (const phrase of titlePhrases(title)) {
      const key = normalize(phrase);
      if (!subjects.has(key) || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The subject that best identifies this context.
 *
 * Coverage times distinctiveness, and nothing else. A third factor was tried — penalising a
 * phrase for also appearing in other contexts — on the reasoning that an organisation name
 * shared by every context distinguishes none of them. That reasoning is sound and the result
 * was worse: it preferred rarer, emptier words, turning "Pricing (MKT-118)" into
 * "Update (MKT-118)". Softening it to a square root changed nothing. Rarity across contexts
 * turns out to be a poor proxy for meaning, so it is not used.
 *
 * The cost is that an organisation name can still surface as a label when a context has no
 * better phrase in its titles. That is a vague name rather than a wrong one, and the place
 * shown beneath it carries the detail.
 */
function bestSubject(
  c: EngineContext,
  subjects: Map<string, Anchor>,
  byRef: Map<string, GoldenEvent>,
): Anchor | undefined {
  let best: Anchor | undefined;
  let bestScore = 0;
  for (const [key, count] of subjectsIn(c, subjects, byRef)) {
    const anchor = subjects.get(key)!;
    // A phrase in one title out of twenty describes a moment, not the work.
    const score = (count / c.eventRefs.length) * anchor.confidence;
    if (score > bestScore) {
      bestScore = score;
      best = anchor;
    }
  }
  return best;
}

function confidenceOf(c: EngineContext): number {
  const strong = c.anchors.filter((a) => strength(a.type) === 'strong').length;
  const sources = new Set(c.appChain).size;
  return Math.min(1, 0.3 + 0.25 * Math.min(strong, 2) + 0.1 * Math.min(sources, 4));
}
