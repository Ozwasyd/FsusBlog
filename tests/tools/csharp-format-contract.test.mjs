import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { csharpFormatFingerprint as fingerprint, validateFormatOnlyDiff, validateRepositoryBlameIgnore } from '../../tools/governance/change-contract.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const before = 'using System;\n\nusing FsusBlog.Contracts;\n\nusing Vendor;\n\n';
const after = 'using System;\n\nusing Vendor;\n\nusing FsusBlog.Contracts;\n\n';
const body = 'namespace Fixture;\n\npublic sealed class Reader\n{\n    public int Read() => 1;\n}\n';

test('C# format contract preserves ordinary whitespace and complete import multiset', () =>
{
    assert.equal(fingerprint('int x = 1;\n'), fingerprint('int    x    =    1;\n'));
    assert.equal(fingerprint(before + body), fingerprint(after + body));
    assert.equal(fingerprint(before + 'using Vendor;\n' + body),
        fingerprint('using Vendor;\n' + after + body));
    for (const changed of [after.replace('using Vendor;\n', ''), after + 'using Vendor;\n',
        after.replace('Vendor;', 'Other;'), after.replace('Vendor;', 'vendor;')])
    {
        assert.notEqual(fingerprint(before + body), fingerprint(changed + body));
    }
    assert.notEqual(fingerprint(before + body), fingerprint(after + body.replace('=> 1', '=> 2')));
});

for (const declaration of ['using A = Vendor;\n', 'using static System.Math;\n', 'global using Vendor;\n', 'extern alias External;\n'])
{
    test(`C# format contract preserves ordered special imports: ${declaration.trim()}`, () =>
    {
        const prefix = declaration.startsWith('global') || declaration.startsWith('extern');
        const left = prefix ? declaration + before + body : before + declaration + body;
        const right = prefix ? declaration + after + body : after + declaration + body;
        assert.notEqual(fingerprint(left), fingerprint(right));
        assert.equal(fingerprint(left), fingerprint(left.replace('=> 1', '=>    1')));
    });
}

test('C# format contract preserves alias names, targets, static and global scope', () =>
{
    for (const [left, right] of [
        ['using A = Vendor;', 'using B = Vendor;'],
        ['using A = Vendor;', 'using A = Other;'],
        ['using static System.Math;', 'using System.Math;'],
        ['global using Vendor;', 'using Vendor;'],
        ['using A = Vendor;\nusing B = Other;', 'using B = Other;\nusing A = Vendor;']
    ])
    {
        assert.notEqual(fingerprint(left + '\n' + body), fingerprint(right + '\n' + body));
    }
    assert.notEqual(fingerprint(before + body), fingerprint(body.replace('namespace Fixture;',
        'namespace Fixture\n{\n' + before) + '}\n'));
});

for (const literal of ['"hello world"', '@"hello ""world"""', '$"hello {1 + 2} world"',
    '$"{string.Join(\" \", new[] { \"a\", \"b\" })}"',
    '"""\n        hello world\n        """', '$$"""\n        hello {{1 + 2}} world\n        """'])
{
    test(`C# format contract protects literal text: ${JSON.stringify(literal)}`, () =>
    {
        const source = `class Reader { string Read() => ${literal}; }\n`;
        assert.equal(fingerprint(source), fingerprint(source.replace('string Read()', 'string    Read()')));
        const changed = literal.includes('hello') ? source.replace('hello', 'hel lo')
            : source.replace('Join(" "', 'Join("  "');
        assert.notEqual(fingerprint(source), fingerprint(changed));
    });
}

test('C# format contract protects raw-string closing indentation and preprocessor boundaries', () =>
{
    const raw = 'class Reader { string Read() => """\n        content\n        """; }\n';
    assert.notEqual(fingerprint(raw), fingerprint(raw.replace('        """', '    """')));
    const guarded = '#if FEATURE\n' + before + '#endif\n' + body;
    assert.notEqual(fingerprint(guarded), fingerprint(guarded.replace(before, after)));
    assert.notEqual(fingerprint(guarded), fingerprint(guarded.replace('FEATURE', 'OTHER')));
    const comments = '// license\n' + before + body;
    assert.equal(fingerprint(comments), fingerprint('// license\n' + after + body));
    assert.notEqual(fingerprint(before + body), fingerprint(after + '// new intent\n' + body));
    assert.throws(() => fingerprint('class {'), /C# format classification/u);
});

function withFixture(callback)
{
    const directory = mkdtempSync(join(tmpdir(), 'fsusblog-csharp-format-contract-'));
    const write = (file, text) =>
    {
        mkdirSync(join(directory, file, '..'), { recursive: true });
        writeFileSync(join(directory, file), text);
    };
    const policy = JSON.parse(readFileSync(join(root, 'config/development/csharp-style-policy.json'), 'utf8'));
    write('.editorconfig', readFileSync(join(root, '.editorconfig')));
    write('config/policy.json', JSON.stringify({ ...policy, workspace: 'missing.slnx', baseline: 'missing.json' }));
    write('config/development/csharp-import-compatibility.json',
        readFileSync(join(root, 'config/development/csharp-import-compatibility.json')));
    const run = (...args) => spawnSync(process.execPath, [join(root, 'tools/dotnet/check-csharp-style.mjs'),
        '--root', directory, '--policy', join(directory, 'config/policy.json'), '--mode', 'full',
        '--import-order', 'mother-standard', '--file', 'src/Reader.cs', ...args], { encoding: 'utf8' });
    try
    {
        callback({ directory, write, run });
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('explicit mother-standard checker and formatter share the comparator and run idempotently', () =>
{
    withFixture(({ directory, write, run }) =>
    {
        write('src/Reader.cs', before + body);
        assert.notEqual(run().status, 0);
        const fixed = run('--fix');
        assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
        assert.equal(readFileSync(join(directory, 'src/Reader.cs'), 'utf8'), after + body);
        assert.equal(run('--fix').status, 0);
        assert.equal(readFileSync(join(directory, 'src/Reader.cs'), 'utf8'), after + body);
        assert.equal(run().status, 0);
        assert.notEqual(run('--update-baseline').status, 0);
    });
});

test('explicit formatter refuses unsupported scope and symlinks without modifying source', () =>
{
    withFixture(({ directory, write, run }) =>
    {
        const source = 'global using Vendor;\n' + before + body;
        write('src/Reader.cs', source);
        assert.notEqual(run('--fix').status, 0);
        assert.equal(readFileSync(join(directory, 'src/Reader.cs'), 'utf8'), source);
        write('src/Target.cs', before + body);
        rmSync(join(directory, 'src/Reader.cs'));
        symlinkSync('Target.cs', join(directory, 'src/Reader.cs'));
        assert.notEqual(run('--fix').status, 0);
        assert.equal(readFileSync(join(directory, 'src/Target.cs'), 'utf8'), before + body);
    });
});

test('explicit formatter retains the existing shared-third-party owner grouping', () =>
{
    withFixture(({ directory, write, run }) =>
    {
        const owner = 'tests/migration/PgLegacyNonArticlePreparationTests.cs';
        write('src/Reader.cs', after + body);
        write(owner, before.replace('using Vendor;', 'using Vendor;\n\nusing Npgsql;') + body);
        const fixed = run('--file', owner, '--fix');
        assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
        assert.equal(readFileSync(join(directory, owner), 'utf8'),
            after.replace('using Vendor;', 'using Npgsql;\nusing Vendor;') + body);
    });
});

test('explicit formatter refuses invalid UTF-8 without changing bytes outside imports', () =>
{
    withFixture(({ directory, write, run }) =>
    {
        const source = Buffer.concat([Buffer.from('// license '), Buffer.from([0xff]),
            Buffer.from('\n' + before + body)]);
        write('src/Reader.cs', source);
        const result = run('--fix');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /requires valid UTF-8/u);
        assert.deepEqual(readFileSync(join(directory, 'src/Reader.cs')), source);
    });
});

test('cached C# parser rejects changed executable bytes on the next classification', () =>
{
    const directory = mkdtempSync(join(tmpdir(), 'fsusblog-csharp-parser-tamper-'));
    try
    {
        const script = `
            import assert from 'node:assert/strict';
            import { appendFileSync, readdirSync } from 'node:fs';
            import { join } from 'node:path';
            import { inspectCsharpFormat } from ${JSON.stringify(new URL('../../tools/governance/csharp-format-equivalence.mjs', import.meta.url).href)};
            inspectCsharpFormat('int x = 1;');
            const built = readdirSync(process.env.TMPDIR).find(name => name.startsWith('fsusblog-csharp-format-parser-'));
            appendFileSync(join(process.env.TMPDIR, built, 'out/Parser.dll'), 'changed');
            assert.throws(() => inspectCsharpFormat('int x = 1;'), /output changed after build/);
        `;
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            env: { ...process.env, TMPDIR: directory }, stdio: 'pipe'
        });
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('C# historical whitespace migrations and actual complete repository blame audit remain accepted', () =>
{
    for (const revision of ['655d65dd8d00f55ec6bcf2cedf9cbc740045173d', 'bf5028585074ead295baf02d36f7ce9ccf0525eb'])
    {
        assert.deepEqual(validateFormatOnlyDiff(root, `${revision}^`, revision), [], revision);
    }
    assert.deepEqual(validateRepositoryBlameIgnore(root), []);
});
