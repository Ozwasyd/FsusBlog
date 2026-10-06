import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditWip, createWipContext, inventoryWip, originalIdentity, sha256 } from '../../tools/operations/wip-publication.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceTool = path.join(repositoryRoot, 'tools/operations/wip-publication.mjs');
const catalogTool = path.join(repositoryRoot, 'tools/operations/wip-catalog-publication.mjs');
const testParent = process.env.FSUSBLOG_OPERATIONS_FIXTURE_ROOT ?? os.tmpdir();

function git(root, args, input) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(testParent, 'local-wip-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    const remote = path.join(root, 'remote.git');
    const taskRoot = path.join(root, 'task');
    const dirtyRoot = path.join(root, 'dirty');
    fs.mkdirSync(repo);
    fs.mkdirSync(taskRoot);
    git(repo, ['init', '-b', 'master']);
    git(repo, ['config', 'user.name', 'Disposable WIP Test']);
    git(repo, ['config', 'user.email', 'wip-test@example.invalid']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.qoder/\n');
    fs.writeFileSync(path.join(repo, 'source.txt'), 'published\n');
    fs.writeFileSync(path.join(repo, 'delete.txt'), 'published delete\n');
    fs.writeFileSync(path.join(repo, '.env.example'), 'PUBLIC_EXAMPLE=placeholder\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'chore(test): initialize public baseline']);
    git(root, ['init', '--bare', remote]);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', 'origin', 'master']);
    const baseline = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['switch', '-c', 'task/issue-123']);
    fs.writeFileSync(path.join(repo, 'source.txt'), 'unpublished source\n');
    git(repo, ['commit', '-am', 'feat(test): retain source\n\nRefs: #123']);
    const branchHead = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['switch', 'master']);
    fs.writeFileSync(path.join(repo, 'source.txt'), 'stash source\n');
    fs.writeFileSync(path.join(repo, 'stash-untracked.txt'), 'third parent bytes\n');
    git(repo, ['stash', 'push', '-u', '-m', 'Refs: #124 retained stash']);
    const stash = git(repo, ['rev-parse', 'refs/stash']).trim();
    git(repo, ['worktree', 'add', '-b', 'dirty-task', dirtyRoot, 'master']);
    fs.writeFileSync(path.join(dirtyRoot, 'source.txt'), 'staged dirty\n');
    git(dirtyRoot, ['add', 'source.txt']);
    fs.writeFileSync(path.join(dirtyRoot, 'source.txt'), 'actual unstaged dirty\n');
    fs.unlinkSync(path.join(dirtyRoot, 'delete.txt'));
    fs.writeFileSync(path.join(dirtyRoot, 'new-source.sh'), '#!/bin/sh\necho recoverable\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dirtyRoot, '.qoder'));
    fs.writeFileSync(path.join(dirtyRoot, '.qoder', 'local'), 'local private material remains\n');
    const operationalSource = path.join(taskRoot, 'operation.mjs');
    fs.writeFileSync(operationalSource, 'export const reusable = true;\n');
    const lock = path.join(taskRoot, 'task.lock');
    fs.writeFileSync(lock, '');
    const plan = {
        schema: 'fsusblog.local-task-plan.v1', sourceInputs: [sourceTool, catalogTool, path.join(repositoryRoot, 'tools/operations/local-task-plan.mjs')].map(file => ({ file, sha256: sha256(fs.readFileSync(file)) })), taskRoot, taskLock: lock, repoRoot: repo,
        remote: { name: 'origin', url: remote }, baselineRef: 'refs/heads/master', prefix: 'wip-test/run', handoffPath: '.wip/run/WIP.md',
        branches: ['task/issue-123'], stashes: [stash],
        dirty: [{ root: dirtyRoot, head: baseline, ref: 'uncommitted/dirty-task', paths: ['source.txt', 'delete.txt', 'new-source.sh'].map(file => ({ path: file, sha256: file === 'delete.txt' ? null : sha256(fs.readFileSync(path.join(dirtyRoot, file))) })) }],
        publicTemplates: [{ path: '.env.example', baselinePath: '.env.example', blob: git(repo, ['rev-parse', `${baseline}:.env.example`]).trim() }],
        catalog: { ref: 'catalog', directory: '.wip/catalog', sources: [{ source: operationalSource, target: '.wip/catalog/local-tools/operation.mjs', sha256: sha256(fs.readFileSync(operationalSource)) }] },
        maxObjectBytes: 10 * 1024 * 1024, maxSourceBytes: 1024 * 1024, resourceFloor: { availableMemoryBytes: 0, availableDiskBytes: 0 }
    };
    const planFile = path.join(taskRoot, 'plan.json');
    function freeze() {
        fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 4)}\n`);
        return sha256(fs.readFileSync(planFile));
    }
    const digest = freeze();
    const context = createWipContext(planFile, digest);
    const initial = originalIdentity(context);
    const dirtyInitial = originalIdentity(context, dirtyRoot);
    function run(mode, { locked = true, expectSuccess = true, tool = sourceTool } = {}) {
        const argumentsList = [tool, '--plan', planFile, '--plan-sha256', sha256(fs.readFileSync(planFile)), '--mode', mode];
        const result = spawnSync(locked ? '/usr/bin/flock' : process.execPath, locked ? ['-n', '--close', lock, process.execPath, ...argumentsList] : argumentsList, { encoding: 'utf8', timeout: 180000 });
        if (expectSuccess) {
            assert.equal(result.status, 0, result.stderr);
            return JSON.parse(result.stdout);
        }
        assert.notEqual(result.status, 0);
        return result.stderr;
    }
    function preserve() {
        run('inventory');
        run('complete-path-audit');
        run('prepare');
        run('snapshot-dirty');
        return run('catalog', { tool: catalogTool });
    }
    return { root, repo, remote, taskRoot, dirtyRoot, baseline, stash, branchHead, plan, planFile, digest, context, initial, dirtyInitial, operationalSource, freeze, run, preserve };
}

test('default inspection is read-only, full-tree safety is baseline-pinned, and unknown plan fields fail closed', t => {
    const f = fixture(t);
    const beforeFiles = fs.readdirSync(f.taskRoot);
    const result = spawnSync(process.execPath, [sourceTool, '--plan', f.planFile, '--plan-sha256', f.digest], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(result.stdout);
    assert.equal(inventory.branches[0].sha, f.branchHead);
    assert.deepEqual(inventory.branches[0].linkedIssues, [123]);
    assert.equal(inventory.stashes[0].parents.length, 3);
    assert.equal(inventory.worktrees.length, 2);
    assert.deepEqual(fs.readdirSync(f.taskRoot), beforeFiles);
    assert.deepEqual(originalIdentity(f.context), f.initial);
    assert.deepEqual(originalIdentity(f.context, f.dirtyRoot), f.dirtyInitial);
    const audit = auditWip(f.context, inventory);
    assert.equal(audit.auditCompleted, true);
    assert.ok(audit.exactPublishedTemplatePaths > 0);
    assert.throws(() => createWipContext(f.planFile, '0'.repeat(64)), /digest changed/u);
    f.plan.waiver = true;
    assert.throws(() => createWipContext(f.planFile, f.freeze()), /closed task plan/u);
});

test('prepare preserves branch and stash ancestry, exact dirty bytes/deletion/mode, and catalog operational source', t => {
    const f = fixture(t);
    const publication = f.preserve();
    assert.equal(publication.refs.length, 4);
    const branch = publication.refs.find(row => row.ref.endsWith('/task/issue-123'));
    assert.equal(git(f.repo, ['rev-parse', `${branch.sha}^`]).trim(), f.branchHead);
    assert.equal(git(f.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', f.branchHead, branch.sha]).trim(), f.plan.handoffPath);
    const stash = publication.refs.find(row => row.ref.includes('/stash/'));
    assert.equal(git(f.repo, ['rev-parse', `${stash.sha}^`]).trim(), f.stash);
    assert.equal(git(f.repo, ['show', `${f.stash}^3:stash-untracked.txt`]), 'third parent bytes\n');
    const dirty = publication.refs.find(row => row.ref.includes('/uncommitted/'));
    const snapshot = git(f.repo, ['rev-parse', `${dirty.sha}^`]).trim();
    assert.equal(git(f.repo, ['rev-parse', `${snapshot}^`]).trim(), f.baseline);
    assert.equal(git(f.repo, ['show', `${snapshot}:source.txt`]), 'actual unstaged dirty\n');
    assert.equal(git(f.repo, ['ls-tree', snapshot, '--', 'delete.txt']).trim(), '');
    assert.match(git(f.repo, ['ls-tree', snapshot, '--', 'new-source.sh']), /^100755 blob/u);
    assert.equal(git(f.repo, ['ls-tree', '-r', '--name-only', snapshot]).includes('.qoder/'), false);
    const catalog = publication.refs.find(row => row.catalog);
    assert.equal(git(f.repo, ['show', `${catalog.sha}:.wip/catalog/local-tools/operation.mjs`]), fs.readFileSync(f.operationalSource, 'utf8'));
    const manifest = JSON.parse(git(f.repo, ['show', `${catalog.sha}:.wip/catalog/manifest.json`]));
    assert.equal(manifest.sourceBranches.length, 1);
    assert.equal(manifest.operationalSources[0].sha256, f.plan.catalog.sources[0].sha256);
    assert.equal(manifest.acceptance.issuesClosed, false);
    assert.deepEqual(originalIdentity(f.context), f.initial);
    assert.deepEqual(originalIdentity(f.context, f.dirtyRoot), f.dirtyInitial);
    assert.equal(fs.readFileSync(path.join(f.dirtyRoot, '.qoder/local'), 'utf8'), 'local private material remains\n');
    assert.equal(git(f.repo, ['ls-remote', '--heads', 'origin']).trim().split('\n').length, 1);
});

test('explicit publish performs actual atomic create-only CAS and verifies original source/remote refs', t => {
    const f = fixture(t);
    const publication = f.preserve();
    const verification = f.run('push', { tool: catalogTool });
    assert.equal(verification.refsMatched, 4);
    for (const row of publication.refs) {
        assert.equal(git(f.remote, ['rev-parse', row.ref]).trim(), row.sha);
    }
    assert.equal(git(f.remote, ['rev-parse', 'refs/heads/master']).trim(), f.baseline);
    assert.equal(git(f.repo, ['rev-parse', 'refs/stash']).trim(), f.stash);
    assert.deepEqual(originalIdentity(f.context), f.initial);
    assert.deepEqual(originalIdentity(f.context, f.dirtyRoot), f.dirtyInitial);
    assert.match(f.run('push', { tool: catalogTool, expectSuccess: false }), /destination exists/u);
});

test('mutations require the actual current task flock, and stale source or remote changes refuse publication', t => {
    const f = fixture(t);
    assert.match(f.run('inventory', { locked: false, expectSuccess: false }), /flock parent/u);
    f.preserve();
    fs.writeFileSync(path.join(f.dirtyRoot, 'source.txt'), 'later user changes\n');
    assert.match(f.run('push', { tool: catalogTool, expectSuccess: false }), /dirty source.*changed/u);
    assert.equal(git(f.repo, ['ls-remote', '--heads', 'origin']).trim().split('\n').length, 1);
});

test('a pre-existing remote destination is never overwritten or deleted', t => {
    const f = fixture(t);
    const publication = f.preserve();
    const collision = publication.refs[0].ref;
    git(f.repo, ['push', 'origin', `${f.baseline}:${collision}`]);
    assert.match(f.run('push', { tool: catalogTool, expectSuccess: false }), /destination exists/u);
    assert.equal(git(f.remote, ['rev-parse', collision]).trim(), f.baseline);
    assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads']).trim().split('\n').length, 2);
});

test('full-tree safety refuses inherited sensitive paths and credential/large objects; public exceptions cannot admit qoder', t => {
    const f = fixture(t);
    f.plan.publicTemplates = [];
    const missingException = createWipContext(f.planFile, f.freeze());
    assert.throws(() => auditWip(missingException, inventoryWip(missingException)), /full-tree sensitive path/u);
    f.plan.publicTemplates = [{ path: '.qoder/local', baselinePath: '.env.example', blob: git(f.repo, ['rev-parse', `${f.baseline}:.env.example`]).trim() }];
    assert.throws(() => createWipContext(f.planFile, f.freeze()), /invalid public template/u);
    f.plan.publicTemplates = [{ path: '.env.example', baselinePath: '.env.example', blob: git(f.repo, ['rev-parse', `${f.baseline}:.env.example`]).trim() }];
    git(f.repo, ['switch', 'task/issue-123']);
    fs.writeFileSync(path.join(f.repo, 'credential.txt'), `ghp_${'A'.repeat(40)}\n`);
    git(f.repo, ['add', 'credential.txt']);
    git(f.repo, ['commit', '-m', 'chore(test): demonstrate credential refusal']);
    const context = createWipContext(f.planFile, f.freeze());
    assert.throws(() => auditWip(context, inventoryWip(context)), /credential-pattern/u);
    git(f.repo, ['rm', 'credential.txt']);
    git(f.repo, ['commit', '-m', 'chore(test): remove unsafe content']);
    // Removed credentials remain in the unpublished parent history.
    assert.throws(() => auditWip(context, inventoryWip(context)), /credential-pattern/u);
    f.plan.maxObjectBytes = 1;
    const bounded = createWipContext(f.planFile, f.freeze());
    assert.throws(() => auditWip(bounded, inventoryWip(bounded)), /large object/u);
});

test('catalog source hash and epoch drift fail before catalog refs attach', t => {
    const f = fixture(t);
    f.run('inventory');
    f.run('complete-path-audit');
    f.run('prepare');
    f.run('snapshot-dirty');
    fs.writeFileSync(f.operationalSource, 'export const changed = true;\n');
    assert.match(f.run('catalog', { tool: catalogTool, expectSuccess: false }), /source digest/u);
    assert.equal(spawnSync('git', ['-C', f.repo, 'show-ref', '--verify', '--quiet', 'refs/heads/wip-test/run/catalog']).status, 1);
});

test('closed CLI refuses historical modes, unsafe dirty selections, and actual remote URL drift', t => {
    const f = fixture(t);
    assert.match(f.run('snapshot-dirty-2214', { expectSuccess: false }), /supported mode/u);
    f.plan.dirty[0].paths[0].path = '.qoder/local';
    assert.throws(() => createWipContext(f.planFile, f.freeze()), /sensitive\/unpinned/u);
    f.plan.dirty[0].paths[0].path = '../escape';
    assert.throws(() => createWipContext(f.planFile, f.freeze()), /relative path/u);
    f.plan.dirty = [];
    git(f.repo, ['remote', 'set-url', '--push', 'origin', path.join(f.root, 'unplanned.git')]);
    assert.throws(() => createWipContext(f.planFile, f.freeze()), /remote URL/u);
});

test('actual remote race fails atomic create-only CAS without publishing other refs', t => {
    const f = fixture(t);
    const publication = f.preserve();
    const collision = publication.refs[0].ref;
    const hook = path.join(f.remote, 'hooks/pre-receive');
    fs.writeFileSync(hook, `#!/bin/sh\nunset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH\ngit update-ref '${collision}' '${f.baseline}'\nexit 0\n`, { mode: 0o755 });
    assert.match(f.run('push', { tool: catalogTool, expectSuccess: false }), /atomic publication failed/u);
    assert.equal(git(f.remote, ['rev-parse', collision]).trim(), f.baseline);
    assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads']).trim().split('\n').length, 2);
    const attempt = JSON.parse(fs.readFileSync(path.join(f.taskRoot, 'wip-push-actual.json'), 'utf8'));
    assert.notEqual(attempt.status, 0);
    assert.deepEqual(originalIdentity(f.context), f.initial);
    assert.deepEqual(originalIdentity(f.context, f.dirtyRoot), f.dirtyInitial);
});

test('publication honors rejecting repository pre-push hooks', t => {
    const f = fixture(t);
    f.preserve();
    const hook = path.join(f.repo, '.git/hooks/pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\necho task-repository-push-refused >&2\nexit 1\n', { mode: 0o755 });
    assert.match(f.run('push', { tool: catalogTool, expectSuccess: false }), /atomic publication failed/u);
    assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads']).trim(), 'refs/heads/master');
    const attempt = JSON.parse(fs.readFileSync(path.join(f.taskRoot, 'wip-push-actual.json'), 'utf8'));
    assert.match(attempt.message, /task-repository-push-refused/u);
    assert.deepEqual(originalIdentity(f.context), f.initial);
    assert.deepEqual(originalIdentity(f.context, f.dirtyRoot), f.dirtyInitial);
});
