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
    'Reduces round-trips and token usage. Actions execute in order; stops on first error by default. ' +
    'Consecutive read-only steps (snapshot, screenshot, assert, network, console) run in parallel automatically. ' +
    'Data tools (evaluate, snapshot, navigate) show up to 30 lines per step; action tools show 5.',
  type: 'destructive',
  inputSchema: BATCH_INPUT_SCHEMA,
};

// Read-only tools safe for parallel execution within batch
const READ_ONLY_TOOLS = new Set([
  'browser_snapshot', 'browser_take_screenshot',
  'browser_console_messages', 'browser_network_requests',
  'browser_session_context', 'browser_assert',
]);

/**
 * Execute batch of actions against the backend.
 * Consecutive read-only tools run in parallel via Promise.all.
 */
async function executeBatch(backend, params, progress) {
  const actions = params.actions || [];
  const stopOnError = params.stopOnError !== false;
  const defaultExpectations = params.defaultExpectations || null;
  const results = [];
  let totalTimeMs = 0;
  let stopped = false;

  // Группируем в сегменты: parallel (read-only) и sequential (interactive)
  const segments = segmentActions(actions);

  for (const segment of segments) {
    if (stopped) break;

    if (segment.parallel && segment.items.length > 1) {
      // Параллельное выполнение read-only инструментов
      const batchStart = Date.now();
      progress({ message: `Steps ${segment.items.map(a => a.idx + 1).join(',')}: parallel (${segment.items.length} read-only)` });

      const promises = segment.items.map(async (item) => {
        const stepStart = Date.now();
        try {
          let stepArgs = item.arguments || {};
          if (defaultExpectations) {
            const stepExp = stepArgs.expectations || {};
            stepArgs = { ...stepArgs, expectations: { ...defaultExpectations, ...stepExp } };
          }
          const result = await backend.callTool(item.tool, stepArgs, () => {});
          return {
            step: item.idx + 1, tool: item.tool,
            success: !result.isError, timeMs: Date.now() - stepStart,
            content: result.content, isError: result.isError,
          };
        } catch (error) {
          return {
            step: item.idx + 1, tool: item.tool,
            success: false, timeMs: Date.now() - stepStart,
            content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true,
          };
        }
      });

      const stepResults = await Promise.all(promises);
      const batchTimeMs = Date.now() - batchStart;
      totalTimeMs += batchTimeMs;

      // Сохраняем в порядке оригинальных индексов
      stepResults.sort((a, b) => a.step - b.step);
      for (const r of stepResults) {
        results.push(r);
        if (r.isError && stopOnError) { stopped = true; break; }
      }
    } else {
      // Последовательное выполнение
      for (const item of segment.items) {
        if (stopped) break;
        const stepStart = Date.now();

        progress({ message: `Step ${item.idx + 1}/${actions.length}: ${item.tool}` });

        if (item.tool === 'browser_batch_execute') {
          results.push({ step: item.idx + 1, tool: item.tool, success: false, timeMs: 0,
            content: [{ type: 'text', text: 'Error: nested batch execute is not allowed' }], isError: true });
          if (stopOnError) { stopped = true; }
          continue;
        }

        let stepArgs = item.arguments || {};
        if (defaultExpectations) {
          const stepExp = stepArgs.expectations || {};
          stepArgs = { ...stepArgs, expectations: { ...defaultExpectations, ...stepExp } };
        }

        try {
          const result = await backend.callTool(item.tool, stepArgs, () => {});
          const stepTimeMs = Date.now() - stepStart;
          totalTimeMs += stepTimeMs;
          results.push({
            step: item.idx + 1, tool: item.tool,
            success: !result.isError, timeMs: stepTimeMs,
            content: result.content, isError: result.isError,
          });
          if (result.isError && stopOnError) { stopped = true; }
        } catch (error) {
          const stepTimeMs = Date.now() - stepStart;
          totalTimeMs += stepTimeMs;
          results.push({
            step: item.idx + 1, tool: item.tool,
            success: false, timeMs: stepTimeMs,
            content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true,
          });
          if (stopOnError) { stopped = true; }
        }
      }
    }
  }

  return formatBatchResult(results, actions.length, totalTimeMs);
}

/**
 * Разбивает actions на сегменты: consecutive read-only -> parallel, остальное -> sequential.
 */
function segmentActions(actions) {
  const segments = [];
  let current = null;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const isReadOnly = READ_ONLY_TOOLS.has(action.tool);

    if (!current || current.parallel !== isReadOnly) {
      current = { parallel: isReadOnly, items: [] };
      segments.push(current);
    }
    current.items.push({ ...action, idx: i });
  }

  return segments;
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
          // evaluate/snapshot/navigate возвращают полезные данные - показываем больше
          const isDataTool = result.tool === 'browser_evaluate' || result.tool === 'browser_snapshot'
            || result.tool === 'browser_navigate' || result.tool === 'browser_network_requests'
            || result.tool === 'browser_console_messages';
          const maxLines = isDataTool ? 30 : 5;
          const stepLines = part.text.split('\n');
          if (stepLines.length <= maxLines) {
            lines.push(part.text);
          } else {
            lines.push(...stepLines.slice(0, maxLines));
            lines.push(`... (${stepLines.length - maxLines} more lines)`);
          }
        }
      }
    }
    lines.push('');
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
