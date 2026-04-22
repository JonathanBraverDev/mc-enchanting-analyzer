import fs from 'fs';

const version = process.argv[2];
if (!version) {
    console.error('No version provided.');
    process.exit(1);
}

const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');

// Normalize version (e.g., v3.1.0 -> 3.1.0)
const cleanVersion = version.startsWith('v') ? version.slice(1) : version;

// Regex to find the section for the specific version
// Matches "## v[version] (date)" and everything until the next "## "
const regex = new RegExp(`## v${cleanVersion}\\s+\\(\\d{4}-\\d{2}-\\d{2}\\)\\s+([\\s\\S]*?)(?=\\n\\s*##\\s+|$)`);
const match = changelog.match(regex);

if (match && match[1]) {
    process.stdout.write(match[1].trim());
} else {
    console.warn(`Warning: No changelog entry found for version ${cleanVersion}`);
    process.exit(0); // Exit gracefully so the release can still happen with an empty body
}
