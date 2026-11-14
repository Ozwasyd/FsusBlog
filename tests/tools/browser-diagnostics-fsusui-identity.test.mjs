import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const baselineCli = path.join(root, 'tools/test/fsusui-baseline.mjs');
const identityCli = path.join(root, 'tests/browser-diagnostics/local-fsusui-identity.mjs');
const identitySchema = 'fsusblog.browser-diagnostics.local-fsusui-identity.v1';
const pinnedCommit = execFileSync(process.execPath, [baselineCli, '--commit'], {
    encoding: 'utf8'
}).trim();

function resolveIdentity({ root: fsusUiRoot, expectedCommit, env } = {})
{
    const args = [identityCli];
    if (fsusUiRoot)
    {
        args.push('--root', fsusUiRoot);
    }
    if (expectedCommit)
    {
        args.push('--expected-commit', expectedCommit);
    }
    try
    {
        return JSON.parse(execFileSync(process.execPath, args, {
            encoding: 'utf8',
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        }));
    }
    catch (error)
    {
        throw new Error(
            String(error?.stderr || error?.message || error).trim(),
            { cause: error }
        );
    }
}

function git(repository, ...args)
{
    return execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

function write(repository, relativePath, contents)
{
    const target = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
}

function createFixture(t)
{
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusui-identity-'));
    t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
    git(repository, 'init', '--quiet', '--initial-branch=main');
    git(repository, 'config', 'user.name', 'FsusBlog fixture');
    git(repository, 'config', 'user.email', 'fixture@fsus.blog');
    write(repository, '.gitignore', 'vue/packages/theme-chalk/dist/\n');
    write(repository, 'vue/packages/element-plus/index.ts', 'export const version = "fixture"\n');
    write(repository, 'vue/packages/icons-vue/src/index.ts', 'export const FixtureIcon = {}\n');
    write(repository, 'vue/packages/components/public-shell/index.ts', 'export { default as ElPublicShell } from "./src/public-shell.vue"\n');
    write(repository, 'vue/packages/components/public-shell/src/public-shell.vue', '<template><main>fixture</main></template>\n');
    write(repository, 'vue/packages/utils/index.ts', 'export const withInstall = (value) => value\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '--quiet', '-m', 'fixture');
    write(repository, 'vue/packages/theme-chalk/dist/index.css', ':root{--fixture:1}\n');
    write(repository, 'vue/packages/theme-chalk/dist/el-public-shell-critical.css', '.shell{display:grid}\n');
    write(repository, 'vue/packages/theme-chalk/dist/el-fsus-theme.css', '.shell{color:CanvasText}\n');
    return { repository, commit: git(repository, 'rev-parse', 'HEAD') };
}

test('FsusUI baseline CLI exports the canonical commit for local and workflow consumers', (t) =>
{
    const outputFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'fsusui-baseline-output-')),
        'github-output'
    );
    t.after(() => fs.rmSync(path.dirname(outputFile), { recursive: true, force: true }));

    const commit = execFileSync(process.execPath, [baselineCli, '--commit'], {
        encoding: 'utf8'
    }).trim();
    execFileSync(
        process.execPath,
        [baselineCli, '--github-output', outputFile],
        { encoding: 'utf8' }
    );

    assert.equal(commit, pinnedCommit);
    assert.equal(fs.readFileSync(outputFile, 'utf8'), `commit=${pinnedCommit}\n`);
});

test('workflow exports and checks out the exact pinned FsusUI identity', () =>
{
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/browser-diagnostics.yml'), 'utf8');
    const qualityGate = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    assert.match(workflow, /ref: \$\{\{ steps\.fsusui-baseline\.outputs\.commit \}\}/u);
    assert.match(workflow, /node tools\/test\/fsusui-baseline\.mjs --github-output "\$GITHUB_OUTPUT"/u);
    assert.match(workflow, /repository: Ozwasyd\/FsusUI[\s\S]*?token: \$\{\{ secrets\.GITHUB_PACKAGES_TOKEN \|\| github\.token \}\}[\s\S]*?persist-credentials: false/u);
    assert.match(workflow, /node tests\/browser-diagnostics\/local-fsusui-identity\.mjs/u);
    assert.match(qualityGate, /repository: Ozwasyd\/FsusUI[\s\S]*?token: \$\{\{ github\.token \}\}[\s\S]*?persist-credentials: false/u);
});

test('local FsusUI identity is stable, path-independent and binds source plus generated theme dist', (t) =>
{
    const first = createFixture(t);
    const second = createFixture(t);
    const firstIdentity = resolveIdentity({
        root: first.repository,
        expectedCommit: first.commit
    });
    const repeatedIdentity = resolveIdentity({
        expectedCommit: first.commit,
        env: {
            FSUSBLOG_LOCAL_FSUSUI_ROOT: first.repository
        }
    });
    const secondIdentity = resolveIdentity({
        root: second.repository,
        expectedCommit: second.commit
    });

    assert.deepEqual(repeatedIdentity, firstIdentity);
    assert.equal(firstIdentity.schema, identitySchema);
    assert.equal(firstIdentity.commit, first.commit);
    assert.equal(firstIdentity.expectedCommit, first.commit);
    assert.equal(firstIdentity.worktreeState, 'clean');
    assert.equal(firstIdentity.source.fileCount, 5);
    assert.equal(firstIdentity.themeDist.fileCount, 3);
    assert.match(firstIdentity.source.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.match(firstIdentity.themeDist.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.match(firstIdentity.contentDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(secondIdentity.source.sha256, firstIdentity.source.sha256);
    assert.equal(secondIdentity.themeDist.sha256, firstIdentity.themeDist.sha256);

    write(first.repository, 'vue/packages/theme-chalk/dist/el-fsus-theme.css', '.shell{color:Highlight}\n');
    const rebuiltIdentity = resolveIdentity({
        root: first.repository,
        expectedCommit: first.commit
    });
    assert.equal(rebuiltIdentity.source.sha256, firstIdentity.source.sha256);
    assert.notEqual(rebuiltIdentity.themeDist.sha256, firstIdentity.themeDist.sha256);
    assert.notEqual(rebuiltIdentity.contentDigest, firstIdentity.contentDigest);
});

test('local FsusUI identity rejects dirty, unpinned and incomplete inputs', (t) =>
{
    const fixture = createFixture(t);
    assert.throws(
        () => resolveIdentity({ root: fixture.repository, expectedCommit: '0'.repeat(40) }),
        /does not match expected commit/u
    );

    write(fixture.repository, 'vue/packages/components/public-shell/index.ts', 'dirty\n');
    assert.throws(
        () => resolveIdentity({ root: fixture.repository, expectedCommit: fixture.commit }),
        /worktree must be clean/u
    );
    git(fixture.repository, 'checkout', '--quiet', '--', 'vue/packages/components/public-shell/index.ts');
    write(fixture.repository, 'untracked.txt', 'untracked\n');
    assert.throws(
        () => resolveIdentity({ root: fixture.repository, expectedCommit: fixture.commit }),
        /worktree must be clean/u
    );

    fs.rmSync(path.join(fixture.repository, 'untracked.txt'));
    fs.rmSync(path.join(fixture.repository, 'vue/packages/theme-chalk/dist/index.css'));
    assert.throws(
        () => resolveIdentity({ root: fixture.repository, expectedCommit: fixture.commit }),
        /identity input is missing/u
    );
    assert.throws(
        () => resolveIdentity({
            root: fixture.repository,
            expectedCommit: 'not-a-commit'
        }),
        /FsusUI baseline must be a full lowercase Git commit/u
    );
});
