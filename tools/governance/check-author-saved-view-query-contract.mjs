#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const contractPath = 'src/backend/Services/Authoring/AuthorSavedViewContracts.cs';

function walkCSharpFiles(directory)
{
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        if (entry.name === 'bin' || entry.name === 'obj') return [];
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return walkCSharpFiles(entryPath);
        return entry.isFile() && entry.name.endsWith('.cs') ? [entryPath] : [];
    });
}

function occurrences(value, pattern)
{
    return [...value.matchAll(pattern)].length;
}

function normalizedRecordSignature(source, recordName)
{
    const match = source.match(new RegExp(`public sealed record ${recordName}\\(([^;]+)\\);`, 'su'));
    return match?.[1].replaceAll(/\s+/gu, ' ').trim() ?? null;
}

export function validateAuthorSavedViewQueryContract(repositoryRoot)
{
    const root = path.resolve(repositoryRoot);
    const sourceFile = path.join(root, contractPath);
    if (!fs.existsSync(sourceFile)) return [`missing ${contractPath}`];

    const source = fs.readFileSync(sourceFile, 'utf8');
    const backendSources = walkCSharpFiles(path.join(root, 'src/backend'))
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n');
    const errors = [];

    const expectedQuery = [
        'int SchemaVersion,',
        'IReadOnlyList<AuthorSavedViewCondition> Conditions,',
        'AuthorSavedViewSort Sort,',
        'IReadOnlyList<AuthorSavedViewFieldReference> Projection,',
        'int PageSize'
    ].join(' ');
    const expectedCondition = [
        'AuthorSavedViewFieldReference Field,',
        'string OperatorId,',
        'IReadOnlyList<string> Values,',
        'string? TimeZoneId = null'
    ].join(' ');
    const expectedFact = [
        'AuthorSavedViewFieldReference Dependency,',
        'string OperatorId,',
        'AuthorSavedViewDependencyStatus Status,',
        'string AuthorityRevision,',
        'IReadOnlyList<string> CanonicalValues'
    ].join(' ');

    if (normalizedRecordSignature(source, 'AuthorSavedViewQuery') !== expectedQuery)
        errors.push('AuthorSavedViewQuery must remain the exact non-recursive closed shape');
    if (normalizedRecordSignature(source, 'AuthorSavedViewCondition') !== expectedCondition)
        errors.push('AuthorSavedViewCondition must remain the exact non-recursive closed shape');
    if (normalizedRecordSignature(source, 'AuthorSavedViewDependencyFact') !== expectedFact)
        errors.push('dependency providers must return the exact descriptor-free fact shape');

    const provider = source.match(/public interface IAuthorSavedViewDependencyProvider\s*\{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? '';
    if (occurrences(provider, /ValueTask<AuthorSavedViewDependencyFact\?>/gu) !== 3
        || provider.includes('AuthorSavedViewDependencyResolution')
        || provider.includes('AuthorSavedViewOperatorDescriptor'))
    {
        errors.push('dependency provider may resolve facts only and cannot supply operator descriptors');
    }

    if (occurrences(backendSources, /public sealed record AuthorSavedViewQuery\b/gu) !== 1)
        errors.push('AuthorSavedViewQuery must have exactly one backend definition');
    if (occurrences(backendSources, /\bReadOnlyDictionary<string,\s*AuthorSavedViewOperatorDescriptor>/gu) !== 1
        || occurrences(backendSources, /new Dictionary<string,\s*AuthorSavedViewOperatorDescriptor>/gu) !== 1)
    {
        errors.push('Author Saved View operator registry must have exactly one read-only owner');
    }
    if (occurrences(backendSources, /\bReadOnlyDictionary<AuthorSavedViewFieldKind,\s*AuthorSavedViewFieldDescriptor>/gu) !== 1
        || occurrences(backendSources, /new Dictionary<AuthorSavedViewFieldKind,\s*AuthorSavedViewFieldDescriptor>/gu) !== 1)
    {
        errors.push('Author Saved View field registry must have exactly one read-only owner');
    }

    const forbiddenIdentifier = /\bAuthorSavedView\w*(?:Sql|JavaScript|Regex|AiQuery|ResultIds|ClientFunction|ExpressionTree|RecursiveGroup)\w*\b/gu;
    if (forbiddenIdentifier.test(backendSources))
        errors.push('saved view backend contains an executable, AI, result snapshot, or recursive expression surface');

    for (const required of [
        'saved_view_field_kind_unknown',
        'saved_view_field_identity_unknown',
        'saved_view_operator_unknown',
        'saved_view_operator_field_incompatible',
        'saved_view_dependency_fact_tampered'
    ])
    {
        if (!source.includes(required)) errors.push(`missing fail-closed validation: ${required}`);
    }

    return errors;
}

function option(name)
{
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
{
    const root = path.resolve(option('--root') ?? path.join(import.meta.dirname, '../..'));
    const errors = validateAuthorSavedViewQueryContract(root);
    if (errors.length > 0)
    {
        for (const error of errors) console.error(`[author-saved-view-query-contract] ${error}`);
        process.exitCode = 1;
    }
    else
    {
        console.log('[author-saved-view-query-contract] ok');
    }
}
