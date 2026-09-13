import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    FSUSUI_RELEASE_TRAIN_MANAGER
} = await import(new URL('../../tools/dependencies/fsusui-manager-ownership.mjs', import.meta.url));
const {
    PACKAGE_NAME
} = await import(new URL('../../tools/dependencies/fsusui-release-package.mjs', import.meta.url));
const {
    prepareReleaseTrainBranch,
    RELEASE_TRAIN_BRANCH
} = await import(new URL('../../tools/dependencies/update-fsusui-release.mjs', import.meta.url));
const {
    evaluatePlatformAutomerge
} = await import(new URL('../../tools/governance/dependency-automerge.mjs', import.meta.url));
const {
    resolveGroupChecks
} = await import(new URL('../../tools/governance/dependency-required-checks.mjs', import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const packageVersion = '1.5.2';
const privateRegistryHost = ['npm', 'pkg', 'github', 'com'].join('.');
const privatePackageToken = ['GITHUB', 'PACKAGES', 'TOKEN'].join('_');

function temporaryRoot(t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusui-release-orchestration-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function git(repository, args)
{
    return execFileSync('git', args, {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

function gitRepositoryFixture(t)
{
    const directory = temporaryRoot(t);
    const origin = path.join(directory, 'origin.git');
    const repository = path.join(directory, 'repository');
    fs.mkdirSync(repository);
    execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore' });
    execFileSync('git', ['init', '--initial-branch=master'], { cwd: repository, stdio: 'ignore' });
    git(repository, ['config', 'user.name', 'FsusBlog fixture']);
    git(repository, ['config', 'user.email', 'fixture@fsusblog.invalid']);
    fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
    git(repository, ['add', 'base.txt']);
    git(repository, ['commit', '-m', 'base']);
    git(repository, ['remote', 'add', 'origin', origin]);
    git(repository, ['push', '-u', 'origin', 'master']);
    return repository;
}

test('branch preparation creates and reuses one fixed branch while incorporating latest master', (t) =>
{
    const repository = gitRepositoryFixture(t);
    const first = prepareReleaseTrainBranch(repository);
    assert.deepEqual(first, { branch: RELEASE_TRAIN_BRANCH, baseBranch: 'master', existed: false });
    assert.equal(git(repository, ['branch', '--show-current']), RELEASE_TRAIN_BRANCH);

    fs.writeFileSync(path.join(repository, 'release.txt'), 'release\n');
    git(repository, ['add', 'release.txt']);
    git(repository, ['commit', '-m', 'release train']);
    git(repository, ['push', 'origin', `HEAD:refs/heads/${RELEASE_TRAIN_BRANCH}`]);
    git(repository, ['checkout', 'master']);
    fs.writeFileSync(path.join(repository, 'base-after.txt'), 'new base\n');
    git(repository, ['add', 'base-after.txt']);
    git(repository, ['commit', '-m', 'advance master']);
    git(repository, ['push', 'origin', 'master']);

    const reused = prepareReleaseTrainBranch(repository);
    assert.deepEqual(reused, { branch: RELEASE_TRAIN_BRANCH, baseBranch: 'master', existed: true });
    assert.equal(git(repository, ['branch', '--show-current']), RELEASE_TRAIN_BRANCH);
    git(repository, ['merge-base', '--is-ancestor', 'origin/master', 'HEAD']);
    assert.equal(fs.readFileSync(path.join(repository, 'release.txt'), 'utf8'), 'release\n');
    assert.equal(fs.readFileSync(path.join(repository, 'base-after.txt'), 'utf8'), 'new base\n');
    assert.equal(git(repository, ['status', '--porcelain']), '');
});

test('release-train PRs use the existing required checks and platform auto-merge contract', () =>
{
    const requiredCatalog = JSON.parse(readFileSync(path.join(repositoryRoot, 'config/dependencies/required-checks.json'), 'utf8'));
    const required = resolveGroupChecks(requiredCatalog, FSUSUI_RELEASE_TRAIN_MANAGER, 'patch');
    assert.ok(required.length > 0);
    const decision = evaluatePlatformAutomerge({
        catalog: requiredCatalog,
        defaultHeadSha: 'base-sha',
        latestStable: packageVersion,
        pullRequest: {
            number: 1986,
            group: FSUSUI_RELEASE_TRAIN_MANAGER,
            updateType: 'patch',
            targetVersion: packageVersion,
            draft: false,
            mergeable: true,
            mergeableState: 'clean',
            baseSha: 'base-sha',
            platformAutomerge: true,
            automergeType: 'pr',
            checkRuns: required.map((name) => ({ name, status: 'completed', conclusion: 'success' }))
        }
    });
    assert.equal(decision.decision, 'merge');

    const majorRequired = resolveGroupChecks(requiredCatalog, FSUSUI_RELEASE_TRAIN_MANAGER, 'major');
    assert.ok(majorRequired.length > 0);
    const failedMajor = evaluatePlatformAutomerge({
        catalog: requiredCatalog,
        defaultHeadSha: 'base-sha',
        latestStable: '2.0.0',
        pullRequest: {
            number: 1986,
            group: FSUSUI_RELEASE_TRAIN_MANAGER,
            updateType: 'major',
            targetVersion: '2.0.0',
            draft: false,
            mergeable: true,
            mergeableState: 'clean',
            baseSha: 'base-sha',
            platformAutomerge: true,
            automergeType: 'pr',
            failedHours: 24,
            checkRuns: majorRequired.map((name, index) => ({
                name,
                status: 'completed',
                conclusion: index === 0 ? 'failure' : 'success'
            }))
        }
    });
    assert.notEqual(failedMajor.decision, 'merge');
    assert.equal(failedMajor.close, false);
    assert.equal(failedMajor.downgrade, false);
    assert.equal(failedMajor.restorePrevious, false);
});

test('workflow serializes verification, both contract suites, and one regular updater', () =>
{
    const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/fsusui-release-train.yml'), 'utf8');
    const verifier = workflow.indexOf('verify-fsusui-release-event.mjs');
    const contracts = workflow.indexOf('fsusui-release-orchestration.test.mjs');
    const updater = workflow.indexOf('update-fsusui-release.mjs');
    assert.ok(verifier >= 0 && contracts > verifier && updater > contracts);
    assert.match(workflow, /repository_dispatch:[\s\S]*fsusui-npm-published-v1/u);
    assert.match(workflow, /concurrency:\s*\n\s*group: fsusui-release-train\s*\n\s*cancel-in-progress: false/u);
    assert.match(workflow, /node --test tests\/tools\/fsusui-release-train\.test\.mjs tests\/tools\/fsusui-release-orchestration\.test\.mjs/u);
    assert.match(workflow, /--receipt \.tmp\/fsusui-release-train\/receipt\.json/u);
    assert.doesNotMatch(workflow, /--first-migration/u);
    assert.doesNotMatch(workflow, /package\.json.*replace|replace.*package\.json/u);
    assert.doesNotMatch(workflow, new RegExp(`${privatePackageToken}|${privateRegistryHost.replaceAll('.', '\\.')}`, 'u'));
    assert.match(workflow, /actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/u);
    assert.match(workflow, /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/u);
    assert.equal(PACKAGE_NAME, '@ozwasyd/element-plus');
});
