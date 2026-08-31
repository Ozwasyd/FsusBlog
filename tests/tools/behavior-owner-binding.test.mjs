import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs';
import {
    assertBehaviorOwnerBindings,
    formatOwnerBindingReport,
    matchSymbol,
    parseOwnerBindingsFromSource,
    scanBehaviorOwnerBindings
} from '../../tools/contracts/behavior-owner-binding.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const expectedRepositoryOwners = Object.freeze([
    {
        behaviorId: 'article-comment-lifecycle-outbox',
        sourcePath: 'tools/fact-extractors/content-lifecycle/extract.mjs',
        symbol: 'extract'
    },
    {
        behaviorId: 'authentication-session-permission',
        sourcePath: 'tools/fact-extractors/auth-session-permission/extract.mjs',
        symbol: 'extract'
    },
    {
        behaviorId: 'binary-api-aeds-contract',
        sourcePath: 'tools/fact-extractors/openapi-aeds/extract.mjs',
        symbol: 'extract'
    },
    {
        behaviorId: 'browserless-production-correctness',
        sourcePath: 'tools/run-test-matrix.mjs',
        symbol: 'main'
    },
    {
        behaviorId: 'code-intent-governance',
        sourcePath: 'tools/governance/check-code-intent.mjs',
        symbol: 'checkCodeIntent'
    },
    {
        behaviorId: 'configuration-error-security-policy',
        sourcePath: 'tools/fact-extractors/config-error-security-policy/extract.mjs',
        symbol: 'extract'
    },
    {
        behaviorId: 'deployment-blue-green-runtime-role',
        sourcePath: 'tools/run-test-matrix.mjs',
        symbol: 'validateDeploymentDomainAuthorities'
    },
    {
        behaviorId: 'document-lifecycle-governance',
        sourcePath: 'tools/docs/document-lifecycle.mjs',
        symbol: 'ValidateDocumentLifecycle'
    },
    {
        behaviorId: 'release-final-aggregate-contract',
        sourcePath: 'tools/run-test-matrix.mjs',
        symbol: 'validateReleaseFinalAggregateAuthorities'
    },
    {
        behaviorId: 'test-asset-audit-reconciliation',
        sourcePath: 'tools/test/run-test-asset-audit.mjs',
        symbol: 'main'
    }
]);

function fixtureRoot()
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-behavior-owner-'));
    for (const relative of [
        'config/contracts/behavior-contracts.json',
        'config/contracts/generated-fact-sections.json',
        'config/schemas/behavior-contract-catalog.schema.json',
        'tests/coverage-registry.json',
        'config/development/document-lifecycle.json'
    ])
    {
        const target = path.join(directory, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(path.join(root, relative), target);
    }
    const catalog = loadFixtureCatalog(directory);
    for (const extractor of catalog.extractors)
    {
        const target = path.join(directory, extractor.path);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(path.join(root, extractor.path), target);
    }
    return directory;
}

function write(repositoryRoot, relative, source)
{
    const target = path.join(repositoryRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
    return relative;
}

function seedRequiredOwners(repositoryRoot)
{
    write(repositoryRoot, 'tools/test/run-test-asset-audit.mjs', '// BEHAVIOR-OWNER: test-asset-audit-reconciliation\nfunction main() {}\n');
    write(repositoryRoot, 'tools/governance/check-code-intent.mjs', '// BEHAVIOR-OWNER: code-intent-governance\nexport function checkCodeIntent() {}\n');
    write(repositoryRoot, 'tools/docs/document-lifecycle.mjs', '// BEHAVIOR-OWNER: document-lifecycle-governance\nexport function ValidateDocumentLifecycle() {}\n');
    write(repositoryRoot, 'tools/run-test-matrix.mjs', [
        '// BEHAVIOR-OWNER: browserless-production-correctness',
        'async function main() {}',
        '// BEHAVIOR-OWNER: release-final-aggregate-contract',
        'function validateReleaseFinalAggregateAuthorities() {}',
        '// BEHAVIOR-OWNER: deployment-blue-green-runtime-role',
        'function validateDeploymentDomainAuthorities() {}',
        ''
    ].join('\n'));
}

function seedOwnerEntrypointsWithoutMarkers(repositoryRoot)
{
    for (const owner of expectedRepositoryOwners)
    {
        const asyncPrefix = owner.symbol === 'main' ? 'async ' : '';
        write(repositoryRoot, owner.sourcePath, `${asyncPrefix}function ${owner.symbol}() {}\n`);
    }
}

function loadFixtureCatalog(repositoryRoot)
{
    return JSON.parse(readFileSync(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'), 'utf8'));
}

test('repository active behaviors have exact one-owner marker bindings and receipts', () =>
{
    const report = formatOwnerBindingReport(scanBehaviorOwnerBindings({ repositoryRoot: root }));
    assert.equal(report.errors.length, 0, report.errors.join('\n'));
    assert.equal(report.status, 'ok');
    assert.equal(report.bindingCount, expectedRepositoryOwners.length);
    assert.match(report.catalogDigest, /^[a-f0-9]{64}$/u);
    assert.ok(report.worktreeDigest);
    const byId = new Map(report.bindings.map((binding) => [binding.behaviorId, binding]));
    assert.deepEqual(
        report.bindings.map(({ behaviorId, sourcePath, symbol }) => ({
            behaviorId,
            sourcePath,
            symbol
        })),
        expectedRepositoryOwners
    );
    assert.equal(byId.get('code-intent-governance')?.bindingKind, 'marker');
    assert.equal(byId.get('code-intent-governance')?.language, 'javascript');
    for (const binding of report.bindings)
    {
        assert.equal(binding.status, 'ok');
        assert.match(binding.sourceDigest, /^[a-f0-9]{64}$/u);
        assert.equal(binding.catalogDigest, report.catalogDigest);
        assert.equal(binding.worktreeDigest, report.worktreeDigest);
        assert.equal(binding.role, undefined);
    }
    execFileSync('node', ['tools/contracts/check-behavior-owner-binding.mjs'], { cwd: root, stdio: 'inherit' });
});

test('C# attribute syntax binds a symbol without comment-marker fallback', () =>
{
    const source = `[BehaviorOwner("code-intent-governance")]
internal sealed class CodeIntentOwner
{
}
`;
    const scanned = parseOwnerBindingsFromSource({
        source,
        relativePath: 'src/shared/Contracts/Governance/CodeIntentOwner.cs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.deepEqual(scanned.errors, []);
    assert.equal(scanned.bindings.length, 1);
    assert.equal(scanned.bindings[0].bindingKind, 'attribute');
    assert.equal(scanned.bindings[0].symbol, 'CodeIntentOwner');
    assert.equal(scanned.bindings[0].language, 'csharp');
});

test('rejects dual syntax fallback on the same language surface', () =>
{
    const csharp = parseOwnerBindingsFromSource({
        source: '// BEHAVIOR-OWNER: code-intent-governance\npublic sealed class Wrong {}\n',
        relativePath: 'src/core/Wrong.cs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.match(csharp.errors.join('\n'), /\[BehaviorOwner\("id"\)\] only|comment markers are forbidden/u);

    const script = parseOwnerBindingsFromSource({
        source: '[BehaviorOwner("code-intent-governance")]\nexport function wrong() {}\n',
        relativePath: 'tools/wrong.mjs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.match(script.errors.join('\n'), /BEHAVIOR-OWNER markers only/u);
});

test('1) rejects two services bound to the same one-owner behavior', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredOwners(directory);
        write(directory, 'tools/extra-owner.mjs', '// BEHAVIOR-OWNER: code-intent-governance\nexport function secondOwner() {}\n');
        const report = scanBehaviorOwnerBindings({ repositoryRoot: directory, catalog: loadFixtureCatalog(directory) });
        assert.match(report.errors.join('\n'), /one-owner behavior has 2 owners/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('2) rejects controller-only binding while real owner is missing', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredOwners(directory);
        write(directory, 'tools/governance/check-code-intent.mjs', 'export function checkCodeIntent() {}\n');
        write(directory, 'tools/controllers/code-intent-controller.mjs', '// BEHAVIOR-OWNER: code-intent-governance\nexport function handleRequest() {}\n');
        const report = scanBehaviorOwnerBindings({ repositoryRoot: directory, catalog: loadFixtureCatalog(directory) });
        const text = report.errors.join('\n');
        assert.match(text, /controller\/adapter\/DTO path|real owner\/entrypoint must be tools\/governance\/check-code-intent\.mjs/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('3) rejects marker at file top without adjacent symbol', () =>
{
    const source = `// BEHAVIOR-OWNER: code-intent-governance

const unrelated = 1
export function later() {}
`;
    const scanned = parseOwnerBindingsFromSource({
        source,
        relativePath: 'tools/governance/orphan-marker.mjs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.match(scanned.errors.join('\n'), /not adjacent to a parseable symbol/u);
    assert.equal(scanned.bindings.length, 0);
});

test('4) rejects test helper declaring implementation owner', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredOwners(directory);
        write(directory, 'tests/helpers/fake-owner.mjs', '// BEHAVIOR-OWNER: code-intent-governance\nexport function fakeOwner() {}\n');
        const report = scanBehaviorOwnerBindings({ repositoryRoot: directory, catalog: loadFixtureCatalog(directory) });
        assert.match(report.errors.join('\n'), /tests\/docs\/fixtures\/generated cannot declare implementation owners/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('5) rejects residual marker after owner symbol deletion', () =>
{
    const source = `// BEHAVIOR-OWNER: code-intent-governance
// leftover after class deletion
const x = 1
`;
    const scanned = parseOwnerBindingsFromSource({
        source,
        relativePath: 'tools/governance/stale-marker.mjs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.match(scanned.errors.join('\n'), /not adjacent to a parseable symbol/u);
});

test('6) rejects empty wrapper kept only to preserve owner binding path', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredOwners(directory);
        write(directory, 'tools/governance/check-code-intent.mjs', `// BEHAVIOR-OWNER: code-intent-governance
export function checkCodeIntent() {
  return deprecatedAlias()
}

// BEHAVIOR-OWNER: code-intent-governance
export function deprecatedAlias() {}
`);
        const report = scanBehaviorOwnerBindings({ repositoryRoot: directory, catalog: loadFixtureCatalog(directory) });
        assert.match(report.errors.join('\n'), /one-owner behavior has 2 owners/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('7) rejects marker containing expected fact values', () =>
{
    const scanned = parseOwnerBindingsFromSource({
        source: '// BEHAVIOR-OWNER: code-intent-governance expected=5\nexport function checkCodeIntent() {}\n',
        relativePath: 'tools/governance/fact-marker.mjs',
        catalogDigest: 'd'.repeat(64)
    });
    assert.match(scanned.errors.join('\n'), /must not declare fact\/value field expected/u);
});

test('8) does not guess owners from coverage evidencePaths', () =>
{
    const directory = fixtureRoot();
    try
    {
    // Extractor files exist (as coverage evidencePaths would) but carry no owner markers.
        seedOwnerEntrypointsWithoutMarkers(directory);
        const catalog = loadFixtureCatalog(directory);
        const report = scanBehaviorOwnerBindings({ repositoryRoot: directory, catalog });
        assert.ok(report.errors.some((error) => /no implementation owner/u.test(error)));
        assert.equal(report.bindings.length, 0);
        assert.doesNotMatch(report.errors.join('\n'), /evidencePaths/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('zero-owner active behavior fails closed', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredOwners(directory);
        write(directory, 'tools/governance/check-code-intent.mjs', 'export function checkCodeIntent() {}\n');
        const report = scanBehaviorOwnerBindings({ repositoryRoot: directory, catalog: loadFixtureCatalog(directory) });
        assert.match(report.errors.join('\n'), /code-intent-governance active one-owner behavior has no implementation owner/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('many-owner role set is exact and finite', () =>
{
    const directory = fixtureRoot();
    try
    {
        seedRequiredOwners(directory);
        const catalog = loadFixtureCatalog(directory);
        const contract = catalog.contracts.find((entry) => entry.id === 'code-intent-governance');
        contract.implementationOwnerCardinality = 'many';
        contract.allowedImplementationOwnerRoles = ['primary', 'secondary'];
        write(directory, 'tools/governance/check-code-intent.mjs', '// BEHAVIOR-OWNER: code-intent-governance role=primary\nexport function checkCodeIntent() {}\n');
        write(directory, 'tools/governance/code-intent-secondary.mjs', '// BEHAVIOR-OWNER: code-intent-governance role=secondary\nexport function secondaryOwner() {}\n');
        writeFileSync(path.join(directory, 'config/contracts/behavior-contracts.json'), `${JSON.stringify(catalog, null, 2)}\n`);
        const ok = scanBehaviorOwnerBindings({ repositoryRoot: directory, catalog });
        assert.deepEqual(ok.errors, []);
        write(directory, 'tools/governance/code-intent-tertiary.mjs', '// BEHAVIOR-OWNER: code-intent-governance role=primary\nexport function tertiary() {}\n');
        const bad = scanBehaviorOwnerBindings({ repositoryRoot: directory, catalog });
        assert.match(bad.errors.join('\n'), /requires exactly 2 owners|bound more than once/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('symbol matcher recognizes supported language entrypoints', () =>
{
    assert.equal(matchSymbol('export function checkCodeIntent() {', 'javascript'), 'checkCodeIntent');
    assert.equal(matchSymbol('async function main() {', 'javascript'), 'main');
    assert.equal(matchSymbol('internal sealed class ArticleWriter', 'csharp'), 'ArticleWriter');
    assert.equal(matchSymbol('function Bootstrap() {', 'shell'), 'Bootstrap');
    assert.equal(matchSymbol('function(AddDecoder)', 'cmake'), 'AddDecoder');
    assert.equal(matchSymbol('class Decoder final {', 'cpp'), 'Decoder');
});

test('assertBehaviorOwnerBindings throws on repository failures only when broken', () =>
{
    assert.doesNotThrow(() => assertBehaviorOwnerBindings({ repositoryRoot: root, catalog: loadCatalog() }));
    const result = spawnSync('node', ['tools/contracts/check-behavior-owner-binding.mjs', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.bindingCount, expectedRepositoryOwners.length);
});
