import { UIUtils, RomanUtils } from '#utils/index.js';
import { UI_DEFAULTS, UI_TEXTS, REFINEMENT_LEVEL_COLORS, RefinementStatusLevel } from '#core/config.js';
import { RegistryState, EnchantInsights, TopRunView } from '#types/index.js';

/**
 * View component for rendering enchantment combinations and ranks.
 */
export class ResultsView {
    private comboEl: HTMLElement | null;
    private rankEl: HTMLElement | null;
    private statusEl: HTMLElement | null;
    private chartStatusEl: HTMLElement | null;

    constructor() {
        this.comboEl = document.getElementById("combo-list");
        this.rankEl = document.getElementById("rank-section");
        this.statusEl = document.getElementById("refinement-status");
        this.chartStatusEl = document.getElementById("chart-status");
    }

    public showPlaceholder(text: string): void {
        if (this.comboEl) {
            this.comboEl.innerHTML = `<div class="combo-placeholder" style="opacity: 0.5; padding: 15px; font-size: 0.85rem;">${text}${UI_TEXTS.STATUS_POSTFIX}</div>`;
        }
    }

    public setRefinementStatus(text: string, level: RefinementStatusLevel): void {
        if (!this.statusEl) return;
        const c = REFINEMENT_LEVEL_COLORS[level];
        this.statusEl.textContent = text + (level === 'done' ? '' : UI_TEXTS.STATUS_POSTFIX);
        this.statusEl.style.backgroundColor = c.bg;
        this.statusEl.style.color = c.text;
        this.statusEl.style.opacity = level === 'done' ? '0.6' : '1';
    }

    public setChartStatus(text: string, progress?: number): void {
        if (!this.chartStatusEl) return;
        if (!text) {
            this.chartStatusEl.textContent = '';
            this.chartStatusEl.style.opacity = '0';
            return;
        }

        const isComplete = text === UI_TEXTS.STATUS_CHART_COMPLETE;
        const progressText = progress !== undefined ? ` (${Math.round(progress * 100)}%)` : '';
        const postfix = (progress !== undefined || isComplete) ? '' : UI_TEXTS.STATUS_POSTFIX;

        this.chartStatusEl.textContent = text + progressText + postfix;
        this.chartStatusEl.style.opacity = isComplete ? '0.6' : '1';
    }

    public update(insights: EnchantInsights, registry: RegistryState): void {
        const hasResults = Object.keys(insights.combos).length > 0;

        if (hasResults) {
            this.renderCombos(insights, registry);
            this.renderRanks(insights, registry);
        } else {
            this.showNoResults();
        }
    }

    /**
     * V5 update path using the pre-projected TopRunView.
     */
    public updateV5(view: TopRunView, registry: RegistryState): void {
        if (view.combos.length > 0) {
            this.renderCombosV5(view, registry);
            this.renderEnchantsV5(view, registry);
        } else {
            this.showNoResults();
        }
    }

    public showNoResults(): void {
        if (this.comboEl) {
            this.comboEl.innerHTML = `<div class="combo-placeholder" style="opacity: 0.5; padding: 15px; font-size: 0.85rem;">No combinations found for this level.</div>`;
        }
    }

    private renderCombos(insights: EnchantInsights, registry: RegistryState): void {
        if (!this.comboEl) return;

        const fragment = document.createDocumentFragment();
        const romanMap = registry.data.constants.ROMAN_MAP;

        Object.entries(insights.combos).slice(0, UI_DEFAULTS.MAX_TOP_COMBOS_DISPLAY).forEach(([combo, prob]) => {
            const item = document.createElement("div");
            item.className = "combo-item";

            const tooltip = combo.split('+').map(e => {
                const name = RomanUtils.getBaseName(e.trim(), romanMap);
                const props = registry.resolvedRegistry[name];
                return props ? `${name}: Weight ${props.weight}` : name;
            }).join('\n');
            item.title = tooltip;

            item.innerHTML = `
                <div style="display: flex; justify-content: space-between;">
                    <span class="combo-names">${combo.replace(/\+/g, ' + ')}</span>
                    <span class="combo-prob">${UIUtils.formatPercent(prob)}</span>
                </div>
            `;
            fragment.appendChild(item);
        });

        this.appendConfidenceItem(fragment, insights.accuracy, insights.accounting, insights.clue?.knownSpace);

        // Atomic swap
        this.comboEl.replaceChildren(fragment);
    }

    private renderRanks(insights: EnchantInsights, registry: RegistryState): void {
        if (!this.rankEl) return;

        const fragment = document.createDocumentFragment();

        Object.entries(insights.any).sort((a, b) => b[1] - a[1]).forEach(([name, prob]) => {
            const props = registry.resolvedRegistry[name];
            const levelsCount = props ? Object.keys(props.levels).length : 2;
            const label = levelsCount > 1 ? `Any ${name}` : name;

            const item = document.createElement("div");
            item.className = "rank-item";

            const tooltipEntries = [`Weight: ${props?.weight ?? '?'}`];
            if (props?.valid_from) tooltipEntries.push(`From: ${props.valid_from}`);
            if (props?.valid_to) tooltipEntries.push(`Until: ${props.valid_to}`);
            item.title = tooltipEntries.join('\n');

            item.innerHTML = `
                <div style="display: flex; justify-content: space-between; font-size: 0.8rem;">
                    <span>${label}</span>
                    <span style="font-weight:700;">${UIUtils.formatPercent(prob)}</span>
                </div>
                <div class="progress-bg"><div class="progress-fill" style="width: ${prob * 100}%"></div></div>
            `;
            fragment.appendChild(item);
        });

        // Atomic swap
        this.rankEl.replaceChildren(fragment);
    }

    private renderCombosV5(view: TopRunView, _registry: RegistryState): void {
        if (!this.comboEl) return;

        const fragment = document.createDocumentFragment();

        view.combos.slice(0, UI_DEFAULTS.MAX_TOP_COMBOS_DISPLAY).forEach((combo) => {
            const item = document.createElement("div");
            item.className = "combo-item";

            if (combo.tooltip) item.title = combo.tooltip;

            item.innerHTML = `
                <div style="display: flex; justify-content: space-between;">
                    <span class="combo-names">${combo.enchants.join(' + ')}</span>
                    <span class="combo-prob">${UIUtils.formatPercent(combo.share)}</span>
                </div>
            `;
            fragment.appendChild(item);
        });

        const clueKnownSpace = view.normalization.domain === 'clue-known-space'
            ? view.normalization.clue?.knownSpace
            : undefined;
        this.appendConfidenceItem(fragment, view.accounting.resolved, view.accounting, clueKnownSpace);

        // Atomic swap
        this.comboEl.replaceChildren(fragment);
    }

    private renderEnchantsV5(view: TopRunView, registry: RegistryState): void {
        if (!this.rankEl) return;

        const fragment = document.createDocumentFragment();

        view.enchants.forEach((enchant) => {
            const props = registry.resolvedRegistry[enchant.label];
            const levelsCount = props ? Object.keys(props.levels).length : 2;
            const label = levelsCount > 1 ? `Any ${enchant.label}` : enchant.label;

            const item = document.createElement("div");
            item.className = "rank-item";

            if (enchant.tooltip) {
                item.title = enchant.tooltip;
            } else {
                const tooltipEntries = [`Weight: ${props?.weight ?? '?'}`];
                if (props?.valid_from) tooltipEntries.push(`From: ${props.valid_from}`);
                if (props?.valid_to) tooltipEntries.push(`Until: ${props.valid_to}`);
                item.title = tooltipEntries.join('\n');
            }

            item.innerHTML = `
                <div style="display: flex; justify-content: space-between; font-size: 0.8rem;">
                    <span>${label}</span>
                    <span style="font-weight:700;">${UIUtils.formatPercent(enchant.share)}</span>
                </div>
                <div class="progress-bg"><div class="progress-fill" style="width: ${enchant.share * 100}%"></div></div>
            `;
            fragment.appendChild(item);
        });

        // Atomic swap
        this.rankEl.replaceChildren(fragment);
    }

    private appendConfidenceItem(
        fragment: DocumentFragment,
        accuracy: number,
        accounting: { resolved: number; clueIncompatible: number; pending: number; sieved: number; overflow: number; rounding: number },
        clueKnownSpace?: number
    ): void {
        if (accuracy >= 0.999 && accounting.pending <= 0.001) return;

        const info = document.createElement("div");
        info.className = "combo-item";
        info.style.cssText = "border-top: 1px solid rgba(255,255,255,0.05); margin-top: 10px; padding-top: 10px; opacity: 0.8;";
        info.title = this.getAccountingTooltip(accounting, clueKnownSpace);

        const color = accounting.pending > 0.1 ? '#ffca28' : '#66bb6a';
        info.innerHTML = `
            <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                <span>Calculation Confidence</span>
                <span style="color: ${color}">${UIUtils.formatPercent(accuracy)}</span>
            </div>
            ${accounting.pending > 0.1 ? `<div style="font-size: 0.7rem; color: #ffca28; margin-top: 3px;">High branching complexity - results approximated.</div>` : ''}
            ${this.getClueDiagnosticHtml(clueKnownSpace, accounting.clueIncompatible)}
        `;
        fragment.appendChild(info);
    }

    private getAccountingTooltip(
        accounting: { resolved: number; clueIncompatible: number; pending: number; sieved: number; overflow: number; rounding: number },
        clueKnownSpace?: number
    ): string {
        const tooltip = [
            `Resolved: ${UIUtils.formatPercent(accounting.resolved)}`,
            `Pending: ${UIUtils.formatPercent(accounting.pending)}`,
            `Pruned (Sieved): ${UIUtils.formatPercent(accounting.sieved)}`,
            `Dropped (Overflow): ${UIUtils.formatPercent(accounting.overflow)}`,
            `Rounding: ${UIUtils.formatPercent(accounting.rounding)}`
        ];

        if (clueKnownSpace !== undefined) {
            tooltip.push(`--- Posterior (Clue-Conditioned) ---`);
            tooltip.push(`Compatible Mass: ${UIUtils.formatPercent(clueKnownSpace)} of explored space`);
            tooltip.push(`Incompatible Mass: ${UIUtils.formatPercent(accounting.clueIncompatible)}`);
        }

        return tooltip.join('\n');
    }

    private getClueDiagnosticHtml(clueKnownSpace?: number, clueIncompatible = 0): string {
        if (clueKnownSpace === undefined) return '';

        return `
            <div style="margin-top: 8px; border-top: 1px dotted rgba(255,255,255,0.1); padding-top: 6px; font-size: 0.75rem; opacity: 0.9;">
                <div style="display: flex; justify-content: space-between;">
                    <span>Known compatible mass:</span>
                    <span>${UIUtils.formatPercent(clueKnownSpace)}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span>Known incompatible mass:</span>
                    <span>${UIUtils.formatPercent(clueIncompatible)}</span>
                </div>
            </div>
        `;
    }
}
