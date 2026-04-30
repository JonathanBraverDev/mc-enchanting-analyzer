import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const uiPath = path.join(root, 'dist', 'ui.js');
const topWorkerPath = path.join(root, 'dist', 'top-worker.js');
const chartWorkerPath = path.join(root, 'dist', 'chart-worker.js');
const outputPath = path.join(root, 'dist', 'bundle.js');

console.log('Bundling dual workers into main JS...');

try {
    if (!fs.existsSync(uiPath)) throw new Error(`UI file not found: ${uiPath}`);
    if (!fs.existsSync(topWorkerPath)) throw new Error(`Top worker file not found: ${topWorkerPath}`);
    if (!fs.existsSync(chartWorkerPath)) throw new Error(`Chart worker file not found: ${chartWorkerPath}`);

    let uiJs = fs.readFileSync(uiPath, 'utf8');
    const topWorkerJs = fs.readFileSync(topWorkerPath, 'utf8');
    const chartWorkerJs = fs.readFileSync(chartWorkerPath, 'utf8');

    const escape = (js) => js.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

    const workerBlobsJs = `
        const topWorkerBlob = new Blob([\`${escape(topWorkerJs)}\`], { type: 'application/javascript' });
        const topWorkerUrl = URL.createObjectURL(topWorkerBlob);
        const chartWorkerBlob = new Blob([\`${escape(chartWorkerJs)}\`], { type: 'application/javascript' });
        const chartWorkerUrl = URL.createObjectURL(chartWorkerBlob);
    `;

    // Inject the worker blob definitions and replace the hardcoded paths with the blob URLs
    const bundledJs = workerBlobsJs + uiJs
        .replace(/new Worker\(['"]dist\/top-worker\.js['"]\)/g, 'new Worker(topWorkerUrl)')
        .replace(/new Worker\(['"]dist\/chart-worker\.js['"]\)/g, 'new Worker(chartWorkerUrl)');

    fs.writeFileSync(outputPath, bundledJs);
    console.log(`Success! Unified bundle created at: ${outputPath}`);
} catch (err) {
    console.error('Bundling failed:', err.message);
    process.exit(1);
}
