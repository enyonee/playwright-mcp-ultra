/**
 * Patches playwright-core to add custom enhancements:
 * - browser_batch_execute tool
 * - browser_assert tool (compact page verification)
 * - browser_session_context tool (action history summary)
 * - expectations (response section filtering)
 * - snapshot diff tracking
 * - snapshot truncation (maxTokens, maxDepth)
 * - viewport-only snapshot filtering
 * - network/console result filters
 * - screenshot image optimization (quality, maxWidth)
 * - stale ref auto-retry
 * - global response budget enforcement
 *
 * Must be required before any MCP server creation (cli.js, index.js).
 *
 * Approach: patch class prototypes (BrowserBackend, Server) rather than
 * module exports, because playwright-core uses non-configurable getters
 * for its module.exports that can't be reassigned.
 */

const { createRequire } = require('module');
const mcpBundle = require('playwright-core/lib/mcpBundle');
const pcRequire = createRequire(require.resolve('playwright-core/lib/tools/mcp/program'));
const { BrowserBackend } = pcRequire('../backend/browserBackend');

// Guard against double-patching (e.g. if require cache is cleared)
if (!BrowserBackend.prototype.__mcpOptimizedPatched) {
  BrowserBackend.prototype.__mcpOptimizedPatched = true;

  const { executeBatch, batchToolMcpSchema } = require('./batch-middleware');
  const { extractExpectations, applyExpectations, injectExpectationsSchema } = require('./expectations');
  const { applySnapshotDiff } = require('./diff-tracker');
  const { extractFilter, applyNetworkFilter, applyConsoleFilter, injectFilterSchemas } = require('./result-filters');
  const { extractImageOptions, applyImageOptimization, injectImageOptionsSchema } = require('./image-optimizer');
  const { executeAssert, assertToolMcpSchema } = require('./assert');
  const { recordAction, getSessionContext, sessionContextMcpSchema } = require('./session-context');
  const { extractTruncationOptions, applySnapshotTruncation, injectTruncationSchema } = require('./snapshot-truncator');
  const { extractViewportOption, applyViewportFilter, injectViewportSchema } = require('./viewport-filter');
  const { callToolWithStaleRefRetry } = require('./stale-ref-resolver');
  const { parseResponseBudget, enforceResponseBudget } = require('./response-budget');

  // Parse global budget from process args (--max-response-size=N)
  const globalBudget = parseResponseBudget(process.argv);

  // 1. Patch BrowserBackend.prototype.callTool
  const originalCallTool = BrowserBackend.prototype.callTool;
  BrowserBackend.prototype.callTool = async function(name, args, progress) {
    // Custom tools that don't go through playwright-core
    if (name === 'browser_batch_execute')
      return executeBatch(this, args, progress || (() => {}));
    if (name === 'browser_assert')
      return executeAssert(this, args);
    if (name === 'browser_session_context')
      return getSessionContext(this);

    // Strip custom parameters before passing to playwright-core
    const { expectations, cleanArgs: argsNoExp } = extractExpectations(args);
    const { filter, cleanArgs: argsNoFilter } = extractFilter(argsNoExp);
    const { imageOptions, cleanArgs: argsNoImage } = extractImageOptions(argsNoFilter);
    const { truncationOpts, cleanArgs: argsNoTrunc } = extractTruncationOptions(argsNoImage);
    const { viewportOnly, cleanArgs: finalArgs } = extractViewportOption(argsNoTrunc);

    // Call original with stale ref retry wrapper
    const result = await callToolWithStaleRefRetry(originalCallTool, this, name, finalArgs, progress);

    // Record action in session context
    recordAction(this, name, finalArgs, result);

    // Post-process pipeline (order matters):
    // image -> truncation -> viewport -> diff -> filter -> expectations -> budget
    let processed = result;

    if (name === 'browser_take_screenshot')
      processed = applyImageOptimization(processed, imageOptions);

    // Snapshot truncation (maxTokens/maxDepth) - before diff
    processed = applySnapshotTruncation(processed, truncationOpts);

    // Viewport filter (above-the-fold) - before diff
    processed = applyViewportFilter(processed, viewportOnly);

    // Diff tracking
    const diffEnabled = expectations && expectations.diff === true;
    processed = applySnapshotDiff(this, processed, diffEnabled);

    // Result filters
    if (name === 'browser_network_requests')
      processed = applyNetworkFilter(processed, filter);
    else if (name === 'browser_console_messages')
      processed = applyConsoleFilter(processed, filter);

    // Expectations (section filtering)
    processed = applyExpectations(processed, expectations);

    // Global budget enforcement (last - compresses whatever is left)
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
        // Add custom tools
        result.tools.push(batchMcpTool);
        result.tools.push(assertMcpTool);
        result.tools.push(sessionContextMcpTool);
        // Inject custom schemas into existing tools
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
