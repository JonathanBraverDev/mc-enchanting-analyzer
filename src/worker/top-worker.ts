import { EnchantEngine } from '#engine/index.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { WorkerRequest, RunId, TopUpdateResponse, RunAcceptedResponse, RunTerminalResponse, WorkerReadyResponse } from '#types/index.js';
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
        worker: 'top',
        version: msg.version
      };
      workerScope.postMessage(ready);
      return;
    }

    if (!engine) {
      throw new Error("Worker not initialized");
    }

    if (msg.type === 'topRunStart') {
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
        worker: 'top',
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
          const result = await engine.calculateTop(input.category, input.xpLevel, input.material, {
            clue: input.clue,
            threshold: params.threshold,
            maxIterations: params.limit,
            signal
          });

          // Double check supersession after async call
          if (currentRunId !== runId) return;

          // Project into TopRunView
          const view = SearchStateSnapshotFactory.create(
            engine.registry,
            result.tracker,
            result.combos,
            {
              snapshotType: 'top',
              input,
              refinementLevel: level,
              clue: input.clue
            }
          );

          const response: TopUpdateResponse = {
            type: 'topUpdate',
            worker: 'top',
            runId,
            refinementLevel: level,
            view: view as any
          };

          workerScope.postMessage(response);
        }

        // Terminal message
        if (currentRunId === runId) {
          const terminal: RunTerminalResponse = {
            type: 'terminal',
            worker: 'top',
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
      worker: 'top', 
      runId: currentRunId as any, 
      error: err.message 
    });
  }
};
