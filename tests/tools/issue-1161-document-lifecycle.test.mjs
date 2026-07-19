import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    BuildDocumentInventory,
    DocumentLifecycleSchema,
    ReadDocumentLifecyclePolicy,
    RenderDocumentIndex,
    ValidateDocumentLifecycle,
    WriteDocumentLifecycle
} = await import(pathToFileURL(path.join(root, 'tools/docs/document-lifecycle.mjs')).href);

function Write(rootDirectory, relative, content)
{
    const target = path.join(rootDirectory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function Fixture(t)
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-document-lifecycle-'));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    Write(fixtureRoot, 'docs/index.md', '# Documentation Index\n');
    Write(fixtureRoot, 'docs/current.md', '# Current\n\n```text\ncurrent\n```\n');
    Write(fixtureRoot, 'docs/development/document-lifecycle.md', '# Documentation Lifecycle\n');
    Write(fixtureRoot, 'docs/history/issue-1042-handoff.md', '# Historical\n');
    Write(fixtureRoot, 'docs/generated.md', '# Generated\n');
    Write(fixtureRoot, 'tools/generate.mjs', 'export {};\n');
    const policy = {
        schema: DocumentLifecycleSchema,
        lastVerifiedCommit: 'a'.repeat(40),
        maximumVerificationDistance: 100,
        statusRules: [
            { patterns: ['docs/generated.md'], status: 'generated' },
            { patterns: ['docs/**/issue-*'], status: 'historical' },
            { patterns: ['docs/**'], status: 'current' }
        ],
        ownerRules: [{ patterns: ['docs/**'], owner: 'governance' }],
        generatedDocuments: [{ path: 'docs/generated.md', producer: 'tools/generate.mjs' }],
        authorityClaims: [{ id: 'current', path: 'docs/current.md' }],
        closedIssues: [1042],
        retiredReferences: [{ token: 'RetiredSymbol' }],
        redirects: []
    };
    Write(fixtureRoot, 'config/development/document-lifecycle.json', `${JSON.stringify(policy, null, 4)}\n`);
    WriteDocumentLifecycle(fixtureRoot, policy);
    return { fixtureRoot, policy };
}

function Validate(fixtureRoot, policy)
{
    const inventory = BuildDocumentInventory(fixtureRoot, policy);
    return ValidateDocumentLifecycle(fixtureRoot, policy, inventory, RenderDocumentIndex(inventory), { validateGit: false });
}

test('repository document lifecycle inventory and generated index are current', () =>
{
    const policy = ReadDocumentLifecyclePolicy(root);
    const inventory = BuildDocumentInventory(root, policy);
    assert.equal(ValidateDocumentLifecycle(root, policy, inventory, RenderDocumentIndex(inventory)).length, 0);
    assert.ok(inventory.documents.length >= 300);
    assert.ok(inventory.documents.every((document) => document.owner && document.status && document.lastVerifiedCommit));
});

test('closed issue handoffs are historical and generated documents require a live producer', (t) =>
{
    const { fixtureRoot, policy } = Fixture(t);
    const currentIssue = structuredClone(policy);
    currentIssue.statusRules.unshift({ patterns: ['docs/history/issue-1042-handoff.md'], status: 'current' });
    WriteDocumentLifecycle(fixtureRoot, currentIssue);
    assert.ok(Validate(fixtureRoot, currentIssue).some((error) => error.includes('closed issue')));

    const missingProducer = structuredClone(policy);
    missingProducer.generatedDocuments[0].producer = 'tools/missing.mjs';
    WriteDocumentLifecycle(fixtureRoot, missingProducer);
    assert.ok(Validate(fixtureRoot, missingProducer).some((error) => error.includes('generated producer does not exist')));
});

test('duplicate authority, retired references and broken internal links fail closed', (t) =>
{
    const { fixtureRoot, policy } = Fixture(t);
    const duplicate = structuredClone(policy);
    duplicate.authorityClaims.push({ id: 'current', path: 'docs/index.md' });
    WriteDocumentLifecycle(fixtureRoot, duplicate);
    assert.ok(Validate(fixtureRoot, duplicate).some((error) => error.includes('duplicate source-of-truth authority ID')));

    Write(fixtureRoot, 'docs/current.md', '# Current\n\nRetiredSymbol\n\n[missing](missing.md)\n');
    const errors = Validate(fixtureRoot, policy);
    assert.ok(errors.some((error) => error.includes('retired reference RetiredSymbol')));
    assert.ok(errors.some((error) => error.includes('missing internal link missing.md')));
});

test('redirect map accepts removed sources and rejects live sources or missing targets', (t) =>
{
    const { fixtureRoot, policy } = Fixture(t);
    const valid = structuredClone(policy);
    valid.redirects = [{ from: 'docs/old.md', to: 'docs/current.md' }];
    WriteDocumentLifecycle(fixtureRoot, valid);
    assert.deepEqual(Validate(fixtureRoot, valid), []);

    const invalid = structuredClone(policy);
    invalid.redirects = [
        { from: 'docs/current.md', to: 'docs/generated.md' },
        { from: 'docs/missing.md', to: 'docs/also-missing.md' }
    ];
    WriteDocumentLifecycle(fixtureRoot, invalid);
    const errors = Validate(fixtureRoot, invalid);
    assert.equal(errors.filter((error) => error.includes('invalid document redirect')).length, 2);
});
