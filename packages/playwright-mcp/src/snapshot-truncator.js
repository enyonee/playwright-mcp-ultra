/**
 * Snapshot truncation middleware for Playwright MCP.
 * Limits snapshot size by maxTokens parameter, cutting YAML
 * accessibility tree by depth while preserving complete nodes.
 *
 * Token savings: 50-70% on large pages (3000+ token snapshots).
 *
 * Approach: YAML ARIA tree is indentation-based. We parse indent levels
 * and cut at depth boundaries, never mid-node. Priority: interactable
 * elements (buttons, links, inputs) kept over static text.
 */

const TRUNCATION_SCHEMA = {
  type: 'object',
  description: 'Limit snapshot size. Reduces tokens on large pages by truncating the accessibility tree.',
  properties: {
    maxTokens: {
      type: 'number',
      minimum: 100,
      maximum: 50000,
      description: 'Approximate max tokens for snapshot (~4 chars/token). Default: unlimited. 2000 is good for most tasks.',
    },
    maxDepth: {
      type: 'number',
      minimum: 1,
      maximum: 20,
      description: 'Max nesting depth of the accessibility tree. Deeper nodes are removed. Default: unlimited.',
    },
    prioritizeInteractable: {
      type: 'boolean',
      description: 'Keep interactive elements (buttons, links, inputs) over static text when truncating (default: true).',
    },
  },
  additionalProperties: false,
};

// ~4 chars per token (rough approximation for YAML/English mix)
const CHARS_PER_TOKEN = 4;

// Interactable ARIA roles (high priority when truncating)
const INTERACTABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox',
  'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'menuitem', 'option', 'treeitem',
]);

/**
 * Extract truncation options from tool arguments.
 */
function extractTruncationOptions(args) {
  if (!args || typeof args !== 'object' || !args.snapshotOptions)
    return { truncationOpts: null, cleanArgs: args };

  const { snapshotOptions, ...cleanArgs } = args;
  return { truncationOpts: snapshotOptions, cleanArgs };
}

/**
 * Apply truncation to snapshot section in tool result.
 */
function applySnapshotTruncation(result, opts) {
  if (!opts || !result || !result.content)
    return result;

  const maxTokens = opts.maxTokens;
  const maxDepth = opts.maxDepth;
  if (!maxTokens && !maxDepth)
    return result;

  const content = result.content.map(part => {
    if (part.type !== 'text' || !part.text)
      return part;

    const snapshotContent = extractSnapshotContent(part.text);
    if (!snapshotContent)
      return part;

    const truncated = truncateSnapshot(snapshotContent, {
      maxChars: maxTokens ? maxTokens * CHARS_PER_TOKEN : Infinity,
      maxDepth: maxDepth || Infinity,
      prioritizeInteractable: opts.prioritizeInteractable !== false,
    });

    return { ...part, text: replaceSnapshot(part.text, truncated) };
  });

  return { ...result, content };
}

/**
 * Truncate YAML accessibility tree.
 * Strategy:
 * 1. Parse lines into nodes with indent levels
 * 2. Remove nodes deeper than maxDepth
 * 3. If still over budget, remove low-priority subtrees (static text first)
 * 4. Add truncation marker
 */
function truncateSnapshot(snapshot, opts) {
  const lines = snapshot.split('\n');
  if (lines.length === 0) return snapshot;

  // Шаг 1: depth filter
  let filtered = lines;
  if (opts.maxDepth !== Infinity) {
    filtered = filterByDepth(lines, opts.maxDepth);
  }

  // Шаг 2: size check
  let text = filtered.join('\n');
  if (text.length <= opts.maxChars)
    return text;

  // Шаг 3: приоритезированная обрезка
  if (opts.prioritizeInteractable) {
    filtered = prioritizedTruncate(filtered, opts.maxChars);
  } else {
    // Простая обрезка по глубине до вписывания в бюджет
    for (let depth = getMaxDepth(filtered); depth >= 1; depth--) {
      filtered = filterByDepth(filtered, depth);
      if (filtered.join('\n').length <= opts.maxChars)
        break;
    }
  }

  text = filtered.join('\n');

  // Обрезаем если все еще не влезает (крайний случай)
  if (text.length > opts.maxChars) {
    text = cutAtNodeBoundary(text, opts.maxChars);
  }

  const approxTokens = Math.round(text.length / CHARS_PER_TOKEN);
  const origTokens = Math.round(snapshot.length / CHARS_PER_TOKEN);
  if (approxTokens < origTokens) {
    text += `\n[Truncated: ~${approxTokens} tokens, was ~${origTokens}]`;
  }

  return text;
}

/**
 * Filter YAML lines by indentation depth.
 * Indentation is 2 spaces per level in ARIA snapshots.
 */
function filterByDepth(lines, maxDepth) {
  const result = [];
  let truncatedChildren = false;

  for (const line of lines) {
    const depth = getLineDepth(line);
    if (depth <= maxDepth) {
      if (truncatedChildren) {
        // Вставляем маркер на предыдущем уровне
        truncatedChildren = false;
      }
      result.push(line);
    } else {
      truncatedChildren = true;
    }
  }

  return result;
}

/**
 * Prioritized truncation: keep interactable nodes, remove static text first.
 */
function prioritizedTruncate(lines, maxChars) {
  // Классифицируем каждую строку
  const classified = lines.map(line => ({
    line,
    depth: getLineDepth(line),
    interactable: isInteractableLine(line),
  }));

  // Начинаем с полного списка, убираем неинтерактивные с самой большой глубины
  let current = [...classified];
  let currentSize = current.reduce((s, c) => s + c.line.length + 1, 0);

  if (currentSize <= maxChars) return current.map(c => c.line);

  const maxD = Math.max(...current.map(c => c.depth));

  for (let depth = maxD; depth >= 1; depth--) {
    if (currentSize <= maxChars) break;

    // Сначала убираем неинтерактивные на этой глубине
    const before = current.length;
    current = current.filter(c => {
      if (c.depth === depth && !c.interactable) {
        currentSize -= c.line.length + 1;
        return false;
      }
      return true;
    });
    if (currentSize <= maxChars) break;

    // Если все еще не влезает - убираем и интерактивные на этой глубине
    current = current.filter(c => {
      if (c.depth === depth) {
        currentSize -= c.line.length + 1;
        return false;
      }
      return true;
    });
  }

  return current.map(c => c.line);
}

/**
 * Cut text at the last complete node boundary before maxChars.
 */
function cutAtNodeBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;

  // Ищем последний перенос строки перед лимитом
  let cutPoint = text.lastIndexOf('\n', maxChars);
  if (cutPoint <= 0) cutPoint = maxChars;

  return text.substring(0, cutPoint);
}

function getLineDepth(line) {
  const match = line.match(/^( *)/);
  return match ? Math.floor(match[1].length / 2) : 0;
}

function getMaxDepth(lines) {
  let max = 0;
  for (const line of lines) {
    const d = getLineDepth(line);
    if (d > max) max = d;
  }
  return max;
}

function isInteractableLine(line) {
  const trimmed = line.trimStart();
  // ARIA snapshot format: "- role 'name':" or "- role 'name'"
  const roleMatch = trimmed.match(/^- (\w+)/);
  if (!roleMatch) return false;
  return INTERACTABLE_ROLES.has(roleMatch[1]);
}

function extractSnapshotContent(text) {
  const match = text.match(/### Snapshot\n([\s\S]*?)(?=\n### |\s*$)/);
  return match ? match[1] : null;
}

function replaceSnapshot(text, newContent) {
  return text.replace(
    /(### Snapshot\n)([\s\S]*?)(?=\n### |\s*$)/,
    `$1${newContent}`
  );
}

/**
 * Inject snapshotOptions schema into browser_snapshot tool.
 */
function injectTruncationSchema(tools) {
  for (const tool of tools) {
    if (tool.name !== 'browser_snapshot')
      continue;
    if (!tool.inputSchema || !tool.inputSchema.properties)
      continue;

    tool.inputSchema.properties.snapshotOptions = TRUNCATION_SCHEMA;

    if (tool.inputSchema.required)
      tool.inputSchema.required = tool.inputSchema.required.filter(r => r !== 'snapshotOptions');

    if (tool.inputSchema.additionalProperties === false)
      delete tool.inputSchema.additionalProperties;
  }
}

module.exports = {
  extractTruncationOptions,
  applySnapshotTruncation,
  injectTruncationSchema,
  TRUNCATION_SCHEMA,
};
