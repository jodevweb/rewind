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
 *   - the updater bundle and its signature,
 *   - the installer a person downloads and double-clicks,
 *   - a small `<platform>.json` describing what was found, which `build-latest-json.mjs` merges.
 *
 * On Windows those first two are the same file: Tauri v2 signs the NSIS `.exe` directly and produces
 * no `.nsis.zip`, which was v1 behaviour. On macOS they differ — a `.app.tar.gz` for the updater, a
 * `.dmg` for a person.
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
  'windows-x86_64': { updater: /-setup\.exe$/, installer: /-setup\.exe$/ },
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

// `.sig` files are excluded so a signature never gets mistaken for the artifact it signs: on Windows
// the updater pattern ends in `-setup.exe`, and `-setup.exe.sig` would not match, but the next
// platform's pattern might not be so lucky.
const files = walk(TARGET).filter((f) => f.includes('bundle') && !f.endsWith('.sig'));
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

const installerName = installerPath.split(/[/\\]/).pop();

// Tauri names the macOS updater bundle `REWIND.app.tar.gz` — no version, no architecture — and two
// platforms cannot upload files of the same name to one release. Windows already produces a unique
// name, and there the updater artifact is the installer people download, so renaming it would only
// make the release page harder to read.
const updaterIsInstaller = updaterPath === installerPath;
const updaterName = updaterIsInstaller ? installerName : `REWIND_${version}_${platform}.app.tar.gz`;

copyFileSync(installerPath, join(OUT, installerName));
if (!updaterIsInstaller) {
  copyFileSync(updaterPath, join(OUT, updaterName));
}

writeFileSync(
  join(OUT, `${platform}.json`),
  `${JSON.stringify({ platform, version, updaterName, installerName, signature }, null, 2)}\n`,
);

console.log(
  [
    `Collected for ${platform}:`,
    `  installer: ${installerName}`,
    `  updater:   ${updaterName}${updaterIsInstaller ? ' (the installer itself)' : ''}`,
    `  signature: ${signature.length} chars`,
  ].join('\n'),
);
