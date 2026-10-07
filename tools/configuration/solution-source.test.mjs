import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectSolutionSource, validateSolutionSourceReceipt } from './check-solution-source.mjs';

function fixture(source, action)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-solution-source-'));
    try
    {
        const directory = path.join(root, 'tools/contracts');
        fs.mkdirSync(path.join(directory, 'Sample'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'Sample/Example.csproj'), '<Project />\n');
        fs.writeFileSync(path.join(directory, 'Sample.slnx'), source);
        const git = (...args) => execFileSync('git', ['-C', root, ...args],
            { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
        git('init', '--quiet');
        git('add', '.');
        const tree = git('write-tree').toString('utf8').trim();
        const commit = execFileSync('git', ['-C', root, 'commit-tree', tree],
            { input: 'controlled solution source fixture\n', env: { ...process.env,
                GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString('utf8').trim();
        git('update-ref', 'HEAD', commit);
        return action({ root, directory, git });
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const valid = '<Solution>\n    <Project Path="Sample/Example.csproj" />\n</Solution>\n';
const inspect = root => inspectSolutionSource({ repositoryRoot: root, files: ['tools/contracts/Sample.slnx'] });

test('flat solution inspection binds actual project source without evaluating it', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        const result = inspect(root);
        assert.equal(result.status, 'success');
        assert.equal(result.qualificationEligible, false);
        assert.equal(result.solutions.length, 1);
        assert.deepEqual(result.solutions[0].projects.map(value => value.file), ['tools/contracts/Sample/Example.csproj']);
        assert.equal(result.solutions[0].projects[0].bytes, 12);
        assert.ok(result.parser.sha256);
        assert.deepEqual(fs.readdirSync(path.join(directory, 'Sample')), ['Example.csproj']);
    });
});

test('malformed XML and declarations or external entities are refused', () =>
{
    for (const source of ['<Solution><Project Path="Sample/Example.csproj"></Solution>',
        '<!DOCTYPE Solution><Solution><Project Path="Sample/Example.csproj" /></Solution>',
        '<!DOCTYPE Solution [<!ENTITY file SYSTEM "file:///etc/passwd">]><Solution>&file;</Solution>'])
    {
        fixture(source, ({ root }) => assert.throws(() => inspect(root), /solution XML refused/u));
    }
});

test('numeric predefined entity aliases and processing instructions cannot become literal project paths', () =>
{
    for (const value of ['Sample&#47;Example.csproj', 'Sample&#x2f;Example.csproj',
        'Sample/Example&apos;.csproj', 'Sample/Example&amp;.csproj'])
    {
        fixture(`<Solution><Project Path="${value}" /></Solution>`,
            ({ root }) => assert.throws(() => inspect(root), /source entity references/u));
    }
    fixture('<?command ignored?><Solution><Project Path="Sample/Example.csproj" /></Solution>',
        ({ root }) => assert.throws(() => inspect(root), /processing instructions/u));
});

test('source admission compares the closed complete receipt against independent current HEAD and bindings', () =>
{
    fixture(valid, ({ root }) =>
    {
        const actual = inspect(root);
        const validate = receipt => validateSolutionSourceReceipt({ repositoryRoot: root,
            files: ['tools/contracts/Sample.slnx'], expectedHead: actual.head, receipt });
        assert.deepEqual(validate(JSON.parse(JSON.stringify(actual))), actual);
        const mutations = [
            value =>
            {
                value.head = '0'.repeat(40);
            },
            value =>
            {
                value.indexDigest = '0'.repeat(64);
            },
            value =>
            {
                value.solutions[0].sha256 = '0'.repeat(64);
            },
            value =>
            {
                value.solutions[0].projects[0].file = 'tools/contracts/Alias.csproj';
            },
            value =>
            {
                value.solutions[0].projects = [];
            },
            value =>
            {
                value.uncheckedField = true;
            },
            value =>
            {
                value.solutions[0].projects[0].uncheckedField = true;
            }
        ];
        for (const mutate of mutations)
        {
            const receipt = JSON.parse(JSON.stringify(actual));
            mutate(receipt);
            assert.throws(() => validate(receipt), /independent current source projection/u);
        }
        assert.throws(() => validateSolutionSourceReceipt({ repositoryRoot: root,
            files: ['tools/contracts/Sample.slnx'], expectedHead: '0'.repeat(40), receipt: actual }),
        /independent current source projection/u);
        assert.throws(() => validateSolutionSourceReceipt({ repositoryRoot: root,
            files: ['tools/contracts/Sample.slnx'], receipt: actual }), /independent candidate HEAD/u);
    });
});

test('unknown elements attributes nested structures and text remain unsupported', () =>
{
    for (const source of ['<Solution Version="1"><Project Path="Sample/Example.csproj" /></Solution>',
        '<Solution><Folder><Project Path="Sample/Example.csproj" /></Folder></Solution>',
        '<Solution><Project Path="Sample/Example.csproj" Type="test" /></Solution>',
        '<Solution>unexpected<Project Path="Sample/Example.csproj" /></Solution>'])
    {
        fixture(source, ({ root }) => assert.throws(() => inspect(root), /solution XML refused/u));
    }
});

test('escaping substituted and duplicate project paths cannot receive source coverage', () =>
{
    for (const project of ['../Example.csproj', '/tmp/Example.csproj', 'Sample\\Example.csproj',
        '$(Project).csproj', 'Sample//Example.csproj'])
    {
        fixture(`<Solution><Project Path="${project}" /></Solution>`,
            ({ root }) => assert.throws(() => inspect(root), /normalized relative/u));
    }
    fixture('<Solution><Project Path="Sample/Example.csproj" /><Project Path="Sample/Example.csproj" /></Solution>',
        ({ root }) => assert.throws(() => inspect(root), /duplicate project/u));
});

test('missing linked and uncommitted project sources are refused', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        fs.unlinkSync(path.join(directory, 'Sample/Example.csproj'));
        assert.throws(() => inspect(root), /ENOENT/u);
    });
    fixture(valid, ({ root, directory }) =>
    {
        const project = path.join(directory, 'Sample/Example.csproj');
        fs.renameSync(project, path.join(directory, 'other.csproj'));
        fs.symlinkSync('../other.csproj', project);
        assert.throws(() => inspect(root), /ELOOP/u);
    });
    fixture(valid, ({ root, directory }) =>
    {
        fs.appendFileSync(path.join(directory, 'Sample/Example.csproj'), 'changed');
        assert.throws(() => inspect(root), /HEAD\/index\/physical/u);
    });
});

test('linked ancestors and hardlinked project aliases are refused', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        fs.renameSync(path.join(directory, 'Sample'), path.join(directory, 'Actual'));
        fs.symlinkSync('Actual', path.join(directory, 'Sample'));
        assert.throws(() => inspect(root), /linked or non-directory ancestor/u);
    });
    fixture(valid, ({ root, directory }) =>
    {
        fs.linkSync(path.join(directory, 'Sample/Example.csproj'), path.join(directory, 'Alias.csproj'));
        assert.throws(() => inspect(root), /single-link/u);
    });
});

test('the solution itself and exact caller arguments cannot be replaced by declarations', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        fs.appendFileSync(path.join(directory, 'Sample.slnx'), 'changed');
        assert.throws(() => inspect(root), /HEAD\/index\/physical/u);
        assert.throws(() => inspectSolutionSource({ repositoryRoot: root, files: ['../Sample.slnx'] }), /normalized relative/u);
        const checker = fileURLToPath(new URL('./check-solution-source.mjs', import.meta.url));
        const result = spawnSync(process.execPath, [checker, '--root', root, '--file', 'tools/contracts/Sample.slnx', '--write'],
            { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /accepts only/u);
    });
});

test('a source change during the final Git binding recheck is refused through the held descriptor', () =>
{
    fixture(valid, ({ root, directory }) =>
    {
        const original = childProcess.execFileSync;
        let indexReads = 0;
        childProcess.execFileSync = (command, args, options) =>
        {
            if (command === 'git' && args.includes('ls-files') && !args.includes('--'))
            {
                indexReads += 1;
                if (indexReads === 2)
                {
                    fs.appendFileSync(path.join(directory, 'Sample/Example.csproj'), 'drift');
                }
            }
            return original(command, args, options);
        };
        syncBuiltinESMExports();
        try
        {
            assert.throws(() => inspect(root), /identity changed during inspection/u);
            assert.equal(indexReads, 2);
        }
        finally
        {
            childProcess.execFileSync = original;
            syncBuiltinESMExports();
        }
    });
});
