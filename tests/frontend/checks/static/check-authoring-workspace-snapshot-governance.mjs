#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-stage controls only. --full intentionally exposes outstanding shell integration;
// this scanner cannot issue authenticated runtime, UX or terminal acceptance evidence.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const requireFrontend = createRequire(path.join(root, 'src/frontend/package.json'));
const ts = requireFrontend('typescript');
const api = 'src/frontend/src/api/authoringWorkspaceSnapshot.ts';
const prefix = 'src/frontend/src/services/authoring/authoringWorkspaceSnapshot';
const files = [api, ...['Cache', 'Sync', 'Restore', 'Migration', 'Status'].map(name => `${prefix}${name}.ts`),
    'src/shared/Contracts/AuthoringWorkspace/AuthoringWorkspaceSnapshotContracts.cs',
    'src/backend/Services/Authoring/AuthoringWorkspaceSnapshotStore.cs',
    'src/backend/Services/Authoring/AuthoringWorkspaceSnapshotPostgresPersistence.cs'];
const sources = new Map(files.map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
for (const argument of process.argv.slice(2)) assert.ok(['--full', '--self-test'].includes(argument), `unknown argument ${argument}`);
const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const forbiddenField = /^(?:name|names|workspaces|collection|collections|template|templates|body|draft|undo|undoStack|history|selection|selectionOffsets|parserState|projectionState|html|attachmentBytes|token|journal|title|titles)$/iu;
const failures = (map) =>
{
    const result = [];
    for (const [file, source] of map)
    {
        if (!file.endsWith('.ts')) continue;
        const tree = parse(file, source);
        const visit = node =>
        {
            if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node))
            {
                for (const member of node.members)
                {
                    if (ts.isPropertySignature(member) && forbiddenField.test(member.name.getText(tree).replaceAll(/['"]/gu, '')))
                        result.push(`${file}: forbidden-persistence-field`);
                }
            }
            if (ts.isIdentifier(node) && /^(?:localStorage|sessionStorage)$/u.test(node.text))
                result.push(`${file}: browser-local-authority`);
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
                && /(?:pinia|writer|editor)/iu.test(node.moduleSpecifier.text))
                result.push(`${file}: editor-hydration-dependency`);
            if (ts.isCallExpression(node) && /^(?:fetch|axios(?:\..+)?|navigator\.sendBeacon)$/u.test(node.expression.getText(tree)))
                result.push(`${file}: unregistered-transport`);
            ts.forEachChild(node, visit);
        };
        visit(tree);
    }
    const apiTree = parse(api, map.get(api));
    const snapshot = apiTree.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'AuthoringWorkspaceSnapshot');
    const workspaceId = snapshot?.members.find(node => node.name?.getText(apiTree) === 'workspaceId');
    if (workspaceId?.type?.getText(apiTree) !== "'default'") result.push(`${api}: second-workspace`);
    const hasCall = (file, name) =>
    {
        let found = false;
        const visit = node =>
        {
            if (ts.isCallExpression(node) && node.expression.getText() === name) found = true;
            ts.forEachChild(node, visit);
        };
        visit(parse(file, map.get(file)));
        return found;
    };
    if (!hasCall(`${prefix}Cache.ts`, 'requireWorkspaceServerObservation')) result.push('cache: provenance-guard-missing');
    if (!hasCall(`${prefix}Restore.ts`, 'requireWorkspaceServerObservation')) result.push('restore: provenance-guard-missing');
    if (!hasCall(`${prefix}Restore.ts`, 'requirePreparedWorkspaceSnapshotRestorePlan')) result.push('restore: prepared-plan-guard-missing');
    const cacheTree = parse(`${prefix}Cache.ts`, map.get(`${prefix}Cache.ts`));
    const cacheRead = cacheTree.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'WorkspaceSnapshotCacheRead');
    if (cacheRead && /['"](?:current|saved|applied)['"]/u.test(cacheRead.type.getText(cacheTree))) result.push('cache: authority-status');
    const postgres = map.get(files.at(-1));
    if (!postgres.includes('ON CONFLICT (user_id, site_id, workspace_id) DO NOTHING')
        || !postgres.includes('AND revision = @ExpectedRevision')) result.push('postgres: atomic-cas-missing');
    for (const file of files.filter(name => name.endsWith('.cs')))
    {
        if (/\b(?:ArticleService|AuthoringDraftLifecycleService|Deleteable|DeleteArticle|DeleteDraft)\b/u.test(map.get(file)))
            result.push(`${file}: content-mutation-dependency`);
    }
    return [...new Set(result)];
};

// Enumerate the actual exported schema/policies rather than defining another workspace model.
const inventory = { fields: {}, fieldTypes: {}, aliases: {}, policies: {} };
for (const [file, source] of sources)
{
    if (!file.endsWith('.ts')) continue;
    const tree = parse(file, source);
    for (const statement of tree.statements)
    {
        if (ts.isInterfaceDeclaration(statement))
        {
            inventory.fields[statement.name.text] = statement.members.filter(node => ts.isPropertySignature(node)).map(node => node.name.getText(tree));
            inventory.fieldTypes[statement.name.text] = Object.fromEntries(statement.members.filter(node => ts.isPropertySignature(node))
                .map(node => [node.name.getText(tree), node.type?.getText(tree) ?? null]));
        }
        if (ts.isTypeAliasDeclaration(statement)) inventory.aliases[statement.name.text] = statement.type.getText(tree);
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations)
        {
            if (!/(?:Contract|Policy)$/u.test(declaration.name.getText(tree)) || !declaration.initializer) continue;
            const visit = node =>
            {
                if (ts.isObjectLiteralExpression(node))
                    inventory.policies[declaration.name.getText(tree)] = Object.fromEntries(node.properties.filter(ts.isPropertyAssignment)
                        .map(property => [property.name.getText(tree), property.initializer.getText(tree)]));
                ts.forEachChild(node, visit);
            };
            visit(declaration.initializer);
        }
    }
}
const identityFile = 'src/frontend/src/services/authoring/openArticleDocumentRegistry.ts';
const identityTree = parse(identityFile, readFileSync(path.join(root, identityFile), 'utf8'));
const identity = identityTree.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'ArticleDocumentIdentity');
inventory.fields.AuthoringWorkspaceSnapshotIdentity = identity.members.map(node => node.name.getText(identityTree));
for (const match of sources.get(files[6]).matchAll(/public sealed record (\w+)\(([\s\S]*?)\);/gu))
{
    const members = match[2].split(',').map(member => member.trim().split(/\s+/u).at(-1)).map(name => name[0].toLowerCase() + name.slice(1));
    assert.deepEqual(members, inventory.fields[match[1]], `C#/TypeScript field parity: ${match[1]}`);
}

const controls = [
    ['named-workspace', api, "    revision: number;", "    name: string;\n    revision: number;", 'forbidden-persistence-field'],
    ['second-workspace', api, "    workspaceId: 'default';", "    workspaceId: string;", 'second-workspace'],
    ['body-storage', api, '    tabId: string;', '    body: string;\n    tabId: string;', 'forbidden-persistence-field'],
    ['journal-storage', `${prefix}Cache.ts`, '    snapshotBytes: string;', '    journal: string;\n    snapshotBytes: string;', 'forbidden-persistence-field'],
    ['local-authority', `${prefix}Sync.ts`, 'this.memory = structuredClone(layout);', "localStorage.setItem('workspace', JSON.stringify(layout));\n        this.memory = structuredClone(layout);", 'browser-local-authority'],
    ['json-transport', api, 'validateWorkspaceSnapshotScope(scope);', "fetch('/workspace.json');\n        validateWorkspaceSnapshotScope(scope);", 'unregistered-transport'],
    ['direct-editor-hydration', `${prefix}Restore.ts`, 'const preparedPlans', "import { useEditorStore } from '@/stores/editor';\nconst preparedPlans", 'editor-hydration-dependency'],
    ['cache-saved', `${prefix}Cache.ts`, "status: 'cached-placeholder';", "status: 'current';", 'authority-status'],
    ['cache-provenance-denial', `${prefix}Cache.ts`, 'requireWorkspaceServerObservation(observation);', 'void observation;', 'provenance-guard-missing'],
    ['restore-provenance-denial', `${prefix}Restore.ts`, 'requireWorkspaceServerObservation(', 'void (', 'provenance-guard-missing'],
    ['restore-plan-denial', `${prefix}Restore.ts`, 'requirePreparedWorkspaceSnapshotRestorePlan(plan);', 'void plan;', 'prepared-plan-guard-missing'],
    ['last-write-wins', files.at(-1), 'AND revision = @ExpectedRevision', 'AND TRUE', 'atomic-cas-missing'],
    ['reset-deletes-content', files[7], 'public sealed class', 'internal class DeleteArticle {}\npublic sealed class', 'content-mutation-dependency']
];
if (process.argv.includes('--self-test'))
{
    assert.deepEqual(failures(sources), [], 'source-stage baseline');
    for (const [name, file, needle, replacement, expected] of controls)
    {
        const mutant = new Map(sources);
        assert.ok(mutant.get(file).includes(needle), `mutation target ${name}`);
        mutant.set(file, mutant.get(file).replaceAll(needle, replacement));
        assert.ok(failures(mutant).some(value => value.includes(expected)), `mutation survived: ${name}`);
    }
}
const errors = failures(sources);
if (process.argv.includes('--full'))
{
    const visit = directory =>
    {
        for (const entry of readdirSync(directory, { withFileTypes: true }))
        {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (/\.(?:ts|vue)$/u.test(entry.name))
            {
                const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
                const source = readFileSync(absolute, 'utf8');
                if (relative !== `${prefix}Migration.ts` && source.includes('fsusblog.article-outline.rail-open.v1'))
                    errors.push(`${relative}: unscoped-legacy-reader-writer-still-live`);
                if (relative !== api && source.includes('fsusblog.authoring-workspace-snapshot.v1'))
                    errors.push(`${relative}: second-snapshot-contract-owner`);
                if (relative !== `${prefix}Cache.ts` && source.includes('fsusblog.authoring-workspace-verified.v1'))
                    errors.push(`${relative}: second-cache-owner`);
            }
        }
    };
    visit(path.join(root, 'src/frontend/src'));
}
const sourceDigest = createHash('sha256').update(JSON.stringify([...sources])).digest('hex');
console.log(JSON.stringify({ schema: 'fsusblog.workspace-snapshot-source-check.v1', stage: 'source-only', sourceDigest,
    inventory, mutationControls: process.argv.includes('--self-test') ? controls.map(control => control[0]) : [], failures: errors }, null, 2));
process.exitCode = errors.length ? 1 : 0;
