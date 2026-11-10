// ui/components/AgentToolCallCard.kt (+ ToolCallExpansionCache.kt): a flat one-line row — rotating chevron, status
// icon, action verb, command — that expands into the terminal-style output (a diff for file edits).
// Question tools (ASK_CHOICE) show ChoiceQuestionnaireCard's compact states (the questions themselves are answered in
// the docked question panel).
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { ChoiceQuestionnaire, ToolCall } from '@shared/model';
import { Collapse, Dialog, Icon, IconButton, type IconName } from '../ui/primitives';
import { alpha, formatDuration } from '../util/format';
import { copyText, readImage, send, sendMessage, state, stop } from '../state/store';
import { DiffView, looksLikeDiff } from './CodeBlock';
import { openImageViewer } from './Media';
import { createResource } from 'solid-js';

// ToolCallExpansionCache: survives re-renders; cleared when another chat opens
const [expansion, setExpansion] = createSignal<Record<string, boolean>>({});
export const clearToolExpansion = () => setExpansion({});
const keyOf = (t: ToolCall) => (t.stepIndex != null ? `step_${t.stepIndex}` : `id_${t.id}`);

const MAX_OUTPUT_LINES = 2000;

// ChatScreen's "Command Terminated" dialog after the stop button: new instructions for the agent, or stop the turn
const [terminated, setTerminated] = createSignal<{ command: string } | null>(null);

export function TerminatedDialogHost() {
  const [text, setText] = createSignal('');
  const close = () => {
    setTerminated(null);
    setText('');
  };
  return (
    <Dialog
      open={!!terminated()}
      onClose={close}
      radius={16}
      background="var(--surface)"
      title={
        <span class="row-center">
          <Icon name="cancel" size={22} color="var(--danger)" />
          <span style={{ 'margin-left': '8px', 'font-size': 'calc(17 * var(--sp))', 'font-weight': 700 }}>Command Terminated</span>
        </span>
      }
      actions={
        <>
          <button
            class="text-btn"
            style={{ color: 'color-mix(in srgb, var(--on-surface) 70%, transparent)' }}
            onClick={() => {
              close();
              stop();
            }}
          >
            Stop Turn Here
          </button>
          <button
            class="filled-btn small"
            style={{ background: 'var(--primary)', color: '#fff', 'border-radius': '8px' }}
            onClick={() => {
              const t = text().trim();
              close();
              if (t) sendMessage(t, []);
            }}
          >
            Send to AI &amp; Proceed
          </button>
        </>
      }
    >
      <div class="term-text">You stopped the running command:</div>
      <div class="term-cmd">$ {terminated()?.command}</div>
      <div class="term-text" style={{ 'margin-top': '12px' }}>
        Explain why or give new instructions to AI (optional):
      </div>
      <textarea
        class="outlined-field term-input"
        rows={3}
        placeholder="e.g. It was taking too long, please use grep or find a faster way..."
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
    </Dialog>
  );
}

export function ToolCallCard(props: { call: ToolCall }) {
  return (
    <Show when={props.call.toolType !== 'ASK_CHOICE'} fallback={<QuestionToolCard call={props.call} />}>
      <ToolRow call={props.call} />
    </Show>
  );
}

function ToolRow(props: { call: ToolCall }) {
  const t = () => props.call;
  const expanded = () => expansion()[keyOf(t())] ?? false;
  const toggle = () => setExpansion((m) => ({ ...m, [keyOf(t())]: !expanded() }));

  const type = () => t().toolType;
  const isSystem = () => type() === 'SYSTEM_NOTIFICATION' || t().name === 'system_notice';
  const status = () => t().status;
  const pendingApproval = () => status() === 'PENDING_APPROVAL';
  const running = () => status() === 'RUNNING';
  const terminated = () => status() === 'TERMINATED';
  const rejected = () => status() === 'REJECTED';
  const success = () =>
    status() === 'SUCCESS' || (status() !== 'FAILED' && !terminated() && !rejected() && !pendingApproval() && t().exitCode === 0);
  const failed = () =>
    status() === 'FAILED' || (t().exitCode != null && t().exitCode !== 0 && !terminated() && !rejected());

  const verb = () => {
    const ty = type();
    if (pendingApproval()) return ty === 'MCP' ? 'Approve MCP:' : 'Approve Command:';
    if (running()) {
      if (isSystem()) return 'System event...';
      switch (ty) {
        case 'SEARCH_WEB':
          return 'Searching web...';
        case 'READ_URL':
          return 'Fetching page...';
        case 'MATH':
          return 'Evaluating math...';
        case 'VIEW_FILE':
          return 'Reading file...';
        case 'EDIT_FILE':
          return 'Editing file...';
        case 'LIST_DIR':
          return 'Listing directory...';
        case 'FIND':
        case 'GREP_SEARCH':
          return 'Searching code...';
        case 'GENERATE_IMAGE':
          return 'Generating image...';
        case 'MCP':
          return 'Executing MCP tool...';
        default:
          return 'Running command...';
      }
    }
    if (success()) {
      if (isSystem()) return 'System:';
      switch (ty) {
        case 'SEARCH_WEB':
          return 'Web search';
        case 'READ_URL':
          return 'Read page';
        case 'MATH':
          return 'Math evaluated';
        case 'VIEW_FILE':
          return 'Read file';
        case 'EDIT_FILE':
          return 'Edited file';
        case 'LIST_DIR':
          return 'Listed directory';
        case 'FIND':
        case 'GREP_SEARCH':
          return 'Searched code';
        case 'GENERATE_IMAGE':
          return 'Generated image';
        case 'MCP':
          return 'MCP tool';
        default:
          return 'Ran bash';
      }
    }
    if (terminated()) return 'Stopped:';
    if (rejected()) return 'Rejected:';
    if (failed()) return 'Failed:';
    return 'Tool:';
  };

  const verbColor = () =>
    pendingApproval()
      ? 'var(--warning)'
      : running()
        ? 'var(--primary)'
        : success()
          ? 'var(--on-surface)'
          : terminated() || failed()
            ? 'var(--danger)'
            : rejected()
              ? 'gray'
              : 'var(--on-surface)';

  const toolIcon = (): IconName => {
    if (isSystem()) return /timer|schedule/i.test(t().command) ? 'schedule' : 'notifications';
    switch (type()) {
      case 'SEARCH_WEB':
        return 'search';
      case 'READ_URL':
        return 'language';
      case 'MATH':
        return 'functions';
      case 'VIEW_FILE':
        return 'description';
      case 'EDIT_FILE':
        return 'edit';
      case 'LIST_DIR':
        return 'folder';
      case 'FIND':
      case 'GREP_SEARCH':
        return 'search';
      case 'GENERATE_IMAGE':
        return 'image';
      case 'MCP':
        return 'build';
      default:
        return 'terminal';
    }
  };
  const stateIcon = (): { name: IconName; color: string } | null => {
    if (pendingApproval()) return { name: 'hourglass', color: 'var(--warning)' };
    if (running()) return { name: toolIcon(), color: 'var(--primary)' };
    if (success()) return { name: toolIcon(), color: 'var(--success)' };
    if (terminated()) return { name: 'cancel', color: 'var(--danger)' };
    if (rejected()) return { name: 'close', color: 'gray' };
    if (failed()) return { name: 'warning', color: 'red' };
    return null;
  };
  const monoCommand = () => ['BASH', 'MCP', 'VIEW_FILE', 'EDIT_FILE'].includes(type());

  const commandLine = () => {
    const c = t().command;
    if (isSystem()) return `Notification: ${c}`;
    switch (type()) {
      case 'SEARCH_WEB':
        return `Search Query: "${c}"`;
      case 'READ_URL':
        return `URL: ${c}`;
      case 'MATH':
        return `CAS Expr: ${c}`;
      case 'VIEW_FILE':
      case 'EDIT_FILE':
        return `File: ${c}`;
      case 'LIST_DIR':
        return `Directory: ${c}`;
      case 'GREP_SEARCH':
        return `Grep: ${c}`;
      case 'FIND':
        return `Find: ${c}`;
      case 'GENERATE_IMAGE':
        return `Prompt: ${c}`;
      case 'MCP':
        return `MCP: ${c}`;
      default:
        return type() === 'BASH' ? `$ ${c}` : c;
    }
  };
  const emptyMessage = () => {
    const ty = type();
    if (running()) {
      if (ty === 'VIEW_FILE') return 'Reading file contents...';
      if (ty === 'EDIT_FILE') return 'Applying file modifications...';
      if (ty === 'LIST_DIR') return 'Scanning directory...';
      if (ty === 'FIND' || ty === 'GREP_SEARCH') return 'Searching...';
      if (ty === 'GENERATE_IMAGE') return 'Generating image...';
      if (ty === 'MCP') return 'Executing MCP tool...';
      if (ty === 'BASH') return 'Running command...';
      return 'Processing...';
    }
    if (pendingApproval()) return '(Waiting for approval)';
    if (ty === 'VIEW_FILE') return '(File inspected by model)';
    if (ty === 'EDIT_FILE') return '(File modification completed)';
    if (ty === 'LIST_DIR') return '(Directory contents scanned)';
    if (ty === 'FIND' || ty === 'GREP_SEARCH') return '(Search completed - no output)';
    if (ty === 'GENERATE_IMAGE') return '(Image generation completed)';
    if (ty === 'MCP') return '(MCP tool executed - no output)';
    return '(No output returned)';
  };

  const isImageOutput = () =>
    type() === 'GENERATE_IMAGE' || t().output.startsWith('data:image/') || /^(file:\/\/|\/)\S+\.(png|jpe?g|webp|gif|bmp)$/i.test(t().output.trim());
  // a generated image given as a file path: read by the host
  const [fileImage] = createResource(
    () => {
      const o = t().output.trim();
      return isImageOutput() && !running() && o && !o.startsWith('data:image/') && !/^https?:/i.test(o) ? o : null;
    },
    (p) => readImage(p),
  );
  const imageSrc = () => {
    const o = t().output.trim();
    if (o.startsWith('data:image/') || /^https?:/i.test(o)) return o;
    return fileImage() ?? null;
  };
  const imagePath = () => {
    const o = t().output.trim();
    return o.startsWith('data:image/') || /^https?:/i.test(o) ? null : o.replace(/^file:\/\//, '');
  };
  // long output / a diff opens in an editor tab
  const canOpenText = () => !!t().output && (showDiff() || t().output.split('\n').length > 40 || t().output.length > 4000);
  const openText = () =>
    send({
      type: 'openText',
      title: showDiff() ? `${t().command || 'Changes'}.diff` : `${verb().replace(/[:.…]+$/, '')} ${t().command}`.trim().slice(0, 80),
      content: t().output,
      language: showDiff() ? 'diff' : type() === 'BASH' ? 'shellscript' : null,
    });
  const terminate = (e: MouseEvent) => {
    e.stopPropagation();
    const c = state.chat.conversationId;
    if (!c) return;
    send({ type: 'toolAction', conversationId: c, toolId: t().id, action: 'terminate' });
    setTerminated({ command: t().command });
  };
  const output = createMemo(() => {
    const o = t().output;
    if (!o) return { text: '', more: 0 };
    let n = 0;
    let idx = -1;
    for (let i = 0; i < o.length; i++) {
      if (o.charCodeAt(i) === 10 && ++n === MAX_OUTPUT_LINES) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return { text: o, more: 0 };
    const total = o.split('\n').length;
    return { text: o.substring(0, idx), more: total - MAX_OUTPUT_LINES };
  });
  const showDiff = () => type() === 'EDIT_FILE' && !!t().output && looksLikeDiff(t().output);

  return (
    <div class="tool">
      <button class="tool-head" onClick={toggle} aria-expanded={expanded()}>
        <Icon name="chevron_right" size={16} class="chev tool-chev" style={{ transform: expanded() ? 'rotate(90deg)' : 'none' }} />
        <Show when={stateIcon()}>{(s) => <Icon name={s().name} size={14} color={s().color} class="tool-state" />}</Show>
        <span class="tool-verb" style={{ color: verbColor() }}>
          {verb()}
        </span>
        <span class="tool-cmd" classList={{ mono: monoCommand() }}>
          {t().command}
        </span>
        {/* the running command's stop button (AgentToolCallCard.kt: BASH only) */}
        <Show when={running() && type() === 'BASH'}>
          <span class="tool-stop" role="button" title="Stop command" onClick={terminate}>
            <Icon name="stop" size={12} />
          </span>
        </Show>
        <Show when={t().durationMs && t().durationMs! > 0}>
          <span class="tool-dur">{formatDuration(t().durationMs)}</span>
        </Show>
        <Show
          when={terminated()}
          fallback={
            <Show when={t().exitCode != null && !running() && !pendingApproval() && !rejected()}>
              <span class="tool-exit" classList={{ ok: success() }}>
                exit {t().exitCode}
              </span>
            </Show>
          }
        >
          <span class="tool-exit">stopped</span>
        </Show>
      </button>

      <Show when={isImageOutput() && !running() && t().output.trim()}>
        <div class="tool-image">
          <Show when={imageSrc()} fallback={<div class="tool-image-wait"><span class="mini-spinner" /> Loading image...</div>}>
            <img src={imageSrc()!} alt={t().command} onClick={() => openImageViewer({ src: imageSrc(), path: imagePath(), title: t().command || 'Generated image' })} />
          </Show>
          <div class="tool-image-bar">
            <span class="tool-image-hint">Click image to enlarge · double-click to zoom</span>
            <IconButton icon="open_in_full" size={26} iconSize={15} color="var(--on-surface-variant)" title="Full view" onClick={() => openImageViewer({ src: imageSrc(), path: imagePath(), title: t().command || 'Generated image' })} />
            <IconButton
              icon="download"
              size={26}
              iconSize={16}
              color="var(--on-surface-variant)"
              title="Download"
              onClick={() => {
                const p = imagePath();
                if (p) send({ type: 'saveArtifact', path: p });
                else if (imageSrc()) {
                  const a = document.createElement('a');
                  a.href = imageSrc()!;
                  a.download = 'image.png';
                  a.click();
                }
              }}
            />
          </div>
        </div>
      </Show>

      <Collapse when={expanded()}>
        <div class="tool-out">
          <div class="tool-out-head">
            <span class="tool-out-cmd" classList={{ mono: type() === 'BASH' || type() === 'MCP' }}>
              {commandLine()}
            </span>
            <Show when={t().durationMs && t().durationMs! > 0}>
              <span class="tool-out-dur">⏱️ {formatDuration(t().durationMs)}</span>
            </Show>
            <Show when={canOpenText()}>
              <IconButton icon="open_in_new" size={24} iconSize={13} color="gray" title="Open in editor" onClick={openText} />
            </Show>
            <IconButton icon="copy" size={24} iconSize={13} color="gray" title="Copy Output" onClick={() => copyText(t().output, 'Output copied')} />
          </div>
          <Show
            when={t().output}
            fallback={<div class="tool-out-empty">{emptyMessage()}</div>}
          >
            <Show when={showDiff()} fallback={
              <pre class="tool-out-text">
                {output().text}
                <Show when={output().more > 0}>{`\n… ${output().more} more lines`}</Show>
              </pre>
            }>
              <DiffView diff={t().output} />
            </Show>
          </Show>
        </div>
      </Collapse>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ question tools

function QuestionToolCard(props: { call: ToolCall }) {
  const q = () => props.call.questionnaire;
  const completed = () => ['SUCCESS', 'COMPLETED', 'DONE'].includes(props.call.status);
  return (
    <Show
      when={q() && q()!.questions.length}
      fallback={
        <div class="qcard">
          <div class="qcard-title">
            <Icon name="help" size={16} color="var(--primary)" />
            <span>Questionnaire</span>
          </div>
          <div class="qcard-raw">{props.call.command}</div>
        </div>
      }
    >
      <Show when={completed()} fallback={<QuestionStatusRow call={props.call} questionnaire={q()!} />}>
        <AnswerSummary call={props.call} questionnaire={q()!} />
      </Show>
    </Show>
  );
}

/** ChoiceQuestionnaireCard.QuestionPanelStatusRow: the in-chat stand-in while the panel above the input asks. */
function QuestionStatusRow(props: { call: ToolCall; questionnaire: ChoiceQuestionnaire }) {
  const waiting = () => props.call.status === 'AWAITING_CHOICE';
  const look = () =>
    waiting()
      ? { title: 'Waiting for your answer', tint: 'var(--primary)' }
      : props.call.status === 'RUNNING'
        ? { title: 'Answer sent', tint: 'var(--success)' }
        : { title: 'Question dismissed', tint: alpha('var(--on-surface)', 0.5) };
  return (
    <div class="qstatus" style={{ '--tint': look().tint }}>
      <Icon name={waiting() ? 'help' : 'check_circle'} size={17} color={look().tint} />
      <div class="qstatus-text">
        <div class="qstatus-title">{look().title}</div>
        <For each={props.questionnaire.questions.slice(0, 3)}>{(q) => <div class="qstatus-q">• {q.prompt}</div>}</For>
        <Show when={props.questionnaire.questions.length > 3}>
          <div class="qstatus-more">+{props.questionnaire.questions.length - 3} more</div>
        </Show>
        <Show when={waiting()}>
          <div class="qstatus-hint">Answer in the panel above the message box.</div>
        </Show>
      </div>
    </div>
  );
}

/** ChoiceQuestionnaireCard's completed state: "Preferences Submitted" with Q / ↳ A pairs. */
function AnswerSummary(props: { call: ToolCall; questionnaire: ChoiceQuestionnaire }) {
  const pairs = createMemo(() => parseAnswerSummary(props.call.output, props.questionnaire));
  return (
    <div class="qcard done">
      <div class="qcard-title">
        <Icon name="check_circle" size={17} color="var(--success)" />
        <span>Preferences Submitted</span>
      </div>
      <Show when={pairs().length}>
        <div class="qcard-pairs">
          <For each={pairs()}>
            {(p) => (
              <div class="qpair">
                <div class="qpair-row">
                  <span class="qpair-q">Q:</span>
                  <span class="qpair-qtext">{p.q}</span>
                </div>
                <div class="qpair-row">
                  <span class="qpair-a">↳ A:</span>
                  <span class="qpair-atext">{p.a}</span>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function parseAnswerSummary(output: string, q: ChoiceQuestionnaire): { q: string; a: string }[] {
  const res: { q: string; a: string }[] = [];
  const clean = (output || '').replace('[User Clarification & Preferences]:', '').trim();
  const lines = clean
    .split('\n')
    .map((l) => l.trim().replace(/^•/, '').trim())
    .filter(Boolean);
  for (const qq of q.questions) {
    const p = qq.prompt.trim();
    const line = lines.find((l) => l.toLowerCase().startsWith(p.toLowerCase()) || l.toLowerCase().includes(p.toLowerCase()));
    if (line) res.push({ q: p, a: line.substring(line.indexOf(':') + 1).trim() || 'Selected' });
  }
  if (!res.length) {
    for (const l of lines) {
      const i = l.indexOf(':');
      if (i > 0 && l.substring(i + 1).trim()) res.push({ q: l.substring(0, i).trim(), a: l.substring(i + 1).trim() });
    }
  }
  return res;
}
