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

// --- Console filter tests ---

test('console filter: filter by level', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<script>console.log("info");console.warn("warn");console.error("err")</script>' },
  });

  const result = await client.callTool({
    name: 'browser_console_messages',
    arguments: { filter: { levels: ['ERROR'] } },
  });

  const text = result.content[0].text;
  expect(text).toContain('[ERROR] err');
  expect(text).not.toContain('[LOG] info');
  expect(text).not.toContain('[WARNING] warn');
});

test('console filter: pattern matching', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<script>console.log("auth token ok");console.log("fetching data");console.log("auth failed")</script>' },
  });

  const result = await client.callTool({
    name: 'browser_console_messages',
    arguments: { filter: { pattern: 'auth' } },
  });

  const text = result.content[0].text;
  expect(text).toContain('auth token ok');
  expect(text).toContain('auth failed');
  expect(text).not.toContain('fetching data');
});

test('console filter: maxMessages keeps latest', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<script>for(let i=0;i<10;i++)console.log("msg"+i)</script>' },
  });

  const result = await client.callTool({
    name: 'browser_console_messages',
    arguments: { filter: { maxMessages: 3 } },
  });

  const text = result.content[0].text;
  expect(text).toContain('msg9');
  expect(text).toContain('msg8');
  expect(text).toContain('msg7');
  expect(text).not.toContain('msg0');
});

test('console filter: no filter = full results', async ({ client }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<script>console.log("a");console.warn("b")</script>' },
  });

  const result = await client.callTool({
    name: 'browser_console_messages',
    arguments: {},
  });

  const text = result.content[0].text;
  expect(text).toContain('[LOG] a');
  expect(text).toContain('[WARNING] b');
});

// --- Filter schema injection tests ---

test('filter schema appears on network and console tools', async ({ client }) => {
  const { tools } = await client.listTools();

  const network = tools.find(t => t.name === 'browser_network_requests');
  expect(network!.inputSchema.properties.filter).toBeTruthy();
  expect(network!.inputSchema.properties.filter.properties.urlPattern).toBeTruthy();
  expect(network!.inputSchema.properties.filter.properties.statusCodes).toBeTruthy();

  const console = tools.find(t => t.name === 'browser_console_messages');
  expect(console!.inputSchema.properties.filter).toBeTruthy();
  expect(console!.inputSchema.properties.filter.properties.levels).toBeTruthy();
  expect(console!.inputSchema.properties.filter.properties.pattern).toBeTruthy();

  // Other tools should NOT have filter
  const click = tools.find(t => t.name === 'browser_click');
  expect(click!.inputSchema.properties.filter).toBeFalsy();
});
