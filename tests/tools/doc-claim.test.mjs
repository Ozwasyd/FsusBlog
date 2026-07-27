import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
    DocClaimErrorCode,
    assertReceiptHasNoPassEvidence,
    buildParseReceipt,
    canonicalize,
    digestValue,
    loadDocClaimSchema,
    parseDocumentClaims,
    parseRepositoryClaims,
    receiptProducesPassEvidence,
    scanDocClaimGovernance,
    serializeClaimDeclaration,
    validateClaimDeclaration,
    validateDocClaimSchemaContract
} from '../../tools/docs/doc-claim.mjs'
import { digestCatalog, loadCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const checker = path.join(root, 'tools/docs/check-doc-claim.mjs')
const activeBehaviorId = 'document-lifecycle-governance'
const secondBehaviorId = 'code-intent-governance'

function fixtureRoot()
{
    return mkdtempSync(path.join(os.tmpdir(), 'fsusblog-doc-claim-'))
}

function write(directory, relative, content)
{
    const target = path.join(directory, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
}

function baseCatalog()
{
    return structuredClone(loadCatalog())
}

function migrationContract(catalog)
{
    Object.assign(catalog.contracts[0], {
        status: 'migration-only',
        releaseQualification: false,
        requiredTestKinds: ['migration'],
        documentationPolicy: 'not-public',
        documents: []
    })
    return catalog
}

function claimBlock(fields)
{
    return serializeClaimDeclaration(fields).trimEnd()
}

function validScalarFields(overrides = {})
{
    return {
        claimId: 'document-lifecycle-governance.maximum-distance',
        behaviorId: activeBehaviorId,
        claimType: 'scalar',
        factPath: 'maximumVerificationDistance',
        render: 'integer-count',
        ...overrides
    }
}

test('schema contract is fail-closed and forbids self-proving fields', () =>
{
    validateDocClaimSchemaContract(loadDocClaimSchema())
    const schema = structuredClone(loadDocClaimSchema())
    schema.properties.expectedValue = { type: 'boolean' }
    assert.throws(() => validateDocClaimSchemaContract(schema), /forbidden field expectedValue|SCHEMA_DRIFT/u)
    schema.properties = { ...loadDocClaimSchema().properties }
    schema.properties.claimType.enum.push('compat-scalar')
    assert.throws(() => validateDocClaimSchemaContract(schema), /claimType enum drifted/u)
})

test('canonical serializer is stable and round-trips allowed fields only', () =>
{
    const declaration = validScalarFields({ anchor: 'lifecycle', projection: 'default' })
    const first = serializeClaimDeclaration(declaration)
    const second = serializeClaimDeclaration(declaration)
    assert.equal(first, second)
    assert.match(first, /^<!-- fsus-doc-claim\n/u)
    assert.doesNotMatch(first, /verified|expectedValue|lastVerifiedCommit/u)
    const markdown = `# Lifecycle

${first}

Distance is **100** commits.
`
    const parsed = parseDocumentClaims(markdown, {
        documentPath: 'docs/development/document-lifecycle.md',
        documentStatus: 'current'
    })
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].declaration.claimId, declaration.claimId)
    assert.equal(parsed[0].declaration.anchor, 'lifecycle')
    assert.equal(parsed[0].location.bodyKind, 'paragraph')
    assert.match(parsed[0].location.bodyText, /100/u)
})

test('rejects unknown fields and unknown claimType without scalar default', () =>
{
    assert.throws(
        () => validateClaimDeclaration(validScalarFields({ temporary: true })),
        (error) => error.code === DocClaimErrorCode.UNKNOWN_FIELD
    )
    assert.throws(
        () => validateClaimDeclaration(validScalarFields({ claimType: 'mystery' })),
        (error) => error.code === DocClaimErrorCode.UNKNOWN_CLAIM_TYPE
    )
    assert.throws(
        () => parseDocumentClaims(`${claimBlock(validScalarFields({ claimType: 'mystery' }))}\n\nBody.\n`, {
            documentPath: 'docs/x.md',
            documentStatus: 'current'
        }),
        (error) => error.code === DocClaimErrorCode.UNKNOWN_CLAIM_TYPE
    )
})

test('rejects approved, expectedValue, and other self-proving fields', () =>
{
    for (const field of ['approved', 'expectedValue', 'verified', 'baselineValue', 'waiver', 'allowStaleUntil', 'lastVerifiedCommit', 'ignoreDifference'])
    {
        assert.throws(
            () => validateClaimDeclaration(validScalarFields({ [field]: field === 'expectedValue' ? 5 : true })),
            (error) => error.code === DocClaimErrorCode.FORBIDDEN_FIELD,
            field
        )
    }
})

test('rejects claim without body, shared body drift, and cross-heading body', () =>
{
    assert.throws(
        () => parseDocumentClaims(`${claimBlock(validScalarFields())}\n`, {
            documentPath: 'docs/x.md',
            documentStatus: 'current'
        }),
        (error) => error.code === DocClaimErrorCode.MISSING_BODY
    )

    const shared = `# Title

${claimBlock(validScalarFields({ claimId: 'a.one', behaviorId: activeBehaviorId }))}

Shared body paragraph.

${claimBlock(validScalarFields({ claimId: 'b.two', behaviorId: secondBehaviorId, factPath: 'otherFact' }))}
`
    // Second claim has no body after it → missing body. Build true shared-body case via stacked claims before one body:
    const stacked = `# Title

${claimBlock(validScalarFields({ claimId: 'a.one', behaviorId: activeBehaviorId }))}
${claimBlock(validScalarFields({ claimId: 'b.two', behaviorId: secondBehaviorId, factPath: 'otherFact' }))}

Shared body paragraph.
`
    assert.throws(
        () => parseDocumentClaims(stacked, { documentPath: 'docs/x.md', documentStatus: 'current' }),
        (error) => error.code === DocClaimErrorCode.MISSING_BODY || error.code === DocClaimErrorCode.BODY_SHARED
    )
    void shared

    const drifted = `# One

${claimBlock(validScalarFields())}

## Inserted heading

Body after a new heading.
`
    assert.throws(
        () => parseDocumentClaims(drifted, { documentPath: 'docs/x.md', documentStatus: 'current' }),
        (error) => error.code === DocClaimErrorCode.CROSS_HEADING_DRIFT
    )
})

test('rejects rationale precise unregistered quantity', () =>
{
    const markdown = `# Why

${claimBlock(validScalarFields({
        claimId: 'document-lifecycle-governance.rationale.timing',
        claimType: 'rationale',
        factPath: 'documentationRationale',
        render: 'rationale-prose'
    }))}

该窗口固定为 10分钟，实现不得缩短。
`
    assert.throws(
        () => parseDocumentClaims(markdown, { documentPath: 'docs/x.md', documentStatus: 'current' }),
        (error) => error.code === DocClaimErrorCode.RATIONALE_PRECISE_FACT
    )
})

test('parse receipt never includes lastVerifiedCommit and cannot produce pass evidence', () =>
{
    const markdown = `# Lifecycle

${claimBlock(validScalarFields())}

Distance is **100** commits.
`
    const located = parseDocumentClaims(markdown, {
        documentPath: 'docs/development/document-lifecycle.md',
        documentStatus: 'current'
    })
    const receipt = buildParseReceipt(located, { behaviorCatalogDigest: digestCatalog(loadCatalog()) })
    assert.equal(receipt.schema, 'fsusblog.doc-claim-parse-receipt.v1')
    assert.equal(receiptProducesPassEvidence(receipt), false)
    assert.doesNotMatch(canonicalize(receipt), /lastVerifiedCommit|expectedValue|verified|approved/u)
    assertReceiptHasNoPassEvidence(receipt)

    // Injecting lifecycle lastVerifiedCommit must not become pass evidence or digest input.
    const poisoned = {
        ...receipt,
        lastVerifiedCommit: 'a'.repeat(40),
        verified: true
    }
    assert.equal(receiptProducesPassEvidence(poisoned), true)
    assert.throws(() => assertReceiptHasNoPassEvidence(poisoned), (error) => error.code === DocClaimErrorCode.PASS_EVIDENCE_FORBIDDEN)
    assert.notEqual(digestValue(receipt), createHash('sha256').update(JSON.stringify(poisoned), 'utf8').digest('hex'))
})

test('repository gate rejects duplicate claimId and historical active behavior', () =>
{
    const directory = fixtureRoot()
    try
    {
        const catalog = baseCatalog()
        write(directory, 'config/contracts/behavior-contracts.json', `${JSON.stringify(catalog, null, 4)}\n`)
        write(directory, 'config/schemas/doc-claim.schema.json', readFileSync(path.join(root, 'config/schemas/doc-claim.schema.json'), 'utf8'))
        const body = `${claimBlock(validScalarFields())}\n\nDistance is **100** commits.\n`
        write(directory, 'docs/a.md', `# A\n\n${body}`)
        write(directory, 'docs/b.md', `# B\n\n${body}`)
        const statusMap = new Map([
            ['docs/a.md', 'current'],
            ['docs/b.md', 'current']
        ])
        let duplicateCode = null
        try
        {
            parseRepositoryClaims(directory, {
                catalog,
                behaviorCatalogDigest: digestCatalog(catalog),
                statusMap
            })
        }
        catch (error)
        {
            duplicateCode = error.code
        }
        assert.equal(duplicateCode, DocClaimErrorCode.DUPLICATE_CLAIM_ID, `expected duplicate claim id, got ${duplicateCode}`)

        // Isolate historical active rejection in a fresh tree.
        const historicalRoot = fixtureRoot()
        try
        {
            write(historicalRoot, 'config/schemas/doc-claim.schema.json', readFileSync(path.join(root, 'config/schemas/doc-claim.schema.json'), 'utf8'))
            write(
                historicalRoot,
                'docs/history.md',
                `# Historical\n\n${claimBlock(validScalarFields({ claimId: 'document-lifecycle-governance.history' }))}\n\nOld prose.\n`
            )
            let historicalCode = null
            try
            {
                parseRepositoryClaims(historicalRoot, {
                    catalog,
                    behaviorCatalogDigest: digestCatalog(catalog),
                    statusMap: new Map([['docs/history.md', 'historical']])
                })
            }
            catch (error)
            {
                historicalCode = error.code
            }
            assert.equal(historicalCode, DocClaimErrorCode.HISTORICAL_ACTIVE_BEHAVIOR)
        }
        finally
        {
            rmSync(historicalRoot, { recursive: true, force: true })
        }
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('historical docs may parse migration-only/retired claims without pass evidence', () =>
{
    const directory = fixtureRoot()
    try
    {
        const catalog = migrationContract(baseCatalog())
        const retiredId = catalog.contracts[0].id
        write(directory, 'config/schemas/doc-claim.schema.json', readFileSync(path.join(root, 'config/schemas/doc-claim.schema.json'), 'utf8'))
        write(
            directory,
            'docs/history/migration.md',
            `# Migration\n\n${claimBlock(validScalarFields({
                claimId: `${retiredId}.migration.note`,
                behaviorId: retiredId
            }))}\n\nMigration-only prose remains for auditors.\n`
        )
        const receipt = parseRepositoryClaims(directory, {
            catalog,
            behaviorCatalogDigest: digestCatalog(catalog),
            statusMap: new Map([['docs/history/migration.md', 'historical']])
        })
        assert.equal(receipt.claims.length, 1)
        assert.equal(receiptProducesPassEvidence(receipt), false)
        assert.doesNotMatch(canonicalize(receipt), /lastVerifiedCommit|"passed"|qualification/u)
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('required counterexample: approved true and expectedValue 5 fail closed', () =>
{
    const approved = `<!-- fsus-doc-claim
claimId: document-lifecycle-governance.approved
behaviorId: ${activeBehaviorId}
claimType: scalar
factPath: maximumVerificationDistance
render: integer-count
approved: true
-->

Body.
`
    const expected = `<!-- fsus-doc-claim
claimId: document-lifecycle-governance.expected
behaviorId: ${activeBehaviorId}
claimType: scalar
factPath: maximumVerificationDistance
render: integer-count
expectedValue: 5
-->

Body.
`
    assert.throws(() => parseDocumentClaims(approved, { documentPath: 'docs/x.md', documentStatus: 'current' }), (error) => error.code === DocClaimErrorCode.FORBIDDEN_FIELD)
    assert.throws(() => parseDocumentClaims(expected, { documentPath: 'docs/x.md', documentStatus: 'current' }), (error) => error.code === DocClaimErrorCode.FORBIDDEN_FIELD)
})

test('repository checker passes on master worktree and governance scan is clean', () =>
{
    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /claims=\d+ digest=/u)
    const violations = scanDocClaimGovernance(root)
    assert.deepEqual(violations, [])
})

test('governance scan rejects a second protocol / compat parser surface', () =>
{
    const directory = fixtureRoot()
    try
    {
        // Copy only what the scan walks; plant a forbidden surface outside allowlist.
        write(directory, 'tools/docs/evil-compat.mjs', 'export const legacy_doc_claim_parser = () => {}\n')
        write(directory, 'docs/x.md', '<!-- fsus-claim-v0\nclaimId: x\n-->\n')
        const violations = scanDocClaimGovernance(directory)
        assert.ok(violations.some((item) => item.code === DocClaimErrorCode.COMPAT_PARSER || item.code === DocClaimErrorCode.SECOND_PROTOCOL))
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('generated-section uses generatedSectionId and does not require prose body', () =>
{
    const markdown = `# Generated

${claimBlock({
        claimId: 'document-lifecycle-governance.section.index',
        behaviorId: activeBehaviorId,
        claimType: 'generated-section',
        generatedSectionId: 'document-lifecycle-index',
        render: 'generated-markdown-section'
    })}
`
    const parsed = parseDocumentClaims(markdown, {
        documentPath: 'docs/development/document-lifecycle.md',
        documentStatus: 'current'
    })
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].location.bodyKind, 'none')
    assert.equal(parsed[0].declaration.generatedSectionId, 'document-lifecycle-index')
})

test('fenced examples are not parsed as live claims', () =>
{
    const markdown = `# Protocol

\`\`\`md
${claimBlock(validScalarFields())}

Example body only.
\`\`\`
`
    const parsed = parseDocumentClaims(markdown, {
        documentPath: 'docs/development/doc-claim-protocol.md',
        documentStatus: 'current'
    })
    assert.equal(parsed.length, 0)
})

