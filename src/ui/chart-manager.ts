import { ThemeManager } from './theme.js';
import { Registry } from '../core/registry.js';
import { CalculationStats } from '../core/types.js';
import { RomanUtils } from '../utils/index.js';
import { ENGINE_DEFAULTS } from '../core/config.js';

declare const Chart: any;

interface ChartDataset {
    label: string;
    data: number[];
    borderColor: string;
    backgroundColor: string;
    borderWidth: number;
    tension: number;
    pointRadius: number;
    borderDash?: number[];
}

/**
 * Encapsulates Chart.js lifecycle and data mapping.
 */
export class ChartManager {
    public chart: any = null;
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


    public generateDatasets(sweep: { l: number, s: CalculationStats }[], metric: string, registry: Registry): ChartDataset[] {
        const datasets: ChartDataset[] = [];
        const romanMap = registry.data.constants.ROMAN_MAP;

        if (metric === "any") {
            const allEnchants = new Set<number>();
            sweep.forEach(x => { if(x && x.s) Object.keys(x.s.any).forEach(idStr => allEnchants.add(parseInt(idStr))); });

            Array.from(allEnchants).sort((a,b) => registry.getEnchantName(a).localeCompare(registry.getEnchantName(b))).forEach(id => {
                const name = registry.getEnchantName(id);
                const color = ThemeManager.getEnchantColor(name, registry);
                datasets.push({
                    label: name,
                    data: sweep.map(x => (x && x.s && x.s.any[id] || 0) * 100),
                    borderColor: color,
                    backgroundColor: color.replace(')', ', 0.1)'),
                    borderWidth: 2, tension: 0.1, pointRadius: 0
                });
            });
        } else if (metric === "ranks") {
            const allRanks = new Set<number>();
            sweep.forEach(e => { if(e && e.s) Object.entries(e.s.ranks).forEach(([idAndRankStr, p]) => { if (p > 0.01) allRanks.add(parseInt(idAndRankStr)); }); });
            
            Array.from(allRanks).sort((a, b) => {
                const na = registry.getFullEnchantName(a), nb = registry.getFullEnchantName(b);
                const ba = RomanUtils.getBaseName(na, romanMap), bb = RomanUtils.getBaseName(nb, romanMap);
                if (ba !== bb) return ba.localeCompare(bb);
                return (a & 0xFF) - (b & 0xFF);
            }).slice(0, 32).forEach(idAndRank => {
                const fullName = registry.getFullEnchantName(idAndRank);
                const color = ThemeManager.getEnchantColor(idAndRank, registry);
                datasets.push({
                    label: fullName,
                    data: sweep.map(x => (x && x.s && x.s.ranks[idAndRank] || 0) * 100),
                    borderColor: color,
                    backgroundColor: color.replace(')', ', 0.1)'),
                    borderWidth: 2, tension: 0.1, pointRadius: 0
                });
            });
        } else {
            const max = ENGINE_DEFAULTS.MAX_ENCHANTS_PER_ITEM || 6;
            for (let c = 1; c <= max; c++) {
                const maxInSweep = Math.max(...sweep.map(x => x && x.s ? (x.s.count[c] || 0) : 0));
                if (maxInSweep < 0.005) continue;

                const hue = (c - 1) * (140 / (max - 1 || 1));
                const color = `hsl(${hue}, 70%, 50%)`;
                
                datasets.push({
                    label: `${c} Enchant${c > 1 ? 's' : ''}`,
                    data: sweep.map(x => (x && x.s && x.s.count[c] || 0) * 100),
                    borderColor: color,
                    backgroundColor: color.replace(')', ', 0.1)'),
                    borderWidth: 2, tension: 0.1, pointRadius: 0
                });
            }

            // Optional: Total Capture line to show we hit 100%
            const captureData = sweep.map(x => {
                if (!x || !x.s) return 0;
                const base = Object.values(x.s.count).reduce((a, b) => a + b, 0);
                return (base + (x.s.uncertainty || 0)) * 100;
            });

            if (captureData.some(d => d < 99.9)) {
                datasets.push({
                    label: "Total Accounted (incl. Uncertain)",
                    data: captureData,
                    borderColor: "rgba(255,255,255,0.3)",
                    backgroundColor: "transparent",
                    borderWidth: 1, 
                    borderDash: [5, 5],
                    tension: 0.1, 
                    pointRadius: 0
                });
            }
        }
        return datasets;
    }


    private getChartOptions(): any {
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
                    labels: { color: '#ccc', font: { size: 10 }, boxWidth: 10 } 
                } 
            }
        };
    }
}
