// product/scripts/build-dist.mjs
// Assembles the folder a customer gets. Two layouts come out of one build:
//   dist/            the static-site drop-in (paste one script tag)
//   dist/wordpress/  a complete WordPress plugin, with dist/ inside it
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const abs = path => join(root, path);
const rel = path => relative(root, path);
const fail = message => { throw new Error(`build: ${message}`); };

// Every module the runtime can reach, including the ones only dashboard.js
// pulls in through ingest.js. Missing one leaves a 404 in the shipped folder.
const assets = [
  'loader.js', 'widget.js', 'widget.css', 'service-worker.js', 'config.js',
  'embedder.js', 'retriever.js', 'prompt.js', 'chat.js', 'cpuchat.js', 'cpu-worker.js', 'gpu.js', 'indexcodec.js',
  'suggest.js', 'overview.js', 'theme.js',
  'sitemap.js', 'extract.js', 'chunk.js', 'ingest.js',
  'dashboard.html', 'dashboard.js', 'dashboard.css', 'tabs.js'
];

for (const file of [...assets, 'config.example.json']) {
  if (!existsSync(abs(`src/${file}`))) fail(`missing src/${file}`);
}
if (!existsSync(abs('src/vendor'))) fail('missing src/vendor; run npm run vendor first');
const pluginFiles = ['local-assistant.php', 'readme.txt', 'THIRD-PARTY-NOTICES.txt'];
for (const file of pluginFiles) {
  if (!existsSync(abs(`wordpress/${file}`))) fail(`missing wordpress/${file}`);
}
// The directory will not accept minified scripts unless the readable originals
// travel with them. LOCAL_ASSISTANT_WPORG=1 adds a source/ folder for that
// upload; GitHub releases stay minified-only.
const WPORG = process.env.LOCAL_ASSISTANT_WPORG === '1';

await rm(abs('dist'), { recursive: true, force: true });
await mkdir(abs('dist'), { recursive: true });

// The asset payload is identical in both layouts; the plugin simply holds its
// own copy so the plugin folder can be zipped and installed on its own.
// Only the browser bundles are reachable at runtime. The Node and unminified
// builds of transformers.js were shipping too and pushed the archive past the
// directory's 10 MB limit for no benefit.
const unusedVendor =['transformers.web.js', 'transformers.web.min.js', 'transformers.node.mjs', 'transformers.node.cjs', 'transformers.node.min.mjs', 'transformers.node.min.cjs'];

async function copyPayload(dest) {
  await mkdir(dest, { recursive: true });
  for (const file of assets) await cp(abs(`src/${file}`), join(dest, file));
  await cp(abs('src/vendor'), join(dest, 'vendor'), { recursive: true });
  for (const file of unusedVendor) {
    await rm(join(dest, 'vendor/transformers', file), { force: true });
  }
  const example = JSON.parse(await readFile(abs('src/config.example.json'), 'utf8'));
  await writeFile(join(dest, 'assistant.config.json'), JSON.stringify(example, null, 2) + '\n');
}

await copyPayload(abs('dist'));
await copyPayload(abs('dist/wordpress/dist'));
for (const file of pluginFiles) {
  await cp(abs(`wordpress/${file}`), abs(`dist/wordpress/${file}`));
}
if (WPORG) {
  await mkdir(abs('dist/wordpress/source'), { recursive: true });
  for (const file of assets) await cp(abs(`src/${file}`), abs(`dist/wordpress/source/${file}`));
}
// Plugin icons and banners belong to the wordpress.org listing, not to the
// installable archive, nothing at runtime reads them, and they would spend
// about a megabyte of the directory's 10 MB limit.

// The shipped JavaScript is minified and its comments removed; `src/` stays
// readable. This is a browser bundle, so a native extension is not available
// and minification is the meaningful protection: names are shortened, comments
// and formatting are gone, and no source map is emitted. Third-party runtimes
// under vendor/ are already built artifacts and are left untouched.
const MINIFY = !process.argv.includes('--no-minify');

async function minifyPayload(dir) {
  let before = 0;
  let after = 0;
  for (const file of await readdir(dir)) {
    const full = join(dir, file);
    if (file.endsWith('.js')) {
      const source = await readFile(full, 'utf8');
      const { code } = await transform(source, {
        loader: 'js', format: 'esm', minify: true, legalComments: 'none', target: 'es2022'
      });
      before += source.length;
      after += code.length;
      await writeFile(full, code);
    } else if (file.endsWith('.css')) {
      const source = await readFile(full, 'utf8');
      const { code } = await transform(source, { loader: 'css', minify: true });
      before += source.length;
      after += code.length;
      await writeFile(full, code);
    } else if (file.endsWith('.html')) {
      // The dashboard carried section-marker comments into the shipped folder;
      // conditional comments are left alone because only IE reads them.
      const source = await readFile(full, 'utf8');
      const code = source.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
      before += source.length;
      after += code.length;
      await writeFile(full, code);
    }
  }
  return { before, after };
}

if (MINIFY) {
  for (const dir of ['dist', 'dist/wordpress/dist']) {
    const { before, after } = await minifyPayload(abs(dir));
    console.log(`dist: minified ${dir} (${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB)`);
  }
  // The plugin's PHP used to ship with every docblock and inline comment in
  // it, the one file in either release that was not comment-free (found
  // 2026-10-31). The WordPress header is itself a docblock, so the stripper
  // keeps the one comment WordPress needs and removes the rest.
  const php = [];
  for (const file of await readdir(abs('dist/wordpress'))) {
    if (file.endsWith('.php')) php.push(abs(`dist/wordpress/${file}`));
  }
  if (php.length) {
    execFileSync('php', [abs('scripts/strip-comments.php'), ...php], { stdio: 'inherit' });
    for (const file of php) {
      const out = execFileSync('php', ['-l', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (!/No syntax errors detected/.test(out)) fail(`stripped PHP does not parse: ${rel(file)}`);
    }
  }
} else {
  console.log('dist: --no-minify, source copied as-is');
}

// A copy-paste folder only works if every relative import lands on a file that
// is actually in that folder. Catch a forgotten entry here, not on a host page.
const specifier = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
const isRelative = value => value.startsWith('.') || value.startsWith('/');
const isUrl = value => /^[a-z][a-z0-9+.-]*:/i.test(value);

for (const dir of ['dist', 'dist/wordpress/dist']) {
  const base = abs(dir);
  const missing = [];
  const bare = [];
  for (const file of await readdir(base)) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(join(base, file), 'utf8');
    for (const [, value] of source.matchAll(specifier)) {
      if (value.startsWith('data:') || value.startsWith('blob:')) continue;
      if (!isRelative(value) && !isUrl(value)) { bare.push(`${dir}/${file}: ${value}`); continue; }
      if (!isRelative(value)) continue;
      if (!existsSync(abs(join(dir, dirname(file), value)))) missing.push(`${dir}/${file}: ${value}`);
    }
  }
  if (missing.length) fail(`unresolved relative imports:\n  ${missing.join('\n  ')}`);
  // No bare specifiers: the host page has no import map, so `from 'x'` throws
  // before the widget renders. URLs (and data:/blob:) are deliberate.
  if (bare.length) fail(`bare module specifiers:\n  ${bare.join('\n  ')}`);
}

const plugin = pluginFiles;
for (const file of plugin) {
  if (!existsSync(abs(`dist/wordpress/${file}`))) fail(`dist/wordpress/${file} missing`);
}

console.log(`dist: built (${(await dirSize(abs('dist')) / 1024 / 1024).toFixed(1)} MB in ${rel(abs('dist'))}/)`);
console.log('dist: static drop-in -> dist/ ; WordPress plugin -> dist/wordpress/');

async function dirSize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await dirSize(child);
    else total += (await stat(child)).size;
  }
  return total;
}
