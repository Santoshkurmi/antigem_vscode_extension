// Dev only: with `?mock` in a normal browser, pretend to be a VS Code webview. acquireVsCodeApi() is defined before
// host.ts loads, so host.ts takes its VS Code path unchanged (postMessage out, window 'message' events in) and never
// opens the dev-server WebSocket. The fake host itself (dev/mock.ts) is a separate chunk, loaded only here.
import type { HostToView, ViewToHost } from '@shared/protocol';

const g = globalThis as any;
if (typeof g.acquireVsCodeApi !== 'function' && new URLSearchParams(location.search).has('mock')) {
  const queue: ViewToHost[] = [];
  let handle: ((m: ViewToHost) => void) | null = null;
  import('./mock').then(({ startMock }) => {
    handle = startMock((msg: HostToView) => window.postMessage(msg, '*'));
    for (const m of queue.splice(0)) handle(m);
  });
  g.acquireVsCodeApi = () => ({
    postMessage: (m: ViewToHost) => (handle ? handle(m) : queue.push(m)),
    getState: () => {
      try {
        return JSON.parse(localStorage.getItem('antigem-mock-state') ?? 'null');
      } catch {
        return undefined;
      }
    },
    setState: (s: unknown) => {
      try {
        localStorage.setItem('antigem-mock-state', JSON.stringify(s));
      } catch {
        /* ignore */
      }
    },
  });
}
