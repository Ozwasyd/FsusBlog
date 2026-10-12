import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertLocaleSchemaAlgorithm, literalLocaleSchema } from './sync-locale-domain-schema.mjs';

// Inert source AST controls, not product-module execution or test/list discovery.
if (process.argv.length !== 2)
{
    throw new Error('usage: node tools/frontend/check-locale-domain-schema-source-controls.mjs');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(root, 'src/frontend/src/locales/zh-CN/admin.ts'), 'utf8');
const store = readFileSync(path.join(root, 'src/frontend/src/locales/localeDomainBundleStore.ts'), 'utf8');
const identity = { locale: 'zh-CN', domain: 'admin' };
const canonical = literalLocaleSchema(source, 'admin', identity);
const controls = [
    { id: 'actual-original-admin', source, accepted: true },
    { id: 'translated-values-do-not-change-schema', source: source.replace("'第一编辑区'", "'Changed translation'"), accepted: true },
    { id: 'spread-refused', source: source.replace('workspaceLayout: {', '...other, workspaceLayout: {'), accepted: false },
    { id: 'computed-key-refused', source: source.replace('workspaceLayout: {', '[dynamic]: {'), accepted: false },
    { id: 'duplicate-key-refused', source: source.replace('workspaceLayout: {', 'workspaceLayout: {}, workspaceLayout: {'), accepted: false },
    { id: 'identifier-value-refused', source: source.replace("'第一编辑区'", 'dynamic'), accepted: false },
    { id: 'getter-refused', source: source.replace('workspaceLayout: {', 'get other() { return {}; }, workspaceLayout: {'), accepted: false },
    { id: 'method-refused', source: source.replace('workspaceLayout: {', 'other() { return {}; }, workspaceLayout: {'), accepted: false },
    { id: 'runtime-import-refused', source: `import { other } from './other';\n${source}`, accepted: false },
    { id: 'export-mutation-refused', source: `${source}\nadmin.extra = 'new leaf';`, accepted: false },
    { id: 'wrong-module-identity-refused', source: source.replace("locale: 'zh-CN'", "locale: 'en-US'"), accepted: false },
    { id: 'algorithm-seed-drift-refused', source: store.replace('0xcbf29ce484222325n', '0xcbf29ce484222324n'), accepted: false, algorithm: true },
    { id: 'algorithm-kind-drift-refused', source: store.replace("return 'string';", "return 'other';"), accepted: false, algorithm: true },
    { id: 'algorithm-function-missing-refused', source: store.replace('function leafKind(', 'function renamedLeafKind('), accepted: false, algorithm: true }
];
const results = controls.map(control =>
{
    let accepted = false;
    let error = null;
    try
    {
        const result = control.algorithm ? assertLocaleSchemaAlgorithm(control.source)
            : literalLocaleSchema(control.source, 'admin', identity);
        accepted = control.algorithm || result === canonical;
    }
    catch (failure)
    {
        error = failure.message;
    }
    return { id: control.id, expectedAccepted: control.accepted, actualAccepted: accepted,
        passed: accepted === control.accepted, error };
});
const failures = results.filter(result => !result.passed).map(result => result.id);
console.log(JSON.stringify({ scope: 'literal source AST controls only; all runtime/tests/list UNRUN',
    status: failures.length ? 'FAIL' : 'PASS', failures, results }, null, 4));
process.exitCode = failures.length ? 1 : 0;
