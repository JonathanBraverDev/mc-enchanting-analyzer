import { EnchantEngine } from '#engine/index.js';
import { EngineFactory } from '#engine/factory.js';
import { DATA } from '#data/index.js';
import { 
  WorkerRequest, 
  RunId, 
  ChartUpdateResponse, 
  RunAcceptedResponse, 
  RunTerminalResponse, 
  WorkerReadyResponse,
  WorkerErrorResponse,
  PassId
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
      
      // Abort previous run if active
      if (currentRunId && currentRunId !== runId) {
        if (currentAbortController) {
          currentAbortController.abort();
        }
        const superseded: RunTerminalResponse = {
          type: 'terminal',
          worker: 'chart',
          runId: currentRunId,
          status: 'superseded'
        };
        workerScope.postMessage(superseded);
      }

      currentRunId = runId;
      currentAbortController = new AbortController();
      const signal = currentAbortController.signal;

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
          refinement: refinement.map((level, i) => ({
            refinementLevel: level,
            label: level.toUpperCase(),
            order: i
          }))
        }
      };
      workerScope.postMessage(accepted);

      const isBook = input.category === 'book';

      try {
        // Upfront clue validation (Correction 5)
        if (input.clue) {
          ClueValidator.validate(engine.registry, input.category, input.clue);
        }

        for (const level of refinement) {
          if (signal.aborted) break;

          const params = getParamsForMode(level, isBook);
          const passId = `pass_${level}` as PassId;

          for (let xp = 1; xp <= xpCap; xp++) {
            if (signal.aborted || currentRunId !== runId) break;

            const result = await engine.calculateTop(input.category, xp, input.material, {
              clue: input.clue,
              threshold: params.threshold,
              maxIterations: params.limit,
              signal
            });

            if (signal.aborted || currentRunId !== runId) break;

            // NOTE: Projection logic will be updated in Phase 3 for authoritative masses
            const cell = SearchStateSnapshotFactory.create(
              engine.registry,
              result.tracker,
              result.combos,
              {
                snapshotType: 'chart-cell',
                input: { ...input, xpLevel: xp },
                refinementLevel: level,
                clue: input.clue
              },
              result // authoritative masses
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

        // Terminal message
        if (currentRunId === runId && !signal.aborted) {
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
    const errorMsg: WorkerErrorResponse = { 
      type: 'error', 
      worker: 'chart', 
      runId: currentRunId as any, 
      error: err.message 
    };
    workerScope.postMessage(errorMsg);
    
    if (currentRunId) {
      const terminal: RunTerminalResponse = {
        type: 'terminal',
        worker: 'chart',
        runId: currentRunId,
        status: 'error',
        error: err.message
      };
      workerScope.postMessage(terminal);
    }
  }
};
