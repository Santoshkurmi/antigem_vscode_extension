// Headless test client for the dev server: node dist/client.js <mode> [arg]
import WebSocket from 'ws';
const [mode, arg] = process.argv.slice(2);
const ws = new WebSocket('ws://127.0.0.1:5199');
const send = (m: any) => ws.send(JSON.stringify(m));
const msgs = new Map<string, any>();
let order: string[] = [];
let convs: any[] = [];
let streaming = false;
let opened = false;
let sent = false;
let sawStreaming = false;
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
ws.on('open', () => send({ type: 'ready' }));
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'agents') console.log(el(), 'agents', m.agents.map((a: any) => `${a.kind}:${a.state}${a.detail ? `(${a.detail})` : ''}`).join(' '));
  if (m.type === 'models') console.log(el(), 'models', m.state.agent, m.state.models.length, 'selected', m.state.selectedId);
  if (m.type === 'conversations') {
    convs = m.conversations;
    if (!opened && convs.length && mode === 'open') {
      opened = true;
      const c = arg ? convs.find((x) => x.id === arg) : convs[0];
      console.log(el(), 'conversations', convs.length, '→ open', c.id, JSON.stringify(c.title));
      send({ type: 'openConversation', id: c.id });
    }
  }
  if (m.type === 'agents' && mode === 'send' && !sent && m.agents.find((a: any) => a.kind === 'AGY')?.state === 'online') {
    sent = true;
    const id = require('node:crypto').randomUUID();
    console.log(el(), 'send new chat', id);
    send({ type: 'send', conversationId: id, isNew: true, agent: 'AGY', text: arg ?? 'Reply with exactly: OK', attachments: [], modelId: null, workspaceUri: null });
  }
  if (m.type === 'toast') console.log(el(), 'TOAST', m.level, m.message);
  if (m.type === 'chat') {
    const p = m.patch;
    if (p.reset) { msgs.clear(); order = []; }
    if (p.order) order = p.order;
    for (const u of p.upserts ?? []) msgs.set(u.id, u);
    if (p.isStreaming !== undefined) { streaming = p.isStreaming; if (streaming) sawStreaming = true; }
    const keys = Object.keys(p).filter((k) => !['upserts', 'order'].includes(k));
    console.log(el(), 'chat', m.conversationId?.slice(0, 8), 'upserts', (p.upserts ?? []).length, p.order ? `order=${p.order.length}` : '', keys.map((k) => `${k}=${JSON.stringify(p[k])?.slice(0, 50)}`).join(' '));
    if (mode === 'open' && order.length && !p.reset) { dump(); process.exit(0); }
    if (mode === 'send' && sawStreaming && !streaming && order.length >= 2) { dump(); console.log('CONV', m.conversationId); process.exit(0); }
  }
});
function dump() {
  for (const id of order) {
    const x = msgs.get(id);
    console.log('  ', x.role, JSON.stringify(x.content).slice(0, 140), x.toolCalls.map((t: any) => `${t.toolType}:${t.status}`).join(','), x.isStreaming ? '(streaming)' : '');
  }
}
setTimeout(() => { console.log('TIMEOUT'); dump(); process.exit(1); }, Number(process.env.T ?? 90000));
