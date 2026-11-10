// Read-only probe of a running agy hub: node dist/probe.js <port> <csrf>
import { GrpcClient } from '../src/core/agy/grpc';
import { HubRpc } from '../src/core/agy/proto';

const [port, csrf, convId] = process.argv.slice(2);
const rpc = new HubRpc(new GrpcClient({ baseUrl: `http://127.0.0.1:${port}`, headers: () => ({ 'x-codeium-csrf-token': csrf }) }));

(async () => {
  const t0 = Date.now();
  const models = await rpc.call('GetAvailableModels', {});
  const m = models.response?.models ?? {};
  console.log('models:', Object.keys(m).length, 'in', Date.now() - t0, 'ms; sample:', Object.entries(m).slice(0, 3).map(([k, v]: any) => `${k} → ${v.model} "${v.display_name}"`));
  console.log('sorts:', JSON.stringify(models.response?.agent_model_sorts?.[0]?.groups?.map((g: any) => g.model_ids)).slice(0, 200));
  const ac = new AbortController();
  let frames = 0;
  await rpc.stream('JetboxSubscribeToSummaries', {}, (msg: any) => {
    frames++;
    const ups = Object.entries(msg.updates ?? {});
    console.log('summaries frame', frames, 'updates', ups.length, 'deletes', (msg.deletes ?? []).length);
    for (const [id, s] of ups.slice(0, 3) as any) console.log('  ', id, s.status, s.step_count, JSON.stringify(s.annotations?.title ?? s.summary)?.slice(0, 60), s.trajectory_metadata?.workspace_uris);
    ac.abort();
  }, ac.signal);
  if (convId) {
    const ac2 = new AbortController();
    await rpc.stream('StreamAgentStateUpdates', { conversation_id: convId, subscriber_id: 'probe-' + Date.now(), trajectory_verbosity: 2 }, (msg: any) => {
      const u = msg.update ?? {};
      const su = u.main_trajectory_update?.steps_update;
      console.log('state frame: status', u.status, 'fully_idle', u.fully_idle, 'steps', su?.steps?.length, 'indices0', su?.indices?.[0], 'total', su?.total_length);
      const types = (su?.steps ?? []).map((s: any) => s.type?.replace('CORTEX_STEP_TYPE_', '')).slice(0, 12);
      console.log('  step types:', types.join(','));
      ac2.abort();
    }, ac2.signal);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
