// Shared chat model: a TypeScript mirror of the Android app's domain/model/Models.kt.
// Every agent backend (agy, Claude, Codex, OpenCode) produces these shapes; the webview only renders them.
// `ChatMessage.content` uses the same inline markers as the app (parsed by the app's MarkdownContent.kt):
//   <!-- thought[:streaming] -->…<!-- /thought -->, <!-- tool_call:ID -->, <!-- error -->{json}<!-- /error -->

export type AgentKind = 'AGY' | 'CLAUDE' | 'OPENCODE' | 'CODEX';

export type MessageRole = 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM' | 'SUMMARY';

export type ToolType =
  | 'BASH'
  | 'VIEW_FILE'
  | 'EDIT_FILE'
  | 'LIST_DIR'
  | 'GREP_SEARCH'
  | 'FIND'
  | 'SEARCH_WEB'
  | 'READ_URL'
  | 'GENERATE_IMAGE'
  | 'MCP'
  | 'ASK_CHOICE'
  | 'MATH'
  | 'SYSTEM_NOTIFICATION'
  | 'UNKNOWN';

export type ToolStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'TERMINATED' | string;

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string | null;
  icon?: string | null;
  isCustomInput?: boolean;
  nestedQuestions?: ChoiceQuestion[];
}

export interface ChoiceQuestion {
  id: string;
  prompt: string;
  description?: string | null;
  isMultiSelect: boolean;
  options: ChoiceOption[];
  allowCustomAnswer: boolean;
}

export interface ChoiceQuestionnaire {
  title: string;
  description?: string | null;
  questions: ChoiceQuestion[];
  allowCustomNote: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  toolType: ToolType;
  command: string;
  status: ToolStatus;
  output: string;
  exitCode?: number | null;
  durationMs?: number | null;
  stepIndex?: number | null;
  trajectoryId?: string | null;
  interactionType?: string | null;
  questionnaire?: ChoiceQuestionnaire | null;
}

export interface TokenUsage {
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  durationMs: number;
  isEstimated: boolean;
  costUsd?: number | null;
  model?: string | null;
}

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  isImage: boolean;
  isAudio: boolean;
  localUri?: string | null;
  size: number;
  url?: string | null;
  durationSeconds?: number;
  mimeType?: string | null;
  /** Base64 data (no data: prefix). Images the webview may show inline. */
  base64?: string | null;
  /** Opened in place by the agent (real path); never uploaded. */
  reference?: boolean;
  /** What the chip is: a file / folder by path, an image, or a selection from the editor. */
  kind?: 'file' | 'folder' | 'image' | 'selection' | null;
  /** Selection chips: 1-based line range and the selected text (sent to the agent with the message). */
  lineStart?: number | null;
  lineEnd?: number | null;
  selectionText?: string | null;
  languageId?: string | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  thoughtText?: string | null;
  thoughtDurationMs?: number | null;
  toolCalls: ToolCall[];
  isStreaming: boolean;
  tokenUsage?: TokenUsage | null;
  rawContent?: string | null;
  contextSummary?: string | null;
  stepIndex?: number | null;
  attachments: ChatAttachment[];
  createdAt: number;
  modelId?: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  modelId: string;
  createdAt: number;
  updatedAt: number;
  isRunning: boolean;
  notFullyIdle: boolean;
  hasActivity: boolean;
  runStatus: string;
  stepCount: number;
  workspaceUri: string;
  parentConversationId?: string | null;
  subagentRole?: string | null;
  subagentTypeName?: string | null;
  nestingDepth: number;
  agent: AgentKind;
  archived: boolean;
  cloudProjectId?: string | null;
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachmentCount: number;
  canSendNow: boolean;
  canDelete: boolean;
  isPending: boolean;
}

export type ModelFamily = 'CLAUDE' | 'GEMINI' | 'OTHER';

export interface AiModel {
  id: string;
  /** The agent's own key for the model ("gemini-4-argon-medium"), when it differs from id. */
  key?: string | null;
  displayName: string;
  family: ModelFamily;
  description: string;
  isDefault: boolean;
  baseName: string;
  tier?: string | null;
  /** 0..1 share of quota left, when the agent reports it. */
  quotaRemaining?: number | null;
  quotaText?: string | null;
  /** Grouping label in the model picker (e.g. quota group). */
  group?: string | null;
}

export interface ArtifactSnapshot {
  name: string;
  absoluteUri: string;
  lastEdited: string;
  summary: string;
  requestFeedback: boolean;
  userFacing: boolean;
}
