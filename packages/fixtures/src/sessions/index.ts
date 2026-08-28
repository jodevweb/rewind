import type { GoldenSession } from '../authoring.js';

import { gs01 } from './gs-01-focused-debugging.js';
import { gs02 } from './gs-02-temporary-interruption.js';
import { gs03 } from './gs-03-real-context-switch.js';
import { gs04 } from './gs-04-two-tasks-same-repo.js';
import { gs05 } from './gs-05-failed-investigation.js';
import { gs06 } from './gs-06-chaotic-day.js';
import { gs07 } from './gs-07-cross-app-feature-work.js';
import { gs08 } from './gs-08-two-projects-interleaved.js';
import { gs09 } from './gs-09-administrative-work.js';
import { gs10 } from './gs-10-communication-noise.js';

/**
 * The golden set (ticket P0-005). Each fixture isolates one failure mode of the context engine:
 *
 *   GS-01  the baseline — one focused task must not fragment
 *   GS-02  false split  — a short interruption must not break a context
 *   GS-03  false merge  — a sustained switch must break one
 *   GS-04  false merge  — same repository, two tasks, one shared file
 *   GS-05  Resume       — unfinished work is the common case, not the exception
 *   GS-06  the benchmark  — a whole messy day, contexts fragmented across it
 *
 * Cross-application set (ADR 0002 — work-context-first, macOS):
 *
 *   GS-07  nine applications, one piece of work — almost no repository signal
 *   GS-08  two projects interleaved in short slices, sharing every application
 *   GS-09  pure administrative work — zero development events
 *   GS-10  interruptions arriving in the same applications the real work uses
 *
 * A fix for any future context-engine bug should add a fixture here, or extend one.
 */
export const ALL_SESSIONS: GoldenSession[] = [
  gs01,
  gs02,
  gs03,
  gs04,
  gs05,
  gs06,
  gs07,
  gs08,
  gs09,
  gs10,
];

export { gs01, gs02, gs03, gs04, gs05, gs06, gs07, gs08, gs09, gs10 };
