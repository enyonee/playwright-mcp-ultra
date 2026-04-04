/**
 * Patches playwright-core to add custom enhancements:
 * - browser_batch_execute tool
 * - expectations (response section filtering)
 * - snapshot diff tracking
 * - network/console result filters
 * - screenshot image optimization (quality, maxWidth)
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

  // 1. Patch BrowserBackend.prototype.callTool:
  //    - Handle browser_batch_execute
  //    - Extract & apply expectations, diff, filters
  const originalCallTool = BrowserBackend.prototype.callTool;
  BrowserBackend.prototype.callTool = async function(name, args, progress) {
    if (name === 'browser_batch_execute') {
      return executeBatch(this, args, progress || (() => {}));
    }

    // Strip custom parameters before passing to playwright-core
    const { expectations, cleanArgs: argsNoExp } = extractExpectations(args);
    const { filter, cleanArgs: argsNoFilter } = extractFilter(argsNoExp);
    const { imageOptions, cleanArgs: finalArgs } = extractImageOptions(argsNoFilter);

    const result = await originalCallTool.call(this, name, finalArgs, progress);

    // Post-process: image -> diff -> filter -> expectations (order matters)
    const optimized = (name === 'browser_take_screenshot')
      ? applyImageOptimization(result, imageOptions)
      : result;

    const diffEnabled = expectations && expectations.diff === true;
    const diffed = applySnapshotDiff(this, optimized, diffEnabled);

    let filtered = diffed;
    if (name === 'browser_network_requests')
      filtered = applyNetworkFilter(diffed, filter);
    else if (name === 'browser_console_messages')
      filtered = applyConsoleFilter(diffed, filter);

    return applyExpectations(filtered, expectations);
  };

  // 2. Patch Server.prototype.setRequestHandler:
  //    - Add batch tool to ListTools
  //    - Add expectations schema to all browser_* tools
  //    - Add filter schemas to network/console tools
  const batchMcpTool = batchToolMcpSchema();
  const originalSetRequestHandler = mcpBundle.Server.prototype.setRequestHandler;
  mcpBundle.Server.prototype.setRequestHandler = function(schema, handler) {
    if (schema === mcpBundle.ListToolsRequestSchema) {
      const originalHandler = handler;
      handler = async function(...args) {
        const result = await originalHandler.apply(this, args);
        result.tools.push(batchMcpTool);
        injectExpectationsSchema(result.tools);
        injectFilterSchemas(result.tools);
        injectImageOptionsSchema(result.tools);
        return result;
      };
    }
    return originalSetRequestHandler.call(this, schema, handler);
  };
}
