import { EnchantEngine } from '#engine/index.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { WorkerRequest, RunId, ChartUpdateResponse, RunAcceptedResponse, RunTerminalResponse, WorkerReadyResponse } from '#types/index.js';
import { SearchStateSnapshotFactory } from '#engine/snapshot/SearchStateSnapshotFactory.js';
import { getParamsForMode } from '#core/config.js';

let engine: EnchantEngine | null = null;
let currentRunId: RunId | null = null;
let currentAbortController: AbortController | null = null;

const workerScope = self as any;

workerScope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  try {
    if (msg.type === 'init') {
      engine = EngineFactory.create(DATA, msg.version);
      const ready: WorkerReadyResponse = {
        type: 'ready',
        requestId: msg.requestId,
        worker: 'chart',
        version: msg.version
      };
      workerScope.postMessage(ready);
      return;
    }

    if (!engine) {
      throw new Error("Worker not initialized");
    }

    if (msg.type === 'chartRunStart') {
      const { requestId, runId, input, refinement } = msg;
      
      // Supersession check
      if (currentRunId === runId) return;
      currentRunId = runId;

      // Abort previous run if active
      if (currentAbortController) {
        currentAbortController.abort();
      }
      currentAbortController = new AbortController();
      const signal = currentAbortController.signal;

      // Notify UI that run is accepted
      const accepted: RunAcceptedResponse = {
        type: 'runAccepted',
        requestId,
        worker: 'chart',
        runId,
        input,
        state: 'calculating',
        message: 'worker-handoff'
      };
      workerScope.postMessage(accepted);

      const isBook = input.category === 'book';

      try {
        for (const level of refinement) {
          if (signal.aborted) break;

          const params = getParamsForMode(level, isBook);
          const xpCap = engine.registry.mechanics.xp_cap || 30;

          for (let xp = 1; xp <= xpCap; xp++) {
            if (signal.aborted) break;

            const result = await engine.calculateTop(input.category, xp, input.material, {
              clue: input.clue,
              threshold: params.threshold,
              maxIterations: params.limit,
              signal
            });

            // Double check supersession after async call
            if (currentRunId !== runId) return;

            const cell = SearchStateSnapshotFactory.create(
              engine.registry,
              result.tracker,
              result.combos,
              {
                snapshotType: 'chart-cell',
                input: { ...input, xpLevel: xp },
                refinementLevel: level,
                clue: input.clue
              }
            );

            const response: ChartUpdateResponse = {
              type: 'chartUpdate',
              worker: 'chart',
              runId,
              passId: level as any,
              refinementLevel: level,
              progress: {
                passId: level as any,
                refinementLevel: level,
                completedXpLevels: xp,
                totalXpLevels: xpCap
              },
              cell: cell as any
            };

            workerScope.postMessage(response);
          }
        }

        // Terminal message
        if (currentRunId === runId) {
          const terminal: RunTerminalResponse = {
            type: 'terminal',
            worker: 'chart',
            runId,
            status: 'done'
          };
          workerScope.postMessage(terminal);
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || err.message === 'Aborted') return;
        throw err;
      }
    }
  } catch (err: any) {
    workerScope.postMessage({ 
      type: 'error', 
      worker: 'chart', 
      runId: currentRunId as any, 
      error: err.message 
    });
  }
};
