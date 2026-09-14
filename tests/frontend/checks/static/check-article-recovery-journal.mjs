#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = path => readFileSync(resolve(repoRoot, path), 'utf8');
const assert = (condition, message) =>
{
    if (!condition)
    {
        throw new Error(message);
    }
};

const journal = read('src/frontend/src/services/articleRecoveryJournal.ts');
const write = read('src/frontend/src/composables/useAdminArticleWrite.ts');
const list = read('src/frontend/src/composables/useAdminArticleList.ts');
const view = read('src/frontend/src/views/admin/article/Write.vue');
const registry = read('src/frontend/src/services/privateStorageRegistry.ts');
const resilience = read('tests/frontend/e2e/resilience/markdown-extreme.spec.ts');
const persistentProbe = read('tests/frontend/e2e/article-editor-recovery-persistent-probe.mjs');
const architecture = read('docs/architecture.md');
const apiDesign = read('docs/api/design.md');
const apiContracts = read('docs/api/contracts.md');
const security = read('docs/security.md');
const privateSurface = read('docs/security/private-surface-runtime.md');

for (const token of [
    "ARTICLE_RECOVERY_JOURNAL_DATABASE = 'fsusblog-article-recovery-journal'",
    "ARTICLE_RECOVERY_JOURNAL_SCHEMA = 'fsusblog.article-recovery-journal.v2'",
    "ARTICLE_RECOVERY_JOURNAL_PAYLOAD_CODEC = 'utf8-v1'",
    'ARTICLE_RECOVERY_JOURNAL_TTL_HOURS = 168',
    'ARTICLE_RECOVERY_JOURNAL_TTL_MS = ARTICLE_RECOVERY_JOURNAL_TTL_HOURS * 60 * 60 * 1000',
    'ARTICLE_RECOVERY_JOURNAL_PRIVACY_NOTICE',
    'encodeArticleRecoveryPayload',
    'decodeArticleRecoveryPayload',
    'ARTICLE_RECOVERY_JOURNAL_MAX_CONTENT_BYTES = 1024 * 1024',
    'ARTICLE_RECOVERY_JOURNAL_MAX_STORED_BYTES = 1024 * 1024',
    'ARTICLE_RECOVERY_JOURNAL_MAX_SCOPE_ENTRIES = 8',
    'ARTICLE_RECOVERY_JOURNAL_MAX_TOTAL_ENTRIES = 32',
    'ARTICLE_RECOVERY_JOURNAL_MAX_TOTAL_BYTES = 4 * 1024 * 1024',
    'identityHash',
    'baseRevisionId',
    'serverRevision',
    'clientRevision',
    'sourceHash',
    'record?.clientRevision === confirmation.clientRevision',
    'record.sourceHash === confirmation.sourceHash',
    'ArticleRecoveryCoordinator',
    'ArticleRecoveryFlushOwner',
    'private inFlight: ArticleRecoveryFlushOperation | null = null',
    'private pending: ArticleRecoveryFlushOperation | null = null',
    'bindArticleRecoveryLifecycleFlush',
    "'visibilitychange'",
    "'pagehide'",
    "'beforeunload'",
    'environment.window.setInterval',
    'createArticleRecoveryOperationRunner',
    'summarizeArticleRecoveryComparison'
])
{
    assert(journal.includes(token), `article recovery journal is missing ${token}`);
}

assert(!journal.includes('localStorage'), 'article recovery journal must not fall back to localStorage');
assert(!journal.includes('sessionStorage'), 'article recovery journal must not fall back to sessionStorage');
assert(!journal.includes('CompressionStream'), 'article recovery journal must not depend on gzip compression');
assert(!journal.includes('gzip'), 'article recovery journal at-rest payload must stay plaintext UTF-8');
assert(!journal.includes('AES'), 'article recovery journal must not add an encryption layer');
assert(journal.includes('store.put(storedRecord)'),
    'IndexedDB must receive only the stored-record representation');
assert(journal.includes('payload: Uint8Array'),
    'persisted article recovery content must use typed plaintext UTF-8 bytes');
assert(journal.includes('decodeArticleRecoveryPayload(stored.payload)'),
    'journal reads must reconstruct content through the versioned plaintext codec');
assert(!journal.includes('pendingBySequence'),
    'article recovery writes must not retain an unbounded per-sequence queue');
assert(!write.includes("localStorage.setItem('fsus:article-draft:"),
    'article editor must not write a second localStorage recovery owner');
assert(write.includes("flush: 'sync'"), 'article recovery must journal input before the autosave debounce');
assert(write.includes('stageArticleRecoveryWrite'), 'article editor must stage the newest input before debounce');
assert(write.includes('flushArticleRecoveryWrite'), 'article editor must expose one idempotent journal flush path');
assert(write.includes('bindArticleRecoveryLifecycleFlush'),
    'article editor must bind visibility/pagehide/beforeunload/periodic flush to the same owner');
assert(write.includes('disposeArticleRecoveryLifecycle?.()'),
    'article editor must remove lifecycle listeners and periodic flush on unmount');
assert(write.includes('queueArticleRecoveryWrite'), 'article editor must journal before server draft write');
assert(write.includes('articleRecoveryJournal.confirm'), 'server confirmation must guard journal cleanup');
assert(write.includes('articleRecoveryFlushOwner.markConfirmed'),
    'server confirmation must only clear matching in-memory pending coordinates');
assert(write.includes('saveServerDraftSnapshot(snapshot, recoveryRecord)'),
    'offline retry must retain the exact recovery confirmation coordinates');
assert(write.includes('assessArticleRecoveryDivergence'),
    'recovery prompt must compare current/server revision state');
assert(write.includes('articleRecoveryJournal.clearScope'),
    'publish/discard cleanup must clear the identity/article scope');
assert(list.includes('onSuccess: async () =>'), 'article delete cleanup must run at the mutation success boundary');
assert(list.includes('articleRecoveryJournal.clearArticle(row.id)'),
    'article delete success must clear the article journal');

assert(view.includes('data-article-recovery-prompt="true"'),
    'recovery prompt must expose a stable production contract');
assert(view.includes('选择要恢复的未同步正文版本'),
    'multi-tab versions must have an accessible selection name');
assert(view.includes('articleRecoveryPrivacyNotice'),
    'recovery prompt must surface the canonical plaintext privacy notice');
assert(view.includes('未加密') && view.includes('最长 7 天') && view.includes('服务端确认后即删除'),
    'editor UI must honestly describe unencrypted local storage, 7-day TTL, and confirm cleanup');
assert(!view.includes('12 小时'), 'editor UI must not retain the retired 12-hour TTL claim');
assert(view.includes('恢复所选正文') || view.includes('draftRestoreButtonText'),
    'recovery prompt must expose an explicit restore action');
assert(view.includes('比较所选正文'),
    'recovery prompt must expose an explicit comparison action');
assert(view.includes('articleRecoveryOperationPending')
    && view.includes('articleRecoveryOperationError')
    && view.includes('role="alert"'),
'recovery decisions must share pending/disabled/error state');
assert(write.includes('articleRecoveryComparisonRequired'),
    'divergent journal coordinates must require comparison before recovery');
assert(!view.includes('已安全备份'), 'normal editor UI must not claim a permanent safe backup');
assert(!view.includes('已加密') && !view.includes('本地天然安全'),
    'editor UI must not claim encryption or inherent local safety');

for (const token of [
    "medium: 'indexed-db'",
    "value: 'fsusblog-article-recovery-journal'",
    "id: 'retired-article-draft-create-metadata'",
    "id: 'retired-article-draft-edit-metadata'",
    'purgeRetiredArticleDraftMetadata',
    "'admin-logout'",
    'indexedDb.deleteDatabase(entry.matcher.value)'
])
{
    assert(registry.includes(token), `private storage registry is missing ${token}`);
}
assert(write.includes('purgeRetiredArticleDraftMetadata(window.localStorage)'),
    'article editor initialization must purge retired metadata even without logout');

assert(!resilience.includes("localStorage.getItem('fsus:article-draft:create')"),
    'markdown resilience must not assert the retired localStorage recovery owner');
assert(resilience.includes('readArticleRecoveryJournal'),
    'markdown resilience must inspect the IndexedDB recovery journal');
assert(resilience.includes('articleRecoverySourceHash(source)')
    && resilience.includes('sourceHash: expectedRecoverySourceHash')
    && resilience.includes('record.sourceHash === expected.sourceHash'),
'markdown resilience must bind raw journal evidence to the production source-hash contract');
assert(resilience.includes("record.payloadCodec === 'utf8-v1'")
    && resilience.includes('record.payloadIsUint8Array')
    && resilience.includes("!record.hasOwnContent"),
'markdown resilience must require plaintext typed UTF-8 bytes without a raw content field');
assert(resilience.includes('ARTICLE_RECOVERY_CLIENT_REVISION_PATTERN.test(record.clientRevision)')
    && resilience.includes('runtimeClientRevision = matches[0]?.clientRevision ?? null')
    && resilience.includes('record.clientRevision === runtimeClientRevision')
    && resilience.includes('articleKey: expectedRecoveryArticleKey')
    && resilience.includes('record.articleKey === expected.articleKey'),
'markdown resilience must capture one valid runtime client revision and retain it across reload');
assert(!resilience.includes('randomUUID')
    && !resilience.includes('markdown-extreme-client-1813'),
'markdown resilience must not replace production client revision generation');
assert(!resilience.includes('record.content === source'),
    'markdown resilience must not require the retired raw-body record shape');
for (const token of [
    "'os-restart-prepare'",
    "'os-restart-verify'",
    "'os-restart-cleanup'",
    "'boot-identity-contract'",
    'os-restart-handoff.json',
    'prepared-awaiting-user-authorized-host-reboot',
    'No host reboot or OS-restart verification has occurred.',
    "'/proc/sys/kernel/random/boot_id'",
    'article_recovery_os_restart_same_boot_rejected',
    'handoff.baseUrl !== baseUrl',
    'handoff.origin !== baseOrigin',
    '`PLAYWRIGHT_BASE_URL=${shellQuote(baseUrl)}`'
])
{
    assert(persistentProbe.includes(token), `persistent probe is missing bounded OS-restart handoff token ${token}`);
}

for (const [path, content] of [
    ['docs/architecture.md', architecture],
    ['docs/api/design.md', apiDesign],
    ['docs/api/contracts.md', apiContracts],
    ['docs/security.md', security],
    ['docs/security/private-surface-runtime.md', privateSurface]
])
{
    assert(content.includes('IndexedDB'), `${path} must document the bounded IndexedDB recovery journal`);
    assert(!content.includes('localStorage 只保存不可恢复正文的草稿 metadata'),
        `${path} must not retain the retired metadata-only owner`);
    assert(!content.includes('浏览器 localStorage 只保存 schema、保存时间、来源文章和 client revision'),
        `${path} must not retain the retired metadata-only owner`);
    assert(!content.includes('gzip-v1'), `${path} must not claim gzip at-rest journal payloads`);
    assert(!content.includes('TTL is 12 hours') && !content.includes('12-hour') && !content.includes('12 hours'),
        `${path} must not retain the retired 12-hour journal TTL`);
}

console.log('[check-article-recovery-journal] ok');
