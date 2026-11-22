// groups_mcp (/groups): any agent can design and run AntiGem group chats: create a group with its cast of AI bots
// (name, persona, emoji, color, agent / model, chattiness, access), change them, read the room, post for the user, and
// open a group on screen. The bots themselves never get these tools: they only talk.
import type { AgentKind } from '../../../../shared/model';
import { S, errorResult, jsonResult, text, type McpResult, type McpServerDef } from '../../mcp/server';
import type { RoomEngine } from './engine';
import { AGENT_LABEL, TEMPLATES } from './prompts';
import type { Bot, Group } from './types';

const AGENT_NAMES: Record<string, AgentKind> = {
  claude: 'CLAUDE',
  'claude code': 'CLAUDE',
  claude_code: 'CLAUDE',
  codex: 'CODEX',
  opencode: 'OPENCODE',
  agy: 'AGY',
  antigravity: 'AGY',
};

function agentOf(v: unknown): AgentKind | undefined {
  if (v == null || v === '') return undefined;
  const k = AGENT_NAMES[String(v).trim().toLowerCase()] ?? (String(v).toUpperCase() as AgentKind);
  if (!(k in AGENT_LABEL)) throw new Error(`Unknown agent "${String(v)}": use claude, codex, opencode or agy.`);
  return k;
}

const BOT_PROPS = {
  name: S.prop('string', 'One word others @mention (letters, digits, _ . -; spaces are removed). Unique in the group.'),
  agent: S.prop('string', 'Which agent runs this bot', ['claude', 'codex', 'opencode', 'agy']),
  model: S.prop('string', "Model id from group_models (omit = the agent's default)"),
  persona: S.prop('string', 'Who the bot is: character, expertise, how it talks, what it cares about. A few sentences.'),
  emoji: S.prop('string', 'Avatar emoji (one)'),
  color: S.prop('string', 'Avatar color, #RRGGBB'),
  chattiness: S.prop('number', 'How often it joins in when nobody mentioned it, 0-100 (default 40)'),
  access: S.prop('string', 'chat = talk only (default); read = may read the project and the web; edit = may change project files', ['chat', 'read', 'edit']),
  effort: S.prop('string', 'Reasoning effort of its chat (default = the agent default; low is cheapest)', ['default', 'low', 'medium', 'high']),
};

const GROUP_REF = S.prop('string', 'Group id or exact title');

function botInput(a: Record<string, unknown>): Partial<Bot> {
  const out: Partial<Bot> = {};
  if (a.name !== undefined) out.name = String(a.name);
  const ag = agentOf(a.agent);
  if (ag) out.agent = ag;
  if (a.model !== undefined) out.modelId = a.model ? String(a.model) : null;
  if (a.persona !== undefined) out.persona = String(a.persona);
  if (a.emoji !== undefined) out.emoji = String(a.emoji);
  if (a.color !== undefined) out.color = String(a.color);
  if (a.chattiness !== undefined) out.chattiness = Number(a.chattiness);
  if (a.access !== undefined) out.access = String(a.access) as Bot['access'];
  if (a.effort !== undefined) out.effort = String(a.effort);
  if (a.muted !== undefined) out.muted = a.muted === true;
  return out;
}

function describe(g: Group) {
  return {
    id: g.id,
    title: g.title,
    topic: g.topic,
    user_name: g.userName,
    mode: g.mode,
    lead: g.bots.find((b) => b.id === g.lead)?.name ?? null,
    drafting: g.drafting,
    turns_per_member: g.turnsPerMember,
    max_bot_turns: g.maxBotTurns,
    auto_talk: g.autoTalk,
    idle_seconds: g.idleSeconds,
    paused: g.paused,
    messages: g.messages.filter((m) => m.from !== 'notice').length,
    bots: g.bots.map((b) => ({
      name: b.name,
      agent: b.agent.toLowerCase(),
      model: b.modelId,
      persona: b.persona,
      emoji: b.emoji,
      color: b.color,
      chattiness: b.chattiness,
      access: b.access,
      effort: b.effort,
      on_hold: b.muted,
      title: b.title,
      aliases: b.aliases,
    })),
  };
}

export function groupsMcp(engine: RoomEngine): McpServerDef {
  const resolveModel = (agent: AgentKind, model: string | null | undefined): string | null => {
    if (!model) return null;
    const list = engine.modelsOf(agent);
    if (!list.length) return model;
    const m = list.find((x) => x.id === model) ?? list.find((x) => x.name.toLowerCase() === model.toLowerCase());
    if (!m) throw new Error(`${AGENT_LABEL[agent]} has no model "${model}". Use group_models.`);
    return m.id;
  };
  const withModel = (b: Partial<Bot>, fallbackAgent: AgentKind): Partial<Bot> => (b.modelId !== undefined ? { ...b, modelId: resolveModel(b.agent ?? fallbackAgent, b.modelId) } : b);

  return {
    path: '/groups',
    name: 'groups_mcp',
    instructions:
      'AntiGem group chats: the user and several AI bots talk in one room. Each bot has a persona and runs on its own agent / model. ' +
      'Design a cast with distinct voices (mixing agents and models makes them more different), create it with group_create, then group_open it. ' +
      'Modes: auto (the best-fitting member answers: names, topics, role, else a cheap router model, else the lead), mentions (only @mentioned members answer; others may chime in), lead (the lead answers), everyone (every member answers), moderator (a model picks who speaks after every message). ' +
      'Members are crew bots: they keep one profile and persona across every room and their DM.',
    tools: () => [
      S.tool('group_list', 'List the group chats with their bots.', [], {}),
      S.tool('group_models', 'Agents that can run bots now and their models (ids to pass as model).', [], {
        agent: S.prop('string', 'Only this agent', ['claude', 'codex', 'opencode', 'agy']),
      }),
      S.tool('group_templates', 'Ready-made groups (brainstorm, code review, debate, coffee break) to start from with group_create template=.', [], {}),
      S.tool('group_create', 'Create a group chat, optionally with its bots (or a template). Returns the group.', ['title'], {
        title: S.prop('string', 'Group name'),
        topic: S.prop('string', 'What the group is about (every bot is told)'),
        user_name: S.prop('string', 'What the bots call the user (one word)'),
        mode: S.prop('string', 'Who answers a message nobody @mentioned: auto (default), mentions, lead, everyone, moderator', ['auto', 'mentions', 'lead', 'everyone', 'moderator']),
        max_bot_turns: S.prop('number', 'Bot messages in a row before they wait for the user (1-50, default 6)'),
        auto_talk: S.prop('boolean', 'Bots start talking by themselves when the room is quiet (while it is open)'),
        idle_seconds: S.prop('number', 'Quiet seconds before auto-talk (10-3600, default 60)'),
        template: S.prop('string', 'Start from a template id (group_templates)'),
        bots: { type: 'array', description: 'The cast', items: { type: 'object', properties: BOT_PROPS, required: ['name', 'persona'] } },
        open: S.prop('boolean', 'Show it on screen (default true)'),
      }),
      S.tool('group_get', "A group's settings and bots.", ['group'], { group: GROUP_REF }),
      S.tool('group_update', "Change a group's settings.", ['group'], {
        group: GROUP_REF,
        title: S.prop('string', 'New name'),
        topic: S.prop('string', 'New topic (bots are told)'),
        user_name: S.prop('string', 'What the bots call the user'),
        mode: S.prop('string', 'auto, mentions, lead, everyone or moderator', ['auto', 'mentions', 'lead', 'everyone', 'moderator']),
        lead: S.prop('string', 'The member (name) who answers when nobody else is picked'),
        drafting: S.prop('string', 'turns = one speaker at a time; parallel = all picked members draft at once', ['turns', 'parallel']),
        turns_per_member: S.prop('number', 'Turns each member gets per round, 1-5'),
        moderator_agent: S.prop('string', 'Auto / moderator mode: the agent that picks speakers', ['claude', 'codex', 'opencode', 'agy']),
        moderator_model: S.prop('string', 'Auto / moderator mode: its model id (default: the cheapest-looking one)'),
        max_bot_turns: S.prop('number', '1-50'),
        auto_talk: S.prop('boolean', 'Auto-talk on / off'),
        idle_seconds: S.prop('number', '10-3600'),
        paused: S.prop('boolean', 'Pause (stops the bot replying now) or resume'),
      }),
      S.tool('group_add_bot', 'Add a bot to a group.', ['group', 'name', 'persona'], { group: GROUP_REF, ...BOT_PROPS }),
      S.tool('group_update_bot', "Change a member (its crew profile: every room and its DM follow). A new agent or model starts its room memory again; a new persona applies at once.", ['group', 'bot'], {
        group: GROUP_REF,
        bot: S.prop('string', "The bot's name"),
        ...BOT_PROPS,
        name: S.prop('string', 'New name'),
        muted: S.prop('boolean', 'A muted bot does not speak'),
      }),
      S.tool('group_remove_bot', 'Remove a bot from a group.', ['group', 'bot'], { group: GROUP_REF, bot: S.prop('string', "The bot's name") }),
      S.tool('group_read', "The room's latest messages as text.", ['group'], { group: GROUP_REF, last: S.prop('number', 'How many (default 30)') }),
      S.tool('group_post', 'Post a message in the room as the user (for example to start the discussion). The bots react as usual.', ['group', 'text'], {
        group: GROUP_REF,
        text: S.prop('string', 'Markdown; @Name mentions a bot, @all asks everyone'),
      }),
      S.tool('group_open', 'Show a group on the AntiGem screen.', ['group'], { group: GROUP_REF }),
      S.tool('group_delete', 'Delete a group, its messages and its bots\' hidden chats.', ['group'], { group: GROUP_REF }),
    ],
    async call(name, a): Promise<McpResult> {
      try {
        switch (name) {
          case 'group_list':
            return jsonResult(engine.store.all().map((g) => ({ id: g.id, title: g.title, topic: g.topic, bots: g.bots.map((b) => `${b.emoji} ${b.name} (${b.agent.toLowerCase()})`), messages: g.messages.length })));
          case 'group_models': {
            const only = agentOf(a.agent);
            const kinds = engine.usableKinds().filter((k) => !only || k === only);
            if (!kinds.length) return text(only ? `${AGENT_LABEL[only]} is not available (turned off or not installed).` : 'No agent is available.');
            return jsonResult(kinds.map((k) => ({ agent: k.toLowerCase(), label: AGENT_LABEL[k], models: engine.modelsOf(k).map((m) => ({ id: m.id, name: m.name, ...(m.isDefault ? { default: true } : {}) })) })));
          }
          case 'group_templates':
            return jsonResult(TEMPLATES.map((t) => ({ id: t.id, title: t.title, topic: t.topic, mode: t.mode, bots: t.bots.map((b) => `${b.emoji} ${b.name}: ${b.persona}`) })));
          case 'group_create': {
            const def = engine.usableKinds()[0];
            const bots = Array.isArray(a.bots) ? (a.bots as Record<string, unknown>[]).map((b) => withModel(botInput(b), def)) : [];
            const g = engine.create({
              title: String(a.title ?? ''),
              topic: a.topic != null ? String(a.topic) : undefined,
              userName: a.user_name != null ? String(a.user_name) : undefined,
              mode: a.mode != null ? String(a.mode) : undefined,
              maxBotTurns: a.max_bot_turns != null ? Number(a.max_bot_turns) : undefined,
              autoTalk: a.auto_talk === true,
              idleSeconds: a.idle_seconds != null ? Number(a.idle_seconds) : undefined,
              template: a.template != null ? String(a.template) : null,
              bots,
            });
            if (a.open !== false) engine.open(g.id);
            return jsonResult(describe(g));
          }
          case 'group_get': {
            const g = engine.find(String(a.group ?? ''));
            return g ? jsonResult(describe(g)) : errorResult('No such group. Use group_list.');
          }
          case 'group_update': {
            const ref = String(a.group ?? '');
            const g = engine.find(ref);
            if (!g) return errorResult('No such group. Use group_list.');
            const modAgent = agentOf(a.moderator_agent);
            engine.update(g.id, {
              ...(a.title !== undefined ? { title: a.title } : {}),
              ...(a.topic !== undefined ? { topic: a.topic } : {}),
              ...(a.user_name !== undefined ? { userName: a.user_name } : {}),
              ...(a.mode !== undefined ? { mode: a.mode } : {}),
              ...(a.lead !== undefined ? { lead: engine.findBot(g, String(a.lead))?.id } : {}),
              ...(a.drafting !== undefined ? { drafting: a.drafting } : {}),
              ...(a.turns_per_member !== undefined ? { turnsPerMember: a.turns_per_member } : {}),
              ...(modAgent ? { moderatorAgent: modAgent } : {}),
              ...(a.moderator_model !== undefined ? { moderatorModelId: resolveModel(modAgent ?? g.moderatorAgent ?? engine.usableKinds()[0], String(a.moderator_model || '')) } : {}),
              ...(a.max_bot_turns !== undefined ? { maxBotTurns: a.max_bot_turns } : {}),
              ...(a.auto_talk !== undefined ? { autoTalk: a.auto_talk } : {}),
              ...(a.idle_seconds !== undefined ? { idleSeconds: a.idle_seconds } : {}),
            });
            if (a.paused === true) engine.pause(g.id);
            else if (a.paused === false) engine.resume(g.id);
            return jsonResult(describe(engine.find(g.id)!));
          }
          case 'group_add_bot': {
            const g = engine.find(String(a.group ?? ''));
            if (!g) return errorResult('No such group. Use group_list.');
            const b = engine.addBot(g.id, withModel(botInput(a), engine.usableKinds()[0]));
            return text(`Added ${b.emoji} ${b.name} (${AGENT_LABEL[b.agent]}${b.modelId ? `, ${b.modelId}` : ''}).`);
          }
          case 'group_update_bot': {
            const g = engine.find(String(a.group ?? ''));
            if (!g) return errorResult('No such group. Use group_list.');
            const cur = engine.findBot(g, String(a.bot ?? ''));
            if (!cur) return errorResult(`No bot "${String(a.bot ?? '')}" in ${g.title}.`);
            const b = engine.updateBot(g.id, cur.id, withModel(botInput(a), cur.agent));
            return text(`Updated ${b.emoji} ${b.name}.`);
          }
          case 'group_remove_bot': {
            const g = engine.find(String(a.group ?? ''));
            if (!g) return errorResult('No such group. Use group_list.');
            engine.removeBot(g.id, String(a.bot ?? ''));
            return text('Removed.');
          }
          case 'group_read': {
            const out = engine.readTranscript(String(a.group ?? ''), Number(a.last ?? 30) || 30);
            return text(out || '(no messages yet)');
          }
          case 'group_post': {
            engine.post(String(a.group ?? ''), String(a.text ?? ''));
            return text('Posted. The bots reply in the room (group_read to see what they said).');
          }
          case 'group_open':
            engine.open(String(a.group ?? ''));
            return text('Opened.');
          case 'group_delete':
            await engine.remove(String(a.group ?? ''));
            return text('Deleted.');
        }
        return errorResult(`Unknown tool ${name}`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
