#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireParser = createRequire(path.join(defaultRoot, 'src/frontend/package.json'));

const authorityFiles = Object.freeze([
    'tools/test-fixtures/mutation-recovery/mutation-adapters.mjs',
    'tools/test-fixtures/mutation-recovery/runner.mjs',
    'tools/test-fixtures/mutation-recovery/semantic-snapshot.mjs'
]);

function read(root, relativePath)
{
    const absolute = path.join(root, relativePath);
    if (!fs.existsSync(absolute))
    {
        throw new Error(`missing mutation recovery authority ${relativePath}`);
    }
    return fs.readFileSync(absolute, 'utf8');
}

function toolingSources(root)
{
    const result = [];
    function visit(directory)
    {
        if (!fs.existsSync(directory))
        {
            return;
        }
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory())
            {
                visit(absolute);
            }
            else if (entry.isFile() && entry.name.endsWith('.mjs'))
            {
                result.push(fs.readFileSync(absolute, 'utf8'));
            }
        }
    }
    visit(path.join(root, 'tools'));
    return result.join('\n');
}

function processModuleImports(source, relativePath)
{
    // Use the installed frontend parser rather than treating comments or strings
    // as executable imports. A missing parser or invalid source fails closed.
    const { parse } = requireParser('acorn');
    const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
    const errors = [];
    function stringValue(node)
    {
        if (node?.type === 'Literal' && typeof node.value === 'string')
        {
            return node.value;
        }
        if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
        {
            return node.quasis[0].value.cooked;
        }
        if (node?.type === 'BinaryExpression' && node.operator === '+')
        {
            const left = stringValue(node.left);
            const right = stringValue(node.right);
            return left === null || right === null ? null : left + right;
        }
        if (node?.type === 'NewExpression' && node.callee?.name === 'URL'
            && node.arguments.length === 2
            && node.arguments[1]?.type === 'MemberExpression'
            && node.arguments[1].computed === false
            && node.arguments[1].property.name === 'url'
            && node.arguments[1].object?.type === 'MetaProperty'
            && node.arguments[1].object.meta.name === 'import'
            && node.arguments[1].object.property.name === 'meta')
        {
            return stringValue(node.arguments[0]);
        }
        return null;
    }
    function visit(node)
    {
        if (!node || typeof node !== 'object')
        {
            return;
        }
        let specifier = null;
        let moduleLoad = false;
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type))
        {
            moduleLoad = node.source !== null;
            specifier = stringValue(node.source);
        }
        else if (node.type === 'CallExpression'
            && (node.callee?.name === 'require'
                || (node.callee?.type === 'MemberExpression'
                    && ['require', 'getBuiltinModule'].includes(node.callee.computed
                        ? stringValue(node.callee.property)
                        : node.callee.property.name))))
        {
            moduleLoad = true;
            specifier = stringValue(node.arguments[0]);
        }
        if (moduleLoad && specifier === null)
        {
            errors.push(`mutation recovery authority forbids unresolved module loading: ${relativePath}:${node.loc.start.line}`);
        }
        if (specifier === 'child_process' || specifier === 'node:child_process')
        {
            errors.push(`mutation recovery authority forbids process execution: ${relativePath}:${node.loc.start.line} imports ${specifier}`);
        }
        for (const value of Object.values(node))
        {
            if (Array.isArray(value))
            {
                value.forEach(visit);
            }
            else if (value && typeof value === 'object' && typeof value.type === 'string')
            {
                visit(value);
            }
        }
    }
    visit(syntax);
    return errors;
}

export function checkFixtureMutationRecoveryGovernance(root = defaultRoot)
{
    const errors = [];
    const sources = Object.fromEntries(authorityFiles.map((file) => [file, read(root, file)]));
    const allTooling = toolingSources(root);
    const exports = [
        ['runMutationRecovery', /export async function runMutationRecovery\s*\(/gu],
        ['applyFixtureMutation', /export async function applyFixtureMutation\s*\(/gu],
        ['verifyMutationRecoveryReceipt', /export function verifyMutationRecoveryReceipt\s*\(/gu],
        ['verifyMutationJournal', /export async function verifyMutationJournal\s*\(/gu],
        ['verifySemanticSnapshot', /export function verifySemanticSnapshot\s*\(/gu]
    ];
    for (const [name, pattern] of exports)
    {
        if ([...allTooling.matchAll(pattern)].length !== 1)
        {
            errors.push(`${name} must have exactly one canonical implementation`);
        }
    }
    for (const [relativePath, source] of Object.entries(sources))
    {
        try
        {
            errors.push(...processModuleImports(source, relativePath));
        }
        catch (error)
        {
            errors.push(`mutation recovery authority syntax unavailable: ${relativePath}: ${error.message}`);
        }
    }
    const adapterSource = sources[authorityFiles[0]];
    const forbiddenAdapterPatterns = [
        [/\.query\s*\(/u, 'raw database query'],
        [/\.exec\s*\(/u, 'raw command execution'],
        [/\.scan\s*\(/iu, 'Redis wildcard scan'],
        [/\.flush(?:db|all)?\s*\(/iu, 'Redis/global cache flush'],
        [/\b(?:unlink|rm|rmdir)Sync\s*\(/u, 'unscoped filesystem removal'],
        [/\$\{[^}]+\}[^\n]*(?:SELECT|UPDATE|DELETE|INSERT)/iu, 'concatenated database statement']
    ];
    for (const [pattern, label] of forbiddenAdapterPatterns)
    {
        if (pattern.test(adapterSource))
        {
            errors.push(`mutation adapter contains forbidden ${label}`);
        }
    }
    const runnerSource = sources[authorityFiles[1]];
    const forbiddenRunnerCalls = [
        [/\.cleanup\s*\(/u, 'cleanup'],
        [/\.restart\s*\(/u, 'restart'],
        [/\.reset\s*\(/u, 'reset'],
        [/\.flush\s*\(/u, 'cache flush'],
        [/\bspawn(?:Sync)?\s*\(/u, 'process spawn'],
        [/\bexec(?:File|Sync)?\s*\(/u, 'command execution']
    ];
    for (const [pattern, label] of forbiddenRunnerCalls)
    {
        if (pattern.test(runnerSource))
        {
            errors.push(`mutation recovery runner contains forbidden ${label} call`);
        }
    }
    if (!runnerSource.includes("retryPolicy: 'none'")
      || !runnerSource.includes("recoveryMethod: 'same-sealed-profile-canonical-prepare'"))
    {
        errors.push('mutation recovery runner must seal no-retry and canonical same-profile recovery');
    }
    if (!adapterSource.includes('operationId: request.mutationKind')
      || !adapterSource.includes('targets: request.targets'))
    {
        errors.push('mutation adapter must pass only closed operation identity and resolved targets');
    }
    const snapshotSource = sources[authorityFiles[2]];
    if (!snapshotSource.includes('fieldDispositions')
      || !snapshotSource.includes("'secret-redacted'")
      || !snapshotSource.includes('semantic timestamp requires a #1730 semanticRole'))
    {
        errors.push('semantic snapshot must retain the closed field disposition and temporal authority');
    }
    if (/from ['"][^'"]*\/producers\//u.test(snapshotSource)
      || /(?:readdir|glob|latestSnapshot|expectedFixtureState)\s*\(/u.test(snapshotSource))
    {
        errors.push('semantic snapshot must observe current receipt state without producer copy, latest scan or expected-state derivation');
    }
    if (!snapshotSource.includes('semanticRecordDigest(record)')
      || !snapshotSource.includes('relationChanges')
      || !snapshotSource.includes('ttlChanges')
      || !snapshotSource.includes('byteChanges')
      || !snapshotSource.includes('projectionChanges'))
    {
        errors.push('semantic comparison must not degrade to row-count-only evidence');
    }
    return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    let errors;
    try
    {
        errors = checkFixtureMutationRecoveryGovernance(defaultRoot);
    }
    catch (error)
    {
        errors = [error.message];
    }
    if (errors.length > 0)
    {
        for (const error of errors)
        {
            console.error(`[fixture-mutation-recovery] ${error}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log('[fixture-mutation-recovery] governance passed');
    }
}
