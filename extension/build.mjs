import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { applyManifestVersion, resolveVersion } from './build-version.mjs';

const extension = resolve(fileURLToPath(new URL('.', import.meta.url)));
const source = resolve(extension, 'src');
const distRoot = resolve(extension, 'dist');

function gitTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: extension, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const version = resolveVersion({ env: process.env, tag: gitTag() });

async function copyFile(from, to) {
  await writeFile(to, await readFile(from));
}

async function copyContentEngine(out) {
  const files = [
    'content/refs.js',
    'content/semantics.js',
    'content/snapshot.js',
    'content/pointer.js',
    'content/files.js',
    'content/network.js',
    'content/engine.js'
  ];
  const chunks = [];
  for (const file of files) {
    let sourceText = await readFile(resolve(source, file), 'utf8');
    sourceText = sourceText
      .replace(/^import.*;\s*$/gm, '')
      .replace(/^export /gm, '');
    chunks.push(sourceText);
  }
  await writeFile(resolve(out, 'src/content/engine.js'), chunks.join('\n'));
}

async function build(target) {
  const out = resolve(distRoot, target);
  await rm(out, { recursive: true, force: true });
  await mkdir(resolve(out, 'src/content'), { recursive: true });
  await mkdir(resolve(out, 'adapters'), { recursive: true });
  await copyFile(resolve(source, 'background.js'), resolve(out, 'background.js'));
  await copyFile(resolve(source, 'router.js'), resolve(out, 'router.js'));
  await copyFile(resolve(source, 'session.js'), resolve(out, 'session.js'));
  await copyFile(resolve(source, 'network-monitor.js'), resolve(out, 'network-monitor.js'));
  await copyFile(resolve(source, 'screenshot.js'), resolve(out, 'screenshot.js'));
  await copyFile(resolve(source, 'evaluate.js'), resolve(out, 'evaluate.js'));
  await copyFile(resolve(source, 'adapters/compatibility.js'), resolve(out, 'adapters/compatibility.js'));
  await copyFile(resolve(source, 'adapters/runtime.js'), resolve(out, 'adapters/runtime.js'));
  await copyFile(resolve(source, `${target === 'firefox' ? 'adapters/firefox.js' : 'adapters/chromium.js'}`), resolve(out, `adapters/${target}.js`));
  await copyContentEngine(out);
  await copyFile(resolve(source, 'status.js'), resolve(out, 'status.js'));
  await copyFile(resolve(extension, 'status.html'), resolve(out, 'status.html'));
  await mkdir(resolve(out, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await copyFile(resolve(extension, `assets/icons/icon-${size}.png`), resolve(out, `icons/icon-${size}.png`));
  }
  const manifest = JSON.parse(await readFile(resolve(extension, `manifest.${target}.json`), 'utf8'));
  await writeFile(resolve(out, 'manifest.json'), `${JSON.stringify(applyManifestVersion(manifest, version), null, 2)}\n`);
}

await build('chromium');
await build('firefox');
await writeFile(resolve(distRoot, '.built'), `${new Date().toISOString()}\n`);
console.log(`Built extension targets in ${distRoot} (version ${version})`);
