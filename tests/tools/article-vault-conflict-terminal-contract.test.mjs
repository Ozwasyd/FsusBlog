import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(readFileSync(path.join(root,
    'src/shared/Contracts/ArticleVault/article-vault-conflict-evidence.schema.json'), 'utf8'));
const taxonomy = schema.$defs.type.enum;
const directory = mkdtempSync(path.join(os.tmpdir(), 'article-vault-conflict-terminal-contract-'));
let actual;

// This compiles the real Shared project into a temporary, task-owned output root. The fixture
// supplies contract values, never substitute readers, writers, Git or recovery implementations.
const program = String.raw`
using System.Collections.Immutable;
using System.Text.Json;
using FsusBlog.Shared.Contracts.ArticleVault;

const string A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const string B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const string C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
var entries = ArticleVaultConflictRegistry.Entries;
var rows = new List<object>();
foreach (VaultConflictRegistryEntry entry in entries)
{
    int index = entries.IndexOf(entry);
    var found = ArticleVaultConflictRegistry.Find(entry.Type);
    var evidence = Evidence(entry);
    var item = evidence.Items[0];
    var empty = item.Observation with { Source = null, Metadata = null, Authority = null };
    var wrongDisposition = entry.Disposition == VaultConflictDisposition.Automatic
        ? VaultConflictDisposition.Manual : VaultConflictDisposition.Automatic;
    rows.Add(new
    {
        type = Wire(entry.Type.ToString()), disposition = Wire(entry.Disposition.ToString()),
        actions = entry.AllowedActions.Select(action => Wire(action.ToString())).ToArray(),
        positive = found == entry && ArticleVaultConflictRegistry.Validate(entries).IsValid,
        negative = Result(ArticleVaultConflictRegistry.Validate(entries.RemoveAt(index))),
        authority = Result(ArticleVaultConflictRegistry.Validate(entries.SetItem(index,
            entry with { AuthorityBoundary = (VaultConflictAuthorityBoundary)999 }))),
        structure = Result(ArticleVaultConflictVerifier.ValidateStructure(evidence)),
        missingFacts = Result(ArticleVaultConflictVerifier.ValidateStructure(Seal(evidence with
            { Items = [item with { Observation = empty }] }))),
        authorityBypass = Result(ArticleVaultConflictVerifier.ValidateStructure(Seal(evidence with
            { Items = [item with { Disposition = wrongDisposition }] }))),
        eligibility = Result(ArticleVaultConflictVerifier.ValidateAutomaticEligibility(evidence))
    });
}
Console.WriteLine(JsonSerializer.Serialize(new
{
    qualification = "prerequisite-contract-only",
    rows,
    unknownTypeRejected = ArticleVaultConflictRegistry.Find((VaultConflictType)999) is null,
    defaultRegistryRejected = !ArticleVaultConflictRegistry.Validate(default).IsValid
}));

string Wire(string value) => JsonNamingPolicy.KebabCaseLower.ConvertName(value);
object Result(ArticleVaultValidationResult value) => new { valid = value.IsValid, reason = value.ReasonCode };
VaultArticleCoordinate Coordinate(VaultArticleCoordinate value) => value with
    { ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(value) };
ArticleVaultConflictEvidence Seal(ArticleVaultConflictEvidence value) => value with
    { ContentSha256 = ArticleVaultConflictCodec.ComputeContentSha256(value) };
VaultPathProjection Projection(string value) => new(value, ArticleVaultManifestCodec.ComputeProjectionSha256(value));

ArticleVaultConflictEvidence Evidence(VaultConflictRegistryEntry entry)
{
    var baseline = Coordinate(new(ArticleVaultSchemas.Coordinate, 1, true, false, 4,
        new(A, 100, false, VaultNewlineStyle.Lf, 0, true), A, A, "draft", A, ""));
    var local = Coordinate(baseline with { Source = baseline.Source! with { Sha256 = B }, MetadataManifestSha256 = B });
    var server = Coordinate(baseline with { Source = baseline.Source! with { Sha256 = C }, MetadataManifestSha256 = C, ServerRevision = 5 });
    switch (entry.Type)
    {
        case VaultConflictType.DeleteVsEdit:
            local = Coordinate(local with { Deleted = true, Source = null });
            break;
        case VaultConflictType.LifecycleConflict:
            server = Coordinate(server with { Lifecycle = "published" });
            break;
        case VaultConflictType.PermissionConflict:
            server = Coordinate(server with { PermissionSha256 = C });
            break;
        case VaultConflictType.DependencyConflict:
            server = Coordinate(server with { DependencySha256 = C });
            break;
        case VaultConflictType.SchemaConflict:
            // The current coordinate seal accepts only V1, so schema-version drift fails earlier.
            server = Coordinate(server with { SchemaVersion = 2 });
            break;
    }
    var coordinates = new VaultArticleCoordinates(baseline, local, server);
    VaultConflictObservation observation;
    switch (entry.RequiredFact)
    {
        case VaultConflictFactKind.SourceChanges:
            observation = new(entry.Type, new("unadmitted-fixture-parser", 1, A, B,
                [new(0, 10, "base-node-local")],
                entry.Type == VaultConflictType.SourceOverlap
                    ? [new(20, 30, "base-node-local")] : [new(20, 30, "base-node-server")]), null, null);
            break;
        case VaultConflictFactKind.MetadataChanges:
            ImmutableArray<VaultConflictMetadataChange> changes = entry.Type == VaultConflictType.MetadataOverlap
                ? [new(VaultConflictMetadataField.Title, null, A, B, C)]
                : [new(VaultConflictMetadataField.Title, null, A, B, A), new(VaultConflictMetadataField.Summary, null, A, A, C)];
            observation = new(entry.Type, null, new(A, changes), null);
            break;
        case VaultConflictFactKind.IdentityProjection:
            observation = new(entry.Type, null, null, new(entry.RequiredFact,
                baseline.ContentSha256, local.ContentSha256, server.ContentSha256,
                new(Projection("articles/base.md"), Projection("articles/renamed.md"), Projection("articles/base.md")), null));
            break;
        case VaultConflictFactKind.GitMarkers:
            observation = new(entry.Type, null, null, new(entry.RequiredFact,
                baseline.ContentSha256, local.ContentSha256, server.ContentSha256, null,
                new("worktree-fixture", A, B, [new(0, 7, "marker-node")])));
            break;
        case VaultConflictFactKind.Deletion:
        case VaultConflictFactKind.Creation:
        case VaultConflictFactKind.Lifecycle:
        case VaultConflictFactKind.Permission:
        case VaultConflictFactKind.Schema:
        case VaultConflictFactKind.Dependency:
            observation = new(entry.Type, null, null, new(entry.RequiredFact,
                baseline.ContentSha256, local.ContentSha256, server.ContentSha256, null, null));
            break;
        default:
            throw new InvalidDataException("terminal_fixture_missing_for_new_fact_kind");
    }
    var binding = new VaultConflictBinding("site-fixture", "vault-fixture", "device-fixture", "article-fixture",
        "server-fixture", "plan-fixture", A, "group-fixture", "operation-fixture", A, B, coordinates);
    return Seal(new(ArticleVaultConflictSchemas.Evidence, 1, ArticleVaultConflictRegistry.ContentSha256,
        binding, [new(entry.Type, entry.Disposition, entry.AllowedActions, observation)], ""));
}
`;

before(async () =>
{
    const shared = path.join(root, 'src/shared/FsusBlog.Shared.csproj')
        .replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    writeFileSync(path.join(directory, 'ContractFixture.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><LangVersion>14.0</LangVersion><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
    <ItemGroup><ProjectReference Include="${shared}" /></ItemGroup>
</Project>\n`);
    writeFileSync(path.join(directory, 'Program.cs'), program);
    const { stdout } = await promisify(execFile)(process.env.DOTNET_HOST_PATH || 'dotnet',
        ['run', '--project', path.join(directory, 'ContractFixture.csproj'), '--verbosity', 'quiet',
            '--no-launch-profile', '--disable-build-servers'],
        {
            cwd: directory, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1',
                DOTNET_CLI_HOME: path.join(directory, 'cli-home'), MSBUILDDISABLENODEREUSE: '1',
                FSUSBLOG_PRODUCTION_BUILD_ROOT: path.join(directory, 'compiled') }
        });
    const lines = stdout.trim().split(/\r?\n/u);
    actual = JSON.parse(lines.at(-1));
});

after(() => rmSync(directory, { recursive: true, force: true }));

test('compiled immutable registry and schema enumerate the same closed taxonomy and dispositions', () =>
{
    assert.equal(actual.qualification, 'prerequisite-contract-only');
    assert.deepEqual(actual.rows.map(row => row.type), taxonomy);
    assert.deepEqual([...new Set(actual.rows.map(row => row.disposition))].sort(),
        [...schema.$defs.disposition.enum].sort());
    assert.equal(actual.unknownTypeRejected, true);
    assert.equal(actual.defaultRegistryRejected, true);
});

const unavailableStructure = new Map([
    ['rename-vs-edit', 'article_vault_conflict_identity_observer_missing'],
    ['create-create', 'article_vault_conflict_authority_fact_not_observed'],
    ['schema-conflict', 'article_vault_conflict_coordinate_invalid'],
    ['git-marker-present', 'article_vault_conflict_git_observer_missing']
]);

for (const type of taxonomy)
{
    test(`${type}: exact-one positive, negative and authority registry fixture through compiled owner`, () =>
    {
        const rows = actual.rows.filter(row => row.type === type);
        assert.equal(rows.length, 1);
        const [row] = rows;
        assert.equal(row.positive, true);
        assert.deepEqual(row.negative, { valid: false, reason: 'article_vault_conflict_registry_incomplete' });
        assert.deepEqual(row.authority, { valid: false, reason: 'article_vault_conflict_registry_drift' });
        assert.equal(row.actions.length, 2);
        assert.equal(row.actions[1], 'cancel-operation');
        assert.equal(new Set(row.actions).size, row.actions.length);
        assert.ok(row.actions.every(action => schema.$defs.action.enum.includes(action)));
    });

    test(`${type}: actual verifier preserves structure checks and unavailable reader failures`, () =>
    {
        const row = actual.rows.find(entry => entry.type === type);
        const reason = unavailableStructure.get(type);
        assert.deepEqual(row.structure, reason ? { valid: false, reason } : { valid: true, reason: null });
        assert.equal(row.missingFacts.valid, false);
        assert.equal(row.missingFacts.reason, type === 'schema-conflict'
            ? 'article_vault_conflict_coordinate_invalid'
            : type.startsWith('source-') ? 'article_vault_conflict_source_facts_missing'
                : type.startsWith('metadata-') ? 'article_vault_conflict_metadata_facts_missing'
                    : 'article_vault_conflict_authority_facts_missing');
        assert.equal(row.authorityBypass.valid, false);
        if (type !== 'schema-conflict')
        {
            assert.equal(row.authorityBypass.reason, 'article_vault_conflict_authority_or_action_drift');
        }
        assert.equal(row.eligibility.valid, false);
        if (type === 'source-disjoint')
        {
            assert.equal(row.eligibility.reason, 'article_vault_conflict_independent_source_reader_missing');
        }
        if (type === 'metadata-disjoint')
        {
            assert.equal(row.eligibility.reason, 'article_vault_conflict_independent_metadata_reader_missing');
        }
        if (!['source-disjoint', 'metadata-disjoint'].includes(type))
        {
            assert.equal(row.eligibility.reason, reason ?? 'article_vault_conflict_automatic_disposition_unavailable');
        }
    });
}
