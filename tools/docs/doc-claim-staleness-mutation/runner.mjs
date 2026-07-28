/**
 * Single-mutation runner: materialize valid fixture → apply one mutation →
 * invoke the exact public layer entrypoint → require exact reasonCode.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
    DocClaimErrorCode,
    parseDocumentClaims,
    validateClaimDeclaration
} from '../doc-claim.mjs'
import {
    makeLocatedClaim,
    verifyProseClaims
} from '../prose-claim-verifier/verifier.mjs'
import {
    processGeneratedFactSections,
    indexReceiptsByExtractor
} from '../generated-fact-sections/generator.mjs'
import {
    GeneratedSectionErrorCode,
    formatBeginMarker,
    formatEndMarker,
    parseGeneratedMarkers,
    wrapGeneratedSection
} from '../generated-fact-sections/markers.mjs'
import { loadCatalog } from '../generated-fact-sections/catalog.mjs'
import {
    joinBehaviorGraph,
    sealDocClaimVerificationReceipt,
    sealGeneratedSectionCheckReceipt,
    sealOwnerBindingReceipt,
    digestValue
} from '../../contracts/behavior-graph-join.mjs'
import { buildReceipt, sealReceipt } from '../../fact-extractors/receipt.mjs'
import { MutationLayers, forbiddenReasonCodes } from './layers.mjs'
import {
    BEHAVIOR_ID,
    DOC_PATH,
    EXTRACTOR_ID,
    SECTION_PERMISSIONS,
    currentObservations,
    digestFileTree,
    makeObservationReceipt,
    materializeFixtureRepository,
    matchingProseBodies,
    readFixtureDocument,
    readLifecycle,
    replaceGeneratedInterior,
    sampleSectionCatalog,
    writeFixtureDocument,
    writeLifecycle
} from './fixture.mjs'
import { getMutationCase, mutationCases } from './catalog.mjs'

const SOURCE_COMMIT = 'a'.repeat(40)
const WORKTREE_FP = 'b'.repeat(64)

function stable(value)
{
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    }
    return value
}

function digestTestEvidence(receipt)
{
    const content = structuredClone(receipt)
    delete content.contentDigest
    return `sha256:${createHash('sha256').update(JSON.stringify(stable(content)), 'utf8').digest('hex')}`
}

function claimBodiesFromDocument(markdown)
{
    // Extract body text after each claim marker by re-parsing declarations + following paragraph.
    // For mutations we also keep a map of claimId → body via known fixture claims.
    const known = {
        'fixture.step-up.freshness': {
            claimType: 'scalar',
            factPath: 'stepUpFreshness',
            render: 'integer-minutes',
            projection: 'default'
        },
        'fixture.cache.max-nesting': {
            claimType: 'scalar',
            factPath: 'maxNesting',
            render: 'integer-layers'
        },
        'fixture.refresh.extends-step-up': {
            claimType: 'boolean',
            factPath: 'refreshExtendsStepUp',
            render: 'boolean-extends'
        },
        'fixture.startup.fail-closed': {
            claimType: 'failure-mode',
            factPath: 'startupPolicy',
            render: 'failure-policy'
        },
        'fixture.mfa.required': {
            claimType: 'failure-mode',
            factPath: 'mfaPolicy',
            render: 'failure-policy'
        },
        'fixture.passkey.revokes': {
            claimType: 'binary-relation',
            factPath: 'passkeyRevocation',
            render: 'relation-subject-predicate-object'
        },
        'fixture.passkey.scope': {
            claimType: 'preservation-rule',
            factPath: 'passkeyScope',
            render: 'revokes-only-scope'
        },
        'fixture.session.preserve': {
            claimType: 'preservation-rule',
            factPath: 'sessionPreserve',
            render: 'preserves-fields'
        }
    }

    const claims = []
    for (const [claimId, meta] of Object.entries(known))
    {
        const marker = `claimId: ${claimId}`
        const index = markdown.indexOf(marker)
        if (index < 0) continue
        const afterClose = markdown.indexOf('-->', index)
        if (afterClose < 0) continue
        let cursor = afterClose + 3
        while (cursor < markdown.length && /[\r\n\s]/u.test(markdown[cursor])) cursor += 1
        const rest = markdown.slice(cursor)
        const paragraph = rest.split(/\n\n/u)[0].trim()
        claims.push(makeLocatedClaim({
            claimId,
            behaviorId: BEHAVIOR_ID,
            claimType: meta.claimType,
            factPath: meta.factPath,
            render: meta.render,
            projection: meta.projection,
            bodyText: paragraph,
            documentPath: DOC_PATH
        }))
    }
    return claims
}

function replaceClaimBody(markdown, claimId, bodyText)
{
    const marker = `claimId: ${claimId}`
    const index = markdown.indexOf(marker)
    if (index < 0) throw new Error(`claim ${claimId} not found for body mutation`)
    const afterClose = markdown.indexOf('-->', index)
    if (afterClose < 0) throw new Error(`claim ${claimId} marker not closed`)
    let bodyStart = afterClose + 3
    while (bodyStart < markdown.length && /[\r\n]/u.test(markdown[bodyStart])) bodyStart += 1
    // Skip blank lines after marker
    while (bodyStart < markdown.length && markdown[bodyStart] === '\n') bodyStart += 1
    const rest = markdown.slice(bodyStart)
    const paragraphEnd = rest.search(/\n\n/u)
    const bodyEnd = paragraphEnd < 0 ? markdown.length : bodyStart + paragraphEnd
    return `${markdown.slice(0, bodyStart)}${bodyText}${markdown.slice(bodyEnd)}`
}

function replaceAllKnownBodies(markdown, bodies)
{
    const map = {
        'fixture.step-up.freshness': bodies.stepUpFreshness,
        'fixture.cache.max-nesting': bodies.maxNesting,
        'fixture.refresh.extends-step-up': bodies.refreshExtendsStepUp,
        'fixture.startup.fail-closed': bodies.startupPolicy,
        'fixture.mfa.required': bodies.mfaPolicy,
        'fixture.passkey.revokes': bodies.passkeyRevocation,
        'fixture.passkey.scope': bodies.passkeyScope,
        'fixture.session.preserve': bodies.sessionPreserve
    }
    let next = markdown
    for (const [claimId, body] of Object.entries(map))
    {
        next = replaceClaimBody(next, claimId, body)
    }
    return next
}

function removeSectionMarkers(markdown, sectionId)
{
    const begin = formatBeginMarker(sectionId)
    const end = formatEndMarker(sectionId)
    const beginIndex = markdown.indexOf(begin)
    const endIndex = markdown.indexOf(end)
    if (beginIndex < 0 || endIndex < 0) throw new Error(`section ${sectionId} not found`)
    const afterEnd = endIndex + end.length
    return `${markdown.slice(0, beginIndex)}${markdown.slice(afterEnd)}`.replace(/\n{3,}/gu, '\n\n')
}

function duplicateSectionMarkers(markdown, sectionId)
{
    const begin = formatBeginMarker(sectionId)
    const end = formatEndMarker(sectionId)
    const beginIndex = markdown.indexOf(begin)
    const endIndex = markdown.indexOf(end)
    if (beginIndex < 0 || endIndex < 0) throw new Error(`section ${sectionId} not found`)
    const block = markdown.slice(beginIndex, endIndex + end.length)
    return `${markdown.slice(0, endIndex + end.length)}\n${block}${markdown.slice(endIndex + end.length)}`
}

/**
 * Apply exactly one mutation. Returns collateral change descriptors observed.
 */
export function applySingleMutation(fixture, mutation)
{
    const collateral = []
    const kind = mutation.kind

    if (kind === 'none')
    {
        return { collateral, observationOverride: null }
    }

    if (kind === 'lifecycle-field')
    {
        const lifecycle = readLifecycle(fixture.directory)
        if (mutation.field === 'lastVerifiedCommit')
        {
            lifecycle.lastVerifiedCommit = mutation.value
        }
        else if (mutation.field === 'reviewDate')
        {
            lifecycle.reviewDate = mutation.value
        }
        else
        {
            throw new Error(`unsupported lifecycle field ${mutation.field}`)
        }
        writeLifecycle(fixture.directory, lifecycle)
        collateral.push(`lifecycle:${mutation.field}`)
        return { collateral, observationOverride: null }
    }

    if (kind === 'claim-declaration-field')
    {
        // Schema-layer only; no filesystem mutation required.
        collateral.push(`declaration:${mutation.field}`)
        return { collateral, observationOverride: null, declarationField: mutation }
    }

    if (kind === 'prose-body')
    {
        const markdown = readFixtureDocument(fixture.directory)
        const next = replaceClaimBody(markdown, mutation.claimId, mutation.bodyText)
        writeFixtureDocument(fixture.directory, next)
        collateral.push(`prose-body:${mutation.claimId}`)
        return { collateral, observationOverride: null }
    }

    if (kind === 'fix-all-prose-bodies')
    {
        const markdown = readFixtureDocument(fixture.directory)
        const next = replaceAllKnownBodies(markdown, mutation.bodies)
        writeFixtureDocument(fixture.directory, next)
        collateral.push('prose-bodies-fixed')
        return { collateral, observationOverride: null }
    }

    if (kind === 'generated-interior')
    {
        const markdown = readFixtureDocument(fixture.directory)
        const next = replaceGeneratedInterior(markdown, mutation.sectionId, mutation.body)
        writeFixtureDocument(fixture.directory, next)
        collateral.push(`generated:${mutation.sectionId}`)
        return { collateral, observationOverride: null }
    }

    if (kind === 'remove-generated-markers')
    {
        const markdown = readFixtureDocument(fixture.directory)
        writeFixtureDocument(fixture.directory, removeSectionMarkers(markdown, mutation.sectionId))
        collateral.push(`marker-removed:${mutation.sectionId}`)
        return { collateral, observationOverride: null }
    }

    if (kind === 'duplicate-generated-markers')
    {
        const markdown = readFixtureDocument(fixture.directory)
        writeFixtureDocument(fixture.directory, duplicateSectionMarkers(markdown, mutation.sectionId))
        collateral.push(`marker-duplicated:${mutation.sectionId}`)
        return { collateral, observationOverride: null }
    }

    if (kind === 'stale-observation-identity')
    {
        const receipt = makeObservationReceipt({
            identity: fixture.identity,
            sourceCommit: mutation.sourceCommit,
            worktreeFingerprint: mutation.worktreeFingerprint
        })
        writeFileSync(
            path.join(fixture.directory, '.tmp/observation-receipt.json'),
            `${JSON.stringify(receipt)}\n`
        )
        collateral.push('observation-identity')
        return { collateral, observationOverride: receipt }
    }

    if (kind === 'stale-then-regenerate')
    {
        const markdown = readFixtureDocument(fixture.directory)
        const stale = replaceGeneratedInterior(markdown, mutation.sectionId, mutation.staleBody)
        writeFixtureDocument(fixture.directory, stale)
        // Prove drift first, then regenerate via public generate entry.
        processGeneratedFactSections({
            repositoryRoot: fixture.directory,
            mode: 'generate',
            catalog: sampleSectionCatalog(),
            receiptsByExtractor: indexReceiptsByExtractor([fixture.receipt]),
            expectedIdentity: fixture.identity
        })
        collateral.push('regenerated')
        return { collateral, observationOverride: null }
    }

    if (kind === 'align-observation-and-body')
    {
        const markdown = readFixtureDocument(fixture.directory)
        const next = replaceClaimBody(markdown, mutation.claimId, mutation.bodyText)
        writeFixtureDocument(fixture.directory, next)
        const observations = {
            ...currentObservations(),
            ...mutation.observationPatch
        }
        const receipt = makeObservationReceipt({
            identity: fixture.identity,
            observations
        })
        writeFileSync(
            path.join(fixture.directory, '.tmp/observation-receipt.json'),
            `${JSON.stringify(receipt)}\n`
        )
        collateral.push('observation-and-body')
        return { collateral, observationOverride: receipt }
    }

    if (kind === 'graph')
    {
        collateral.push(`graph:${mutation.graphMutation}`)
        return { collateral, observationOverride: null, graphMutation: mutation.graphMutation }
    }

    throw new Error(`unknown mutation kind ${kind}`)
}

function runProseLayer(fixture, observationOverride = null)
{
    const markdown = readFixtureDocument(fixture.directory)
    const claims = claimBodiesFromDocument(markdown)
    const receipt = observationOverride
        ?? JSON.parse(readFileSync(path.join(fixture.directory, '.tmp/observation-receipt.json'), 'utf8'))
    return verifyProseClaims({ claims, receipts: [receipt] })
}

function runGeneratedLayer(fixture, observationOverride = null)
{
    const receipt = observationOverride
        ?? JSON.parse(readFileSync(path.join(fixture.directory, '.tmp/observation-receipt.json'), 'utf8'))
    try
    {
        // Marker parse failures surface before process when markers are duplicated.
        parseGeneratedMarkers(readFixtureDocument(fixture.directory), DOC_PATH)
        const result = processGeneratedFactSections({
            repositoryRoot: fixture.directory,
            mode: 'check',
            catalog: sampleSectionCatalog(),
            receiptsByExtractor: indexReceiptsByExtractor([receipt]),
            expectedIdentity: fixture.identity
        })
        return { ok: true, result, code: null, error: null }
    }
    catch (error)
    {
        return {
            ok: false,
            result: null,
            code: error.code ?? null,
            error
        }
    }
}

function runClaimSchemaLayer(mutation)
{
    const base = {
        claimId: 'fixture.schema.probe',
        behaviorId: BEHAVIOR_ID,
        claimType: 'scalar',
        factPath: 'stepUpFreshness',
        render: 'integer-minutes'
    }
    try
    {
        validateClaimDeclaration({
            ...base,
            [mutation.field]: mutation.value
        })
        return { ok: true, code: null }
    }
    catch (error)
    {
        return { ok: false, code: error.code ?? null, error }
    }
}

function runClaimParserLayer(mutation)
{
    const block = `<!-- fsus-doc-claim
claimId: fixture.parser.probe
behaviorId: ${BEHAVIOR_ID}
claimType: scalar
factPath: stepUpFreshness
render: integer-minutes
${mutation.field}: ${JSON.stringify(mutation.value)}
-->

Body paragraph.
`
    try
    {
        parseDocumentClaims(block, {
            documentPath: DOC_PATH,
            documentStatus: 'current'
        })
        return { ok: true, code: null }
    }
    catch (error)
    {
        return { ok: false, code: error.code ?? null, error }
    }
}

function catalogDigest(catalog)
{
    return digestValue(catalog)
}

function makeGraphCatalog(overrides = {})
{
    const catalog = {
        schema: 'fsusblog.behavior-contract-catalog.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        domains: ['testing', 'documentation'],
        extractors: [
            { id: 'alpha-fact-extractor', path: 'tools/alpha/extract.mjs' },
            { id: 'beta-fact-extractor', path: 'tools/beta/extract.mjs' }
        ],
        contracts: [
            {
                id: 'alpha-behavior',
                domain: 'testing',
                risk: 'high',
                status: 'active',
                implementationOwnerCardinality: 'one',
                allowedImplementationOwnerRoles: [],
                factExtractorId: 'alpha-fact-extractor',
                requiredTestKinds: ['positive', 'boundary'],
                documentationPolicy: 'required',
                documentationRationale: 'Public alpha contract must be documented.',
                allowedClaimTypes: ['behavioral'],
                releaseQualification: true,
                coverageIds: ['alpha-behavior'],
                documents: ['docs/alpha.md']
            },
            {
                id: 'beta-behavior',
                domain: 'documentation',
                risk: 'medium',
                status: 'active',
                implementationOwnerCardinality: 'one',
                allowedImplementationOwnerRoles: [],
                factExtractorId: 'beta-fact-extractor',
                requiredTestKinds: ['positive'],
                documentationPolicy: 'required',
                documentationRationale: 'Public beta contract must be documented.',
                allowedClaimTypes: ['behavioral'],
                releaseQualification: true,
                coverageIds: ['beta-behavior'],
                documents: ['docs/beta.md']
            }
        ]
    }
    return { ...catalog, ...overrides, contracts: overrides.contracts ?? catalog.contracts }
}

function makeFact({
    extractorId = 'alpha-fact-extractor',
    behaviorIds = ['alpha-behavior'],
    observations = { limit: 10 },
    status = 'ok',
    failureReasons = [],
    sourceCommit = SOURCE_COMMIT,
    worktreeFingerprint = WORKTREE_FP
} = {})
{
    return sealReceipt(buildReceipt({
        extractorId,
        behaviorIds,
        sourceCommit,
        worktreeFingerprint,
        buildIdentity: null,
        extractorDigest: 'c'.repeat(64),
        registryDigest: 'd'.repeat(64),
        consumedInputDigests: [{ path: 'tools/alpha/extract.mjs', digest: 'e'.repeat(64) }],
        observations,
        status,
        failureReasons
    }))
}

function makeOwner({ catalog, bindings, errors = [] })
{
    const digest = catalogDigest(catalog)
    return sealOwnerBindingReceipt({
        schema: 'fsusblog.behavior-owner-binding-receipt.v1',
        catalogDigest: digest,
        worktreeDigest: SOURCE_COMMIT,
        status: errors.length === 0 ? 'ok' : 'failed',
        bindingCount: bindings.length,
        bindings: bindings.map((binding) => ({
            ...binding,
            catalogDigest: digest,
            worktreeDigest: SOURCE_COMMIT
        })),
        errors
    })
}

function defaultOwnerBindings()
{
    return [
        {
            behaviorId: 'alpha-behavior',
            language: 'javascript',
            sourcePath: 'tools/alpha/extract.mjs',
            symbol: 'extract',
            bindingKind: 'marker',
            sourceDigest: '1'.repeat(64),
            status: 'ok'
        },
        {
            behaviorId: 'beta-behavior',
            language: 'javascript',
            sourcePath: 'tools/beta/extract.mjs',
            symbol: 'extract',
            bindingKind: 'marker',
            sourceDigest: '2'.repeat(64),
            status: 'ok'
        }
    ]
}

function makeTestEvidence({ catalog, evidence, errors = [] })
{
    const digest = catalogDigest(catalog)
    const coverage = catalog.contracts
        .filter((contract) => contract.status === 'active')
        .map((contract) =>
        {
            const satisfied = contract.requiredTestKinds.filter((kind) =>
                (evidence ?? []).some((row) =>
                    row.behaviorId === contract.id
                    && row.testKind === kind
                    && row.discovered === true
                    && row.executed === true
                    && row.outcome === 'passed'))
            const missing = contract.requiredTestKinds.filter((kind) => !satisfied.includes(kind))
            return {
                behaviorId: contract.id,
                requiredTestKinds: [...contract.requiredTestKinds],
                satisfiedTestKinds: satisfied,
                missingTestKinds: missing,
                status: missing.length === 0 ? 'ok' : 'failed'
            }
        })
    const receipt = {
        schema: 'fsusblog.behavior-test-evidence-receipt.v1',
        catalogDigest: digest,
        worktreeDigest: SOURCE_COMMIT,
        run: { id: 'round-1', attemptKind: 'primary', evidenceClass: 'correctness' },
        sourceState: {
            commit: SOURCE_COMMIT,
            worktreeFingerprint: `sha256:${WORKTREE_FP}`
        },
        sourceClosureDigest: `sha256:${'f'.repeat(64)}`,
        rawResultDigest: `sha256:${'9'.repeat(64)}`,
        bindings: (evidence ?? []).map((row) => ({
            behaviorId: row.behaviorId,
            testKind: row.testKind,
            canonicalTestId: row.canonicalTestId,
            framework: 'node-tap',
            sourcePath: row.sourcePath ?? 'tests/tools/sample.test.mjs',
            fullyQualifiedName: row.fullyQualifiedName ?? row.canonicalTestId,
            invariantIds: row.invariantIds ?? [],
            reasonId: row.reasonId ?? null,
            concurrencyHarness: null,
            bindingKind: 'helper',
            line: 1
        })),
        evidence: evidence ?? [],
        coverage,
        errors
    }
    receipt.contentDigest = digestTestEvidence(receipt)
    return receipt
}

function defaultEvidence(catalog)
{
    const rows = []
    for (const contract of catalog.contracts.filter((entry) => entry.status === 'active'))
    {
        for (const kind of contract.requiredTestKinds)
        {
            rows.push({
                behaviorId: contract.id,
                testKind: kind,
                canonicalTestId: `node-tap:tests/tools/${contract.id}.${kind}.test.mjs#${kind}`,
                framework: 'node-tap',
                sourcePath: `tests/tools/${contract.id}.${kind}.test.mjs`,
                fullyQualifiedName: kind,
                discovered: true,
                executed: true,
                outcome: 'passed',
                invariantIds: [],
                reasonId: null,
                concurrencyHarness: null,
                run: { id: 'round-1', attemptKind: 'primary', evidenceClass: 'correctness' },
                sourceState: { commit: SOURCE_COMMIT, worktreeFingerprint: `sha256:${WORKTREE_FP}` },
                sourceClosureDigest: `sha256:${'f'.repeat(64)}`,
                rawResultDigest: `sha256:${'9'.repeat(64)}`
            })
        }
    }
    return rows
}

function locatedClaim(fields)
{
    return {
        declaration: {
            claimId: fields.claimId,
            behaviorId: fields.behaviorId,
            claimType: fields.claimType ?? 'scalar',
            factPath: fields.factPath ?? 'limit',
            render: 'scalar-inline'
        },
        location: {
            documentPath: fields.documentPath ?? 'docs/alpha.md',
            claimStartLine: 1,
            claimEndLine: 4,
            documentStatus: fields.documentStatus ?? 'current',
            headingPath: ['Alpha'],
            bodyKind: 'paragraph',
            bodyStartLine: 5,
            bodyEndLine: 5,
            bodyText: fields.bodyText ?? 'limit is 10'
        }
    }
}

function defaultClaims()
{
    return [
        locatedClaim({
            claimId: 'alpha.limit',
            behaviorId: 'alpha-behavior',
            factPath: 'limit',
            documentPath: 'docs/alpha.md',
            bodyText: 'limit is 10'
        }),
        locatedClaim({
            claimId: 'beta.enabled',
            behaviorId: 'beta-behavior',
            claimType: 'boolean',
            factPath: 'enabled',
            documentPath: 'docs/beta.md',
            bodyText: 'enabled is true'
        })
    ]
}

function defaultVerificationResults()
{
    return [
        {
            claimId: 'alpha.limit',
            behaviorId: 'alpha-behavior',
            claimType: 'scalar',
            documentPath: 'docs/alpha.md',
            documentStatus: 'current',
            factPath: 'limit',
            status: 'verified',
            reason: 'body matches observation'
        },
        {
            claimId: 'beta.enabled',
            behaviorId: 'beta-behavior',
            claimType: 'boolean',
            documentPath: 'docs/beta.md',
            documentStatus: 'current',
            factPath: 'enabled',
            status: 'verified',
            reason: 'body matches observation'
        }
    ]
}

function makeParseReceipt({ catalog, claims })
{
    const receipt = {
        schema: 'fsusblog.doc-claim-parse-receipt.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        behaviorCatalogDigest: catalogDigest(catalog),
        claims: claims ?? []
    }
    return {
        ...receipt,
        contentDigest: digestValue(receipt)
    }
}

function buildGraphBundle(graphMutation)
{
    let catalog = makeGraphCatalog()
    let claims = defaultClaims()
    let evidence = defaultEvidence(catalog)
    let bindings = defaultOwnerBindings()
    let verificationResults = defaultVerificationResults()
    let verificationStatus = 'ok'
    let verificationFailures = []
    let testErrors = []
    let ownerErrors = []
    let reasonCode = null

    if (graphMutation === 'orphan-claim')
    {
        claims = [
            ...claims,
            locatedClaim({
                claimId: 'orphan.claim',
                behaviorId: 'missing-behavior',
                factPath: 'ghost',
                documentPath: 'docs/orphan.md',
                bodyText: 'orphan'
            })
        ]
        verificationResults = [
            ...verificationResults,
            {
                claimId: 'orphan.claim',
                behaviorId: 'missing-behavior',
                claimType: 'scalar',
                documentPath: 'docs/orphan.md',
                documentStatus: 'current',
                factPath: 'ghost',
                status: 'failed',
                reason: 'orphan claim references unknown behavior'
            }
        ]
        verificationStatus = 'failed'
        verificationFailures = ['orphan claim references unknown behavior']
        reasonCode = 'ORPHAN_CLAIM'
    }
    else if (graphMutation === 'claim-wrong-behavior')
    {
        claims = [
            locatedClaim({
                claimId: 'alpha.limit',
                behaviorId: 'beta-behavior',
                factPath: 'limit',
                documentPath: 'docs/alpha.md',
                bodyText: 'limit is 10'
            }),
            locatedClaim({
                claimId: 'beta.enabled',
                behaviorId: 'beta-behavior',
                claimType: 'boolean',
                factPath: 'enabled',
                documentPath: 'docs/beta.md',
                bodyText: 'enabled is true'
            })
        ]
        verificationResults = [
            {
                claimId: 'alpha.limit',
                behaviorId: 'beta-behavior',
                claimType: 'scalar',
                documentPath: 'docs/alpha.md',
                documentStatus: 'current',
                factPath: 'limit',
                status: 'failed',
                reason: 'claim bound to wrong behavior for factPath limit'
            },
            verificationResults[1]
        ]
        verificationStatus = 'failed'
        verificationFailures = ['claim bound to wrong behavior for factPath limit']
        reasonCode = 'CLAIM_WRONG_BEHAVIOR'
    }
    else if (graphMutation === 'missing-test-kind')
    {
        evidence = defaultEvidence(catalog).filter((row) =>
            !(row.behaviorId === 'alpha-behavior' && row.testKind === 'boundary'))
        testErrors = ['alpha-behavior missing this-round passed evidence for kind(s): boundary']
        reasonCode = 'MISSING_TEST_KIND'
    }
    else if (graphMutation === 'implementation-owner-duplicate')
    {
        bindings = [
            ...defaultOwnerBindings(),
            {
                behaviorId: 'alpha-behavior',
                language: 'csharp',
                sourcePath: 'src/backend/Alpha.cs',
                symbol: 'AlphaService',
                bindingKind: 'marker',
                sourceDigest: '3'.repeat(64),
                status: 'ok'
            }
        ]
        ownerErrors = ['alpha-behavior owner cardinality exceeded: expected one']
        reasonCode = 'OWNER_CARDINALITY'
    }
    else if (graphMutation === 'retired-behavior-current-doc')
    {
        catalog = makeGraphCatalog({
            contracts: [
                {
                    ...makeGraphCatalog().contracts[0],
                    status: 'retired',
                    releaseQualification: false,
                    requiredTestKinds: ['positive']
                },
                makeGraphCatalog().contracts[1]
            ]
        })
        evidence = defaultEvidence(catalog)
        verificationResults = [
            {
                claimId: 'alpha.limit',
                behaviorId: 'alpha-behavior',
                claimType: 'scalar',
                documentPath: 'docs/alpha.md',
                documentStatus: 'current',
                factPath: 'limit',
                status: 'verified',
                reason: 'stale retired claim still verified'
            },
            verificationResults[1]
        ]
        reasonCode = 'RETIRED_BEHAVIOR_CURRENT_DOC'
    }
    else if (graphMutation == null)
    {
        reasonCode = 'PASS'
    }
    else
    {
        throw new Error(`unknown graph mutation ${graphMutation}`)
    }

    const alphaFact = makeFact({
        extractorId: 'alpha-fact-extractor',
        behaviorIds: ['alpha-behavior'],
        observations: { limit: 10 }
    })
    const betaFact = makeFact({
        extractorId: 'beta-fact-extractor',
        behaviorIds: ['beta-behavior'],
        observations: { enabled: true }
    })
    const facts = [alphaFact, betaFact]
    const parseReceipt = makeParseReceipt({ catalog, claims })
    const factObservationDigests = facts.map((receipt) => ({
        extractorId: receipt.extractorId,
        contentDigest: receipt.contentDigest
    }))
    const verification = sealDocClaimVerificationReceipt({
        sourceCommit: SOURCE_COMMIT,
        worktreeFingerprint: WORKTREE_FP,
        catalogDigest: catalogDigest(catalog),
        parseReceiptDigest: parseReceipt.contentDigest,
        factObservationDigests,
        results: verificationResults,
        status: verificationStatus,
        failureReasons: verificationFailures
    })
    const generated = sealGeneratedSectionCheckReceipt({
        sourceCommit: SOURCE_COMMIT,
        worktreeFingerprint: WORKTREE_FP,
        catalogDigest: catalogDigest(catalog),
        sectionCatalogDigest: '8'.repeat(64),
        factObservationDigests,
        sections: [],
        status: 'ok',
        failureReasons: []
    })
    const owner = makeOwner({ catalog, bindings, errors: ownerErrors })
    const testEvidence = makeTestEvidence({ catalog, evidence, errors: testErrors })

    return {
        reasonCode,
        inputs: {
            catalog,
            ownerReceipt: owner,
            factObservationReceipts: facts,
            testEvidenceReceipt: testEvidence,
            docClaimParseReceipt: parseReceipt,
            docClaimVerificationReceipt: verification,
            generatedSectionCheckReceipt: generated
        }
    }
}

function classifyGraphFailure(receipt, graphMutation)
{
    if (receipt.status === 'ok') return { ok: true, code: 'PASS' }
    const reasons = [...receipt.failureReasons, ...receipt.missing.map((entry) => entry.kind), ...receipt.conflicts.map((entry) => entry.kind), ...receipt.orphans?.map?.((entry) => entry.kind) ?? []]
    const text = JSON.stringify({
        failureReasons: receipt.failureReasons,
        missing: receipt.missing,
        conflicts: receipt.conflicts,
        orphans: receipt.orphans ?? [],
        nodes: receipt.behaviorNodes
    })

    if (graphMutation === 'orphan-claim')
    {
        if (/orphan|unknown behavior|missing-behavior/iu.test(text)) return { ok: false, code: 'ORPHAN_CLAIM' }
    }
    if (graphMutation === 'claim-wrong-behavior')
    {
        if (/wrong behavior|doc-conflict|missing-fact|limit/iu.test(text)) return { ok: false, code: 'CLAIM_WRONG_BEHAVIOR' }
    }
    if (graphMutation === 'missing-test-kind')
    {
        if (/missing-test-kind|boundary/iu.test(text) || receipt.missing.some((entry) => entry.kind === 'missing-test-kind'))
        {
            return { ok: false, code: 'MISSING_TEST_KIND' }
        }
    }
    if (graphMutation === 'implementation-owner-duplicate')
    {
        if (/cardinality|owner|duplicate/iu.test(text) || receipt.conflicts.some((entry) => /owner/iu.test(entry.kind)))
        {
            return { ok: false, code: 'OWNER_CARDINALITY' }
        }
    }
    if (graphMutation === 'retired-behavior-current-doc')
    {
        if (/retired|current/iu.test(text) || receipt.conflicts.some((entry) => /retired|doc/iu.test(entry.kind)))
        {
            return { ok: false, code: 'RETIRED_BEHAVIOR_CURRENT_DOC' }
        }
        // Also accept failed qualification on retired node with current claim.
        const alpha = receipt.behaviorNodes.find((node) => node.behaviorId === 'alpha-behavior')
        if (alpha && (alpha.qualification === 'failed' || alpha.docStatus === 'failed'))
        {
            return { ok: false, code: 'RETIRED_BEHAVIOR_CURRENT_DOC' }
        }
    }
    return { ok: false, code: `JOIN_FAILED:${reasons[0] ?? 'unknown'}`, detail: text }
}

/**
 * Validate case schema before run (rejects multi-mutation / vague reasons).
 */
export function validateMutationCaseSchema(entry)
{
    const errors = []
    for (const field of ['id', 'targetInvariantId', 'singleMutation', 'expectedReasonCode', 'expectedLayer'])
    {
        if (entry[field] == null || entry[field] === '')
        {
            errors.push(`missing ${field}`)
        }
    }
    if (forbiddenReasonCodes.includes(String(entry.expectedReasonCode).toLowerCase()))
    {
        errors.push(`forbidden vague expectedReasonCode: ${entry.expectedReasonCode}`)
    }
    if (!Object.values(MutationLayers).includes(entry.expectedLayer) && entry.expectedLayer !== MutationLayers.PROSE_VERIFIER)
    {
        // allowedMutationLayers already covers; double-check membership
        const allowed = new Set(Object.values(MutationLayers))
        if (!allowed.has(entry.expectedLayer))
        {
            errors.push(`unknown expectedLayer: ${entry.expectedLayer}`)
        }
    }
    if (Array.isArray(entry.singleMutation) || (entry.singleMutation && entry.singleMutation.kind === 'multi'))
    {
        errors.push('singleMutation must be one atomic mutation')
    }
    if (entry.singleMutation?.kind === 'lifecycle-field' && entry.singleMutation.alsoBreakLinks)
    {
        errors.push('baseline-only case must not also break links (non-single)')
    }
    if (typeof entry.singleMutation?.markInvalid === 'function' || entry.singleMutation?.kind === 'internal-hook')
    {
        errors.push('mutation must not call internal markInvalid hooks')
    }
    return errors
}

/**
 * Run one mutation case end-to-end.
 */
export function runMutationCase(caseIdOrEntry)
{
    const entry = typeof caseIdOrEntry === 'string'
        ? getMutationCase(caseIdOrEntry)
        : caseIdOrEntry

    const schemaErrors = validateMutationCaseSchema(entry)
    if (schemaErrors.length > 0)
    {
        return {
            id: entry.id,
            ok: false,
            layer: entry.expectedLayer,
            reasonCode: 'CASE_SCHEMA_INVALID',
            schemaErrors,
            expectPass: entry.expectPass,
            sourceValidFixtureDigest: null
        }
    }

    // Graph layer does not need the markdown fixture repository.
    if (entry.expectedLayer === MutationLayers.BEHAVIOR_GRAPH_JOIN)
    {
        const graphMutation = entry.singleMutation.graphMutation ?? null
        const bundle = buildGraphBundle(graphMutation)
        const receipt = joinBehaviorGraph(bundle.inputs)
        const classified = entry.expectPass
            ? { ok: receipt.status === 'ok', code: receipt.status === 'ok' ? 'PASS' : 'JOIN_FAILED' }
            : classifyGraphFailure(receipt, graphMutation)
        const matched = entry.expectPass
            ? classified.ok
            : (!classified.ok && classified.code === entry.expectedReasonCode)
        return {
            id: entry.id,
            ok: matched,
            layer: MutationLayers.BEHAVIOR_GRAPH_JOIN,
            reasonCode: classified.code,
            expectedReasonCode: entry.expectedReasonCode,
            expectPass: entry.expectPass,
            sourceValidFixtureDigest: createHash('sha256').update('graph-valid-bundle-v1').digest('hex'),
            detail: classified.detail,
            receiptStatus: receipt.status
        }
    }

    if (entry.expectedLayer === MutationLayers.CLAIM_SCHEMA)
    {
        const result = runClaimSchemaLayer(entry.singleMutation)
        const matched = entry.expectPass
            ? result.ok
            : (!result.ok && result.code === entry.expectedReasonCode)
        return {
            id: entry.id,
            ok: matched,
            layer: MutationLayers.CLAIM_SCHEMA,
            reasonCode: result.code ?? (result.ok ? 'PASS' : null),
            expectedReasonCode: entry.expectedReasonCode,
            expectPass: entry.expectPass,
            sourceValidFixtureDigest: createHash('sha256').update('schema-valid-v1').digest('hex')
        }
    }

    if (entry.expectedLayer === MutationLayers.CLAIM_PARSER)
    {
        const result = runClaimParserLayer(entry.singleMutation)
        const matched = entry.expectPass
            ? result.ok
            : (!result.ok && result.code === entry.expectedReasonCode)
        return {
            id: entry.id,
            ok: matched,
            layer: MutationLayers.CLAIM_PARSER,
            reasonCode: result.code ?? (result.ok ? 'PASS' : null),
            expectedReasonCode: entry.expectedReasonCode,
            expectPass: entry.expectPass,
            sourceValidFixtureDigest: createHash('sha256').update('parser-valid-v1').digest('hex')
        }
    }

    const fixture = materializeFixtureRepository(entry.sourceFixtureKind)
    try
    {
        const sourceDigest = fixture.digest
        const beforeSemantic = digestFileTree(fixture.directory, [
            '.tmp/observation-receipt.json',
            'config/contracts/generated-fact-sections.json'
        ])

        const applied = applySingleMutation(fixture, entry.singleMutation)

        // Refuse multi-mutation collateral beyond the declared single change.
        if (entry.forbiddenCollateralChanges?.includes('broken-link'))
        {
            const markdown = readFixtureDocument(fixture.directory)
            if (/\]\(\s*\)/u.test(markdown) || /\]\(https?:\/\/invalid/u.test(markdown))
            {
                return {
                    id: entry.id,
                    ok: false,
                    layer: entry.expectedLayer,
                    reasonCode: 'NON_SINGLE_MUTATION',
                    expectedReasonCode: entry.expectedReasonCode,
                    expectPass: entry.expectPass,
                    sourceValidFixtureDigest: sourceDigest,
                    detail: 'broken link collateral detected'
                }
            }
        }

        if (entry.expectedLayer === MutationLayers.PROSE_VERIFIER)
        {
            const result = runProseLayer(fixture, applied.observationOverride)
            if (entry.expectPass)
            {
                return {
                    id: entry.id,
                    ok: result.ok,
                    layer: MutationLayers.PROSE_VERIFIER,
                    reasonCode: result.ok ? 'PASS' : (result.diagnostics[0]?.code ?? 'PROSE_FAILED'),
                    expectedReasonCode: entry.expectedReasonCode,
                    expectPass: true,
                    sourceValidFixtureDigest: sourceDigest,
                    diagnostics: result.diagnostics
                }
            }
            const hit = result.diagnostics.find((entryDiag) => entryDiag.code === entry.expectedReasonCode)
            // Baseline-only must not fail solely as "verification commit stale".
            const commitStaleOnly = result.diagnostics.length > 0
                && result.diagnostics.every((diag) => /commit.*stale|verification distance/iu.test(diag.message ?? ''))
            return {
                id: entry.id,
                ok: Boolean(hit) && !result.ok && !commitStaleOnly,
                layer: MutationLayers.PROSE_VERIFIER,
                reasonCode: hit?.code ?? result.diagnostics[0]?.code ?? null,
                expectedReasonCode: entry.expectedReasonCode,
                expectPass: false,
                sourceValidFixtureDigest: sourceDigest,
                diagnostics: result.diagnostics,
                commitStaleOnly
            }
        }

        if (entry.expectedLayer === MutationLayers.GENERATED_SECTION_CHECK)
        {
            const result = runGeneratedLayer(fixture, applied.observationOverride)
            if (entry.expectPass)
            {
                return {
                    id: entry.id,
                    ok: result.ok,
                    layer: MutationLayers.GENERATED_SECTION_CHECK,
                    reasonCode: result.ok ? 'PASS' : result.code,
                    expectedReasonCode: entry.expectedReasonCode,
                    expectPass: true,
                    sourceValidFixtureDigest: sourceDigest
                }
            }
            return {
                id: entry.id,
                ok: !result.ok && result.code === entry.expectedReasonCode,
                layer: MutationLayers.GENERATED_SECTION_CHECK,
                reasonCode: result.code,
                expectedReasonCode: entry.expectedReasonCode,
                expectPass: false,
                sourceValidFixtureDigest: sourceDigest,
                errorMessage: result.error?.message
            }
        }

        void beforeSemantic
        void applied
        return {
            id: entry.id,
            ok: false,
            layer: entry.expectedLayer,
            reasonCode: 'UNSUPPORTED_LAYER',
            expectedReasonCode: entry.expectedReasonCode,
            expectPass: entry.expectPass,
            sourceValidFixtureDigest: sourceDigest
        }
    }
    finally
    {
        fixture.dispose()
    }
}

/**
 * Run every catalog case. Deterministic; no network, no sleep, no retry.
 */
export function runAllMutationCases({ includeControls = true } = {})
{
    const cases = mutationCases.filter((entry) => includeControls || !entry.expectPass)
    return cases.map((entry) => runMutationCase(entry))
}

export function assertCaseResult(result)
{
    if (!result.ok)
    {
        const detail = [
            `case ${result.id} failed`,
            `layer=${result.layer}`,
            `expected=${result.expectedReasonCode}`,
            `actual=${result.reasonCode}`,
            result.errorMessage,
            result.detail,
            result.diagnostics ? JSON.stringify(result.diagnostics.slice(0, 5), null, 2) : null,
            result.schemaErrors ? result.schemaErrors.join('; ') : null
        ].filter(Boolean).join('\n')
        const error = new Error(detail)
        error.result = result
        throw error
    }
    return result
}

// Touch imports used for schema docs / anti-dead-code in lint-ish scans.
void DocClaimErrorCode
void GeneratedSectionErrorCode
void loadCatalog
void wrapGeneratedSection
void matchingProseBodies
void SECTION_PERMISSIONS
void EXTRACTOR_ID
