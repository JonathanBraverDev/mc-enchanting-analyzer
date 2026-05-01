import { DOMUtils, StringUtils } from '#utils/index.js';
import { UiMetadataService } from '#services/UiMetadataService.js';

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
        UiMetadataService.getVersions().forEach(v => {
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
            clue: (this.elements["clue-select"] as HTMLSelectElement)?.value || "",
            xpLevel: parseInt((this.elements["lvl-range"] as HTMLInputElement)?.value || "0"),
            chartMetric: (this.elements["chart-metric"] as HTMLSelectElement)?.value || "any",
            sortMode: (this.elements["combo-sort"] as HTMLSelectElement)?.value || "prob"
        };
    }

    public updateConstraints(): void {
        const { version } = this.getValues();
        const xpCap = UiMetadataService.getXpCap(version);
        const lvlRange = this.elements["lvl-range"] as HTMLInputElement;
        if (lvlRange) {
            lvlRange.max = xpCap.toString();
            if (parseInt(lvlRange.value) > xpCap) {
                lvlRange.value = xpCap.toString();
                const lvlVal = document.getElementById("lvl-val");
                if (lvlVal) lvlVal.textContent = xpCap.toString();
            }
        }
    }

    public updateMaterials(): void {
        const { version, category, material } = this.getValues();
        const matSelect = this.elements["mat-select"] as HTMLSelectElement;
        if (!matSelect) return;

        const currentMat = material;
        matSelect.innerHTML = "";
        const eligibleKeys = UiMetadataService.getEligibleMaterials(version, category);

        let bestMat = currentMat;
        if (!eligibleKeys.includes(currentMat)) {
            bestMat = eligibleKeys.includes("diamond") ? "diamond" : (eligibleKeys[0] || "");
        }

        eligibleKeys.forEach(m => {
            DOMUtils.addOption(matSelect, m, StringUtils.toTitleCase(m), m === bestMat);
        });
    }

    public updateClueTarget(): void {
        const { version, category, material, xpLevel } = this.getValues();
        const gSelect = this.elements["clue-select"] as HTMLSelectElement;
        if (!gSelect) return;

        const saved = gSelect.value;
        gSelect.innerHTML = '<option value="">None (Unconditioned)</option>';
        if (!material) return;

        const options = UiMetadataService.getClueOptions(version, category, material, xpLevel);

        options.forEach(s => {
            DOMUtils.addOption(gSelect, s, s, s === saved);
        });
    }

    public setEnchantability(val: number): void {
        const el = document.getElementById("ench-val");
        if (el) el.textContent = val.toString();
    }
}
