import { readFile, readdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { normalizeDetectedThemeImport } from '../vendor/2fa/themes/import.js';
import { readArchiveManifest } from '../vendor/2fa/themes/archive.js';
import { unpackAppTheme } from '../vendor/2fa/themes/appArchive.js';
import { unpackTheme } from '../vendor/2fa/themes/archive.js';
import { ImportBudget } from '../vendor/2fa/themes/resources.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const UPLOAD_LIMIT = 12 * 1024 * 1024;
const CATALOG_LIMIT = 1024 * 1024;
const METADATA_LIMIT = 16 * 1024;
const MAX_THEMES = 500;
const LFS_HEADER = 'version https://git-lfs.github.com/spec/v1';
const THEME_FILES = new Set(['2fa-theme.zip', 'theme.json', 'LICENSE']);

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max, field, optional = false) {
  requireThat(typeof value === 'string' && (optional || value.trim().length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), `Invalid ${field}`);
  return value;
}

async function safeFile(root, name, limit) {
  const file = resolve(root, name);
  const stat = await lstat(file);
  requireThat(stat.isFile() && !stat.isSymbolicLink(), `${name}: only regular files are accepted`);
  requireThat(stat.size > 0 && stat.size <= limit, `${name}: size exceeds ${limit} bytes or is empty`);
  const canonical = await realpath(file);
  const location = relative(root, canonical);
  requireThat(location !== '..' && !location.startsWith('..' + sep) && !location.startsWith(sep), `${name}: file escapes the repository`);
  const bytes = await readFile(file);
  requireThat(!bytes.subarray(0, 80).toString('utf8').startsWith(LFS_HEADER), `${name}: Git LFS pointers are not distributable theme files`);
  return bytes;
}

async function safeDirectory(root, name) {
  const file = resolve(root, name);
  const stat = await lstat(file);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink(), `${name}: linked directories and submodules are not accepted`);
  const location = relative(root, await realpath(file));
  requireThat(location !== '..' && !location.startsWith('..' + sep), `${name}: directory escapes the repository`);
  return file;
}

function metadata(input) {
  requireThat(plain(input) && Object.keys(input).every((key) => ['license', 'source'].includes(key)), 'theme.json allows only license and optional source');
  text(input.license, 120, 'license');
  requireThat(/^[A-Za-z0-9().+ -]+$/.test(input.license), 'license must be an SPDX identifier or expression');
  if (input.source !== undefined) {
    text(input.source, 300, 'source');
    requireThat(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.source), 'source must be an HTTPS GitHub repository URL');
  }
  return input;
}

export async function validateThemeBytes(bytes, id) {
  requireThat(bytes.length > 0 && bytes.length <= UPLOAD_LIMIT, 'Theme ZIP exceeds 12 MiB');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readArchiveManifest(bytes, { maxEntries: 256, manifestBytes: 128 * 1024 })));
  const app = manifest.themeApiVersion === 2 || manifest.kind === 'app';
  const archive = app ? unpackAppTheme(bytes) : unpackTheme(bytes, new ImportBudget());
  requireThat(!archive.has('appearance.json') && ![...archive.keys()].some((name) => name.startsWith('appearance-assets/')), 'Personal appearance backups cannot be published as themes');
  if (app) requireThat([...archive.keys()].some((name) => /^licenses\/[A-Za-z0-9_.-]+\.txt$/.test(name) && archive.get(name).length > 0), 'App package must contain redistribution licenses under licenses/*.txt');
  const pkg = await normalizeDetectedThemeImport({ bytes: new Uint8Array(bytes), name: '2fa-theme.zip' }, {
    fetcher: async () => { throw new Error('Catalog packages must be self-contained; remote resources are forbidden'); },
  });
  requireThat(!pkg.appearance, 'Personal appearance backups cannot be published as themes');
  requireThat(pkg.manifest.id === id, 'Directory name must equal manifest.id');
  return pkg;
}

/** Reads submitted files as data. Never imports theme JS, runs a build, or follows source URLs. */
export async function buildCatalog(repository) {
  const root = await realpath(resolve(repository));
  try {
    await lstat(resolve(root, '.gitmodules'));
    throw new Error('Git submodules are not accepted');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Git keeps no empty folders: a catalog without accepted themes has no themes/.
  let directories = [];
  try {
    directories = (await readdir(await safeDirectory(root, 'themes'))).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  requireThat(directories.length <= MAX_THEMES, `At most ${MAX_THEMES} themes can be indexed`);
  const seen = new Set();
  const themes = [];
  for (const id of directories) {
    requireThat(ID.test(id) && !id.startsWith('builtin-') && !RESERVED.has(id), `Invalid theme id: ${id}`);
    requireThat(!seen.has(id.toLowerCase()), `Duplicate theme id ignoring case: ${id}`);
    seen.add(id.toLowerCase());
    const directory = await safeDirectory(root, `themes/${id}`);
    const children = await readdir(directory);
    requireThat(children.length === THEME_FILES.size && children.every((name) => THEME_FILES.has(name)), `${id}: keep exactly 2fa-theme.zip, theme.json and LICENSE; historical packages and external links are not accepted`);
    const meta = metadata(JSON.parse((await safeFile(root, `themes/${id}/theme.json`, METADATA_LIMIT)).toString('utf8')));
    const license = (await safeFile(root, `themes/${id}/LICENSE`, 128 * 1024)).toString('utf8');
    requireThat(license.trim().length >= 80, `${id}: include the actual redistribution license text`);
    const bytes = await safeFile(root, `themes/${id}/2fa-theme.zip`, UPLOAD_LIMIT);
    const pkg = await validateThemeBytes(bytes, id);
    const info = pkg.manifest;
    themes.push({
      id,
      kind: pkg.kind === 'app' ? 'app' : 'v1',
      name: text(info.name, 120, 'name'),
      version: text(info.version, 100, 'version'),
      description: text(info.description || '', 1000, 'description', true),
      author: text(info.author || '', 120, 'author', true),
      packageId: pkg.packageId,
      path: `themes/${id}/2fa-theme.zip`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      ...(meta.source ? { source: meta.source } : {}),
    });
  }
  const result = { schemaVersion: 1, themes };
  requireThat(Buffer.byteLength(serializeCatalog(result)) <= CATALOG_LIMIT, 'catalog.json exceeds 1 MiB');
  return result;
}

export function serializeCatalog(catalog) {
  return JSON.stringify(catalog, null, 2) + '\n';
}

/** Compare checkout bytes without consulting candidate .gitignore, Git hooks or executable code. */
export async function assertSubmissionScope(repository, trustedRepository) {
  const candidate = await realpath(resolve(repository));
  const trusted = await realpath(resolve(trustedRepository));
  requireThat(candidate !== trusted, 'A submission requires a separate trusted checkout');
  async function inventory(root, isTrusted) {
    const protectedPaths = new Map();
    async function walk(directory, prefix = '') {
      for (const name of (await readdir(directory)).sort()) {
        const path = prefix + name;
        // Dependencies installed in the trusted checkout are tooling, never PR input.
        if (isTrusted && path === 'node_modules') continue;
        requireThat(path !== 'node_modules', 'Submission scope forbids candidate node_modules, including ignored files');
        const fullPath = resolve(directory, name);
        const info = await lstat(fullPath);
        requireThat(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()), `Submission scope rejects links and special files: ${path}`);
        // Only root checkout metadata is ignored; nested .git entries are ordinary input.
        if (path === '.git') continue;
        const allowed = path === 'catalog.json' || path === 'themes' || path.startsWith('themes/');
        if (!allowed) protectedPaths.set(path, { fullPath, directory: info.isDirectory(), executable: Boolean(info.mode & 0o111), size: info.size });
        if (info.isDirectory()) await walk(fullPath, path + '/');
      }
    }
    await walk(root);
    return protectedPaths;
  }
  const baseline = await inventory(trusted, true);
  const submitted = await inventory(candidate, false);
  for (const [path, actual] of submitted) {
    const expected = baseline.get(path);
    requireThat(expected, `Submission scope forbids adding ${path}; only themes/** and catalog.json may change`);
    requireThat(actual.directory === expected.directory, `Submission scope forbids changing the type of ${path}`);
    if (!actual.directory) {
      requireThat(actual.executable === expected.executable, `Submission scope forbids changing executable mode: ${path}`);
      requireThat(actual.size === expected.size, `Submission scope forbids modifying ${path}; use the trusted maintainer workflow`);
      requireThat((await readFile(actual.fullPath)).equals(await readFile(expected.fullPath)), `Submission scope forbids modifying ${path}; use the trusted maintainer workflow`);
    }
  }
  for (const path of baseline.keys()) requireThat(submitted.has(path), `Submission scope forbids deleting ${path}; only themes/** and catalog.json may change`);
}

export async function checkCatalog(root, { trustedRoot } = {}) {
  const canonical = await realpath(resolve(root));
  if (trustedRoot) await assertSubmissionScope(canonical, trustedRoot);
  const expected = serializeCatalog(await buildCatalog(canonical));
  const actual = (await safeFile(canonical, 'catalog.json', CATALOG_LIMIT)).toString('utf8');
  requireThat(actual === expected, 'catalog.json is stale or edited by hand; run npm run catalog');
  return JSON.parse(expected);
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  const usage = 'Usage: node scripts/catalog.mjs [--root directory] [--trusted-root directory] --check|--write';
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    requireThat(['--root', '--trusted-root', '--check', '--write'].includes(option) && !Object.hasOwn(options, option), usage);
    if (option === '--root' || option === '--trusted-root') {
      const value = args[++index];
      requireThat(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), usage);
      options[option] = value;
    } else options[option] = true;
  }
  requireThat(Boolean(options['--check']) !== Boolean(options['--write']), 'Choose exactly one of --check or --write');
  requireThat(!options['--trusted-root'] || options['--check'], '--trusted-root is only valid with --check');
  const root = options['--root'] || fileURLToPath(new URL('..', import.meta.url));
  const catalog = options['--write'] ? await buildCatalog(root) : await checkCatalog(root, { trustedRoot: options['--trusted-root'] });
  if (options['--write']) await writeFile(resolve(root, 'catalog.json'), serializeCatalog(catalog));
  console.log(`Validated ${catalog.themes.length} self-contained themes (${catalog.themes.reduce((sum, theme) => sum + theme.size, 0)} ZIP bytes).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
