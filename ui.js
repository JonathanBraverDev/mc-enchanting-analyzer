// --- UI SYNC ---
let mainChart = null;
let engine = null;

function init() {
    const vSelect = document.getElementById("v-select");
    const catSelect = document.getElementById("cat-select");
    const matSelect = document.getElementById("mat-select");
    const seedSelect = document.getElementById("seed-select");
    const lvlRange = document.getElementById("lvl-range");
    const lvlVal = document.getElementById("lvl-val");

    // Populate versions
    Object.keys(DATA.versions).reverse().forEach(v => {
        const o = document.createElement("option");
        o.value = v; o.textContent = v;
        vSelect.appendChild(o);
    });

    const updateMaterials = () => {
        const cat = catSelect.value;
        const armorCats = ["helmet", "chestplate", "leggings", "boots", "turtle_shell"];
        const isArmor = armorCats.includes(cat);
        const currentMat = matSelect.value;
        matSelect.innerHTML = "";
        
        const mats = isArmor ? DATA.material_values.armor : DATA.material_values.tools;
        
        // Strict Material Filtering
        const itemCats = ["bow", "crossbow", "fishing_rod", "trident", "mace", "spear", "brush", "shield"];
        
        let eligibleKeys = Object.keys(mats);
        if (itemCats.includes(cat) && mats[cat]) {
            eligibleKeys = [cat];
        } else {
            eligibleKeys = eligibleKeys.filter(m => !itemCats.includes(m) || m === cat);
        }

        const sortedKeys = eligibleKeys.sort((a, b) => {
            const priors = ["netherite", "diamond", "gold", "iron", "stone", "wood", "leather", "chain"];
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
            if(m === currentMat || (currentMat === "" && m === "diamond")) o.selected = true;
            matSelect.appendChild(o);
        });
        if (!matSelect.value && matSelect.options.length > 0) matSelect.options[0].selected = true;
        updateSeed();
    };

    const updateSeed = () => {
        const cat = catSelect.value;
        const mat = matSelect.value;
        const lvl = parseInt(lvlRange.value);
        const v = vSelect.value;
        const currentSeed = seedSelect.value;
        
        seedSelect.innerHTML = '<option value="">None (Random First)</option>';
        if (!mat) return;
        
        engine = new EnchantEngine(DATA, v);
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
        const v = vSelect.value;
        const cat = catSelect.value;
        const mat = matSelect.value;
        const xp = parseInt(lvlRange.value);
        lvlVal.textContent = xp;

        if (!engine || engine.version !== v) {
            engine = new EnchantEngine(DATA, v);
        }
        
        document.getElementById("ench-val").textContent = engine.getEnchantability(mat, cat);

        const seed = seedSelect.value;
        const stats = engine.getFullStats(cat, xp, mat, seed);
        updateInsights(stats);
        updateChart(cat, mat, v);
    };

    vSelect.onchange = () => { updateMaterials(); updateSeed(); run(); };
    catSelect.onchange = () => { updateMaterials(); updateSeed(); run(); };
    matSelect.onchange = () => { updateSeed(); run(); };
    seedSelect.onchange = run;
    lvlRange.oninput = () => { lvlVal.textContent = lvlRange.value; };
    lvlRange.onchange = () => { updateSeed(); run(); };
    document.getElementById("chart-metric").onchange = run;

    updateMaterials();
    run();
}

function updateInsights(stats) {
    const comboEl = document.getElementById("combo-list");
    const ranks = Object.entries(stats.ranks).sort((a,b) => b[1] - a[1]).slice(0, 10);
    comboEl.innerHTML = ranks.map(([name, prob]) => `
        <div class="combo-item">
            <div style="display: flex; justify-content: space-between;">
                <span class="combo-names">${name}</span>
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

let chartUpdateId = 0;
async function updateChart(cat, mat, v) {
    const currentId = ++chartUpdateId;
    const metric = document.getElementById("chart-metric").value;
    const seed = document.getElementById("seed-select").value;
    const labels = Array.from({length: 30}, (_, i) => i + 1);
    const datasets = [];

    const threshold = cat === "book" ? 0.002 : 0.0001;
    const sweep = [];
    const chartLabels = labels;
    
    for (let i = 0; i < labels.length; i++) {
        if (currentId !== chartUpdateId) return;
        const l = labels[i];
        sweep.push({ l, s: engine.getFullStats(cat, l, mat, seed, threshold) });
        if (i % (cat === "book" ? 1 : 10) === 0) {
            await new Promise(r => requestAnimationFrame(r));
        }
    }

    const getColor = (name, index) => {
        const colors = {
            "Efficiency": "hsl(200, 70%, 60%)",
            "Unbreaking": "hsl(0, 70%, 60%)",
            "Fortune": "hsl(45, 80%, 60%)",
            "Silk Touch": "hsl(280, 70%, 60%)",
            "Sharpness": "hsl(0, 80%, 50%)",
            "Smite": "hsl(30, 70%, 50%)",
            "Bane of Arthropods": "hsl(120, 60%, 40%)",
            "Protection": "hsl(145, 60%, 50%)",
            "Fire Protection": "hsl(15, 80%, 50%)",
            "Blast Protection": "hsl(0, 0%, 50%)",
            "Projectile Protection": "hsl(210, 60%, 50%)",
            "Mending": "hsl(110, 80%, 60%)",
            "Looting": "hsl(260, 60%, 60%)",
            "Knockback": "hsl(180, 50%, 50%)",
            "Fire Aspect": "hsl(10, 90%, 50%)",
            "Sweeping Edge": "hsl(240, 50%, 60%)",
            "Power": "hsl(30, 80%, 60%)",
            "Punch": "hsl(210, 70%, 60%)",
            "Flame": "hsl(15, 90%, 60%)",
            "Infinity": "hsl(280, 80%, 70%)",
            "Luck of the Sea": "hsl(200, 80%, 70%)",
            "Lure": "hsl(180, 70%, 60%)",
            "Respiration": "hsl(190, 60%, 70%)",
            "Aqua Affinity": "hsl(180, 90%, 70%)",
            "Thorns": "hsl(340, 70%, 60%)",
            "Depth Strider": "hsl(220, 70%, 60%)",
            "Frost Walker": "hsl(180, 40%, 80%)",
            "Loyalty": "hsl(45, 70%, 60%)",
            "Impaling": "hsl(190, 80%, 50%)",
            "Riptide": "hsl(200, 50%, 80%)",
            "Channeling": "hsl(50, 100%, 70%)"
        };
        
        const base = getBaseName(name);
        let color = colors[base];
        if (!color) {
            let hash = 0;
            for (let i = 0; i < base.length; i++) hash = base.charCodeAt(i) + ((hash << 5) - hash);
            color = `hsl(${Math.abs(hash) % 360}, 65%, 60%)`;
        }
        
        const rankPart = name.split(' ').pop();
        const rankMap = {"I":0, "II":5, "III":10, "IV":15, "V":20};
        const boost = rankMap[rankPart] || 0;
        
        if (color.startsWith('hsl')) {
           const parts = color.match(/\d+/g);
           return `hsl(${parts[0]}, ${parts[1]}%, ${parseInt(parts[2]) + boost}%)`;
        }
        return color;
    };

    if(metric === "any") {
        const last = sweep[sweep.length-1].s;
        Object.keys(last.any).forEach((k, i) => {
            datasets.push({
                label: k,
                data: sweep.map(x => (x.s.any[k] || 0) * 100),
                borderColor: getColor(k, i),
                backgroundColor: getColor(k, i).replace(')', ', 0.1)'),
                borderWidth: 2, tension: 0.3, pointRadius: 0
            });
        });
    } else if(metric === "ranks") {
        const allRanks = new Set();
        sweep.forEach(entry => {
            Object.entries(entry.s.ranks).forEach(([r, p]) => {
                if (p > 0.01) allRanks.add(r);
            });
        });
        
        const sortedRanks = Array.from(allRanks).sort((a, b) => {
            const baseA = getBaseName(a), baseB = getBaseName(b);
            if (baseA !== baseB) return baseA.localeCompare(baseB);
            const rankOrder = {"I":1, "II":2, "III":3, "IV":4, "V":5};
            return (rankOrder[a.split(' ').pop()] || 0) - (rankOrder[b.split(' ').pop()] || 0);
        });
        
        sortedRanks.slice(0, 32).forEach((r, i) => {
            datasets.push({
                label: r,
                data: sweep.map(x => (x.s.ranks[r] || 0) * 100),
                borderColor: getColor(r, i),
                backgroundColor: getColor(r, i).replace(')', ', 0.1)'),
                borderWidth: 2, tension: 0.35, pointRadius: 0
            });
        });
    } else {
        const countColors = {
            1: "hsl(0, 80%, 60%)", 2: "hsl(15, 80%, 55%)", 3: "hsl(45, 80%, 50%)", 4: "hsl(80, 70%, 50%)", 5: "hsl(140, 70%, 50%)"
        };
        [1,2,3,4,5].forEach((c, i) => {
            const maxVal = Math.max(...sweep.map(x => x.s.count[c] || 0));
            if(maxVal < 0.01) return;
            const color = countColors[c] || `hsl(${120 + c * 40}, 70%, 60%)`;
            datasets.push({
                label: c + (c===1?" Enchant":" Enchants"),
                data: sweep.map(x => (x.s.count[c] || 0) * 100),
                borderColor: color,
                backgroundColor: color.replace(')', ', 0.1)'),
                borderWidth: 2, tension: 0.3, pointRadius: 0
            });
        });
    }

    if(mainChart) mainChart.destroy();
    const ctx = document.getElementById("mainChart").getContext("2d");
    mainChart = new Chart(ctx, {
        type: 'line',
        data: { labels: chartLabels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                x: { grid: { color: 'rgba(255,255,255,0.05)' } }
            },
            plugins: {
                legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 10 }, boxWidth: 10 } }
            }
        }
    });
}

window.onload = init;
