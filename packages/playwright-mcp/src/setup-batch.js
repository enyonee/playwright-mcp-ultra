/**
 * Patches playwright-core to add custom enhancements.
 * Performance-optimized: unified arg extraction, early-exit pipeline,
 * lazy session recording, batch fast path.
 *
 * Must be required before any MCP server creation (cli.js, index.js).
 */

const { createRequire } = require('module');
const mcpBundle = require('playwright-core/lib/mcpBundle');
const pcRequire = createRequire(require.resolve('playwright-core/lib/tools/mcp/program'));
const { BrowserBackend } = pcRequire('../backend/browserBackend');

if (!BrowserBackend.prototype.__mcpOptimizedPatched) {
  BrowserBackend.prototype.__mcpOptimizedPatched = true;

  const { executeBatch, batchToolMcpSchema } = require('./batch-middleware');
  const { applyExpectations, injectExpectationsSchema } = require('./expectations');
  const { diffSnapshotContent } = require('./diff-tracker');
  const { applyNetworkFilter, applyConsoleFilter, injectFilterSchemas } = require('./result-filters');
  const { applyImageOptimization, injectImageOptionsSchema } = require('./image-optimizer');
  const { executeAssert, assertToolMcpSchema } = require('./assert');
  const { recordAction, getSessionContext, sessionContextMcpSchema } = require('./session-context');
  const { truncateSnapshotContent, injectTruncationSchema } = require('./snapshot-truncator');
  const { filterByViewportApprox, injectViewportSchema } = require('./viewport-filter');
  const { callToolWithStaleRefRetry } = require('./stale-ref-resolver');
  const { parseResponseBudget, enforceResponseBudget } = require('./response-budget');

  // Regex для snapshot extract/replace - вызывается ОДИН раз за pipeline (#4 optimization)
  const SNAPSHOT_RE = /(### Snapshot\n)([\s\S]*?)(?=\n### |\s*$)/;

  /**
   * Consolidated snapshot pipeline: extract ONCE -> transform -> replace ONCE.
   * Replaces 3 separate regex extract+replace cycles (~6 regex ops) with 2 (~1 extract + 1 replace).
   */
  function applySnapshotPipeline(result, backend, truncationOpts, viewportOnly, diffEnabled) {
    if (!result || !result.content) return result;

    let changed = false;
    const content = result.content.map(part => {
      if (part.type !== 'text' || !part.text) return part;
      if (part.text.indexOf('### Snapshot') === -1) return part;

      const match = part.text.match(SNAPSHOT_RE);
      if (!match) return part;

      let snapshotContent = match[2];

      // Transform 1: truncation
      if (truncationOpts)
        snapshotContent = truncateSnapshotContent(snapshotContent, truncationOpts);

      // Transform 2: viewport filter
      if (viewportOnly)
        snapshotContent = filterByViewportApprox(snapshotContent);

      // Transform 3: diff
      if (diffEnabled) {
        const diffResult = diffSnapshotContent(backend, snapshotContent);
        if (diffResult !== null)
          snapshotContent = diffResult;
      }

      // Единственный replace
      if (snapshotContent !== match[2]) {
        changed = true;
        return { ...part, text: part.text.replace(SNAPSHOT_RE, `$1${snapshotContent}`) };
      }
      return part;
    });

    return changed ? { ...result, content } : result;
  }

  const globalBudget = parseResponseBudget(process.argv);

  // Keys we strip from args before passing to playwright-core
  const CUSTOM_KEYS = new Set(['expectations', 'filter', 'imageOptions', 'snapshotOptions', 'viewportOnly']);

  // Tools where session recording extracts page state (expensive regex)
  const PAGE_STATE_TOOLS = new Set([
    'browser_navigate', 'browser_navigate_back', 'browser_navigate_forward',
    'browser_snapshot', 'browser_click', 'browser_type', 'browser_select_option',
    'browser_press_key', 'browser_hover',
  ]);

  /**
   * Unified arg extraction: one pass strips all custom keys.
   * Returns custom options + clean args for playwright-core.
   * Zero intermediate objects when no custom keys present.
   */
  function extractAllOptions(args) {
    if (!args || typeof args !== 'object')
      return { cleanArgs: args, expectations: null, filter: null, imageOptions: null, truncationOpts: null, viewportOnly: false };

    // Fast check: any custom keys present?
    let hasCustom = false;
    for (const key of CUSTOM_KEYS) {
      if (key in args) { hasCustom = true; break; }
    }

    if (!hasCustom)
      return { cleanArgs: args, expectations: null, filter: null, imageOptions: null, truncationOpts: null, viewportOnly: false };

    // Extract all at once
    const { expectations: rawExp, filter, imageOptions, snapshotOptions, viewportOnly, ...cleanArgs } = args;

    // Parse expectations (inline - avoids function call overhead)
    let expectations = null;
    if (rawExp && typeof rawExp === 'object') {
      expectations = {
        includeSnapshot: rawExp.includeSnapshot !== false,
        includeCode: rawExp.includeCode !== false,
        includePage: rawExp.includePage !== false,
        includeConsole: rawExp.includeConsole !== false,
        includeModal: rawExp.includeModal !== false,
        includeDownloads: rawExp.includeDownloads !== false,
        includeTabs: rawExp.includeTabs !== false,
      };
      if (rawExp.diff === true) expectations.diff = true;
    }

    return {
      cleanArgs,
      expectations,
      filter: filter || null,
      imageOptions: imageOptions || null,
      truncationOpts: snapshotOptions || null,
      viewportOnly: !!viewportOnly,
    };
  }

  // 1. Patch BrowserBackend.prototype.callTool
  const originalCallTool = BrowserBackend.prototype.callTool;
  BrowserBackend.prototype.callTool = async function(name, args, progress) {
    // Custom tools - no pipeline overhead
    if (name === 'browser_batch_execute')
      return executeBatch(this, args, progress || (() => {}));
    if (name === 'browser_assert')
      return executeAssert(this, args);
    if (name === 'browser_session_context')
      return getSessionContext(this);

    // Unified extraction (one pass)
    const opts = extractAllOptions(args);

    // Native JPEG pass-through: если нужен только quality без resize,
    // передаем type/quality напрямую в playwright-core (экономим decode/encode цикл ~200-400ms)
    let callArgs = opts.cleanArgs;
    let skipImageOptimization = false;
    if (opts.imageOptions && name === 'browser_take_screenshot') {
      const { quality, maxWidth } = opts.imageOptions;
      if (quality && !maxWidth) {
        callArgs = { ...callArgs, type: 'jpeg', quality };
        skipImageOptimization = true;
      }
    }

    // Call original (with stale ref retry for interactive tools)
    const result = await callToolWithStaleRefRetry(originalCallTool, this, name, callArgs, progress);

    // Session recording (lazy: expensive page state parsing only for relevant tools)
    recordAction(this, name, opts.cleanArgs, result, PAGE_STATE_TOOLS.has(name));

    // Post-processing pipeline with early exits (no allocation if option is null/false)
    let processed = result;

    // Image optimization (screenshot only, skip if native JPEG was used)
    if (opts.imageOptions && name === 'browser_take_screenshot' && !skipImageOptimization)
      processed = applyImageOptimization(processed, opts.imageOptions);

    // Snapshot-specific optimizations (skip for non-snapshot tools)
    // Regex consolidation: extract snapshot ONCE, apply all transforms, replace ONCE
    if (name === 'browser_snapshot' || name === 'browser_navigate' ||
        name === 'browser_click' || name === 'browser_type') {
      const diffEnabled = opts.expectations && opts.expectations.diff === true;
      const needsProcessing = opts.truncationOpts || opts.viewportOnly || diffEnabled;

      if (needsProcessing)
        processed = applySnapshotPipeline(processed, this, opts.truncationOpts, opts.viewportOnly, diffEnabled);
    }

    // Result filters (tool-specific, guarded)
    if (opts.filter) {
      if (name === 'browser_network_requests')
        processed = applyNetworkFilter(processed, opts.filter);
      else if (name === 'browser_console_messages')
        processed = applyConsoleFilter(processed, opts.filter);
    }

    // Section filtering
    if (opts.expectations)
      processed = applyExpectations(processed, opts.expectations);

    // Global budget (only if configured)
    if (globalBudget)
      processed = enforceResponseBudget(processed, name, globalBudget);

    return processed;
  };

  // 2. Patch Server.prototype.setRequestHandler
  const batchMcpTool = batchToolMcpSchema();
  const assertMcpTool = assertToolMcpSchema();
  const sessionContextMcpTool = sessionContextMcpSchema();

  const originalSetRequestHandler = mcpBundle.Server.prototype.setRequestHandler;
  mcpBundle.Server.prototype.setRequestHandler = function(schema, handler) {
    if (schema === mcpBundle.ListToolsRequestSchema) {
      const originalHandler = handler;
      handler = async function(...args) {
        const result = await originalHandler.apply(this, args);
        result.tools.push(batchMcpTool, assertMcpTool, sessionContextMcpTool);
        injectExpectationsSchema(result.tools);
        injectFilterSchemas(result.tools);
        injectImageOptionsSchema(result.tools);
        injectTruncationSchema(result.tools);
        injectViewportSchema(result.tools);
        return result;
      };
    }
    return originalSetRequestHandler.call(this, schema, handler);
  };
}
