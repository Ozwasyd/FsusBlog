#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
# shellcheck source=_release-reliability-lifecycle.sh
source "$ROOT_DIR/tools/test/lanes/_release-reliability-lifecycle.sh"
CURRENT_TIER=backend-mutation-critical
InitializeReleaseReliabilityLifecycle
RunTier "$CURRENT_TIER" RunBackendMutationCriticalOnly

# Release-final consumes a second, isolated Release mutation execution.  The
# scheduler reruns the very same sealed critical authority scope in Release;
# accepting changed-critical selection or ambient development bin/obj would
# invalidate mutant identity parity.
if [[ "${FSUSBLOG_RELEASE_MUTATION_PARITY:-0}" == "1" ]]; then
    : "${FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY:?release mutation parity requires fixed subset policy path}"
    : "${FSUSBLOG_TEST_RUN_ID:?release mutation parity requires scheduler run id}"
    Run node "$ROOT_DIR/tools/test/run-release-mutation-parity-build.mjs" \
        --authority "$ROOT_DIR/.tmp/mutation/backend-critical/authority.json" \
        --policy "$FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY" \
        --output-root "$ROOT_DIR/.tmp/mutation/backend-critical/release-parity" \
        --run-id "$FSUSBLOG_TEST_RUN_ID"
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
fi
