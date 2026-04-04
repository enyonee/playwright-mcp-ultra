# CertiK Skynet - Security Analysis Recipe

Парсинг security-профиля криптопроекта на skynet.certik.com.
Демонстрирует все оптимизации: expectations, snapshot compactor, image optimization, evaluate parsing.

## Особенности сайта

- Тяжёлый SPA (React + HeadlessUI), hydration ~2-3s
- Cookie consent popup при первом визите (триггерит re-render)
- Combobox-поиск с API debounce
- Radar chart в SVG (данные не в DOM текстом)
- Много секций с lazy loading при скролле

## Рецепт: поиск Ethereum + полный парсинг

### Шаг 1: Навигация + dismiss cookie consent

```json
{
  "tool": "browser_batch_execute",
  "arguments": {
    "actions": [
      {
        "action": "navigate",
        "url": "https://skynet.certik.com/"
      },
      {
        "action": "click",
        "element": "Accept cookies button",
        "ref": "FIND_BY_TEXT:Accept"
      }
    ]
  }
}
```

### Шаг 2: Прямая навигация к проекту

Combobox-поиск медленный (API debounce + HeadlessUI re-render). Прямой URL быстрее:

```json
{
  "tool": "browser_navigate",
  "arguments": {
    "url": "https://skynet.certik.com/projects/ethereum"
  }
}
```

### Шаг 3: Парсинг основных метрик через evaluate

```json
{
  "tool": "browser_evaluate",
  "arguments": {
    "expectations": { "includeSnapshot": false },
    "function": "() => { const body = document.body.innerText; return JSON.stringify({ skynetScore: (body.match(/[\\d\\.]+\\s*AAA/) || [''])[0], price: (body.match(/\\$[\\d,]+\\.\\d{2}/) || [''])[0], marketCap: (body.match(/Mcap[\\s\\S]*?\\$([\\d\\.]+[BMK])/) || ['',''])[1], volume: (body.match(/Vol[\\s\\S]*?\\$([\\d\\.]+[BMK])/) || ['',''])[1], certikAudit: body.includes('CertiK Audit') && body.includes('No') ? 'No' : 'Yes', thirdPartyAudit: body.includes('3rd Party Audit') && body.includes('Yes') ? 'Yes' : 'No' }); }"
  }
}
```

### Шаг 4: Глубокий парсинг security breakdown

```json
{
  "tool": "browser_evaluate",
  "arguments": {
    "expectations": { "includeSnapshot": false },
    "function": "() => { const body = document.body.innerText; const result = {}; result.tokenScan = { score: (body.match(/Token Scan Score\\s*([\\d\\.]+)/) || ['',''])[1], critical: (body.match(/Token Scan Score\\s*[\\d\\.]+\\s*(\\d+)/) || ['',''])[1], major: (body.match(/Token Scan Score\\s*[\\d\\.]+\\s*\\d+\\s*(\\d+)/) || ['',''])[1], info: (body.match(/Token Scan Score\\s*[\\d\\.]+\\s*\\d+\\s*\\d+\\s*(\\d+)/) || ['',''])[1], top10Holders: (body.match(/Top 10 Holders Ratio\\s*([\\d\\.]+%?)/) || ['',''])[1] }; result.security = {}; ['Network Security','App Security','DNS Health'].forEach(l => { const i = body.indexOf(l); if (i>=0) { const c = body.substring(i,i+100); result.security[l] = (c.match(/(High|Medium|Low|Critical)/) || ['','N/A'])[1]; } }); result.incidents = body.includes('No security incidents') ? 'None (90d)' : 'Has incidents'; result.twitter = { followers: (body.match(/Twitter Followers.*?([\\d,]+)/) || ['',''])[1], age: (body.match(/Twitter Account Age\\s*([\\d]+\\s*yr)/) || ['',''])[1] }; result.domain = { created: (body.match(/Creation Date\\s*([\\w\\s,]+\\d{4})/) || ['',''])[1], expiry: (body.match(/Expiry.*?(\\w+\\s+\\d+,\\s+\\d{4})/) || ['',''])[1] }; return JSON.stringify(result, null, 2); }"
  }
}
```

### Шаг 5: Скриншот с оптимизацией

```json
{
  "tool": "browser_take_screenshot",
  "arguments": {
    "type": "jpeg",
    "imageOptions": { "quality": 60, "maxWidth": 1000 },
    "expectations": { "includeSnapshot": false }
  }
}
```

### Шаг 6: Batch - assertions + snapshot

```json
{
  "tool": "browser_batch_execute",
  "arguments": {
    "actions": [
      {
        "action": "assert",
        "assertions": [
          { "type": "url_contains", "value": "ethereum" },
          { "type": "title_contains", "value": "Ethereum" },
          { "type": "text_visible", "value": "CertiK Skynet Score" },
          { "type": "text_visible", "value": "Token Scan" }
        ]
      },
      {
        "action": "snapshot",
        "snapshotOptions": { "maxTokens": 2000, "prioritizeInteractable": true }
      }
    ]
  }
}
```

## Результат парсинга (пример)

```
Ethereum (ETH)
- Skynet Score: 97.23 (AAA)
- Price: $2,048.94 | MCap: $247.9B | Vol: $8.02B
- Token Scan Score: 72.00 (2 critical, 0 major, 21 info)
- Top 10 Holders: 4%
- CertiK Audit: No | 3rd Party: Yes
- Network/App/DNS Security: High/High/High
- Incidents (90d): None
- Twitter: 4.1M followers, 12yr account
- Domain: ethereum.org (since 2013, expires 2031)
- Contract: 0x2170ed0880ac9a755fd29b2688956bd959f933f8
```

## Оптимизации задействованные

| Оптимизация | Эффект |
|------------|--------|
| `expectations: { includeSnapshot: false }` | -80% токенов на evaluate (не нужен accessibility tree) |
| Default expectations (code/tabs/downloads off) | -300-700 tokens/call |
| Snapshot compactor | -25-35% snapshot size (refs stripped from generic elements) |
| `imageOptions: { quality: 60, maxWidth: 1000 }` | ~15KB JPEG vs ~385KB PNG |
| `snapshotOptions: { maxTokens: 2000 }` | Caps tree to ~2k tokens (vs 5-15k raw) |
| Response budget (4000 tokens) | Hard cap prevents oversized responses |

## Tips

1. **Прямой URL лучше поиска** - combobox search на CertiK медленный (3-5s), прямой `/projects/{slug}` мгновенный
2. **evaluate > snapshot для данных** - структурированный JSON из DOM быстрее парсинга YAML tree
3. **includeSnapshot: false** для evaluate - accessibility tree не нужен когда парсишь через JS
4. **Несколько evaluate лучше одного гигантского** - проще дебажить, меньше шанс timeout
