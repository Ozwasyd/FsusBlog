/* eslint-disable import-x/no-relative-parent-imports -- The existing rollout owner consumes the sole release manifest and canonical pure digests. */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalize, digestValue } from '../fact-extractors/lib/canonicalize.mjs';
import { releaseIdentityRosterContent } from '../release/release-manifest-identity-contract.mjs';
import { verifyReleaseManifestArtifacts } from '../release/release-manifest-signature-contract.mjs';
import { createReleaseManifestValueContract } from '../release/release-manifest-value-contract.mjs';

export const currentActivationPhases = Object.freeze(['prepared', 'verified', 'switching', 'active',
    'failed-before-switch', 'rollback-to-unactivated-candidate', 'restore-required']);
export const currentActivationNativeOwner = 'FsusBlog.Server.Infrastructure.SchemaMigration.CurrentSchemaReceiptAdmission.VerifyAsync';
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && canonicalize(Object.keys(value).sort()) === canonicalize([...keys].sort());
const fail = message =>
{
    throw new Error(`current activation: ${message}`);
};
const identity = manifest => ({ candidateId: manifest.candidateId, manifestContentDigest: manifest.contentDigest });
const same = (left, right) => canonicalize(left) === canonicalize(right);

function closure(manifest)
{
    return {
        identity: releaseIdentityRosterContent(manifest.identity), imageDigest: manifest.imageDigest,
        frontendManifestHash: manifest.frontendManifestHash, wasmArtifactHash: manifest.wasmArtifactHash,
        currentSchema: { receiptFormat: manifest.currentSchema.receiptFormat,
            receiptSha256: manifest.currentSchema.receipt.sha256, receiptContentDigest: manifest.currentSchema.receiptContentDigest,
            target: manifest.currentSchema.target, database: manifest.currentSchema.database,
            actualSchemaDigest: manifest.currentSchema.actualSchemaDigest },
        runtimeProfile: manifest.runtimeProfile, toolchain: manifest.toolchain, build: manifest.build
    };
}

function seal(value)
{
    const unsigned = { ...value };
    delete unsigned.contentDigest;
    return { ...unsigned, contentDigest: `sha256:${digestValue(unsigned)}` };
}

export function createCurrentActivationPlan({ manifest, manifestReference, manifestSha256, activeBefore, releaseIdContract })
{
    const errors = createReleaseManifestValueContract({ releaseIdContract }).validateReleaseManifest(manifest,
        { requireConcreteRuntimeProfile: true });
    if (errors.length > 0)
    {
        fail(errors.join('; '));
    }
    const plan = seal({ schema: 'fsusblog.current-activation-plan.v1',
        candidateId: manifest.candidateId,
        manifest: { reference: manifestReference, sha256: manifestSha256, contentDigest: manifest.contentDigest },
        closure: closure(manifest), closureDigest: `sha256:${digestValue(closure(manifest))}`,
        activeBefore: structuredClone(activeBefore), currentActive: structuredClone(activeBefore), phase: 'prepared',
        nativeAdmission: { owner: currentActivationNativeOwner, bridge: 'unconfigured', claimEligible: false },
        failurePolicy: { beforeSwitch: 'keep-active', afterSwitch: 'restore-required' }, errorCode: null });
    validateCurrentActivationPlan(plan, manifest);
    return plan;
}

// Persisted state and self-reported status never grant permission to switch.
export function validateCurrentActivationPlan(plan, manifest)
{
    if (!closed(plan, ['schema', 'candidateId', 'manifest', 'closure', 'closureDigest', 'activeBefore',
        'currentActive', 'phase', 'nativeAdmission', 'failurePolicy', 'errorCode', 'contentDigest'])
        || plan.schema !== 'fsusblog.current-activation-plan.v1' || !currentActivationPhases.includes(plan.phase))
    {
        fail('closed plan/state fields required');
    }
    if (!closed(plan.manifest, ['reference', 'sha256', 'contentDigest']) || !digest(plan.manifest.sha256)
        || typeof plan.manifest.reference !== 'string' || !path.isAbsolute(plan.manifest.reference)
        || path.resolve(plan.manifest.reference) !== plan.manifest.reference
        || [...plan.manifest.reference].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        || plan.manifest.reference.split('/').some(part => ['latest', 'previous', 'stable'].includes(part)))
    {
        fail('explicit canonical manifest reference/digest required');
    }
    if (plan.candidateId !== manifest.candidateId || plan.manifest.contentDigest !== manifest.contentDigest
        || !same(plan.closure, closure(manifest)) || plan.closureDigest !== `sha256:${digestValue(closure(manifest))}`)
    {
        fail('mixed or stale candidate activation closure');
    }
    for (const active of [plan.activeBefore, plan.currentActive])
    {
        if (!closed(active, ['candidateId', 'manifestContentDigest']) || !digest(active.candidateId)
            || !digest(active.manifestContentDigest))
        {
            fail('closed active candidate identity required');
        }
    }
    if (['prepared', 'verified', 'switching', 'failed-before-switch', 'rollback-to-unactivated-candidate'].includes(plan.phase)
        && !same(plan.currentActive, plan.activeBefore))
    {
        fail('active identity changed before atomic activation');
    }
    if (plan.phase === 'active' && !same(plan.currentActive, identity(manifest)))
    {
        fail('active identity differs from the whole current candidate');
    }
    if (plan.phase === 'restore-required' && !same(plan.currentActive, plan.activeBefore)
        && !same(plan.currentActive, identity(manifest)))
    {
        fail('restore cannot splice candidate identities');
    }
    if (!same(plan.nativeAdmission, { owner: currentActivationNativeOwner, bridge: 'unconfigured', claimEligible: false }))
    {
        fail('native admission cannot be granted by plan metadata');
    }
    if (!same(plan.failurePolicy, { beforeSwitch: 'keep-active', afterSwitch: 'restore-required' }))
    {
        fail('current-only failure policy required');
    }
    if (['failed-before-switch', 'rollback-to-unactivated-candidate', 'restore-required'].includes(plan.phase)
        ? typeof plan.errorCode !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/u.test(plan.errorCode)
        : plan.errorCode !== null)
    {
        fail('phase/error identity mismatch');
    }
    if (seal(plan).contentDigest !== plan.contentDigest)
    {
        fail('activation plan content seal mismatch');
    }
    return plan;
}

export function verifyCurrentActivationArtifacts(plan, options)
{
    const { manifest, readBytes } = options;
    validateCurrentActivationPlan(plan, manifest);
    if (!['prepared', 'verified'].includes(plan.phase))
    {
        fail('artifact verification cannot replay a failed or activated plan');
    }
    const bytes = readBytes(plan.manifest.reference);
    if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024
        || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== plan.manifest.sha256
        || !same(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), manifest))
    {
        fail('explicit manifest artifact bytes mismatch');
    }
    const evidence = verifyReleaseManifestArtifacts(options);
    return { plan: seal({ ...structuredClone(plan), phase: 'verified' }), evidence };
}

export function beginCurrentActivationSwitch(plan, options)
{
    verifyCurrentActivationArtifacts(plan, options);
    // The actual Server API needs native DB/model inspector inputs and publishes
    // CurrentSchemaAdmissionState only after startup admission. No Node/CLI bridge
    // exists yet. Source artifact evidence, fixture booleans and HTTP/process
    // liveness cannot substitute for that original admission or current health.
    fail('native_current_schema_admission_bridge_unconfigured');
}

export function failCurrentActivation(plan, manifest, errorCode)
{
    validateCurrentActivationPlan(plan, manifest);
    if (['failed-before-switch', 'rollback-to-unactivated-candidate', 'restore-required'].includes(plan.phase))
    {
        fail('activation failure is already terminal');
    }
    return validateCurrentActivationPlan(seal({ ...structuredClone(plan), errorCode,
        phase: ['switching', 'active'].includes(plan.phase) ? 'restore-required' : 'failed-before-switch' }), manifest);
}

export function discardUnactivatedCandidate(plan, manifest)
{
    validateCurrentActivationPlan(plan, manifest);
    if (plan.phase !== 'failed-before-switch')
    {
        fail('only an unactivated failed candidate can be discarded');
    }
    return validateCurrentActivationPlan(seal({ ...structuredClone(plan), phase: 'rollback-to-unactivated-candidate' }), manifest);
}
