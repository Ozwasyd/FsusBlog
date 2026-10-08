import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson, sealContentDigest, sha256 } from './attempt-provenance.mjs';

export const backendAtomicPlanSchema = 'fsusblog.backend-atomic-plan-candidate.v1';
const suiteSource = 'tools/test/lanes/_suite-support.sh';
const governanceOwners = new Map([
    ['backend-source-file-size', 'RunBackendSourceFileSizeCheckOnce'],
    ['backend-test-governance', 'RunBackendTestGovernanceCheckOnce'],
    ['postgres-test-collections', 'RunPostgresTestCollectionsCheckOnce']
]);
const perfOwners = new Map([
    ['backend-perf-governance', 'projectBackendGovernanceOutcomes'],
    ['backend-perf-native-p99', 'RunBackendPerfNativeP99Only'],
    ['backend-perf-readiness', null]
]);
const identityFields = ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId', 'profile'];
const producerFields = [
    'producerId', 'kind', 'logicalParentId', 'commandSourceRef', 'commandDigest',
    'inputClosureRef', 'attemptPolicyId', 'executionClass', 'fixtureProfile',
    'stateAccessRef', 'resourceContractRef', 'dependsOn', 'settledDependsOn',
    'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'
];

export function backendAtomicExactFields(value, fields, label)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort()))
    {
        throw new Error(`${label} must have exactly the declared fields`);
    }
}

export function backendAtomicDigest(value, label)
{
    if (!/^sha256:[0-9a-f]{64}$/u.test(value))
    {
        throw new Error(`${label} must be a SHA-256 digest`);
    }
}

function text(value, label)
{
    if (typeof value !== 'string' || !value.trim() || value !== value.trim())
    {
        throw new Error(`${label} must be nonempty canonical text`);
    }
}

function equal(actual, expected, label)
{
    if (canonicalJson(actual) !== canonicalJson(expected))
    {
        throw new Error(`${label} does not match the domain contract`);
    }
}

function sortedIds(values, label)
{
    if (!Array.isArray(values) || values.some((value) => !/^[a-z][a-z0-9-]*$/u.test(value)))
    {
        throw new Error(`${label} must contain semantic producer IDs`);
    }
    equal(values, [...new Set(values)].sort(), `${label} sorted unique IDs`);
}

function reference(value, label, withSymbol = false)
{
    backendAtomicExactFields(value, withSymbol ? ['path', 'digest', 'symbol'] : ['path', 'digest'], label);
    if (typeof value.path !== 'string' || !value.path || path.posix.isAbsolute(value.path)
        || value.path.includes('\\') || value.path.split('/').some((part) => ['', '.', '..'].includes(part)))
    {
        throw new Error(`${label} must be repository relative`);
    }
    backendAtomicDigest(value.digest, `${label}.digest`);
    if (withSymbol && value.symbol !== null)
    {
        text(value.symbol, `${label}.symbol`);
    }
}

function producer(value, parent)
{
    sortedIds([parent], 'logicalParentId');
    backendAtomicExactFields(value, producerFields, value?.producerId ?? 'producer');
    sortedIds([value.producerId], 'producerId');
    equal(value.kind, 'atomic-producer', `${value.producerId}.kind`);
    equal(value.logicalParentId, parent, `${value.producerId}.logicalParentId`);
    equal(value.attemptPolicyId, 'correctness-first-attempt', `${value.producerId}.attemptPolicyId`);
    reference(value.commandSourceRef, `${value.producerId}.commandSourceRef`, true);
    for (const field of ['inputClosureRef', 'stateAccessRef', 'resourceContractRef'])
    {
        reference(value[field], `${value.producerId}.${field}`);
    }
    for (const field of ['commandDigest', 'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'])
    {
        backendAtomicDigest(value[field], `${value.producerId}.${field}`);
    }
    text(value.fixtureProfile, `${value.producerId}.fixtureProfile`);
    sortedIds(value.dependsOn, `${value.producerId}.dependsOn`);
    sortedIds(value.settledDependsOn, `${value.producerId}.settledDependsOn`);
    if (value.dependsOn.some((id) => value.settledDependsOn.includes(id))
        || [...value.dependsOn, ...value.settledDependsOn].includes(value.producerId))
    {
        throw new Error(`${value.producerId} has duplicate/self edges`);
    }
}

function validateInput(input)
{
    backendAtomicExactFields(input, ['lane', 'identity', 'readinessMode', 'buildConfiguration', 'releasePrerequisite', 'declarations'], 'plan input');
    if (!['backend-test-governance', 'backend-perf'].includes(input.lane))
    {
        throw new Error('unknown backend lane');
    }
    backendAtomicExactFields(input.identity, identityFields, 'execution identity');
    if (!/^[0-9a-f]{40}$/u.test(input.identity.sourceCommit))
    {
        throw new Error('sourceCommit must be exact');
    }
    backendAtomicDigest(input.identity.worktreeFingerprint, 'worktreeFingerprint');
    text(input.identity.schedulerRunId, 'schedulerRunId');
    text(input.identity.profile, 'profile');
    const governance = input.lane === 'backend-test-governance';
    const owners = governance ? governanceOwners : perfOwners;
    const summaryId = governance ? 'backend-governance-summary' : 'backend-perf-summary';
    if (!Array.isArray(input.declarations))
    {
        throw new Error('declarations must be an array');
    }
    equal(input.declarations.map((entry) => entry.producerId).sort(), [...owners.keys(), summaryId].sort(), 'exact producer roster');
    if (governance)
    {
        equal(input.buildConfiguration, null, 'governance buildConfiguration');
        equal(input.readinessMode, null, 'governance readinessMode');
        equal(input.releasePrerequisite, null, 'governance releasePrerequisite');
    }
    else
    {
        equal(input.buildConfiguration, 'Release', 'performance buildConfiguration');
        if (!['build', 'verify-fresh'].includes(input.readinessMode))
        {
            throw new Error('readinessMode must explicitly be build or verify-fresh');
        }
        producer(input.releasePrerequisite, input.releasePrerequisite?.logicalParentId);
        equal(input.releasePrerequisite.executionClass, 'correctness', 'Release assembly prerequisite class');
        if ([...owners.keys(), summaryId, ...governanceOwners.keys(), 'backend-governance-summary'].includes(input.releasePrerequisite.producerId))
        {
            throw new Error('Release test assembly needs its own prerequisite owner');
        }
    }
    for (const entry of input.declarations)
    {
        if (entry.producerId === summaryId)
        {
            backendAtomicExactFields(entry, ['producerId', 'kind', 'logicalParentId', 'dependsOn', 'settledDependsOn'], summaryId);
            equal(entry.kind, 'settled-join', `${summaryId}.kind`);
            equal(entry.logicalParentId, input.lane, `${summaryId}.logicalParentId`);
            equal(entry.dependsOn, [], `${summaryId}.dependsOn`);
            equal(entry.settledDependsOn, [...owners.keys()].sort(), 'complete settled summary roster');
            continue;
        }
        producer(entry, input.lane);
        let source = suiteSource;
        let symbol = owners.get(entry.producerId);
        if (entry.producerId === 'backend-perf-governance')
        {
            source = 'tools/test/backend-atomic-outcomes.mjs';
        }
        if (entry.producerId === 'backend-perf-readiness')
        {
            source = input.readinessMode === 'build'
                ? 'tools/test/ensure-benchmark-release-build.sh' : 'tools/test/verify-benchmark-build-ready.mjs';
        }
        equal(entry.commandSourceRef.path, source, `${entry.producerId} existing command owner`);
        equal(entry.commandSourceRef.symbol, symbol, `${entry.producerId} existing command symbol`);
        equal(entry.executionClass, entry.producerId === 'backend-perf-native-p99' ? 'benchmark' : 'correctness', `${entry.producerId}.executionClass`);
        equal(entry.fixtureProfile, 'none', `${entry.producerId}.fixtureProfile`);
        equal(entry.dependsOn, entry.producerId === 'backend-perf-native-p99' ? [input.releasePrerequisite.producerId] : [], `${entry.producerId} hard dependencies`);
        const settled = entry.producerId === 'backend-perf-governance' ? ['backend-governance-summary']
            : entry.producerId === 'backend-perf-native-p99' ? ['backend-perf-governance', 'backend-perf-readiness'] : [];
        equal(entry.settledDependsOn, settled, `${entry.producerId} settled dependencies`);
    }
}

// A read-only domain contract for the future canonical matrix compiler. It never
// discovers commands, schedules work, grants authority, or runs a checker.
export function createBackendAtomicPlan(input)
{
    validateInput(input);
    const snapshot = JSON.parse(JSON.stringify(input));
    snapshot.declarations.sort((left, right) => left.producerId.localeCompare(right.producerId));
    return sealContentDigest({ schema: backendAtomicPlanSchema, authority: 'DATA_ONLY', ...snapshot });
}

export function validateBackendAtomicPlan(plan, expectedDigest)
{
    backendAtomicExactFields(plan, ['schema', 'authority', 'lane', 'identity', 'readinessMode', 'buildConfiguration', 'releasePrerequisite', 'declarations', 'contentDigest'], 'plan');
    equal(plan.schema, backendAtomicPlanSchema, 'plan schema');
    equal(plan.authority, 'DATA_ONLY', 'plan authority');
    const { lane, identity, readinessMode, buildConfiguration, releasePrerequisite, declarations } = plan;
    const canonical = createBackendAtomicPlan({ lane, identity, readinessMode, buildConfiguration, releasePrerequisite, declarations });
    equal(plan, canonical, 'canonical plan');
    backendAtomicDigest(expectedDigest, 'independently selected plan digest');
    equal(plan.contentDigest, expectedDigest, 'selected plan digest');
    return canonical;
}

export function assertBackendAtomicPlanParity(local, ci, expectedDigest)
{
    validateBackendAtomicPlan(local, expectedDigest);
    validateBackendAtomicPlan(ci, expectedDigest);
    equal(local, ci, 'local/CI plan parity');
}

export function verifyBackendAtomicSourceRefs(plan, expectedDigest, root)
{
    validateBackendAtomicPlan(plan, expectedDigest);
    const refs = [...plan.declarations.filter((entry) => entry.kind === 'atomic-producer'),
        ...(plan.releasePrerequisite ? [plan.releasePrerequisite] : [])].flatMap((entry) => [
        entry.commandSourceRef, entry.inputClosureRef, entry.stateAccessRef, entry.resourceContractRef
    ]);
    const realRoot = fs.realpathSync(root);
    for (const ref of refs)
    {
        const file = path.join(realRoot, ref.path);
        if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()
            || sha256(fs.readFileSync(file)) !== ref.digest)
        {
            throw new Error(`atomic source/reference drift: ${ref.path}`);
        }
    }
    return true;
}
