// Read-only: print lines of a chat's messages containing a pattern.  node dist/probe-find.js <port> <csrf> <conv> <regex>
import { GrpcClient } from '../src/core/agy/grpc';
import { HubRpc } from '../src/core/agy/proto';
import { TrajectoryEngine } from '../src/core/agy/trajectory';
const [port, csrf, convId, pat] = process.argv.slice(2);
const rpc = new HubRpc(new GrpcClient({ baseUrl: `http://127.0.0.1:${port}`, headers: () => ({ 'x-codeium-csrf-token': csrf }) }));
const eng = new TrajectoryEngine();
eng.reset(convId);
const ac = new AbortController();
rpc.stream('StreamAgentStateUpdates', { conversation_id: convId, subscriber_id: 'find-' + Date.now(), trajectory_verbosity: 2 }, (msg: any) => {
  eng.ingestAgentStateUpdate(msg.update ?? {});
  const re = new RegExp(pat);
  for (const m of eng.toChatMessages(convId)) {
    const lines = m.content.split('\n');
    lines.forEach((l, i) => { if (re.test(l)) console.log(m.id, i, JSON.stringify(lines.slice(Math.max(0, i - 1), i + 2).join('\n'))); });
  }
  ac.abort();
  process.exit(0);
}, ac.signal).catch((e) => { console.error(e.message); process.exit(1); });
