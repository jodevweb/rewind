/**
 * Bundles the MCP server and the session-start hook into two self-contained files that ship inside
 * the desktop application, so an installed REWIND can connect any agent without a checkout, pnpm or
 * tsx. The only requirement left on the machine is Node 22.5 or later, for `node:sqlite`.
 *
 *   node bundle.mjs [outDir]   (default: ../../apps/desktop/src-tauri/resources/mcp)
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, '../../apps/desktop/src-tauri/resources/mcp'));
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: {
    'rewind-mcp': join(here, 'src/main.ts'),
    'rewind-hook': join(here, 'src/hook.ts'),
  },
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // `node:sqlite` is resolved at run time by the Node that runs the file.
  external: ['node:*'],
  legalComments: 'none',
  logLevel: 'warning',
});

console.log(`MCP bundled into ${outDir}`);
