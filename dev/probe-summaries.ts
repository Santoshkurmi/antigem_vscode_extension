// Read-only: counts chats, sub-agents and cloud chats in the hub's summaries.  node dist/probe-summaries.js <port> <csrf>
import { GrpcClient } from '../src/core/agy/grpc';
import { HubRpc } from '../src/core/agy/proto';
const [port, csrf] = process.argv.slice(2);
const rpc = new HubRpc(new GrpcClient({ baseUrl: `http://127.0.0.1:${port}`, headers: () => ({ 'x-codeium-csrf-token': csrf }) }));
const ac = new AbortController();
rpc.stream('JetboxSubscribeToSummaries', {}, (msg: any) => {
  const ups = Object.entries<any>(msg.updates ?? {});
  const subs = ups.filter(([, s]) => s.trajectory_metadata?.parent_conversation_id);
  const cloud = ups.filter(([, s]) => s.cloud);
  console.log('chats', ups.length, 'sub-agents', subs.length, 'cloud', cloud.length);
  const fs = require('node:fs');
  const dir = `${process.env.HOME}/.gemini/${process.argv[4] ?? 'antigravity-ide'}/conversations`;
  const has = ups.filter(([id]) => fs.existsSync(`${dir}/${id}.db`) || fs.existsSync(`${dir}/${id}.pb`));
  console.log('with stored trajectory (openable):', has.length, 'missing:', ups.length - has.length);
  for (const [, s] of subs.slice(0, 5)) console.log('  sub:', s.trajectory_metadata?.subagent_spec?.role || s.trajectory_metadata?.subagent_spec?.type_name || '?', '|', String(s.annotations?.title ?? s.summary).slice(0, 50), '| depth', s.trajectory_metadata?.nesting_depth);
  ac.abort();
  process.exit(0);
}, ac.signal).catch((e) => { console.error('ERR', e.message); process.exit(1); });
