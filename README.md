# Minecraft Enchantment Analyzer

A high-performance, real-time simulation tool for Minecraft enchanting mechanics. This analyzer uses a progressive refinement algorithm to provide instant rough estimates that settle into mathematically precise probabilities.

![Analyzer Screenshot](file:///d:/Projects/mc-enchanting-analyzer/media/Screenshot.png)

## ✨ Key Features

- **Progressive Refinement**: Get instant feedback with coarse searches (0.05 threshold) that refine in the background to deep precision (0.0001).
- **Real-Time Visualization**: Dynamic charts that update point-by-point as the engine settles on exact values.
- **Multithreaded Search**: Powered by Web Workers to keep the UI buttery smooth even during complex "Book" calculations.
- **Differentiated Caching**: 
  - **Slider**: Instant results by reusing the most precise data in the cache.
  - **Chart**: Consistent visual updates by matching exact refinement thresholds.
- **Cooperative Multitasking**: Interleaved execution of background chart updates and foreground slider interactions.
- **Zero-Dependency Frontend**: Pure Vanilla JS/TS for maximum performance and portability.

## 🚀 Getting Started

### Development
1. Clone the repository.
2. Install dependencies: `npm install`.
3. Start the dev server: `npm start`.
4. Build the project: `npm run build`.

### Standalone Usage
The project includes a `bundle.js` that contains all engine and worker logic. Simply open `analyzer.html` in any modern browser.

## 🛠️ Technical Overview

### The Engine
The core `EnchantEngine` simulates the Minecraft random bonus and modified level distribution. It uses a **Search Frontier** approach to navigate the massive combination space of multi-enchantment outcomes.

### The Worker
A dedicated Web Worker manages the heavy lifting. It includes a custom cancellation system that distinguishes between various UI interaction sources, allowing the chart to refine in the background while you move the level slider.

### Performance Optimizations
- **Early Exit**: Calculations stop once the "residual" (unexplored) math reaches 0.
- **Yielding**: Long-running loops use `setTimeout(0)` to keep the worker responsive to new cancellation signals.
- **Memory Management**: Automatic LRU cache cleanup for large statistical sets.

---
Created by **Jonathan Braver**
