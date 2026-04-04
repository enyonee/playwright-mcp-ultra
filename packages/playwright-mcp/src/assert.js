/**
 * browser_assert tool for Playwright MCP.
 * Runs assertions against the current page state and returns
 * compact pass/fail results instead of full snapshots.
 *
 * Token savings: ~90% vs snapshot + AI parsing for simple checks.
 * One tool call replaces: snapshot -> parse -> verify chain.
 */

const { z } = require('playwright-core/lib/zodBundle');

const ASSERT_INPUT_SCHEMA = z.object({
  assertions: z.array(z.object({
    type: z.enum([
      'text_visible',
      'text_not_visible',
      'element_exists',
      'element_not_exists',
      'element_count',
      'url_contains',
      'url_equals',
      'title_contains',
      'title_equals',
      'element_text',
      'element_attribute',
      'element_visible',
      'element_enabled',
      'element_checked',
    ]).describe('Assertion type'),
    text: z.string().optional().describe('Text to check (for text_visible, text_not_visible, element_text)'),
    selector: z.string().optional().describe('CSS selector or ARIA role (for element_* assertions)'),
    value: z.string().optional().describe('Expected value (for url_*, title_*, element_text, element_attribute)'),
    attribute: z.string().optional().describe('Attribute name (for element_attribute)'),
    min: z.number().optional().describe('Min count (for element_count)'),
    max: z.number().optional().describe('Max count (for element_count)'),
    count: z.number().optional().describe('Exact count (for element_count)'),
  })).min(1).max(20).describe('Assertions to run against current page state'),
  stopOnFailure: z.boolean().optional().default(false)
    .describe('Stop on first failed assertion (default: false, run all)'),
  timeout: z.number().optional().default(5000)
    .describe('Timeout per assertion in ms (default: 5000)'),
});

const ASSERT_TOOL_SCHEMA = {
  name: 'browser_assert',
  title: 'Assert Page State',
  description: 'Run assertions against the current page. Returns compact pass/fail results (~50 tokens) ' +
    'instead of requiring a full snapshot (~3000 tokens) for verification. ' +
    'Use for checking: text visible, element exists/count, URL, title, attributes, visibility, enabled state.',
  type: 'readOnly',
  inputSchema: ASSERT_INPUT_SCHEMA,
};

/**
 * Execute assertions against the current page via evaluate.
 * @param {object} backend - BrowserBackend instance
 * @param {object} params - Tool parameters
 * @returns {object} MCP tool result
 */
async function executeAssert(backend, params) {
  const assertions = params.assertions || [];
  const stopOnFailure = params.stopOnFailure === true;
  const timeout = params.timeout || 5000;
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const assertion of assertions) {
    try {
      const result = await runSingleAssertion(backend, assertion, timeout);
      results.push(result);
      if (result.passed) passed++;
      else {
        failed++;
        if (stopOnFailure) break;
      }
    } catch (error) {
      const result = { type: assertion.type, passed: false, message: `Error: ${error.message}` };
      results.push(result);
      failed++;
      if (stopOnFailure) break;
    }
  }

  return formatAssertResult(results, passed, failed);
}

async function runSingleAssertion(backend, assertion, timeout) {
  const { type } = assertion;

  // URL/title - через evaluate
  if (type === 'url_contains' || type === 'url_equals' ||
      type === 'title_contains' || type === 'title_equals') {
    return runPagePropertyAssertion(backend, assertion, timeout);
  }

  // Text visibility
  if (type === 'text_visible' || type === 'text_not_visible') {
    return runTextAssertion(backend, assertion, timeout);
  }

  // Element-based
  return runElementAssertion(backend, assertion, timeout);
}

async function runPagePropertyAssertion(backend, assertion, timeout) {
  const { type, value } = assertion;

  // Используем browser_evaluate чтобы получить URL/title
  const fnBody = type.startsWith('url_')
    ? 'return window.location.href;'
    : 'return document.title;';

  const result = await backend.callTool('browser_evaluate', {
    function: `() => { ${fnBody} }`,
  }, () => {});

  const actual = extractEvaluateResult(result);

  if (type === 'url_contains' || type === 'title_contains') {
    const pass = actual.includes(value || '');
    return { type, passed: pass, expected: value, actual,
      message: pass ? `Contains "${value}"` : `"${actual}" does not contain "${value}"` };
  }

  const pass = actual === (value || '');
  return { type, passed: pass, expected: value, actual,
    message: pass ? 'Match' : `Expected "${value}", got "${actual}"` };
}

async function runTextAssertion(backend, assertion, timeout) {
  const { type, text } = assertion;
  const negate = type === 'text_not_visible';
  const escaped = JSON.stringify(text || '');

  const result = await backend.callTool('browser_evaluate', {
    function: `() => {
      const text = ${escaped};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.includes(text)) {
          const el = walker.currentNode.parentElement;
          if (!el) continue;
          const style = getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') return true;
        }
      }
      return false;
    }`,
  }, () => {});

  const found = extractEvaluateResult(result) === 'true';
  const pass = negate ? !found : found;

  return { type, passed: pass, text,
    message: pass ? (negate ? 'Text not found (expected)' : 'Text found')
      : (negate ? `Text "${text}" unexpectedly visible` : `Text "${text}" not found`) };
}

async function runElementAssertion(backend, assertion, timeout) {
  const { type, selector, value, attribute, min, max, count } = assertion;
  if (!selector)
    return { type, passed: false, message: 'Missing selector' };

  const escapedSelector = JSON.stringify(selector);
  const escapedAttr = JSON.stringify(attribute || '');

  const result = await backend.callTool('browser_evaluate', {
    function: `() => {
      const sel = ${escapedSelector};
      const attrName = ${escapedAttr};
      const els = document.querySelectorAll(sel);
      const first = els[0];
      return JSON.stringify({
        count: els.length,
        exists: els.length > 0,
        visible: first ? getComputedStyle(first).display !== 'none' && getComputedStyle(first).visibility !== 'hidden' : false,
        enabled: first ? !first.disabled : false,
        checked: first ? !!first.checked : false,
        text: first ? (first.textContent || '').trim().slice(0, 500) : '',
        attr: first && attrName ? first.getAttribute(attrName) : null,
      });
    }`,
  }, () => {});

  const data = extractEvaluateResultParsed(result);
  if (!data || typeof data !== 'object') {
    return { type, passed: false, selector, message: 'Failed to evaluate selector' };
  }

  switch (type) {
    case 'element_exists':
      return { type, passed: data.exists, selector, count: data.count,
        message: data.exists ? `Found (${data.count})` : 'Not found' };

    case 'element_not_exists':
      return { type, passed: !data.exists, selector,
        message: data.exists ? `Unexpectedly found (${data.count})` : 'Not found (expected)' };

    case 'element_count': {
      let pass = true;
      if (count !== undefined) pass = data.count === count;
      else {
        if (min !== undefined && data.count < min) pass = false;
        if (max !== undefined && data.count > max) pass = false;
      }
      return { type, passed: pass, selector, actual: data.count,
        expected: count !== undefined ? count : `${min || 0}-${max || 'inf'}`,
        message: pass ? `Count: ${data.count}` : `Count ${data.count} outside expected range` };
    }

    case 'element_text': {
      const pass = data.text.includes(value || '');
      return { type, passed: pass, selector, actual: data.text.slice(0, 100),
        message: pass ? 'Text matches' : `Text "${data.text.slice(0, 50)}" doesn't contain "${value}"` };
    }

    case 'element_attribute': {
      const pass = data.attr === value;
      return { type, passed: pass, selector, attribute, actual: data.attr,
        message: pass ? 'Attribute matches' : `Attribute "${attribute}" is "${data.attr}", expected "${value}"` };
    }

    case 'element_visible':
      return { type, passed: data.visible, selector,
        message: data.visible ? 'Visible' : 'Not visible' };

    case 'element_enabled':
      return { type, passed: data.enabled, selector,
        message: data.enabled ? 'Enabled' : 'Disabled' };

    case 'element_checked':
      return { type, passed: data.checked, selector,
        message: data.checked ? 'Checked' : 'Not checked' };

    default:
      return { type, passed: false, message: `Unknown assertion type: ${type}` };
  }
}

function extractEvaluateResult(result) {
  if (!result || !result.content) return '';
  for (const part of result.content) {
    if (part.type === 'text' && part.text) {
      const match = part.text.match(/### Result\n([\s\S]*?)(?=\n### |\s*$)/);
      if (match) {
        let val = match[1].trim();
        // evaluate wraps return values as JSON literals:
        // string -> "value", object -> "{...}", boolean -> true/false
        // Try JSON.parse to unwrap
        try {
          val = JSON.parse(val);
        } catch {
          // not JSON - return raw
        }
        return typeof val === 'string' ? val : String(val);
      }
      return part.text.trim();
    }
  }
  return '';
}

/**
 * Extract evaluate result as parsed object (for JSON.stringify results).
 */
function extractEvaluateResultParsed(result) {
  if (!result || !result.content) return null;
  for (const part of result.content) {
    if (part.type === 'text' && part.text) {
      const match = part.text.match(/### Result\n([\s\S]*?)(?=\n### |\s*$)/);
      if (match) {
        try {
          // Double-parse: evaluate wraps strings in quotes, and our JSON.stringify is inside
          let val = JSON.parse(match[1].trim());
          if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch {}
          }
          return val;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function formatAssertResult(results, passed, failed) {
  const allPassed = failed === 0;
  const lines = [`## Assertions: ${allPassed ? 'ALL PASSED' : 'FAILED'} (${passed}/${passed + failed})`];

  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL';
    lines.push(`[${icon}] ${r.type}: ${r.message}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: false,
  };
}

function assertToolMcpSchema() {
  const { z } = require('playwright-core/lib/zodBundle');
  return {
    name: ASSERT_TOOL_SCHEMA.name,
    description: ASSERT_TOOL_SCHEMA.description,
    inputSchema: z.toJSONSchema(ASSERT_INPUT_SCHEMA),
    annotations: {
      title: ASSERT_TOOL_SCHEMA.title,
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  };
}

module.exports = { executeAssert, assertToolMcpSchema, ASSERT_TOOL_SCHEMA };
