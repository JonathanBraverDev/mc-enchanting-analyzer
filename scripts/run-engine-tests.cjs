#!/usr/bin/env node
const { readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const testRoots = [
  'tests/unit',
  'tests/infra',
  'tests/integration',
  'tests/diagnostics',
];

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(relative(root, fullPath));
    }
  }

  return files;
}

const testFiles = testRoots
  .filter(path => statSync(path, { throwIfNoEntry: false })?.isDirectory())
  .flatMap(walk)
  .sort();

if (testFiles.length === 0) {
  console.error('No engine test files found.');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  console.log(`Discovered ${testFiles.length} engine test files:`);
  for (const file of testFiles) console.log(`- ${file}`);
  process.exit(0);
}

const tsxBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const result = spawnSync(tsxBin, ['--test', '--test-concurrency=1', ...testFiles], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
