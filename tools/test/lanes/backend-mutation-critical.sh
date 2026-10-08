#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
CURRENT_TIER=backend-mutation-critical

# Release-final consumes a second, isolated Release mutation execution.  The
# scheduler reruns the very same sealed critical authority scope in Release;
# accepting changed-critical selection or ambient development bin/obj would
# invalidate mutant identity parity.
if [[ "${FSUSBLOG_RELEASE_MUTATION_PARITY:-0}" == "1" ]]; then
    : "${FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY:?release mutation parity requires fixed subset policy path}"
    : "${FSUSBLOG_TEST_RUN_ID:?release mutation parity requires scheduler run id}"
    : "${FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID:?release mutation requires current invocation}"
    : "${FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH:?release mutation requires verified run identity}"
    : "${FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST:?release mutation requires pinned run identity}"
    Run node "$ROOT_DIR/tools/test/run-release-mutation-parity-build.mjs" \
        --produce-source \
        --authority "$ROOT_DIR/.tmp/mutation/backend-critical/authority.json" \
        --policy "$FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY" \
        --receipt-output "$ROOT_DIR/.tmp/mutation/backend-critical/release-parity/$FSUSBLOG_TEST_RUN_ID/release-parity-receipt.json" \
        --run-id "$FSUSBLOG_TEST_RUN_ID" \
        --invocation-id "$FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID" \
        --attempt-id "$FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID.attempt-1" \
        --identity "$FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH" \
        --identity-digest "$FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST"
    Run node "$ROOT_DIR/tools/test/run-release-mutation-parity.mjs" \
        --authority "$ROOT_DIR/.tmp/mutation/backend-critical/authority.json" \
        --release "$ROOT_DIR/.tmp/mutation/backend-critical/release-parity/$FSUSBLOG_TEST_RUN_ID/release-parity-receipt.json" \
        --policy "$FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY"
    Run node --input-type=module - \
        "$ROOT_DIR" \
        "$ROOT_DIR/.tmp/mutation/backend-critical/authority.json" \
        "$FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY" \
        "$ROOT_DIR/.tmp/mutation/backend-critical/release-parity/$FSUSBLOG_TEST_RUN_ID/release-parity-receipt.json" <<'NODE'
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [repositoryRoot, authorityFile, policyFile, releaseParityFile] = process.argv.slice(2);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const valueDigest = (value) => bytesDigest(JSON.stringify(value));
const relative = (file) => path.relative(repositoryRoot, path.resolve(file)).replaceAll(path.sep, '/');
const authority = readJson(authorityFile);
const policyBytes = fs.readFileSync(policyFile);
const policy = JSON.parse(policyBytes);
const releaseParityBytes = fs.readFileSync(releaseParityFile);
const releaseParity = JSON.parse(releaseParityBytes);

if (policy.subsetDigest !== valueDigest(policy.subset)
    || authority.tierId !== 'release-mutation-critical-slice'
    || authority.sliceId !== 'release-mutation-critical-slice'
    || !Array.isArray(authority.plannedMutantIds)
    || !Array.isArray(authority.executedMutantIds)
    || releaseParity.schema !== 'fsusblog.release-mutation-parity-receipt.v1'
    || releaseParity.sourceAuthority?.inventoryDigest !== authority.inventoryDigest
    || releaseParity.sourceAuthority?.configDigest !== authority.config?.sha256)
{
    throw new Error('release mutation qualification inputs are incomplete or mismatched');
}

authority.releaseQualification = {
    schema: 'fsusblog.release-mutation-qualification.v1',
    status: 'complete',
    tierId: authority.tierId,
    sliceId: authority.sliceId,
    releaseParity: true,
    policy: {
        path: relative(policyFile),
        fileDigest: bytesDigest(policyBytes),
        subsetDigest: policy.subsetDigest
    },
    releaseParityReceipt: {
        path: relative(releaseParityFile),
        fileDigest: bytesDigest(releaseParityBytes),
        resolvedSubsetDigest: releaseParity.resolvedSubsetDigest
    },
    sourceAuthority: {
        inventoryDigest: authority.inventoryDigest,
        configDigest: authority.config.sha256
    },
    plannedMutantIds: authority.plannedMutantIds,
    executedMutantIds: authority.executedMutantIds
};
const temporary = `${authorityFile}.next-${process.pid}-${randomUUID()}`;
fs.writeFileSync(temporary, `${JSON.stringify(authority, null, 2)}\n`, 'utf8');
fs.renameSync(temporary, authorityFile);
NODE
else
    RunTier "$CURRENT_TIER" RunBackendMutationCriticalOnly
fi
