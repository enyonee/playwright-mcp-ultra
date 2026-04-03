/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from './fixtures';

test('diff mode: first snapshot returns full content', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: { expectations: { diff: true } },
  });

  const text = result.content[0].text;
  // First snapshot is always full (no previous to diff against)
  expect(text).toContain('### Snapshot');
  expect(text).not.toContain('[Snapshot unchanged]');
  expect(text).not.toContain('[Snapshot diff');
});

test('diff mode: identical snapshot returns "[Snapshot unchanged]"', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  // First snapshot (establishes baseline)
  await client.callTool({
    name: 'browser_snapshot',
    arguments: { expectations: { diff: true } },
  });

  // Second snapshot (should be identical)
  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: { expectations: { diff: true } },
  });

  const text = result.content[0].text;
  expect(text).toContain('[Snapshot unchanged]');
});

test('diff mode: changed snapshot returns diff', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<h1>Title</h1><p>Original</p>' },
  });

  // Baseline
  await client.callTool({
    name: 'browser_snapshot',
    arguments: { expectations: { diff: true } },
  });

  // Navigate to a different page to change the snapshot
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<h1>Title</h1><p>Changed</p><button>Click</button>' },
  });

  // Diff should show the change
  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: { expectations: { diff: true } },
  });

  const text = result.content[0].text;
  expect(text).toContain('[Snapshot diff');
});

test('diff mode disabled by default (full snapshot always)', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  // Two identical snapshots without diff mode
  await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const result = await client.callTool({ name: 'browser_snapshot', arguments: {} });

  const text = result.content[0].text;
  expect(text).not.toContain('[Snapshot unchanged]');
  expect(text).toContain('### Snapshot');
});
