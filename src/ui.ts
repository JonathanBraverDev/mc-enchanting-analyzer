import { DATA } from './data.js';
import { EnchantEngine } from './engine.js';
import { CalculationStats } from './types.js';
import { ThemeManager } from './theme.js';
import { ChartManager } from './chart-manager.js';
import { RomanUtils } from './utils.js';

/**
 * Main UI Controller for the Enchantment Analyzer.
 */
const UIController = {
    elements: {} as { [id: string]: HTMLElement },
    chartManager: null as ChartManager | null,
    engine: null as EnchantEngine | null,
    chartUpdateId: 0,
    lastChartParams: "",
    savedSeed: "",
    DEFAULT_THRESHOLD: 0.0001,
    BOOK_THRESHOLD: 0.001,
    runTimeout: 0,
    activeRefinementId: 0,
    currentSweep: [] as { l: number, s: CalculationStats }[],

    init(): void {
        const ids = ["v-select", "cat-select", "mat-select", "seed-select", "lvl-range", "lvl-val", "chart-metric", "refinement-status"];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) this.elements[id] = el;
        });

        this.chartManager = new ChartManager("mainChart");
        this.populateVersions();
        this.setupEventListeners();
        
        this.updateMaterials();
        this.run();
    },

    populateVersions(): void {
        const vSelect = this.elements["v-select"] as HTMLSelectElement;
        Object.keys(DATA.versions).reverse().forEach(v => {
            const o = document.createElement("option");
            o.value = v; o.textContent = v;
            vSelect.appendChild(o);
        });
    },

    setupEventListeners(): void {
        const v = this.elements["v-select"] as HTMLSelectElement;
        const cat = this.elements["cat-select"] as HTMLSelectElement;
        const mat = this.elements["mat-select"] as HTMLSelectElement;
        const seed = this.elements["seed-select"] as HTMLSelectElement;
        const lvl = this.elements["lvl-range"] as HTMLInputElement;
        const metric = this.elements["chart-metric"] as HTMLSelectElement;

        v.onchange = () => { this.updateMaterials(); this.updateSeed(); this.run(); };
        cat.onchange = () => { this.updateMaterials(); this.updateSeed(); this.run(); };
        mat.onchange = () => { this.updateSeed(); this.run(); };
        
        seed.onchange = () => {
            this.savedSeed = seed.value;
            this.run();
        };
        
        lvl.oninput = () => {
            this.elements["lvl-val"].textContent = lvl.value;
            if (this.runTimeout) clearTimeout(this.runTimeout);
            this.runTimeout = window.setTimeout(() => this.run(), 50);
        };
        metric.onchange = () => this.run();
    },

    getEngine(): EnchantEngine {
        const v = (this.elements["v-select"] as HTMLSelectElement).value;
        if (!this.engine || this.engine.registry.version !== v) {
            this.engine = new EnchantEngine(DATA, v);
        }
        return this.engine;
    },

    updateMaterials(): void {
        const engine = this.getEngine();
        const cat = (this.elements["cat-select"] as HTMLSelectElement).value;
        const matSelect = this.elements["mat-select"] as HTMLSelectElement;
        const currentMat = matSelect.value;
        
        matSelect.innerHTML = "";
        const eligibleKeys = engine.registry.getEligibleMaterials(cat);

        // Determine best selection
        let bestMat = currentMat;
        if (!eligibleKeys.includes(currentMat)) {
            bestMat = eligibleKeys.includes("diamond") ? "diamond" : (eligibleKeys[0] || "");
        }

        eligibleKeys.forEach(m => {
            const o = document.createElement("option");
            o.value = m;
            o.textContent = m.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            if (m === bestMat) o.selected = true;
            matSelect.appendChild(o);
        });

        this.updateSeed();
    },

    updateSeed(): void {
        const engine = this.getEngine();
        const cat = (this.elements["cat-select"] as HTMLSelectElement).value;
        const mat = (this.elements["mat-select"] as HTMLSelectElement).value;
        const lvl = parseInt((this.elements["lvl-range"] as HTMLInputElement).value);
        const seedSelect = this.elements["seed-select"] as HTMLSelectElement;
        
        seedSelect.innerHTML = '<option value="">None (Random First)</option>';
        if (!mat) return;
        
        const ench = engine.registry.getEnchantability(mat, cat);
        const dist = engine.getModifiedLevelDist(lvl, ench);
        
        const allPossible = new Set<string>();
        Object.keys(dist).forEach(ml => {
            const numeric = engine.getEligibleListNumeric(cat, parseInt(ml), mat, 0n);
            numeric.forEach(n => {
                const name = engine.registry.revIdMap[n >> 8];
                const rank = engine.revRomanMap[n & 0xFF];
                allPossible.add(`${name} ${rank}`);
            });
        });

        Array.from(allPossible).sort().forEach(s => {
            const o = document.createElement("option");
            o.value = s; o.textContent = s;
            if (s === this.savedSeed) o.selected = true;
            seedSelect.appendChild(o);
        });
    },

    async run(): Promise<void> {
        const engine = this.getEngine();
        const cat = (this.elements["cat-select"] as HTMLSelectElement).value;
        const mat = (this.elements["mat-select"] as HTMLSelectElement).value;
        const xp = parseInt((this.elements["lvl-range"] as HTMLInputElement).value);
        
        this.updateSeed();
        const seed = (this.elements["seed-select"] as HTMLSelectElement).value;

        const enchValEl = document.getElementById("ench-val");
        if (enchValEl) enchValEl.textContent = engine.registry.getEnchantability(mat, cat).toString();

        const currentId = ++this.chartUpdateId;
        this.activeRefinementId = currentId;
        this.currentSweep = []; // Fresh start for new run

        // Pass 1: Coarse Refinement (Instant)
        this.setRefinementStatus("Searching...", "coarse");
        let stats = await engine.getFullStats(cat, xp, mat, seed, 0.05);
        if (currentId !== this.activeRefinementId) return;
        this.updateInsights(stats);
        
        // Start chart sweep in background but wait for coarse pass for responsiveness
        const chartPromise = this.updateChart(cat, mat, 0.05);
        await chartPromise;
        if (currentId !== this.activeRefinementId) return;

        // Pass 2: Standard Refinement
        this.setRefinementStatus("Refining...", "standard");
        const standardThreshold = cat === "book" ? this.BOOK_THRESHOLD : this.DEFAULT_THRESHOLD;
        stats = await engine.getFullStats(cat, xp, mat, seed, standardThreshold);
        if (currentId !== this.activeRefinementId) return;
        this.updateInsights(stats);
        await this.updateChart(cat, mat, standardThreshold);
        if (currentId !== this.activeRefinementId) return;

        // Pass 3: Fine Refinement (Deep Analysis)
        this.setRefinementStatus("Finalizing...", "fine");
        stats = await engine.getFullStats(cat, xp, mat, seed, 0.00001);
        if (currentId !== this.activeRefinementId) return;
        this.updateInsights(stats);
        this.setRefinementStatus("Complete", "done");
        
        // Re-calculate last chart params to avoid unnecessary redraws
        const metric = (this.elements["chart-metric"] as HTMLSelectElement).value;
        this.lastChartParams = `${engine.registry.version}|${cat}|${mat}|${seed}|${metric}|fine`;
    },

    setRefinementStatus(text: string, level: 'coarse' | 'standard' | 'fine' | 'done'): void {
        const el = this.elements["refinement-status"];
        if (!el) return;

        const colors = {
            coarse: { bg: 'rgba(255, 193, 7, 0.15)', text: '#ffca28' },
            standard: { bg: 'rgba(76, 175, 80, 0.15)', text: '#66bb6a' },
            fine: { bg: 'rgba(33, 150, 243, 0.15)', text: '#42a5f5' },
            done: { bg: 'rgba(255, 255, 255, 0.05)', text: 'var(--text-muted)' }
        };

        el.textContent = text;
        el.style.backgroundColor = colors[level].bg;
        el.style.color = colors[level].text;
        el.style.opacity = level === 'done' ? '0.6' : '1';
    },

    updateInsights(stats: CalculationStats): void {
        const comboEl = document.getElementById("combo-list");
        if (!comboEl) return;

        const engine = this.getEngine();
        const topCombos = Object.entries(stats.combos).sort((a,b) => b[1] - a[1]).slice(0, 10);
        
        const comboListHtml = topCombos.map(([name, prob]) => `
            <div class="combo-item">
                <div style="display: flex; justify-content: space-between;">
                    <span class="combo-names">${engine.translateComboKey(name).replace(/\+/g, ' + ')}</span>
                    <span class="combo-prob">${(prob * 100).toFixed(1)}%</span>
                </div>
            </div>
        `).join("");

        const uncertaintyHtml = stats.residual && stats.residual > 0.005 ? `
            <div class="combo-item" style="border-top: 1px solid rgba(255,255,255,0.05); margin-top: 10px; padding-top: 10px; opacity: 0.8;">
                <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                    <span>Calculation Confidence</span>
                    <span style="color: ${stats.residual > 0.1 ? '#ffca28' : '#66bb6a'}">${((1 - stats.residual) * 100).toFixed(1)}%</span>
                </div>
                ${stats.residual > 0.1 ? `<div style="font-size: 0.7rem; color: #ffca28; margin-top: 3px;">⚠️ High branching complexity - some combinations were collapsed into their parents for speed.</div>` : ''}
            </div>
        ` : '';

        comboEl.innerHTML = comboListHtml + uncertaintyHtml;

        const rankSection = document.getElementById("rank-section");
        if (!rankSection) return;

        rankSection.innerHTML = Object.entries(stats.any).sort((a,b) => b[1] - a[1]).map(([name, prob]) => {
            const props = DATA.global_enchantments[name];
            const levelsCount = props ? Object.keys(props.levels).length : 2;
            const label = levelsCount > 1 ? `Any ${name}` : name;
            
            return `
                <div class="rank-item">
                    <div style="display: flex; justify-content: space-between; font-size: 0.8rem;">
                        <span>${label}</span>
                        <span style="font-weight:700;">${(prob*100).toFixed(1)}%</span>
                    </div>
                    <div class="progress-bg"><div class="progress-fill" style="width: ${prob*100}%"></div></div>
                </div>
            `;
        }).join("");
    },

    async updateChart(cat: string, mat: string, threshold?: number): Promise<void> {
        const currentId = this.activeRefinementId;
        const engine = this.getEngine();
        const metric = (this.elements["chart-metric"] as HTMLSelectElement).value;
        const seed = (this.elements["seed-select"] as HTMLSelectElement).value;
        const labels = Array.from({length: 30}, (_, i) => i + 1);
        
        const activeThreshold = threshold || (cat === "book" ? this.BOOK_THRESHOLD : this.DEFAULT_THRESHOLD);
        
        // One level redraws for smooth animation
        const redrawStep = 1;

        for (let i = 0; i < labels.length; i++) {
            const l = labels[i];
            if (currentId !== this.activeRefinementId) return;
            
            const stats = await engine.getFullStats(cat, l, mat, seed, activeThreshold);
            
            // Incremental update of the central sweep cache
            this.currentSweep[i] = { l, s: stats };

            if (l % redrawStep === 0 || l === 30) {
                if (this.chartManager) {
                    // Always render using the current state of currentSweep
                    const tempDatasets = this.chartManager.generateDatasets(this.currentSweep, metric, engine.registry);
                    this.chartManager.update(labels, tempDatasets);
                }
                // Yield to browser to paint the update
                await new Promise(r => requestAnimationFrame(r));
            }
        }
    }

};

window.onload = () => UIController.init();

