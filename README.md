# Minecraft Enchantment Analyzer

A high-performance, real-time simulation tool for Minecraft's enchanting mechanics. This analyzer provides instant, mathematically precise probabilities for any item, material, and version combination.

![Analyzer Screenshot](file:///d:/Projects/mc-enchanting-analyzer/media/Screenshot.png)

## ✨ Why use this Analyzer?

- **🚀 Instant Insights**: Get immediate estimates that refine into exact percentages in seconds. No more waiting for deep-dive calculations to finish before you see data.
- **📈 Real-Time Convergence**: Watch the probability charts update live as the engine explores millions of possible outcomes.
- **💎 Version Perfect**: Supports all major mechanics changes from **Beta 1.9 up to 1.21**, including historical quirks like the 1.14 Protection conflict window.
- **📚 Complex Support**: Accurate handling of "Multi-Enchanment" books and secondary enchantment decays that other tools often overlook.

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
4. **Test**: `npm test` (runs the engine and registry validation suite)

To build your own standalone version, use: `npm run build:standalone`. The result will appear at `dist/analyzer-standalone.html`.

## 🧠 The Engine

This tool uses a specialized "Progressive Refinement" search. It prioritizes the most statistically significant paths first, allowing the UI to remain incredibly responsive even when calculating deep probability trees for high-level enchantments.

---
Created by **Jonathan Braver** | **Version 1.0.0**
