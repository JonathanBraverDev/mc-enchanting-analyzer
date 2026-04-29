import { UIUtils, RomanUtils } from '../../utils/index.js';
import { UI_DEFAULTS, UI_TEXTS, SEARCH_LEVEL_COLORS, SearchLevel } from '../../core/config.js';
import { Registry } from '../../core/registry.js';
import { EnchantInsights } from '../../types/index.js';

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

    public setRefinementStatus(text: string, level: SearchLevel): void {
        if (!this.statusEl) return;
        const c = SEARCH_LEVEL_COLORS[level];
        this.statusEl.textContent = text + (level === 'done' ? '' : UI_TEXTS.STATUS_POSTFIX);
        this.statusEl.style.backgroundColor = c.bg;
        this.statusEl.style.color = c.text;
        this.statusEl.style.opacity = level === 'done' ? '0.6' : '1';
    }

    public setChartStatus(text: string, progress?: number): void {
        if (!this.chartStatusEl) return;
        if (!text) {
            this.chartStatusEl.style.opacity = '0';
            return;
        }
        
        const progressText = progress !== undefined ? ` (${Math.round(progress * 100)}%)` : '';
        this.chartStatusEl.textContent = text + (progress !== undefined ? progressText : UI_TEXTS.STATUS_POSTFIX);
        this.chartStatusEl.style.opacity = '1';
    }

    public update(insights: EnchantInsights, registry: Registry): void {
        const hasResults = Object.keys(insights.combos).length > 0;
        if (!hasResults) return; // Don't wipe the UI if we got an empty/preliminary update
        
        this.renderCombos(insights, registry);
        this.renderRanks(insights, registry);
    }

    private renderCombos(insights: EnchantInsights, registry: Registry): void {
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

        if (insights.uncertainty > 0.005) {
            const info = document.createElement("div");
            info.className = "combo-item";
            info.style.cssText = "border-top: 1px solid rgba(255,255,255,0.05); margin-top: 10px; padding-top: 10px; opacity: 0.8;";
            
            const confidence = 1 - insights.uncertainty;
            const color = (insights.uncertainty > 0.1) ? '#ffca28' : '#66bb6a';
            
            info.innerHTML = `
                <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                    <span>Calculation Confidence</span>
                    <span style="color: ${color}">${UIUtils.formatPercent(confidence)}</span>
                </div>
                ${insights.uncertainty > 0.1 ? `<div style="font-size: 0.7rem; color: #ffca28; margin-top: 3px;">⚠️ High branching complexity - results approximated.</div>` : ''}
            `;
            fragment.appendChild(info);
        }

        // Atomic swap
        this.comboEl.replaceChildren(fragment);
    }

    private renderRanks(insights: EnchantInsights, registry: Registry): void {
        if (!this.rankEl) return;

        const fragment = document.createDocumentFragment();
        
        Object.entries(insights.any).sort((a, b) => b[1] - a[1]).forEach(([name, prob]) => {
            const props = registry.resolvedRegistry[name];
            const levelsCount = props ? Object.keys(props.levels).length : 2;
            const label = levelsCount > 1 ? `Any ${name}` : name;
            
            const item = document.createElement("div");
            item.className = "rank-item";
            
            const tooltipEntries = [`Weight: ${props?.weight || '?'}`];
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
}
