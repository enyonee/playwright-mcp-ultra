/**
 * Stale ref resolver for Playwright MCP.
 * When an action fails due to stale element reference,
 * automatically re-snapshots, finds matching element, and retries.
 *
 * Token savings: eliminates 2 round-trips (error -> snapshot -> retry)
 * per stale ref hit. Common in SPAs where DOM updates between actions.
 *
 * Detection: error messages containing "Target closed", "Element is not attached",
 * "no longer attached", "frame was detached", ref-related errors from playwright.
 */

const STALE_REF_PATTERNS = [
  /element.*not.*attached/i,
  /target.*closed/i,
  /frame.*detached/i,
  /no longer attached/i,
  /element.*not found/i,
  /Cannot find element/i,
  /ref \w+ not found/i,
  /element ref.*not/i,
  /stale element/i,
];

// Инструменты которые оперируют с ref-ами и могут retry
const RETRIABLE_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_hover',
  'browser_select_option',
  'browser_drag',
]);

/**
 * Wrap a callTool to handle stale refs transparently.
 *
 * @param {Function} originalCallTool - original callTool method
 * @param {object} backend - BrowserBackend instance
 * @param {string} name - tool name
 * @param {object} args - tool arguments
 * @param {Function} progress - progress callback
 * @returns {object} result (original or retried)
 */
async function callToolWithStaleRefRetry(originalCallTool, backend, name, args, progress) {
  const result = await originalCallTool.call(backend, name, args, progress);

  // Только для retriable tools с ошибкой
  if (!RETRIABLE_TOOLS.has(name) || !result || !result.isError)
    return result;

  // Проверяем паттерн ошибки
  const errorText = extractErrorText(result);
  if (!isStaleRefError(errorText))
    return result;

  // Stale ref detected - автоматический retry
  try {
    // Минимальный snapshot: depth=1 достаточно для refresh ref-ов в playwright-core.
    // Полный snapshot не нужен - экономим ~50-100ms на большых страницах.
    const snapshotResult = await originalCallTool.call(backend, 'browser_snapshot', { depth: 1 }, progress);

    // Retry оригинальный вызов (playwright-core переназначит ref-ы)
    const retryResult = await originalCallTool.call(backend, name, args, progress);

    // Добавляем hint что был автоматический retry
    if (retryResult && retryResult.content) {
      const hint = `\n### Auto-retry\nStale ref detected and resolved. Original error: ${errorText.slice(0, 100)}`;
      const content = retryResult.content.map(part => {
        if (part.type === 'text')
          return { ...part, text: part.text + hint };
        return part;
      });
      return { ...retryResult, content };
    }

    return retryResult;
  } catch {
    // Retry failed - возвращаем оригинальную ошибку
    return result;
  }
}

function extractErrorText(result) {
  if (!result || !result.content) return '';
  for (const part of result.content) {
    if (part.type === 'text' && part.text) {
      const match = part.text.match(/### Error\n([\s\S]*?)(?=\n### |\s*$)/);
      if (match) return match[1].trim();
    }
  }
  return '';
}

function isStaleRefError(errorText) {
  if (!errorText) return false;
  return STALE_REF_PATTERNS.some(pattern => pattern.test(errorText));
}

module.exports = { callToolWithStaleRefRetry };
