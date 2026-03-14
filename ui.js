// --- UI SYNC ---
let mainChart = null;
let engine = null;

const ELEMENTS = {};

function init() {
    ["v-select", "cat-select", "mat-select", "seed-select", "lvl-range", "lvl-val", "chart-metric"].forEach(id => {
        ELEMENTS[id] = document.getElementById(id);
    });
    const { "v-select": vSelect, "cat-select": catSelect, "mat-select": matSelect, "lvl-range": lvlRange, "lvl-val": lvlVal } = ELEMENTS;

    // Populate versions
    Object.keys(DATA.versions).reverse().forEach(v => {
        const o = document.createElement("option");
        o.value = v; o.textContent = v;
        ELEMENTS["v-select"].appendChild(o);
    });

    const updateMaterials = () => {
    const v = ELEMENTS["v-select"].value;
    if (!engine || engine.version !== v) engine = new EnchantEngine(DATA, v);

    const cat = ELEMENTS["cat-select"].value;
    const armorCats = DATA.constants.ARMOR_CATS;
    const isArmor = armorCats.includes(cat);
    const matSelect = ELEMENTS["mat-select"];
    const currentMat = matSelect.value;
    matSelect.innerHTML = "";
        
        const mats = isArmor ? DATA.material_values.armor : DATA.material_values.tools;
        
        // Strict Material Filtering
        const itemCats = DATA.constants.ITEM_SPECIFIC_CATS;
        
        let eligibleKeys = Object.keys(mats);
        if (itemCats.includes(cat) && mats[cat]) {
            eligibleKeys = [cat];
        } else {
            // Filter materials: version-appropriate and context-aware
            eligibleKeys = eligibleKeys.filter(m => {
                if (!engine.mergedMaterials.has(m)) return false;
                return !itemCats.includes(m) || m === cat;
            });
        }

        // Selection Reset & Validation
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
            if(m === bestMat) o.selected = true;
            matSelect.appendChild(o);
        });

        updateSeed();
    };

    const updateSeed = () => {
    const v = ELEMENTS["v-select"].value;
    if (!engine || engine.version !== v) engine = new EnchantEngine(DATA, v);
    
    const cat = ELEMENTS["cat-select"].value;
    const mat = ELEMENTS["mat-select"].value;
    const lvl = parseInt(ELEMENTS["lvl-range"].value);
    const seedSelect = ELEMENTS["seed-select"];
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
    };

    const run = () => {
        const v = ELEMENTS["v-select"].value;
        const cat = ELEMENTS["cat-select"].value;
        const mat = ELEMENTS["mat-select"].value;
        const xp = parseInt(ELEMENTS["lvl-range"].value);
        ELEMENTS["lvl-val"].textContent = xp;

        if (!engine || engine.version !== v) {
            engine = new EnchantEngine(DATA, v);
        }
        
        document.getElementById("ench-val").textContent = engine.getEnchantability(mat, cat);

        const seed = ELEMENTS["seed-select"].value;
        const stats = engine.getFullStats(cat, xp, mat, seed);
        updateInsights(stats);
        updateChart(cat, mat, v);
    };

    ELEMENTS["v-select"].onchange = () => { updateMaterials(); updateSeed(); run(); };
    ELEMENTS["cat-select"].onchange = () => { updateMaterials(); updateSeed(); run(); };
    ELEMENTS["mat-select"].onchange = () => { updateSeed(); run(); };
    ELEMENTS["seed-select"].onchange = run;
    ELEMENTS["lvl-range"].oninput = () => { ELEMENTS["lvl-val"].textContent = ELEMENTS["lvl-range"].value; run(); };
    ELEMENTS["chart-metric"].onchange = run;

    updateMaterials();
    run();
}

function updateInsights(stats) {
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
        const levels = props ? Object.keys(props.levels).length : 2;
        const label = levels > 1 ? `Any ${name}` : name;
        
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
}

function getEnchantColor(name) {
    const base = getBaseName(name);
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

let chartUpdateId = 0;
async function updateChart(cat, mat, v) {
    const currentId = ++chartUpdateId;
    const metric = ELEMENTS["chart-metric"].value;
    const seed = ELEMENTS["seed-select"].value;
    const labels = Array.from({length: 30}, (_, i) => i + 1);
    
    const threshold = cat === "book" ? 0.002 : 0.0001;
    const sweep = [];
    
    for (let l of labels) {
        if (currentId !== chartUpdateId) return;
        sweep.push({ l, s: engine.getFullStats(cat, l, mat, seed, threshold) });
        if (l % (cat === "book" ? 1 : 10) === 0) await new Promise(r => requestAnimationFrame(r));
    }

    const datasets = [];
    if(metric === "any") {
        Object.keys(sweep[sweep.length-1].s.any).forEach(k => {
            datasets.push({
                label: k,
                data: sweep.map(x => (x.s.any[k] || 0) * 100),
                borderColor: getEnchantColor(k),
                backgroundColor: getEnchantColor(k).replace(')', ', 0.1)'),
                borderWidth: 2, tension: 0.3, pointRadius: 0
            });
        });
    } else if(metric === "ranks") {
        const allRanks = new Set();
        sweep.forEach(e => Object.entries(e.s.ranks).forEach(([r, p]) => { if (p > 0.01) allRanks.add(r); }));
        Array.from(allRanks).sort((a, b) => {
            const ba = getBaseName(a), bb = getBaseName(b);
            return ba !== bb ? ba.localeCompare(bb) : DATA.constants.ROMAN_MAP[a.split(' ').pop()] - DATA.constants.ROMAN_MAP[b.split(' ').pop()];
        }).slice(0, 32).forEach(r => {
            datasets.push({
                label: r,
                data: sweep.map(x => (x.s.ranks[r] || 0) * 100),
                borderColor: getEnchantColor(r),
                backgroundColor: getEnchantColor(r).replace(')', ', 0.1)'),
                borderWidth: 2, tension: 0.35, pointRadius: 0
            });
        });
    } else {
        const colors = { 1: "hsl(0, 80%, 60%)", 2: "hsl(15, 80%, 55%)", 3: "hsl(45, 80%, 50%)", 4: "hsl(80, 70%, 50%)", 5: "hsl(140, 70%, 50%)" };
        [1,2,3,4,5].filter(c => Math.max(...sweep.map(x => x.s.count[c] || 0)) > 0.01).forEach(c => {
            datasets.push({
                label: `${c} Enchant${c > 1 ? 's' : ''}`,
                data: sweep.map(x => (x.s.count[c] || 0) * 100),
                borderColor: colors[c],
                backgroundColor: colors[c].replace(')', ', 0.1)'),
                borderWidth: 2, tension: 0.3, pointRadius: 0
            });
        });
    }

    if(mainChart) mainChart.destroy();
    mainChart = new Chart(document.getElementById("mainChart").getContext("2d"), {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                x: { grid: { color: 'rgba(255,255,255,0.05)' } }
            },
            plugins: { legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 10 }, boxWidth: 10 } } }
        }
    });
}

window.onload = init;
