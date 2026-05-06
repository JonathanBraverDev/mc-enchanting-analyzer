import { UIUtils, RomanUtils } from '#utils/index.js';
import { UI_DEFAULTS, UI_TEXTS, REFINEMENT_LEVEL_COLORS, RefinementStatusLevel } from '#core/config.js';
import { RegistryState, EnchantInsights, TargetLevelClueAdvisorView, TopRunView } from '#types/index.js';

export function getDisplayConfidence(view: Pick<TopRunView, 'normalization' | 'accounting'>): number {
    if (view.normalization.domain === 'clue-known-space') {
        return Math.min(1, view.accounting.resolved + view.accounting.clueIncompatible);
    }

    return view.accounting.resolved;
}

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
        this.setComboPlaceholder(`${text}${UI_TEXTS.STATUS_POSTFIX}`);
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
    public updateV5(
        view: TopRunView,
        registry: RegistryState,
        levelClueAdvisor?: TargetLevelClueAdvisorView | undefined
    ): void {
        if (view.combos.length > 0 || view.target || view.clueAdvisor || levelClueAdvisor) {
            this.renderCombosV5(view, registry, levelClueAdvisor);
            this.renderEnchantsV5(view, registry);
        } else {
            this.showNoResults();
        }
    }

    public showNoResults(): void {
        this.setComboPlaceholder('No combinations found for this level.');
    }

    private setComboPlaceholder(text: string): void {
        if (!this.comboEl) return;

        const placeholder = document.createElement('div');
        placeholder.className = 'combo-placeholder';
        placeholder.textContent = text;
        placeholder.style.opacity = '0.5';
        placeholder.style.padding = '15px';
        placeholder.style.fontSize = '0.85rem';

        this.comboEl.replaceChildren(placeholder);
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

    private renderCombosV5(
        view: TopRunView,
        _registry: RegistryState,
        levelClueAdvisor?: TargetLevelClueAdvisorView | undefined
    ): void {
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

        if (view.target && view.combos.length === 0) {
            const empty = document.createElement("div");
            empty.className = "combo-placeholder";
            empty.textContent = "No matching combinations found at this checkpoint.";
            empty.style.opacity = "0.5";
            empty.style.padding = "15px";
            empty.style.fontSize = "0.85rem";
            fragment.appendChild(empty);
        }

        if (view.target) this.appendTargetItem(fragment, view.target);
        if (view.clueAdvisor) this.appendClueAdvisorItem(fragment, view.clueAdvisor);
        if (levelClueAdvisor) this.appendLevelClueAdvisorItem(fragment, levelClueAdvisor);

        const clueKnownSpace = view.normalization.domain === 'clue-known-space'
            ? view.normalization.clue?.knownSpace
            : undefined;
        this.appendConfidenceItem(fragment, getDisplayConfidence(view), view.accounting, clueKnownSpace);

        // Atomic swap
        this.comboEl.replaceChildren(fragment);
    }

    private appendTargetItem(
        fragment: DocumentFragment,
        target: NonNullable<TopRunView['target']>
    ): void {
        const info = document.createElement("div");
        info.className = "combo-item";
        info.style.cssText = "border-top: 1px solid rgba(255,255,255,0.05); margin-top: 10px; padding-top: 10px; opacity: 0.9;";

        const row = document.createElement("div");
        row.style.cssText = "display: flex; justify-content: space-between; gap: 12px; font-size: 0.85rem;";

        const label = document.createElement("span");
        label.textContent = target.labels.length > 0
            ? `Target Match (${target.labels.join(' + ')})`
            : "Target Match";

        const value = document.createElement("span");
        value.style.color = "var(--accent)";
        value.style.fontWeight = "800";
        value.textContent = UIUtils.formatPercent(target.matchShare);

        const count = document.createElement("div");
        count.style.cssText = "font-size: 0.7rem; color: var(--text-muted); margin-top: 3px;";
        count.textContent = `${target.matchingComboCount} matching combinations`;

        row.append(label, value);
        info.append(row, count);

        if (target.nearMissComboCount > 0) {
            info.appendChild(this.createTargetDiagnosticRow(
                "One target short",
                target.nearMissShare,
                target.nearMissComboCount
            ));
        }

        if (target.blockedComboCount > 0) {
            info.appendChild(this.createTargetDiagnosticRow(
                "Blocked by conflicts",
                target.blockedShare,
                target.blockedComboCount
            ));
        }

        fragment.appendChild(info);
    }

    private appendClueAdvisorItem(
        fragment: DocumentFragment,
        clueAdvisor: NonNullable<TopRunView['clueAdvisor']>
    ): void {
        if (clueAdvisor.recommendations.length === 0) return;

        const info = document.createElement("div");
        info.className = "combo-item";
        info.style.cssText = "border-top: 1px solid rgba(255,255,255,0.05); margin-top: 10px; padding-top: 10px; opacity: 0.92;";

        const title = document.createElement("div");
        title.style.cssText = "font-size: 0.85rem; font-weight: 800; margin-bottom: 6px;";
        title.textContent = "Best Shown Clues";
        info.appendChild(title);

        for (const recommendation of clueAdvisor.recommendations) {
            const row = document.createElement("div");
            row.style.cssText = "display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: baseline; margin-top: 5px;";

            const label = document.createElement("span");
            label.style.cssText = "font-size: 0.8rem; overflow-wrap: anywhere;";
            label.textContent = recommendation.label;

            const chance = document.createElement("span");
            chance.style.cssText = "font-size: 0.8rem; font-weight: 800; color: var(--accent);";
            chance.textContent = UIUtils.formatPercent(recommendation.targetChance);

            const meta = document.createElement("div");
            meta.style.cssText = "grid-column: 1 / -1; font-size: 0.68rem; color: var(--text-muted);";
            meta.textContent = `Shown ${UIUtils.formatPercent(recommendation.clueShare)} · joint ${UIUtils.formatPercent(recommendation.targetAndClueShare)}`;

            row.append(label, chance, meta);
            info.appendChild(row);
        }

        fragment.appendChild(info);
    }

    private appendLevelClueAdvisorItem(
        fragment: DocumentFragment,
        advisor: TargetLevelClueAdvisorView
    ): void {
        if (advisor.recommendations.length === 0) return;

        const info = document.createElement("div");
        info.className = "combo-item";
        info.style.cssText = "border-top: 1px solid rgba(255,255,255,0.05); margin-top: 10px; padding-top: 10px; opacity: 0.92;";

        const title = document.createElement("div");
        title.style.cssText = "font-size: 0.85rem; font-weight: 800; margin-bottom: 6px;";
        title.textContent = "Best Level + Clue";
        info.appendChild(title);

        for (const recommendation of advisor.recommendations) {
            const row = document.createElement("div");
            row.style.cssText = "display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: baseline; margin-top: 5px;";

            const label = document.createElement("span");
            label.style.cssText = "font-size: 0.8rem; overflow-wrap: anywhere;";
            label.textContent = `Level ${recommendation.xpLevel} · ${recommendation.label}`;

            const chance = document.createElement("span");
            chance.style.cssText = "font-size: 0.8rem; font-weight: 800; color: var(--accent);";
            chance.textContent = UIUtils.formatPercent(recommendation.targetChance);

            const meta = document.createElement("div");
            meta.style.cssText = "grid-column: 1 / -1; font-size: 0.68rem; color: var(--text-muted);";
            meta.textContent = `Shown ${UIUtils.formatPercent(recommendation.clueShare)} · joint ${UIUtils.formatPercent(recommendation.targetAndClueShare)}`;

            row.append(label, chance, meta);
            info.appendChild(row);
        }

        fragment.appendChild(info);
    }

    private createTargetDiagnosticRow(labelText: string, share: number, count: number): HTMLElement {
        const row = document.createElement("div");
        row.style.cssText = "display: flex; justify-content: space-between; gap: 12px; margin-top: 3px; font-size: 0.7rem; color: var(--text-muted);";

        const label = document.createElement("span");
        label.textContent = labelText;

        const value = document.createElement("span");
        value.textContent = `${UIUtils.formatPercent(share)} across ${count}`;

        row.append(label, value);
        return row;
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
