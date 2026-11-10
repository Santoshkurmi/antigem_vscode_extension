// Headless check of settings / commands / quota: node dist/settings-client.js
import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:5199');
const send = (m: any) => ws.send(JSON.stringify(m));
const pages = ['root', 'agy.permissions', 'agy.mcp', 'agy.skills', 'agy.cli', 'slash', 'context'];
let i = 0;
let step = 0;
const show = (p: any) => {
  console.log(`\n=== page ${p.id}: ${p.title}`);
  for (const s of p.sections) {
    console.log(`  [${s.title}]${s.agent ? ' (' + s.agent + ')' : ''}${s.description ? ' — ' + s.description.slice(0, 60) : ''}`);
    for (const it of s.items) {
      const extra =
        it.kind === 'list' ? `${it.rows.length} rows: ${it.rows.slice(0, 4).map((r: any) => `${r.title}${r.status ? `[${r.status}]` : ''}`).join(', ')}` :
        it.kind === 'quota' ? it.groups.map((g: any) => `${g.name}: ${g.windows.map((w: any) => `${w.label} ${(w.remaining * 100).toFixed(1)}% ${w.resetText ?? ''}`).join(' | ')}`).join(' ; ') :
        it.kind === 'select' ? `= ${it.value} (${it.options.map((o: any) => o.value).join('/')})` :
        it.kind === 'toggle' ? `= ${it.value}` : it.kind === 'info' ? `= ${it.value}` : it.kind === 'page' ? `→ ${it.id}${it.badge ? ' (' + it.badge + ')' : ''}` : it.kind === 'text' ? `(${String(it.value).length} chars)` : '';
      console.log(`    ${it.kind.padEnd(6)} ${it.label}: ${extra}`);
    }
  }
};
ws.on('open', () => send({ type: 'ready' }));
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'agents' && step === 0 && m.agents[0].state === 'online') {
    step = 1;
    setTimeout(() => { send({ type: 'requestCommands', agent: 'AGY' }); send({ type: 'requestModels', agent: 'AGY' }); send({ type: 'requestSettings', page: pages[i] }); }, 3000);
  }
  if (m.type === 'commands') console.log('commands', m.agent, m.commands.length, m.commands.slice(0, 6).map((c: any) => `${c.command}(${c.kind})`).join(' '));
  if (m.type === 'models' && m.state.groups?.length) console.log('models', m.state.models.length, 'refreshing', m.state.refreshing, 'groups', m.state.groups.map((g: any) => g.name).join(', '), '| sample pills:', m.state.models.slice(0, 4).map((x: any) => `${x.displayName}=${x.quotaText}`).join(', '));
  if (m.type === 'toast') console.log('TOAST', m.level, m.message);
  if (m.type === 'settings') {
    if (m.page.id !== pages[i]) return;
    show(m.page);
    i++;
    if (i < pages.length) send({ type: 'requestSettings', page: pages[i] });
    else if (step === 1) {
      step = 2;
      // custom command round trip (dev store only)
      send({ type: 'settingAction', page: 'slash', id: 'commands', actionId: 'add', values: { name: 'zz-test', description: 'test', expansion: 'Say: $ARGUMENTS' } });
      setTimeout(() => send({ type: 'requestCommands', agent: 'AGY' }), 400);
      setTimeout(() => send({ type: 'settingAction', page: 'slash', id: 'commands', rowId: 'zz-test', actionId: 'delete' }), 800);
      setTimeout(() => process.exit(0), 1500);
    }
  }
});
setTimeout(() => { console.log('TIMEOUT at page', pages[i]); process.exit(1); }, 60000);
