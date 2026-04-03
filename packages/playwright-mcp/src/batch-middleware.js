/**
 * Batch execution middleware for Playwright MCP.
 * Wraps the backend factory to add browser_batch_execute tool
 * without modifying playwright-core internals.
 */

const { z } = require('playwright-core/lib/zodBundle');

const BATCH_INPUT_SCHEMA = z.object({
  actions: z.array(z.object({
    tool: z.string().describe('Tool name (e.g. browser_click, browser_type)'),
    arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments for the tool'),
  })).min(1).max(20).describe('Array of actions to execute sequentially'),
  stopOnError: z.boolean().optional().default(true).describe('Stop execution on first error (default: true)'),
  defaultExpectations: z.record(z.string(), z.boolean()).optional()
    .describe('Default expectations for all steps. Each step can override via arguments.expectations. Example: { "includeCode": false, "includeSnapshot": false }'),
});

const BATCH_EXECUTE_SCHEMA = {
  name: 'browser_batch_execute',
  title: 'Batch Execute Browser Actions',
  description: 'Execute multiple browser actions in a single call. ' +
    'PREFER this over individual tool calls when performing 2+ sequential operations. ' +
    'Reduces round-trips and token usage. Actions execute in order; stops on first error by default.',
  type: 'destructive',
  inputSchema: BATCH_INPUT_SCHEMA,
};

/**
 * Execute batch of actions against the backend
 */
async function executeBatch(backend, params, progress) {
  const actions = params.actions || [];
  const stopOnError = params.stopOnError !== false;
  const defaultExpectations = params.defaultExpectations || null;
  const results = [];
  let totalTimeMs = 0;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const stepStart = Date.now();

    progress({ message: `Step ${i + 1}/${actions.length}: ${action.tool}` });

    if (action.tool === 'browser_batch_execute') {
      results.push({ step: i + 1, tool: action.tool, success: false, timeMs: 0,
        content: [{ type: 'text', text: 'Error: nested batch execute is not allowed' }], isError: true });
      if (stopOnError) break;
      continue;
    }

    // Merge defaultExpectations into step args (step-level overrides default)
    let stepArgs = action.arguments || {};
    if (defaultExpectations) {
      const stepExp = stepArgs.expectations || {};
      stepArgs = { ...stepArgs, expectations: { ...defaultExpectations, ...stepExp } };
    }

    try {
      const result = await backend.callTool(
        action.tool,
        stepArgs,
        () => {}
      );
      const stepTimeMs = Date.now() - stepStart;
      totalTimeMs += stepTimeMs;

      results.push({
        step: i + 1,
        tool: action.tool,
        success: !result.isError,
        timeMs: stepTimeMs,
        content: result.content,
        isError: result.isError,
      });

      if (result.isError && stopOnError) {
        break;
      }
    } catch (error) {
      const stepTimeMs = Date.now() - stepStart;
      totalTimeMs += stepTimeMs;

      results.push({
        step: i + 1,
        tool: action.tool,
        success: false,
        timeMs: stepTimeMs,
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      });

      if (stopOnError) {
        break;
      }
    }
  }

  return formatBatchResult(results, actions.length, totalTimeMs);
}

/**
 * Format batch results into MCP tool response
 */
function formatBatchResult(results, totalSteps, totalTimeMs) {
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  const lines = [
    `## Batch Execution Summary`,
    `- Steps: ${results.length}/${totalSteps} executed`,
    `- Successful: ${successful}`,
    `- Failed: ${failed}`,
    `- Total time: ${totalTimeMs}ms`,
    '',
  ];

  for (const result of results) {
    const status = result.success ? 'OK' : 'FAIL';
    lines.push(`### Step ${result.step}: ${result.tool} [${status}] (${result.timeMs}ms)`);

    if (result.content) {
      for (const part of result.content) {
        if (part.type === 'text' && part.text) {
          const stepLines = part.text.split('\n');
          if (stepLines.length <= 5) {
            lines.push(part.text);
          } else {
            lines.push(...stepLines.slice(0, 5));
            lines.push(`... (${stepLines.length - 5} more lines)`);
          }
        }
      }
    }
    lines.push('');
  }

  const lastSuccessful = [...results].reverse().find(r => r.success);
  if (lastSuccessful && lastSuccessful.content) {
    lines.push('## Final State (last successful step)');
    for (const part of lastSuccessful.content) {
      if (part.type === 'text') {
        lines.push(part.text);
      }
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: failed > 0 && successful === 0,
  };
}

/**
 * Convert batch schema to MCP tool format (matching toMcpTool output)
 */
function batchToolMcpSchema() {
  const { z } = require('playwright-core/lib/zodBundle');
  return {
    name: BATCH_EXECUTE_SCHEMA.name,
    description: BATCH_EXECUTE_SCHEMA.description,
    inputSchema: z.toJSONSchema(BATCH_INPUT_SCHEMA),
    annotations: {
      title: BATCH_EXECUTE_SCHEMA.title,
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  };
}

module.exports = { executeBatch, batchToolMcpSchema, BATCH_EXECUTE_SCHEMA };
