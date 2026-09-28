import fs from 'node:fs';
import path from 'node:path';

import { materializeEsmFixture } from './esm-fixture-materializer.mjs';

/** Materialize the current runner closure without changing the legacy fixture's sealed import owner. */
export function materializeTestMatrixRunner(repositoryRoot, fixtureRoot)
{
    const workflowDirectory = path.join(fixtureRoot, '.github/workflows');
    const testingConfigDirectory = path.join(fixtureRoot, 'config/testing');
    const testDirectory = path.join(fixtureRoot, 'tests');
    fs.mkdirSync(workflowDirectory, { recursive: true });
    fs.mkdirSync(testingConfigDirectory, { recursive: true });
    fs.mkdirSync(testDirectory, { recursive: true });
    const fixture = materializeEsmFixture({
        repositoryRoot,
        fixtureRoot,
        entries: [
            'tools/run-test-matrix.mjs',
            'tools/test-matrix/production-build-gc.mjs',
            'tools/test/measurement-noise-envelope.mjs',
            'tools/test/attempt-runner.mjs',
            'tools/test/bundles/run-bundle.mjs',
            'tools/test/temporal-context.mjs',
            'tools/test/physical-execution-unix-bootstrap.mjs',
            'tools/test/physical-execution-linux-systemd-bootstrap.mjs'
        ],
        // Entry-owned scripts and canonical inputs read at runtime, rather than imported as ESM.
        assets: [
            'tools/test/physical-execution-linux-preexec.py',
            'tools/test/physical-execution-nested-socket.py',
            'tools/test/physical-execution-windows-job.ps1',
            'tools/test-matrix/windows-job-members.ps1',
            'tools/test-matrix/windows-job-supervisor.ps1',
            'tools/test/lanes/release-final.sh',
            'tests/fixtures/test-matrix/release-final-evidence-inputs.json'
        ],
        allowedRoots: ['tools', 'src/frontend/scripts/fsusui-root.mjs',
            'tests/fixtures/test-matrix/release-final-evidence-inputs.json']
    });
    fs.copyFileSync(path.join(repositoryRoot, '.github/workflows/quality-gate.yml'),
        path.join(workflowDirectory, 'quality-gate.yml'));
    for (const file of [
        'correctness-attempt-producers.json',
        'correctness-budget-policy.json',
        'measurement-noise-policy.json',
        'physical-execution-process-policy.json',
        'release-reliability-scenario-catalog.json',
        'replay-qualification-producers.json',
        'temporal-callsite-dispositions.json',
        'temporal-policy.json',
        'test-execution-envelope-applicability.json'
    ])
    {
        fs.copyFileSync(path.join(repositoryRoot, 'config/testing', file),
            path.join(testingConfigDirectory, file));
    }
    fs.copyFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), path.join(testDirectory, 'matrix.yml'));
    return fixture.entryFiles[0];
}
