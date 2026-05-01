import { EnchantEngine } from '#engine/index.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { 
  WorkerRequest, 
  RunId, 
  TopUpdateResponse, 
  RunAcceptedResponse, 
  RunTerminalResponse, 
  WorkerReadyResponse, 
  WorkerErrorResponse 
} from '#types/index.js';
import { SearchStateSnapshotFactory } from '#engine/snapshot/SearchStateSnapshotFactory.js';
import { getParamsForMode } from '#core/config.js';
import { ClueValidator } from '#core/clue.js';

let engine: EnchantEngine | null = null;
let currentRunId: RunId | null = null;
let currentAbortController: AbortController | null = null;

const workerScope = self as any;

workerScope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  try {
    if (msg.type === 'init') {
      if (msg.data) {
        (globalThis as any).ENCHANTING_DATA = msg.data;
      }
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
      
      // Abort previous run if active
      if (currentRunId && currentRunId !== runId) {
        if (currentAbortController) {
          currentAbortController.abort();
        }
        const superseded: RunTerminalResponse = {
          type: 'terminal',
          worker: 'top',
          runId: currentRunId,
          status: 'superseded'
        };
        workerScope.postMessage(superseded);
      }

      currentRunId = runId;
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
        // Upfront clue validation (Correction 5)
        if (input.clue) {
          ClueValidator.validate(engine.registry, input.category, input.clue);
        }

        const tiers = refinement.map(level => getParamsForMode(level, isBook));
        
        await engine.calculateTiered(
          input.category,
          input.xpLevel,
          input.material,
          tiers,
          (result, tierIndex) => {
            if (signal.aborted || currentRunId !== runId) return;

            const level = refinement[tierIndex]!;
            
            const view = SearchStateSnapshotFactory.create(
              engine!.registry,
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
          {
            clue: input.clue,
            signal
          }
        );

        // Terminal message
        if (currentRunId === runId && !signal.aborted) {
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
    const errorMsg: WorkerErrorResponse = { 
      type: 'error', 
      worker: 'top', 
      runId: currentRunId as any, 
      error: err.message 
    };
    workerScope.postMessage(errorMsg);
    
    if (currentRunId) {
      const terminal: RunTerminalResponse = {
        type: 'terminal',
        worker: 'top',
        runId: currentRunId,
        status: 'error',
        error: err.message
      };
      workerScope.postMessage(terminal);
    }
  }
};
