import { WorkerShell } from '#worker/WorkerShell.js';
import {
    WorkerRequest,
    ChartUpdateResponse,
    RunAcceptedResponse,
    PassId
} from '#types/index.js';
import { SnapshotService } from '#services/SnapshotService.js';
import { getSearchCheckpointForRefinement } from '#core/config.js';
import { ClueValidator } from '#core/clue.js';

const workerScope = self as any;
const shell = new WorkerShell('chart', workerScope);

shell.onRun = async (msg: WorkerRequest, engine, signal) => {
    if (msg.type !== 'chartRunStart') return;

    const { requestId, runId, input, refinementLevels } = msg;
    const isBook = input.item === 'book';
    const xpCap = engine.registry.mechanics.xp_cap || 30;

    // Notify UI that run is accepted
    const accepted: RunAcceptedResponse = {
        type: 'runAccepted',
        requestId,
        worker: 'chart',
        runId,
        input,
        state: 'calculating',
        message: 'worker-handoff',
        chart: {
            input,
            maxXpLevel: xpCap,
            refinement: refinementLevels.map((level, i) => ({
                refinementLevel: level,
                label: level.toUpperCase(),
                order: i
            }))
        }
    };
    workerScope.postMessage(accepted);

    // Upfront clue validation
    if (input.clue) {
        ClueValidator.validate(engine.registry, input.item, input.clue);
    }

    for (const level of refinementLevels) {
        if (signal.aborted) break;

        const params = getSearchCheckpointForRefinement(level, isBook);
        const passId = `pass_${level}` as PassId;

        for (let xp = 1; xp <= xpCap; xp++) {
            if (signal.aborted || shell.runId !== runId) break;

            const result = await engine.searchToCheckpoint({
                item: input.item,
                xp,
                material: input.material,
                clue: input.clue,
                threshold: params.threshold,
                maxIterations: params.limit,
                signal
            });

            if (signal.aborted || shell.runId !== runId) break;

            const cell = SnapshotService.create(
                engine.registry,
                result.snapshot,
                {
                    snapshotType: 'chart-cell',
                    input: { ...input, xpLevel: xp },
                    refinementLevel: level,
                    clue: input.clue,
                    includeCombos: false
                }
            );

            const response: ChartUpdateResponse = {
                type: 'chartUpdate',
                worker: 'chart',
                runId,
                passId,
                refinementLevel: level,
                progress: {
                    passId,
                    refinementLevel: level,
                    completedXpLevels: xp,
                    totalXpLevels: xpCap
                },
                cell: cell as any
            };

            workerScope.postMessage(response);
        }
    }
};

workerScope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
    await shell.dispatchEvent(e);
};
