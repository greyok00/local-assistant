// product/scripts/build-release.mjs
// Produces the public-release folder: three archives, a checksum file, the
// README and the license. Everything executable inside them is the minified,
// comment-free build from scripts/build-dist.mjs, `src/` never ships.
//
//   release/local-assistant-<version>-static.zip      static-site drop-in
//   release/grey-local-site-ai-assistant-<version>-wordpress.zip   WordPress plugin
//   release/README.md, LICENSE, SHA256SUMS
//
// Usage: node scripts/build-release.mjs [--no-minify]
// Fails loudly if the payload contains a source map, an absolute home path,
// an email address, or a token-shaped string.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const abs = path => join(root, path);
const { version } = JSON.parse(await readFile(abs('package.json'), 'utf8'));
const releaseDir = abs('release');
const packageName = `local-assistant-${version}`;
const stage = join(releaseDir, packageName);

const fail = message => { throw new Error(`release: ${message}`); };

// 1. Build the minified payload (comments stripped, no source maps).
execFileSync(process.execPath, [abs('scripts/build-dist.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
if (!existsSync(abs('dist/loader.js'))) fail('dist/ was not produced');

// 2. Stage the static drop-in under a versioned folder name.
await rm(releaseDir, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(abs('dist'), stage, { recursive: true });
await rm(join(stage, 'wordpress'), { recursive: true, force: true });
await cp(abs('README.md'), join(stage, 'README.md'));
// The product license is the repository's GPL-2.0-or-later file at the root.
await cp(join(root, '..', 'LICENSE'), join(stage, 'LICENSE'));

// 3. The WordPress plugin is its own zip, already assembled by dist/wordpress.
// The folder inside the archive must be the plugin slug; a versioned folder
// name becomes the slug on upload and "wordpress" is a restricted term.
const pluginSlug = 'grey-local-site-ai-assistant';
const pluginStage = join(releaseDir, pluginSlug);
await cp(abs('dist/wordpress'), pluginStage, { recursive: true });

// 4. Sanity checks on what is about to be published.
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) { await walk(child); continue; }
    files.push(child);
  }
}
await walk(releaseDir);

const problems = [];
for (const file of files) {
  const rel = relative(releaseDir, file);
  if (file.endsWith('.map')) problems.push(`${rel}: source map`);
  if (!/\.(js|css|html|json|php|txt|md)$/i.test(file)) continue;
  const text = await readFile(file, 'utf8');
  if (/\/home\/[a-z0-9._-]+\//i.test(text)) problems.push(`${rel}: absolute home path`);
  for (const address of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
    if (/@(example\.(com|org)|localhost)$/i.test(address) || /@[\w-]+\.php$/i.test(address)) continue;
    problems.push(`${rel}: email address (${address})`);
  }
  if (/\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/.test(text)) {
    problems.push(`${rel}: token-shaped string`);
  }
  // Comments are the whole point of the stripped build; only third-party
  // bundles under vendor/ (already-built artifacts, not our code) keep theirs.
  const readable = rel.includes('/vendor/') || rel.includes('/source/');
  if (/\.js$/i.test(file) && !readable && /^\s*\/\*[\s\S]{40,}?\*\//m.test(text) && !/^\s*\/\*!/.test(text)) {
    problems.push(`${rel}: block comment survived minification`);
  }
}
if (problems.length) fail(`clean check failed:\n  ${problems.join('\n  ')}`);

// 5. Archives. zip -r with -X so no extra attributes leak into the archive.
const zip = (out, from, ...entries) => {
  execFileSync('zip', ['-qrX', out, ...entries], { cwd: from });
};
zip(join(releaseDir, `${packageName}-static.zip`), releaseDir, packageName);
zip(join(releaseDir, `grey-local-site-ai-assistant-${version}-wordpress.zip`), releaseDir, pluginSlug);
await rm(pluginStage, { recursive: true, force: true });

// 6. Checksums for the three artifacts.
const artifacts = (await readdir(releaseDir)).filter(name => name.endsWith('.zip')).sort();
const sums = [];
for (const name of artifacts) {
  const data = await readFile(join(releaseDir, name));
  sums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
}
await writeFile(join(releaseDir, 'SHA256SUMS'), sums.join('\n') + '\n');

const size = async (file) => ((await stat(file)).size / 1024 / 1024).toFixed(1);
console.log(`release: ${packageName}`);
for (const name of artifacts) console.log(`  ${name} (${await size(join(releaseDir, name))} MB)`);
console.log(`  SHA256SUMS, README.md, LICENSE`);
