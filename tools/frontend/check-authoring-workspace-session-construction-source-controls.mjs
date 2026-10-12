import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAllowedAuthoringSessionSourceConstruction } from './authoring-workspace-session-construction-policy.mjs';

// Compiler AST controls only: no product import/evaluation, test discovery or runtime qualification.
if (process.argv.length !== 2)
{
    throw new Error('usage: node tools/frontend/check-authoring-workspace-session-construction-source-controls.mjs');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ts = createRequire(path.join(root, 'src/frontend/package.json'))('typescript');
const file = 'src/frontend/src/services/authoring/authoringWorkspaceSessionSource.ts';
const original = readFileSync(path.join(root, file), 'utf8');
const message = "'authoring-workspace-session-source-retirement-incomplete'";
const controls = [
    { id: 'actual-original-standard-aggregation', source: original, allowed: true },
    { id: 'other-host-constructor', source: original.replace('new AggregateError', 'new AuthoringSessionHost'), allowed: false },
    { id: 'other-registry-constructor', source: original.replace('new AggregateError', 'new OpenArticleDocumentRegistry'), allowed: false },
    { id: 'other-authority-constructor', source: original.replace('new AggregateError', 'new AuthoringWorkspaceRatioOwner'), allowed: false },
    { id: 'constructor-alias', source: `const Alias = AggregateError;\n${original.replace('new AggregateError', 'new Alias')}`, allowed: false },
    { id: 'global-member-alias', source: original.replace('new AggregateError', 'new globalThis.AggregateError'), allowed: false },
    { id: 'shadowed-const', source: `const AggregateError = FakeAggregate;\n${original}`, allowed: false },
    { id: 'shadowed-class', source: `class AggregateError {}\n${original}`, allowed: false },
    { id: 'shadowed-function', source: `function AggregateError() {}\n${original}`, allowed: false },
    { id: 'shadowed-import', source: `import { AggregateError } from './fake';\n${original}`, allowed: false },
    { id: 'shadowed-parameter', source: original.replace('groups: AuthoringTabGroupRegistry,', 'AggregateError: unknown, groups: AuthoringTabGroupRegistry,'), allowed: false },
    { id: 'shadowed-destructuring', source: `const { AggregateError } = fake;\n${original}`, allowed: false },
    { id: 'global-constructor-write', source: `globalThis.AggregateError = FakeAggregate;\n${original}`, allowed: false },
    { id: 'bare-constructor-write', source: `AggregateError = FakeAggregate;\n${original}`, allowed: false },
    { id: 'global-constructor-define', source: `Object.defineProperty(globalThis, 'AggregateError', { value: FakeAggregate });\n${original}`, allowed: false },
    { id: 'destructured-global-property-write', source: `({ AggregateError: globalThis.AggregateError } = { AggregateError: FakeAggregate });\n${original}`, allowed: false },
    { id: 'destructured-global-array-write', source: `[globalThis.AggregateError] = [FakeAggregate];\n${original}`, allowed: false },
    { id: 'global-alias-property-write', source: `const globalAlias = globalThis; globalAlias.AggregateError = FakeAggregate;\n${original}`, allowed: false },
    { id: 'global-alias-define-property', source: `const globalAlias = globalThis; Object.defineProperty(globalAlias, 'AggregateError', { value: FakeAggregate });\n${original}`, allowed: false },
    { id: 'global-object-assign', source: `Object.assign(globalThis, { AggregateError: FakeAggregate });\n${original}`, allowed: false },
    { id: 'global-alias-object-assign', source: `const globalAlias = globalThis; Object.assign(globalAlias, { AggregateError: FakeAggregate });\n${original}`, allowed: false },
    { id: 'global-alias-reflect-set', source: `const globalAlias = globalThis; Reflect.set(globalAlias, 'AggregateError', FakeAggregate);\n${original}`, allowed: false },
    { id: 'global-reflect-set', source: `Reflect.set(globalThis, 'AggregateError', FakeAggregate);\n${original}`, allowed: false },
    { id: 'nested-destructuring-default-write', source: `const globalAlias = globalThis; ({ nested: [globalAlias.AggregateError = FakeAggregate] } = value);\n${original}`, allowed: false },
    { id: 'global-alias-chain-write', source: `const first = (globalThis as typeof globalThis); let second; second = first; second.AggregateError = FakeAggregate;\n${original}`, allowed: false },
    { id: 'unknown-global-alias-key', source: `const globalAlias = globalThis; globalAlias[key] = FakeAggregate;\n${original}`, allowed: false },
    { id: 'unknown-assign-key', source: `Object.assign(globalThis, { [key]: FakeAggregate });\n${original}`, allowed: false },
    { id: 'unknown-assign-spread', source: `Object.assign(globalThis, { ...source });\n${original}`, allowed: false },
    { id: 'unknown-assign-source', source: `Object.assign(globalThis, source);\n${original}`, allowed: false },
    { id: 'unknown-reflect-set-key', source: `Reflect.set(globalThis, key, FakeAggregate);\n${original}`, allowed: false },
    { id: 'reflect-receiver-alias-write', source: `const reflector = Reflect; const target = globalThis; reflector.set(target, 'AggregateError', FakeAggregate);\n${original}`, allowed: false },
    { id: 'object-receiver-alias-write', source: `const object = Object; const target = globalThis; object.assign(target, { AggregateError: FakeAggregate });\n${original}`, allowed: false },
    { id: 'global-define-properties-write', source: `Object.defineProperties(globalThis, { AggregateError: { value: FakeAggregate } });\n${original}`, allowed: false },
    { id: 'wrong-error-order', source: original.replace('[error, retirementError]', '[retirementError, error]'), allowed: false },
    { id: 'wrong-message', source: original.replace(message, "'alternate-host'"), allowed: false },
    { id: 'wrong-cause', source: original.replace('{ cause: retirementError }', '{ cause: error }'), allowed: false },
    { id: 'extra-option', source: original.replace('{ cause: retirementError }', '{ cause: retirementError, authority: true }'), allowed: false },
    { id: 'outside-original-callback', source: original.replace('const withCurrentSource', 'const anotherSource'), allowed: false },
    { id: 'outside-original-connector', source: original.replace('function connectAuthoringWorkspaceSessionSource', 'function anotherConnector'), allowed: false },
    { id: 'fake-retirement-call', source: original.replace('                retire();', '                inventAuthority();'), allowed: false },
    { id: 'generic-constructor', source: original.replace('new AggregateError(', 'new AggregateError<object>('), allowed: false }
];
const results = [];
for (const control of controls)
{
    const tree = ts.createSourceFile(file, control.source, ts.ScriptTarget.Latest, true);
    if (tree.parseDiagnostics.length || control.source === original && !control.allowed)
    {
        throw new Error(`invalid-source-control:${control.id}`);
    }
    const denied = [];
    let aggregations = 0;
    const visit = node =>
    {
        if (ts.isNewExpression(node))
        {
            if (node.expression.getText(tree) === 'AggregateError')
            {
                aggregations++;
            }
            if (!isAllowedAuthoringSessionSourceConstruction(ts, tree, node))
            {
                denied.push(node.expression.getText(tree));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    const allowed = denied.length === 0;
    const passed = allowed === control.allowed && (!control.allowed || aggregations === 1);
    results.push({ id: control.id, expectedAllowed: control.allowed, actualAllowed: allowed, passed, denied });
}
const failures = results.filter(result => !result.passed).map(result => result.id);
console.log(JSON.stringify({ scope: 'static AST policy controls only; product/test/runtime UNRUN',
    status: failures.length === 0 ? 'PASS' : 'FAIL', failures, results }, null, 4));
process.exitCode = failures.length === 0 ? 0 : 1;
