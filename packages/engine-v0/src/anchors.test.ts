/**
 * Anchors, and the one an anchor must never be: shared by unrelated work.
 *
 * Found on a real day, not on the golden set. Claude Code writes `"gitBranch":"HEAD"` when it reads
 * the repository while a checkout is in flight, and `HEAD` is the same string in every repository on
 * the machine. It arrived as a medium-strength `branch` anchor, so two projects worked five hours
 * apart came back as one context — named after whichever of them spoke first.
 *
 * The collector no longer stores it (`claude.rs`), and the engine no longer reads it, because the
 * events already recorded are kept deliberately and must still group correctly when replayed.
 */

import { buildSession } from '@rewind/fixtures/authoring';
import { describe, expect, it } from 'vitest';

import { runEngine } from './engine.js';

function twoProjects(branchA: string, branchB: string) {
  return buildSession({
    id: 'anchors-branch',
    name: 'Two projects, one branch label',
    description: 'Two unrelated repositories worked on the same day.',
    tests: 'Whether a branch label shared by every repository merges them.',
    day: '2026-08-29',
    tzOffsetMinutes: 120,
    defaultRepo: null,
    contexts: {
      A: { label: 'Work in rewind' },
      B: { label: 'Work in beta' },
    },
    steps: [
      {
        t: '09:00:00',
        ctx: 'A',
        type: 'agent.session',
        app: 'Claude Code',
        title: 'rewind',
        repo: 'rewind',
        meta: { gitBranch: branchA, cwd: 'C:/Users/dev/rewind' },
        endT: '09:40:00',
      },
      {
        t: '09:45:00',
        ctx: 'A',
        type: 'system.window.focus',
        app: 'WindowsTerminal',
        title: 'rewind',
        repo: 'rewind',
      },
      {
        t: '14:00:00',
        ctx: 'B',
        type: 'agent.session',
        app: 'Claude Code',
        title: 'Moonrise post-apocalyptic strategy game',
        repo: 'beta',
        meta: { gitBranch: branchB, cwd: 'C:/Users/dev/beta' },
        endT: '14:40:00',
      },
      {
        t: '14:45:00',
        ctx: 'B',
        type: 'system.window.focus',
        app: 'WindowsTerminal',
        title: 'beta',
        repo: 'beta',
      },
    ],
  });
}

describe('the branch anchor', () => {
  it('keeps two projects apart when each reports its own branch', () => {
    // The control. If this ever fails the test below proves nothing.
    expect(runEngine(twoProjects('main', 'master')).contexts.length).toBe(2);
  });

  it('does not merge two repositories that both report a detached head', () => {
    expect(runEngine(twoProjects('HEAD', 'HEAD')).contexts.length).toBe(2);
  });
});
