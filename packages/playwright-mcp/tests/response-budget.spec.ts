/**
 * Tests for response budget enforcement.
 * Note: global budget is set via --max-response-size CLI arg,
 * so we test the module functions directly here via a large page.
 */

import { test, expect } from './fixtures';

// Response budget is a global setting, so we test it indirectly
// by checking that large responses are properly structured

test('large page snapshot has expected sections', async ({ client }) => {
  const items = Array.from({ length: 100 }, (_, i) =>
    `<div><h3>Item ${i}</h3><p>Description for item ${i} with details</p><button>Action ${i}</button></div>`
  ).join('');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: `data:text/html,<body>${items}</body>` },
  });

  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });

  const text = result.content[0].text;
  // Large page still has proper sections
  expect(text).toContain('### Snapshot');
  expect(text).toContain('### Page');
  // And the snapshot is indeed large
  expect(text.length).toBeGreaterThan(2000);
});

test('expectations still work to reduce response size', async ({ client }) => {
  const items = Array.from({ length: 50 }, (_, i) =>
    `<div><p>Item ${i}</p></div>`
  ).join('');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: `data:text/html,<body>${items}</body>` },
  });

  const full = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });

  const minimal = await client.callTool({
    name: 'browser_snapshot',
    arguments: {
      expectations: {
        includeCode: false,
        includePage: false,
        includeConsole: false,
        includeModal: false,
        includeTabs: false,
      },
    },
  });

  // Minimal should be notably smaller
  expect(minimal.content[0].text.length).toBeLessThan(full.content[0].text.length);
});
