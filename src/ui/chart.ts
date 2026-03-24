import { ChartManager } from './chart-manager.js';
import { Registry } from '../core/registry.js';
import { UI_DEFAULTS } from '../core/config.js';

export class ChartController {
    public manager: ChartManager | null;
    private metricEl: HTMLSelectElement | null;

    constructor(canvasId: string, metricId: string) {
        this.manager = new ChartManager(canvasId);
        this.metricEl = document.getElementById(metricId) as HTMLSelectElement;
    }

    public refresh(sweep: any[], registry: Registry): void {
        if (sweep.length > 0 && this.manager && this.metricEl) {
            const metric = this.metricEl.value;
            const datasets = this.manager.generateDatasets(sweep, metric, registry);
            const labels = Array.from({length: UI_DEFAULTS.MAX_XP_LEVEL}, (_, i) => i + 1);
            this.manager.update(labels, datasets);
        }
    }

    public getMetric(): string {
        return this.metricEl?.value || "count";
    }
}
