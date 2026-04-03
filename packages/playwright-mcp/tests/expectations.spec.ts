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

test('expectations schema appears in tool list', async ({ client }) => {
  const { tools } = await client.listTools();
  const navigate = tools.find(t => t.name === 'browser_navigate');
  expect(navigate).toBeTruthy();
  expect(navigate!.inputSchema.properties.expectations).toBeTruthy();
  expect(navigate!.inputSchema.properties.expectations.properties.includeSnapshot).toBeTruthy();
  expect(navigate!.inputSchema.properties.expectations.properties.includeCode).toBeTruthy();

  // batch_execute should NOT have expectations injected (has defaultExpectations instead)
  const batch = tools.find(t => t.name === 'browser_batch_execute');
  expect(batch!.inputSchema.properties.expectations).toBeFalsy();
});

test('includeCode: false removes Ran Playwright code section', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.HELLO_WORLD,
      expectations: { includeCode: false },
    },
  });

  const text = result.content[0].text;
  expect(text).not.toContain('### Ran Playwright code');
  expect(text).toContain('### Page');
  expect(text).toContain('### Snapshot');
});

test('includeSnapshot: false removes Snapshot section', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.HELLO_WORLD,
      expectations: { includeSnapshot: false },
    },
  });

  const text = result.content[0].text;
  expect(text).not.toContain('### Snapshot');
  expect(text).toContain('### Ran Playwright code');
});

test('multiple expectations combined', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.HELLO_WORLD,
      expectations: { includeSnapshot: false, includeCode: false },
    },
  });

  const text = result.content[0].text;
  expect(text).not.toContain('### Snapshot');
  expect(text).not.toContain('### Ran Playwright code');
  expect(text).toContain('### Page');
});

test('no expectations = full response (backwards compatible)', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  const text = result.content[0].text;
  expect(text).toContain('### Ran Playwright code');
  expect(text).toContain('### Snapshot');
  expect(text).toContain('### Page');
});

test('includePage: false removes Page section', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.HELLO_WORLD,
      expectations: { includePage: false },
    },
  });

  const text = result.content[0].text;
  expect(text).not.toContain('### Page');
  expect(text).toContain('### Snapshot');
});

test('Result and Error sections are never filtered', async ({ client }) => {
  // browser_network_requests returns a ### Result section
  const result = await client.callTool({
    name: 'browser_network_requests',
    arguments: {
      expectations: { includeSnapshot: false, includeCode: false, includePage: false },
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('### Result');
});

test('batch defaultExpectations applies to all steps', async ({ client, server }) => {
  const result = await client.callTool({
    name: 'browser_batch_execute',
    arguments: {
      actions: [
        { tool: 'browser_navigate', arguments: { url: server.HELLO_WORLD } },
        { tool: 'browser_snapshot', arguments: {} },
      ],
      defaultExpectations: { includeCode: false },
    },
  });

  const text = result.content[0].text;
  expect(text).toContain('Batch Execution Summary');
  expect(text).not.toContain('Ran Playwright code');
});
