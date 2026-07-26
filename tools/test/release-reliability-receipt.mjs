import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const canonicalScenarioIds = [
    'release-soak-min',
    'release-load-peak',
    'release-load-burst',
    'release-data-scale-m',
    'release-mutation-critical-slice',
    'release-memory-leak-budget',
    'release-open-handle-budget'
];

function stableValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(stableValue);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

export function digestValue(value)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

export function digestFile(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function sourceIdentity(repositoryRoot)
{
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    const worktree = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    });
    return {
        commit,
        worktreeFingerprint: digestValue({ commit, worktree })
    };
}

function requiredDigest(value)
{
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function tryReadBuildReceipt(repositoryRoot, env)
{
    const configured = String(env.FSUSBLOG_RELEASE_BUILD_RECEIPT ?? '').trim();
    if (!configured)
    {
        return { status: 'unavailable', reason: 'FSUSBLOG_RELEASE_BUILD_RECEIPT is required' };
    }
    const receiptPath = path.resolve(repositoryRoot, configured);
    if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile())
    {
        return { status: 'unavailable', reason: `build receipt is unavailable: ${configured}` };
    }
    return {
        status: 'complete',
        path: path.relative(repositoryRoot, receiptPath).replaceAll(path.sep, '/'),
        digest: digestFile(receiptPath)
    };
}

function collectMachineIdentity()
{
    const cpus = os.cpus();
    return {
        collectorStatus: 'complete',
        os: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        cpuModels: [...new Set(cpus.map((cpu) => cpu.model))].sort(),
        cpuCount: cpus.length,
        memoryBytes: os.totalmem(),
        containerLimits: process.platform === 'linux' ? 'collector-required-by-host-policy' : 'not-applicable'
    };
}

export function collectRunIdentity({ repositoryRoot, catalog, env = process.env, source = null })
{
    const sourceState = source ?? sourceIdentity(repositoryRoot);
    const fixtureRoot = String(env.FSUSBLOG_TEST_FIXTURE_ROOT ?? '').trim();
    const fixtureConfig = String(env.FSUSBLOG_TEST_FIXTURE_CONFIG ?? '').trim();
    const imageDigest = String(env.FSUSBLOG_RELEASE_IMAGE_DIGEST ?? '').trim();
    const thresholdPath = path.join(repositoryRoot, 'tests/performance/perf-policy.yml');
    return {
        source: sourceState,
        build: {
            ...tryReadBuildReceipt(repositoryRoot, env),
            imageDigest: requiredDigest(imageDigest) ? imageDigest : null
        },
        fixture: {
            collectorStatus: fixtureRoot && fixtureConfig ? 'complete' : 'unavailable',
            root: fixtureRoot || null,
            namespace: String(env.FSUSBLOG_TEST_NAMESPACE ?? '').trim() || null,
            configDigest: fixtureConfig && fs.existsSync(path.resolve(repositoryRoot, fixtureConfig))
                ? digestFile(path.resolve(repositoryRoot, fixtureConfig))
                : null,
            topology: String(env.FSUSBLOG_TEST_RUNTIME_TOPOLOGY ?? '').trim() || null
        },
        machine: collectMachineIdentity(),
        policy: {
            catalogDigest: digestValue(catalog),
            thresholdDigest: fs.existsSync(thresholdPath) ? digestFile(thresholdPath) : null,
            executorSchema: 'fsusblog.release-reliability-scenario-result.v1'
        }
    };
}

function receiptPayload(receipt)
{
    const { contentDigest, ...payload } = receipt;
    return payload;
}

function assertExactScenarioIds(items, label)
{
    const ids = items.map((item) => item.scenarioId);
    if (ids.length !== canonicalScenarioIds.length || new Set(ids).size !== canonicalScenarioIds.length)
    {
        throw new Error(`${label} must contain exactly the seven canonical scenarios`);
    }
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...canonicalScenarioIds].sort()))
    {
        throw new Error(`${label} contains missing, duplicate, or unknown scenarios`);
    }
}

function verifyIdentityComplete(identity)
{
    if (!/^[0-9a-f]{40}$/u.test(identity?.source?.commit ?? ''))
    {
        throw new Error('receipt source commit must be a full 40-character SHA');
    }
    if (!requiredDigest(identity?.source?.worktreeFingerprint))
    {
        throw new Error('receipt worktree fingerprint is missing or invalid');
    }
    if (identity?.build?.status !== 'complete' || !requiredDigest(identity.build.digest) || !requiredDigest(identity.build.imageDigest))
    {
        throw new Error('receipt immutable build receipt and image digest must be complete');
    }
    if (identity?.fixture?.collectorStatus !== 'complete' || !requiredDigest(identity.fixture.configDigest)
        || !identity.fixture.root || !identity.fixture.namespace || !identity.fixture.topology)
    {
        throw new Error('receipt fixture identity collector is incomplete');
    }
    if (identity?.machine?.collectorStatus !== 'complete')
    {
        throw new Error('receipt machine identity collector is incomplete');
    }
    if (!requiredDigest(identity?.policy?.catalogDigest) || !requiredDigest(identity?.policy?.thresholdDigest))
    {
        throw new Error('receipt policy identity is incomplete');
    }
}

function verifyScenarioResult(result, identity)
{
    if (result?.schema !== 'fsusblog.release-reliability-scenario-result.v1' || result.status !== 'passed')
    {
        throw new Error(`scenario ${result?.scenarioId ?? '<missing>'} is not a passed sealed result`);
    }
    if (JSON.stringify(result.source) !== JSON.stringify(identity.source))
    {
        throw new Error(`scenario ${result.scenarioId} source identity mismatch`);
    }
    if (result.policy?.catalogDigest !== identity.policy.catalogDigest)
    {
        throw new Error(`scenario ${result.scenarioId} policy identity mismatch`);
    }
    if (result.identityDigest !== digestValue(identity))
    {
        throw new Error(`scenario ${result.scenarioId} complete identity mismatch`);
    }
    if (!requiredDigest(result.authoritativeEvidence?.digest))
    {
        throw new Error(`scenario ${result.scenarioId} authoritative evidence digest is invalid`);
    }
    if (result.isolation?.precondition?.status !== 'complete'
        || result.isolation?.reset?.status !== 'complete'
        || result.isolation?.postcondition?.status !== 'complete')
    {
        throw new Error(`scenario ${result.scenarioId} isolation or reset evidence is incomplete`);
    }
}

export function createQualifiedReceipt({ invocationId, scenarioResults, identity, createdAt })
{
    const base = {
        schema: 'fsusblog.release-reliability-qualified-receipt.v1',
        invocationId,
        status: 'failed',
        identity,
        scenarios: [],
        createdAt,
        failure: null
    };
    try
    {
        assertExactScenarioIds(scenarioResults, 'scenario results');
        verifyIdentityComplete(identity);
        for (const result of scenarioResults)
        {
            if (result.invocationId !== invocationId)
            {
                throw new Error(`scenario ${result.scenarioId} invocation ID mismatch`);
            }
            verifyScenarioResult(result, identity);
            base.scenarios.push({
                scenarioId: result.scenarioId,
                resultDigest: digestValue(result),
                producerEvidenceDigest: result.authoritativeEvidence.digest,
                source: result.source,
                isolation: result.isolation
            });
        }
        base.scenarios.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
        base.status = 'qualified';
    }
    catch (error)
    {
        base.failure = error instanceof Error ? error.message : String(error);
    }
    return { ...base, contentDigest: digestValue(base) };
}

export function verifyQualifiedReceipt({ receipt, scenarioResults })
{
    if (receipt?.schema !== 'fsusblog.release-reliability-qualified-receipt.v1')
    {
        throw new Error('receipt schema is invalid');
    }
    if (receipt.contentDigest !== digestValue(receiptPayload(receipt)))
    {
        throw new Error('receipt content digest mismatch');
    }
    if (receipt.status !== 'qualified')
    {
        throw new Error(`receipt is not qualified: ${receipt.status}`);
    }
    assertExactScenarioIds(receipt.scenarios, 'receipt scenarios');
    assertExactScenarioIds(scenarioResults, 'scenario results');
    verifyIdentityComplete(receipt.identity);
    const resultsById = new Map(scenarioResults.map((result) => [result.scenarioId, result]));
    for (const scenario of receipt.scenarios)
    {
        const result = resultsById.get(scenario.scenarioId);
        verifyScenarioResult(result, receipt.identity);
        if (scenario.resultDigest !== digestValue(result))
        {
            throw new Error(`scenario ${scenario.scenarioId} sealed result digest mismatch`);
        }
        if (scenario.producerEvidenceDigest !== result.authoritativeEvidence.digest)
        {
            throw new Error(`scenario ${scenario.scenarioId} producer evidence digest mismatch`);
        }
    }
    return receipt;
}
