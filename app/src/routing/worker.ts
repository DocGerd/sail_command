import {
  createHandler,
  createSolverHandler,
  type SolverInitRequest,
  type WorkerRequest,
} from './protocol';

const handler = createHandler((m) => self.postMessage(m));
const solverHandler = createSolverHandler((m) => self.postMessage(m));
self.onmessage = (e: MessageEvent<WorkerRequest | SolverInitRequest>) => {
  if (e.data.type === 'init-solver') solverHandler(e.data);
  else handler(e.data);
};
