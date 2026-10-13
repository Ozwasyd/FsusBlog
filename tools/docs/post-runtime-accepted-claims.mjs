#!/usr/bin/env node

/**
 * Publishes the claim subset accepted by the #2205 terminal authority for one
 * post-runtime producer. The publisher derives every claim from the canonical
 * migration ledger and registry, after replaying the terminal document mapping
 * against current authorities. It does not execute runtime evidence.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { BehaviorId, loadCatalog } from '../contracts/behavior-contract-catalog.mjs'
import { digestValue } from '../fact-extractors/lib/canonicalize.mjs'
import { sealSourceIdentity } from '../fact-extractors/identity.mjs'
import {
    globalExactnessSchema,
    validateGlobalClaimExactnessReceipt
} from './global-claim-exactness-final.mjs'
import {
    acceptedClaimsSchema,
    loadPostRuntimeProducerRegistry,
    validateAcceptedClaimsReceiptAgainstRegistry,
    validatePostRuntimeProducerRegistry
} from '../test-matrix/post-runtime-producer-registry.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const commitPattern = /^[a-f0-9]{40}$/u
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const unsafePathPattern = /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu
const authorityCache = new Map()

function fail(message)
{
    throw new Error(`[post-runtime-accepted-claims] ${message}`)
}

const prefixedDigest = (value) => `sha256:${String(value ?? '').replace(/^sha256:/u, '')}`

function receiptDigest(receipt)
{
    const withoutDigest = Object.fromEntries(Object.entries(receipt)
        .filter(([key]) => key !== 'contentDigest'))
    return `sha256:${digestValue(withoutDigest)}`
}

function ensurePhysicalRoot(repositoryRoot)
{
    const resolved = path.resolve(repositoryRoot)
    if (!fs.statSync(resolved).isDirectory() || fs.lstatSync(resolved).isSymbolicLink()
        || fs.realpathSync(resolved) !== resolved)
    {
        fail('repository root must be a physical non-symlink directory')
    }
    return resolved
}

function resolveCurrentJsonPath(repositoryRoot, relative, label, { mustExist })
{
    const resolvedRoot = ensurePhysicalRoot(repositoryRoot)
    if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)
        || relative.includes('\\') || !relative.endsWith('.json') || unsafePathPattern.test(relative))
    {
        fail(`${label} must be an explicit current-run JSON path inside the repository`)
    }
    const absolute = path.resolve(resolvedRoot, relative)
    if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) fail(`${label} escapes the repository root`)

    let cursor = resolvedRoot
    for (const component of path.relative(resolvedRoot, absolute).split(path.sep))
    {
        cursor = path.join(cursor, component)
        const stat = fs.lstatSync(cursor, { throwIfNoEntry: false })
        if (stat?.isSymbolicLink()) fail(`${label} path must not contain symlinks`)
        if (!stat) break
    }

    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
    if (mustExist && (!stat?.isFile() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute))
    {
        fail(`${label} must be a physical regular file`)
    }
    if (!mustExist && stat) fail(`${label} already exists`)
    return {
        absolute,
        relative: path.relative(resolvedRoot, absolute).replaceAll(path.sep, '/')
    }
}

function currentRepositoryAuthorityKey(repositoryRoot)
{
    const root = path.resolve(repositoryRoot)
    const git = (args) => execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
    }).trim()
    if (git(['for-each-ref', '--format=%(refname)', 'refs/replace/']))
    {
        fail('Git replacement refs are forbidden for repository authority validation')
    }
    try
    {
        git(['diff-index', '--cached', '--quiet', 'HEAD', '--'])
        git(['diff-files', '--quiet', '--'])
    }
    catch (error)
    {
        fail(`Git HEAD/index/worktree authority is not exact-clean: ${error.stderr?.trim() || error.message}`)
    }
    return `${root}\0${git(['rev-parse', '--verify', 'HEAD'])}\0${git([
        'rev-parse', '--verify', 'HEAD^{tree}'
    ])}`
}

function loadAuthorities(repositoryRoot)
{
    const cacheKey = currentRepositoryAuthorityKey(repositoryRoot)
    const cached = authorityCache.get(cacheKey)
    if (cached) return cached
    const catalog = loadCatalog(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'))
    const migrationLedger = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
    const registry = loadPostRuntimeProducerRegistry(repositoryRoot)
    validatePostRuntimeProducerRegistry(registry, { catalog, migrationLedger, repositoryRoot })
    const resolved = { migrationLedger, registry }
    authorityCache.clear()
    authorityCache.set(cacheKey, resolved)
    return resolved
}

function selectProducer(registry, producerId, { requireExplicitWhenAmbiguous })
{
    const selectedId = producerId ?? (registry.producers.length === 1 ? registry.producers[0].producerId : null)
    if (!selectedId && requireExplicitWhenAmbiguous)
    {
        fail('--producer is required when the registry contains multiple producers')
    }
    const producer = registry.producers.find((entry) => entry.producerId === selectedId)
    if (!producer) fail(`unknown post-runtime producer ${selectedId ?? '<missing>'}`)
    return producer
}

function assertCurrentSource(receiptSource, repositoryRoot)
{
    const current = sealSourceIdentity(repositoryRoot)
    if (!commitPattern.test(receiptSource?.commit ?? '')
        || !digestPattern.test(receiptSource?.worktreeFingerprint ?? '')
        || receiptSource.commit !== current.sourceCommit
        || receiptSource.worktreeFingerprint !== prefixedDigest(current.worktreeFingerprint))
    {
        fail('receipt source identity does not match the current repository state')
    }
}

function assertExpectedRunId(runId)
{
    if (typeof runId !== 'string' || runId.length === 0)
    {
        fail('expected run id is required')
    }
    return runId
}

function readAcceptedTerminal(terminalBytes, expectedRunId, repositoryRoot)
{
    const terminal = JSON.parse(terminalBytes.toString('utf8'))
    validateGlobalClaimExactnessReceipt(terminal, {
        expectedRunId: assertExpectedRunId(expectedRunId),
        repositoryRoot
    })
    return terminal
}

function claimOwners(migrationLedger)
{
    const owners = new Map()
    for (const scope of migrationLedger.scopes ?? [])
    {
        for (const entry of scope.entries ?? [])
        {
            for (const claimId of entry.claimIds ?? [])
            {
                if (owners.has(claimId)) fail(`claim ${claimId} has duplicate migration-ledger owners`)
                owners.set(claimId, {
                    claimId,
                    behaviorId: BehaviorId(entry.behaviorId),
                    scopeId: scope.scopeId
                })
            }
        }
    }
    return owners
}

export function buildPostRuntimeAcceptedClaimsReceipt({
    terminalReceiptPath,
    expectedRunId,
    producerId = null,
    repositoryRoot = root
})
{
    const terminalPath = resolveCurrentJsonPath(
        repositoryRoot, terminalReceiptPath, 'terminal receipt', { mustExist: true })
    const referenceBytes = fs.readFileSync(terminalPath.absolute)
    const reference = JSON.parse(referenceBytes.toString('utf8'))
    const payloadPath = resolveCurrentJsonPath(repositoryRoot, reference.payload?.path,
        'terminal payload', { mustExist: true })
    const terminalBytes = fs.readFileSync(payloadPath.absolute)
    const terminal = readAcceptedTerminal(terminalBytes, expectedRunId, repositoryRoot)

    const sourceState = {
        commit: terminal.source?.sourceCommit,
        worktreeFingerprint: prefixedDigest(terminal.source?.worktreeFingerprint),
        schedulerRunId: reference.schedulerRunId,
        attemptId: reference.attemptId,
        candidateIdentityDigest: prefixedDigest(digestValue(reference.candidateIdentity)),
        buildIdentityDigest: prefixedDigest(digestValue(reference.buildIdentity))
    }
    assertCurrentSource(sourceState, repositoryRoot)

    const { migrationLedger, registry } = loadAuthorities(repositoryRoot)
    const producer = selectProducer(registry, producerId, { requireExplicitWhenAmbiguous: true })
    const migrationLedgerDigest = `sha256:${digestValue(migrationLedger)}`
    if (prefixedDigest(terminal.source?.migrationLedgerDigest) !== migrationLedgerDigest)
    {
        fail('terminal receipt migration-ledger digest does not match current #2205 authority')
    }

    const owners = claimOwners(migrationLedger)
    const claims = producer.acceptedClaimRefs.map((claimId) =>
    {
        const owner = owners.get(claimId)
        if (!owner || owner.behaviorId !== producer.behaviorId)
        {
            fail(`accepted claim ${claimId} is absent from the #2205 terminal authority`)
        }
        const accepted = terminal.claimAcceptance.find((claim) => claim.claimId === claimId)
        if (!accepted) fail(`claim ${claimId} lacks terminal acceptance`)
        return { ...owner, claimDigest: accepted.claimDigest }
    }).sort((left, right) => left.claimId.localeCompare(right.claimId))

    const receipt = {
        schema: acceptedClaimsSchema,
        sourceState,
        producerId: producer.producerId,
        toolVersion: registry.receiptSemantics.acceptedClaimsToolVersion,
        registryDigest: prefixedDigest(digestValue(registry)),
        claimsSchemaDigest: prefixedDigest(digestValue(JSON.parse(fs.readFileSync(
            path.join(repositoryRoot, 'config/schemas/post-runtime-accepted-claims.schema.json'), 'utf8')))),
        terminalReceiptRef: {
            path: terminalPath.relative,
            fileDigest: `sha256:${createHash('sha256').update(referenceBytes).digest('hex')}`,
            contentDigest: reference.contentDigest,
            schema: reference.schema,
            authorityId: registry.receiptSemantics.acceptedTerminalAuthority.authorityId,
            producerId: registry.receiptSemantics.acceptedTerminalAuthority.producerId,
            toolVersion: registry.receiptSemantics.acceptedTerminalAuthority.toolVersion,
            producerCommand: registry.receiptSemantics.acceptedTerminalAuthority.producerCommand,
            payloadPath: payloadPath.relative,
            payloadFileDigest: `sha256:${createHash('sha256').update(terminalBytes).digest('hex')}`,
            payloadContentDigest: prefixedDigest(terminal.contentDigest),
            payloadSchema: globalExactnessSchema
        },
        migrationLedgerDigest,
        claims,
        status: 'accepted'
    }
    receipt.contentDigest = receiptDigest(receipt)
    validatePostRuntimeAcceptedClaimsValue({
        receipt,
        expectedRunId,
        producerId: producer.producerId,
        repositoryRoot
    })
    return receipt
}

export function validatePostRuntimeAcceptedClaimsValue({
    receipt,
    expectedRunId,
    producerId = null,
    repositoryRoot = root
})
{
    const { migrationLedger, registry } = loadAuthorities(repositoryRoot)
    const producer = selectProducer(registry, producerId ?? receipt?.producerId, {
        requireExplicitWhenAmbiguous: false
    })
    if (receipt?.producerId !== producer.producerId) fail('accepted-claims producer identity mismatch')
    const terminalPath = resolveCurrentJsonPath(repositoryRoot, receipt?.terminalReceiptRef?.payloadPath,
        'accepted terminal receipt', { mustExist: true })
    assertCurrentSource(receipt?.sourceState, repositoryRoot)
    validateAcceptedClaimsReceiptAgainstRegistry({
        registry,
        producerId: producer.producerId,
        receipt,
        repositoryRoot,
        migrationLedger
    })
    readAcceptedTerminal(fs.readFileSync(terminalPath.absolute), expectedRunId, repositoryRoot)
    return receipt
}

export function readAndValidatePostRuntimeAcceptedClaimsReceipt({
    receiptPath,
    expectedRunId,
    producerId = null,
    repositoryRoot = root
})
{
    const resolved = resolveCurrentJsonPath(
        repositoryRoot, receiptPath, 'accepted-claims receipt', { mustExist: true })
    return validatePostRuntimeAcceptedClaimsValue({
        receipt: JSON.parse(fs.readFileSync(resolved.absolute, 'utf8')),
        expectedRunId,
        producerId,
        repositoryRoot
    })
}

export function writePostRuntimeAcceptedClaimsReceipt({
    outputPath,
    receipt,
    expectedRunId,
    repositoryRoot = root
})
{
    validatePostRuntimeAcceptedClaimsValue({ receipt, expectedRunId, repositoryRoot })
    const resolved = resolveCurrentJsonPath(
        repositoryRoot, outputPath, 'accepted-claims output', { mustExist: false })
    const resolvedRoot = ensurePhysicalRoot(repositoryRoot)
    const parentRelative = path.relative(resolvedRoot, path.dirname(resolved.absolute)).split(path.sep)
    let cursor = resolvedRoot
    for (const component of parentRelative)
    {
        if (!component) continue
        cursor = path.join(cursor, component)
        const existing = fs.lstatSync(cursor, { throwIfNoEntry: false })
        if (!existing) fs.mkdirSync(cursor)
        const created = fs.lstatSync(cursor)
        if (!created.isDirectory() || created.isSymbolicLink() || fs.realpathSync(cursor) !== cursor)
        {
            fail('accepted-claims output parent must be a physical directory')
        }
    }

    const temporary = `${resolved.absolute}.pending-${process.pid}`
    try
    {
        fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600
        })
        fs.linkSync(temporary, resolved.absolute)
    }
    finally
    {
        fs.rmSync(temporary, { force: true })
    }
    readAndValidatePostRuntimeAcceptedClaimsReceipt({
        receiptPath: resolved.relative,
        expectedRunId,
        producerId: receipt.producerId,
        repositoryRoot
    })
    return resolved.relative
}

function parseArguments(argv)
{
    const [command, ...args] = argv
    if (!['produce', 'verify'].includes(command)) fail('command must be produce or verify')
    const options = {}
    const seen = new Set()
    for (let index = 0; index < args.length; index += 2)
    {
        const key = args[index]
        const value = args[index + 1]
        if (seen.has(key)) fail(`duplicate option ${key}`)
        seen.add(key)
        if (!value) fail(`${key ?? '<missing option>'} requires a value`)
        if (key === '--terminal') options.terminalReceiptPath = value
        else if (key === '--receipt') options.receiptPath = value
        else if (key === '--producer') options.producerId = value
        else if (key === '--run-id') options.expectedRunId = value
        else if (key === '--out') options.outputPath = value
        else fail(`unknown option ${key}`)
    }
    if (command === 'produce'
        && (!options.terminalReceiptPath || !options.outputPath || !options.expectedRunId || options.receiptPath))
    {
        fail('produce requires --terminal, --run-id and --out')
    }
    if (command === 'verify'
        && (!options.receiptPath || !options.expectedRunId
            || options.outputPath || options.terminalReceiptPath))
    {
        fail('verify requires --receipt, --run-id and optional --producer')
    }
    return { command, options }
}

export function runPostRuntimeAcceptedClaimsCli(argv, repositoryRoot = root)
{
    const { command, options } = parseArguments(argv)
    if (command === 'produce')
    {
        const receipt = buildPostRuntimeAcceptedClaimsReceipt({
            terminalReceiptPath: options.terminalReceiptPath,
            expectedRunId: options.expectedRunId,
            producerId: options.producerId,
            repositoryRoot
        })
        writePostRuntimeAcceptedClaimsReceipt({
            outputPath: options.outputPath,
            receipt,
            expectedRunId: options.expectedRunId,
            repositoryRoot
        })
        console.log(`[post-runtime-accepted-claims] produced run=${options.expectedRunId} producer=${receipt.producerId} claims=${receipt.claims.length} digest=${receipt.contentDigest}`)
        return receipt
    }
    const receipt = readAndValidatePostRuntimeAcceptedClaimsReceipt({
        receiptPath: options.receiptPath,
        expectedRunId: options.expectedRunId,
        producerId: options.producerId,
        repositoryRoot
    })
    console.log(`[post-runtime-accepted-claims] verified run=${options.expectedRunId} producer=${receipt.producerId} claims=${receipt.claims.length} digest=${receipt.contentDigest}`)
    return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        runPostRuntimeAcceptedClaimsCli(process.argv.slice(2))
    }
    catch (error)
    {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    }
}
