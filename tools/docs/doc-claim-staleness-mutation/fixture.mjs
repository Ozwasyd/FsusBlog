/**
 * Process-unique valid fixture repository for docs-governance staleness mutations.
 * Zero pollution of real docs/source/test artifacts.
 */

import { createHash } from 'node:crypto'
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildReceipt, sealReceipt } from '../../fact-extractors/receipt.mjs'
import { sealSourceIdentity } from '../../fact-extractors/identity.mjs'
import { serializeClaimDeclaration } from '../doc-claim.mjs'
import {
    wrapGeneratedSection,
    formatBeginMarker,
    formatEndMarker
} from '../generated-fact-sections/markers.mjs'
import { catalogSchemaId } from '../generated-fact-sections/catalog.mjs'
import { RendererRegistry } from '../generated-fact-sections/renderers.mjs'

export const fixtureRootPrefix = 'fsusblog-doc-claim-staleness-'

export const BEHAVIOR_ID = 'authentication-session-permission'
export const EXTRACTOR_ID = 'auth-session-permission-fact-extractor'
export const DOC_PATH = 'docs/security.md'
export const SECTION_PERMISSIONS = 'auth.permissions.all'
export const SECTION_TRANSITIONS = 'auth.session.transitions'
export const SECTION_MAP = 'auth.policy.map'
export const SECTION_OUTBOX = 'auth.outbox.edges'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const frameworkRelative = Object.freeze([
    'config/schemas/fact-observation-receipt.schema.json',
    'config/schemas/generated-fact-section-catalog.schema.json',
    'config/schemas/doc-claim.schema.json',
    'config/contracts/generated-fact-sections.json',
    'tools/fact-extractors/lib/canonicalize.mjs',
    'tools/fact-extractors/identity.mjs',
    'tools/fact-extractors/receipt.mjs',
    'tools/fact-extractors/reader.mjs',
    'tools/fact-extractors/registry.mjs',
    'tools/docs/generated-fact-sections/markers.mjs',
    'tools/docs/generated-fact-sections/renderers.mjs',
    'tools/docs/generated-fact-sections/catalog.mjs',
    'tools/docs/generated-fact-sections/generator.mjs',
    'tools/docs/generated-fact-sections/governance.mjs',
    'tools/docs/generate-fact-sections.mjs',
    'tools/docs/doc-claim.mjs',
    'tools/docs/check-doc-claim.mjs',
    'tools/docs/check-prose-claims.mjs',
    'tools/docs/prose-claim-verifier/errors.mjs',
    'tools/docs/prose-claim-verifier/phrases.mjs',
    'tools/docs/prose-claim-verifier/renderers.mjs',
    'tools/docs/prose-claim-verifier/parser.mjs',
    'tools/docs/prose-claim-verifier/verifier.mjs',
    'tools/docs/prose-claim-verifier/governance.mjs',
    'tools/contracts/behavior-contract-catalog.mjs',
    'config/contracts/behavior-contracts.json',
    'config/schemas/behavior-contract-catalog.schema.json'
])

function write(directory, relative, content)
{
    const target = path.join(directory, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
    return target
}

function claimBlock(fields)
{
    return serializeClaimDeclaration(fields).trimEnd()
}

/** Canonical current observations for the fixture. */
export function currentObservations()
{
    return {
        stepUpFreshness: {
            default: { value: 10, unit: 'minutes', role: 'default' },
            maximum: { value: 16, unit: 'layers', role: 'maximum', inclusivity: 'inclusive' }
        },
        maxNesting: {
            value: 16,
            unit: 'layers',
            role: 'maximum',
            inclusivity: 'inclusive'
        },
        refreshExtendsStepUp: { extends: false },
        startupPolicy: { policy: 'fail-closed' },
        mfaPolicy: { policy: 'required' },
        passkeyRevocation: {
            subject: 'credential',
            predicate: 'revokes',
            object: 'session'
        },
        passkeyScope: {
            subject: 'passkey_delete',
            scope: 'sessions_bound_to_credential'
        },
        sessionPreserve: {
            preserves: ['session_id', 'device_binding']
        },
        permissions: ['admin.read', 'admin.write'],
        policyMap: {
            stepUp: 'required',
            refresh: 'rotate'
        },
        // Receipt schema admits only scalar set members; transition renderer accepts Action:From->To.
        transitions: [
            'Publish:Draft->Published',
            'Archive:Published->Archived'
        ],
        outboxEdges: [
            'required:ArticleUpdated->ProjectionRebuild',
            'required:CommentCreated->ModerationEnqueue'
        ]
    }
}

export function matchingProseBodies()
{
    return {
        stepUpFreshness: '敏感操作的 step-up proof 默认有效期为 **10 分钟**。',
        maxNesting: '缓存嵌套最大 16 层（含）。',
        refreshExtendsStepUp: 'Refresh 不会延长 step-up proof。',
        startupPolicy: '校验失败时 fail closed，拒绝请求。',
        mfaPolicy: 'MFA proof 是 required，不是 optional。',
        passkeyRevocation: '删除某个 Passkey 时 credential 撤销 session。',
        passkeyScope: '删除 passkey_delete 只撤销 sessions_bound_to_credential。',
        sessionPreserve: '恢复流程 preserves session_id 与 device_binding。'
    }
}

export function staleProseBodies()
{
    return {
        stepUpFreshness: '敏感操作的 step-up proof 默认有效期为 **5 分钟**。',
        maxNesting: '缓存嵌套最大 32 层（不含）。',
        refreshExtendsStepUp: 'Refresh 会延长 step-up proof。',
        startupPolicy: '校验失败时 fail open，失败时继续处理请求。',
        mfaPolicy: 'MFA proof 是 optional，不是 required。',
        passkeyRevocation: '删除时 session 撤销 credential。',
        passkeyScope: '删除 passkey_delete 撤销所有 sessions_bound_to_credential。',
        sessionPreserve: '恢复流程重置 session_id 与 device_binding。'
    }
}

function renderGenerated(renderer, value)
{
    return RendererRegistry.render(renderer, value, {
        orderPolicy: 'ordinal',
        emptyPolicy: 'fail'
    })
}

export function permissionsBody(items)
{
    return renderGenerated('enum-set', items)
}

export function mapBody(map)
{
    return renderGenerated('key-value-table', map)
}

export function transitionBody(rows)
{
    return renderGenerated('transition-table', rows)
}

export function outboxBody(rows)
{
    return renderGenerated('transition-table', rows)
}

export function buildProseMarkdown({ bodies = matchingProseBodies(), stale = false } = {})
{
    const b = bodies
    const claims = [
        {
            fields: {
                claimId: 'fixture.step-up.freshness',
                behaviorId: BEHAVIOR_ID,
                claimType: 'scalar',
                factPath: 'stepUpFreshness',
                render: 'integer-minutes',
                projection: 'default'
            },
            body: b.stepUpFreshness
        },
        {
            fields: {
                claimId: 'fixture.cache.max-nesting',
                behaviorId: BEHAVIOR_ID,
                claimType: 'scalar',
                factPath: 'maxNesting',
                render: 'integer-layers'
            },
            body: b.maxNesting
        },
        {
            fields: {
                claimId: 'fixture.refresh.extends-step-up',
                behaviorId: BEHAVIOR_ID,
                claimType: 'boolean',
                factPath: 'refreshExtendsStepUp',
                render: 'boolean-extends'
            },
            body: b.refreshExtendsStepUp
        },
        {
            fields: {
                claimId: 'fixture.startup.fail-closed',
                behaviorId: BEHAVIOR_ID,
                claimType: 'failure-mode',
                factPath: 'startupPolicy',
                render: 'failure-policy'
            },
            body: b.startupPolicy
        },
        {
            fields: {
                claimId: 'fixture.mfa.required',
                behaviorId: BEHAVIOR_ID,
                claimType: 'failure-mode',
                factPath: 'mfaPolicy',
                render: 'failure-policy'
            },
            body: b.mfaPolicy
        },
        {
            fields: {
                claimId: 'fixture.passkey.revokes',
                behaviorId: BEHAVIOR_ID,
                claimType: 'binary-relation',
                factPath: 'passkeyRevocation',
                render: 'relation-subject-predicate-object'
            },
            body: b.passkeyRevocation
        },
        {
            fields: {
                claimId: 'fixture.passkey.scope',
                behaviorId: BEHAVIOR_ID,
                claimType: 'preservation-rule',
                factPath: 'passkeyScope',
                render: 'revokes-only-scope'
            },
            body: b.passkeyScope
        },
        {
            fields: {
                claimId: 'fixture.session.preserve',
                behaviorId: BEHAVIOR_ID,
                claimType: 'preservation-rule',
                factPath: 'sessionPreserve',
                render: 'preserves-fields'
            },
            body: b.sessionPreserve
        }
    ]

    const parts = [`# Security fixture${stale ? ' (stale body control)' : ''}`, '']
    for (const entry of claims)
    {
        parts.push(claimBlock(entry.fields), '', entry.body, '')
    }

    const observations = currentObservations()
    parts.push(
        '## Generated permissions',
        '',
        wrapGeneratedSection(SECTION_PERMISSIONS, permissionsBody(observations.permissions)),
        '',
        '## Generated policy map',
        '',
        wrapGeneratedSection(SECTION_MAP, mapBody(observations.policyMap)),
        '',
        '## Generated transitions',
        '',
        wrapGeneratedSection(SECTION_TRANSITIONS, transitionBody(observations.transitions)),
        '',
        '## Generated outbox edges',
        '',
        wrapGeneratedSection(SECTION_OUTBOX, outboxBody(observations.outboxEdges)),
        ''
    )
    return parts.join('\n')
}

export function sampleSectionCatalog()
{
    return {
        schema: catalogSchemaId,
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        sections: [
            {
                sectionId: SECTION_PERMISSIONS,
                documentPath: DOC_PATH,
                renderer: 'enum-set',
                extractorId: EXTRACTOR_ID,
                behaviorId: BEHAVIOR_ID,
                factPath: 'permissions',
                orderPolicy: 'ordinal',
                emptyPolicy: 'fail'
            },
            {
                sectionId: SECTION_MAP,
                documentPath: DOC_PATH,
                renderer: 'key-value-table',
                extractorId: EXTRACTOR_ID,
                behaviorId: BEHAVIOR_ID,
                factPath: 'policyMap',
                orderPolicy: 'ordinal',
                emptyPolicy: 'fail'
            },
            {
                sectionId: SECTION_TRANSITIONS,
                documentPath: DOC_PATH,
                renderer: 'transition-table',
                extractorId: EXTRACTOR_ID,
                behaviorId: BEHAVIOR_ID,
                factPath: 'transitions',
                orderPolicy: 'ordinal',
                emptyPolicy: 'fail'
            },
            {
                sectionId: SECTION_OUTBOX,
                documentPath: DOC_PATH,
                renderer: 'transition-table',
                extractorId: EXTRACTOR_ID,
                behaviorId: BEHAVIOR_ID,
                factPath: 'outboxEdges',
                orderPolicy: 'ordinal',
                emptyPolicy: 'fail'
            }
        ]
    }
}

export function validLifecycle()
{
    return {
        schema: 'fsusblog.document-lifecycle-policy.v3',
        documents: [
            {
                path: DOC_PATH,
                status: 'current',
                owner: 'security',
                relatedIssues: [1750],
                supersedes: [],
                supersededBy: null
            }
        ]
    }
}

function copyFramework(directory)
{
    for (const relative of frameworkRelative)
    {
        const source = path.join(root, relative)
        if (!existsSync(source)) continue
        const target = path.join(directory, relative)
        mkdirSync(path.dirname(target), { recursive: true })
        cpSync(source, target)
    }
}

function initGit(directory)
{
    spawnSync('git', ['init'], { cwd: directory, encoding: 'utf8' })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory, encoding: 'utf8' })
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: directory, encoding: 'utf8' })
    spawnSync('git', ['add', '-A'], { cwd: directory, encoding: 'utf8' })
    spawnSync('git', ['commit', '-m', 'valid-fixture'], { cwd: directory, encoding: 'utf8' })
    return sealSourceIdentity(directory)
}

/**
 * Build a sealed FactObservation receipt for the fixture identity.
 */
export function makeObservationReceipt({
    identity,
    observations = currentObservations(),
    status = 'ok',
    failureReasons = [],
    sourceCommit,
    worktreeFingerprint
} = {})
{
    return sealReceipt(buildReceipt({
        extractorId: EXTRACTOR_ID,
        behaviorIds: [BEHAVIOR_ID],
        sourceCommit: sourceCommit ?? identity.sourceCommit,
        worktreeFingerprint: worktreeFingerprint ?? identity.worktreeFingerprint,
        buildIdentity: null,
        extractorDigest: 'c'.repeat(64),
        registryDigest: 'd'.repeat(64),
        consumedInputDigests: [{ path: 'src/backend/Infrastructure/Auth/AdminPermissions.cs', digest: 'e'.repeat(64) }],
        observations,
        status,
        failureReasons
    }))
}

/**
 * Materialize a complete valid fixture repository in a process-unique temp root.
 * @param {'full-valid'|'stale-body-valid-lifecycle'} kind
 */
export function materializeFixtureRepository(kind = 'full-valid')
{
    const directory = mkdtempSync(path.join(os.tmpdir(), fixtureRootPrefix))
    copyFramework(directory)

    const bodies = kind === 'stale-body-valid-lifecycle'
        ? staleProseBodies()
        : matchingProseBodies()
    const markdown = buildProseMarkdown({
        bodies,
        stale: kind === 'stale-body-valid-lifecycle'
    })

    write(directory, DOC_PATH, markdown)
    write(
        directory,
        'config/contracts/generated-fact-sections.json',
        `${JSON.stringify(sampleSectionCatalog(), null, 2)}\n`
    )
    write(
        directory,
        'config/development/document-lifecycle.json',
        `${JSON.stringify(validLifecycle(), null, 2)}\n`
    )
    write(directory, 'README.md', '# fixture\n')

    const identity = initGit(directory)
    const receipt = makeObservationReceipt({ identity })
    write(directory, '.tmp/observation-receipt.json', `${JSON.stringify(receipt)}\n`)

    const snapshot = {
        kind,
        document: markdown,
        lifecycle: validLifecycle(),
        catalog: sampleSectionCatalog(),
        observations: currentObservations(),
        identity
    }
    const digest = createHash('sha256')
        .update(JSON.stringify({
            kind: snapshot.kind,
            document: snapshot.document,
            lifecycle: snapshot.lifecycle,
            catalog: snapshot.catalog,
            observations: snapshot.observations
        }), 'utf8')
        .digest('hex')

    return {
        directory,
        kind,
        identity,
        receipt,
        digest,
        documentPath: DOC_PATH,
        dispose()
        {
            rmSync(directory, { recursive: true, force: true })
        }
    }
}

export function readFixtureDocument(directory)
{
    return readFileSync(path.join(directory, DOC_PATH), 'utf8')
}

export function writeFixtureDocument(directory, content)
{
    write(directory, DOC_PATH, content)
}

export function readLifecycle(directory)
{
    return JSON.parse(readFileSync(path.join(directory, 'config/development/document-lifecycle.json'), 'utf8'))
}

export function writeLifecycle(directory, lifecycle)
{
    write(directory, 'config/development/document-lifecycle.json', `${JSON.stringify(lifecycle, null, 2)}\n`)
}

export function replaceGeneratedInterior(source, sectionId, body)
{
    const begin = formatBeginMarker(sectionId)
    const end = formatEndMarker(sectionId)
    const beginIndex = source.indexOf(begin)
    const endIndex = source.indexOf(end)
    if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex)
    {
        throw new Error(`section ${sectionId} markers missing for mutation`)
    }
    const before = source.slice(0, beginIndex + begin.length)
    const after = source.slice(endIndex)
    const interior = body.length === 0 ? '\n' : `\n${body.replace(/\n+$/u, '')}\n`
    return `${before}${interior}${after}`
}

export function digestFileTree(directory, relatives)
{
    const parts = relatives.map((relative) =>
    {
        const absolute = path.join(directory, relative)
        if (!existsSync(absolute)) return { relative, digest: null }
        return {
            relative,
            digest: createHash('sha256').update(readFileSync(absolute)).digest('hex')
        }
    })
    return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
}
