/**
 * Network and console result filters for Playwright MCP.
 * Post-processes tool responses to reduce token usage
 * by filtering results based on client-specified criteria.
 */

// --- Network filter ---

const NETWORK_FILTER_SCHEMA = {
  type: 'object',
  description: 'Filter network requests. Reduces token usage by showing only relevant entries.',
  properties: {
    urlPattern: {
      type: 'string',
      description: 'Regex pattern to include matching URLs only.',
    },
    excludeUrlPattern: {
      type: 'string',
      description: 'Regex pattern to exclude matching URLs.',
    },
    methods: {
      type: 'array',
      items: { type: 'string' },
      description: 'HTTP methods to include (e.g. ["GET", "POST"]).',
    },
    statusCodes: {
      type: 'string',
      description: 'Status code range, e.g. "400-599" for errors only.',
    },
    maxResults: {
      type: 'number',
      description: 'Maximum number of entries to return.',
    },
  },
  additionalProperties: false,
};

const CONSOLE_FILTER_SCHEMA = {
  type: 'object',
  description: 'Filter console messages. Reduces token usage by showing only relevant entries.',
  properties: {
    levels: {
      type: 'array',
      items: { type: 'string' },
      description: 'Levels to include: "LOG", "WARNING", "ERROR", "INFO".',
    },
    pattern: {
      type: 'string',
      description: 'Regex pattern to include matching messages only.',
    },
    excludePattern: {
      type: 'string',
      description: 'Regex pattern to exclude matching messages.',
    },
    deduplicate: {
      type: 'boolean',
      description: 'Remove duplicate messages (default: false).',
    },
    maxMessages: {
      type: 'number',
      description: 'Maximum number of messages to return (keeps latest).',
    },
  },
  additionalProperties: false,
};

/**
 * Extract filter parameter from tool args.
 * Returns clean args (without filter) + extracted filter.
 */
function extractFilter(args) {
  if (!args || typeof args !== 'object' || !args.filter)
    return { filter: null, cleanArgs: args };
  const { filter, ...cleanArgs } = args;
  return { filter, cleanArgs };
}

/**
 * Apply network filter to browser_network_requests result.
 * Response format: each line is "[METHOD] URL => [STATUS] details"
 */
function applyNetworkFilter(result, filter) {
  if (!filter || !result || !result.content)
    return result;

  const content = result.content.map(part => {
    if (part.type !== 'text' || !part.text)
      return part;
    return { ...part, text: filterNetworkText(part.text, filter) };
  });

  return { ...result, content };
}

function filterNetworkText(text, filter) {
  const sections = text.split(/^(### .+)$/m);
  const output = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (section.startsWith('### Result')) {
      output.push(section);
      // Next element is the result content
      if (i + 1 < sections.length) {
        const filtered = filterNetworkLines(sections[i + 1], filter);
        output.push(filtered);
        i++;
      }
    } else {
      output.push(section);
    }
  }

  return output.join('');
}

function filterNetworkLines(text, filter) {
  // Parse network lines: [METHOD] URL => [STATUS] details
  const lineRegex = /^\[([A-Z]+)\]\s+(\S+)\s+=>\s+\[([^\]]*)\]/;
  const lines = text.split('\n');
  let filtered = [];

  // Parse status code range
  let statusMin, statusMax;
  if (filter.statusCodes) {
    const range = filter.statusCodes.split('-');
    statusMin = parseInt(range[0], 10);
    statusMax = range.length > 1 ? parseInt(range[1], 10) : statusMin;
  }

  // Compile regex patterns once
  const urlRegex = filter.urlPattern ? safeRegex(filter.urlPattern) : null;
  const excludeRegex = filter.excludeUrlPattern ? safeRegex(filter.excludeUrlPattern) : null;
  const methodSet = filter.methods ? new Set(filter.methods.map(m => m.toUpperCase())) : null;

  for (const line of lines) {
    const match = line.match(lineRegex);
    if (!match) {
      filtered.push(line);
      continue;
    }

    const [, method, url, statusStr] = match;
    const status = parseInt(statusStr, 10);

    if (methodSet && !methodSet.has(method))
      continue;
    if (urlRegex && !urlRegex.test(url))
      continue;
    if (excludeRegex && excludeRegex.test(url))
      continue;
    if (statusMin !== undefined && !isNaN(status) && (status < statusMin || status > statusMax))
      continue;
    if (statusMin !== undefined && isNaN(status) && statusStr === 'FAILED')
      continue; // Skip failed requests when filtering by status

    filtered.push(line);
  }

  if (filter.maxResults && filtered.length > filter.maxResults)
    filtered = filtered.slice(-filter.maxResults);

  return filtered.join('\n');
}

/**
 * Apply console filter to browser_console_messages result.
 * Response format: "[LEVEL] message @ source:line"
 */
function applyConsoleFilter(result, filter) {
  if (!filter || !result || !result.content)
    return result;

  const content = result.content.map(part => {
    if (part.type !== 'text' || !part.text)
      return part;
    return { ...part, text: filterConsoleText(part.text, filter) };
  });

  return { ...result, content };
}

function filterConsoleText(text, filter) {
  const sections = text.split(/^(### .+)$/m);
  const output = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (section.startsWith('### Result')) {
      output.push(section);
      if (i + 1 < sections.length) {
        const filtered = filterConsoleLines(sections[i + 1], filter);
        output.push(filtered);
        i++;
      }
    } else {
      output.push(section);
    }
  }

  return output.join('');
}

function filterConsoleLines(text, filter) {
  // Parse console lines: [LEVEL] message @ source:line
  const lineRegex = /^\[([A-Z]+)\]\s+(.*)/;
  const lines = text.split('\n');

  // Compile patterns once
  const levelSet = filter.levels ? new Set(filter.levels.map(l => l.toUpperCase())) : null;
  const patternRegex = filter.pattern ? safeRegex(filter.pattern) : null;
  const excludeRegex = filter.excludePattern ? safeRegex(filter.excludePattern) : null;

  let filtered = [];
  const seen = new Set();

  for (const line of lines) {
    const match = line.match(lineRegex);
    if (!match) {
      // Header line (Total messages: ...) or empty - always include
      if (line.trim())
        filtered.push(line);
      continue;
    }

    const [, level, message] = match;

    if (levelSet && !levelSet.has(level))
      continue;
    if (patternRegex && !patternRegex.test(message))
      continue;
    if (excludeRegex && excludeRegex.test(message))
      continue;
    if (filter.deduplicate) {
      if (seen.has(line))
        continue;
      seen.add(line);
    }

    filtered.push(line);
  }

  if (filter.maxMessages && filtered.length > filter.maxMessages) {
    // Keep header + last N messages
    const header = filtered.filter(l => !l.match(lineRegex));
    const messages = filtered.filter(l => l.match(lineRegex));
    filtered = [...header, ...messages.slice(-filter.maxMessages)];
  }

  return '\n' + filtered.join('\n');
}

/**
 * Safely create a RegExp from user input, falling back to literal match.
 */
function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

/**
 * Inject filter parameter into specific tool schemas in ListTools response.
 */
function injectFilterSchemas(tools) {
  for (const tool of tools) {
    if (!tool.inputSchema || !tool.inputSchema.properties)
      continue;

    if (tool.name === 'browser_network_requests') {
      tool.inputSchema.properties.filter = NETWORK_FILTER_SCHEMA;
      if (tool.inputSchema.additionalProperties === false)
        delete tool.inputSchema.additionalProperties;
    }

    if (tool.name === 'browser_console_messages') {
      tool.inputSchema.properties.filter = CONSOLE_FILTER_SCHEMA;
      if (tool.inputSchema.additionalProperties === false)
        delete tool.inputSchema.additionalProperties;
    }
  }
}

module.exports = {
  extractFilter,
  applyNetworkFilter,
  applyConsoleFilter,
  injectFilterSchemas,
};
