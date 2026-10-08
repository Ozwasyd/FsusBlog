import path from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';

import { digestCanonical, sealContentDigest, sha256 } from '../test/attempt-provenance.mjs';

export const coverageProducerIds = Object.freeze([
    'coverage-backend', 'coverage-frontend', 'coverage-merge',
    'coverage-scope-snapshot', 'coverage-threshold-merged',
    'coverage-threshold-backend', 'coverage-threshold-frontend'
]);
const policyVariables = Object.freeze([
    'FSUSBLOG_COVERAGE_LINE_THRESHOLD', 'FSUSBLOG_COVERAGE_BRANCH_THRESHOLD',
    'FSUSBLOG_COVERAGE_METHOD_THRESHOLD', 'FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD',
    'FSUSBLOG_BACKEND_COVERAGE_LINE_THRESHOLD', 'FSUSBLOG_BACKEND_COVERAGE_BRANCH_THRESHOLD',
    'FSUSBLOG_BACKEND_COVERAGE_METHOD_THRESHOLD', 'FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD',
    'FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD', 'FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD',
    'FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD'
]);
const sourcePaths = Object.freeze([
    'tools/coverage/collect-backend-coverage.sh', 'tools/coverage/collect-frontend-coverage.sh',
    'tools/coverage/backend-coverage-pipeline.mjs', 'tools/coverage/merge-coverage.sh',
    'tools/coverage/check-scope-snapshot.sh', 'tools/coverage/check-threshold.sh',
    'tools/test/lanes/coverage-threshold.sh', 'tools/test/lanes/_suite-support.sh',
    'tests/coverage-policy.yml', 'src/frontend/package.json'
]);

export function requireCoverage(condition, message)
{
    if (!condition) throw new Error(`coverage.atomic-input-invalid: ${message}`);
}

/** Read only an explicit repository-relative regular file, rejecting symlink ancestors. */
export function readCoverageBytes(root, relative)
{
    requireCoverage(typeof relative === 'string' && relative.length > 0
        && !relative.includes('\\') && !path.posix.isAbsolute(relative)
        && relative.split('/').every((part) => part && part !== '.' && part !== '..'), 'invalid explicit file path');
    const segments = relative.split('/');
    let current = path.resolve(root);
    for (const [index, segment] of segments.entries())
    {
        current = path.join(current, segment);
        const stat = lstatSync(current);
        requireCoverage(!stat.isSymbolicLink() && (index === segments.length - 1 ? stat.isFile() : stat.isDirectory()),
            `nonregular or symlink path: ${relative}`);
    }
    return readFileSync(current);
}

/**
 * Domain migration input for the canonical #2248 compiler, not an executable scheduler.
 * Local and CI callers supply the same identity, policy overrides and coverage root.
 * Existing collector/checker commands retain instrumentation and policy semantics.
 */
export function createCoveragePlan({ root, identity, coverageRoot = '.tmp/coverage', environment = {} })
{
    requireCoverage(identity && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(identity.runId), 'explicit runId required');
    requireCoverage(/^[0-9a-f]{40}$/u.test(identity.sourceCommit), 'exact sourceCommit required');
    requireCoverage(/^sha256:[0-9a-f]{64}$/u.test(identity.sourceFingerprint), 'sourceFingerprint required');
    requireCoverage(Object.keys(identity).sort().join(',') === 'runId,sourceCommit,sourceFingerprint', 'unknown identity field');
    requireCoverage(typeof coverageRoot === 'string' && /^\.tmp\/coverage(?:\/[a-zA-Z0-9._-]+)*$/u.test(coverageRoot)
        && !coverageRoot.split('/').includes('..'), 'coverage root must be explicit task-local path');
    requireCoverage(Object.keys(environment).every((key) => policyVariables.includes(key)), 'unknown policy override');
    const overrides = Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)
        .map(([key, value]) =>
        {
            requireCoverage(typeof value === 'string' && !value.includes('\0'), `invalid policy value: ${key}`);
            return [key, value];
        }));
    const effective = (key, fallback) => overrides[key] || fallback;
    const common = {
        FSUSBLOG_COVERAGE_ROOT: coverageRoot,
        FSUSBLOG_TEST_RUN_ID: identity.runId,
        FSUSBLOG_TEST_SOURCE_COMMIT: identity.sourceCommit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: identity.sourceFingerprint,
        FSUSBLOG_COVERAGE_SKIP_TESTS: '0'
    };
    const summaries = {
        backend: `${coverageRoot}/backend-merged/Summary.json`,
        frontend: `${coverageRoot}/frontend/Summary.json`,
        merged: `${coverageRoot}/merged/Summary.json`
    };
    const output = (role, file) => ({ role, path: file });
    const producer = (id, script, dependsOn, outputs, variables = {}) => ({
        id, dependsOn, retryPolicyId: 'correctness-first-attempt', allowedRetries: 0, attemptNumber: 1,
        command: ['env', ...Object.entries({ ...common, ...variables }).sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}=${value}`), 'bash', script], outputs
    });
    const threshold = (domain, parent, defaults) =>
    {
        const prefix = domain === 'merged' ? 'FSUSBLOG_COVERAGE' : `FSUSBLOG_${domain.toUpperCase()}_COVERAGE`;
        const method = effective(`${prefix}_${domain === 'frontend' ? 'FUNCTION' : 'METHOD'}_THRESHOLD`, defaults[2]);
        return producer(`coverage-threshold-${domain}`, 'tools/coverage/check-threshold.sh', [parent], [], {
            FSUSBLOG_COVERAGE_THRESHOLD_LABEL: domain,
            FSUSBLOG_COVERAGE_SUMMARY_FILE: summaries[domain],
            FSUSBLOG_COVERAGE_LINE_THRESHOLD: effective(`${prefix}_LINE_THRESHOLD`, defaults[0]),
            FSUSBLOG_COVERAGE_BRANCH_THRESHOLD: effective(`${prefix}_BRANCH_THRESHOLD`, defaults[1]),
            FSUSBLOG_COVERAGE_METHOD_THRESHOLD: method,
            FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD: domain === 'frontend' ? method
                : effective('FSUSBLOG_COVERAGE_FUNCTION_THRESHOLD', method)
        });
    };
    const producers = [
        producer('coverage-backend', 'tools/coverage/collect-backend-coverage.sh', [], [
            output('summary', summaries.backend), output('raw', `${coverageRoot}/backend-merged/coverage.json`),
            output('exchange', `${coverageRoot}/backend-merged/coverage.cobertura.xml`),
            output('universe', `${coverageRoot}/backend/universe.json`)
        ]),
        producer('coverage-frontend', 'tools/coverage/collect-frontend-coverage.sh', [], [
            output('summary', summaries.frontend), output('raw', 'src/frontend/coverage/unit/coverage-summary.json')
        ], Object.fromEntries(['LINE', 'BRANCH', 'FUNCTION', 'STATEMENT'].map((metric) =>
            [`FSUSBLOG_FRONTEND_COVERAGE_${metric}_THRESHOLD`, effective(`FSUSBLOG_FRONTEND_COVERAGE_${metric}_THRESHOLD`, '0')]))),
        producer('coverage-merge', 'tools/coverage/merge-coverage.sh', ['coverage-backend', 'coverage-frontend'],
            [output('summary', summaries.merged)]),
        producer('coverage-scope-snapshot', 'tools/coverage/check-scope-snapshot.sh', ['coverage-merge'],
            [output('scope', `${coverageRoot}/scope-snapshot.json`)], { FSUSBLOG_COVERAGE_SUMMARY_FILE: summaries.merged }),
        threshold('merged', 'coverage-merge', ['35', '20', '30']),
        threshold('backend', 'coverage-backend', ['75', '55', '95']),
        threshold('frontend', 'coverage-frontend', ['0', '0', '0'])
    ];
    return sealContentDigest({
        schema: 'fsusblog.atomic-coverage-plan-input.v1', identity: { ...identity }, coverageRoot,
        environment: overrides, sourceDigests: Object.fromEntries(sourcePaths.map((file) => [file, sha256(readCoverageBytes(root, file))])),
        producers, projections: [
            { id: 'coverage-gate-summary', settledDependsOn: coverageProducerIds.slice(0, 3) },
            { id: 'coverage-threshold-summary', settledDependsOn: coverageProducerIds.slice(3) }
        ], qualificationEligible: false
    });
}

/** Reject plan mutation and source/policy drift before producing a command or projection. */
export function validateCoveragePlan(plan, root)
{
    const expected = createCoveragePlan({ root, identity: plan?.identity, coverageRoot: plan?.coverageRoot, environment: plan?.environment });
    requireCoverage(digestCanonical(plan) === digestCanonical(expected), 'plan or command/policy source drift');
    return plan;
}
