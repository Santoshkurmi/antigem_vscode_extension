// Offline test of Crew packages (docs/crew/PLAN.md §14, src/core/crew/packages): the YAML subset (edge cases, errors
// with line numbers, round trips), the AntiGem package format (parse / serialize round trip, lenient inputs, limits),
// secret redaction, the import plan (name dedupe, access cap, MCP off, paused automations), export (no secrets, no
// chats), OpenMausBot imports (the real fixtures from ~/agy_cli_hub/research/OpenMausBot when present, plus small
// hand-written BotMRR and JSON samples) and GitHub links with a fake fetch. No network, no files written.
//   npx esbuild dev/test-packages.ts --bundle --platform=node --outfile=<tmp>/t.js && node <tmp>/t.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeBot, normalizeRoom } from '../src/core/crew/store/store';
import { parsePackage, serializePackage, PACKAGE_LIMITS, type CrewPackage } from '../src/core/crew/packages/format';
import { fetchPackageText, githubCandidates, PACKAGE_FILE_NAMES } from '../src/core/crew/packages/github';
import { detectFormat, fromOpenMaus, readPackage } from '../src/core/crew/packages/openmaus';
import { exportCrew, planImport, redactSecrets } from '../src/core/crew/packages/plan';
import { parseYaml, stringifyYaml, YamlError } from '../src/core/crew/packages/yaml';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 800)}` : ''}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function throws(fn: () => unknown, re: RegExp): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return re.test(msg) ? msg : `wrong error: ${msg}`;
  }
}
const yamlLine = (text: string) => {
  try {
    parseYaml(text);
    return 0;
  } catch (e) {
    return e instanceof YamlError ? e.line : -1;
  }
};

// ------------------------------------------------------------------------------------------------ YAML

function testYaml() {
  console.log('YAML');
  const doc = parseYaml(`# a comment
name: Ada   # trailing comment
count: 3
ratio: -1.5e2
on: true
off: False
none: ~
empty:
time: 09:00
version: 1.0.0
url: https://x.dev/a#b
hash: a#b
list:
- one
- "two: 2"
- 'it''s'
nested:
  deep:
    - a: 1
      b: [x, "y, z", 3]
    - - inner
      - more
flow: {k: v, n: null, l: [1, {m: 2}]}
multi: [a,
  b, # comment
  c]
`) as any;
  check('maps, lists at the key indent, scalars, comments', doc.name === 'Ada' && doc.count === 3 && doc.ratio === -150 && doc.on === true && doc.off === false && doc.none === null && doc.empty === null, doc);
  check('09:00 and 1.0.0 stay text, # inside words is text', doc.time === '09:00' && doc.version === '1.0.0' && doc.url === 'https://x.dev/a#b' && doc.hash === 'a#b');
  check('quoted strings', same(doc.list, ['one', 'two: 2', "it's"]), doc.list);
  check('maps in lists, flow lists, nested lists', same(doc.nested, { deep: [{ a: 1, b: ['x', 'y, z', 3] }, ['inner', 'more']] }), doc.nested);
  check('flow maps and a flow list over three lines', same(doc.flow, { k: 'v', n: null, l: [1, { m: 2 }] }) && same(doc.multi, ['a', 'b', 'c']), [doc.flow, doc.multi]);

  const blocks = parseYaml(`lit: |
  line one
    indented

  after blank
strip: |-
  no newline
keep: |+
  two newlines

fold: >
  folded
  text

  new para
indicator: |2
    starts with spaces
plain: this plain text
  goes on here

  and a new line
dq: "esc \\"q\\" \\t tab \\u00e9 \\x41 \\U0001F600
  folded"
sq: 'one
  two'
`) as any;
  check('| keeps lines, blank and indented ones', blocks.lit === 'line one\n  indented\n\nafter blank\n', JSON.stringify(blocks.lit));
  check('|- strips, |+ keeps the newlines', blocks.strip === 'no newline' && blocks.keep === 'two newlines\n\n', [blocks.strip, blocks.keep]);
  check('> folds lines, blank lines become line breaks', blocks.fold === 'folded text\nnew para\n', JSON.stringify(blocks.fold));
  check('|2 keeps leading spaces', blocks.indicator === '  starts with spaces\n', JSON.stringify(blocks.indicator));
  check('multi-line plain text folds', blocks.plain === 'this plain text goes on here\nand a new line', JSON.stringify(blocks.plain));
  check('double-quoted escapes and folding, single quotes over lines', blocks.dq === 'esc "q" \t tab é A 😀 folded' && blocks.sq === 'one two', [blocks.dq, blocks.sq]);

  check('a tab indent names its line', yamlLine('a:\n\tb: 1') === 2);
  check('bad indentation names its line', yamlLine('a: 1\n  b: 2\nc: 3') === 2);
  check('an unclosed quote names where it starts', yamlLine('a: 1\nb: "open\nc: 2') === 2);
  check('a duplicate key names its line', yamlLine('a: 1\nb: 2\na: 3') === 3);
  check('an unclosed [ names where it starts', yamlLine('x: 1\ny: [a, b\nz: 2') === 2);
  check('anchors and aliases are refused', yamlLine('a: &x 1\nb: *x') === 1);
  check('a list item among keys is refused', yamlLine('a: 1\n- b') === 2);
  check('text after a quoted value is refused', yamlLine('a: "x" y') === 1);
  check('an empty document is null', parseYaml('# nothing\n') === null);
  const proto = parseYaml('__proto__:\n  polluted: true\n') as any;
  check('__proto__ is a plain key, nothing polluted', ({} as any).polluted === undefined && Object.keys(proto).includes('__proto__'));

  const tricky = {
    plain: 'Hello world',
    colon: 'a: b',
    hash: 'x #y',
    lead: '  spaced',
    trail: 'end ',
    empty: '',
    words: ['true', 'null', '123', '1.0', '09:00', 'yes', 'no', '~', '-x', '[a]', '{b}', '*star', '&amp', '!bang', '@at', '%p', '`tick`', '"q"', "'s'", '#h', '|', '>', '? q', 'a:'],
    nl: 'one\ntwo\n',
    nl0: 'one\ntwo',
    nl2: 'one\n\n',
    onlyNl: '\n',
    lines: '  indented first\nsecond\n',
    blanks: '\n\nafter blanks',
    spaces: 'a\n   \nb',
    tabs: '\tt\n\tu',
    ctrl: 'bell\x07 cr\r\nlf',
    unicode: 'café 🤖 ✍️ 日本',
    numbers: [0, -1, 3.25, 1e21, 1e-7],
    flags: [true, false, null],
    emptyList: [],
    emptyMap: {},
    deep: [[['x']], [{ a: [{ b: 'c' }] }], [[]]],
    'key with: colon': 1,
    '': 'empty key',
    '123': 'numeric key',
    soul: '# Role\n\nYou are **Ada**.\n\n---\n\n- bullet: with colon\n  - nested # not a comment\n',
  };
  const text = stringifyYaml(tricky);
  const back = parseYaml(text);
  check('the writer round-trips tricky values', same(back, tricky), { text: text.slice(0, 1500), back });
  check('the writer round-trips a top-level list and a scalar', same(parseYaml(stringifyYaml([1, 'a', { b: 2 }])), [1, 'a', { b: 2 }]) && parseYaml(stringifyYaml('x\ny\n')) === 'x\ny\n');

  const fixtures = path.join(os.homedir(), 'agy_cli_hub/research/OpenMausBot/shared/package-fixtures');
  const full = path.join(fixtures, 'full-team.v2.json');
  if (fs.existsSync(full)) {
    const json = JSON.parse(fs.readFileSync(full, 'utf8'));
    check('the writer round-trips the OpenMausBot full-team fixture', same(parseYaml(stringifyYaml(json)), json));
  } else console.log('  - (OpenMausBot fixtures not found: skipped)');
}

// ------------------------------------------------------------------------------------------------ package format

const SAMPLE = `---
antigem-crew: 1
name: Feature squad
tagline: Plan, build, test and review one feature.
outcomes:
  - A merged feature with tests.
requirements:
  mcp:
    - name: github
      reason: Open pull requests.
      url: https://api.example.com/mcp
    - name: browser
      reason: Check the page.
      command: npx -y @example/browser-mcp
chief: Ada
bots:
  - name: Ada
    title: Planner
    description: Splits the work.
    emoji: 🧭
    color: '#8B5CF6'
    engine: claude
    model: sonnet
    access: read
    aliases: [plan, planner]
    seedMemory:
      - The team ships on Fridays.
    soul: |
      You plan.
      Keep it short.
  - name: Bo
    title: Coder
    emoji: 💻
    color: teal
    engine: Codex
    access: full
    soul: You write code.
rooms:
  - name: Squad
    members: [Ada, '@Bo']
    lead: Ada
    mode: lead
    bulletin: Tests before review.
playbooks:
  - name: Ship
    text: Branch, build, test, PR.
automations:
  - name: Morning check
    bot: Bo
    when: daily 09:00 mon-fri
    room: Squad
    instructions: Run the tests and report failures.
---

# Feature squad

Run it like this.
`;

function testFormat() {
  console.log('Package format');
  const { pkg, warnings } = parsePackage(SAMPLE);
  check('parses without warnings', warnings.length === 0, warnings);
  check('name, tagline, outcomes, chief', pkg.name === 'Feature squad' && pkg.tagline.startsWith('Plan') && pkg.outcomes.length === 1 && pkg.chief === 'Ada');
  const [ada, bo] = pkg.bots;
  check('bot fields', ada.soul === 'You plan.\nKeep it short.' && ada.engine === 'CLAUDE' && ada.model === 'sonnet' && ada.access === 'read' && same(ada.aliases, ['plan', 'planner']) && ada.chief === true && same(ada.seedMemory, ['The team ships on Fridays.']), ada);
  check('engine names and named colors are understood', bo.engine === 'CODEX' && bo.color === '#01A492' && bo.access === 'full' && bo.chief === undefined, bo);
  check('rooms resolve @names', same(pkg.rooms[0], { name: 'Squad', members: ['Ada', 'Bo'], bulletin: 'Tests before review.', lead: 'Ada', mode: 'lead' }), pkg.rooms[0]);
  check('requirements keep url / command', pkg.requirements.mcp[0].url === 'https://api.example.com/mcp' && pkg.requirements.mcp[1].command === 'npx -y @example/browser-mcp');
  check('automations and playbooks', same(pkg.automations[0], { name: 'Morning check', bot: 'Bo', when: 'daily 09:00 mon-fri', instructions: 'Run the tests and report failures.', room: 'Squad' }) && pkg.playbooks[0].text.startsWith('Branch'));
  check('the body is the prose after the frontmatter', pkg.body === '# Feature squad\n\nRun it like this.\n', JSON.stringify(pkg.body));

  const text = serializePackage(pkg);
  const again = parsePackage(text);
  check('serialize → parse gives the same package', same(again.pkg, pkg) && again.warnings.length === 0, { text, again });
  check('serialize is stable', serializePackage(again.pkg) === text);
  check('the file starts with the marker', text.startsWith('---\nantigem-crew: 1\nname: Feature squad\n'));

  const lenient = parsePackage(`---
antigem-crew: 1
bots:
  - Solo
  - name: Solo
    color: blue-ish
    engine: gpt
    access: admin
    voice: deep
  - title: no name
  - name: Lou
    chief: true
  - name: Max
    chief: true
rooms:
  - name: R
    members: [Solo, Ghost]
    lead: Ghost
    mode: chaos
  - name: Empty
    members: [Nobody]
automations:
  - name: A
    bot: Ghost
    when: hourly
    instructions: x
  - name: B
    bot: Lou
    when: every 30m
    instructions: y
    room: Nowhere
requirements:
  - name: svc
    url: https://user:pw@mcp.example.com/x?token=abc&team=1
    env: { API_KEY: secret }
  - name: tool
    command: [node, "my server.js"]
    args: [--port, 3000]
  - name: both
    url: https://a.example.com
    command: run-it
extra: 1
---
# Lenient crew
`);
  const lp = lenient.pkg;
  const w = lenient.warnings.join('\n');
  check('a missing name comes from the first heading', lp.name === 'Lenient crew' && /no name/.test(w));
  check('bots: a plain string is a bot, duplicates renamed, nameless left out', same(lp.bots.map((b) => b.name), ['Solo', 'Solo 2', 'Lou', 'Max']) && /second is now Solo 2/.test(w) && /Bot 3 has no name/.test(w), lp.bots.map((b) => b.name));
  check('bad color / engine / access fall back with warnings', lp.bots[1].color.startsWith('#') && lp.bots[1].engine === undefined && lp.bots[1].access === undefined && /engine "gpt"/.test(w) && /access "admin"/.test(w) && /color "blue-ish"/.test(w) && /"voice"/.test(w));
  check('several chief marks: the first wins', lp.chief === 'Lou' && lp.bots.filter((b) => b.chief).length === 1 && /Several bots are marked chief/.test(w));
  check('rooms: unknown members and leads dropped, empty rooms left out', lp.rooms.length === 1 && same(lp.rooms[0].members, ['Solo']) && lp.rooms[0].lead === undefined && lp.rooms[0].mode === undefined && /Ghost/.test(w) && /Empty has no members/.test(w), lp.rooms);
  check('automations: unknown bot dropped, unknown room dropped', lp.automations.length === 1 && lp.automations[0].room === undefined && /posts to Lou's chat/.test(w), lp.automations);
  const [svc, tool, both] = lp.requirements.mcp;
  check('requirements: credentials leave the url, env dropped', svc.url === 'https://mcp.example.com/x?team=1' && /dropped env/.test(w) && /credentials were taken out/.test(w), svc);
  check('requirements: command lists and args are joined', tool.command === 'node "my server.js" --port 3000', tool);
  check('requirements: url wins over command', both.url === 'https://a.example.com' && both.command === undefined && /both a url and a command/.test(w));
  check('unknown top-level fields are named', /Ignored the field "extra"/.test(w));

  const many = { 'antigem-crew': 1, name: 'Big', bots: Array.from({ length: 45 }, (_, i) => ({ name: `B${i}`, soul: i === 0 ? 'é'.repeat(20_000) : 'x' })), rooms: Array.from({ length: 25 }, (_, i) => ({ name: `R${i}`, members: ['B1'] })) };
  const big = parsePackage(`---\n${stringifyYaml(many)}---\n`);
  check('at most 40 bots and 20 rooms are kept', big.pkg.bots.length === 40 && big.pkg.rooms.length === 20 && /first 40 of 45 bots/.test(big.warnings.join()) && /first 20 of 25 rooms/.test(big.warnings.join()));
  const soulBytes = Buffer.byteLength(big.pkg.bots[0].soul, 'utf8');
  check('a soul over 24 KB is cut on a character boundary', soulBytes <= 24 * 1024 && soulBytes > 24 * 1024 - 2 && !big.pkg.bots[0].soul.includes('\uFFFD') && /soul was cut/.test(big.warnings.join()), soulBytes);

  check('no frontmatter is refused', !!throws(() => parsePackage('# just markdown'), /no YAML frontmatter/));
  check('another frontmatter is refused', !!throws(() => parsePackage('---\ntitle: x\n---\n'), /antigem-crew: 1/));
  check('a newer version is refused with a clear message', !!throws(() => parsePackage('---\nantigem-crew: 2\nbots: [A]\n---\n'), /newer AntiGem/));
  const yamlErr = throws(() => parsePackage('\n---\nantigem-crew: 1\nbots:\n  - name: "x\n---\n'), /line 5/);
  check('a YAML error names the file line', !!yamlErr && !yamlErr.startsWith('wrong'), yamlErr);
  check('a package without bots is refused', !!throws(() => parsePackage('---\nantigem-crew: 1\nname: x\n---\n'), /no bots/));
  check('more than 4 MB is refused', !!throws(() => parsePackage('---\nantigem-crew: 1\n---\n' + 'x'.repeat(PACKAGE_LIMITS.bytes)), /larger than 4 MB/));
}

// ------------------------------------------------------------------------------------------------ secrets

function testRedaction() {
  console.log('Redaction');
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----';
  const text = [
    'openai sk-proj-abcdefghijklmnopqrstuvwx and github ghp_abcdefghijklmnopqrstuvwxyz0123',
    'slack xoxb-1234567890-abcdefghij aws AKIAABCDEFGHIJKLMNOP',
    'password=hunter22! and "api_key": "abc123def456"',
    'my token is 9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    'Authorization: Bearer abcdefghijklmnop123',
    'run --token s3cr3t-value now',
    'api key: Zx9Yw8Vu7Ts6Rq5Po4Nm3L',
    pem,
  ].join('\n');
  const r = redactSecrets(text);
  check('every secret shape is found', r.count === 11, { count: r.count, text: r.text });
  check('no secret value is left', !/sk-proj|ghp_|xoxb|AKIA|hunter22|abc123def456|9f8e7d6c|abcdefghijklmnop123|s3cr3t|Zx9Yw8|MIIEow/.test(r.text), r.text);
  check('names stay, values go', r.text.includes('password=[redacted]!') && r.text.includes('"api_key": "[redacted]"') && r.text.includes('Bearer [redacted]') && r.text.includes('[redacted private key]'), r.text);
  const twice = redactSecrets(r.text);
  check('redaction is idempotent', twice.count === 0 && twice.text === r.text, twice);
  const prose = 'Never ask for a password: required by policy. The secret ingredient is love. Use token: $GITHUB_TOKEN or {api_key}. Keyboard shortcuts help. The key point is speed.';
  check('prose and placeholders are left alone', redactSecrets(prose).count === 0, redactSecrets(prose));
}

// ------------------------------------------------------------------------------------------------ import plan + export

function testPlan() {
  console.log('Import plan');
  const pkg = parsePackage(`---
antigem-crew: 1
name: Team
chief: Package Scout
requirements:
  mcp:
    - name: crm
      reason: Deals.
      url: https://mcp.example.com/crm
    - name: shell
      reason: Local tools.
      command: run --token abcdef123456 now
bots:
  - name: Ada
    access: full
    soul: Use key sk-ant-abcdefghijklmnopqrstuv please.
    seedMemory: ['wifi password=Sunny-Day-42']
  - name: Package Scout
    access: talk
  - name: All
    access: read
  - name: Ada Lovelace
    access: auto
  - name: AdaLovelace
rooms:
  - name: Desk
    members: [Ada, Package Scout, All]
    lead: Package Scout
automations:
  - name: Digest
    bot: Package Scout
    when: every 30m
    room: Desk
    instructions: Summarize.
playbooks:
  - name: Qualify
    text: 'Check ghp_abcdefghijklmnopqrstuvwxyz0123 first.'
---
`).pkg;
  const plan = planImport(pkg, { botNames: ['ada', 'Bob'] });
  check('names: taken → 2, spaces removed, reserved words avoided, collisions numbered', same(plan.bots.map((b) => b.name), ['Ada2', 'PackageScout', 'All2', 'AdaLovelace', 'AdaLovelace2']), plan.bots.map((b) => b.name));
  check('each bot knows its package name', same(plan.bots.map((b) => b.from), ['Ada', 'Package Scout', 'All', 'Ada Lovelace', 'AdaLovelace']));
  check('renames are explained', plan.warnings.some((w) => /Ada2 here: the name Ada is taken/.test(w)) && plan.warnings.some((w) => /PackageScout here \(one word/.test(w)) && plan.warnings.some((w) => /All2 here: the name All is reserved/.test(w)), plan.warnings);
  check('access is capped at Edit; talk and read stay; default Edit', same(plan.bots.map((b) => b.access), ['edit', 'talk', 'read', 'edit', 'edit']));
  check('capped access is listed as left out', plan.leftOut.filter((l) => /access: imported bots start at Edit/.test(l)).length === 2, plan.leftOut);
  check('references follow the new names', same(plan.rooms[0].members, ['Ada2', 'PackageScout', 'All2']) && plan.rooms[0].lead === 'PackageScout' && plan.chief === 'PackageScout' && plan.bots[1].chief && plan.automations[0].bot === 'PackageScout');
  check('MCP servers arrive off, automations paused', plan.mcp.every((m) => m.state === 'off') && plan.automations.every((a) => a.state === 'paused') && plan.automations[0].room === 'Desk');
  check('counts', same(plan.counts, { bots: 5, rooms: 1, mcp: 2, automations: 1, playbooks: 1 }), plan.counts);
  check('secrets in soul, memory, playbook and command are redacted and counted', plan.redacted === 4 && !JSON.stringify(plan).match(/sk-ant|Sunny-Day|ghp_|abcdef123456/) && plan.leftOut.some((l) => /^4 secrets/.test(l)), { redacted: plan.redacted, plan });

  console.log('Export');
  const now = Date.now();
  const ada = normalizeBot({ name: 'Ada', title: 'Planner', emoji: '🧭', color: '#8B5CF6', engine: 'CLAUDE', model: 'opus', access: 'full', folder: '/home/me/secret-project', tools: { mcp: ['github'], off: [] }, aliases: ['plan'], createdAt: now }, 'bot_ada');
  const bo = normalizeBot({ name: 'Bo', title: 'Coder', engine: 'CODEX', tools: { mcp: ['github', 'linear'], off: [] }, department: 'dep_1' }, 'bot_bo');
  const room = normalizeRoom({ name: 'Squad', members: ['bot_ada', 'bot_bo', 'bot_gone'], lead: 'bot_bo', bulletin: 'Deploy key: AKIAABCDEFGHIJKLMNOP', mode: 'auto', heldMessages: [{ botId: 'bot_ada', lineId: 'line_1' }], userName: 'Santa', folder: '/home/me/proj' }, 'room_1');
  const lonely = normalizeRoom({ name: 'Others', members: ['bot_other'] }, 'room_2');
  const out = exportCrew({
    name: 'My crew',
    tagline: 'Two bots',
    bots: [
      { profile: ada, soul: 'Plan things. password: Pa55word-xyz', seedMemory: ['Likes short plans.'] },
      { profile: bo, soul: 'Write code.' },
    ],
    rooms: [room, lonely],
    chiefId: 'bot_ada',
    automations: [
      { name: 'Nightly', botName: 'Bo', when: 'daily 02:00', instructions: 'Run tests.', room: 'Squad' },
      { name: 'Orphan', botName: 'Gone', when: 'daily', instructions: 'x' },
    ],
    mcp: [{ name: 'github', reason: 'PRs', command: 'gh-mcp --token ghp_abcdefghijklmnopqrstuvwxyz0123' }],
  });
  const json = JSON.stringify(out);
  check('secrets are redacted and counted', out.redacted === 3 && !/Pa55word|AKIAABCD|ghp_/.test(json), { redacted: out.redacted });
  check('no ids, folders, chats, held messages or user names travel', !/bot_ada|bot_bo|room_1|secret-project|\/home\/me|line_1|heldMessages|Santa|dep_1|transcript/.test(json), json.slice(0, 600));
  check('room members outside the export are dropped, empty rooms left out', out.rooms.length === 1 && same(out.rooms[0].members, ['Ada', 'Bo']) && out.rooms[0].lead === 'Bo' && out.rooms[0].mode === 'auto');
  check('engine, model and access travel as suggestions; the Chief by name', out.bots[0].engine === 'CLAUDE' && out.bots[0].model === 'opus' && out.bots[0].access === 'full' && out.chief === 'Ada' && out.bots[0].chief === true);
  check('automations of unknown bots are dropped', out.automations.length === 1 && out.automations[0].room === 'Squad');
  check('MCP servers bots are limited to become requirements', same(out.requirements.mcp.map((m) => [m.name, m.reason]), [['github', 'PRs'], ['linear', 'Used by Bo']]), out.requirements.mcp);
  check('a prose body is written', out.body.startsWith('# My crew') && /You act as Ada, the Chief/.test(out.body) && /## Automations/.test(out.body));
  const { redacted: _r, warnings: _w, ...pkgOnly } = out;
  const back = parsePackage(serializePackage(out));
  check('an export reads back as the same package', same(back.pkg, pkgOnly) && back.warnings.length === 0, { back: back.pkg, warnings: back.warnings });
}

// ------------------------------------------------------------------------------------------------ OpenMausBot

function roundTrips(pkg: CrewPackage): boolean {
  return same(parsePackage(serializePackage(pkg)).pkg, pkg);
}

function testOpenMaus() {
  console.log('OpenMausBot');
  const dir = path.join(os.homedir(), 'agy_cli_hub/research/OpenMausBot/shared/package-fixtures');
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);

  const botmrr = read('legacy-botmrr.v1.md');
  if (botmrr) {
    check('the real BotMRR fixture is detected', detectFormat(botmrr) === 'botmrr');
    const { pkg, leftOut } = fromOpenMaus(botmrr);
    check('BotMRR: bots, titles, colors, chief', same(pkg.bots.map((b) => b.name), ['Package Scout', 'Package Editor']) && pkg.bots[0].title === 'Researcher' && pkg.bots[0].color === '#0EA5C6' && pkg.chief === 'Package Scout', pkg.bots);
    check('BotMRR: a role emoji, playbooks named in the soul', pkg.bots[0].emoji === '🔎' && /Playbooks you use: Signal Check/.test(pkg.bots[0].soul), pkg.bots[0]);
    check('BotMRR: room with its default responder as lead', same(pkg.rooms[0], { name: 'Signal Room', members: ['Package Scout', 'Package Editor'], bulletin: 'Separate direct evidence from inference.', lead: 'Package Scout', mode: 'lead' }), pkg.rooms[0]);
    check('BotMRR: the routine is an automation', same(pkg.automations[0], { name: 'Morning signals', bot: 'Package Scout', when: 'daily 09:00 mon-fri', instructions: 'Prepare the approved morning signal brief.' }), pkg.automations[0]);
    check('BotMRR: playbook text has summary, triggers and instructions', pkg.playbooks[0].name === 'Signal Check' && pkg.playbooks[0].text === 'Verify a public signal.\n\nUse when: signal brief\n\nKeep the source URL and confidence.');
    check('BotMRR: required apps become MCP requirements', same(pkg.requirements.mcp, [{ name: 'reddit', reason: 'Reddit: Read approved communities.' }]), pkg.requirements.mcp);
    check('BotMRR: its prose body is kept', pkg.body.startsWith('# Signal Desk') && pkg.body.includes('## Completion rule'));
    check('BotMRR: skills and capabilities are listed as left out', leftOut.some((l) => /source-check/.test(l)) && leftOut.some((l) => /capabilities: computer/.test(l)), leftOut);
    check('BotMRR: the result is a valid AntiGem package', roundTrips(pkg));
  } else console.log('  - (BotMRR fixture not found: skipped)');

  const full = read('full-team.v2.json');
  if (full) {
    check('the real v2 JSON fixture is detected', detectFormat(full) === 'openmaus-json');
    const { pkg, warnings, leftOut } = fromOpenMaus(full);
    const [morgan, scout, quill] = pkg.bots;
    check('JSON: bots and the team leader', same(pkg.bots.map((b) => b.name), ['Morgan', 'Scout', 'Quill']) && pkg.chief === 'Morgan' && pkg.name === 'Sales desk', pkg.bots.map((b) => b.name));
    check('JSON: approval → access suggestion, look → color + emoji', morgan.access === 'auto' && quill.access === 'edit' && scout.access === undefined && morgan.color === '#8057C8' && quill.emoji === '✍️' && morgan.emoji === '🧭', pkg.bots);
    check('JSON: soul and seed memory', morgan.soul.startsWith('You coordinate the desk.') && same(morgan.seedMemory, ['The team prefers short summaries.', 'Pricing notes live in memory/pricing.md.', 'pricing: List price is 49 per seat per month.']), morgan);
    check('JSON: routines, one in a room, cron time zone noted', same(pkg.automations.map((a) => [a.when, a.room ?? '']), [['daily 09:00 mon-fri', ''], ['cron 0 10 * * 1', 'Deal desk']]) && warnings.some((w) => /in UTC/.test(w)), pkg.automations);
    check('JSON: connections → requirements with url, never values', same(pkg.requirements.mcp, [{ name: 'crm', reason: 'CRM: Look up accounts and deals.', url: 'https://mcp.example.com/crm' }, { name: 'hubspot', reason: 'HubSpot: Read deals and contacts.' }]), pkg.requirements.mcp);
    check('JSON: what has no equivalent is listed', ['picture', 'skills', 'preset', 'example', 'Authorization', 'team brief', 'run limits'].every((k) => leftOut.some((l) => l.includes(k))), leftOut);
    check('JSON: the body is written, with the team brief', pkg.body.startsWith('# Sales desk') && pkg.body.includes('## Team brief') && pkg.body.includes('By Acme Partners'));
    check('JSON: the result is a valid AntiGem package', roundTrips(pkg));
    const plan = planImport(pkg, { botNames: ['Scout'] });
    check('JSON: planned import caps Morgan and renames Scout', plan.bots[0].access === 'edit' && plan.bots[1].name === 'Scout2' && plan.rooms[0].members.includes('Scout2'));
  }
  const v1 = read('legacy-team.v1.json');
  if (v1) {
    const { pkg } = fromOpenMaus(v1);
    check('v1 JSON: chiefOfStaff becomes the Chief', pkg.chief === 'Package Scout' && pkg.bots.length === 2 && pkg.automations.length === 1);
  }
  const leaky = read('secret-in-soul.v2.json');
  if (leaky) {
    const plan = planImport(fromOpenMaus(leaky).pkg, { botNames: [] });
    check('the secret-in-soul fixture is redacted on import', plan.redacted === 1 && !plan.bots[0].soul.includes('FixtureOnly'), plan.bots[0].soul);
  }
  const library = read('library-only.v2.json');
  if (library) check('a skills-only package is refused clearly', !!throws(() => fromOpenMaus(library), /no bots/));
  const newer = read('newer.v4.json');
  if (newer) check('a newer package is refused clearly', !!throws(() => fromOpenMaus(newer), /newer OpenMausBot/));

  // hand-written samples
  const md = `---
botmrr: 1
name: Tiny Desk
tagline: Two mice.
outcomes: [Answers.]
agents:
  - key: a
    name: Writer Mouse
    title: Writer
    soul: Write clearly.
    appearance: { color: pink }
  - key: b
    name: Writer Mouse
    title: Tester
    appearance: { color: chrome }
chiefOfStaff: b
rooms:
  - key: r
    name: Room
    members: [a, b]
    defaultResponder: { kind: everyone }
routines:
  - key: t
    name: Tick
    agent: a
    prompt: Check.
    runOn: cloud
    schedule: { type: interval, everyMinutes: 120, anchorAt: 0, weekdays: [0, 6], window: { start: '08:00', end: '20:00' } }
    durationMinutes: 10
    enabledAfterInstall: true
---

# Tiny Desk

Prose.
`;
  const tiny = fromOpenMaus(md);
  check('hand BotMRR: duplicate names made unique, keys resolved', same(tiny.pkg.bots.map((b) => b.name), ['Writer Mouse', 'Writer Mouse 2']) && tiny.pkg.chief === 'Writer Mouse 2' && tiny.pkg.bots[1].emoji === '🧪', tiny.pkg.bots);
  check('hand BotMRR: everyone mode, interval schedule, cloud note', tiny.pkg.rooms[0].mode === 'everyone' && tiny.pkg.automations[0].when === 'every 2h sat,sun 08:00-20:00' && tiny.warnings.some((w) => /cloud/.test(w)), [tiny.pkg.rooms[0], tiny.pkg.automations[0]]);
  const json = JSON.stringify({ format: 'openmaus.package', version: 3, package: { name: 'J', tagline: 't', outcomes: ['o'], requirements: { apps: [], capabilities: [] }, team: { name: 'J', leader: 'x' }, agents: [{ key: 'x', name: 'Xavier', appearance: { color: 'red' }, seed: { memory: { 'MEMORY.md': '# Notes\n- one\n2. two\n' } } }], routines: [{ key: 'o', name: 'Once', agent: 'x', prompt: 'p', runOn: 'maus', schedule: { type: 'once', at: Date.UTC(2026, 10, 22, 9, 0) }, durationMinutes: 5, enabledAfterInstall: false }] } });
  const j = fromOpenMaus(json);
  check('hand JSON v3: seed notes, once schedule, red', same(j.pkg.bots[0].seedMemory, ['one', 'two']) && j.pkg.automations[0].when === 'once 2026-11-22 09:00 UTC' && j.pkg.bots[0].color === '#D94B52' && j.pkg.bots[0].emoji === '🐭', j.pkg);
  check('detectFormat: antigem / none', detectFormat(SAMPLE) === 'antigem' && detectFormat('{"a":1}') === null && detectFormat('hello') === null && detectFormat('---\ntitle: x\n---\n') === null && detectFormat('{not json') === null);
  check('fromOpenMaus refuses other text', !!throws(() => fromOpenMaus(SAMPLE), /not an OpenMausBot package/));
  check('readPackage reads every format', readPackage(SAMPLE).format === 'antigem' && readPackage(md).format === 'botmrr' && readPackage(json).pkg.name === 'J' && !!throws(() => readPackage('# hi'), /not a crew package/));
}

// ------------------------------------------------------------------------------------------------ GitHub

async function testGithub() {
  console.log('GitHub');
  const repo = githubCandidates('https://github.com/acme/crews');
  check('a repo → the usual names on HEAD, README last', repo.length === PACKAGE_FILE_NAMES.length && repo[0] === 'https://raw.githubusercontent.com/acme/crews/HEAD/crew.md' && repo[repo.length - 1].endsWith('/HEAD/README.md'), repo);
  check('.git, no scheme, trailing slash', same(githubCandidates('github.com/acme/crews.git/'), repo));
  check('a folder (tree) keeps its ref and path', githubCandidates('https://github.com/acme/crews/tree/main/teams/sales')[0] === 'https://raw.githubusercontent.com/acme/crews/main/teams/sales/crew.md');
  check('a file (blob) → only that file', same(githubCandidates('https://github.com/acme/crews/blob/v1/teams/sales.md?plain=1'), ['https://raw.githubusercontent.com/acme/crews/v1/teams/sales.md']));
  check('a raw link stays', same(githubCandidates('https://raw.githubusercontent.com/acme/crews/main/crew.md'), ['https://raw.githubusercontent.com/acme/crews/main/crew.md']));
  check('a gist → its raw file', same(githubCandidates('https://gist.github.com/ada/abc123'), ['https://gist.githubusercontent.com/ada/abc123/raw']));
  check('other links are not read', githubCandidates('https://example.com/crew.md').length === 0 && githubCandidates('https://github.com/acme/crews/issues/3').length === 0 && githubCandidates('https://github.com/acme').length === 0 && githubCandidates('file:///etc/passwd').length === 0 && githubCandidates('not a url at all').length === 0);

  const calls: string[] = [];
  const files: Record<string, string | Error> = {
    'https://raw.githubusercontent.com/acme/crews/HEAD/CREW.md': new Error('socket hang up'),
    'https://raw.githubusercontent.com/acme/crews/HEAD/package.md': '# Just a readme-ish file',
    'https://raw.githubusercontent.com/acme/crews/HEAD/botmrr.md': 'x'.repeat(PACKAGE_LIMITS.bytes + 1),
    'https://raw.githubusercontent.com/acme/crews/HEAD/team.md': SAMPLE,
  };
  const fake = async (u: string) => {
    calls.push(u);
    const f = files[u];
    if (f instanceof Error) throw f;
    return { ok: f !== undefined, status: f === undefined ? 404 : 200, text: async () => f ?? '' };
  };
  const got = await fetchPackageText('https://github.com/acme/crews', fake);
  check('the first candidate that is a package wins, in order', got.url.endsWith('/HEAD/team.md') && got.text === SAMPLE && calls.length === 5, calls);
  let err = '';
  try {
    await fetchPackageText('https://github.com/acme/empty', fake);
  } catch (e) {
    err = (e as Error).message;
  }
  check('nothing found: the error lists every address tried', PACKAGE_FILE_NAMES.every((n) => err.includes(`/acme/empty/HEAD/${n}: not found`)), err);
  calls.length = 0;
  try {
    await fetchPackageText('https://github.com/acme/crews/blob/main/x.md', async () => ({ ok: false, status: 500, text: async () => '' }));
  } catch (e) {
    err = (e as Error).message;
  }
  check('server errors are named', /x\.md: HTTP 500/.test(err), err);
  delete files['https://raw.githubusercontent.com/acme/crews/HEAD/team.md'];
  err = '';
  try {
    await fetchPackageText('https://github.com/acme/crews', fake);
  } catch (e) {
    err = (e as Error).message;
  }
  check('network errors, non-packages and oversize files are skipped with their reason', /CREW\.md: socket hang up/.test(err) && /package\.md: not a crew package/.test(err) && /botmrr\.md: larger than 4 MB/.test(err) && /team\.md: not found/.test(err), err);
  let notLink = '';
  try {
    await fetchPackageText('https://example.com/x', fake);
  } catch (e) {
    notLink = (e as Error).message;
  }
  check('a link that is not GitHub is refused before any fetch', /not a GitHub link/.test(notLink));
}

async function main() {
  testYaml();
  testFormat();
  testRedaction();
  testPlan();
  testOpenMaus();
  await testGithub();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
