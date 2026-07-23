import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path) => readFileSync(`${repoRoot}/${path}`, 'utf8');
const article = read('src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue');
const layout = read('src/frontend/src/assets/reading-layout.css');

assert.doesNotMatch(article, /calc\(\s*100%\s*\+/u, 'article media bleed must not grow width with calc(100% + ...)');
assert.doesNotMatch(article, /margin-(?:left|right)\s*:\s*-/u, 'article media bleed must not use negative side margins');
assert.match(article, /data-fsus-reading-layout/u, 'article root must expose the shared reading layout');
assert.match(article, /data-fsus-reading-bleed/u, 'article cover must opt into the shared bleed line');
for (const line of ['full-start', 'bleed-start', 'content-start', 'content-end', 'bleed-end', 'full-end'])
{
    assert.match(layout, new RegExp(`\\[${line}\\]`, 'u'), `reading layout must define ${line}`);
}
assert.match(layout, /\[data-fsus-reading-bleed\]\s*\{[^}]*grid-column:\s*bleed;/su);
assert.match(layout, /figcaption[^}]*grid-column:\s*content;/su);
assert.match(layout, /pre\.shiki[^}]*grid-column:\s*bleed;/su);
assert.doesNotMatch(layout, /overflow-x\s*:\s*hidden/u, 'reading layout must not hide page overflow');

console.log('[check-reading-layout-primitive] ok');
