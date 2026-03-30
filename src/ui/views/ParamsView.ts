import { DATA } from '../../data/index.js';
import { DOMUtils, StringUtils } from '../../utils/index.js';
import { EnchantEngine } from '../../engine/index.js';
import { getEligibleMaterials, getEnchantability, getFullEnchantName } from '../../core/registry.js';

/**
 * View component for managing input parameters and their synchronization.
 */
export class ParamsView {
    private elements: Record<string, HTMLElement> = {};
    private onChange: (type: string) => void;

    constructor(elementIds: string[], onChange: (type: string) => void) {
        this.onChange = onChange;
        elementIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) this.elements[id] = el;
        });

        this.populateVersions();
        this.setupListeners();
    }

    private populateVersions(): void {
        const vSelect = this.elements["v-select"] as HTMLSelectElement;
        if (!vSelect) return;
        Object.keys(DATA.versions).reverse().forEach(v => {
            DOMUtils.addOption(vSelect, v, v);
        });
    }

    private setupListeners(): void {
        Object.entries(this.elements).forEach(([id, el]) => {
            if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) {
                el.onchange = () => {
                    const type = id.replace('-select', '').replace('-range', '');
                    this.onChange(type);
                };
            }
        });

        const lvl = this.elements["lvl-range"] as HTMLInputElement;
        if (lvl) {
            lvl.oninput = () => {
                const val = document.getElementById("lvl-val");
                if (val) val.textContent = lvl.value;
                this.onChange('level-input');
            };
        }
    }

    public getValues() {
        return {
            version: (this.elements["v-select"] as HTMLSelectElement)?.value || "",
            category: (this.elements["cat-select"] as HTMLSelectElement)?.value || "",
            material: (this.elements["mat-select"] as HTMLSelectElement)?.value || "",
            guaranteedFirst: (this.elements["guaranteed-first-select"] as HTMLSelectElement)?.value || "",
            xpLevel: parseInt((this.elements["lvl-range"] as HTMLInputElement)?.value || "30"),
            chartMetric: (this.elements["chart-metric"] as HTMLSelectElement)?.value || "any",
            sortMode: (this.elements["combo-sort"] as HTMLSelectElement)?.value || "prob"
        };
    }

    public updateMaterials(engine: EnchantEngine): void {
        const { category } = this.getValues();
        const matSelect = this.elements["mat-select"] as HTMLSelectElement;
        if (!matSelect) return;

        const currentMat = matSelect.value;
        matSelect.innerHTML = "";
        const eligibleKeys = getEligibleMaterials(engine.registry, category);

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
        const gSelect = this.elements["guaranteed-first-select"] as HTMLSelectElement;
        if (!gSelect) return;

        const saved = gSelect.value;
        gSelect.innerHTML = '<option value="">None (Random First)</option>';
        if (!material) return;
        
        const ench = getEnchantability(engine.registry, material, category);
        const dist = engine.getModifiedLevelDist(xpLevel, ench);
        
        const allPossible = new Set<string>();
        Object.keys(dist).forEach(ml => {
            const numeric = engine.getEligibleListNumeric(category, parseInt(ml), material, 0n);
            numeric.forEach(n => {
                allPossible.add(getFullEnchantName(engine.registry, n));
            });
        });

        Array.from(allPossible).sort().forEach(s => {
            DOMUtils.addOption(gSelect, s, s, s === saved);
        });
    }

    public setEnchantability(val: number): void {
        const el = document.getElementById("ench-val");
        if (el) el.textContent = val.toString();
    }
}
