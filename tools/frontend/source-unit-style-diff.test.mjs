import assert from 'node:assert/strict';
import test from 'node:test';

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
