import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = path.join(rootDir, 'dist');
const resourceDir = path.join(rootDir, 'resource');
const tscPath = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

function patchBinShebangs() {
  const binDir = path.join(distDir, 'bin');
  if (!fs.existsSync(binDir)) return;
  for (const file of walkFiles(binDir)) {
    if (!file.endsWith('.js')) continue;
    const content = fs.readFileSync(file, 'utf-8');
    const patched = content.replace(/^#!\/usr\/bin\/env ts-node/, '#!/usr/bin/env node');
    if (patched !== content) fs.writeFileSync(file, patched, 'utf-8');
  }
}

fs.rmSync(distDir, { recursive: true, force: true });
run(process.execPath, [ tscPath ]);
fs.cpSync(resourceDir, path.join(distDir, 'resource'), { recursive: true });
fs.rmSync(path.join(distDir, 'test'), { recursive: true, force: true });
patchBinShebangs();
