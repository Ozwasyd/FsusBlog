#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd(), '../..');
const errors = [];

function read(path)
{
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

function expectIncludes(source, token, label)
{
    if (!source.includes(token))
    {
        errors.push(`${label} missing ${token}`);
    }
}

function expectNotMatches(source, pattern, message)
{
    if (pattern.test(source))
    {
        errors.push(message);
    }
}

const utility = read('src/frontend/src/composables/useRowStateMotion.ts');
const motionCss = read('src/frontend/src/assets/motion.css');
const docs = read('docs/frontend/motion-guidelines.md');

for (const token of [
    '.blog-motion-row-state',
    '.blog-motion-row-pending',
    '.blog-motion-row-updated',
    '.blog-motion-row-error',
    '.blog-motion-summary-enter'
])
{
    expectIncludes(motionCss, token, 'motion.css');
}

expectIncludes(utility, 'DEFAULT_VISIBLE_LIMIT = 20', 'useRowStateMotion.ts');
expectIncludes(utility, 'visibleLimit', 'useRowStateMotion.ts');
expectIncludes(utility, 'markPending', 'useRowStateMotion.ts');
expectIncludes(utility, 'markUpdated', 'useRowStateMotion.ts');
expectIncludes(utility, 'markError', 'useRowStateMotion.ts');
expectIncludes(utility, 'onScopeDispose', 'useRowStateMotion.ts');
expectIncludes(docs, 'Row State Motion', 'motion-guidelines.md');

const coverage = [
    ['src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue', ['blog-motion-row-pending', 'blog-motion-row-updated']],
    ['src/frontend/src/views/admin/AuditLog.vue', ['useRowStateMotion', ':row-class-name="auditRowClassName"', 'blog-motion-summary-enter']],
    ['src/frontend/src/components/admin/article/ArticleAssetLibraryPanel.vue', ['useRowStateMotion', 'assetRowMotion.classFor', 'blog-motion-summary-enter']],
    ['src/frontend/src/views/user/Messages.vue', ['useRowStateMotion', 'conversationMotion.classFor', 'messageMotion.classFor']],
    ['src/frontend/src/composables/useAdminArticleList.ts', ['useRowStateMotion', 'rowMotion.markPending', 'rowMotion.markUpdated']],
    ['src/frontend/src/views/admin/article/List.vue', ['rowMotion.classFor', ':row-class-name="articleTableRowClassName"', 'blog-motion-summary-enter']],
    ['src/frontend/src/composables/useAdminUserManage.ts', ['useRowStateMotion', 'rowMotion.markPending', 'rowMotion.markUpdated']],
    ['src/frontend/src/components/admin/users/UserManageTable.vue', ['rowMotionClass', ':row-class-name="rowClassName"']]
];

for (const [path, tokens] of coverage)
{
    const source = read(path);
    for (const token of tokens)
    {
        expectIncludes(source, token, path);
    }
    expectNotMatches(source, /stagger/i, `${path} must not use row stagger motion`);
    expectNotMatches(source, /transition\s*:[^;\n]*(?:height|width|top|left|filter|blur)/s, `${path} must not animate costly row properties`);
}

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[row-state-motion] ${error}`);
    }
    process.exit(1);
}

console.log(`[row-state-motion] ok surfaces=${coverage.length}`);
