/**
 * The home screen's projects: which directories are projects, and what each one left behind.
 *
 * The shapes tested here are the ones a real machine produced: projects on two disks, the same
 * folder spelled two ways, agent scratchpads in the temporary directory, a workspace folder that
 * holds projects rather than being one, and a game paused for a week.
 */

import { describe, expect, it } from 'vitest';

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';

import { buildHome, isScratch, pathKey, place, projectBrief } from './projects.js';

const TZ = 60;
const H = 3_600_000;
/** 2026-11-04, 16:00 local. */
const NOW = Date.UTC(2026, 10, 4, 15, 0);

let n = 0;
function ev(
  type: string,
  at: number,
  metadata: Record<string, unknown>,
  extra: Partial<GoldenEvent> = {},
): GoldenEvent {
  n += 1;
  return {
    id: `e${n}`,
    ref: `e${n}`,
    timestamp: at,
    tzOffsetMinutes: TZ,
    source: type.startsWith('git') ? 'git' : type.startsWith('terminal') ? 'terminal' : 'agent',
    type,
    producer: { name: 'test', version: '1' },
    metadata,
    privacyLevel: 'normal',
    redaction: { patternsVersion: '1', applied: [], count: 0 },
    importance: 50,
    ...extra,
  };
}

const session = (
  path: string,
  at: number,
  title: string,
  minutes = 30,
  more: Record<string, unknown> = {},
) =>
  ev(
    'agent.session',
    at,
    { projectPath: path, ...more },
    { endTimestamp: at + minutes * 60_000, title },
  );

function history(events: GoldenEvent[]): GoldenSession {
  return {
    id: 'h',
    name: 'h',
    description: '',
    tests: '',
    day: '2026-11-04',
    tzOffsetMinutes: TZ,
    expected: { contextCount: 0, contexts: [], noiseEventRefs: [] },
    events,
  };
}

describe('paths', () => {
  it('spells a Windows folder one way whatever the case or slash', () => {
    expect(pathKey('D:\\work\\Atlas')).toBe(pathKey('D:/work/ATLAS/'));
  });

  it('keeps POSIX paths case-sensitive', () => {
    expect(pathKey('/home/a/Repo')).not.toBe(pathKey('/home/a/repo'));
  });

  it('recognises an agent scratchpad', () => {
    expect(isScratch('C:\\Users\\a\\AppData\\Local\\Temp\\claude\\x\\scratchpad\\repo')).toBe(true);
    expect(isScratch('D:\\work\\Atlas')).toBe(false);
  });
});

describe('buildHome', () => {
  it('orders projects by last activity, newest first', () => {
    const home = buildHome(
      history([
        session('D:\\work\\Atlas', NOW - 3 * H, 'Personnages'),
        session('D:\\work\\rewind', NOW - 1 * H, 'Refonte'),
      ]),
      NOW,
    );
    expect(home.projects.map((p) => p.name)).toEqual(['rewind', 'Atlas']);
  });

  it('merges the same folder reported with two spellings', () => {
    const home = buildHome(
      history([
        session('D:\\work\\Atlas', NOW - 3 * H, 'Un'),
        session('D:\\work\\ATLAS', NOW - 2 * H, 'Deux'),
      ]),
      NOW,
    );
    expect(home.projects).toHaveLength(1);
    expect(home.projects[0]!.sessions).toBe(2);
    expect(home.projects[0]!.lastSession?.title).toBe('Deux');
  });

  it('never makes a project of a scratchpad or of a folder that holds projects', () => {
    const home = buildHome(
      history([
        session(
          'C:\\Users\\a\\AppData\\Local\\Temp\\claude\\x\\scratchpad\\probe',
          NOW - H,
          'Sonde',
        ),
        session('D:\\work', NOW - H, 'Tour du propriétaire'),
        session('D:\\work\\orbit', NOW - 2 * H, 'Analyse'),
      ]),
      NOW,
    );
    expect(home.projects.map((p) => p.name)).toEqual(['orbit']);
  });

  it('joins Git and shell activity onto the project that contains them', () => {
    const home = buildHome(
      history([
        session('D:\\work\\Atlas', NOW - 5 * H, 'Caméra'),
        ev('git.commit', NOW - 4 * H, {
          worktree: 'D:\\work\\Atlas',
          messageRedacted: 'build 59',
          branch: 'main',
        }),
        ev('git.status.summary', NOW - 3 * H, { worktree: 'd:/work/atlas', dirtyFiles: 18 }),
        ev('terminal.command', NOW - 2 * H, {
          cwd: 'D:\\work\\Atlas\\Source',
          exitCode: 0,
          durationMs: 5000,
        }),
      ]),
      NOW,
    );
    const atlas = home.projects[0]!;
    expect(atlas.lastCommit?.message).toBe('build 59');
    expect(atlas.dirty).toBe(18);
    expect(atlas.branch).toBe('main');
    expect(atlas.lastAt).toBe(NOW - 2 * H + 0);
  });

  it('ignores the tool’s default session title, which says where and never what', () => {
    const home = buildHome(
      history([
        session('D:\\p', NOW - 3 * H, 'Vrai sujet'),
        session('D:\\p', NOW - 2 * H, 'Claude Code — p'),
      ]),
      NOW,
    );
    expect(home.projects[0]!.lastSession?.title).toBe('Vrai sujet');
  });

  it('reopens absolute paths, resolving the ones a session gave relative to its project', () => {
    const home = buildHome(
      history([
        session('D:\\p', NOW - H, 'X', 30, { filesTouched: ['src\\a.ts', 'C:\\other\\b.md'] }),
      ]),
      NOW,
    );
    expect(home.projects[0]!.files).toEqual(['C:\\other\\b.md', 'D:\\p\\src\\a.ts']);
  });

  it('draws only today on the band, with touching runs merged', () => {
    const home = buildHome(
      history([
        session('D:\\p', NOW - 30 * H, 'Hier', 60),
        session('D:\\p', NOW - 4 * H, 'Matin', 60),
        session('D:\\p', NOW - 3 * H + 5 * 60_000, 'Suite', 30),
      ]),
      NOW,
    );
    const p = home.projects[0]!;
    expect(p.today).toHaveLength(1);
    expect(p.today[0]!.start).toBe(NOW - 4 * H);
    expect(home.axis).not.toBeNull();
    const at = place(p.today[0]!, home.axis!);
    expect(at.left).toBeGreaterThanOrEqual(0);
    expect(at.left + at.width).toBeLessThanOrEqual(100);
  });

  it('has no band at all on a day with nothing in it', () => {
    const home = buildHome(history([session('D:\\p', NOW - 48 * H, 'Avant-hier')]), NOW);
    expect(home.axis).toBeNull();
  });
});

describe('the week', () => {
  const days = (path: string, count: number, title = 'Travail') =>
    Array.from({ length: count }, (_, i) => session(path, NOW - i * 24 * H - H, title));

  it('names the project of the week, the one gone quiet, and the crash recoveries', () => {
    const home = buildHome(
      history([
        ...days('D:\\work\\Atlas', 5),
        ...Array.from({ length: 6 }, (_, i) =>
          session('D:\\work\\Harbor', NOW - 9 * 24 * H - i * H, 'Paquets'),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          session('D:\\work\\Atlas', NOW - 2 * H - i * 60_000, 'Reprise après plantage du PC'),
        ),
      ]),
      NOW,
    );
    expect(home.week).toEqual([
      { kind: 'main', name: 'Atlas', days: 5 },
      // Nine days since it started, eight full days since its last session ended.
      { kind: 'paused', name: 'Harbor', days: 8 },
      { kind: 'recoveries', count: 3 },
    ]);
  });

  it('says nothing rather than something thin', () => {
    const home = buildHome(history([session('D:\\p', NOW - H, 'Un jour')]), NOW);
    expect(home.week).toEqual([]);
  });
});

describe('projectBrief', () => {
  it('carries what an agent needs and nothing generated', () => {
    const home = buildHome(
      history([
        session('D:\\p', NOW - 2 * H, 'Refonte', 30, { filesTouched: ['a.ts'], gitBranch: 'main' }),
        ev('git.status.summary', NOW - H, { worktree: 'D:\\p', dirtyFiles: 2 }),
      ]),
      NOW,
    );
    const brief = projectBrief(home.projects[0]!);
    expect(brief).toContain('D:\\p');
    expect(brief).toContain('Refonte');
    expect(brief).toContain('Fichiers non commités : 2');
    expect(brief).toContain('D:\\p\\a.ts');
  });
});
