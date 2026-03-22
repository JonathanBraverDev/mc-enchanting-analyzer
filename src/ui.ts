import { DATA } from './data.js';
import { EnchantEngine } from './engine.js';
import { CalculationStats } from './types.js';
import { ChartManager } from './chart-manager.js';
import { UI_DEFAULTS, getParamsForMode, SEARCH_LEVEL_COLORS, SearchLevel, UI_TEXTS } from './config.js';
import { WorkerClient } from './worker-client.js';
import { StringUtils, UIUtils, DOMUtils, RomanUtils } from './utils/index.js';

/**
 * Main UI Controller for the Enchantment Analyzer.
 */
const UIController = {
    elements: {} as { [id: string]: HTMLElement },
    chartManager: null as ChartManager | null,
    engine: null as EnchantEngine | null, // Sync engine for local queries (eligible list, enchantability, etc.)
    chartUpdateId: 0,
    runTimeout: 0,
    activeRefinementId: 0,
    savedGuaranteedFirst: "",
    currentSweep: [] as { l: number, s: CalculationStats }[],
    bestUncertainty: 1.1,
    bestInsights: null as any | null,
    isWorkerReady: false,
    lastRunParams: { version: "", cat: "", mat: "", guaranteedFirst: "" },

    async init(): Promise<void> {
        const ids = ["v-select", "cat-select", "mat-select", "guaranteed-first-select", "lvl-range", "lvl-val", "chart-metric", "combo-sort", "refinement-status", "combo-list"];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) this.elements[id] = el;
        });

        this.chartManager = new ChartManager("mainChart");
        
        // Initial text from single source of truth
        document.title = UI_TEXTS.PAGE_TITLE;
        const logoSpan = document.querySelector('.logo span');
        if (logoSpan) logoSpan.textContent = UI_TEXTS.LOGO_TEXT;

        this.populateVersions();
        this.setupEventListeners();
        
        const v = (this.elements["v-select"] as HTMLSelectElement).value;
        await WorkerClient.init(v);
        this.isWorkerReady = true;

        this.updateMaterials();
        this.run();
    },

    populateVersions(): void {
        const vSelect = this.elements["v-select"] as HTMLSelectElement;
        Object.keys(DATA.versions).reverse().forEach(v => {
            DOMUtils.addOption(vSelect, v, v);
        });
    },

    setupEventListeners(): void {
        const v = this.elements["v-select"] as HTMLSelectElement;
        const cat = this.elements["cat-select"] as HTMLSelectElement;
        const mat = this.elements["mat-select"] as HTMLSelectElement;
        const guaranteedFirst = this.elements["guaranteed-first-select"] as HTMLSelectElement;
        const lvl = this.elements["lvl-range"] as HTMLInputElement;
        const metric = this.elements["chart-metric"] as HTMLSelectElement;
        const comboSort = this.elements["combo-sort"] as HTMLSelectElement;

        metric.onchange = () => this.refreshChartDatasets();
        comboSort.onchange = () => {
            if (this.currentSweep.length > 0) {
                // Find the result for the currently selected level if possible, or use the latest
                const lvl = parseInt((this.elements["lvl-range"] as HTMLInputElement).value);
                const match = this.currentSweep.find(i => i.l === lvl);
                if (match) {
                     // Since updateInsights uses humanized stats, we might need to re-humanize or cache human stats
                     // But for now, we just re-run the insights update if we have the data
                     this.updateInsights(this.bestInsights, true);
                }
            }
        };
        v.onchange = () => this.onParamsChange('version');
        cat.onchange = () => this.onParamsChange('category');
        mat.onchange = () => this.onParamsChange('material');
        guaranteedFirst.onchange = () => {
            this.savedGuaranteedFirst = guaranteedFirst.value;
            this.onParamsChange('guaranteed');
        };

        lvl.oninput = () => {
            this.elements["lvl-val"].textContent = lvl.value;
            if (this.runTimeout) clearTimeout(this.runTimeout);
            this.runTimeout = window.setTimeout(() => this.run(), UI_DEFAULTS.INPUT_DEBOUNCE_MS);
        };
    },

    onParamsChange(type: 'version' | 'category' | 'material' | 'guaranteed'): void {
        const comboList = document.getElementById("combo-list");
        const rankSection = document.getElementById("rank-section");

        if (type === 'version') {
            this.showPlaceholder(UI_TEXTS.STATUS_LOADING_VERSION);
            this.isWorkerReady = false;
            WorkerClient.init((this.elements["v-select"] as HTMLSelectElement).value).then(() => {
                this.isWorkerReady = true;
                this.updateMaterials();
                this.updateGuaranteedFirst();
                this.run();
            });
            return;
        }

        if (type === 'category') {
            this.showPlaceholder(UI_TEXTS.STATUS_SWITCHING_CATEGORY);
            if (rankSection) rankSection.innerHTML = '';
            this.updateMaterials();
        }

        if (type === 'material') {
            this.updateGuaranteedFirst();
        }

        this.run();
    },

    showPlaceholder(text: string): void {
        const comboList = document.getElementById("combo-list");
        if (comboList) {
            comboList.innerHTML = `<div class="combo-placeholder" style="opacity: 0.5; padding: 15px; font-size: 0.85rem;">${text}${UI_TEXTS.STATUS_POSTFIX}</div>`;
        }
    },

    getLvlLabels(): number[] {
        return Array.from({length: UI_DEFAULTS.MAX_XP_LEVEL}, (_, i) => i + 1);
    },

    refreshChartDatasets(): void {
        if (this.currentSweep.length > 0 && this.chartManager) {
            const engine = this.getEngine();
            const metric = (this.elements["chart-metric"] as HTMLSelectElement).value;
            const datasets = this.chartManager.generateDatasets(this.currentSweep, metric, engine.registry);
            this.chartManager.update(this.getLvlLabels(), datasets);
        }
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
            DOMUtils.addOption(matSelect, m, StringUtils.toTitleCase(m), m === bestMat);
        });

        this.updateGuaranteedFirst();
    },

    updateGuaranteedFirst(): void {
        const engine = this.getEngine();
        const cat = (this.elements["cat-select"] as HTMLSelectElement).value;
        const mat = (this.elements["mat-select"] as HTMLSelectElement).value;
        const lvl = parseInt((this.elements["lvl-range"] as HTMLInputElement).value);
        const guaranteedFirstSelect = this.elements["guaranteed-first-select"] as HTMLSelectElement;
        
        guaranteedFirstSelect.innerHTML = '<option value="">None (Random First)</option>';
        if (!mat) return;
        
        const ench = engine.registry.getEnchantability(mat, cat);
        const dist = engine.getModifiedLevelDist(lvl, ench);
        
        const allPossible = new Set<string>();
        Object.keys(dist).forEach(ml => {
            const numeric = engine.getEligibleListNumeric(cat, parseInt(ml), mat, 0n);
            numeric.forEach(n => {
                allPossible.add(engine.registry.getFullEnchantName(n));
            });
        });

        Array.from(allPossible).sort().forEach(s => {
            DOMUtils.addOption(guaranteedFirstSelect, s, s, s === this.savedGuaranteedFirst);
        });
    },

    isStillActive(id: number): boolean {
        return id === this.activeRefinementId;
    },

    async runPass(
        level: Exclude<SearchLevel, 'done'>,
        basePayload: { cat: string; xp: number; mat: string; guaranteedFirst: string },
        currentId: number
    ): Promise<{ stats: any; done: boolean }> {
        const isBook = basePayload.cat === "book";
        const params = getParamsForMode(level, isBook);
        this.setRefinementStatus(params.status, level);

        const stats = await WorkerClient.request(
            'getFullStats',
            { ...basePayload, threshold: params.threshold, source: 'main', useBestCache: true, maxIterations: params.limit },
            (partial) => { if (this.isStillActive(currentId)) this.updateInsights(partial.human); }
        );

        if (!this.isStillActive(currentId)) return { stats, done: true };
        this.updateInsights(stats.human, true);

        if (stats.stats && stats.stats.uncertainty === 0) {
            this.setRefinementStatus(UI_TEXTS.STATUS_COMPLETE, "done");
            return { stats, done: true };
        }

        return { stats, done: false };
    },

    async run(): Promise<void> {
        if (!this.isWorkerReady) return;

        const engine = this.getEngine();
        const cat = (this.elements["cat-select"] as HTMLSelectElement).value;
        const mat = (this.elements["mat-select"] as HTMLSelectElement).value;
        const xp = parseInt((this.elements["lvl-range"] as HTMLInputElement).value);
        
        this.updateGuaranteedFirst();
        const guaranteedFirst = (this.elements["guaranteed-first-select"] as HTMLSelectElement).value;

        const enchValEl = document.getElementById("ench-val");
        if (enchValEl) enchValEl.textContent = engine.registry.getEnchantability(mat, cat).toString();

        const currentId = ++this.chartUpdateId;
        this.activeRefinementId = currentId;

        const version = (this.elements["v-select"] as HTMLSelectElement).value;
        const paramsChanged = this.lastRunParams.version !== version ||
                              this.lastRunParams.cat !== cat || 
                              this.lastRunParams.mat !== mat || 
                              this.lastRunParams.guaranteedFirst !== guaranteedFirst;

        if (paramsChanged) {
            this.currentSweep = [];
            this.bestUncertainty = 1.1;
            this.lastRunParams = { version, cat, mat, guaranteedFirst };
        }

        const basePayload = { cat, xp, mat, guaranteedFirst };
        const isBook = cat === "book";

        // Pass 1: Coarse (instant, no progress callback)
        const coarse = getParamsForMode('coarse', isBook);
        this.setRefinementStatus(coarse.status, 'coarse');

        let stats = await WorkerClient.request('getFullStats', {
            ...basePayload, threshold: coarse.threshold, source: 'main', useBestCache: true, maxIterations: coarse.limit
        });
        if (!this.isStillActive(currentId)) return;
        this.updateInsights(stats.human, true);

        if (paramsChanged) {
            await this.updateChart(cat, mat, coarse.threshold);
        }
        if (!this.isStillActive(currentId)) return;

        if (stats.stats && stats.stats.uncertainty === 0) {
            this.setRefinementStatus(UI_TEXTS.STATUS_COMPLETE, "done");
            return;
        }

        // Passes 2-4: Standard → Deep → Ultra
        for (const level of ['standard', 'deep', 'ultra'] as Exclude<SearchLevel, 'done'>[]) {
            const result = await this.runPass(level, basePayload, currentId);
            if (!this.isStillActive(currentId)) return;
            if (result.done) {
                if (paramsChanged && level === 'standard') {
                    this.updateChart(cat, mat, getParamsForMode('standard', isBook).threshold);
                }
                return;
            }
        }

        if (paramsChanged) {
            this.updateChart(cat, mat, getParamsForMode('ultra', isBook).threshold);
        }
        this.setRefinementStatus(UI_TEXTS.STATUS_COMPLETE, "done");
    },

    setRefinementStatus(text: string, level: SearchLevel): void {
        const el = this.elements["refinement-status"];
        if (!el) return;

        const c = SEARCH_LEVEL_COLORS[level];
        el.textContent = text + (level === 'done' ? '' : UI_TEXTS.STATUS_POSTFIX);
        el.style.backgroundColor = c.bg;
        el.style.color = c.text;
        el.style.opacity = level === 'done' ? '0.6' : '1';
    },

    updateInsights(human: any, force: boolean = false): void {
        if (!human || !human.combos) return;

        const uncertainty = human.uncertainty ?? 1;
        if (!force && uncertainty > this.bestUncertainty + 0.0001) return;
        this.bestInsights = human;
        this.bestUncertainty = uncertainty;
        const comboEl = document.getElementById("combo-list");
        if (!comboEl) return;

        const sortMode = (this.elements["combo-sort"] as HTMLSelectElement).value;
        const romanMap = (this.getEngine().registry.data.constants as any).ROMAN_MAP;

        try {
            const entries = Object.entries(human.combos);
            const hasCombos = entries.length > 0;
            
            // 1. Update Combinations List (only if we have new results)
            if (hasCombos) {
                // Sorting logic
                const sorted = [...entries];
                if (sortMode === 'prob') {
                    sorted.sort((a: any, b: any) => (b[1] as number) - (a[1] as number));
                } else if (sortMode === 'count') {
                    sorted.sort((a: any, b: any) => {
                        const countA = (a[0] as string).split('+').length;
                        const countB = (b[0] as string).split('+').length;
                        return countB - countA || (b[1] as number) - (a[1] as number);
                    });
                } else if (sortMode === 'rank') {
                    const getRankSum = (s: string) => {
                        return s.split('+').reduce((sum, e) => {
                            const roman = e.trim().split(' ').pop() || "";
                            return sum + RomanUtils.getRomanValue(roman, romanMap);
                        }, 0);
                    };
                    sorted.sort((a: any, b: any) => {
                        const rankA = getRankSum(a[0]);
                        const rankB = getRankSum(b[0]);
                        return rankB - rankA || (b[1] as number) - (a[1] as number);
                    });
                }

                const topCombos = sorted.slice(0, UI_DEFAULTS.MAX_TOP_COMBOS_DISPLAY);
                const comboListHtml = topCombos.map(([combo, prob]) => {
                    const tooltip = (combo as string).split('+').map(e => {
                        const name = RomanUtils.getBaseName(e.trim(), romanMap);
                        const props = (this.getEngine().registry.resolvedRegistry as any)[name];
                        return props ? `${name}: Weight ${props.weight}` : name;
                    }).join('\n');

                    return `
                        <div class="combo-item" title="${tooltip}">
                            <div style="display: flex; justify-content: space-between;">
                                <span class="combo-names">${(combo as string).replace(/\+/g, ' + ')}</span>
                                <span class="combo-prob">${UIUtils.formatPercent(prob as number)}</span>
                            </div>
                        </div>
                    `;
                }).join("");

                const uncertaintyHtml = human.uncertainty && human.uncertainty > 0.005 ? `
                    <div class="combo-item" style="border-top: 1px solid rgba(255,255,255,0.05); margin-top: 10px; padding-top: 10px; opacity: 0.8;">
                        <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                            <span>Calculation Confidence</span>
                            <span style="color: ${human.uncertainty > 0.1 ? '#ffca28' : '#66bb6a'}">${UIUtils.formatPercent(1 - human.uncertainty)}</span>
                        </div>
                        ${human.uncertainty > 0.1 ? `<div style="font-size: 0.7rem; color: #ffca28; margin-top: 3px;">⚠️ High branching complexity - some combinations were collapsed into their parents for speed.</div>` : ''}
                    </div>
                ` : '';
                comboEl.innerHTML = comboListHtml + uncertaintyHtml;
            } else if (force && uncertainty > 0.99) {
                // Only clear if it's the very first pass (high uncertainty) and we are forcing it (new run)
                comboEl.innerHTML = `<div class="combo-placeholder" style="opacity: 0.5; padding: 15px; font-size: 0.85rem;">${UI_TEXTS.STATUS_CALCULATING}${UI_TEXTS.STATUS_POSTFIX}</div>`;
            }

            // 2. Always Update Rank Section (Analytical stats like "Any Sharpness")
            // These are accurate even in partial passes and shouldn't be suppressed
            const rankSection = document.getElementById("rank-section");
            if (!rankSection) return;

            rankSection.innerHTML = Object.entries(human.any).sort((a: any, b: any) => (b[1] as number) - (a[1] as number)).map(([name, prob]) => {
                const props = (this.getEngine().registry.resolvedRegistry as any)[name];
                const levelsCount = props ? Object.keys(props.levels).length : 2;
                const label = levelsCount > 1 ? `Any ${name}` : name;
                
                const tooltipEntries = [`Weight: ${props?.weight || '?'}`];
                if (props?.valid_from) tooltipEntries.push(`From: ${props.valid_from}`);
                if (props?.valid_to) tooltipEntries.push(`Until: ${props.valid_to}`);
                const tooltip = tooltipEntries.join('\n');

                return `
                    <div class="rank-item" title="${tooltip}">
                        <div style="display: flex; justify-content: space-between; font-size: 0.8rem;">
                            <span>${label}</span>
                            <span style="font-weight:700;">${UIUtils.formatPercent(prob as number)}</span>
                        </div>
                        <div class="progress-bg"><div class="progress-fill" style="width: ${(prob as number)*100}%"></div></div>
                    </div>
                `;
            }).join("");
        } catch (e) {
            console.warn("UI Insights Error:", e);
        }
    },

    async updateChart(cat: string, mat: string, threshold?: number): Promise<void> {
        const currentId = this.activeRefinementId;
        const engine = this.getEngine();
        if (!engine) return;

        const guaranteedFirst = (this.elements["guaranteed-first-select"] as HTMLSelectElement).value;
        const labels = this.getLvlLabels();
        
        const isBook = cat === "book";
        const activeThreshold = threshold ?? getParamsForMode('ultra', isBook).threshold;
        
        try {
            for (let i = 0; i < labels.length; i++) {
                const l = labels[i];
                if (!this.isStillActive(currentId)) return;
                
                const stats = await WorkerClient.request(
                    'getFullStats', 
                    { cat, xp: l, mat, guaranteedFirst, threshold: activeThreshold, source: 'chart' }
                );
                if (!this.isStillActive(currentId)) return;

                this.currentSweep[i] = { l, s: stats.stats };

                if (this.chartManager) {
                    this.refreshChartDatasets();
                }
            }
        } catch (e) {
            console.warn("UI Chart Error:", e);
        }
    }

};

window.onload = () => UIController.init();
(window as any).UIController = UIController;
