import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const htmlPath = path.join(root, 'src', 'ui', 'analyzer.html');
const cssPath = path.join(root, 'src', 'ui', 'styles', 'style.css');
const jsPath = path.join(root, 'dist', 'bundle.js');
const outputPath = path.join(root, 'dist', 'analyzer-standalone.html');

console.log('Building standalone analyzer...');

try {
    let html = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');
    let js = fs.readFileSync(jsPath, 'utf8');

    // Remove existing link and script tags
    html = html.replace(/<link rel="stylesheet" href="styles\/style\.css">/, `<style>\n${css}\n</style>`);
    html = html.replace(/<script src="\.\.\/\.\.\/dist\/bundle\.js"><\/script>/, `<script>\n${js}\n</script>`);

    // Ensure output directory exists
    if (!fs.existsSync(path.dirname(outputPath))) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    }

    fs.writeFileSync(outputPath, html);
    console.log(`Success! Standalone file created at: ${outputPath}`);
    console.log(`File size: ${(fs.statSync(outputPath).size / 1024).toFixed(2)} KB`);
} catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
}
