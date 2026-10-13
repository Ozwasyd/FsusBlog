import assert from 'node:assert/strict';
import test from 'node:test';

const {
    checkArticleVaultConflicts,
    checkArticleVaultConflictSources,
    readArticleVaultConflictSources
} = await import(new URL('../../tools/governance/check-article-vault-conflicts.mjs', import.meta.url));

const contractsFile = 'src/shared/Contracts/ArticleVault/ArticleVaultConflictContracts.cs';
const registryFile = 'src/shared/Contracts/ArticleVault/ArticleVaultConflictRegistry.cs';
const verifierFile = 'src/shared/Contracts/ArticleVault/ArticleVaultConflictVerifier.cs';

function diagnostics(relative, mutate)
{
    const sources = readArticleVaultConflictSources();
    sources.set(relative, mutate(sources.get(relative)));
    return checkArticleVaultConflictSources(sources).join('\n');
}

test('three canonical conflict owners retain exact twelve types and source-only qualification limits', () =>
{
    assert.deepEqual(checkArticleVaultConflicts(), []);
});

test('unknown, removed and duplicate types or wildcard authority cannot enter the registry', () =>
{
    assert.match(diagnostics(contractsFile, (source) => source.replace('    GitMarkerPresent\n', '    GitMarkerPresent,\n    Unknown\n')), /exact twelve/u);
    assert.match(diagnostics(contractsFile, (source) => source.replace('    SourceOverlap,\n', '')), /exact twelve/u);
    assert.match(diagnostics(registryFile, (source) => source.replace('VaultConflictType.SourceOverlap,', 'VaultConflictType.SourceDisjoint,')), /exact-one entry/u);
    assert.match(diagnostics(registryFile, (source) => source.replace('"issue-2117"', '"*"')), /canonical disposition\/owner/u);
});

test('lifecycle automatic action or metadata authority field drift is rejected', () =>
{
    assert.match(diagnostics(registryFile, (source) => source.replace('VaultConflictType.LifecycleConflict, VaultConflictDisposition.Rejected', 'VaultConflictType.LifecycleConflict, VaultConflictDisposition.Automatic')), /canonical disposition/u);
    assert.match(diagnostics(registryFile, (source) => source.replace('VaultConflictAuthorityBoundary.ServerPermission, VaultConflictAction.RefreshEvidence', 'VaultConflictAuthorityBoundary.ServerPermission, VaultConflictAction.ProposeMetadataReplacement')), /canonical disposition/u);
    assert.match(diagnostics(contractsFile, (source) => source.replace('    Properties\n', '    Properties,\n    Publication\n')), /exclude server authority fields/u);
    assert.match(diagnostics(contractsFile, (source) => source.replace('    CancelOperation\n', '    CancelOperation,\n    AcceptAllLocal\n')), /closed per-item/u);
});

test('direct filesystem, Git, network and writer code fails the conflict-only ownership boundary', () =>
{
    const injected = [
        ['File.WriteAllText(path, content);', /filesystem/u],
        ['new FileInfo(path);', /filesystem/u],
        ['using WatcherAlias = System.IO.FileSystemWatcher; new WatcherAlias();', /filesystem/u],
        ['new DirectoryInfo(path);', /filesystem/u],
        ['new FileSystemWatcher(path);', /filesystem/u],
        ['new System.IO.FileInfo(path);', /filesystem/u],
        ['new System.IO.DirectoryInfo(path);', /filesystem/u],
        ['new System.IO.FileSystemWatcher(path);', /filesystem/u],
        ['new LibGit2Sharp.Repository(path);', /Git/u],
        ['LibGit2Sharp.Commands.Checkout(repository, branch);', /Git/u],
        ['Directory.Delete(path);', /filesystem/u],
        ['new ProcessStartInfo("git");', /Git/u],
        ['new HttpClient();', /network/u],
        ['ArticleService.UpdateAsync(command);', /writer/u],
        ['context.SaveChanges();', /database/u],
        ['writer.ExecuteGroupAsync(bundle);', /write\/execution/u]
    ];
    for (const [source, expected] of injected)
    {
        assert.match(diagnostics(verifierFile, (original) => `${original}\n${source}\n`), expected);
    }
});

test('mtime, size, AI, two-way, generic winner and caller verification shortcuts are denied', () =>
{
    for (const member of ['WinnerMtime', 'WinnerSize', 'LongerContent', 'AiScore', 'LastWriteWins', 'TwoWayMerge', 'AcceptAllServer', 'Winner'])
    {
        assert.match(diagnostics(contractsFile, (source) => `${source}\npublic bool ${member};\n`), /winner authority/u);
    }
    assert.match(diagnostics(contractsFile, (source) => `${source}\npublic bool Verified;\n`), /verified flag/u);
});

test('missing original-plan, overlap, current-fact, digest and actual-reader gates are detected', () =>
{
    const missing = [
        'ArticleVaultSyncPlanVerifier.VerifyCurrent', 'binding.Coordinates.Base.Present',
        'source_disposition_mismatch', 'metadata_disposition_mismatch', 'current_facts_drift',
        'automatic_authority_drift', 'authority_fact_not_observed', 'CryptographicOperations.FixedTimeEquals',
        'independent_source_reader_missing', 'independent_metadata_reader_missing', 'identity_observer_missing', 'git_observer_missing'
    ];
    for (const guard of missing)
    {
        assert.match(diagnostics(verifierFile, (source) => source.replaceAll(guard, 'RemovedGuard')), /must retain/u);
    }
});

test('source-only eligibility cannot become green through a valid-result fallback', () =>
{
    assert.match(diagnostics(verifierFile, (source) => source.replace('return Invalid("automatic_disposition_unavailable");', 'return ArticleVaultValidationResult.Valid();')), /cannot grant acceptance/u);
});

test('duplicate conflict owners and missing canonical files are rejected', () =>
{
    const duplicate = readArticleVaultConflictSources();
    duplicate.set(verifierFile, `${duplicate.get(verifierFile)}\npublic class ArticleVaultConflictRegistry {}\n`);
    assert.match(checkArticleVaultConflictSources(duplicate).join('\n'), /exact-one conflict authority/u);
    duplicate.delete(contractsFile);
    assert.match(checkArticleVaultConflictSources(duplicate).join('\n'), /missing canonical conflict owner/u);
});

test('schema opening, type/version drift and missing bound identity cannot change the contract', () =>
{
    const file = 'src/shared/Contracts/ArticleVault/article-vault-conflict-evidence.schema.json';
    for (const mutate of [
        (schema) =>
        {
            schema.additionalProperties = true;
        },
        (schema) =>
        {
            schema.$defs.binding.additionalProperties = true;
        },
        (schema) =>
        {
            schema.properties.schemaVersion.const = 2;
        },
        (schema) =>
        {
            schema.$defs.type.enum.push('generic-winner');
        },
        (schema) =>
        {
            schema.required = schema.required.filter((field) => field !== 'binding');
        }
    ])
    {
        assert.match(diagnostics(file, (source) =>
        {
            const schema = JSON.parse(source);
            mutate(schema);
            return JSON.stringify(schema);
        }), /schema/u);
    }
    assert.match(diagnostics(file, () => '{'), /valid closed JSON/u);
});
