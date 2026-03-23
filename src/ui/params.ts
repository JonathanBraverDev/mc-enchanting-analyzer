import { DATA } from '../data.js';
import { DOMUtils, StringUtils } from '../utils/index.js';
import { EnchantEngine } from '../engine.js';

export class ParamsManager {
    private elements: { [id: string]: HTMLElement } = {};
    private onParamsChange: (type: string) => void;

    constructor(elements: string[], onParamsChange: (type: string) => void) {
        this.onParamsChange = onParamsChange;
        elements.forEach(id => {
            const el = document.getElementById(id);
            if (el) this.elements[id] = el;
        });
        this.populateVersions();
        this.setupListeners();
    }

    private populateVersions(): void {
        const vSelect = this.elements["v-select"] as HTMLSelectElement;
        Object.keys(DATA.versions).reverse().forEach(v => {
            DOMUtils.addOption(vSelect, v, v);
        });
    }

    private setupListeners(): void {
        Object.entries(this.elements).forEach(([id, el]) => {
            if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) {
                el.onchange = () => {
                    let type = id.replace('-select', '').replace('-range', '');
                    this.onParamsChange(type);
                };
            }
        });

        const lvl = this.elements["lvl-range"] as HTMLInputElement;
        if (lvl) {
            lvl.oninput = () => {
                const val = document.getElementById("lvl-val");
                if (val) val.textContent = lvl.value;
                this.onParamsChange('level-input');
            };
        }
    }

    public getValues() {
        return {
            version: (this.elements["v-select"] as HTMLSelectElement).value,
            category: (this.elements["cat-select"] as HTMLSelectElement).value,
            material: (this.elements["mat-select"] as HTMLSelectElement).value,
            guaranteedFirst: (this.elements["guaranteed-first-select"] as HTMLSelectElement).value,
            xpLevel: parseInt((this.elements["lvl-range"] as HTMLInputElement).value)
        };
    }

    public updateMaterials(engine: EnchantEngine): void {
        const { category } = this.getValues();
        const matSelect = this.elements["mat-select"] as HTMLSelectElement;
        const currentMat = matSelect.value;
        
        matSelect.innerHTML = "";
        const eligibleKeys = engine.registry.getEligibleMaterials(category);

        let bestMat = currentMat;
        if (!eligibleKeys.includes(currentMat)) {
            bestMat = eligibleKeys.includes("diamond") ? "diamond" : (eligibleKeys[0] || "");
        }

        eligibleKeys.forEach(m => {
            DOMUtils.addOption(matSelect, m, StringUtils.toTitleCase(m), m === bestMat);
        });
    }

    public updateGuaranteedFirst(engine: EnchantEngine): void {
        const { category, material, xpLevel } = this.getValues();
        const guaranteedFirstSelect = this.elements["guaranteed-first-select"] as HTMLSelectElement;
        const saved = guaranteedFirstSelect.value;
        
        guaranteedFirstSelect.innerHTML = '<option value="">None (Random First)</option>';
        if (!material) return;
        
        const ench = engine.registry.getEnchantability(material, category);
        const dist = engine.getModifiedLevelDist(xpLevel, ench);
        
        const allPossible = new Set<string>();
        Object.keys(dist).forEach(ml => {
            const numeric = engine.getEligibleListNumeric(category, parseInt(ml), material, 0n);
            numeric.forEach(n => {
                allPossible.add(engine.registry.getFullEnchantName(n));
            });
        });

        Array.from(allPossible).sort().forEach(s => {
            DOMUtils.addOption(guaranteedFirstSelect, s, s, s === saved);
        });
    }
}
