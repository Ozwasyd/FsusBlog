import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectPythonSource, inspectSolutionSource, validatePythonSourceReceipt, validateSolutionSourceReceipt } from './check-solution-source.mjs';

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
