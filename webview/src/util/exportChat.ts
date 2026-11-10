// Chat export as Markdown / standalone HTML: a port of the Android app's
// ui/components/ConversationExportHelper.kt (generateMarkdown, generateHtml, file name).
// Only builds the text; saving / opening the file is up to the caller.

import type { ChatMessage, Conversation, ToolCall } from '@shared/model';

/** Markdown export (ExportFormat.MARKDOWN). */
export function exportMarkdown(conversation: Conversation | null, messages: ChatMessage[]): { suggestedName: string; content: string } {
  const now = new Date();
  const { title, conversationId } = meta(conversation, messages);
  return { suggestedName: exportFileName(title, now, 'md'), content: generateMarkdown(title, conversationId, messages, now) };
}

/** Standalone HTML export (ExportFormat.HTML). */
export function exportHtml(conversation: Conversation | null, messages: ChatMessage[]): { suggestedName: string; content: string } {
  const now = new Date();
  const { title, conversationId } = meta(conversation, messages);
  return { suggestedName: exportFileName(title, now, 'html'), content: generateHtml(title, conversationId, messages, now) };
}

function meta(conversation: Conversation | null, messages: ChatMessage[]): { title: string; conversationId: string } {
  return {
    title: conversation?.title ?? '',
    conversationId: conversation?.id ?? messages[0]?.conversationId ?? '',
  };
}

/** "${sanitizedTitle}_${yyyyMMdd_HHmmss}.${ext}", as in exportConversation(). */
function exportFileName(title: string, now: Date, ext: string): string {
  // `u` flag: Java's regex replaces a surrogate pair (emoji) with one "_", not two.
  const sanitized = ifBlank(title.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 40), 'conversation');
  const stamp = `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${sanitized}_${stamp}.${ext}`;
}

/** SimpleDateFormat("yyyy-MM-dd HH:mm:ss"), local time. */
function exportDate(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

// Kotlin's Char.isWhitespace (Character.isWhitespace || isSpaceChar), used by trim()/isBlank().
// Differs from JS trim(): includes U+001C..U+001F, excludes U+FEFF.
function isKtWhitespace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    (c >= 0x1c && c <= 0x20) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

function ktTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isKtWhitespace(s.charCodeAt(start))) start++;
  while (end > start && isKtWhitespace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

function isBlank(s: string | null | undefined): boolean {
  if (!s) return true;
  for (let i = 0; i < s.length; i++) if (!isKtWhitespace(s.charCodeAt(i))) return false;
  return true;
}

const ifBlank = (s: string, fallback: string) => (isBlank(s) ? fallback : s);

function generateMarkdown(title: string, conversationId: string, messages: ChatMessage[], now: Date): string {
  let sb = '';
  const dateStr = exportDate(now);

  sb += '# ' + ifBlank(title, 'Antigravity Chat') + '\n\n';
  sb += '> **Exported on:** ' + dateStr + '\n';
  sb += '> **Conversation ID:** `' + conversationId + '`\n\n';
  sb += '---\n\n';

  for (const msg of messages) {
    const content = msg.content ?? '';
    switch (msg.role) {
      case 'USER': {
        sb += '### 👤 User\n\n';
        const attachments = msg.attachments ?? [];
        if (attachments.length > 0) {
          sb += '**Attachments:**\n';
          for (const att of attachments) sb += '- 📎 ' + att.name + '\n';
          sb += '\n';
        }
        sb += ktTrim(content) + '\n\n';
        sb += '---\n\n';
        break;
      }
      case 'ASSISTANT': {
        sb += '### 🤖 Assistant\n\n';

        // Thinking
        if (!isBlank(msg.thoughtText)) {
          sb += '<details><summary>💭 <i>Thinking Process</i></summary>\n\n';
          sb += ktTrim(msg.thoughtText ?? '') + '\n\n';
          sb += '</details>\n\n';
        }

        // Tools
        for (const tc of msg.toolCalls ?? []) {
          const statusBadge = tc.exitCode != null ? ` (exit ${tc.exitCode})` : '';
          sb += `<details><summary>🔧 <b>${tc.name ?? ''}</b>: <code>${escapeMdInline(tc.command ?? '')}</code>${statusBadge}</summary>\n\n`;
          if (!isBlank(tc.output)) {
            sb += '```\n' + ktTrim(tc.output) + '\n```\n\n';
          }
          sb += '</details>\n\n';
        }

        // Content
        if (!isBlank(content)) {
          sb += ktTrim(content) + '\n\n';
        }
        sb += '---\n\n';
        break;
      }
      case 'SYSTEM':
        sb += '> ⚙️ **System:** ' + ktTrim(content) + '\n\n---\n\n';
        break;
      default:
        if (!isBlank(content)) {
          sb += ktTrim(content) + '\n\n---\n\n';
        }
    }
  }
  return sb;
}

function generateHtml(title: string, conversationId: string, messages: ChatMessage[], now: Date): string {
  const dateStr = exportDate(now);
  const htmlTitle = escapeHtml(ifBlank(title, 'Antigravity Chat'));

  let sb = '';
  sb += '<!DOCTYPE html>\n';
  sb += '<html lang="en">\n<head>\n';
  sb += '  <meta charset="UTF-8">\n';
  sb += '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
  sb += '  <title>' + htmlTitle + '</title>\n';
  sb += '  <style>\n';
  // Inline CSS + header, verbatim from the Kotlin raw string (starts with a newline).
  sb += `
    :root {
      --bg: #0B0C10;
      --card-bg: #141721;
      --card-border: #232738;
      --user-bg: #1C2030;
      --user-border: #333952;
      --accent-terracotta: #CC785C;
      --accent-blue: #8AB4F8;
      --text-main: #E2E8F0;
      --text-muted: #94A3B8;
      --tool-bg: #0E1017;
      --code-bg: #08090C;
      --badge-green: #10B981;
      --badge-red: #EF4444;
      --badge-amber: #F59E0B;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      padding: 24px 16px 64px 16px;
    }
    .container {
      max-width: 860px;
      margin: 0 auto;
    }
    header {
      padding-bottom: 20px;
      margin-bottom: 28px;
      border-bottom: 1px solid var(--card-border);
    }
    h1 {
      font-size: 1.65rem;
      font-weight: 700;
      color: #FFFFFF;
      margin-bottom: 8px;
    }
    .meta-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .meta-tag {
      background: var(--card-bg);
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid var(--card-border);
      font-family: monospace;
    }
    .chat-flow {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .turn {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .turn-user {
      align-items: flex-end;
    }
    .turn-assistant {
      align-items: flex-start;
    }
    .bubble-user {
      background: var(--user-bg);
      border: 1px solid var(--user-border);
      border-radius: 16px 16px 4px 16px;
      padding: 14px 18px;
      max-width: 85%;
      color: #FFFFFF;
      font-size: 0.95rem;
      white-space: pre-wrap;
      word-break: break-word;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
    }
    .bubble-assistant {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px 16px 16px 4px;
      padding: 18px 20px;
      width: 100%;
      font-size: 0.95rem;
      box-shadow: 0 4px 14px rgba(0,0,0,0.25);
    }
    .role-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .role-badge.user-badge { color: var(--accent-terracotta); }
    .role-badge.assistant-badge { color: var(--accent-blue); }

    /* Thinking Process Accordion */
    details.thinking-box {
      background: rgba(138, 180, 248, 0.05);
      border: 1px solid rgba(138, 180, 248, 0.18);
      border-radius: 10px;
      padding: 10px 14px;
      margin: 10px 0;
      font-size: 0.88rem;
      color: #CBD5E1;
    }
    details.thinking-box summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--accent-blue);
      user-select: none;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .thinking-content {
      margin-top: 10px;
      white-space: pre-wrap;
      font-family: monospace;
      font-size: 0.82rem;
      line-height: 1.5;
      color: #94A3B8;
      border-top: 1px dashed rgba(138, 180, 248, 0.15);
      padding-top: 8px;
    }

    /* Tool Call Card */
    details.tool-card {
      background: var(--tool-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 8px 14px;
      margin: 10px 0;
      font-size: 0.88rem;
    }
    details.tool-card summary {
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      user-select: none;
    }
    .tool-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: monospace;
    }
    .tool-name {
      font-weight: 700;
      color: #FFFFFF;
    }
    .tool-cmd {
      color: var(--text-muted);
      font-size: 0.82rem;
      max-width: 480px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tool-badge {
      font-size: 0.72rem;
      font-weight: bold;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
    }
    .badge-success { background: rgba(16,185,129,0.15); color: var(--badge-green); }
    .badge-failed { background: rgba(239,68,68,0.15); color: var(--badge-red); }
    .tool-output {
      margin-top: 10px;
      background: var(--code-bg);
      border-radius: 6px;
      padding: 10px 12px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
      font-size: 0.82rem;
      white-space: pre-wrap;
      word-break: break-all;
      color: #A7F3D0;
      max-height: 380px;
      overflow-y: auto;
      border: 1px solid rgba(255,255,255,0.05);
    }

    /* Markdown styling inside content */
    .rendered-content p { margin: 10px 0; }
    .rendered-content h1, .rendered-content h2, .rendered-content h3 { margin: 16px 0 8px 0; color: #FFFFFF; }
    .rendered-content ul, .rendered-content ol { margin: 8px 0 8px 24px; }
    .rendered-content li { margin: 4px 0; }
    .rendered-content pre {
      background: var(--code-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px 14px;
      overflow-x: auto;
      margin: 12px 0;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 0.85rem;
      color: #F8FAFC;
    }
    .rendered-content code:not(pre code) {
      background: rgba(255,255,255,0.08);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.88em;
      color: #FCA5A5;
    }
    .rendered-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 14px 0;
      font-size: 0.88rem;
    }
    .rendered-content th, .rendered-content td {
      border: 1px solid var(--card-border);
      padding: 8px 12px;
      text-align: left;
    }
    .rendered-content th { background: rgba(255,255,255,0.04); font-weight: 600; color: #FFFFFF; }
    .rendered-content blockquote {
      border-left: 3px solid var(--accent-blue);
      padding-left: 12px;
      margin: 10px 0;
      color: var(--text-muted);
    }
    .attachment-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(204, 120, 92, 0.15);
      border: 1px solid rgba(204, 120, 92, 0.3);
      padding: 4px 10px;
      border-radius: 8px;
      font-size: 0.82rem;
      margin-bottom: 8px;
      color: #FFD4C4;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${htmlTitle}</h1>
      <div class="meta-bar">
        <span>📅 Exported: <b>${dateStr}</b></span>
        <span class="meta-tag">ID: ${escapeHtml(conversationId)}</span>
      </div>
    </header>

    <div class="chat-flow">
`;

  for (const msg of messages) {
    const content = msg.content ?? '';
    switch (msg.role) {
      case 'USER':
        sb += '      <div class="turn turn-user">\n';
        sb += '        <div class="role-badge user-badge">👤 User</div>\n';
        sb += '        <div class="bubble-user">\n';
        for (const att of msg.attachments ?? []) {
          sb += '          <div class="attachment-pill">📎 ' + escapeHtml(att.name) + '</div>\n';
        }
        sb += '          ' + escapeHtml(ktTrim(content)) + '\n';
        sb += '        </div>\n';
        sb += '      </div>\n';
        break;
      case 'ASSISTANT':
        sb += '      <div class="turn turn-assistant">\n';
        sb += '        <div class="role-badge assistant-badge">🤖 Assistant</div>\n';
        sb += '        <div class="bubble-assistant">\n';

        // Thinking
        if (!isBlank(msg.thoughtText)) {
          sb += '          <details class="thinking-box">\n';
          sb += '            <summary>💭 Model Thinking</summary>\n';
          sb += '            <div class="thinking-content">' + escapeHtml(ktTrim(msg.thoughtText ?? '')) + '</div>\n';
          sb += '          </details>\n';
        }

        // Tools
        for (const tc of msg.toolCalls ?? []) sb += renderHtmlToolCall(tc);

        // Content
        if (!isBlank(content)) {
          sb += '          <div class="rendered-content">' + simpleMarkdownToHtml(ktTrim(content)) + '</div>\n';
        }

        sb += '        </div>\n';
        sb += '      </div>\n';
        break;
      case 'SYSTEM':
        sb += '      <div class="turn">\n';
        sb += '        <div class="role-badge">⚙️ System</div>\n';
        sb += '        <div class="bubble-assistant" style="border-left: 3px solid #F59E0B;">\n';
        sb += '          <div class="rendered-content">' + escapeHtml(ktTrim(content)) + '</div>\n';
        sb += '        </div>\n';
        sb += '      </div>\n';
        break;
      default:
        if (!isBlank(content)) {
          sb += '      <div class="turn">\n';
          sb += '        <div class="bubble-assistant">\n';
          sb += '          <div class="rendered-content">' + escapeHtml(ktTrim(content)) + '</div>\n';
          sb += '        </div>\n';
          sb += '      </div>\n';
        }
    }
  }

  sb += '    </div>\n';
  sb += '  </div>\n';
  sb += '</body>\n';
  sb += '</html>\n';
  return sb;
}

function renderHtmlToolCall(tc: ToolCall): string {
  const status = tc.status ?? '';
  const isSuccess = tc.exitCode === 0 || (tc.exitCode == null && status === 'SUCCESS');
  const badgeClass = isSuccess ? 'badge-success' : 'badge-failed';
  const badgeText = tc.exitCode != null ? `exit ${tc.exitCode}` : ifBlank(status, 'DONE');

  let sb = '';
  sb += '          <details class="tool-card">\n';
  sb += '            <summary>\n';
  sb += '              <div class="tool-header-left">\n';
  sb += '                <span>🔧</span>\n';
  sb += '                <span class="tool-name">' + escapeHtml(tc.name ?? '') + '</span>\n';
  sb += '                <span class="tool-cmd">' + escapeHtml(tc.command ?? '') + '</span>\n';
  sb += '              </div>\n';
  sb += '              <span class="tool-badge ' + badgeClass + '">' + escapeHtml(badgeText) + '</span>\n';
  sb += '            </summary>\n';
  if (!isBlank(tc.output)) {
    sb += '            <pre class="tool-output">' + escapeHtml(ktTrim(tc.output)) + '</pre>\n';
  }
  sb += '          </details>\n';
  return sb;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeMdInline(text: string): string {
  return text.replaceAll('`', '\\`').replaceAll('\n', ' ');
}

/** The Kotlin's regex-based mini markdown renderer, same rules in the same order. */
function simpleMarkdownToHtml(text: string): string {
  let out = escapeHtml(text);

  // Triple backtick code blocks
  out = out.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => `<pre><code class="language-${lang}">${code}</code></pre>`);

  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  out = out.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
  out = out.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
  out = out.replace(/^# (.*?)$/gm, '<h1>$1</h1>');

  // Bold & Italic
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/\*([^*]+)\*/g, '<i>$1</i>');

  // Lists
  out = out.replace(/^[-*] (.*?)$/gm, '<li>$1</li>');

  // Line breaks (except inside pre)
  return out
    .split(/<pre>|<\/pre>/)
    .map((part, i) => (i % 2 === 0 ? part.replaceAll('\n', '<br>\n') : '<pre>' + part + '</pre>'))
    .join('');
}
