/**
 * Stamp a version across every file that carries one.
 *
 * The release workflow fills `__VERSION__` from tauri.conf.json, so the version typed into the
 * Actions tab used to be ignored and the run republished whatever was already committed. This is
 * what makes that input mean something.
 *
 * It lives in a file rather than inline in the YAML because the escaping needed to embed a script
 * inside a quoted shell string inside a YAML block is unreadable, and it silently mangled the
 * regular expressions the first time.
 *
 *   node scripts/set-version.mjs 0.2.0
 */

import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Version must look like 1.2.3, got: ${version ?? '(nothing)'}`);
  process.exit(1);
}

/**
 * Replace exactly one match, textually.
 *
 * Parsing and re-serialising the JSON reformatted the whole file, which buries a one-line version
 * bump in a hundred lines of churn. And the replacement is passed as a function because `$&` and
 * ``$` `` are substitutions inside a replacement string — that is how an earlier version of this
 * script pasted the file's own header into the middle of itself.
 */
function stampOnce(file, pattern, replacement) {
  const before = readFileSync(file, 'utf8');
  const matches = before.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];

  if (matches.length !== 1) {
    console.error(`Expected exactly one version line in ${file}, found ${matches.length}.`);
    process.exit(1);
  }

  writeFileSync(
    file,
    before.replace(pattern, () => replacement),
  );
  return file;
}

// `\r?$` rather than `$`: a Windows checkout has CRLF line endings, and without it the anchor never
// matches there — which is exactly how this failed the first time it ran.
const stamped = [
  stampOnce(
    'apps/desktop/src-tauri/tauri.conf.json',
    /^(\s*)"version": ".*"/m,
    `  "version": "${version}"`,
  ),
  stampOnce('apps/desktop/package.json', /^(\s*)"version": ".*"/m, `  "version": "${version}"`),
  // Only the package's own version. Dependency pins further down the file look identical, so the
  // anchor is the line start, and the count check above fails loudly if that ever stops being true.
  stampOnce('apps/desktop/src-tauri/Cargo.toml', /^version = ".*"/m, `version = "${version}"`),
];

console.log(`Version set to ${version} in ${stamped.length} files:\n  ${stamped.join('\n  ')}`);
