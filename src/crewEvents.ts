// Editor events for Crew automations (docs/crew/PLAN.md §13 "Editor events"): file saved, problems count went up,
// task / test / terminal command failed, git commit / branch switch / pull, files changed, project opened. Plain VS
// Code listeners: an event only reaches the crew when some automation listens to it (the check happens before any AI
// runs), and the file watcher exists only while an automation watches files.
import * as vscode from 'vscode';
import type { Automations } from './core/crew/automations/runner';
import type { EditorEvent } from './core/crew/automations/when';

const TEST_CMD = /\b(test|tests|jest|vitest|mocha|pytest|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|phpunit|rspec|ctest)\b/i;
const IGNORE = /[\\/](\.git|node_modules|dist|out|build|\.next|target)[\\/]/;

interface GitRepo {
  state: { HEAD?: { name?: string; commit?: string; behind?: number }; onDidChange(cb: () => void): vscode.Disposable };
  rootUri: vscode.Uri;
}

export function watchEditorForCrew(context: vscode.ExtensionContext, auto: () => Automations | null, log: (l: string) => void): void {
  const listens = (k: EditorEvent) => auto()?.listening().events.has(k) ?? false;
  const fire = (k: EditorEvent, detail: string) => {
    if (listens(k)) auto()?.editorEvent(k, detail);
  };
  const subs = context.subscriptions;

  subs.push(vscode.workspace.onDidSaveTextDocument((d) => d.uri.scheme === 'file' && fire('file_saved', d.uri.fsPath)));

  // problems: the error count across the workspace went up (counted at most every 2 s)
  const errors = () => vscode.languages.getDiagnostics().reduce((n, [, ds]) => n + ds.filter((x) => x.severity === vscode.DiagnosticSeverity.Error).length, 0);
  let lastErrors = errors();
  let diagTimer: NodeJS.Timeout | null = null;
  subs.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      if (diagTimer || !listens('problems_rose')) return;
      diagTimer = setTimeout(() => {
        diagTimer = null;
        const n = errors();
        if (n > lastErrors) fire('problems_rose', `${n} errors (was ${lastErrors})`);
        lastErrors = n;
      }, 2000);
    }),
  );

  subs.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (!e.exitCode) return;
      const t = e.execution.task;
      fire('task_failed', `${t.name} (exit ${e.exitCode})`);
      if (t.group === vscode.TaskGroup.Test || TEST_CMD.test(t.name)) fire('test_failed', t.name);
    }),
  );

  // terminal commands (shell integration, VS Code 1.93+)
  const win = vscode.window as unknown as { onDidEndTerminalShellExecution?: vscode.Event<{ exitCode: number | undefined; execution: { commandLine: { value: string } } }> };
  if (win.onDidEndTerminalShellExecution) {
    subs.push(
      win.onDidEndTerminalShellExecution((e) => {
        if (!e.exitCode) return;
        const cmd = e.execution.commandLine.value.trim().slice(0, 300);
        fire('terminal_failed', `${cmd} (exit ${e.exitCode})`);
        if (TEST_CMD.test(cmd)) fire('test_failed', cmd);
      }),
    );
  }

  // git: a new commit, another branch, a pull (behind went to 0 with a new HEAD)
  const watchRepo = (r: GitRepo) => {
    let head = r.state.HEAD?.commit;
    let branch = r.state.HEAD?.name;
    let behind = r.state.HEAD?.behind ?? 0;
    subs.push(
      r.state.onDidChange(() => {
        const h = r.state.HEAD;
        if (!h) return;
        const where = vscode.workspace.asRelativePath(r.rootUri);
        if (h.name !== branch) fire('git_branch', `${where}: ${branch ?? '?'} → ${h.name ?? '(detached)'}`);
        else if (h.commit && h.commit !== head) fire(behind > 0 && (h.behind ?? 0) === 0 ? 'git_pull' : 'git_commit', `${where}: ${h.commit.slice(0, 8)}`);
        head = h.commit;
        branch = h.name;
        behind = h.behind ?? 0;
      }),
    );
  };
  void (async () => {
    try {
      const ext = vscode.extensions.getExtension('vscode.git');
      const api = (ext?.isActive ? ext.exports : await ext?.activate())?.getAPI?.(1) as { repositories: GitRepo[]; onDidOpenRepository(cb: (r: GitRepo) => void): vscode.Disposable } | undefined;
      if (!api) return;
      api.repositories.forEach(watchRepo);
      subs.push(api.onDidOpenRepository(watchRepo));
    } catch (e) {
      log(`[crew] git events: ${e instanceof Error ? e.message : e}`);
    }
  })();

  // files changed: one watcher per glob some automation uses (kept in step every 30 s)
  const watchers = new Map<string, vscode.Disposable>();
  const syncWatchers = () => {
    const want = new Set(auto()?.listening().globs ?? []);
    for (const [g, w] of watchers) if (!want.has(g)) (w.dispose(), watchers.delete(g));
    for (const g of want) {
      if (watchers.has(g)) continue;
      const w = vscode.workspace.createFileSystemWatcher(g.includes('/') || g.includes('*') ? g : `**/${g}`);
      const on = (u: vscode.Uri) => !IGNORE.test(u.fsPath) && fire('files_changed', u.fsPath);
      w.onDidChange(on);
      w.onDidCreate(on);
      w.onDidDelete(on);
      watchers.set(g, w);
    }
  };
  const timer = setInterval(syncWatchers, 30_000);
  setTimeout(syncWatchers, 3000);
  subs.push({ dispose: () => (clearInterval(timer), [...watchers.values()].forEach((w) => w.dispose())) });

  // the project opened (once per folder, after the crew is up)
  setTimeout(() => {
    for (const f of vscode.workspace.workspaceFolders ?? []) fire('project_opened', f.uri.fsPath);
  }, 8000);
}
