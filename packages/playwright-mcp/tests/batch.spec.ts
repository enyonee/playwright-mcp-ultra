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

test('batch execute navigates and takes snapshot', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_batch_execute',
    arguments: {
      actions: [
        { tool: 'browser_navigate', arguments: { url: server.HELLO_WORLD } },
        { tool: 'browser_snapshot', arguments: {} },
      ],
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('Batch Execution Summary');
  expect(text).toContain('Steps: 2/2 executed');
  expect(text).toContain('Successful: 2');
  expect(text).toContain('Failed: 0');
  expect(text).toContain('browser_navigate [OK]');
  expect(text).toContain('browser_snapshot [OK]');
});

test('batch execute stops on error by default', async ({ client }) => {
  const result = await client.callTool({
    name: 'browser_batch_execute',
    arguments: {
      actions: [
        { tool: 'browser_navigate', arguments: { url: 'https://does-not-exist.invalid' } },
        { tool: 'browser_snapshot', arguments: {} },
      ],
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('Steps: 1/2 executed');
  expect(text).toContain('browser_navigate');
  expect(text).not.toContain('browser_snapshot [OK]');
});

test('batch execute continues on error when stopOnError is false', async ({ client }) => {
  const result = await client.callTool({
    name: 'browser_batch_execute',
    arguments: {
      actions: [
        { tool: 'browser_navigate', arguments: { url: 'https://does-not-exist.invalid' } },
        { tool: 'browser_snapshot', arguments: {} },
      ],
      stopOnError: false,
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('Steps: 2/2 executed');
});

test('batch rejects nested batch execute', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_batch_execute',
    arguments: {
      actions: [
        { tool: 'browser_navigate', arguments: { url: server.HELLO_WORLD } },
        { tool: 'browser_batch_execute', arguments: { actions: [{ tool: 'browser_snapshot' }] } },
      ],
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('Steps: 2/2 executed');
  expect(text).toContain('Successful: 1');
  expect(text).toContain('Failed: 1');
  expect(text).toContain('nested batch execute is not allowed');
});

test('batch execute single action', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_batch_execute',
    arguments: {
      actions: [
        { tool: 'browser_navigate', arguments: { url: server.HELLO_WORLD } },
      ],
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('Steps: 1/1 executed');
  expect(text).toContain('Successful: 1');
});
