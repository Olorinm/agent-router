import { writeFile } from 'node:fs/promises';

const source = 'https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce.md';
const response = await fetch(source);
if (!response.ok) throw new Error(`emoji_catalog_http_${response.status}`);
const markdown = await response.text();
const emojis = [...markdown.matchAll(/!\[[^\]]*\]\([^\n]*?\)\s*\|\s*([A-Za-z0-9_]+)/g)].map(match => match[1]);
if (emojis.length < 100 || new Set(emojis).size !== emojis.length) throw new Error('unexpected_emoji_catalog');
const lines = [];
for (let offset = 0; offset < emojis.length; offset += 8) lines.push('  ' + emojis.slice(offset, offset + 8).map(JSON.stringify).join(', ') + ',');
await writeFile(new URL('../src/channels/feishu-emojis.ts', import.meta.url),
  `// Complete official reaction catalog; regenerate with node scripts/update-feishu-emojis.mjs.\n// Source: ${source}\nexport const FEISHU_EMOJIS = [\n${lines.join('\n')}\n] as const;\n`);
console.log(`Updated ${emojis.length} Feishu reaction types.`);
