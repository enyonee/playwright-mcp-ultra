/**
 * Expectations middleware for Playwright MCP.
 * Filters response sections based on client-specified expectations.
 * Pure proxy layer - does not modify playwright-core internals.
 *
 * Response format from playwright-core:
 *   ### Ran Playwright code
 *   ### Page
 *   ### Snapshot
 *   ### Result
 *   ### Error
 *   ### New console messages
 *   ### Modal state
 *   ### Downloads
 *   ### Open tabs
 */

// Section name -> expectation key mapping
const SECTION_TO_KEY = {
  'Ran Playwright code': 'includeCode',
  'Snapshot': 'includeSnapshot',
  'Page': 'includePage',
  'New console messages': 'includeConsole',
  'Modal state': 'includeModal',
  'Downloads': 'includeDownloads',
  'Open tabs': 'includeTabs',
};

// Sections that are NEVER filtered (core response)
const ALWAYS_INCLUDE = new Set(['Result', 'Error']);

// Optimized defaults: strip low-value sections that waste tokens.
// Code/Tabs/Downloads are almost never useful for AI agents.
// Agent can override: expectations: { includeCode: true }
const DEFAULT_EXPECTATIONS = {
  includeSnapshot: true,
  includeCode: false,
  includePage: true,
  includeConsole: true,
  includeModal: true,
  includeDownloads: false,
  includeTabs: false,
};

/**
 * JSON Schema for the expectations parameter (added to each tool).
 */
const EXPECTATIONS_JSON_SCHEMA = {
  type: 'object',
  description: 'Control which sections to include in the response. By default, low-value sections (code, tabs, downloads) are excluded. Set fields to true to include them.',
  properties: {
    includeSnapshot: {
      type: 'boolean',
      description: 'Include accessibility tree snapshot (default: true). Set false for intermediate steps.',
    },
    includeCode: {
      type: 'boolean',
      description: 'Include generated Playwright code (default: false). Rarely needed by AI agents.',
    },
    includePage: {
      type: 'boolean',
      description: 'Include page info - URL, console summary (default: true).',
    },
    includeConsole: {
      type: 'boolean',
      description: 'Include console messages (default: true).',
    },
    includeModal: {
      type: 'boolean',
      description: 'Include modal/dialog state (default: true).',
    },
    includeDownloads: {
      type: 'boolean',
      description: 'Include download info (default: false). Set true if monitoring downloads.',
    },
    includeTabs: {
      type: 'boolean',
      description: 'Include open tabs list (default: false). Set true for multi-tab workflows.',
    },
    diff: {
      type: 'boolean',
      description: 'Enable snapshot diff mode (default: false). Returns "[Snapshot unchanged]" if identical to previous, or a compact line diff showing only changes. Saves ~80% tokens on repeated snapshots.',
    },
  },
  additionalProperties: false,
};

/**
 * Extract expectations from tool arguments.
 * Returns clean args (without expectations) + merged expectations.
 */
function extractExpectations(args) {
  if (!args || typeof args !== 'object' || !args.expectations) {
    return { expectations: null, cleanArgs: args };
  }
  const { expectations: raw, ...cleanArgs } = args;
  const expectations = { ...DEFAULT_EXPECTATIONS };
  for (const key of Object.keys(DEFAULT_EXPECTATIONS)) {
    if (raw[key] === false)
      expectations[key] = false;
  }
  if (raw.diff === true)
    expectations.diff = true;
  return { expectations, cleanArgs };
}

/**
 * Apply expectations filter to a tool result.
 * Parses response text into sections, removes filtered ones, reassembles.
 */
function applyExpectations(result, expectations) {
  if (!expectations || !result || !result.content)
    return result;

  // Check if any filtering is needed (fast path)
  const hasFilter = Object.values(expectations).some(v => v === false);
  if (!hasFilter)
    return result;

  const filtered = result.content.map(part => {
    if (part.type !== 'text' || !part.text)
      return part;
    return { ...part, text: filterSections(part.text, expectations) };
  });

  return { ...result, content: filtered };
}

/**
 * Parse text into ### sections, filter, and reassemble.
 */
function filterSections(text, expectations) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(/^### (.+)$/);
    if (match) {
      if (current)
        sections.push(current);
      current = { name: match[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      // Text before any section header (rare, but preserve it)
      if (!sections.length)
        sections.push({ name: null, lines: [line] });
      else if (sections[sections.length - 1].name === null)
        sections[sections.length - 1].lines.push(line);
      else
        sections.push({ name: null, lines: [line] });
    }
  }
  if (current)
    sections.push(current);

  const result = [];
  for (const section of sections) {
    if (section.name === null || ALWAYS_INCLUDE.has(section.name)) {
      result.push(section.lines.join('\n'));
      continue;
    }
    const key = SECTION_TO_KEY[section.name];
    if (!key || expectations[key] !== false) {
      result.push(section.lines.join('\n'));
    }
  }

  return result.join('\n');
}

/**
 * Add expectations property to each browser_* tool's JSON Schema
 * in the ListTools response. Modifies tools array in place.
 */
function injectExpectationsSchema(tools) {
  for (const tool of tools) {
    if (!tool.name.startsWith('browser_'))
      continue;
    if (tool.name === 'browser_batch_execute')
      continue;
    if (!tool.inputSchema || !tool.inputSchema.properties)
      continue;

    tool.inputSchema.properties.expectations = EXPECTATIONS_JSON_SCHEMA;

    // Remove expectations from required (it's always optional)
    if (tool.inputSchema.required) {
      tool.inputSchema.required = tool.inputSchema.required.filter(r => r !== 'expectations');
    }

    // Allow additional properties since we're adding one
    // (playwright-core schemas have additionalProperties: false)
    if (tool.inputSchema.additionalProperties === false) {
      delete tool.inputSchema.additionalProperties;
    }
  }
}

module.exports = {
  extractExpectations,
  applyExpectations,
  injectExpectationsSchema,
  EXPECTATIONS_JSON_SCHEMA,
  DEFAULT_EXPECTATIONS,
};
