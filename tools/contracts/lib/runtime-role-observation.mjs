#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

import { digestValue } from '../../fact-extractors/lib/canonicalize.mjs';
import { observeRuntimeRoleDeploymentAuthority } from '../../governance/check-monolithic-distributed-architecture.mjs';
import { loadExecutionServiceCatalog, verifyLiveServiceEnvelope } from '../../test/execution-envelope-services.mjs';

export const runtimeRoleArtifactId = 'runtime-role-observation';
export const runtimeRoleProject = 'tools/contracts/FsusBlog.RuntimeRoleObservation/FsusBlog.RuntimeRoleObservation.csproj';
export const runtimeRoleObservationRelative = '.tmp/contracts/runtime-role/runtime-role-observation.json';
export const runtimeRoleDeploymentObservationRelative = '.tmp/contracts/runtime-role/deployment-topology-observation.json';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const currentSchemaSideKeys = ['assembly', 'candidateSourceRevision', 'connectionString', 'receiptPath',
    'receiptSha256', 'serviceCatalog', 'serviceEnvelope'];
const currentSchemaDigest = /^[a-f0-9]{64}$/u;
const currentSchemaRevision = /^[a-f0-9]{40}$/u;
const currentSchemaFail = (reason) => { throw new Error(`runtime-role current schema: ${reason}`); };

function exactCurrentKeys(value, expected, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        currentSchemaFail(`${label} key set mismatch`);
}

function validateCurrentSide(side, label)
{
    exactCurrentKeys(side, currentSchemaSideKeys, label);
    for (const key of currentSchemaSideKeys)
    {
        if (typeof side[key] !== 'string' || !side[key].trim() || side[key].length > 65_536)
            currentSchemaFail(`${label} field invalid`);
    }
    if (!currentSchemaDigest.test(side.receiptSha256)
        || !currentSchemaRevision.test(side.candidateSourceRevision) || /^0+$/u.test(side.candidateSourceRevision))
        currentSchemaFail(`${label} artifact or candidate binding invalid`);
    for (const key of ['assembly', 'receiptPath', 'serviceCatalog', 'serviceEnvelope'])
    {
        if (!path.isAbsolute(side[key]) || path.resolve(side[key]) !== side[key]
            || /[\p{Cc}\p{Cs}]/u.test(side[key]) || side[key].split(path.sep).some(value => /^latest$/iu.test(value)))
            currentSchemaFail(`${label} explicit canonical file required`);
    }
}

function fileEpoch(stat)
{
    return ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs']
        .map(key => String(stat[key])).join('/');
}

// Retained file data only: these descriptors do not create a native execution or issuer capability.
function retainCurrentFile(file, maximumBytes)
{
    if (fs.realpathSync(file) !== file) currentSchemaFail('file alias refused');
    const ancestors = [];
    for (let directory = path.dirname(file); ; directory = path.dirname(directory))
    {
        const stat = fs.lstatSync(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) currentSchemaFail('file ancestor refused');
        ancestors.push({ directory, identity: `${stat.dev}/${stat.ino}/${stat.mode}` });
        if (directory === path.dirname(directory)) break;
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try
    {
        const initial = fs.fstatSync(descriptor, { bigint: true });
        if (!initial.isFile() || initial.nlink !== 1n || initial.size <= 0n || initial.size > BigInt(maximumBytes))
            currentSchemaFail('bounded single-link regular file required');
        const record = { file, descriptor, initial: fileEpoch(initial), ancestors, bytes: null };
        const read = () =>
        {
            const bytes = Buffer.alloc(Number(initial.size));
            let offset = 0;
            while (offset < bytes.length)
            {
                const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
                if (!count) currentSchemaFail('retained file truncated');
                offset += count;
            }
            const trailing = Buffer.alloc(1);
            if (fs.readSync(descriptor, trailing, 0, 1, bytes.length)) currentSchemaFail('retained file grew');
            return bytes;
        };
        record.recheck = () =>
        {
            if (fs.realpathSync(file) !== file || fileEpoch(fs.lstatSync(file, { bigint: true })) !== record.initial
                || fileEpoch(fs.fstatSync(descriptor, { bigint: true })) !== record.initial)
                currentSchemaFail('retained file epoch changed');
            for (const ancestor of ancestors)
            {
                const stat = fs.lstatSync(ancestor.directory, { bigint: true });
                if (!stat.isDirectory() || stat.isSymbolicLink()
                    || `${stat.dev}/${stat.ino}/${stat.mode}` !== ancestor.identity)
                    currentSchemaFail('retained file ancestor changed');
            }
            if (record.bytes && !record.bytes.equals(read())) currentSchemaFail('retained file bytes changed');
        };
        record.recheck();
        record.bytes = read();
        record.recheck();
        return record;
    }
    catch (error)
    {
        try { fs.closeSync(descriptor); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'runtime-role current file cleanup failed'); }
        throw error;
    }
}

function bindCurrentObservation(observation, side, backend, envelope)
{
    exactCurrentKeys(observation, ['schema', 'status', 'readOnly', 'qualificationEligible', 'isolation',
        'candidateSourceRevision', 'currentReceipt', 'configuredEndpoint', 'databaseIdentity', 'databaseInstance',
        'canonicalIdentity', 'observedDatabaseDigest', 'tableCount', 'candidateAssemblyDigest'], 'native observation');
    exactCurrentKeys(observation.currentReceipt, ['path', 'sha256', 'contentDigest', 'verifierSourceRevision'], 'current receipt');
    exactCurrentKeys(observation.configuredEndpoint, ['host', 'port', 'database', 'username'], 'configured endpoint');
    exactCurrentKeys(observation.databaseIdentity, ['provider', 'instanceId', 'databaseId'], 'native database');
    exactCurrentKeys(observation.databaseInstance, ['systemIdentifier', 'serverVersion', 'serverVersionNumber',
        'serverAddress', 'serverPort', 'backendPid', 'username', 'readOnly'], 'native session');
    exactCurrentKeys(observation.canonicalIdentity, ['modelVersion', 'extractorVersion', 'generatorVersion',
        'sourceDigest', 'contentDigest'], 'current canonical identity');
    const services = envelope.actual.services.filter(value => value.id === 'postgres');
    if (services.length !== 1 || envelope.requiredServices.filter(value => value === 'postgres').length !== 1)
        currentSchemaFail('live PostgreSQL service must be unique');
    const service = services[0];
    const native = observation.databaseInstance;
    const endpoint = observation.configuredEndpoint;
    const port = service.ports.filter(value => value.containerPort === '5432/tcp');
    if (observation.schema !== 'fsusblog.runtime-role-current-schema-observation.v2'
        || observation.status !== 'verified' || observation.readOnly !== true || observation.qualificationEligible !== false
        || observation.isolation !== 'repeatable read' || native.readOnly !== 'on'
        || observation.candidateSourceRevision !== side.candidateSourceRevision
        || observation.currentReceipt.path !== side.receiptPath || observation.currentReceipt.sha256 !== side.receiptSha256
        || !currentSchemaDigest.test(observation.currentReceipt.contentDigest)
        || !currentSchemaRevision.test(observation.currentReceipt.verifierSourceRevision)
        || observation.candidateAssemblyDigest !== `sha256:${sha256(backend.bytes)}`
        || observation.databaseIdentity.provider !== 'postgresql'
        || observation.databaseIdentity.instanceId !== native.systemIdentifier
        || !/^[1-9][0-9]*\//u.test(observation.databaseIdentity.databaseId)
        || observation.databaseIdentity.databaseId.split('/').slice(1).join('/') !== endpoint.database
        || native.systemIdentifier !== service.databaseIdentity.systemIdentifier
        || native.serverVersion !== service.databaseIdentity.serverVersion
        || native.serverVersionNumber !== service.databaseIdentity.serverVersionNumber
        || endpoint.database !== service.databaseIdentity.database || endpoint.username !== service.databaseIdentity.username
        || native.username !== endpoint.username || port.length !== 1
        || endpoint.host !== port[0].hostIp || endpoint.port !== Number(port[0].hostPort)
        || typeof native.serverAddress !== 'string' || !native.serverAddress || native.serverPort !== 5432
        || !Number.isSafeInteger(native.backendPid) || native.backendPid <= 0
        || !Number.isSafeInteger(observation.tableCount) || observation.tableCount <= 0
        || !currentSchemaDigest.test(observation.observedDatabaseDigest)
        || !currentSchemaDigest.test(observation.canonicalIdentity.sourceDigest)
        || !currentSchemaDigest.test(observation.canonicalIdentity.contentDigest)
        || observation.canonicalIdentity.modelVersion !== 'fsusblog.current-schema.v4'
        || observation.canonicalIdentity.extractorVersion !== 'fsusblog.current-schema-reflection.v2'
        || observation.canonicalIdentity.generatorVersion !== 'fsusblog.current-schema-projection.v4')
        currentSchemaFail('formal native observation binding mismatch');
    return service;
}

function observeCurrentSide(side, runId, held)
{
    const retain = (file, maximum) =>
    {
        const record = retainCurrentFile(file, maximum);
        held.push(record);
        return record;
    };
    const assembly = retain(side.assembly, 64 * 1024 * 1024);
    const backend = retain(path.join(path.dirname(side.assembly), 'FsusBlog.Server.dll'), 64 * 1024 * 1024);
    const receipt = retain(side.receiptPath, 1024 * 1024);
    const catalogFile = retain(side.serviceCatalog, 1024 * 1024);
    const envelopeFile = retain(side.serviceEnvelope, 1024 * 1024);
    if (sha256(receipt.bytes) !== side.receiptSha256) currentSchemaFail('formal receipt artifact mismatch');
    const catalog = loadExecutionServiceCatalog(catalogFile.file);
    const envelope = JSON.parse(envelopeFile.bytes.toString('utf8'));
    if (envelope.runId !== runId) currentSchemaFail('service run identity mismatch');
    verifyLiveServiceEnvelope({ envelope, catalog });
    for (const record of held) record.recheck();
    const run = spawnSync('dotnet', [side.assembly, '--observe-current-schema'], {
        input: JSON.stringify({ connectionString: side.connectionString, receiptPath: side.receiptPath,
            receiptSha256: side.receiptSha256, candidateSourceRevision: side.candidateSourceRevision }),
        encoding: 'utf8', timeout: 150_000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true
    });
    if (run.error || run.status !== 0) currentSchemaFail('candidate native read-only observation failed');
    let observation;
    try { observation = JSON.parse(run.stdout); }
    catch { currentSchemaFail('candidate native observation invalid'); }
    const service = bindCurrentObservation(observation, side, backend, envelope);
    verifyLiveServiceEnvelope({ envelope, catalog });
    for (const record of held) record.recheck();
    // Session PID/address describe one snapshot, not stable equality or cross-run identity.
    return { observation, service, stableIdentity: {
        candidateSourceRevision: side.candidateSourceRevision,
        assemblySha256: sha256(assembly.bytes), backendAssemblySha256: sha256(backend.bytes),
        receiptPath: side.receiptPath, receiptSha256: side.receiptSha256,
        receiptContentDigest: observation.currentReceipt.contentDigest,
        serviceCatalogSha256: sha256(catalogFile.bytes), serviceEnvelopeSha256: sha256(envelopeFile.bytes),
        containerId: service.containerId, postgresInstance: service.databaseIdentity,
        configuredEndpoint: observation.configuredEndpoint, databaseIdentity: observation.databaseIdentity,
        canonicalIdentity: observation.canonicalIdentity, observedDatabaseDigest: observation.observedDatabaseDigest,
        tableCount: observation.tableCount
    }, recheckService: () => verifyLiveServiceEnvelope({ envelope, catalog }) };
}

/** Independently re-observes both explicit formal current-only candidates; grants no readiness or native qualification. */
export function verifyRuntimeRoleCurrentSchemaPair(input)
{
    exactCurrentKeys(input, ['runId', 'sourceCommit', 'source', 'target'], 'pair');
    if (typeof input.runId !== 'string' || !input.runId.trim() || input.runId.length > 4096
        || typeof input.sourceCommit !== 'string'
        || !currentSchemaRevision.test(input.sourceCommit ?? '') || /^0+$/u.test(input.sourceCommit))
        currentSchemaFail('pair run or target candidate invalid');
    validateCurrentSide(input.source, 'source');
    validateCurrentSide(input.target, 'target');
    if (input.target.candidateSourceRevision !== input.sourceCommit) currentSchemaFail('target candidate mismatch');
    const held = [];
    let result;
    let primary;
    const secondary = [];
    try
    {
        const source = observeCurrentSide(input.source, input.runId, held);
        const target = observeCurrentSide(input.target, input.runId, held);
        for (const key of ['databaseIdentity', 'canonicalIdentity', 'observedDatabaseDigest', 'tableCount'])
        {
            if (digestValue(source.observation[key]) !== digestValue(target.observation[key]))
                currentSchemaFail(`independently observed current ${key} mismatch`);
        }
        if (digestValue(source.service.databaseIdentity) !== digestValue(target.service.databaseIdentity)
            || source.service.containerId !== target.service.containerId)
            currentSchemaFail('independently observed service instance mismatch');
        source.recheckService();
        target.recheckService();
        result = { status: 'exact-current-schema-match', readOnly: true, qualificationEligible: false,
            runId: input.runId, sourceCommit: input.sourceCommit,
            sourceVerification: { observation: source.observation, stableIdentity: source.stableIdentity },
            targetVerification: { observation: target.observation, stableIdentity: target.stableIdentity } };
    }
    catch (error) { primary = error; }
    finally
    {
        for (const record of held)
        {
            try { record.recheck(); }
            catch (error) { secondary.push(error); }
        }
        for (const record of held.reverse())
        {
            try { fs.closeSync(record.descriptor); }
            catch (error) { secondary.push(error); }
        }
    }
    if (secondary.length) throw new AggregateError([...(primary ? [primary] : []), ...secondary], 'runtime-role current pair cleanup failed');
    if (primary) throw primary;
    return result;
}

export function produceRuntimeRoleObservation({ repositoryRoot, rebuild = true } = {})
{
    if (!repositoryRoot)
    {
        throw new Error('runtime-role producer requires repositoryRoot');
    }
    const output = path.join(repositoryRoot, runtimeRoleObservationRelative);
    mkdirSync(path.dirname(output), { recursive: true });
    const deploymentObservation = observeRuntimeRoleDeploymentAuthority({ root: repositoryRoot });
    if (!deploymentObservation.ownership?.claimEligible)
    {
        throw new Error(`runtime-role deployment authority is not claim eligible:\n${deploymentObservation.ownership?.failureReasons?.join('\n')}`);
    }
    const deploymentOutput = path.join(repositoryRoot, runtimeRoleDeploymentObservationRelative);
    writeFileSync(deploymentOutput, `${JSON.stringify(deploymentObservation, null, 2)}\n`);
    const project = path.join(repositoryRoot, runtimeRoleProject);
    if (!existsSync(project))
    {
        throw new Error(`runtime-role project missing: ${runtimeRoleProject}`);
    }
    if (rebuild)
    {
        const build = spawnSync('dotnet', [
            'build', project, '-c', 'Release', '-v', 'minimal', '/m:1', '/p:NuGetAudit=false'
        ], {
            cwd: repositoryRoot, encoding: 'utf8'
        });
        if (build.status !== 0)
        {
            throw new Error(`runtime-role build failed:\n${build.stdout}\n${build.stderr}`);
        }
    }
    const run = spawnSync('dotnet', [
        'run', '--project', project, '-c', 'Release', '--no-build', '--',
        '--deployment-observation', deploymentOutput,
        '--output', output
    ], {
        cwd: repositoryRoot, encoding: 'utf8'
    });
    if (run.status !== 0)
    {
        throw new Error(`runtime-role observation failed:\n${run.stdout}\n${run.stderr}`);
    }
    const bytes = readFileSync(output);
    const artifactDigest = sha256(bytes);
    const receiptBody = {
        schema: 'fsusblog.runtime-role-observation-build-receipt.v2',
        artifactId: runtimeRoleArtifactId,
        artifactPath: runtimeRoleObservationRelative,
        artifactDigest,
        configuration: 'Release',
        deploymentAuthoritySchema: deploymentObservation.authoritySchema,
        deploymentAuthorityContentDigest: deploymentObservation.authorityContentDigest,
        deploymentObservationDigest: deploymentObservation.observationDigest
    };
    const buildIdentity = {
        artifactId: runtimeRoleArtifactId,
        artifactDigest,
        receiptDigest: digestValue(receiptBody)
    };
    const receiptPath = path.join(path.dirname(output), 'build-receipt.json');
    writeFileSync(receiptPath, `${JSON.stringify({ ...receiptBody, buildIdentity }, null, 2)}\n`);
    return { observation: JSON.parse(bytes), output, deploymentOutput, receiptPath, buildIdentity };
}
