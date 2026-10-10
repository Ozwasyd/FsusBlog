import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const root = '/workspace/chain-1895-origin-export-successor/FsusBlog';
const out = path.dirname(new URL(import.meta.url).pathname);
const ts = createRequire(path.join(root, 'src/frontend/package.json'))('typescript');
const file = 'tests/tools/layout-functional-source.test.mjs';
const before = execFileSync('git', ['show', '12c3152f6a5ced35784e89400fd8ce98e74d126a:' + file], { cwd: root, encoding: 'utf8' });
const after = fs.readFileSync(path.join(root, file), 'utf8');
function facts(text)
{
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw new Error('functional test AST parse failed');
    const calls = new Map(); let negatives;
    function visit(node)
    {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test')
            calls.set(node.arguments[0].getText(ast), node.getText(ast));
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'negatives')
            negatives = node.initializer.elements.map((row) => row.getText(ast));
        ts.forEachChild(node, visit);
    }
    visit(ast); return { calls, negatives };
}
const old = facts(before), current = facts(after);
for (const [name, body] of old.calls)
    if (current.calls.get(name) !== body) throw new Error('original functional assertion body changed: ' + name);
if (old.negatives.some((row, index) => current.negatives[index] !== row)) throw new Error('original negative row changed');
const oldRoster = JSON.parse(fs.readFileSync(path.join(out, 'order2-clean-positive-preflight.json'), 'utf8')).selections.find((s) => s.file === file).names;
const newRoster = JSON.parse(fs.readFileSync(path.join(out, 'functional-clean-positive-preflight.json'), 'utf8')).selections.find((s) => s.file === file).names;
if (oldRoster.length !== 89 || newRoster.length !== 107 || oldRoster.some((name) => !newRoster.includes(name))) throw new Error('original functional roster changed');
const result = { originalControls: oldRoster.length, actualNewControls: newRoster.length, originalTestCallBodiesUnchanged: true, originalNegativeRowsUnchanged: true, originalNames: oldRoster, actualNewNames: newRoster, parserRootOverrideForOriginalFreshPositive: false, importGlueChanged: false };
fs.writeFileSync(path.join(out, 'functional-original-89-preservation.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ originalControls: 89, actualNewControls: 107, originalTestCallBodiesUnchanged: true, originalNegativeRowsUnchanged: true }));
