import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { csharpFormatFingerprint, validateFormatOnlyDiff } = await import(
    new URL('../../tools/governance/change-contract.mjs', import.meta.url)
);

const imports = 'using Alpha;\nusing Beta;\n';
const reversed = 'using Beta;\nusing Alpha;\n';
const body = 'namespace Example;\nclass Reader { int Read() { return 1; } }\n';
const fingerprint = csharpFormatFingerprint;

function reject(before, after)
{
    assert.notEqual(fingerprint(before), fingerprint(after));
}

function compareDiff(file, before, after)
{
    const repository = mkdtempSync(join(tmpdir(), 'fsusblog-csharp-using-format-'));
    const git = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
    try
    {
        git(['init', '-q']);
        git(['config', 'user.name', 'Fixture']);
        git(['config', 'user.email', 'fixture@example.invalid']);
        writeFileSync(join(repository, file), before);
        git(['add', file]);
        git(['commit', '-qm', 'fixture before']);
        const base = git(['rev-parse', 'HEAD']);
        writeFileSync(join(repository, file), after);
        git(['add', file]);
        git(['commit', '-qm', 'fixture after']);
        return validateFormatOnlyDiff(repository, base, git(['rev-parse', 'HEAD']));
    }
    finally
    {
        rmSync(repository, { recursive: true, force: true });
    }
}

test('CSharp using equivalence accepts ordinary compilation unit import permutations', () =>
{
    const namespaces = ['System.Data', 'FsusBlog.Shared.Contracts', 'Npgsql', 'SqlSugar'];
    const render = (names) => `${names.map((name) => `using ${name};`).join('\n')}\n${body}`;
    const original = fingerprint(render(namespaces));
    for (const permutation of [namespaces.toReversed(), [...namespaces.slice(1), namespaces[0]],
        [namespaces[2], namespaces[0], namespaces[3], namespaces[1]]])
    {
        assert.equal(fingerprint(render(permutation)), original);
    }
});

test('CSharp using equivalence accepts qualified name whitespace and line endings', () =>
{
    assert.equal(fingerprint(`using Alpha.Core;\nusing Beta.Data;\n${body}`),
        fingerprint(`using Beta .\nData ;\r\n\r\nusing Alpha . Core ;\r\n${body}`));
});

test('CSharp using equivalence retains unchanged header and member comments', () =>
{
    const header = '// License and source contract\n/* Header */\n';
    const member = '/// Reader contract\n';
    assert.equal(fingerprint(`${header}${imports}${member}${body}`),
        fingerprint(`${header}${reversed}${member}${body}`));
});

test('CSharp using equivalence preserves duplicate import multiplicity', () =>
{
    assert.equal(fingerprint(`${imports}using Alpha;\n${body}`),
        fingerprint(`using Alpha;\n${reversed}${body}`));
    reject(`${imports}${body}`, `${reversed}using Alpha;\n${body}`);
});

test('CSharp using equivalence rejects changed import membership and spelling', () =>
{
    for (const changed of ['using Alpha;\n', `${reversed}using Gamma;\n`,
        'using Gamma;\nusing Alpha;\n', 'using beta;\nusing Alpha;\n'])
    {
        reject(`${imports}${body}`, `${changed}${body}`);
    }
});

test('CSharp using equivalence rejects alias identity target and order changes', () =>
{
    const aliases = 'using First = Alpha;\nusing Second = Beta;\n';
    for (const changed of [aliases.replace('First', 'Other'), aliases.replace('= Alpha', '= Gamma'),
        'using Second = Beta;\nusing First = Alpha;\n'])
    {
        reject(`${aliases}${body}`, `${changed}${body}`);
    }
});

test('CSharp using equivalence refuses reordering beside unsupported import declarations', () =>
{
    for (const declaration of ['using Name = Alpha;\n', 'using static Alpha.Reader;\n',
        'global using Gamma;\n', 'extern alias External;\n'])
    {
        reject(`${imports}${declaration}${body}`, `${reversed}${declaration}${body}`);
        reject(`${declaration}${imports}${body}`, `${declaration}${reversed}${body}`);
    }
});

test('CSharp using equivalence rejects conditional guards and import relocation', () =>
{
    const source = `#if FEATURE\n${imports}#endif\n${body}`;
    reject(source, source.replace('FEATURE', 'OTHER'));
    reject(source, `using Alpha;\n#if FEATURE\nusing Beta;\n#endif\n${body}`);
    reject(source, `#if FEATURE\n${reversed}#endif\n${body}`);
});

test('CSharp using equivalence rejects changed preprocessor line boundaries', () =>
{
    reject(`#if FEATURE\n${imports}#endif\n${body}`,
        `#if FEATURE using Alpha;\nusing Beta;\n#endif\n${body}`);
    reject(`#nullable enable\n${imports}${body}`, `#nullable\nenable\n${imports}${body}`);
});

test('CSharp using equivalence keeps directive bearing files conservative', () =>
{
    for (const directive of ['#nullable enable\n', '#pragma warning disable CS0168\n', '#define FEATURE\n'])
    {
        reject(`${directive}${imports}${body}`, `${directive}${reversed}${body}`);
    }
    reject(`#nullable enable\n${imports}${body}`,
        `#  nullable   enable\n${imports}${body}`);
});

test('CSharp using equivalence rejects namespace identity and boundary changes', () =>
{
    reject(`${imports}${body}`, `${reversed}${body.replace('Example', 'Other')}`);
    reject(`${imports}${body}`, `${reversed}namespace Example { class Reader { int Read() { return 1; } } }`);
    reject(`${imports}${body}`, `namespace Example;\n${reversed}class Reader { int Read() { return 1; } }`);
});

test('CSharp using equivalence does not reorder namespace scoped imports', () =>
{
    reject(`namespace Example { ${imports}class Reader { } }`,
        `namespace Example { ${reversed}class Reader { } }`);
    reject(`${imports}namespace Example { ${imports}class Reader { } }`,
        `${reversed}namespace Example { ${reversed}class Reader { } }`);
});

test('CSharp using equivalence preserves executable tokens and resource statement order', () =>
{
    reject(`${imports}${body}`, `${reversed}${body.replace('return 1;', 'return 2;')}`);
    const resourceBody = 'class Reader { void Read() { using var first = Open(); using var second = Open(); } }';
    reject(`${imports}${resourceBody}`, `${reversed}${resourceBody.replace(
        'using var first = Open(); using var second = Open();',
        'using var second = Open(); using var first = Open();'
    )}`);
    reject(`${imports}Run();\nusing Gamma;\n`, `${reversed}using Gamma;\nRun();\n`);
});

test('CSharp using equivalence preserves SQL and quoted literal bytes', () =>
{
    for (const literal of ['"SELECT value FROM entries"', '@"SELECT ""value"" FROM entries"',
        '"""SELECT value FROM entries"""', '$"SELECT {field} FROM entries"'])
    {
        const declaration = `class Reader { string Query = ${literal}; }`;
        reject(`${imports}${declaration}`, `${reversed}${declaration.replace('entries', 'other')}`);
    }
    reject(`${imports}class Reader { string Value = "\\u0061"; }`,
        `${reversed}class Reader { string Value = "a"; }`);
});

test('CSharp using equivalence preserves comments as import barriers', () =>
{
    reject(`using Alpha;\n// Beta binding\nusing Beta;\n${body}`,
        `using Beta;\n// Beta binding\nusing Alpha;\n${body}`);
    reject(`${imports}// Gamma binding\nusing Gamma;\n${body}`,
        `${reversed}// Gamma binding\nusing Gamma;\n${body}`);
    reject(`// Header\n${imports}${body}`, `${reversed}// Header\n${body}`);
});

test('CSharp using equivalence refuses malformed and unsupported namespace names', () =>
{
    for (const target of ['42', 'Alpha..Core', 'Alpha.', 'Alpha.@class', 'global::Alpha',
        'class', 'Alpha.class', '__arglist', '__makeref', '__reftype', '__refvalue',
        'Αλφα', 'Alpha /* target */ . Core'])
    {
        reject(`using ${target};\nusing Beta;\n${body}`, `using Beta;\nusing ${target};\n${body}`);
    }
    reject(`using Alpha\nusing Beta;\n${body}`, `using Beta;\nusing Alpha\n${body}`);
});

test('CSharp using equivalence reaches the original format only diff gate', () =>
{
    assert.deepEqual(compareDiff('sample.cs', `${imports}${body}`, `${reversed}${body}`), []);
});

test('CSharp using equivalence retains original semantic and other language diff refusals', () =>
{
    assert.match(compareDiff('sample.cs', `${imports}${body}`,
        `${reversed}${body.replace('return 1;', 'return 2;')}`).join('\n'), /quoted-value tokens/u);
    assert.match(compareDiff('contract.json', '{"alpha":1,"beta":2}\n',
        '{"beta":2,"alpha":1}\n').join('\n'), /quoted-value tokens/u);
    assert.match(compareDiff('native.h', '#define VALUE 1\nint x;\n',
        '#define VALUE\n1 int x;\n').join('\n'), /quoted-value tokens/u);
});

test('CSharp using equivalence rejects raw SQL literal embedded quote whitespace changes', () =>
{
    const declaration = 'class Reader { const string Sql = """SELECT "x  y" FROM t"""; }';
    const before = `${imports}${declaration}`;
    const after = `${reversed}${declaration.replace('x  y', 'x y')}`;
    const observed = {
        fingerprintsEqual: fingerprint(before) === fingerprint(after),
        diffAccepted: compareDiff('sample.cs', before, after).length === 0
    };
    assert.deepEqual(observed, { fingerprintsEqual: false, diffAccepted: false });
});

test('CSharp using equivalence rejects U2028 region label executable relocation', () =>
{
    const separator = '\u2028';
    const before = ['using Alpha;', 'using Beta;', '#region class Added { }',
        '#endregion', 'namespace Example;', 'class Reader { }'].join(separator);
    const after = ['using Beta;', 'using Alpha;', '#region', 'class Added { }',
        '#endregion', 'namespace Example;', 'class Reader { }'].join(separator);
    const observed = {
        fingerprintsEqual: fingerprint(before) === fingerprint(after),
        diffAccepted: compareDiff('sample.cs', before, after).length === 0
    };
    assert.deepEqual(observed, { fingerprintsEqual: false, diffAccepted: false });
});

test('CSharp using equivalence preserves exact body whitespace and line terminators', () =>
{
    reject(`${imports}${body}`, `${reversed}${body.replace('return 1;', 'return   1 ;')}`);
    reject(`${imports}${body}`, `${reversed}${body.replaceAll('\n', '\r\n')}`);
    const declaration = 'class Reader { const string Sql = """\nSELECT "x  y" FROM t\n"""; }';
    for (const separator of ['\r', '\n', '\r\n', '\u0085', '\u2028', '\u2029'])
    {
        const changed = declaration.replaceAll('\n', separator);
        if (changed !== declaration)
        {
            reject(`${imports}${declaration}`, `${reversed}${changed}`);
        }
    }
    reject(`// Header  contract\n${imports}${body}`, `// Header contract\n${reversed}${body}`);
});

test('CSharp using equivalence rejects region relocation with every CSharp line terminator', () =>
{
    for (const separator of ['\r', '\n', '\r\n', '\u0085', '\u2028', '\u2029'])
    {
        const before = ['using Alpha;', 'using Beta;', '#region class Added { }',
            '#endregion', 'namespace Example;', 'class Reader { }'].join(separator);
        const after = ['using Beta;', 'using Alpha;', '#region', 'class Added { }',
            '#endregion', 'namespace Example;', 'class Reader { }'].join(separator);
        assert.notEqual(fingerprint(before), fingerprint(after), JSON.stringify(separator));
        assert.notDeepEqual(compareDiff('sample.cs', before, after), [], JSON.stringify(separator));
    }
});

test('CSharp using equivalence accepts unchanged raw literals behind ordinary imports', () =>
{
    for (const literal of ['"""SELECT "x  y" FROM t"""', '"""\r\nSELECT "x  y" FROM t\r\n"""',
        '$$"""SELECT "x  y" FROM {{table}}"""'])
    {
        const declaration = `class Reader { string Sql = ${literal}; }`;
        assert.equal(fingerprint(`${imports}${declaration}`), fingerprint(`${reversed}${declaration}`));
        assert.deepEqual(compareDiff('sample.cs', `${imports}${declaration}`, `${reversed}${declaration}`), []);
    }
});

test('CSharp using equivalence refuses hashes and unsupported import separators conservatively', () =>
{
    for (const remainder of ['class Reader { string Value = "#"; }', '// # retained comment\n' + body])
    {
        reject(`${imports}${remainder}`, `${reversed}${remainder}`);
    }
    for (const separator of ['\u0085', '\u2028', '\u2029', '\u00a0', '\ufeff'])
    {
        reject(`using Alpha;${separator}using Beta;${separator}${body}`,
            `using Beta;${separator}using Alpha;${separator}${body}`);
    }
});

function rejectUnsupportedImportsAfterLineComment(separator)
{
    const declarations = ['using static System.Math;', 'using Name = Alpha;',
        'global using Gamma;', 'extern alias External;'];
    const cases = declarations.flatMap((declaration) => [separator, `${separator} ${separator}\u00a0`]
        .map((separatorTrivia) => ({ declaration, separatorTrivia })));
    const observed = cases.map(({ declaration, separatorTrivia }) =>
    {
        const remainder = `// barrier${separatorTrivia}${declaration}${separator}${body}`;
        const before = `${imports}${remainder}`;
        const after = `${reversed}${remainder}`;
        return {
            declaration,
            separatorTrivia,
            fingerprintsEqual: fingerprint(before) === fingerprint(after),
            diffAccepted: compareDiff('sample.cs', before, after).length === 0
        };
    });
    assert.deepEqual(observed, cases.map(({ declaration, separatorTrivia }) => ({
        declaration, separatorTrivia, fingerprintsEqual: false, diffAccepted: false
    })));
}

test('CSharp using equivalence refuses unsupported imports after CR line comments', () =>
{
    rejectUnsupportedImportsAfterLineComment('\r');
});

test('CSharp using equivalence refuses unsupported imports after LF line comments', () =>
{
    rejectUnsupportedImportsAfterLineComment('\n');
});

test('CSharp using equivalence refuses unsupported imports after CRLF line comments', () =>
{
    rejectUnsupportedImportsAfterLineComment('\r\n');
});

test('CSharp using equivalence refuses unsupported imports after U0085 line comments', () =>
{
    rejectUnsupportedImportsAfterLineComment('\u0085');
});

test('CSharp using equivalence refuses unsupported imports after U2028 line comments', () =>
{
    rejectUnsupportedImportsAfterLineComment('\u2028');
});

test('CSharp using equivalence refuses unsupported imports after U2029 line comments', () =>
{
    rejectUnsupportedImportsAfterLineComment('\u2029');
});
