import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    assertRuntimeAssetBoundary,
    materializeTestMatrixRunner
} from './support/esm-fixture-materializer-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('ESM fixture materializer requires literal runtime assets and rejects missing or linked assets', assertRuntimeAssetBoundary);

test('original scheduler fixture includes its runtime-read release and containment assets', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-scheduler-runtime-assets-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    materializeTestMatrixRunner(root, temp);
    for (const file of [
        'tools/test/lanes/release-final.sh',
        'tools/test/physical-execution-linux-preexec.py',
        'tools/test/physical-execution-windows-job.ps1',
        'tools/test-matrix/windows-job-members.ps1',
        'tools/test-matrix/windows-job-supervisor.ps1',
        'tests/fixtures/test-matrix/release-final-evidence-inputs.json'
    ])
    {
        assert.deepEqual(fs.readFileSync(path.join(temp, file)), fs.readFileSync(path.join(root, file)), file);
    }
});
