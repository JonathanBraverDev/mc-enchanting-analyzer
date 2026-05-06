import { DOMUtils, StringUtils } from '#utils/index.js';
import { UiMetadataService } from '#services/UiMetadataService.js';
import type { TargetOptionView, TargetRequirementInput } from '#types/index.js';

/**
 * View component for managing input parameters and their synchronization.
 */
export class ParamsView {
    private elements: Record<string, HTMLElement> = {};
    private onChange: (type: string) => void;
    private targets: TargetRequirementInput[] = [];
    private targetOptions: TargetOptionView[] = [];

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
            if (id === 'target-select') return;
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

        const targetAdd = document.getElementById("target-add") as HTMLButtonElement | null;
        targetAdd?.addEventListener('click', () => this.addSelectedTarget());
    }

    public getValues() {
        return {
            version: (this.elements["v-select"] as HTMLSelectElement)?.value || "",
            category: (this.elements["cat-select"] as HTMLSelectElement)?.value || "",
            material: (this.elements["mat-select"] as HTMLSelectElement)?.value || "",
            clue: (this.elements["clue-select"] as HTMLSelectElement)?.value || "",
            xpLevel: parseInt((this.elements["lvl-range"] as HTMLInputElement)?.value || "0"),
            chartMetric: (this.elements["chart-metric"] as HTMLSelectElement)?.value || "any",
            sortMode: (this.elements["combo-sort"] as HTMLSelectElement)?.value || "prob",
            targets: this.targets.map(target => ({ ...target }))
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
        if (!material) {
            this.updateTargetOptions();
            return;
        }

        const options = UiMetadataService.getClueOptions(version, category, material, xpLevel);

        options.forEach(s => {
            DOMUtils.addOption(gSelect, s, s, s === saved);
        });

        this.updateTargetOptions();
    }

    public updateTargetOptions(): void {
        const { version, category, material, xpLevel } = this.getValues();
        const targetSelect = this.elements["target-select"] as HTMLSelectElement;
        if (!targetSelect) return;

        const saved = targetSelect.value;
        this.targetOptions = UiMetadataService.getTargetOptions(version, category, material, xpLevel);
        const validKeys = new Set(this.targetOptions.map(option => this.getTargetKey(option)));
        this.targets = this.targets.filter(target => validKeys.has(this.getTargetKey(target)));
        const compatibleOptions = this.targetOptions.filter(option =>
            UiMetadataService.isTargetCompatible(version, option, this.targets)
        );

        targetSelect.replaceChildren();
        for (const option of compatibleOptions) {
            const value = this.serializeTarget(option);
            DOMUtils.addOption(targetSelect, value, option.label, value === saved);
        }

        const addButton = document.getElementById("target-add") as HTMLButtonElement | null;
        if (addButton) addButton.disabled = compatibleOptions.length === 0;

        this.renderTargets();
    }

    public setEnchantability(val: number): void {
        const el = document.getElementById("ench-val");
        if (el) el.textContent = val.toString();
    }

    private addSelectedTarget(): void {
        const targetSelect = this.elements["target-select"] as HTMLSelectElement;
        if (!targetSelect?.value) return;

        const selected = this.parseTargetValue(targetSelect.value);
        this.targets = this.targets.filter(target => target.enchantment !== selected.enchantment);
        this.targets.push(selected);
        this.targets.sort((a, b) => this.getTargetLabel(a).localeCompare(this.getTargetLabel(b)));

        this.updateTargetOptions();
        this.onChange('target');
    }

    private removeTarget(target: TargetRequirementInput): void {
        const key = this.getTargetKey(target);
        this.targets = this.targets.filter(existing => this.getTargetKey(existing) !== key);
        this.updateTargetOptions();
        this.onChange('target');
    }

    private renderTargets(): void {
        const list = document.getElementById("target-list");
        if (!list) return;

        const fragment = document.createDocumentFragment();
        for (const target of this.targets) {
            const chip = document.createElement('span');
            chip.className = 'target-chip';

            const label = document.createElement('span');
            label.textContent = this.getTargetLabel(target);

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'target-chip-remove';
            button.setAttribute('aria-label', `Remove ${this.getTargetLabel(target)}`);
            button.textContent = 'x';
            button.addEventListener('click', () => this.removeTarget(target));

            chip.append(label, button);
            fragment.appendChild(chip);
        }

        list.replaceChildren(fragment);
    }

    private serializeTarget(target: Pick<TargetRequirementInput, 'enchantment' | 'rank'>): string {
        return JSON.stringify({
            enchantment: target.enchantment,
            rank: target.rank,
            rankMode: 'atLeast'
        });
    }

    private parseTargetValue(value: string): TargetRequirementInput {
        const parsed = JSON.parse(value) as TargetRequirementInput;
        return {
            enchantment: parsed.enchantment,
            rank: parsed.rank,
            rankMode: 'atLeast'
        };
    }

    private getTargetKey(target: Pick<TargetRequirementInput, 'enchantment' | 'rank'>): string {
        return `${target.enchantment}|${target.rank}`;
    }

    private getTargetLabel(target: TargetRequirementInput): string {
        return this.targetOptions.find(option => this.getTargetKey(option) === this.getTargetKey(target))?.label
            ?? `${target.enchantment} ${target.rank}+`;
    }
}
