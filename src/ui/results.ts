import { UIUtils, RomanUtils } from '../utils/index.js';
import { UI_DEFAULTS, UI_TEXTS, SEARCH_LEVEL_COLORS, SearchLevel } from '../core/config.js';
import { Registry } from '../core/registry.js';

export class ResultsManager {
    private comboEl: HTMLElement | null;
    private rankEl: HTMLElement | null;
    private statusEl: HTMLElement | null;

    constructor() {
        this.comboEl = document.getElementById("combo-list");
        this.rankEl = document.getElementById("rank-section");
        this.statusEl = document.getElementById("refinement-status");
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

    public updateInsights(human: any, registry: Registry, sortMode: string): void {
        if (!human || !human.combos) return;

        // 1. Update Combinations List
        if (this.comboEl) {
            const entries = Object.entries(human.combos);
            const romanMap = registry.data.constants.ROMAN_MAP;

            const sorted = [...entries];
            if (sortMode === 'prob') {
                sorted.sort((a: any, b: any) => (b[1] as number) - (a[1] as number));
            } else if (sortMode === 'count') {
                sorted.sort((a: any, b: any) => {
                    const countA = (a[0] as string).split('+').length;
                    const countB = (b[0] as string).split('+').length;
                    return countB - countA || (b[1] as number) - (a[1] as number);
                });
            } else if (sortMode === 'rank') {
                const getRankSum = (s: string) => {
                    return s.split('+').reduce((sum, e) => {
                        const roman = e.trim().split(' ').pop() || "";
                        return sum + RomanUtils.getRomanValue(roman, romanMap);
                    }, 0);
                };
                sorted.sort((a: any, b: any) => {
                    const rankA = getRankSum(a[0]);
                    const rankB = getRankSum(b[0]);
                    return rankB - rankA || (b[1] as number) - (a[1] as number);
                });
            }

            const topCombos = sorted.slice(0, UI_DEFAULTS.MAX_TOP_COMBOS_DISPLAY);
            const comboListHtml = topCombos.map(([combo, prob]) => {
                const tooltip = (combo as string).split('+').map(e => {
                    const name = RomanUtils.getBaseName(e.trim(), romanMap);
                    const props = registry.resolvedRegistry[name];
                    return props ? `${name}: Weight ${props.weight}` : name;
                }).join('\n');

                return `
                    <div class="combo-item" title="${tooltip}">
                        <div style="display: flex; justify-content: space-between;">
                            <span class="combo-names">${(combo as string).replace(/\+/g, ' + ')}</span>
                            <span class="combo-prob">${UIUtils.formatPercent(prob as number)}</span>
                        </div>
                    </div>
                `;
            }).join("");

            const uncertaintyHtml = human.uncertainty && human.uncertainty > 0.005 ? `
                <div class="combo-item" style="border-top: 1px solid rgba(255,255,255,0.05); margin-top: 10px; padding-top: 10px; opacity: 0.8;">
                    <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                        <span>Calculation Confidence</span>
                        <span style="color: ${human.uncertainty > 0.1 ? '#ffca28' : '#66bb6a'}">${UIUtils.formatPercent(1 - human.uncertainty)}</span>
                    </div>
                    ${human.uncertainty > 0.1 ? `<div style="font-size: 0.7rem; color: #ffca28; margin-top: 3px;">⚠️ High branching complexity - some combinations were collapsed into their parents for speed.</div>` : ''}
                </div>
            ` : '';
            this.comboEl.innerHTML = comboListHtml + uncertaintyHtml;
        }

        // 2. Update Rank Section
        if (this.rankEl) {
            this.rankEl.innerHTML = Object.entries(human.any).sort((a: any, b: any) => (b[1] as number) - (a[1] as number)).map(([name, prob]) => {
                const props = registry.resolvedRegistry[name];
                const levelsCount = props ? Object.keys(props.levels).length : 2;
                const label = levelsCount > 1 ? `Any ${name}` : name;
                
                const tooltipEntries = [`Weight: ${props?.weight || '?'}`];
                if (props?.valid_from) tooltipEntries.push(`From: ${props.valid_from}`);
                if (props?.valid_to) tooltipEntries.push(`Until: ${props.valid_to}`);
                const tooltip = tooltipEntries.join('\n');

                return `
                    <div class="rank-item" title="${tooltip}">
                        <div style="display: flex; justify-content: space-between; font-size: 0.8rem;">
                            <span>${label}</span>
                            <span style="font-weight:700;">${UIUtils.formatPercent(prob as number)}</span>
                        </div>
                        <div class="progress-bg"><div class="progress-fill" style="width: ${(prob as number)*100}%"></div></div>
                    </div>
                `;
            }).join("");
        }
    }
}
