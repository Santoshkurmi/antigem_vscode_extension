// Port of the Android app's domain/chat/TrajectoryEngine.kt: turns the hub's StreamAgentStateUpdates frames into the
// shared ChatMessage list. Two-tier cache like the app: finished turns are immutable (and their ChatMessage objects are
// cached, so unchanged messages keep their identity and are never re-sent to the UI); only the active turn is rebuilt.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ArtifactSnapshot, ChatAttachment, ChatMessage, ChoiceQuestionnaire, TokenUsage, ToolCall, ToolType } from '../../../shared/model';
import { decodeAs } from './proto';
import { displayUserText, parseVoiceTurn } from '../text';

export const CLIENT_MSG_TAG_PREFIX = 'client_msg:';

type Step = any;

interface UserTurn {
  kind: 'user';
  stepIndex: number;
  text: string;
  rawText: string;
  attachments: ChatAttachment[];
  createdAt: number | null;
}

type TurnBlock =
  | { kind: 'thinking'; stepIndex: number; thought: string; durationMs: number | null; isStreaming: boolean }
  | { kind: 'text'; stepIndex: number; markdown: string; isStreaming: boolean }
  | { kind: 'tool'; stepIndex: number; toolCall: ToolCall }
  | { kind: 'notice'; stepIndex: number; title: string; content: string }
  | {
      kind: 'error';
      stepIndex: number;
      title: string;
      userMessage: string;
      shortError: string;
      fullError: string;
      errorCode: number | null;
      errorId: string;
    };

interface AssistantTurn {
  kind: 'assistant';
  turnId: string;
  blocks: TurnBlock[];
  isStreaming: boolean;
  tokenUsage: TokenUsage | null;
  modelId: string | null;
}

type ChatTurn = UserTurn | AssistantTurn;

export interface QueuedEntry {
  id: string;
  text: string;
  media: any[];
  deliveryStrategy: string;
  tags: string[];
}

const S = {
  DONE: 'CORTEX_STEP_STATUS_DONE',
  RUNNING: 'CORTEX_STEP_STATUS_RUNNING',
  ERROR: 'CORTEX_STEP_STATUS_ERROR',
  WAITING: 'CORTEX_STEP_STATUS_WAITING',
  CANCELED: 'CORTEX_STEP_STATUS_CANCELED',
  PENDING: 'CORTEX_STEP_STATUS_PENDING',
  GENERATING: 'CORTEX_STEP_STATUS_GENERATING',
  QUEUED: 'CORTEX_STEP_STATUS_QUEUED',
  UNSPECIFIED: 'CORTEX_STEP_STATUS_UNSPECIFIED',
};
const T = (s: string) => `CORTEX_STEP_TYPE_${s}`;

const nonBlank = (s: unknown): string | null => (typeof s === 'string' && s.trim() !== '' ? s : null);
const tsMillis = (ts: any): number | null => (ts ? Number(ts.seconds ?? 0) * 1000 + Math.floor(Number(ts.nanos ?? 0) / 1e6) : null);
const durMillis = tsMillis;

/** The error, if it says anything (cloud chats send empty errors with every frame). */
export function realError(e: any): any | null {
  if (!e) return null;
  const has =
    nonBlank(e.user_error_message) ||
    nonBlank(e.short_error) ||
    nonBlank(e.full_error) ||
    nonBlank(e.model_error_message) ||
    nonBlank(e.details) ||
    (e.error_code ?? 0) !== 0 ||
    (e.structured_error_parts?.length ?? 0) > 0;
  return has ? e : null;
}

function isUserInput(step: Step): boolean {
  return step.type === T('USER_INPUT') || step.user_input != null;
}

function isAskChoice(step: Step): boolean {
  return (
    step.metadata?.tool_call?.name === 'ask_question' ||
    (step.generic?.args && 'ask_question' in step.generic.args) ||
    step.ask_question != null ||
    step.requested_interaction?.ask_question != null
  );
}

function isWaitingStep(step: Step): boolean {
  return (
    step.status === S.WAITING ||
    step.requested_interaction != null ||
    (isAskChoice(step) && step.status !== S.DONE && step.status !== S.CANCELED && step.status !== S.ERROR)
  );
}

/** RequestedInteraction kinds answered by `{confirm: bool}` (same field name in CascadeUserInteraction). */
export const CONFIRM_INTERACTIONS = [
  'mcp',
  'read_url_content',
  'browser_action',
  'approval_interaction',
  'run_command',
  'send_command_input',
  'open_browser_url',
  'run_extension_code',
  'execute_browser_javascript',
  'capture_browser_screenshot',
  'click_browser_pixel',
  'open_browser_setup',
  'confirm_browser_setup',
] as const;

/**
 * Which CascadeUserInteraction field answers a step's requested interaction (the field of RequestedInteraction that is
 * set; same names on both messages). The app's default is 'permission'.
 */
export function interactionTypeOf(step: Step | undefined): string {
  const ri = step?.requested_interaction;
  if (!ri) return 'permission';
  if (ri.permission) return 'permission';
  if (ri.file_permission) return 'file_permission';
  for (const k of CONFIRM_INTERACTIONS) if (ri[k]) return k;
  if (ri.deploy) return 'deploy';
  if (ri.elicitation) return 'elicitation';
  return 'permission';
}

function readableModelName(slug: string): string {
  const parts = slug.split('-').filter(Boolean);
  const levels = new Set(['low', 'medium', 'high', 'minimal', 'max', 'xhigh']);
  const last = parts[parts.length - 1];
  const level = last && levels.has(last.toLowerCase()) ? last : null;
  const words = (level ? parts.slice(0, -1) : parts).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return level ? `${words} (${level.charAt(0).toUpperCase() + level.slice(1)})` : words;
}

function extractTitleFromSystemMessage(msgText: string): string {
  const clean = msgText.trim();
  if (/^schedule timer/i.test(clean)) return 'Schedule Timer';
  if (/^timer has expired/i.test(clean)) return 'Timer Expired';
  if (/^task completed:/i.test(clean)) return 'Task Completed';
  if (/\[message\]/i.test(clean)) {
    const prefix = clean.slice(0, clean.toLowerCase().indexOf('[message]')).trim().replace(/:$/, '');
    if (prefix && prefix.length <= 40) return prefix;
    return 'System Notification';
  }
  const firstLine = clean.split('\n')[0]?.trim() ?? '';
  const colon = firstLine.indexOf(':');
  if (colon >= 3 && colon <= 40) {
    const candidate = firstLine.slice(0, colon).trim();
    if (candidate.length <= 40) return candidate;
  }
  return firstLine && firstLine.length <= 40 ? firstLine : 'System Notification';
}

const stripFile = (s: string) => s.replace(/^file:\/\//, '');
const baseName = (p: string) => p.split('/').pop() || p;

export class TrajectoryEngine {
  /** Model enum name → display name (set by the backend from its model list). */
  modelDisplayName: (id: string) => string = (id) => id;
  /** Cloud model name → listed model enum (set by the backend). */
  modelEnumForCloudName: (name: string) => string | null = () => null;

  artifacts: ArtifactSnapshot[] = [];
  trajectoryId = '';
  conversationId = '';
  isRunning = false;
  isWaitingInteraction = false;
  fullyIdle = true;
  totalStepsLength = 0;

  readonly userRespondedStepIndices = new Set<number>();

  private completedTurns: ChatTurn[] = [];
  private activeStepsMap = new Map<number, Step>();
  private activeTurnStartStep = 0;
  private pendingUserTurn: UserTurn | null = null;
  private pendingAgentMessages: any[] = [];
  private seenClientTags = new Set<string>();
  /** Finished turn → its ChatMessage (stable identity for unchanged messages). */
  private messageCache = new WeakMap<ChatTurn, ChatMessage>();

  /** Rebuild every message on the next toChatMessages (the model list changed: usage pills name the model). */
  invalidateMessages() {
    this.messageCache = new WeakMap();
  }

  /**
   * A local error bubble after the last turn (a message that could not be delivered), like the app's
   * formatStructuredErrorMessage reply. Dropped by the next full sync.
   */
  addLocalError(title: string, userMessage: string, shortError = userMessage) {
    this.cancelRunning();
    this.localErrorCount++;
    this.completedTurns.push({
      kind: 'assistant',
      turnId: `${this.conversationId}_local_error_${this.localErrorCount}`,
      blocks: [{ kind: 'error', stepIndex: this.totalStepsLength + this.localErrorCount, title, userMessage, shortError, fullError: '', errorCode: null, errorId: '' }],
      isStreaming: false,
      tokenUsage: null,
      modelId: null,
    });
  }
  private localErrorCount = 0;

  /** The step with this index, when it is in the active turn (for approvals). */
  activeStep(stepIndex: number): Step | undefined {
    return this.activeStepsMap.get(stepIndex);
  }

  queuedMessages(): QueuedEntry[] {
    const out: QueuedEntry[] = [];
    for (const m of this.pendingAgentMessages) {
      if (!nonBlank(m?.id) || m.hide_from_user) continue;
      let step: Step | null = null;
      try {
        step = m.step_payload ? decodeAs('Step', Buffer.from(m.step_payload, 'base64')) : null;
      } catch {
        step = null;
      }
      const input = step?.user_input;
      if (!input) continue;
      const items = (input.items ?? []).map((i: any) => nonBlank(i.text)).filter(Boolean).join('\n');
      const text = items || input.query || '';
      out.push({
        id: m.id,
        text: (() => {
          const v = parseVoiceTurn(text, input.tags ?? []);
          return v ? v.spoken || v.voiceLine || 'Voice request' : displayUserText(text, `q_${m.id}`).text;
        })(),
        media: input.media ?? [],
        deliveryStrategy: m.delivery_strategy ?? '',
        tags: input.tags ?? [],
      });
    }
    return out;
  }

  hasSeenClientTag(tag: string): boolean {
    return this.seenClientTags.has(tag);
  }

  private applyPendingMessagesUpdate(u: any) {
    const len = Number(u.total_length ?? 0);
    const next: any[] = new Array(len).fill(null);
    this.pendingAgentMessages.forEach((m, i) => {
      if (i < len) next[i] = m;
    });
    (u.indices ?? []).forEach((idx: number, k: number) => {
      if (idx >= 0 && idx < len && k < (u.pending_agent_messages?.length ?? 0)) next[idx] = u.pending_agent_messages[k];
    });
    this.pendingAgentMessages = next.map((m) => m ?? {});
  }

  reset(newConversationId = '', force = false) {
    if (!force && this.pendingUserTurn && (!this.conversationId || this.conversationId === newConversationId)) {
      if (newConversationId) this.conversationId = newConversationId;
      this.trajectoryId = '';
      this.userRespondedStepIndices.clear();
      this.activeStepsMap.clear();
      return;
    }
    this.conversationId = newConversationId;
    this.trajectoryId = '';
    this.isRunning = false;
    this.isWaitingInteraction = false;
    this.fullyIdle = true;
    this.totalStepsLength = 0;
    this.pendingAgentMessages = [];
    this.seenClientTags.clear();
    this.activeTurnStartStep = 0;
    this.userRespondedStepIndices.clear();
    this.completedTurns = [];
    this.activeStepsMap.clear();
    this.pendingUserTurn = null;
    this.artifacts = [];
  }

  /** Shows the user's prompt at once, before the hub echoes it back. */
  submitUserPrompt(text: string, attachments: ChatAttachment[], convId: string) {
    if (convId) this.conversationId = convId;
    this.finalizeActiveTurn();
    const shown = displayUserText(text, `att_${this.activeTurnStartStep}`);
    this.pendingUserTurn = {
      kind: 'user',
      stepIndex: this.activeTurnStartStep,
      text: shown.text,
      rawText: text,
      attachments: [...attachments, ...shown.cards],
      createdAt: Date.now(),
    };
  }

  cancelRunning() {
    this.isRunning = false;
    const pending = this.pendingUserTurn;
    if (pending && !this.completedTurns.some((t) => t.kind === 'user' && t.stepIndex === pending.stepIndex)) {
      this.completedTurns.push(pending);
    }
    this.pendingUserTurn = null;
  }

  markStepResponded(i: number) {
    this.userRespondedStepIndices.add(i);
  }
  unmarkStepResponded(i: number) {
    this.userRespondedStepIndices.delete(i);
  }

  optimisticUpdateStepStatus(stepIndex: number, status: string, output?: string) {
    const existing = this.activeStepsMap.get(stepIndex);
    if (!existing) return;
    const up = status.toUpperCase();
    const protoStatus =
      up === 'DONE' || up === 'SUCCESS'
        ? S.DONE
        : up === 'RUNNING'
          ? S.RUNNING
          : up === 'ERROR' || up === 'FAILED'
            ? S.ERROR
            : up === 'WAITING' || up === 'PENDING_APPROVAL' || up === 'AWAITING_CHOICE'
              ? S.WAITING
              : up === 'CANCELED' || up === 'REJECTED' || up === 'TERMINATED'
                ? S.CANCELED
                : S.UNSPECIFIED;
    const updated = {
      ...existing,
      status: protoStatus,
      run_command: output != null && existing.run_command ? { ...existing.run_command, stdout: output } : existing.run_command,
    };
    this.activeStepsMap.set(stepIndex, updated);
  }

  ingestAgentStateUpdate(update: any) {
    const convId = nonBlank(update.conversation_id);
    const trajId = nonBlank(update.trajectory_id);
    if (convId) this.conversationId = convId;
    if (trajId) this.trajectoryId = trajId;

    const metas = update.main_trajectory_update?.executor_metadatas_update?.executor_metadatas ?? [];
    const executorMeta = metas[metas.length - 1];
    const liveTerminationReason: string | undefined = executorMeta?.termination_reason;
    const executionError: string | undefined = executorMeta?.execution_error;

    // Hub rule: a conversation is running iff its own `status` is RUNNING (executor metadata may be stale).
    const daemonRunning = update.status === 'CASCADE_RUN_STATUS_RUNNING';
    const daemonIdle = update.status === 'CASCADE_RUN_STATUS_IDLE' || update.fully_idle === true;
    this.fullyIdle = update.fully_idle === true;

    if (update.pending_agent_messages_update) this.applyPendingMessagesUpdate(update.pending_agent_messages_update);

    const stepsUpdate = update.main_trajectory_update?.steps_update;
    const effectiveSteps: Step[] = stepsUpdate?.steps ?? [];
    const effectiveIndices: number[] = stepsUpdate?.indices?.length ? stepsUpdate.indices : effectiveSteps.map((_, i) => i);
    const totalLength = stepsUpdate ? Number(stepsUpdate.total_length ?? 0) : 0;
    if (stepsUpdate) this.totalStepsLength = totalLength;
    for (const s of effectiveSteps) for (const t of s.user_input?.tags ?? []) if (t.startsWith(CLIENT_MSG_TAG_PREFIX)) this.seenClientTags.add(t);

    if (effectiveSteps.length) {
      const isInitialFullSync = effectiveIndices[0] === 0 || (this.completedTurns.length === 0 && this.activeStepsMap.size === 0);
      if (isInitialFullSync) this.ingestInitialFullSync(effectiveIndices, effectiveSteps, daemonRunning);
      else this.ingestIncrementalDeltas(effectiveIndices, effectiveSteps, totalLength);
    }

    const frameLastStepError = realError(update.main_trajectory_update?.last_step_error);
    let terminationErrorMsg: string | null = null;
    if (!daemonRunning) {
      switch (liveTerminationReason) {
        case 'EXECUTOR_TERMINATION_REASON_ERROR':
          terminationErrorMsg = nonBlank(executionError) ?? 'Execution encountered an error';
          break;
        case 'EXECUTOR_TERMINATION_REASON_MAX_INVOCATIONS':
          terminationErrorMsg = 'Maximum step limit reached (max generator invocations)';
          break;
        case 'EXECUTOR_TERMINATION_REASON_MAX_FORCED_INVOCATIONS':
          terminationErrorMsg = 'Maximum forced invocation limit reached';
          break;
        case 'EXECUTOR_TERMINATION_REASON_MAX_TOKEN_BUDGET_EXCEEDED':
          terminationErrorMsg = 'Maximum token budget exceeded';
          break;
      }
    }
    const effectiveError =
      frameLastStepError ??
      (terminationErrorMsg ? { user_error_message: terminationErrorMsg, short_error: terminationErrorMsg, full_error: terminationErrorMsg } : null);

    const lastIdx = executorMeta?.last_step_idx;
    const keys = [...this.activeStepsMap.keys()];
    const targetIdx = typeof lastIdx === 'number' && lastIdx >= 0 ? lastIdx : keys.length ? Math.max(...keys) : this.activeTurnStartStep;
    const isTargetInActiveTurn = targetIdx >= this.activeTurnStartStep || this.activeStepsMap.has(targetIdx);

    if (effectiveError && isTargetInActiveTurn) {
      const existingStep = this.activeStepsMap.get(targetIdx);
      if (existingStep && (realError(existingStep.error_message?.error) || realError(existingStep.error))) {
        const curErr = existingStep.error_message?.error ?? existingStep.error;
        const base = curErr ?? effectiveError;
        const enriched = {
          ...base,
          full_error: nonBlank(curErr?.full_error) ?? effectiveError.full_error ?? '',
          short_error: nonBlank(curErr?.short_error) ?? effectiveError.short_error ?? '',
          user_error_message: nonBlank(curErr?.user_error_message) ?? effectiveError.user_error_message ?? '',
          error_code: curErr?.error_code ?? effectiveError.error_code,
          error_id: nonBlank(curErr?.error_id) ?? effectiveError.error_id ?? '',
        };
        this.activeStepsMap.set(targetIdx, { ...existingStep, error_message: { error: enriched, should_show_user: true }, error: enriched });
      } else if (
        ![...this.activeStepsMap.values()].some(
          (s) => realError(s.error_message?.error) || realError(s.error) || s.type === T('ERROR_MESSAGE'),
        )
      ) {
        this.activeStepsMap.set(targetIdx, {
          type: T('ERROR_MESSAGE'),
          status: S.DONE,
          error_message: { error: effectiveError, should_show_user: true },
          error: effectiveError,
        });
      }
    }

    this.isRunning = daemonRunning;
    if (daemonIdle && effectiveSteps.length) this.pendingUserTurn = null;

    let waiting = false;
    for (const [idx, step] of this.activeStepsMap) if (isWaitingStep(step) && !this.userRespondedStepIndices.has(idx)) waiting = true;
    this.isWaitingInteraction = waiting;

    const snaps = update.artifact_snapshots_update?.artifact_snapshots ?? [];
    if (snaps.length) {
      const current = [...this.artifacts];
      for (const snap of snaps) {
        const incoming: ArtifactSnapshot = {
          name: snap.artifact_name ?? '',
          absoluteUri: snap.artifact_absolute_uri ?? '',
          lastEdited: snap.last_edited ? String(snap.last_edited.seconds ?? '') : '',
          summary: snap.artifact_metadata?.summary ?? '',
          requestFeedback: snap.artifact_metadata?.request_feedback === true,
          userFacing: snap.artifact_metadata?.user_facing === true,
        };
        const i = current.findIndex(
          (a) => (a.absoluteUri && a.absoluteUri === incoming.absoluteUri) || (a.name && a.name === incoming.name),
        );
        if (i >= 0) current[i] = incoming;
        else current.push(incoming);
      }
      this.artifacts = current;
    }
  }

  private ingestInitialFullSync(indices: number[], steps: Step[], cascadeRunning: boolean) {
    const savedPending = this.pendingUserTurn;
    this.completedTurns = [];
    this.activeStepsMap.clear();
    this.activeTurnStartStep = 0;
    this.pendingUserTurn = null;

    let currentBlocks: TurnBlock[] = [];
    let currentSteps: Step[] = [];
    let lastUserArrayIndex = -1;
    let hasUserInputStep = false;

    for (let i = 0; i < steps.length; i++) {
      const stepIndex = indices[i] ?? i;
      const step = steps[i];
      if (isUserInput(step)) {
        hasUserInputStep = true;
        if (currentBlocks.length) {
          const prevUserStepIdx = lastUserArrayIndex >= 0 ? (indices[lastUserArrayIndex] ?? lastUserArrayIndex) : -1;
          this.completedTurns.push({
            kind: 'assistant',
            turnId: `${this.conversationId}_${prevUserStepIdx + 1}`,
            blocks: currentBlocks,
            isStreaming: false,
            tokenUsage: this.computeTokenUsage(currentSteps),
            modelId: this.turnModel(currentSteps),
          });
          currentBlocks = [];
          currentSteps = [];
        }
        this.completedTurns.push(this.userTurnOf(step, stepIndex));
        lastUserArrayIndex = i;
        this.activeTurnStartStep = stepIndex + 1;
      } else {
        currentSteps.push(step);
        this.extractStepBlocks(step, stepIndex, false, currentBlocks);
      }
    }

    if (!hasUserInputStep && savedPending) this.pendingUserTurn = savedPending;

    const hasActiveWork =
      cascadeRunning || currentBlocks.some((b) => b.kind === 'tool' && b.toolCall.status === 'PENDING_APPROVAL');
    if (hasActiveWork && currentBlocks.length) {
      const startIdx = lastUserArrayIndex >= 0 ? lastUserArrayIndex + 1 : 0;
      for (let i = startIdx; i < steps.length; i++) this.activeStepsMap.set(indices[i] ?? i, steps[i]);
    } else if (currentBlocks.length) {
      const lastUserStepIdx = lastUserArrayIndex >= 0 ? (indices[lastUserArrayIndex] ?? lastUserArrayIndex) : -1;
      this.completedTurns.push({
        kind: 'assistant',
        turnId: `${this.conversationId}_${lastUserStepIdx + 1}`,
        blocks: currentBlocks,
        isStreaming: false,
        tokenUsage: this.computeTokenUsage(currentSteps),
        modelId: this.turnModel(currentSteps),
      });
    }
  }

  private ingestIncrementalDeltas(indices: number[], steps: Step[], totalLength: number) {
    if (totalLength >= 1 && totalLength <= this.activeStepsMap.size) {
      for (const k of [...this.activeStepsMap.keys()]) if (k >= totalLength) this.activeStepsMap.delete(k);
    }
    for (let i = 0; i < steps.length; i++) {
      const stepIndex = indices[i] ?? this.activeTurnStartStep + i;
      const step = steps[i];
      if (isUserInput(step)) {
        this.finalizeActiveTurn();
        this.pendingUserTurn = null;
        const userTurn = this.userTurnOf(step, stepIndex);
        const existingIdx = this.completedTurns.findIndex((t) => t.kind === 'user' && t.stepIndex === stepIndex);
        if (existingIdx >= 0) this.completedTurns[existingIdx] = userTurn;
        else this.completedTurns.push(userTurn);
        this.activeTurnStartStep = stepIndex + 1;
        this.activeStepsMap.clear();
      } else {
        this.activeStepsMap.set(stepIndex, step);
      }
    }
  }

  private turnModel(steps: Iterable<Step>): string | null {
    let last: string | null = null;
    for (const s of steps) last = this.stepModel(s) ?? last;
    return last;
  }

  private stepModel(step: Step): string | null {
    const meta = step.metadata;
    if (!meta) return null;
    const gen: unknown = meta.generator_model;
    // a model enum newer than this proto copy arrives as a number (Wire: UNSPECIFIED)
    if (typeof gen !== 'string' || !gen || gen.includes('UNSPECIFIED')) return null;
    if (gen !== 'MODEL_GOOGLE_GEMINI_INTERNAL_BYOM') return gen;
    const cloudName = nonBlank(meta.model_info?.display_name) ?? nonBlank(meta.model_info?.model_name);
    if (!cloudName) return null;
    return this.modelEnumForCloudName(cloudName) ?? readableModelName(cloudName);
  }

  private computeTokenUsage(steps: Iterable<Step>): TokenUsage | null {
    const all = [...steps];
    const planner = all.filter((s) => s.type === T('PLANNER_RESPONSE') && s.status === S.DONE && s.metadata?.model_usage);
    const starts = all.map((s) => tsMillis(s.metadata?.created_at) ?? tsMillis(s.metadata?.started_at)).filter((x): x is number => x != null);
    const ends = all
      .map((s) => tsMillis(s.metadata?.completed_at) ?? tsMillis(s.metadata?.finished_generating_at))
      .filter((x): x is number => x != null);
    let durationMs = 0;
    if (starts.length && ends.length) {
      const st = Math.min(...starts);
      const en = Math.max(...ends);
      durationMs = en >= st ? en - st : 0;
    }
    if (!planner.length && durationMs === 0) return null;
    const outputTokens = planner.reduce((a, s) => a + Number(s.metadata?.model_usage?.output_tokens ?? 0), 0);
    const promptTokens = Number(planner[planner.length - 1]?.metadata?.model_usage?.input_tokens ?? 0);
    const cachedTokens = planner.reduce((a, s) => a + Number(s.metadata?.model_usage?.cache_read_tokens ?? 0), 0);
    if (!outputTokens && !promptTokens && !cachedTokens && !durationMs) return null;
    return {
      promptTokens,
      outputTokens,
      cachedTokens,
      cacheCreationTokens: 0,
      totalTokens: promptTokens + outputTokens,
      durationMs,
      isEstimated: false,
    };
  }

  private finalizeActiveTurn() {
    if (!this.activeStepsMap.size) return;
    const blocks: TurnBlock[] = [];
    for (const [idx, step] of [...this.activeStepsMap].sort((a, b) => a[0] - b[0])) this.extractStepBlocks(step, idx, false, blocks);
    if (blocks.length) {
      const turnId = `${this.conversationId}_${this.activeTurnStartStep}`;
      const tokenUsage = this.computeTokenUsage(this.activeStepsMap.values());
      const modelId = this.turnModel(this.activeStepsMap.values());
      let existingIndex = -1;
      for (let i = this.completedTurns.length - 1; i >= 0; i--) {
        const t = this.completedTurns[i];
        if (t.kind === 'assistant' && t.turnId === turnId) {
          existingIndex = i;
          break;
        }
      }
      if (existingIndex >= 0) {
        const ex = this.completedTurns[existingIndex] as AssistantTurn;
        const merged = [...ex.blocks.filter((eb) => !blocks.some((b) => b.stepIndex === eb.stepIndex)), ...blocks].sort(
          (a, b) => a.stepIndex - b.stepIndex,
        );
        this.completedTurns[existingIndex] = { ...ex, blocks: merged, isStreaming: false, tokenUsage: tokenUsage ?? ex.tokenUsage, modelId: modelId ?? ex.modelId };
      } else {
        this.completedTurns.push({ kind: 'assistant', turnId, blocks, isStreaming: false, tokenUsage, modelId });
      }
    }
    this.activeStepsMap.clear();
    this.isWaitingInteraction = false;
  }

  /** Completed turns (cached) + the active turn (rebuilt). */
  getTurns(): ChatTurn[] {
    const pending = this.pendingUserTurn;
    const baseTurns: ChatTurn[] =
      pending && !this.completedTurns.some((t) => t.kind === 'user' && t.stepIndex === pending.stepIndex)
        ? [...this.completedTurns, pending]
        : [...this.completedTurns];

    const nextAssistantStartStep = pending ? this.activeTurnStartStep + 1 : this.activeTurnStartStep;
    const turnId = `${this.conversationId}_${nextAssistantStartStep}`;
    let existingIdx = -1;
    for (let i = baseTurns.length - 1; i >= 0; i--) {
      const t = baseTurns[i];
      if (t.kind === 'assistant' && t.turnId === turnId) {
        existingIdx = i;
        break;
      }
    }

    if (!this.activeStepsMap.size) {
      if ((this.isRunning || pending) && !this.isWaitingInteraction) {
        if (existingIdx >= 0) {
          const ex = baseTurns[existingIdx] as AssistantTurn;
          baseTurns[existingIdx] = { ...ex, isStreaming: true };
          return baseTurns;
        }
        return [...baseTurns, { kind: 'assistant', turnId, blocks: [], isStreaming: true, tokenUsage: null, modelId: null }];
      }
      return baseTurns;
    }

    const activeBlocks: TurnBlock[] = [];
    let waitingFound = false;
    for (const [idx, step] of [...this.activeStepsMap].sort((a, b) => a[0] - b[0])) {
      const stepRunning = step.status === S.RUNNING || step.status === S.PENDING || step.status === S.GENERATING || step.status === S.QUEUED;
      if (isWaitingStep(step) && !this.userRespondedStepIndices.has(idx)) waitingFound = true;
      this.extractStepBlocks(step, idx, stepRunning && this.isRunning, activeBlocks);
    }
    this.isWaitingInteraction = waitingFound;

    const finalBlocks =
      existingIdx >= 0
        ? [
            ...(baseTurns[existingIdx] as AssistantTurn).blocks.filter((eb) => !activeBlocks.some((b) => b.stepIndex === eb.stepIndex)),
            ...activeBlocks,
          ].sort((a, b) => a.stepIndex - b.stepIndex)
        : activeBlocks;

    if (finalBlocks.length || (this.isRunning && !this.isWaitingInteraction)) {
      const activeTurn: AssistantTurn = {
        kind: 'assistant',
        turnId,
        blocks: finalBlocks,
        isStreaming: this.isRunning && !this.isWaitingInteraction,
        tokenUsage: this.computeTokenUsage(this.activeStepsMap.values()),
        modelId: this.turnModel(this.activeStepsMap.values()),
      };
      if (existingIdx >= 0) baseTurns[existingIdx] = activeTurn;
      else baseTurns.push(activeTurn);
    }
    return baseTurns;
  }

  toChatMessages(convId = this.conversationId): ChatMessage[] {
    const turns = this.getTurns();
    const messages: ChatMessage[] = [];
    const seen = new Set<string>();
    for (const turn of turns) {
      const cached = this.messageCache.get(turn);
      if (cached && cached.conversationId === convId && !seen.has(cached.id)) {
        seen.add(cached.id);
        messages.push(cached);
        continue;
      }
      let msg: ChatMessage | null = null;
      if (turn.kind === 'user') {
        const uId = `user_${convId}_${turn.stepIndex}`;
        if (seen.has(uId)) continue;
        msg = {
          id: uId,
          conversationId: convId,
          role: 'USER',
          content: turn.text,
          rawContent: turn.rawText,
          toolCalls: [],
          isStreaming: false,
          attachments: turn.attachments,
          stepIndex: turn.stepIndex,
          createdAt: turn.createdAt ?? Date.now(),
        };
      } else {
        msg = this.assistantMessage(turn, convId, seen);
      }
      seen.add(msg.id);
      this.messageCache.set(turn, msg);
      messages.push(msg);
    }
    return messages;
  }

  private assistantMessage(turn: AssistantTurn, convId: string, seen: Set<string>): ChatMessage {
    const thoughts: string[] = [];
    let maxDuration: number | null = null;
    const toolCalls: ToolCall[] = [];
    const parts: string[] = [];
    for (const block of turn.blocks) {
      switch (block.kind) {
        case 'thinking': {
          const t = block.thought.trim();
          const streamTag = block.isStreaming ? ':streaming' : '';
          const durTag = block.durationMs && block.durationMs > 0 ? `:${block.durationMs}` : '';
          if (t) {
            parts.push(`<!-- thought${streamTag}${durTag} -->\n${t}\n<!-- /thought -->`);
            thoughts.push(t);
          }
          if (block.durationMs && block.durationMs > 0) maxDuration = Math.max(maxDuration ?? 0, block.durationMs);
          break;
        }
        case 'text':
          if (block.markdown.trim()) parts.push(block.markdown.trim());
          break;
        case 'tool':
          if (!toolCalls.some((t) => t.stepIndex === block.stepIndex)) {
            toolCalls.push(block.toolCall);
            parts.push(`<!-- tool_call:${block.toolCall.id} -->`);
          }
          break;
        case 'error': {
          const err: Record<string, unknown> = {
            title: block.title,
            userMessage: block.userMessage,
            shortError: block.shortError,
            fullError: block.fullError,
          };
          if (block.errorCode != null) err.errorCode = block.errorCode;
          if (block.errorId) err.errorId = block.errorId;
          parts.push(`<!-- error:${block.stepIndex} -->\n${JSON.stringify(err)}\n<!-- /error -->`);
          break;
        }
        case 'notice': {
          if (!block.content.trim()) break;
          const id = `notice_${block.stepIndex}`;
          if (!toolCalls.some((t) => t.id === id || t.stepIndex === block.stepIndex)) {
            toolCalls.push({
              id,
              name: 'system_notice',
              toolType: 'SYSTEM_NOTIFICATION',
              command: block.title || 'System Notification',
              status: 'SUCCESS',
              output: block.content,
              exitCode: 0,
              stepIndex: block.stepIndex,
            });
            parts.push(`<!-- tool_call:${id} -->`);
          }
          break;
        }
      }
    }
    let aId = turn.turnId || `asst_${convId}_${this.activeTurnStartStep}`;
    let counter = 1;
    while (seen.has(aId)) aId = `${turn.turnId}_${counter++}`;
    const usage = turn.tokenUsage ? (turn.modelId ? { ...turn.tokenUsage, model: this.modelDisplayName(turn.modelId) } : turn.tokenUsage) : null;
    return {
      id: aId,
      conversationId: convId,
      role: 'ASSISTANT',
      content: parts.join('\n\n').trim(),
      thoughtText: thoughts.join('\n\n').trim() || null,
      thoughtDurationMs: maxDuration,
      toolCalls,
      isStreaming: turn.isStreaming,
      tokenUsage: usage,
      attachments: [],
      createdAt: Date.now(),
      modelId: turn.modelId,
    };
  }

  private extractStepBlocks(step: Step, stepIndex: number, isStreaming: boolean, blocks: TurnBlock[]) {
    if (isUserInput(step)) return;

    if (step.type === T('PLANNER_RESPONSE') || step.planner_response != null) {
      const thinking = nonBlank(step.planner_response?.thinking);
      const response = nonBlank(step.planner_response?.response);
      const dur = durMillis(step.planner_response?.thinking_duration);
      if (thinking) blocks.push({ kind: 'thinking', stepIndex, thought: thinking, durationMs: dur, isStreaming });
      if (response) blocks.push({ kind: 'text', stepIndex, markdown: response, isStreaming });
      return;
    }

    if (step.type === T('SYSTEM_MESSAGE') || step.system_message != null) {
      const sys = step.system_message;
      const msgText = nonBlank(sys?.message) ?? '';
      const title =
        (nonBlank(sys?.render_info?.title) && sys.render_info.title !== 'System' ? sys.render_info.title : null) ??
        nonBlank(sys?.agent_message?.render_details?.message_title) ??
        extractTitleFromSystemMessage(msgText);
      const hidden = sys?.render_info?.hidden === true || sys?.agent_message?.hide_from_user === true;
      const lower = msgText.toLowerCase();
      const bgStop =
        lower.includes('subagents and background tasks have been stopped') ||
        lower.includes('server restart') ||
        lower.includes('stopped due to server restart');
      if (!hidden && !bgStop && msgText.trim()) blocks.push({ kind: 'notice', stepIndex, title, content: msgText });
      return;
    }

    const stepError = realError(step.error_message?.error) ?? realError(step.error);
    if (step.type === T('ERROR_MESSAGE') || step.status === S.ERROR || stepError) {
      const userMsg = nonBlank(stepError?.user_error_message) ?? 'Agent Execution Error';
      const shortErr = nonBlank(stepError?.short_error) ?? nonBlank(stepError?.model_error_message) ?? '';
      const fullErr = nonBlank(stepError?.full_error) ?? '';
      const code: number | null = stepError?.error_code ?? null;
      const s = shortErr.toLowerCase();
      const u = userMsg.toLowerCase();
      const title =
        s.includes('cancel') || u.includes('cancel') || u.includes('stopped by user')
          ? 'Generation Stopped by User'
          : s.includes('auth') || u.includes('auth')
            ? 'Authentication Required'
            : s.includes('quota') || s.includes('credit') || code === 429
              ? 'Quota / Usage Limit Exceeded'
              : s.includes('model not found') || s.includes('unknown model')
                ? 'Model Configuration Error'
                : s.includes('network') || s.includes('connect')
                  ? 'Network / Server Connection Error'
                  : 'Agent Execution Error';
      blocks.push({
        kind: 'error',
        stepIndex,
        title,
        userMessage: userMsg,
        shortError: shortErr,
        fullError: fullErr,
        errorCode: code,
        errorId: stepError?.error_id ?? '',
      });
      return;
    }

    const tc = this.extractToolCall(step, stepIndex);
    if (tc) blocks.push({ kind: 'tool', stepIndex, toolCall: tc });
  }

  private extractToolCall(step: Step, stepIndex: number): ToolCall | null {
    const meta = step.metadata;
    const args: Record<string, string> = step.generic?.args ?? {};
    const typeName: Record<string, string> = {
      [T('RUN_COMMAND')]: 'run_command',
      [T('VIEW_FILE')]: 'view_file',
      [T('CODE_ACTION')]: 'code_action',
      [T('LIST_DIRECTORY')]: 'list_dir',
      [T('GREP_SEARCH')]: 'grep_search',
      [T('FIND')]: 'find',
      [T('SEARCH_WEB')]: 'search_web',
      [T('READ_URL_CONTENT')]: 'read_url',
      [T('READ_RESOURCE')]: 'read_url',
      [T('GENERATE_IMAGE')]: 'generate_image',
      [T('MCP_TOOL')]: 'call_mcp_tool',
      [T('ASK_QUESTION')]: 'ask_question',
    };
    const rawName: string =
      nonBlank(meta?.tool_call?.name) ??
      typeName[step.type] ??
      (step.run_command
        ? 'run_command'
        : step.view_file
          ? 'view_file'
          : step.code_action
            ? 'code_action'
            : step.write_to_file
              ? 'write_to_file'
              : step.list_directory
                ? 'list_dir'
                : step.grep_search
                  ? 'grep_search'
                  : step.find
                    ? 'find'
                    : step.search_web
                      ? 'search_web'
                      : step.read_url_content
                        ? 'read_url'
                        : step.generate_image
                          ? 'generate_image'
                          : step.mcp_tool
                            ? 'call_mcp_tool'
                            : step.ask_question || step.requested_interaction?.ask_question
                              ? 'ask_question'
                              : (nonBlank(meta?.tool_summary) ?? 'unknown_tool'));

    const toolType: ToolType = (() => {
      switch (rawName) {
        case 'run_command':
        case 'bash':
        case 'terminal':
          return 'BASH';
        case 'view_file':
          return 'VIEW_FILE';
        case 'write_to_file':
        case 'replace_file_content':
        case 'multi_replace_file_content':
        case 'edit_file':
        case 'code_action':
        case 'codeaction':
          return 'EDIT_FILE';
        case 'list_dir':
        case 'list_directory':
          return 'LIST_DIR';
        case 'grep_search':
          return 'GREP_SEARCH';
        case 'find':
        case 'find_by_name':
          return 'FIND';
        case 'search_web':
          return 'SEARCH_WEB';
        case 'read_url':
        case 'read_url_content':
        case 'read_resource':
          return 'READ_URL';
        case 'generate_image':
          return 'GENERATE_IMAGE';
        case 'call_mcp_tool':
        case 'mcp_tool':
          return 'MCP';
        case 'ask_choices':
        case 'ask_question':
        case 'user_choice':
          return 'ASK_CHOICE';
        case 'system_notice':
        case 'system_notification':
        case 'system_message':
          return 'SYSTEM_NOTIFICATION';
        default:
          return rawName.startsWith('mcp_') ? 'MCP' : 'UNKNOWN';
      }
    })();

    const fullOutputUri: string | undefined = step.generic?.result?.full_output_uri;
    const runCmd = step.run_command;
    const codeAct = step.code_action;
    const viewF = step.view_file;
    const listDir = step.list_directory;
    const searchW = step.search_web;
    const grepS = step.grep_search;
    const findF = step.find;
    const readUrl = step.read_url_content;
    const genImg = step.generate_image;
    const mcp = step.mcp_tool;
    const askQ = step.ask_question;
    const summary = nonBlank(meta?.tool_summary);
    const diffOf = () => {
      const lines = codeAct?.action_result?.edit?.diff?.unified_diff?.lines;
      return lines?.length ? lines.map((l: any) => l.text ?? '').join('\n') : '';
    };

    let command = '';
    let output = '';
    let exitCode: number | null = null;
    let questionnaire: ChoiceQuestionnaire | null = null;

    switch (rawName) {
      case 'run_command':
      case 'bash':
      case 'terminal':
        command = nonBlank(runCmd?.command_line) ?? nonBlank(runCmd?.proposed_command_line) ?? args.CommandLine ?? summary ?? 'run_command';
        output = nonBlank(runCmd?.combined_output?.full) ?? runCmd?.stdout ?? '';
        exitCode = runCmd ? Number(runCmd.exit_code ?? 0) : null;
        break;
      case 'view_file': {
        const p = stripFile(args.AbsolutePath ?? viewF?.absolute_path_uri ?? '');
        const fileName = baseName(p);
        const start = args.StartLine ? Number(args.StartLine) : viewF?.start_line;
        const end = args.EndLine ? Number(args.EndLine) : viewF?.end_line;
        const range = start != null && end != null ? ` (lines ${start}-${end})` : end != null ? ` (lines 1-${end})` : '';
        command = fileName ? `${fileName}${range}` : (summary ?? 'view_file');
        output = nonBlank(viewF?.content) ?? (fullOutputUri ? `[File content at ${fullOutputUri}]` : '');
        break;
      }
      case 'write_to_file': {
        const p = stripFile(args.TargetFile ?? codeAct?.action_spec?.create_file?.path?.absolute_uri ?? codeAct?.action_result?.edit?.absolute_uri ?? '');
        command = p ? baseName(p) : (summary ?? 'write_to_file');
        output = diffOf() || (args.CodeContent ?? '');
        break;
      }
      case 'replace_file_content': {
        const p = stripFile(args.TargetFile ?? codeAct?.action_spec?.command?.file?.absolute_uri ?? codeAct?.action_result?.edit?.absolute_uri ?? '');
        const start = args.StartLine ? Number(args.StartLine) : codeAct?.action_spec?.command?.line_range?.start_line;
        const end = args.EndLine ? Number(args.EndLine) : codeAct?.action_spec?.command?.line_range?.end_line;
        const range = start != null && end != null ? ` (lines ${start}-${end})` : '';
        command = p ? `${baseName(p)}${range}` : (summary ?? 'replace_file_content');
        output =
          diffOf() ||
          (() => {
            const target = args.TargetContent ?? '';
            const repl = args.ReplacementContent ?? '';
            return target || repl ? `--- Target (${start ?? 1}-${end ?? '?'}):\n${target}\n\n+++ Replacement:\n${repl}` : '';
          })();
        break;
      }
      case 'multi_replace_file_content': {
        const p = stripFile(args.TargetFile ?? codeAct?.action_spec?.command?.file?.absolute_uri ?? codeAct?.action_result?.edit?.absolute_uri ?? '');
        command = p ? `${baseName(p)} (multi-replace)` : (summary ?? 'multi_replace_file_content');
        output = diffOf() || (args.ReplacementChunks ?? '');
        break;
      }
      case 'list_dir': {
        const d = stripFile(args.DirectoryPath ?? listDir?.directory_path_uri ?? '');
        command = d ? baseName(d) : (summary ?? 'list_dir');
        if (listDir?.results?.length) {
          output = listDir.results
            .map((e: any) => `${e.is_dir ? '📁' : '📄'} ${e.name ?? ''}${Number(e.size_bytes ?? 0) > 0 ? ` (${e.size_bytes} B)` : ''}`)
            .join('\n');
        } else if (listDir?.children?.length) output = listDir.children.map((c: string) => `📄 ${c}`).join('\n');
        break;
      }
      case 'grep_search': {
        const query = args.Query ?? grepS?.query ?? '';
        const sp = stripFile(args.SearchPath ?? grepS?.search_path_uri ?? '');
        const pd = sp ? baseName(sp) : '';
        command = query && pd ? `"${query}" in ${pd}` : query || summary || 'grep_search';
        output = grepS?.results?.length
          ? grepS.results.map((r: any) => `${r.relative_path || r.absolute_path || ''}:${r.line_number ?? 0}: ${r.content ?? ''}`).join('\n')
          : grepS
            ? (grepS.raw_output ?? '')
            : '';
        break;
      }
      case 'find':
      case 'find_by_name': {
        const pattern = args.Pattern ?? findF?.pattern ?? '*';
        const dir = baseName(stripFile(args.SearchDirectory ?? findF?.search_directory ?? ''));
        command = dir ? `${pattern} in ${dir}` : `find ${pattern}`;
        output = nonBlank(findF?.truncated_output) ?? (findF ? (findF.raw_output ?? '') : '');
        break;
      }
      case 'search_web': {
        const query = args.query ?? searchW?.query ?? '';
        command = query || summary || 'search_web';
        let o = searchW?.summary?.trim() ? searchW.summary : '';
        if (searchW?.web_documents?.length) {
          if (o) o += '\n\n';
          for (const r of searchW.web_documents) o += `• ${r.title ?? ''} (${r.url ?? ''})\n  ${r.summary || r.text || ''}\n`;
        }
        output = o;
        break;
      }
      case 'read_url':
      case 'read_url_content':
        command = args.Url ?? readUrl?.url ?? summary ?? 'read_url';
        output = nonBlank(readUrl?.web_document?.text) ?? readUrl?.web_document?.summary ?? '';
        break;
      case 'generate_image': {
        command = args.Prompt ?? genImg?.prompt ?? summary ?? 'generate_image';
        const inline = genImg?.generated_media?.inline_data;
        const imgB64 = nonBlank(genImg?.generated_image?.base64_data);
        if (inline) output = `data:${nonBlank(genImg?.generated_media?.mime_type) ?? 'image/png'};base64,${inline}`;
        else if (imgB64) output = `data:${nonBlank(genImg?.generated_image?.mime_type) ?? 'image/png'};base64,${imgB64}`;
        else output = nonBlank(genImg?.generated_media?.uri) ?? nonBlank(genImg?.generated_image?.uri) ?? '';
        break;
      }
      case 'call_mcp_tool': {
        const sName = args.ServerName ?? mcp?.server_name ?? '';
        const tName = args.ToolName ?? mcp?.tool_call?.name ?? '';
        command = sName && tName ? `${sName} / ${tName}` : tName || summary || 'call_mcp_tool';
        output = nonBlank(mcp?.result_string) ?? (mcp?.result_uri ? `[Result at ${mcp.result_uri}]` : '');
        break;
      }
      case 'ask_choices':
      case 'ask_question':
      case 'user_choice': {
        const qs: any[] | undefined = askQ?.questions?.length
          ? askQ.questions
          : step.requested_interaction?.ask_question?.questions?.length
            ? step.requested_interaction.ask_question.questions
            : undefined;
        const title = nonBlank(meta?.tool_action) ?? summary ?? 'Questionnaire';
        if (qs?.length) {
          questionnaire = {
            title: title || 'Clarification & Options',
            description: meta?.tool_action && meta.tool_action !== title ? meta.tool_action : null,
            allowCustomNote: true,
            questions: qs.map((q, i) => ({
              id: String(i + 1),
              prompt: q.question ?? '',
              isMultiSelect: q.is_multi_select === true,
              allowCustomAnswer: true,
              options: (q.options ?? []).map((o: any, j: number) => ({ id: nonBlank(o.id) ?? String(j + 1), label: o.text ?? '' })),
            })),
          };
        }
        command = title;
        const answerOf = (q: any) => {
          const sel: string[] = q.selected_option_ids ?? [];
          const matched = (q.options ?? []).filter((o: any) => sel.includes(o.id) || sel.includes(o.text));
          return q.skipped
            ? 'Skipped'
            : matched.length
              ? matched.map((o: any) => o.text).join(', ')
              : nonBlank(q.write_in_response)
                ? `Other: "${q.write_in_response}"`
                : sel.length
                  ? sel.join(', ')
                  : 'Submitted';
        };
        const completed = (step.completed_interactions ?? [])
          .flatMap((c: any) => c.response?.ask_question?.responses ?? [])
          .filter((r: any) => nonBlank(r.question));
        if (completed.length) output = completed.map((r: any) => `• ${r.question}: ${answerOf(r)}`).join('\n\n');
        else if (qs?.length) {
          const answered = qs.filter((q) => (q.selected_option_ids?.length ?? 0) > 0 || nonBlank(q.write_in_response) || q.skipped);
          output = answered.length
            ? answered.map((q) => `• ${q.question}: ${answerOf(q)}`).join('\n\n')
            : qs.map((q) => `${q.question}\n${(q.options ?? []).map((o: any) => `• ${o.text}`).join('\n')}`).join('\n\n');
        }
        break;
      }
      default:
        command = nonBlank(meta?.tool_action) ?? summary ?? rawName;
        output = fullOutputUri ? `[Output at ${fullOutputUri}]` : '';
    }
    if (!command.trim()) command = nonBlank(meta?.tool_action) ?? summary ?? rawName;

    const responded = this.userRespondedStepIndices.has(stepIndex);
    let status: string;
    switch (step.status) {
      case S.DONE:
        this.userRespondedStepIndices.delete(stepIndex);
        status = 'SUCCESS';
        break;
      case S.ERROR:
        this.userRespondedStepIndices.delete(stepIndex);
        status = 'FAILED';
        break;
      case S.CANCELED: {
        this.userRespondedStepIndices.delete(stepIndex);
        const lo = output.toLowerCase();
        status = lo.includes('rejected')
          ? 'REJECTED'
          : lo.includes('terminated') || lo.includes('stopped')
            ? 'TERMINATED'
            : step.requested_interaction
              ? 'REJECTED'
              : 'TERMINATED';
        break;
      }
      case S.WAITING:
        status = responded ? 'RUNNING' : toolType === 'ASK_CHOICE' ? 'AWAITING_CHOICE' : 'PENDING_APPROVAL';
        break;
      case S.RUNNING:
      case S.PENDING:
      case S.GENERATING:
      case S.QUEUED:
        status = toolType === 'ASK_CHOICE' && !responded ? 'AWAITING_CHOICE' : 'RUNNING';
        break;
      default:
        status =
          step.requested_interaction || toolType === 'ASK_CHOICE'
            ? responded
              ? 'RUNNING'
              : toolType === 'ASK_CHOICE'
                ? 'AWAITING_CHOICE'
                : 'PENDING_APPROVAL'
            : 'RUNNING';
    }

    const startMs = tsMillis(meta?.started_at) ?? tsMillis(meta?.created_at);
    const endMs = tsMillis(meta?.completed_at) ?? tsMillis(meta?.finished_generating_at);
    return {
      id: String(stepIndex),
      name: rawName,
      toolType,
      command,
      output,
      status,
      exitCode,
      durationMs: startMs != null && endMs != null && endMs >= startMs ? endMs - startMs : null,
      stepIndex,
      trajectoryId: this.trajectoryId,
      interactionType: interactionTypeOf(step),
      questionnaire,
    };
  }

  private userTurnOf(step: Step, stepIndex: number): UserTurn {
    const input = step.user_input;
    const raw = nonBlank(input?.user_response) ?? nonBlank(input?.query) ?? (input?.items ?? []).map((i: any) => nonBlank(i.text)).filter(Boolean).join('\n');
    const shown = displayUserText(raw, `att_${stepIndex}`);
    const voice = parseVoiceTurn(raw, input?.tags ?? []);
    if (voice) {
      return {
        kind: 'user',
        stepIndex,
        text: voice.spoken || voice.voiceLine || 'Voice request',
        rawText: raw,
        attachments: this.userAttachments(input, stepIndex).filter((a) => !a.isAudio),
        createdAt: tsMillis(step.metadata?.created_at) || null,
      };
    }
    return {
      kind: 'user',
      stepIndex,
      text: shown.text,
      rawText: raw,
      attachments: [...this.userAttachments(input, stepIndex), ...shown.cards],
      createdAt: tsMillis(step.metadata?.created_at) || null,
    };
  }

  private userAttachments(input: any, stepIndex: number): ChatAttachment[] {
    if (!input) return [];
    const list: ChatAttachment[] = [];
    (input.media ?? []).forEach((m: any, idx: number) => {
      const mime: string = m.mime_type ?? '';
      const uri = stripFile(m.uri ?? '');
      const b64: string = m.inline_data ?? '';
      if (!mime && !uri && !b64) return;
      const isAud = mime.startsWith('audio/') || /\.(m4a|mp3|wav|ogg)$/i.test(uri);
      const isImg = mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(uri);
      const dur = Math.floor(Number(m.duration_seconds ?? 0));
      const name =
        nonBlank(m.display_name) && !m.display_name.startsWith('attachment_')
          ? m.display_name
          : (nonBlank(m.description) ??
            (isAud ? (dur > 0 ? `Voice Note (${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')})` : 'Voice Note') : isImg ? 'Image' : `attachment_${idx}`));
      list.push({
        id: `att_${stepIndex}_${idx}`,
        name,
        path: uri,
        isImage: isImg,
        isAudio: isAud,
        size: 0,
        durationSeconds: dur,
        mimeType: mime || (isAud ? 'audio/mp4' : isImg ? 'image/jpeg' : ''),
        base64: b64 || null,
      });
    });
    (input.images ?? []).forEach((img: any, idx: number) => {
      const uri = stripFile(img.uri ?? '');
      const b64: string = img.base64_data ?? '';
      if (!uri && !b64) return;
      list.push({
        id: `att_${stepIndex}_img_${idx}`,
        name: nonBlank(img.caption) ?? 'Image',
        path: uri,
        isImage: true,
        isAudio: false,
        size: 0,
        mimeType: nonBlank(img.mime_type) ?? 'image/jpeg',
        base64: b64 || null,
      });
    });
    return list;
  }
}
