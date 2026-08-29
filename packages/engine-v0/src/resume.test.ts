/**
 * What the Resume card offers to reopen.
 *
 * Every entry here is rendered as a button. A button that reopens a file nobody wants teaches the
 * reader the feature is decorative, and that is not un-taught — which is why the shape of this list
 * is guarded rather than left to whatever the collectors happen to emit.
 */

import { buildSession } from '@rewind/fixtures/authoring';
import { describe, expect, it } from 'vitest';

import { runEngine } from './engine.js';
import { buildResume } from './resume.js';

const PROJECT = 'C:/Users/jorda/rewind';
const REAL_FILE = 'C:/Users/jorda/rewind/packages/ask/src/text.ts';
const SCRATCH = 'C:/Users/jorda/AppData/Local/Temp/claude/session-1/scratchpad/fixdia.cjs';

function aDayInTheAgent() {
  return buildSession({
    id: 'resume-open',
    name: 'A day spent in Claude Code',
    description: 'One agent session that edited a project file and a scratch file.',
    tests: 'What a Resume card offers to reopen after a day driven by an agent.',
    day: '2026-08-29',
    tzOffsetMinutes: 120,
    defaultRepo: 'rewind',
    contexts: { A: { label: 'Work in rewind' } },
    steps: [
      {
        t: '09:00:00',
        ctx: 'A',
        type: 'agent.session',
        app: 'Claude Code',
        title: 'rewind',
        endT: '09:40:00',
        meta: {
          gitBranch: 'main',
          cwd: PROJECT,
          filesTouched: [REAL_FILE, SCRATCH],
        },
      },
      {
        t: '09:45:00',
        ctx: 'A',
        type: 'system.window.focus',
        app: 'WindowsTerminal',
        title: 'rewind',
      },
    ],
  });
}

describe('what a Resume card offers to reopen', () => {
  const session = aDayInTheAgent();
  const context = runEngine(session).contexts[0]!;
  const targets = buildResume(session, context).openResources.map((r) => r.target);

  it('offers the file the work was actually in', () => {
    expect(targets).toContain(REAL_FILE);
  });

  it('does not offer an agent scratch file from the system temp directory', () => {
    // Real evidence: a Resume card proposed reopening two throwaway .cjs scripts an agent had
    // written under AppData/Local/Temp two sessions earlier.
    expect(targets).not.toContain(SCRATCH);
    expect(targets.some((t) => /[/\\](?:temp|tmp)[/\\]/i.test(t))).toBe(false);
  });

  it('still offers the workspace itself', () => {
    expect(targets).toContain(PROJECT);
  });
});
