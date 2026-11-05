/**
 * Emit the golden sessions as JSON (ticket P0-005).
 *
 * The TypeScript in `src/sessions/` is the human-editable source. This produces the
 * language-neutral artefact the Rust engine and the evaluation harness read. Both are committed;
 * CI fails if the JSON is stale, exactly like generated types.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ALL_SESSIONS } from './sessions/index.js';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../golden');
const check = process.argv.includes('--check');

mkdirSync(outDir, { recursive: true });

let stale = 0;
for (const session of ALL_SESSIONS) {
  const path = join(outDir, `${session.id}.json`);
  const next = JSON.stringify(session, null, 2) + '\n';

  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      /* missing counts as stale */
    }
    if (current !== next) {
      console.error(`stale: ${session.id}.json`);
      stale += 1;
    }
    continue;
  }

  writeFileSync(path, next);
  const events = session.events.length;
  const contexts = session.expected.contextCount;
  const noise = session.expected.noiseEventRefs.length;
  console.log(
    `${session.id.padEnd(32)} ${String(events).padStart(3)} events  ` +
      `${contexts} context${contexts === 1 ? ' ' : 's'}  ${String(noise).padStart(2)} noise`,
  );
}

if (check) {
  if (stale > 0) {
    console.error(
      `\n${stale} golden fixture(s) out of date. Run: pnpm --filter @rewind/fixtures build`,
    );
    process.exit(1);
  }
  console.log('Golden fixtures are up to date.');
} else {
  const totalEvents = ALL_SESSIONS.reduce((n, s) => n + s.events.length, 0);
  const totalContexts = ALL_SESSIONS.reduce((n, s) => n + s.expected.contextCount, 0);
  console.log(
    `\n${ALL_SESSIONS.length} sessions · ${totalEvents} events · ${totalContexts} ground-truth contexts`,
  );
}
