/**
 * Narrow ID projection from a verified FixtureReceipt (#1710).
 *
 * Projections are consumer convenience only — never authoritative receipt evidence.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestCanonical, freezeDeep } from './canonical.mjs';
import { validateFixtureReceipt } from './fixture-receipt.mjs';
import { runPostcondition } from './postconditions.mjs';
import { projectPreparedPublicIds } from './prepared-public-projection-contract.mjs';
import { readPrivateJson, writePrivateJson } from './private-io.mjs';
import {
    FIXTURE_ID_PROJECTION_SCHEMA,
    PREPARED_PUBLIC_ID_PROJECTION_SCHEMA,
    PRIVATE_ADMIN_SESSION_PROJECTION_SCHEMA,
    RUNTIME_CACHE_FIXTURE_INPUT_SCHEMA
} from './schemas.mjs';
import { assertNoSecrets } from './secrets.mjs';

const { parseMatrix } = await import(new URL('../../test-matrix/parse-matrix.mjs', import.meta.url));
const { buildProducerFixtureVariantPlan, readFixtureCatalogs, sealMatrixFixtureProfile, planFixtureMutation } = await import(new URL('../../testing/fixture-catalog.mjs', import.meta.url));
const { readAuthPrivateCarrier, invokeAuthPrivate } = await import(new URL('../producers/auth-session-producer.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The matrix is the consumer declaration owner; a file name is not admission. */
export function resolveRuntimeCacheConsumer(consumerId, { root = repositoryRoot, catalogs = readFixtureCatalogs() } = {})
{
    const tier = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')).tiers
        .find((item) => item.id === consumerId);
    if (!tier || tier.executionClass !== 'runtime'
        || tier.command !== `node tools/test/run-runtime-cache-evidence.mjs --scenario ${consumerId.slice('runtime-cache-'.length)}`
        || !consumerId.startsWith('runtime-cache-'))
    {
        throw new Error('runtime cache consumer requires its exact matrix tier declaration');
    }
    const sealed = sealMatrixFixtureProfile(tier, catalogs);
    const mutation = planFixtureMutation(tier.fixtureProfile, catalogs);
    return freezeDeep({ consumerId, profileId: tier.fixtureProfile, executionClass: tier.executionClass,
        catalogDigest: sealed.catalogDigest, expandedCapabilityDigest: sealed.expandedCapabilityDigest,
        variantPlanDigest: sealed.variantPlanDigest, capabilityIds: mutation.capabilities,
        producerIds: mutation.producers, prerequisites: sealed.prerequisites ?? [] });
}

export function assertRuntimeCacheConsumerSupported(declaration)
{
    // These are current independent verification ports, not a capability waiver.
    // The other existing ports still reuse prepare observations. Until those
    // owners land real verification, their entire profile is not admissible.
    const pending = declaration.producerIds.filter((id) => !['public-content', 'auth-session'].includes(id));
    if (pending.length > 0)
    {
        throw new Error(`runtime cache profile blocked: independent verification/allocation missing for ${pending.join(', ')}`);
    }
    if (declaration.consumerId === 'runtime-cache-hot-featured-frame'
        && declaration.prerequisites?.length !== 1)
    {
        throw new Error('runtime cache hot-featured-frame blocked: matrix has no explicit typed admin prerequisite declaration');
    }
}

function validateConsumerReceipt(receipt, declaration, catalogs)
{
    const validated = validateFixtureReceipt(receipt, { catalogs, requireVerified: true,
        expectedProfileId: declaration.profileId });
    if (!validated.profileIdentity.sealed || validated.profileIdentity.profileSource !== 'matrix'
        || validated.profileIdentity.executionClass !== declaration.executionClass
        || validated.catalogDigest !== declaration.catalogDigest
        || validated.expandedCapabilityDigest !== declaration.expandedCapabilityDigest
        || validated.variantPlanDigest !== declaration.variantPlanDigest
        || digestCanonical(validated.capabilityMap.map((item) => item.capabilityId).sort())
            !== digestCanonical([...declaration.capabilityIds].sort())
        || digestCanonical(validated.producerReceipts.map((item) => item.producerId).sort())
            !== digestCanonical([...declaration.producerIds].sort()))
    {
        throw new Error('verified receipt does not bind the complete sealed matrix profile');
    }
    return validated;
}

function requireCurrentVerification(receipt, now)
{
    if (!Number.isFinite(Date.parse(receipt.verifiedAt)) || Date.parse(receipt.verifiedAt) > now
        || now - Date.parse(receipt.verifiedAt) > 15 * 60_000)
    {
        throw new Error('runtime cache input requires current independent verification');
    }
}

/** Called only by the existing CLI run lifecycle with an explicitly sealed consumer. */
export async function prepareRuntimeCacheDeclaredPrerequisites({ consumerId, directory, receiptFile,
    prepareStateFile, publicProjectionFile, handles, sealedPrerequisites, signal, catalogs = readFixtureCatalogs() })
{
    signal?.throwIfAborted();
    const declaration = resolveRuntimeCacheConsumer(consumerId, { catalogs });
    assertRuntimeCacheConsumerSupported(declaration);
    if (!declaration.prerequisites.length
        || digestCanonical(sealedPrerequisites) !== digestCanonical(declaration.prerequisites))
    {
        throw new Error('runtime cache requires exact sealed consumer prerequisites before issuance');
    }
    const content = validateConsumerReceipt(readPrivateJson(receiptFile).document, declaration, catalogs);
    const original = validateRuntimePrepareState(reference(prepareStateFile, 'runtime-cache-prepare-state').ref,
        declaration, content.executionIdentity);
    const { plan, prepare, verify } = await import(new URL('../orchestrator.mjs', import.meta.url));
    const { createPortsForProducerIds } = await import(new URL('../producers/catalog-ports.mjs', import.meta.url));
    const inputs = [];
    for (const required of declaration.prerequisites)
    {
        signal?.throwIfAborted();
        const owned = path.join(directory, 'prerequisites', required.id);
        const planned = plan({ profileId: required.profileId, profileSource: 'matrix', executionClass: required.executionClass,
            sealed: { fixtureProfileId: required.profileId, fixtureCatalogDigest: required.catalogDigest,
                expandedCapabilityDigest: required.expandedCapabilityDigest, fixtureVariantIds: required.variantIds,
                fixtureVariantPlanDigest: required.variantPlanDigest, executionClass: required.executionClass } },
        original.plan.executionIdentity);
        const ports = createPortsForProducerIds(required.producerIds);
        const privateHandles = { ...handles, authPrivateCarrierDir: path.join(owned, 'carriers') };
        const authStateFile = path.join(owned, 'prepare-state.json');
        const authReceiptFile = path.join(owned, 'fixture-receipt.json');
        let state;
        let authReceipt;
        try
        {
            state = await prepare(planned, ports, signal, { handles: privateHandles });
            signal?.throwIfAborted();
            writePrivateJson(authStateFile, state, { label: 'runtime-cache-auth-prepare-state' });
            authReceipt = await verify(state, ports, { handles: privateHandles, signal });
            signal?.throwIfAborted();
        }
        catch (error)
        {
            if (error.receipt)
            {
                writePrivateJson(authStateFile, error.receipt, { label: 'runtime-cache-auth-failure-state' });
            }
            if (error.fixtureReceipt)
            {
                writePrivateJson(authReceiptFile, error.fixtureReceipt, { label: 'runtime-cache-auth-failure-receipt' });
            }
            // Do not let the outer CLI run catch overwrite the public lifecycle
            // state with another profile's recovery state.
            throw new Error('runtime cache declared auth prerequisite failed; separate owned recovery state retained', { cause: error });
        }
        validateConsumerReceipt(authReceipt, required, catalogs);
        verifyAuthPublicPrerequisites({ authReceipt, publicReceipt: content, consumerId,
            consumerProfileId: declaration.profileId, catalogs });
        writePrivateJson(authReceiptFile, authReceipt, { label: 'runtime-cache-auth-receipt' });
        const carriers = state.producerResults.find((item) => item.producerId === required.producerId)
            ?.privateCarrierReferences?.filter((item) => item.semanticRole === required.semanticRole);
        if (carriers?.length !== 1)
        {
            throw new Error('runtime cache typed prerequisite requires exact allocated admin carrier');
        }
        const privateAdminFile = path.join(owned, 'admin-private-projection.json');
        await writeVerifiedAdminPrerequisiteProjection(privateAdminFile, { authReceipt, publicReceipt: content,
            carrierReference: carriers[0], consumerId, consumerProfileId: declaration.profileId,
            handles: { ...original.plan.executionIdentity.handles, ...privateHandles }, catalogs, publicProjectionFile, signal });
        signal?.throwIfAborted();
        inputs.push({ declaration: required, receiptFile: authReceiptFile, prepareStateFile: authStateFile, privateAdminFile });
    }
    signal?.throwIfAborted();
    writePrivateJson(path.join(directory, 'prerequisite-inputs.json'), inputs, { label: 'runtime-cache-prerequisite-inputs' });
    writeRuntimeCacheFixtureInput(path.join(directory, `${consumerId}.json`), { consumerId, receiptFile, prepareStateFile,
        publicProjectionFile, prerequisiteInputs: inputs, catalogs });
    return { consumerId, status: 'projected-not-authoritative', prerequisiteIds: inputs.map((item) => item.declaration.id) };
}

function reference(file, label)
{
    const read = readPrivateJson(file, { label });
    return { read, ref: { path: read.path, contentDigest: read.contentDigest } };
}

function readReference(ref, label)
{
    if (!ref || digestCanonical(Object.keys(ref).sort()) !== digestCanonical(['contentDigest', 'path']))
    {
        throw new Error(`${label} reference fields must be exact`);
    }
    const read = readPrivateJson(ref?.path, { label });
    if (read.contentDigest !== ref.contentDigest)
    {
        throw new Error(`${label} content binding mismatch`);
    }
    return read.document;
}

/** Reopen the primary invocation's bounded outlet; references alone are not evidence. */
function readRuntimePrimaryArtifacts(receipt, prepareState, declaration, receiptFile)
{
    const refs = receipt.outputArtifacts;
    const producers = declaration.producerIds;
    if (!Array.isArray(refs) || refs.length === 0)
    {
        throw new Error('runtime cache artifact missing primary invocation outlet');
    }
    if (refs.length > producers.length * 8)
    {
        throw new Error('runtime cache artifact size exceeds bounded record count');
    }
    const directory = path.join(path.dirname(path.resolve(receiptFile)), 'artifacts');
    for (let current = directory; ; current = path.dirname(current))
    {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink())
        {
            throw new Error('runtime cache artifact path ancestors must not be symlinks');
        }
        if (!stat.isDirectory() || process.platform !== 'win32' && [directory, path.dirname(directory)].includes(current)
            && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()))
        {
            throw new Error('runtime cache artifact directory must be private and owned');
        }
        if (current === path.dirname(current))
        {
            break;
        }
    }
    const paths = new Set();
    const records = new Set();
    let totalBytes = 0;
    for (const ref of refs)
    {
        if (!['fixture-prepare-port-result', 'fixture-verify-port-result'].includes(ref.role))
        {
            throw new Error('runtime cache artifact role is not a primary prepare/verify result');
        }
        const target = path.resolve(ref.path);
        if (ref.path !== target || path.dirname(target) !== directory)
        {
            throw new Error('runtime cache artifact path escapes its primary invocation');
        }
        if (paths.has(target))
        {
            throw new Error('runtime cache artifact duplicate path');
        }
        paths.add(target);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink())
        {
            throw new Error('runtime cache artifact must not be a symlink');
        }
        if (!stat.isFile() || process.platform !== 'win32'
            && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()))
        {
            throw new Error('runtime cache artifact must be a private owned regular file');
        }
        if (stat.size <= 0 || stat.size > 2 * 1024 * 1024 || totalBytes + stat.size > producers.length * 8 * 1024 * 1024)
        {
            throw new Error('runtime cache artifact size exceeds bounded invocation capacity');
        }
        const read = readPrivateJson(target, { label: 'runtime-cache-artifact' });
        if (read.bytes.length !== stat.size || read.contentDigest !== ref.digest)
        {
            throw new Error('runtime cache artifact digest or size changed');
        }
        totalBytes += read.bytes.length;
        const { document } = read;
        const producerId = document.binding?.producerId;
        const phase = document.phase;
        const produced = receipt.producerReceipts.find((item) => item.producerId === producerId);
        const slice = prepareState.plan.variantPlan.byProducer.find((item) => item.producerId === producerId);
        if (!producers.includes(producerId) || !produced || !slice)
        {
            throw new Error('runtime cache artifact producer binding mismatch');
        }
        const variants = buildProducerFixtureVariantPlan({ producerId,
            variantIds: slice.variants.map((item) => item.id), fixtureVariantIds: prepareState.plan.variantIds,
            fixtureVariantPlanDigest: prepareState.plan.variantPlanDigest });
        const expectedBinding = { ...receipt.executionIdentity, profileId: declaration.profileId, producerId,
            consumerId: declaration.consumerId, variantIds: variants.variants.map((item) => item.id).sort(),
            producerVariantPlanDigest: variants.producerVariantPlanDigest };
        if (digestCanonical(document.binding) !== digestCanonical(expectedBinding)
            || produced.producerVariantPlanDigest !== variants.producerVariantPlanDigest
            || digestCanonical(Object.keys(document).sort()) !== digestCanonical(['binding', 'checkedPostconditions', 'phase', 'result'])
            || !Array.isArray(document.checkedPostconditions) || !document.result || document.result.producerId !== producerId
            || !['prepare', 'verify'].includes(phase) || phase === 'verify' && document.result.ok !== true)
        {
            throw new Error('runtime cache artifact execution/source/profile/variant binding mismatch');
        }
        if (Object.keys(document.result).some((name) => !['ok', 'producerId', 'observations', 'entityIdentities',
            'authSourceReceiptDigest', 'publicSourceReceiptDigest', 'readObservationDigest'].includes(name)))
        {
            throw new Error('runtime cache artifact result contains an unowned field');
        }
        assertNoSecrets(document);
        if (ref.role !== `fixture-${phase}-port-result` || path.basename(target) !== `${phase}-${producerId}-port-result.json`)
        {
            throw new Error('runtime cache artifact role/path differs from actual producer phase');
        }
        const key = `${producerId}:${phase}`;
        if (records.has(key))
        {
            throw new Error('runtime cache artifact duplicate producer phase');
        }
        records.add(key);
    }
    if (producers.some((id) => !records.has(`${id}:prepare`) || !records.has(`${id}:verify`)))
    {
        throw new Error('runtime cache artifact missing primary prepare/verify result');
    }
}

export function writeRuntimeCacheFixtureInput(file, { receiptFile, prepareStateFile, publicProjectionFile, prerequisiteInputs = [],
    consumerId, root = repositoryRoot, catalogs = readFixtureCatalogs(), now = Date.now() } = {})
{
    const declaration = resolveRuntimeCacheConsumer(consumerId, { root, catalogs });
    assertRuntimeCacheConsumerSupported(declaration);
    if (!Array.isArray(prerequisiteInputs) || prerequisiteInputs.length !== declaration.prerequisites.length)
    {
        throw new Error('runtime cache requires exact declared typed admin prerequisite inputs');
    }
    const receipt = reference(receiptFile, 'runtime-cache-verified-receipt');
    const validated = validateConsumerReceipt(receipt.read.document, declaration, catalogs);
    requireCurrentVerification(validated, now);
    const prepare = reference(prepareStateFile, 'runtime-cache-prepare-state');
    if (prepare.read.document.plan?.profileIdentity?.profileId !== declaration.profileId
        || prepare.read.document.plan?.catalogDigest !== declaration.catalogDigest)
    {
        throw new Error('runtime cache prepare state/profile mismatch');
    }
    const state = validateRuntimePrepareState(prepare.ref, declaration, validated.executionIdentity);
    readRuntimePrimaryArtifacts(validated, state, declaration, receipt.ref.path);
    const projection = writeFixtureIdProjection(publicProjectionFile, validated, { catalogs });
    const publicRef = reference(publicProjectionFile, 'runtime-cache-public-projection');
    const prerequisites = declaration.prerequisites.map((required, index) =>
    {
        const supplied = prerequisiteInputs[index];
        if (digestCanonical(Object.keys(supplied).sort()) !== digestCanonical(['declaration', 'privateAdminFile', 'prepareStateFile', 'receiptFile'].sort())
            || digestCanonical(supplied.declaration) !== digestCanonical(required))
        {
            throw new Error('runtime cache prerequisite input declaration binding mismatch');
        }
        const auth = reference(supplied.receiptFile, 'runtime-cache-auth-receipt');
        const authReceipt = validateConsumerReceipt(auth.read.document, required, catalogs);
        verifyAuthPublicPrerequisites({ authReceipt, publicReceipt: validated, consumerId,
            consumerProfileId: declaration.profileId, catalogs });
        requireCurrentVerification(authReceipt, now);
        return { declaration: required, receipt: auth.ref,
            prepareState: reference(supplied.prepareStateFile, 'runtime-cache-auth-prepare-state').ref };
    });
    const manifest = { schema: RUNTIME_CACHE_FIXTURE_INPUT_SCHEMA, notAuthoritative: true,
        authority: 'derived-from-verified-fixture-receipt', declaration,
        executionIdentity: validated.executionIdentity, serviceIdentity: validated.serviceIdentity,
        receipt: receipt.ref, prepareState: prepare.ref, publicProjection: publicRef.ref,
        projectionDigest: projection.projectionDigest, prerequisites,
        privateAdmin: prerequisiteInputs.length ? reference(prerequisiteInputs[0].privateAdminFile, 'runtime-cache-private-admin').ref : null,
        issuedAtUtc: new Date(now).toISOString(), expiresAtUtc: new Date(now + 15 * 60_000).toISOString() };
    assertNoSecrets(manifest);
    const written = writePrivateJson(file, manifest, { label: 'runtime-cache-fixture-input' });
    readRuntimeCacheFixtureInput(file, { consumerId, root, catalogs, now, source: validated.executionIdentity.source,
        runId: validated.executionIdentity.runId, namespace: validated.executionIdentity.namespace,
        serviceGeneration: validated.executionIdentity.serviceGeneration,
        pgContainer: validated.serviceIdentity.databaseInstance, redisContainer: validated.serviceIdentity.redisInstance });
    return written;
}

/** Reopen every referenced file, including private IO mode/no-follow checks. */
export function readRuntimeCacheFixtureInput(file, { consumerId, source, runId, namespace, serviceGeneration,
    pgContainer, redisContainer, root = repositoryRoot, catalogs = readFixtureCatalogs(), now = Date.now() } = {})
{
    const declaration = resolveRuntimeCacheConsumer(consumerId, { root, catalogs });
    assertRuntimeCacheConsumerSupported(declaration);
    const read = readPrivateJson(file, { label: 'runtime-cache-fixture-input' });
    const input = read.document;
    assertNoSecrets(input);
    const fields = ['schema', 'notAuthoritative', 'authority', 'declaration', 'executionIdentity', 'serviceIdentity',
        'receipt', 'prepareState', 'publicProjection', 'projectionDigest', 'prerequisites', 'privateAdmin', 'issuedAtUtc', 'expiresAtUtc'];
    if (input.schema !== RUNTIME_CACHE_FIXTURE_INPUT_SCHEMA || input.notAuthoritative !== true
        || input.authority !== 'derived-from-verified-fixture-receipt'
        || digestCanonical(Object.keys(input).sort()) !== digestCanonical(fields.sort())
        || digestCanonical(input.declaration) !== digestCanonical(declaration)
        || !Number.isFinite(Date.parse(input.issuedAtUtc)) || !Number.isFinite(Date.parse(input.expiresAtUtc))
        || Date.parse(input.issuedAtUtc) > now || Date.parse(input.expiresAtUtc) <= now
        || Date.parse(input.expiresAtUtc) - Date.parse(input.issuedAtUtc) > 15 * 60_000)
    {
        throw new Error('runtime cache input declaration/expiry mismatch');
    }
    const receipt = validateConsumerReceipt(readReference(input.receipt, 'runtime-cache-verified-receipt'), declaration, catalogs);
    requireCurrentVerification(receipt, now);
    const expectedExecution = { runId, namespace, source: { commit: source?.commit,
        worktreeFingerprint: source?.worktreeFingerprint }, serviceGeneration };
    if (!runId || !namespace || !serviceGeneration || !pgContainer || !redisContainer
        || digestCanonical(receipt.executionIdentity) !== digestCanonical(expectedExecution)
        || digestCanonical(input.executionIdentity) !== digestCanonical(receipt.executionIdentity)
        || digestCanonical(input.serviceIdentity) !== digestCanonical(receipt.serviceIdentity)
        || receipt.serviceIdentity.databaseInstance !== pgContainer || receipt.serviceIdentity.redisInstance !== redisContainer
        || receipt.serviceIdentity.redisNamespace !== `FsusBlog_${namespace}_`)
    {
        throw new Error('runtime cache input run/source/service binding mismatch');
    }
    const projection = readReference(input.publicProjection, 'runtime-cache-public-projection');
    if (digestCanonical(projection) !== digestCanonical(projectFixtureIds(receipt, { catalogs }))
        || projection.projectionDigest !== input.projectionDigest)
    {
        throw new Error('runtime cache public projection/private consumer binding mismatch');
    }
    const prepareState = validateRuntimePrepareState(input.prepareState, declaration, expectedExecution);
    readRuntimePrimaryArtifacts(receipt, prepareState, declaration, input.receipt.path);
    if (!Array.isArray(input.prerequisites) || input.prerequisites.length !== declaration.prerequisites.length
        || (!input.prerequisites.length && input.privateAdmin !== null))
    {
        throw new Error('runtime cache prerequisite/private consumer binding mismatch');
    }
    let authReceipt;
    let authPrepareState;
    for (const [index, required] of declaration.prerequisites.entries())
    {
        const supplied = input.prerequisites[index];
        if (digestCanonical(Object.keys(supplied).sort()) !== digestCanonical(['declaration', 'prepareState', 'receipt'])
            || digestCanonical(supplied.declaration) !== digestCanonical(required))
        {
            throw new Error('runtime cache prerequisite sealed declaration binding mismatch');
        }
        authReceipt = validateConsumerReceipt(readReference(supplied.receipt, 'runtime-cache-auth-receipt'), required, catalogs);
        requireCurrentVerification(authReceipt, now);
        verifyAuthPublicPrerequisites({ authReceipt, publicReceipt: receipt, consumerId,
            consumerProfileId: declaration.profileId, catalogs });
        authPrepareState = validateRuntimePrepareState(supplied.prepareState, required, expectedExecution);
        const artifact = readReference(input.privateAdmin, 'runtime-cache-private-admin');
        validateAdminRuntimeArtifact(artifact, { auth: authReceipt, content: receipt, consumerId,
            consumerProfileId: declaration.profileId, executionIdentity: expectedExecution, catalogs, now });
        validateAdminRuntimeCarrier(artifact, authReceipt);
    }
    return { input, receipt, prepareState, projection, authReceipt, authPrepareState, contentDigest: read.contentDigest,
        fixtureFile: input.publicProjection.path };
}

function validateRuntimePrepareState(ref, declaration, expectedExecution)
{
    const state = readReference(ref, 'runtime-cache-prepare-state');
    const planned = state.plan;
    if (state.schema !== 'fsusblog.fixture-prepare-state.v1' || !['prepared', 'verified'].includes(state.terminalState)
        || !planned?.profileIdentity?.sealed || planned.profileIdentity.profileSource !== 'matrix'
        || planned.profileIdentity.profileId !== declaration.profileId
        || planned.profileIdentity.executionClass !== declaration.executionClass
        || planned.catalogDigest !== declaration.catalogDigest || planned.variantPlanDigest !== declaration.variantPlanDigest
        || planned.expandedCapabilityDigest !== declaration.expandedCapabilityDigest
        || digestCanonical({ runId: planned?.executionIdentity?.runId, namespace: planned?.executionIdentity?.namespace,
            source: planned?.executionIdentity?.sourceIdentity,
            serviceGeneration: planned?.executionIdentity?.handles?.serviceGeneration }) !== digestCanonical(expectedExecution))
    {
        throw new Error('runtime cache original prepare-state execution/profile binding mismatch');
    }
    return state;
}

export async function verifyRuntimeCacheFixtureInput(admitted, { handles = {}, signal } = {})
{
    signal?.throwIfAborted();
    const { verify } = await import(new URL('../orchestrator.mjs', import.meta.url));
    const { createPortsForProducerIds } = await import(new URL('../producers/catalog-ports.mjs', import.meta.url));
    const profiles = [{ state: admitted.prepareState, original: admitted.receipt,
        producers: admitted.input.declaration.producerIds }];
    if (admitted.authReceipt)
    {
        profiles.push({ state: admitted.authPrepareState, original: admitted.authReceipt,
            producers: admitted.input.declaration.prerequisites[0].producerIds });
    }
    for (const { state, original, producers } of profiles)
    {
        const current = await verify(state, createPortsForProducerIds(producers), { handles, serviceIdentity: original.serviceIdentity, signal });
        signal?.throwIfAborted();
        for (const field of ['executionIdentity', 'profileIdentity', 'serviceIdentity', 'capabilityMap',
            'databaseObservationDigest', 'redisObservationDigest', 'cacheObservationDigest'])
        {
            if (digestCanonical(current[field]) !== digestCanonical(original[field]))
            {
                throw new Error(`runtime cache independent verification drift: ${field}`);
            }
        }
    }
    if (admitted.authReceipt)
    {
        await readVerifiedAdminRuntimeProjection(admitted.input.privateAdmin.path, { authReceipt: admitted.authReceipt,
            publicReceipt: admitted.receipt, consumerProfileId: admitted.input.declaration.profileId,
            consumerId: admitted.input.declaration.consumerId, executionIdentity: admitted.receipt.executionIdentity,
            expectedContentDigest: admitted.input.privateAdmin.contentDigest, handles, signal });
    }
    signal?.throwIfAborted();
    return admitted;
}

export function writeRuntimeCacheProfileInputs({ directory, receiptFile, prepareStateFile,
    publicProjectionFile, prerequisiteInputs = [], root = repositoryRoot, catalogs = readFixtureCatalogs() } = {})
{
    const receipt = validateFixtureReceipt(readPrivateJson(receiptFile).document, { catalogs, requireVerified: true });
    const tiers = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8')).tiers;
    const results = [];
    for (const tier of tiers.filter((item) => item.id.startsWith('runtime-cache-')
        && item.fixtureProfile === receipt.profileIdentity.profileId))
    {
        const declaration = resolveRuntimeCacheConsumer(tier.id, { root, catalogs });
        try
        {
            assertRuntimeCacheConsumerSupported(declaration);
            if (declaration.prerequisites.length && !prerequisiteInputs.length)
            {
                throw new Error('runtime cache requires exact declared typed admin prerequisite inputs');
            }
        }
        catch (error)
        {
            results.push({ consumerId: tier.id, status: 'blocked', reason: error.message });
            continue;
        }
        writeRuntimeCacheFixtureInput(path.join(directory, `${tier.id}.json`), {
            receiptFile, prepareStateFile, publicProjectionFile, consumerId: tier.id, root, catalogs,
            prerequisiteInputs: declaration.prerequisites.length ? prerequisiteInputs : []
        });
        results.push({ consumerId: tier.id, status: 'projected-not-authoritative' });
    }
    return results;
}

export function verifyAuthPublicPrerequisites({ authReceipt, publicReceipt, consumerProfileId, consumerId, catalogs } = {})
{
    const auth = validateFixtureReceipt(authReceipt, { catalogs, requireVerified: true, expectedProfileId: 'auth-basic' });
    const content = validateFixtureReceipt(publicReceipt, { catalogs, requireVerified: true, expectedProfileId: consumerProfileId });
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(String(consumerId ?? ''))
        || !consumerProfileId || content.profileIdentity.profileId === 'none'
        || !content.producerReceipts.some((item) => item.producerId === 'public-content')
        || !auth.producerReceipts.some((item) => item.producerId === 'auth-session'
            && item.providedCapabilities.includes('auth.admin.full-permission'))
        || !auth.executionIdentity.runId || !auth.executionIdentity.namespace || !auth.executionIdentity.serviceGeneration
        || !auth.executionIdentity.source?.commit || !auth.executionIdentity.source?.worktreeFingerprint
        || digestCanonical(auth.executionIdentity) !== digestCanonical(content.executionIdentity)
        || digestCanonical(auth.serviceIdentity) !== digestCanonical(content.serviceIdentity)
        || !auth.serviceIdentity.databaseInstance || !auth.serviceIdentity.redisInstance)
    {
        throw new Error('verified auth/public prerequisite identity/owner mismatch');
    }
    return Object.freeze({ auth, content, consumerProfileId, consumerId });
}

export async function writeVerifiedAdminPrerequisiteProjection(file, {
    authReceipt, publicReceipt, carrierReference, consumerProfileId, consumerId, handles, catalogs, publicProjectionFile, signal
} = {})
{
    signal?.throwIfAborted();
    const { auth, content } = verifyAuthPublicPrerequisites({ authReceipt, publicReceipt, consumerProfileId, consumerId, catalogs });
    const carrier = readAuthPrivateCarrier(carrierReference);
    const owner = auth.producerReceipts.find((item) => item.producerId === 'auth-session');
    const fact = owner.observations.database.entities.find((item) => item.kind === 'admin'
        && item.id === carrierReference.principalId && item.semanticRole === carrierReference.semanticRole
        && item.capabilityHint === 'auth.admin.full-permission' && item.owned !== false);
    const identity = carrier.identity;
    const execution = auth.executionIdentity;
    if (!fact || fact.fixtureIdentity !== carrier.publicFact.fixtureIdentity
        || digestCanonical(fact.fields) !== digestCanonical(carrier.publicFact.fields)
        || identity.runId !== execution.runId || identity.namespace !== execution.namespace
        || identity.profileId !== auth.profileIdentity.profileId || identity.catalogDigest !== auth.catalogDigest
        || identity.variantPlanDigest !== auth.variantPlanDigest || identity.serviceGeneration !== execution.serviceGeneration
        || identity.sourceCommit !== execution.source.commit || identity.sourceFingerprint !== execution.source.worktreeFingerprint
        || identity.planDigest !== fact.fields.adminFixturePlanDigest)
    {
        throw new Error('auth private reference not bound to sealed owned fixture facts');
    }
    const verified = await invokeAuthPrivate({
        runIdentity: execution.runId, namespace: execution.namespace, handles
    }, carrier, { reveal: true, receiptDigest: auth.receiptDigest, callerAbortSignal: signal });
    signal?.throwIfAborted();
    const credentials = verified.credentials;
    if (!credentials || credentials.sessionId !== fact.fields.adminSessionId
        || Date.parse(credentials.accessTokenExpiresAtUtc) !== Date.parse(fact.fields.adminAccessExpiresAtUtc)
        || Date.parse(credentials.idleExpiresAtUtc) !== Date.parse(fact.fields.adminSessionIdleExpiresAtUtc))
    {
        throw new Error('auth private independent credential coordinates mismatch');
    }
    const projection = {
        schema: PRIVATE_ADMIN_SESSION_PROJECTION_SCHEMA,
        authority: 'derived-from-verified-fixture-receipts-and-live-admin-authority',
        notAuthoritative: true, consumerId, consumerProfileId,
        executionIdentity: execution,
        sourceReceipts: {
            auth: { profileId: auth.profileIdentity.profileId, receiptDigest: auth.receiptDigest },
            public: { profileId: content.profileIdentity.profileId, receiptDigest: content.receiptDigest }
        },
        ...(publicProjectionFile ? {
            publicProjectionReference: (() =>
            {
                writeFixtureIdProjection(publicProjectionFile, content, { catalogs });
                return reference(publicProjectionFile, 'verified-admin-public-projection').ref;
            })(),
            carrierReference, semanticRole: fact.semanticRole
        } : { publicProjection: projectFixtureIds(content, { catalogs }) }),
        adminPrincipalId: fact.id, carrierDigest: verified.carrierDigest,
        expiresAtUtc: new Date(Math.min(...[credentials.accessTokenExpiresAtUtc,
            fact.fields.adminSessionIdleExpiresAtUtc, fact.fields.adminSessionAbsoluteExpiresAtUtc].map(Date.parse))).toISOString(),
        credentials
    };
    const written = writePrivateJson(file, projection, { label: 'verified-admin-prerequisite-projection' });
    // Never return ciphertext or credentials to the CLI stdout channel.
    return Object.freeze({ schema: projection.schema, notAuthoritative: true,
        sourceReceipts: projection.sourceReceipts, contentDigest: written.contentDigest });
}

/** Consume original credentials only after rechecking the existing private owner. */
export async function readVerifiedAdminRuntimeProjection(file, { authReceipt, publicReceipt,
    consumerProfileId, consumerId, executionIdentity, expectedContentDigest, handles, catalogs, signal, now = Date.now() } = {})
{
    signal?.throwIfAborted();
    const { auth, content } = verifyAuthPublicPrerequisites({ authReceipt, publicReceipt,
        consumerProfileId, consumerId, catalogs });
    const read = readPrivateJson(file, { label: 'runtime-cache-private-admin-projection' });
    if (expectedContentDigest !== undefined && read.contentDigest !== expectedContentDigest)
    {
        throw new Error('runtime cache private admin content binding drift');
    }
    const artifact = read.document;
    validateAdminRuntimeArtifact(artifact, { auth, content, consumerProfileId, consumerId, executionIdentity, catalogs, now });
    const { carrier, fact } = validateAdminRuntimeCarrier(artifact, auth);
    const current = await invokeAuthPrivate({ runIdentity: auth.executionIdentity.runId,
        namespace: auth.executionIdentity.namespace, handles }, carrier, { reveal: true, receiptDigest: auth.receiptDigest, callerAbortSignal: signal });
    signal?.throwIfAborted();
    const expectedExpiry = Math.min(...[fact.fields.adminAccessExpiresAtUtc, fact.fields.adminSessionIdleExpiresAtUtc,
        fact.fields.adminSessionAbsoluteExpiresAtUtc].map(Date.parse));
    if (current.carrierDigest !== artifact.carrierDigest
        || digestCanonical(current.credentials) !== digestCanonical(artifact.credentials)
        || Date.parse(artifact.expiresAtUtc) !== expectedExpiry
        || current.credentials.sessionId !== fact.fields.adminSessionId
        || typeof current.credentials.accessToken !== 'string' || !current.credentials.accessToken
        || /[\0\r\n]/u.test(current.credentials.accessToken))
    {
        throw new Error('runtime cache private admin live authority/credential drift');
    }
    return { Authorization: `Bearer ${current.credentials.accessToken}` };
}

function validateAdminRuntimeArtifact(artifact, { auth, content, consumerProfileId, consumerId, executionIdentity, catalogs, now })
{
    const fields = ['schema', 'authority', 'notAuthoritative', 'consumerId', 'consumerProfileId', 'executionIdentity',
        'sourceReceipts', 'publicProjectionReference', 'carrierReference', 'semanticRole', 'adminPrincipalId',
        'carrierDigest', 'expiresAtUtc', 'credentials'];
    if (artifact.schema !== PRIVATE_ADMIN_SESSION_PROJECTION_SCHEMA || artifact.notAuthoritative !== true
        || artifact.authority !== 'derived-from-verified-fixture-receipts-and-live-admin-authority'
        || digestCanonical(Object.keys(artifact).sort()) !== digestCanonical(fields.sort())
        || artifact.consumerId !== consumerId || artifact.consumerProfileId !== consumerProfileId
        || artifact.semanticRole !== 'admin.full-permission' || artifact.publicProjection !== undefined
        || digestCanonical(artifact.executionIdentity) !== digestCanonical(executionIdentity)
        || digestCanonical(artifact.executionIdentity) !== digestCanonical(auth.executionIdentity)
        || artifact.sourceReceipts?.auth?.receiptDigest !== auth.receiptDigest
        || artifact.sourceReceipts?.public?.receiptDigest !== content.receiptDigest
        || artifact.sourceReceipts.auth.profileId !== auth.profileIdentity.profileId
        || artifact.sourceReceipts.public.profileId !== content.profileIdentity.profileId
        || !Number.isFinite(Date.parse(artifact.expiresAtUtc)) || Date.parse(artifact.expiresAtUtc) <= now
        || digestCanonical(readReference(artifact.publicProjectionReference, 'runtime-cache-admin-public-projection'))
            !== digestCanonical(projectFixtureIds(content, { catalogs })))
    {
        throw new Error('runtime cache private admin consumer/role/receipt/expiry binding mismatch');
    }
}

function validateAdminRuntimeCarrier(artifact, auth)
{
    const carrier = readAuthPrivateCarrier(artifact.carrierReference);
    const fact = auth.producerReceipts.find((item) => item.producerId === 'auth-session')
        .observations.database.entities.find((item) => item.kind === 'admin'
            && item.id === artifact.adminPrincipalId && item.semanticRole === artifact.semanticRole
            && item.capabilityHint === 'auth.admin.full-permission' && item.owned !== false);
    if (!fact || artifact.carrierReference.principalId !== fact.id
        || artifact.carrierReference.semanticRole !== fact.semanticRole
        || carrier.publicFact.fixtureIdentity !== fact.fixtureIdentity
        || digestCanonical(carrier.publicFact.fields) !== digestCanonical(fact.fields)
        || carrier.identity.profileId !== auth.profileIdentity.profileId
        || carrier.identity.runId !== auth.executionIdentity.runId || carrier.identity.namespace !== auth.executionIdentity.namespace
        || carrier.identity.sourceCommit !== auth.executionIdentity.source.commit
        || carrier.identity.sourceFingerprint !== auth.executionIdentity.source.worktreeFingerprint
        || carrier.identity.serviceGeneration !== auth.executionIdentity.serviceGeneration
        || carrier.identity.catalogDigest !== auth.catalogDigest || carrier.identity.variantPlanDigest !== auth.variantPlanDigest
        || carrier.identity.planDigest !== fact.fields.adminFixturePlanDigest)
    {
        throw new Error('runtime cache private admin carrier/owned fact binding mismatch');
    }
    return { carrier, fact };
}

export { projectPreparedPublicIds } from './prepared-public-projection-contract.mjs';

/**
 * Deterministically project stable entity IDs from a verified receipt.
 */
export function projectFixtureIds(receipt, {
    catalogs,
    requireVerified = true
} = {})
{
    const validated = validateFixtureReceipt(receipt, { catalogs, requireVerified });
    if (validated.terminalStatus !== 'verified')
    {
        throw new Error('ID projection requires a verified FixtureReceipt');
    }

    const entities = [];
    for (const producerReceipt of validated.producerReceipts ?? [])
    {
        for (const entity of producerReceipt.entityIdentities ?? [])
        {
            entities.push({
                producerId: producerReceipt.producerId,
                kind: entity.kind,
                id: entity.id,
                handle: entity.handle ?? null,
                variantId: entity.variantId ?? null,
                owner: entity.owner ?? null
            });
        }
    }
    entities.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));

    const byKind = {};
    for (const entity of entities)
    {
        if (!byKind[entity.kind])
        {
            byKind[entity.kind] = [];
        }
        byKind[entity.kind].push(entity.id);
    }

    const publicReceipt = validated.producerReceipts.find((item) => item.producerId === 'public-content');
    const requiresPagination = publicReceipt?.providedCapabilities.includes('public.article.pagination-deep');
    let pagination = null;
    if (requiresPagination)
    {
        const database = publicReceipt.databaseObservation ?? publicReceipt.observations?.database;
        const checked = runPostcondition('article-pagination-deep', { observations: { database } });
        if (!checked.ok)
        {
            throw new Error(`verified pagination projection rejected: ${checked.reason}`);
        }
        const keyset = database.entities.find((item) => item.kind === 'pagination-keyset'
            && item.owned !== false
            && (item.capabilityHint === 'article-pagination-deep' || item.postconditionId === 'article-pagination-deep'));
        const fields = keyset.fields;
        pagination = {
            route: fields.route,
            sort: fields.sort,
            pageSize: fields.pageSize,
            generation: fields.generation,
            articleCount: fields.articleCount,
            ownedArticleCount: fields.ownedArticleCount,
            cursors: fields.cursors
        };
    }

    const projection = freezeDeep({
        schema: FIXTURE_ID_PROJECTION_SCHEMA,
        authority: 'derived-from-verified-fixture-receipt',
        notAuthoritative: true,
        sourceReceiptDigest: validated.receiptDigest,
        profileId: validated.profileIdentity.profileId,
        runId: validated.executionIdentity.runId,
        namespace: validated.executionIdentity.namespace,
        catalogDigest: validated.catalogDigest,
        ...(pagination ? { pagination } : {}),
        entities: Object.freeze(entities.map((item) => freezeDeep(item))),
        idsByKind: freezeDeep(byKind),
        // Convenience single-ID fields when exactly one article/category/tag exists.
        articleId: byKind.article?.length === 1 ? byKind.article[0] : null,
        categoryId: byKind.category?.length === 1 ? byKind.category[0] : null,
        tagId: byKind.tag?.length === 1 ? byKind.tag[0] : null,
        projectionDigest: null
    });

    assertNoSecrets(projection);
    const projectionDigest = digestCanonical({
        ...projection,
        projectionDigest: undefined
    });
    return freezeDeep({ ...projection, projectionDigest });
}

export function writeFixtureIdProjection(file, receipt, options = {})
{
    const projection = projectFixtureIds(receipt, options);
    writePrivateJson(file, projection, { label: 'fixture-id-projection' });
    return projection;
}

export function writePreparedPublicIdProjection(file, prepareState)
{
    const projection = projectPreparedPublicIds(prepareState);
    writePrivateJson(file, projection, { label: 'prepared-public-id-projection' });
    return projection;
}

/**
 * Fail closed if a consumer treats a projection document as a verified receipt.
 */
export function assertNotAuthoritativeReceipt(document)
{
    if (document?.schema === FIXTURE_ID_PROJECTION_SCHEMA
    || document?.schema === PREPARED_PUBLIC_ID_PROJECTION_SCHEMA
    || document?.notAuthoritative === true)
    {
        throw new Error('fixture ID projection is not an authoritative FixtureReceipt');
    }
    if (document?.schema === 'fsusblog.fixture-receipt.v1')
    {
        throw new Error('retired fixture receipt schema cannot authorize fixtures');
    }
}
