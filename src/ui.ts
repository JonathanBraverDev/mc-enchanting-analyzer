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

    init(): void {
        const ids = ["v-select", "cat-select", "mat-select", "seed-select", "lvl-range", "lvl-val", "chart-metric"];
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
        await new Promise(r => requestAnimationFrame(r));
        if (currentId !== this.chartUpdateId) return;

        const threshold = cat === "book" ? this.BOOK_THRESHOLD : this.DEFAULT_THRESHOLD;
        const stats = await engine.getFullStats(cat, xp, mat, seed, threshold);
        
        this.updateInsights(stats);

        const metric = (this.elements["chart-metric"] as HTMLSelectElement).value;
        const chartParams = `${engine.registry.version}|${cat}|${mat}|${seed}|${metric}`;
        
        if (chartParams !== this.lastChartParams) {
            this.lastChartParams = chartParams;
            this.updateChart(cat, mat);
        }
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

    async updateChart(cat: string, mat: string): Promise<void> {
        const currentId = ++this.chartUpdateId;
        const engine = this.getEngine();
        const metric = (this.elements["chart-metric"] as HTMLSelectElement).value;
        const seed = (this.elements["seed-select"] as HTMLSelectElement).value;
        const labels = Array.from({length: 30}, (_, i) => i + 1);
        
        const threshold = cat === "book" ? this.BOOK_THRESHOLD : this.DEFAULT_THRESHOLD;
        const sweep: { l: number, s: CalculationStats }[] = [];
        
        for (const l of labels) {
            if (currentId !== this.chartUpdateId) return;
            sweep.push({ l, s: await engine.getFullStats(cat, l, mat, seed, threshold) });
            if (l % (cat === "book" ? 2 : 10) === 0) await new Promise(r => requestAnimationFrame(r));
        }

        if (this.chartManager) {
            const datasets = this.chartManager.generateDatasets(sweep, metric, engine.registry);
            this.chartManager.update(labels, datasets);
        }
    }
};

window.onload = () => UIController.init();

