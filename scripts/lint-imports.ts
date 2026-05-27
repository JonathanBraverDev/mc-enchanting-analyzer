import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const IGNORE_DIRS = ['node_modules', 'dist', '.git', 'scratch', 'tmp'];
const ALIASES = {
    '#lib/': 'src/lib/',
    '#core/': 'src/lib/core/',
    '#data/': 'src/lib/data/',
    '#engine/': 'src/lib/engine/',
    '#services/': 'src/lib/services/',
    '#types/': 'src/lib/types/',
    '#utils/': 'src/lib/utils/',
    '#constants/': 'src/lib/constants/',
    '#ui/': 'src/ui/',
    '#worker/': 'src/worker/',
    '#tests/': 'tests/'
};

function isAllowedRelativeImport(relativePath: string, importPath: string): boolean {
    return relativePath === 'src/lib/api/EnchantingAnalyzer.ts' && importPath.startsWith('../types/');
}

function getAllFiles(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            if (!IGNORE_DIRS.includes(file)) {
                getAllFiles(filePath, fileList);
            }
        } else if (filePath.endsWith('.ts') || filePath.endsWith('.js')) {
            fileList.push(filePath);
        }
    });
    return fileList;
}

let warningCount = 0;

console.log('--- Checking for direct relative imports that should use "#" aliases ---');

const files = getAllFiles(ROOT);

files.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const relativePath = path.relative(ROOT, file).replace(/\\/g, '/');

    lines.forEach((line, index) => {
        // Match import ... from './...' or import ... from '../...'
        const match = line.match(/import .* from ['"](\.\.?\/.*)['"]/);
        if (match && match[1]) {
            const importPath = match[1];
            if (isAllowedRelativeImport(relativePath, importPath)) return;

            const absoluteImportPath = path.resolve(path.dirname(file), importPath);
            const rootRelativeImportPath = path.relative(ROOT, absoluteImportPath).replace(/\\/g, '/');

            // Check if this path matches any of our aliases
            for (const [alias, aliasPath] of Object.entries(ALIASES)) {
                if (rootRelativeImportPath.startsWith(aliasPath)) {
                    // It's a hit. But is it just a local file in the same dir?
                    // Even if same dir, user wants # where possible.
                    console.warn(`[WARN] ${relativePath}:${index + 1}: Direct relative import "${importPath}" should be "${alias}${rootRelativeImportPath.slice(aliasPath.length)}"`);
                    warningCount++;
                    break;
                }
            }
        }
    });
});

if (warningCount > 0) {
    console.error(`\nFound ${warningCount} import warnings.`);
    process.exit(1);
} else {
    console.log('\nNo import warnings found. All paths are optimized!');
}
