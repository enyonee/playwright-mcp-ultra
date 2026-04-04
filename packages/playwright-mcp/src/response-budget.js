/**
 * Global response budget enforcement for Playwright MCP.
 * Automatically compresses responses to fit within a configured
 * max size. Applies multiple strategies in order:
 * 1. Remove low-priority sections (code, tabs, downloads)
 * 2. Snapshot depth reduction
 * 3. Proportional section truncation
 * 4. Hard truncation
 *
 * Savings: ~40% globally when budget is set.
 * Agent doesn't need to specify per-tool optimizations.
 */

const CHARS_PER_UNIT = 4;

/**
 * Extract global response budget from CLI args.
 * Called once at setup time.
 * --max-response-size=2000
 */
function parseResponseBudget(args) {
  for (const arg of args || []) {
    const match = arg.match(/^--max-response-size=(\d+)$/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Enforce budget on a tool result.
 * Applies progressive compression to fit within limit.
 *
 * @param {object} result - MCP tool result
 * @param {string} toolName - tool that produced the result
 * @param {number|null} budget - max size units (null = unlimited)
 * @returns {object} compressed result
 */
function enforceResponseBudget(result, toolName, budget) {
  if (!budget || !result || !result.content)
    return result;

  const maxChars = budget * CHARS_PER_UNIT;

  // Текущий размер (только text parts)
  let currentSize = 0;
  for (const part of result.content) {
    if (part.type === 'text' && part.text)
      currentSize += part.text.length;
  }

  if (currentSize <= maxChars)
    return result;

  // Прогрессивная компрессия
  let compressed = result;

  // Стратегия 1: убираем низкоприоритетные секции
  compressed = removeLowPrioritySections(compressed);
  if (getTextSize(compressed) <= maxChars) return compressed;

  // Стратегия 2: обрезаем snapshot по глубине
  compressed = truncateSnapshotInResult(compressed, maxChars);
  if (getTextSize(compressed) <= maxChars) return compressed;

  // Стратегия 3: обрезаем длинные секции
  compressed = truncateLongSections(compressed, maxChars);
  if (getTextSize(compressed) <= maxChars) return compressed;

  // Стратегия 4: жесткая обрезка
  compressed = hardTruncate(compressed, maxChars);

  return compressed;
}

/**
 * Remove low-priority sections: code, tabs, downloads.
 * Keeps: Result, Error, Snapshot, Page.
 */
function removeLowPrioritySections(result) {
  const LOW_PRIORITY = new Set([
    'Ran Playwright code',
    'Open tabs',
    'Downloads',
  ]);

  const content = result.content.map(part => {
    if (part.type !== 'text' || !part.text) return part;

    const sections = parseSections(part.text);
    const filtered = sections.filter(s => !LOW_PRIORITY.has(s.name));
    return { ...part, text: assembleSections(filtered) };
  });

  return { ...result, content };
}

/**
 * Truncate snapshot section by reducing depth.
 */
function truncateSnapshotInResult(result, maxChars) {
  const content = result.content.map(part => {
    if (part.type !== 'text' || !part.text) return part;

    const snapshotMatch = part.text.match(/(### Snapshot\n)([\s\S]*?)(?=\n### |\s*$)/);
    if (!snapshotMatch) return part;

    const snapshotContent = snapshotMatch[2];
    const otherSize = part.text.length - snapshotContent.length;
    const snapshotBudget = maxChars - otherSize;

    if (snapshotBudget < 200) {
      return { ...part, text: part.text.replace(/(### Snapshot\n)([\s\S]*?)(?=\n### |\s*$)/, '$1[Snapshot omitted: over budget]\n') };
    }

    const lines = snapshotContent.split('\n');
    let depth = getMaxDepth(lines);
    let truncated = lines;

    while (truncated.join('\n').length > snapshotBudget && depth > 0) {
      depth--;
      truncated = lines.filter(line => getLineDepth(line) <= depth);
    }

    const newSnapshot = truncated.join('\n');
    return { ...part, text: part.text.replace(/(### Snapshot\n)([\s\S]*?)(?=\n### |\s*$)/, `$1${newSnapshot}\n`) };
  });

  return { ...result, content };
}

/**
 * Truncate each section proportionally.
 */
function truncateLongSections(result, maxChars) {
  const content = result.content.map(part => {
    if (part.type !== 'text' || !part.text) return part;

    const sections = parseSections(part.text);
    const totalSize = sections.reduce((s, sec) => s + sec.text.length, 0);
    if (totalSize <= maxChars) return part;

    const truncated = sections.map(section => {
      const ratio = maxChars / totalSize;
      const sectionBudget = Math.max(100, Math.floor(section.text.length * ratio));
      if (section.text.length <= sectionBudget) return section;

      const cut = section.text.lastIndexOf('\n', sectionBudget);
      const truncatedText = section.text.substring(0, cut > 0 ? cut : sectionBudget);
      return { ...section, text: truncatedText + '\n[...truncated]' };
    });

    return { ...part, text: assembleSections(truncated) };
  });

  return { ...result, content };
}

/**
 * Hard truncate - last resort.
 */
function hardTruncate(result, maxChars) {
  const content = result.content.map(part => {
    if (part.type !== 'text' || !part.text) return part;
    if (part.text.length <= maxChars) return part;

    const truncated = part.text.substring(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    return {
      ...part,
      text: truncated.substring(0, lastNewline > 0 ? lastNewline : maxChars) + '\n[Response truncated to fit budget]',
    };
  });

  return { ...result, content };
}

// --- Section parsing helpers ---

function parseSections(text) {
  const parts = text.split(/^(### .+)$/m);
  const sections = [];
  let currentName = null;
  let currentText = '';

  for (const part of parts) {
    const headerMatch = part.match(/^### (.+)$/);
    if (headerMatch) {
      if (currentName !== null || currentText) {
        sections.push({ name: currentName, text: currentText });
      }
      currentName = headerMatch[1];
      currentText = part;
    } else {
      currentText += part;
    }
  }
  if (currentName !== null || currentText) {
    sections.push({ name: currentName, text: currentText });
  }

  return sections;
}

function assembleSections(sections) {
  return sections.map(s => s.text).join('');
}

function getTextSize(result) {
  if (!result || !result.content) return 0;
  let size = 0;
  for (const part of result.content) {
    if (part.type === 'text' && part.text)
      size += part.text.length;
  }
  return size;
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

module.exports = {
  parseResponseBudget,
  enforceResponseBudget,
};
