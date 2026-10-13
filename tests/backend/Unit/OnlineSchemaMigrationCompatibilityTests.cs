using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Migration;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OnlineSchemaMigrationCompatibilityTests
{
    private static HistoricalMigrationFence Coordinate(string value)
    {
        if (value.Length > 14 && value[14] == '-')
        {
            ReleaseId recorded = ReleaseId.Parse(value);
            return HistoricalMigrationFence.FromRecordedValue(recorded.Value, recorded.Value);
        }
        return HistoricalMigrationFence.FromLegacyMetadata(value);
    }

    private static ReleaseId Release(string value)
        => ReleaseId.Parse(value);

    [Fact]
    public void Expand_AllowsOldAndNewReleaseToReadAndWriteDuringDualReleaseWindow()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-dual-write-expand");
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            descriptor.MigrationId,
            OfflineMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");
        RecordedDatabase database = Database(
            "20260712-schema",
            new RecordedHistory(
                descriptor.MigrationId,
                descriptor.Checksum,
                DateTimeOffset.Parse("2026-07-12T00:00:00Z"),
                "20260712000000-dddddddddddd",
                true));
        var release = new RecordedRelease(
            Release("20260720000000-aaaaaaaaaaaa"),
            Release("20260719000000-bbbbbbbbbbbb"),
            new RecordedBounds(Coordinate("20260701-schema"), Coordinate("20260731-schema")));

        AssertHistoricalIntentRejected(
            release,
            database,
            new Dictionary<string, OfflineMigrationClassificationFact>
            {
                [descriptor.MigrationId] = metadata
            });
    }

    [Fact]
    public void Readiness_ReturnsStable503CodeWhenSchemaReleaseIsOutsideManifest()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-range-expand");
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            descriptor.MigrationId,
            OfflineMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");
        RecordedDatabase database = Database(
            "20260801-schema",
            new RecordedHistory(
                descriptor.MigrationId,
                descriptor.Checksum,
                DateTimeOffset.UtcNow,
                "20260712000000-dddddddddddd",
                true));

        AssertHistoricalIntentRejected(
            new RecordedRelease(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new RecordedBounds(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            database,
            new Dictionary<string, OfflineMigrationClassificationFact>
            {
                [descriptor.MigrationId] = metadata
            });
    }

    [Fact]
    public void PendingBackfill_IsReadyOnlyAsWarningInsideCompatibilityWindow()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-post-resumable-backfill");
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            descriptor.MigrationId,
            OfflineMigrationPhase.Backfill,
            "20260701-release",
            "20260731-release") with
        {
            BatchSize = 100,
            ResumeTokenName = "last_id",
            RollbackMode = OfflineMigrationHistoricalRollbackMode.ResumeFromCheckpoint
        };

        AssertHistoricalIntentRejected(
            new RecordedRelease(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new RecordedBounds(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            Database("20260712-schema"),
            new Dictionary<string, OfflineMigrationClassificationFact>
            {
                [descriptor.MigrationId] = metadata
            });
    }

    [Fact]
    public void PendingExpand_BlocksReadinessWithoutRunningItOnServe()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-required-expand");
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            descriptor.MigrationId,
            OfflineMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");

        AssertHistoricalIntentRejected(
            new RecordedRelease(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new RecordedBounds(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            Database("20260712-schema"),
            new Dictionary<string, OfflineMigrationClassificationFact>
            {
                [descriptor.MigrationId] = metadata
            });
    }

    [Fact]
    public void History_RejectsUnknownDuplicateAndChecksumMismatchEntriesTogether()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-history-expand");
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            descriptor.MigrationId,
            OfflineMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");
        RecordedHistory mismatch = new(
            descriptor.MigrationId,
            "BAD-CHECKSUM",
            DateTimeOffset.UtcNow,
            "20260712000000-dddddddddddd",
            true);
        RecordedHistory duplicate = mismatch with
        {
            MigrationId = "20260712-pre-duplicate"
        };
        RecordedHistory duplicateAgain = duplicate with
        {
            AppliedAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        RecordedHistory unknown = mismatch with
        {
            MigrationId = "20260712-pre-unknown"
        };
        var database = new RecordedDatabase(
            true,
            Coordinate("20260712-schema"),
            [mismatch, duplicate, duplicateAgain, unknown],
            new Dictionary<string, object>(StringComparer.Ordinal));

        AssertHistoricalIntentRejected(
            new RecordedRelease(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new RecordedBounds(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            database,
            new Dictionary<string, OfflineMigrationClassificationFact>
            {
                [descriptor.MigrationId] = metadata
            });
    }

    [Fact]
    public void History_RejectsSchemaCoordinateForgedAsAppliedReleaseIdentity()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-history-release-identity");
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            descriptor.MigrationId,
            OfflineMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");
        RecordedDatabase database = Database(
            "20260720-schema",
            new RecordedHistory(
                descriptor.MigrationId,
                descriptor.Checksum,
                DateTimeOffset.UtcNow,
                HistoricalMigrationFence.MinimumValue,
                true));

        AssertHistoricalIntentRejected(
            new RecordedRelease(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new RecordedBounds(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            database,
            new Dictionary<string, OfflineMigrationClassificationFact>
            {
                [descriptor.MigrationId] = metadata
            });
    }

    [Fact]
    public void AppliedContract_BlocksPreviousReleaseOutsideCompatibilityWindow()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-post-gated-contract");
        OfflineMigrationClassificationFact metadata = CreateMetadata(
            descriptor.MigrationId,
            OfflineMigrationPhase.Contract,
            "20260720000000-aaaaaaaaaaaa",
            "20260731-release") with
        {
            ContractAfterFence = Coordinate("20260719-contract-fence"),
            MinimumRetentionWindow = TimeSpan.FromDays(7)
        };
        RecordedDatabase database = Database(
            "20260720-schema",
            new RecordedHistory(
                descriptor.MigrationId,
                descriptor.Checksum,
                DateTimeOffset.UtcNow,
                "20260720000000-aaaaaaaaaaaa",
                true));

        AssertHistoricalIntentRejected(
            new RecordedRelease(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260718000000-eeeeeeeeeeee"),
                new RecordedBounds(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            database,
            new Dictionary<string, OfflineMigrationClassificationFact>
            {
                [descriptor.MigrationId] = metadata
            });
    }

    private static ISchemaMigrationDescriptor CreateDescriptor(string migrationId)
        => new SchemaMigrationDescriptor(
            migrationId,
            "online migration test descriptor",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article", "online_test_column", "bigint NULL")
            ]);

    private static OfflineMigrationClassificationFact CreateMetadata(
        string migrationId,
        OfflineMigrationPhase phase,
        string minimumCoordinate,
        string maximumCoordinate)
        => new(
            migrationId,
            phase,
            Coordinate(minimumCoordinate),
            Coordinate(maximumCoordinate),
            RequiresExclusiveMode: false,
            Destructive: false,
            RollbackMode: OfflineMigrationHistoricalRollbackMode.CompatibleCode,
            EstimatedLockRisk: OfflineMigrationHistoricalLockRisk.Low,
            BatchSize: null,
            ResumeTokenName: null,
            IntroducedAtFence: Coordinate(minimumCoordinate),
            ContractAfterFence: phase == OfflineMigrationPhase.Contract ? Coordinate(minimumCoordinate) : null,
            MinimumRetentionWindow: phase == OfflineMigrationPhase.Contract ? TimeSpan.FromDays(7) : TimeSpan.Zero,
            Validators: ["test-validator"]);

    private static RecordedDatabase Database(
        string schemaCompatibilityCoordinate,
        params RecordedHistory[] history)
        => new(
            true,
            Coordinate(schemaCompatibilityCoordinate),
            history,
            new Dictionary<string, object>(StringComparer.Ordinal));

    // Historical test data only, not a window evaluator or deployment parser.
    private sealed record RecordedBounds(HistoricalMigrationFence Minimum, HistoricalMigrationFence Maximum);
    private sealed record RecordedRelease(ReleaseId Current, ReleaseId Previous, RecordedBounds Bounds);
    private sealed record RecordedHistory(string MigrationId, string Checksum, DateTimeOffset AppliedAtUtc, string AppliedByRelease, bool Success);
    private sealed record RecordedDatabase(bool HistoryAvailable, HistoricalMigrationFence Coordinate, RecordedHistory[] History, Dictionary<string, object> Backfills);

    private static void AssertHistoricalIntentRejected(object release, object database, object classifications)
        => AssertHistoricalBytesRejected(JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = "fsusblog.release-manifest.v2",
            release,
            database,
            classifications
        }));

    internal static void AssertHistoricalBytesRejected(byte[] historicalBytes)
    {
        // A current component positive precedes refusal, not an issued receipt
        // or an actual database observation.
        CurrentSchemaReceipt current = StructurallyValidCurrentFixture();
        byte[] positive = CurrentSchemaReceiptCodec.Serialize(current);
        var observation = new CurrentSchemaAdmissionObservation(current.Target, current.Database, current.ActualSchemaDigest);
        string positiveSha = Convert.ToHexStringLower(SHA256.HashData(positive));
        Assert.Equal(current.ContentDigest, CurrentSchemaReceiptAdmission.Validate(positive, positiveSha, observation).ContentDigest);
        string historicalSha = Convert.ToHexStringLower(SHA256.HashData(historicalBytes));
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaReceiptAdmission.Validate(historicalBytes, historicalSha, observation));
        Assert.Equal("current_receipt_json_invalid", error.Message);
    }

    private static CurrentSchemaReceipt StructurallyValidCurrentFixture()
    {
        string digest = new('a', 64);
        var receipt = new CurrentSchemaReceipt(
            CurrentSchemaReceiptCodec.Format, CurrentSchemaReceiptStatus.VerifiedCurrent,
            new("model.v1", "extractor.v1", "generator.v1", digest, digest),
            "empty.v1", "fingerprint.v1", digest, digest,
            new("offline-plan/v1/plan", digest), new("offline-apply/v1/apply", digest),
            [new("offline-checkpoint/v1/checkpoint", digest)],
            new(CurrentSchemaProviderKind.PostgreSql, "instance-1", "database-1"), digest,
            [new("bootstrap", "predicate/current/v1", digest, digest, digest)],
            new("backup/package", digest), new("backup/manifest", digest), new("backup/restore-drill", digest),
            [], new(new string('b', 40), digest, digest, digest), [], string.Empty);
        return receipt with { ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(receipt) };
    }
}
