import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

const challengeClient = read('src/frontend/src/security/challenge-client.ts');
const articleCommentFlow = read('src/frontend/src/composables/useArticleDetailView.ts');
const riskCommand = read('src/frontend/src/composables/useRiskChallengeCommand.ts');
const businessChallengeConsumers = [
    'src/frontend/src/composables/useArticleDetailView.ts',
    'src/frontend/src/composables/usePasskeyLogin.ts',
    'src/frontend/src/composables/useNotification.ts',
    'src/frontend/src/views/auth/Recover.vue'
];
const productionRoot = path.join(root, 'src/frontend/src');
const actionPattern = /comment\.(?:create|reply)|auth\.[a-z.-]+|recovery-key\.verify|notification\.subscribe|admin\.[a-z.-]+/;

assert.doesNotMatch(challengeClient, /securityBusinessChallengeGates/, 'challenge client must not keep an action-to-kind policy shadow');
assert.match(articleCommentFlow, /commentRiskChallenge\.run\(/, 'comment mutation must submit first and use the shared 428 runtime');
assert.doesNotMatch(articleCommentFlow, /ensureCommentCreateChallengeProof|issueCommentChallenge/, 'comment mutation must not pre-issue a challenge');
assert.match(riskCommand, /contextFromHandoff\(context, error\.riskChallengeHandoff\)/, 'retry context must come from the structured server handoff');
assert.match(riskCommand, /handoff\.action !== expected\.action/, 'retry must keep the original action identity');
assert.match(riskCommand, /handoff\.routeKey !== expected\.routeKey/, 'retry must keep the original route identity');
assert.match(riskCommand, /riskChallengePolicyVersion/, 'retry must carry the current server policy version');

for (const relative of businessChallengeConsumers)
{
    const source = read(relative);
    assert.doesNotMatch(source, /SecurityChallengeKind\./, `${relative} must dispatch via capability metadata, not kind policy`);
    assert.doesNotMatch(source, /securityBusinessChallengeGates/, `${relative} must not own action-to-kind policy`);
}

for (const absolute of walkProductionSources(productionRoot))
{
    if (absolute.endsWith('/security/challenge-capability-registry.ts'))
    {
        continue;
    }
    const source = readFileSync(absolute, 'utf8');
    assert.ok(
        !(actionPattern.test(source) && /SecurityChallengeKind\./.test(source)),
        `${path.relative(root, absolute)} combines a business action with a challenge kind`
    );
}

console.log(`challenge policy shadow: ${businessChallengeConsumers.length} business consumers server-directed`);

function walkProductionSources(directory)
{
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true }))
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            files.push(...walkProductionSources(absolute));
        }
        else if (/\.(?:ts|vue)$/.test(entry.name))
        {
            files.push(absolute);
        }
    }
    return files;
}
