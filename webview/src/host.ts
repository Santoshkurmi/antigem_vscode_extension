// The only bridge between the UI and the outside world.
// In VS Code: the webview postMessage channel. In a normal browser (dev): a WebSocket to dev/server.ts,
// which runs the same host-side code as the extension. The UI never calls the network itself.
import type { HostToView, ViewToHost } from '@shared/protocol';

type Listener = (msg: HostToView) => void;

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const listeners = new Set<Listener>();
const emit = (msg: HostToView) => listeners.forEach((l) => l(msg));

export const isVsCode = typeof (globalThis as any).acquireVsCodeApi === 'function';

let sendImpl: (msg: ViewToHost) => void;
let getStateImpl: () => unknown = () => undefined;
let setStateImpl: (s: unknown) => void = () => {};

if (isVsCode) {
  const api = acquireVsCodeApi();
  sendImpl = (m) => api.postMessage(m);
  getStateImpl = () => api.getState();
  setStateImpl = (s) => api.setState(s);
  window.addEventListener('message', (e) => emit(e.data as HostToView));
} else {
  // Dev mode in a browser tab: talk to dev/server.ts.
  const url = (import.meta as any).env?.VITE_DEV_HOST ?? 'ws://127.0.0.1:5199';
  let ws: WebSocket | null = null;
  let outbox: ViewToHost[] = [];
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      const pending = outbox;
      outbox = [];
      pending.forEach((m) => ws!.send(JSON.stringify(m)));
    };
    ws.onmessage = (e) => emit(JSON.parse(e.data as string));
    ws.onclose = () => setTimeout(connect, 1000);
  };
  connect();
  sendImpl = (m) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    else outbox.push(m);
  };
  getStateImpl = () => {
    try {
      return JSON.parse(localStorage.getItem('antigem-view-state') ?? 'null');
    } catch {
      return undefined;
    }
  };
  setStateImpl = (s) => {
    try {
      localStorage.setItem('antigem-view-state', JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };
}

export const host = {
  send: (msg: ViewToHost) => sendImpl(msg),
  onMessage: (l: Listener) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Small per-view UI state that survives the webview being hidden (drawer open, filter…). */
  getState: <T>() => getStateImpl() as T | undefined,
  setState: (s: unknown) => setStateImpl(s),
};
