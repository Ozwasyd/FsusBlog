import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildReceipt, sealReceipt } from '../../tools/fact-extractors/receipt.mjs'
import {
    ProseClaimErrorCode,
    sortDiagnostics
} from '../../tools/docs/prose-claim-verifier/errors.mjs'
import {
    ProseRenderRegistry,
    allowedProseRenders,
    proseSupportedClaimTypes,
    proseRejectedClaimTypes,
    assertSingleProseRenderRegistry,
    applyProjection
} from '../../tools/docs/prose-claim-verifier/renderers.mjs'
import {
    verifyBodyAgainstPlan,
    collectDimensionValues
} from '../../tools/docs/prose-claim-verifier/parser.mjs'
import {
    ProseClaimVerifier,
    verifyProseClaims,
    makeLocatedClaim,
    resolveFactPath,
    indexReceipts
} from '../../tools/docs/prose-claim-verifier/verifier.mjs'
import {
    scanProseClaimGovernance,
    countForbiddenProseSurfaces,
    root
} from '../../tools/docs/prose-claim-verifier/governance.mjs'
import {
    validateClaimDeclaration,
    allowedClaimTypes
} from '../../tools/docs/doc-claim.mjs'

const cli = path.join(root, 'tools/docs/check-prose-claims.mjs')

function makeReceipt({
    extractorId = 'auth-session-permission-fact-extractor',
    behaviorIds = ['authentication-session-permission'],
    observations,
    status = 'ok',
    failureReasons = []
})
{
    return sealReceipt(buildReceipt({
        extractorId,
        behaviorIds,
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64),
        buildIdentity: null,
        extractorDigest: 'c'.repeat(64),
        registryDigest: 'd'.repeat(64),
        consumedInputDigests: [{ path: 'src/backend/Infrastructure/Auth/AdminPermissions.cs', digest: 'e'.repeat(64) }],
        observations,
        status,
        failureReasons
    }))
}

test('ProseRenderRegistry is unique and admits only registered renders', () =>
{
    assert.deepEqual([...ProseRenderRegistry.kinds], [...allowedProseRenders])
    for (const kind of allowedProseRenders)
    {
        assert.equal(typeof ProseRenderRegistry.get(kind), 'function')
    }
    assert.throws(
        () => ProseRenderRegistry.get('fuzzy-keyword-scan'),
        (error) => error.code === ProseClaimErrorCode.UNKNOWN_RENDER
    )
    assertSingleProseRenderRegistry(
        readFileSync(path.join(root, 'tools/docs/prose-claim-verifier/renderers.mjs'), 'utf8')
    )
})

test('prose supported/rejected claim type partitions are explicit', () =>
{
    assert.ok(proseSupportedClaimTypes.includes('scalar'))
    assert.ok(proseSupportedClaimTypes.includes('boolean'))
    assert.ok(proseSupportedClaimTypes.includes('failure-mode'))
    assert.ok(proseSupportedClaimTypes.includes('binary-relation'))
    assert.ok(proseSupportedClaimTypes.includes('implication'))
    assert.ok(proseSupportedClaimTypes.includes('preservation-rule'))
    assert.ok(proseRejectedClaimTypes.includes('enum-set'))
    assert.ok(proseRejectedClaimTypes.includes('map'))
    assert.ok(proseRejectedClaimTypes.includes('transition-set'))
    assert.ok(allowedClaimTypes.includes('binary-relation'))
    assert.ok(allowedClaimTypes.includes('preservation-rule'))
    assert.ok(allowedClaimTypes.includes('implication'))
})

test('DocClaim accepts new relation/implication/preservation claimTypes', () =>
{
    for (const claimType of ['binary-relation', 'implication', 'preservation-rule'])
    {
        const declaration = validateClaimDeclaration({
            claimId: `auth.example.${claimType}`,
            behaviorId: 'authentication-session-permission',
            claimType,
            factPath: 'exampleFact',
            render: claimType === 'binary-relation'
                ? 'relation-subject-predicate-object'
                : claimType === 'implication'
                    ? 'implication-if-then'
                    : 'preserves-fields'
        })
        assert.equal(declaration.claimType, claimType)
    }
})

test('applyProjection selects default/max nested quantity fields', () =>
{
    const value = {
        default: { value: 5, unit: 'minutes' },
        maximum: { value: 15, unit: 'minutes', role: 'maximum' }
    }
    assert.deepEqual(applyProjection(value, 'default'), { value: 5, unit: 'minutes' })
    assert.deepEqual(applyProjection(value, 'maximum').value, 15)
})

test('1) observed=10 minutes but body still says 5 minutes fails', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.step-up.freshness.default',
        behaviorId: 'authentication-session-permission',
        claimType: 'scalar',
        factPath: 'stepUpFreshness',
        render: 'integer-minutes',
        bodyText: '敏感操作的 step-up proof 默认有效期为 **5 分钟**。',
        projection: 'default'
    })
    const receipt = makeReceipt({
        observations: {
            stepUpFreshness: {
                default: { value: 10, unit: 'minutes', role: 'default' }
            }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) =>
        entry.code === ProseClaimErrorCode.CONFLICTING_VALUE
        || entry.code === ProseClaimErrorCode.REQUIRED_TOKEN_MISSING))
})

test('2) body says 不会延长 while observation extends=true fails', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.refresh.extends-step-up',
        behaviorId: 'authentication-session-permission',
        claimType: 'boolean',
        factPath: 'refreshExtendsStepUp',
        render: 'boolean-extends',
        bodyText: 'Refresh 不会延长 step-up proof。'
    })
    const receipt = makeReceipt({
        observations: {
            refreshExtendsStepUp: { extends: true }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) =>
        entry.code === ProseClaimErrorCode.BOOLEAN_CONFLICT
        || entry.code === ProseClaimErrorCode.FORBIDDEN_TOKEN_PRESENT
        || entry.code === ProseClaimErrorCode.REQUIRED_TOKEN_MISSING))
})

test('boolean-extends false accepts 不会延长', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.refresh.extends-step-up.false',
        behaviorId: 'authentication-session-permission',
        claimType: 'boolean',
        factPath: 'refreshExtendsStepUp',
        render: 'boolean-extends',
        bodyText: 'Refresh 不会延长 step-up proof。'
    })
    const receipt = makeReceipt({
        observations: {
            refreshExtendsStepUp: { extends: false }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2))
})

test('3) body with both fail closed and 失败时继续 fails', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.policy.fail-closed',
        behaviorId: 'authentication-session-permission',
        claimType: 'failure-mode',
        factPath: 'startupPolicy',
        render: 'failure-policy',
        bodyText: '校验失败时 fail closed；但失败时继续处理请求。'
    })
    const receipt = makeReceipt({
        observations: {
            startupPolicy: { policy: 'fail-closed' }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) =>
        entry.code === ProseClaimErrorCode.FAILURE_POLICY_CONFLICT
        || entry.code === ProseClaimErrorCode.FORBIDDEN_TOKEN_PRESENT
        || entry.code === ProseClaimErrorCode.BOOLEAN_CONFLICT))
})

test('4) relation words present but direction reversed fails', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.passkey.revokes-sessions',
        behaviorId: 'authentication-session-permission',
        claimType: 'binary-relation',
        factPath: 'passkeyRevocation',
        render: 'relation-subject-predicate-object',
        // Reverse: session revokes credential (object before subject).
        bodyText: '删除时 session 撤销 credential，而不是按凭据收敛。'
    })
    const receipt = makeReceipt({
        observations: {
            passkeyRevocation: {
                subject: 'credential',
                predicate: 'revokes',
                object: 'session'
            }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) => entry.code === ProseClaimErrorCode.RELATION_DIRECTION))
})

test('forward relation subject-predicate-object passes', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.passkey.revokes-sessions.forward',
        behaviorId: 'authentication-session-permission',
        claimType: 'binary-relation',
        factPath: 'passkeyRevocation',
        render: 'relation-subject-predicate-object',
        bodyText: '删除某个 Passkey 时 credential 撤销 session（仅该凭据绑定会话）。'
    })
    const receipt = makeReceipt({
        observations: {
            passkeyRevocation: {
                subject: 'credential',
                predicate: 'revokes',
                object: 'session'
            }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2))
})

test('5) body max 32 layers vs observation max inclusive 16 fails', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'cache.nesting.max',
        behaviorId: 'authentication-session-permission',
        claimType: 'scalar',
        factPath: 'maxNesting',
        render: 'integer-layers',
        bodyText: '缓存嵌套最大 32 层。'
    })
    const receipt = makeReceipt({
        observations: {
            maxNesting: {
                value: 16,
                unit: 'layers',
                role: 'maximum',
                inclusivity: 'inclusive'
            }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) =>
        entry.code === ProseClaimErrorCode.CONFLICTING_VALUE
        || entry.code === ProseClaimErrorCode.REQUIRED_TOKEN_MISSING
        || entry.code === ProseClaimErrorCode.BOUNDARY_MISMATCH))
})

test('6) same body contains both 5 minutes and 10 minutes fails', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.step-up.freshness.conflict',
        behaviorId: 'authentication-session-permission',
        claimType: 'scalar',
        factPath: 'stepUpFreshness',
        render: 'integer-minutes',
        bodyText: '默认 5 分钟，有时也写作 10 分钟。',
        projection: 'default'
    })
    const receipt = makeReceipt({
        observations: {
            stepUpFreshness: {
                default: { value: 5, unit: 'minutes', role: 'default' }
            }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) => entry.code === ProseClaimErrorCode.CONFLICTING_VALUE))
})

test('7) rationale absolute Redis commitment without neighboring executable claim fails', () =>
{
    const rationale = makeLocatedClaim({
        claimId: 'auth.cache.rationale',
        behaviorId: 'authentication-session-permission',
        claimType: 'rationale',
        factPath: 'documentationScope',
        render: 'rationale-prose',
        bodyText: '该路径永远不会访问 Redis。',
        headingPath: ['Cache']
    })
    const result = verifyProseClaims({ claims: [rationale], receipts: [] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) =>
        entry.code === ProseClaimErrorCode.RATIONALE_UNBOUND
        || entry.code === ProseClaimErrorCode.RATIONALE_PRECISE_FACT))
})

test('rationale with absolute word is ok when neighboring executable claim exists', () =>
{
    const executable = makeLocatedClaim({
        claimId: 'auth.cache.no-redis',
        behaviorId: 'authentication-session-permission',
        claimType: 'boolean',
        factPath: 'usesRedis',
        render: 'boolean-negated',
        bodyText: '该路径不会启用 Redis 访问。',
        headingPath: ['Cache'],
        claimStartLine: 1
    })
    const rationale = makeLocatedClaim({
        claimId: 'auth.cache.rationale.bound',
        behaviorId: 'authentication-session-permission',
        claimType: 'rationale',
        factPath: 'documentationScope',
        render: 'rationale-prose',
        bodyText: '因此该路径永远保持与缓存边界一致。',
        headingPath: ['Cache'],
        claimStartLine: 20
    })
    const receipt = makeReceipt({
        observations: {
            usesRedis: false
        }
    })
    const result = verifyProseClaims({
        claims: [executable, rationale],
        receipts: [receipt]
    })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2))
})

test('8) large permission set as free prose enum-set is rejected', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'admin.permissions.all.prose',
        behaviorId: 'authentication-session-permission',
        claimType: 'enum-set',
        factPath: 'adminPermissions',
        render: 'integer-count',
        bodyText: '权限包括 admin.manage、article.write、audit.read 等一大集合。'
    })
    const receipt = makeReceipt({
        observations: {
            adminPermissions: ['admin.manage', 'article.write', 'audit.read']
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) =>
        entry.code === ProseClaimErrorCode.UNSUPPORTED_CLAIM_TYPE
        && /generated-section/u.test(entry.message)))
})

test('unknown fuzzy render is rejected; no loose mode', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.bad.render',
        behaviorId: 'authentication-session-permission',
        claimType: 'scalar',
        factPath: 'stepUpFreshness',
        render: 'fuzzy-keyword-scan',
        bodyText: '5 分钟'
    })
    const receipt = makeReceipt({
        observations: {
            stepUpFreshness: { value: 5, unit: 'minutes' }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) =>
        entry.code === ProseClaimErrorCode.UNKNOWN_RENDER
        || entry.code === ProseClaimErrorCode.CLAIM_TYPE_RENDER_MISMATCH))
})

test('missing observation fails closed; marker alone is not pass evidence', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.step-up.freshness.missing',
        behaviorId: 'authentication-session-permission',
        claimType: 'scalar',
        factPath: 'missingPath',
        render: 'integer-minutes',
        bodyText: '默认 5 分钟。'
    })
    const receipt = makeReceipt({
        observations: {
            otherFact: { value: 5, unit: 'minutes' }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) => entry.code === ProseClaimErrorCode.MISSING_OBSERVATION))
})

test('failed receipt status fails closed', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.step-up.freshness.failed-receipt',
        behaviorId: 'authentication-session-permission',
        claimType: 'scalar',
        factPath: 'stepUpFreshness',
        render: 'integer-minutes',
        bodyText: '默认 5 分钟。'
    })
    const receipt = makeReceipt({
        observations: {},
        status: 'failed',
        failureReasons: ['extractor broke']
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, false)
    assert.ok(result.diagnostics.some((entry) => entry.code === ProseClaimErrorCode.OBSERVATION_FAILED))
})

test('revokes-only-scope passes controlled phrase and fails all-session wording', () =>
{
    const passClaim = makeLocatedClaim({
        claimId: 'auth.passkey.revokes-only',
        behaviorId: 'authentication-session-permission',
        claimType: 'preservation-rule',
        factPath: 'passkeyScope',
        render: 'revokes-only-scope',
        bodyText: '删除 passkey_delete 只撤销 sessions_bound_to_credential。'
    })
    const receipt = makeReceipt({
        observations: {
            passkeyScope: {
                subject: 'passkey_delete',
                scope: 'sessions_bound_to_credential'
            }
        }
    })
    const pass = verifyProseClaims({ claims: [passClaim], receipts: [receipt] })
    assert.equal(pass.ok, true, JSON.stringify(pass.diagnostics, null, 2))

    const failClaim = makeLocatedClaim({
        claimId: 'auth.passkey.revokes-only.bad',
        behaviorId: 'authentication-session-permission',
        claimType: 'preservation-rule',
        factPath: 'passkeyScope',
        render: 'revokes-only-scope',
        bodyText: '删除 passkey_delete 撤销所有 sessions_bound_to_credential。'
    })
    const fail = verifyProseClaims({ claims: [failClaim], receipts: [receipt] })
    assert.equal(fail.ok, false)
})

test('diagnostics are deterministically ordered for identical inputs', () =>
{
    const claims = [
        makeLocatedClaim({
            claimId: 'z.claim',
            behaviorId: 'authentication-session-permission',
            claimType: 'scalar',
            factPath: 'a',
            render: 'integer-minutes',
            bodyText: '3 分钟',
            documentPath: 'docs/b.md',
            claimStartLine: 10
        }),
        makeLocatedClaim({
            claimId: 'a.claim',
            behaviorId: 'authentication-session-permission',
            claimType: 'scalar',
            factPath: 'b',
            render: 'integer-minutes',
            bodyText: '3 分钟',
            documentPath: 'docs/a.md',
            claimStartLine: 5
        })
    ]
    const receipt = makeReceipt({
        observations: {
            a: { value: 10, unit: 'minutes' },
            b: { value: 10, unit: 'minutes' }
        }
    })
    const first = verifyProseClaims({ claims, receipts: [receipt] })
    const second = verifyProseClaims({ claims, receipts: [receipt] })
    assert.deepEqual(
        first.diagnostics.map((entry) => [entry.documentPath, entry.line, entry.claimId, entry.code]),
        second.diagnostics.map((entry) => [entry.documentPath, entry.line, entry.claimId, entry.code])
    )
    const sorted = sortDiagnostics(first.diagnostics)
    assert.deepEqual(first.diagnostics, sorted)
    assert.ok(first.diagnostics[0].documentPath <= first.diagnostics[1].documentPath
        || first.diagnostics[0].claimId <= first.diagnostics[1].claimId)
})

test('resolveFactPath prefers exact dotted keys then nested descent', () =>
{
    const observations = {
        'auth.step-up.freshness': { default: { value: 5, unit: 'minutes' } },
        nested: { child: { value: 1, unit: 'count' } }
    }
    assert.deepEqual(resolveFactPath(observations, 'auth.step-up.freshness').default.value, 5)
    assert.deepEqual(resolveFactPath(observations, 'nested.child').value, 1)
    assert.equal(resolveFactPath(observations, 'missing'), undefined)
})

test('unit policy does not convert 300 seconds into 5 minutes', () =>
{
    const plan = ProseRenderRegistry.render(
        'scalar',
        'integer-minutes',
        { value: 5, unit: 'minutes' }
    )
    const diagnostics = verifyBodyAgainstPlan('默认 300 秒。', plan, {
        claimId: 'x',
        documentPath: 'docs/x.md',
        line: 1
    })
    assert.ok(diagnostics.some((entry) =>
        entry.code === ProseClaimErrorCode.REQUIRED_TOKEN_MISSING
        || entry.code === ProseClaimErrorCode.CONFLICTING_VALUE))
})

test('collectDimensionValues finds neighboring unit numbers only', () =>
{
    const values = collectDimensionValues('窗口 5 分钟，重试 3 次。', {
        id: 'duration-minutes',
        expectedValue: 5,
        unit: 'minutes',
        unitTokens: ['分钟', 'minutes']
    })
    assert.ok(values.includes(5))
    assert.ok(!values.includes(3))
})

test('governance scan reports zero fuzzy/reviewed/baseline surfaces on clean tree', () =>
{
    const counts = countForbiddenProseSurfaces(root)
    assert.equal(counts.fuzzy, 0, JSON.stringify(counts.violations.filter((entry) => entry.code === ProseClaimErrorCode.FUZZY_SCAN_FORBIDDEN)))
    assert.equal(counts.reviewed, 0)
    assert.equal(counts.baseline, 0)
    const violations = scanProseClaimGovernance(root)
    assert.equal(violations.length, 0, JSON.stringify(violations, null, 2))
})

test('governance detects fuzzy scan / reviewed flag / baseline allowlist when planted', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-prose-gov-'))
    try
    {
        // Minimal framework stubs so missing-file checks pass for scanned roots only.
        for (const relative of [
            'tools/docs/prose-claim-verifier/errors.mjs',
            'tools/docs/prose-claim-verifier/phrases.mjs',
            'tools/docs/prose-claim-verifier/renderers.mjs',
            'tools/docs/prose-claim-verifier/parser.mjs',
            'tools/docs/prose-claim-verifier/verifier.mjs',
            'tools/docs/prose-claim-verifier/governance.mjs',
            'tools/docs/check-prose-claims.mjs',
            'config/schemas/doc-claim.schema.json',
            'tools/docs/doc-claim.mjs'
        ])
        {
            const target = path.join(directory, relative)
            mkdirSync(path.dirname(target), { recursive: true })
            cpSync(path.join(root, relative), target)
        }
        // Build forbidden identifiers at runtime so a repo-wide static search for those
        // surfaces still returns only governance ban-list definitions (not fixture seeds).
        const evilSource = [
            `export const ${['fuzzy', 'FullText', 'Scan'].join('')} = () => {};`,
            `export const ${['prose', 'Reviewed'].join('')} = true;`,
            `export const ${['proseClaim', 'Baseline', 'Allowlist'].join('')} = [];`
        ].join(' ')
        writeFileSync(path.join(directory, 'tools/docs/evil-prose.mjs'), `${evilSource}\n`)
        const violations = scanProseClaimGovernance(directory)
        assert.ok(violations.some((entry) => entry.code === ProseClaimErrorCode.FUZZY_SCAN_FORBIDDEN))
        assert.ok(violations.some((entry) => entry.code === ProseClaimErrorCode.REVIEWED_FLAG_FORBIDDEN))
        assert.ok(violations.some((entry) => entry.code === ProseClaimErrorCode.BASELINE_ALLOWLIST_FORBIDDEN))
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('CLI governance-only succeeds on repository', () =>
{
    const result = spawnSync(process.execPath, [cli, '--governance-only'], {
        cwd: root,
        encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /governance clean/u)
})

test('ProseClaimVerifier does not import extractor implementations', () =>
{
    for (const relative of [
        'tools/docs/prose-claim-verifier/verifier.mjs',
        'tools/docs/prose-claim-verifier/renderers.mjs',
        'tools/docs/prose-claim-verifier/parser.mjs'
    ])
    {
        const source = readFileSync(path.join(root, relative), 'utf8')
        assert.doesNotMatch(source, /fact-extractors\/(?:runner|seeds|auth-|content-|config-)/u)
        assert.doesNotMatch(source, /from\s+['"][^'"]*\/src\//u)
        assert.doesNotMatch(source, /\bopenai\b|\bcallLlm\b|\bembeddingModel\b/u)
        assert.doesNotMatch(source, /\breviewed\s*[:=]\s*true\b/u)
        assert.doesNotMatch(source, /\bwarningOnly\b|\bfeatureFlag\b/u)
    }
})

test('indexReceipts rejects duplicate extractor receipts', () =>
{
    const receipt = makeReceipt({
        observations: { x: true }
    })
    assert.throws(
        () => indexReceipts([receipt, structuredClone(receipt)]),
        (error) => error.code === ProseClaimErrorCode.OBSERVATION_AMBIGUOUS
    )
})

test('scalar success path with exact minutes and default role', () =>
{
    const claim = makeLocatedClaim({
        claimId: 'auth.step-up.freshness.ok',
        behaviorId: 'authentication-session-permission',
        claimType: 'scalar',
        factPath: 'stepUpFreshness',
        render: 'integer-minutes',
        bodyText: '敏感操作的 step-up proof 默认有效期为 **5 分钟**。',
        projection: 'default'
    })
    const receipt = makeReceipt({
        observations: {
            stepUpFreshness: {
                default: { value: 5, unit: 'minutes', role: 'default' }
            }
        }
    })
    const result = verifyProseClaims({ claims: [claim], receipts: [receipt] })
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2))
})

test('ProseClaimVerifier singleton surface exports verify entrypoint', () =>
{
    assert.equal(typeof ProseClaimVerifier.verify, 'function')
    assert.equal(ProseClaimVerifier.renderRegistry, ProseRenderRegistry)
})
