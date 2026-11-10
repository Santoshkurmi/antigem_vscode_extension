// Read-only: builds (does NOT send) the JetboxWriteState that "sandbox off" would send, and diffs it field by field.
import { GrpcClient } from '../src/core/agy/grpc';
import { rawFields, patchMessage, lengthDelimited } from '../src/core/agy/proto';
const [port, csrf] = process.argv.slice(2);
const client = new GrpcClient({ baseUrl: `http://127.0.0.1:${port}`, headers: () => ({ 'x-codeium-csrf-token': csrf }) });
const ac = new AbortController();
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
client.serverStream('/exa.language_server_pb.LanguageServerService/JetboxSubscribeToState', new Uint8Array(0), (buf) => {
  const uc = rawFields(buf).find((f) => f.id === 3)!.payload!;
  const ucFields = rawFields(uc);
  const settings = ucFields.find((f) => f.id === 2)!.payload!;
  const patched = patchMessage('JetboxState_UserSettings', settings, { enable_terminal_sandbox: false });
  const before = new Map(rawFields(settings).map((f) => [f.id, hex(f.bytes)]));
  const after = new Map(rawFields(patched).map((f) => [f.id, hex(f.bytes)]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(id) !== after.get(id)) console.log(`field #${id}: ${before.get(id) ?? '(none)'} → ${after.get(id) ?? '(none)'}`);
  }
  console.log('unchanged fields:', [...before.keys()].filter((id) => before.get(id) === after.get(id)).join(','));
  const others = ucFields.filter((f) => f.id !== 2).map((f) => f.bytes);
  const req = lengthDelimited(3, Buffer.concat([...others, lengthDelimited(2, patched)].map((b) => Buffer.from(b))));
  console.log('request bytes', req.length, '(user_config was', uc.length, ') — not sent');
  ac.abort();
  process.exit(0);
}, ac.signal).catch((e) => { console.error('ERR', e.message); process.exit(1); });
