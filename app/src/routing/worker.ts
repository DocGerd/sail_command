import { createHandler, type WorkerRequest } from './protocol';

const handler = createHandler((m) => self.postMessage(m));
self.onmessage = (e: MessageEvent<WorkerRequest>) => handler(e.data);
