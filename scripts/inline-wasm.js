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

// 4. Write back
fs.writeFileSync(BRIDGE_PATH, newContent);

console.log(`✅ Success: Inlined ${wasmBuffer.length} bytes into ${BRIDGE_PATH}`);
