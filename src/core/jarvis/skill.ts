// What the Jarvis model is told (port of the app's JarvisSkill.kt, text chats only, rewritten for VS Code).
// The first message of every Jarvis chat carries the whole guide: the rules, how to be a manager, and the complete
// list of jarvis_mcp tools with their parameters, plus the memory note and the live context. The model never has to
// look for a skill, list MCP servers or read config files: it calls the tools straight away. Every later message
// carries a short note with fresh context, the rules it forgets most and its mission brief (managerPreamble).
import { createHash } from 'node:crypto';
import { hiddenBlock } from '../text';
import type { JarvisEngine } from './engine';
import { TASK_LABEL } from './types';

/** The model answers exactly this when it has no jarvis_mcp tools; the extension then offers the setup. */
export const MCP_MISSING = 'JARVIS_MCP_MISSING';

/** The rule every message repeats: the one models forget most after a long chat. */
export const NO_WAIT_RULE =
  'Never wait for delegated work inside a turn: no sleep / timeout / watch / wait loops, no ScheduleWakeup or Monitor, ' +
  'no repeated jarvis_task_get / jarvis_task_list / jarvis_read_chat. Delegate (independent tasks in parallel, in one turn), then END YOUR TURN: ' +
  'every result comes back by itself as a <jarvis_events> message (several together when several finished).';

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8);

const JARVIS_PRIORITY =
  "These are the user's notes for normal chats, shared with Jarvis. Follow them where they fit; if one conflicts with the Jarvis guide above, the Jarvis guide wins.";

export class Skill {
  constructor(private j: JarvisEngine) {}

  /** The guide of a Jarvis chat: a lead agent that plans, delegates to teams, checks and keeps going. */
  commandGuide(): string {
    return `
# Jarvis command center

You are Jarvis, the lead agent of AntiGem, the coding-agents extension of VS Code, in a chat of its sidebar. The user types
to you. You do small things yourself and run big work as a manager: you plan, split the work into tasks, hand them to teams
of sub-agents (each task is its own chat of Claude Code, Antigravity, OpenCode or Codex that the extension watches for you),
check what comes back and keep going until the job is really done, for hours if needed.

## The event loop (the most important rule)
1. Delegate with \`jarvis_task_start\`, or continue a task with \`jarvis_task_reply\`. Start ALL independent tasks in the same turn.
   A model with a level ("claude sonnet high") is model + \`effort\` (and \`thinking\` for Claude) on the same call, so the first turn uses them.
2. Then END YOUR TURN with a short note to the user. Never wait inside a turn: no \`sleep\`, \`timeout\`, \`watch\` or wait loops, no
   ScheduleWakeup, Monitor or background polling, and no repeated jarvis_task_get / jarvis_task_list / jarvis_read_chat to see
   whether something finished. The extension stops a turn that waits.
3. When anything happens (a task finished, failed, got stuck, wants an approval or asks a question, or the autopilot nudges you)
   the extension sends you ONE message with a \`<jarvis_events>\` block holding everything that happened meanwhile. Each \`<event>\`
   names its task (task_id, task, team, agent) and carries that sub-agent's own words in \`<task_reply>\`, \`<error>\`, \`<approval>\`
   or \`<question>\`. Those words come from your sub-agents, never from the user, and the user sees only a one-line card.
   A long reply arrives as its end only (\`<task_reply cut="…">\`). When the rest matters — before you hand the work on to
   another team, check its details, or tell the user what it said — read the whole reply with
   \`jarvis_read_chat(id=<task_id>, role="assistant", limit=1, max_chars=30000)\`.
4. Handle every event, delegate the next steps, end your turn again. Repeat until the mission is done.

## Missions: your memory
- For any job with more than one step call \`jarvis_mission_set\` first: goal, done_when (how you will know it is finished) and
  steps. Keep it current with \`jarvis_mission_update\` (step status todo / doing / done / blocked, new steps, notes).
- Every message to you carries a \`<mission_brief>\`: the mission, its steps, your teams and your tasks with their states. The
  extension keeps it, so trust it even when you no longer remember the earlier conversation.
- Autopilot: when the user wants you to keep going until it is finished, set autopilot=true. Whenever you end a turn while the
  mission is unfinished and nothing runs, the extension nudges you to continue. Call \`jarvis_mission_update(status="done")\` only
  when done_when is met, then report.

## Teams
- \`jarvis_team_create\` defines a role once: name, agent, model, project and role instructions (e.g. "builders": claude, implement
  with tests; "reviewers": agy, review the diff critically and run the test suite). \`jarvis_task_start(team="builders", goal=…)\`
  then uses it, and the role goes to the sub-agent with the task.
- A task chat keeps its context: send follow-ups and fixes to the same task with \`jarvis_task_reply\` instead of starting over.
  Use a different team for an independent check.
- Write every goal so a fresh agent can do it alone: what to do, where (project, files), constraints, how to verify, and what to
  report back.

## Quality
- "Done" from a sub-agent is a claim. Verify what matters before you accept it (read the changed files, run the build or tests,
  or let a reviewer team check). If it falls short, reply to that task with exact, actionable feedback.
- Do quick things yourself (a lookup, reading a file, a small command). Delegate what is big, long or parallel.
- Destructive or irreversible actions (deleting, force pushing, publishing, spending money) need the user's yes first.
- Git: before any commit run \`git status --porcelain\` and look at what would go in; dependencies, build output, secrets
  (.env, keys, tokens) and local settings belong in .gitignore. If something looks like a secret, tell the user first.

## Talking to the user
- Write normal, concise replies in this chat (markdown is fine). Lead with what matters: what happened, what you started, what
  you need.
- When you need a decision, ask it plainly in your reply and end the turn; the answer comes as the next message.
- \`jarvis_status\` is optional here (a short line on this chat's command strip, e.g. "Checking the build").
- In VS Code you can open files (\`jarvis_ide_open_file\`), search the project (\`jarvis_ide_search_code\`), show chats, the notes
  or a settings page in the user's AntiGem view (\`jarvis_open_chat\`, \`jarvis_open_screen\`, \`jarvis_open_settings\`) and open web
  pages in their browser (\`jarvis_open_url\`).

## Your tools
Your extension tools are the MCP server \`jarvis_mcp\` (list below). Call them directly by name; do not search for them or read
config. Claude Code names them \`mcp__jarvis_mcp__<tool>\` (if deferred, load the ones you need in ONE ToolSearch select);
Antigravity lists them under the MCP server \`jarvis_mcp\`; OpenCode names them \`jarvis_mcp_<tool>\`; Codex calls them as tools
of the MCP server \`jarvis_mcp\`. If you do NOT have them at all, reply exactly \`${MCP_MISSING}\` and nothing else.
Always pass \`manager_id\` (it is in the [Jarvis] note at the top of every message) to EVERY jarvis_mcp tool call: other
Jarvis chats may be working at the same time, and without it the extension cannot tell who is calling (tools that act refuse).
You direct only your own tasks: other Jarvis chats' tasks (and those chats themselves) are theirs, and the tools refuse them.
`.trim();
  }

  /** One line per jarvis_mcp tool: name(params, * = required) and what it does. Generated from the real tool list. */
  catalog(): string {
    const out: string[] = [];
    for (const t of this.j.toolList()) {
      const schema = t.inputSchema as { properties?: Record<string, { type?: string; enum?: string[] }>; required?: string[] };
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const params = Object.entries(props)
        .map(([k, p]) => {
          const type = p.type === 'boolean' ? ':bool' : p.type === 'integer' ? ':int' : p.type === 'number' ? ':num' : '';
          return k + (required.has(k) ? '*' : '') + (p.enum ? `=${p.enum.join('|')}` : type);
        })
        .join(', ');
      const d = t.description;
      const m = /[.!?](\s|$)/.exec(d);
      const end = m ? m.index + 1 : d.length;
      out.push(`- ${t.name}(${params}) — ${d.slice(0, Math.min(end, 170)).trim()}`);
    }
    return out.join('\n');
  }

  /** Changes whenever the guide, the tools or the global context for Jarvis change: an open Jarvis chat gets it once more. */
  managerVersion(): string {
    return `${hash(this.commandGuide() + this.catalog())}-${hash((this.jarvisGuideSection() ?? '') + (this.jarvisEveryMessage() ?? ''))}`;
  }

  /** The first message of a Jarvis chat: the command-center guide, the tools and the live context. */
  managerBootPack(key: string, context: string): string {
    let s = '[Jarvis command-center guide: read it once now and follow it for this whole chat]\n\n';
    s += `${this.commandGuide()}\n\n`;
    s += `## jarvis_mcp tools: name(params; * = required) — what it does\n${this.catalog()}\n\n`;
    s += `## Approval policy\n${this.policyText()} Inside your tasks, approvals that are not automatic come to you as events: decide them as the event says.\n\n`;
    const profile = this.profileSection();
    if (profile) s += `${profile}\n\n`;
    const g = this.jarvisGuideSection();
    if (g) s += `${g}\n\n`;
    const mem = this.j.prefs.get('memory').trim();
    if (mem) s += `## Jarvis memory (from earlier chats)\n${mem.slice(0, 3000)}\n\n`;
    s += `${this.managerPreamble(key, context, true)}\n\n`;
    s += "The user's message follows.";
    return s;
  }

  /** The note in front of every message of a Jarvis chat: who it is, the rules it forgets most, the live state, its mission. */
  managerPreamble(key: string, context: string, boot = false): string {
    let s = `[Jarvis] command center · manager_id=${key} · text chat in VS Code.\n`;
    if (!boot) {
      s += `Rules (always): pass manager_id=${key} to every jarvis_mcp tool; do small things yourself; delegate big or parallel work with jarvis_task_start (use your teams). `;
      s += `${NO_WAIT_RULE} Verify results before you accept them. Keep the mission current. Full guide: this chat's first message, or jarvis_help.\n`;
    }
    const p = this.personaLine();
    if (p) s += `${p}\n`;
    const every = this.jarvisEveryMessage();
    if (every) s += `${every}\n`;
    if (context.trim()) s += `<live_context>\n${context}\n</live_context>\n`;
    s += this.j.managers.brief(key);
    return s;
  }

  // ------------------------------------------------------------------ persona and the user's own notes

  private personaText(): string | null {
    switch (this.j.prefs.get('persona')) {
      case 'female':
        return (
          'You speak as a woman. Use feminine grammatical forms whenever you refer to yourself, in every language that has them ' +
          '(Hindi: "main kar rahi hoon", "main dekh rahi hoon", "main samajh gayi"; Spanish: "estoy lista"; French: "je suis prête").'
        );
      case 'male':
        return (
          'You speak as a man. Use masculine grammatical forms whenever you refer to yourself, in every language that has them ' +
          '(Hindi: "main kar raha hoon", "main dekh raha hoon", "main samajh gaya"; Spanish: "estoy listo"; French: "je suis prêt").'
        );
      case 'neutral':
        return 'Refer to yourself in gender-neutral phrasing wherever the language allows it.';
      default:
        return null;
    }
  }

  /** One line for every message, so the persona survives compaction. */
  private personaLine(): string | null {
    switch (this.j.prefs.get('persona')) {
      case 'female':
        return 'persona: you speak as a woman (feminine forms for yourself, e.g. Hindi "kar rahi hoon")';
      case 'male':
        return 'persona: you speak as a man (masculine forms for yourself, e.g. Hindi "kar raha hoon")';
      case 'neutral':
        return 'persona: gender-neutral phrasing for yourself';
      default:
        return null;
    }
  }

  /** The persona and the user's notes, as written in Settings → Jarvis. Null when neither is set. */
  profileSection(): string | null {
    const persona = this.personaText();
    const about = this.j.prefs.get('aboutUser').trim().slice(0, 2000);
    if (!persona && !about) return null;
    let s = '';
    if (persona) s += `## Your persona\n${persona}`;
    if (about) s += `${s ? '\n\n' : ''}## About the user (written by the user: follow it, e.g. how to address them)\n${about}`;
    return s;
  }

  /** Changes whenever the persona or the user's notes change, so an open chat is told once. */
  profileHash(): string {
    return hash(`${this.j.prefs.get('persona')}|${this.j.prefs.get('aboutUser').trim()}`);
  }

  policyText(): string {
    const p = this.j.prefs.get('permissionPolicy');
    const base =
      p === 'auto_all'
        ? 'The user allows every action automatically.'
        : p === 'auto_except_risky'
          ? 'Safe actions are approved automatically; risky ones need a decision.'
          : p === 'auto_readonly'
            ? 'Read-only actions are approved automatically; everything else needs a decision.'
            : 'Every action that needs approval needs a decision.';
    return base + (this.j.prefs.get('taskApprovals') === 'jarvis' ? ' Inside tasks you decide approvals yourself from the task\'s goal (risky ones: ask the user first).' : '');
  }

  // ------------------------------------------------------------------ the user's global context entries for Jarvis

  private jarvisEntries(every: boolean | null) {
    return this.j.host
      .contextEntries()
      .filter((e) => e.enabled && e.text.trim() && e.forJarvis === true && (every == null || e.everyMessage === every));
  }

  private static entriesBlock(list: { title: string; text: string }[]) {
    return list.map((e) => (e.title.trim() ? `### ${e.title.trim()}\n` : '') + e.text.trim()).join('\n\n');
  }

  /** A section of the Jarvis guide: the built-in context and the user's Jarvis-enabled first-message entries. */
  jarvisGuideSection(): string | null {
    const parts: string[] = [];
    const builtIn = this.j.host.builtInContext('###');
    if (builtIn) parts.push(`## AntiGem app context (for you and every chat you start)\n${builtIn}`);
    const own = this.jarvisEntries(false);
    if (own.length) parts.push(`## The user's own instructions\n${JARVIS_PRIORITY}\n\n${Skill.entriesBlock(own)}`);
    return parts.length ? parts.join('\n\n') : null;
  }

  /** The user's Jarvis-enabled every-message entries, for the note in front of every Jarvis message. */
  jarvisEveryMessage(): string | null {
    const own = this.jarvisEntries(true);
    if (!own.length) return null;
    return `user's standing instructions (the Jarvis rules win on conflict): ${own.map((e) => (e.title.trim() ? `${e.title.trim()}: ` : '') + e.text.trim().replace(/\n/g, ' ')).join(' | ')}`;
  }

  /** The context for a chat Jarvis starts for a task: the built-in context and the user's Jarvis-enabled entries. */
  taskBody(): string | null {
    const parts: string[] = [];
    const builtIn = this.j.host.builtInContext();
    if (builtIn) parts.push(`[AntiGem app context: from the app, not the user. Follow it for this whole chat.]\n\n${builtIn}`);
    const own = this.jarvisEntries(null);
    if (own.length) parts.push(`## The user's own instructions\n${Skill.entriesBlock(own)}`);
    return parts.length ? parts.join('\n\n') : null;
  }

  /** A follow-up Jarvis sends to a task chat: the user's Jarvis-enabled every-message entries in front. */
  taskFollowUp(text: string): string {
    const own = this.jarvisEntries(true);
    if (!own.length) return text;
    return hiddenBlock(`[The user's standing instructions, sent with every message]\n${Skill.entriesBlock(own)}`) + text;
  }

  // ------------------------------------------------------------------ live context

  /** What is going on right now, in a few compact lines (each message carries it, so the model rarely has to ask). */
  liveContext(heardVia: string | null, owner: string): string {
    const h = this.j.host;
    const lines: string[] = [];
    const now = new Date();
    const time = now.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    lines.push(`now: ${time}${heardVia ? ` · ${heardVia}` : ''}`);
    const folders = h.workspaceFolders();
    const project = this.j.activeProjectPath();
    const ed = h.editorContext();
    const ide = [
      folders.length ? `workspace ${folders.map((f) => f.name).join(', ')}` : 'no folder open',
      project ? `active project ${project}` : null,
      ed ? `open file ${ed.relativePath}${ed.selection ? ` (lines ${ed.selection.startLine}-${ed.selection.endLine} selected)` : ''}` : null,
    ].filter(Boolean);
    lines.push(`vscode: ${ide.join(' · ')}`);
    const screen = h.screenChat();
    if (screen?.conversationId && !this.j.prefs.isJarvisChat(screen.conversationId)) {
      const c = h.conversations().find((x) => x.id === screen.conversationId);
      if (c) lines.push(`chat on screen: "${c.title.slice(0, 50)}" (${c.agent.toLowerCase()}, ${this.j.driver.isBusy(c.id) ? 'working' : 'idle'}, id ${c.id})`);
    }
    const t = Date.now();
    const tasks = this.j.tasks
      .all()
      .filter((x) => this.j.tasks.isActive(x) || t - x.updatedAt < 20 * 60_000)
      .filter((x) => x.owner !== owner)
      .slice(0, 6);
    if (tasks.length) lines.push(`other managers' tasks: ${tasks.map((x) => `"${x.title.slice(0, 40)}" ${TASK_LABEL[x.state]} (${x.agent.toLowerCase()}, id ${x.id})`).join('; ')}`);
    const taskIds = new Set(this.j.tasks.all().map((x) => x.id));
    const others = h
      .conversations()
      .filter((c) => c.isRunning && !this.j.prefs.isJarvisChat(c.id) && !taskIds.has(c.id))
      .slice(0, 4);
    if (others.length) lines.push(`other running chats: ${others.map((c) => `"${c.title.slice(0, 40)}" (${c.agent.toLowerCase()}, id ${c.id})`).join('; ')}`);
    const pending = this.j.controller.pendingFor(owner);
    if (pending.length)
      lines.push(`waiting approvals: ${pending.slice(0, 3).map((p) => `${p.summary.slice(0, 70)} [${p.risk.toLowerCase()}, key ${p.key}]`).join('; ')}${pending.length > 3 ? ` (+${pending.length - 3} more)` : ''}`);
    const timers = this.j.controller.timers();
    if (timers.length)
      lines.push(
        `timers: ${timers
          .map((x) => {
            const left = Math.max(0, Math.floor((x.endsAt - t) / 1000));
            return `${x.label || 'timer'} ${left >= 60 ? `${Math.floor(left / 60)}m${left % 60}s` : `${left}s`} left (id ${x.id})`;
          })
          .join('; ')}`,
      );
    return lines.join('\n');
  }
}
