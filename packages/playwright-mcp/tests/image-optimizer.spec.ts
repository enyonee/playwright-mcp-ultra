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

test('imageOptions schema appears on browser_take_screenshot', async ({ client }) => {
  const { tools } = await client.listTools();

  const screenshot = tools.find(t => t.name === 'browser_take_screenshot');
  expect(screenshot!.inputSchema.properties.imageOptions).toBeTruthy();
  expect(screenshot!.inputSchema.properties.imageOptions.properties.quality).toBeTruthy();
  expect(screenshot!.inputSchema.properties.imageOptions.properties.maxWidth).toBeTruthy();

  // Other tools should NOT have imageOptions
  const snapshot = tools.find(t => t.name === 'browser_snapshot');
  expect(snapshot!.inputSchema.properties.imageOptions).toBeFalsy();
});

test('imageOptions quality produces JPEG output', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  // JPEG quality 30 screenshot
  const jpegResult = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: { imageOptions: { quality: 30 } },
  });

  const jpegImage = jpegResult.content.find((p: any) => p.type === 'image');
  expect(jpegImage).toBeTruthy();
  expect(jpegImage.mimeType).toBe('image/jpeg');

  // Verify it's actual JPEG data (starts with /9j in base64 = FF D8 magic bytes)
  expect(jpegImage.data.startsWith('/9j')).toBe(true);
});

test('imageOptions maxWidth resizes screenshot', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  // Resized to 200px wide, JPEG to verify dimensions via decode
  const smallResult = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: { imageOptions: { maxWidth: 200, quality: 80 } },
  });

  const smallImage = smallResult.content.find((p: any) => p.type === 'image');
  expect(smallImage).toBeTruthy();
  expect(smallImage.mimeType).toBe('image/jpeg');

  // Decode JPEG and check width
  const jpegjs = require('playwright-core/lib/utilsBundle').jpegjs;
  const buf = Buffer.from(smallImage.data, 'base64');
  const decoded = jpegjs.decode(buf, { maxMemoryUsageInMB: 512 });
  expect(decoded.width).toBeLessThanOrEqual(200);
});

test('screenshot without imageOptions works normally', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const result = await client.callTool({
    name: 'browser_take_screenshot',
    arguments: {},
  });

  const image = result.content.find((p: any) => p.type === 'image');
  expect(image).toBeTruthy();
  expect(image.mimeType).toBe('image/png');
});
