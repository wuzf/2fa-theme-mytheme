import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { zipSync } from 'fflate';
import { assertSubmissionScope, buildCatalog, checkCatalog, serializeCatalog } from '../scripts/catalog.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/catalog.mjs', import.meta.url));
const license = 'MIT License\nCopyright (c) 2026 Test Author\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software to use, copy, modify and distribute it.';
const trustedFiles = {
  '.github/workflows/validate.yml': 'name: Validate catalog\non: [pull_request_target]\n',
  '.github/CODEOWNERS': '* @maintainer\n',
  '.gitignore': 'node_modules/\nignored-script.js\n',
  'scripts/catalog.mjs': 'throw new Error("CANDIDATE_VALIDATOR_MUST_NOT_EXECUTE");\n',
  'vendor/parser.mjs': 'throw new Error("CANDIDATE_VENDOR_MUST_NOT_EXECUTE");\n',
  'tests/untrusted.test.mjs': 'throw new Error("CANDIDATE_TEST_MUST_NOT_EXECUTE");\n',
  'package.json': JSON.stringify({ scripts: { test: 'throw-CANDIDATE_PACKAGE_MUST_NOT_EXECUTE' } }),
  'package-lock.json': '{"lockfileVersion":3}\n',
  'README.md': 'Trusted instructions\n',
};

async function write(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}

async function theme(root, { id = 'example', version = '1.0.0', color = 'red' } = {}) {
  const manifest = { themeApiVersion: 1, id, name: 'Example', version, styles: 'theme.css' };
  const bytes = zipSync({
    '2fa-theme.json': new TextEncoder().encode(JSON.stringify(manifest)),
    'theme.css': new TextEncoder().encode(`[data-part="account"] { color: ${color}; }`),
  });
  await write(root, `themes/${id}/2fa-theme.zip`, bytes);
  await write(root, `themes/${id}/theme.json`, '{"license":"MIT"}\n');
  await write(root, `themes/${id}/LICENSE`, license);
  await write(root, 'catalog.json', serializeCatalog(await buildCatalog(root)));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), '2fa-trusted-submission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trusted = join(root, 'trusted');
  const candidate = join(root, 'candidate');
  for (const directory of [trusted, candidate]) {
    await mkdir(directory, { recursive: true });
    for (const [path, value] of Object.entries(trustedFiles)) await write(directory, path, value);
    await mkdir(join(directory, '.git'), { recursive: true });
    await theme(directory);
  }
  // CI installs only trusted dependencies. They must not become protected source input.
  await write(trusted, 'node_modules/installed-package/index.js', 'TRUSTED_DEPENDENCY');
  return { root, trusted, candidate };
}

test('accepts normal theme updates and new themes with a changed catalog, without executing candidate tooling', async (t) => {
  const { trusted, candidate } = await fixture(t);
  await theme(candidate, { version: '1.1.0', color: 'blue' });
  await theme(candidate, { id: 'another-theme' });
  const catalog = await checkCatalog(candidate, { trustedRoot: trusted });
  assert.equal(catalog.themes.length, 2);
  assert.equal(catalog.themes.find((item) => item.id === 'example').version, '1.1.0');
});

test('rejects a candidate workflow that replaces validation with arbitrary contributor execution', async (t) => {
  const { trusted, candidate } = await fixture(t);
  await write(candidate, '.github/workflows/validate.yml', 'name: Validate catalog\non: [pull_request]\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node -e "console.log(\'CONTRIBUTOR_EXECUTED\')"\n');
  await assert.rejects(checkCatalog(candidate, { trustedRoot: trusted }), /Submission scope forbids modifying \.github\/workflows\/validate.yml/);
});

for (const file of ['scripts/catalog.mjs', 'vendor/parser.mjs', 'tests/untrusted.test.mjs', 'package.json', 'package-lock.json', '.github/CODEOWNERS']) {
  test(`rejects malicious modifications of ${file}`, async (t) => {
    const { trusted, candidate } = await fixture(t);
    await write(candidate, file, file === 'package.json' ? '{"scripts":{"postinstall":"node attack.js","test":"exit 0"}}' : 'process.exit(0); // forged validation\n');
    await assert.rejects(checkCatalog(candidate, { trustedRoot: trusted }), /Submission scope forbids modifying/);
  });
}

test('rejects added workflows and files hidden by the candidate ignore rules', async (t) => {
  const { trusted, candidate } = await fixture(t);
  await write(candidate, 'ignored-script.js', 'throw new Error("CANDIDATE_EXECUTED");');
  await assert.rejects(checkCatalog(candidate, { trustedRoot: trusted }), /Submission scope forbids adding ignored-script.js/);
  await rm(join(candidate, 'ignored-script.js'));
  await write(candidate, '.github/workflows/another.yml', 'on: pull_request\njobs: {}');
  await assert.rejects(checkCatalog(candidate, { trustedRoot: trusted }), /Submission scope forbids adding \.github\/workflows\/another.yml/);
});

test('rejects deleted protected files', async (t) => {
  const { trusted, candidate } = await fixture(t);
  await rm(join(candidate, 'scripts/catalog.mjs'));
  await assert.rejects(checkCatalog(candidate, { trustedRoot: trusted }), /Submission scope forbids deleting scripts\/catalog.mjs/);
});

test('rejects candidate node_modules even when .gitignore excludes it', async (t) => {
  const { trusted, candidate } = await fixture(t);
  await write(candidate, 'node_modules/trap/index.js', 'process.exit(0)');
  await assert.rejects(checkCatalog(candidate, { trustedRoot: trusted }), /forbids candidate node_modules/);
});

test('rejects directory links instead of following them into the trusted checkout', async (t) => {
  const { trusted, candidate } = await fixture(t);
  await rm(join(candidate, 'scripts'), { recursive: true });
  await symlink(join(trusted, 'scripts'), join(candidate, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(checkCatalog(candidate, { trustedRoot: trusted }), /Submission scope rejects links/);
});

test('does not permit the candidate to declare itself the trusted checkout', async (t) => {
  const { candidate } = await fixture(t);
  await assert.rejects(assertSubmissionScope(candidate, candidate), /separate trusted checkout/);
});

test('rejects executable mode changes on platforms that preserve them', { skip: process.platform === 'win32' }, async (t) => {
  const { trusted, candidate } = await fixture(t);
  await chmod(join(trusted, 'scripts/catalog.mjs'), 0o644);
  await chmod(join(candidate, 'scripts/catalog.mjs'), 0o755);
  await assert.rejects(checkCatalog(candidate, { trustedRoot: trusted }), /executable mode/);
});

test('CLI enforces --trusted-root for PRs and keeps local --check usable', async (t) => {
  const { trusted, candidate } = await fixture(t);
  const valid = await exec(process.execPath, [cli, '--root', candidate, '--trusted-root', trusted, '--check']);
  assert.match(valid.stdout, /Validated 1/);
  await write(candidate, 'package.json', '{"scripts":{"test":"exit 0"}}');
  await assert.rejects(exec(process.execPath, [cli, '--root', candidate, '--trusted-root', trusted, '--check']), /Submission scope forbids modifying package.json/);
  const local = await exec(process.execPath, [cli, '--root', candidate, '--check']);
  assert.match(local.stdout, /Validated 1/);
});

test('production workflow runs PR checks from the target context with read-only permission and an explicit trusted checkout', async () => {
  const workflow = await readFile(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /^\s+pull_request:/m);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /--root candidate --trusted-root validator --check/);
  assert.doesNotMatch(workflow, /secrets\.|working-directory: candidate|run:.*(?:candidate\/.*\.(?:m?js|sh)|npm.*--prefix candidate)/);
});
