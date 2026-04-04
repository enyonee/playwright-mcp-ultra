/**
 * Tests for browser_session_context tool.
 */

import { test, expect } from './fixtures';

test('session context: returns summary after actions', async ({ client, server }) => {
  // Perform several actions
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  await client.callTool({ name: 'browser_snapshot', arguments: {} });

  const result = await client.callTool({
    name: 'browser_session_context',
    arguments: {},
  });

  const text = result.content[0].text;
  expect(text).toContain('Session Context');
  expect(text).toContain('URL:');
  expect(text).toContain('Recent Actions');
  expect(text).toContain('navigate');
});

test('session context: is compact (under 500 chars)', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  await client.callTool({ name: 'browser_snapshot', arguments: {} });
  await client.callTool({ name: 'browser_snapshot', arguments: {} });

  const result = await client.callTool({
    name: 'browser_session_context',
    arguments: {},
  });

  const text = result.content[0].text;
  expect(text.length).toBeLessThan(800);
});

test('session context: tracks multiple navigations', async ({ client, server }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<h1>Page 1</h1>' },
  });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<h1>Page 2</h1>' },
  });

  const result = await client.callTool({
    name: 'browser_session_context',
    arguments: {},
  });

  const text = result.content[0].text;
  expect(text).toContain('Actions: 2 total');
});

test('session context: empty session', async ({ client }) => {
  const result = await client.callTool({
    name: 'browser_session_context',
    arguments: {},
  });

  const text = result.content[0].text;
  expect(text).toContain('No actions recorded');
});
