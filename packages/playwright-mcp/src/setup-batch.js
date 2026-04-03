/**
 * Patches playwright-core to add custom enhancements:
 * - browser_batch_execute tool
 * - expectations (response section filtering)
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
const { executeBatch, batchToolMcpSchema } = require('./batch-middleware');
const { extractExpectations, applyExpectations, injectExpectationsSchema } = require('./expectations');

// 1. Patch BrowserBackend.prototype.callTool:
//    - Handle browser_batch_execute
//    - Extract & apply expectations for all tools
const originalCallTool = BrowserBackend.prototype.callTool;
BrowserBackend.prototype.callTool = async function(name, args, progress) {
  if (name === 'browser_batch_execute') {
    return executeBatch(this, args, progress || (() => {}));
  }

  const { expectations, cleanArgs } = extractExpectations(args);
  const result = await originalCallTool.call(this, name, cleanArgs, progress);
  return applyExpectations(result, expectations);
};

// 2. Patch Server.prototype.setRequestHandler:
//    - Add batch tool to ListTools
//    - Add expectations schema to all browser_* tools
const batchMcpTool = batchToolMcpSchema();
const originalSetRequestHandler = mcpBundle.Server.prototype.setRequestHandler;
mcpBundle.Server.prototype.setRequestHandler = function(schema, handler) {
  if (schema === mcpBundle.ListToolsRequestSchema) {
    const originalHandler = handler;
    handler = async function(...args) {
      const result = await originalHandler.apply(this, args);
      result.tools.push(batchMcpTool);
      injectExpectationsSchema(result.tools);
      return result;
    };
  }
  return originalSetRequestHandler.call(this, schema, handler);
};
