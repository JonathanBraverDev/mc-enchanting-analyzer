import { ThemeManager } from '#ui/theme.js';
import { getEnchantName, getFullEnchantName } from '#core/registry.js';
import { ChartCellView, ChartDataset, RegistryState } from '#types/index.js';
import { RomanUtils } from '#utils/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

interface ChartInstance {
    data: { labels: unknown[]; datasets: unknown[] };
    destroy(): void;
    hide(datasetIndex: number): void;
    isDatasetVisible(datasetIndex: number): boolean;
    show(datasetIndex: number): void;
    update(mode: string): void;
}
interface ChartConstructor {
    new(ctx: CanvasRenderingContext2D | null, config: Record<string, unknown>): ChartInstance;
}
declare const Chart: ChartConstructor;

const MAX_RANK_DATASETS = 32;

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

    constructor(canvasId: string) {
        this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
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
            this.chart.update('none'); // 'none' for performance during rapid updates
            return;
        }

        try {
            this.chart = new Chart(this.canvas.getContext("2d"), {
                type: 'line',
                data: { labels, datasets },
                options: this.getChartOptions()
            });
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

            const selectedRanks: RankDatasetCandidate[] = [];
            Array.from(groups.values()).sort((a, b) => {
                const peakDelta = Math.max(...b.map(candidate => candidate.peak)) - Math.max(...a.map(candidate => candidate.peak));
                if (peakDelta !== 0) return peakDelta;
                return a[0]!.baseName.localeCompare(b[0]!.baseName);
            }).forEach(group => {
                const sortedGroup = group.sort((a, b) => a.rank - b.rank);
                if (selectedRanks.length > 0 && selectedRanks.length + sortedGroup.length > MAX_RANK_DATASETS) return;
                selectedRanks.push(...sortedGroup);
            });

            selectedRanks.forEach(({ idAndRank, baseName }) => {
                const fullName = getFullEnchantName(registry, idAndRank);
                const style = ThemeManager.getRankLineStyle(idAndRank, registry);
                datasets.push({
                    label: fullName,
                    groupKey: baseName,
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


    private getChartOptions(): Record<string, unknown> {
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
                legend: {
                    position: 'bottom',
                    labels: { color: '#ccc', font: { size: 10 }, boxWidth: 10 },
                    onClick: (_event: unknown, legendItem: { datasetIndex?: number }, legend: { chart: ChartInstance }) => {
                        const datasetIndex = legendItem.datasetIndex;
                        if (datasetIndex === undefined) return;

                        const clickedDataset = legend.chart.data.datasets[datasetIndex] as ChartDataset | undefined;
                        const groupKey = clickedDataset?.groupKey;
                        if (!groupKey) {
                            if (legend.chart.isDatasetVisible(datasetIndex)) legend.chart.hide(datasetIndex);
                            else legend.chart.show(datasetIndex);
                            return;
                        }

                        const groupedIndexes = (legend.chart.data.datasets as ChartDataset[])
                            .map((dataset, index) => dataset.groupKey === groupKey ? index : -1)
                            .filter(index => index >= 0);
                        const shouldHide = groupedIndexes.some(index => legend.chart.isDatasetVisible(index));
                        groupedIndexes.forEach(index => {
                            if (shouldHide) legend.chart.hide(index);
                            else legend.chart.show(index);
                        });
                    }
                }
            }
        };
    }
}
