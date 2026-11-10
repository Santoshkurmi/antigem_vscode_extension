// Panels docked above the input: ui/agents/AgentApprovalPanel.kt and ui/agents/AgentQuestionPanel.kt.
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { ChoiceQuestion } from '@shared/model';
import type { ApprovalView, QuestionView } from '@shared/protocol';
import { send, state } from '../state/store';
import { Collapse, DropdownMenu, Icon, IconButton, type IconName } from '../ui/primitives';
import { MarkdownContent } from './Markdown';
import { agentAccent, agentLabel, alpha } from '../util/format';
import { esc } from '../markdown/inline';

// ------------------------------------------------------------------------------------------------ approvals

export function ApprovalPanel() {
  const items = () => state.chat.approvals;
  // keep the last request on screen while the panel animates away
  const [last, setLast] = createSignal<ApprovalView[]>([]);
  createEffect(() => {
    if (items().length) setLast(items().slice());
  });
  const shown = () => (items().length ? items() : last());
  return (
    <Collapse when={items().length > 0}>
      <Show when={shown()[0]}>{(item) => <ApprovalCard item={item()} count={shown().length} />}</Show>
    </Collapse>
  );
}

const APPROVAL_ICONS: Record<string, IconName> = {
  terminal: 'terminal_o',
  file: 'description_o',
  edit: 'edit_o',
  web: 'language',
  mcp: 'build',
  plan: 'checklist',
  shield: 'shield',
};

/** A plan approval: the 'plan' icon, or a choice of how to go on (several secondary choices). */
const isPlanApproval = (a: ApprovalView) => a.icon === 'plan' || /exitplanmode/i.test(a.title + ' ' + (a.subtitle ?? '')) || a.secondary.length > 0;

function ApprovalCard(props: { item: ApprovalView; count: number }) {
  const accent = () => agentAccent(props.item.agent);
  return (
    <div class="dock-card" style={{ '--accent': accent() }}>
      <Show when={props.item.key} keyed>
        {(_k) => (
          <div class="dock-swap">
            <ApprovalBody item={props.item} count={props.count} />
          </div>
        )}
      </Show>
    </div>
  );
}

function decide(item: ApprovalView, choiceId?: string, deny?: boolean, feedback?: string) {
  const c = state.chat.conversationId;
  if (!c) return;
  send({ type: 'approval', conversationId: c, key: item.key, choiceId, deny, feedback });
}

function ApprovalBody(props: { item: ApprovalView; count: number }) {
  const item = () => props.item;
  const [denying, setDenying] = createSignal(false);
  const [feedback, setFeedback] = createSignal('');
  const [alwaysOpen, setAlwaysOpen] = createSignal(false);
  const [moreOpen, setMoreOpen] = createSignal(false);
  let alwaysBtn: HTMLButtonElement | undefined;
  let moreBtn: HTMLButtonElement | undefined;

  const previewHtml = createMemo(() =>
    (item().preview ?? '')
      .split('\n')
      .map((l) => {
        const e = esc(l);
        if (l.startsWith('+ ')) return `<span style="color:var(--success)">${e}</span>`;
        if (l.startsWith('- ')) return `<span style="color:var(--danger)">${e}</span>`;
        if (l.startsWith('$ ')) return `<b>${e}</b>`;
        if (l.startsWith('# ')) return `<span style="color:var(--text-secondary)">${e}</span>`;
        return e;
      })
      .join('\n'),
  );

  return (
    <div class="approval">
      <div class="dock-head">
        <div class="dock-icon">
          <Icon name={APPROVAL_ICONS[item().icon] ?? 'shield'} size={19} color="var(--accent)" />
        </div>
        <div class="dock-titles">
          <div class="dock-title">{item().title}</div>
          <div class="dock-sub">{[agentLabel(item().agent), item().subtitle].filter(Boolean).join(' · ')}</div>
        </div>
        <Show when={props.count > 1}>
          <span class="dock-count">1 of {props.count}</span>
          <IconButton ref={(el) => (moreBtn = el)} icon="more_vert_o" size={32} iconSize={18} color={alpha('var(--on-surface)', 0.6)} title="More" onClick={() => setMoreOpen(true)} />
          <DropdownMenu
            anchor={() => moreBtn}
            open={moreOpen()}
            onClose={() => setMoreOpen(false)}
            align="end"
            items={[
              {
                label: `Allow all ${props.count}`,
                // a plan to approve (Claude's ExitPlanMode) is never approved in bulk: it is read first
                onClick: () => state.chat.approvals.filter((a) => !isPlanApproval(a)).forEach((a) => decide(a, a.primary.id)),
              },
              {
                label: `Deny all ${props.count}`,
                color: 'var(--danger)',
                onClick: () => state.chat.approvals.forEach((a) => decide(a, undefined, true)),
              },
            ]}
          />
        </Show>
      </div>
      <div class="approval-content">
        <Show when={item().target}>
          <div class="approval-target">{item().target}</div>
        </Show>
        <Show when={item().preview?.trim()}>
          <div class="approval-preview">
            <pre innerHTML={previewHtml()} />
          </div>
        </Show>
        <Show when={item().markdown?.trim()}>
          <div class="approval-md">
            <MarkdownContent text={item().markdown!} />
          </div>
        </Show>
        <Show when={item().reason?.trim()}>
          <div class="approval-reason">{item().reason}</div>
        </Show>

        <Show
          when={!denying()}
          fallback={
            <div class="deny-box">
              <textarea
                class="outlined-field"
                rows={2}
                placeholder={item().denyPlaceholder}
                value={feedback()}
                onInput={(e) => setFeedback(e.currentTarget.value)}
                ref={(el) => setTimeout(() => el.focus({ preventScroll: true }), 50)}
              />
              <div class="dock-actions end">
                <button class="text-btn" onClick={() => setDenying(false)}>
                  Back
                </button>
                <button
                  class="filled-btn"
                  style={{ background: item().secondary.length ? 'var(--accent)' : 'var(--danger)' }}
                  onClick={() => decide(item(), undefined, true, feedback().trim() || undefined)}
                >
                  {item().denyLabel}
                </button>
              </div>
            </div>
          }
        >
          <Show
            when={!item().secondary.length}
            fallback={
              <div class="plan-choices">
                <button class="filled-btn wide allow" onClick={() => decide(item(), item().primary.id)}>
                  {item().primary.label}
                </button>
                <For each={item().secondary}>
                  {(c) => (
                    <button class="outlined-btn wide" onClick={() => decide(item(), c.id)} title={c.description ?? undefined}>
                      {c.label}
                    </button>
                  )}
                </For>
                <button class="text-btn wide muted" onClick={() => setDenying(true)}>
                  {item().denyLabel}…
                </button>
              </div>
            }
          >
            <div class="dock-actions">
              <button class="text-btn deny" onClick={() => setDenying(true)}>
                {item().denyLabel}
              </button>
              <span class="flex1" />
              <Show when={item().always.length}>
                <button ref={alwaysBtn} class="outlined-btn always" onClick={() => setAlwaysOpen(true)}>
                  Always…
                  <Icon name="expand_more_o" size={18} color={alpha('var(--on-surface)', 0.6)} />
                </button>
                <DropdownMenu
                  anchor={() => alwaysBtn}
                  open={alwaysOpen()}
                  onClose={() => setAlwaysOpen(false)}
                  items={item().always.map((c) => ({ label: c.label, description: c.description ?? undefined, onClick: () => decide(item(), c.id) }))}
                />
              </Show>
              <button class="filled-btn allow" onClick={() => decide(item(), item().primary.id)}>
                {item().primary.label}
              </button>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ questions

export function QuestionPanel() {
  const q = () => (state.chat.approvals.length ? null : state.chat.question);
  const [last, setLast] = createSignal<QuestionView | null>(null);
  createEffect(() => {
    const x = state.chat.question;
    if (x) setLast(x);
  });
  return (
    <Collapse when={!!q()}>
      <Show when={q() ?? last()} keyed>
        {(question) => <QuestionCard question={question} />}
      </Show>
    </Collapse>
  );
}

function QuestionCard(props: { question: QuestionView }) {
  const qs = () => props.question.questionnaire.questions;
  const accent = () => agentAccent(props.question.agent);
  const [sel, setSel] = createStore<Record<string, string[]>>({});
  const [otherOn, setOtherOn] = createStore<Record<string, boolean>>({});
  const [otherText, setOtherText] = createStore<Record<string, string>>({});
  const [page, setPage] = createSignal(0);
  const [dir, setDir] = createSignal<'fwd' | 'back'>('fwd');
  const current = () => qs()[Math.min(page(), qs().length - 1)];
  const answered = (q: ChoiceQuestion) => (sel[q.id]?.length ?? 0) > 0 || (!!otherOn[q.id] && !!otherText[q.id]?.trim());
  const isLast = () => page() >= qs().length - 1;

  const submit = (skip: boolean, cancel = false) => {
    const c = state.chat.conversationId;
    if (!c) return;
    const answers: Record<string, string[]> = {};
    const custom: Record<string, string> = {};
    if (!skip) {
      for (const q of qs()) {
        answers[q.id] = [...(sel[q.id] ?? [])];
        const t = otherText[q.id]?.trim();
        if (otherOn[q.id] && t) custom[q.id] = t;
      }
    }
    send({
      type: 'answer',
      conversationId: c,
      key: props.question.key,
      answers,
      skip: skip || undefined,
      custom: Object.keys(custom).length ? custom : undefined,
      cancel: cancel || undefined,
    });
  };

  const toggle = (q: ChoiceQuestion, id: string) => {
    const cur = sel[q.id] ?? [];
    const on = cur.includes(id);
    if (q.isMultiSelect) setSel(q.id, on ? cur.filter((x) => x !== id) : [...cur, id]);
    else {
      setSel(q.id, on ? [] : [id]);
      setOtherOn(q.id, false);
    }
  };

  return (
    <div class="dock-card question" style={{ '--accent': accent() }}>
      <div class="dock-head">
        <div class="dock-icon">
          <Icon name="help" size={19} color="var(--accent)" />
        </div>
        <div class="dock-titles">
          <div class="dock-title q">
            {agentLabel(props.question.agent)} has {qs().length > 1 ? `${qs().length} questions` : 'a question'}
          </div>
          <Show when={qs().length > 1}>
            <div class="q-dots">
              <For each={qs()}>
                {(q, i) => <span class="q-dot" classList={{ cur: i() === page(), done: i() !== page() && answered(q) }} />}
              </For>
              <span class="q-page">
                {page() + 1} of {qs().length}
              </span>
            </div>
          </Show>
        </div>
        <IconButton icon="close_o" size={30} iconSize={18} color={alpha('var(--on-surface)', 0.55)} title="Dismiss question" onClick={() => submit(true, true)} />
      </div>

      <Show when={current()} keyed>
        {(q) => (
          <div class="q-page-body" classList={{ back: dir() === 'back' }}>
            <Show when={q.description && q.description.length <= 28}>
              <div class="q-kicker">{q.description!.toUpperCase()}</div>
            </Show>
            <div class="q-prompt">{q.prompt}</div>
            <Show when={q.description && q.description.length > 28}>
              <div class="q-desc">{q.description}</div>
            </Show>
            <div class="q-choose">{q.isMultiSelect ? 'Choose any' : 'Choose one'}</div>
            <div class="q-options">
              <For each={q.options}>
                {(o) => (
                  <OptionCard
                    label={o.label}
                    description={o.description}
                    selected={(sel[q.id] ?? []).includes(o.id)}
                    multi={q.isMultiSelect}
                    onClick={() => toggle(q, o.id)}
                  />
                )}
              </For>
              <Show when={q.allowCustomAnswer}>
                <OptionCard
                  label="Other…"
                  selected={!!otherOn[q.id]}
                  multi={q.isMultiSelect}
                  onClick={() => {
                    const on = !otherOn[q.id];
                    setOtherOn(q.id, on);
                    if (!q.isMultiSelect && on) setSel(q.id, []);
                  }}
                />
                <Collapse when={!!otherOn[q.id]}>
                  <textarea
                    class="outlined-field"
                    rows={2}
                    placeholder="Your answer"
                    value={otherText[q.id] ?? ''}
                    onInput={(e) => setOtherText(q.id, e.currentTarget.value)}
                  />
                </Collapse>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <div class="dock-actions">
        <button class="text-btn muted" onClick={() => submit(true)}>
          {qs().length > 1 ? 'Skip all' : 'Skip'}
        </button>
        <span class="flex1" />
        <Show when={page() > 0}>
          <button
            class="text-btn"
            style={{ color: 'var(--primary)' }}
            onClick={() => {
              setDir('back');
              setPage(page() - 1);
            }}
          >
            Back
          </button>
        </Show>
        <button
          class="filled-btn"
          style={{ background: 'var(--accent)' }}
          disabled={isLast() && !qs().some(answered)}
          onClick={() => {
            if (!isLast()) {
              setDir('fwd');
              setPage(page() + 1);
            } else submit(false);
          }}
        >
          {!isLast() ? (answered(current()) ? 'Next' : 'Skip question') : 'Submit'}
        </button>
      </div>
    </div>
  );
}

function OptionCard(props: { label: string; description?: string | null; selected: boolean; multi: boolean; onClick: () => void }) {
  return (
    <button class="q-option" classList={{ on: props.selected }} onClick={props.onClick}>
      <span class="q-ind" classList={{ multi: props.multi, on: props.selected }}>
        <Show when={props.selected}>
          <Show when={props.multi} fallback={<span class="q-radio-dot" />}>
            <Icon name="check" size={13} color="#fff" />
          </Show>
        </Show>
      </span>
      <span class="q-option-text">
        <span class="q-option-label">{props.label}</span>
        <Show when={props.description?.trim()}>
          <span class="q-option-desc">{props.description}</span>
        </Show>
      </span>
    </button>
  );
}
