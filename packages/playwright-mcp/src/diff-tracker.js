/**
 * Snapshot diff tracker for Playwright MCP.
 * Tracks previous snapshot per backend instance and returns
 * either "[Snapshot unchanged]" or a compact line diff.
 *
 * Token savings: ~80% on identical snapshots (most common case),
 * ~50-70% on small changes (only diff lines returned).
 */

const crypto = require('crypto');

// Per-backend state. WeakMap so backends can be GC'd normally.
const stateMap = new WeakMap();

function getState(backend) {
  if (!stateMap.has(backend))
    stateMap.set(backend, { hash: null, lines: null });
  return stateMap.get(backend);
}

/**
 * Process a tool result, replacing the Snapshot section with a diff
 * if the client opted in via expectations.diff = true.
 *
 * @param {object} backend - BrowserBackend instance (used as state key)
 * @param {object} result - MCP tool result { content, isError }
 * @param {boolean} diffEnabled - whether diff mode is on
 * @returns {object} result with snapshot section replaced (or unchanged)
 */
function applySnapshotDiff(backend, result, diffEnabled) {
  if (!result || !result.content)
    return result;

  // Fast check: any text part with snapshot?
  let hasSnapshot = false;
  for (const part of result.content) {
    if (part.type === 'text' && part.text && part.text.indexOf('### Snapshot') !== -1) {
      hasSnapshot = true;
      break;
    }
  }
  if (!hasSnapshot) return result;

  let changed = false;
  const content = result.content.map(part => {
    if (part.type !== 'text' || !part.text)
      return part;

    const snapshotContent = extractSnapshotContent(part.text);
    if (!snapshotContent)
      return part;

    const state = getState(backend);
    const hash = crypto.createHash('sha256').update(snapshotContent).digest('hex');

    if (!diffEnabled)
      return part;

    if (state.hash === hash) {
      changed = true;
      return { ...part, text: replaceSnapshot(part.text, '[Snapshot unchanged]') };
    }

    if (state.lines !== null) {
      const newLines = snapshotContent.split('\n');
      const diffText = formatLineDiff(state.lines, newLines);
      state.hash = hash;
      state.lines = newLines;
      changed = true;
      return { ...part, text: replaceSnapshot(part.text, diffText) };
    }

    state.hash = hash;
    state.lines = snapshotContent.split('\n');
    return part;
  });

  // Avoid allocating new result object if nothing changed
  return changed ? { ...result, content } : result;
}

/**
 * Extract the content of the ### Snapshot section from response text.
 */
function extractSnapshotContent(text) {
  const match = text.match(/### Snapshot\n([\s\S]*?)(?=\n### |\s*$)/);
  return match ? match[1] : null;
}

/**
 * Replace the ### Snapshot section content in response text.
 */
function replaceSnapshot(text, newContent) {
  return text.replace(
    /(### Snapshot\n)([\s\S]*?)(?=\n### |\s*$)/,
    `$1${newContent}`
  );
}

/**
 * Simple line-by-line diff. Produces compact output:
 * - removed lines prefixed with "- "
 * - added lines prefixed with "+ "
 * - unchanged lines omitted (with count summary)
 *
 * Handles accessibility trees well because structure is stable
 * and changes are usually localized.
 */
function formatLineDiff(oldLines, newLines) {
  const maxLen = Math.max(oldLines.length, newLines.length);
  const output = [];
  let unchanged = 0;
  let added = 0;
  let removed = 0;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) {
      unchanged++;
      continue;
    }

    if (oldLine !== undefined && newLine !== undefined) {
      output.push(`- ${oldLine}`);
      output.push(`+ ${newLine}`);
      removed++;
      added++;
    } else if (oldLine !== undefined) {
      output.push(`- ${oldLine}`);
      removed++;
    } else {
      output.push(`+ ${newLine}`);
      added++;
    }
  }

  if (output.length === 0)
    return '[Snapshot unchanged]';

  const header = `[Snapshot diff: ${added} added, ${removed} removed, ${unchanged} unchanged]`;
  return `${header}\n${output.join('\n')}`;
}

module.exports = { applySnapshotDiff };
