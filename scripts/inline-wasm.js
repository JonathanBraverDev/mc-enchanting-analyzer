import fs from 'fs';
import path from 'path';

const WASM_PATH = path.resolve('rust_engine/pkg/rust_engine_bg.wasm');
const BRIDGE_PATH = path.resolve('src/wasm.ts');

if (!fs.existsSync(WASM_PATH)) {
    console.error(`❌ Error: WASM file not found at ${WASM_PATH}`);
    process.exit(1);
}

// 1. Read WASM and convert to Base64
const wasmBuffer = fs.readFileSync(WASM_PATH);
const wasmBase64 = wasmBuffer.toString('base64');

// 2. Read the bridge file
let bridgeContent = fs.readFileSync(BRIDGE_PATH, 'utf8');

// 3. Replace the B64 constant
// We look for: const WASM_B64 = '...';
const regex = /const WASM_B64 = '.*';/;
if (!regex.test(bridgeContent)) {
    console.error(`❌ Error: Could not find WASM_B64 constant in ${BRIDGE_PATH}`);
    process.exit(1);
}

const newContent = bridgeContent.replace(regex, `const WASM_B64 = '${wasmBase64}';`);

// 4. Write back bridge
fs.writeFileSync(BRIDGE_PATH, newContent);

// 5. Patch the glue code (rust_engine.js) to be IIFE-compatible
// esbuild complains about import.meta.url when bundling to iife format.
// Since we pass bytes to init(), the default loading logic is never used.
const GLUE_PATH = path.resolve('rust_engine/pkg/rust_engine.js');
if (fs.existsSync(GLUE_PATH)) {
    let glueContent = fs.readFileSync(GLUE_PATH, 'utf8');
    // Replace the problematic line: module_or_path = new URL('rust_engine_bg.wasm', import.meta.url);
    // with something safe like null, since we don't use it.
    const patchedGlue = glueContent.replace(/import\.meta\.url/g, '""');
    fs.writeFileSync(GLUE_PATH, patchedGlue);
    console.log(`✅ Success: Patched ${GLUE_PATH} for IIFE compatibility`);
}

console.log(`✅ Success: Inlined ${wasmBuffer.length} bytes into ${BRIDGE_PATH}`);
