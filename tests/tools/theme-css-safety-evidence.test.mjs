import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    readAndValidateThemeCssSafetyEvidence,
    validateThemeCssSafetyEvidence
} from '../../tools/release/theme-css-safety-evidence.mjs';

function validEvidence(overrides = {})
{
    return {
        schema: 'fsusblog.theme.css-safety.v1',
        themeId: 'fsusblog.theme.minimal-ink',
        status: 'ok',
        cssBytes: 42112,
        assetBytes: 210944,
        previewBytes: 120000,
        selectorCount: 312,
        maxSelectorDepth: 3,
        importantCount: 2,
        maxMotionDurationMs: 180,
        violations: [],
        warnings: [],
        ...overrides
    };
}

test('release consumer accepts bounded scanner evidence', () =>
{
    assert.deepEqual(validateThemeCssSafetyEvidence(validEvidence()), []);
});

test('release consumer fails closed on blocked, over-budget, or violation evidence', () =>
{
    assert.match(
        validateThemeCssSafetyEvidence(validEvidence({
            status: 'blocked',
            cssBytes: 65537,
            violations: [{ code: 'selector_scope_denied' }]
        })).join('\n'),
        /status must be ok[\s\S]*cssBytes[\s\S]*violations must be an empty array/u);
});

test('release consumer refuses symlink evidence', t =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-css-safety-evidence-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const target = path.join(directory, 'target.json');
    const link = path.join(directory, 'summary.json');
    fs.writeFileSync(target, JSON.stringify(validEvidence()));
    fs.symlinkSync(target, link);

    assert.throws(
        () => readAndValidateThemeCssSafetyEvidence(link),
        /regular non-symlink file/u);
});
