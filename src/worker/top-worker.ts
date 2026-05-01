import { WorkerShell } from '#worker/WorkerShell.js';
import {
    WorkerRequest,
    TopUpdateResponse,
    RunAcceptedResponse,
} from '#types/index.js';
import { SnapshotService } from '#services/SnapshotService.js';
import { getSearchCheckpointForRefinement } from '#core/config.js';
import { ClueValidator } from '#core/clue.js';

const workerScope = self as any;
const shell = new WorkerShell('top', workerScope);

shell.onRun = async (msg: WorkerRequest, engine, signal) => {
    if (msg.type !== 'topRunStart') return;

    const { requestId, runId, input, refinementLevels } = msg;
    const isBook = input.category === 'book';

    // Notify UI that run is accepted
    const accepted: RunAcceptedResponse = {
        type: 'runAccepted',
        requestId,
        worker: 'top',
        runId,
        input,
        state: 'calculating',
        message: 'worker-handoff'
    };
    workerScope.postMessage(accepted);

    // Upfront clue validation
    if (input.clue) {
        ClueValidator.validate(engine.registry, input.category, input.clue);
    }

    const checkpoints = refinementLevels.map(level => getSearchCheckpointForRefinement(level, isBook));

    await engine.searchSequentialCheckpoints(
        input.category,
        input.xpLevel,
        input.material,
        checkpoints,
        (result, checkpointIndex) => {
            if (signal.aborted || shell.runId !== runId) return;

            const level = refinementLevels[checkpointIndex]!;

            const view = SnapshotService.create(
                engine.registry,
                result.tracker,
                result.combos,
                {
                    snapshotType: 'top',
                    input,
                    refinementLevel: level,
                    clue: input.clue
                },
                result.frontiers
            );

            const response: TopUpdateResponse = {
                type: 'topUpdate',
                worker: 'top',
                runId,
                refinementLevel: level,
                view: view as any
            };

            workerScope.postMessage(response);
        },
        { clue: input.clue, signal }
    );
};

workerScope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
    await shell.dispatch(e.data);
};
