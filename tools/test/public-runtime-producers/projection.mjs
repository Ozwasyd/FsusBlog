const { canonicalJson, digestCanonical, sealContentDigest } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { buildSettledPhaseJoinEvidence } = await import(new URL('../bundles/bundle-steps.mjs', import.meta.url));

import { verifyPublicRuntimeDeclarations } from './declarations.mjs';

const terminalStates = new Set(['success', 'failed', 'timed-out', 'cancelled', 'blocked', 'internal-error']);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const identityKeys = ['runId', 'sourceCommit', 'sourceFingerprint', 'candidateDigest', 'buildDigest',
    'manifestDigest', 'runtimeIdentityDigest', 'backendUrl', 'previewUrl'];

function requireCondition(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function exactKeys(value, keys, label)
{
    requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value)
        && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), `${label} fields mismatch`);
}

function validateIdentity(identity)
{
    exactKeys(identity, identityKeys, 'runtime identity');
    requireCondition(identityKeys.every((key) => typeof identity[key] === 'string'), 'runtime identity fields must be strings');
    requireCondition(/^[a-zA-Z0-9_-]+$/u.test(identity.runId), 'invalid runId');
    requireCondition(/^[a-f0-9]{40}$/u.test(identity.sourceCommit), 'invalid sourceCommit');
    for (const field of identityKeys.filter((key) => key.endsWith('Digest') || key === 'sourceFingerprint'))
    {
        requireCondition(digestPattern.test(identity[field]), `invalid ${field}`);
    }
    for (const field of ['backendUrl', 'previewUrl'])
    {
        const url = new URL(identity[field]);
        requireCondition(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
            && !url.search && !url.hash, `invalid ${field}`);
    }
}

function validateRef(reference, runId, label)
{
    exactKeys(reference, ['ref', 'contentDigest'], label);
    requireCondition(typeof reference.ref === 'string' && reference.ref.startsWith(`runs/${runId}/`)
        && reference.ref.split('/').every((part) => /^[a-zA-Z0-9_.-]+$/u.test(part)
            && !['.', '..', 'latest'].includes(part)), `${label} must be an explicit current-run ref`);
    requireCondition(digestPattern.test(reference.contentDigest), `${label} digest invalid`);
}

function classify(node, receipt, failureKind)
{
    if (receipt.terminalState === 'success')
    {
        return 'success';
    }
    if (receipt.terminalState === 'blocked' || receipt.terminalState === 'cancelled')
    {
        return receipt.terminalState;
    }
    if (node.kind === 'verified-postcondition-barrier')
    {
        return 'reset-failure';
    }
    if (receipt.terminalState === 'failed' && failureKind === 'product')
    {
        return 'product-failure';
    }
    return failureKind === 'state-corruption' ? 'state-corruption' : 'infrastructure-failure';
}

function validateMaterial(input, node, declarations, identity)
{
    exactKeys(input, ['ref', 'contentDigest', 'document'], 'terminal input');
    validateRef({ ref: input.ref, contentDigest: input.contentDigest }, identity.runId, 'terminal input');
    requireCondition(input.contentDigest === digestCanonical(input.document), 'terminal material digest mismatch');
    const material = input.document;
    exactKeys(material, ['schema', 'authority', 'producerId', 'declarationDigest', 'identity', 'schedulerReceipt',
        'attemptRef', 'fixtureRef', 'stateAccessRef', 'replayRef', 'artifactRefs', 'evidenceRefs',
        'failureKind', 'postconditionRef', 'measurement'], 'terminal material');
    requireCondition(material.schema === 'fsusblog.public-runtime-terminal-material.v1'
        && material.authority === 'DATA_ONLY', 'terminal material is not DATA_ONLY');
    requireCondition(material.producerId === node.id && material.declarationDigest === declarations.contentDigest,
        'terminal producer/declaration mismatch');
    requireCondition(canonicalJson(material.identity) === canonicalJson(identity), 'terminal runtime identity drift');
    const receipt = material.schedulerReceipt;
    requireCondition(receipt?.schema === 'fsusblog.scheduler.terminal-receipt.v1' && receipt.stepId === node.id
        && terminalStates.has(receipt.terminalState), 'scheduler terminal receipt mismatch');
    requireCondition(typeof receipt.reasonCode === 'string' && receipt.reasonCode.length > 0
        && Array.isArray(receipt.primaryFailureRefs), 'scheduler terminal reasons missing');
    requireCondition(['none', 'product', 'infrastructure', 'state-corruption'].includes(material.failureKind), 'invalid failure kind');
    requireCondition(receipt.terminalState !== 'success' || material.failureKind === 'none', 'success hides failure');
    for (const field of ['artifactRefs', 'evidenceRefs'])
    {
        requireCondition(Array.isArray(material[field]), `${field} must be explicit`);
        material[field].forEach((reference) => validateRef(reference, identity.runId, field));
    }
    const executed = receipt.terminalState !== 'blocked';
    for (const field of ['fixtureRef', 'stateAccessRef', 'replayRef'])
    {
        if (executed || material[field] !== null)
        {
            validateRef(material[field], identity.runId, field);
        }
    }
    if (node.kind === 'correctness' && executed)
    {
        validateRef(material.attemptRef, identity.runId, 'attemptRef');
    }
    else
    {
        requireCondition(material.attemptRef === null, 'blocked/barrier node cannot claim a correctness attempt');
    }
    if (node.kind === 'verified-postcondition-barrier' && receipt.terminalState === 'success')
    {
        validateRef(material.postconditionRef, identity.runId, 'postconditionRef');
    }
    else
    {
        requireCondition(material.postconditionRef === null, 'unexpected successful postcondition ref');
    }
    const measurementRequired = node.execution?.measurementWindowId && executed
        && (receipt.terminalState === 'success' || material.failureKind === 'product');
    if (node.execution?.measurementWindowId && executed && material.measurement !== null)
    {
        const measurement = material.measurement;
        exactKeys(measurement, ['windowId', 'runtimeIdentityDigest', 'fixtureRef', 'admissionRef', 'noiseRef',
            'quiescenceRef', 'startedNs', 'finishedNs'], 'measurement');
        requireCondition(measurement.windowId === node.id
            && measurement.runtimeIdentityDigest === identity.runtimeIdentityDigest
            && canonicalJson(measurement.fixtureRef) === canonicalJson(material.fixtureRef), 'measurement identity drift');
        for (const field of ['admissionRef', 'noiseRef', 'quiescenceRef'])
        {
            validateRef(measurement[field], identity.runId, field);
        }
        requireCondition(typeof measurement.startedNs === 'string' && typeof measurement.finishedNs === 'string'
            && /^\d+$/u.test(measurement.startedNs) && /^\d+$/u.test(measurement.finishedNs)
            && BigInt(measurement.finishedNs) >= BigInt(measurement.startedNs), 'invalid measurement interval');
    }
    else
    {
        requireCondition(!measurementRequired && material.measurement === null, 'missing or unexpected measurement material');
    }
    return material;
}

/**
 * Read-only DATA_ONLY projection over exact supplied terminal materials. Digests
 * prove input consistency, not receipt authority or runtime qualification.
 */
export function projectPublicRuntimeOutcomes({ declarations, identity, inputs }, options = {})
{
    verifyPublicRuntimeDeclarations(declarations, options);
    validateIdentity(identity);
    const children = declarations.nodes.filter((node) => node.kind !== 'settled-projection');
    requireCondition(Array.isArray(inputs) && inputs.length === children.length, 'terminal input membership incomplete');
    const byId = new Map();
    const inputRefs = new Set();
    for (const input of inputs)
    {
        const id = input?.document?.producerId;
        requireCondition(children.some((node) => node.id === id) && !byId.has(id), 'unknown/duplicate terminal producer');
        requireCondition(!inputRefs.has(input.ref), 'duplicate terminal ref');
        byId.set(id, input);
        inputRefs.add(input.ref);
    }
    const attempts = new Set();
    const outcomes = children.map((node) =>
    {
        const input = byId.get(node.id);
        const material = validateMaterial(input, node, declarations, identity);
        if (material.attemptRef)
        {
            requireCondition(!attempts.has(material.attemptRef.ref), 'correctness attempt reused across producers');
            attempts.add(material.attemptRef.ref);
        }
        return {
            producerId: node.id,
            terminalState: material.schedulerReceipt.terminalState,
            classification: classify(node, material.schedulerReceipt, material.failureKind),
            reasonCode: material.schedulerReceipt.reasonCode,
            primaryFailureRefs: material.schedulerReceipt.primaryFailureRefs,
            terminalRef: { ref: input.ref, contentDigest: input.contentDigest },
            attemptRef: material.attemptRef,
            fixtureRef: material.fixtureRef,
            stateAccessRef: material.stateAccessRef,
            replayRef: material.replayRef,
            artifactRefs: material.artifactRefs,
            evidenceRefs: material.evidenceRefs,
            postconditionRef: material.postconditionRef,
            measurement: material.measurement
        };
    });
    if (declarations.tier === 'load')
    {
        const first = outcomes.find((outcome) => outcome.producerId === 'load-public-api');
        const reset = outcomes.find((outcome) => outcome.producerId === 'reset-pre-notification-stream');
        const second = outcomes.find((outcome) => outcome.producerId === 'load-notification-stream-pressure');
        requireCondition(reset.terminalState === 'success' || second.terminalState === 'blocked',
            'second window executed without successful reset');
        if (first.measurement && second.measurement)
        {
            requireCondition(BigInt(first.measurement.finishedNs) <= BigInt(second.measurement.startedNs),
                'measurement windows overlap');
            for (const field of ['admissionRef', 'noiseRef'])
            {
                requireCondition(first.measurement[field].ref !== second.measurement[field].ref
                    && first.measurement[field].contentDigest !== second.measurement[field].contentDigest,
                `measurement ${field} reused across windows`);
            }
        }
    }
    const summary = declarations.nodes.find((node) => node.kind === 'settled-projection');
    // Reuse canonical settled-join status semantics; no independent success policy.
    const { evidence: join } = buildSettledPhaseJoinEvidence({
        stepId: summary.id,
        dependencyIds: summary.settledDependsOn,
        dependencyOutcomes: Object.fromEntries(outcomes.map((outcome) => [outcome.producerId, outcome.terminalState])),
        dependencyResults: Object.fromEntries(children.map((node) => [node.id, byId.get(node.id).document.schedulerReceipt])),
        evidenceRef: `runs/${identity.runId}/${summary.id}/projection`,
        generatedAt: 'DATA_ONLY'
    });
    return sealContentDigest({
        schema: 'fsusblog.public-runtime-settled-projection.v1',
        authority: 'DATA_ONLY',
        qualificationEligible: false,
        tier: declarations.tier,
        declarationDigest: declarations.contentDigest,
        identity: structuredClone(identity),
        terminalState: join.terminalState,
        reasonCode: join.reasonCode,
        primaryFailureRefs: join.primaryFailureRefs,
        outcomes: structuredClone(outcomes)
    });
}

export function verifyPublicRuntimeProjection(projection, heldInputs, options = {})
{
    const expected = projectPublicRuntimeOutcomes(heldInputs, options);
    requireCondition(canonicalJson(projection) === canonicalJson(expected), 'settled projection tamper/input mismatch');
    return expected;
}
