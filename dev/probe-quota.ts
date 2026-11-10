// Read-only: raw RetrieveUserQuotaSummary buckets.  node dist/probe-quota.js <port> <csrf>
import { GrpcClient } from '../src/core/agy/grpc';
import { HubRpc } from '../src/core/agy/proto';
const [port, csrf] = process.argv.slice(2);
const rpc = new HubRpc(new GrpcClient({ baseUrl: `http://127.0.0.1:${port}`, headers: () => ({ 'x-codeium-csrf-token': csrf }) }));
rpc.call('RetrieveUserQuotaSummary', { force_refresh: false }).then((r: any) => {
  for (const g of r.response?.groups ?? []) {
    console.log('GROUP', JSON.stringify(g.display_name));
    for (const b of g.buckets ?? []) console.log('   bucket', JSON.stringify({ id: b.bucket_id, name: b.display_name, window: b.window, remaining: b.remaining_fraction, disabled: b.disabled, reset: b.reset_time?.seconds }));
  }
  process.exit(0);
}).catch((e) => { console.error(e.message); process.exit(1); });
