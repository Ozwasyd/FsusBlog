import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-only guard for the delivered modules. It never imports candidate product code.
// Full SFC/DOM/receipt/session governance remains blocked on the original integrations.
if (process.argv.length !== 2)
{
    throw new Error('usage: node tools/frontend/check-authoring-workspace-layout-source.mjs');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireFrontend = createRequire(path.join(root, 'src/frontend/package.json'));
const ts = requireFrontend('typescript');
const ownerPath = 'src/frontend/src/services/authoring/authoringWorkspaceRatioOwner.ts';
const geometryPath = 'src/frontend/src/services/authoring/authoringWorkspaceGeometryPolicy.ts';
const sources = new Map([ownerPath, geometryPath].map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
const trees = new Map([...sources].map(([file, source]) => [file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)]));
const failures = [];
const forbiddenIdentifiers = new Set([
    'document', 'window', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator',
    'fetch', 'XMLHttpRequest', 'HTMLElement', 'ResizeObserver', 'MarkdownEditor',
    'groupId', 'tabIds', 'articleToGroup', 'editorState', 'sessionState', 'paneTree'
]);

function visit(tree, callback)
{
    const walk = node =>
    {
        callback(node);
        ts.forEachChild(node, walk);
    };
    walk(tree);
}

for (const [file, tree] of trees)
{
    if (tree.parseDiagnostics.length > 0)
    {
        failures.push(`${file}: parse-error`);
    }
    visit(tree, node =>
    {
        if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text))
        {
            failures.push(`${file}: forbidden-state-or-runtime-dependency:${node.text}`);
        }
        if (ts.isImportDeclaration(node)
            && (file !== geometryPath || node.moduleSpecifier.text !== './authoringWorkspaceRatioOwner'))
        {
            failures.push(`${file}: unowned-import`);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        {
            failures.push(`${file}: dynamic-product-import`);
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        {
            failures.push(`${file}: unowned-re-export`);
        }
        if (ts.isPropertySignature(node) && node.name.getText(tree) === 'requestedLayout')
        {
            const members = node.type && ts.isUnionTypeNode(node.type) ? node.type.types : [];
            const values = members.map(member => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : null);
            if (values.length !== 2 || !values.includes('single-group') || !values.includes('horizontal-two-group'))
            {
                failures.push(`${file}: open-layout-vocabulary`);
            }
        }
        if (ts.isPropertySignature(node) && node.name.getText(tree) === 'effectiveLayout'
            && (!node.type || !ts.isLiteralTypeNode(node.type) || !ts.isStringLiteral(node.type.literal)
                || !['single-group', 'horizontal-two-group'].includes(node.type.literal.text)))
        {
            failures.push(`${file}: open-effective-layout-vocabulary`);
        }
    });
}

const ownerTree = trees.get(ownerPath);
const ownerClasses = ownerTree.statements.filter(node => ts.isClassDeclaration(node) && node.name?.text === 'AuthoringWorkspaceRatioOwner');
let ownerCreations = 0;
let identityCasGuards = 0;
visit(ownerTree, node =>
{
    if (ts.isNewExpression(node) && node.expression.getText(ownerTree) === 'AuthoringWorkspaceRatioOwner')
    {
        ownerCreations++;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
        && node.left.getText(ownerTree) === 'state.current' && node.right.getText(ownerTree) === 'prepared.expected')
    {
        identityCasGuards++;
    }
});
if (ownerClasses.length !== 1 || ownerClasses[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    || ownerCreations !== 1 || identityCasGuards !== 1)
{
    failures.push('ratio-owner: missing-unique-owner-or-exact-ref-CAS');
}
for (const name of ['#scopes', '#ratios', '#changes'])
{
    const member = ownerClasses[0]?.members.find(node => ts.isPropertyDeclaration(node) && node.name.getText(ownerTree) === name);
    if (!member?.initializer || !ts.isNewExpression(member.initializer) || member.initializer.expression.getText(ownerTree) !== 'WeakMap')
    {
        failures.push(`ratio-owner: missing-private-provenance-map:${name}`);
    }
}
for (const name of ['#requireScope', '#issue'])
{
    const member = ownerClasses[0]?.members.find(node => ts.isMethodDeclaration(node)
        && ts.isPrivateIdentifier(node.name) && node.name.getText(ownerTree) === name);
    if (!member)
    {
        failures.push(`ratio-owner: missing-runtime-private-helper:${name}`);
    }
}
for (const member of ownerClasses[0]?.members ?? [])
{
    if (member.modifiers?.some(modifier => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(modifier.kind))
        && (!member.name || !ts.isPrivateIdentifier(member.name)))
    {
        failures.push('ratio-owner: erased-privacy-modifier-leaks-runtime-member');
    }
    if (ts.isMethodDeclaration(member) && !ts.isPrivateIdentifier(member.name)
        && member.type?.getText(ownerTree) === 'RatioState')
    {
        failures.push('ratio-owner: public-mutable-state-return');
    }
}

const ratioValues = {};
visit(ownerTree, node =>
{
    if (ts.isPropertyAssignment(node) && ['minimumPermille', 'maximumPermille', 'defaultPermille'].includes(node.name.getText(ownerTree))
        && ts.isNumericLiteral(node.initializer))
    {
        const key = node.name.getText(ownerTree);
        if (Object.hasOwn(ratioValues, key))
        {
            failures.push(`ratio-owner: duplicate-policy-value:${key}`);
        }
        ratioValues[key] = Number(node.initializer.text);
    }
});
const wire = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/authoring-workspace-snapshot-wire.json'), 'utf8'));
let wireRatio;
function findWireRatio(value)
{
    if (!value || typeof value !== 'object')
    {
        return;
    }
    if (value.name === 'SplitRatioPermille')
    {
        if (wireRatio)
        {
            failures.push('snapshot-wire: ambiguous-ratio-field');
        }
        wireRatio = value;
    }
    for (const child of Object.values(value))
    {
        findWireRatio(child);
    }
}
findWireRatio(wire);
if (!wireRatio || ratioValues.minimumPermille !== wireRatio.min || ratioValues.maximumPermille !== wireRatio.max
    || ratioValues.defaultPermille !== 500)
{
    failures.push('ratio-owner: canonical-snapshot-policy-mismatch');
}

const uniqueFailures = [...new Set(failures)];
console.log(JSON.stringify({
    schema: 'fsusblog.authoring-workspace-layout-source-scan.v1',
    scope: 'ratio-and-pure-geometry-source-only',
    status: uniqueFailures.length === 0 ? 'source-check-pass' : 'source-check-fail',
    sources: [...sources].map(([file, source]) => ({ path: file, sha256: createHash('sha256').update(source).digest('hex') })),
    failures: uniqueFailures,
    notCovered: ['group-projection', 'session-retention', 'repository-wide-owner-count', 'SFC-DOM-font-stack-destroy-split-mutations', 'public-splitter', 'runtime-receipt-verifier', 'browser-geometry', 'tamper-race-security-privacy-IME-native']
}, null, 4));
process.exitCode = uniqueFailures.length === 0 ? 0 : 1;
