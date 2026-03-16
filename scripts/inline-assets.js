import fs from 'fs';
import path from 'path';

const root = process.cwd();
const htmlPath = path.join(root, 'analyzer.html');
const cssPath = path.join(root, 'style.css');
const jsPath = path.join(root, 'dist', 'bundle.js');
const outputPath = path.join(root, 'dist', 'analyzer-standalone.html');

console.log('Building standalone analyzer...');

try {
    let html = fs.readFileSync(htmlPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');

    // Remove existing link and script tags
    html = html.replace(/<link rel="stylesheet" href="style\.css">/, `<style>\n${css}\n</style>`);
    html = html.replace(/<script src="dist\/bundle\.js"><\/script>/, `<script>\n${js}\n</script>`);

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
