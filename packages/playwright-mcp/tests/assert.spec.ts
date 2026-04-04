/**
 * Tests for browser_assert tool.
 */

import { test, expect } from './fixtures';

test('assert: text_visible passes when text exists', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const result = await client.callTool({
    name: 'browser_assert',
    arguments: {
      assertions: [
        { type: 'text_visible', text: 'Hello' },
      ],
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('ALL PASSED');
  expect(text).toContain('[PASS]');
});

test('assert: text_visible fails when text missing', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const result = await client.callTool({
    name: 'browser_assert',
    arguments: {
      assertions: [
        { type: 'text_visible', text: 'NonexistentText12345' },
      ],
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('FAILED');
  expect(text).toContain('[FAIL]');
});

test('assert: url_contains checks current URL', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const result = await client.callTool({
    name: 'browser_assert',
    arguments: {
      assertions: [
        { type: 'url_contains', value: 'hello' },
      ],
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('[PASS]');
});

test('assert: element_exists with CSS selector', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<button id="test-btn">Click</button><input type="text"/>' },
  });

  const result = await client.callTool({
    name: 'browser_assert',
    arguments: {
      assertions: [
        { type: 'element_exists', selector: '#test-btn' },
        { type: 'element_exists', selector: 'input[type="text"]' },
        { type: 'element_not_exists', selector: '#nonexistent' },
      ],
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('ALL PASSED');
  expect(text).toContain('3/3');
});

test('assert: element_count with min/max', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<ul><li>A</li><li>B</li><li>C</li></ul>' },
  });

  const result = await client.callTool({
    name: 'browser_assert',
    arguments: {
      assertions: [
        { type: 'element_count', selector: 'li', count: 3 },
        { type: 'element_count', selector: 'li', min: 2, max: 5 },
      ],
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('ALL PASSED');
});

test('assert: multiple mixed assertions with stopOnFailure', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const result = await client.callTool({
    name: 'browser_assert',
    arguments: {
      assertions: [
        { type: 'text_visible', text: 'Hello' },
        { type: 'text_visible', text: 'NONEXISTENT' },
        { type: 'url_contains', value: 'hello' },
      ],
      stopOnFailure: true,
    },
  });

  const text = result.content[0].text;
  // Should stop after second assertion fails
  expect(text).toContain('FAILED');
  expect(text).toContain('1/2');
});

test('assert: response is compact (under 500 chars)', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const result = await client.callTool({
    name: 'browser_assert',
    arguments: {
      assertions: [
        { type: 'text_visible', text: 'Hello' },
        { type: 'url_contains', value: 'hello' },
      ],
    },
  });

  const text = result.content[0].text;
  // Assert response should be much smaller than a full snapshot
  expect(text.length).toBeLessThan(500);
});
