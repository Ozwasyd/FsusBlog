#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rollout = fs.readFileSync(path.join(root, 'tools/deployment/release-rollout.sh'), 'utf8');
const invoker = fs.readFileSync(path.join(root, 'tools/deployment/invoke-security-challenge-kind-cutover.mjs'), 'utf8');
const errors = [];
const activeFence = rollout.match(/StageActiveFence\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';
const sourceDrain = rollout.match(/StageSourceDrain\(\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';

for (const required of [
    'invoke-security-challenge-kind-cutover.mjs',
    'verify-security-challenge-kind-cutover.mjs',
    'activate-security-challenge-protocol.mjs',
    'verify-release-challenge-kind-cutover.mjs',
    'challenge-kind-cutover-receipt.json',
    'challenge-kind-cutover-acceptance.json',
    'challenge-kind-cutover-gate.json'
])
{
    if (!sourceDrain.includes(required))
    {
        errors.push(`source-drain stage is missing ${required}`);
    }
}
const invocationIndex = sourceDrain.indexOf('invoke-security-challenge-kind-cutover.mjs');
const acceptanceIndex = sourceDrain.indexOf('verify-security-challenge-kind-cutover.mjs');
const bindingIndex = sourceDrain.indexOf('verify-release-challenge-kind-cutover.mjs');
const protocolActivationIndex = sourceDrain.indexOf('activate-security-challenge-protocol.mjs');
const drainGateIndex = sourceDrain.indexOf('release-rollout-gate.mjs" source-drain');
const authorizationFenceIndex = sourceDrain.indexOf('active-release-fence.mjs" acquire');
const destructiveMarkerIndex = sourceDrain.indexOf('mark-destructive-cutover');
if (!(drainGateIndex >= 0 && drainGateIndex < authorizationFenceIndex
  && authorizationFenceIndex < destructiveMarkerIndex && destructiveMarkerIndex < invocationIndex
  && invocationIndex < acceptanceIndex && acceptanceIndex < protocolActivationIndex
  && protocolActivationIndex < bindingIndex))
{
    errors.push('source drain closure, cutover invocation, acceptance and binding gate are not fail-closed ordered');
}
if (!activeFence.includes('active-release-fence.mjs" revoke') || !activeFence.includes('active-release-fence-verified.json')
  || !activeFence.includes('mark-activation')
  || activeFence.includes('invoke-security-challenge-kind-cutover.mjs'))
{
    errors.push('active-fence must verify the completed cutover, revoke source ownership and commit activation');
}
if (!rollout.includes('--challenge-kind-target-map') || !rollout.includes('FSUSBLOG_CHALLENGE_KIND_CUTOVER_TARGET_MAP'))
{
    errors.push('rollout lacks an independent target-map input');
}
if (!invoker.includes('/api/ops/deployment/fence/challenge-kind-cutover'))
{
    errors.push('cutover invoker lacks the protected endpoint');
}
if (!rollout.startsWith('#!/usr/bin/env bash\nset -Eeuo pipefail') || sourceDrain.includes('|| true'))
{
    errors.push('source-drain cutover stage is not fail closed');
}
if (!invoker.includes("receipt?.accepted !== true") || !invoker.includes("receipt?.status !== 'applied'")
  || !invoker.includes('await atomicJson'))
{
    errors.push('cutover invoker does not durably persist and reject an unsuccessful receipt');
}
const rolloutLibrary = fs.readFileSync(path.join(root, 'tools/deployment/release-rollout-lib.mjs'), 'utf8');
if (!rolloutLibrary.includes("action: 'resume-release-activation-same-cutover'")
  || !rolloutLibrary.includes("reason: 'destructive_cutover_started_old_source_rollback_forbidden'"))
{
    errors.push('post-boundary recovery is not pinned to same-operation activation resume');
}
const bindingVerifier = fs.readFileSync(path.join(root, 'tools/deployment/verify-release-challenge-kind-cutover.mjs'), 'utf8');
if (!bindingVerifier.includes("state.activationCommitted !== false")
  || !bindingVerifier.includes("state.currentStage !== 'source-drain'"))
{
    errors.push('cutover evidence does not prove it was captured before rollout activation');
}

const deploymentFiles = fs.readdirSync(path.join(root, 'tools/deployment'))
    .filter(name => name.endsWith('.mjs') || name.endsWith('.sh'));
for (const name of deploymentFiles)
{
    if (name === 'invoke-security-challenge-kind-cutover.mjs' || name === 'check-challenge-kind-cutover-rollout-contract.mjs')
    {
        continue;
    }
    const source = fs.readFileSync(path.join(root, 'tools/deployment', name), 'utf8');
    if (source.includes('/api/ops/deployment/fence/challenge-kind-cutover'))
    {
        errors.push(`unsupported direct cutover endpoint caller: tools/deployment/${name}`);
    }
}

if (errors.length > 0)
{
    process.stderr.write(`[challenge-kind-cutover-rollout-contract] ${errors.join('; ')}\n`);
    process.exit(1);
}
process.stdout.write('[challenge-kind-cutover-rollout-contract] ok\n');
