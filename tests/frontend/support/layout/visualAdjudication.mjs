import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '@fsusblog/layout-governance/schema-validator';

import {
    compositionDigest,
    compositionLedgerPath,
    createCompositionIdentity,
    verifyCompositionIdentity
} from './compositionContracts.mjs';
import { inspectVisualProducerAdmission, visualProducerAdmissionIdentity } from './visualProducerAdmission.mjs';



export const visualAdjudicationSchemaPath = 'config/schemas/layout-visual-adjudication.schema.json';
const schemaUrl = new URL('../../../../config/schemas/layout-visual-adjudication.schema.json', import.meta.url);
const schemaBytes = readFileSync(schemaUrl);
const loadedVerifierBytes = readFileSync(fileURLToPath(import.meta.url));
const schema = JSON.parse(schemaBytes.toString('utf8'));
// The schema owns the rubric. There is no independently maintained scoring list.
export const visualRubricFields = Object.freeze([...schema.$defs.rubric.required]);
export const visualEvidenceKinds = Object.freeze([...schema.$defs.evidence.properties.kind.enum]);

export function visualArtifactDigest(bytes)
{
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
    {
        fail('artifact-bytes-required', 'evidence must provide explicit artifact bytes');
    }
    return createHash('sha256').update(bytes).digest('hex');
}

export function visualVerifierIdentity()
{
    if (visualArtifactDigest(readFileSync(schemaUrl)) !== visualArtifactDigest(schemaBytes)
        || visualArtifactDigest(readFileSync(fileURLToPath(import.meta.url))) !== visualArtifactDigest(loadedVerifierBytes))
    {
        fail('version-drift', 'loaded schema/verifier bytes differ from current source');
    }
    return {
        schemaDigest: visualArtifactDigest(schemaBytes),
        verifierDigest: visualArtifactDigest(loadedVerifierBytes),
        producerAdmissionDigest: visualProducerAdmissionIdentity().producerAdmissionDigest,
        rubricDigest: compositionDigest(schema.$defs.rubric),
        rubricVersion: schema.properties.rubricVersion.const,
        verifierVersion: schema.properties.verifierVersion.const
    };
}

export function visualReceiptDigest(receipt)
{
    const unsigned = { ...receipt };
    delete unsigned.contentDigest;
    return compositionDigest(unsigned);
}

function fail(code, message)
{
    const error = new Error(`[layout-visual-adjudication] ${message}`);
    error.code = `layout-visual-${code}`;
    throw error;
}

function equal(actual, expected, label)
{
    if (compositionDigest(actual) !== compositionDigest(expected))
    {
        fail('binding-mismatch', label);
    }
}

function exactArtifacts(receipt, artifacts)
{
    const ids = receipt.evidence.map(({ id }) => id);
    if (new Set(ids).size !== ids.length)
    {
        fail('evidence-duplicate', 'duplicate evidence ID');
    }
    if (!artifacts || Object.keys(artifacts).length !== ids.length
        || Object.keys(artifacts).some((id) => !ids.includes(id)))
    {
        fail('evidence-cardinality', 'explicit artifact set must match receipt evidence exactly');
    }
    for (const reference of receipt.evidence)
    {
        const artifact = artifacts[reference.id];
        if (visualArtifactDigest(artifact.bytes) !== reference.contentDigest
            || visualArtifactDigest(artifact.opaqueProducerBytes) !== reference.opaqueProducerDigest)
        {
            fail('artifact-tampered', `${reference.id}: artifact or opaque producer digest mismatch`);
        }
        equal(reference.binding, receipt.binding, `${reference.id}: cross-scene or identity binding`);
    }
}

function observeSynthetic(reference, artifact, purpose)
{
    if (purpose !== 'synthetic-contract-test')
    {
        fail('synthetic-not-admitted', 'synthetic evidence is test-only');
    }
    let observation;
    try
    {
        observation = JSON.parse(Buffer.from(artifact.opaqueProducerBytes).toString('utf8'));
    }
    catch
    {
        fail('synthetic-invalid', 'invalid synthetic test observation');
    }
    if (observation.fixtureClass !== 'synthetic' || observation.kind !== reference.kind
        || !['pass', 'fail'].includes(observation.outcome)
        || compositionDigest(observation.binding) !== compositionDigest(reference.binding))
    {
        fail('synthetic-invalid', `${reference.id}: synthetic observation does not bind this artifact`);
    }
    return observation.outcome;
}

function verifyEvidence(receipt, artifacts, purpose)
{
    const outcomes = new Map();
    for (const reference of receipt.evidence)
    {
        if (receipt.evidenceClass === 'rendered')
        {
            // The canonical #2098 diagnostic API is consumed separately through
            // inspectCompositionObservationDiagnostic. Its diagnostic-only
            // source/DOM observation is not qualified static/DOM scene evidence.
            // Do not split it into two receipts or promote a status bit to pass.
            const owner = ['static', 'dom'].includes(reference.kind) ? 2098 : 2099;
            fail('producer-adapter-unavailable', `${reference.kind}: canonical producer adapter for #${owner} unavailable`);
        }
        outcomes.set(reference.id, observeSynthetic(reference, artifacts[reference.id], purpose));
    }
    return outcomes;
}

function verifyMovement(receipt, inputs, artifacts)
{
    const movement = receipt.baselineMovement;
    if (!movement)
    {
        return;
    }
    if (movement.ledgerPath !== compositionLedgerPath
        || movement.ledgerDigest !== compositionDigest(inputs.ledger)
        || movement.ledgerDigest !== receipt.compositionIdentity.visualLedgerDigest)
    {
        fail('ledger-mismatch', 'movement does not reference the sole current visual ledger');
    }
    const entries = inputs.ledger.entries.filter((entry) => entry.issue === movement.issue
        && entry.archetypes.includes(receipt.binding.scene.archetype));
    if (entries.length !== 1 || compositionDigest(entries[0]) !== movement.entryDigest
        || entries[0].classification !== movement.classification)
    {
        fail('ledger-entry-mismatch', 'movement requires an exact-one matching ledger entry digest/classification');
    }
    if (movement.sourceCommit !== receipt.compositionIdentity.sourceCommit
        || movement.fsusUIBaselineIdentityDigest !== receipt.compositionIdentity.fsusUIBaselineIdentityDigest
        || movement.compositionContractDigest !== receipt.compositionIdentity.compositionContractDigest)
    {
        fail('ledger-mismatch', 'movement source, FsusUI, or composition identity is stale');
    }
    if (!receipt.evidence.some((entry) => entry.kind === 'screenshot' && entry.contentDigest === movement.newScreenshotDigest))
    {
        fail('ledger-mismatch', 'movement new screenshot is not current rendered evidence');
    }
    const old = artifacts.oldScreenshot;
    if ((movement.kind === 'creation' && (movement.oldScreenshotDigest !== null || old))
        || (movement.kind === 'movement' && (!old || visualArtifactDigest(old.bytes) !== movement.oldScreenshotDigest)))
    {
        fail('ledger-mismatch', 'movement old screenshot bytes missing or tampered');
    }
}

/**
 * Contract validation only. Rendered production evidence is deliberately blocked
 * until canonical #2098/#2099 adapters are supplied. Synthetic success never
 * qualifies a page, archetype, runtime, baseline movement, or release.
 */
export function verifyVisualAdjudication(receipt, context)
{
    const errors = validateJsonSchema(receipt, schema);
    if (errors.length)
    {
        fail('schema-invalid', errors.join('; '));
    }
    const identity = createCompositionIdentity(context.inputs, context.currentSource);
    verifyCompositionIdentity(receipt.compositionIdentity, identity);
    const verifier = visualVerifierIdentity();
    for (const [key, value] of Object.entries(verifier))
    {
        if (receipt[key] !== value)
        {
            fail('version-drift', `stale ${key}`);
        }
    }
    if (receipt.contentDigest !== visualReceiptDigest(receipt))
    {
        fail('receipt-tampered', 'receipt content digest mismatch');
    }
    const binding = {
        scene: context.expectedScene,
        compositionIdentityDigest: identity.identityDigest,
        worktreeFingerprint: context.worktreeFingerprint,
        runId: context.runId,
        attemptId: context.attemptId
    };
    equal(receipt.binding, binding, 'current scene/run/source/worktree mismatch');
    const archetype = context.inputs.matrix.archetypes.find((entry) =>
        `${entry.surface}/${entry.kind}` === receipt.binding.scene.archetype);
    if (!archetype?.critical || receipt.binding.scene.routePattern !== archetype.path)
    {
        fail('scene-unregistered', 'scene must reference a critical entry from the sole matrix');
    }
    if (receipt.adjudicator.id === receipt.adjudicator.independentReviewerId
        || receipt.adjudicator.runId !== context.runId)
    {
        fail('independence-invalid', 'distinct independent reviewer and current run required');
    }
    const { oldScreenshot, ...artifacts } = context.artifacts ?? {};
    exactArtifacts(receipt, artifacts);
    const screenshots = receipt.evidence.filter((entry) => entry.kind === 'screenshot');
    if (screenshots.length !== 1)
    {
        fail('evidence-cardinality', 'one screenshot observation per scene required');
    }
    if (!context.baseline || !['existing', 'missing'].includes(context.baseline.kind))
    {
        fail('baseline-unbound', 'explicit current baseline observation required');
    }
    const moved = context.baseline.kind === 'missing'
        || visualArtifactDigest(context.baseline.bytes) !== screenshots[0].contentDigest;
    if (moved !== Boolean(receipt.baselineMovement))
    {
        fail('ledger-mismatch', 'baseline creation/movement needs an exact ledger binding');
    }
    if (receipt.baselineMovement)
    {
        if (receipt.baselineMovement.kind !== (context.baseline.kind === 'missing' ? 'creation' : 'movement'))
        {
            fail('ledger-mismatch', 'baseline observation does not match movement kind');
        }
        if (context.baseline.kind === 'existing')
        {
            if (!oldScreenshot || visualArtifactDigest(oldScreenshot.bytes) !== visualArtifactDigest(context.baseline.bytes))
            {
                fail('ledger-mismatch', 'movement old screenshot is not the explicitly supplied baseline');
            }
        }
    }
    else if (oldScreenshot)
    {
        fail('evidence-cardinality', 'unconsumed old screenshot artifact');
    }
    verifyMovement(receipt, context.inputs, { ...artifacts, oldScreenshot });
    // Canonical origin/transport/browser admission is available independently of
    // the missing static/DOM/geometry producer semantics. It cannot sign a pass.
    if (receipt.evidenceClass === 'rendered' && context.producerAdmission)
    {
        inspectVisualProducerAdmission({
            ...context.producerAdmission, visualReceipt: receipt,
            evidenceArtifacts: artifacts, purpose: context.purpose
        });
    }
    const outcomes = verifyEvidence(receipt, artifacts, context.purpose);
    const counts = { pass: 0, fail: 0, 'not-observed': 0 };
    for (const fieldName of visualRubricFields)
    {
        const field = receipt.rubric[fieldName];
        equal(field.binding, binding, `${fieldName}: current field binding mismatch`);
        const refs = field.evidenceIds.map((id) => receipt.evidence.find((entry) => entry.id === id));
        if (refs.some((entry) => !entry))
        {
            fail('evidence-missing', `${fieldName}: evidence ID missing`);
        }
        const kinds = new Set(refs.map(({ kind }) => kind));
        if (field.status === 'pass')
        {
            if (visualEvidenceKinds.some((kind) => !kinds.has(kind)))
            {
                fail('evidence-incomplete', `${fieldName}: screenshot, static, DOM and geometry required`);
            }
            if (refs.some(({ id }) => outcomes.get(id) !== 'pass'))
            {
                fail('machine-failure', `${fieldName}: machine failure cannot be overruled by visual pass`);
            }
            if (field.reason !== null || field.blockingIssue !== null)
            {
                fail('status-inconsistent', `${fieldName}: pass has failure metadata`);
            }
        }
        else if (field.status === 'fail')
        {
            if (!field.reason || !field.blockingIssue || field.reason.rubricField !== fieldName
                || !Object.hasOwn(archetype.compositionContract, field.reason.contractField)
                || field.reason.contractField === 'schema'
                || field.reason.code === 'missing-observation')
            {
                fail('failure-unbound', `${fieldName}: canonical reason and blocking production issue required`);
            }
        }
        else if (!field.reason || field.reason.code !== 'missing-observation'
            || field.reason.rubricField !== fieldName
            || !Object.hasOwn(archetype.compositionContract, field.reason.contractField)
            || field.reason.contractField === 'schema' || field.blockingIssue !== null)
        {
            fail('status-inconsistent', `${fieldName}: not-observed requires an explicit missing observation`);
        }
        counts[field.status] += 1;
    }
    const expectedStatus = counts.fail > 0 ? 'failed' : counts['not-observed'] > 0 ? 'incomplete' : 'verified';
    if (receipt.status !== expectedStatus)
    {
        fail('status-inconsistent', 'required fields cannot be promoted to verified');
    }
    return {
        status: `synthetic-contract-${expectedStatus}`,
        evidenceClass: 'synthetic',
        qualificationEligible: false,
        contentDigest: receipt.contentDigest,
        compositionIdentityDigest: identity.identityDigest,
        counts,
        missingProductionCapabilities: [2098, 2099]
    };
}

export function verifyVisualModeParity(left, right)
{
    if (left.compositionIdentity.fsusUIMode !== 'local' || right.compositionIdentity.fsusUIMode !== 'published')
    {
        fail('mode-mismatch', 'comparison requires actual local and published identities');
    }
    for (const field of ['schema', 'rubricVersion', 'rubricDigest', 'schemaDigest', 'verifierVersion', 'verifierDigest', 'producerAdmissionDigest'])
    {
        if (left[field] !== right[field])
        {
            fail('mode-mismatch', `local/published ${field} differs`);
        }
    }
    for (const field of ['sourceCommit', 'archetypeMatrixDigest', 'compositionContractDigest', 'contractSchemaDigest', 'designSourceDigest', 'fixtureSourceDigest'])
    {
        if (left.compositionIdentity[field] !== right.compositionIdentity[field])
        {
            fail('mode-mismatch', `local/published ${field} differs`);
        }
    }
    equal(left.binding.scene, right.binding.scene, 'local/published route fixture or scene differs');
    const currentVerifier = visualVerifierIdentity();
    for (const receipt of [left, right])
    {
        const errors = validateJsonSchema(receipt, schema);
        if (errors.length)
        {
            fail('schema-invalid', errors.join('; '));
        }
        verifyCompositionIdentity(receipt.compositionIdentity, receipt.compositionIdentity);
        for (const [key, value] of Object.entries(currentVerifier))
        {
            if (receipt[key] !== value)
            {
                fail('version-drift', `stale parity ${key}`);
            }
        }
        if (receipt.contentDigest !== visualReceiptDigest(receipt))
        {
            fail('receipt-tampered', 'parity receipt content digest mismatch');
        }
    }
    return { status: 'contract-parity-only', qualificationEligible: false };
}
