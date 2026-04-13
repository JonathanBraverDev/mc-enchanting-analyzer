import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const uiPath = path.join(root, 'dist', 'ui.js');
const workerPath = path.join(root, 'dist', 'worker.js');
const outputPath = path.join(root, 'dist', 'bundle.js');

console.log('Bundling worker into main JS...');

try {
    if (!fs.existsSync(uiPath)) throw new Error(`UI file not found: ${uiPath}`);
    if (!fs.existsSync(workerPath)) throw new Error(`Worker file not found: ${workerPath}`);

    let uiJs = fs.readFileSync(uiPath, 'utf8');
    const workerJs = fs.readFileSync(workerPath, 'utf8');

    // Prepare worker as a Blob URL to allow local execution (file://) and single-file distribution
    // We escape backslashes, backticks, and dollar signs for the template literal
    const workerBlobJs = `
        const workerBlob = new Blob([\`${workerJs.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(workerBlob);
    `;

    // Inject the worker blob definition and replace the hardcoded path with the blob URL
    // Supports both 'dist/worker.js' and "dist/worker.js"
    const bundledJs = workerBlobJs + uiJs.replace(/new Worker\(['"]dist\/worker\.js['"]\)/g, 'new Worker(workerUrl)');

    fs.writeFileSync(outputPath, bundledJs);
    console.log(`Success! Unified bundle created at: ${outputPath}`);
} catch (err) {
    console.error('Bundling failed:', err.message);
    process.exit(1);
}
