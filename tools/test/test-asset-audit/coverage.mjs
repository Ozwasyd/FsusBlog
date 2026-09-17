import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function readSummary(file)
{
    if (!fs.existsSync(file))
    {
        return null;
    }
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { summary: value.summary ?? null, totals: value.totals ?? null, producer: value.producer ?? null };
}

export function collectAuditCoverage(root, layerReceipts)
{
    const backendPassed = layerReceipts.find((entry) => entry.id === 'backend-xunit')?.outcome === 'passed';
    const frontendPassed = layerReceipts.find((entry) => entry.id === 'frontend-vitest')?.outcome === 'passed';
    let mergeError = null;
    if (backendPassed && frontendPassed)
    {
        const result = spawnSync('bash', ['tools/coverage/merge-coverage.sh'], { cwd: root, encoding: 'utf8' });
        if (result.status !== 0)
        {
            mergeError = String(result.stderr || result.stdout || 'coverage merge failed').trim();
        }
    }
    const coverageRoot = path.join(root, '.tmp/coverage');
    return {
        status: backendPassed && frontendPassed && !mergeError ? 'available' : 'blocked',
        blockedReasons: [
      !backendPassed ? 'backend-coverage-producer-not-passed' : null,
      !frontendPassed ? 'frontend-coverage-producer-not-passed' : null,
      mergeError
        ].filter(Boolean),
        backend: backendPassed ? readSummary(path.join(coverageRoot, 'backend-merged/Summary.json')) : null,
        frontend: frontendPassed ? readSummary(path.join(coverageRoot, 'frontend/Summary.json')) : null,
        merged: backendPassed && frontendPassed && !mergeError ? readSummary(path.join(coverageRoot, 'merged/Summary.json')) : null
    };
}
