import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
const { validateEvidenceExecutionDeclaration, evidenceExecutionModes } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/projection-declaration.mjs')).href
);

test('matrix validates every executionMode declaration and exposes invalid release aggregate targets', async () => {
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const errors = [];

    for (const tier of matrix.tiers) {
        const mode = tier.executionMode ?? 'execute';
        if (!evidenceExecutionModes.includes(mode)) {
            errors.push(`${tier.id} executionMode is invalid: ${tier.executionMode}`);
        }

        errors.push(...validateEvidenceExecutionDeclaration(tier, matrix));

        const command = String(tier.command ?? '');
        if (command.includes('noop.sh')) {
            errors.push(`${tier.id} must not use noop.sh physical process scheduling; found ${command}`);
        }
    }

    for (const tierId of ['release-admin-console', 'release-auth-flow', 'release-authoring-flow', 'release-private-preview', 'release-error-boundary', 'release-aot-generation', 'release-static-asset-digest-coherence']) {
        assert.ok(errors.some((error) => error.includes(`${tierId}.commandKind`)), `${tierId} must not bypass summary validation`);
        assert.ok(errors.some((error) => error.includes(`unknown aggregate authority: ${tierId}`)), `${tierId} must not resolve as an aggregate authority`);
    }
    assert.ok(errors.some((error) => error.includes('release-aot-consumption.commandKind')));
    assert.ok(errors.some((error) => error.includes('release-rbac-negative.commandKind')));
});

test('canonical producer topologies define valid projectFrom dependencies and clear execution owners', async () => {
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const projectionTiers = matrix.tiers.filter((tier) => tier.executionMode === 'projection');

    assert.ok(projectionTiers.length > 0, 'matrix must define projection tiers');
    for (const tier of projectionTiers) {
        assert.ok(tier.executionOwner, `${tier.id} must declare executionOwner`);
        assert.ok(tier.projectFrom, `${tier.id} must declare projectFrom`);
        assert.ok(tier.projectionCatalog, `${tier.id} must declare projectionCatalog`);
    }
});
