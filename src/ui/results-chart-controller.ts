import { ChartManager } from '#ui/results-chart-manager.js';
import { RegistryState, SweepData } from '#types/index.js';
import { UI_DEFAULTS } from '#core/config.js';

/**
 * Manages the results chart UI, coordinating between the canvas manager and metric selector.
 * Bridges XP level sweep data and chart rendering.
 */
export class ChartController {
    public manager: ChartManager | null;
    private metricEl: HTMLSelectElement | null;

    /**
     * Initializes the chart controller with DOM element references.
     * @param canvasId ID of the canvas element for Chart.js.
     * @param metricId ID of the metric selector dropdown.
     */
    constructor(canvasId: string, metricId: string) {
        this.manager = new ChartManager(canvasId);
        this.metricEl = document.getElementById(metricId) as HTMLSelectElement;
    }

    /**
     * Updates the chart with data from a sweep (multiple XP levels).
     * Regenerates datasets based on the currently selected metric.
     * @param sweep Aggregated results across XP levels.
     * @param registry Registry context for enchantment data lookups.
     */
    public refresh(sweep: SweepData[], registry: RegistryState): void {
        if (sweep.length > 0 && this.manager && this.metricEl) {
            const metric = this.metricEl.value;
            const datasets = this.manager.generateDatasets(sweep, metric, registry);
            const xpCap = registry.mechanics.xp_cap || UI_DEFAULTS.DEFAULT_VIEW_XP_CAP;
            const labels = Array.from({length: xpCap}, (_, i) => i + 1);
            this.manager.update(labels, datasets);
        }
    }

    /**
     * Gets the currently selected metric from the dropdown.
     * @returns The metric key (e.g., "count", "rarity").
     */
    public getMetric(): string {
        return this.metricEl?.value || "count";
    }
}
