import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as sourceChecker from './check-solution-source.mjs';

const { inspectPythonSource, inspectSolutionSource, validatePythonSourceReceipt, validateSolutionSourceReceipt } = sourceChecker;
const { validateCommitRange } = await import(new URL('../governance/change-contract.mjs', import.meta.url));

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

function pythonFixture(source, action)
{
    return fixture(valid, ({ root, directory, git }) =>
    {
        const file = 'tools/contracts/Sample/Example.py';
        fs.writeFileSync(path.join(root, file), source);
        git('add', '.');
        const tree = git('write-tree').toString('utf8').trim();
        const commit = execFileSync('git', ['-C', root, 'commit-tree', tree],
            { input: 'controlled Python AST source fixture\n', env: { ...process.env,
                GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString('utf8').trim();
        git('update-ref', 'HEAD', commit);
        return action({ root, directory, git, file });
    });
}

const inspectPython = (root, file) => inspectPythonSource({ repositoryRoot: root, files: [file] });

test('Python AST syntax does not execute imports bodies bytecode or lifecycle', () =>
{
    pythonFixture('import nonexistent_source_dependency\nraise RuntimeError("never executed")\n', ({ root, directory, git, file }) =>
    {
        const source = path.join(root, file);
        fs.appendFileSync(source, `open(${JSON.stringify(path.join(directory, 'marker'))}, "w").write("executed")\n`);
        git('add', '.');
        const tree = git('write-tree').toString('utf8').trim();
        const commit = execFileSync('git', ['-C', root, 'commit-tree', tree],
            { input: 'controlled marker source\n', env: { ...process.env,
                GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString('utf8').trim();
        git('update-ref', 'HEAD', commit);
        const before = { head: git('rev-parse', 'HEAD'), index: fs.readFileSync(path.join(root, '.git/index')),
            refs: git('show-ref'), status: git('status', '--porcelain=v1') };
        const result = inspectPython(root, file);
        assert.equal(result.status, 'success');
        assert.equal(result.qualificationEligible, false);
        assert.equal(result.sources[0].file, file);
        assert.equal(result.sources[0].bytes, fs.statSync(source).size);
        assert.equal(result.parser.executable, fs.realpathSync('/usr/bin/python3'));
        assert.match(result.parser.version, /^3\.\d+\.\d+ /u);
        assert.match(result.parser.sha256, /^[a-f0-9]{64}$/u);
        assert.deepEqual(fs.readdirSync(path.join(directory, 'Sample')), ['Example.csproj', 'Example.py']);
        assert.equal(fs.existsSync(path.join(directory, 'marker')), false);
        assert.deepEqual(git('rev-parse', 'HEAD'), before.head);
        assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), before.index);
        assert.deepEqual(git('show-ref'), before.refs);
        assert.deepEqual(git('status', '--porcelain=v1'), before.status);
        const checker = fileURLToPath(new URL('./check-solution-source.mjs', import.meta.url));
        const cli = spawnSync(process.execPath, [checker, '--language', 'python-ast', '--root', root, '--file', file],
            { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        assert.deepEqual(JSON.parse(cli.stdout), result);
    });
});

test('Python AST refuses malformed UTF-8 syntax and bounded input overflow', () =>
{
    for (const [source, error] of [[Buffer.from([0xff]), /not exact UTF-8/u],
        ['def invalid(:\n', /Python AST source refused/u],
        [Buffer.alloc(1024 * 1024 + 1, 32), /bounded file size/u]])
    {
        pythonFixture(source, ({ root, file }) => assert.throws(() => inspectPython(root, file), error));
    }
});

test('Python AST reuses regular single-link source HEAD index and path refusals', () =>
{
    const source = 'value = 1\n';
    pythonFixture(source, ({ root, directory, file }) =>
    {
        const target = path.join(root, file);
        fs.renameSync(target, path.join(directory, 'Actual.py'));
        fs.symlinkSync('../Actual.py', target);
        assert.throws(() => inspectPython(root, file), /ELOOP/u);
    });
    pythonFixture(source, ({ root, directory, file }) =>
    {
        fs.renameSync(path.join(directory, 'Sample'), path.join(directory, 'Actual'));
        fs.symlinkSync('Actual', path.join(directory, 'Sample'));
        assert.throws(() => inspectPython(root, file), /linked or non-directory ancestor/u);
    });
    pythonFixture(source, ({ root, directory, file }) =>
    {
        fs.linkSync(path.join(root, file), path.join(directory, 'Alias.py'));
        assert.throws(() => inspectPython(root, file), /single-link/u);
    });
    pythonFixture(source, ({ root, file }) =>
    {
        fs.appendFileSync(path.join(root, file), 'changed');
        assert.throws(() => inspectPython(root, file), /HEAD\/index\/physical/u);
        assert.throws(() => inspectPython(root, '../Example.py'), /normalized relative/u);
        assert.throws(() => inspectPythonSource({ repositoryRoot: root, files: [file, file] }), /distinct explicit/u);
    });
});

test('Python AST receipt cannot substitute HEAD source parser version limits or extra output', () =>
{
    pythonFixture('value = 1\n', ({ root, file }) =>
    {
        const actual = inspectPython(root, file);
        const validate = receipt => validatePythonSourceReceipt({ repositoryRoot: root,
            files: [file], expectedHead: actual.head, receipt });
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
                value.sources = [];
            },
            value =>
            {
                value.sources[0].sha256 = '0'.repeat(64);
            },
            value =>
            {
                value.sources[0].mode = '100755';
            },
            value =>
            {
                value.parser.version = '3.0.0 foreign';
            },
            value =>
            {
                value.parser.sourceSha256 = '0'.repeat(64);
            },
            value =>
            {
                value.limits.timeoutMs = 0;
            },
            value =>
            {
                value.extra = true;
            },
            value =>
            {
                value.sources[0].extra = true;
            }
        ];
        for (const mutate of mutations)
        {
            const changed = JSON.parse(JSON.stringify(actual));
            mutate(changed);
            assert.throws(() => validate(changed), /independent current source projection/u);
        }
        assert.throws(() => validatePythonSourceReceipt({ repositoryRoot: root, files: [file],
            expectedHead: '0'.repeat(40), receipt: actual }), /independent current source projection/u);
        assert.throws(() => validatePythonSourceReceipt({ repositoryRoot: root, files: [file], receipt: actual }), /independent candidate HEAD/u);
    });
});

test('Python AST held descriptor refuses input replacement during the final index recheck', () =>
{
    for (const replace of [false, true])
    {
        pythonFixture('value = 1\n', ({ root, file }) =>
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
                        if (replace)
                        {
                            fs.renameSync(path.join(root, file), path.join(root, `${file}.original`));
                        }
                        fs.writeFileSync(path.join(root, file), 'value = 2\n');
                    }
                }
                return original(command, args, options);
            };
            syncBuiltinESMExports();
            try
            {
                assert.throws(() => inspectPython(root, file), /identity changed during inspection/u);
                assert.equal(indexReads, 2);
            }
            finally
            {
                childProcess.execFileSync = original;
                syncBuiltinESMExports();
            }
        });
    }
});

test('Python AST fixed worker refuses added fields and ignores caller Python import paths', () =>
{
    pythonFixture('value = 1\n', ({ root, directory, file }) =>
    {
        const original = childProcess.spawnSync;
        childProcess.spawnSync = (...args) =>
        {
            const result = original(...args);
            if (args[0] === fs.realpathSync('/usr/bin/python3'))
            {
                const parsed = JSON.parse(result.stdout);
                parsed.extra = true;
                result.stdout = JSON.stringify(parsed);
            }
            return result;
        };
        syncBuiltinESMExports();
        try
        {
            assert.throws(() => inspectPython(root, file), /worker output/u);
        }
        finally
        {
            childProcess.spawnSync = original;
            syncBuiltinESMExports();
        }
        fs.writeFileSync(path.join(directory, 'ast.py'), 'raise RuntimeError("foreign import must not run")\n');
        const previous = process.env.PYTHONPATH;
        process.env.PYTHONPATH = directory;
        try
        {
            assert.equal(inspectPython(root, file).status, 'success');
            assert.equal(fs.existsSync(path.join(directory, '__pycache__')), false);
        }
        finally
        {
            if (previous === undefined)
            {
                delete process.env.PYTHONPATH;
            }
            else
            {
                process.env.PYTHONPATH = previous;
            }
        }
    });
});

test('Python AST bounded FD reader refuses growth after the small initial stat without reading beyond cap plus one', () =>
{
    pythonFixture('value = 1\n', ({ root, file }) =>
    {
        const target = path.join(root, file);
        const sourceStat = fs.statSync(target, { bigint: true });
        const limit = 1024 * 1024;
        const originalStat = fs.fstatSync;
        const originalRead = fs.readSync;
        const originalReadFile = fs.readFileSync;
        const originalSpawn = childProcess.spawnSync;
        let descriptor = null;
        let initialSize = null;
        let grew = false;
        let requested = 0;
        let returned = 0;
        let workerSpawns = 0;
        fs.fstatSync = (actual, options) =>
        {
            const result = originalStat(actual, options);
            if (options?.bigint && result.dev === sourceStat.dev && result.ino === sourceStat.ino)
            {
                descriptor = actual;
                initialSize = result.size;
            }
            return result;
        };
        fs.readSync = (actual, buffer, offset, length, position) =>
        {
            if (actual === descriptor)
            {
                if (!grew)
                {
                    fs.truncateSync(target, limit + 32);
                    grew = true;
                }
                requested += length;
            }
            const count = originalRead(actual, buffer, offset, length, position);
            if (actual === descriptor)
            {
                returned += count;
            }
            return count;
        };
        fs.readFileSync = (actual, ...args) =>
        {
            assert.notEqual(actual, descriptor, 'bounded Python source must not use an unbounded FD read');
            return originalReadFile(actual, ...args);
        };
        childProcess.spawnSync = (...args) =>
        {
            workerSpawns += 1;
            return originalSpawn(...args);
        };
        syncBuiltinESMExports();
        try
        {
            assert.throws(() => inspectPython(root, file), /bounded file size/u);
            assert.equal(initialSize, sourceStat.size);
            assert.ok(initialSize < BigInt(limit));
            assert.equal(grew, true);
            assert.equal(requested, limit + 1);
            assert.equal(returned, limit + 1);
            assert.equal(workerSpawns, 0);
            assert.throws(() => originalStat(descriptor), /EBADF/u);
        }
        finally
        {
            fs.fstatSync = originalStat;
            fs.readSync = originalRead;
            fs.readFileSync = originalReadFile;
            childProcess.spawnSync = originalSpawn;
            syncBuiltinESMExports();
        }
    });
});

test('Python AST batch budget refuses the next committed source before reading or parsing beyond eight MiB', () =>
{
    pythonFixture('value = 1\n', ({ root, directory, git, file }) =>
    {
        const files = [];
        const buffer = Buffer.alloc(64 * 1024, 35);
        for (let index = 0; index < 8; index += 1)
        {
            const name = `tools/contracts/Sample/Bounded${index}.py`;
            files.push(name);
            const descriptor = fs.openSync(path.join(root, name), 'wx');
            try
            {
                for (let chunk = 0; chunk < 16; chunk += 1)
                {
                    fs.writeSync(descriptor, buffer);
                }
            }
            finally
            {
                fs.closeSync(descriptor);
            }
        }
        files.push(file);
        git('add', '.');
        const tree = git('write-tree').toString('utf8').trim();
        const commit = execFileSync('git', ['-C', root, 'commit-tree', tree],
            { input: 'controlled bounded Python batch fixture\n', env: { ...process.env,
                GIT_AUTHOR_NAME: 'Source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString('utf8').trim();
        git('update-ref', 'HEAD', commit);
        const inodes = new Set(files.map(value => fs.statSync(path.join(root, value), { bigint: true }).ino));
        const originalStat = fs.fstatSync;
        const originalRead = fs.readSync;
        const originalSpawn = childProcess.spawnSync;
        const descriptors = new Set();
        let returned = 0;
        let workerSpawns = 0;
        fs.fstatSync = (actual, options) =>
        {
            const result = originalStat(actual, options);
            if (options?.bigint && inodes.has(result.ino))
            {
                descriptors.add(actual);
            }
            return result;
        };
        fs.readSync = (actual, ...args) =>
        {
            const count = originalRead(actual, ...args);
            if (descriptors.has(actual))
            {
                returned += count;
            }
            return count;
        };
        childProcess.spawnSync = (...args) =>
        {
            workerSpawns += 1;
            return originalSpawn(...args);
        };
        syncBuiltinESMExports();
        try
        {
            assert.throws(() => inspectPythonSource({ repositoryRoot: root, files }), /bounded file size/u);
            assert.equal(returned, 8 * 1024 * 1024);
            assert.equal(workerSpawns, 8);
            assert.equal(fs.existsSync(path.join(directory, 'Sample/__pycache__')), false);
        }
        finally
        {
            fs.fstatSync = originalStat;
            fs.readSync = originalRead;
            childProcess.spawnSync = originalSpawn;
            syncBuiltinESMExports();
        }
    });
});


const blameFile = '.git-blame-ignore-revs';

function blameFixture(action, { extension = 'cs', semantic = false, register = true } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-blame-source-'));
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0',
        GIT_AUTHOR_NAME: 'Blame source fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Blame source fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { env });
    const commit = message =>
    {
        git('add', '.');
        const tree = git('write-tree').toString('utf8').trim();
        const current = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { env, encoding: 'utf8' });
        const parents = current.status === 0 ? ['-p', current.stdout.trim()] : [];
        const revision = execFileSync('git', ['-C', root, 'commit-tree', tree, ...parents],
            { env, input: message }).toString('utf8').trim();
        git('update-ref', 'HEAD', revision);
        return revision;
    };
    try
    {
        git('init', '--quiet');
        const file = 'source.' + extension;
        fs.writeFileSync(path.join(root, blameFile), '');
        fs.writeFileSync(path.join(root, file), extension === 'cs' ? 'class Fixture { }\n' : 'export const value = 1;\n');
        const base = commit('test(tooling): initialize controlled blame source\n\nRefs: #1163\n');
        fs.writeFileSync(path.join(root, file), extension === 'cs'
            ? semantic ? 'class ChangedFixture { }\n' : 'class Fixture    {    }\n'
            : semantic ? 'export const value = 2;\n' : 'export const value  =  1;\n');
        const format = commit('style(frontend): normalize controlled source whitespace\n\n'
            + 'Change-Class: format-only\nFormatter: source-fixture@1 :: source-fixture\n'
            + 'Idempotence-Evidence: artifacts/style/idempotence.json\nRefs: #1163\n');
        if (register)
        {
            fs.writeFileSync(path.join(root, blameFile), format + '\n');
            commit('chore(governance): register controlled format revision\n\nRefs: #1163\n');
        }
        return action({ root, base, format, git, commit, env });
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const inspectBlame = root =>
{
    assert.equal(typeof sourceChecker.inspectBlameIgnoreSource, 'function');
    return sourceChecker.inspectBlameIgnoreSource({ repositoryRoot: root, files: [blameFile] });
};

test('canonical blame source binds actual registered format history and the normal checker CLI', () =>
{
    blameFixture(({ root, format, git }) =>
    {
        const actual = inspectBlame(root);
        assert.equal(actual.status, 'success');
        assert.equal(actual.qualificationEligible, false);
        assert.equal(actual.head, git('rev-parse', 'HEAD').toString('utf8').trim());
        assert.deepEqual(actual.revisions, [format]);
        assert.deepEqual(actual.sources.map(value => value.file), [blameFile]);
        const checker = fileURLToPath(new URL('./check-solution-source.mjs', import.meta.url));
        const cli = spawnSync(process.execPath, [checker, '--language', 'git-blame-ignore',
            '--root', root, '--file', blameFile], { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        assert.deepEqual(JSON.parse(cli.stdout), actual);
    });
});

test('canonical blame source invokes the existing JavaScript AST equivalence boundary', () =>
{
    blameFixture(({ root }) => assert.equal(inspectBlame(root).status, 'success'), { extension: 'mjs' });
    blameFixture(({ root }) => assert.throws(() => inspectBlame(root), /Format-only diff changes non-whitespace or quoted-value tokens/u),
        { extension: 'mjs', semantic: true });
    blameFixture(({ root }) => assert.throws(() => inspectBlame(root), /Format-only diff changes non-whitespace or quoted-value tokens/u),
        { semantic: true });
});

test('canonical blame source refuses malformed missing duplicate unreachable and merge revision entries', () =>
{
    for (const mutate of [
        ({ root }) => fs.writeFileSync(path.join(root, blameFile), 'not-a-sha\n'),
        ({ root }) => fs.writeFileSync(path.join(root, blameFile), '0'.repeat(40) + '\n'),
        ({ root, format }) => fs.writeFileSync(path.join(root, blameFile), format + '\n' + format + '\n'),
        ({ root, base, git, env }) =>
        {
            const tree = git('rev-parse', 'HEAD^{tree}').toString('utf8').trim();
            const revision = execFileSync('git', ['-C', root, 'commit-tree', tree, '-p', base],
                { env, input: 'style(frontend): create unreachable controlled revision\n' }).toString('utf8').trim();
            fs.writeFileSync(path.join(root, blameFile), revision + '\n');
        },
        ({ root, base, git, env }) =>
        {
            const tree = git('rev-parse', 'HEAD^{tree}').toString('utf8').trim();
            const head = git('rev-parse', 'HEAD').toString('utf8').trim();
            const revision = execFileSync('git', ['-C', root, 'commit-tree', tree, '-p', head, '-p', base],
                { env, input: 'style(frontend): merge controlled format history\n' }).toString('utf8').trim();
            git('update-ref', 'HEAD', revision);
            fs.writeFileSync(path.join(root, blameFile), revision + '\n');
        }
    ])
    {
        blameFixture(control =>
        {
            mutate(control);
            control.commit('test(governance): register rejected blame input\n\nRefs: #1163\n');
            assert.throws(() => inspectBlame(control.root), /blame-ignore/u);
        });
    }
});

test('canonical blame source preserves missing path link mode working-tree and index refusals', () =>
{
    for (const mutate of [
        root => fs.rmSync(path.join(root, blameFile)),
        root => fs.writeFileSync(path.join(root, blameFile), '# unstaged source drift\n'),
        root => fs.chmodSync(path.join(root, blameFile), 0o755),
        root =>
        {
            fs.renameSync(path.join(root, blameFile), path.join(root, 'original-blame'));
            fs.symlinkSync('original-blame', path.join(root, blameFile));
        },
        root => fs.linkSync(path.join(root, blameFile), path.join(root, 'blame-alias')),
        root =>
        {
            fs.writeFileSync(path.join(root, blameFile), '# staged source drift\n');
            execFileSync('git', ['-C', root, 'add', blameFile]);
        }
    ])
    {
        blameFixture(({ root }) =>
        {
            mutate(root);
            assert.throws(() => inspectBlame(root), /ENOENT|ELOOP|regular|single-link|HEAD|index|bytes|mode/u);
        });
    }
    blameFixture(({ root }) =>
    {
        for (const files of [[], [blameFile, blameFile], ['nested/' + blameFile], ['../' + blameFile], ['other.input']])
        {
            assert.throws(() => sourceChecker.inspectBlameIgnoreSource({ repositoryRoot: root, files }), /canonical/u);
        }
        for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
        {
            const previous = process.env[key];
            process.env[key] = path.join(root, 'alternate-git-input');
            try
            {
                assert.throws(() => inspectBlame(root), /ambient alternate Git/u);
            }
            finally
            {
                if (previous === undefined)
                {
                    delete process.env[key];
                }
                else
                {
                    process.env[key] = previous;
                }
            }
        }
    });
});

test('canonical blame receipt cannot substitute HEAD source history or qualification', () =>
{
    blameFixture(({ root }) =>
    {
        const actual = inspectBlame(root);
        const validate = (receipt, expectedHead = actual.head) => sourceChecker.validateBlameIgnoreSourceReceipt({
            repositoryRoot: root, files: [blameFile], expectedHead, receipt });
        assert.deepEqual(validate(JSON.parse(JSON.stringify(actual))), actual);
        for (const mutate of [
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
                value.sources[0].sha256 = '0'.repeat(64);
            },
            value =>
            {
                value.revisions = [];
            },
            value =>
            {
                value.qualificationEligible = true;
            },
            value =>
            {
                value.validator = 'caller-approval';
            },
            value =>
            {
                value.extraApproval = true;
            }
        ])
        {
            const changed = structuredClone(actual);
            mutate(changed);
            assert.throws(() => validate(changed), /receipt/u);
        }
        assert.throws(() => validate(actual, '0'.repeat(40)), /receipt/u);
    });
});

test('canonical blame held input and whole index refuse drift during the final Git recheck', () =>
{
    for (const drift of ['source', 'index'])
    {
        blameFixture(({ root, git }) =>
        {
            const original = childProcess.execFileSync;
            let indexes = 0;
            childProcess.execFileSync = (executable, args, options) =>
            {
                if (executable === 'git' && args[0] === '-C' && args[1] === root
                    && args.length === 5 && args.slice(2).join(' ') === 'ls-files --stage -z' && ++indexes === 2)
                {
                    if (drift === 'source')
                    {
                        fs.writeFileSync(path.join(root, blameFile), '# replaced during validation\n');
                    }
                    else
                    {
                        git('update-index', '--chmod=+x', 'source.cs');
                    }
                }
                return original(executable, args, options);
            };
            syncBuiltinESMExports();
            try
            {
                assert.throws(() => inspectBlame(root), /identity changed|bytes|index/u);
                assert.equal(indexes, 2);
            }
            finally
            {
                childProcess.execFileSync = original;
                syncBuiltinESMExports();
            }
        });
    }
});

test('canonical blame source success does not replace mandatory later-registration range checks', () =>
{
    blameFixture(({ root, base }) =>
    {
        assert.equal(inspectBlame(root).status, 'success');
        assert.match(validateCommitRange(root, base + '..HEAD').join('\n'), /missing blame-ignore entry/u);
    }, { register: false });
});

for (const context of ['blob', 'commit', 'custom-prefix', 'graft-environment', 'repository-grafts'])
{
    test(`canonical blame source refuses real Git history rewrite context: ${context}`, () =>
    {
        blameFixture(({ root, format, git, env }) =>
        {
            const previous = { GIT_REPLACE_REF_BASE: process.env.GIT_REPLACE_REF_BASE,
                GIT_GRAFT_FILE: process.env.GIT_GRAFT_FILE };
            try
            {
                if (context === 'graft-environment' || context === 'repository-grafts')
                {
                    const graft = context === 'graft-environment' ? path.join(root, 'alternate-grafts')
                        : path.resolve(root, git('rev-parse', '--git-path', 'info/grafts').toString('utf8').trim());
                    fs.writeFileSync(graft, git('rev-parse', 'HEAD').toString('utf8').trim() + ' ' + format + '\n');
                    if (context === 'graft-environment')
                    {
                        process.env.GIT_GRAFT_FILE = graft;
                    }
                }
                else if (context === 'commit')
                {
                    const head = git('rev-parse', 'HEAD').toString('utf8').trim();
                    const tree = git('rev-parse', 'HEAD^{tree}').toString('utf8').trim();
                    const replacement = execFileSync('git', ['-C', root, 'commit-tree', tree, '-p', format],
                        { env, input: 'test(governance): replace actual commit metadata\n\nRefs: #4452\n' }).toString('utf8').trim();
                    git('replace', head, replacement);
                }
                else
                {
                    const original = git('rev-parse', 'HEAD:' + blameFile).toString('utf8').trim();
                    const bytes = fs.readFileSync(path.join(root, blameFile), 'utf8') + '# replacement-only uncommitted comment\n';
                    const replacement = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'],
                        { env, input: bytes }).toString('utf8').trim();
                    const prefix = context === 'custom-prefix' ? 'refs/source-fixture-replacements/' : 'refs/replace/';
                    git('update-ref', prefix + original, replacement);
                    fs.writeFileSync(path.join(root, blameFile), bytes);
                    if (context === 'custom-prefix')
                    {
                        process.env.GIT_REPLACE_REF_BASE = prefix;
                    }
                }
                assert.throws(() => inspectBlame(root), /history.rewrite|replacement|graft/u);
            }
            finally
            {
                for (const [key, value] of Object.entries(previous))
                {
                    if (value === undefined)
                    {
                        delete process.env[key];
                    }
                    else
                    {
                        process.env[key] = value;
                    }
                }
            }
        });
    });
}

for (const context of ['replacement-ref', 'graft-file', 'graft-environment'])
{
    test(`canonical blame source refuses Git history rewrite introduced during validation: ${context}`, () =>
    {
        blameFixture(({ root, format, git, env }) =>
        {
            const original = childProcess.execFileSync;
            const previousGraft = process.env.GIT_GRAFT_FILE;
            const head = git('rev-parse', 'HEAD').toString('utf8').trim();
            const tree = git('rev-parse', 'HEAD^{tree}').toString('utf8').trim();
            const replacement = execFileSync('git', ['-C', root, 'commit-tree', tree, '-p', format],
                { env, input: 'test(governance): create actual controlled replacement\n\nRefs: #4452\n' }).toString('utf8').trim();
            const graft = path.resolve(root, git('rev-parse', '--git-path', 'info/grafts').toString('utf8').trim());
            let indexes = 0;
            childProcess.execFileSync = (executable, args, options) =>
            {
                if (executable === 'git' && args[0] === '-C' && args[1] === root
                    && args.length === 5 && args.slice(2).join(' ') === 'ls-files --stage -z' && ++indexes === 2)
                {
                    if (context === 'replacement-ref')
                    {
                        original('git', ['-C', root, 'replace', head, replacement], { env });
                    }
                    else if (context === 'graft-file')
                    {
                        fs.writeFileSync(graft, head + ' ' + format + '\n');
                    }
                    else
                    {
                        process.env.GIT_GRAFT_FILE = path.join(root, 'new-graft-context');
                    }
                }
                return original(executable, args, options);
            };
            syncBuiltinESMExports();
            try
            {
                assert.throws(() => inspectBlame(root), /history.rewrite|replacement|graft/u);
                assert.equal(indexes, 2);
            }
            finally
            {
                childProcess.execFileSync = original;
                syncBuiltinESMExports();
                if (previousGraft === undefined)
                {
                    delete process.env.GIT_GRAFT_FILE;
                }
                else
                {
                    process.env.GIT_GRAFT_FILE = previousGraft;
                }
            }
        });
    });
}
