// jarvis_mcp: lets the model drive AntiGem directly (port of the app's JarvisMcp.kt, minus voice and GitHub): tasks it
// manages in their own chats, missions and teams, chats of every agent, models and chat controls, approvals, screens
// and settings pages, VS Code (projects, files, code search), help and configuration, usage, timers and Jarvis' memory.
// Served by the extension's MCP host at /jarvis (stateful: every connection has a session id, passed as _mcp_session).
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, AiModel, ChatMessage, Conversation } from '../../../shared/model';
import type { ProjectView } from '../../../shared/protocol';
import { S, errorResult, text as textResult, type McpResult, type McpServerDef, type McpTool } from '../mcp/server';
import * as Guide from './appGuide';
import { agentName } from './controller';
import type { JarvisEngine } from './engine';
import { missionDone, missionIsEmpty } from './managers';
import * as JText from './text';
import { TASK_LABEL, needsUserState, type Task, type Team } from './types';

export const INSTRUCTIONS =
  'Jarvis controls the AntiGem extension and leads teams of sub-agents. The first message of a Jarvis chat ' +
  'has the full guide and tool list; jarvis_help repeats it. Call these tools directly by name (no searching, no config reading). ' +
  'Big jobs go to jarvis_task_start (its own watched chat, optionally a team); pass your manager_id. Never wait or poll for tasks: ' +
  'end your turn, the extension reports back with a <jarvis_events> message. Keep multi-step work in jarvis_mission_set / jarvis_mission_update. ' +
  'Help: jarvis_app_guide, jarvis_get_config, jarvis_open_settings. Ask before deleting anything.';

const POLL_STOP =
  'Stop polling. The task is still working, and checking again will not make it faster. END YOUR TURN now ' +
  '(start any other independent task first): the extension sends you a <jarvis_events> message the moment it finishes, fails or needs you.';

const NEED_ID =
  'Pass manager_id: it is in the [Jarvis] note at the top of your latest message. ' + "Several Jarvis chats are working right now, so I can't tell which one is calling.";

const NOT_JARVIS = 'This chat is not a Jarvis chat, so it has no tasks, mission or teams. The user opens one from the Jarvis tab of the chat list (New Jarvis chat).';

const NO_WAIT_NOTE = 'Do not wait, sleep or poll. Start any other independent tasks now, tell the user briefly, then END YOUR TURN: results come back to you as a <jarvis_events> message.';

const NO_VOICE = 'There is no voice in VS Code: write it in your reply (and ask questions in your reply, then end your turn).';

/** Tools that act for one Jarvis chat (start, steer or stop its work): they must know for certain which chat calls. */
const ACTING = new Set([
  'jarvis_task_start',
  'jarvis_task_reply',
  'jarvis_task_answer',
  'jarvis_task_stop',
  'jarvis_task_close',
  'jarvis_mission_set',
  'jarvis_mission_update',
  'jarvis_team_create',
  'jarvis_team_delete',
  'jarvis_resolve_permission',
  'jarvis_send_to_chat',
  'jarvis_new_chat',
  'jarvis_stop_all',
  'jarvis_stop_chat',
  'jarvis_delete_chat',
  'jarvis_set_model',
]);

/** Voice-only tools of the app: still answered (a chat that learned them elsewhere), never listed. */
const HIDDEN = new Set(['jarvis_speak', 'jarvis_ask', 'jarvis_ignore', 'jarvis_new_session']);

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const AGENTS = ['claude', 'agy', 'opencode', 'codex'];

type Args = Record<string, unknown>;
const P = S.prop;

const chatId = { id: P('string', 'Chat id from jarvis_list_chats (default: the chat on screen)') };
const taskId = { id: P('string', 'Task id (from the context note, jarvis_task_list or jarvis_task_start; the first 8 characters are enough)') };
const limit = { limit: P('integer', `Entries per page, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT})`) };
const offset = { offset: P('integer', 'Entries to skip (default 0)') };
const managerId = { manager_id: P('string', 'Your manager id, from the [Jarvis] note at the top of your messages. The news of your tasks comes back to that chat.') };

export function jarvisTools(): McpTool[] {
  const t = S.tool;
  return [
    // ---- status and help
    t('jarvis_status', 'Show a short live status on your chat\'s command strip (2 to 6 words, e.g. "Checking the build"). Optional; returns at once.', ['text'], {
      text: P('string', 'What you are doing now, present tense, 2-6 words'),
      ...managerId,
    }),
    t('jarvis_help', 'Repeat the Jarvis guide and the full tool list (when your first message was compacted away or you are unsure how to do something).', [], {}),
    // ---- tasks (Jarvis as a manager)
    t(
      'jarvis_task_start',
      'Start a big, independent job as a TASK in its own new chat that the extension watches for you (a build, a refactor, a bug fix, a long ' +
        'investigation), optionally done by one of your teams. Start all independent tasks in the same turn. Never wait for it: the extension ' +
        'sends you a <jarvis_events> message when it finishes, fails, gets stuck, needs an approval or asks something. Do quick things ' +
        'yourself instead. Returns the task id.',
      ['goal'],
      {
        goal: P('string', 'Full instructions for the task\'s agent: what to do, where, constraints, how to verify and what to report back'),
        title: P('string', 'Short name, 2-5 words (e.g. "Release build")'),
        team: P('string', 'One of your teams (jarvis_team_create): its agent, model, project and role are used unless given here'),
        agent: P(
          'string',
          "claude, agy, opencode or codex (default: the team's, else the agent new chats use). OpenCode runs any provider's models (OpenAI-compatible, NVIDIA, Groq, free models); Codex is OpenAI's agent on the user's ChatGPT plan",
          AGENTS,
        ),
        model: P('string', "Model id or part of its name (default: the team's, else the agent's default)"),
        project: P('string', "Project name or path to work in (default: the team's, else the active project)"),
        open: P('boolean', "Also show the chat in the user's view (default false)"),
        ...managerId,
      },
    ),
    t(
      'jarvis_task_list',
      'Your tasks: state (starting, running, waiting for approval, asking a question, no progress, done, failed, stopped), team, age and last note. Not for polling: the news comes to you by itself.',
      [],
      {
        include_finished: P('boolean', 'Also list finished tasks (default true)'),
        scope: P('string', 'mine (default: the tasks of your chat) or all', ['mine', 'all']),
        ...limit,
        ...managerId,
      },
    ),
    t(
      'jarvis_task_get',
      'One task in detail: goal, state, last note, and its latest reply or progress. Use it for "how is X going?" or to understand a failure; not to poll a running task. ' +
        'For a finished task\'s whole reply use jarvis_read_chat(id, role="assistant", limit=1, max_chars=30000).',
      ['id'],
      {
        ...taskId,
        messages: P('integer', 'Also include this many of its newest messages (default 3, 0-10)'),
        max_chars: P('integer', 'Cut each of those messages to this length (default 600, up to 30000)'),
        ...managerId,
      },
    ),
    t(
      'jarvis_task_reply',
      'Send the task a follow-up, a correction or a new direction ("also run the tests", "use the other API"). The task keeps its context, so ' +
        'fixes and next steps of the same work go here. With interrupt=true a task that is still working is stopped first and then gets this message.',
      ['id', 'message'],
      { ...taskId, message: P('string', "What to tell the task's agent"), interrupt: P('boolean', 'Stop the running task first (default false)'), ...managerId },
    ),
    t('jarvis_task_answer', 'Answer the multiple-choice question a task is asking (option number, option name, or free text; "skip" lets it decide).', ['id', 'answer'], {
      ...taskId,
      answer: P('string', 'The answer'),
      ...managerId,
    }),
    t('jarvis_task_stop', 'Stop what a task is doing right now.', ['id'], { ...taskId, ...managerId }),
    t('jarvis_task_open', "Show a task's chat in the user's view.", ['id'], { ...taskId }),
    t('jarvis_task_close', 'Stop watching a task and remove it from the list (the chat itself stays).', ['id'], { ...taskId, ...managerId }),
    // ---- missions and teams (the manager's memory, repeated to it with every message)
    t(
      'jarvis_mission_set',
      'Start (or replace) your mission for a job with several steps: the goal, how you know it is done, and the steps. The extension keeps it and ' +
        'repeats it to you in every message, so you never lose track, and shows it to the user.',
      ['goal'],
      {
        goal: P('string', 'What the whole job must achieve'),
        done_when: P('string', 'Concrete criteria for done (e.g. "the build passes, all tests green, the feature works on the login screen")'),
        steps: P('string', 'The plan, one step per line'),
        autopilot: P('boolean', 'Keep going until done: the extension nudges you whenever you stop while the mission is unfinished and nothing runs'),
        ...managerId,
      },
    ),
    t("jarvis_mission_update", "Update your mission: a step's status (todo, doing, done, blocked) and note, new steps, the mission's status (active, done, paused), autopilot, notes.", [], {
      step: P('integer', 'Step number to change'),
      step_status: P('string', 'New status of that step', ['todo', 'doing', 'done', 'blocked']),
      note: P('string', 'Short note on that step (result, blocker)'),
      add_steps: P('string', 'New steps to append, one per line'),
      status: P('string', "The mission's status: done only when done_when is met", ['active', 'done', 'paused']),
      autopilot: P('boolean', 'Turn autopilot on or off'),
      notes: P('string', 'Notes to keep with the mission (decisions, findings); replaces the earlier notes'),
      ...managerId,
    }),
    t('jarvis_mission_get', 'Your mission, its steps, your teams and your tasks (the same brief that comes with every message).', [], { ...managerId }),
    t(
      'jarvis_team_create',
      'Create or change a team: a named role that tasks can be given to (e.g. builders: claude, implement with tests; reviewers: agy, review ' +
        'the diff and run the tests). jarvis_task_start(team=…) then uses its agent, model, project and role.',
      ['name'],
      {
        name: P('string', 'Team name, one or two words'),
        agent: P('string', 'claude, agy, opencode or codex (default: the agent new chats use)', AGENTS),
        model: P('string', "Model id or part of its name (default: the agent's default)"),
        role: P('string', 'What this team does and how it should work and report (sent with each of its tasks)'),
        project: P('string', 'Project name or path the team works in (default: the active project at the time)'),
        ...managerId,
      },
    ),
    t('jarvis_team_list', 'Your teams with their agent, model, project and role, and how many of their tasks are running.', [], { ...managerId }),
    t('jarvis_team_delete', 'Remove one of your teams (its tasks keep running).', ['name'], { name: P('string', 'Team name'), ...managerId }),
    // ---- everyday
    t('jarvis_set_timer', 'Set a timer that shows a notification when it ends (breaks, a build to check later). Give seconds or minutes.', [], {
      minutes: P('number', 'Length in minutes (can be fractional)'),
      seconds: P('integer', 'Length in seconds (added to minutes)'),
      label: P('string', 'What it is for, e.g. stand-up'),
    }),
    t('jarvis_list_timers', 'The running timers and how long each has left.', [], {}),
    t('jarvis_cancel_timer', 'Cancel a timer by id (from jarvis_list_timers), or all of them.', [], { id: P('integer', 'Timer id'), all: P('boolean', 'Cancel every timer') }),
    t('jarvis_get_health', 'Is everything up? The bridge, each agent (installed, signed in, running), the extension\'s MCP server and Jarvis.', [], {}),
    t('jarvis_open_url', "Open a web page in the user's browser.", ['url'], { url: P('string', 'Address, e.g. https://example.com') }),
    t('jarvis_stop_all', "Emergency stop: stop your own running tasks. Use when the user says stop or cancel everything.", [], { ...managerId }),
    // ---- state and help
    t(
      'jarvis_get_state',
      'Where the user is and what is going on: the VS Code workspace and open file, the chat on screen, tasks, running chats, ' +
        'approvals waiting. The context note of each message already has most of this.',
      [],
      {},
    ),
    t(
      'jarvis_app_guide',
      'How to use AntiGem: where a setting is, how to add an MCP server, the agents, the editor integration, notes, slash commands, ' +
        "Jarvis' own features, troubleshooting. Give a topic or the user's words.",
      ['topic'],
      { topic: P('string', `A topic (${Guide.topics().join(', ')}) or words`) },
    ),
    t('jarvis_get_config', "The user's configuration: agents (accounts, versions, plans), MCP servers of each agent, Jarvis settings, look, projects.", [], {
      area: P('string', 'What to read (default overview)', ['overview', 'agents', 'mcp', 'jarvis', 'appearance', 'projects']),
    }),
    t('jarvis_open_settings', "Show a settings page in the user's AntiGem view (e.g. jarvis, agents, claude, agy, codex, opencode, slash, context, connection).", ['section'], {
      section: P('string', 'Settings page name (jarvis_app_guide topic settings lists them)'),
    }),
    t(
      'jarvis_get_usage',
      "Plan usage of each agent: its usage windows (5-hour, weekly…) with percent left and when each resets, as the model picker shows them. Always name every window when answering.",
      [],
      { agent: P('string', 'Which agent (default all)', ['all', ...AGENTS]) },
    ),
    // ---- chats
    t('jarvis_list_chats', "List chats of Claude Code, Antigravity, OpenCode and Codex, newest first, with paging. Jarvis' own chats are left out unless asked for.", [], {
      agent: P('string', 'Only this agent', ['all', ...AGENTS]),
      running: P('boolean', 'Only chats that are working right now'),
      project: P('string', 'Only chats of a project (part of its name or path)'),
      query: P('string', 'Words in the title'),
      sort: P('string', 'Order (default updated_desc)', ['updated_desc', 'updated_asc', 'created_desc', 'title_asc']),
      include_jarvis: P('boolean', "Also list Jarvis' own chats (default false)"),
      ...limit,
      ...offset,
      page: P('integer', '1-based page number, instead of offset'),
    }),
    t('jarvis_get_chat', 'Status of one chat: running or idle, agent, model, project, waiting approvals and a preview of the last messages.', [], { ...chatId }),
    t(
      'jarvis_read_chat',
      "Read what is inside a chat (also a task's chat: its id is the task id), in pages. By default the newest messages first (from_end=true). " +
        "A message longer than max_chars is cut (it then says chars and cut=true); for a task's whole last reply use role=\"assistant\", limit=1, max_chars=30000.",
      [],
      {
        ...chatId,
        ...limit,
        ...offset,
        from_end: P('boolean', 'Count from the newest message (default true)'),
        role: P('string', 'Only these messages', ['all', 'user', 'assistant']),
        include_tools: P('boolean', 'Include the tool calls each reply made (default false)'),
        max_chars: P('integer', 'Cut each message to this length (default 800, up to 30000)'),
      },
    ),
    t('jarvis_search_chats', 'Find chats by title; with deep=true also look inside the chats (each agent\'s own search).', ['query'], {
      query: P('string', 'Words to find'),
      deep: P('boolean', 'Also search message text (slower)'),
      ...limit,
    }),
    t(
      'jarvis_new_chat',
      "Start a new chat. With a message it runs as a watched task (same as jarvis_task_start); without one an empty chat opens in the user's view. " +
        'Use it only when the user asked for a new chat; prefer jarvis_task_start for delegated work.',
      [],
      {
        agent: P('string', 'claude, agy, opencode or codex (default: the agent new chats use)', AGENTS),
        message: P('string', 'The first message / task'),
        model: P('string', "Model id or name (default: the agent's default)"),
        project: P('string', 'Project name or path to work in (default: the active project)'),
        open: P('boolean', "Also show the chat in the user's view (default false)"),
        ...managerId,
      },
    ),
    t(
      'jarvis_send_to_chat',
      'Send a message to ANOTHER existing chat (it then becomes a watched task). Use it ONLY when the user told you to ("tell the build chat to run the tests") ' +
        'or the request clearly continues exactly what that chat is working on. NEVER for general questions or anything you can do yourself, ' +
        'and never for a chat that is running.',
      ['id', 'message', 'reason'],
      { ...chatId, message: P('string', 'The message'), reason: P('string', 'Why this goes to that chat', ['user_named_this_chat', 'continues_that_chats_work']), ...managerId },
    ),
    t('jarvis_stop_chat', 'Stop what a chat is doing right now.', [], { ...chatId, ...managerId }),
    t('jarvis_open_chat', "Show a chat in the user's view.", ['id'], { ...chatId }),
    t('jarvis_rename_chat', 'Rename a chat.', ['id', 'title'], { ...chatId, title: P('string', 'New title') }),
    t('jarvis_fork_chat', 'Copy a chat into a new one that continues from the same point (the copy opens in the user\'s view).', ['id'], { ...chatId }),
    t('jarvis_delete_chat', 'Delete a chat for good. Ask the user in your reply first and pass confirm=true only after they said yes.', ['id', 'confirm'], {
      ...chatId,
      confirm: P('boolean', 'Must be true'),
      ...managerId,
    }),
    // ---- models and chat settings
    t('jarvis_list_models', 'Models available to each agent, marking the selected one.', [], { agent: P('string', 'Which agent (default the chat on screen, or all)', ['all', ...AGENTS]) }),
    t(
      'jarvis_set_model',
      'Change the model. With id it changes that chat or task; without id scope=screen changes the chat on screen, ' +
        'scope=jarvis the model of your own Jarvis chat. The model can be a part of its name. Applies to the chat\'s next message.',
      ['model'],
      { id: P('string', 'Chat or task id to change'), model: P('string', 'Model id or part of its name, e.g. opus, sonnet, flash'), scope: P('string', 'screen (default) or jarvis', ['screen', 'jarvis']), ...managerId },
    ),
    t('jarvis_set_effort', 'Claude Code chat on screen (or id): set the reasoning effort.', ['level'], { level: P('string', 'low, medium, high, xhigh, max or default'), ...chatId }),
    t('jarvis_set_thinking', 'Claude Code chat on screen (or id): turn extended thinking on or off.', ['enabled'], { enabled: P('boolean', 'true or false'), ...chatId }),
    t(
      'jarvis_set_permission_mode',
      'Claude Code chat on screen (or id): how it asks for approval. default = ask for everything, acceptEdits = file edits are allowed, plan = plan only, ' +
        'auto = decides itself, dontAsk = no prompts.',
      ['mode'],
      { mode: P('string', 'The mode', ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']), ...chatId },
    ),
    t('jarvis_get_setting', 'Read AntiGem and Jarvis settings (look, new-chat agent, Jarvis\' own options…) with their allowed values.', [], { key: P('string', 'One key, or omit for all') }),
    t(
      'jarvis_set_setting',
      "Change a setting (keys from jarvis_get_setting). Jarvis' own options (keys starting with jarvis_) can always be changed; app settings " +
        '(theme_mode, chat_font_scale, new_chat_agent…) only when the user allowed it. Approval and security policies cannot be changed here.',
      ['key', 'value'],
      { key: P('string', 'Setting key'), value: P('string', 'New value') },
    ),
    // ---- permissions
    t('jarvis_list_permissions', 'Requests waiting for approval in your tasks, with the exact action and a risk level.', [], { ...managerId }),
    t('jarvis_resolve_permission', 'Approve or reject waiting requests of your tasks: one by key, or all. Ask the user first about risky actions.', ['approve'], {
      key: P('string', 'Key from jarvis_list_permissions or the event (omit with all=true)'),
      approve: P('boolean', 'true = approve, false = reject'),
      all: P('boolean', 'Apply to every waiting request'),
      reason: P('string', 'When rejecting: what to tell the agent'),
      ...managerId,
    }),
    // ---- screens and VS Code
    t('jarvis_open_screen', "Switch the user's AntiGem view to a screen.", ['screen'], { screen: P('string', 'Where to go', ['chat', 'notes', 'settings']) }),
    t('jarvis_ide_list_projects', 'List the projects (this window\'s folders, saved projects, folders recent chats ran in) and which one is active for Jarvis.', [], {
      query: P('string', 'Part of a name or path'),
      ...limit,
      ...offset,
    }),
    t('jarvis_ide_open_project', 'Make a project the active one: where new tasks and chats work by default. Give the name (or part of it) or the full path.', ['project'], {
      project: P('string', 'Project name or path'),
    }),
    t('jarvis_ide_open_file', 'Open a file in the VS Code editor. Give a path (absolute, or relative to the active project) or just the file name.', ['file'], {
      file: P('string', 'Path or file name'),
      line: P('integer', 'Line to show (default 1)'),
      project: P('string', 'Look in this project (name or path)'),
    }),
    t('jarvis_ide_get_open_files', "VS Code's active file and the selected lines.", [], {}),
    t('jarvis_ide_search_code', 'Search text in the files of the active project (or another project). Returns file, line number and the line, paged.', ['query'], {
      query: P('string', 'Text to find'),
      project: P('string', 'Project name or path (default: the active project)'),
      ...limit,
      ...offset,
    }),
    // ---- memory
    t('jarvis_memory_read', 'Read the Jarvis memory note that survives new chats.', [], {}),
    t('jarvis_memory_write', 'Save to the Jarvis memory note (preferences, names, what is in progress). Keep it short.', ['text'], {
      text: P('string', 'Text to save'),
      mode: P('string', 'replace (default) or append', ['replace', 'append']),
    }),
  ];
}

// ------------------------------------------------------------------------------------------------ the server

export function jarvisMcp(j: JarvisEngine): McpServerDef {
  return new JarvisMcp(j).def();
}

class JarvisMcp {
  private polls = new Map<string, number[]>();

  constructor(private j: JarvisEngine) {}

  def(): McpServerDef {
    return {
      path: '/jarvis',
      name: 'jarvis_mcp',
      instructions: INSTRUCTIONS,
      stateful: true,
      tools: () => this.j.toolList(),
      hiddenTool: (n) => HIDDEN.has(n),
      notReady: () => (this.j.prefs.get('enabled') ? null : 'Jarvis is turned off. The user can turn it on in Settings → Jarvis.'),
      call: (name, args) => this.call(name, args),
    };
  }

  private async call(name: string, args: Args): Promise<McpResult> {
    if (!this.j.prefs.get('enabled')) return errorResult('Jarvis is turned off. The user can turn it on in Settings → Jarvis.');
    // which Jarvis chat is calling (their status shows on their own strip)
    const session = typeof args._mcp_session === 'string' ? args._mcp_session : null;
    delete args._mcp_session;
    const who = this.j.managers.resolveCaller(str(args.manager_id), session);
    // never act for the wrong Jarvis chat: when it is not certain who calls, ask for the manager_id
    if (ACTING.has(name) && !who.sure) return errorResult(who.key == null ? NOT_JARVIS : NEED_ID);
    const caller = who.key;
    this.j.controller.onToolCall(caller);
    const status = friendlyStatus(name, args);
    if (status && caller) this.j.managers.setStatus(caller, status);
    try {
      return await this.dispatch(name, args, caller);
    } catch (e) {
      return errorResult(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private needCaller(caller: string | null): McpResult | null {
    return caller ? null : errorResult(NOT_JARVIS);
  }

  private async dispatch(name: string, args: Args, caller: string | null): Promise<McpResult> {
    const j = this.j;
    switch (name) {
      case 'jarvis_speak':
      case 'jarvis_ask':
        return errorResult(NO_VOICE);
      case 'jarvis_ignore':
        return textResult('Ignored.');
      case 'jarvis_new_session':
        return errorResult('Only the voice Jarvis of the phone app starts over by itself. For a fresh start the user opens a new Jarvis chat.');
      case 'jarvis_status': {
        const t = str(args.text).trim();
        if (!t) return errorResult('text is empty');
        if (caller) j.managers.setStatus(caller, t);
        return textResult('ok');
      }
      case 'jarvis_help':
        return textResult(`${j.skill.commandGuide()}\n\n## jarvis_mcp tools\n${j.skill.catalog()}`);
      case 'jarvis_task_start':
        return this.taskStart(args, caller!);
      case 'jarvis_task_list':
        return this.needCaller(caller) ?? this.taskList(args, caller!);
      case 'jarvis_task_get':
        return this.taskGet(args, caller);
      case 'jarvis_task_reply': {
        const [t, err] = this.owned(str(args.id), caller);
        if (!t) return err!;
        const r = await j.tasks.reply(t.id, str(args.message), bool(args.interrupt));
        return textResult(r.startsWith('Sent') ? `${r} ${NO_WAIT_NOTE}` : r);
      }
      case 'jarvis_mission_set':
        return this.missionSet(args, caller!);
      case 'jarvis_mission_update':
        return this.missionUpdate(args, caller!);
      case 'jarvis_mission_get':
        return this.needCaller(caller) ?? textResult(j.managers.brief(caller!));
      case 'jarvis_team_create':
        return this.teamCreate(args, caller!);
      case 'jarvis_team_list':
        return this.needCaller(caller) ?? this.teamList(caller!);
      case 'jarvis_team_delete': {
        const n = str(args.name).trim();
        if (!n) return errorResult('name is required');
        return textResult(j.managers.removeTeam(caller!, n) ? `Team ${n} removed.` : `No team ${n}.`);
      }
      case 'jarvis_task_answer': {
        const [t, err] = this.owned(str(args.id), caller);
        if (!t) return err!;
        return textResult(await j.controller.answerTaskQuestion(t.id, str(args.answer)));
      }
      case 'jarvis_task_stop': {
        const [t, err] = this.owned(str(args.id), caller);
        if (!t) return err!;
        return textResult(await j.tasks.stop(t.id));
      }
      case 'jarvis_task_open': {
        const t = j.tasks.find(str(args.id));
        if (!t) return errorResult('No task with that id.');
        j.host.showChat(t.id, t.agent);
        return textResult(`Showing ${t.title}.`);
      }
      case 'jarvis_task_close': {
        const [t, err] = this.owned(str(args.id), caller);
        if (!t) return err!;
        j.tasks.close(t.id);
        return textResult(`No longer watching ${t.title}.`);
      }
      case 'jarvis_set_timer': {
        const total = Math.round(num(args.minutes, 0) * 60) + Math.round(num(args.seconds, 0));
        if (total < 1 || total > 24 * 3600) return errorResult('Give a length between 1 second and 24 hours.');
        const t = j.controller.addTimer(total, str(args.label));
        return textResult(`Timer ${t.id} set for ${total >= 60 ? `${Math.floor(total / 60)} min ${total % 60} s` : `${total} s`}${t.label ? ` (${t.label})` : ''}.`);
      }
      case 'jarvis_list_timers':
        return json({ timers: j.controller.timers().map((t) => ({ id: t.id, label: t.label, left: inText(t.endsAt) })) });
      case 'jarvis_cancel_timer':
        if (bool(args.all)) {
          for (const t of j.controller.timers()) j.controller.cancelTimer(t.id);
          return textResult('All timers cancelled.');
        }
        return textResult(j.controller.cancelTimer(num(args.id, -1)) ? 'Cancelled.' : 'No such timer.');
      case 'jarvis_get_health':
        return this.health();
      case 'jarvis_open_url': {
        let u = str(args.url).trim();
        if (!u) return errorResult('url is required');
        if (!/^https?:\/\//.test(u)) u = `https://${u}`;
        j.host.openUrl(u);
        return textResult(`Opened ${u}.`);
      }
      case 'jarvis_stop_all': {
        // a Jarvis chat stops its own work only
        const mine = j.tasks.ownedBy(caller).filter((t) => j.tasks.isActive(t));
        for (const t of mine) await j.tasks.stop(t.id);
        return textResult(mine.length ? `Stopped ${mine.length} task${mine.length === 1 ? '' : 's'} of yours.` : 'None of your tasks is running.');
      }
      case 'jarvis_get_state':
        return this.getState(caller);
      case 'jarvis_app_guide': {
        const topic = str(args.topic).trim();
        const hits = Guide.lookup(topic || 'overview');
        if (!hits.length) return textResult(`Nothing specific about "${topic}". Topics: ${Guide.topics().join(', ')}. Explain from what you know, and say where in Settings it most likely is.`);
        return textResult(`${hits.map((h) => `## ${h.topic}\n${h.text}`).join('\n\n')}\n\nExplain it in a sentence or two and offer to open the page (jarvis_open_settings).`);
      }
      case 'jarvis_get_config':
        return this.getConfig(args);
      case 'jarvis_open_settings':
        return this.openSettings(args);
      case 'jarvis_get_usage':
        return this.getUsage(args);
      case 'jarvis_list_chats':
        return this.listChats(args);
      case 'jarvis_get_chat':
        return this.getChat(args);
      case 'jarvis_read_chat':
        return this.readChat(args);
      case 'jarvis_search_chats':
        return this.searchChats(args);
      case 'jarvis_new_chat':
        return this.newChat(args, caller!);
      case 'jarvis_send_to_chat': {
        const id = this.resolveId(args);
        if (!id) return errorResult('No chat. Give an id.');
        const m = str(args.message).trim();
        if (!m) return errorResult('message is empty');
        if (!['user_named_this_chat', 'continues_that_chats_work'].includes(str(args.reason)))
          return errorResult('Do it yourself unless the user named that chat or the request continues its work. Pass reason if one of those is true.');
        const f = this.foreign(id, caller);
        if (f) return errorResult(f);
        return textResult(await j.controller.sendToChat(id, m, caller!));
      }
      case 'jarvis_stop_chat': {
        const id = this.resolveId(args);
        if (!id) return errorResult('No chat. Give an id.');
        const f = this.foreign(id, caller);
        if (f) return errorResult(f);
        return textResult(await j.controller.stopChat(id));
      }
      case 'jarvis_open_chat': {
        const id = this.resolveId(args);
        if (!id) return errorResult('id is required');
        j.host.showChat(id, j.driver.agentOf(id) ?? undefined);
        return textResult('Opened the chat.');
      }
      case 'jarvis_rename_chat': {
        const id = this.resolveId(args);
        if (!id) return errorResult('No chat. Give an id.');
        const b = j.driver.backendOf(id);
        if (!b) return errorResult('No chat with that id.');
        await b.conversationAction(id, 'rename', str(args.title));
        return textResult('Renamed.');
      }
      case 'jarvis_fork_chat': {
        const id = this.resolveId(args);
        if (!id) return errorResult('id is required');
        const b = j.driver.backendOf(id);
        if (!b) return errorResult('No chat with that id.');
        const res = await b.conversationAction(id, 'fork');
        if (typeof res === 'string' && res) j.host.showChat(res, b.kind);
        return textResult(typeof res === 'string' && res ? `Forked. The copy (id ${res}) is now on screen.` : 'Forked.');
      }
      case 'jarvis_delete_chat': {
        // a task id may be given shortened: resolve it before any check
        const raw = str(args.id).trim();
        if (!raw) return errorResult('id is required');
        const id = j.tasks.find(raw)?.id ?? this.resolveId(args) ?? raw;
        if (!bool(args.confirm)) return errorResult('Ask the user first, then call again with confirm=true.');
        if (id === caller) return errorResult('That is your own Jarvis chat. The user deletes it from the chat list.');
        const f = this.foreign(id, caller);
        if (f) return errorResult(f);
        const b = j.driver.backendOf(id);
        if (!b) return errorResult('No chat with that id.');
        j.tasks.close(id);
        await b.conversationAction(id, 'delete');
        j.onChatDeleted(id);
        return textResult('Deleted.');
      }
      case 'jarvis_list_models':
        return this.listModels(args);
      case 'jarvis_set_model':
        return this.setModel(args, caller);
      case 'jarvis_set_effort':
      case 'jarvis_set_thinking':
      case 'jarvis_set_permission_mode':
        return this.claudeControl(name, args);
      case 'jarvis_get_setting':
        return this.getSetting(args);
      case 'jarvis_set_setting':
        return this.setSetting(args);
      case 'jarvis_list_permissions': {
        const list = j.controller.pendingFor(caller);
        return json({ count: list.length, items: list.map((p) => ({ key: p.key, chat_id: p.chatId, tool: p.tool, wants_to: p.summary, risk: p.risk.toLowerCase() })) });
      }
      case 'jarvis_resolve_permission':
        return textResult(await j.controller.resolve(str(args.key) || null, bool(args.approve), bool(args.all), str(args.reason) || null, caller));
      case 'jarvis_open_screen': {
        const s = str(args.screen).toLowerCase();
        if (s !== 'chat' && s !== 'notes' && s !== 'settings') return errorResult(`Unknown screen ${s}. Screens: chat, notes, settings.`);
        j.host.postActive({ type: 'jarvisNavigate', screen: s, settingsPage: s === 'settings' ? 'root' : null, conversationId: null });
        return textResult(`Opened ${s}.`);
      }
      case 'jarvis_ide_list_projects':
        return this.ideListProjects(args);
      case 'jarvis_ide_open_project':
        return this.ideOpenProject(args);
      case 'jarvis_ide_open_file':
        return this.ideOpenFile(args);
      case 'jarvis_ide_get_open_files': {
        const ed = j.host.editorContext();
        return json({ active: ed?.path ?? null, relative: ed?.relativePath ?? null, language: ed?.languageId ?? null, selection: ed?.selection ? { start_line: ed.selection.startLine, end_line: ed.selection.endLine } : null });
      }
      case 'jarvis_ide_search_code':
        return this.ideSearchCode(args);
      case 'jarvis_memory_read':
        return textResult(j.prefs.get('memory').trim() || '(empty)');
      case 'jarvis_memory_write': {
        const t = str(args.text).trim();
        const cur = j.prefs.get('memory');
        j.prefs.set('memory', (str(args.mode) === 'append' && cur.trim() ? `${cur}\n${t}` : t).slice(0, 4000));
        return textResult('Saved.');
      }
      default:
        return errorResult(`Unknown tool ${name}`);
    }
  }

  // ------------------------------------------------------------------ ownership

  /** The task [id] if [caller] directs it; otherwise the error to return (each Jarvis chat directs only its own tasks). */
  private owned(id: string, caller: string | null): [Task | null, McpResult | null] {
    const t = this.j.tasks.find(id.trim());
    if (!t) return [null, errorResult('No task with that id. Use jarvis_task_list.')];
    const owner = this.j.managers.ownerOf(t.owner);
    if (owner !== caller) {
      return [
        null,
        errorResult(`That task belongs to ${this.j.managers.nameOf(owner)}. Each Jarvis chat directs only its own tasks; start your own with jarvis_task_start if you need this work.`),
      ];
    }
    return [t, null];
  }

  /** Why [caller] must leave chat [id] alone: another Jarvis chat, or a task another Jarvis chat directs. Null: it may act. */
  private foreign(id: string, caller: string | null): string | null {
    if (this.j.managers.isManager(id) && id !== caller) return `That is ${this.j.managers.nameOf(id)}. Jarvis chats don't control each other's chats.`;
    const t = this.j.tasks.find(id, true);
    if (!t) return null;
    const owner = this.j.managers.ownerOf(t.owner);
    return owner !== caller ? `That chat is a task of ${this.j.managers.nameOf(owner)}: only that Jarvis chat directs it.` : null;
  }

  /** The chat id meant by args.id: a task's (also shortened), a chat's (also shortened, when unique), else as given; none = the chat on screen. */
  private resolveId(args: Args): string | null {
    const given = str(args.id).trim();
    if (!given) return this.j.host.screenChat()?.conversationId ?? null;
    const t = this.j.tasks.find(given);
    if (t) return t.id;
    const all = this.j.host.conversations();
    if (all.some((c) => c.id === given)) return given;
    if (given.length >= 6) {
      const hits = all.filter((c) => c.id.startsWith(given));
      if (hits.length === 1) return hits[0].id;
    }
    return given;
  }

  /** Counts a status check; true when it is more than [max] in [windowMs] (the model is polling). */
  private polling(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const l = (this.polls.get(key) ?? []).filter((t) => now - t <= windowMs);
    l.push(now);
    this.polls.set(key, l);
    return l.length > max;
  }

  // ------------------------------------------------------------------ tasks, missions, teams

  private agentArg(raw: string): AgentKind {
    switch (raw.toLowerCase()) {
      case 'claude':
        return 'CLAUDE';
      case 'agy':
      case 'antigravity':
        return 'AGY';
      case 'opencode':
        return 'OPENCODE';
      case 'codex':
        return 'CODEX';
      default: {
        const enabled = this.j.host.enabledKinds();
        const d = this.j.host.defaultAgent();
        return enabled.includes(d) ? d : (enabled[0] ?? 'CLAUDE');
      }
    }
  }

  /** Hidden in front of every task's goal: how a sub-agent of Jarvis works and reports, and its team's role. */
  private subAgentBrief(team: Team | undefined): string {
    let s =
      'You are a sub-agent of Jarvis, the lead agent of the AntiGem extension, which delegated this task to you. Work on it on your own until it is ' +
      'completely done: do not stop halfway to ask for confirmation, and ask a question only when you are truly blocked (it reaches Jarvis). ' +
      'Verify your work (build, tests, or running it) where that makes sense. Finish with a short report: what you did, the files you changed, ' +
      'how you verified it, and anything left open, risky or needing a decision. ' +
      'The jarvis_mcp tools (jarvis_*) belong to Jarvis, not to you: do not call them.';
    if (team) s += `\n\nYour team: ${team.name}.${team.role ? ` Your role: ${team.role}` : ''}`;
    return s;
  }

  private async taskStart(args: Args, caller: string): Promise<McpResult> {
    const j = this.j;
    const goal = str(args.goal).trim();
    if (!goal) return errorResult('goal is required');
    const teamArg = str(args.team).trim();
    const team = j.managers.team(caller, teamArg);
    if (teamArg && !team) {
      const have = j.managers.of(caller).teams.map((t) => t.name).join(', ');
      return errorResult(`No team "${teamArg}". ${have ? `Your teams: ${have}.` : 'Create it first with jarvis_team_create.'}`);
    }
    const agent = this.agentArg(str(args.agent) || team?.agent.toLowerCase() || '');
    if (!j.host.enabledKinds().includes(agent)) return errorResult(`${agentName(agent)} is turned off (Settings → Agents).`);
    const projectArg = str(args.project).trim() || team?.project || '';
    const project = projectArg ? await this.findProject(projectArg) : null;
    if (projectArg && !project) return errorResult(`No project matches "${projectArg}". Use jarvis_ide_list_projects.`);
    const modelArg = str(args.model).trim() || (team && team.agent === agent ? team.model : '');
    let model: string | null = null;
    if (modelArg) {
      const m = findModel(modelArg, this.modelsFor(agent));
      if (!m) return errorResult(`No ${agent.toLowerCase()} model matches "${modelArg}".`);
      model = m.id;
    }
    const t = await j.tasks.start(agent, goal, str(args.title) || null, model, project?.path ?? null, caller, team?.name ?? '', this.subAgentBrief(team));
    // work started: the autopilot's patience starts over
    j.managers.resetNudges(caller);
    if (bool(args.open)) setTimeout(() => j.host.showChat(t.id, t.agent), 2500);
    return json({ task_id: t.id, title: t.title, agent: agent.toLowerCase(), status: 'started', ...(team ? { team: team.name } : {}), note: NO_WAIT_NOTE });
  }

  private taskJson(t: Task) {
    const o: Record<string, unknown> = { id: t.id, title: t.title, agent: t.agent.toLowerCase(), state: TASK_LABEL[t.state] };
    if (t.team) o.team = t.team;
    o.started = ago(t.createdAt);
    o.last_change = ago(t.updatedAt);
    if (t.note) o.note = t.note;
    if (t.project) o.project = path.basename(t.project);
    if (t.followUps > 0) o.follow_ups = t.followUps;
    if (this.j.host.screenChat()?.conversationId === t.id) o.on_screen = true;
    return o;
  }

  private taskList(args: Args, caller: string): McpResult {
    const mine = str(args.scope || 'mine') !== 'all';
    const all = mine ? this.j.tasks.ownedBy(caller) : this.j.tasks.all();
    const anyActive = all.some((t) => this.j.tasks.isActive(t));
    if (anyActive && this.polling(`list:${caller}`, 3, 120_000)) return errorResult(POLL_STOP);
    const list = args.include_finished === false ? all.filter((t) => this.j.tasks.isActive(t)) : all;
    return json(
      paged('tasks', list.map((t) => this.taskJson(t)), args, {
        active: all.filter((t) => this.j.tasks.isActive(t)).length,
        ...(anyActive ? { reminder: 'Do not poll: end your turn, the news of these tasks comes to you by itself.' } : {}),
      }),
    );
  }

  private async taskGet(args: Args, caller: string | null): Promise<McpResult> {
    const j = this.j;
    const t = j.tasks.find(str(args.id));
    if (!t) return errorResult('No task with that id. Use jarvis_task_list.');
    if (j.tasks.isActive(t) && !needsUserState(t.state) && this.polling(`get:${caller}:${t.id}`, 2, 90_000)) return errorResult(POLL_STOP);
    const n = clamp(num(args.messages, 3), 0, 10);
    const max = clamp(num(args.max_chars, 600), 100, 30_000);
    const o: Record<string, unknown> = { ...this.taskJson(t), goal: t.goal };
    if (t.result) {
      o.result = t.result;
      if (t.resultChars > t.result.length)
        o.result_note = `Only the end of a ${t.resultChars}-character reply. All of it: jarvis_read_chat(id="${t.id}", role="assistant", limit=1, max_chars=30000).`;
    }
    const pending = j.controller.allPending().filter((p) => p.chatId === t.id);
    if (pending.length) o.waiting_approvals = pending.map((p) => ({ key: p.key, what: p.summary, risk: p.risk.toLowerCase() }));
    const q = j.driver.state(t.id)?.question?.questionnaire.questions[0];
    if (q) o.question = { text: q.prompt, options: q.options.filter((x) => !x.isCustomInput).map((x) => x.label) };
    if (n > 0) {
      const msgs = (j.driver.liveMessages(t.id)?.length ? j.driver.liveMessages(t.id)! : await j.driver.readChat(t.id)).filter((m) => m.content.trim() || m.toolCalls.length).slice(-n);
      o.latest = msgs.map((m) => {
        const tc = m.toolCalls[m.toolCalls.length - 1];
        return { role: roleName(m), text: cleanText(m.content, max), ...(tc ? { last_tool: `${tc.name} ${tc.command.slice(0, 80)} (${String(tc.status).toLowerCase()})`.trim() } : {}) };
      });
    }
    return json(o);
  }

  private missionSet(args: Args, caller: string): McpResult {
    const goal = str(args.goal).trim();
    if (!goal) return errorResult('goal is required');
    const steps = linesArg(args.steps);
    this.j.managers.setMission(caller, goal, str(args.done_when), steps, optBool(args.autopilot));
    this.j.log('mission', `Mission: ${goal.slice(0, 120)}`, caller);
    return textResult(`Mission set with ${steps.length} step(s). It is shown to the user and repeated to you with every message.\n\n${this.j.managers.brief(caller)}`);
  }

  private missionUpdate(args: Args, caller: string): McpResult {
    const m = this.j.managers;
    if (missionIsEmpty(m.of(caller).mission)) return errorResult('There is no mission yet. Start one with jarvis_mission_set.');
    const step = args.step != null && args.step !== '' ? num(args.step, NaN) : null;
    const ss = str(args.step_status).trim().toLowerCase();
    const stepStatus = ss === 'todo' || ss === 'doing' || ss === 'done' || ss === 'blocked' ? ss : null;
    const status = str(args.status).trim().toLowerCase() || null;
    const changed = m.updateMission(
      caller,
      step != null && Number.isFinite(step) ? step : null,
      stepStatus,
      str(args.note) || null,
      linesArg(args.add_steps),
      status,
      optBool(args.autopilot),
      'notes' in args ? str(args.notes) : null,
    );
    const mi = m.of(caller).mission;
    if (status === 'done') this.j.log('mission', `Mission done: ${mi.goal.slice(0, 120)}`, caller);
    return textResult(`Updated: ${changed}. ${missionDone(mi)}/${mi.steps.length} steps done.${mi.status === 'done' ? ' The mission is done: report the result to the user.' : ''}`);
  }

  private async teamCreate(args: Args, caller: string): Promise<McpResult> {
    const j = this.j;
    const name = str(args.name).trim().slice(0, 30);
    if (!name) return errorResult('name is required');
    const existing = j.managers.team(caller, name);
    const agent = !str(args.agent) && existing ? existing.agent : this.agentArg(str(args.agent));
    if (!j.host.enabledKinds().includes(agent)) return errorResult(`${agentName(agent)} is turned off (Settings → Agents).`);
    const modelArg = str(args.model).trim();
    let model = '';
    if (!modelArg) model = existing && existing.agent === agent ? existing.model : '';
    else {
      const m = findModel(modelArg, this.modelsFor(agent));
      if (!m) return errorResult(`No ${agent.toLowerCase()} model matches "${modelArg}".`);
      model = m.id;
    }
    const projectArg = str(args.project).trim();
    let project = existing?.project ?? '';
    if (projectArg) {
      const p = await this.findProject(projectArg);
      if (!p) return errorResult(`No project matches "${projectArg}".`);
      project = p.path;
    }
    const team: Team = { name, agent, model, role: (str(args.role).trim() || existing?.role || '').slice(0, 800), project };
    j.managers.upsertTeam(caller, team);
    return textResult(`${existing ? 'Updated' : 'Created'} team ${name} (${agent.toLowerCase()}${model ? `, ${model}` : ''}). Give it work with jarvis_task_start(team="${name}", goal=…).`);
  }

  private teamList(caller: string): McpResult {
    const m = this.j.managers.of(caller);
    const tasks = this.j.tasks.ownedBy(caller);
    return json({
      teams: m.teams.map((t) => ({
        name: t.name,
        agent: t.agent.toLowerCase(),
        model: t.model || 'default',
        role: t.role,
        project: path.basename(t.project) || 'active project',
        running_tasks: tasks.filter((x) => x.team.toLowerCase() === t.name.toLowerCase() && this.j.tasks.isActive(x)).length,
      })),
    });
  }

  // ------------------------------------------------------------------ state, config and help

  private health(): McpResult {
    const j = this.j;
    const agents: Record<string, unknown> = {};
    for (const k of ['AGY', 'CLAUDE', 'CODEX', 'OPENCODE'] as AgentKind[]) {
      const b = j.host.backend(k);
      if (!b) {
        agents[k.toLowerCase()] = 'turned off';
        continue;
      }
      const s = b.status();
      agents[k.toLowerCase()] = { state: s.state, ...(s.detail ? { detail: s.detail } : {}), ...(s.version ? { version: s.version } : {}), ...(s.account ? { account: s.account } : {}) };
    }
    return json({
      antigem: j.host.isOff() ? 'turned off (drawer ⏻)' : 'on',
      agents,
      jarvis_mcp: j.mcp.boundPort ? `served by this window on 127.0.0.1:${j.mcp.boundPort}` : 'served by another VS Code window',
      jarvis: { enabled: j.prefs.get('enabled'), jarvis_chats: j.managers.keys().length, active_tasks: j.tasks.active().length },
    });
  }

  private convJson(c: Conversation) {
    const o: Record<string, unknown> = { id: c.id, title: c.title, agent: c.agent.toLowerCase(), running: this.j.driver.isBusy(c.id) || c.isRunning };
    o.project = path.basename(c.workspaceUri.replace(/^file:\/\//, '').replace(/\/+$/, ''));
    if (c.modelId) o.model = c.modelId;
    o.updated = ago(c.updatedAt);
    if (this.j.prefs.isJarvisChat(c.id)) o.jarvis_chat = true;
    if (this.j.tasks.isTask(c.id)) o.task = true;
    if (this.j.host.screenChat()?.conversationId === c.id) o.on_screen = true;
    return o;
  }

  private getState(caller: string | null): McpResult {
    const j = this.j;
    const h = j.host;
    const screen = h.screenChat();
    const conv = screen?.conversationId ? h.conversations().find((c) => c.id === screen.conversationId) : undefined;
    const pending = j.controller.pendingFor(caller);
    const ed = h.editorContext();
    return json({
      vscode: {
        workspace: h.workspaceFolders().map((f) => ({ name: f.name, path: f.path })),
        active_project: j.activeProjectPath() || null,
        active_file: ed?.path ?? null,
        selection: ed?.selection ? `${ed.selection.startLine}-${ed.selection.endLine}` : null,
      },
      chat_on_screen: conv ? { ...this.convJson(conv), busy: j.driver.isBusy(conv.id) } : screen ? { new_chat: true, agent: screen.agent.toLowerCase() } : null,
      tasks: j.tasks.all().slice(0, 8).map((t) => this.taskJson(t)),
      running_chats: h
        .conversations()
        .filter((c) => c.isRunning && !j.prefs.isJarvisChat(c.id))
        .slice(0, 10)
        .map((c) => this.convJson(c)),
      pending_permissions: { count: pending.length, items: pending.slice(0, 5).map((p) => ({ key: p.key, what: p.summary, risk: p.risk.toLowerCase() })) },
      jarvis: { manager_id: caller, permission_policy: j.prefs.get('permissionPolicy'), jarvis_chats: j.managers.keys().length },
    });
  }

  private async getConfig(args: Args): Promise<McpResult> {
    const j = this.j;
    const area = (str(args.area) || 'overview').toLowerCase();
    const out: Record<string, unknown> = {};
    const agents = () => ({
      enabled: j.host.enabledKinds().map((k) => k.toLowerCase()),
      new_chat_agent: j.host.defaultAgent().toLowerCase(),
      each: Object.fromEntries(
        j.host.enabledKinds().map((k) => {
          const b = j.host.backend(k)!;
          const s = b.status();
          const m = b.models();
          return [k.toLowerCase(), { state: s.state, version: s.version ?? null, account: s.account ?? null, plan: s.plan ?? null, selected_model: m.selectedId, models: m.models.length }];
        }),
      ),
    });
    const jarvis = () => ({
      agent: j.prefs.agentKind()?.toLowerCase() ?? 'last used / new-chat agent',
      model: j.prefs.get('modelId') || 'default',
      permission_policy: j.prefs.get('permissionPolicy'),
      task_approvals: j.prefs.get('taskApprovals'),
      event_routing: j.prefs.get('eventRouting'),
      stall_minutes: j.prefs.get('stallMinutes'),
      wait_guard: j.prefs.get('waitGuard'),
      app_settings_allowed: j.prefs.get('allowSettingChanges'),
      chats_in_list: j.prefs.get('listMode'),
    });
    switch (area) {
      case 'agents':
        out.agents = agents();
        break;
      case 'mcp': {
        const st = await j.setup.status(true).catch(() => null);
        out.jarvis_mcp_added = st;
        out.where = "Each agent's MCP servers: Settings → <agent> → MCP servers. Jarvis: Settings → Jarvis → Setup.";
        break;
      }
      case 'jarvis':
        out.jarvis = jarvis();
        break;
      case 'appearance': {
        const p = j.host.uiPrefs();
        out.appearance = { theme_mode: p.theme ?? 'auto', light_theme: p.lightTheme ?? null, dark_theme: p.darkTheme ?? null, chat_font_scale: p.chatFontScale ?? 1 };
        break;
      }
      case 'projects': {
        const ps = await j.host.projects();
        out.projects = { active: j.activeProjectPath() || null, list: ps.slice(0, 15).map((p) => p.name) };
        break;
      }
      default:
        out.agents = agents();
        out.jarvis = jarvis();
        out.theme_mode = j.host.uiPrefs().theme ?? 'auto';
    }
    return json(out);
  }

  private openSettings(args: Args): McpResult {
    const want = str(args.section).trim().toLowerCase().replace(/\s+/g, '_');
    const pages: Record<string, string> = {
      root: 'root',
      main: 'root',
      settings: 'root',
      agents: 'agents',
      agent: 'agents',
      agy: 'agy',
      antigravity: 'agy',
      claude: 'claude',
      claude_code: 'claude',
      codex: 'codex',
      opencode: 'opencode',
      slash: 'slash',
      commands: 'slash',
      slash_commands: 'slash',
      context: 'context',
      global_context: 'context',
      connection: 'connection',
      bridge: 'connection',
      jarvis: 'jarvis',
      jarvis_setup: 'jarvis.setup',
      setup: 'jarvis.setup',
      approvals: 'jarvis.approvals',
      permissions: 'jarvis.approvals',
      tasks: 'jarvis.tasks',
      personality: 'jarvis.personality',
      mcp: 'jarvis.setup',
      claude_mcp: 'claude.mcp',
      agy_mcp: 'agy.mcp',
      codex_mcp: 'codex.mcp',
      opencode_mcp: 'opencode.mcp',
    };
    const page = pages[want] ?? (/^(agy|claude|codex|opencode|jarvis)\.[a-z_.]+$/.test(want) ? want : null);
    if (!page) return errorResult(`No settings page "${want}". Pages: ${Object.keys(pages).join(', ')}.`);
    this.j.host.postActive({ type: 'jarvisNavigate', screen: 'settings', settingsPage: page, conversationId: null });
    return textResult(`Opened Settings → ${page}.`);
  }

  private getUsage(args: Args): McpResult {
    const which = (str(args.agent) || 'all').toLowerCase();
    const out: Record<string, unknown> = {};
    for (const k of this.j.host.enabledKinds()) {
      const key = k === 'AGY' ? 'agy' : k.toLowerCase();
      if (which !== 'all' && which !== key) continue;
      const b = this.j.host.backend(k)!;
      const groups = b.models().groups ?? [];
      const withWindows = groups.filter((g) => g.windows?.length);
      out[key === 'agy' ? 'antigravity' : key] = withWindows.length
        ? withWindows.map((g) => ({
            group: g.name,
            windows: (g.windows ?? []).map((w) => ({ window: w.label, percent_left: Math.round(w.remaining * 100), shown_as: w.text ?? null, resets_in: w.resetText ?? null })),
          }))
        : { note: `No usage information from ${agentName(k)} yet (signed in and running?).` };
    }
    return json(out);
  }

  // ------------------------------------------------------------------ chats

  private listChats(args: Args): McpResult {
    const agent = (str(args.agent) || 'all').toLowerCase();
    const running = bool(args.running);
    const project = str(args.project).toLowerCase();
    const query = str(args.query).toLowerCase();
    const includeJarvis = bool(args.include_jarvis);
    let list = this.j.host.conversations().filter(
      (c) =>
        (includeJarvis || !this.j.prefs.isJarvisChat(c.id)) &&
        (agent === 'all' || c.agent.toLowerCase() === agent || (agent === 'antigravity' && c.agent === 'AGY')) &&
        (!running || c.isRunning || this.j.driver.isBusy(c.id)) &&
        (!project || c.workspaceUri.toLowerCase().includes(project)) &&
        (!query || c.title.toLowerCase().includes(query)),
    );
    switch (str(args.sort) || 'updated_desc') {
      case 'updated_asc':
        list = [...list].sort((a, b) => a.updatedAt - b.updatedAt);
        break;
      case 'created_desc':
        list = [...list].sort((a, b) => b.createdAt - a.createdAt);
        break;
      case 'title_asc':
        list = [...list].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
        break;
      default:
        list = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return json(paged('chats', list.map((c) => this.convJson(c)), args));
  }

  private async getChat(args: Args): Promise<McpResult> {
    const id = this.resolveId(args);
    if (!id) return errorResult('No chat on screen. Give an id.');
    const c = this.j.host.conversations().find((x) => x.id === id);
    if (!c) return errorResult('No chat with that id.');
    const msgs = await this.j.driver.readChat(id);
    const pending = this.j.controller.allPending().filter((p) => p.chatId === id);
    const st = this.j.driver.state(id);
    return json({
      ...this.convJson(c),
      message_count: msgs.length,
      waiting_permissions: pending.length ? pending.map((p) => ({ key: p.key, what: p.summary, risk: p.risk.toLowerCase() })) : (st?.approvals ?? []).map((a) => ({ key: a.key, what: a.title })),
      last_messages: msgs.slice(-3).map((m) => ({ role: roleName(m), text: cleanText(m.content, 300) })),
    });
  }

  private async readChat(args: Args): Promise<McpResult> {
    const id = this.resolveId(args);
    if (!id) return errorResult('No chat on screen. Give an id.');
    let msgs = await this.j.driver.readChat(id);
    const role = str(args.role) || 'all';
    if (role !== 'all') msgs = msgs.filter((m) => roleName(m) === role);
    msgs = msgs.filter((m) => m.content.trim() || m.toolCalls.length);
    if (!msgs.length) {
      return errorResult(
        role !== 'all'
          ? `That chat has no ${role} messages.`
          : `Nothing could be read from chat "${id}". Check the id (jarvis_task_list or jarvis_list_chats give the full one); a chat that was just created may need a moment.`,
      );
    }
    const fromEnd = args.from_end !== false;
    const ordered = fromEnd ? [...msgs].reverse() : msgs;
    const max = clamp(num(args.max_chars, 800), 100, 30_000);
    const tools = bool(args.include_tools);
    const items = ordered.map((m) => {
      const whole = JText.report(m.content);
      const o: Record<string, unknown> = { role: roleName(m), text: whole.length > max ? `${whole.slice(0, max)}…` : whole };
      if (whole.length > max) {
        o.chars = whole.length;
        o.cut = true;
      }
      if (tools && m.toolCalls.length) o.tools = m.toolCalls.slice(0, 12).map((t) => ({ name: t.name, command: t.command.slice(0, 160), status: t.status }));
      o.time = ago(m.createdAt);
      return o;
    });
    return json(paged('messages', items, args, { order: fromEnd ? 'newest_first' : 'oldest_first', chat_id: id }));
  }

  private async searchChats(args: Args): Promise<McpResult> {
    const q = str(args.query).toLowerCase().trim();
    if (!q) return errorResult('query is empty');
    const all = this.j.host
      .conversations()
      .filter((c) => !this.j.prefs.isJarvisChat(c.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const hits = new Map<string, Record<string, unknown>>();
    for (const c of all) if (c.title.toLowerCase().includes(q)) hits.set(c.id, { ...this.convJson(c), matched: 'title' });
    if (bool(args.deep)) {
      const results = await Promise.all(this.j.host.enabledKinds().map((k) => this.j.host.backend(k)?.search?.(q).catch(() => []) ?? Promise.resolve([])));
      for (const list of results)
        for (const h of list) {
          if (hits.has(h.conversationId)) continue;
          const c = all.find((x) => x.id === h.conversationId);
          if (c) hits.set(c.id, { ...this.convJson(c), matched: 'content', snippet: cleanText(h.snippet, 200) });
        }
    }
    return json(paged('chats', [...hits.values()], args));
  }

  private async newChat(args: Args, caller: string): Promise<McpResult> {
    const agent = this.agentArg(str(args.agent));
    const message = str(args.message).trim();
    if (message) return this.taskStart({ ...args, goal: message, agent: agent === 'AGY' ? 'agy' : agent.toLowerCase() }, caller);
    if (!this.j.host.enabledKinds().includes(agent)) return errorResult(`${agentName(agent)} is turned off (Settings → Agents).`);
    const projectArg = str(args.project).trim();
    if (projectArg) {
      const p = await this.findProject(projectArg);
      if (!p) return errorResult(`No project matches "${projectArg}". Use jarvis_ide_list_projects.`);
      this.j.prefs.set('activeProject', p.path);
    }
    this.j.host.showChat(null, agent);
    return textResult(`Started an empty ${agent.toLowerCase()} chat on screen.`);
  }

  // ------------------------------------------------------------------ models and chat controls

  private modelsFor(agent: AgentKind): AiModel[] {
    return this.j.host.backend(agent)?.models().models ?? [];
  }

  private listModels(args: Args): McpResult {
    const screen = this.j.host.screenChat();
    const which = (str(args.agent) || screen?.agent.toLowerCase() || 'all').toLowerCase();
    const out: Record<string, unknown> = {};
    for (const k of this.j.host.enabledKinds()) {
      const key = k === 'AGY' ? 'agy' : k.toLowerCase();
      if (which !== 'all' && which !== key && !(which === 'antigravity' && k === 'AGY')) continue;
      const st = this.j.host.backend(k)!.models();
      out[k === 'AGY' ? 'antigravity' : key] = st.models.map((m) => ({ id: m.id, name: m.displayName || m.id, selected: m.id === st.selectedId }));
    }
    out.jarvis_chat_model = this.j.prefs.get('modelId') || 'default';
    return json(out);
  }

  private setModel(args: Args, caller: string | null): McpResult {
    const j = this.j;
    const wanted = str(args.model).trim();
    if (!wanted) return errorResult('model is required');
    const raw = str(args.id).trim();
    const chat = raw ? (j.tasks.find(raw)?.id ?? this.resolveId(args) ?? raw) : '';
    if (chat && chat !== caller) {
      const f = this.foreign(chat, caller);
      if (f) return errorResult(f);
    }
    // a Jarvis chat's "jarvis" model is its own
    const target = chat || (str(args.scope) === 'jarvis' ? caller : j.host.screenChat()?.conversationId) || null;
    if (!target) return errorResult('No chat on screen. Pass id to change another chat.');
    if (!chat && target !== caller) {
      const f = this.foreign(target, caller);
      if (f) return errorResult(f);
    }
    const kind = j.driver.agentOf(target);
    if (!kind) return errorResult('No chat with that id.');
    const m = findModel(wanted, this.modelsFor(kind));
    if (!m) return errorResult(`No ${kind.toLowerCase()} model matches "${wanted}".`);
    j.controller.setChatModel(target, kind, m.id);
    return textResult(target === caller ? `This chat now uses ${m.displayName || m.id} from its next message.` : `Chat model set to ${m.displayName || m.id}.`);
  }

  private async claudeControl(name: string, args: Args): Promise<McpResult> {
    const id = this.resolveId(args);
    const b = id ? this.j.driver.backendOf(id) : undefined;
    if (!id || !b || b.kind !== 'CLAUDE' || !b.setControl) return errorResult('That is not a Claude Code chat (pass the id of one, or open it on screen).');
    if (name === 'jarvis_set_effort') {
      const level = str(args.level).toLowerCase() || 'default';
      await b.setControl(id, 'effort', level);
      return textResult(`Effort set to ${level}.`);
    }
    if (name === 'jarvis_set_thinking') {
      const on = bool(args.enabled);
      await b.setControl(id, 'thinking', on ? 'on' : 'off');
      return textResult(`Thinking is now ${on ? 'on' : 'off'}.`);
    }
    const mode = str(args.mode);
    if (!['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'].includes(mode)) return errorResult(`Unknown mode ${mode}`);
    await b.setControl(id, 'mode', mode);
    return textResult(`Permission mode is now ${mode}.`);
  }

  // ------------------------------------------------------------------ settings

  private settingList(): Setting[] {
    const j = this.j;
    const p = j.prefs;
    const choice = (key: string, about: string, own: boolean, choices: string[], get: () => string, set: (v: string) => void): Setting => ({
      key,
      about,
      values: choices.join('|'),
      own,
      get,
      set: (v) => {
        const c = choices.find((x) => x.toLowerCase() === v.trim().toLowerCase());
        if (!c) return `Use one of ${choices.join(', ')}.`;
        set(c);
        return null;
      },
    });
    const int = (key: string, about: string, lo: number, hi: number, get: () => number, set: (v: number) => void): Setting => ({
      key,
      about,
      values: `${lo}-${hi}`,
      own: true,
      get,
      set: (v) => {
        const n = Number(v.trim());
        if (!Number.isFinite(n)) return 'Not a number.';
        set(Math.min(hi, Math.max(lo, Math.round(n))));
        return null;
      },
    });
    const ro = (key: string, about: string, get: () => unknown): Setting => ({ key, about, values: 'read-only', own: true, readOnly: true, get });
    return [
      // ---- app (only when the user allowed it)
      choice('theme_mode', 'Light, dark or follow VS Code (auto)', false, ['auto', 'light', 'dark'], () => String(j.host.uiPrefs().theme ?? 'auto'), (v) => j.host.patchUiPrefs({ theme: v })),
      {
        key: 'chat_font_scale',
        about: 'Chat text size',
        values: '0.75-1.6',
        own: false,
        get: () => Number(j.host.uiPrefs().chatFontScale ?? 1),
        set: (v) => {
          const n = Number(v.trim().replace(/x$/, ''));
          if (!Number.isFinite(n)) return 'Not a number.';
          j.host.patchUiPrefs({ chatFontScale: Math.round(Math.min(1.6, Math.max(0.75, n)) * 100) / 100 });
          return null;
        },
      },
      {
        key: 'new_chat_agent',
        about: 'Agent of new chats',
        values: 'claude|agy|opencode|codex',
        own: false,
        get: () => j.host.defaultAgent().toLowerCase(),
        set: (v) => {
          const a = ({ claude: 'CLAUDE', agy: 'AGY', antigravity: 'AGY', opencode: 'OPENCODE', codex: 'CODEX' } as Record<string, AgentKind>)[v.trim().toLowerCase()];
          if (!a) return 'Use claude, agy, opencode or codex.';
          if (!j.host.enabledKinds().includes(a)) return 'That agent is turned off (Settings → Agents).';
          j.host.setDefaultAgent(a);
          return null;
        },
      },
      // ---- Jarvis' own options (always allowed)
      choice('jarvis_event_routing', 'Task news: the Jarvis chat decides what to do (model), or just a notice (speak)', true, ['model', 'speak'], () => p.get('eventRouting'), (v) => p.set('eventRouting', v)),
      int('jarvis_stall_minutes', 'Report a task with no progress after this many minutes (0 = never)', 0, 240, () => p.get('stallMinutes'), (v) => p.set('stallMinutes', v)),
      choice('jarvis_wait_guard', 'A Jarvis chat that waits inside its turn: stop it (interrupt), only remind it, or off', true, ['interrupt', 'remind', 'off'], () => p.get('waitGuard'), (v) => p.set('waitGuard', v)),
      int('jarvis_event_batch_ms', 'News within this time goes to Jarvis together (milliseconds)', 0, 30_000, () => p.get('eventBatchMs'), (v) => p.set('eventBatchMs', v)),
      int('jarvis_autopilot_max_nudges', 'Autopilot pauses after this many nudges without progress', 1, 20, () => p.get('autopilotMaxNudges'), (v) => p.set('autopilotMaxNudges', v)),
      {
        key: 'jarvis_context_in_prompt',
        about: 'Send live context with every message',
        values: 'true|false',
        own: true,
        get: () => p.get('contextInPrompt'),
        set: (v) => {
          const b = parseBool(v);
          if (b == null) return 'Use true or false.';
          p.set('contextInPrompt', b);
          return null;
        },
      },
      {
        key: 'jarvis_persona',
        about: 'Whom Jarvis speaks as (grammatical gender for itself, e.g. Hindi kar rahi / kar raha hoon)',
        values: 'female|male|neutral|unset',
        own: true,
        get: () => p.get('persona') || 'unset',
        set: (v) => {
          const x = v.trim().toLowerCase();
          if (x === 'female' || x === 'male' || x === 'neutral') p.set('persona', x);
          else if (x === 'unset' || x === 'none' || x === '') p.set('persona', '');
          else return 'Use female, male, neutral or unset.';
          return null;
        },
      },
      choice('jarvis_chats_in_list', 'Jarvis chats in All too: none, text (your Jarvis chats) or all', true, ['none', 'text', 'all'], () => p.get('listMode'), (v) => p.set('listMode', v as 'none' | 'text' | 'all')),
      // ---- read only (changed by the user in Settings → Jarvis)
      ro('jarvis_agent', 'Agent of new Jarvis chats', () => p.agentKind()?.toLowerCase() ?? 'last used'),
      ro('jarvis_model', 'Model of new Jarvis chats', () => p.get('modelId') || 'default'),
      ro('jarvis_permission_policy', 'Approval policy', () => p.get('permissionPolicy')),
      ro('jarvis_task_approvals', 'Approvals inside tasks', () => p.get('taskApprovals')),
      ro('jarvis_allow_setting_changes', 'Jarvis may change app settings', () => p.get('allowSettingChanges')),
      ro('jarvis_about_user', "The user's own notes for Jarvis (edited by the user in Settings → Jarvis; use jarvis_memory_write for your own notes)", () => p.get('aboutUser') || '(empty)'),
    ];
  }

  private getSetting(args: Args): McpResult {
    const list = this.settingList();
    const key = str(args.key).trim().toLowerCase();
    const allowed = this.j.prefs.get('allowSettingChanges');
    if (key) {
      const s = list.find((x) => x.key === key);
      if (!s) return errorResult(`Unknown setting. Known: ${list.map((x) => x.key).join(', ')}`);
      return textResult(`${s.key} = ${String(s.get())} (${s.values}) — ${s.about}${!s.own && !allowed ? "; changing it needs the user's permission" : ''}`);
    }
    return json({ app_settings_changeable: allowed, settings: list.map((s) => ({ key: s.key, value: s.get(), values: s.values, about: s.about })) });
  }

  private setSetting(args: Args): McpResult {
    const list = this.settingList();
    const key = str(args.key).trim().toLowerCase();
    const v = str(args.value).trim();
    const s = list.find((x) => x.key === key);
    if (!s) return errorResult(`Unknown setting. Known: ${list.filter((x) => !x.readOnly).map((x) => x.key).join(', ')}`);
    if (s.readOnly || !s.set) return errorResult(`${key} can only be changed by the user in Settings → Jarvis. Offer to open it (jarvis_open_settings section=jarvis).`);
    if (!s.own && !this.j.prefs.get('allowSettingChanges'))
      return errorResult('The user has not allowed Jarvis to change app settings. They can allow it in Settings → Jarvis → Approvals ("Let Jarvis change app settings"), or change it themselves.');
    const err = s.set(v);
    if (err) return errorResult(`${key}: ${err}`);
    return textResult(`${key} set to ${String(s.get())}.`);
  }

  // ------------------------------------------------------------------ projects and VS Code

  private async findProject(text: string): Promise<ProjectView | null> {
    const raw = text.trim().replace(/\/+$/, '');
    const t = raw.toLowerCase();
    const all = await this.j.host.projects();
    const hit =
      all.find((p) => p.path.toLowerCase() === t) ??
      all.find((p) => p.name.toLowerCase() === t) ??
      all.find((p) => p.name.toLowerCase().includes(t)) ??
      all.find((p) => p.path.toLowerCase().includes(t));
    if (hit) return hit;
    const abs = raw.startsWith('~/') ? path.join(process.env.HOME ?? '', raw.slice(2)) : raw;
    try {
      if (path.isAbsolute(abs) && fs.statSync(abs).isDirectory()) return { name: path.basename(abs), path: abs, uri: `file://${abs}`, source: 'saved' };
    } catch {
      /* not a folder */
    }
    return null;
  }

  private async ideListProjects(args: Args): Promise<McpResult> {
    const q = str(args.query).toLowerCase();
    const active = this.j.activeProjectPath();
    const list = (await this.j.host.projects()).filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
    return json(paged('projects', list.map((p) => ({ name: p.name, path: p.path, active: p.path === active, source: p.source })), args));
  }

  private async ideOpenProject(args: Args): Promise<McpResult> {
    const wanted = str(args.project).trim();
    if (!wanted) return errorResult('project is required');
    const p = await this.findProject(wanted);
    if (!p) return errorResult(`No project matches "${wanted}". Use jarvis_ide_list_projects.`);
    this.j.prefs.set('activeProject', p.path);
    await this.j.host.saveProject(p.path).catch(() => undefined);
    return textResult(`${p.name} is now the active project (new tasks and chats work there).`);
  }

  private async resolveFile(file: string, root: string): Promise<string | null> {
    const f = file.trim();
    if (f.startsWith('~/')) return path.join(process.env.HOME ?? '', f.slice(2));
    if (path.isAbsolute(f)) return f;
    if (root && f.includes('/')) {
      const p = path.join(root, f.replace(/^\.\//, ''));
      if (fs.existsSync(p)) return p;
    }
    // just a name: the editor's file search (open editors first, then the workspace)
    const hits = await this.j.host.searchFiles(f).catch(() => []);
    const lower = f.toLowerCase();
    const files = hits.filter((h) => h.kind !== 'folder');
    const hit =
      files.find((h) => path.basename(h.path).toLowerCase() === lower) ??
      files.find((h) => h.path.toLowerCase().endsWith(`/${lower}`)) ??
      files.find((h) => path.basename(h.path).toLowerCase().startsWith(lower)) ??
      files[0];
    if (hit) return hit.path;
    if (root) {
      const p = path.join(root, f);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  private async ideOpenFile(args: Args): Promise<McpResult> {
    const file = str(args.file).trim();
    if (!file) return errorResult('file is required');
    let root = this.j.activeProjectPath();
    const pn = str(args.project).trim();
    if (pn) {
      const p = await this.findProject(pn);
      if (!p) return errorResult(`No project matches "${pn}".`);
      root = p.path;
    }
    const p = await this.resolveFile(file, root);
    if (!p) return errorResult(`Could not find "${file}". Give its path, or open the right project first.`);
    try {
      if (fs.statSync(p).isDirectory()) return errorResult(`${p} is a folder.`);
    } catch {
      return errorResult(`Could not read ${p}.`);
    }
    const line = num(args.line, 0);
    this.j.host.openFile(p, line > 0 ? line : undefined);
    return textResult(`Opened ${path.basename(p)}.`);
  }

  private async ideSearchCode(args: Args): Promise<McpResult> {
    const q = str(args.query).trim();
    if (!q) return errorResult('query is empty');
    const pn = str(args.project).trim();
    let dir = this.j.activeProjectPath();
    if (pn) {
      const p = await this.findProject(pn);
      if (!p) return errorResult(`No project matches "${pn}".`);
      dir = p.path;
    }
    if (!dir) return errorResult('No project is open. Use jarvis_ide_open_project first.');
    let hits: { path: string; line: number; text: string }[] = [];
    try {
      const r = await this.j.bridge.json<{ path: string; line_number?: number; lineNumber?: number; line_text?: string; lineText?: string }[]>(
        `/api/search?q=${encodeURIComponent(q)}&dir=${encodeURIComponent(dir)}`,
      );
      hits = (Array.isArray(r) ? r : []).map((m) => ({ path: m.path, line: Number(m.line_number ?? m.lineNumber ?? 0), text: String(m.line_text ?? m.lineText ?? '') }));
    } catch {
      hits = [];
    }
    // the bridge searches with ripgrep; without it (or when it found nothing) a small search here
    if (!hits.length) hits = grep(dir, q, 400);
    return json(paged('matches', hits.map((h) => ({ file: path.relative(dir, h.path) || h.path, line: h.line, text: h.text.trim().slice(0, 160) })), args));
  }
}

interface Setting {
  key: string;
  about: string;
  values: string;
  own: boolean;
  readOnly?: boolean;
  get: () => unknown;
  set?: (v: string) => string | null;
}

// ------------------------------------------------------------------------------------------------ helpers

/** The card line for a tool, so the user sees progress even when the model forgets jarvis_status. */
function friendlyStatus(name: string, args: Args): string | null {
  switch (name) {
    case 'jarvis_status':
    case 'jarvis_stop_all':
    case 'jarvis_list_timers':
    case 'jarvis_help':
    case 'jarvis_speak':
    case 'jarvis_ask':
    case 'jarvis_ignore':
      return null;
    case 'jarvis_get_state':
      return 'Checking what is open';
    case 'jarvis_get_usage':
      return 'Checking your usage';
    case 'jarvis_task_start':
      return `Starting ${str(args.title).slice(0, 30) || 'a task'}`;
    case 'jarvis_task_list':
    case 'jarvis_task_get':
      return 'Checking your tasks';
    case 'jarvis_task_reply':
      return 'Updating the task';
    case 'jarvis_task_answer':
      return 'Answering the task';
    case 'jarvis_task_stop':
      return 'Stopping the task';
    case 'jarvis_task_open':
      return 'Opening the task';
    case 'jarvis_task_close':
      return 'Closing the task';
    case 'jarvis_mission_set':
      return 'Planning the mission';
    case 'jarvis_mission_update':
    case 'jarvis_mission_get':
      return 'Updating the mission';
    case 'jarvis_team_create':
    case 'jarvis_team_list':
    case 'jarvis_team_delete':
      return 'Organizing teams';
    case 'jarvis_app_guide':
      return 'Looking it up';
    case 'jarvis_get_config':
      return 'Reading your setup';
    case 'jarvis_open_settings':
      return 'Opening settings';
    case 'jarvis_list_chats':
    case 'jarvis_search_chats':
      return 'Looking through your chats';
    case 'jarvis_get_chat':
    case 'jarvis_read_chat':
      return 'Reading a chat';
    case 'jarvis_new_chat':
      return 'Starting a new chat';
    case 'jarvis_send_to_chat':
      return 'Sending your message';
    case 'jarvis_stop_chat':
      return 'Stopping the chat';
    case 'jarvis_open_chat':
      return 'Opening the chat';
    case 'jarvis_rename_chat':
    case 'jarvis_fork_chat':
    case 'jarvis_delete_chat':
      return 'Updating the chat';
    case 'jarvis_list_models':
      return 'Checking models';
    case 'jarvis_set_model':
      return 'Switching model';
    case 'jarvis_set_effort':
    case 'jarvis_set_thinking':
    case 'jarvis_set_permission_mode':
      return 'Changing chat settings';
    case 'jarvis_get_setting':
    case 'jarvis_set_setting':
      return 'Updating settings';
    case 'jarvis_list_permissions':
      return 'Checking approvals';
    case 'jarvis_resolve_permission':
      return 'Handling an approval';
    case 'jarvis_open_screen':
      return `Opening ${str(args.screen)}`;
    case 'jarvis_ide_list_projects':
      return 'Looking at your projects';
    case 'jarvis_ide_open_project':
      return `Opening ${str(args.project).slice(0, 30)}`;
    case 'jarvis_ide_open_file':
      return `Opening ${path.basename(str(args.file)).slice(0, 30)}`;
    case 'jarvis_ide_get_open_files':
      return 'Checking the editor';
    case 'jarvis_ide_search_code':
      return 'Searching the code';
    case 'jarvis_open_url':
      return 'Opening the page';
    case 'jarvis_set_timer':
    case 'jarvis_cancel_timer':
      return 'Setting a timer';
    case 'jarvis_get_health':
      return 'Checking the system';
    case 'jarvis_memory_read':
    case 'jarvis_memory_write':
      return 'Updating memory';
    default:
      return null;
  }
}

const str = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : String(v));
const bool = (v: unknown): boolean => v === true || v === 'true';
const optBool = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const num = (v: unknown, d: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
const json = (o: unknown): McpResult => textResult(JSON.stringify(o, null, 2));
const parseBool = (v: string): boolean | null => {
  const t = v.trim().toLowerCase();
  if (['true', 'on', 'yes', '1', 'enable', 'enabled'].includes(t)) return true;
  if (['false', 'off', 'no', '0', 'disable', 'disabled'].includes(t)) return false;
  return null;
};

/** "a\nb" or "a; b" or a JSON array → the list of lines (numbering and bullets taken off). */
function linesArg(v: unknown): string[] {
  if (v == null) return [];
  const raw = Array.isArray(v) ? v.map(String) : String(v).includes('\n') ? String(v).split('\n') : String(v).split(';');
  return raw.map((s) => s.trim().replace(/^[-*]/, '').trim().replace(/^\d+[.)]\s*/, '')).filter(Boolean);
}

function findModel(text: string, models: AiModel[]): AiModel | undefined {
  const t = text.toLowerCase().trim();
  const exact = models.find((m) => m.id.toLowerCase() === t || m.displayName.toLowerCase() === t || (m.key ?? '').toLowerCase() === t);
  if (exact) return exact;
  const tokens = t.split(/[\s\-_]+/).filter(Boolean);
  return models.find((m) => {
    const hay = `${m.id} ${m.displayName}`.toLowerCase();
    return tokens.every((x) => hay.includes(x));
  });
}

function roleName(m: ChatMessage): string {
  return m.role === 'USER' ? 'user' : m.role === 'ASSISTANT' ? 'assistant' : m.role.toLowerCase();
}

function cleanText(s: string, max: number): string {
  // what was written, without the model's thinking, tool markers, error cards or hidden notes
  const c = JText.report(s);
  return c.length > max ? `${c.slice(0, max)}…` : c;
}

function ago(ms: number): string {
  if (ms <= 0) return 'unknown';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

function inText(ms: number): string {
  const m = Math.floor((ms - Date.now()) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / (24 * 60))} days ${Math.floor((m % (24 * 60)) / 60)} h`;
}

function paged(key: string, items: unknown[], args: Args, extra: Record<string, unknown> = {}) {
  const l = clamp(num(args.limit, DEFAULT_LIMIT), 1, MAX_LIMIT);
  const off = args.page != null && args.page !== '' ? (Math.max(1, num(args.page, 1)) - 1) * l : Math.max(0, num(args.offset, 0));
  const slice = items.slice(off, off + l);
  const more = off + slice.length < items.length;
  return {
    total: items.length,
    offset: off,
    limit: l,
    page: Math.floor(off / l) + 1,
    pages: items.length ? Math.ceil(items.length / l) : 0,
    has_more: more,
    ...(more ? { next_offset: off + slice.length } : {}),
    [key]: slice,
    ...extra,
  };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', '__pycache__', 'target', '.gradle', '.idea']);

/** A small plain-text search (used when the bridge's ripgrep found nothing or is missing). */
function grep(root: string, query: string, max: number): { path: string; line: number; text: string }[] {
  const out: { path: string; line: number; text: string }[] = [];
  const needle = query.toLowerCase();
  let files = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || out.length >= max || files > 8000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      files++;
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.size > 1_000_000) continue;
      let content: string;
      try {
        content = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && out.length < max; i++) if (lines[i].toLowerCase().includes(needle)) out.push({ path: p, line: i + 1, text: lines[i] });
    }
  };
  walk(root, 0);
  return out;
}
