using Xunit;

namespace FsusBlog.Migration.Tests;

// These invoke the original Expand preflight and dry-run branch without a native
// client. They cannot grant execution, a rollback proof or provider qualification.
public sealed class OfflineMigrationExpandSafetyTests
{
    private const string MigrationId = "20261006-pre-expand-safety-probe";

    public static IEnumerable<object[]> DestructiveTypedSteps()
    {
        DestructiveMigrationProof proof = DestructiveMigrationProofs.For("20260418-post-content-cleanup");
        SchemaMigrationStep[] steps =
        [
            new DropColumnStep("article", "legacy_title", proof),
            new DropTableStep("article", proof),
            new DropIndexStep("article_title_idx"),
            new RenameColumnStep("article", "title", "heading"),
            new RenameTableStep("article", "article_old")
        ];
        foreach (SchemaMigrationStep step in steps)
        {
            yield return [step, false];
            yield return [step, true];
        }
    }

    public static IEnumerable<object[]> DestructiveSqlSteps()
    {
        string[] statements =
        [
            "ALTER TABLE article DROP COLUMN legacy_title;",
            "DROP TABLE article;",
            "DROP INDEX article_title_idx;",
            "ALTER TABLE article RENAME COLUMN title TO heading;",
            "ALTER TABLE article RENAME TO article_old;",
            "ALTER TABLE article ALTER title SET NOT NULL;",
            "ALTER TABLE article ALTER COLUMN title TYPE varchar(64);",
            "TRUNCATE article;",
            "DELETE FROM article WHERE id = 1;"
        ];
        foreach (string sql in statements)
        {
            foreach (SchemaMigrationStep step in new SchemaMigrationStep[]
                { new RawSqlStep(sql), new BackfillSqlStep(sql), new AssertSqlStep("original guard", sql) })
            {
                yield return [step, false];
                yield return [step, true];
            }
        }
    }

    [Theory]
    [MemberData(nameof(DestructiveTypedSteps))]
    public Task EveryOriginalDestructiveTypedStepRefusesBeforeDryRunOrExecution(SchemaMigrationStep step, bool dryRun)
        => RequireRefusalAsync(step, dryRun);

    [Theory]
    [MemberData(nameof(DestructiveSqlSteps))]
    public Task EachOriginalFullSqlTokenRefusesIndependentlyInEverySqlStep(SchemaMigrationStep step, bool dryRun)
        => RequireRefusalAsync(step, dryRun);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public Task WhitespaceAndCaseCannotHideAnOriginalDestructiveToken(bool dryRun)
        => RequireRefusalAsync(new RawSqlStep("aLtEr\tTABLE\narticle\r\nDROP\tCOLUMN\nlegacy_title;"), dryRun);

    [Fact]
    public Task AssertDescriptionRetainsTheOriginalFullFingerprintConservativeBoundary()
        => RequireRefusalAsync(new AssertSqlStep("refuse DROP TABLE article", "SELECT 1;"), true);

    [Fact]
    public async Task AdditiveStepsRetainTheirOriginalDryRunSelection()
    {
        ISchemaMigrationDescriptor descriptor = Descriptor(
        [
            new EnsureTableStep("new_article", "CREATE TABLE new_article (id integer PRIMARY KEY);"),
            new EnsureColumnStep("article", "note", "text NULL"),
            new CreateIndexStep("article_note_idx", "CREATE INDEX article_note_idx ON article (note);"),
            new RawSqlStep("ALTER TABLE article ADD COLUMN summary text NULL;"),
            new BackfillSqlStep("UPDATE article SET summary = title WHERE summary IS NULL;"),
            new AssertSqlStep("original guard", "SELECT COUNT(*) FROM article WHERE summary IS NULL;")
        ]);
        OfflineMigrationExecutionResult result = await ExecuteAsync([descriptor], Classifications(), [], true);
        Assert.Equal("dry_run", result.Status);
        Assert.Equal([MigrationId], result.MigrationIds);
        Assert.Empty(result.Codes);
    }

    [Fact]
    public async Task AppliedDestructiveWorkIsNotSelectedForExpand()
    {
        OfflineMigrationExecutionResult result = await ExecuteAsync(
            [Descriptor([new RawSqlStep("DROP TABLE article;")])], Classifications(), [MigrationId], true);
        Assert.Equal("dry_run", result.Status);
        Assert.Empty(result.MigrationIds);
        Assert.Empty(result.Codes);
    }

    [Fact]
    public async Task OriginalManifestPendingLegacyRetainsItsEarlyBootstrapRefusal()
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = SchemaMigrationManifest.Current.Descriptors;
        IReadOnlyDictionary<string, OfflineMigrationClassification> classifications = OfflineMigrationCatalogEntries.Classifications;
        string[] legacy = descriptors.Where(descriptor => classifications[descriptor.MigrationId].LegacyBootstrapOnly)
            .Select(descriptor => descriptor.MigrationId).ToArray();
        Assert.NotEmpty(legacy);
        string[] applied = descriptors.Select(descriptor => descriptor.MigrationId).Except(legacy).ToArray();
        OfflineMigrationExecutionResult result = await ExecuteAsync(descriptors, classifications, applied, true);
        Assert.Equal("failed", result.Status);
        Assert.Equal(legacy.Select(id => $"schema_legacy_bootstrap_required:{id}"), result.Codes);
        Assert.Empty(result.MigrationIds);
    }

    [Fact]
    public async Task OriginalManifestContractWorkCannotEnterExpandSelection()
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = SchemaMigrationManifest.Current.Descriptors;
        IReadOnlyDictionary<string, OfflineMigrationClassification> classifications = OfflineMigrationCatalogEntries.Classifications;
        string[] contract = descriptors.Where(descriptor => classifications[descriptor.MigrationId] is
        { Phase: OfflineMigrationPhase.Contract, LegacyBootstrapOnly: false })
            .Select(descriptor => descriptor.MigrationId).ToArray();
        Assert.NotEmpty(contract);
        string[] applied = descriptors.Select(descriptor => descriptor.MigrationId).Except(contract).ToArray();
        OfflineMigrationExecutionResult result = await ExecuteAsync(descriptors, classifications, applied, true);
        Assert.Equal("dry_run", result.Status);
        Assert.Empty(result.MigrationIds);
        Assert.Empty(result.Codes);
    }

    private static async Task RequireRefusalAsync(SchemaMigrationStep step, bool dryRun)
    {
        OfflineMigrationExecutionResult result = await ExecuteAsync([Descriptor([step])], Classifications(), [], dryRun);
        Assert.Equal("failed", result.Status);
        Assert.Equal(OfflineMigrationPhase.Expand, result.Phase);
        Assert.Empty(result.MigrationIds);
        Assert.Equal([$"schema_expand_destructive_operation:{MigrationId}"], result.Codes);
    }

    private static SchemaMigrationDescriptor Descriptor(IReadOnlyList<SchemaMigrationStep> steps)
        => new(MigrationId, "original Expand preflight source control", SchemaMigrationPhase.PreCodeFirst, true, steps);

    private static IReadOnlyDictionary<string, OfflineMigrationClassification> Classifications()
        => new Dictionary<string, OfflineMigrationClassification>(StringComparer.Ordinal)
        {
            [MigrationId] = new(MigrationId, OfflineMigrationPhase.Expand, null, false)
        };

    private static Task<OfflineMigrationExecutionResult> ExecuteAsync(
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors,
        IReadOnlyDictionary<string, OfflineMigrationClassification> classifications,
        IEnumerable<string> applied, bool dryRun)
        => OfflineMigrationExecutor.ExecuteExpandAsync(
            new(OfflineMigrationPhase.Expand, null, null, null, null, false, dryRun),
            descriptors, classifications, applied.ToHashSet(StringComparer.Ordinal), null!, "source-control", default);
}
