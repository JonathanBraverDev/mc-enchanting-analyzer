import { WorkerShell } from '#worker/WorkerShell.js';
import {
    WorkerRequest,
    TopUpdateResponse,
    RunAcceptedResponse,
    SearchResult,
    RefinementLevelName,
    TopInputSignature,
    RequestId,
    RunId,
    RegistryState
} from '#types/index.js';
import { SnapshotService } from '#services/SnapshotService.js';
import { getSearchCheckpointForRefinement } from '#core/config.js';
import { ClueValidator } from '#core/clue.js';

const workerScope = self as any;
const shell = new WorkerShell('top', workerScope);

interface CachedTopCheckpoint {
    refinementLevel: RefinementLevelName;
    result: SearchResult;
}

interface CachedTopRun {
    baseKey: string;
    checkpoints: CachedTopCheckpoint[];
}

let latestTopRun: CachedTopRun | null = null;

shell.onRun = async (msg: WorkerRequest, engine, signal) => {
    if (msg.type === 'topRunProject') {
        const { requestId, runId, input, refinementLevels } = msg;
        const baseKey = getProjectionBaseKey(input, refinementLevels);

        if (input.clue) {
            ClueValidator.validate(engine.registry, input.item, input.clue);
        }

        if (!latestTopRun || latestTopRun.baseKey !== baseKey || latestTopRun.checkpoints.length === 0) {
            throw new Error('No compatible cached top result is available for target projection.');
        }

        postAccepted(requestId, runId, input);

        for (const cached of latestTopRun.checkpoints) {
            if (signal.aborted || shell.runId !== runId) return;
            postTopSnapshot(runId, engine.registry, input, cached.refinementLevel, cached.result);
        }
        return;
    }

    if (msg.type !== 'topRunStart') return;

    const { requestId, runId, input, refinementLevels } = msg;
    const isBook = input.item === 'book';
    const baseKey = getProjectionBaseKey(input, refinementLevels);
    const cachedCheckpoints: CachedTopCheckpoint[] = [];

    postAccepted(requestId, runId, input);

    // Upfront clue validation
    if (input.clue) {
        ClueValidator.validate(engine.registry, input.item, input.clue);
    }

    const checkpoints = refinementLevels.map(level => getSearchCheckpointForRefinement(level, isBook));

    await engine.searchSequentialCheckpoints({
        item: input.item,
        xp: input.xpLevel,
        material: input.material,
        checkpoints,
        onCheckpointComplete: (result, checkpointIndex) => {
            if (signal.aborted || shell.runId !== runId) return;

            const level = refinementLevels[checkpointIndex]!;
            cachedCheckpoints[checkpointIndex] = { refinementLevel: level, result };
            latestTopRun = {
                baseKey,
                checkpoints: cachedCheckpoints.filter(Boolean)
            };
            postTopSnapshot(runId, engine.registry, input, level, result);
        },
        clue: input.clue,
        signal
    });
};

function getProjectionBaseKey(input: TopInputSignature, refinementLevels: RefinementLevelName[]): string {
    return JSON.stringify({
        version: input.version,
        item: input.item,
        material: input.material,
        xpLevel: input.xpLevel,
        clue: input.clue,
        refinementLevels
    });
}

function postAccepted(requestId: RequestId, runId: RunId, input: TopInputSignature): void {
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
}

function postTopSnapshot(
    runId: RunId,
    registry: RegistryState,
    input: TopInputSignature,
    refinementLevel: RefinementLevelName,
    result: SearchResult
): void {
    const view = SnapshotService.create(
        registry,
        result.snapshot,
        {
            snapshotType: 'top',
            input,
            refinementLevel,
            clue: input.clue
        }
    );

    const response: TopUpdateResponse = {
        type: 'topUpdate',
        worker: 'top',
        runId,
        refinementLevel,
        view: view as any
    };

    workerScope.postMessage(response);
}

workerScope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
    await shell.dispatchEvent(e);
};
