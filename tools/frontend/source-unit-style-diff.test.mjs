import assert from 'node:assert/strict';
import test from 'node:test';

import './check-frontend-style-source-base.test.mjs';
import { compareSourceUnitFindings } from './source-unit-style-diff.mjs';

const source = "function original()\n{\n    return /\\[/.test('x');\n}\n";
const finding = { tool: 'eslint', rule: 'no-useless-escape', severity: 2,
    message: 'Unnecessary escape character: \\[.', line: 3, column: 13, endLine: 3, endColumn: 14 };

function compare(candidateSource = source, candidateFindings = [finding], baseSource = source, baseFindings = [finding])
{
    return compareSourceUnitFindings({ baseSource, candidateSource, baseFindings, candidateFindings });
}

test('inherits an exact unique complete function after an unrelated line shift', () =>
{
    const result = compare(`const added = 1;\n${source}`, [{ ...finding, line: 4, endLine: 4 }]);
    assert.equal(result.existing.length, 1);
    assert.equal(result.unexpected.length, 0);
    assert.equal(result.failure, null);
});

test('rejects an unchanged diagnostic inside a changed complete function', () =>
{
    const result = compare(source.replace("test('x')", "test('y')"));
    assert.equal(result.existing.length, 0);
    assert.equal(result.unexpected.length, 1);
});

test('rejects copied or ambiguous complete functions in either source', () =>
{
    const expression = "const a = () => /\\[/;\n";
    const local = { ...finding, line: 1, column: 18, endLine: 1, endColumn: 19 };
    const duplicate = expression + expression.replace('const a', 'const b');
    assert.equal(compare(duplicate, [local], expression, [local]).existing.length, 0);
    assert.equal(compare(expression, [local], duplicate, [local]).existing.length, 0);
});

test('requires identical rule message severity and relative start and end', () =>
{
    for (const mutation of [{ rule: 'unknown-rule' }, { message: 'changed message' },
        { severity: 1 }, { column: 12 }, { endColumn: 15 }])
    {
        assert.equal(compare(source, [{ ...finding, ...mutation }]).existing.length, 0);
    }
});

test('consumes each base diagnostic at most once and refuses ambiguous base findings', () =>
{
    assert.equal(compare(source, [finding, finding]).unexpected.length, 1);
    assert.equal(compare(source, [finding], source, [finding, finding]).unexpected.length, 1);
});

test('rejects parser fatal global and unsupported findings even in an exact file', () =>
{
    for (const mutation of [{ fatal: true }, { rule: 'parse-error' }, { rule: 'import-x/order' },
        { rule: '@stylistic/eol-last' }, { line: 0 }, { tool: 'stylelint' }])
    {
        assert.equal(compare(source, [{ ...finding, ...mutation }]).unexpected.length, 1);
    }
    assert.match(compare('function {').failure, /parse failed/u);
});

test('a new file strictly retains all 122 findings as unexpected', () =>
{
    const findings = Array.from({ length: 122 }, () => ({ ...finding }));
    const result = compare(source, findings, null, []);
    assert.equal(result.existing.length, 0);
    assert.equal(result.unexpected.length, 122);
});

function diagnostic(text, needle, rule)
{
    const start = text.indexOf(needle);
    assert.notEqual(start, -1);
    const before = text.slice(0, start).split('\n');
    const through = text.slice(0, start + needle.length).split('\n');
    return { tool: 'eslint', rule, severity: 2, message: 'original local diagnostic',
        line: before.length, column: before.at(-1).length + 1,
        endLine: through.length, endColumn: through.at(-1).length + 1 };
}

test('never inherits a real top-level const regex finding from a supported rule', () =>
{
    const text = "const expression = /\\[/;\n";
    const local = diagnostic(text, '\\[', 'no-useless-escape');
    const result = compare(text, [local], text, [local]);
    assert.equal(result.existing.length, 0);
    assert.equal(result.unexpected.length, 1);
});

test('local layout requires complete diagnostic lines and the enclosing statement', () =>
{
    const text = 'const a = () => { return 1; };\n';
    for (const rule of ['@stylistic/brace-style', '@stylistic/max-statements-per-line'])
    {
        const local = diagnostic(text, 'return', rule);
        assert.equal(compare(text, [local], text, [local]).existing.length, 1);
        assert.equal(compare(text.replace('const a', 'const b'), [local], text, [local]).unexpected.length, 1);
        const multiline = 'const a =\n    () => { return 1; };\n';
        const shifted = diagnostic(multiline, 'return', rule);
        assert.equal(compare(multiline.replace('const a', 'const b'), [shifted], multiline, [shifted]).unexpected.length, 1);
    }
});

test('control regex inheritance requires a static literal and unchanged module bindings', () =>
{
    const text = String.raw`const suffix = 'a';
function original()
{
    return suffix.replace(/\x01/, '');
}
`;
    const local = diagnostic(text, String.raw`/\x01/`, 'no-control-regex');
    assert.equal(compare(text, [local], text, [local]).existing.length, 1);
    assert.equal(compare(text.replace("suffix = 'a'", "suffix = 'b'"), [local], text, [local]).unexpected.length, 1);
    const imported = text.replace("const suffix = 'a';", "import { suffix } from './one.mjs';");
    const fromImport = diagnostic(imported, String.raw`/\x01/`, 'no-control-regex');
    assert.equal(compare(imported.replace('./one.mjs', './two.mjs'), [fromImport], imported, [fromImport]).unexpected.length, 1);
    const constructor = String.raw`function original()
{
    return RegExp('\x01');
}
`;
    const unproved = diagnostic(constructor, String.raw`'\x01'`, 'no-control-regex');
    assert.equal(compare(constructor, [unproved], constructor, [unproved]).unexpected.length, 1);
});

test('finite layout proofs inherit local original statements across an unrelated allocation change', () =>
{
    const before = 'function owner()\n{\n    if (ready) return false\n    const allocation = make(oldRoot)\n}\n';
    const after = before.replace('make(oldRoot)', 'make(newRoot)');
    for (const rule of ['@stylistic/indent', '@stylistic/semi', 'curly'])
    {
        const local = diagnostic(before, 'return false', rule);
        assert.equal(compare(after, [local], before, [local]).existing.length, 1, rule);
        assert.equal(compare(after.replace('if (ready)', 'if (changed)'), [local], before, [local]).unexpected.length, 1, rule);
        assert.equal(compare(after.replace('return false', 'return true'), [local], before, [local]).unexpected.length, 1, rule);
    }
});

test('layout rejects changed lexical owners bindings lines and duplicate statement identities', () =>
{
    const before = 'function owner()\n{\n    if (ready) return false\n    const allocation = make(oldRoot)\n}\n';
    const local = diagnostic(before, 'return false', 'curly');
    for (const after of [before.replace('function owner()', 'function renamed()'),
        before.replace('const allocation', 'let allocation'),
        before.replace('return false', 'return false /* changed */'),
        before.replace('    if (ready) return false', '    if (ready) return false\n    if (ready) return false')])
    {
        assert.equal(compare(after, [local], before, [local]).unexpected.length, 1);
    }
    assert.equal(compare(before, [local, local], before, [local]).unexpected.length, 1);
    assert.equal(compare(before, [local], before, [local, local]).unexpected.length, 1);
});

test('missing semicolons bind line terminators and preserve ASI neighbours', () =>
{
    const before = 'function owner()\n{\n    const value = 1\n    return value\n}\n';
    const local = { ...diagnostic(before, 'return value', '@stylistic/semi'), column: 17, endLine: 5, endColumn: 1 };
    assert.equal(compare(before, [local], before, [local]).existing.length, 1);
    const after = before.replace('    return value', '    return value\n    (run)()');
    assert.equal(compare(after, [local], before, [local]).unexpected.length, 1);
});

test('unused bindings require original definition zero reads and unchanged lexical scope', () =>
{
    const before = 'function owner()\n{\n    const unused = getValue()\n    const allocation = make(oldRoot)\n}\n';
    const local = diagnostic(before, 'unused', 'no-unused-vars');
    const after = before.replace('make(oldRoot)', 'make(newRoot)');
    assert.equal(compare(after, [local], before, [local]).existing.length, 1);
    for (const changed of [after.replace('getValue()', 'otherValue()'),
        after.replace('const allocation', 'let allocation'),
        after.replace('make(newRoot)', 'make(unused)'),
        after.replace('make(newRoot)', "eval('unused')")])
    {
        assert.equal(compare(changed, [local], before, [local]).unexpected.length, 1);
    }
});

test('import ordering requires the exact full roster and actual dependency context', () =>
{
    const before = "import { value } from './value.mjs';\nimport fs from 'node:fs';\nfunction owner() { return 1; }\n";
    const local = diagnostic(before, "import fs from 'node:fs';", 'import-x/order');
    const witness = { sourcePath: 'tools/owner.mjs', configurationIdentities: [{ file: 'eslint.config.mjs', sha256: 'a'.repeat(64) }],
        dependencies: [{ owner: 'tools/owner.mjs', specifier: './value.mjs', kind: 'repository', path: 'tools/value.mjs', blob: 'b'.repeat(40), sha256: 'c'.repeat(64) },
            { owner: 'tools/owner.mjs', specifier: 'node:fs', kind: 'builtin', nodeVersion: process.version }] };
    const run = (candidateSource, candidateWitness = witness) => compareSourceUnitFindings({ baseSource: before, candidateSource,
        baseFindings: [local], candidateFindings: [local], importContext: { base: witness, candidate: candidateWitness } });
    assert.equal(run(before.replace('return 1', 'return 2')).existing.length, 1);
    assert.equal(compare(before, [local], before, [local]).unexpected.length, 1);
    assert.equal(run(before.replace("'./value.mjs'", "'./other.mjs'")).unexpected.length, 1);
    assert.equal(run(before.replace(';\nimport fs', ';\n\nimport fs')).unexpected.length, 1);
    const changed = structuredClone(witness);
    changed.dependencies[0].sha256 = 'd'.repeat(64);
    assert.equal(run(before, changed).unexpected.length, 1);
    const omitted = structuredClone(witness);
    omitted.dependencies.shift();
    assert.equal(run(before, omitted).unexpected.length, 1);
    const fabricated = diagnostic(source, 'return', 'import-x/order');
    assert.equal(run(source).existing.length, 0);
    assert.equal(compare(source, [fabricated], source, [fabricated]).unexpected.length, 1);
});

test('base diagnostics are located once per invocation and no candidate cache is reused', () =>
{
    let reads = 0;
    const original = { ...finding, get line()
    {
        reads += 1;
        return finding.line;
    } };
    const repeated = Array.from({ length: 100 }, () => ({ ...finding }));
    const first = compare(source, repeated, source, [original]);
    assert.equal(first.existing.length, 1);
    assert.ok(reads < 10, `base location was repeated ${reads} times`);
    repeated[0].message = 'changed';
    assert.equal(compare(source, repeated, source, [original]).existing.length, 1);
    assert.equal(compare(source.replace("test('x')", "test('y')"), repeated, source, [original]).existing.length, 0);
});

test('module layout proves only unique complete declarations and unchanged physical neighbours', () =>
{
    const before = "import fs from 'node:fs'\n  const value = 1\nconst next = 2;\nfunction unrelated() { return 3; }\n";
    const after = before.replace('return 3', 'return 4');
    const indent = { ...diagnostic(before, 'const value', '@stylistic/indent'), column: 1, endColumn: 3 };
    const semi = { ...diagnostic(before, 'const value', '@stylistic/semi'), column: 18, endLine: 3, endColumn: 1 };
    for (const local of [indent, semi])
    {
        assert.equal(compare(after, [local], before, [local]).existing.length, 1);
        for (const changed of [after.replace('const next = 2', 'const next = 5'),
            after.replace("from 'node:fs'", "from 'node:path'"),
            after.replace('\nconst next', '\n/* new boundary */\nconst next'),
            after.replace('  const value = 1', 'function moved() {\n  const value = 1\n}')])
        {
            assert.equal(compare(changed, [local], before, [local]).unexpected.length, 1);
        }
        assert.equal(compare(after, [local], before, []).unexpected.length, 1);
        assert.equal(compare(after, [local, local], before, [local]).unexpected.length, 1);
        assert.equal(compare(after, [local], null, []).unexpected.length, 1);
        const moved = after.replace('  const value = 1', 'function moved() {\n  const value = 1\n}');
        assert.equal(compare(moved, [{ ...local, line: local.line + 1, endLine: local.endLine + 1 }],
            before, [local]).unexpected.length, 1);
    }
    const importSemi = { ...diagnostic(before, "import fs from 'node:fs'", '@stylistic/semi'),
        column: 25, endLine: 2, endColumn: 1 };
    assert.equal(compare(after, [importSemi], before, [importSemi]).existing.length, 1);
    const duplicate = "import 'node:fs'\nimport 'node:fs'\nconst next = 2;\n";
    const duplicated = { ...diagnostic(duplicate, "import 'node:fs'", '@stylistic/indent'), column: 1, endColumn: 2 };
    assert.equal(compare(duplicate, [duplicated], duplicate, [duplicated]).unexpected.length, 1);
});

test('module declarations preserve ASI syntax and reject unsupported global owners and rules', () =>
{
    const before = 'const value = getValue()\nconst next = 2;\n';
    const local = { ...diagnostic(before, 'const value', '@stylistic/semi'), column: 25, endLine: 2, endColumn: 1 };
    assert.equal(compare(before, [local], before, [local]).existing.length, 1);
    const asi = before.replace('\nconst next', '\n(run)()\nconst next');
    assert.equal(compare(asi, [local], before, [local]).unexpected.length, 1);
    for (const rule of ['curly', 'unknown-rule', 'no-useless-escape', 'no-control-regex'])
    {
        const unsupported = { ...local, rule };
        assert.equal(compare(before, [unsupported], before, [unsupported]).unexpected.length, 1);
    }
    const expression = '  execute()\nconst next = 2;\n';
    const expressionIndent = { ...diagnostic(expression, 'execute()', '@stylistic/indent'), column: 1, endColumn: 3 };
    assert.equal(compare(expression, [expressionIndent], expression, [expressionIndent]).unexpected.length, 1);
    const exported = 'export const value = 1\nconst next = 2;\n';
    const exportSemi = { ...diagnostic(exported, 'export const value', '@stylistic/semi'), column: 23, endLine: 2, endColumn: 1 };
    assert.equal(compare(exported, [exportSemi], exported, [exportSemi]).existing.length, 1);
    assert.equal(compare(exported.replace('export ', ''), [exportSemi], exported, [exportSemi]).unexpected.length, 1);
});

test('parent import findings require the original full roster and actual resolver identities', () =>
{
    const before = "import { value } from '../value.mjs';\nfunction owner() { return 1; }\n";
    const local = diagnostic(before, "'../value.mjs'", 'import-x/no-relative-parent-imports');
    const witness = { sourcePath: 'tools/nested/owner.mjs',
        configurationIdentities: [{ file: 'tools/package.json', sha256: 'a'.repeat(64) }],
        dependencies: [{ owner: 'tools/nested/owner.mjs', specifier: '../value.mjs', kind: 'repository',
            path: 'tools/value.mjs', blob: 'b'.repeat(40), sha256: 'c'.repeat(64) }] };
    function run(candidateSource, candidateWitness = witness, baseFindings = [local])
    {
        return compareSourceUnitFindings({ baseSource: before, candidateSource, baseFindings, candidateFindings: [local],
            importContext: { base: witness, candidate: candidateWitness } });
    }
    assert.equal(run(before.replace('return 1', 'return 2')).existing.length, 1);
    assert.equal(compare(before, [local], before, [local]).unexpected.length, 1);
    assert.equal(run(before.replace('../value.mjs', '../other.mjs')).unexpected.length, 1);
    assert.equal(run(before, witness, []).unexpected.length, 1);
    for (const change of [value =>
    {
        value.sourcePath = 'other/owner.mjs';
    }, value =>
    {
        value.configurationIdentities[0].sha256 = 'd'.repeat(64);
    }, value =>
    {
        value.dependencies[0].blob = 'e'.repeat(40);
    }, value =>
    {
        value.dependencies[0].sha256 = 'f'.repeat(64);
    }, value =>
    {
        value.dependencies = [];
    }])
    {
        const changed = structuredClone(witness);
        change(changed);
        assert.equal(run(before, changed).unexpected.length, 1);
    }
});

test('mechanical try boundaries retain layout while binding headers lexical owners and ASI syntax', () =>
{
    const before = 'function owner()\n{\n    const allocation = make(oldRoot)\n    try\n    {\n        execute()\n    }\n    catch (error)\n    {\n        recover(error)\n    }\n}\n';
    const after = before.replace('make(oldRoot)', 'make(newRoot);').replace('    {\n        execute()', '      {\n        execute()')
        .replace('        execute()\n    }', '        execute()\n      }');
    const local = { ...diagnostic(before, 'execute()', '@stylistic/semi'), column: 18, endLine: 7, endColumn: 1 };
    assert.equal(compare(after, [local], before, [local]).existing.length, 1);
    for (const changed of [after.replace('catch (error)', 'catch (other)'),
        after.replace('recover(error)', 'recover(other)'),
        after.replace('execute()', 'execute()\n        (run)()'),
        after.replace('const allocation', 'let allocation'),
        after.replace('        execute()', '        execute() /* changed line */')])
    {
        assert.equal(compare(changed, [local], before, [local]).unexpected.length, 1);
    }
    const tryIndent = { ...diagnostic(before, 'try', '@stylistic/indent'), column: 1, endColumn: 5 };
    assert.equal(compare(after, [tryIndent], before, [tryIndent]).existing.length, 1);
    assert.equal(compare(after.replace('execute()', 'other()'), [tryIndent], before, [tryIndent]).unexpected.length, 1);
    const extraToken = after.replace('make(newRoot);\n', 'make(newRoot);;\n');
    assert.equal(compare(extraToken, [tryIndent], before, [tryIndent]).unexpected.length, 1);
    const catchIndent = { ...diagnostic(before, 'catch', '@stylistic/indent'), column: 1, endColumn: 5 };
    assert.equal(compare(after, [catchIndent], before, [catchIndent]).existing.length, 1);
    assert.equal(compare(after.replace('catch (error)', 'catch (other)'), [catchIndent],
        before, [catchIndent]).unexpected.length, 1);
    const migrated = `function wrapper()\n{\n${after}\n}\n`;
    assert.equal(compare(migrated, [{ ...catchIndent, line: catchIndent.line + 2, endLine: catchIndent.endLine + 2 }],
        before, [catchIndent]).unexpected.length, 1);
    assert.equal(compare(after.replace('    catch (error)', '    finally'), [catchIndent],
        before, [catchIndent]).unexpected.length, 1);
});

test('adjacent function layout context keeps its complete header and lexical boundary', () =>
{
    const before = 'function neighbour(input)\n{\n    const allocation = make(oldRoot)\n}\n  const value = 1\nconst next = 2\n';
    const local = { ...diagnostic(before, 'const value', '@stylistic/indent'), column: 1, endColumn: 3 };
    const after = before.replace('make(oldRoot)', 'make(newRoot);').replace('const next = 2', 'const next = 2;');
    assert.equal(compare(after, [local], before, [local]).existing.length, 1);
    const exportedBefore = before.replace('function neighbour', 'export function neighbour');
    const exportedAfter = after.replace('function neighbour', 'export function neighbour');
    assert.equal(compare(exportedAfter, [local], exportedBefore, [local]).existing.length, 1);
    assert.equal(compare(exportedAfter.replace('export function', 'function'), [local],
        exportedBefore, [local]).unexpected.length, 1);
    for (const changed of [after.replace('neighbour(input)', 'neighbour(other)'),
        after.replace('const allocation', 'let allocation'),
        after.replace('}\n  const', '}\n/* new boundary */\n  const'),
        after.replace('const next = 2;', 'const next = 3;')])
    {
        assert.equal(compare(changed, [local], before, [local]).unexpected.length, 1);
    }
});

test('empty loop body tokens cannot become optional ancestor statement terminators', () =>
{
    const before = 'function owner()\n{\n    make()\n    return value\n}\n';
    const local = { ...diagnostic(before, 'return value', '@stylistic/indent'), column: 1, endColumn: 5 };
    assert.equal(compare(before, [local], before, [local]).existing.length, 1);
    for (const emptyBody of ['while (condition);', 'for (; condition;);', 'label: while (condition);'])
    {
        const after = before.replace('make()', emptyBody);
        assert.equal(compare(after, [local], before, [local]).unexpected.length, 1, emptyBody);
    }
});
