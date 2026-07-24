import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);

test('release-final script files do not contain recursive test or build producer invocations', () => {
    const files = [
        path.join(root, 'tools/test/lanes/release-final.sh'),
        path.join(root, 'tools/release/check-release-final.mjs')
    ];
    const forbiddenPattern = /dotnet test|vitest|playwright|bootstrap-acceptance|load-|soak|mutation|npm.*build/u;

    for (const file of files) {
        const content = readFileSync(file, 'utf8');
        assert.equal(
            forbiddenPattern.test(content),
            false,
            `${file} must not contain recursive test or build producer execution`
        );
    }
});

test('release-final tier in matrix uses summary executionMode without physical service/bootstrap dependencies', () => {
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const releaseFinalTier = matrix.tiers.find((tier) => tier.id === 'release-final');

    assert.ok(releaseFinalTier, 'matrix must contain release-final tier');
    assert.equal(releaseFinalTier.executionMode, 'summary');
    assert.deepEqual(releaseFinalTier.services ?? [], []);
    assert.equal(releaseFinalTier.requiresBootstrap, 'none');
    assert.equal(releaseFinalTier.requiresDotnet, false);

    assert.ok(
        Array.isArray(releaseFinalTier.requiresEvidenceFrom) && releaseFinalTier.requiresEvidenceFrom.length > 0,
        'release-final tier must declare requiresEvidenceFrom producers'
    );
});
