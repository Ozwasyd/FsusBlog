import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { controlledRequiredEvidenceFixture } from './fixtures/required-evidence-controlled-owner.mjs';
const { loadCanonicalRequiredEvidenceCatalog } = await import(new URL('../../tools/test-matrix/required-evidence-catalog.mjs', import.meta.url));
const { createDomainVerifierImportClosure } = await import(new URL('../../tools/release/required-evidence-verifier-registry.mjs', import.meta.url));
const { registerRequiredEvidenceVerifierImports } = await import(new URL('../../tools/release/register-required-evidence-verifier-imports.mjs', import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('dynamic owner import dependencies derive exactly from the canonical catalog, not an independent authority list', () =>
{
    const catalog = loadCanonicalRequiredEvidenceCatalog();
    const closure = createDomainVerifierImportClosure({ catalog, repositoryRoot });
    assert.deepEqual(closure.dependencies, [...new Set(catalog.entries.map((entry) => entry.producerVerifier.split(':')[0]))].sort());
    assert.equal(closure.kind, 'runtime-module-path');
    assert.equal(closure.owner, 'tools/release/required-evidence-verifier-registry.mjs');
    assert.deepEqual(registerRequiredEvidenceVerifierImports({ repositoryRoot }), closure);
});

test('closure writer preserves every other indexed owner and refuses duplicate, missing, drifted or extra dependencies', (t) =>
{
    const fixture = controlledRequiredEvidenceFixture(t, { preserveCanonicalVerifierRefs: true });
    const config = path.join(fixture.repositoryRoot, 'config/testing');
    fs.mkdirSync(config, { recursive: true });
    const owner = 'tools/release/required-evidence-verifier-registry.mjs';
    fs.copyFileSync(path.join(repositoryRoot, owner), path.join(fixture.repositoryRoot, owner));
    fs.writeFileSync(path.join(config, 'required-evidence-authority-ledger.json'), JSON.stringify(fixture.catalog));
    const file = path.join(config, 'release-final-execution-authority-index.json');
    const index = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/testing/release-final-execution-authority-index.json')));
    index.runtimeDynamicImports = index.runtimeDynamicImports.filter((entry) => entry.owner !== owner);
    const others = structuredClone(index.runtimeDynamicImports);
    fs.writeFileSync(file, JSON.stringify(index));
    assert.throws(() => registerRequiredEvidenceVerifierImports({ repositoryRoot: fixture.repositoryRoot }), /missing, duplicated/u);
    registerRequiredEvidenceVerifierImports({ repositoryRoot: fixture.repositoryRoot, write: true });
    const canonical = JSON.parse(fs.readFileSync(file));
    assert.deepEqual(canonical.runtimeDynamicImports.filter((entry) => entry.owner !== owner), others);
    for (const mutate of [
        (doc) => doc.runtimeDynamicImports.push(doc.runtimeDynamicImports.at(-1)),
        (doc) => doc.runtimeDynamicImports.at(-1).dependencies.pop(),
        (doc) => doc.runtimeDynamicImports.at(-1).dependencies.push('tools/undeclared-owner.mjs'),
        (doc) => doc.runtimeDynamicImports.at(-1).sourceDigest = `sha256:${'a'.repeat(64)}`
    ])
    {
        const changed = structuredClone(canonical);
        mutate(changed);
        fs.writeFileSync(file, JSON.stringify(changed));
        assert.throws(() => registerRequiredEvidenceVerifierImports({ repositoryRoot: fixture.repositoryRoot }), /canonical catalog\/source/u);
    }
});
