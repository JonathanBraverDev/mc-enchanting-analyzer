# Minecraft Enchantment Analyzer

A high-performance, real-time simulation tool for Minecraft's enchanting mechanics. This analyzer provides instant, mathematically precise probabilities for any item, material, and version combination.

![Analyzer Screenshot](media/Screenshot.png)

## ✨ Why use this Analyzer?

- **🚀 Instant Insights**: Get immediate estimates that refine into exact percentages in seconds.
- **📈 Live Charting**: Watch the probability charts update live as the engine explores millions of possible outcomes.
- **💎 Version Perfect**: Supports enchanting mechanics back to **Beta 1.9**, including historical quirks like the 1.14 Protection conflict window.
- **📏 Deep Analysis**: Correctly models up to **6 concurrent enchantments** on a single item, providing better coverage for top-tier gear.
- **🎯 Target Combos**: Filter results by the enchantments you want together, like `Efficiency IV+` and `Fortune III+`, and see the combined chance directly.
- **Best Clues**: When target combos are selected, compare which shown table clues give the best chance of hitting them.
- **📚 Complex Support**: Accurate handling of "Multi-Enchantment" books and secondary enchantment decays that other tools often overlook.

## 🚀 Getting Started

### 📥 Standalone HTML (Zero Install)
The easiest way to use the analyzer is to download the **Standalone HTML** file from our [Releases Page](https://github.com/JonathanBraverDev/mc-enchanting-analyzer/releases).
- **No install needed**: Just open the file in any modern web browser.
- **Portable**: Everything (logic, styles, data) is contained in a single file.

### 🛠️ Developer Setup
If you want to contribute to the engine or run from source:
1. **Clone** the repository.
2. **Install**: `npm install`
3. **Run**: `npm start` (opens the dev server)
4. **Build**: `npm run build` (bundles the modular engine)
5. **Test**: `npm test` (runs the public API/CLI contract, engine, registry, and UI validation suite)


To build your own standalone version, use: `npm run build:standalone`. The result will appear at `dist/analyzer-standalone.html`.

### Command Line
After `npm run build`, run quick checks from the terminal:

```bash
node dist/cli.js 1.21 pickaxe diamond 30 --search deep
node dist/cli.js 1.21 sword diamond 30 --format json
node dist/cli.js 1.21 sword diamond 1 --search exhaustive --raw
```

Published packages expose `mcenchant` for everyday use and `mc-enchanting-analyzer` as the package-name command. The same inputs also work as explicit flags for scripts. The CLI accepts in-between Minecraft versions such as `1.14.2` and `1.7.1`.

## 🧠 The Engine

This tool uses a checkpoint-capable search engine that searches a globally weighted frontier across modified levels, reports useful intermediate checkpoints to the UI, and keeps every probability bucket accounted for while deeper searches continue. The bundled registry models only enchantments reachable through the enchanting table, so treasure-only enchantments are excluded from the active search space.

For implementation details, see `docs/README.md` for the documentation map, or jump directly to:
- `docs/public-api.md` for the supported library API boundary.
- `ARCHITECTURE.md` for the engine, worker, and checkpoint flow.
- `MASS_HANDLING.md` for probability conservation and accounting.
- `docs/search-engine.md` for the deeper search design, factorized-tree model, and optimization notes.

---
Created by **Jonathan Braver**
