const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CI_CONFIG_PATHS = ['.github/workflows', '.github/actions'];
const WORKFLOW_FILE_PATTERN = /^\.github\/(?:workflows\/.*\.ya?ml|actions\/)/;
const CI_SUPPORT_SCRIPT_PATTERN = /^scripts\/(?:classify-ci-changes|validate-release-[^/]+|release-changelog-policy|pr-marker-comment|.*ci.*|.*workflow.*)\./;
const SCRIPT_PATH_PATTERN = /\b(?:node|tsx|playwright|tsc)\s+(?:--[^\s]+\s+)*(?<file>(?:scripts|tests|src)\/[^\s"'`]+)/g;
const SCRIPT_COMMAND_PATTERN = /\b(?<runner>node|tsx|playwright|tsc)\s+(?:--[^\s]+\s+)*(?<file>(?:scripts|tests|src)\/[^\s"'`]+)/g;
const NPM_RUN_PATTERN = /\bnpm\s+(?:run|run-script)(?:\s+--[^\s]+)*\s+([A-Za-z0-9:_-]+)/g;
const WORKFLOW_SUMMARY_MAX_CHARS = 4000;

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

function readRefFileIfPresent(ref, file, options = {}) {
  try {
    return readRefFile(ref, file, options);
  } catch {
    return '';
  }
}

function listChangedFiles(baseRef, headRef, options = {}) {
  return gitLines(['diff', '--name-only', `${baseRef}...${headRef}`], options);
}

function listChangedFileStatuses(baseRef, headRef, options = {}) {
  const output = git(['diff', '--name-status', `${baseRef}...${headRef}`], options);
  if (!output) return new Map();

  return new Map(output.split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split('\t');
    const status = parts[0][0];
    const file = normalizePath(parts[parts.length - 1]);
    return [file, status];
  }));
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectTopLevelSection(content, key) {
  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`);
  const start = lines.findIndex((line) => keyPattern.test(line));
  if (start === -1) return '';

  const section = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S[^:]*:\s*/.test(line) && line.trim() !== '') break;
    section.push(line);
  }

  return section.join('\n').trimEnd();
}

function collectWorkflowJobs(content) {
  const jobsSection = collectTopLevelSection(content, 'jobs');
  if (!jobsSection) return [];

  const jobs = [];
  let current = null;
  for (const line of jobsSection.split(/\r?\n/)) {
    const jobMatch = /^  (?<id>[A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      current = { id: jobMatch.groups.id, name: '', runsOn: '', condition: '' };
      jobs.push(current);
      continue;
    }

    if (!current) continue;
    const nameMatch = /^    name:\s*(?<value>.+?)\s*$/.exec(line);
    const runsOnMatch = /^    runs-on:\s*(?<value>.+?)\s*$/.exec(line);
    const conditionMatch = /^    if:\s*(?<value>.+?)\s*$/.exec(line);
    if (nameMatch) current.name = nameMatch.groups.value;
    if (runsOnMatch) current.runsOn = runsOnMatch.groups.value;
    if (conditionMatch) current.condition = conditionMatch.groups.value;
  }

  return jobs;
}

function collectCheckoutTargets(content) {
  const lines = content.split(/\r?\n/);
  const checkouts = [];

  for (let index = 0; index < lines.length; index += 1) {
    const checkoutMatch = /uses:\s*actions\/checkout@(?<version>[^\s]+)/.exec(lines[index]);
    if (!checkoutMatch) continue;

    const baseIndent = lines[index].match(/^\s*/)?.[0].length ?? 0;
    const checkout = {
      uses: `actions/checkout@${checkoutMatch.groups.version}`,
      ref: '',
      persistCredentials: '',
      fetchDepth: '',
    };

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') continue;
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= baseIndent && /^\s*-?\s*\w/.test(line)) break;

      const refMatch = /^\s*ref:\s*(?<value>.+?)\s*$/.exec(line);
      const persistMatch = /^\s*persist-credentials:\s*(?<value>.+?)\s*$/.exec(line);
      const fetchDepthMatch = /^\s*fetch-depth:\s*(?<value>.+?)\s*$/.exec(line);
      if (refMatch) checkout.ref = refMatch.groups.value;
      if (persistMatch) checkout.persistCredentials = persistMatch.groups.value;
      if (fetchDepthMatch) checkout.fetchDepth = fetchDepthMatch.groups.value;
    }

    checkouts.push(checkout);
  }

  return checkouts;
}

function collectWorkflowInvocations(content) {
  const invocations = new Set();

  for (const script of collectNpmRunScripts(content)) {
    invocations.add(`npm run ${script}`);
  }

  for (const match of content.matchAll(SCRIPT_COMMAND_PATTERN)) {
    invocations.add(`${match.groups.runner} ${normalizePath(match.groups.file).replace(/[),;]+$/, '')}`);
  }

  return [...invocations].sort();
}

function summarizeWorkflowBehavior(content) {
  if (!content) return null;
  return {
    triggers: collectTopLevelSection(content, 'on'),
    permissions: collectTopLevelSection(content, 'permissions'),
    concurrency: collectTopLevelSection(content, 'concurrency'),
    jobs: collectWorkflowJobs(content),
    checkoutTargets: collectCheckoutTargets(content),
    invocations: collectWorkflowInvocations(content),
  };
}

function workflowBehaviorCategories(summary) {
  if (!summary) return [];
  const categories = [];
  if (summary.triggers) categories.push('triggers');
  if (summary.permissions) categories.push('permissions');
  if (summary.concurrency) categories.push('concurrency');
  if (summary.jobs.length > 0) categories.push('jobs');
  if (summary.checkoutTargets.length > 0) categories.push('checkoutTargets');
  if (summary.invocations.length > 0) categories.push('invocations');
  return categories;
}

function changedWorkflowBehaviorCategories(before, after) {
  const categories = [...new Set([
    ...workflowBehaviorCategories(before),
    ...workflowBehaviorCategories(after),
  ])];

  return categories.filter((category) => {
    return JSON.stringify(before?.[category] ?? null) !== JSON.stringify(after?.[category] ?? null);
  });
}

function summarizeWorkflowFileChange({ baseRef, headRef, file, status, cwd }) {
  const beforeContent = status === 'A' ? '' : readRefFileIfPresent(baseRef, file, { cwd });
  const afterContent = status === 'D' ? '' : readRefFileIfPresent(headRef, file, { cwd });
  const before = summarizeWorkflowBehavior(beforeContent);
  const after = summarizeWorkflowBehavior(afterContent);

  return {
    file,
    status,
    before,
    after,
    changedCategories: status === 'A'
      ? workflowBehaviorCategories(after)
      : status === 'D'
        ? workflowBehaviorCategories(before)
        : changedWorkflowBehaviorCategories(before, after),
  };
}

function ciPolicyFiles(classification) {
  return [...new Set([
    ...classification.workflowFiles,
    ...classification.supportScripts,
  ])].sort();
}

function classifyCiChanges({ baseRef, headRef, changedFiles, cwd = process.cwd() }) {
  changedFiles ??= listChangedFiles(baseRef, headRef, { cwd });

  const normalizedFiles = changedFiles.map(normalizePath);
  const statusByFile = listChangedFileStatuses(baseRef, headRef, { cwd });
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
    workflowFileChanges: workflowFiles.map((file) => ({
      file,
      status: statusByFile.get(file) ?? 'M',
    })),
    workflowBehaviorChanges: workflowFiles.map((file) => summarizeWorkflowFileChange({
      baseRef,
      headRef,
      file,
      status: statusByFile.get(file) ?? 'M',
      cwd,
    })),
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

function truncateWorkflowSummary(text) {
  if (text.length <= WORKFLOW_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, WORKFLOW_SUMMARY_MAX_CHARS).trimEnd()}\n... summary truncated; open the PR files view for the full workflow content.`;
}

function workflowStatusLabel(status) {
  if (status === 'A') return 'added';
  if (status === 'D') return 'removed';
  if (status === 'R') return 'renamed';
  return 'modified';
}

function addYamlSection(lines, label, snippet) {
  if (!snippet) return;
  lines.push(`${label}:`, '', '```yaml');
  lines.push(truncateWorkflowSummary(snippet));
  lines.push('```', '');
}

function formatJobs(jobs) {
  if (!jobs || jobs.length === 0) return ['- none detected'];
  return jobs.map((job) => {
    const details = [
      job.name ? `name ${job.name}` : '',
      job.runsOn ? `runs-on ${job.runsOn}` : '',
      job.condition ? `if ${job.condition}` : '',
    ].filter(Boolean).join(', ');
    return details ? `- \`${job.id}\` (${details})` : `- \`${job.id}\``;
  });
}

function formatCheckoutTargets(checkoutTargets) {
  if (!checkoutTargets || checkoutTargets.length === 0) return ['- none detected'];
  return checkoutTargets.map((checkout) => {
    const details = [
      checkout.ref ? `ref \`${checkout.ref}\`` : '',
      checkout.persistCredentials ? `persist-credentials \`${checkout.persistCredentials}\`` : '',
      checkout.fetchDepth ? `fetch-depth \`${checkout.fetchDepth}\`` : '',
    ].filter(Boolean).join(', ');
    return details ? `- \`${checkout.uses}\` (${details})` : `- \`${checkout.uses}\``;
  });
}

function formatInvocations(invocations) {
  if (!invocations || invocations.length === 0) return ['- none detected'];
  return invocations.map((invocation) => `- \`${invocation}\``);
}

function addListComparison(lines, label, beforeLines, afterLines) {
  lines.push(`Before ${label}:`, '');
  lines.push(...beforeLines);
  lines.push('', `After ${label}:`, '');
  lines.push(...afterLines, '');
}

function addWorkflowSummary(lines, summary, categories) {
  const categorySet = new Set(categories);
  if (categorySet.has('triggers')) addYamlSection(lines, 'Triggers', summary?.triggers ?? '');
  if (categorySet.has('permissions')) addYamlSection(lines, 'Permissions', summary?.permissions ?? '');
  if (categorySet.has('concurrency')) addYamlSection(lines, 'Concurrency', summary?.concurrency ?? '');

  if (categorySet.has('jobs')) {
    lines.push('Jobs:', '');
    lines.push(...formatJobs(summary?.jobs), '');
  }

  if (categorySet.has('checkoutTargets')) {
    lines.push('Checkout targets:', '');
    lines.push(...formatCheckoutTargets(summary?.checkoutTargets), '');
  }

  if (categorySet.has('invocations')) {
    lines.push('CI entrypoints:', '');
    lines.push(...formatInvocations(summary?.invocations), '');
  }
}

function formatWorkflowBehaviorChange(change) {
  const lines = [`#### \`${change.file}\` (${workflowStatusLabel(change.status)})`, ''];
  const categories = change.changedCategories ?? [];

  if (categories.length === 0) {
    lines.push('No trigger, permission, checkout, job, concurrency, or CI entrypoint changes detected.', '');
    return lines;
  }

  if (change.status === 'A') {
    lines.push('New workflow behavior:', '');
    addWorkflowSummary(lines, change.after, categories);
    return lines;
  }

  if (change.status === 'D') {
    lines.push('Removed workflow behavior:', '');
    addWorkflowSummary(lines, change.before, categories);
    return lines;
  }

  lines.push(`Changed behavior categories: ${categories.map((category) => `\`${category}\``).join(', ')}`, '');
  for (const category of categories) {
    if (['triggers', 'permissions', 'concurrency'].includes(category)) {
      addYamlSection(lines, `Before ${category}`, change.before?.[category] ?? '');
      addYamlSection(lines, `After ${category}`, change.after?.[category] ?? '');
    } else if (category === 'jobs') {
      addListComparison(lines, 'jobs', formatJobs(change.before?.jobs), formatJobs(change.after?.jobs));
    } else if (category === 'checkoutTargets') {
      addListComparison(lines, 'checkout targets', formatCheckoutTargets(change.before?.checkoutTargets), formatCheckoutTargets(change.after?.checkoutTargets));
    } else if (category === 'invocations') {
      addListComparison(lines, 'CI entrypoints', formatInvocations(change.before?.invocations), formatInvocations(change.after?.invocations));
    }
  }

  return lines;
}

function formatMarkdown(classification) {
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

    if ((classification.workflowBehaviorChanges ?? []).length > 0) {
      lines.push('## Workflow behavior summary', '');
      for (const change of classification.workflowBehaviorChanges) {
        lines.push(...formatWorkflowBehaviorChange(change));
      }
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
    const markdown = changed ? formatMarkdown(classification) : '';

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
  summarizeWorkflowBehavior,
  collectWorkflowCalledScripts,
  collectNpmScriptClosure,
  collectExecutedScriptFiles,
  formatMarkdown,
  hasCiChanges,
};
