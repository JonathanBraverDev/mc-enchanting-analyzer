import { ThemeManager } from '#ui/theme.js';
import { getEnchantName, getFullEnchantName } from '#core/registry.js';
import { ChartCellView, ChartDataset, RegistryState } from '#types/index.js';
import { RomanUtils } from '#utils/index.js';
import { ENGINE_LIMITS } from '#constants/engine.js';

interface ChartInstance {
    chartArea: { bottom: number; left: number; right: number; top: number };
    data: { labels: unknown[]; datasets: unknown[] };
    destroy(): void;
    scales: { x?: { getValueForPixel(pixel: number): number } };
    update(mode: string): void;
}
interface ChartPointerEvent {
    x?: number;
    y?: number;
}
interface ChartConstructor {
    new(ctx: CanvasRenderingContext2D | null, config: Record<string, unknown>): ChartInstance;
}
declare const Chart: ChartConstructor;


/**
 * Encapsulates Chart.js lifecycle and data mapping.
 */
export class ChartManager {
    private chart: ChartInstance | null = null;
    get chartInstance(): ChartInstance | null { return this.chart; }
    private canvas: HTMLCanvasElement | null = null;
    private onLevelSelect: ((level: number) => void) | null = null;
    private readonly handleCanvasMouseMove = (event: MouseEvent): void => {
        if (!this.canvas || !this.chart || !this.onLevelSelect) return;

        const bounds = this.canvas.getBoundingClientRect();
        const pointer = {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top
        };
        this.canvas.style.cursor = this.isInChartArea(pointer, this.chart) ? 'pointer' : '';
    };
    private readonly handleCanvasMouseLeave = (): void => {
        if (this.canvas) this.canvas.style.cursor = '';
    };

    constructor(canvasId: string, onLevelSelect?: (level: number) => void) {
        this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
        this.onLevelSelect = onLevelSelect || null;
        this.canvas?.addEventListener('mousemove', this.handleCanvasMouseMove);
        this.canvas?.addEventListener('mouseleave', this.handleCanvasMouseLeave);
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
                    backgroundColor: color.replace(')', ', 0.1)'),
                    borderWidth: 2, tension: 0.1, pointRadius: 0
                });
            });
        } else if (metric === "ranks") {
            const allRanks = new Set<number>();
            sweep.forEach(e => {
                if(e && e.buckets && e.buckets.rankByIdAndRank) {
                    Object.entries(e.buckets.rankByIdAndRank).forEach(([idAndRankStr, p]) => {
                        if (p > 0.01) allRanks.add(parseInt(idAndRankStr));
                    });
                }
            });

            Array.from(allRanks).sort((a, b) => {
                const na = getFullEnchantName(registry, a), nb = getFullEnchantName(registry, b);
                const ba = RomanUtils.getBaseName(na, romanMap), bb = RomanUtils.getBaseName(nb, romanMap);
                if (ba !== bb) return ba.localeCompare(bb);
                return (a & 0xFF) - (b & 0xFF);
            }).slice(0, 32).forEach(idAndRank => {
                const fullName = getFullEnchantName(registry, idAndRank);
                const color = ThemeManager.getEnchantColor(idAndRank, registry);
                datasets.push({
                    label: fullName,
                    data: sweep.map(x => (x && x.buckets && x.buckets.rankByIdAndRank[idAndRank] || 0) * 100),
                    borderColor: color,
                    backgroundColor: color.replace(')', ', 0.1)'),
                    borderWidth: 2, tension: 0.1, pointRadius: 0
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
                    backgroundColor: color.replace(')', ', 0.1)'),
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
            onClick: (event: ChartPointerEvent, _elements: unknown[], chart: ChartInstance) => this.handleChartClick(event, chart),
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
                    labels: { color: '#ccc', font: { size: 10 }, boxWidth: 10 }
                }
            }
        };
    }


    private handleChartClick(event: ChartPointerEvent, chart: ChartInstance): void {
        if (!this.onLevelSelect || event.x === undefined || event.y === undefined) return;

        if (!this.isInChartArea(event, chart)) return;

        const xScale = chart.scales.x;
        if (!xScale) return;

        const rawIndex = xScale.getValueForPixel(event.x);
        const index = Math.round(rawIndex);
        const label = chart.data.labels[index];
        const rawLevel = label === undefined ? index + 1 : Number(label);
        if (!Number.isFinite(rawLevel)) return;

        const numericLabels = chart.data.labels.map(Number).filter(Number.isFinite);
        const minLevel = Math.min(...numericLabels);
        const maxLevel = Math.max(...numericLabels);
        const level = Math.max(minLevel, Math.min(maxLevel, Math.round(rawLevel)));

        this.onLevelSelect(level);
    }

    private isInChartArea(event: ChartPointerEvent, chart: ChartInstance): boolean {
        if (event.x === undefined || event.y === undefined) return false;

        const { left, right, top, bottom } = chart.chartArea;
        return event.x >= left && event.x <= right && event.y >= top && event.y <= bottom;
    }
}
