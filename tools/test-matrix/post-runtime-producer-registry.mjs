#!/usr/bin/env node

/**
 * Post-runtime evidence producer registry.
 *
 * Derives the required behavior set directly from the BehaviorCatalog
 * (`evidenceStage=post-runtime && releaseQualification=true`), then enforces
 * exact-one producer/schema/claim mapping per behavior over the closed
 * observation classes. Validators fail closed on missing, duplicate, orphan,
 * conflicting or stale mappings; existence shortcuts (HTTP 200, artifact or
 * screenshot presence, job success), diagnostic qualification and manual
 * owner/waiver surfaces are rejected. This module never executes runtime or
 * browser work and never reads Markdown to decide facts.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { digestValue, isPlainObject } from '../fact-extractors/lib/canonicalize.mjs'
import { parseMatrix } from './parse-matrix.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const registryRelative = 'config/testing/post-runtime-producer-registry.json'
export const postRuntimeRegistrySchema = 'fsusblog.post-runtime-producer-registry.v2'
export const observationEnvelopeSchema = 'fsusblog.post-runtime-observation-result-envelope.v1'
export const acceptedClaimsSchema = 'fsusblog.post-runtime-accepted-claims.v1'
export const globalExactnessSchema = 'fsusblog.global-claim-exactness-terminal-receipt.v1'
export const identityAuthoritySchema = 'fsusblog.post-runtime-identity-authority.v1'
export const sourceReceiptSchema = 'fsusblog.post-runtime-source-receipt.v1'

const observationEnvelopeSchemaRelative = 'config/schemas/post-runtime-observation-result.schema.json'
const acceptedClaimsSchemaRelative = 'config/schemas/post-runtime-accepted-claims.schema.json'
const matrixRelative = 'tests/matrix.yml'
const attemptProducersRelative = 'config/testing/correctness-attempt-producers.json'
const fixtureProfileCatalogRelative = 'config/testing/fixture-profile-catalog.json'
const configurationOwnershipRelative = 'config/configuration-ownership.json'
const modes = Object.freeze(['positive', 'negative', 'boundary', 'failure'])
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const toolVersionPattern = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/u
const unsafeReceiptPath = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
const runtimeProducerDomains = new Set(['testing', 'release', 'deployment'])
const identityRoles = Object.freeze(['plan', 'attempt', 'fixture', 'profile'])
const stableIdentityPattern = /^[a-z][a-z0-9-]{2,127}$/u
const runIdentityPattern = /^(?!\.{1,2}$)[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_])?$/u
const attemptIdentityPattern = /^attempt-[0-9]{4}$/u
const releaseIdentityPattern = /^[0-9]{14}-[a-f0-9]{12}$/u
const readerFirewallEntry = 'tools/test-matrix/post-runtime-producer-registry.mjs'
const acornDependencyParser = String.raw`
const acorn = require('internal/deps/acorn/acorn/dist/acorn')
let source = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { source += chunk })
process.stdin.on('end', () => {
    const sourceType = process.argv[1]
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType, allowHashBang: true })
    const dependencies = []
    const literal = (node) => node?.type === 'Literal' && typeof node.value === 'string'
    const add = (kind, node) => {
        if (!literal(node)) throw new Error('non-literal ' + kind + ' dependency')
        dependencies.push({ kind, specifier: node.value })
    }
    const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.type === 'ImportDeclaration') add('import', node.source)
        else if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source)
            add('import', node.source)
        else if (node.type === 'ImportExpression') add('import', node.source)
        else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier'
            && node.callee.name === 'require')
        {
            if (node.arguments.length !== 1) throw new Error('require() must have exact-one argument')
            add('require', node.arguments[0])
        }
        for (const [key, value] of Object.entries(node))
        {
            if (key === 'start' || key === 'end') continue
            if (Array.isArray(value)) value.forEach(walk)
            else walk(value)
        }
    }
    walk(ast)
    process.stdout.write(JSON.stringify(dependencies))
})
`

const readJson = (repositoryRoot, relative) =>
    JSON.parse(fs.readFileSync(path.join(repositoryRoot, relative), 'utf8'))

const forbiddenRegistryFields = new Set([
    'waiver', 'manualOwner', 'manual-owner', 'artifactPath', 'jobName', 'jobId',
    'httpStatus', 'fileExists', 'screenshot', 'allowDiagnostic', 'ignoreSchemaVersion'
])
const forbiddenSemanticFactFields = new Set([
    'httpStatus', 'fileExists', 'filePath', 'screenshot', 'screenshotPath',
    'artifactExists', 'jobStatus', 'tierPassed', 'success'
])

function fail(message)
{
    throw new Error(`[post-runtime-producer-registry] ${message}`)
}

const prefixedDigest = (value) => `sha256:${String(value ?? '').replace(/^sha256:/u, '')}`
export const authorityDigest = (value) => `sha256:${digestValue(value)}`

function canonicalRepositoryRoot(repositoryRoot)
{
    const lexicalRoot = path.resolve(repositoryRoot)
    const stat = fs.lstatSync(lexicalRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink())
    {
        fail('repository root must be a canonical non-symlink directory')
    }
    return { lexicalRoot, realRoot: fs.realpathSync.native(lexicalRoot) }
}

export function canonicalRepositoryFile(repositoryRoot, relative, label)
{
    if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)
        || relative.includes('\\') || relative.split('/').includes('..'))
    {
        fail(`${label} must be a canonical repository-relative path`)
    }
    const { lexicalRoot, realRoot } = canonicalRepositoryRoot(repositoryRoot)
    const absolute = path.resolve(lexicalRoot, relative)
    if (!absolute.startsWith(`${lexicalRoot}${path.sep}`)) fail(`${label} escapes the repository root`)
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    {
        fail(`${label} must be a regular non-symlink single-link file`)
    }
    const real = fs.realpathSync.native(absolute)
    const expectedReal = path.join(realRoot, ...relative.split('/'))
    if (real !== expectedReal || !real.startsWith(`${realRoot}${path.sep}`))
    {
        fail(`${label} must resolve to its canonical path inside the repository root`)
    }
    return real
}

function trackedRepositoryEntries(repositoryRoot)
{
    const { lexicalRoot } = canonicalRepositoryRoot(repositoryRoot)
    let output
    try
    {
        execFileSync('git', ['-C', lexicalRoot, 'diff-index', '--cached', '--quiet', 'HEAD', '--'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        })
        output = execFileSync('git', ['-C', lexicalRoot, 'ls-files', '--stage', '-z'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        })
    }
    catch (error)
    {
        fail(`Git HEAD/index authority is not exact-clean: ${error.stderr?.trim() || error.message}`)
    }
    const entries = output.split('\0').filter(Boolean).map((record) =>
    {
        const separator = record.indexOf('\t')
        const metadata = separator < 0 ? [] : record.slice(0, separator).split(' ')
        if (metadata.length !== 3 || !/^[0-7]{6}$/u.test(metadata[0])
            || !/^[a-f0-9]{40,64}$/u.test(metadata[1]) || !/^[0-3]$/u.test(metadata[2]))
        {
            fail('Git index contains an invalid tracked entry')
        }
        return {
            mode: metadata[0],
            oid: metadata[1],
            stage: Number(metadata[2]),
            path: record.slice(separator + 1).replaceAll('\\', '/')
        }
    })
    if (entries.some((entry) => entry.stage !== 0)
        || new Set(entries.map((entry) => entry.path)).size !== entries.length)
    {
        fail('Git index must contain exact-one stage-zero entry per tracked path')
    }
    return entries
}

function readIndexBlobs(repositoryRoot, entries)
{
    const objectIds = [...new Set(entries
        .filter((entry) => entry.mode === '100644' || entry.mode === '100755' || entry.mode === '120000')
        .map((entry) => entry.oid))]
    const output = execFileSync('git', ['-C', repositoryRoot, 'cat-file', '--batch'], {
        input: `${objectIds.join('\n')}\n`, maxBuffer: 256 * 1024 * 1024
    })
    const blobs = new Map()
    let offset = 0
    for (const requested of objectIds)
    {
        const headerEnd = output.indexOf(0x0a, offset)
        if (headerEnd < 0) fail(`Git index blob ${requested} has no batch header`)
        const header = output.subarray(offset, headerEnd).toString('utf8').split(' ')
        const size = Number(header[2])
        if (header[0] !== requested || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0)
        {
            fail(`Git index object ${requested} is not an exact blob`)
        }
        const start = headerEnd + 1
        const end = start + size
        if (output[end] !== 0x0a) fail(`Git index blob ${requested} has an invalid batch boundary`)
        blobs.set(requested, output.subarray(start, end))
        offset = end + 1
    }
    if (offset !== output.length) fail('Git index blob batch has trailing data')
    return blobs
}

function gitObjectFormat(repositoryRoot)
{
    const algorithm = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', '--show-object-format'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    if (!['sha1', 'sha256'].includes(algorithm)) fail(`unsupported Git object format ${algorithm}`)
    return algorithm
}

function gitBlobOid(algorithm, bytes)
{
    return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

function assertIndexWorktreeIdentity(repositoryRoot, entry, expectedBytes, objectFormat)
{
    const absolute = path.join(repositoryRoot, entry.path)
    let actualBytes
    if (entry.mode === '120000')
    {
        const stat = fs.lstatSync(absolute)
        if (!stat.isSymbolicLink()) fail(`tracked path ${entry.path} differs from its Git index file type`)
        actualBytes = Buffer.from(fs.readlinkSync(absolute), 'utf8')
    }
    else
    {
        const canonical = canonicalRepositoryFile(repositoryRoot, entry.path, `tracked path ${entry.path}`)
        actualBytes = fs.readFileSync(canonical)
    }
    if (!actualBytes.equals(expectedBytes) || gitBlobOid(objectFormat, actualBytes) !== entry.oid)
    {
        fail(`tracked path ${entry.path} worktree bytes do not exact-match the Git index blob`)
    }
}

function parseExecutableDependencies(source, relative)
{
    const sourceType = relative.endsWith('.cjs') ? 'script' : 'module'
    try
    {
        return JSON.parse(execFileSync(process.execPath, [
            '--expose-internals', '--input-type=commonjs', '--eval', acornDependencyParser, sourceType
        ], { input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }))
    }
    catch (error)
    {
        fail(`cannot parse executable dependency AST for ${relative}: ${error.stderr?.trim() || error.message}`)
    }
}

function resolveExecutableDependency(repositoryRoot, importer, dependency)
{
    const specifier = dependency.specifier
    if (isBuiltin(specifier) || specifier.startsWith('node:')) return null
    const importerAbsolute = path.join(repositoryRoot, importer)
    let resolved
    try
    {
        if (dependency.kind === 'require')
        {
            resolved = createRequire(pathToFileURL(importerAbsolute)).resolve(specifier)
        }
        else
        {
            const output = execFileSync(process.execPath, [
                '--experimental-import-meta-resolve', '--input-type=module', '--eval',
                'process.stdout.write(import.meta.resolve(process.argv[1], process.argv[2]))',
                specifier, pathToFileURL(importerAbsolute).href
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
            if (output.startsWith('node:') || isBuiltin(output)) return null
            if (!output.startsWith('file:')) fail(`reader dependency ${specifier} resolves to unsupported ${output}`)
            resolved = fileURLToPath(output)
        }
    }
    catch (error)
    {
        fail(`reader dependency ${specifier} from ${importer} cannot be resolved by Node: ${error.stderr?.trim() || error.message}`)
    }
    const { realRoot } = canonicalRepositoryRoot(repositoryRoot)
    const absolute = path.resolve(resolved)
    if (!absolute.startsWith(`${realRoot}${path.sep}`))
    {
        fail(`reader dependency ${specifier} from ${importer} resolves outside the repository`)
    }
    return path.relative(realRoot, absolute).replaceAll(path.sep, '/')
}

export function validatePostRuntimeReaderFirewall(repositoryRoot = root, entry = readerFirewallEntry)
{
    const pending = [entry]
    const visited = new Set()
    while (pending.length > 0)
    {
        const relative = pending.pop()
        if (visited.has(relative)) continue
        visited.add(relative)
        if (relative.startsWith('docs/') || relative.startsWith('tools/docs/')
            || /(?:^|\/)(?:doc-claim|markdown-reader)[^/]*\.(?:mjs|js|cjs)$/iu.test(relative))
        {
            fail(`post-runtime reader import closure reaches forbidden Markdown/DocClaim module ${relative}`)
        }
        const absolute = canonicalRepositoryFile(repositoryRoot, relative, `reader module ${relative}`)
        const dependencies = parseExecutableDependencies(fs.readFileSync(absolute, 'utf8'), relative)
        for (const dependency of dependencies)
        {
            const resolved = resolveExecutableDependency(repositoryRoot, relative, dependency)
            if (resolved) pending.push(resolved)
        }
    }
    return { entry, modules: [...visited].sort() }
}

export function validatePostRuntimeRepositoryAuthority(repositoryRoot = root, {
    validateReaderFirewall = true
} = {})
{
    canonicalRepositoryFile(repositoryRoot, registryRelative, 'canonical post-runtime registry')
    const ownership = readJson(repositoryRoot, configurationOwnershipRelative)
    const owners = (ownership.ownership ?? []).filter((entry) =>
        entry.id === 'post-runtime-producer-registry' || entry.canonicalPath === registryRelative)
    if (owners.length !== 1 || owners[0].id !== 'post-runtime-producer-registry'
        || owners[0].canonicalPath !== registryRelative || owners[0].pathType !== 'file'
        || owners[0].owner !== 'behavior-test-evidence-binding'
        || owners[0].status !== 'manual')
    {
        fail('post-runtime registry must have exact-one canonical configuration owner')
    }
    const trackedEntries = trackedRepositoryEntries(repositoryRoot)
    const indexBlobs = readIndexBlobs(repositoryRoot, trackedEntries)
    const objectFormat = gitObjectFormat(repositoryRoot)
    const registryFiles = trackedEntries
        .filter((entry) => indexBlobs.has(entry.oid))
        .filter((entry) =>
        {
            const bytes = indexBlobs.get(entry.oid)
            assertIndexWorktreeIdentity(repositoryRoot, entry, bytes, objectFormat)
            try
            {
                return JSON.parse(bytes.toString('utf8'))?.schema === postRuntimeRegistrySchema
            }
            catch
            {
                return false
            }
        })
        .map((entry) => entry.path)
        .sort()
    assertExactSet(registryFiles, [registryRelative], 'post-runtime registry authority paths')
    if (validateReaderFirewall) validatePostRuntimeReaderFirewall(repositoryRoot)
    return true
}

function receiptDigest(receipt)
{
    if (!isPlainObject(receipt)) fail('receipt must be a plain object')
    const content = Object.fromEntries(Object.entries(receipt)
        .filter(([key]) => key !== 'contentDigest'))
    return `sha256:${digestValue(content)}`
}

function assertExactSet(actual, expected, label)
{
    if (!Array.isArray(actual) || new Set(actual).size !== actual.length
        || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort()))
    {
        fail(`${label} must exact-match ${[...expected].sort().join(', ')}`)
    }
}

function assertExactKeys(value, expected, label)
{
    if (!isPlainObject(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
    {
        fail(`${label} has missing or unknown fields`)
    }
}

function assertAllowedKeys(value, allowed, required, label)
{
    if (!isPlainObject(value)
        || Object.keys(value).some((key) => !allowed.includes(key))
        || required.some((key) => !Object.hasOwn(value, key)))
    {
        fail(`${label} has missing or unknown fields`)
    }
}

function currentReceiptFile(repositoryRoot, relative, label)
{
    if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)
        || relative.includes('\\') || unsafeReceiptPath.test(relative) || !relative.endsWith('.json'))
    {
        fail(`${label} must be an explicit current-run JSON path`)
    }
    return canonicalRepositoryFile(repositoryRoot, relative, label)
}

export const BehaviorId = (value) =>
{
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(value)) throw new Error(`invalid behavior ID ${value}`)
    return value
}

export function loadPostRuntimeProducerRegistry(repositoryRoot = root)
{
    return readJson(repositoryRoot, registryRelative)
}

export function validatePostRuntimeReceiptSchemas(registry, {
    observationSchema = readJson(root, observationEnvelopeSchemaRelative),
    claimsSchema = readJson(root, acceptedClaimsSchemaRelative)
} = {})
{
    if (observationSchema?.$id !== observationEnvelopeSchema
        || observationSchema.additionalProperties !== false)
    {
        fail('observation envelope schema identity or closed shape drifted')
    }
    if (claimsSchema?.$id !== acceptedClaimsSchema || claimsSchema.additionalProperties !== false)
    {
        fail('accepted-claims schema identity or closed shape drifted')
    }
    const observationSchemas = Object.values(registry.observationClasses ?? {})
        .map((definition) => definition.schema)
    assertExactSet(observationSchema.properties?.schema?.enum, observationSchemas,
        'observation envelope schema identities')
    assertExactSet(observationSchema.properties?.modes?.items?.enum, modes,
        'observation envelope modes')
    assertExactSet(observationSchema.properties?.outcome?.enum,
        Object.keys(registry.receiptSemantics?.terminalOutcomes ?? {}),
        'observation envelope terminal outcomes')
    assertExactSet(observationSchema.required, [
        'schema', 'producerId', 'toolVersion', 'registryDigest',
        'observationSchemaDigest', 'sourceState', 'executionClass',
        'evidenceClass', 'qualificationEligible', 'planned', 'executed', 'outcome',
        'recovered', 'modes', 'terminal', 'semanticFacts', 'candidatePlanRef',
        'attemptAuthorityRef', 'fixtureAuthorityRef', 'profileAuthorityRef',
        'sourceReceiptRef', 'canonicalRerunCommand', 'independentVerifyCommand',
        'contentDigest'
    ], 'observation envelope required fields')
    assertExactSet(observationSchema.properties?.sourceState?.required,
        ['sourceCommit', 'worktreeFingerprint', 'runId', 'attemptId', 'fixtureId', 'profileId'],
        'observation source-state required fields')
    assertExactSet(observationSchema.$defs?.identityAuthorityRef?.properties?.role?.enum,
        identityRoles, 'identity authority roles')
    if (observationSchema.$defs?.identityAuthorityRef?.properties?.schema?.const !== identityAuthoritySchema)
    {
        fail('identity authority reference schema drifted')
    }
    assertExactSet(observationSchema.$defs?.sourceReceiptRef?.required,
        ['path', 'fileDigest', 'contentDigest', 'schema', 'role'],
        'source receipt reference fields')
    if (observationSchema.$defs?.sourceReceiptRef?.properties?.schema?.const !== sourceReceiptSchema
        || observationSchema.$defs?.sourceReceiptRef?.properties?.role?.const !== 'source')
    {
        fail('source receipt reference schema/role drifted')
    }
    assertExactSet(claimsSchema.required, [
        'schema', 'sourceState', 'producerId', 'toolVersion', 'registryDigest',
        'claimsSchemaDigest', 'terminalReceiptRef', 'migrationLedgerDigest', 'claims',
        'status', 'contentDigest'
    ], 'accepted-claims required fields')
    assertExactSet(claimsSchema.properties?.terminalReceiptRef?.required,
        ['path', 'fileDigest', 'contentDigest', 'schema'],
        'accepted terminal receipt reference fields')
    if (claimsSchema.properties?.terminalReceiptRef?.properties?.schema?.const !== globalExactnessSchema)
    {
        fail('accepted-claims terminal schema does not bind #2205 authority')
    }
    return true
}

export function requiredPostRuntimeBehaviors(catalog)
{
    return catalog.contracts
        .filter((contract) => contract.status === 'active'
            && contract.evidenceStage === 'post-runtime'
            && contract.releaseQualification === true)
        .map((contract) => contract.id)
        .sort()
}

export function validatePostRuntimeProducerRegistry(registry, {
    catalog,
    migrationLedger = null,
    repositoryRoot = root,
    matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, matrixRelative), 'utf8')),
    attemptProducers = readJson(repositoryRoot, attemptProducersRelative),
    validateRepositoryAuthority = true
} = {})
{
    if (!registry || registry.schema !== postRuntimeRegistrySchema)
    {
        fail(`unexpected registry schema: ${registry?.schema ?? 'missing'}`)
    }
    for (const key of Object.keys(registry))
    {
        if (forbiddenRegistryFields.has(key)) fail(`forbidden registry field ${key}`)
    }
    assertExactKeys(registry, [
        'schema', 'digestAlgorithm', 'canonicalSerialization', 'receiptSemantics',
        'observationClasses', 'producers'
    ], 'registry')
    if (registry.digestAlgorithm !== 'sha256' || registry.canonicalSerialization !== 'json-utf8-v1')
    {
        fail('registry digest algorithm or canonical serialization drifted')
    }
    const semantics = registry.receiptSemantics
    assertExactKeys(semantics, [
        'observationEnvelopeSchema', 'acceptedClaimsSchema', 'acceptedClaimsToolVersion',
        'acceptedTerminalSchema', 'requiredModes', 'qualifyingEnvelope', 'terminalOutcomes'
    ], 'receipt semantics')
    if (semantics.observationEnvelopeSchema !== observationEnvelopeSchema
        || semantics.acceptedClaimsSchema !== acceptedClaimsSchema
        || semantics.acceptedTerminalSchema !== globalExactnessSchema
        || !toolVersionPattern.test(semantics.acceptedClaimsToolVersion ?? ''))
    {
        fail('receipt semantics schema or accepted-claims tool identity drifted')
    }
    assertExactSet(semantics.requiredModes, modes, 'receipt semantics required modes')
    assertExactKeys(semantics.qualifyingEnvelope, [
        'executionClass', 'evidenceClass', 'qualificationEligible', 'planned',
        'executed', 'outcome', 'recovered'
    ], 'qualifying envelope')
    const qualifying = semantics.qualifyingEnvelope
    if (qualifying.executionClass !== 'correctness' || qualifying.evidenceClass !== 'correctness'
        || qualifying.qualificationEligible !== true || qualifying.planned !== true
        || qualifying.executed !== true || qualifying.outcome !== 'passed'
        || qualifying.recovered !== false)
    {
        fail('qualifying envelope must be clean correctness execution')
    }
    assertExactKeys(semantics.terminalOutcomes, ['passed', 'failed', 'timed-out', 'cancelled'],
        'terminal outcome registry')
    const expectedTerminal = {
        passed: [false, false, false],
        failed: [false, false, false],
        'timed-out': [true, false, true],
        cancelled: [false, true, true]
    }
    for (const [outcome, expected] of Object.entries(expectedTerminal))
    {
        const terminal = semantics.terminalOutcomes[outcome]
        assertExactKeys(terminal, ['timeout', 'cancelled', 'processTreeTerminated'],
            `terminal outcome ${outcome}`)
        if (JSON.stringify([terminal.timeout, terminal.cancelled, terminal.processTreeTerminated])
            !== JSON.stringify(expected))
        {
            fail(`terminal outcome ${outcome} has contradictory process semantics`)
        }
    }

    const classIds = Object.keys(registry.observationClasses ?? {})
    if (classIds.length === 0) fail('observation classes must not be empty')
    for (const [classId, definition] of Object.entries(registry.observationClasses ?? {}))
    {
        assertExactKeys(definition, [
            'schema', 'requiredIdentityFields', 'requiredSemanticFactFields', 'allowedModes',
            'existenceShortcutForbidden'
        ], `observation class ${classId}`)
        if (!/^[a-z0-9-]+$/u.test(classId)) fail(`observation class id ${classId} is not canonical`)
        if (!definition.schema || !/^fsusblog\.observation\.[a-z0-9.-]+\.v\d+$/u.test(definition.schema))
        {
            if (definition.schema !== 'fsusblog.browser-contract-receipt.v2')
            {
                fail(`observation class ${classId} schema is missing or not versioned`)
            }
        }
        const identities = definition.requiredIdentityFields ?? []
        if (!identities.includes('contentDigest'))
        {
            fail(`observation class ${classId} must bind contentDigest`)
        }
        if (definition.existenceShortcutForbidden !== true)
        {
            fail(`observation class ${classId} must forbid existence shortcuts`)
        }
        if (!Array.isArray(definition.requiredSemanticFactFields)
            || definition.requiredSemanticFactFields.length === 0
            || new Set(definition.requiredSemanticFactFields).size !== definition.requiredSemanticFactFields.length
            || definition.requiredSemanticFactFields.some((field) =>
                typeof field !== 'string' || field.length === 0 || forbiddenSemanticFactFields.has(field)))
        {
            fail(`observation class ${classId} must declare closed semantic facts without existence shortcuts`)
        }
        assertExactSet(definition.allowedModes, modes, `observation class ${classId} allowed modes`)
        for (const field of Object.keys(definition))
        {
            if (forbiddenRegistryFields.has(field)) fail(`observation class ${classId} has forbidden field ${field}`)
        }
    }

    const requiredBehaviors = requiredPostRuntimeBehaviors(catalog)
    if (requiredBehaviors.length === 0) fail('catalog declares no post-runtime release behaviors')

    const producers = registry.producers ?? []
    const byBehavior = new Map()
    const contracts = new Map((catalog.contracts ?? []).map((contract) => [contract.id, contract]))
    for (const producer of producers)
    {
        for (const field of Object.keys(producer))
        {
            if (forbiddenRegistryFields.has(field)) fail(`producer ${producer.producerId} has forbidden field ${field}`)
        }
        assertExactKeys(producer, [
            'producerId', 'toolVersion', 'owner', 'behaviorId', 'behaviorDomain',
            'producerTierId', 'observationSchema', 'executionClass', 'evidenceClass',
            'requiredIdentities', 'requiredObservations',
            'diagnosticEligible', 'timeoutPolicy', 'cancelPolicy', 'recoveryPolicy',
            'acceptedClaimRefs'
        ], `producer ${producer.producerId ?? 'missing'}`)
        if (!/^[a-z0-9-]+$/u.test(producer.producerId ?? ''))
        {
            fail(`producer id ${producer.producerId} is not canonical`)
        }
        if (!toolVersionPattern.test(producer.toolVersion ?? ''))
        {
            fail(`producer ${producer.producerId} toolVersion is missing or invalid`)
        }
        if (byBehavior.has(producer.behaviorId))
        {
            fail(`behavior ${producer.behaviorId} is mapped by two producers (${byBehavior.get(producer.behaviorId)}, ${producer.producerId})`)
        }
        byBehavior.set(producer.behaviorId, producer.producerId)
        if (!requiredBehaviors.includes(producer.behaviorId))
        {
            fail(`producer ${producer.producerId} maps behavior ${producer.behaviorId} which is not a post-runtime release behavior`)
        }
        const contract = contracts.get(producer.behaviorId)
        if (producer.behaviorDomain !== contract?.domain
            || producer.producerTierId !== contract?.runtimeEvidence?.producerTierId
            || producer.observationSchema !== contract?.runtimeEvidence?.observationSchema)
        {
            fail(`producer ${producer.producerId} domain/tier/schema conflicts with the BehaviorCatalog`)
        }
        if (!runtimeProducerDomains.has(producer.behaviorDomain))
        {
            fail(`producer ${producer.producerId} behavior domain is not runtime-eligible`)
        }
        const tier = (matrix.tiers ?? []).find((entry) => entry.id === producer.producerTierId)
        const attemptAuthority = (attemptProducers.entries ?? []).find((entry) =>
            entry.producerId === `matrix:${producer.producerTierId}`)
        if (!tier || !attemptAuthority
            || attemptAuthority.sourceAuthority !== matrixRelative
            || JSON.stringify(attemptAuthority.logicalTierIds) !== JSON.stringify([producer.producerTierId])
            || attemptAuthority.canonicalCommand !== tier.command
            || attemptAuthority.executionOwner !== producer.owner
            || attemptAuthority.qualificationEligible !== true)
        {
            fail(`producer ${producer.producerId} owner is not the canonical matrix producer authority`)
        }
        if (typeof tier.command !== 'string' || !tier.command.startsWith('tools/')
            || tier.command.endsWith('.md'))
        {
            fail(`producer ${producer.producerId} command must be a non-Markdown executable authority`)
        }
        canonicalRepositoryFile(repositoryRoot, tier.command, `producer ${producer.producerId} command`)
        if (typeof producer.owner !== 'string' || producer.owner.startsWith('docs/')
            || producer.owner.endsWith('.md'))
        {
            fail(`producer ${producer.producerId} owner must be a non-Markdown executable authority`)
        }
        canonicalRepositoryFile(repositoryRoot, producer.owner, `producer ${producer.producerId} owner`)
        if (producer.diagnosticEligible === true)
        {
            fail(`producer ${producer.producerId} must never accept diagnostic evidence as qualification`)
        }
        if (producer.executionClass !== 'correctness' && producer.executionClass !== 'browser-contract')
        {
            fail(`producer ${producer.producerId} execution class ${producer.executionClass} cannot satisfy qualification`)
        }
        if (producer.evidenceClass !== tier.evidenceClass
            || !['correctness', 'browser-contract'].includes(producer.evidenceClass))
        {
            fail(`producer ${producer.producerId} evidenceClass conflicts with its matrix tier`)
        }
        for (const identity of producer.requiredIdentities ?? [])
        {
            if (typeof identity !== 'string' || identity.length === 0)
            {
                fail(`producer ${producer.producerId} has an invalid required identity`)
            }
        }
        if (!(producer.requiredIdentities ?? []).includes('sourceCommit')
            || !(producer.requiredIdentities ?? []).includes('worktreeFingerprint'))
        {
            fail(`producer ${producer.producerId} must bind source identity`)
        }
        assertExactKeys(producer.requiredObservations, modes,
            `producer ${producer.producerId} required observations`)
        const observedClasses = new Set()
        for (const [mode, classes] of Object.entries(producer.requiredObservations ?? {}))
        {
            if (!['positive', 'negative', 'boundary', 'failure'].includes(mode))
            {
                fail(`producer ${producer.producerId} has unknown observation mode ${mode}`)
            }
            if (!Array.isArray(classes) || classes.length === 0)
            {
                fail(`producer ${producer.producerId} mode ${mode} must list observation classes`)
            }
            if (new Set(classes).size !== classes.length)
            {
                fail(`producer ${producer.producerId} mode ${mode} has duplicate observation classes`)
            }
            for (const classId of classes)
            {
                if (!registry.observationClasses[classId])
                {
                    fail(`producer ${producer.producerId} references unknown observation class ${classId}`)
                }
                observedClasses.add(classId)
            }
        }
        assertExactSet([...observedClasses], classIds,
            `producer ${producer.producerId} observation class closure`)
        for (const policy of ['timeoutPolicy', 'cancelPolicy', 'recoveryPolicy'])
        {
            if (typeof producer[policy] !== 'string' || producer[policy].length === 0)
            {
                fail(`producer ${producer.producerId} must declare ${policy}`)
            }
        }
        if (!Array.isArray(producer.acceptedClaimRefs) || producer.acceptedClaimRefs.length === 0)
        {
            fail(`producer ${producer.producerId} must reference accepted document claims`)
        }
        if (migrationLedger)
        {
            const ledgerClaims = migrationLedger.scopes
                .flatMap((scope) => scope.entries)
                .filter((entry) => entry['behaviorId'] === producer.behaviorId)
                .flatMap((entry) => entry.claimIds)
            assertExactSet(producer.acceptedClaimRefs, ledgerClaims,
                `producer ${producer.producerId} accepted claim refs`)
        }
    }

    for (const behaviorId of requiredBehaviors)
    {
        if (!byBehavior.has(behaviorId))
        {
            fail(`post-runtime release behavior ${behaviorId} has no producer mapping`)
        }
    }

    validatePostRuntimeReceiptSchemas(registry, {
        observationSchema: readJson(repositoryRoot, observationEnvelopeSchemaRelative),
        claimsSchema: readJson(repositoryRoot, acceptedClaimsSchemaRelative)
    })
    if (validateRepositoryAuthority) validatePostRuntimeRepositoryAuthority(repositoryRoot)

    return {
        schema: registry.schema,
        requiredBehaviors,
        producerCount: producers.length,
        observationClassCount: classIds.length,
        warnings: 0
    }
}

function producerFor(registry, producerId)
{
    if (registry?.schema !== postRuntimeRegistrySchema)
    {
        fail(`unexpected registry schema: ${registry?.schema ?? 'missing'}`)
    }
    const producer = (registry.producers ?? []).find((entry) => entry.producerId === producerId)
    if (!producer) fail(`unknown producer ${producerId}`)
    return producer
}

function classForReceipt(registry, receipt, requestedClassId = null)
{
    const matches = Object.entries(registry.observationClasses ?? {})
        .filter(([classId, definition]) => definition.schema === receipt?.schema
            && (requestedClassId === null || classId === requestedClassId))
    if (matches.length !== 1)
    {
        fail(`receipt schema ${receipt?.schema ?? 'missing'} does not resolve exact-one observation class`)
    }
    return { classId: matches[0][0], definition: matches[0][1] }
}

function requiredModesFor(producer, classId)
{
    return Object.entries(producer.requiredObservations)
        .filter(([, classIds]) => classIds.includes(classId))
        .map(([mode]) => mode)
        .sort()
}

function validateTypedSourceState(sourceState, schema, repositoryRoot, producerId)
{
    assertAllowedKeys(sourceState,
        Object.keys(schema.properties?.sourceState?.properties ?? {}),
        schema.properties?.sourceState?.required ?? [],
        `producer ${producerId} sourceState`)
    if (!/^[a-f0-9]{40}$/u.test(sourceState.sourceCommit ?? '')
        || !digestPattern.test(sourceState.worktreeFingerprint ?? '')
        || !runIdentityPattern.test(sourceState.runId ?? '')
        || !attemptIdentityPattern.test(sourceState.attemptId ?? '')
        || !stableIdentityPattern.test(sourceState.profileId ?? ''))
    {
        fail(`producer ${producerId} receipt source identity is invalid`)
    }
    for (const digestField of ['buildIdentity', 'artifactDigest'])
    {
        if (sourceState[digestField] !== undefined && !digestPattern.test(sourceState[digestField]))
        {
            fail(`producer ${producerId} receipt source identity ${digestField} is invalid`)
        }
    }
    if (sourceState.candidateId !== `${sourceState.runId}:candidate`
        || sourceState.fixtureId !== `${sourceState.runId}:fixture`
        || sourceState.runtimeId !== `${sourceState.runId}:runtime`
        || sourceState.browserIdentity !== `${sourceState.runId}:browser-contract`
        || sourceState.rolloutId !== `${sourceState.runId}:rollout`
        || !releaseIdentityPattern.test(sourceState.releaseId ?? ''))
    {
        fail(`producer ${producerId} receipt scoped candidate/runtime/browser/release identity is invalid`)
    }
    const profileCatalog = readJson(repositoryRoot, fixtureProfileCatalogRelative)
    if (!(profileCatalog.profiles ?? []).some((profile) => profile.id === sourceState.profileId))
    {
        fail(`producer ${producerId} profileId is absent from the fixture-profile authority`)
    }
}

function validateMachineGlobalClaimExactnessReceipt(receipt)
{
    assertExactKeys(receipt, [
        'schema', 'scopeId', 'source', 'authorityDigests', 'counts', 'mutationAggregate',
        'residue', 'proseVerification', 'status', 'failureReasons', 'contentDigest'
    ], 'global exactness terminal receipt')
    if (receipt.schema !== globalExactnessSchema
        || receipt.contentDigest !== digestValue({ ...receipt, contentDigest: null }))
    {
        fail('global exactness terminal schema/contentDigest mismatch')
    }
    if (receipt.status !== 'ok' || !Array.isArray(receipt.failureReasons)
        || receipt.failureReasons.length !== 0 || !Array.isArray(receipt.residue)
        || receipt.residue.length !== 0 || receipt.counts?.warnings !== 0
        || receipt.counts?.missing !== 0 || receipt.counts?.extra !== 0
        || receipt.counts?.residue !== 0 || receipt.counts?.generatedSectionDrifts !== 0
        || receipt.counts?.proseVerified !== receipt.counts?.proseTotal
        || receipt.mutationAggregate?.killed !== receipt.mutationAggregate?.total)
    {
        fail('global exactness terminal receipt is not a clean machine acceptance')
    }
    return receipt
}

function validateIdentityAuthorityRef(repositoryRoot, ref, expectedRole, sourceState, producerId)
{
    assertExactKeys(ref, ['path', 'fileDigest', 'contentDigest', 'schema', 'role'],
        `producer ${producerId} ${expectedRole} authority reference`)
    if (ref.schema !== identityAuthoritySchema || ref.role !== expectedRole
        || !digestPattern.test(ref.fileDigest ?? '') || !digestPattern.test(ref.contentDigest ?? ''))
    {
        fail(`producer ${producerId} ${expectedRole} authority reference is invalid`)
    }
    const authorityPath = currentReceiptFile(repositoryRoot, ref.path,
        `producer ${producerId} ${expectedRole} authority`)
    const bytes = fs.readFileSync(authorityPath)
    const fileDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (ref.fileDigest !== fileDigest) fail(`producer ${producerId} ${expectedRole} authority file digest mismatch`)
    const authority = JSON.parse(bytes.toString('utf8'))
    assertExactKeys(authority, ['schema', 'role', 'authorityId', 'sourceState', 'contentDigest'],
        `producer ${producerId} ${expectedRole} authority`)
    const roleIdentity = {
        plan: 'runId',
        attempt: 'attemptId',
        fixture: 'fixtureId',
        profile: 'profileId'
    }[expectedRole]
    if (authority.schema !== identityAuthoritySchema || authority.role !== expectedRole
        || authority.authorityId !== sourceState[roleIdentity]
        || authority.contentDigest !== receiptDigest(authority)
        || ref.contentDigest !== authority.contentDigest)
    {
        fail(`producer ${producerId} ${expectedRole} authority identity/content mismatch`)
    }
    assertExactKeys(authority.sourceState,
        ['sourceCommit', 'worktreeFingerprint', 'runId', 'attemptId', 'fixtureId', 'profileId'],
        `producer ${producerId} ${expectedRole} authority sourceState`)
    for (const field of Object.keys(authority.sourceState))
    {
        if (authority.sourceState[field] !== sourceState[field])
        {
            fail(`producer ${producerId} ${expectedRole} authority sourceState mismatch`)
        }
    }
}

function validateSourceReceiptRef(repositoryRoot, ref, sourceState, producer, producerId)
{
    assertExactKeys(ref, ['path', 'fileDigest', 'contentDigest', 'schema', 'role'],
        `producer ${producerId} source receipt reference`)
    if (ref.schema !== sourceReceiptSchema || ref.role !== 'source'
        || !digestPattern.test(ref.fileDigest ?? '') || !digestPattern.test(ref.contentDigest ?? ''))
    {
        fail(`producer ${producerId} source receipt reference is invalid`)
    }
    const sourcePath = currentReceiptFile(repositoryRoot, ref.path, `producer ${producerId} source receipt`)
    const bytes = fs.readFileSync(sourcePath)
    const fileDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (ref.fileDigest !== fileDigest) fail(`producer ${producerId} source receipt file digest mismatch`)
    const sourceReceipt = JSON.parse(bytes.toString('utf8'))
    assertExactKeys(sourceReceipt,
        ['schema', 'role', 'producerId', 'toolVersion', 'sourceState', 'contentDigest'],
        `producer ${producerId} source receipt`)
    if (sourceReceipt.schema !== sourceReceiptSchema || sourceReceipt.role !== 'source'
        || sourceReceipt.producerId !== producerId || sourceReceipt.toolVersion !== producer.toolVersion
        || sourceReceipt.contentDigest !== receiptDigest(sourceReceipt)
        || ref.contentDigest !== sourceReceipt.contentDigest
        || digestValue(sourceReceipt.sourceState) !== digestValue(sourceState))
    {
        fail(`producer ${producerId} source receipt schema/producer/source identity mismatch`)
    }
}

export function validateProducerReceiptAgainstRegistry({
    registry,
    producerId,
    receipt,
    classId: requestedClassId = null,
    repositoryRoot = root
})
{
    const producer = producerFor(registry, producerId)
    const { classId, definition } = classForReceipt(registry, receipt, requestedClassId)
    const schema = readJson(repositoryRoot, observationEnvelopeSchemaRelative)
    assertExactKeys(receipt, schema.required, `producer ${producerId} receipt`)
    if (receipt.producerId !== producerId || receipt.toolVersion !== producer.toolVersion)
    {
        fail(`producer ${producerId} receipt producer/tool version mismatch`)
    }
    if (receipt.registryDigest !== authorityDigest(registry)
        || receipt.observationSchemaDigest !== authorityDigest(schema))
    {
        fail(`producer ${producerId} receipt registry/schema digest mismatch`)
    }
    if (receipt.evidenceClass !== producer.evidenceClass)
    {
        fail(`producer ${producerId} receipt evidenceClass does not match producer contract`)
    }
    if (!digestPattern.test(receipt.contentDigest ?? '') || receipt.contentDigest !== receiptDigest(receipt))
    {
        fail(`producer ${producerId} receipt contentDigest mismatch`)
    }
    const identity = receipt?.sourceState ?? receipt?.sourceIdentity ?? {}
    for (const required of definition.requiredIdentityFields)
    {
        if (required === 'contentDigest') continue
        if (identity[required] == null && receipt?.[required] == null)
        {
            fail(`producer ${producerId} receipt is missing ${classId} identity ${required}`)
        }
    }
    validateTypedSourceState(identity, schema, repositoryRoot, producerId)
    assertExactSet(receipt.modes, requiredModesFor(producer, classId),
        `producer ${producerId} ${classId} modes`)
    assertExactKeys(receipt.terminal,
        ['timeout', 'cancelled', 'processTreeTerminated', 'priorAttemptDigest'],
        `producer ${producerId} terminal`)
    const expectedTerminal = registry.receiptSemantics.terminalOutcomes[receipt.outcome]
    if (!expectedTerminal
        || receipt.terminal.timeout !== expectedTerminal.timeout
        || receipt.terminal.cancelled !== expectedTerminal.cancelled
        || receipt.terminal.processTreeTerminated !== expectedTerminal.processTreeTerminated)
    {
        fail(`producer ${producerId} receipt terminal outcome is contradictory`)
    }
    if (receipt.recovered === true)
    {
        if (!digestPattern.test(receipt.terminal.priorAttemptDigest ?? ''))
        {
            fail(`producer ${producerId} recovered receipt must bind a prior sealed attempt`)
        }
    }
    else if (receipt.terminal.priorAttemptDigest !== null)
    {
        fail(`producer ${producerId} non-recovered receipt cannot bind a recovery attempt`)
    }
    const authorityRefs = [
        ['candidatePlanRef', 'plan'],
        ['attemptAuthorityRef', 'attempt'],
        ['fixtureAuthorityRef', 'fixture'],
        ['profileAuthorityRef', 'profile']
    ]
    if (new Set([...authorityRefs.map(([field]) => receipt[field]?.path), receipt.sourceReceiptRef?.path]).size
        !== authorityRefs.length + 1)
    {
        fail(`producer ${producerId} identity authorities must use independent paths`)
    }
    for (const [field, role] of authorityRefs)
    {
        validateIdentityAuthorityRef(repositoryRoot, receipt[field], role, identity, producerId)
    }
    validateSourceReceiptRef(repositoryRoot, receipt.sourceReceiptRef, identity, producer, producerId)
    assertExactKeys(receipt.semanticFacts, definition.requiredSemanticFactFields,
        `producer ${producerId} ${classId} semantic facts`)
    if (Object.values(receipt.semanticFacts).some((value) => value === null || value === '')
        || typeof receipt.canonicalRerunCommand !== 'string' || receipt.canonicalRerunCommand.length === 0
        || typeof receipt.independentVerifyCommand !== 'string'
        || receipt.independentVerifyCommand.length === 0)
    {
        fail(`producer ${producerId} receipt lacks semantic facts or replay commands`)
    }
    for (const [field, expected] of Object.entries(registry.receiptSemantics.qualifyingEnvelope))
    {
        if (receipt[field] !== expected)
        {
            fail(`producer ${producerId} receipt ${field} cannot satisfy qualification`)
        }
    }
    return {
        producerId,
        behaviorId: BehaviorId(producer.behaviorId),
        classId,
        qualificationEligible: true,
        warnings: 0
    }
}

export function validateAcceptedClaimsReceiptAgainstRegistry({
    registry,
    producerId,
    receipt,
    repositoryRoot = root,
    migrationLedger = readJson(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json')
})
{
    const producer = producerFor(registry, producerId)
    const schema = readJson(repositoryRoot, acceptedClaimsSchemaRelative)
    assertExactKeys(receipt, schema.required, 'accepted-claims receipt')
    if (receipt.schema !== acceptedClaimsSchema || receipt.status !== 'accepted'
        || receipt.producerId !== producerId
        || receipt.toolVersion !== registry.receiptSemantics.acceptedClaimsToolVersion)
    {
        fail('accepted-claims receipt schema/status/producer/tool version mismatch')
    }
    if (receipt.registryDigest !== authorityDigest(registry)
        || receipt.claimsSchemaDigest !== authorityDigest(schema))
    {
        fail('accepted-claims receipt registry/schema digest mismatch')
    }
    if (!digestPattern.test(receipt.contentDigest ?? '') || receipt.contentDigest !== receiptDigest(receipt))
    {
        fail('accepted-claims receipt contentDigest mismatch')
    }
    assertExactKeys(receipt.sourceState, ['commit', 'worktreeFingerprint'],
        'accepted-claims source identity')
    if (!/^[a-f0-9]{40}$/u.test(receipt.sourceState.commit ?? '')
        || !digestPattern.test(receipt.sourceState.worktreeFingerprint ?? ''))
    {
        fail('accepted-claims source identity is invalid')
    }
    assertExactKeys(receipt.terminalReceiptRef, ['path', 'fileDigest', 'contentDigest', 'schema'],
        'accepted terminal receipt reference')
    const terminalPath = currentReceiptFile(repositoryRoot, receipt.terminalReceiptRef.path,
        'accepted terminal receipt')
    const terminalBytes = fs.readFileSync(terminalPath)
    const terminalFileDigest = `sha256:${createHash('sha256').update(terminalBytes).digest('hex')}`
    if (receipt.terminalReceiptRef.fileDigest !== terminalFileDigest)
    {
        fail('accepted terminal receipt file digest mismatch')
    }
    const terminal = JSON.parse(terminalBytes.toString('utf8'))
    if (receipt.terminalReceiptRef.schema !== globalExactnessSchema
        || terminal.schema !== globalExactnessSchema
        || receipt.terminalReceiptRef.contentDigest !== prefixedDigest(terminal.contentDigest))
    {
        fail('accepted terminal receipt schema/content digest mismatch')
    }
    validateMachineGlobalClaimExactnessReceipt(terminal)
    if (receipt.sourceState.commit !== terminal.source?.sourceCommit
        || receipt.sourceState.worktreeFingerprint !== prefixedDigest(terminal.source?.worktreeFingerprint))
    {
        fail('accepted terminal receipt source identity mismatch')
    }
    const currentLedgerDigest = `sha256:${digestValue(migrationLedger)}`
    if (receipt.migrationLedgerDigest !== currentLedgerDigest
        || receipt.migrationLedgerDigest !== prefixedDigest(terminal.source?.migrationLedgerDigest))
    {
        fail('accepted terminal receipt migration ledger digest mismatch')
    }
    const owners = new Map()
    for (const scope of migrationLedger.scopes ?? [])
    {
        for (const entry of scope.entries ?? [])
        {
            for (const claimId of entry.claimIds ?? [])
            {
                if (owners.has(claimId)) fail(`claim ${claimId} has duplicate ledger owners`)
                owners.set(claimId, {
                    claimId,
                    behaviorId: BehaviorId(entry.behaviorId),
                    scopeId: scope.scopeId
                })
            }
        }
    }
    const expectedClaims = producer.acceptedClaimRefs.map((claimId) =>
    {
        const owner = owners.get(claimId)
        if (!owner || owner.behaviorId !== producer.behaviorId)
        {
            fail(`accepted claim ${claimId} is absent from the #2205 terminal authority`)
        }
        return owner
    }).sort((left, right) => left.claimId.localeCompare(right.claimId))
    const actualClaims = [...(receipt.claims ?? [])]
        .sort((left, right) => String(left?.claimId).localeCompare(String(right?.claimId)))
    if (new Set(actualClaims.map((entry) => entry?.claimId)).size !== actualClaims.length
        || JSON.stringify(actualClaims) !== JSON.stringify(expectedClaims))
    {
        fail('accepted claim set does not exact-match #2205 terminal authority and registry')
    }
    return {
        producerId,
        behaviorId: BehaviorId(producer.behaviorId),
        terminalReceiptDigest: receipt.terminalReceiptRef.contentDigest,
        acceptedClaims: actualClaims.length,
        warnings: 0
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const registry = loadPostRuntimeProducerRegistry(root)
    const summary = validatePostRuntimeProducerRegistry(registry, {
        catalog: readJson(root, 'config/contracts/behavior-contracts.json'),
        migrationLedger: readJson(root, 'config/contracts/document-claim-migration-ledger.json')
    })
    console.log(`[post-runtime-producer-registry] ok behaviors=${summary.requiredBehaviors.length} producers=${summary.producerCount} classes=${summary.observationClassCount} warnings=${summary.warnings}`)
}
