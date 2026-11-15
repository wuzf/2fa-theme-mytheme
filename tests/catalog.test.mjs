import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import { buildCatalog, checkCatalog, serializeCatalog, validateThemeBytes } from '../scripts/catalog.mjs';

const license = 'MIT License\nCopyright (c) 2026 Test Author\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software to use, copy, modify and distribute it.';
const encoder = new TextEncoder();
const encode = (value) => encoder.encode(value);
function pack({ id = 'example', code = 'export function mount() { return () => {}; }', extra = {}, manifest = {} } = {}) {
  const content = { 'entry.js': encode(code), 'licenses/MIT.txt': encode(license), ...extra };
  const mime = { js: 'text/javascript', txt: 'text/plain', css: 'text/css', json: 'application/json' };
  const value = {
    themeApiVersion: 2, kind: 'app', sdkApiVersion: 1, id, name: 'Example', version: '1.0.0', author: 'Test Author', description: 'Self-contained test theme', entry: 'entry.js', styles: [], settings: [],
    files: Object.entries(content).map(([path, bytes]) => ({ path, mime: mime[path.split('.').pop()], size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
    ...manifest,
  };
  return zipSync({ ...content, '2fa-theme.json': encode(JSON.stringify(value)) });
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), '2fa-catalog-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'themes', 'example');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '2fa-theme.zip'), pack(options));
  await writeFile(join(directory, 'theme.json'), JSON.stringify({ license: 'MIT', source: 'https://github.com/deleted-author/deleted-theme' }));
  await writeFile(join(directory, 'LICENSE'), license);
  return { root, directory };
}

test('creates a catalog from copied ZIP bytes without contacting the author repository or executing theme JS', async (t) => {
  const { root } = await fixture(t, { code: 'globalThis.__catalogExecuted = true; export function mount() {}' });
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No network permitted'); };
  t.after(() => { globalThis.fetch = fetch; delete globalThis.__catalogExecuted; });
  const catalog = await buildCatalog(root);
  assert.equal(globalThis.__catalogExecuted, undefined);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.themes.length, 1);
  assert.equal(catalog.themes[0].path, 'themes/example/2fa-theme.zip');
  assert.equal(catalog.themes[0].source, 'https://github.com/deleted-author/deleted-theme');
  assert.match(catalog.themes[0].packageId, /^[a-f0-9]{64}$/);
  await writeFile(join(root, 'catalog.json'), serializeCatalog(catalog));
  assert.deepEqual(await checkCatalog(root), catalog);
});

test('updates replace the single fixed package entry and detect a stale catalog', async (t) => {
  const { root, directory } = await fixture(t);
  const before = await buildCatalog(root);
  await writeFile(join(root, 'catalog.json'), serializeCatalog(before));
  await writeFile(join(directory, '2fa-theme.zip'), pack({ code: 'export function mount() { return { update() {} }; }', manifest: { version: '1.1.0' } }));
  const after = await buildCatalog(root);
  assert.equal(after.themes.length, 1);
  assert.equal(after.themes[0].path, before.themes[0].path);
  assert.notEqual(after.themes[0].packageId, before.themes[0].packageId);
  assert.notEqual(after.themes[0].sha256, before.themes[0].sha256);
  await assert.rejects(checkCatalog(root), /stale/);
});

test('rejects extra historical ZIP files instead of indexing multiple versions', async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(join(directory, 'old.zip'), pack());
  await assert.rejects(buildCatalog(root), /exactly/);
});

test('rejects repository symlink or junction theme directories', async (t) => {
  const { root, directory } = await fixture(t);
  await symlink(directory, join(root, 'themes', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildCatalog(root), /linked directories/);
});

test('rejects submodule declarations', async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, '.gitmodules'), '[submodule "theme"]');
  await assert.rejects(buildCatalog(root), /submodules/);
});

test('rejects Git LFS pointers in place of archived theme bytes', async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(join(directory, '2fa-theme.zip'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n');
  await assert.rejects(buildCatalog(root), /LFS/);
});

test('rejects forged manifest hashes', async () => {
  const files = unzipSync(pack());
  files['entry.js'] = encode('export function mount() { throw new Error("changed"); }');
  await assert.rejects(validateThemeBytes(zipSync(files), 'example'), /THEME_APP_HASH/);
});

test('rejects external ESM imports and missing packaged chunks', async () => {
  await assert.rejects(validateThemeBytes(pack({ code: 'import "https://github.com/author/theme/entry.js"; export function mount() {}' }), 'example'), /THEME_APP_REFERENCE/);
  await assert.rejects(validateThemeBytes(pack({ code: 'import "./missing.js"; export function mount() {}' }), 'example'), /THEME_MISSING_FILE/);
});

test('rejects personal appearance backups', async () => {
  const files = unzipSync(pack());
  files['appearance.json'] = encode('{}');
  await assert.rejects(validateThemeBytes(zipSync(files), 'example'), /Personal appearance/);
});

test('rejects mismatched IDs and metadata-provided package URLs', async (t) => {
  const { root, directory } = await fixture(t, { id: 'someone-else' });
  await assert.rejects(buildCatalog(root), /Directory name/);
  await writeFile(join(directory, '2fa-theme.zip'), pack());
  await writeFile(join(directory, 'theme.json'), JSON.stringify({ license: 'MIT', download: 'https://example.com/theme.zip' }));
  await assert.rejects(buildCatalog(root), /allows only/);
});

test('rejects missing licenses and invalid source credentials', async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(join(directory, 'theme.json'), JSON.stringify({ license: 'MIT', source: 'https://token@github.com/user/repo' }));
  await assert.rejects(buildCatalog(root), /HTTPS GitHub/);
  await writeFile(join(directory, 'theme.json'), JSON.stringify({ license: 'MIT' }));
  await writeFile(join(directory, 'LICENSE'), 'MIT');
  await assert.rejects(buildCatalog(root), /license text/);
});

test('accepts self-contained v1 themes with external license metadata', async (t) => {
  const { root, directory } = await fixture(t);
  const manifest = { themeApiVersion: 1, id: 'example', name: 'Example', version: '1.0.0', author: 'Test', description: 'V1', styles: 'theme.css' };
  await writeFile(join(directory, '2fa-theme.zip'), zipSync({ '2fa-theme.json': encode(JSON.stringify(manifest)), 'theme.css': encode('[data-part="account"] { border-radius: 4px; }') }));
  const result = await buildCatalog(root);
  assert.equal(result.themes[0].kind, 'v1');
});

test('rejects remote v1 resources rather than fetching author files', async (t) => {
  const { root, directory } = await fixture(t);
  const manifest = { themeApiVersion: 1, id: 'example', name: 'Example', version: '1.0.0', styles: 'theme.css' };
  await writeFile(join(directory, '2fa-theme.zip'), zipSync({ '2fa-theme.json': encode(JSON.stringify(manifest)), 'theme.css': encode('[data-part="account"] { background: url("https://example.com/picture.png"); }') }));
  await assert.rejects(buildCatalog(root), /self-contained|THEME_DOWNLOAD/);
});

test('builds an empty catalog when no theme has been accepted yet', async (t) => {
  const root = await mkdtemp(join(tmpdir(), '2fa-empty-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await buildCatalog(root), { schemaVersion: 1, themes: [] });
});

test('validates the production catalog with the same parser', async () => {
  const root = new URL('..', import.meta.url);
  const catalog = await checkCatalog(fileURLToPath(root));
  for (const item of catalog.themes) {
    const bytes = await readFile(new URL(item.path, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  }
});
