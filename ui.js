/**
 * Manages UI colors and enchantment-specific styles.
 */
const ThemeManager = {
    /**
     * Calculates a color for an enchantment based on its base name and rank.
     */
    getEnchantColor: (name, engine) => {
        const base = engine.getBaseName(name);
        let color = DATA.cosmetics.ENCHANT_COLORS[base];
        
        if (!color) {
            let hash = 0;
            for (let i = 0; i < base.length; i++) hash = base.charCodeAt(i) + ((hash << 5) - hash);
            color = `hsl(${Math.abs(hash) % 360}, 65%, 60%)`;
        }

        const rankPart = name.split(' ').pop();
        const boost = DATA.cosmetics.RANK_LIGHTNESS_BOOST[rankPart] || 0;
        
        if (color.startsWith('hsl')) {
            const parts = color.match(/\d+/g);
            return `hsl(${parts[0]}, ${parts[1]}%, ${parseInt(parts[2]) + boost}%)`;
        }
        return color;
    }
};

/**
 * Main UI Controller for the Enchantment Analyzer.
 */
const UIController = {
    elements: {},
    mainChart: null,
    engine: null,
    chartUpdateId: 0,

    init() {
        const ids = ["v-select", "cat-select", "mat-select", "seed-select", "lvl-range", "lvl-val", "chart-metric"];
        ids.forEach(id => this.elements[id] = document.getElementById(id));

        this.populateVersions();
        this.setupEventListeners();
        
        this.updateMaterials();
        this.run();
    },

    populateVersions() {
        const vSelect = this.elements["v-select"];
        Object.keys(DATA.versions).reverse().forEach(v => {
            const o = document.createElement("option");
            o.value = v; o.textContent = v;
            vSelect.appendChild(o);
        });
    },

    setupEventListeners() {
        const { "v-select": v, "cat-select": cat, "mat-select": mat, "seed-select": seed, "lvl-range": lvl, "chart-metric": metric } = this.elements;

        v.onchange = () => { this.updateMaterials(); this.updateSeed(); this.run(); };
        cat.onchange = () => { this.updateMaterials(); this.updateSeed(); this.run(); };
        mat.onchange = () => { this.updateSeed(); this.run(); };
        seed.onchange = () => this.run();
        
        lvl.oninput = () => {
            this.elements["lvl-val"].textContent = lvl.value;
            this.run();
        };
        metric.onchange = () => this.run();
    },

    getEngine() {
        const v = this.elements["v-select"].value;
        if (!this.engine || this.engine.version !== v) {
            this.engine = new EnchantEngine(DATA, v);
        }
        return this.engine;
    },

    updateMaterials() {
        const engine = this.getEngine();
        const cat = this.elements["cat-select"].value;
        const matSelect = this.elements["mat-select"];
        const currentMat = matSelect.value;
        
        matSelect.innerHTML = "";
        const isArmor = DATA.constants.ARMOR_CATS.includes(cat);
        const mats = isArmor ? DATA.material_values.armor : DATA.material_values.tools;
        const itemCats = DATA.constants.ITEM_SPECIFIC_CATS;
        
        let eligibleKeys = Object.keys(mats);
        if (itemCats.includes(cat) && mats[cat]) {
            eligibleKeys = [cat];
        } else {
            eligibleKeys = eligibleKeys.filter(m => {
                if (!engine.mergedMaterials.has(m)) return false;
                return !itemCats.includes(m) || m === cat;
            });
        }

        // Determine best selection
        let bestMat = currentMat;
        if (!eligibleKeys.includes(currentMat)) {
            bestMat = eligibleKeys.includes("diamond") ? "diamond" : (eligibleKeys[0] || "");
        }

        const sortedKeys = eligibleKeys.sort((a, b) => {
            const priors = DATA.constants.MATERIAL_PRIORITY;
            const ai = priors.indexOf(a), bi = priors.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
        });

        sortedKeys.forEach(m => {
            const o = document.createElement("option");
            o.value = m;
            o.textContent = m.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            if (m === bestMat) o.selected = true;
            matSelect.appendChild(o);
        });

        this.updateSeed();
    },

    updateSeed() {
        const engine = this.getEngine();
        const cat = this.elements["cat-select"].value;
        const mat = this.elements["mat-select"].value;
        const lvl = parseInt(this.elements["lvl-range"].value);
        const seedSelect = this.elements["seed-select"];
        const currentSeed = seedSelect.value;
        
        seedSelect.innerHTML = '<option value="">None (Random First)</option>';
        if (!mat) return;
        
        const ench = engine.getEnchantability(mat, cat);
        const dist = engine.getModifiedLevelDist(lvl, ench);
        
        const allPossible = new Set();
        Object.keys(dist).forEach(ml => {
            const eligible = engine.getEligibleList(cat, parseInt(ml), mat);
            eligible.forEach(e => allPossible.add(`${e.name} ${e.rank}`));
        });

        Array.from(allPossible).sort().forEach(s => {
            const o = document.createElement("option");
            o.value = s; o.textContent = s;
            if (s === currentSeed) o.selected = true;
            seedSelect.appendChild(o);
        });
    },

    run() {
        const engine = this.getEngine();
        const cat = this.elements["cat-select"].value;
        const mat = this.elements["mat-select"].value;
        const xp = parseInt(this.elements["lvl-range"].value);
        const seed = this.elements["seed-select"].value;

        document.getElementById("ench-val").textContent = engine.getEnchantability(mat, cat);

        const stats = engine.getFullStats(cat, xp, mat, seed);
        this.updateInsights(stats);
        this.updateChart(cat, mat);
    },

    updateInsights(stats) {
        const comboEl = document.getElementById("combo-list");
        const topCombos = Object.entries(stats.combos).sort((a,b) => b[1] - a[1]).slice(0, 10);
        
        comboEl.innerHTML = topCombos.map(([name, prob]) => `
            <div class="combo-item">
                <div style="display: flex; justify-content: space-between;">
                    <span class="combo-names">${name.replace(/\+/g, ' + ')}</span>
                    <span class="combo-prob">${(prob * 100).toFixed(1)}%</span>
                </div>
            </div>
        `).join("");

        const rankSection = document.getElementById("rank-section");
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

    async updateChart(cat, mat) {
        const currentId = ++this.chartUpdateId;
        const engine = this.getEngine();
        const metric = this.elements["chart-metric"].value;
        const seed = this.elements["seed-select"].value;
        const labels = Array.from({length: 30}, (_, i) => i + 1);
        
        const threshold = cat === "book" ? 0.002 : 0.0001;
        const sweep = [];
        
        // Asynchronous sweep to keep UI responsive
        for (const l of labels) {
            if (currentId !== this.chartUpdateId) return;
            sweep.push({ l, s: engine.getFullStats(cat, l, mat, seed, threshold) });
            if (l % (cat === "book" ? 2 : 10) === 0) await new Promise(r => requestAnimationFrame(r));
        }

        const datasets = this.generateDatasets(sweep, metric, engine);

        if (this.mainChart) this.mainChart.destroy();
        this.mainChart = new Chart(document.getElementById("mainChart").getContext("2d"), {
            type: 'line',
            data: { labels, datasets },
            options: this.getChartOptions()
        });
    },

    generateDatasets(sweep, metric, engine) {
        const datasets = [];
        const lastSweep = sweep[sweep.length - 1].s;

        if (metric === "any") {
            Object.keys(lastSweep.any).forEach(k => {
                const color = ThemeManager.getEnchantColor(k, engine);
                datasets.push({
                    label: k,
                    data: sweep.map(x => (x.s.any[k] || 0) * 100),
                    borderColor: color,
                    backgroundColor: color.replace(')', ', 0.1)'),
                    borderWidth: 2, tension: 0.3, pointRadius: 0
                });
            });
        } else if (metric === "ranks") {
            const allRanks = new Set();
            sweep.forEach(e => Object.entries(e.s.ranks).forEach(([r, p]) => { if (p > 0.01) allRanks.add(r); }));
            
            Array.from(allRanks).sort((a, b) => {
                const ba = engine.getBaseName(a), bb = engine.getBaseName(b);
                if (ba !== bb) return ba.localeCompare(bb);
                return engine.getRomanValue(a.split(' ').pop()) - engine.getRomanValue(b.split(' ').pop());
            }).slice(0, 32).forEach(r => {
                const color = ThemeManager.getEnchantColor(r, engine);
                datasets.push({
                    label: r,
                    data: sweep.map(x => (x.s.ranks[r] || 0) * 100),
                    borderColor: color,
                    backgroundColor: color.replace(')', ', 0.1)'),
                    borderWidth: 2, tension: 0.35, pointRadius: 0
                });
            });
        } else {
            const colors = { 1: "hsl(0, 80%, 60%)", 2: "hsl(15, 80%, 55%)", 3: "hsl(45, 80%, 50%)", 4: "hsl(80, 70%, 50%)", 5: "hsl(140, 70%, 50%)" };
            [1, 2, 3, 4, 5].filter(c => Math.max(...sweep.map(x => x.s.count[c] || 0)) > 0.01).forEach(c => {
                datasets.push({
                    label: `${c} Enchant${c > 1 ? 's' : ''}`,
                    data: sweep.map(x => (x.s.count[c] || 0) * 100),
                    borderColor: colors[c],
                    backgroundColor: colors[c].replace(')', ', 0.1)'),
                    borderWidth: 2, tension: 0.3, pointRadius: 0
                });
            });
        }
        return datasets;
    },

    getChartOptions() {
        return {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                x: { grid: { color: 'rgba(255,255,255,0.05)' } }
            },
            plugins: { 
                legend: { 
                    position: 'bottom', 
                    labels: { color: '#ccc', font: { size: 10 }, boxWidth: 10 } 
                } 
            }
        };
    }
};

window.onload = () => UIController.init();
