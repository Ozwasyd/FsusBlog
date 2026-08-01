import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = path.join(root, 'tests/fixtures/issue-orchestration')
const policyPath = path.join(
    root,
    '.agents/skills/issue-orchestration/scripts/stage-profile-policy.mjs'
)
const acceptance = readJson('stage-profile-acceptance-map.json')
const controls = readJson('stage-profile-mutation-controls.json').controls
const probes = readJson('stage-profile-runtime-probes.json').probes
const contract = readJson('stage-profile-test-contract.json')

const roles = [
    'root-scheduler',
    'dag-creator-updater',
    'test-owner',
    'code-implementer',
    'ui-ux-implementer',
    'ux-acceptance-verifier',
    'documentation-writer',
    'cleanup-verifier'
]

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'))
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

async function policy() {
    return import(`${pathToFileURL(policyPath).href}?contract=${Date.now()}`)
}

function assignment(role = 'code-implementer') {
    return {
        schema: 'issue-orchestration.stage-assignment.v1',
        policyVersion: 'stage-profiles.v1',
        role,
        model: 'gpt-5.6-sol',
        effort: role === 'root-scheduler' || role.includes('implementer') ? 'low' : 'max',
        sandbox: ['root-scheduler', 'dag-creator-updater', 'ux-acceptance-verifier']
            .includes(role) ? 'read-only' : 'workspace-write',
        writeScope: role === 'test-owner' ? 'tests-only'
            : role.includes('implementer') ? 'implementation-only' : 'none',
        capabilityDigest: 'a'.repeat(64),
        requiredSkillDigests: [],
        rationaleCodes: ['issue-contract'],
        requestedByRole: 'root-scheduler',
        freshContext: ['dag-creator-updater', 'test-owner', 'ux-acceptance-verifier'].includes(role),
        trigger: role === 'dag-creator-updater' ? 'remote-live-snapshot-changed' : 'stage-ready',
        logicalActorId: `${role}-1819`,
        memberReceiptDigest: 'b'.repeat(64),
        inheritedFromRole: null,
        writePaths: [],
        prerequisites: { behaviorGreen: true, uxAccepted: true },
        candidate: { commandsGreen: true, remainingFailures: [], internalFixCycles: 2 },
        globalReworkDelta: 0
    }
}

test('contract assets are exact and internally linked', () => {
    assert.equal(contract.issueId, 'Ozwasyd/FsusBlog#1819')
    assert.equal(contract.baseSha, 'b5796c28c379f8d8725d8b32ff261b15baed3822')
    assert.equal(contract.authorityCommentId, 5145144548)
    assert.deepEqual(contract.acceptanceMap,
        'tests/fixtures/issue-orchestration/stage-profile-acceptance-map.json')
    assert.deepEqual(acceptance.acceptance.flatMap(({ mutations }) => mutations).sort(),
        controls.map(({ id }) => id).sort())
    assert.deepEqual(probes.map(({ id }) => id),
        Array.from({ length: 10 }, (_, index) => `RP${String(index + 1).padStart(2, '0')}`))
    for (const [relative, expected] of Object.entries(contract.fileHashes)) {
        assert.equal(digest(fs.readFileSync(path.join(root, relative))), expected)
    }
    const unsigned = structuredClone(contract)
    delete unsigned.testContractDigest
    assert.equal(digest(unsigned), contract.testContractDigest)
})

test('P01 exactly eight canonical stage profiles replace all dual-role authority', async () => {
    const module = await policy()
    assert.deepEqual(Object.keys(module.STAGE_PROFILES), roles)
})

test('P02 every profile binds the complete versioned machine policy', async () => {
    const { STAGE_PROFILES } = await policy()
    for (const role of roles) {
        const profile = STAGE_PROFILES[role]
        for (const field of [
            'policyVersion', 'capabilityDigest', 'role', 'model', 'effort',
            'sandbox', 'writeScope', 'requiredSkillDigests', 'rationaleCodes'
        ]) assert.ok(Object.hasOwn(profile, field), `${role}.${field}`)
    }
})

test('P03 root and DAG authority are exact and remote-triggered', async () => {
    const { validateStageAssignment } = await policy()
    assert.doesNotThrow(() => validateStageAssignment(assignment('root-scheduler')))
    assert.doesNotThrow(() => validateStageAssignment(assignment('dag-creator-updater')))
})

test('P04 test owner continuity preserves independent Sol/max verification', async () => {
    const { validateStageAssignment } = await policy()
    assert.doesNotThrow(() => validateStageAssignment(assignment('test-owner')))
})

test('P05 implementer owns same-attempt self-test but not behavior authority', async () => {
    const { validateStageAssignment } = await policy()
    for (const role of ['code-implementer', 'ui-ux-implementer']) {
        const value = assignment(role)
        if (role === 'ui-ux-implementer') {
            value.requiredSkillDigests = ['c'.repeat(64), 'd'.repeat(64)]
        }
        assert.doesNotThrow(() => validateStageAssignment(value))
    }
})

test('P06 UI implementation and UX acceptance have distinct exact profiles', async () => {
    const { validateStageAssignment } = await policy()
    const ui = assignment('ui-ux-implementer')
    ui.requiredSkillDigests = ['c'.repeat(64), 'd'.repeat(64)]
    assert.doesNotThrow(() => validateStageAssignment(ui))
    assert.doesNotThrow(() => validateStageAssignment(assignment('ux-acceptance-verifier')))
})

test('P07 documentation capability fallback is explicit and prerequisite-bound', async () => {
    const { resolveDocumentationProfile } = await policy()
    const resolved = resolveDocumentationProfile({
        capabilityReceipt: {
            schema: 'issue-orchestration.model-capability-receipt.v1',
            model: 'gpt-5.6-luna',
            effort: 'xhigh',
            supported: true,
            receiptDigest: 'e'.repeat(64)
        },
        prerequisites: { behaviorGreen: true, uxAccepted: true }
    })
    assert.deepEqual([resolved.model, resolved.effort], ['gpt-5.6-luna', 'xhigh'])
})

test('P08 continuity identity cannot alter profiles or replace member evidence', async () => {
    const { validateContinuity } = await policy()
    assert.doesNotThrow(() => validateContinuity({
        previous: assignment('code-implementer'),
        next: assignment('code-implementer')
    }))
})

test('P09 legacy roles and node-level profile authority are rejected', async () => {
    const { validateStageAssignment } = await policy()
    for (const role of ['issue-implementer', 'issue-reviewer']) {
        assert.throws(() => validateStageAssignment(assignment(role)),
            (error) => error.code === 'stage-profile-legacy-role')
    }
})

test('P10 dispatch and batch selection consume the central policy without legacy aliases', () => {
    const dispatch = fs.readFileSync(path.join(
        root, '.agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs'), 'utf8')
    const batch = fs.readFileSync(path.join(
        root, '.agents/skills/issue-orchestration/scripts/dispatch-batch-selector.mjs'), 'utf8')
    assert.match(dispatch, /stage-profile-policy\.mjs/u)
    assert.match(batch, /stage-profile-policy\.mjs/u)
    assert.doesNotMatch(batch, /['"]ux-verifier['"]/u)
    assert.equal(fs.existsSync(path.join(root, '.codex/agents/issue-reviewer.toml')), false)
    assert.equal(fs.existsSync(path.join(root, '.codex/agents/issue-implementer.toml')), false)
})

const mutations = {
    'role-missing': (value) => { delete value.role },
    'policy-version-missing': (value) => { delete value.policyVersion },
    'capability-digest-missing': (value) => { delete value.capabilityDigest },
    'rationale-codes-missing': (value) => { value.rationaleCodes = [] },
    'root-effort-max': (value) => { Object.assign(value, assignment('root-scheduler'), { effort: 'max' }) },
    'root-authors-dag': (value) => { Object.assign(value, assignment('root-scheduler'), { action: 'author-dag' }) },
    'dag-effort-low': (value) => { Object.assign(value, assignment('dag-creator-updater'), { effort: 'low' }) },
    'dag-sandbox-writable': (value) => { Object.assign(value, assignment('dag-creator-updater'), { sandbox: 'workspace-write' }) },
    'dag-not-fresh': (value) => { Object.assign(value, assignment('dag-creator-updater'), { freshContext: false }) },
    'dag-nonroot-launch': (value) => { Object.assign(value, assignment('dag-creator-updater'), { requestedByRole: 'test-owner' }) },
    'dag-local-event-trigger': (value) => { Object.assign(value, assignment('dag-creator-updater'), { trigger: 'local-test-failed' }) },
    'test-owner-implementation-write': (value) => { Object.assign(value, assignment('test-owner'), { writePaths: ['src/runtime.mjs'] }) },
    'behavior-verifier-inherits-implementer': (value) => { Object.assign(value, assignment('test-owner'), { inheritedFromRole: 'code-implementer' }) },
    'group-receipt-substitutes-member': (value) => { value.memberReceiptDigest = null },
    'implementer-effort-upgrade': (value) => { value.effort = 'max' },
    'implementer-modifies-frozen-test': (value) => { value.writePaths = ['tests/frozen.test.mjs'] },
    'implementer-modifies-docs': (value) => { value.writePaths = ['docs/current.md'] },
    'implementer-returns-red-candidate': (value) => { value.candidate.remainingFailures = ['failure'] },
    'implementer-signs-behavior': (value) => { value.action = 'sign-behavior-green' },
    'internal-cycle-increments-rework': (value) => { value.globalReworkDelta = 1 },
    'ui-owner-split': (value) => { Object.assign(value, assignment('ui-ux-implementer'), { logicalActorId: ['ui-owner', 'ux-owner'] }) },
    'ui-skill-missing': (value) => { Object.assign(value, assignment('ui-ux-implementer'), { requiredSkillDigests: [] }) },
    'code-role-writes-ui': (value) => { value.writePaths = ['src/frontend/App.tsx'] },
    'ux-verifier-writable': (value) => { Object.assign(value, assignment('ux-acceptance-verifier'), { sandbox: 'workspace-write' }) },
    'ux-verifier-implements': (value) => { Object.assign(value, assignment('ux-acceptance-verifier'), { writePaths: ['src/frontend/App.tsx'] }) },
    'documentation-before-green': (value) => { Object.assign(value, assignment('documentation-writer'), { prerequisites: { behaviorGreen: false, uxAccepted: true } }) },
    'documentation-before-ux': (value) => { Object.assign(value, assignment('documentation-writer'), { prerequisites: { behaviorGreen: true, uxAccepted: false } }) },
    'documentation-silent-fallback': (value) => { Object.assign(value, assignment('documentation-writer'), { model: 'gpt-5.6-sol', fallbackReceipt: null }) },
    'continuity-effort-upgrade': (value) => { value.continuity = { previous: assignment(), next: { ...assignment(), effort: 'max' } } },
    'continuity-permission-accumulation': (value) => { value.continuity = { previous: assignment(), next: { ...assignment(), writeScope: 'workspace' } } },
    'continuity-member-metadata-missing': (value) => { value.memberReceiptDigest = null },
    'legacy-implementer-role': (value) => { value.role = 'issue-implementer' },
    'legacy-reviewer-role': (value) => { value.role = 'issue-reviewer' },
    'legacy-node-profile-authority': (value) => { value.node = { model: 'gpt-5.6-sol', effort: 'max' } }
}

test('mutation catalog is exact and executable', () => {
    assert.deepEqual(Object.keys(mutations).sort(), controls.map(({ id }) => id).sort())
})

for (const control of controls) {
    test(`MUTATION ${control.id} is rejected with ${control.expectedCode}`, async () => {
        const module = await policy()
        const value = assignment()
        mutations[control.id](value)
        const invoke = value.continuity
            ? () => module.validateContinuity(value.continuity)
            : () => module.validateStageAssignment(value)
        assert.throws(invoke, (error) => error.code === control.expectedCode)
    })
}
