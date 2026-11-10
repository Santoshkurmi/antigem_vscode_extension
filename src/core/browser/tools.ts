// browser_mcp tool definitions: the app's BrowserMcp.kt tools (names, schemas, descriptions), worded for Chrome on a
// PC (the AntiGem tab group instead of the in-app browser's tabs; clicks instead of touches).
import type { McpTool } from '../mcp/server';

export const INSTRUCTIONS =
  "Controls the user's Chrome (through the AntiGem browser extension) like a person would, in the tabs of the \"AntiGem\" tab group. Look, then act: " +
  'open a page with browser_open_url, then get element refs (like ref_12) from browser_find (one element by description) or ' +
  'browser_read_page (the page\'s structure), and act on refs with browser_computer (left_click, type, key, hover, scroll_to) ' +
  'or browser_form_input (fill fields, pick options, tick boxes). Take a screenshot (browser_computer action=screenshot) when ' +
  'you need to see the page; coordinates you pass are pixels in the latest screenshot of that tab. Read articles with ' +
  'browser_get_page_text. Put steps you can predict into one browser_batch call (e.g. click a field, type, press Enter, ' +
  'screenshot). Check results: actions report page changes and new tabs; read the page again or take a screenshot when ' +
  'unsure. Refs stay valid until the page changes. Never click file inputs: use browser_upload_file with the ref. ' +
  "For a task of several steps, call browser_lock once first (the user's mouse and keyboard stay out of your way on " +
  'every tab you use or open) and browser_lock with locked=false when you finish (it releases all of them). If the page changes in ways you did not cause, ' +
  'the user may have unlocked it: check browser_list_tabs (lockedByAgent), read the page again and lock it again. ' +
  'If a page opens an alert/confirm/prompt, ' +
  'answer it with browser_handle_dialog. Pass action_summary (a few words) on actions so the user can follow what you do. ' +
  'Omit tab_id to use the current AntiGem tab; browser_list_tabs lists them. You only see and use AntiGem tabs: other tabs need ' +
  "the user's OK, and sites on the user's blocklist (banking, payments, password managers) are never opened or controlled.";

const prop = (type: string | string[], description: string, enumValues?: string[]) => ({ type, description, ...(enumValues ? { enum: enumValues } : {}) });
const numberPair = (description: string, size = 2) => ({ type: 'array', description, items: { type: 'number' }, minItems: size, maxItems: size });
const tool = (name: string, description: string, required: string[], props: Record<string, unknown>): McpTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: props, ...(required.length ? { required } : {}) },
});

const tabId = { tab_id: prop('string', 'Tab id from browser_list_tabs; omit for the current AntiGem tab') };
const summary = {
  action_summary: prop(
    'string',
    'Optional: 2-5 words saying what you are doing, shown next to the cursor so the user can ' +
      'follow along, e.g. "Opening Filters menu", "Searching for shoes". Never include passwords or other secrets.',
  ),
};

/** Older tool names kept callable for existing prompts and scripts, but not listed. */
export const HIDDEN_TOOLS = new Set(['browser_screenshot', 'browser_inspect_dom', 'browser_interact']);

export const TOOLS: McpTool[] = [
  tool(
    'browser_list_tabs',
    'List the AntiGem tabs (the "AntiGem" tab group in Chrome): id, URL, title, which is current, loading state and view mode.',
    [],
    {},
  ),
  tool(
    'browser_open_url',
    'Open a URL in Chrome and wait for it to load (up to 10 s), or move in a tab\'s history. Opens in the current ' +
      'AntiGem tab unless new_tab=true or tab_id is given (new tabs join the AntiGem tab group). Returns the tab id, final URL and title.',
    ['url'],
    {
      url: prop('string', 'URL (https://…, localhost:5173, or words to search), or "back", "forward" or "reload"'),
      ...tabId,
      new_tab: prop('boolean', 'Open in a new tab (default false)'),
      mode: prop('string', 'View mode for the tab: mobile (phone-sized, mobile user agent) or desktop', ['mobile', 'desktop']),
      desktop_mode: prop('boolean', 'Same as mode=desktop when true, mode=mobile when false'),
      ...summary,
    },
  ),
  tool('browser_switch_tab', 'Show this tab in the browser (make it the active tab of its window).', ['tab_id'], { tab_id: prop('string', 'Tab to activate') }),
  tool('browser_close_tab', 'Close a tab.', ['tab_id'], { tab_id: prop('string', 'Tab to close') }),
  tool('browser_set_view_mode', 'Switch a tab between mobile and desktop view (mobile user agent and phone-sized layout, or the normal desktop one). Reloads the page.', [], {
    ...tabId,
    mode: prop('string', 'mobile or desktop; omit both to toggle', ['mobile', 'desktop']),
    desktop_mode: prop('boolean', 'true for desktop, false for mobile'),
  }),
  tool(
    'browser_read_page',
    'Read the page as an indented tree of its elements: role, name, state and value, each with a ref (e.g. ref_12) that ' +
      'browser_computer, browser_form_input and browser_upload_file accept. Short text blocks appear as one line. ' +
      'filter="interactive" lists only what you can click or type into (much smaller). Controls outside the visible ' +
      'area are marked (off-screen); acting on a ref scrolls to it. Refs stay the same for an element until the page changes. ' +
      'Output is cut at max_chars; use ref_id to read one part of a big page.',
    [],
    {
      ...tabId,
      filter: prop('string', 'all (default) or interactive', ['all', 'interactive']),
      depth: prop('integer', 'Maximum tree depth (default 25)'),
      ref_id: prop('string', 'Read only this element and what is inside it'),
      max_chars: prop('integer', 'Maximum characters returned (default 50000)'),
    },
  ),
  tool(
    'browser_find',
    'Find elements by what they are or what they say, e.g. "search box", "Add to cart button", "price of the blue shirt", ' +
      '"email field". Returns up to 20 matches, best first, each with a ref to act on. Cheaper than reading the whole page.',
    ['query'],
    { ...tabId, query: prop('string', 'What to look for, in plain words') },
  ),
  tool(
    'browser_get_page_text',
    "Read the page's main text as plain text (the article or main content when the page has one): articles, docs, " +
      'search results, messages. Has no refs; use browser_find or browser_read_page to act on things. Says when part of the ' +
      'text is hidden (collapsed sections, tabs); include_hidden=true reads that too.',
    [],
    {
      ...tabId,
      max_chars: prop('integer', 'Maximum characters returned (default 50000)'),
      include_hidden: prop('boolean', 'Also read hidden text: collapsed sections, inactive tabs, closed menus (default false)'),
    },
  ),
  tool(
    'browser_computer',
    'Use the mouse and keyboard on a tab, and take screenshots. Input is real (trusted) input, like a person\'s. Target ' +
      'elements by ref (from browser_find / browser_read_page; preferred, it scrolls the element into view) or by coordinate: ' +
      '[x, y] pixels in the latest screenshot of this tab (take one first). Click the centre of elements. Each action reports ' +
      'what it hit and whether the page navigated or opened a tab.\n' +
      'Actions:\n' +
      '* screenshot: see the visible part of the page (sets the coordinate frame for this tab)\n' +
      '* left_click / double_click / triple_click / right_click: click ref or coordinate (modifiers like "ctrl" or "shift" optional)\n' +
      '* hover: move the mouse over ref or coordinate (menus, tooltips)\n' +
      '* left_click_drag: drag from start_coordinate to coordinate\n' +
      '* type: type text into the focused text field (click it first; nothing is typed and you get an error if no text field has focus); \\n presses Enter\n' +
      '* key: press keys, space-separated: "Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ctrl+a", "shift+Tab"; repeat for many presses\n' +
      '* scroll: scroll_direction up/down/left/right by scroll_amount wheel ticks (default 3) at coordinate (default: page centre); returns a screenshot\n' +
      '* scroll_to: scroll ref into view\n' +
      "* zoom: closer look at region [x0, y0, x1, y1] of the latest screenshot (coordinates stay in the full screenshot's frame)\n" +
      '* wait: wait duration seconds (max 10) for the page to change',
    ['action'],
    {
      ...tabId,
      action: prop('string', 'What to do', ['screenshot', 'left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'left_click_drag', 'type', 'key', 'scroll', 'scroll_to', 'zoom', 'wait']),
      ref: prop('string', 'Element ref, e.g. ref_12 (clicks, hover, scroll_to)'),
      coordinate: numberPair('[x, y] in pixels of the latest screenshot (clicks, hover, scroll; drag end point)'),
      start_coordinate: numberPair('[x, y] where left_click_drag starts'),
      text: prop('string', 'Text to type (type), or keys to press (key)'),
      modifiers: prop('string', 'Keys held during a click: ctrl, shift, alt, meta; combine with + (e.g. "ctrl+shift")'),
      repeat: prop('integer', 'key: press the sequence this many times (1-100, default 1)'),
      scroll_direction: prop('string', 'scroll direction', ['up', 'down', 'left', 'right']),
      scroll_amount: prop('integer', 'scroll: wheel ticks, 1-10 (default 3)'),
      region: numberPair('zoom: [x0, y0, x1, y1] rectangle in pixels of the latest screenshot', 4),
      duration: prop('number', 'wait: seconds, up to 10'),
      scale: prop('number', 'screenshot/zoom: 0.1-1 to get a smaller image (fewer tokens); coordinates still use the full-size frame'),
      ...summary,
    },
  ),
  tool(
    'browser_form_input',
    'Set a form field by ref, the way frameworks like React expect: text, number, date and time fields and textareas ' +
      '(value replaces the content), <select> dropdowns (option text or value; a list for multi-selects), checkboxes and ' +
      'switches (true/false; never clicks twice), radio buttons (true), and contenteditable editors. For custom dropdowns, ' +
      'click them with browser_computer instead.',
    ['ref', 'value'],
    {
      ...tabId,
      ref: prop('string', 'Field ref from browser_find / browser_read_page'),
      value: { description: 'New value: string, number, boolean, or a list of options for a multi-select', type: ['string', 'number', 'boolean', 'array'] },
      ...summary,
    },
  ),
  tool(
    'browser_eval_js',
    'Run JavaScript in the page and get the value of the last expression (top-level await works; values come back as JSON). ' +
      'For reading data or debugging; prefer browser_computer and browser_form_input for acting, which behave like a real user.',
    ['script'],
    { ...tabId, script: prop('string', "JavaScript to run, e.g. document.querySelectorAll('li').length or await fetch('/api').then(r => r.json())") },
  ),
  tool('browser_get_console_logs', "Read the tab's console messages (console.log/warn/error and uncaught errors), oldest first. Use pattern to filter.", [], {
    ...tabId,
    pattern: prop('string', 'Regular expression (case-insensitive) the message must match'),
    only_errors: prop('boolean', 'Only errors'),
    level: prop('string', 'Only this level', ['ALL', 'ERROR', 'WARN', 'LOG', 'INFO', 'DEBUG']),
    limit: prop('integer', 'Return the newest N messages, listed oldest first (default 100, max 300)'),
    clear: prop('boolean', 'Clear the messages after reading, so the next read shows only new ones'),
  }),
  tool(
    'browser_read_network',
    "List the tab's network requests (documents, XHR/fetch, scripts, images…) with method, status, type, size and time. " +
      'Recording starts the first time the browser MCP uses the tab, so reload the page to see its initial requests.',
    [],
    {
      ...tabId,
      url_pattern: prop('string', 'Only URLs containing this text (e.g. /api/)'),
      only_failed: prop('boolean', 'Only failed requests and HTTP errors (status >= 400)'),
      limit: prop('integer', 'Return the newest N requests, listed oldest first (default 100, max 500)'),
      clear: prop('boolean', 'Clear the list after reading'),
    },
  ),
  tool(
    'browser_upload_file',
    'Upload local files to the page like a person picking them in a file dialog: give the ref of the upload button, its label ' +
      'or the file input (hidden inputs work), or omit it when the page has a single file input. The site\'s own file chooser ' +
      'receives the files; no picker is shown. For drag-and-drop-only areas it falls back to dropping the files (up to 25 MiB). ' +
      'Check the page afterwards to confirm the site accepted them.',
    ['file_paths'],
    {
      ...tabId,
      file_paths: { type: 'array', items: { type: 'string' }, description: '1-20 local files: absolute, ~/... or relative to the workspace folder' },
      ref: prop('string', 'Ref of the upload button, its label or the file input'),
      selector: prop('string', 'Instead of ref: CSS selector of the upload element'),
      method: prop('string', 'auto (default): file chooser, else in-page fallback; chooser: only the real file chooser; drop: only build the files in the page', ['auto', 'chooser', 'drop']),
      timeout_seconds: prop('integer', 'How long to wait for the page to open its file chooser (1-30, default 10)'),
      ...summary,
    },
  ),
  tool(
    'browser_lock',
    'Take or give back control of the browser for your task. locked=true (default) turns on the agent lock: the tab (tab_id, ' +
      'or the current tab) is locked now, and so is every tab you use or open while it is on (new tabs, popups from clicks). ' +
      "On locked tabs the user's mouse and keyboard are kept off the page, so pages behave consistently; the user " +
      'sees an Unlock button and can take over a tab at any time. There is no timeout. locked=false without tab_id turns the ' +
      'lock off and releases every locked tab: do this when your task is done. locked=false with tab_id releases only that tab. ' +
      'Recommended for any task of several steps.',
    [],
    {
      tab_id: prop('string', 'Lock: the tab to lock now (default: the current tab). Unlock: release only this tab (default: all)'),
      locked: prop('boolean', 'true to lock (default), false to unlock'),
      ...summary,
    },
  ),
  tool(
    'browser_handle_dialog',
    'Answer the JavaScript alert, confirm or prompt (or "Leave this page?") a page opened. While one is open the tab is ' +
      'paused, and other tools say so. accept=true presses OK (or Leave), accept=false presses Cancel (or Stay). browser_list_tabs ' +
      'shows open dialogs.',
    ['accept'],
    {
      tab_id: prop('string', 'Tab with the dialog; omit for the one that has it'),
      accept: prop('boolean', 'true for OK / Leave, false for Cancel / Stay'),
      prompt_text: prop('string', "For a prompt: the text to answer with (default: the page's suggested text)"),
    },
  ),
  tool(
    'browser_batch',
    'Run several browser tool calls in one round trip, in order, stopping at the first error. Use it whenever you can predict ' +
      'two or more steps, e.g. click a field, type, press Enter, then screenshot. Each item is {"name": tool name, "input": ' +
      'that tool\'s arguments}. Coordinates inside a batch refer to the screenshot taken before the batch. Results and images ' +
      'come back in order. Batches cannot be nested.',
    ['actions'],
    {
      actions: {
        type: 'array',
        minItems: 1,
        description: 'Tool calls to run in order',
        items: {
          type: 'object',
          properties: { name: prop('string', 'Tool name, e.g. browser_computer'), input: { type: 'object', description: "The tool's arguments" } },
          required: ['name', 'input'],
        },
      },
    },
  ),
];

/** Claude-in-Chrome names accepted inside browser_batch. */
export const ALIASES: Record<string, string> = {
  computer: 'browser_computer',
  navigate: 'browser_open_url',
  javascript_tool: 'browser_eval_js',
  tabs_context: 'browser_list_tabs',
  tabs_context_mcp: 'browser_list_tabs',
  read_console_messages: 'browser_get_console_logs',
  read_network_requests: 'browser_read_network',
  file_upload: 'browser_upload_file',
};
