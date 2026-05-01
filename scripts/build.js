import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const buildOptions = (entry, outfile, isStandalone) => ({
  entryPoints: [path.join(root, entry)],
  outfile: path.join(root, outfile),
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'browser',
  format: 'iife',
  alias: isStandalone ? {
    '#data/registry.js': path.join(root, 'src/lib/data/empty-registry.ts'),
  } : {},
});

async function build() {
  console.log('Building standalone components...');
  
  // 1. Build Data as a clean IIFE that defines global ENCHANTING_DATA
  await esbuild.build({
    entryPoints: [path.join(root, 'src/lib/data/registry.ts')],
    outfile: path.join(root, 'dist/data.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'ENCHANTING_DATA',
  });
  console.log('Data built.');

  // 2. Build UI
  await esbuild.build(buildOptions('src/ui/index.ts', 'dist/ui.js', true));
  console.log('UI built.');

  // 3. Build Workers
  await esbuild.build(buildOptions('src/worker/top-worker.ts', 'dist/top-worker.js', true));
  await esbuild.build(buildOptions('src/worker/chart-worker.ts', 'dist/chart-worker.js', true));
  console.log('Workers built.');
}

build().catch(err => {
  if (err.errors) {
    err.errors.forEach(e => console.error(`Error: ${e.text} (${e.location?.file}:${e.location?.line})`));
  } else {
    console.error('Build failed:', err);
  }
  process.exit(1);
});
