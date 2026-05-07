import { ThemeManager } from '#ui/theme.js';
import { getEnchantName, getFullEnchantName } from '#core/registry.js';
import { ChartCellView, ChartDataset, RegistryState } from '#types/index.js';
import { RomanUtils } from '#utils/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

interface ChartInstance {
    data: { labels: unknown[]; datasets: unknown[] };
    destroy(): void;
    isDatasetVisible(datasetIndex: number): boolean;
    setDatasetVisibility(datasetIndex: number, visible: boolean): void;
    update(mode: string): void;
}
interface TooltipDataset {
    label?: string;
    groupKey?: string;
}
interface TooltipItem {
    dataset?: TooltipDataset;
    formattedValue?: string;
    parsed?: { y?: number };
}
interface ChartConstructor {
    new(ctx: CanvasRenderingContext2D | null, config: Record<string, unknown>): ChartInstance;
}
declare const Chart: ChartConstructor;

const DEFAULT_VISIBLE_RANK_DATASET_LIMIT = 32;
const TOOLTIP_GROUPING_CONFIG = {
    maxDetailedItems: 16,
    minValuePercent: 0.05,
    mode: 'group-overflow' as 'group-overflow'
};

interface RankDatasetCandidate {
    idAndRank: number;
    baseName: string;
    rank: number;
    peak: number;
}


/**
 * Encapsulates Chart.js lifecycle and data mapping.
 */
export class ChartManager {
    private chart: ChartInstance | null = null;
    get chartInstance(): ChartInstance | null { return this.chart; }
    private canvas: HTMLCanvasElement | null = null;
    private hiddenGroups = new Set<string>();
    private hiddenGroupRanks = new Set<string>();
    private userTouchedGroups = new Set<string>();
    private legendEl: HTMLElement | null = null;
    private legendSignature = '';

    constructor(canvasId: string) {
        this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
        this.legendEl = document.getElementById('chart-custom-legend');
    }

    public destroy(): void {
        if (this.chart) {
            try { this.chart.destroy(); } catch(e) {}
            this.chart = null;
        }
    }

    public update(labels: number[], datasets: ChartDataset[]): void {
        if (!this.canvas || typeof Chart === 'undefined') return;

        if (this.chart) {
            this.chart.data.labels = labels;
            this.chart.data.datasets = datasets;
            if (datasets.some(dataset => dataset.groupKey)) this.syncDefaultGroupVisibility(datasets);
            this.renderGroupedLegend(datasets);
            if (datasets.some(dataset => dataset.groupKey)) this.applyGroupVisibility();
            this.chart.update('none'); // 'none' for performance during rapid updates
            return;
        }

        try {
            this.chart = new Chart(this.canvas.getContext("2d"), {
                type: 'line',
                data: { labels, datasets },
                options: this.getChartOptions()
            });
            if (datasets.some(dataset => dataset.groupKey)) this.syncDefaultGroupVisibility(datasets);
            this.renderGroupedLegend(datasets);
            if (datasets.some(dataset => dataset.groupKey)) this.applyGroupVisibility();
        } catch (e) {
            console.error("Failed to render chart:", e);
        }
    }


    public generateDatasets(sweep: ChartCellView[], metric: string, registry: RegistryState): ChartDataset[] {
        const datasets: ChartDataset[] = [];
        const romanMap = registry.romanMap;

        if (metric === "any") {
            const allEnchants = new Set<number>();
            sweep.forEach(x => {
                if(x && x.buckets && x.buckets.anyByEnchantId) {
                    Object.keys(x.buckets.anyByEnchantId).forEach(idStr => allEnchants.add(parseInt(idStr)));
                }
            });

            Array.from(allEnchants).sort((a,b) => getEnchantName(registry, a).localeCompare(getEnchantName(registry, b))).forEach(id => {
                const name = getEnchantName(registry, id);
                const color = ThemeManager.getEnchantColor(name, registry);
                datasets.push({
                    label: name,
                    data: sweep.map(x => (x && x.buckets && x.buckets.anyByEnchantId[id] || 0) * 100),
                    borderColor: color,
                    backgroundColor: ThemeManager.withAlpha(color, 0.1),
                    borderWidth: 2, tension: 0.1, pointRadius: 0
                });
            });
        } else if (metric === "ranks") {
            const candidatesByRank = new Map<number, RankDatasetCandidate>();
            sweep.forEach(e => {
                if(e && e.buckets && e.buckets.rankByIdAndRank) {
                    Object.entries(e.buckets.rankByIdAndRank).forEach(([idAndRankStr, p]) => {
                        if (p <= 0.01) return;

                        const idAndRank = parseInt(idAndRankStr);
                        const fullName = getFullEnchantName(registry, idAndRank);
                        const baseName = RomanUtils.getBaseName(fullName, romanMap);
                        const rank = idAndRank & 0xFF;
                        const existing = candidatesByRank.get(idAndRank);

                        candidatesByRank.set(idAndRank, {
                            idAndRank,
                            baseName,
                            rank,
                            peak: Math.max(existing?.peak || 0, p)
                        });
                    });
                }
            });

            const groups = new Map<string, RankDatasetCandidate[]>();
            candidatesByRank.forEach(candidate => {
                const group = groups.get(candidate.baseName) || [];
                group.push(candidate);
                groups.set(candidate.baseName, group);
            });

            const defaultVisibleRankIds = new Set<number>();
            let defaultVisibleRankCount = 0;
            Array.from(groups.values()).sort((a, b) => {
                const peakDelta = Math.max(...b.map(candidate => candidate.peak)) - Math.max(...a.map(candidate => candidate.peak));
                if (peakDelta !== 0) return peakDelta;
                return a[0]!.baseName.localeCompare(b[0]!.baseName);
            }).forEach(group => {
                const sortedGroup = group.sort((a, b) => a.rank - b.rank);
                if (defaultVisibleRankCount > 0 && defaultVisibleRankCount + sortedGroup.length > DEFAULT_VISIBLE_RANK_DATASET_LIMIT) return;
                sortedGroup.forEach(candidate => defaultVisibleRankIds.add(candidate.idAndRank));
                defaultVisibleRankCount += sortedGroup.length;
            });

            Array.from(candidatesByRank.values()).sort((a, b) => {
                if (a.baseName !== b.baseName) return a.baseName.localeCompare(b.baseName);
                return a.rank - b.rank;
            }).forEach(({ idAndRank, baseName }) => {
                const fullName = getFullEnchantName(registry, idAndRank);
                const style = ThemeManager.getRankLineStyle(idAndRank, registry);
                datasets.push({
                    label: fullName,
                    groupKey: baseName,
                    rankLevel: idAndRank & 0xFF,
                    defaultVisible: defaultVisibleRankIds.has(idAndRank),
                    data: sweep.map(x => (x && x.buckets && x.buckets.rankByIdAndRank[idAndRank] || 0) * 100),
                    borderColor: style.color,
                    backgroundColor: ThemeManager.withAlpha(style.color, 0.1),
                    borderWidth: style.borderWidth,
                    borderDash: style.borderDash,
                    tension: 0.1, pointRadius: 0
                });
            });
        } else {
            const max = ENGINE_LIMITS.MAX_ENCHANTS_PER_ITEM || 6;
            for (let c = 1; c <= max; c++) {
                const maxInSweep = Math.max(...sweep.map(x => x && x.buckets ? (x.buckets.countBySize[c] || 0) : 0));
                if (maxInSweep < 0.005) continue;

                const hue = (c - 1) * (140 / (max - 1 || 1));
                const color = `hsl(${hue}, 70%, 50%)`;

                datasets.push({
                    label: `${c} Enchant${c > 1 ? 's' : ''}`,
                    data: sweep.map(x => (x && x.buckets && x.buckets.countBySize[c] || 0) * 100),
                    borderColor: color,
                    backgroundColor: ThemeManager.withAlpha(color, 0.1),
                    borderWidth: 2, tension: 0.1, pointRadius: 0
                });
            }
        }
        return datasets;
    }


    private applyGroupVisibility(): void {
        if (!this.chart) return;

        (this.chart.data.datasets as ChartDataset[]).forEach((dataset, index) => {
            const shouldShow = !dataset.groupKey
                || (!this.hiddenGroups.has(dataset.groupKey) && !this.hiddenGroupRanks.has(this.getGroupRankKey(dataset.groupKey, dataset.rankLevel)));
            this.chart!.setDatasetVisibility(index, shouldShow);
        });
    }


    private syncDefaultGroupVisibility(datasets: ChartDataset[]): void {
        const groupedDefaults = new Map<string, boolean>();
        datasets.forEach(dataset => {
            if (!dataset.groupKey || this.userTouchedGroups.has(dataset.groupKey)) return;
            groupedDefaults.set(dataset.groupKey, (groupedDefaults.get(dataset.groupKey) || false) || dataset.defaultVisible !== false);
        });

        groupedDefaults.forEach((hasDefaultVisibleRank, groupKey) => {
            if (hasDefaultVisibleRank) this.hiddenGroups.delete(groupKey);
            else this.hiddenGroups.add(groupKey);
        });
    }


    private getGroupRankKey(groupKey: string, rankLevel: number | undefined): string {
        return `${groupKey}:${rankLevel ?? 'unknown'}`;
    }


    private renderGroupedLegend(datasets: ChartDataset[]): void {
        if (!this.legendEl) return;

        const groupedDatasets = datasets.filter(dataset => dataset.groupKey);
        if (groupedDatasets.length === 0) {
            this.legendEl.hidden = true;
            this.legendEl.replaceChildren();
            this.hiddenGroups.clear();
            this.hiddenGroupRanks.clear();
            this.userTouchedGroups.clear();
            this.legendSignature = '';
            return;
        }

        const signature = groupedDatasets
            .map(dataset => `${dataset.groupKey}:${dataset.rankLevel}:${dataset.defaultVisible}:${dataset.borderColor}:${dataset.borderDash?.join('.') || ''}`)
            .join('|')
            + ` hiddenGroups=${Array.from(this.hiddenGroups).sort().join(',')}`
            + ` hiddenRanks=${Array.from(this.hiddenGroupRanks).sort().join(',')}`;
        if (signature === this.legendSignature) return;
        this.legendSignature = signature;

        this.legendEl.hidden = false;
        this.legendEl.replaceChildren(
            this.createLegendSummary(groupedDatasets),
            this.createLegendActions(groupedDatasets),
            this.createEnchantLegend(groupedDatasets),
            this.createRankStyleLegend(groupedDatasets)
        );
    }


    private createLegendSummary(datasets: ChartDataset[]): HTMLElement {
        const summary = document.createElement('div');
        summary.className = 'chart-legend-summary';

        const visible = datasets.filter(dataset => dataset.groupKey
            && !this.hiddenGroups.has(dataset.groupKey)
            && !this.hiddenGroupRanks.has(this.getGroupRankKey(dataset.groupKey, dataset.rankLevel))).length;
        const defaultVisible = datasets.filter(dataset => dataset.defaultVisible !== false).length;
        const total = datasets.length;
        const hiddenByDefault = Math.max(0, total - defaultVisible);

        summary.textContent = hiddenByDefault > 0
            ? `Showing ${visible} of ${total} rank lines. ${hiddenByDefault} lower-priority lines start hidden by default.`
            : `Showing ${visible} of ${total} rank lines.`;
        return summary;
    }


    private createLegendActions(datasets: ChartDataset[]): HTMLElement {
        const actions = document.createElement('div');
        actions.className = 'chart-legend-actions';

        const groupKeys = Array.from(new Set(datasets.map(dataset => dataset.groupKey).filter((groupKey): groupKey is string => groupKey !== undefined)));
        const buttons = [
            { label: 'Recommended', action: () => this.showRecommendedLegendState(datasets) },
            { label: 'All', action: () => this.showAllLegendState(groupKeys) },
            { label: 'None', action: () => this.showNoLegendState(groupKeys) },
            { label: 'Max only', action: () => this.showMaxOnlyLegendState(datasets, groupKeys) }
        ];

        buttons.forEach(({ label, action }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chart-legend-action';
            button.textContent = label;
            button.addEventListener('click', () => {
                action();
                this.applyGroupVisibility();
                this.renderGroupedLegend(this.chart?.data.datasets as ChartDataset[] || []);
                this.chart?.update('none');
            });
            actions.append(button);
        });

        return actions;
    }


    private showRecommendedLegendState(datasets: ChartDataset[]): void {
        this.hiddenGroups.clear();
        this.hiddenGroupRanks.clear();
        this.userTouchedGroups.clear();
        this.syncDefaultGroupVisibility(datasets);
    }


    private showAllLegendState(groupKeys: string[]): void {
        this.hiddenGroups.clear();
        this.hiddenGroupRanks.clear();
        groupKeys.forEach(groupKey => this.userTouchedGroups.add(groupKey));
    }


    private showNoLegendState(groupKeys: string[]): void {
        this.hiddenGroups = new Set(groupKeys);
        this.hiddenGroupRanks.clear();
        groupKeys.forEach(groupKey => this.userTouchedGroups.add(groupKey));
    }


    private showMaxOnlyLegendState(datasets: ChartDataset[], groupKeys: string[]): void {
        this.hiddenGroups.clear();
        this.hiddenGroupRanks.clear();
        groupKeys.forEach(groupKey => this.userTouchedGroups.add(groupKey));

        const maxRankByGroup = new Map<string, number>();
        datasets.forEach(dataset => {
            if (!dataset.groupKey || dataset.rankLevel === undefined) return;
            maxRankByGroup.set(dataset.groupKey, Math.max(maxRankByGroup.get(dataset.groupKey) || 0, dataset.rankLevel));
        });

        datasets.forEach(dataset => {
            if (!dataset.groupKey || dataset.rankLevel === undefined) return;
            if (dataset.rankLevel < (maxRankByGroup.get(dataset.groupKey) || dataset.rankLevel)) {
                this.hiddenGroupRanks.add(this.getGroupRankKey(dataset.groupKey, dataset.rankLevel));
            }
        });
    }


    private createEnchantLegend(datasets: ChartDataset[]): HTMLElement {
        const section = document.createElement('div');
        section.className = 'chart-legend-section';

        const title = document.createElement('div');
        title.className = 'chart-legend-title';
        title.textContent = 'Enchantments';

        const items = document.createElement('div');
        items.className = 'chart-legend-items';

        const groupMap = new Map<string, { sample: ChartDataset; ranks: Set<number> }>();
        datasets.forEach(dataset => {
            if (!dataset.groupKey) return;
            const group = groupMap.get(dataset.groupKey) || { sample: dataset, ranks: new Set<number>() };
            if (dataset.rankLevel !== undefined) group.ranks.add(dataset.rankLevel);
            groupMap.set(dataset.groupKey, group);
        });

        Array.from(groupMap.entries()).sort(([a], [b]) => a.localeCompare(b)).forEach(([groupKey, group]) => {
            const item = document.createElement('div');
            item.className = 'chart-legend-group';

            const groupButton = document.createElement('button');
            groupButton.type = 'button';
            groupButton.className = `chart-legend-item chart-legend-group-toggle${this.hiddenGroups.has(groupKey) ? ' is-hidden' : ''}`;

            const swatch = document.createElement('span');
            swatch.className = 'chart-legend-swatch';
            swatch.style.backgroundColor = group.sample.borderColor;

            const label = document.createElement('span');
            label.textContent = groupKey;

            groupButton.append(swatch, label);
            groupButton.addEventListener('click', () => {
                this.userTouchedGroups.add(groupKey);
                if (this.hiddenGroups.has(groupKey)) this.hiddenGroups.delete(groupKey);
                else this.hiddenGroups.add(groupKey);
                this.applyGroupVisibility();
                this.renderGroupedLegend(this.chart?.data.datasets as ChartDataset[] || []);
                this.chart?.update('none');
            });

            const rankItems = document.createElement('div');
            rankItems.className = 'chart-legend-rank-items';
            Array.from(group.ranks).sort((a, b) => a - b).forEach(rank => {
                const rankKey = this.getGroupRankKey(groupKey, rank);
                const rankButton = document.createElement('button');
                rankButton.type = 'button';
                rankButton.className = `chart-legend-rank-toggle${this.hiddenGroupRanks.has(rankKey) ? ' is-hidden' : ''}`;
                rankButton.textContent = RomanUtils.rankToRoman(rank, { I: 1, II: 2, III: 3, IV: 4, V: 5 });
                rankButton.addEventListener('click', () => {
                    if (this.hiddenGroupRanks.has(rankKey)) this.hiddenGroupRanks.delete(rankKey);
                    else this.hiddenGroupRanks.add(rankKey);
                    this.applyGroupVisibility();
                    this.renderGroupedLegend(this.chart?.data.datasets as ChartDataset[] || []);
                    this.chart?.update('none');
                });
                rankItems.append(rankButton);
            });

            item.append(groupButton, rankItems);
            items.append(item);
        });

        section.append(title, items);
        return section;
    }


    private createRankStyleLegend(datasets: ChartDataset[]): HTMLElement {
        const section = document.createElement('div');
        section.className = 'chart-legend-section';

        const title = document.createElement('div');
        title.className = 'chart-legend-title';
        title.textContent = 'Level line styles';

        const items = document.createElement('div');
        items.className = 'chart-legend-items';

        const ranks = Array.from(new Set(datasets.map(dataset => dataset.rankLevel).filter((rank): rank is number => rank !== undefined))).sort((a, b) => a - b);
        ranks.forEach(rank => {
            const sampleDataset = datasets.find(dataset => dataset.rankLevel === rank);
            const item = document.createElement('div');
            item.className = 'chart-legend-item';

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'chart-style-sample');
            svg.setAttribute('viewBox', '0 0 34 4');
            svg.setAttribute('aria-hidden', 'true');

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', '1');
            line.setAttribute('x2', '33');
            line.setAttribute('y1', '2');
            line.setAttribute('y2', '2');
            line.setAttribute('stroke', sampleDataset?.borderColor || '#ccc');
            line.setAttribute('stroke-width', '2');
            line.setAttribute('stroke-linecap', 'round');
            if (sampleDataset?.borderDash && sampleDataset.borderDash.length > 0) {
                line.setAttribute('stroke-dasharray', sampleDataset.borderDash.join(' '));
            }
            svg.append(line);

            const label = document.createElement('span');
            label.textContent = RomanUtils.rankToRoman(rank, { I: 1, II: 2, III: 3, IV: 4, V: 5 });

            item.append(svg, label);
            items.append(item);
        });

        section.append(title, items);
        return section;
    }


    private shouldShowTooltipItem(item: TooltipItem): boolean {
        const value = item.parsed?.y || 0;
        return value >= TOOLTIP_GROUPING_CONFIG.minValuePercent;
    }


    private shouldGroupTooltip(items: TooltipItem[]): boolean {
        return TOOLTIP_GROUPING_CONFIG.mode === 'group-overflow'
            && items.filter(item => this.shouldShowTooltipItem(item)).length > TOOLTIP_GROUPING_CONFIG.maxDetailedItems;
    }


    private getGroupedTooltipLines(items: TooltipItem[]): string[] {
        if (!this.shouldGroupTooltip(items)) return [];

        const totals = new Map<string, number>();
        items.filter(item => this.shouldShowTooltipItem(item)).forEach(item => {
            const label = item.dataset?.groupKey || item.dataset?.label || 'Other';
            totals.set(label, (totals.get(label) || 0) + (item.parsed?.y || 0));
        });

        return Array.from(totals.entries())
            .sort(([, a], [, b]) => b - a)
            .slice(0, TOOLTIP_GROUPING_CONFIG.maxDetailedItems)
            .map(([label, value]) => `${label}: ${value.toFixed(2)}%`);
    }


    private getDetailedTooltipLabel(item: TooltipItem, dataPoints: TooltipItem[]): string | string[] {
        if (this.shouldGroupTooltip(dataPoints)) return [];

        const label = item.dataset?.label || '';
        const value = item.formattedValue || `${(item.parsed?.y || 0).toFixed(2)}%`;
        return `${label}: ${value}%`;
    }


    private getChartOptions(): Record<string, unknown> {
        const manager = this;

        return {
            responsive: true, maintainAspectRatio: false,
            animation: false, // Performance: Disable animations to enable Path2D caching
            spanGaps: true,   // Performance: Avoid line segmentation
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: {
                    beginAtZero: true,
                    min: 0,
                    max: 100,
                    grid: { color: 'rgba(255,255,255,0.05)' }
                },
                x: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { maxTicksLimit: 30 } // Show all 30 levels if space permits
                }
            },

            plugins: {
                tooltip: {
                    filter: (item: TooltipItem) => this.shouldShowTooltipItem(item),
                    itemSort: (a: TooltipItem, b: TooltipItem) => (b.parsed?.y || 0) - (a.parsed?.y || 0),
                    callbacks: {
                        beforeBody: (items: TooltipItem[]) => this.getGroupedTooltipLines(items),
                        label(this: { dataPoints?: TooltipItem[] }, item: TooltipItem) {
                            return manager.getDetailedTooltipLabel(item, this.dataPoints || []);
                        }
                    }
                },
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#ccc',
                        font: { size: 10 },
                        boxWidth: 10,
                        filter: (legendItem: { datasetIndex?: number }, data: { datasets?: ChartDataset[] }) => {
                            const datasetIndex = legendItem.datasetIndex;
                            if (datasetIndex === undefined) return true;
                            return !data.datasets?.[datasetIndex]?.groupKey;
                        }
                    },
                    onClick: (_event: unknown, legendItem: { datasetIndex?: number }, legend: { chart: ChartInstance }) => {
                        const datasetIndex = legendItem.datasetIndex;
                        if (datasetIndex === undefined) return;

                        const clickedDataset = legend.chart.data.datasets[datasetIndex] as ChartDataset | undefined;
                        const groupKey = clickedDataset?.groupKey;
                        if (!groupKey) {
                            legend.chart.setDatasetVisibility(datasetIndex, !legend.chart.isDatasetVisible(datasetIndex));
                            legend.chart.update('none');
                            return;
                        }

                        const groupedIndexes = (legend.chart.data.datasets as ChartDataset[])
                            .map((dataset, index) => dataset.groupKey === groupKey ? index : -1)
                            .filter(index => index >= 0);
                        const shouldHide = groupedIndexes.some(index => legend.chart.isDatasetVisible(index));
                        groupedIndexes.forEach(index => {
                            legend.chart.setDatasetVisibility(index, !shouldHide);
                        });
                        legend.chart.update('none');
                    }
                }
            }
        };
    }
}
