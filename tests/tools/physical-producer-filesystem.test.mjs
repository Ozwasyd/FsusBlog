import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    compilePhysicalProducerFilesystemPlan,
    observePhysicalProducerMount,
    physicalProducerFilesystemCatalogSchema,
    verifyPhysicalProducerFilesystemPlan
} = await import(new URL('../../tools/test-matrix/physical-producer-filesystem.mjs', import.meta.url));

function fixture(t)
{
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'physical-filesystem-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const builds = path.join(root, 'builds');
    fs.mkdirSync(source);
    fs.mkdirSync(builds);
    return {
        catalog: {
            schema: physicalProducerFilesystemCatalogSchema,
            domains: [
                { domainId: 'repository-source', rootIds: ['source'], sourceOfDeclaration: 'explicit repository source domain' },
                { domainId: 'production-output', rootIds: ['current-build'], sourceOfDeclaration: 'explicit production output domain' }
            ],
            producers: [
                {
                    producerId: 'source-check',
                    ownerKind: 'executable',
                    sourceOfDeclaration: 'explicit source-check access contract',
                    accesses: [{ rootId: 'source', domainId: 'repository-source', accessMode: 'read' }]
                },
                {
                    producerId: 'artifact-owner',
                    ownerKind: 'executable',
                    sourceOfDeclaration: 'explicit artifact-owner access contract',
                    accesses: [
                        { rootId: 'current-build', domainId: 'production-output', accessMode: 'create' },
                        { rootId: 'current-build', domainId: 'production-output', accessMode: 'write' }
                    ]
                }
            ]
        },
        physicalOwners: [
            { producerId: 'source-check', ownerKind: 'executable', spawnEligibility: true },
            { producerId: 'artifact-owner', ownerKind: 'executable', spawnEligibility: true },
            { producerId: 'compatibility', ownerKind: 'summary', spawnEligibility: false }
        ],
        roots: [
            { rootId: 'source', path: source, boundaryPath: root, role: 'repository' },
            { rootId: 'current-build', path: path.join(builds, 'current', 'output'), boundaryPath: builds, role: 'current', runId: 'current' }
        ],
        context: {
            runId: 'current',
            attemptId: 'attempt-1',
            sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` }
        }
    };
}

test('read-only planning resolves future roots without creating directories or changing execution owners', (t) =>
{
    const input = fixture(t);
    const before = structuredClone(input);
    const plan = compilePhysicalProducerFilesystemPlan(input);
    assert.deepEqual(input, before);
    assert.equal(fs.existsSync(input.roots[1].path), false);
    assert.equal(plan.qualificationEligible, false);
    assert.equal(plan.producers.length, 2);
    assert.deepEqual(plan.producers.find((producer) => producer.producerId === 'artifact-owner').resolvedRoots.map((access) => access.accessMode), ['create', 'write']);
    const access = plan.producers[0].resolvedRoots[0];
    assert.ok(path.isAbsolute(access.resolvedRoot));
    assert.match(access.filesystemIdentity, /^linux:device:/u);
    assert.match(access.mountIdentity, /^mnt:\[/u);
    assert.ok(path.isAbsolute(access.filesystemPath));
    assert.deepEqual(access.unresolvedSegments, ['current', 'output']);
    assert.match(plan.catalogDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('missing executable access declaration fails closed', (t) =>
{
    const input = fixture(t);
    input.catalog.producers.pop();
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /missing filesystem declaration/u);
});

test('duplicate producer and duplicate access declarations fail closed', (t) =>
{
    const input = fixture(t);
    input.catalog.producers.push(structuredClone(input.catalog.producers[0]));
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /duplicate filesystem producer/u);
    input.catalog.producers.pop();
    input.catalog.producers[0].accesses.push(structuredClone(input.catalog.producers[0].accesses[0]));
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /duplicate filesystem access/u);
});

test('summary owner cannot declare filesystem access or gain spawn eligibility', (t) =>
{
    const input = fixture(t);
    input.catalog.producers[0].producerId = 'compatibility';
    input.catalog.producers[0].ownerKind = 'summary';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /non-executable/u);
    input.physicalOwners[2].spawnEligibility = true;
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /invalid physical owner/u);
});

test('projection and receipt-only finalizer owners cannot have access declarations', (t) =>
{
    const input = fixture(t);
    input.physicalOwners[0].ownerKind = 'projection';
    input.physicalOwners[0].spawnEligibility = false;
    input.catalog.producers[0].ownerKind = 'projection';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /non-executable/u);
    input.physicalOwners[0].ownerKind = 'receipt-only-finalizer';
    input.catalog.producers[0].ownerKind = 'receipt-only-finalizer';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /non-executable/u);
});

test('unknown producer, root, access mode and domain fail closed', (t) =>
{
    const input = fixture(t);
    const access = input.catalog.producers[0].accesses[0];
    input.catalog.producers[0].producerId = 'unknown';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /unknown filesystem producer/u);
    input.catalog.producers[0].producerId = 'source-check';
    access.rootId = 'unknown';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /unknown filesystem root\/access/u);
    access.rootId = 'source';
    access.accessMode = 'execute';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /unknown filesystem root\/access/u);
    access.accessMode = 'read';
    access.domainId = 'undeclared-domain';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /unknown filesystem domain/u);
    access.domainId = '';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /domainId/u);
});

test('symlink and target share the resolved filesystem coordinate', (t) =>
{
    const input = fixture(t);
    const baseline = compilePhysicalProducerFilesystemPlan(input);
    const alias = path.join(input.roots[0].boundaryPath, 'source-alias');
    fs.symlinkSync(input.roots[0].path, alias, 'dir');
    input.roots[0].path = alias;
    const actual = compilePhysicalProducerFilesystemPlan(input);
    const expectedAccess = baseline.producers.find((producer) => producer.producerId === 'source-check').resolvedRoots[0];
    const actualAccess = actual.producers.find((producer) => producer.producerId === 'source-check').resolvedRoots[0];
    assert.equal(actualAccess.resolvedRoot, expectedAccess.resolvedRoot);
    assert.equal(actualAccess.filesystemIdentity, expectedAccess.filesystemIdentity);
    assert.equal(actualAccess.filesystemPath, expectedAccess.filesystemPath);
    assert.equal(actualAccess.ancestorIdentity, expectedAccess.ancestorIdentity);
});

test('symlink aliases declared under different root IDs are rejected', (t) =>
{
    const input = fixture(t);
    const alias = path.join(input.roots[0].boundaryPath, 'source-alias');
    fs.symlinkSync(input.roots[0].path, alias, 'dir');
    input.roots.push({ ...input.roots[0], rootId: 'duplicate-source', path: alias });
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /alias collision/u);
});

test('lexical path traversal and symlink escape cannot leave an owned boundary', (t) =>
{
    const input = fixture(t);
    const original = input.roots[1].path;
    input.roots[1].path = `${input.roots[1].boundaryPath}/../escape`;
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /path traversal/u);
    input.roots[1].path = original;
    const alias = path.join(input.roots[1].boundaryPath, 'outside');
    fs.symlinkSync(input.roots[0].path, alias, 'dir');
    input.roots[1].path = path.join(alias, 'future');
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /realpath escapes boundary/u);
});

test('dangling symlinks, files and missing owned boundaries are not valid root ancestors', (t) =>
{
    const input = fixture(t);
    const file = path.join(input.roots[0].boundaryPath, 'file');
    fs.writeFileSync(file, 'fixture');
    input.roots[0].path = path.join(file, 'child');
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /not a directory|ENOTDIR/u);
    const alias = path.join(input.roots[0].boundaryPath, 'dangling');
    fs.symlinkSync(path.join(input.roots[0].boundaryPath, 'absent'), alias, 'dir');
    input.roots[0].path = alias;
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /ENOENT/u);
    input.roots[0].boundaryPath = path.join(input.roots[0].boundaryPath, 'absent');
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /ENOENT/u);
});

test('current and resume roots retain distinct run and role identities', (t) =>
{
    const input = fixture(t);
    input.context.resumeRunId = 'previous';
    input.roots.push({ ...input.roots[1], rootId: 'resume-build', path: path.join(input.roots[1].boundaryPath, 'previous'), role: 'resume', runId: 'previous' });
    input.catalog.domains[1].rootIds.push('resume-build');
    input.catalog.producers[1].accesses.push({ rootId: 'resume-build', domainId: 'production-output', accessMode: 'read' });
    const plan = compilePhysicalProducerFilesystemPlan(input);
    const roots = plan.producers[0].resolvedRoots;
    assert.equal(roots.find((access) => access.role === 'current').runId, 'current');
    assert.equal(roots.find((access) => access.role === 'resume').runId, 'previous');
    input.roots[2].runId = 'wrong';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /resume root run identity mismatch/u);
    input.roots.pop();
    input.roots[1].runId = 'wrong';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /current root run identity mismatch/u);
});

test('active resident and retained output roots are explicit rather than inferred from producer names', (t) =>
{
    const input = fixture(t);
    input.roots.push(
        { ...input.roots[1], rootId: 'active', path: path.join(input.roots[1].boundaryPath, 'active'), role: 'active', runId: 'active-run' },
        { ...input.roots[1], rootId: 'resident', path: path.join(input.roots[1].boundaryPath, 'resident'), role: 'resident', runId: 'resident-run' },
        { ...input.roots[1], rootId: 'retained', path: path.join(input.roots[1].boundaryPath, 'retained'), role: 'retained', runId: 'retained-run' }
    );
    input.catalog.producers[1].accesses.push(
        { rootId: 'active', domainId: 'production-output', accessMode: 'read' },
        { rootId: 'resident', domainId: 'production-output', accessMode: 'read' },
        { rootId: 'retained', domainId: 'production-output', accessMode: 'read' }
    );
    input.catalog.domains[1].rootIds.push('active', 'resident', 'retained');
    assert.deepEqual([...new Set(compilePhysicalProducerFilesystemPlan(input).producers[0].resolvedRoots.map((access) => access.role))].sort(), ['active', 'current', 'resident', 'retained']);
});

test('unknown filesystem or mount identity never creates an independent plan', (t) =>
{
    const input = fixture(t);
    assert.throws(() => compilePhysicalProducerFilesystemPlan({ ...input, resolveFilesystem: () => ({}) }), /identity is unknown/u);
    assert.throws(() => compilePhysicalProducerFilesystemPlan({ ...input, observeMount: () => ({}) }), /identity is unknown/u);
    assert.throws(() => observePhysicalProducerMount(input.roots[0].path, { platform: 'unsupported' }), /mount\/volume identity is unknown/u);
});

test('Linux mount observation rejects malformed missing ambiguous and wrong-device records', (t) =>
{
    const input = fixture(t);
    const target = input.roots[0].path;
    const namespace = 'fixture-namespace';
    assert.throws(() => observePhysicalProducerMount(target, { mountInfo: 'invalid', namespace }), /invalid filesystem mount/u);
    assert.throws(() => observePhysicalProducerMount(target, { mountInfo: '1 0 0:0 / /foreign rw - tmpfs tmpfs rw', namespace }), /missing or ambiguous/u);
    assert.throws(() => observePhysicalProducerMount(target, { mountInfo: '1 0 0:0 / / rw - tmpfs tmpfs rw\n1 0 0:0 / / rw - tmpfs tmpfs rw', namespace, mountId: '1' }), /missing or ambiguous/u);
    assert.throws(() => observePhysicalProducerMount(target, { mountInfo: '1 0 0:0 / / rw - tmpfs tmpfs rw', namespace, mountId: '1' }), /device identity mismatch/u);
});

test('different paths on the same filesystem retain different overlap coordinates', (t) =>
{
    const input = fixture(t);
    const plan = compilePhysicalProducerFilesystemPlan(input);
    const output = plan.producers[0].resolvedRoots[0];
    const source = plan.producers[1].resolvedRoots[0];
    assert.equal(output.filesystemIdentity, source.filesystemIdentity);
    assert.notEqual(output.filesystemPath, source.filesystemPath);
});

test('bind-mount coordinates collapse aliases and select the kernel mount rather than path depth', (t) =>
{
    const input = fixture(t);
    const target = input.roots[0].path;
    const metadata = fs.statSync(target, { bigint: true });
    const major = ((metadata.dev >> 8n) & 0xfffn) | ((metadata.dev >> 32n) & 0xfffff000n);
    const minor = (metadata.dev & 0xffn) | ((metadata.dev >> 12n) & 0xffffff00n);
    const device = `${major}:${minor}`;
    const alias = path.join(input.roots[0].boundaryPath, 'bind-alias');
    fs.mkdirSync(alias);
    const mountInfo = `1 0 ${device} /volume/source ${target} rw - tmpfs tmpfs rw\n2 0 ${device} /volume/source ${alias} rw - tmpfs tmpfs rw\n3 0 ${device} /hidden ${target} ro - tmpfs tmpfs ro`;
    const direct = observePhysicalProducerMount(target, { mountInfo, namespace: 'fixture', mountId: '1' });
    const bound = observePhysicalProducerMount(alias, { mountInfo, namespace: 'fixture', mountId: '2' });
    assert.equal(direct.filesystemPath, bound.filesystemPath);
    assert.notEqual(direct.mountIdentity, bound.mountIdentity);
    input.roots.push({ ...input.roots[0], rootId: 'bind-alias', path: alias });
    assert.throws(() => compilePhysicalProducerFilesystemPlan({
        ...input,
        observeMount: (candidate) => candidate === target ? direct : candidate === alias ? bound : observePhysicalProducerMount(candidate)
    }), /alias collision/u);
});

test('mountinfo escaped paths resolve without a case or string-prefix shortcut', (t) =>
{
    const input = fixture(t);
    const target = path.join(input.roots[0].boundaryPath, 'space name');
    fs.mkdirSync(target);
    const metadata = fs.statSync(target, { bigint: true });
    const major = ((metadata.dev >> 8n) & 0xfffn) | ((metadata.dev >> 32n) & 0xfffff000n);
    const minor = (metadata.dev & 0xffn) | ((metadata.dev >> 12n) & 0xffffff00n);
    const escaped = target.replaceAll(' ', '\\040');
    const actual = observePhysicalProducerMount(target, {
        mountInfo: `1 0 ${major}:${minor} /volume/space\\040name ${escaped} rw - tmpfs tmpfs rw`,
        namespace: 'fixture',
        mountId: '1'
    });
    assert.equal(actual.filesystemPath, '/volume/space name');
    assert.throws(() => observePhysicalProducerMount(`${target}-other`, {
        mountInfo: `1 0 ${major}:${minor} /volume ${escaped} rw - tmpfs tmpfs rw`,
        namespace: 'fixture',
        mountId: '1'
    }), /ENOENT|missing or ambiguous/u);
});

test('duplicate physical owners, roots, unknown fields and missing source bindings fail closed', (t) =>
{
    const input = fixture(t);
    input.physicalOwners.push(structuredClone(input.physicalOwners[0]));
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /duplicate or invalid physical owner/u);
    input.physicalOwners.pop();
    input.roots.push(structuredClone(input.roots[0]));
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /duplicate filesystem root/u);
    input.roots.pop();
    input.catalog.producers[0].independent = true;
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /unknown or invalid shape/u);
    delete input.catalog.producers[0].independent;
    input.context.sourceState.commit = '';
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /source\/worktree identity/u);
});

test('domain declarations reject duplicate missing and foreign root ownership', (t) =>
{
    const input = fixture(t);
    input.catalog.domains.push(structuredClone(input.catalog.domains[0]));
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /duplicate or unknown filesystem domain/u);
    input.catalog.domains.pop();
    input.catalog.domains[0].rootIds.push('unknown');
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /duplicate or unknown filesystem domain/u);
    input.catalog.domains[0].rootIds.pop();
    input.catalog.domains[0].rootIds = ['current-build'];
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /unknown filesystem domain\/root binding/u);
    delete input.catalog.domains;
    assert.throws(() => compilePhysicalProducerFilesystemPlan(input), /catalog domains/u);
});

test('saved plan refuses another run attempt source or catalog identity', (t) =>
{
    const input = fixture(t);
    const plan = compilePhysicalProducerFilesystemPlan(input);
    assert.deepEqual(verifyPhysicalProducerFilesystemPlan(plan, input), plan);
    const otherAttempt = structuredClone(input);
    otherAttempt.context.attemptId = 'attempt-2';
    assert.throws(() => verifyPhysicalProducerFilesystemPlan(plan, otherAttempt), /identity drift/u);
    const otherRun = structuredClone(input);
    otherRun.context.runId = 'other-run';
    otherRun.roots[1].runId = 'other-run';
    assert.throws(() => verifyPhysicalProducerFilesystemPlan(plan, otherRun), /identity drift/u);
    const otherSource = structuredClone(input);
    otherSource.context.sourceState.worktreeFingerprint = `sha256:${'c'.repeat(64)}`;
    assert.throws(() => verifyPhysicalProducerFilesystemPlan(plan, otherSource), /identity drift/u);
    assert.throws(() => compilePhysicalProducerFilesystemPlan({ ...input, expectedCatalogDigest: `sha256:${'0'.repeat(64)}` }), /catalog identity drift/u);
});

test('saved plan detects symlink retargeting and document tampering', (t) =>
{
    const input = fixture(t);
    const alias = path.join(input.roots[0].boundaryPath, 'alias');
    fs.symlinkSync(input.roots[0].path, alias, 'dir');
    input.roots[0].path = alias;
    const plan = compilePhysicalProducerFilesystemPlan(input);
    const tampered = structuredClone(plan);
    tampered.producers[0].resolvedRoots[0].accessMode = 'delete';
    assert.throws(() => verifyPhysicalProducerFilesystemPlan(tampered, input), /identity drift/u);
    fs.unlinkSync(alias);
    fs.symlinkSync(input.roots[1].boundaryPath, alias, 'dir');
    assert.throws(() => verifyPhysicalProducerFilesystemPlan(plan, input), /identity drift/u);
});

test('plan-only CLI exposes the same catalog identity and never spawns producers', (t) =>
{
    const input = fixture(t);
    const request = path.join(input.roots[0].boundaryPath, 'request.json');
    fs.writeFileSync(request, JSON.stringify({ schema: 'fsusblog.physical-producer-filesystem-request.v1', ...input }));
    const cli = path.resolve(import.meta.dirname, '../../tools/test-matrix/physical-producer-filesystem.mjs');
    const actual = spawnSync(process.execPath, [cli, '--plan-only', '--input', request], { encoding: 'utf8' });
    assert.equal(actual.status, 0, actual.stderr);
    assert.deepEqual(JSON.parse(actual.stdout), compilePhysicalProducerFilesystemPlan(input));
    assert.equal(fs.existsSync(input.roots[1].path), false);
    const invalid = spawnSync(process.execPath, [cli, '--execute', '--input', request], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /usage/u);
    input.catalog.producers.pop();
    fs.writeFileSync(request, JSON.stringify({ schema: 'fsusblog.physical-producer-filesystem-request.v1', ...input }));
    const missing = spawnSync(process.execPath, [cli, '--plan-only', '--input', request], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
});
