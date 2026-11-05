/**
 * When the morning brief speaks, and — mostly — when it does not.
 *
 * Almost every test here is about withholding. A brief that is right four mornings out of five and
 * confidently wrong on the fifth is worse than none: the reader acts on it before they can tell
 * which kind it was, and the panel is noise from then on.
 */

import { describe, expect, it } from 'vitest';

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';

import { BRIEF_MAX_EVENTS_TODAY, morningBrief } from './brief.js';

const TZ = 60;
/** 2026-08-27, 14:00 local — comfortably inside one work day on the 04:00 cutoff. */
const YESTERDAY = Date.UTC(2026, 7, 27, 13, 0);
const TODAY = Date.UTC(2026, 7, 28, 13, 0);

function event(ref: string, timestamp: number, metadata: Record<string, unknown>): GoldenEvent {
  return {
    id: ref,
    ref,
    timestamp,
    endTimestamp: timestamp + 20 * 60_000,
    tzOffsetMinutes: TZ,
    source: 'agent',
    type: 'agent.session',
    producer: { name: 'test', version: '1' },
    app: 'claude-code',
    appDisplay: 'Claude Code',
    title: 'Pagination du tableau (ACME-412)',
    metadata,
    privacyLevel: 'normal',
    redaction: { patternsVersion: '1', applied: [], count: 0 },
    importance: 70,
  };
}

const project = {
  projectPath: '/Users/dev/dev/acme-web',
  gitBranch: 'feat/ACME-412-pagination',
  toolCallCount: 20,
  filesTouched: ['src/table.tsx'],
};

function history(events: GoldenEvent[]): GoldenSession {
  return {
    id: 'history',
    name: 'history',
    description: '',
    tests: '',
    day: '2026-08-28',
    tzOffsetMinutes: TZ,
    expected: { contextCount: 0, contexts: [], noiseEventRefs: [] },
    events,
  };
}

const twoDays = history([
  event('y1', YESTERDAY, project),
  event('y2', YESTERDAY + 40 * 60_000, project),
  event('t1', TODAY, project),
]);

describe('the morning brief', () => {
  it('describes the last day worked, not today', () => {
    const brief = morningBrief(twoDays, '2026-08-28', 3);
    expect(brief).not.toBeNull();
    expect(brief!.day).toBe('2026-08-27');
    expect(brief!.handoff.card.contextLabel).toBeTruthy();
  });

  it('offers the project it was in, so "resume" reopens something', () => {
    const brief = morningBrief(twoDays, '2026-08-28', 3)!;
    expect(brief.handoff.card.openResources.map((r) => r.target)).toContain(
      '/Users/dev/dev/acme-web',
    );
  });

  it('says nothing once the day is under way', () => {
    // You know what you are doing by then, and a banner about yesterday is in the way.
    expect(morningBrief(twoDays, '2026-08-28', BRIEF_MAX_EVENTS_TODAY + 1)).toBeNull();
  });

  it('says nothing on the very first day, when there is no yesterday', () => {
    const firstDay = history([event('t1', TODAY, project), event('t2', TODAY + 60_000, project)]);
    expect(morningBrief(firstDay, '2026-08-28', 2)).toBeNull();
  });

  it('says nothing when the previous days hold no context at all', () => {
    // One lone event shares an anchor with nothing, so the engine forms no context — and a brief
    // about "an event" is not a brief about a piece of work.
    const thin = history([event('y1', YESTERDAY, {})]);
    expect(morningBrief(thin, '2026-08-28', 0)).toBeNull();
  });

  it('reaches past an empty day rather than giving up at yesterday', () => {
    // A Monday after a long weekend still wants to know what Friday was.
    const friday = YESTERDAY - 3 * 86_400_000;
    const gap = history([event('f1', friday, project), event('f2', friday + 30 * 60_000, project)]);
    const brief = morningBrief(gap, '2026-08-28', 0);
    expect(brief?.day).toBe('2026-08-24');
  });
});
