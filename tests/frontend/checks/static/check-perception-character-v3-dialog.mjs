import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const app = read('src/frontend/src/App.vue');
const host = read('src/frontend/src/components/security/SecurityChallengeDialogHost.vue');
const challenge = read('src/frontend/src/components/security/FsusSecurityChallenge.vue');
const adapter = read('src/frontend/src/fsusui/perceptionCharacterChallenge.ts');
const coordinator = read('src/frontend/src/composables/useRiskChallengeCommand.ts');
const transport = read('src/frontend/src/services/securityPerceptionCharacterV3Flow.ts');
const productionSharedFlowOwners = [
    'src/frontend/src/composables/usePasskeyLogin.ts',
    'src/frontend/src/views/auth/Recover.vue',
    'src/frontend/src/composables/useArticleDetailView.ts'
];
const inlineSurfaces = [
    'src/frontend/src/views/auth/Login.vue',
    'src/frontend/src/views/auth/Recover.vue',
    'src/frontend/src/views/ArticleDetail.vue'
].map(read).join('\n');
const architecture = read('docs/architecture.md');
const security = read('docs/security.md');
const apiContracts = read('docs/api/contracts.md');

const sourceRoot = path.join(root, 'src/frontend/src');
const sourceFiles = [];
const collectSourceFiles = (directory) =>
{
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            collectSourceFiles(absolute);
        }
        else if (/\.(?:ts|vue)$/u.test(entry.name))
        {
            sourceFiles.push(path.relative(root, absolute).replaceAll(path.sep, '/'));
        }
    }
};
collectSourceFiles(sourceRoot);

const actualSharedFlowOwners = sourceFiles
    .filter((relative) => relative !== 'src/frontend/src/composables/useRiskChallengeCommand.ts')
    .filter((relative) => /\buseRiskChallengeCommand\s*\(/u.test(read(relative)))
    .sort();

assert.match(app, /<SecurityChallengeDialogHost\s*\/>/u);
assert.equal((app.match(/<SecurityChallengeDialogHost\s*\/>/gu) ?? []).length, 1);
assert.doesNotMatch(inlineSurfaces, /FsusSecurityChallenge/u);
assert.match(host, /width="min\(92vw, 28rem\)"/u);
assert.match(host, /destroy-on-close/u);
assert.match(host, /:close-on-click-modal="false"/u);
assert.match(challenge, /FsusUiPerceptionCharacterChallenge/u);
assert.match(adapter, /@ozwasyd\/element-plus\/perception-challenge/u);
assert.doesNotMatch(challenge, /@ozwasyd\/element-plus/u);
assert.doesNotMatch(challenge, /\.el-perception-character/u);
assert.doesNotMatch(challenge, /FSUSBLOG_SECURITY_COPY|[\u3400-\u9fff]/u);
assert.doesNotMatch(transport, /solveDuration|recipe|glyph|seed|riskScore|answerVerifier/iu);
assert.match(coordinator, /risk_challenge_command_already_pending/u);
assert.match(coordinator, /current\.settled/u);
assert.match(app, /securityChallengeCoordinator\.handleCancel\(\)/u);
assert.deepEqual(actualSharedFlowOwners, [...productionSharedFlowOwners].sort());

const deferredAccountAdminSources = sourceFiles
    .filter((relative) =>
        relative.startsWith('src/frontend/src/views/admin/')
    || relative.startsWith('src/frontend/src/components/admin/')
    || relative.startsWith('src/frontend/src/components/account/')
    || relative.startsWith('src/frontend/src/layouts/Account')
    || relative === 'src/frontend/src/views/user/Profile.vue'
    )
    .map(read)
    .join('\n');
assert.doesNotMatch(deferredAccountAdminSources, /\buseRiskChallengeCommand\s*\(|\briskChallengeProof\b/u);

for (const document of [architecture, security, apiContracts])
{
    const normalizedDocument = document.replace(/\s+/gu, ' ');
    assert.match(normalizedDocument, /production [^。]*清单|production shared-flow inventory/u);
    assert.match(normalizedDocument, /account[^。；]*admin[^。；]*(?:没有接入|没有|尚无) shared RiskControl/u);
    assert.match(normalizedDocument, /X-Fsus-Mfa-Proof/u);
    assert.match(normalizedDocument, /(?:唯一|同一个)[^。；]*(?:App|application-level)[^。；]*(?:host|SecurityChallengeDialogHost)/u);
}

for (const locale of ['zh-CN', 'en-US'])
{
    const copy = read(`src/frontend/src/locales/${locale}/security.ts`);
    for (const key of [
        'title', 'eyebrow', 'refresh', 'useAudio', 'useImage', 'retryable', 'reissueRequired',
        'unavailable', 'expired', 'perceptionTitle', 'perceptionFailed', 'unsupported', 'preparing'
    ])
    {
        assert.match(copy, new RegExp(`\\b${key}:`, 'u'));
    }
}

console.log('[perception-character-v3-dialog] static governance passed');
