import { GrpcClient } from '../src/core/agy/grpc';
import { HubRpc } from '../src/core/agy/proto';
import { TrajectoryEngine } from '../src/core/agy/trajectory';
const [port, csrf, convId] = process.argv.slice(2);
const rpc = new HubRpc(new GrpcClient({ baseUrl: `http://127.0.0.1:${port}`, headers: () => ({ 'x-codeium-csrf-token': csrf }) }));
(async () => {
  const eng = new TrajectoryEngine();
  eng.reset(convId);
  const ac = new AbortController();
  await rpc.stream('StreamAgentStateUpdates', { conversation_id: convId, subscriber_id: 'probe-' + Date.now(), trajectory_verbosity: 2 }, (msg: any) => {
    eng.ingestAgentStateUpdate(msg.update ?? {});
    const msgs = eng.toChatMessages(convId);
    for (const m of msgs) console.log(m.role, m.id, JSON.stringify(m.content).slice(0, 110), m.toolCalls.map((t) => `${t.toolType}:${t.status}:${t.command.slice(0, 30)}`).join(' | '), m.tokenUsage ? `tok=${m.tokenUsage.outputTokens} ${m.tokenUsage.model}` : '');
    const again = eng.toChatMessages(convId);
    console.log('stable identity on 2nd call:', again.every((m, i) => m === msgs[i]), 'running', eng.isRunning);
    ac.abort();
  }, ac.signal);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
