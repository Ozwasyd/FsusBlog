using System.Collections.Immutable;

using FsusBlog.Contracts.Migration;

using Npgsql;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Pure component controls only; these are not native staging/rollback or a
// complete known-legacy migration qualification.
public sealed class PgLegacyCurrentSchemaPreparationTests
{
    [Fact]
    public void EqualReorderedOriginalSourceFactsRemainTheSameSource()
    {
        OfflineMigrationSourceObservation source = Source();
        PgLegacyCurrentSchemaPreparation.RequireUnchangedSource(source, source with
        {
            Schema = source.Schema.Reverse().ToImmutableArray(),
            History = source.History.Reverse().ToImmutableArray(),
            BusinessShape = source.BusinessShape.Reverse().ToImmutableArray()
        });
    }

    [Theory]
    [InlineData("database")]
    [InlineData("extractor")]
    [InlineData("version")]
    [InlineData("content")]
    [InlineData("schema")]
    [InlineData("history")]
    [InlineData("business")]
    public void SourceOrBusinessDriftDoesNotAuthorizeStaging(string field)
    {
        OfflineMigrationSourceObservation source = Source();
        OfflineMigrationSourceObservation changed = field switch
        {
            "database" => source with { Database = source.Database with { DatabaseId = "2/other" } },
            "extractor" => source with { ExtractorId = "other" },
            "version" => source with { ExtractorVersion = "other" },
            "content" => source with { ContentDigest = new string('b', 64) },
            "schema" => source with { Schema = source.Schema.SetItem(0, source.Schema[0] with { Value = "changed" }) },
            "history" => source with { History = [new("history.state", "partial")] },
            "business" => source with { BusinessShape = source.BusinessShape.Add(new("unowned.business", "changed")) },
            _ => throw new InvalidOperationException()
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            PgLegacyCurrentSchemaPreparation.RequireUnchangedSource(source, changed));
        Assert.Equal("legacy_target_prepare_source_changed", error.Message);
    }

    [Fact]
    public void StageRequiresAnActualOpenOriginalNativeTransaction()
    {
        using var connection = new NpgsqlConnection();
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, null!));
        Assert.Equal("legacy_target_prepare_original_transaction_required", error.Message);
    }

    [Fact]
    public void JournalProjectionKeepsUnknownIndexesAndOtherUnsupportedObjects()
    {
        string sql = OfflineMigrationSourceObserver.ValidatedJournalUnsupportedSql();
        Assert.Contains("p.conrelid<>pg_catalog.to_regclass('public." + OfflineMigrationStateStore.ApplyJournalTableName + "')", sql, StringComparison.Ordinal);
        Assert.Contains("owned.conindid=i.indexrelid AND owned.contype='u'", sql, StringComparison.Ordinal);
        Assert.Contains("i.indisvalid AND i.indisready AND i.indislive", sql, StringComparison.Ordinal);
        Assert.Contains("i.indpred IS NULL AND i.indexprs IS NULL", sql, StringComparison.Ordinal);
        Assert.Contains("NOT t.tgisinternal", sql, StringComparison.Ordinal);
        Assert.Contains("pg_catalog.pg_policy", sql, StringComparison.Ordinal);
        Assert.Contains("pg_catalog.pg_namespace WHERE nspname !~", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("DROP ", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void JournalIsStillUnknownToThePublicOriginalSourceProfile()
    {
        ImmutableArray<OfflineMigrationFact> original = OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.PostgreSql, true);
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceFingerprints.RequireKnownSchema(
            CurrentSchemaProviderKind.PostgreSql, original.Add(new("table/" + OfflineMigrationStateStore.ApplyJournalTableName, "base"))));
    }

    private static OfflineMigrationSourceObservation Source()
        => new(new(CurrentSchemaProviderKind.PostgreSql, "1234", "1/original"),
            OfflineMigrationSourceFingerprints.ExtractorId, OfflineMigrationSourceFingerprints.ExtractorVersion,
            OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.PostgreSql, true),
            [new("history.state", "absent")], OfflineMigrationSourceFingerprints.Business(true, 0, 0, 0, 0), new string('a', 64));
}
