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
  const { applySnapshotDiff } = require('./diff-tracker');
  const { applyNetworkFilter, applyConsoleFilter, injectFilterSchemas } = require('./result-filters');
  const { applyImageOptimization, injectImageOptionsSchema } = require('./image-optimizer');
  const { executeAssert, assertToolMcpSchema } = require('./assert');
  const { recordAction, getSessionContext, sessionContextMcpSchema } = require('./session-context');
  const { applySnapshotTruncation, injectTruncationSchema } = require('./snapshot-truncator');
  const { applyViewportFilter, injectViewportSchema } = require('./viewport-filter');
  const { callToolWithStaleRefRetry } = require('./stale-ref-resolver');
  const { parseResponseBudget, enforceResponseBudget } = require('./response-budget');

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

    // Call original (with stale ref retry for interactive tools)
    const result = await callToolWithStaleRefRetry(originalCallTool, this, name, opts.cleanArgs, progress);

    // Session recording (lazy: expensive page state parsing only for relevant tools)
    recordAction(this, name, opts.cleanArgs, result, PAGE_STATE_TOOLS.has(name));

    // Post-processing pipeline with early exits (no allocation if option is null/false)
    let processed = result;

    // Image optimization (screenshot only)
    if (opts.imageOptions && name === 'browser_take_screenshot')
      processed = applyImageOptimization(processed, opts.imageOptions);

    // Snapshot-specific optimizations (skip for non-snapshot tools)
    if (name === 'browser_snapshot' || name === 'browser_navigate' ||
        name === 'browser_click' || name === 'browser_type') {
      if (opts.truncationOpts)
        processed = applySnapshotTruncation(processed, opts.truncationOpts);
      if (opts.viewportOnly)
        processed = applyViewportFilter(processed, true);

      const diffEnabled = opts.expectations && opts.expectations.diff === true;
      if (diffEnabled)
        processed = applySnapshotDiff(this, processed, true);
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
