/**
 * Gather one platform's release files out of the Tauri bundle tree.
 *
 * The source repository is private, so its release assets are a 404 to an unauthenticated client —
 * and the application has no token and must not have one (ADR 0005 D-13). Distribution therefore
 * happens from a separate public repository holding only the built installers, which means the
 * release workflow has to assemble the assets itself instead of letting tauri-action publish them.
 *
 * This runs once per platform and leaves everything in `release-assets/`:
 *
 *   - the updater bundle (`.app.tar.gz` on macOS, `-setup.nsis.zip` on Windows) and its signature,
 *   - the installer a person downloads and double-clicks (`.dmg`, `-setup.exe`),
 *   - a small `<platform>.json` describing what was found, which `build-latest-json.mjs` merges.
 *
 * Files are renamed to carry the version and platform. Tauri names the macOS updater bundle
 * `REWIND.app.tar.gz` with no version or architecture in it, and two platforms cannot both upload a
 * file of the same name to one release.
 *
 *   node scripts/collect-release-assets.mjs darwin-aarch64 0.2.0
 */

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const [platform, version] = process.argv.slice(2);

const PLATFORMS = {
  'darwin-aarch64': { updater: /\.app\.tar\.gz$/, installer: /\.dmg$/ },
  'windows-x86_64': { updater: /-setup\.nsis\.zip$/, installer: /-setup\.exe$/ },
};

if (!PLATFORMS[platform]) {
  console.error(
    `Unknown platform "${platform}". Expected one of: ${Object.keys(PLATFORMS).join(', ')}`,
  );
  process.exit(1);
}
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Version must look like 1.2.3, got: ${version ?? '(nothing)'}`);
  process.exit(1);
}

const TARGET = 'apps/desktop/src-tauri/target';
const OUT = 'release-assets';

/** Every file under a directory. The bundle layout differs per platform and per target triple. */
function walk(dir) {
  let found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found; // A target triple directory that this platform never built.
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found = found.concat(walk(path));
    } else {
      found.push(path);
    }
  }
  return found;
}

const files = walk(TARGET).filter((f) => f.includes('bundle'));
const { updater, installer } = PLATFORMS[platform];

const pick = (pattern, what) => {
  const matches = files.filter((f) => pattern.test(f));
  if (matches.length !== 1) {
    console.error(`Expected exactly one ${what} matching ${pattern}, found ${matches.length}:`);
    for (const m of matches) console.error(`  ${m}`);
    console.error('\nEverything under the bundle directory:');
    for (const f of files) console.error(`  ${f}`);
    process.exit(1);
  }
  return matches[0];
};

const updaterPath = pick(updater, 'updater bundle');
const installerPath = pick(installer, 'installer');

// The signature Tauri writes next to the updater bundle. Its absence means the build was not signed,
// and an unsigned update is one the application will refuse — better to fail here than to publish a
// release nobody can install.
const signaturePath = `${updaterPath}.sig`;
let signature;
try {
  signature = readFileSync(signaturePath, 'utf8').trim();
} catch {
  console.error(`No signature at ${signaturePath}.`);
  console.error('The build ran without TAURI_SIGNING_PRIVATE_KEY, so the update would be refused.');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const suffix = updaterPath.endsWith('.app.tar.gz') ? 'app.tar.gz' : 'nsis.zip';
const updaterName = `REWIND_${version}_${platform}.${suffix}`;
const installerName = installerPath.split(/[/\\]/).pop();

copyFileSync(updaterPath, join(OUT, updaterName));
copyFileSync(installerPath, join(OUT, installerName));
writeFileSync(
  join(OUT, `${platform}.json`),
  `${JSON.stringify({ platform, version, updaterName, installerName, signature }, null, 2)}\n`,
);

console.log(
  `Collected for ${platform}:\n  ${updaterName}\n  ${installerName}\n  signature (${signature.length} chars)`,
);
