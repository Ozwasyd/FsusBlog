#!/usr/bin/env node

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFrontendSourceIndex, validateFrontendSourceIndex } from './source-index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ownerPath = 'src/frontend/src/services/authoring/authoringNavigationHistory.ts';
const typeImports = new Set(['./articleAnchorContext', './authoringTabGroupRegistry', './openArticleDocumentRegistry']);
const runtimeImports = new Set(['@noble/hashes/sha2.js', '@noble/hashes/utils.js']);
const forbiddenGlobals = new Set(['window', 'globalThis', 'localStorage', 'sessionStorage', 'indexedDB',
    'location', 'fetch', 'XMLHttpRequest', 'WebSocket', 'HTMLElement', 'EventSource', 'URL', 'URLSearchParams',
    'setTimeout', 'setInterval', 'requestAnimationFrame']);
const forbiddenCalls = new Set(['pushState', 'replaceState', 'addEventListener', 'openOrActivate',
    'createEditorSession', 'restore', 'reveal', 'manual', 'capture', 'synchronize']);
const forbiddenFields = new Set(['url', 'title', 'slug', 'headingText', 'domPath', 'htmlOffset',
    'offset', 'textareaRef', 'selection', 'body', 'markdown', 'html', 'undo', 'recentStack', 'editorSessionRef',
    'groupEpoch', 'groupGeneration']);
const requiredExports = new Set(['AuthoringNavigationHistory', 'applyAuthoringNavigationCommand',
    'createAuthoringNavigationHistoryState', 'verifyAuthoringNavigationHistoryState',
    'observeAuthoringNavigationTarget', 'verifyAuthoringNavigationTransition', 'verifyAuthoringNavigationReplay']);

/** Authored source control; symbolic producer coordinates do not mount or execute a target. */
function checkGroupReuseOrdering(ast, ts)
{
    const errors = [];
    const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration)
        .filter(node => node.name).map(node => [node.name.text, node]));
    const mutation = functions.get('validityIsFresh');
    const replay = functions.get('verifyAuthoringNavigationTransition');
    const observation = functions.get('observeAuthoringNavigationTarget');
    const validity = ast.statements.find(node => ts.isInterfaceDeclaration(node)
        && node.name.text === 'AuthoringNavigationValidity');
    const coordinate = validity?.members.find(node => node.name?.getText(ast) === 'groupRegistryRevision');
    if (!coordinate?.type || coordinate.type.getText(ast) !== "AuthoringTabGroupRegistryState['revision']")
    {
        errors.push('group-reuse: validity must retain the original Group registry revision type');
    }
    let replayExpression = null;
    let sharedFreshness = false;
    let coherentProjection = false;
    let projectedCoordinate = false;
    const inspect = (node, mode) =>
    {
        if (mode === 'replay' && ts.isVariableDeclaration(node) && node.name.getText(ast) === 'observationIsOrdered'
            && node.initializer && ts.isArrowFunction(node.initializer) && !ts.isBlock(node.initializer.body))
        {
            replayExpression = node.initializer.body;
        }
        if (mode === 'replay' && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === 'validityIsFresh')
        {
            sharedFreshness = true;
        }
        if (mode === 'observation' && ts.isBinaryExpression(node)
            && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
            && node.left.getText(ast) === 'facts.groupRegistry.articleRegistryRevision'
            && node.right.getText(ast) === 'facts.registryRevision')
        {
            coherentProjection = true;
        }
        if (mode === 'observation' && ts.isPropertyAssignment(node) && node.name.getText(ast) === 'groupRegistryRevision'
            && node.initializer.getText(ast) === 'facts.groupRegistry.revision')
        {
            projectedCoordinate = true;
        }
        ts.forEachChild(node, child => inspect(child, mode));
    };
    if (replay)
    {
        inspect(replay, 'replay');
    }
    if (observation)
    {
        inspect(observation, 'observation');
    }
    if (sharedFreshness || !replayExpression)
    {
        errors.push('group-reuse: replay must independently order producer coordinates');
    }
    if (!coherentProjection || !projectedCoordinate)
    {
        errors.push('group-reuse: observations must bind the actual Group publication to the Registry revision');
    }
    const returns = mutation?.body?.statements.filter(ts.isReturnStatement) ?? [];
    if (returns.length !== 1 || !returns[0].expression)
    {
        errors.push('group-reuse: mutation ordering must have one closed coordinate expression');
        return errors;
    }
    // Closed AST constant folding only: no calls, imports, module execution or arbitrary evaluator.
    const evaluate = (node, bindings) =>
    {
        if (ts.isParenthesizedExpression(node))
        {
            return evaluate(node.expression, bindings);
        }
        if (node.kind === ts.SyntaxKind.FalseKeyword)
        {
            return false;
        }
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
            && Object.hasOwn(bindings, node.expression.text)
            && Object.hasOwn(bindings[node.expression.text], node.name.text))
        {
            return bindings[node.expression.text][node.name.text];
        }
        if (ts.isConditionalExpression(node))
        {
            const condition = evaluate(node.condition, bindings);
            const positive = evaluate(node.whenTrue, bindings);
            const negative = evaluate(node.whenFalse, bindings);
            return condition ? positive : negative;
        }
        if (ts.isBinaryExpression(node))
        {
            const left = evaluate(node.left, bindings);
            const right = evaluate(node.right, bindings);
            switch (node.operatorToken.kind)
            {
                case ts.SyntaxKind.AmpersandAmpersandToken: return left && right;
                case ts.SyntaxKind.BarBarToken: return left || right;
                case ts.SyntaxKind.GreaterThanEqualsToken: return left >= right;
                case ts.SyntaxKind.GreaterThanToken: return left > right;
                case ts.SyntaxKind.LessThanToken: return left < right;
                case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
                case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
            }
        }
        throw new Error('group-reuse: unsupported coordinate AST');
    };
    const previous = { registryRevision: 20, groupRegistryRevision: 5, groupRevision: 2 };
    // Original producer: move-out (6/3), close (7/absent), same-ID-create (8/0), move-back (9/1).
    // History sees only 5/2 and 9/1; document/group identity validation remains outside this ordering control.
    const cases = [
        { name: 'same-document-move-out-close-recreate-move-back-without-missing-observation',
            next: { registryRevision: 24, groupRegistryRevision: 9, groupRevision: 1 }, expected: true },
        { name: 'regressing-group-publication',
            next: { registryRevision: 24, groupRegistryRevision: 4, groupRevision: 1 }, expected: false },
        { name: 'regressing-article-publication',
            next: { registryRevision: 19, groupRegistryRevision: 9, groupRevision: 1 }, expected: false },
        { name: 'same-publication-local-revision-drop',
            next: { registryRevision: 20, groupRegistryRevision: 5, groupRevision: 1 }, expected: false },
        { name: 'same-publication-local-revision-increase',
            next: { registryRevision: 20, groupRegistryRevision: 5, groupRevision: 3 }, expected: false },
        { name: 'same-publication-identical-local-coordinate',
            next: { registryRevision: 20, groupRegistryRevision: 5, groupRevision: 2 }, expected: true },
        { name: 'missing-group-at-a-later-publication',
            next: { registryRevision: 22, groupRegistryRevision: 7, groupRevision: null }, expected: true }
    ];
    for (const item of cases)
    {
        for (const [label, expression] of [['mutation', returns[0].expression], ['independent-replay', replayExpression]])
        {
            try
            {
                if (!expression || evaluate(expression, { previous, next: item.next }) !== item.expected)
                {
                    errors.push(`group-reuse: ${label} does not match producer coordinate case ${item.name}`);
                }
            }
            catch (error)
            {
                errors.push(`group-reuse: ${label}: ${error.message}`);
            }
        }
    }
    return errors;
}

/** Static AST review only: consumes the canonical in-memory index and writes no evidence or receipts. */
export function checkAuthoringNavigationHistorySource(index, repositoryRoot = root)
{
    const errors = validateFrontendSourceIndex(index, { parserRoot: repositoryRoot });
    if (errors.length > 0)
    {
        return errors;
    }
    const require = createRequire(path.join(repositoryRoot, 'src/frontend/package.json'));
    const ts = require('typescript');
    const owner = index.files.find(file => file.path === ownerPath);
    if (!owner?.typescript.ast || Array.isArray(owner.typescript.ast))
    {
        return ['canonical navigation history TypeScript owner is missing'];
    }
    errors.push(...checkGroupReuseOrdering(owner.typescript.ast, ts));
    const declaredExports = new Set();
    const ownerDeclarations = [];
    const issue = (file, node, message) =>
    {
        const position = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
        errors.push(`${file.path}:${position.line + 1}:${position.character + 1}: ${message}`);
    };
    for (const file of index.files)
    {
        const scripts = Array.isArray(file.typescript.ast) ? file.typescript.ast
            : file.typescript.ast ? [file.typescript.ast] : [];
        for (const ast of scripts)
        {
            for (const diagnostic of ast.parseDiagnostics)
            {
                issue(file, ast, `syntax error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
            }
            const visit = node =>
            {
                if (ts.isClassDeclaration(node) && node.name && /navigation.*history|history.*navigation/iu.test(node.name.text))
                {
                    ownerDeclarations.push(`${file.path}:${node.name.text}`);
                }
                const canonical = file.path === ownerPath;
                if (canonical && node.name && ts.isIdentifier(node.name)
                    && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
                {
                    declaredExports.add(node.name.text);
                }
                if (ts.isImportDeclaration(node))
                {
                    const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
                    if (canonical && !(node.importClause?.isTypeOnly ? typeImports.has(specifier) : runtimeImports.has(specifier)))
                    {
                        issue(file, node, 'history imports must use canonical upstream types or the fixed digest primitives');
                    }
                    if (!canonical && /(?:^|\/)authoringNavigationHistory$/u.test(specifier)
                        && !node.importClause?.isTypeOnly)
                    {
                        issue(file, node, 'runtime history attachment remains outside this source-only slice');
                    }
                }
                if (canonical && ts.isIdentifier(node) && forbiddenGlobals.has(node.text))
                {
                    issue(file, node, 'browser, timer, storage or transport capability is forbidden in the pure history owner');
                }
                if (canonical && ts.isCallExpression(node))
                {
                    if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
                    {
                        issue(file, node, 'dynamic product imports are forbidden');
                    }
                    const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
                        : ts.isIdentifier(node.expression) ? node.expression.text : '';
                    if (forbiddenCalls.has(name))
                    {
                        issue(file, node, 'history cannot activate, restore, reveal or subscribe to editor/browser events');
                    }
                }
                if (canonical && (ts.isPropertySignature(node) || ts.isPropertyAssignment(node)))
                {
                    const name = node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : '';
                    if (forbiddenFields.has(name))
                    {
                        issue(file, node, 'presentation/private/editor/recent-stack fields cannot become history authority');
                    }
                    if (node.name && ts.isComputedPropertyName(node.name))
                    {
                        issue(file, node, 'computed payload fields cannot bypass the closed schema');
                    }
                }
                if (!canonical && file.path.startsWith('src/frontend/src/')
                    && (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node))
                    && node.name && ts.isIdentifier(node.name)
                    && /^(?:authoringNavigationHistory|navigationHistory|navigationEntries|navigationStack|backStack|forwardStack)$/u.test(node.name.text))
                {
                    issue(file, node, 'a local navigation stack or second named history authority is forbidden');
                }
                ts.forEachChild(node, visit);
            };
            visit(ast);
        }
    }
    if (ownerDeclarations.length !== 1 || ownerDeclarations[0] !== `${ownerPath}:AuthoringNavigationHistory`)
    {
        errors.push(`expected exact-one named navigation history owner: ${ownerDeclarations.join(', ') || '<none>'}`);
    }
    for (const name of requiredExports)
    {
        if (!declaredExports.has(name))
        {
            errors.push(`${ownerPath}: required source boundary ${name} is missing`);
        }
    }
    return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    if (process.argv.length !== 2)
    {
        throw new Error('usage: node tools/frontend/check-authoring-navigation-history-source.mjs');
    }
    const index = buildFrontendSourceIndex({ repoRoot: root });
    const errors = checkAuthoringNavigationHistorySource(index);
    for (const error of errors)
    {
        console.error(`[authoring-navigation-source] ${error}`);
    }
    if (errors.length > 0)
    {
        process.exitCode = 1;
    }
    else
    {
        console.log(`[authoring-navigation-source] ok: source AST only, owner=${ownerPath}, digest=${index.files.find(file => file.path === ownerPath).contentDigest}`);
    }
}
