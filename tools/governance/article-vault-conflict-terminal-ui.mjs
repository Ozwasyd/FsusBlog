#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const articleVaultConflictUiFiles = Object.freeze([
    'src/frontend/src/components/article-vault/conflictEvidencePresentation.ts',
    'src/frontend/src/components/article-vault/VaultConflictList.vue',
    'src/frontend/src/components/article-vault/resolutionStatusPresentation.ts',
    'src/frontend/src/components/article-vault/VaultResolutionStatus.vue'
]);

const imports = new Set([
    'vue', '@ozwasyd/element-plus', '@/fsusui/button', './conflictEvidencePresentation', './resolutionStatusPresentation',
    '../../../../shared/Contracts/ArticleVault/article-vault-conflict-evidence.schema.json'
]);
const forbiddenReferences = new Set([
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage',
    'indexedDB', 'caches', 'eval', 'Function', 'require', 'process', 'Deno', 'Bun',
    'FileSystemHandle', 'FileSystemFileHandle', 'showOpenFilePicker', 'showSaveFilePicker',
    'showDirectoryPicker', 'sendBeacon', 'serviceWorker'
]);
const forbiddenAuthorities = new Set([
    'ai', 'aiscore', 'airecommendation', 'mtime', 'winnermtime', 'winnersize', 'longercontent',
    'lastwritewins', 'twowaymerge', 'acceptalllocal', 'acceptallserver', 'winner',
    'latestreceipt', 'latestrecovery', 'githeadauthority'
]);
const forbiddenOperations = new Set([
    'writeFile', 'writeFileSync', 'writeTextFile', 'writeTextFileSync', 'executeSql',
    'executeGroupAsync', 'saveChanges', 'saveChangesAsync', 'upload', 'uploadAsync',
    'updateArticle', 'updateArticleAsync', 'publish', 'publishAsync', 'recoverLatest',
    'deleteServerHistory', 'exec', 'execSync', 'spawn', 'spawnSync'
]);
const machineFields = new Set(['state', 'status', 'synced', 'decision', 'winner', 'verified', 'isVerified']);
const reflectionWriters = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'set', 'deleteProperty']);

export function readArticleVaultConflictUiSources(root = repositoryRoot)
{
    return new Map(articleVaultConflictUiFiles.map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
}

/** A deliberately scoped AST check for the conflict/recovery presentation owners; not terminal acceptance. */
export function checkArticleVaultConflictUiSources(sources, root = repositoryRoot)
{
    const require = createRequire(path.join(root, 'src/frontend/package.json'));
    const ts = require('typescript');
    const vue = require('@vue/compiler-sfc');
    const errors = [];

    function issue(file, node, reason)
    {
        errors.push(`${file}:${node.getStart ? node.getStart() : 0}: ${reason}`);
    }

    function memberName(node)
    {
        if (ts.isPropertyAccessExpression(node))
        {
            return node.name.text;
        }
        if (ts.isElementAccessExpression(node) && node.argumentExpression
            && ts.isStringLiteralLike(node.argumentExpression))
        {
            return node.argumentExpression.text;
        }
        return null;
    }

    function inspect(file, source, template = false)
    {
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        if (ast.parseDiagnostics.length > 0)
        {
            errors.push(`${file}: invalid TypeScript syntax`);
            return;
        }

        function visit(node)
        {
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            {
                if (node.moduleSpecifier && (!ts.isStringLiteralLike(node.moduleSpecifier)
                    || !imports.has(node.moduleSpecifier.text)))
                {
                    issue(file, node, 'presentation dependency outside canonical schema/components');
                }
            }
            if (ts.isImportEqualsDeclaration(node))
            {
                issue(file, node, 'alternate import can acquire writer authority');
            }
            if (ts.isIdentifier(node))
            {
                if (forbiddenReferences.has(node.text))
                {
                    issue(file, node, 'network/storage/process authority');
                }
                if (forbiddenAuthorities.has(node.text.toLowerCase()))
                {
                    issue(file, node, 'winner/AI/mtime/two-way/latest authority');
                }
            }
            const member = memberName(node);
            if (member)
            {
                if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
                    && ts.isIdentifier(node.expression))
                {
                    if (['Object', 'Reflect'].includes(node.expression.text) && reflectionWriters.has(member))
                    {
                        issue(file, node, 'reflection writer can mutate canonical machine state');
                    }
                    if (node.expression.text === 'console')
                    {
                        issue(file, node, 'console evidence privacy leak');
                    }
                }
                if (forbiddenReferences.has(member))
                {
                    issue(file, node, 'network/storage/process member authority');
                }
                if (forbiddenAuthorities.has(member.toLowerCase()))
                {
                    issue(file, node, 'winner/AI/mtime/two-way/latest member authority');
                }
            }
            if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
                && ['globalThis', 'window', 'self', 'navigator'].includes(node.expression.text) && !member)
            {
                issue(file, node, 'dynamic global capability lookup');
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node))
            {
                const name = ts.isIdentifier(node.expression) ? node.expression.text : memberName(node.expression);
                if (name && forbiddenOperations.has(name))
                {
                    issue(file, node, 'direct writer/Git/recovery operation');
                }
                if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
                {
                    issue(file, node, 'dynamic dependency can acquire writer authority');
                }
            }
            if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind))
            {
                const name = ts.isIdentifier(node.left) ? node.left.text : memberName(node.left);
                if (machineFields.has(name))
                {
                    issue(file, node, 'UI writes canonical machine state/decision');
                }
            }
            if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
            {
                const name = ts.isIdentifier(node.operand) ? node.operand.text : memberName(node.operand);
                if (machineFields.has(name))
                {
                    issue(file, node, 'UI mutates canonical machine state/decision');
                }
            }
            if (ts.isDeleteExpression(node) && machineFields.has(memberName(node.expression)))
            {
                issue(file, node, 'UI deletes canonical machine state/decision');
            }
            // Vue compiles v-html to an innerHTML property. Inspect the actual generated render AST.
            if (template && ts.isPropertyAssignment(node)
                && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) && node.name.text === 'innerHTML')
            {
                issue(file, node, 'raw HTML body injection');
            }
            ts.forEachChild(node, visit);
        }
        visit(ast);
    }

    for (const file of articleVaultConflictUiFiles)
    {
        const source = sources.get(file);
        if (typeof source !== 'string')
        {
            errors.push(`${file}: missing canonical UI presentation owner`);
            continue;
        }
        if (!file.endsWith('.vue'))
        {
            inspect(file, source);
            continue;
        }
        const parsed = vue.parse(source, { filename: file });
        if (parsed.errors.length > 0)
        {
            errors.push(`${file}: invalid Vue syntax`);
            continue;
        }
        for (const block of [parsed.descriptor.script, parsed.descriptor.scriptSetup].filter(Boolean))
        {
            if (block.src)
            {
                errors.push(`${file}: external script outside canonical presentation owner`);
            }
            inspect(file, block.content);
        }
        if (parsed.descriptor.template)
        {
            const compiled = vue.compileTemplate({
                source: parsed.descriptor.template.content, filename: file, id: 'vault-conflict-terminal',
                compilerOptions: { expressionPlugins: ['typescript'] }
            });
            if (compiled.errors.length > 0)
            {
                errors.push(`${file}: invalid Vue template expressions`);
            }
            else
            {
                inspect(`${file}:template`, compiled.code, true);
            }
        }
    }
    return [...new Set(errors)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const errors = checkArticleVaultConflictUiSources(readArticleVaultConflictUiSources());
    if (errors.length > 0)
    {
        console.error(errors.join('\n'));
        process.exitCode = 1;
    }
    else
    {
        console.log('Article Vault conflict UI AST boundary passed (presentation source only).');
    }
}
