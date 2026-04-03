/**
 * Patches playwright-core to add browser_batch_execute support.
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

// 1. Patch BrowserBackend.prototype.callTool to handle browser_batch_execute
const originalCallTool = BrowserBackend.prototype.callTool;
BrowserBackend.prototype.callTool = async function(name, args, progress) {
  if (name === 'browser_batch_execute') {
    return executeBatch(this, args, progress || (() => {}));
  }
  return originalCallTool.call(this, name, args, progress);
};

// 2. Patch Server.prototype.setRequestHandler to inject batch tool into ListTools
const batchMcpTool = batchToolMcpSchema();
const originalSetRequestHandler = mcpBundle.Server.prototype.setRequestHandler;
mcpBundle.Server.prototype.setRequestHandler = function(schema, handler) {
  if (schema === mcpBundle.ListToolsRequestSchema) {
    const originalHandler = handler;
    handler = async function(...args) {
      const result = await originalHandler.apply(this, args);
      result.tools.push(batchMcpTool);
      return result;
    };
  }
  return originalSetRequestHandler.call(this, schema, handler);
};
