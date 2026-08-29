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

import { offersASubject, titlePhrases } from './anchors.js';
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
      B: { label: 'Work in ogamelike' },
    },
    steps: [
      {
        t: '09:00:00',
        ctx: 'A',
        type: 'agent.session',
        app: 'Claude Code',
        title: 'rewind',
        repo: 'rewind',
        meta: { gitBranch: branchA, cwd: 'C:/Users/jorda/rewind' },
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
        title: 'Ashfall post-apocalyptic strategy game',
        repo: 'ogamelike',
        meta: { gitBranch: branchB, cwd: 'C:/Users/jorda/ogamelike' },
        endT: '14:40:00',
      },
      {
        t: '14:45:00',
        ctx: 'B',
        type: 'system.window.focus',
        app: 'WindowsTerminal',
        title: 'ogamelike',
        repo: 'ogamelike',
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

describe('the phrases a title offers as a subject', () => {
  /**
   * `feat(ui): `, `fix: `, `chore(deps): ` — a convention about the message, not what the work was
   * about. The scope changes with every commit, so across a day of commits the type is the one
   * phrase they all share: the most recurrent candidate, and the least informative. A real project
   * came back named "Feat".
   */
  it('does not offer the type of a conventional commit', () => {
    const phrases = titlePhrases('feat(faction): what none of you could pay for alone');
    expect(phrases).not.toContain('feat');
    expect(phrases).not.toContain('feat faction');
  });

  it('leaves the message the prefix was attached to untouched', () => {
    // The control. Stripping the prefix must take the prefix and nothing else with it.
    expect(titlePhrases('feat(faction): what none of you could pay for alone')).toEqual(
      titlePhrases('what none of you could pay for alone'),
    );
  });

  it('does not strip a word that merely starts a sentence', () => {
    // `fix` is also an ordinary word. Only the prefix form — type, optional scope, colon — goes.
    expect(titlePhrases('fix the sweeper before it leaves')).toContain('sweeper');
    expect(titlePhrases('feature flags for the faction system')).toContain('flags');
  });
});

describe('titles REWIND writes itself', () => {
  const summary = {
    ref: 'e1',
    type: 'git.status.summary',
    title: '16 fichier(s) non commités · ogamelike',
  } as unknown as Parameters<typeof offersASubject>[0];

  const commit = {
    ref: 'e2',
    type: 'git.commit',
    title: 'the sweeper can leave the web process',
  } as unknown as Parameters<typeof offersASubject>[0];

  it('does not let our own bookkeeping name the work', () => {
    // `git.status.summary` is emitted every time the count changes, so across a day it is the
    // phrase a context repeats most. A real project came back called "CommitéS Ogamelike".
    expect(offersASubject(summary)).toBe(false);
  });

  it('keeps a commit message, which is written by the person about the work', () => {
    expect(offersASubject(commit)).toBe(true);
  });
});
