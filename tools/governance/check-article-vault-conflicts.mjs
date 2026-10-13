#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractRoot = 'src/shared/Contracts/ArticleVault';
const contractsFile = `${contractRoot}/ArticleVaultConflictContracts.cs`;
const registryFile = `${contractRoot}/ArticleVaultConflictRegistry.cs`;
const verifierFile = `${contractRoot}/ArticleVaultConflictVerifier.cs`;
const schemaFile = `${contractRoot}/article-vault-conflict-evidence.schema.json`;
const sourceFiles = [contractsFile, registryFile, verifierFile];
const inputFiles = [...sourceFiles, schemaFile];
const expectedRegistry = [
    ['SourceDisjoint', 'Automatic', 'issue-2117', 'SourceChanges', 'VerifiedSourceCandidate', 'PrepareSourceCandidate'],
    ['SourceOverlap', 'Manual', 'issue-2117', 'SourceChanges', 'VerifiedSourceCandidate', 'ProposeSourceReplacement'],
    ['MetadataDisjoint', 'Automatic', 'issue-2118', 'MetadataChanges', 'VerifiedMetadataCandidate', 'PrepareMetadataCandidate'],
    ['MetadataOverlap', 'Manual', 'issue-2118', 'MetadataChanges', 'VerifiedMetadataCandidate', 'ProposeMetadataReplacement'],
    ['RenameVsEdit', 'Manual', 'issue-2120', 'IdentityProjection', 'PortableIdentity', 'RequestRefactorPlan'],
    ['DeleteVsEdit', 'Manual', 'issue-2120', 'Deletion', 'CanonicalDeletion', 'RequestDeletionPlan'],
    ['CreateCreate', 'Rejected', 'issue-2120', 'Creation', 'PortableIdentity', 'RefreshEvidence'],
    ['LifecycleConflict', 'Rejected', 'server-lifecycle', 'Lifecycle', 'ServerLifecycle', 'RefreshEvidence'],
    ['PermissionConflict', 'Rejected', 'server-permission', 'Permission', 'ServerPermission', 'RefreshEvidence'],
    ['SchemaConflict', 'Rejected', 'issue-2103', 'Schema', 'Schema', 'RefreshEvidence'],
    ['DependencyConflict', 'Rejected', 'issue-2124', 'Dependency', 'Dependency', 'RefreshEvidence'],
    ['GitMarkerPresent', 'Rejected', 'issue-2119', 'GitMarkers', 'GitFactsOnly', 'RefreshEvidence']
];

const requiredOwners = new Map([
    ['ArticleVaultConflictSchemas', contractsFile],
    ['ArticleVaultConflictRegistry', registryFile],
    ['ArticleVaultConflictCodec', verifierFile],
    ['ArticleVaultConflictVerifier', verifierFile]
]);

function withoutComments(source)
{
    return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\r\n]*/gu, '');
}

function enumNames(source, name)
{
    const match = new RegExp(`\\bpublic\\s+enum\\s+${name}\\s*\\{([^}]+)\\}`, 'u').exec(source);
    return match ? match[1].split(',').map((value) => value.trim().split(/\s*=\s*/u)[0]) : [];
}

export function readArticleVaultConflictSources(root = repositoryRoot)
{
    return new Map(inputFiles.map((relative) => [relative, readFileSync(path.join(root, relative), 'utf8')]));
}

/** Checks only the three conflict owner files; neither runs nor qualifies product behavior. */
export function checkArticleVaultConflictSources(sources)
{
    const errors = [];
    for (const relative of inputFiles)
    {
        if (!sources.has(relative))
        {
            errors.push(`missing canonical conflict owner: ${relative}`);
        }
    }
    if (errors.length > 0)
    {
        return errors;
    }

    let schema;
    try
    {
        schema = JSON.parse(sources.get(schemaFile));
    }
    catch
    {
        errors.push('conflict schema must be valid closed JSON');
    }
    if (schema)
    {
        const wireTypes = expectedRegistry.map(([type]) => type.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase());
        if (schema.properties?.schema?.const !== 'fsusblog.article-vault.conflict-evidence.v1'
            || schema.properties?.schemaVersion?.const !== 1
            || JSON.stringify(schema.$defs?.type?.enum) !== JSON.stringify(wireTypes)
            || JSON.stringify(schema.required) !== JSON.stringify(['schema', 'schemaVersion', 'registrySha256', 'binding', 'items', 'contentSha256']))
        {
            errors.push('conflict schema version, exact type roster and required bindings must match the sole contract');
        }
        function visit(value)
        {
            if (!value || typeof value !== 'object')
            {
                return;
            }
            if (value.type === 'object' && value.additionalProperties !== false)
            {
                errors.push('conflict schema objects must remain closed');
            }
            for (const child of Object.values(value))
            {
                visit(child);
            }
        }
        visit(schema);
    }
    const code = new Map([...sources].filter(([relative]) => sourceFiles.includes(relative))
        .map(([relative, source]) => [relative, withoutComments(source)]));
    for (const [name, owner] of requiredOwners)
    {
        const declarations = [...code].flatMap(([relative, source]) =>
            [...source.matchAll(new RegExp(`\\bclass\\s+${name}\\b`, 'gu'))].map(() => relative));
        if (declarations.length !== 1 || declarations[0] !== owner)
        {
            errors.push(`exact-one conflict authority required: ${name} at ${owner}`);
        }
    }

    const contracts = code.get(contractsFile);
    const types = enumNames(contracts, 'VaultConflictType');
    if (JSON.stringify(types) !== JSON.stringify(expectedRegistry.map((entry) => entry[0])))
    {
        errors.push('conflict taxonomy must contain the exact twelve closed types in canonical order');
    }
    const actions = enumNames(contracts, 'VaultConflictAction');
    const expectedActions = [
        'PrepareSourceCandidate', 'PrepareMetadataCandidate', 'ProposeSourceReplacement',
        'ProposeMetadataReplacement', 'RequestRefactorPlan', 'RequestDeletionPlan', 'RefreshEvidence', 'CancelOperation'
    ];
    if (JSON.stringify(actions) !== JSON.stringify(expectedActions))
    {
        errors.push('resolution actions must remain closed per-item actions without generic winners');
    }
    if (JSON.stringify(enumNames(contracts, 'VaultConflictDisposition')) !== JSON.stringify(['Automatic', 'Manual', 'Rejected']))
    {
        errors.push('conflict dispositions must remain closed automatic/manual/rejected');
    }
    if (JSON.stringify(enumNames(contracts, 'VaultConflictMetadataField')) !== JSON.stringify(['Title', 'Summary', 'Slug', 'Taxonomy', 'Properties']))
    {
        errors.push('editable metadata must remain closed and exclude server authority fields');
    }

    const registry = code.get(registryFile);
    const entries = [...registry.matchAll(/Entry\(VaultConflictType\.(\w+), VaultConflictDisposition\.(\w+), "([^"]+)", VaultConflictFactKind\.(\w+), VaultConflictAuthorityBoundary\.(\w+), VaultConflictAction\.(\w+)\)/gu)]
        .map((match) => match.slice(1));
    if (JSON.stringify(entries) !== JSON.stringify(expectedRegistry))
    {
        errors.push('registry must bind exact-one entry per type with canonical disposition/owner/fact/action/authority');
    }
    if (!registry.includes('ImmutableArray<VaultConflictRegistryEntry>')
        || !registry.includes('ArticleVaultManifestCodec.SerializeCanonical')
        || !registry.includes('ArticleVaultConflictTests.Registry_PreservesAuthority({type})'))
    {
        errors.push('registry must be immutable, canonically content-addressed and bound to real proof-test cases');
    }

    for (const [relative, source] of code)
    {
        const prohibited = [
            [/\b(?:File|Directory|FileInfo|DirectoryInfo|FileSystemWatcher|FileStream|StreamReader|StreamWriter|HttpClient|Process)\s*\./u, 'direct filesystem/network/process operation'],
            [/\bnew\s+(?:(?:System\.IO\.|System\.Net\.Http\.|System\.Diagnostics\.)?)(?:FileInfo|DirectoryInfo|FileSystemWatcher|FileStream|StreamReader|StreamWriter|HttpClient|ProcessStartInfo|Repository)\s*\(/u, 'direct filesystem/Git/network/process construction'],
            [/\b(?:FileInfo|DirectoryInfo|FileSystemWatcher)\b/u, 'direct filesystem type/alias authority'],
            [/\bLibGit2Sharp\b/u, 'direct Git library authority'],
            [/\b(?:ArticleService|IArticleVaultCanonicalGroupWriter|Npgsql|DbContext|ExecuteSql|SaveChanges)\b/u, 'direct writer/database authority'],
            [/\b(?:Write|Delete|Create|Upload|ExecuteGroup|Execute)Async\s*\(/u, 'write/execution operation'],
            [/"git(?:\s|"\s*[,;)])/u, 'Git command or executable'],
            [/\b(?:Winner|Mtime|WinnerMtime|WinnerSize|LengthWinner|LongerContent|AiScore|AIScore|AiRecommendation|AcceptAllLocal|AcceptAllServer|LastWriteWins|TwoWayMerge)\b/iu, 'mtime/size/AI/two-way/global winner authority'],
            [/\b(?:Verified|IsVerified)\s*[,;)]/u, 'caller asserted verified flag']
        ];
        for (const [pattern, reason] of prohibited)
        {
            if (pattern.test(source))
            {
                errors.push(`${relative}: prohibited ${reason}`);
            }
        }
    }

    const verifier = code.get(verifierFile);
    const requiredGuards = [
        ['ArticleVaultSyncPlanVerifier.VerifyCurrent', 'current original planner verification'],
        ['binding.Coordinates.Base.Present', 'missing-base fail-closed boundary'],
        ['source_disposition_mismatch', 'source range/node overlap rejection'],
        ['metadata_disposition_mismatch', 'typed metadata overlap rejection'],
        ['current_facts_missing_or_duplicate', 'current-fact completeness/uniqueness'],
        ['current_facts_drift', 'current-fact drift'],
        ['automatic_authority_drift', 'automatic server authority boundary'],
        ['authority_fact_not_observed', 'actual coordinate authority fact recomputation'],
        ['CryptographicOperations.FixedTimeEquals', 'independent digest comparison'],
        ['independent_source_reader_missing', 'missing actual source reader admission denial'],
        ['independent_metadata_reader_missing', 'missing actual metadata reader admission denial'],
        ['identity_observer_missing', 'missing historic path reader denial'],
        ['git_observer_missing', 'missing actual Git reader denial']
    ];
    for (const [required, reason] of requiredGuards)
    {
        if (!verifier.includes(required))
        {
            errors.push(`conflict verifier must retain ${reason}`);
        }
    }
    const gate = /ValidateAutomaticEligibility\([^)]*\)\s*\{([\s\S]*?)\n {4}\}/u.exec(verifier);
    if (!gate || /\bArticleVaultValidationResult\.Valid\s*\(/u.test(gate[1]))
    {
        errors.push('source-only automatic eligibility gate cannot grant acceptance before independent reader integration');
    }
    return errors;
}

export function checkArticleVaultConflicts(root = repositoryRoot)
{
    return checkArticleVaultConflictSources(readArticleVaultConflictSources(root));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const errors = checkArticleVaultConflicts();
    if (errors.length > 0)
    {
        console.error(errors.join('\n'));
        process.exitCode = 1;
    }
    else
    {
        console.log('Article Vault conflict source governance passed (source-only; no runtime qualification).');
    }
}
