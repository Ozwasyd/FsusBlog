import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const authEndpoints = read('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs');
const commentEndpoints = read('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs');
const authApi = read('src/frontend/src/api/auth.ts');
const commentApi = read('src/frontend/src/api/comment.ts');
const transportContract = read('src/frontend/src/contracts/binaryTransport.ts');
const transport = read('src/frontend/src/api/binaryApiClient.ts');
const command = read('src/frontend/src/composables/useRiskChallengeCommand.ts');
const article = read('src/frontend/src/composables/useArticleDetailView.ts');
const passkey = read('src/frontend/src/composables/usePasskeyLogin.ts');
const recovery = read('src/frontend/src/views/auth/Recover.vue');
const routes = read('src/frontend/src/security/risk-challenge-routes.ts');

const failures = [];
const requireText = (source, token, label) =>
{
    if (!source.includes(token))
    {
        failures.push(`${label}: missing ${token}`);
    }
};

const protectedEndpoints = [
    ['binary_post_comment', commentEndpoints, 'WithRiskAction(RiskActionNames.CommentCreate)'],
    ['binary_post_auth_recovery_key_verify', authEndpoints, 'WithRiskAction(RiskActionNames.RecoveryKeyVerify)'],
    ['binary_post_auth_passkey_login_begin', authEndpoints, 'WithRiskAction(RiskActionNames.AuthPasskeyBegin)'],
    ['binary_post_auth_passkey_login_complete', authEndpoints, 'WithRiskAction(RiskActionNames.AuthPasskeyComplete)']
];

const endpointFilterCount = [authEndpoints, commentEndpoints]
    .map((source) => source.match(/AddEndpointFilterWithMetadata<RequiresRiskControlFilter>\(\)/g)?.length ?? 0)
    .reduce((total, count) => total + count, 0);
if (endpointFilterCount !== protectedEndpoints.length)
{
    failures.push(`endpoint inventory drift: expected ${protectedEndpoints.length}, found ${endpointFilterCount}`);
}

for (const [operationId, endpointSource, metadata] of protectedEndpoints)
{
    requireText(endpointSource, metadata, operationId);
    requireText(routes, operationId, 'typed risk challenge route inventory');
}

for (const [source, operationId] of [
    [commentApi, 'binary_post_comment'],
    [authApi, 'binary_post_auth_recovery_key_verify'],
    [authApi, 'binary_post_auth_passkey_login_begin'],
    [authApi, 'binary_post_auth_passkey_login_complete']
])
{
    const offset = source.indexOf(`operationId: '${operationId}'`);
    const requestWindow = offset >= 0 ? source.slice(offset, offset + 650) : '';
    requireText(requestWindow, 'riskChallengeProof:', operationId);
}

const recoveryOffset = authApi.indexOf("operationId: 'binary_post_auth_recovery_key_verify'");
requireText(authApi.slice(recoveryOffset, recoveryOffset + 650), 'requiresPow: true', 'recovery legacy PoW remains separate');
requireText(transportContract, 'riskChallengeProof?: RiskChallengeProofContext', 'binary transport contract');
for (const header of ['challengeProof', 'challengeId', 'challengeKind'])
{
    requireText(transport, `FSUS_HEADERS.${header}`, 'single binary proof header writer');
}
for (const lifecycle of ['markInFlight()', "settle('before_send_cancelled')", "settle('unknown_network')"])
{
    requireText(transport, lifecycle, 'binary proof lifecycle');
}
requireText(command, "kind: 'mutation_with_identity'", 'challenge-aware mutation retry');
requireText(command, 'riskChallengeFailure', 'structured 428 handling');
requireText(article, 'riskChallengeProof: challengeLease', 'comment proof handoff');
requireText(passkey, 'riskChallenge.run(', 'passkey shared command wrapper');
requireText(recovery, 'recoveryRiskChallenge.run(', 'recovery shared command wrapper');

const allowedHeaderWriters = new Set([
    'src/frontend/src/api/contracts.ts',
    'src/frontend/src/services/notificationStreamRuntime.ts'
]);
for (const file of walk(join(root, 'src/frontend/src')))
{
    const relativePath = relative(root, file).replaceAll('\\', '/');
    if (allowedHeaderWriters.has(relativePath))
    {
        continue;
    }
    const source = readFileSync(file, 'utf8');
    if (/X-Fsus-Challenge-(?:Proof|Id|Kind)/.test(source))
    {
        failures.push(`${relativePath}: business code must not write X-Fsus-Challenge-* headers`);
    }
}

if (failures.length > 0)
{
    console.error(failures.map((failure) => `[risk-challenge-proof-transport] ${failure}`).join('\n'));
    process.exit(1);
}

console.log('[risk-challenge-proof-transport] 4 endpoint callers, typed headers, lifecycle and retry boundary OK');

function* walk(directory)
{
    for (const entry of readdirSync(directory))
    {
        const path = join(directory, entry);
        if (statSync(path).isDirectory())
        {
            yield* walk(path);
        }
        else if (/\.(?:ts|vue)$/.test(entry))
        {
            yield path;
        }
    }
}

