/**
 * Assemble the update manifest the application polls.
 *
 * Each platform's build leaves a `<platform>.json` in `release-assets/`; this merges them into the
 * single `latest.json` the Tauri updater reads. It runs after every platform has finished, because a
 * manifest naming only one of them would tell the other machine there is no update.
 *
 *   node scripts/build-latest-json.mjs 0.2.0 jodevweb/rewind-dist
 */

import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [version, repository] = process.argv.slice(2);

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Version must look like 1.2.3, got: ${version ?? '(nothing)'}`);
  process.exit(1);
}
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  console.error(`Repository must look like owner/name, got: ${repository ?? '(nothing)'}`);
  process.exit(1);
}

const OUT = 'release-assets';
const EXPECTED = ['darwin-aarch64', 'windows-x86_64'];

const descriptorFiles = readdirSync(OUT).filter((f) => f.endsWith('.json') && f !== 'latest.json');
const descriptors = descriptorFiles.map((f) => JSON.parse(readFileSync(join(OUT, f), 'utf8')));

const missing = EXPECTED.filter((p) => !descriptors.some((d) => d.platform === p));
if (missing.length > 0) {
  // Publishing a partial manifest is worse than not publishing: the platform left out is told there
  // is nothing to update to, and it is told that by a release that looks successful.
  console.error(`No build collected for: ${missing.join(', ')}.`);
  process.exit(1);
}

const wrongVersion = descriptors.filter((d) => d.version !== version);
if (wrongVersion.length > 0) {
  console.error(`Version mismatch — expected ${version}, got:`);
  for (const d of wrongVersion) console.error(`  ${d.platform}: ${d.version}`);
  process.exit(1);
}

const platforms = {};
for (const d of descriptors) {
  platforms[d.platform] = {
    signature: d.signature,
    url: `https://github.com/${repository}/releases/download/v${version}/${d.updaterName}`,
  };
}

const manifest = {
  version,
  // The application shows the first line of this in the update banner. An empty banner reads as a
  // glitch rather than an offer.
  notes: `REWIND ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(join(OUT, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// The per-platform descriptors were scaffolding for this merge. The release uploads whatever is
// left in this directory, and two stray JSON files beside the installers only invite the question
// of what they are.
for (const file of descriptorFiles) rmSync(join(OUT, file));

console.log(`latest.json for ${version}:`);
for (const [name, entry] of Object.entries(platforms)) console.log(`  ${name} → ${entry.url}`);
