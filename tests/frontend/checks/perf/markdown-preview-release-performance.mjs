#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Release artifact verification is the repository authority.
import { verifyProductionBuildReceipt } from '../../../../tools/ci/production-build-artifacts.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Side manifests use the canonical repository worktree fingerprint producer.
import { resolveWorktreeFingerprint } from '../../../../tools/fact-extractors/identity.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- Runtime identities must obey the canonical published release contract.
import { parseReleaseId, validateReleaseId } from '../../../../tools/release/release-id.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This is the shared AEDS v2 frame decoder used by runtime tests.
import { decodeAedsFrame } from '../../support/aeds-envelope.mjs';

export const corpusSchema = 'fsusblog.markdown-preview-release-performance-corpus.v1';
export const sideManifestSchema = 'fsusblog.markdown-preview-release-performance-side.v1';
export const measurementSchema = 'fsusblog.markdown-preview-release-performance-measurement.v1';
export const evidenceSchema = 'fsusblog.markdown-preview-release-performance-evidence.v1';
export const liveMachineSchema = 'fsusblog.markdown-preview-release-performance-machine.v1';
export const retainedSampleCount = 5;
export const warmupSampleCount = 1;
export const thresholds = Object.freeze({
    aotRatio: 1.02,
    clientRatio: 1.02,
    previewRatio: 1.03,
    previewResponseBytesGrowth: 0
});

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const frontendRoot = path.join(root, 'src/frontend');
const corpusFile = path.join(here, 'markdown-preview-release-performance-corpus.json');
const outputRoot = path.join(root, '.tmp/perf/markdown-preview-release-performance');
const rawMeasurementFile = path.join(outputRoot, 'raw-measurements.json');
const finalEvidenceFile = path.join(outputRoot, 'summary.json');
const previewEndpointPath = '/api/binary/author/preview';
const articlePreviewFrameType = 94;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const sourceCommitPattern = /^[a-f0-9]{40}$/u;
const gitObjectPattern = /^[a-f0-9]{40}$/u;
const previewIdentityPattern = /^preview:sha256:[a-f0-9]{64}$/u;
const identityHeaderAllowlist = new Set([
    'x-fsus-build-identity',
    'x-fsus-release-id'
]);
const sensitiveEvidenceKeyPattern = /(?:authorization|cookie|password|secret|token|api[-_]?key)/iu;

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function contentDigest(value, omittedField = 'contentDigest')
{
    const copy = structuredClone(value);
    if (copy && typeof copy === 'object' && !Array.isArray(copy))
    {
        delete copy[omittedField];
    }
    return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(copy))).digest('hex')}`;
}

export function fileDigest(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function fail(message)
{
    throw new Error(`markdown-preview-release-performance: ${message}`);
}

function requireCondition(condition, message)
{
    if (!condition)
    {
        fail(message);
    }
}

function requireString(value, label)
{
    const normalized = String(value ?? '').trim();
    requireCondition(normalized.length > 0, `${label} is required`);
    return normalized;
}

function validateReleaseRuntimeIdentity(runtime, sourceCommit, label)
{
    const releaseId = requireString(runtime.releaseId, `${label}.releaseId`);
    const errors = validateReleaseId(releaseId, { forPublication: true });
    requireCondition(errors.length === 0, `${label}.releaseId violates the canonical contract: ${errors.join(', ')}`);
    const parsed = parseReleaseId(releaseId);
    requireCondition(
        Boolean(parsed) && sourceCommit.startsWith(parsed.commitShaPrefix),
        `${label}.releaseId commit prefix does not match the side source commit`
    );
    requireCondition(
        requireString(runtime.buildIdentity, `${label}.buildIdentity`) === releaseId,
        `${label}.buildIdentity must equal releaseId`
    );
    return releaseId;
}

function requireDigest(value, label)
{
    const normalized = requireString(value, label);
    requireCondition(sha256Pattern.test(normalized), `${label} must be a sha256 digest`);
    return normalized;
}

function requireWorktreeFingerprint(value, label)
{
    const normalized = requireString(value, label);
    requireCondition(
        /^(?:sha256:)?[a-f0-9]{64}$/u.test(normalized),
        `${label} must be a SHA-256 worktree fingerprint`
    );
    return normalized;
}

function normalizedFingerprint(value)
{
    return String(value).replace(/^sha256:/u, '');
}

function requireExactObject(value, keys, label)
{
    requireCondition(
        value && typeof value === 'object' && !Array.isArray(value),
        `${label} must be an object`
    );
    const expected = [...keys].sort();
    const actual = Object.keys(value).sort();
    requireCondition(
        JSON.stringify(actual) === JSON.stringify(expected),
        `${label} exact schema mismatch; expected ${expected.join(', ')}, received ${actual.join(', ')}`
    );
    return value;
}

function validateSideManifestShape(manifest, label)
{
    requireExactObject(manifest, [
        'artifacts',
        'contentDigest',
        'fixture',
        'machine',
        'productionBuild',
        'runtime',
        'schema',
        'side',
        'source',
        'toolchain'
    ], label);
    requireExactObject(manifest.source, [
        'clean',
        'commit',
        'repositoryRoot',
        'tree',
        'worktreeFingerprint'
    ], `${label}.source`);
    requireExactObject(
        manifest.productionBuild,
        ['artifactRoot', 'receiptContentDigest', 'receiptPath'],
        `${label}.productionBuild`
    );
    requireExactObject(
        manifest.artifacts,
        ['clientEntry', 'frontendDist', 'ssrEntry'],
        `${label}.artifacts`
    );
    for (const field of ['clientEntry', 'frontendDist', 'ssrEntry'])
    {
        requireExactObject(manifest.artifacts[field], ['digest', 'path'], `${label}.artifacts.${field}`);
    }
    requireExactObject(manifest.runtime, [
        'backendBaseUrl',
        'backendKind',
        'buildIdentity',
        'identityProbe',
        'mode',
        'releaseId',
        'routes',
        'staticBaseUrl',
        'staticServerKind'
    ], `${label}.runtime`);
    requireExactObject(
        manifest.runtime.routes,
        ['about', 'adminWrite', 'article'],
        `${label}.runtime.routes`
    );
    requireExactObject(manifest.runtime.identityProbe, [
        'headers',
        'method',
        'responseDigest',
        'status',
        'url'
    ], `${label}.runtime.identityProbe`);
    requireExactObject(manifest.fixture, [
        'adminStorageState',
        'contentDigest',
        'identity',
        'namespace',
        'profile',
        'root',
        'topology'
    ], `${label}.fixture`);
    requireExactObject(
        manifest.fixture.adminStorageState,
        ['digest', 'path'],
        `${label}.fixture.adminStorageState`
    );
    requireExactObject(manifest.machine, [
        'cgroup',
        'cpuCount',
        'cpuset',
        'hostname',
        'identityDigest',
        'platform',
        'schema',
        'topology',
        'totalMemoryBytes'
    ], `${label}.machine`);
    requireExactObject(
        manifest.toolchain,
        ['browser', 'dotnet', 'node', 'playwright'],
        `${label}.toolchain`
    );
}

function assertNoSymlinkPath(absolute, label)
{
    const resolved = path.resolve(absolute);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean))
    {
        current = path.join(current, segment);
        if (!fs.existsSync(current))
        {
            fail(`${label} is missing: ${resolved}`);
        }
        if (fs.lstatSync(current).isSymbolicLink())
        {
            fail(`${label} contains a symlink: ${resolved}`);
        }
    }
    return resolved;
}

function requireAbsoluteRegularFile(file, label)
{
    requireCondition(path.isAbsolute(String(file ?? '')), `${label} must be an explicit absolute path`);
    const absolute = assertNoSymlinkPath(file, label);
    const stat = fs.lstatSync(absolute);
    requireCondition(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file`);
    requireCondition(fs.realpathSync(absolute) === absolute, `${label} realpath changed`);
    return absolute;
}

function requireAbsoluteDirectory(directory, label)
{
    requireCondition(path.isAbsolute(String(directory ?? '')), `${label} must be an explicit absolute path`);
    const absolute = assertNoSymlinkPath(directory, label);
    const stat = fs.lstatSync(absolute);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be a directory`);
    requireCondition(fs.realpathSync(absolute) === absolute, `${label} realpath changed`);
    return absolute;
}

function resolveContainedRegularFile(container, relative, label)
{
    const normalized = requireString(relative, label).replaceAll('\\', '/');
    requireCondition(
        !path.posix.isAbsolute(normalized)
        && normalized !== '..'
        && !normalized.startsWith('../'),
        `${label} must be relative and contained`
    );
    const absolute = path.resolve(container, normalized);
    requireCondition(
        absolute !== container && absolute.startsWith(`${container}${path.sep}`),
        `${label} escapes its container`
    );
    const regular = assertNoSymlinkPath(absolute, label);
    requireCondition(fs.lstatSync(regular).isFile(), `${label} must be a regular file`);
    requireCondition(
        fs.realpathSync(regular).startsWith(`${fs.realpathSync(container)}${path.sep}`),
        `${label} realpath escapes its container`
    );
    return regular;
}

function readJsonRegular(file, label)
{
    const absolute = requireAbsoluteRegularFile(file, label);
    let value;
    try
    {
        value = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    }
    catch (error)
    {
        fail(`${label} is not valid JSON: ${error.message}`);
    }
    return { absolute, value };
}

function gitOutput(repositoryRoot, args, label)
{
    const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    });
    requireCondition(result.status === 0, `${label} failed: ${String(result.stderr ?? '').trim()}`);
    return String(result.stdout ?? '').trim();
}

function verifySourceAuthority(source, label)
{
    const repositoryRoot = requireAbsoluteDirectory(source.repositoryRoot, `${label}.repositoryRoot`);
    const commit = requireString(source.commit, `${label}.commit`);
    const tree = requireString(source.tree, `${label}.tree`);
    const worktreeFingerprint = requireWorktreeFingerprint(
        source.worktreeFingerprint,
        `${label}.worktreeFingerprint`
    );
    requireCondition(sourceCommitPattern.test(commit), `${label}.commit must be a full Git commit`);
    requireCondition(gitObjectPattern.test(tree), `${label}.tree must be a full Git tree`);
    requireCondition(source.clean === true, `${label}.clean must be true`);
    requireCondition(
        gitOutput(repositoryRoot, ['rev-parse', 'HEAD'], `${label} HEAD resolution`) === commit,
        `${label}.commit does not match the immutable checkout HEAD`
    );
    requireCondition(
        gitOutput(repositoryRoot, ['rev-parse', `${commit}^{tree}`], `${label} tree resolution`) === tree,
        `${label}.tree does not match the commit tree authority`
    );
    requireCondition(
        gitOutput(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'], `${label} clean check`) === '',
        `${label} checkout is not clean`
    );
    const liveFingerprint = resolveWorktreeFingerprint(repositoryRoot);
    requireCondition(
        normalizedFingerprint(liveFingerprint) === normalizedFingerprint(worktreeFingerprint),
        `${label}.worktreeFingerprint does not match the canonical checkout fingerprint`
    );
    return { repositoryRoot, commit, tree, worktreeFingerprint };
}

export function loadCorpus(file = corpusFile)
{
    const { absolute, value } = readJsonRegular(path.resolve(file), 'performance corpus');
    requireCondition(value.schema === corpusSchema, 'performance corpus schema mismatch');
    requireCondition(value.contentDigest === contentDigest(value), 'performance corpus content digest mismatch');
    requireString(value.fixtureIdentity, 'performance corpus fixtureIdentity');
    for (const field of ['title', 'summary', 'content'])
    {
        requireString(value.preview?.[field], `performance corpus preview.${field}`);
    }
    requireCondition(
        value.preview.coverImageUrl === null || typeof value.preview.coverImageUrl === 'string',
        'performance corpus preview.coverImageUrl must be a string or null'
    );
    for (const token of [
        '| surface | expectation |',
        '```ts',
        '$$E = mc^2$$',
        '```mermaid',
        '<script>',
        '<img ',
        '<iframe '
    ])
    {
        requireCondition(value.preview.content.includes(token), `performance corpus is missing ${token}`);
    }
    return Object.freeze({
        ...value,
        file: absolute,
        fileDigest: fileDigest(absolute)
    });
}

function domainDigest(receipt, name)
{
    const domain = receipt.domains.find(item => item.name === name);
    requireCondition(Boolean(domain), `production receipt is missing ${name} domain`);
    const records = receipt.artifacts
        .filter(item => item.path === domain.path || item.path.startsWith(`${domain.path}/`))
        .map(item => ({ path: item.path, size: item.size, sha256: item.sha256 }))
        .sort((left, right) => left.path.localeCompare(right.path));
    requireCondition(records.length === domain.fileCount, `${name} domain artifact count mismatch`);
    return {
        path: domain.path,
        digest: `sha256:${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`
    };
}

function artifactRecord(receipt, relative, label)
{
    const record = receipt.artifacts.find(item => item.path === relative);
    requireCondition(Boolean(record), `${label} is not owned by the production receipt`);
    return record;
}

function parseHttpUrl(value, label)
{
    let url;
    const raw = requireString(value, label);
    try
    {
        url = new URL(raw);
    }
    catch
    {
        fail(`${label} must be an absolute URL`);
    }
    requireCondition(['http:', 'https:'].includes(url.protocol), `${label} must use HTTP(S)`);
    requireCondition(!url.username && !url.password, `${label} must not contain userinfo`);
    requireCondition(!url.search && !url.hash, `${label} must not contain query or fragment`);
    return { raw, url };
}

function validateBaseUrl(value, label)
{
    const { raw, url } = parseHttpUrl(value, label);
    requireCondition(url.pathname === '/', `${label} must be an origin without a path`);
    requireCondition(raw === url.origin, `${label} must use its canonical origin form`);
    return url.origin;
}

function validateSameOriginRoute(value, baseUrl, label)
{
    const route = requireString(value, label);
    requireCondition(route.startsWith('/') && !route.startsWith('//'), `${label} must be a root-relative route`);
    requireCondition(!route.includes('?') && !route.includes('#'), `${label} must not contain query or fragment`);
    const resolved = new URL(route, `${baseUrl}/`);
    requireCondition(resolved.origin === baseUrl, `${label} must remain on the declared static origin`);
    requireCondition(route === resolved.pathname, `${label} must use a canonical path`);
    return route;
}

function validateIdentityProbeUrl(value, backendBaseUrl, label)
{
    const { raw, url } = parseHttpUrl(value, label);
    requireCondition(url.origin === backendBaseUrl, `${label} must remain on the declared backend origin`);
    requireCondition(url.pathname !== '/', `${label} must bind an explicit probe path`);
    requireCondition(raw === `${url.origin}${url.pathname}`, `${label} must use a canonical URL`);
    return raw;
}

function validateIdentityHeaders(headers, label, expectedReleaseId = null)
{
    requireCondition(
        headers && typeof headers === 'object' && !Array.isArray(headers),
        `${label} must be an object`
    );
    const entries = Object.entries(headers);
    requireCondition(entries.length > 0, `${label} must bind at least one identity header`);
    for (const [name, value] of entries)
    {
        requireCondition(name === name.toLowerCase(), `${label}.${name} must use a lowercase name`);
        requireCondition(identityHeaderAllowlist.has(name), `${label}.${name} is not an allowed identity header`);
        const normalized = requireString(value, `${label}.${name}`);
        requireCondition(!/[\r\n]/u.test(normalized), `${label}.${name} contains a line break`);
    }
    const normalized = Object.fromEntries(entries);
    requireCondition(
        Object.hasOwn(normalized, 'x-fsus-release-id'),
        `${label} must include x-fsus-release-id`
    );
    if (expectedReleaseId !== null)
    {
        requireCondition(
            normalized['x-fsus-release-id'] === expectedReleaseId,
            `${label}.x-fsus-release-id does not match runtime.releaseId`
        );
    }
    return normalized;
}

function validateSideToolchain(toolchain, receiptToolchain, label)
{
    requireCondition(toolchain && typeof toolchain === 'object', `${label}.toolchain is required`);
    for (const key of ['node', 'playwright', 'dotnet', 'browser'])
    {
        requireString(toolchain[key], `${label}.toolchain.${key}`);
    }
    for (const key of ['node', 'playwright', 'dotnet'])
    {
        requireCondition(
            String(toolchain[key]) === String(receiptToolchain[key]),
            `${label}.toolchain.${key} does not match the production receipt`
        );
    }
}

function validateMachineAuthority(machine, liveMachine, label)
{
    requireExactObject(machine, [
        'cgroup',
        'cpuCount',
        'cpuset',
        'hostname',
        'identityDigest',
        'platform',
        'schema',
        'topology',
        'totalMemoryBytes'
    ], label);
    requireCondition(machine.schema === liveMachineSchema, `${label} schema mismatch`);
    requireCondition(machine.topology === 'single-host', `${label} topology is not single-host`);
    for (const field of ['hostname', 'platform', 'cgroup', 'cpuset'])
    {
        requireString(machine[field], `${label}.${field}`);
    }
    for (const field of ['cpuCount', 'totalMemoryBytes'])
    {
        requireCondition(
            Number.isSafeInteger(machine[field]) && machine[field] > 0,
            `${label}.${field} must be a positive safe integer`
        );
    }
    requireCondition(
        machine.identityDigest === contentDigest(machine, 'identityDigest'),
        `${label} identity digest mismatch`
    );
    requireCondition(
        liveMachine.identityDigest === contentDigest(liveMachine, 'identityDigest'),
        'live machine identity digest mismatch'
    );
    for (const field of [
        'schema',
        'topology',
        'hostname',
        'platform',
        'cgroup',
        'cpuset',
        'cpuCount',
        'totalMemoryBytes',
        'identityDigest'
    ])
    {
        requireCondition(machine[field] === liveMachine[field], `${label} live ${field} drift`);
    }
}

export function loadSideManifest(file, expectedSide, {
    verifyReceipt = verifyProductionBuildReceipt,
    liveMachine = currentMachineIdentity()
} = {})
{
    requireCondition(['base', 'candidate'].includes(expectedSide), 'expected side must be base or candidate');
    const { absolute: manifestFile, value: manifest } = readJsonRegular(file, `${expectedSide} side manifest`);
    requireCondition(
        (fs.lstatSync(manifestFile).mode & 0o222) === 0,
        `${expectedSide} side manifest must be sealed read-only`
    );
    validateSideManifestShape(manifest, `${expectedSide} side manifest`);
    requireCondition(manifest.schema === sideManifestSchema, `${expectedSide} side manifest schema mismatch`);
    requireCondition(manifest.side === expectedSide, `${expectedSide} side manifest side-swap detected`);
    requireCondition(
        manifest.contentDigest === contentDigest(manifest),
        `${expectedSide} side manifest content digest mismatch`
    );

    const source = manifest.source;
    const sourceAuthority = verifySourceAuthority(source, `${expectedSide} source`);

    const artifactRoot = requireAbsoluteDirectory(
        manifest.productionBuild?.artifactRoot,
        `${expectedSide} production artifact root`
    );
    const receiptPath = requireString(
        manifest.productionBuild?.receiptPath,
        `${expectedSide} production receipt path`
    );
    const receiptFile = resolveContainedRegularFile(
        artifactRoot,
        receiptPath,
        `${expectedSide} production receipt`
    );
    const expectedReceiptDigest = requireDigest(
        manifest.productionBuild?.receiptContentDigest,
        `${expectedSide} production receipt digest`
    );
    const verified = verifyReceipt({
        artifactRoot,
        receiptFile: path.relative(artifactRoot, receiptFile).replaceAll(path.sep, '/'),
        expectedSourceState: {
            commit: sourceAuthority.commit,
            worktreeFingerprint: sourceAuthority.worktreeFingerprint
        },
        expectedReceiptDigest,
        repairReadOnlySeal: false
    });
    requireCondition(
        verified.receipt.sourceState?.commit === source.commit
        && verified.receipt.sourceState?.worktreeFingerprint === source.worktreeFingerprint,
        `${expectedSide} source authority does not match the production receipt`
    );
    requireCondition(
        verified.receipt.build?.profile === 'production-release-fresh',
        `${expectedSide} production receipt is not Release mode`
    );

    const frontendDist = domainDigest(verified.receipt, 'frontend-dist');
    requireCondition(
        manifest.artifacts?.frontendDist?.path === frontendDist.path
        && manifest.artifacts.frontendDist.digest === frontendDist.digest,
        `${expectedSide} frontend dist digest mismatch`
    );

    const ssrRelative = requireString(
        manifest.artifacts?.ssrEntry?.path,
        `${expectedSide} SSR entry path`
    );
    const ssrRecord = artifactRecord(verified.receipt, ssrRelative, `${expectedSide} SSR entry`);
    requireCondition(
        manifest.artifacts.ssrEntry.digest === ssrRecord.sha256,
        `${expectedSide} SSR entry digest mismatch`
    );
    const ssrEntry = resolveContainedRegularFile(artifactRoot, ssrRelative, `${expectedSide} SSR entry`);

    const clientRelative = requireString(
        manifest.artifacts?.clientEntry?.path,
        `${expectedSide} client entry path`
    );
    const clientRecord = artifactRecord(verified.receipt, clientRelative, `${expectedSide} client entry`);
    requireCondition(
        manifest.artifacts.clientEntry.digest === clientRecord.sha256,
        `${expectedSide} client entry digest mismatch`
    );
    const clientEntry = resolveContainedRegularFile(
        artifactRoot,
        clientRelative,
        `${expectedSide} client entry`
    );

    const runtime = manifest.runtime ?? {};
    requireCondition(runtime.mode === 'Release', `${expectedSide} runtime must be Release mode`);
    requireCondition(
        runtime.staticServerKind === 'immutable-release-static',
        `${expectedSide} runtime must reject dev/Vite servers`
    );
    requireCondition(
        runtime.backendKind === 'immutable-release-runtime',
        `${expectedSide} backend must be an immutable Release runtime`
    );
    const staticBaseUrl = validateBaseUrl(runtime.staticBaseUrl, `${expectedSide} staticBaseUrl`);
    const backendBaseUrl = validateBaseUrl(runtime.backendBaseUrl, `${expectedSide} backendBaseUrl`);
    const releaseId = validateReleaseRuntimeIdentity(
        runtime,
        sourceAuthority.commit,
        `${expectedSide} runtime`
    );
    for (const route of ['article', 'about', 'adminWrite'])
    {
        validateSameOriginRoute(
            runtime.routes[route],
            staticBaseUrl,
            `${expectedSide} runtime.routes.${route}`
        );
    }
    const identityProbeUrl = validateIdentityProbeUrl(
        runtime.identityProbe?.url,
        backendBaseUrl,
        `${expectedSide} runtime.identityProbe.url`
    );
    requireCondition(runtime.identityProbe.method === 'GET', `${expectedSide} identity probe must use GET`);
    requireCondition(
        Number.isInteger(runtime.identityProbe.status)
        && runtime.identityProbe.status >= 100
        && runtime.identityProbe.status <= 599,
        `${expectedSide} identity probe status is invalid`
    );
    requireDigest(
        runtime.identityProbe?.responseDigest,
        `${expectedSide} runtime.identityProbe.responseDigest`
    );
    validateIdentityHeaders(
        runtime.identityProbe.headers,
        `${expectedSide} runtime.identityProbe.headers`,
        releaseId
    );

    const fixture = manifest.fixture ?? {};
    requireCondition(
        fixture.profile === 'acceptance-representative',
        `${expectedSide} fixture profile must be acceptance-representative`
    );
    for (const field of ['identity', 'namespace', 'topology'])
    {
        requireString(fixture[field], `${expectedSide} fixture.${field}`);
    }
    requireDigest(fixture.contentDigest, `${expectedSide} fixture.contentDigest`);
    const fixtureRoot = requireAbsoluteDirectory(fixture.root, `${expectedSide} fixture root`);
    const storageState = resolveContainedRegularFile(
        fixtureRoot,
        fixture.adminStorageState?.path,
        `${expectedSide} admin storage state`
    );
    requireCondition(
        fileDigest(storageState) === fixture.adminStorageState?.digest,
        `${expectedSide} admin storage state digest mismatch`
    );

    const machine = manifest.machine;
    validateMachineAuthority(machine, liveMachine, `${expectedSide} machine`);
    validateSideToolchain(manifest.toolchain, verified.receipt.toolchain, expectedSide);

    return Object.freeze({
        side: expectedSide,
        manifest,
        manifestFile,
        manifestFileDigest: fileDigest(manifestFile),
        artifactRoot,
        receiptFile,
        receipt: verified.receipt,
        receiptVerification: verified.evidence,
        sourceRoot: sourceAuthority.repositoryRoot,
        ssrEntry,
        clientEntry,
        staticBaseUrl,
        backendBaseUrl,
        identityProbeUrl,
        storageState
    });
}

export function validatePairedSides(base, candidate, corpus)
{
    requireCondition(base.side === 'base' && candidate.side === 'candidate', 'paired side identity mismatch');
    requireCondition(base.manifestFile !== candidate.manifestFile, 'base and candidate reuse one side manifest');
    requireCondition(base.artifactRoot !== candidate.artifactRoot, 'base and candidate reuse one artifact root');
    requireCondition(base.receiptFile !== candidate.receiptFile, 'base and candidate reuse one production receipt');
    requireCondition(base.sourceRoot !== candidate.sourceRoot, 'base and candidate reuse one source checkout');
    requireCondition(
        base.manifest.source.commit !== candidate.manifest.source.commit,
        'base and candidate must bind different full commits'
    );
    requireCondition(base.staticBaseUrl !== candidate.staticBaseUrl, 'base and candidate reuse one static runtime');
    requireCondition(base.backendBaseUrl !== candidate.backendBaseUrl, 'base and candidate reuse one backend runtime');
    for (const field of [
        'schema',
        'topology',
        'hostname',
        'platform',
        'cgroup',
        'cpuset',
        'cpuCount',
        'totalMemoryBytes',
        'identityDigest'
    ])
    {
        requireCondition(
            base.manifest.machine[field] === candidate.manifest.machine[field],
            `paired machine ${field} drift`
        );
    }
    for (const field of ['identity', 'namespace', 'topology', 'contentDigest', 'profile'])
    {
        requireCondition(
            base.manifest.fixture[field] === candidate.manifest.fixture[field],
            `paired fixture ${field} drift`
        );
    }
    requireCondition(
        base.manifest.fixture.contentDigest === corpus.contentDigest,
        'base fixture does not bind the canonical corpus'
    );
    requireCondition(
        candidate.manifest.fixture.contentDigest === corpus.contentDigest,
        'candidate fixture does not bind the canonical corpus'
    );
    for (const key of ['node', 'playwright', 'dotnet', 'browser'])
    {
        requireCondition(
            base.manifest.toolchain[key] === candidate.manifest.toolchain[key],
            `paired toolchain ${key} drift`
        );
    }
    return { base, candidate };
}

export function pairedSchedule()
{
    const schedule = [
        { side: 'base', phase: 'warmup', sampleIndex: 0 },
        { side: 'candidate', phase: 'warmup', sampleIndex: 0 }
    ];
    for (let sampleIndex = 1; sampleIndex <= retainedSampleCount; sampleIndex += 1)
    {
        const order = sampleIndex % 2 === 1
            ? ['candidate', 'base']
            : ['base', 'candidate'];
        for (const side of order)
        {
            schedule.push({ side, phase: 'retained', sampleIndex });
        }
    }
    return schedule.map((entry, sequence) => Object.freeze({ sequence, ...entry }));
}

function median(values, label)
{
    requireCondition(values.length === retainedSampleCount, `${label} requires exactly five samples`);
    requireCondition(values.every(value => Number.isFinite(value) && value > 0), `${label} contains zero/NaN`);
    return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function validateMeasuredSampleShape(sample, label)
{
    requireExactObject(sample, [
        'activationMarkdownIdentity',
        'aotMs',
        'browserErrors',
        'clientMs',
        'domPreviewCompleteIdentity',
        'domPreviewSourceIdentity',
        'features',
        'finishedAt',
        'navigationIdentities',
        'phase',
        'placeholderCount',
        'previewMs',
        'previewResponseBytes',
        'previewResponseIdentity',
        'renderMarkdownIdentity',
        'sampleIndex',
        'side',
        'startedAt'
    ], label);
    requireExactObject(sample.features, ['code', 'latex', 'mermaid', 'table'], `${label}.features`);
    requireCondition(Array.isArray(sample.browserErrors), `${label}.browserErrors must be an array`);
    requireString(sample.startedAt, `${label}.startedAt`);
    requireString(sample.finishedAt, `${label}.finishedAt`);
}

function validateNavigationIdentities(value, runtime, label)
{
    requireExactObject(value, ['about', 'adminWrite', 'article'], label);
    for (const [routeName, requiresPublicBootIdentity] of [
        ['article', true],
        ['about', true],
        ['adminWrite', false]
    ])
    {
        const navigation = value[routeName];
        requireExactObject(
            navigation,
            requiresPublicBootIdentity
                ? ['frontendBuildIdentity', 'releaseId', 'status', 'url']
                : ['releaseId', 'status', 'url'],
            `${label}.${routeName}`
        );
        const releaseId = requireString(navigation.releaseId, `${label}.${routeName}.releaseId`);
        requireCondition(
            validateReleaseId(releaseId, { forPublication: true }).length === 0,
            `${label}.${routeName}.releaseId violates the canonical contract`
        );
        requireCondition(
            Number.isInteger(navigation.status)
            && navigation.status >= 200
            && navigation.status < 300,
            `${label}.${routeName}.status is not successful`
        );
        if (requiresPublicBootIdentity)
        {
            requireCondition(
                navigation.frontendBuildIdentity === releaseId,
                `${label}.${routeName}.frontendBuildIdentity does not match the response release`
            );
        }
        if (runtime)
        {
            const expectedUrl = new URL(runtime.routes[routeName], runtime.staticBaseUrl).href;
            requireCondition(
                navigation.url === expectedUrl,
                `${label}.${routeName}.url does not match the side route`
            );
            requireCondition(
                releaseId === runtime.releaseId,
                `${label}.${routeName}.releaseId does not match the side release`
            );
        }
        else
        {
            parseHttpUrl(navigation.url, `${label}.${routeName}.url`);
        }
    }
}

function validateMeasuredSample(sample, expected, runtime = null)
{
    requireCondition(sample && typeof sample === 'object', 'side adapter returned no sample');
    validateMeasuredSampleShape(sample, `${expected.side} ${expected.phase} ${expected.sampleIndex}`);
    requireCondition(sample.side === expected.side, 'side adapter side-swap detected');
    requireCondition(sample.phase === expected.phase, 'side adapter phase mismatch');
    requireCondition(sample.sampleIndex === expected.sampleIndex, 'side adapter sample index mismatch');
    for (const field of ['aotMs', 'clientMs', 'previewMs'])
    {
        requireCondition(
            Number.isFinite(sample[field]) && sample[field] > 0,
            `${expected.side} ${field} is zero/NaN`
        );
    }
    requireCondition(
        Number.isInteger(sample.previewResponseBytes) && sample.previewResponseBytes > 0,
        `${expected.side} preview response bytes are missing`
    );
    requireCondition(
        previewIdentityPattern.test(sample.previewResponseIdentity),
        `${expected.side} preview response identity is invalid`
    );
    requireCondition(
        sample.previewResponseIdentity === sample.domPreviewSourceIdentity
        && sample.previewResponseIdentity === sample.domPreviewCompleteIdentity,
        `${expected.side} preview response/DOM identity mismatch`
    );
    requireCondition(
        /^markdown:/u.test(sample.renderMarkdownIdentity)
        && sample.renderMarkdownIdentity === sample.activationMarkdownIdentity,
        `${expected.side} render/activation Markdown identity mismatch`
    );
    for (const feature of ['table', 'code', 'latex', 'mermaid'])
    {
        requireCondition(sample.features?.[feature] === true, `${expected.side} ${feature} was not activated`);
    }
    requireCondition(sample.placeholderCount === 0, `${expected.side} retained placeholder detected`);
    requireCondition(sample.browserErrors?.length === 0, `${expected.side} browser error detected`);
    validateNavigationIdentities(
        sample.navigationIdentities,
        runtime,
        `${expected.side} navigation identities`
    );
    return Object.freeze({ ...sample, sequence: expected.sequence });
}

function sideSummary(samples, side)
{
    const retained = samples.filter(sample => sample.side === side && sample.phase === 'retained');
    const warmups = samples.filter(sample => sample.side === side && sample.phase === 'warmup');
    requireCondition(warmups.length === warmupSampleCount, `${side} requires exactly one warmup`);
    requireCondition(retained.length === retainedSampleCount, `${side} retained sample count mismatch`);
    requireCondition(
        new Set(retained.map(sample => sample.sampleIndex)).size === retainedSampleCount,
        `${side} retained samples contain duplicate/drop`
    );
    return {
        warmups,
        retained,
        medians: {
            aotMs: median(retained.map(sample => sample.aotMs), `${side} AOT`),
            clientMs: median(retained.map(sample => sample.clientMs), `${side} client`),
            previewMs: median(retained.map(sample => sample.previewMs), `${side} preview`)
        },
        previewResponseBytes: {
            samples: retained.map(sample => sample.previewResponseBytes),
            max: Math.max(...retained.map(sample => sample.previewResponseBytes))
        }
    };
}

export function comparePairedSamples(samples)
{
    requireCondition(
        samples.length === (warmupSampleCount + retainedSampleCount) * 2,
        'paired runner sample count mismatch'
    );
    const expected = pairedSchedule();
    for (const [index, schedule] of expected.entries())
    {
        requireCondition(
            samples[index]?.side === schedule.side
            && samples[index]?.phase === schedule.phase
            && samples[index]?.sampleIndex === schedule.sampleIndex
            && samples[index]?.sequence === schedule.sequence,
            `paired runner order drift at sequence ${schedule.sequence}`
        );
    }
    const base = sideSummary(samples, 'base');
    const candidate = sideSummary(samples, 'candidate');
    const ratios = {
        aot: candidate.medians.aotMs / base.medians.aotMs,
        client: candidate.medians.clientMs / base.medians.clientMs,
        preview: candidate.medians.previewMs / base.medians.previewMs
    };
    const bytePairs = candidate.previewResponseBytes.samples.map((bytes, index) => ({
        sampleIndex: index + 1,
        base: base.previewResponseBytes.samples[index],
        candidate: bytes,
        passed: bytes <= base.previewResponseBytes.samples[index]
    }));
    const gates = {
        aot: { passed: ratios.aot <= thresholds.aotRatio, ratio: ratios.aot, threshold: thresholds.aotRatio },
        client: { passed: ratios.client <= thresholds.clientRatio, ratio: ratios.client, threshold: thresholds.clientRatio },
        preview: { passed: ratios.preview <= thresholds.previewRatio, ratio: ratios.preview, threshold: thresholds.previewRatio },
        previewResponseBytes: {
            passed: bytePairs.every(pair => pair.passed)
                && candidate.previewResponseBytes.max <= base.previewResponseBytes.max,
            maxGrowthBytes: candidate.previewResponseBytes.max - base.previewResponseBytes.max,
            thresholdGrowthBytes: thresholds.previewResponseBytesGrowth,
            pairs: bytePairs
        }
    };
    return {
        status: Object.values(gates).every(gate => gate.passed) ? 'passed' : 'failed',
        base,
        candidate,
        ratios,
        gates
    };
}

export function currentMachineIdentity()
{
    const cgroup = fs.existsSync('/proc/self/cgroup')
        ? fs.readFileSync('/proc/self/cgroup', 'utf8').trim()
        : 'unavailable';
    const status = fs.existsSync('/proc/self/status')
        ? fs.readFileSync('/proc/self/status', 'utf8')
        : '';
    const cpuset = /^Cpus_allowed_list:\s*(.+)$/mu.exec(status)?.[1]?.trim() ?? 'unavailable';
    const identity = {
        schema: liveMachineSchema,
        topology: 'single-host',
        hostname: os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        cgroup,
        cpuset,
        cpuCount: os.availableParallelism?.() ?? os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        identityDigest: null
    };
    identity.identityDigest = contentDigest(identity, 'identityDigest');
    return Object.freeze(identity);
}

function commandVersion(command, args = ['--version'])
{
    const result = spawnSync(command, args, { encoding: 'utf8' });
    requireCondition(result.status === 0, `${command} version is unavailable`);
    return String(result.stdout || result.stderr).trim().split(/\r?\n/u)[0];
}

async function verifyRuntimeIdentityProbe(side)
{
    const probe = side.manifest.runtime.identityProbe;
    const response = await fetch(side.identityProbeUrl, {
        method: probe.method ?? 'GET',
        cache: 'no-store',
        redirect: 'error'
    });
    requireCondition(response.status === Number(probe.status), `${side.side} runtime identity status mismatch`);
    const body = Buffer.from(await response.arrayBuffer());
    requireCondition(
        `sha256:${createHash('sha256').update(body).digest('hex')}` === probe.responseDigest,
        `${side.side} runtime identity response digest mismatch`
    );
    for (const [name, expected] of Object.entries(probe.headers))
    {
        requireCondition(
            response.headers.get(name) === String(expected),
            `${side.side} runtime identity header mismatch: ${name}`
        );
    }
    return {
        url: side.identityProbeUrl,
        status: response.status,
        responseBytes: body.byteLength,
        responseDigest: probe.responseDigest,
        headers: probe.headers
    };
}

function createAotOptions(module, corpus)
{
    const common = {
        siteTitle: 'FsusBlog Release Performance',
        siteDescription: 'Release performance fixture',
        baseUrl: 'https://release-performance.example.invalid',
        renderTimestamp: corpus.aot.renderTimestamp,
        renderLocale: corpus.aot.renderLocale,
        renderDisplayTimeZone: corpus.aot.renderDisplayTimeZone,
        localeCatalogDigest: module.LOCALE_CATALOG_DIGEST
    };
    return {
        article: {
            ...common,
            articleId: corpus.aot.articleId,
            id: corpus.aot.articleId,
            title: corpus.preview.title,
            summary: corpus.preview.summary,
            bodyContent: corpus.preview.content,
            content: corpus.preview.content,
            coverImageUrl: corpus.preview.coverImageUrl ?? '',
            views: 0,
            createTime: corpus.aot.renderTimestamp,
            category: { id: 1, name: 'Performance' },
            tags: ['release-performance'],
            authorName: 'Release Performance',
            rights: {
                snapshotId: '1',
                articleRevisionId: '1',
                revisionNo: 1,
                enabled: true,
                licenseType: 'all-rights-reserved',
                copyrightHolder: null,
                copyrightYear: 2026,
                rightsStatement: null,
                attributionTemplate: null,
                copyPolicy: 'deny',
                maxExcerptChars: 0,
                allowCodeCopy: false,
                showPublicBadge: false,
                proofBindingEnabled: false,
                canonicalUrl: null,
                policyHash: 'release-performance-policy',
                contentCanonicalHash: corpus.contentDigest,
                proofUrl: null,
                proofStatus: null
            },
            relatedReading: { related: [], previous: null, next: null }
        },
        about: {
            ...common,
            title: corpus.preview.title,
            slug: corpus.aot.aboutSlug,
            content: corpus.preview.content
        }
    };
}

function installPreviewInstrumentation()
{
    const endpointPath = '/api/binary/author/preview';
    const state = {
        requests: [],
        completions: []
    };
    Object.defineProperty(globalThis, '__fsusMarkdownPreviewPerformance', {
        configurable: false,
        enumerable: false,
        value: state,
        writable: false
    });
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) =>
    {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url, globalThis.location.href);
        if (request.method === 'POST' && url.pathname === endpointPath)
        {
            state.requests.push({
                index: state.requests.length,
                startedAt: performance.now(),
                path: url.pathname
            });
        }
        return originalFetch(input, init);
    };
    const observe = () =>
    {
        const recordCompletion = () =>
        {
            for (const article of document.querySelectorAll('[data-preview-source-identity]'))
            {
                const previewIdentity = article.getAttribute('data-preview-source-identity');
                const completeIdentity = article.getAttribute('data-preview-render-complete');
                const renderMarkdownIdentity = article.getAttribute('data-preview-render-markdown-identity');
                const activationMarkdownIdentity = article.getAttribute('data-preview-activation-markdown-identity');
                if (!previewIdentity || completeIdentity !== previewIdentity
                    || !renderMarkdownIdentity || !activationMarkdownIdentity)
                {
                    continue;
                }
                const requestIndex = state.requests.length - 1;
                const key = `${requestIndex}:${previewIdentity}`;
                if (state.completions.some(item => item.key === key))
                {
                    continue;
                }
                state.completions.push({
                    key,
                    requestIndex,
                    previewIdentity,
                    completeIdentity,
                    renderMarkdownIdentity,
                    activationMarkdownIdentity,
                    completedAt: performance.now()
                });
            }
        };
        new MutationObserver(recordCompletion).observe(document.documentElement, {
            attributes: true,
            childList: true,
            subtree: true
        });
        recordCompletion();
    };
    if (document.documentElement)
    {
        observe();
    }
    else
    {
        document.addEventListener('DOMContentLoaded', observe, { once: true });
    }
}

async function waitForMarkdownFeatureBoundary(page, scopeSelector)
{
    await page.waitForFunction((selector) =>
    {
        const scope = document.querySelector(selector);
        if (!scope || scope.querySelector('.markdown-renderer__error'))
        {
            return false;
        }
        return Boolean(
            scope.querySelector('table')
            && scope.querySelector('pre code')
            && scope.querySelector('.katex')
            && scope.querySelector('.markdown-renderer__mermaid svg')
            && scope.querySelectorAll('[data-latex-placeholder], [data-mermaid-placeholder]').length === 0
            && scope.querySelectorAll('[data-markdown-feature-activated="latex"]').length === 1
            && scope.querySelectorAll('[data-markdown-feature-activated="mermaid"]').length === 1
        );
    }, scopeSelector);
    return {
        table: true,
        code: true,
        latex: true,
        mermaid: true
    };
}

function browserAudit(page)
{
    const errors = [];
    const sanitizeUrl = value =>
    {
        try
        {
            const url = new URL(value);
            return `${url.origin}${url.pathname}`;
        }
        catch
        {
            return '<invalid-url>';
        }
    };
    const sanitizeText = value => String(value ?? '')
        .replace(/https?:\/\/[^\s"'<>]+/gu, match => sanitizeUrl(match))
        .slice(0, 256);
    page.on('console', message =>
    {
        if (message.type() === 'error')
        {
            errors.push(`console:error:${sanitizeText(message.text())}`);
        }
    });
    page.on('pageerror', error =>
        errors.push(`pageerror:${sanitizeText(error.name || 'Error')}:${sanitizeText(error.message)}`));
    page.on('requestfailed', request =>
    {
        errors.push(
            `requestfailed:${request.method()}:${sanitizeUrl(request.url())}:`
            + sanitizeText(request.failure()?.errorText ?? 'unknown')
        );
    });
    return {
        checkpoint: () => errors.length,
        errorsSince: checkpoint => errors.slice(checkpoint)
    };
}

function parsePublicBootIdentity(html, label)
{
    const match = /<script\b(?=[^>]*\bid=(?:"|')fsus-public-boot-config(?:"|'))[^>]*>([\s\S]*?)<\/script>/iu.exec(html);
    requireCondition(Boolean(match), `${label} is missing #fsus-public-boot-config`);
    let config;
    try
    {
        config = JSON.parse(match[1]);
    }
    catch (error)
    {
        fail(`${label} #fsus-public-boot-config is invalid JSON: ${error.message}`);
    }
    requireCondition(
        config?.schema === 'fsusblog.public-boot-config.v1',
        `${label} public boot config schema mismatch`
    );
    return requireString(
        config.frontendBuildIdentity,
        `${label} #fsus-public-boot-config.frontendBuildIdentity`
    );
}

export async function verifyNavigationResponseIdentity({
    response,
    expectedUrl,
    expectedReleaseId,
    requirePublicBootIdentity,
    label = 'navigation'
})
{
    requireCondition(Boolean(response), `${label} returned no navigation response`);
    const responseUrl = requireString(response.url(), `${label} response URL`);
    requireCondition(responseUrl === expectedUrl, `${label} response URL drift`);
    const status = Number(response.status());
    requireCondition(
        Number.isInteger(status) && status >= 200 && status < 300,
        `${label} response status ${String(status)} is not successful`
    );
    const headers = response.headers();
    const releaseId = requireString(
        headers?.['x-fsus-release-id'],
        `${label} response x-fsus-release-id`
    );
    requireCondition(
        releaseId === expectedReleaseId,
        `${label} response x-fsus-release-id does not match the side release`
    );
    const evidence = { url: responseUrl, status, releaseId };
    if (requirePublicBootIdentity)
    {
        const frontendBuildIdentity = parsePublicBootIdentity(
            await response.text(),
            label
        );
        requireCondition(
            frontendBuildIdentity === expectedReleaseId,
            `${label} public frontendBuildIdentity does not match the side release`
        );
        evidence.frontendBuildIdentity = frontendBuildIdentity;
    }
    return Object.freeze(evidence);
}

async function navigateAndVerifyRelease(page, side, routeName, requirePublicBootIdentity)
{
    const expectedUrl = new URL(
        side.manifest.runtime.routes[routeName],
        side.staticBaseUrl
    ).href;
    const response = await page.goto(expectedUrl, { waitUntil: 'domcontentloaded' });
    return verifyNavigationResponseIdentity({
        response,
        expectedUrl,
        expectedReleaseId: side.manifest.runtime.releaseId,
        requirePublicBootIdentity,
        label: `${side.side} ${routeName}`
    });
}

async function preparePreviewForm(page, corpus)
{
    const navigationIdentity = await navigateAndVerifyRelease(
        page,
        page.__fsusSide,
        'adminWrite',
        false
    );
    await page.getByPlaceholder('在此键入博文标题...').fill(corpus.preview.title);
    await page.getByRole('textbox', { name: 'Markdown 正文编辑区' }).fill(corpus.preview.content);
    const summary = page.getByRole('textbox', { name: '摘要' });
    if (!(await summary.isVisible()))
    {
        await page.locator('.article-sidebar-summary').filter({ hasText: '摘要' }).click();
    }
    await summary.fill(corpus.preview.summary);
    requireCondition(corpus.preview.coverImageUrl === null, 'real preview adapter requires the fixed null cover fixture');
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.getByRole('button', { name: '生成私有预览', exact: true }).waitFor({
        state: 'visible'
    });
    return navigationIdentity;
}

function decodePreviewResponse(bytes)
{
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const frame = decodeAedsFrame(buffer);
    requireCondition(frame.frameType === articlePreviewFrameType, 'preview response frame type mismatch');
    let payload;
    try
    {
        payload = JSON.parse(new TextDecoder().decode(frame.payload));
    }
    catch (error)
    {
        fail(`preview response payload is not canonical JSON: ${error.message}`);
    }
    requireCondition(previewIdentityPattern.test(String(payload.sourceIdentity ?? '')), 'preview response sourceIdentity missing');
    return payload;
}

async function createRealSideAdapter(side, corpus, playwrightRuntime)
{
    const runtimeProbe = await verifyRuntimeIdentityProbe(side);
    const module = await import(pathToFileURL(side.ssrEntry).href);
    for (const name of ['renderPublicArticleDetailEntry', 'renderPublicAboutEntry'])
    {
        requireCondition(typeof module[name] === 'function', `${side.side} SSR entry is missing ${name}`);
    }
    const aotOptions = createAotOptions(module, corpus);
    const browser = await playwrightRuntime.chromium.launch({ headless: true });
    requireCondition(
        browser.version() === side.manifest.toolchain.browser,
        `${side.side} browser version does not match the side manifest`
    );
    const context = await browser.newContext({
        baseURL: side.staticBaseUrl,
        storageState: side.storageState,
        serviceWorkers: 'block'
    });
    await context.addInitScript(installPreviewInstrumentation);
    const page = await context.newPage();
    page.__fsusSide = side;
    const audit = browserAudit(page);
    const previewResponses = [];
    page.on('response', response =>
    {
        const url = new URL(response.url());
        if (url.pathname === previewEndpointPath
            && response.request().method() === 'POST')
        {
            previewResponses.push(response);
        }
    });

    return {
        identity: {
            runtimeProbe,
            browserVersion: browser.version()
        },
        async measure(expected)
        {
            const startedAt = new Date().toISOString();
            const auditCheckpoint = audit.checkpoint();
            const aotStarted = performance.now();
            const article = await module.renderPublicArticleDetailEntry(aotOptions.article);
            const about = await module.renderPublicAboutEntry(aotOptions.about);
            const aotMs = performance.now() - aotStarted;
            requireCondition(
                typeof article?.entry?.html === 'string' && typeof about?.entry?.html === 'string',
                `${side.side} AOT renderer returned no HTML`
            );

            const clientStarted = performance.now();
            const articleNavigation = await navigateAndVerifyRelease(
                page,
                side,
                'article',
                true
            );
            await waitForMarkdownFeatureBoundary(page, '.markdown-renderer__body');
            const aboutNavigation = await navigateAndVerifyRelease(
                page,
                side,
                'about',
                true
            );
            const features = await waitForMarkdownFeatureBoundary(page, '.markdown-renderer__body');
            const clientMs = performance.now() - clientStarted;

            const adminWriteNavigation = await preparePreviewForm(page, corpus);
            const responseCountBefore = previewResponses.length;
            const requestCountBefore = await page.evaluate(
                () => globalThis.__fsusMarkdownPreviewPerformance.requests.length
            );
            const responsePromise = page.waitForResponse(response =>
            {
                const url = new URL(response.url());
                return url.pathname === previewEndpointPath
                    && response.request().method() === 'POST';
            });
            await page.getByRole('button', { name: '生成私有预览', exact: true }).click();
            const response = await responsePromise;
            requireCondition(response.ok(), `${side.side} preview response status ${response.status()}`);
            const bytes = await response.body();
            const previewPayload = decodePreviewResponse(bytes);
            requireCondition(
                previewPayload.normalizedTitle === corpus.preview.title
                && previewPayload.normalizedSummary === corpus.preview.summary
                && previewPayload.normalizedMarkdownSource === corpus.preview.content
                && (previewPayload.normalizedCoverImageUrl ?? null) === corpus.preview.coverImageUrl,
                `${side.side} preview response does not match the canonical corpus`
            );
            await page.waitForFunction((identity) =>
            {
                const article = [...document.querySelectorAll('[data-preview-source-identity]')]
                    .find(element => element.getAttribute('data-preview-source-identity') === identity);
                return article?.getAttribute('data-preview-render-complete') === identity;
            }, previewPayload.sourceIdentity);
            const completion = await page.evaluate(({ identity, requestIndex }) =>
            {
                const state = globalThis.__fsusMarkdownPreviewPerformance;
                return state.completions.find(item =>
                    item.previewIdentity === identity && item.requestIndex === requestIndex) ?? null;
            }, {
                identity: previewPayload.sourceIdentity,
                requestIndex: requestCountBefore
            });
            requireCondition(Boolean(completion), `${side.side} current-source completion event is missing`);
            const request = await page.evaluate(index =>
                globalThis.__fsusMarkdownPreviewPerformance.requests[index] ?? null,
            requestCountBefore);
            requireCondition(Boolean(request), `${side.side} exact preview request start is missing`);
            requireCondition(
                completion.completedAt > request.startedAt,
                `${side.side} preview completion clock is invalid`
            );
            const previewMs = completion.completedAt - request.startedAt;
            const dom = await page.locator(
                `[data-preview-source-identity="${previewPayload.sourceIdentity}"]`
            ).evaluate(element => ({
                previewIdentity: element.getAttribute('data-preview-source-identity'),
                completeIdentity: element.getAttribute('data-preview-render-complete'),
                renderMarkdownIdentity: element.getAttribute('data-preview-render-markdown-identity'),
                activationMarkdownIdentity: element.getAttribute('data-preview-activation-markdown-identity'),
                placeholderCount: element.querySelectorAll(
                    '[data-latex-placeholder], [data-mermaid-placeholder]'
                ).length
            }));
            const previewFeatures = await waitForMarkdownFeatureBoundary(
                page,
                `[data-preview-source-identity="${previewPayload.sourceIdentity}"]`
            );
            requireCondition(
                previewResponses.length === responseCountBefore + 1,
                `${side.side} preview sample emitted duplicate/dropped AEDS responses`
            );
            const browserErrors = audit.errorsSince(auditCheckpoint);
            return {
                side: side.side,
                phase: expected.phase,
                sampleIndex: expected.sampleIndex,
                startedAt,
                finishedAt: new Date().toISOString(),
                aotMs,
                clientMs,
                previewMs,
                previewResponseBytes: bytes.byteLength,
                previewResponseIdentity: previewPayload.sourceIdentity,
                domPreviewSourceIdentity: dom.previewIdentity,
                domPreviewCompleteIdentity: dom.completeIdentity,
                renderMarkdownIdentity: dom.renderMarkdownIdentity,
                activationMarkdownIdentity: dom.activationMarkdownIdentity,
                features: {
                    table: features.table && previewFeatures.table,
                    code: features.code && previewFeatures.code,
                    latex: features.latex && previewFeatures.latex,
                    mermaid: features.mermaid && previewFeatures.mermaid
                },
                navigationIdentities: {
                    article: articleNavigation,
                    about: aboutNavigation,
                    adminWrite: adminWriteNavigation
                },
                placeholderCount: dom.placeholderCount,
                browserErrors
            };
        },
        async close()
        {
            await context.close();
            await browser.close();
        }
    };
}

async function loadManagedPlaywright()
{
    const require = createRequire(import.meta.url);
    const packageFile = require.resolve('@playwright/test/package.json', { paths: [frontendRoot] });
    const moduleFile = require.resolve('@playwright/test', { paths: [frontendRoot] });
    const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const playwright = require(moduleFile);
    return {
        chromium: playwright.chromium,
        version: String(packageJson.version)
    };
}

function sideEvidence(side)
{
    const verification = side.receiptVerification;
    return {
        manifest: side.manifestFile,
        manifestDigest: side.manifestFileDigest,
        source: side.manifest.source,
        productionBuild: {
            receipt: side.receiptFile,
            receiptContentDigest: side.receipt.contentDigest,
            profile: side.receipt.build.profile,
            verification: {
                schema: verification.schema,
                status: verification.status,
                artifactCount: verification.artifactCount,
                artifactBytes: verification.artifactBytes,
                digestAuthority: verification.digestAuthority,
                inputsVerifiedAgainstCheckout: verification.inputsVerifiedAgainstCheckout,
                verifiedAt: verification.verifiedAt
            }
        },
        artifacts: side.manifest.artifacts,
        runtime: side.manifest.runtime,
        fixture: {
            profile: side.manifest.fixture.profile,
            identity: side.manifest.fixture.identity,
            namespace: side.manifest.fixture.namespace,
            topology: side.manifest.fixture.topology,
            contentDigest: side.manifest.fixture.contentDigest,
            adminStorageState: side.manifest.fixture.adminStorageState
        },
        machine: side.manifest.machine,
        toolchain: side.manifest.toolchain
    };
}

export async function runPairedMeasurements({
    base,
    candidate,
    corpus,
    adapterFactory,
    machine = currentMachineIdentity(),
    toolchain = null
})
{
    validatePairedSides(base, candidate, corpus);
    const liveMachine = currentMachineIdentity();
    validateMachineAuthority(machine, liveMachine, 'measurement machine');
    for (const side of [base, candidate])
    {
        requireCondition(
            side.manifest.machine.identityDigest === machine.identityDigest,
            `${side.side} machine identity does not bind the measurement process`
        );
    }
    requireCondition(typeof adapterFactory === 'function', 'paired runner requires an adapter factory');
    const adapters = new Map();
    const samples = [];
    const identities = {};
    try
    {
        for (const side of [base, candidate])
        {
            const adapter = await adapterFactory(side, corpus);
            requireCondition(adapter && typeof adapter.measure === 'function', `${side.side} adapter is invalid`);
            adapters.set(side.side, adapter);
            identities[side.side] = adapter.identity ?? null;
        }
        for (const expected of pairedSchedule())
        {
            const sample = await adapters.get(expected.side).measure(expected);
            const side = expected.side === 'base' ? base : candidate;
            samples.push(validateMeasuredSample(sample, expected, side.manifest.runtime));
        }
    }
    finally
    {
        for (const adapter of adapters.values())
        {
            await adapter.close?.();
        }
    }
    const comparison = comparePairedSamples(samples);
    const measurement = {
        schema: measurementSchema,
        status: comparison.status,
        generatedAt: new Date().toISOString(),
        thresholds,
        corpus: {
            schema: corpus.schema,
            fixtureIdentity: corpus.fixtureIdentity,
            contentDigest: corpus.contentDigest,
            file: corpus.file,
            fileDigest: corpus.fileDigest
        },
        machine,
        toolchain,
        sides: {
            base: sideEvidence(base),
            candidate: sideEvidence(candidate)
        },
        runtimeIdentities: identities,
        schedule: pairedSchedule(),
        samples,
        comparison,
        contentDigest: null
    };
    measurement.contentDigest = contentDigest(measurement);
    return measurement;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function assertNoSensitiveEvidence(value, label = 'evidence')
{
    if (Array.isArray(value))
    {
        value.forEach((entry, index) => assertNoSensitiveEvidence(entry, `${label}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object')
    {
        return;
    }
    for (const [key, entry] of Object.entries(value))
    {
        requireCondition(!sensitiveEvidenceKeyPattern.test(key), `${label}.${key} is a sensitive evidence field`);
        assertNoSensitiveEvidence(entry, `${label}.${key}`);
    }
}

function validateRuntimeEvidence(runtime, label, sourceCommit)
{
    requireExactObject(runtime, [
        'backendBaseUrl',
        'backendKind',
        'buildIdentity',
        'identityProbe',
        'mode',
        'releaseId',
        'routes',
        'staticBaseUrl',
        'staticServerKind'
    ], label);
    requireExactObject(runtime.routes, ['about', 'adminWrite', 'article'], `${label}.routes`);
    requireExactObject(runtime.identityProbe, [
        'headers',
        'method',
        'responseDigest',
        'status',
        'url'
    ], `${label}.identityProbe`);
    requireCondition(runtime.mode === 'Release', `${label}.mode must be Release`);
    requireCondition(
        runtime.staticServerKind === 'immutable-release-static'
        && runtime.backendKind === 'immutable-release-runtime',
        `${label} is not an immutable Release runtime`
    );
    const staticBaseUrl = validateBaseUrl(runtime.staticBaseUrl, `${label}.staticBaseUrl`);
    const backendBaseUrl = validateBaseUrl(runtime.backendBaseUrl, `${label}.backendBaseUrl`);
    const releaseId = validateReleaseRuntimeIdentity(runtime, sourceCommit, label);
    for (const route of ['article', 'about', 'adminWrite'])
    {
        validateSameOriginRoute(runtime.routes[route], staticBaseUrl, `${label}.routes.${route}`);
    }
    validateIdentityProbeUrl(runtime.identityProbe.url, backendBaseUrl, `${label}.identityProbe.url`);
    requireCondition(runtime.identityProbe.method === 'GET', `${label}.identityProbe.method must be GET`);
    requireCondition(
        Number.isInteger(runtime.identityProbe.status)
        && runtime.identityProbe.status >= 100
        && runtime.identityProbe.status <= 599,
        `${label}.identityProbe.status is invalid`
    );
    requireDigest(runtime.identityProbe.responseDigest, `${label}.identityProbe.responseDigest`);
    validateIdentityHeaders(
        runtime.identityProbe.headers,
        `${label}.identityProbe.headers`,
        releaseId
    );
}

function validateSideEvidenceRecord(record, side)
{
    const label = `raw measurement sides.${side}`;
    requireExactObject(record, [
        'artifacts',
        'fixture',
        'machine',
        'manifest',
        'manifestDigest',
        'productionBuild',
        'runtime',
        'source',
        'toolchain'
    ], label);
    requireString(record.manifest, `${label}.manifest`);
    requireDigest(record.manifestDigest, `${label}.manifestDigest`);
    const reloaded = loadSideManifest(record.manifest, side);
    requireCondition(
        reloaded.manifestFileDigest === record.manifestDigest,
        `${label}.manifestDigest does not match the side manifest`
    );
    requireExactObject(record.source, [
        'clean',
        'commit',
        'repositoryRoot',
        'tree',
        'worktreeFingerprint'
    ], `${label}.source`);
    requireCondition(sourceCommitPattern.test(record.source.commit), `${label}.source.commit is invalid`);
    requireCondition(gitObjectPattern.test(record.source.tree), `${label}.source.tree is invalid`);
    requireString(record.source.repositoryRoot, `${label}.source.repositoryRoot`);
    requireWorktreeFingerprint(
        record.source.worktreeFingerprint,
        `${label}.source.worktreeFingerprint`
    );
    requireCondition(record.source.clean === true, `${label}.source.clean must be true`);
    requireExactObject(
        record.productionBuild,
        ['profile', 'receipt', 'receiptContentDigest', 'verification'],
        `${label}.productionBuild`
    );
    requireCondition(
        record.productionBuild.profile === 'production-release-fresh',
        `${label}.productionBuild.profile is invalid`
    );
    requireString(record.productionBuild.receipt, `${label}.productionBuild.receipt`);
    requireDigest(record.productionBuild.receiptContentDigest, `${label}.productionBuild.receiptContentDigest`);
    requireExactObject(record.productionBuild.verification, [
        'artifactBytes',
        'artifactCount',
        'digestAuthority',
        'inputsVerifiedAgainstCheckout',
        'schema',
        'status',
        'verifiedAt'
    ], `${label}.productionBuild.verification`);
    requireCondition(
        record.productionBuild.verification.status === 'success',
        `${label}.productionBuild.verification did not pass`
    );
    requireExactObject(record.artifacts, ['clientEntry', 'frontendDist', 'ssrEntry'], `${label}.artifacts`);
    for (const artifact of ['clientEntry', 'frontendDist', 'ssrEntry'])
    {
        requireExactObject(record.artifacts[artifact], ['digest', 'path'], `${label}.artifacts.${artifact}`);
        requireString(record.artifacts[artifact].path, `${label}.artifacts.${artifact}.path`);
        requireDigest(record.artifacts[artifact].digest, `${label}.artifacts.${artifact}.digest`);
    }
    validateRuntimeEvidence(record.runtime, `${label}.runtime`, record.source.commit);
    requireExactObject(record.fixture, [
        'adminStorageState',
        'contentDigest',
        'identity',
        'namespace',
        'profile',
        'topology'
    ], `${label}.fixture`);
    requireExactObject(
        record.fixture.adminStorageState,
        ['digest', 'path'],
        `${label}.fixture.adminStorageState`
    );
    requireString(record.fixture.adminStorageState.path, `${label}.fixture.adminStorageState.path`);
    requireDigest(record.fixture.adminStorageState.digest, `${label}.fixture.adminStorageState.digest`);
    validateMachineAuthority(record.machine, currentMachineIdentity(), `${label}.machine`);
    requireExactObject(
        record.toolchain,
        ['browser', 'dotnet', 'node', 'playwright'],
        `${label}.toolchain`
    );
    for (const field of ['browser', 'dotnet', 'node', 'playwright'])
    {
        requireString(record.toolchain[field], `${label}.toolchain.${field}`);
    }
    for (const field of ['source', 'artifacts', 'runtime', 'machine', 'toolchain'])
    {
        requireCondition(
            JSON.stringify(canonicalize(record[field]))
                === JSON.stringify(canonicalize(reloaded.manifest[field])),
            `${label}.${field} does not match the independently verified side manifest`
        );
    }
    const reloadedFixtureEvidence = {
        profile: reloaded.manifest.fixture.profile,
        identity: reloaded.manifest.fixture.identity,
        namespace: reloaded.manifest.fixture.namespace,
        topology: reloaded.manifest.fixture.topology,
        contentDigest: reloaded.manifest.fixture.contentDigest,
        adminStorageState: reloaded.manifest.fixture.adminStorageState
    };
    requireCondition(
        JSON.stringify(canonicalize(record.fixture))
            === JSON.stringify(canonicalize(reloadedFixtureEvidence)),
        `${label}.fixture does not match the independently verified side manifest`
    );
    requireCondition(
        record.productionBuild.receipt === reloaded.receiptFile
        && record.productionBuild.receiptContentDigest === reloaded.receipt.contentDigest
        && record.productionBuild.profile === reloaded.receipt.build.profile,
        `${label}.productionBuild does not match the independently verified receipt`
    );
}

function validateRuntimeIdentityEvidence(identity, sideRecord, side)
{
    const label = `raw measurement runtimeIdentities.${side}`;
    requireExactObject(identity, ['browserVersion', 'runtimeProbe'], label);
    requireString(identity.browserVersion, `${label}.browserVersion`);
    requireCondition(
        identity.browserVersion === sideRecord.toolchain.browser,
        `${label}.browserVersion does not match the side manifest`
    );
    requireExactObject(identity.runtimeProbe, [
        'headers',
        'responseBytes',
        'responseDigest',
        'status',
        'url'
    ], `${label}.runtimeProbe`);
    requireCondition(
        identity.runtimeProbe.url === sideRecord.runtime.identityProbe.url,
        `${label}.runtimeProbe.url does not match the side manifest`
    );
    validateIdentityProbeUrl(
        identity.runtimeProbe.url,
        sideRecord.runtime.backendBaseUrl,
        `${label}.runtimeProbe.url`
    );
    requireCondition(
        identity.runtimeProbe.status === sideRecord.runtime.identityProbe.status,
        `${label}.runtimeProbe.status does not match the side manifest`
    );
    requireCondition(
        Number.isSafeInteger(identity.runtimeProbe.responseBytes)
        && identity.runtimeProbe.responseBytes > 0,
        `${label}.runtimeProbe.responseBytes is invalid`
    );
    requireCondition(
        identity.runtimeProbe.responseDigest === sideRecord.runtime.identityProbe.responseDigest,
        `${label}.runtimeProbe.responseDigest does not match the side manifest`
    );
    requireCondition(
        JSON.stringify(canonicalize(identity.runtimeProbe.headers))
            === JSON.stringify(canonicalize(sideRecord.runtime.identityProbe.headers)),
        `${label}.runtimeProbe.headers do not match the side manifest`
    );
    validateIdentityHeaders(
        identity.runtimeProbe.headers,
        `${label}.runtimeProbe.headers`,
        sideRecord.runtime.releaseId
    );
}

function validateMeasurementForSealing(measurement)
{
    requireExactObject(measurement, [
        'comparison',
        'contentDigest',
        'corpus',
        'generatedAt',
        'machine',
        'runtimeIdentities',
        'samples',
        'schedule',
        'schema',
        'sides',
        'status',
        'thresholds',
        'toolchain'
    ], 'raw performance measurement');
    requireCondition(measurement.schema === measurementSchema, 'raw performance measurement schema mismatch');
    requireString(measurement.generatedAt, 'raw performance measurement generatedAt');
    requireCondition(
        JSON.stringify(canonicalize(measurement.thresholds)) === JSON.stringify(canonicalize(thresholds)),
        'raw performance measurement thresholds drift'
    );
    requireCondition(
        JSON.stringify(measurement.schedule) === JSON.stringify(pairedSchedule()),
        'raw performance measurement schedule drift'
    );
    requireExactObject(measurement.corpus, [
        'contentDigest',
        'file',
        'fileDigest',
        'fixtureIdentity',
        'schema'
    ], 'raw performance measurement corpus');
    requireCondition(measurement.corpus.schema === corpusSchema, 'raw performance measurement corpus schema mismatch');
    requireDigest(measurement.corpus.contentDigest, 'raw performance measurement corpus.contentDigest');
    requireString(measurement.corpus.file, 'raw performance measurement corpus.file');
    requireDigest(measurement.corpus.fileDigest, 'raw performance measurement corpus.fileDigest');
    requireString(measurement.corpus.fixtureIdentity, 'raw performance measurement corpus.fixtureIdentity');
    validateMachineAuthority(measurement.machine, currentMachineIdentity(), 'raw performance measurement machine');
    requireExactObject(
        measurement.toolchain,
        ['dotnet', 'node', 'playwright'],
        'raw performance measurement toolchain'
    );
    requireExactObject(measurement.sides, ['base', 'candidate'], 'raw performance measurement sides');
    validateSideEvidenceRecord(measurement.sides.base, 'base');
    validateSideEvidenceRecord(measurement.sides.candidate, 'candidate');
    requireCondition(
        measurement.sides.base.machine.identityDigest === measurement.machine.identityDigest
        && measurement.sides.candidate.machine.identityDigest === measurement.machine.identityDigest,
        'raw performance measurement machine authority drift'
    );
    requireExactObject(
        measurement.runtimeIdentities,
        ['base', 'candidate'],
        'raw performance measurement runtimeIdentities'
    );
    validateRuntimeIdentityEvidence(measurement.runtimeIdentities.base, measurement.sides.base, 'base');
    validateRuntimeIdentityEvidence(
        measurement.runtimeIdentities.candidate,
        measurement.sides.candidate,
        'candidate'
    );
    requireCondition(Array.isArray(measurement.samples), 'raw performance measurement samples must be an array');
    const validatedSamples = measurement.samples.map((sample, index) =>
    {
        requireExactObject(sample, [
            'activationMarkdownIdentity',
            'aotMs',
            'browserErrors',
            'clientMs',
            'domPreviewCompleteIdentity',
            'domPreviewSourceIdentity',
            'features',
            'finishedAt',
            'navigationIdentities',
            'phase',
            'placeholderCount',
            'previewMs',
            'previewResponseBytes',
            'previewResponseIdentity',
            'renderMarkdownIdentity',
            'sampleIndex',
            'sequence',
            'side',
            'startedAt'
        ], `raw performance measurement samples[${index}]`);
        const { sequence, ...adapterSample } = sample;
        const expected = pairedSchedule()[index] ?? {};
        const runtime = measurement.sides?.[expected.side]?.runtime ?? null;
        const validated = validateMeasuredSample(adapterSample, expected, runtime);
        requireCondition(sequence === index, `raw performance measurement sample sequence drift at ${index}`);
        return validated;
    });
    const recomputed = comparePairedSamples(validatedSamples);
    requireCondition(
        JSON.stringify(canonicalize(measurement.comparison))
            === JSON.stringify(canonicalize(recomputed)),
        'raw performance measurement comparison does not match independently recomputed samples'
    );
    requireCondition(
        measurement.status === recomputed.status,
        'raw performance measurement status does not match independently recomputed samples'
    );
    assertNoSensitiveEvidence(measurement);
    return recomputed;
}

export function sealMeasurementEvidence({
    measurementFile,
    noiseReceiptFile,
    outputFile
})
{
    const measurementRecord = readJsonRegular(measurementFile, 'raw performance measurement');
    const noiseRecord = readJsonRegular(noiseReceiptFile, 'measurement noise receipt');
    const measurement = measurementRecord.value;
    const noise = noiseRecord.value;
    requireCondition(measurement.contentDigest === contentDigest(measurement), 'raw performance measurement digest mismatch');
    validateMeasurementForSealing(measurement);
    requireCondition(
        noise.qualificationEligible === true
        && noise.windowId === 'markdown-preview-release-performance',
        'measurement noise qualification did not admit the paired window'
    );
    const rawDigest = fileDigest(measurementRecord.absolute);
    const productEvidence = noise.productOutcome?.productEvidence
        ?? noise.productOutcome?.result?.productEvidence
        ?? null;
    requireCondition(
        productEvidence?.digest === rawDigest,
        'measurement noise receipt does not bind the raw paired evidence'
    );
    const evidence = {
        schema: evidenceSchema,
        status: measurement.status,
        generatedAt: new Date().toISOString(),
        measurement: {
            path: measurementRecord.absolute,
            digest: rawDigest,
            contentDigest: measurement.contentDigest
        },
        measurementNoise: {
            path: noiseRecord.absolute,
            digest: fileDigest(noiseRecord.absolute),
            schema: noise.schema,
            classification: noise.classification,
            qualificationEligible: noise.qualificationEligible
        },
        thresholds: measurement.thresholds,
        corpus: measurement.corpus,
        machine: measurement.machine,
        toolchain: measurement.toolchain,
        sides: measurement.sides,
        runtimeIdentities: measurement.runtimeIdentities,
        schedule: measurement.schedule,
        samples: measurement.samples,
        comparison: measurement.comparison,
        contentDigest: null
    };
    evidence.contentDigest = contentDigest(evidence);
    writeJsonAtomic(outputFile, evidence);
    return evidence;
}

function parseOptions(args)
{
    const options = {};
    for (let index = 0; index < args.length; index += 2)
    {
        const flag = args[index];
        const value = args[index + 1];
        requireCondition(
            ['--base-manifest', '--candidate-manifest', '--output'].includes(flag)
            && value
            && !Object.hasOwn(options, flag),
            `invalid or duplicate CLI option: ${flag ?? '<missing>'}`
        );
        options[flag] = value;
    }
    requireCondition(Object.keys(options).length === 3, 'runner requires exactly base manifest, candidate manifest, and output');
    return options;
}

function parseSealOptions(args)
{
    requireCondition(args[0] === '--seal-evidence', 'invalid evidence sealing command');
    const options = {};
    for (let index = 1; index < args.length; index += 2)
    {
        const flag = args[index];
        const value = args[index + 1];
        requireCondition(
            ['--measurement', '--noise-receipt', '--output'].includes(flag)
            && value
            && !Object.hasOwn(options, flag),
            `invalid or duplicate evidence option: ${flag ?? '<missing>'}`
        );
        options[flag] = value;
    }
    requireCondition(Object.keys(options).length === 3, 'evidence sealing requires measurement, noise receipt, and output');
    return options;
}

async function main(args)
{
    if (args[0] === '--seal-evidence')
    {
        const options = parseSealOptions(args);
        const output = path.resolve(options['--output']);
        requireCondition(output === finalEvidenceFile, 'final evidence output owner is fixed');
        const evidence = sealMeasurementEvidence({
            measurementFile: path.resolve(options['--measurement']),
            noiseReceiptFile: path.resolve(options['--noise-receipt']),
            outputFile: output
        });
        if (evidence.status !== 'passed')
        {
            process.exitCode = 1;
        }
        return;
    }

    const options = parseOptions(args);
    const output = path.resolve(options['--output']);
    requireCondition(output === rawMeasurementFile, 'raw measurement output owner is fixed');
    const corpus = loadCorpus();
    const base = loadSideManifest(
        requireAbsoluteRegularFile(options['--base-manifest'], 'base manifest argument'),
        'base'
    );
    const candidate = loadSideManifest(
        requireAbsoluteRegularFile(options['--candidate-manifest'], 'candidate manifest argument'),
        'candidate'
    );
    const playwright = await loadManagedPlaywright();
    const actualToolchain = {
        node: process.version,
        playwright: playwright.version,
        dotnet: commandVersion('dotnet')
    };
    for (const side of [base, candidate])
    {
        for (const key of ['node', 'playwright', 'dotnet'])
        {
            requireCondition(
                side.manifest.toolchain[key] === actualToolchain[key],
                `${side.side} live ${key} identity drift`
            );
        }
    }
    const measurement = await runPairedMeasurements({
        base,
        candidate,
        corpus,
        toolchain: actualToolchain,
        adapterFactory: (side, sharedCorpus) =>
            createRealSideAdapter(side, sharedCorpus, playwright)
    });
    writeJsonAtomic(output, measurement);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main(process.argv.slice(2)).catch(error =>
    {
        console.error(`[markdown-preview-release-performance] ${error.message}`);
        process.exitCode = 1;
    });
}
