import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { preserveCompiledArtifacts, validateArchivePlan } from '../../tools/operations/archive-compiled-artifacts.mjs';
import { readFrozenPlan, parsePlanCli, readRegular, sha256, requireCanonicalOwnedPath } from '../../tools/operations/local-task-plan.mjs';
import { validateRetirementPlan } from '../../tools/operations/retire-idle-materializations.mjs';

const fixtureParent = process.env.FSUSBLOG_OPERATIONS_FIXTURE_ROOT ?? os.tmpdir();
requireCanonicalOwnedPath(fixtureParent, { directory: true });
const ownerRoot = fs.mkdtempSync(path.join(fixtureParent, 'preservation-controls-'));
const tool = fileURLToPath(new URL('../../tools/operations/archive-compiled-artifacts.mjs', import.meta.url));
const sourceInputs = owner => [owner, fileURLToPath(new URL('../../tools/operations/local-task-plan.mjs', import.meta.url))].map(file => ({ file, sha256: readRegular(file).sha256 }));
const sparseTool = fileURLToPath(new URL('../../tools/operations/retire-idle-materializations.mjs', import.meta.url));

function artifactPlan() {
    const taskRoot = fs.mkdtempSync(path.join(ownerRoot, 'archive-'));
    const original = path.join(taskRoot, 'artifacts');
    fs.mkdirSync(original, { mode: 0o750 });
    fs.mkdirSync(path.join(original, 'nested'), { mode: 0o710 });
    fs.writeFileSync(path.join(original, 'nested', 'owner.bin'), Buffer.from([0, 1, 127, 255]), { mode: 0o640 });
    const timestamp = new Date('2020-01-02T03:04:05.123Z');
    fs.utimesSync(path.join(original, 'nested', 'owner.bin'), timestamp, timestamp);
    const xattr = spawnSync('/usr/bin/python3', ['-I', '-c', 'import os,sys,struct;os.setxattr(sys.argv[1],"user.fsusblog.control",b"raw\\x00attribute");entries=[(1,6,0xffffffff),(2,4,os.getuid()+1),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)];acl=struct.pack("<I",2)+b"".join(struct.pack("<HHI",*entry) for entry in entries);os.setxattr(sys.argv[1],"system.posix_acl_access",acl)', path.join(original, 'nested', 'owner.bin')]);
    assert.equal(xattr.status, 0, String(xattr.stderr));
    fs.writeFileSync(path.join(taskRoot, 'terminal.json'), '{"terminal":"UNKNOWN"}\n');
    fs.writeFileSync(path.join(taskRoot, 'task.lock'), '');
    const stat = fs.lstatSync(original, { bigint: true });
    const expectedRoot = { dev: String(stat.dev), ino: String(stat.ino), mode: Number(stat.mode & 0o7777n), uid: Number(stat.uid), gid: Number(stat.gid), nlink: Number(stat.nlink), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
    return { schema: 'fsusblog.local-task-plan.v1', sourceInputs: sourceInputs(tool), taskRoot, original, terminal: path.join(taskRoot, 'terminal.json'), terminalSha256: readRegular(path.join(taskRoot, 'terminal.json')).sha256, taskLock: path.join(taskRoot, 'task.lock'), budgets: { diskFloorBytes: 1, memoryFloorBytes: 1, archiveBytes: 1024 * 1024, restoreBytes: 1024 * 1024, metadataBytes: 1024 * 1024, maxEntries: 16 }, expectedRoot, originalInventorySha256: null };
}

test('full disposable artifact tar roundtrip keeps owner/mode/mtime/raw xattr and original epoch', async () => {
    const plan = artifactPlan();
    validateArchivePlan(plan);
    const observed = await preserveCompiledArtifacts(plan, 'a'.repeat(64));
    assert.equal(observed.retirementAuthorized, false);
    assert.ok(observed.inventory.entries.find(entry => entry.relative === 'nested/owner.bin').xattrs['system.posix_acl_access']);
    assert.equal(fs.readdirSync(plan.taskRoot).filter(value => value.startsWith('compiled-preservation-')).length, 0);
    plan.originalInventorySha256 = observed.inventorySha256;
    const planFile = path.join(plan.taskRoot, 'plan.json');
    const bytes = Buffer.from(JSON.stringify(plan));
    fs.writeFileSync(planFile, bytes);
    const actual = spawnSync('/usr/bin/flock', ['-n', '--close', plan.taskLock, process.execPath, '--max-old-space-size=128', tool, '--plan', planFile, '--plan-sha256', sha256(bytes), '--mode', 'archive'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000 });
    assert.equal(actual.status, 0, actual.stderr);
    const receipt = JSON.parse(actual.stdout);
    assert.equal(receipt.fullRoundtripBytesRootModeOwnerMtimeAclXattrVerified, true);
    assert.equal(receipt.qualificationEligible, false);
    assert.equal(receipt.retirementAuthorized, false);
    assert.equal(receipt.originalsRetained, true);
    assert.deepEqual((await preserveCompiledArtifacts(plan, 'a'.repeat(64))).inventory, observed.inventory);
    assert.equal(fs.readFileSync(path.join(receipt.restoreRoot, 'nested', 'owner.bin')).toString('hex'), '00017fff');
});

test('artifact source epoch, symlink and hardlink controls fail before output allocation', async () => {
    for (const kind of ['epoch', 'symlink', 'hardlink']) {
        const plan = artifactPlan();
        if (kind === 'epoch')
        {
            plan.expectedRoot.ino = '0';
        }
        if (kind === 'symlink')
        {
            fs.symlinkSync('/etc/passwd', path.join(plan.original, 'outside'));
        }
        if (kind === 'hardlink')
        {
            fs.linkSync(path.join(plan.original, 'nested', 'owner.bin'), path.join(plan.original, 'alias'));
        }
        await assert.rejects(preserveCompiledArtifacts(plan, 'b'.repeat(64)));
        assert.equal(fs.readdirSync(plan.taskRoot).some(value => value.startsWith('compiled-preservation-')), false);
    }
});

test('frozen plans reject stale SHA, extra authority, duplicate mode and symlink ancestry', () => {
    const plan = artifactPlan();
    const file = path.join(plan.taskRoot, 'small-plan.json');
    const bytes = Buffer.from(JSON.stringify({ schema: plan.schema, taskRoot: plan.taskRoot, value: 1 }));
    fs.writeFileSync(file, bytes);
    assert.equal(readFrozenPlan(file, sha256(bytes), ['value']).plan.value, 1);
    assert.throws(() => readFrozenPlan(file, '0'.repeat(64), ['value']), /digest/);
    assert.throws(() => readFrozenPlan(file, sha256(bytes), []), /shape/);
    assert.throws(() => parsePlanCli(['--plan', file, '--plan-sha256', sha256(bytes), '--mode', 'inspect', '--mode', 'archive'], ['archive']), /unique/);
    assert.throws(() => parsePlanCli(['--plan', file, '--plan-sha256', sha256(bytes), '--mode', 'delete'], ['archive']), /supported/);
    fs.symlinkSync(plan.original, path.join(plan.taskRoot, 'alias'));
    assert.throws(() => requireCanonicalOwnedPath(path.join(plan.taskRoot, 'alias', 'nested', 'owner.bin')), /canonical|symlink/);
});

test('sparse retirement rejects protected target, unknown nested plan fields and outside task ownership', () => {
    const plan = artifactPlan();
    const source = path.join(plan.taskRoot, 'ownership.json');
    fs.writeFileSync(source, '{}');
    const input = { ...plan, sourceInputs: sourceInputs(sparseTool), repository: plan.original, base: 'a'.repeat(40), expectedBootId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), protected: [plan.original], sources: [{ path: source, sha256: sha256('{}') }], targets: [{ root: plan.original, admin: plan.original, ref: 'refs/heads/test', head: 'b'.repeat(40), diffPaths: [], preservedPaths: [] }] };
    assert.throws(() => validateRetirementPlan(input), /protected/);
    input.targets[0].root = '/usr';
    assert.throws(() => validateRetirementPlan(input), /owner|descendant/);
    input.targets[0].root = plan.original;
    input.targets[0].approval = true;
    assert.throws(() => validateRetirementPlan(input), /closed current/);
});

test('disposable sparse preserves Git/raw custody; operational owner refuses unreadable occupancy', () => {
    const taskRoot = fs.mkdtempSync(path.join(ownerRoot, 'sparse-'));
    const repository = path.join(taskRoot, 'primary');
    const targetRoot = path.join(taskRoot, 'target');
    fs.mkdirSync(repository);
    const git = (root, ...args) => {
        const result = spawnSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    git(repository, 'init', '-b', 'master');
    git(repository, 'config', 'user.name', 'Owned fixture');
    git(repository, 'config', 'user.email', 'fixture@example.invalid');
    git(repository, 'config', 'extensions.worktreeConfig', 'true');
    fs.mkdirSync(path.join(repository, 'source'));
    fs.writeFileSync(path.join(repository, 'README.md'), 'owned fixture\n');
    fs.writeFileSync(path.join(repository, 'source', 'keep.txt'), 'keep exact bytes\n');
    fs.writeFileSync(path.join(repository, 'source', 'retire.bin'), 'retire disposable materialization\n');
    fs.writeFileSync(path.join(repository, '.gitignore'), '*.log\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'test: initialize owned fixture');
    git(repository, 'worktree', 'add', '-b', 'owned-target', targetRoot);
    fs.writeFileSync(path.join(targetRoot, 'raw.log'), 'original ignored evidence\n');
    const head = git(repository, 'rev-parse', 'HEAD').trim();
    const refs = git(repository, 'for-each-ref', '--format=%(refname) %(objectname)');
    const index = git(targetRoot, 'ls-files', '--stage', '-z');
    const rawEpoch = readRegular(path.join(targetRoot, 'raw.log'));
    fs.writeFileSync(path.join(taskRoot, 'task.lock'), '');
    const source = path.join(taskRoot, 'ownership.json');
    fs.writeFileSync(source, '{"owned":"disposable fixture"}\n');
    const plan = { schema: 'fsusblog.local-task-plan.v1', sourceInputs: sourceInputs(sparseTool), taskRoot, repository, taskLock: path.join(taskRoot, 'task.lock'), base: head, expectedBootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), sources: [{ path: source, sha256: readRegular(source).sha256 }], protected: [repository], targets: [{ root: targetRoot, admin: git(targetRoot, 'rev-parse', '--absolute-git-dir').trim(), head, ref: 'refs/heads/owned-target', diffPaths: [], preservedPaths: ['source/keep.txt'] }] };
    const bytes = Buffer.from(JSON.stringify(plan));
    const planFile = path.join(taskRoot, 'plan.json');
    fs.writeFileSync(planFile, bytes);
    const actual = spawnSync('/usr/bin/flock', ['-n', '--close', plan.taskLock, process.execPath, '--max-old-space-size=128', sparseTool, '--plan', planFile, '--plan-sha256', sha256(bytes), '--mode', 'sparse'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000 });
    assert.equal(actual.status, 0, actual.stderr);
    const receipt = JSON.parse(actual.stdout);
    if (receipt.refused === 1) {
        const summary = JSON.parse(fs.readFileSync(path.join(receipt.runRoot, 'summary.json'), 'utf8'));
        assert.equal(summary.results[0].status, 'REFUSED_ACTIVITY_OR_UNKNOWN');
        assert.ok(summary.results[0].activity.unknown.length > 0);
        assert.equal(fs.existsSync(path.join(targetRoot, 'source', 'retire.bin')), true);
        assert.equal(git(repository, 'for-each-ref', '--format=%(refname) %(objectname)'), refs);
        assert.equal(git(targetRoot, 'ls-files', '--stage', '-z'), index);
        // Exercise ordinary Git only in this disposable fixture; this is not wrapper admission.
        git(targetRoot, 'sparse-checkout', 'set', '--no-cone', '--no-sparse-index', '/README.md', '/.gitignore', '/source/keep.txt');
        console.log('Operational positive sparse admission unverified: unreadable current-owner /proc occupancy; disposable native Git sparse checked separately.');
    } else {
        assert.equal(receipt.projected, 1, JSON.stringify(receipt));
        assert.equal(receipt.refused, 0);
    }
    assert.equal(fs.existsSync(path.join(targetRoot, 'source', 'retire.bin')), false);
    assert.equal(fs.readFileSync(path.join(targetRoot, 'source', 'keep.txt'), 'utf8'), 'keep exact bytes\n');
    assert.deepEqual(readRegular(path.join(targetRoot, 'raw.log')), rawEpoch);
    assert.equal(git(repository, 'for-each-ref', '--format=%(refname) %(objectname)'), refs);
    assert.equal(git(targetRoot, 'ls-files', '--stage', '-z'), index);
    assert.equal(git(targetRoot, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    plan.targets[0].head = '0'.repeat(40);
    const staleBytes = Buffer.from(JSON.stringify(plan));
    fs.writeFileSync(path.join(taskRoot, 'stale-plan.json'), staleBytes);
    const refused = spawnSync('/usr/bin/flock', ['-n', '--close', plan.taskLock, process.execPath, sparseTool, '--plan', path.join(taskRoot, 'stale-plan.json'), '--plan-sha256', sha256(staleBytes), '--mode', 'sparse'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000 });
    assert.equal(refused.status, 0, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).refused, 1);
});
