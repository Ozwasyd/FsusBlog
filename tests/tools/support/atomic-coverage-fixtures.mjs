import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { digestCanonical, sealContentDigest, sha256 } from '../../../tools/test/attempt-provenance.mjs';
import { canonicalTestId, planExactShards, sealReplayPlan } from '../../../tools/test/execution-replay-contract.mjs';
import { createCoveragePlan } from '../../../tools/coverage/atomic-coverage-plan.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const identity = Object.freeze({ runId: 'coverage-fixture', sourceCommit: '1'.repeat(40), sourceFingerprint: `sha256:${'2'.repeat(64)}` });

/** Synthetic source/receipt fixtures, never real runtime or release evidence. */
export function coverageFixture(t, environment = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-atomic-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourcePlan = createCoveragePlan({ root: repositoryRoot, identity, environment });
    for (const relative of Object.keys(sourcePlan.sourceDigests))
    {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, relative), target);
    }
    const plan = createCoveragePlan({ root, identity, environment });
    const authorities = new Map();
    const write = (relative, value) =>
    {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        return { path: relative, digest: sha256(bytes) };
    };
    const makeMaterial = (producerId, status = 'clean-success', modifySummary = (value) => value) =>
    {
        const producer = plan.producers.find((item) => item.id === producerId);
        const base = `.tmp/attempts/${identity.runId}/${producerId}/attempt-1`;
        const domain = producerId.slice('coverage-'.length);
        const summary = modifySummary({
            summary: { linecoverage: 100, branchcoverage: 100, methodcoverage: 100, assemblies: 1, classes: 1, files: 1 },
            totals: { lines: { covered: 1, total: 1 }, branches: { covered: 1, total: 1 }, methods: { covered: 1, total: 1 } },
            producer: identity, source: domain === 'backend' ? 'backend-coverlet-json-authoritative-merge' : 'frontend-vitest',
            authoritativeRaw: `${plan.coverageRoot}/backend-merged/coverage.json`,
            exchangeFormats: [`${plan.coverageRoot}/backend-merged/coverage.cobertura.xml`],
            sources: { backend: true, frontend: true, mergeMethod: 'covered-over-total-weighted' }
        });
        const artifacts = status === 'clean-success' ? producer.outputs.map((output) =>
        {
            const reference = write(output.path, output.role === 'summary' ? summary
                : output.role === 'scope' ? { status: 'ok', summaryFile: `${plan.coverageRoot}/merged/Summary.json`, summary: summary.summary }
                    : { synthetic: true, producerId });
            const attemptPath = `outputs/${output.role}.json`;
            write(`${base}/${attemptPath}`, fs.readFileSync(path.join(root, output.path)));
            return { role: output.role, ...reference, attemptPath };
        }) : [];
        write(`${base}/stdout.log`, 'synthetic stdout');
        write(`${base}/stderr.log`, 'synthetic stderr');
        const replay = sealReplayPlan({
            schema: 'fsusblog.test-execution-replay-plan.v1',
            source: { commit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint },
            producer: { id: producerId, framework: 'node-test' }, run: { id: identity.runId, mode: 'qualification' },
            rootSeed: `seed256:${'ab'.repeat(32)}`, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }], randomStreams: [],
            ...planExactShards({ testIds: [canonicalTestId({ framework: 'node-test', source: 'tests/tools/atomic-coverage-inputs.test.mjs', name: ['synthetic'] })] }),
            workers: { ids: ['worker-a'], assignmentPolicy: 'framework-owned-after-seal' },
            frameworkModes: [{ name: 'retry', value: 'disabled' }],
            schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false }, schedulerShuffleSeed: 'synthetic-seed',
            command: { executable: producer.command[0], args: producer.command.slice(1), environmentDigest: digestCanonical({}) }
        });
        const authorityReferences = ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind) =>
        {
            const ref = write(`${base}/${kind}.json`, kind === 'replay-plan' ? replay : { synthetic: true, kind });
            const verification = write(`${base}/${kind}.verification.json`, { synthetic: true, kind });
            const reference = { kind, artifactPath: ref.path, artifactDigest: ref.digest,
                verificationReceiptPath: verification.path, verificationReceiptDigest: verification.digest };
            authorities.set(`${kind}:${ref.path}:${ref.digest}:${verification.digest}`, {
                verified: true, authorityDigest: ref.digest, verificationReceiptDigest: verification.digest,
                identity: { producerId, schedulerRunId: identity.runId, sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint }
            });
            return reference;
        });
        const artifactDigests = Object.fromEntries([
            ...artifacts.map((item) => [item.attemptPath, item.digest]),
            ...['stdout.log', 'stderr.log'].map((file) => [file, sha256(fs.readFileSync(path.join(root, base, file)))])
        ].sort(([left], [right]) => left.localeCompare(right)));
        const receipt = sealContentDigest({
            schema: 'fsusblog.test-attempt-receipt.v1', producerId, attemptNumber: 1, maxAttempts: 1,
            sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint, schedulerRunId: identity.runId,
            command: producer.command, commandDigest: digestCanonical(producer.command),
            executionEnvelopeDigest: authorityReferences[0].artifactDigest, replayPlanDigest: authorityReferences[1].artifactDigest,
            temporalContextDigest: authorityReferences[2].artifactDigest, authorityReferences,
            startedAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:00.001Z', durationMs: 1,
            exitCode: status === 'clean-success' ? 0 : 1, signal: null,
            failureClass: status === 'clean-success' ? null : 'product', failureKind: status === 'clean-success' ? null : 'synthetic-failure',
            failedTestIds: [], executedTestIds: replay.testEnumerationOrder, stdoutPath: 'stdout.log', stderrPath: 'stderr.log',
            artifactPaths: Object.keys(artifactDigests).sort(), artifactDigests,
            firstFailure: status !== 'clean-success', retryDecision: status === 'clean-success' ? 'not-applicable' : 'policy-denied',
            retryPolicyId: 'correctness-first-attempt', status
        });
        return { attemptRef: write(`${base}/receipt.json`, receipt), artifacts };
    };
    return { root, plan, identity, write, makeMaterial,
        verifyAuthority: (ref) => authorities.get(`${ref.kind}:${ref.artifactPath}:${ref.artifactDigest}:${ref.verificationReceiptDigest}`) };
}
