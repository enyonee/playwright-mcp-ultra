/**
 * Session context tracker for Playwright MCP.
 * Accumulates action history per backend and provides a
 * compact summary (~100 tokens) via browser_session_context tool.
 *
 * Token savings: ~95% vs full snapshot for "where am I" queries.
 * Survives context compaction - agent can recall what it did.
 */

const { z } = require('playwright-core/lib/zodBundle');

// Per-backend session state
const sessionMap = new WeakMap();

const MAX_HISTORY = 50;
const MAX_ERRORS = 10;

function getSession(backend) {
  if (!sessionMap.has(backend)) {
    sessionMap.set(backend, {
      actions: [],       // { tool, summary, timestamp }
      currentUrl: null,
      currentTitle: null,
      pageType: null,    // form, table, dashboard, login, error, unknown
      errors: [],        // last N errors
      toolCallCount: 0,
      sessionStarted: Date.now(),
    });
  }
  return sessionMap.get(backend);
}

/**
 * Record an action in the session.
 * Called after each tool call in the proxy pipeline.
 */
function recordAction(backend, toolName, args, result) {
  const session = getSession(backend);
  session.toolCallCount++;

  const summary = summarizeAction(toolName, args);
  session.actions.push({
    tool: toolName,
    summary,
    timestamp: Date.now(),
  });

  // Cap history
  if (session.actions.length > MAX_HISTORY)
    session.actions = session.actions.slice(-MAX_HISTORY);

  // Extract page state from result
  if (result && result.content) {
    for (const part of result.content) {
      if (part.type !== 'text' || !part.text) continue;

      // URL из Page section
      const urlMatch = part.text.match(/### Page\n.*?(https?:\/\/\S+|data:\S+)/);
      if (urlMatch) session.currentUrl = urlMatch[1];

      // Title
      const titleMatch = part.text.match(/### Page\n-\s*\[(.*?)\]/);
      if (titleMatch) session.currentTitle = titleMatch[1];

      // Detect page type from snapshot hints
      if (part.text.includes('### Snapshot')) {
        session.pageType = detectPageType(part.text);
      }

      // Track errors
      const errorMatch = part.text.match(/### Error\n([\s\S]*?)(?=\n### |\s*$)/);
      if (errorMatch) {
        session.errors.push({
          tool: toolName,
          error: errorMatch[1].trim().slice(0, 200),
          timestamp: Date.now(),
        });
        if (session.errors.length > MAX_ERRORS)
          session.errors = session.errors.slice(-MAX_ERRORS);
      }
    }
  }
}

function summarizeAction(toolName, args) {
  if (!args) return toolName;

  switch (toolName) {
    case 'browser_navigate':
      return `navigate -> ${shortenUrl(args.url || '')}`;
    case 'browser_click':
      return `click ${args.element || args.ref || ''}`.trim();
    case 'browser_type':
      return `type "${(args.text || '').slice(0, 30)}" in ${args.element || args.ref || ''}`.trim();
    case 'browser_select_option':
      return `select "${args.values || args.value || ''}" in ${args.element || args.ref || ''}`.trim();
    case 'browser_press_key':
      return `press ${args.key || ''}`;
    case 'browser_snapshot':
      return 'snapshot';
    case 'browser_take_screenshot':
      return 'screenshot';
    case 'browser_evaluate':
      return 'evaluate JS';
    case 'browser_wait_for':
      return `wait for ${args.selector || args.text || 'condition'}`;
    case 'browser_navigate_back':
      return 'back';
    case 'browser_batch_execute':
      return `batch (${(args.actions || []).length} actions)`;
    case 'browser_assert':
      return `assert (${(args.assertions || []).length} checks)`;
    default:
      return toolName.replace('browser_', '');
  }
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search.slice(0, 30) : '');
  } catch {
    return url.slice(0, 60);
  }
}

function detectPageType(text) {
  // Простая эвристика по содержимому snapshot
  const snapshot = text.match(/### Snapshot\n([\s\S]*?)(?=\n### |\s*$)/);
  if (!snapshot) return 'unknown';
  const s = snapshot[1].toLowerCase();

  if (s.includes('textbox') && (s.includes('button') || s.includes('submit'))) {
    if (s.includes('password') || s.includes('login') || s.includes('sign in'))
      return 'login';
    return 'form';
  }
  if (s.includes('table') || s.includes('grid') || s.includes('rowgroup'))
    return 'table';
  if (s.includes('navigation') && s.includes('tab'))
    return 'dashboard';
  if (s.includes('alert') || s.includes('error'))
    return 'error';
  return 'page';
}

/**
 * Generate compact session context summary.
 */
function getSessionContext(backend) {
  const session = getSession(backend);

  if (session.toolCallCount === 0) {
    return {
      content: [{ type: 'text', text: 'No actions recorded yet. Navigate to a page first.' }],
      isError: false,
    };
  }

  const elapsed = Math.round((Date.now() - session.sessionStarted) / 1000);
  const recentActions = session.actions.slice(-10);

  const lines = [
    `## Session Context`,
    `URL: ${session.currentUrl || 'unknown'}`,
    `Title: ${session.currentTitle || 'unknown'}`,
    `Page type: ${session.pageType || 'unknown'}`,
    `Actions: ${session.toolCallCount} total, ${elapsed}s elapsed`,
    '',
    '### Recent Actions',
  ];

  for (const action of recentActions) {
    lines.push(`- ${action.summary}`);
  }

  if (session.errors.length > 0) {
    lines.push('', '### Recent Errors');
    for (const err of session.errors.slice(-3)) {
      lines.push(`- [${err.tool}] ${err.error}`);
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: false,
  };
}

const SESSION_CONTEXT_INPUT = z.object({});

const SESSION_CONTEXT_SCHEMA = {
  name: 'browser_session_context',
  title: 'Session Context',
  description: 'Get a compact summary of the current browser session: URL, title, page type, ' +
    'recent actions, and errors (~100 tokens). Use instead of snapshot to recall what you did ' +
    'after context compaction or to decide next steps without a full page load.',
  type: 'readOnly',
  inputSchema: SESSION_CONTEXT_INPUT,
};

function sessionContextMcpSchema() {
  const { z } = require('playwright-core/lib/zodBundle');
  return {
    name: SESSION_CONTEXT_SCHEMA.name,
    description: SESSION_CONTEXT_SCHEMA.description,
    inputSchema: z.toJSONSchema(SESSION_CONTEXT_INPUT),
    annotations: {
      title: SESSION_CONTEXT_SCHEMA.title,
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  };
}

module.exports = {
  recordAction,
  getSessionContext,
  sessionContextMcpSchema,
  SESSION_CONTEXT_SCHEMA,
};
