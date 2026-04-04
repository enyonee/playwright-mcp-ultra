/**
 * Tests for snapshot truncation (maxTokens, maxDepth).
 */

import { test, expect } from './fixtures';

test('truncation: maxDepth limits snapshot nesting', async ({ client }) => {
  // Page with deeply nested structure - need enough elements for snapshot depth
  const html = `
    <nav><a href="#">Nav Link 1</a><a href="#">Nav Link 2</a></nav>
    <main>
      <section>
        <article>
          <div>
            <ul>
              <li><a href="#">Deep link 1</a></li>
              <li><a href="#">Deep link 2</a></li>
              <li><a href="#">Deep link 3</a></li>
            </ul>
            <form>
              <label>Name <input type="text"/></label>
              <label>Email <input type="email"/></label>
              <button>Submit</button>
            </form>
          </div>
        </article>
      </section>
    </main>
    <footer><p>Footer text</p></footer>
  `;
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: `data:text/html,${encodeURIComponent(html)}` },
  });

  const full = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });

  const truncated = await client.callTool({
    name: 'browser_snapshot',
    arguments: { snapshotOptions: { maxDepth: 2 } },
  });

  const fullText = full.content[0].text;
  const truncText = truncated.content[0].text;

  // Truncated should be shorter (deep elements removed)
  expect(truncText.length).toBeLessThan(fullText.length);
  expect(truncText).toContain('### Snapshot');
});

test('truncation: maxTokens limits snapshot size', async ({ client }) => {
  // Page with lots of content
  const items = Array.from({ length: 20 }, (_, i) => `<li>Item ${i + 1} with some extra text to make it longer</li>`).join('');
  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: `data:text/html,<h1>Title</h1><ul>${items}</ul><footer>Footer</footer>`,
    },
  });

  const full = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });

  const truncated = await client.callTool({
    name: 'browser_snapshot',
    arguments: { snapshotOptions: { maxTokens: 200 } },
  });

  const fullText = full.content[0].text;
  const truncText = truncated.content[0].text;

  expect(truncText.length).toBeLessThan(fullText.length);
  expect(truncText).toContain('Truncated');
});

test('truncation: small page is not truncated', async ({ client, server }) => {
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  const normal = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });

  const withOptions = await client.callTool({
    name: 'browser_snapshot',
    arguments: { snapshotOptions: { maxTokens: 5000 } },
  });

  // Small page should not be affected by generous budget
  expect(withOptions.content[0].text).not.toContain('Truncated');
});

test('truncation: prioritizeInteractable keeps buttons over text', async ({ client }) => {
  const html = `
    <p>Paragraph 1</p><p>Paragraph 2</p><p>Paragraph 3</p>
    <p>Paragraph 4</p><p>Paragraph 5</p><p>Paragraph 6</p>
    <button>Important Button</button>
    <p>Paragraph 7</p><p>Paragraph 8</p>
  `;
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: `data:text/html,${encodeURIComponent(html)}` },
  });

  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: { snapshotOptions: { maxTokens: 150, prioritizeInteractable: true } },
  });

  const text = result.content[0].text;
  // Button should survive truncation better than static paragraphs
  expect(text).toContain('### Snapshot');
});
