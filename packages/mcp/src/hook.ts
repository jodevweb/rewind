/**
 * SessionStart hook — REWIND hands the agent the thread before it asks for it.
 *
 * The MCP server can already answer "where was I", but only once the model thinks to ask, and only
 * in the project where the server is declared. This runs at session start, in every project, and
 * puts the answer in the session's context before the first prompt is read. The evening this was
 * written, a power cut destroyed a session's context and rebuilding it by hand took fifteen tool
 * calls against git and the GitHub API; the card below is what it was reconstructing.
 *
 * Three rules, all of them about not being in the way:
 *
 * - It fails silent. Any error — no store, a locked database, a schema this build does not know —
 *   exits 0 with no output. Blocking a session start to announce that the memory is unavailable is
 *   worse than starting without the memory.
 * - It says nothing when it has nothing. An empty card teaches the reader to ignore the feature.
 * - It answers for THIS project, never for the machine, so an agent starting in one repository is
 *   never handed a confident description of the work happening in another.
 */

import { existsSync } from 'node:fs';

import { Store, storePath } from './db.js';
import { NOTHING, resumeTextForProject } from './tools.js';

/**
 * Which project this session is starting in, from the most reliable source available.
 *
 * The argument first, because it is the only one that cannot be wrong: the hook command passes the
 * shell's own directory. Then stdin, where the host puts `cwd`. `process.cwd()` is last and is
 * nearly useless here — `pnpm --filter` runs the script from the package directory, so it reads
 * `packages/mcp` rather than the session's project, and the card comes back empty for a reason
 * nothing on screen explains. That is how this was found.
 */
async function projectPath(): Promise<string> {
  const fromArgv = process.argv[2];
  if (typeof fromArgv === 'string' && fromArgv.trim() !== '') return fromArgv.trim();
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw !== '') {
      const parsed = JSON.parse(raw) as { cwd?: unknown };
      if (typeof parsed.cwd === 'string' && parsed.cwd !== '') return parsed.cwd;
    }
  } catch {
    // Not JSON, or nothing on stdin. The working directory is the same answer in practice.
  }
  return process.cwd();
}

async function main(): Promise<void> {
  const cwd = await projectPath();
  if (!existsSync(storePath())) return;

  const store = new Store();
  const text = resumeTextForProject(store, Date.now(), cwd);
  if (text === NOTHING) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Contexte REWIND — reprise automatique de ce projet.\n\n${text}`,
      },
      suppressOutput: true,
    })}\n`,
  );
}

main().catch(() => {
  // See the header: a hook that cannot answer says nothing and gets out of the way.
});
