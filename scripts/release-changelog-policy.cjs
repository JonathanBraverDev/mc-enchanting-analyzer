const ALLOWED_CHANGELOG_SECTIONS = new Set([
  'Added',
  'Improved',
  'Changed',
  'Fixed',
  'Security',
  'Performance',
  'Developer Experience',
  'Documentation',
  'Cleanup',
  'Deprecated',
  'Removed',
  'Breaking',
]);

const MINOR_SECTIONS = ['Added', 'Improved', 'Changed', 'Developer Experience', 'Deprecated'];
const PATCH_SECTIONS = ['Fixed', 'Security', 'Performance', 'Developer Experience', 'Documentation', 'Cleanup'];
const PATCH_MINOR_SIGNAL_SECTIONS = ['Added', 'Improved', 'Changed', 'Deprecated', 'Removed'];

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function releaseBump(latestTag, proposedTag) {
  const latest = parseVersion(latestTag);
  const proposed = parseVersion(proposedTag);

  if (!latest || !proposed || latestTag === proposedTag) {
    return 'unknown';
  }

  if (proposed.major > latest.major) {
    return 'major';
  }

  if (proposed.major === latest.major && proposed.minor > latest.minor) {
    return 'minor';
  }

  return 'patch';
}

function changelogHeaderPattern(tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+(?:\\[${escapedTag}\\]|${escapedTag})(?:\\s*\\([^\\n]*\\))?\\s*$`, 'm');
}

function extractChangelogEntry(changelog, tag) {
  const headerPattern = changelogHeaderPattern(tag);
  const headerMatch = headerPattern.exec(changelog);

  if (!headerMatch) {
    return null;
  }

  const entryStart = headerMatch.index;
  const afterHeader = entryStart + headerMatch[0].length;
  const nextHeaderOffset = changelog.slice(afterHeader).search(/^##\s+/m);
  const entryEnd = nextHeaderOffset === -1 ? changelog.length : afterHeader + nextHeaderOffset;
  return changelog.slice(entryStart, entryEnd).trim();
}

function extractChangelogSections(entry) {
  return Array.from(entry.matchAll(/^###\s+(.+)\s*$/gm), (match) => match[1].trim());
}

function formatSections(sections) {
  return sections.map((section) => `'### ${section}'`).join(', ');
}

function formatMarkdownSections(sections) {
  return sections.map((section) => `\`### ${section}\``).join(', ');
}

function issue(validatorMessage, advisoryMessage = validatorMessage) {
  return { validatorMessage, advisoryMessage };
}

function analyzeChangelogSections({ bump, tag, entry }) {
  const sections = extractChangelogSections(entry);
  const sectionSet = new Set(sections);

  if (sections.length === 0) {
    return {
      sections,
      issue: issue(
        `The ${tag} changelog entry must include at least one '###' section.`,
        `This PR proposes release **${tag}**, but the changelog entry does not include any \`###\` sections.`
      ),
    };
  }

  const unknownSections = sections.filter((section) => !ALLOWED_CHANGELOG_SECTIONS.has(section));
  if (unknownSections.length > 0) {
    return {
      sections,
      issue: issue(
        `The ${tag} changelog entry uses unknown section heading(s): ${formatSections(unknownSections)}. Allowed sections: ${formatSections([...ALLOWED_CHANGELOG_SECTIONS])}.`,
        `This PR's changelog uses unknown section heading(s): ${formatMarkdownSections(unknownSections)}. Allowed sections: ${formatMarkdownSections([...ALLOWED_CHANGELOG_SECTIONS])}.`
      ),
    };
  }

  if (bump === 'major' && !sectionSet.has('Breaking')) {
    return {
      sections,
      issue: issue(
        `Major releases must include a '### Breaking' changelog section.`,
        `This PR proposes major release **${tag}**, but the changelog does not include \`### Breaking\`.`
      ),
    };
  }

  if (bump !== 'major' && sectionSet.has('Breaking')) {
    return {
      sections,
      issue: issue(
        `'### Breaking' requires a major release.`,
        `This PR's changelog includes \`### Breaking\`, but the PR title proposes **${tag}** (${bump}). \`### Breaking\` requires a major release.`
      ),
    };
  }

  if (bump === 'minor' && !MINOR_SECTIONS.some((section) => sectionSet.has(section))) {
    return {
      sections,
      issue: issue(
        `Minor releases must include at least one of these changelog sections: ${MINOR_SECTIONS.join(', ')}.`,
        `This PR proposes minor release **${tag}**, but the changelog does not include a minor-scope section (${formatMarkdownSections(MINOR_SECTIONS)}).`
      ),
    };
  }

  if (bump === 'patch') {
    const presentMinorSignals = PATCH_MINOR_SIGNAL_SECTIONS.filter((section) => sectionSet.has(section));

    if (presentMinorSignals.length > 0) {
      return {
        sections,
        issue: issue(
          `Patch releases should not include ${formatSections(presentMinorSignals)}.`,
          `This PR's changelog includes ${formatMarkdownSections(presentMinorSignals)}, but the PR title proposes patch release **${tag}**. Those sections are not valid for patch releases.`
        ),
      };
    }

    if (!PATCH_SECTIONS.some((section) => sectionSet.has(section))) {
      return {
        sections,
        issue: issue(
          `Patch releases must include at least one of these changelog sections: ${PATCH_SECTIONS.join(', ')}.`,
          `This PR proposes patch release **${tag}**, but the changelog does not include a patch-scope section (${formatMarkdownSections(PATCH_SECTIONS)}).`
        ),
      };
    }
  }

  return { sections, issue: null };
}

module.exports = {
  ALLOWED_CHANGELOG_SECTIONS,
  MINOR_SECTIONS,
  PATCH_MINOR_SIGNAL_SECTIONS,
  PATCH_SECTIONS,
  analyzeChangelogSections,
  changelogHeaderPattern,
  extractChangelogEntry,
  extractChangelogSections,
  parseVersion,
  releaseBump,
};
