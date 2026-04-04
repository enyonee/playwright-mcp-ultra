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
  const { compactSnapshot } = require('./snapshot-compactor');

  // Regex для snapshot extract/replace - вызывается ОДИН раз за pipeline (#4 optimization)
  const SNAPSHOT_RE = /(### Snapshot\n)([\s\S]*?)(?=\n### |\s*$)/;

  /**
   * Consolidated snapshot pipeline: extract ONCE -> transform -> replace ONCE.
   * Replaces 3 separate regex extract+replace cycles (~6 regex ops) with 2 (~1 extract + 1 replace).
   */
  const fs = require('fs');
  const path = require('path');
  const SNAPSHOT_FILE_RE = /\[Snapshot\]\(([^)]+)\)/;

  function applySnapshotPipeline(result, backend, truncationOpts, viewportOnly, diffEnabled) {
    if (!result || !result.content) return result;

    let changed = false;
    const content = result.content.map(part => {
      if (part.type !== 'text' || !part.text) return part;
      if (part.text.indexOf('### Snapshot') === -1) return part;

      const match = part.text.match(SNAPSHOT_RE);
      if (!match) return part;

      let snapshotContent = match[2];

      // Playwright-core saves snapshots to .yml files. If we find a file reference,
      // read the file, compact it, and write it back. The response text stays as-is (link).
      const fileMatch = snapshotContent.match(SNAPSHOT_FILE_RE);
      if (fileMatch) {
        try {
          const filePath = path.resolve(process.cwd(), fileMatch[1]);
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          const compacted = compactSnapshot(fileContent);
          if (compacted !== fileContent) {
            fs.writeFileSync(filePath, compacted, 'utf-8');
            changed = true;
          }
        } catch {}
        return part;
      }

      // Inline snapshot - process directly
      // Transform 0: compact (strip non-interactive refs, cursor hints) - always
      snapshotContent = compactSnapshot(snapshotContent);

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

  // Дефолтный budget 4000 tokens (~16k chars) если не задан явно.
  // Wikipedia snapshot = 14k tokens без ограничения -> agent тормозит.
  const DEFAULT_BUDGET = 4000;
  const globalBudget = parseResponseBudget(process.argv) || DEFAULT_BUDGET;

  // Дефолтные expectations: code/tabs/downloads отключены (экономия ~300-700 tokens/call).
  // Агент может включить обратно: expectations: { includeCode: true }
  const DEFAULT_EXP = {
    includeSnapshot: true,
    includeCode: false,
    includePage: true,
    includeConsole: true,
    includeModal: true,
    includeDownloads: false,
    includeTabs: false,
  };

  // Дефолтные imageOptions для скриншотов: JPEG q80, maxWidth 800.
  // Без этого скриншот 1280x720 PNG = ~385KB base64 = ~96k tokens.
  // С дефолтами: JPEG 800px = ~30-50KB = ~8-12k tokens.
  const DEFAULT_IMAGE_OPTS = { quality: 80, maxWidth: 800 };

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
      return { cleanArgs: args, expectations: { ...DEFAULT_EXP }, filter: null, imageOptions: null, truncationOpts: null, viewportOnly: false };

    // Extract all at once
    const { expectations: rawExp, filter, imageOptions, snapshotOptions, viewportOnly, ...cleanArgs } = args;

    // Parse expectations: merge agent-specified with defaults.
    // Explicit true/false overrides defaults. Missing keys use defaults.
    let expectations = { ...DEFAULT_EXP };
    if (rawExp && typeof rawExp === 'object') {
      for (const key of Object.keys(DEFAULT_EXP)) {
        if (key in rawExp)
          expectations[key] = rawExp[key] !== false;
      }
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

    // Дефолтные imageOptions для скриншотов (если агент не указал)
    if (name === 'browser_take_screenshot' && !opts.imageOptions)
      opts.imageOptions = DEFAULT_IMAGE_OPTS;

    // evaluate/run_code: snapshot бесполезен (агенту нужен ### Result, не дерево).
    // Автоматически выключаем если агент не просил явно.
    if ((name === 'browser_evaluate' || name === 'browser_run_code') && opts.expectations) {
      if (!args || !args.expectations || !('includeSnapshot' in args.expectations))
        opts.expectations.includeSnapshot = false;
    }

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

    // Диагностика: raw размер ДО наших фильтров
    if (process.env.MCP_DEBUG_SIZE) {
      let rawSz = 0;
      for (const p of (result.content || []))
        rawSz += p.type === 'text' ? (p.text || '').length : (p.data || '').length;
      process.stderr.write(`[mcp-raw] ${name}: ${rawSz} chars (~${Math.round(rawSz/4)} tokens)\n`);
    }

    // Session recording (lazy: expensive page state parsing only for relevant tools)
    recordAction(this, name, opts.cleanArgs, result, PAGE_STATE_TOOLS.has(name));

    // Post-processing pipeline with early exits (no allocation if option is null/false)
    let processed = result;

    // Image optimization (screenshot only, skip if native JPEG was used)
    if (opts.imageOptions && name === 'browser_take_screenshot' && !skipImageOptimization)
      processed = applyImageOptimization(processed, opts.imageOptions);

    // Snapshot pipeline: runs for all tools that produce accessibility tree snapshots.
    // At minimum does compaction (strip non-interactive refs, cursor hints).
    // Additionally: truncation, viewport filter, diff when requested.
    if (name === 'browser_snapshot' || name === 'browser_navigate' ||
        name === 'browser_click' || name === 'browser_type' ||
        name === 'browser_select_option' || name === 'browser_press_key' ||
        name === 'browser_hover' || name === 'browser_navigate_back' ||
        name === 'browser_navigate_forward' || name === 'browser_drag' ||
        name === 'browser_file_upload' || name === 'browser_handle_dialog') {
      const diffEnabled = opts.expectations && opts.expectations.diff === true;
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

    // Диагностика размера ответа (stderr, не попадает в MCP протокол)
    if (process.env.MCP_DEBUG_SIZE) {
      let sz = 0;
      for (const p of (processed.content || []))
        sz += p.type === 'text' ? (p.text || '').length : (p.data || '').length;
      process.stderr.write(`[mcp-size] ${name}: ${sz} chars (~${Math.round(sz/4)} tokens)\n`);
    }

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
