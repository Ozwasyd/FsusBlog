#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path) => readFileSync(new URL(path, `file://${root}/`), 'utf8');
const fixture = JSON.parse(read('tests/frontend/fixtures/comment-moderation-first-screen.json'));
const page = read('src/frontend/src/views/admin/CommentModeration.vue');
const primary = read('src/frontend/src/components/admin/comment-moderation/CommentModerationToolbar.vue');
const advanced = read('src/frontend/src/components/admin/comment-moderation/CommentModerationAdvancedFilters.vue');
const workbench = read('src/frontend/src/components/admin/CollectionWorkbench.vue');
const workspaceCss = read('src/frontend/src/assets/admin-workspace.css');
const queueState = read('src/frontend/src/composables/useCommentModerationQueue.ts');

assert.deepEqual(fixture.viewports.map(({ width }) => width), [1366, 1440, 768, 375]);
assert.deepEqual(fixture.themes, ['light', 'dark']);
assert.deepEqual(fixture.queueCases.map(({ selected }) => selected), [0, 0, 1, 10]);
assert.deepEqual(fixture.queueCases.map(({ activeAdvancedFilters }) => activeAdvancedFilters), [0, 0, 1, 7]);
assert.equal(fixture.viewports[0].minimumVisibleRows, 3);
assert.ok(fixture.persistentFilterRoles.length <= 4);

for (const token of [
    'commentModerationArticle',
    'commentModerationUser',
    'commentModerationHitReason',
    'commentModerationBlockedRegion',
    'commentModerationModelLabel',
    'commentModerationModelRuntime',
    'ElDatePicker'
])
{
    assert.doesNotMatch(primary, new RegExp(token), `${token} must not remain in the persistent toolbar`);
}
for (const token of [
    'commentModerationArticle',
    'commentModerationUser',
    '命中原因',
    '屏蔽地区',
    '模型标签',
    '模型运行时',
    'ElDatePicker'
])
{
    assert.match(advanced, new RegExp(token), `${token} must be reachable in one advanced-filter step`);
}

assert.match(page, /#advanced-filter-trigger/);
assert.match(page, /v-if="hasQueueRiskAlert"/, 'risk guidance must only render for a real queue anomaly');
assert.match(workbench, /v-if="selectedCount > 0"/, 'bulk actions must be absent at zero selection');
assert.match(workspaceCss, /\.collection-workbench__selection\s*\{[^}]*position:\s*sticky;[^}]*min-height:\s*52px;/s);
assert.match(primary, /width:\s*clamp\(17\.5rem,\s*28vw,\s*22\.5rem\);/);
assert.match(advanced, /size="min\(100vw, 400px\)"/);
assert.match(advanced, /\.comment-advanced-panel__fields\s*\{[^}]*gap:\s*var\(--fsus-space-4\);/s);
assert.match(advanced, /\.comment-advanced-panel__footer-action\s*\{[^}]*min-height:\s*44px;/s);
assert.match(advanced, /@opened="focusPanel"/);
assert.match(advanced, /@closed="restoreTriggerFocus"/);
assert.match(advanced, /清除全部/);
assert.doesNotMatch(advanced, /<ElTag\b/, 'advanced filters must not become a chip parade');
assert.match(queueState, /createCommentModerationQuery/);
assert.match(queueState, /applyCommentModerationQuery/);
assert.match(queueState, /router\.replace\(\{ name: 'ManageModerationComments', query \}\)/);

console.log('[comment-moderation-first-screen] fixture, hierarchy, geometry and query recovery passed');
