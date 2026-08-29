/**
 * What handing a context over has to get right.
 *
 * Two properties, and the second is the one that matters. The first is that the exports contain what
 * the day contained. The second is that a context REWIND cannot reopen says so, rather than offering
 * a button that does nothing — the failure mode of this whole feature is a "Resume" that opens an
 * empty editor and teaches the reader the tool is decorative.
 */

import { describe, expect, it } from 'vitest';

import { buildResume, runEngine, RESUME_OPEN_LIMIT } from '@rewind/engine-v0';
import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';
import { loadGoldenSession } from '@rewind/fixtures';

import { agentBrief, standup, worklog, type Handoff } from './handoff.js';
import { setLocale, t } from './i18n.js';

const TZ = 60;
const START = Date.UTC(2026, 7, 28, 9, 0);

function event(partial: Partial<GoldenEvent> & { ref: string; type: string }): GoldenEvent {
  return {
    id: partial.ref,
    timestamp: START,
    tzOffsetMinutes: TZ,
    source: 'agent',
    producer: { name: 'test', version: '1' },
    metadata: {},
    privacyLevel: 'normal',
    redaction: { patternsVersion: '1', applied: [], count: 0 },
    importance: 50,
    ...partial,
  } as GoldenEvent;
}

function session(events: GoldenEvent[]): GoldenSession {
  return {
    id: 'test',
    name: 'test',
    description: '',
    tests: '',
    day: '2026-08-28',
    tzOffsetMinutes: TZ,
    expected: { contextCount: 0, contexts: [], noiseEventRefs: [] },
    events,
  };
}

/**
 * Two Claude Code sessions in one project — the shape a real day of this user's work takes, and the
 * one the collectors actually produce today.
 */
const agentDay = session([
  event({
    ref: 'a1',
    type: 'agent.session',
    app: 'claude-code',
    appDisplay: 'Claude Code',
    title: 'Pagination du tableau (ACME-412)',
    timestamp: START,
    endTimestamp: START + 40 * 60_000,
    metadata: {
      projectPath: '/Users/j/dev/acme-web',
      gitBranch: 'feat/ACME-412-pagination',
      toolCallCount: 31,
      filesTouched: ['src/table.tsx', 'src/table.test.ts'],
    },
  }),
  event({
    ref: 'a2',
    type: 'agent.session',
    app: 'claude-code',
    appDisplay: 'Claude Code',
    title: 'Pagination du tableau — suite (ACME-412)',
    timestamp: START + 50 * 60_000,
    endTimestamp: START + 80 * 60_000,
    metadata: {
      projectPath: '/Users/j/dev/acme-web',
      gitBranch: 'feat/ACME-412-pagination',
      toolCallCount: 12,
      filesTouched: ['src/table.tsx'],
    },
  }),
]);

function handoffsFor(s: GoldenSession): Handoff[] {
  return runEngine(s).contexts.map((c) => ({ card: buildResume(s, c), place: c.place }));
}

describe('what a context can be reopened from', () => {
  it('reads an agent session for its project and the files it touched', () => {
    const [first] = handoffsFor(agentDay);
    expect(first).toBeDefined();
    const targets = first!.card.openResources.map((r) => r.target);

    // The project first: opening a file before its workspace lands it in whatever editor claimed
    // the extension.
    expect(first!.card.openResources[0]!.kind).toBe('workspace');
    expect(targets).toContain('/Users/j/dev/acme-web');
    // Relative paths are resolved against the project, or they open nothing.
    expect(targets).toContain('/Users/j/dev/acme-web/src/table.tsx');
  });

  it('lists a file once however many sessions touched it', () => {
    const [first] = handoffsFor(agentDay);
    const table = first!.card.openResources.filter((r) => r.target.endsWith('src/table.tsx'));
    expect(table).toHaveLength(1);
  });

  it('never offers to open more than a person can look at', () => {
    const many = session([
      event({
        ref: 'big',
        type: 'agent.session',
        app: 'claude-code',
        title: 'Refactor',
        metadata: {
          projectPath: '/Users/j/dev/acme-web',
          gitBranch: 'main',
          toolCallCount: 200,
          filesTouched: Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`),
        },
      }),
      event({
        ref: 'big2',
        type: 'agent.session',
        app: 'claude-code',
        title: 'Refactor suite',
        timestamp: START + 10 * 60_000,
        metadata: {
          projectPath: '/Users/j/dev/acme-web',
          gitBranch: 'main',
          toolCallCount: 20,
          filesTouched: ['src/file-1.ts'],
        },
      }),
    ]);
    for (const h of handoffsFor(many)) {
      expect(h.card.openResources.length).toBeLessThanOrEqual(RESUME_OPEN_LIMIT);
    }
  });

  it('leaves a context with nothing openable empty rather than inventing a target', () => {
    // Window focus alone carries no path, no URL and no project — the honest answer is nothing.
    const windows = session([
      event({
        ref: 'w1',
        type: 'system.window.focus',
        source: 'system',
        app: 'com.figma.Desktop',
        title: 'Pricing — ACME-412',
        timestamp: START,
      }),
      event({
        ref: 'w2',
        type: 'system.window.focus',
        source: 'system',
        app: 'com.figma.Desktop',
        title: 'Pricing — ACME-412',
        timestamp: START + 5 * 60_000,
      }),
    ]);
    for (const h of handoffsFor(windows)) {
      expect(h.card.openResources).toHaveLength(0);
    }
  });
});

describe('the brief handed to an agent', () => {
  it('carries the branch, the files and where it came from', () => {
    setLocale('fr');
    const [first] = handoffsFor(agentDay);
    const text = agentBrief(first!, TZ);

    expect(text).toContain('feat/ACME-412-pagination');
    expect(text).toContain('table.tsx');
    expect(text).toContain('/Users/j/dev/acme-web');
    // An agent handed unattributed facts treats them as its own assumptions and defends them.
    expect(text).toContain(t('handoff.provenance'));
  });

  it('says nothing about sections the day did not fill', () => {
    setLocale('fr');
    const [first] = handoffsFor(agentDay);
    const text = agentBrief(first!, TZ);
    // No terminal collector ran, so there are no commands and no failures — and an empty heading
    // reads as "nothing failed", which is a claim this cannot make.
    expect(text).not.toContain(`${t('resume.failed')} :`);
    expect(text).not.toContain(`${t('resume.ran')} :`);
  });

  it('follows the interface language', () => {
    const [first] = handoffsFor(agentDay);
    setLocale('en');
    const english = agentBrief(first!, TZ);
    setLocale('fr');
    const french = agentBrief(first!, TZ);
    expect(english).toContain('Context :');
    expect(french).toContain('Contexte :');
  });
});

describe('the day exports', () => {
  it('gives a standup one line per context', () => {
    setLocale('fr');
    const handoffs = handoffsFor(loadGoldenSession('gs-01-focused-debugging'));
    const text = standup('2026-03-12', handoffs);
    const bullets = text.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(handoffs.filter((h) => h.card.activeMs > 0).length);
  });

  it('writes a worklog that names every context of the day', () => {
    setLocale('fr');
    const handoffs = handoffsFor(loadGoldenSession('gs-01-focused-debugging'));
    const text = worklog('2026-03-12', handoffs, TZ);
    for (const h of handoffs) expect(text).toContain(h.card.contextLabel);
  });
});
