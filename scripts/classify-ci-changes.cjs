const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CI_CONFIG_PATHS = ['.github/workflows', '.github/actions'];
const WORKFLOW_FILE_PATTERN = /^\.github\/(?:workflows\/.*\.ya?ml|actions\/)/;
const CI_SUPPORT_SCRIPT_PATTERN = /^scripts\/(?:classify-ci-changes|validate-release-[^/]+|release-changelog-policy|pr-marker-comment|.*ci.*|.*workflow.*)\./;
const SCRIPT_PATH_PATTERN = /\b(?:node|tsx|playwright|tsc)\s+(?:--[^\s]+\s+)*(?<file>(?:scripts|tests|src)\/[^\s"'`]+)/g;
const NPM_RUN_PATTERN = /\bnpm\s+(?:run|run-script)(?:\s+--[^\s]+)*\s+([A-Za-z0-9:_-]+)/g;
const CRITICAL_WORKFLOW_DIFF_PATTERN = /^[+-](?:\s*(?:on:|pull_request:|pull_request_target:|push:|workflow_dispatch:|workflow_call:|schedule:|branches:|branches-ignore:|paths:|paths-ignore:|types:|permissions:|if:|concurrency:|runs-on:|ref:|token:|secrets:)|\s{2}[A-Za-z0-9_-]+:|\s{4}name:)$/;
const CHECKOUT_TARGET_DIFF_PATTERN = /^[+-]\s*(?:uses:\s+actions\/checkout@|ref:)/;
const CRITICAL_DIFF_MAX_LINES = 80;
const CRITICAL_DIFF_MAX_CHARS = 8000;

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

function normalizePath(file) {
  return file.replace(/\\/g, '/');
}

function gitLines(args, options = {}) {
  const output = git(args, options);
  return output ? output.split(/\r?\n/).filter(Boolean).map(normalizePath) : [];
}

function readRefJson(ref, file, options = {}) {
  return JSON.parse(git(['show', `${ref}:${file}`], options));
}

function readRefFile(ref, file, options = {}) {
  return git(['show', `${ref}:${file}`], options);
}

function listChangedFiles(baseRef, headRef, options = {}) {
  return gitLines(['diff', '--name-only', `${baseRef}...${headRef}`], options);
}

function listCiConfigFiles(ref, options = {}) {
  return gitLines(['ls-tree', '-r', '--name-only', ref, '--', ...CI_CONFIG_PATHS], options);
}

function collectNpmRunScripts(command) {
  const scripts = new Set();

  for (const match of command.matchAll(NPM_RUN_PATTERN)) {
    scripts.add(match[1]);
  }

  return scripts;
}

function collectWorkflowCalledScripts(ref, options = {}) {
  const scripts = new Set();

  for (const file of listCiConfigFiles(ref, options)) {
    const content = readRefFile(ref, file, options);
    for (const script of collectNpmRunScripts(content)) {
      scripts.add(script);
    }
  }

  return scripts;
}

function collectNpmScriptClosure(scripts, roots) {
  const closure = new Set();
  const queue = [...roots].filter((script) => scripts[script]);

  while (queue.length > 0) {
    const scriptName = queue.shift();
    if (closure.has(scriptName)) continue;
    closure.add(scriptName);

    const command = scripts[scriptName] ?? '';
    for (const child of collectNpmRunScripts(command)) {
      if (scripts[child] && !closure.has(child)) {
        queue.push(child);
      }
    }
  }

  return closure;
}

function collectExecutedScriptFiles(scripts, scriptNames) {
  const files = new Set();

  for (const scriptName of scriptNames) {
    const command = scripts[scriptName] ?? '';
    for (const match of command.matchAll(SCRIPT_PATH_PATTERN)) {
      const file = match.groups?.file;
      if (file) {
        files.add(normalizePath(file).replace(/[),;]+$/, ''));
      }
    }
  }

  return files;
}

function ciPolicyFiles(classification) {
  return [...new Set([
    ...classification.workflowFiles,
    ...classification.supportScripts,
  ])].sort();
}

function truncateCriticalDiff(diff) {
  const lines = diff.split(/\r?\n/);
  let truncated = false;
  let selected = lines;

  if (selected.length > CRITICAL_DIFF_MAX_LINES) {
    selected = selected.slice(0, CRITICAL_DIFF_MAX_LINES);
    truncated = true;
  }

  let text = selected.join('\n');
  if (text.length > CRITICAL_DIFF_MAX_CHARS) {
    text = text.slice(0, CRITICAL_DIFF_MAX_CHARS);
    truncated = true;
  }

  return truncated
    ? `${text.trimEnd()}\n... critical diff truncated; open the PR files view for the full workflow diff.`
    : text.trimEnd();
}

function collectCriticalWorkflowDiff({ baseRef, headRef, classification, cwd = process.cwd() }) {
  const files = classification.workflowFiles;
  if (files.length === 0) return '';

  const diff = git(['diff', '--unified=0', `${baseRef}...${headRef}`, '--', ...files], { cwd });
  const criticalLines = diff
    .split(/\r?\n/)
    .filter((line) => {
      return !/^(?:---|\+\+\+)/.test(line)
        && (CRITICAL_WORKFLOW_DIFF_PATTERN.test(line) || CHECKOUT_TARGET_DIFF_PATTERN.test(line));
    });

  return criticalLines.length > 0
    ? truncateCriticalDiff([...new Set(criticalLines)].sort().join('\n'))
    : '';
}

function classifyCiChanges({ baseRef, headRef, changedFiles, cwd = process.cwd() }) {
  changedFiles ??= listChangedFiles(baseRef, headRef, { cwd });

  const normalizedFiles = changedFiles.map(normalizePath);
  const workflowFiles = normalizedFiles.filter((file) => WORKFLOW_FILE_PATTERN.test(file));
  const supportScripts = normalizedFiles.filter((file) => CI_SUPPORT_SCRIPT_PATTERN.test(file));
  const baseScripts = readRefJson(baseRef, 'package.json', { cwd }).scripts ?? {};
  const headScripts = readRefJson(headRef, 'package.json', { cwd }).scripts ?? {};
  const baseWorkflowScripts = collectWorkflowCalledScripts(baseRef, { cwd });
  const headWorkflowScripts = collectWorkflowCalledScripts(headRef, { cwd });
  const baseClosure = collectNpmScriptClosure(baseScripts, baseWorkflowScripts);
  const headClosure = collectNpmScriptClosure(headScripts, headWorkflowScripts);
  const ciScripts = new Set([...baseClosure, ...headClosure]);
  const executedFiles = new Set([
    ...collectExecutedScriptFiles(baseScripts, baseClosure),
    ...collectExecutedScriptFiles(headScripts, headClosure),
  ]);
  const result = {
    workflowFiles,
    supportScripts,
    packageScripts: [],
    executedScriptFiles: normalizedFiles
      .filter((file) => executedFiles.has(file))
      .sort(),
  };

  if (normalizedFiles.includes('package.json')) {
    result.packageScripts = [...ciScripts]
      .filter((script) => (baseScripts[script] ?? null) !== (headScripts[script] ?? null))
      .sort()
      .map((script) => ({
        name: script,
        before: baseScripts[script] ?? null,
        after: headScripts[script] ?? null,
      }));
  }

  return result;
}

function hasCiChanges(classification) {
  return classification.workflowFiles.length > 0
    || classification.supportScripts.length > 0
    || classification.packageScripts.length > 0
    || classification.executedScriptFiles.length > 0;
}

function formatMarkdown(classification, { criticalWorkflowDiff = '' } = {}) {
  const lines = [
    'CI-affecting behavior changed. Review the affected areas before merging.',
    '',
  ];
  const policyFiles = ciPolicyFiles(classification);
  const hasExecutedChanges = classification.packageScripts.length > 0
    || classification.executedScriptFiles.length > 0;

  if (policyFiles.length > 0) {
    lines.push('## CI policy changes', '');
    lines.push('These files define or classify CI behavior. Review the listed files in the PR diff.', '');
    lines.push('Changed policy files:', '');
    for (const file of policyFiles) lines.push(`- \`${file}\``);
    lines.push('');
    if (criticalWorkflowDiff) {
      lines.push('Critical workflow diff lines:', '', '```diff');
      lines.push(criticalWorkflowDiff);
      lines.push('```', '');
    }
  }

  if (hasExecutedChanges) {
    lines.push('## CI-executed behavior changes', '');
    lines.push('These changes affect code or package scripts that CI runs. Review the listed files/scripts in the PR diff.', '');
  }

  if (classification.packageScripts.length > 0) {
    lines.push('Workflow-called package scripts changed:', '');
    for (const script of classification.packageScripts) {
      lines.push(`- \`${script.name}\``);
      lines.push(`  - before: \`${script.before ?? '(missing)'}\``);
      lines.push(`  - after: \`${script.after ?? '(missing)'}\``);
    }
    lines.push('');
  }

  if (classification.executedScriptFiles.length > 0) {
    lines.push('Script files executed by workflow-called package scripts changed:', '');
    for (const file of classification.executedScriptFiles) lines.push(`- \`${file}\``);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function parseCliArgs(argv) {
  const args = [...argv];
  const baseRef = args.shift();
  const headRef = args.shift();
  const options = {};

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--body-file') {
      options.bodyFile = args.shift();
    } else if (arg === '--json-file') {
      options.jsonFile = args.shift();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!baseRef || !headRef) {
    throw new Error('Usage: node scripts/classify-ci-changes.cjs <base-ref> <head-ref> [--body-file path] [--json-file path]');
  }

  return { baseRef, headRef, options };
}

function writeFileIfRequested(file, content) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

if (require.main === module) {
  try {
    const { baseRef, headRef, options } = parseCliArgs(process.argv.slice(2));
    const classification = classifyCiChanges({ baseRef, headRef });
    const changed = hasCiChanges(classification);
    const criticalWorkflowDiff = changed ? collectCriticalWorkflowDiff({ baseRef, headRef, classification }) : '';
    const markdown = changed ? formatMarkdown(classification, { criticalWorkflowDiff }) : '';

    writeFileIfRequested(options.jsonFile, `${JSON.stringify(classification, null, 2)}\n`);
    writeFileIfRequested(options.bodyFile, markdown);

    if (changed) {
      console.log(markdown);
    } else {
      console.log('No CI-affecting behavior changes detected.');
    }

    process.exit(changed ? 1 : 0);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

module.exports = {
  classifyCiChanges,
  ciPolicyFiles,
  collectCriticalWorkflowDiff,
  collectWorkflowCalledScripts,
  collectNpmScriptClosure,
  collectExecutedScriptFiles,
  formatMarkdown,
  hasCiChanges,
};
