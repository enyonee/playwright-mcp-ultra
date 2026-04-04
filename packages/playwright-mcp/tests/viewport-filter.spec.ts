/**
 * Tests for viewport-only snapshot filtering.
 */

import { test, expect } from './fixtures';

test('viewportOnly: reduces snapshot size on long pages', async ({ client }) => {
  // Long page with many items
  const items = Array.from({ length: 50 }, (_, i) =>
    `<div><h2>Section ${i + 1}</h2><p>Content for section ${i + 1} with some details</p></div>`
  ).join('');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: `data:text/html,<body>${items}</body>` },
  });

  const full = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });

  const filtered = await client.callTool({
    name: 'browser_snapshot',
    arguments: { viewportOnly: true },
  });

  const fullText = full.content[0].text;
  const filteredText = filtered.content[0].text;

  // Filtered should be smaller
  expect(filteredText.length).toBeLessThan(fullText.length);
  expect(filteredText).toContain('### Snapshot');
  expect(filteredText).toContain('Below viewport');
});

test('viewportOnly: small page not affected', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const full = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });

  const filtered = await client.callTool({
    name: 'browser_snapshot',
    arguments: { viewportOnly: true },
  });

  // Small page should not have viewport truncation marker
  expect(filtered.content[0].text).not.toContain('Below viewport');
});

test('viewportOnly: preserves snapshot section structure', async ({ client }) => {
  const items = Array.from({ length: 30 }, (_, i) =>
    `<p>Paragraph ${i + 1}</p>`
  ).join('');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: `data:text/html,<h1>Title</h1>${items}` },
  });

  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: { viewportOnly: true },
  });

  const text = result.content[0].text;
  expect(text).toContain('### Snapshot');
  // Other sections should still be present
  expect(text).toContain('### Page');
});
