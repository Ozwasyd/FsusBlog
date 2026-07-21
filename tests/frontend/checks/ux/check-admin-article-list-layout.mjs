#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path) => readFileSync(new URL(path, `file://${root}/`), 'utf8');

const filterGroup = read('src/frontend/src/components/admin/AdminFilterGroup.vue');
const articleList = read('src/frontend/src/views/admin/article/List.vue');

assert.match(filterGroup, /class="grid gap-1"/, 'filter label and control must keep a 4px gap');
assert.match(filterGroup, /text-\[11px\][^"\n]*leading-4/, 'filter label must use a fixed 16px line-height');
assert.match(
    articleList,
    /\.article-cover-thumb\s*\{[^}]*width:\s*4rem;[^}]*height:\s*2\.25rem;/s,
    'article cover thumbnails must use the site-wide 64x36 aspect ratio'
);
assert.match(
    articleList,
    /\.article-cover-thumb\s*\{[^}]*border-radius:\s*var\(--fsus-radius-control\);/s,
    'article cover thumbnails must preserve the control radius token'
);
assert.match(
    articleList,
    /\.article-cover-thumb img\s*\{[^}]*object-fit:\s*cover;/s,
    'article cover images must crop without distortion'
);
assert.match(
    articleList,
    /<el-table-column label="管理" width="160" fixed="right" align="right">/,
    'article management actions must retain the measured 160px column'
);
assert.match(
    articleList,
    /class="flex justify-end items-center gap-x-1 pr-2"/,
    'article management actions must use a compact 4px horizontal gap'
);
assert.doesNotMatch(articleList, /<el-divider\b/, 'article management actions must not spend width on dividers');
assert.doesNotMatch(
    articleList,
    /<AdminFilterGroup\s+label="状态">/,
    'article status filter must not render a redundant visible label'
);
assert.match(
    articleList,
    /<AdminSegmentedControl[\s\S]*?aria-label="文章状态筛选"[\s\S]*?\/>/,
    'article status filter must retain an accessible name'
);

console.log('admin article list layout checks passed');
