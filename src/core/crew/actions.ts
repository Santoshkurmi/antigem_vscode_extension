// What the Crew screens ask the engine to do (engine.ts handle()): the Crew screen's actions (a bot, its SOUL.md, DM and
// memory, crew settings, the Chief, goals, crew packages), Mission Control's job actions and the Automations page's.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HostToView, ViewToHost } from '../../../shared/protocol';
import { needBot, pauseBots } from './bots';
import type { CrewEngine, CrewEngineApi } from './engine';
import { ACCESS_LEVELS, normalizeSettings } from './store/store';
import type { CrewAccess } from './types';

type CrewActionMsg = Extract<ViewToHost, { type: 'crewAction' }>;

export class CrewActions {
  constructor(
    private e: CrewEngine,
    private api: () => CrewEngineApi | null,
  ) {}

  private get store() {
    return this.e.crew.store;
  }

  async crewAction(post: (m: HostToView) => void, msg: CrewActionMsg): Promise<string | void> {
    const d = (msg.data ?? {}) as Record<string, unknown>;
    const botId = msg.botId ?? '';
    switch (msg.action) {
      case 'createBot': {
        const b = this.e.createBot(d);
        post({ type: 'crewNavigate', botId: b.id });
        return `${b.name} joined the crew`;
      }
      case 'updateBot':
        this.e.updateBot(botId, d);
        return;
      case 'deleteBot':
        return this.e.deleteBot(botId);
      case 'openSoul': {
        const b = needBot(this.store, botId);
        const f = this.store.soulPath(b.id);
        if (!fs.existsSync(f)) this.store.setSoul(b.id, '');
        this.api()?.openFile(f);
        return;
      }
      case 'openDm':
        this.e.openDm(botId);
        return;
      case 'pickFolder': {
        const b = needBot(this.store, botId);
        const p = d.clear === true ? null : await this.api()?.pickFolder();
        if (p === undefined || (p === null && d.clear !== true)) return;
        this.store.putBot({ ...b, folder: p });
        this.e.changed();
        return;
      }
      case 'setCrewAccess': {
        const a = d.access == null ? null : String(d.access);
        const s = this.store.settings();
        this.store.saveSettings({ ...s, crewAccess: a && ACCESS_LEVELS.includes(a as CrewAccess) ? (a as CrewAccess) : null });
        this.e.changed();
        return;
      }
      case 'setPaused': {
        const on = d.paused === true;
        this.store.saveSettings({ ...this.store.settings(), paused: on });
        if (on) pauseBots(this.e, this.store.bots().map((b) => b.id));
        else this.e.jobs.resumeBots(this.store.bots().map((b) => b.id));
        this.e.changed();
        this.e.inbox.emit();
        return on ? 'Everyone is paused' : 'The crew is back at work';
      }
      case 'allowAgyServer':
        this.e.inbox.setAgyServer(d.allow !== false);
        return d.allow !== false ? 'Antigravity bots get their crew tools with their next message' : undefined;
      case 'forgetRule':
        this.e.inbox.broker.forget(botId, String(d.key ?? ''));
        this.e.changed();
        return;
      case 'setChief':
        this.e.chief.setChief(botId || null);
        this.e.changed();
        return botId ? `${this.store.bot(botId)?.name ?? 'It'} is the Chief now` : 'No Chief';
      case 'undoManage':
        return this.e.chief.undo(String(d.id ?? ''));
      case 'forgetMemory':
        this.e.memory.forget(botId, String(d.id ?? ''), 'user');
        this.e.changed(false);
        return;
      case 'undoMemory':
        this.e.memory.undo(botId, String(d.id ?? ''));
        this.e.changed(false);
        return;
      case 'openMemory': {
        const f = this.e.memory.file(botId);
        if (!fs.existsSync(f)) {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, '');
        }
        this.api()?.openFile(f);
        return;
      }
      case 'aboutMe':
        if (d.remove) this.e.memory.removeAboutMe(String(d.remove));
        else if (String(d.text ?? '').trim()) this.e.memory.prefer(String(d.text).trim(), 'user');
        this.e.changed(true);
        return;
      case 'library':
        post({ type: 'crewImport', library: this.e.sharing.library() });
        return;
      case 'importPreview':
        try {
          const p = await this.e.sharing.preview({ text: d.text ? String(d.text) : undefined, url: d.url ? String(d.url) : undefined, library: d.library ? String(d.library) : undefined });
          const pl = p.plan;
          post({
            type: 'crewImport',
            preview: {
              name: pl.name,
              tagline: pl.tagline,
              format: p.format,
              from: p.from,
              bots: pl.bots.map((b) => ({ name: b.name, from: b.from, title: b.title, emoji: b.emoji, color: b.color, access: b.access, engine: b.engine })),
              rooms: pl.rooms.map((r) => ({ name: r.name, members: r.members })),
              chief: pl.chief,
              mcp: pl.mcp.map((m) => ({ name: m.name, reason: m.reason })),
              automations: pl.automations.map((a) => ({ name: a.name, bot: a.bot, when: a.when })),
              playbooks: pl.playbooks.length,
              redacted: pl.redacted,
              leftOut: pl.leftOut,
              warnings: pl.warnings,
            },
            error: null,
          });
        } catch (e) {
          post({ type: 'crewImport', preview: null, error: errText(e) });
        }
        return;
      case 'importApply': {
        const msg = await this.e.sharing.apply({ text: d.text ? String(d.text) : undefined, url: d.url ? String(d.url) : undefined, library: d.library ? String(d.library) : undefined });
        this.e.changed(true);
        return msg;
      }
      case 'export': {
        const out = this.e.sharing.export({ botIds: Array.isArray(d.botIds) ? d.botIds.map(String) : null, name: d.name ? String(d.name) : undefined });
        await this.api()?.saveText?.(out.fileName, out.text);
        return out.redacted ? `Saved (${out.redacted} secret${out.redacted === 1 ? '' : 's'} taken out)` : undefined;
      }
      case 'setCaps': {
        const s = this.store.settings();
        const next = normalizeSettings({ ...s, caps: { dayTokens: Number(d.dayTokens) || null, dayUsd: Number(d.dayUsd) || null } });
        this.store.saveSettings(next);
        this.e.changed(false);
        const parts = [next.caps.dayTokens ? `${next.caps.dayTokens.toLocaleString('en-US')} tokens` : '', next.caps.dayUsd ? `$${next.caps.dayUsd.toFixed(2)}` : ''].filter(Boolean);
        return parts.length ? `Daily budget: ${parts.join(' or ')}` : 'No daily budget';
      }
      case 'tourDone':
        this.store.saveSettings({ ...this.store.settings(), tourDone: d.done !== false });
        this.e.changed(false);
        return;
      case 'openProblems': {
        const id = this.e.chief.chiefId();
        const t = id ? this.store.threads().find((x) => x.kind === 'problems' && x.botId === id) : null;
        if (!t?.chatId) return 'The Chief has not looked at a problem yet.';
        this.api()?.showChat(t.chatId, t.engine);
        return;
      }
      case 'goal': {
        const b = needBot(this.store, botId);
        if (d.stop === true) {
          const g = this.e.jobs.store.all().find((j) => j.goal && !j.parentId && j.assignee.botId === b.id && !['done', 'failed', 'cancelled'].includes(j.status));
          if (g) this.e.jobs.stop(g.id, 'stopped by the user');
          return;
        }
        this.e.jobs.startGoal(b.id, String(d.text ?? ''), Number(d.maxTurns ?? 10));
        return `${b.name} is working on its goal`;
      }
    }
  }

  // ------------------------------------------------------------------ Mission Control

  jobAction(action: string, jobId: string, d: Record<string, unknown>): string | void {
    const jobs = this.e.jobs;
    switch (action) {
      case 'stop':
        jobs.stop(jobId);
        return 'Stopped';
      case 'retry':
        jobs.retry(jobId);
        return 'Running it again';
      case 'resumeGoal':
        jobs.resumeGoal(jobId);
        return 'Going on with the goal';
      case 'answer':
        return jobs.answer(null, jobId, String(d.answer ?? ''));
      case 'openThread': {
        const t = jobs.threadOf(jobId);
        if (!t?.chatId) return 'It has not run yet.';
        this.api()?.showChat(t.chatId, t.engine);
        return;
      }
      case 'openArtifact': {
        const a = jobs.store.get(jobId)?.artifacts[Number(d.index ?? -1)];
        if (!a) return;
        if (a.url) this.api()?.openUrl?.(a.url);
        else if (a.path) this.api()?.openFile(a.path);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ Automations page

  async automationAction(action: string, id: string, d: Record<string, unknown>): Promise<string | void> {
    const automations = this.e.automations;
    switch (action) {
      case 'pause':
      case 'resume':
        automations.setPaused(id, action === 'pause', 'user');
        return;
      case 'runNow':
        automations.runNow(id);
        return 'Running it now';
      case 'delete':
        automations.remove(id, 'user');
        return 'Deleted (Undo brings it back)';
      case 'undo':
        return automations.undoLast(id);
      case 'open': {
        const t = this.store.threads().find((x) => x.kind === 'automation' && x.jobId === id);
        if (t?.chatId) this.api()?.showChat(t.chatId, t.engine);
        return;
      }
      case 'new': {
        // the bot sets it up itself (crew_automation) in its DM, where you see it happen
        const b = needBot(this.store, String(d.botId ?? ''));
        const text = String(d.text ?? '').trim();
        if (!text) throw new Error('Say what should happen, and when.');
        let t = this.e.ensureDm(b.id);
        const isNew = !t.chatId;
        if (isNew) {
          t = { ...t, chatId: randomUUID() };
          this.store.putThread(t);
          this.e.changed(true);
        }
        this.api()?.showChat(t.chatId!, t.engine);
        void this.e.runOnThread(t, `Set this up as an automation with crew_automation (create it now, no need to ask), then tell me its sentence in one line:\n\n${text}`, 'its DM', { timeoutMs: 10 * 60_000, waitMs: 10 * 60_000, isNew }).catch((e) => this.api()?.log(`[crew] new automation: ${errText(e)}`));
        return `${b.name} is setting it up`;
      }
    }
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
