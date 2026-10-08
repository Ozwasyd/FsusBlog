import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    captureMemoryCandidate,
    produceMemoryInventory,
    validateMemoryBoundaries,
    verifyMemoryInventory
// eslint-disable-next-line import-x/no-relative-parent-imports -- Tests consume the canonical inventory governance owner.
} from '../../tools/governance/memory-allocation-inventory.mjs';

function fixture(context)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-memory-inventory-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (relative, content) =>
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    };
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'memory-fixture@example.invalid');
    git('config', 'user.name', 'Memory inventory fixture');
    write('src/backend/Frame.cs', 'class Frame { byte[] bytes; }\n');
    write('src/backend/NoMatches.cs', 'class NoMatches {}\n');
    write('src/backend/FsusBlog.Server.csproj', '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n');
    write('tools/governance/memory-allocation-inventory.mjs', fs.readFileSync(new URL('../../tools/governance/memory-allocation-inventory.mjs', import.meta.url)));
    write('tests/matrix.yml', 'fixture: not runtime qualification\n');
    write('tests/backend/Unit/FrameTests.cs', '// fixture test owner\n');
    const catalog = {
        schema: 'fsusblog.memory-allocation-boundaries.v1',
        scope: 'inventory-only',
        policy: {
            default: 'Auto',
            disabled: 'stop-new-probes-and-use-then-drain',
            required: 'never-override-safety-qualification-or-budgets'
        },
        authorities: ['publication', 'revocation', 'queue-delivery', 'configuration', 'test-topology']
            .map((responsibility) => ({ responsibility, path: 'tests/matrix.yml', disposition: 'reuse-do-not-replace' })),
        traces: [{
            id: 'fixture-frame', pathStatus: 'baseline-reported', producer: 'Frame', owner: 'Frame',
            consumers: 'fixture consumer', releaseEvent: 'fixture last reference', capacityModel: 'array length',
            frequency: 'fixture call', asyncEscape: 'fixture task', classification: 'unclassified',
            eligibilityOwner: 'fixture data owner', migrationDisposition: 'deny', observationHeadroom: 'observe managed only',
            testOwner: 'tests/backend/Unit/FrameTests.cs',
            permissions: {
                disk: false, device: false, sharing: false, deduplication: false, crossGenerationReuse: false, staleServing: false
            },
            evidence: [{ path: 'src/backend/Frame.cs', anchor: 'class Frame' }]
        }]
    };
    const saveCatalog = () => write('config/development/memory-allocation-boundaries.json', `${JSON.stringify(catalog)}\n`);
    saveCatalog();
    git('add', '.');
    git('commit', '-qm', 'fixture initial source');
    return { root, write, git, catalog, saveCatalog };
}

test('independent discovery accounts for every required pattern and keeps generated/vendor in the denominator', (context) =>
{
    const { root, write } = fixture(context);
    write('src/backend/All.cs', [
        'byte[] data = new byte[8];', 'data.ToArray();', 'new MemoryStream();', 'ArrayPool<byte>.Shared;',
        'MemoryPool<byte>.Shared;', 'NativeMemory.Alloc(4);', 'GCHandle.Alloc(data);', 'File.ReadAllBytes("x");',
        'File.ReadAllBytesAsync("x");', 'writer.GetMemory(4);', 'writer.GetSpan(4);', 'MemoryMarshal.TryGetArray(data);',
        'query.ToListAsync();', 'Encoding.UTF8.GetBytes("x");', 'malloc(4);', 'new ArrayBuffer(4);'
    ].join('\n'));
    write('src/backend/Frame.generated.cs', 'byte[] generated;\n');
    write('src/vendor/External.cs', 'byte[] external;\n');
    const inventory = produceMemoryInventory(root, 'pattern-fixture');
    const result = verifyMemoryInventory(root, inventory);
    assert.equal(inventory.sites.length, 19);
    assert.equal(result.coverage.unresolvedSites, 19);
    assert.equal(result.acceptance, 'NotVerified');
    assert.deepEqual(new Set(inventory.sites.map((site) => site.surface)),
        new Set(['owner-resolution-required', 'generated-path-candidate', 'vendor-path-candidate']));
    assert.throws(() => verifyMemoryInventory(root, inventory, { requireComplete: true }), /19 unresolved lexical sites/u);
});

test('nonmatching source mutation, addition, deletion and staged changes invalidate inventory', (context) =>
{
    for (const mutation of ['change', 'add', 'delete', 'stage'])
    {
        const { root, write, git } = fixture(context);
        const inventory = produceMemoryInventory(root, `mutation-${mutation}`);
        if (mutation === 'change')
        {
            write('src/backend/NoMatches.cs', 'class Changed {}\n');
        }
        else if (mutation === 'add')
        {
            write('src/backend/New.cs', 'class New {}\n');
        }
        else if (mutation === 'delete')
        {
            fs.unlinkSync(path.join(root, 'src/backend/NoMatches.cs'));
        }
        else
        {
            write('src/backend/NoMatches.cs', 'class Changed {}\n');
            git('add', 'src/backend/NoMatches.cs');
        }
        assert.throws(() => verifyMemoryInventory(root, inventory), /stale inventory/u);
    }
});

test('relabeling a stale receipt with a replacement SHA cannot conceal changed source', (context) =>
{
    const { root, write, git } = fixture(context);
    const inventory = produceMemoryInventory(root, 'relabel-negative');
    write('src/backend/Frame.cs', 'class Frame { byte[] newPayload; }\n');
    git('add', '.');
    git('commit', '-qm', 'fixture changed source');
    inventory.candidate.commit = git('rev-parse', 'HEAD').trim();
    assert.throws(() => verifyMemoryInventory(root, inventory), /stale inventory/u);
});

test('missing, extra, duplicate and altered site evidence is refused', (context) =>
{
    const { root } = fixture(context);
    const original = produceMemoryInventory(root, 'coverage-negative');
    for (const mutate of [
        (item) => item.sites.pop(),
        (item) => item.sites.push({ ...item.sites[0], id: 'invented-site' }),
        (item) => item.sites.push(item.sites[0]),
        (item) =>
        {
            item.sites[0].lineDigest = 'sha256:wrong';
        }
    ])
    {
        const inventory = structuredClone(original);
        mutate(inventory);
        assert.throws(() => verifyMemoryInventory(root, inventory), /discovery-to-inventory mismatch/u);
    }
});

test('missing eligibility owner and all migration permissions fail closed', (context) =>
{
    const { root, catalog } = fixture(context);
    const absentOwner = structuredClone(catalog);
    delete absentOwner.traces[0].eligibilityOwner;
    assert.throws(() => validateMemoryBoundaries(absentOwner, root), /eligibility owner missing/u);
    for (const classification of ['unclassified', 'private-sensitive', 'durable-authoritative', 'public-immutable'])
    {
        const unsafe = structuredClone(catalog);
        unsafe.traces[0].classification = classification;
        unsafe.traces[0].permissions.disk = true;
        assert.throws(() => validateMemoryBoundaries(unsafe, root), /cannot authorize migration/u);
    }
});

test('duplicate/replaced authority, wrong Auto semantics and hidden enable flags are rejected', (context) =>
{
    const { root, catalog } = fixture(context);
    for (const mutate of [
        (item) => item.authorities.push(item.authorities[0]),
        (item) =>
        {
            item.authorities[0].disposition = 'replace';
        },
        (item) =>
        {
            item.policy.default = 'Preferred';
        },
        (item) =>
        {
            item.policy.enableNative = true;
        },
        (item) =>
        {
            item.scope = 'runtime';
        }
    ])
    {
        const invalid = structuredClone(catalog);
        mutate(invalid);
        assert.throws(() => validateMemoryBoundaries(invalid, root));
    }
});

test('unresolved coverage and toolchain identity cannot be fabricated into acceptance', (context) =>
{
    const { root } = fixture(context);
    const original = produceMemoryInventory(root, 'envelope-negative');
    for (const mutate of [
        (item) =>
        {
            item.acceptance = 'Passed';
        },
        (item) =>
        {
            item.coverage.unresolvedSites = 0;
            item.coverage.resolvedSites = item.coverage.discoveredSites;
        },
        (item) =>
        {
            item.unresolved = [];
        },
        (item) =>
        {
            item.toolchain.nodeExecutableDigest = 'sha256:wrong';
        },
        (item) =>
        {
            item.traces[0].releaseEvent = 'function return';
        }
    ])
    {
        const invalid = structuredClone(original);
        mutate(invalid);
        assert.throws(() => verifyMemoryInventory(root, invalid));
    }
});

test('symlink source and offline dependency identity changes invalidate candidate', (context) =>
{
    const { root, write } = fixture(context);
    const initial = captureMemoryCandidate(root);
    write('src/backend/packages.lock.json', '{"version":1}\n');
    assert.notEqual(captureMemoryCandidate(root).worktreeFingerprint, initial.worktreeFingerprint);
    fs.symlinkSync('Frame.cs', path.join(root, 'src/backend/Alias.cs'));
    assert.throws(() => captureMemoryCandidate(root), /symbolic inventory input/u);
});

test('candidate cannot bind evidence to a different producer implementation', (context) =>
{
    const { root, write } = fixture(context);
    const inventory = produceMemoryInventory(root, 'producer-negative');
    write('tools/governance/memory-allocation-inventory.mjs', '// different producer\n');
    assert.throws(() => captureMemoryCandidate(root), /differ from the loaded inventory producer/u);
    assert.throws(() => verifyMemoryInventory(root, inventory), /stale inventory/u);
});


test('explicit families reject missing, extra and multiply owned source paths without claiming semantic closure', (context) =>
{
    const { root, catalog, saveCatalog } = fixture(context);
    catalog.families = [{ ...catalog.traces[0], id: 'frame-family',
        sourcePaths: ['src/backend/Frame.cs'], exclusionReason: 'Unclassified fixture cannot migrate' }];
    saveCatalog();
    const inventory = produceMemoryInventory(root, 'family-fixture');
    assert.equal(inventory.familyMapping.length, 1);
    assert.equal(inventory.familyMapping[0].semanticLifetime, 'NotVerified');
    assert.equal(verifyMemoryInventory(root, inventory).coverage.resolvedSites, 0);
    const forged = structuredClone(inventory);
    forged.familyMapping[0].semanticLifetime = 'Passed';
    assert.throws(() => verifyMemoryInventory(root, forged), /family, support boundary/u);
    catalog.families.push({ ...catalog.families[0], id: 'duplicate-owner' });
    saveCatalog();
    assert.throws(() => produceMemoryInventory(root, 'duplicate-family'), /duplicate source family/u);
    catalog.families.pop();
    catalog.families[0].sourcePaths.push('src/backend/NoMatches.cs');
    saveCatalog();
    assert.throws(() => produceMemoryInventory(root, 'extra-family'), /extra family source/u);
    catalog.families[0].sourcePaths = ['src/backend/NoMatches.cs'];
    saveCatalog();
    assert.throws(() => produceMemoryInventory(root, 'missing-family'), /extra family source|unexplained family source/u);
});


test('installed SDK syntax observer distinguishes creation, reference, literal and trivia without promoting ownership',
    { skip: !process.env.FSUS_MEMORY_SYNTAX_OBSERVER }, (context) =>
    {
        const { root, write, catalog, saveCatalog } = fixture(context);
        const observer = 'tools/governance/memory-syntax-observer/';
        for (const name of ['MemorySyntaxObserver.cs', 'FsusBlog.MemorySyntaxObserver.csproj'])
        {
            write(observer + name, fs.readFileSync(new URL('../../' + observer + name, import.meta.url)));
        }
        write('src/backend/Frame.cs', [
            'class Frame {',
            'byte[] data = new byte[4];',
            'byte[] Copy() => data.ToArray();',
            'string note = "byte[]";',
            '// byte[] is a documentation reference',
            '}'
        ].join('\n'));
        catalog.syntaxObserver = { source: observer + 'MemorySyntaxObserver.cs', project: observer + 'FsusBlog.MemorySyntaxObserver.csproj' };
        catalog.families = [{ ...catalog.traces[0], id: 'frame-family',
            sourcePaths: ['src/backend/Frame.cs'], exclusionReason: 'Fixture stays migration denied' }];
        saveCatalog();
        const inventory = produceMemoryInventory(root, 'syntax-fixture');
        const roles = new Set(inventory.syntax.observations.flatMap((item) => item.facts.map((fact) => fact.role)));
        for (const role of ['array-creation', 'declaration-or-reference', 'literal-reference', 'trivia-or-disabled-source', 'invocation'])
        {
            assert.ok(roles.has(role), role);
        }
        assert.deepEqual(inventory.syntax.parseDiagnostics, []);
        assert.ok(inventory.syntax.artifacts.length >= 3);
        assert.equal(verifyMemoryInventory(root, inventory).acceptance, 'NotVerified');
        const forged = structuredClone(inventory);
        forged.syntax.observations[0].facts[0].capacityModel = 'invented unlimited capacity';
        assert.throws(() => verifyMemoryInventory(root, forged), /syntax observation changed/u);
    });
