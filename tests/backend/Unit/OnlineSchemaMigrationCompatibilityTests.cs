using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;

using Microsoft.AspNetCore.Http;
namespace FsusBlog.Server.Tests.Unit;

public sealed class OnlineSchemaMigrationCompatibilityTests
{
    private static SchemaCompatibilityCoordinate Coordinate(string value)
        => SchemaCompatibilityCoordinate.ParsePersisted(value);

    private static ReleaseId Release(string value)
        => ReleaseId.Parse(value);

    [Fact]
    public void Expand_AllowsOldAndNewReleaseToReadAndWriteDuringDualReleaseWindow()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-dual-write-expand");
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");
        OnlineSchemaDatabaseSnapshot database = Database(
            "20260712-schema",
            new OnlineSchemaMigrationHistorySnapshot(
                descriptor.MigrationId,
                descriptor.Checksum,
                DateTimeOffset.Parse("2026-07-12T00:00:00Z"),
                "20260712000000-dddddddddddd",
                true));
        var release = new OnlineSchemaReleaseManifest(
            Release("20260720000000-aaaaaaaaaaaa"),
            Release("20260719000000-bbbbbbbbbbbb"),
            new OnlineSchemaCompatibilityWindow(Coordinate("20260701-schema"), Coordinate("20260731-schema")));

        OnlineSchemaCompatibilityReport report = OnlineSchemaCompatibilityEvaluator.Evaluate(
            release,
            database,
            [descriptor],
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [descriptor.MigrationId] = metadata
            });

        Assert.True(report.Ready);
        Assert.Null(report.PublicErrorCode);
    }

    [Fact]
    public void Readiness_ReturnsStable503CodeWhenSchemaReleaseIsOutsideManifest()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-range-expand");
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");
        OnlineSchemaDatabaseSnapshot database = Database(
            "20260801-schema",
            new OnlineSchemaMigrationHistorySnapshot(
                descriptor.MigrationId,
                descriptor.Checksum,
                DateTimeOffset.UtcNow,
                "20260712000000-dddddddddddd",
                true));

        OnlineSchemaCompatibilityReport report = OnlineSchemaCompatibilityEvaluator.Evaluate(
            new OnlineSchemaReleaseManifest(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new OnlineSchemaCompatibilityWindow(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            database,
            [descriptor],
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [descriptor.MigrationId] = metadata
            });

        Assert.False(report.Ready);
        Assert.Equal("schema_incompatible", report.PublicErrorCode);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, report.PublicStatusCode);
        Assert.Contains(report.Issues, issue => issue.Code == "schema_coordinate_outside_manifest");
        Assert.Equal("not_ready", Assert.IsType<string>(report.CreatePublicReport()["status"]));
    }

    [Fact]
    public void PendingBackfill_IsReadyOnlyAsWarningInsideCompatibilityWindow()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-post-resumable-backfill");
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Backfill,
            "20260701-release",
            "20260731-release") with
        {
            BatchSize = 100,
            ResumeTokenName = "last_id",
            RollbackMode = OnlineSchemaMigrationRollbackMode.ResumeFromCheckpoint
        };

        OnlineSchemaCompatibilityReport report = OnlineSchemaCompatibilityEvaluator.Evaluate(
            new OnlineSchemaReleaseManifest(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new OnlineSchemaCompatibilityWindow(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            Database("20260712-schema"),
            [descriptor],
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [descriptor.MigrationId] = metadata
            });

        Assert.True(report.Ready);
        OnlineSchemaCompatibilityIssue issue = Assert.Single(report.Issues);
        Assert.Equal("schema_backfill_pending", issue.Code);
        Assert.Equal(OnlineSchemaCompatibilitySeverity.Warning, issue.Severity);
    }

    [Fact]
    public void PendingExpand_BlocksReadinessWithoutRunningItOnServe()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-required-expand");
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");

        OnlineSchemaCompatibilityReport report = OnlineSchemaCompatibilityEvaluator.Evaluate(
            new OnlineSchemaReleaseManifest(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new OnlineSchemaCompatibilityWindow(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            Database("20260712-schema"),
            [descriptor],
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [descriptor.MigrationId] = metadata
            });

        Assert.False(report.Ready);
        Assert.Contains(report.Issues, issue => issue.Code == "schema_expand_pending");
    }

    [Fact]
    public void History_RejectsUnknownDuplicateAndChecksumMismatchEntriesTogether()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-history-expand");
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");
        OnlineSchemaMigrationHistorySnapshot mismatch = new(
            descriptor.MigrationId,
            "BAD-CHECKSUM",
            DateTimeOffset.UtcNow,
            "20260712000000-dddddddddddd",
            true);
        OnlineSchemaMigrationHistorySnapshot duplicate = mismatch with
        {
            MigrationId = "20260712-pre-duplicate"
        };
        OnlineSchemaMigrationHistorySnapshot duplicateAgain = duplicate with
        {
            AppliedAtUtc = DateTimeOffset.UtcNow.AddMinutes(1)
        };
        OnlineSchemaMigrationHistorySnapshot unknown = mismatch with
        {
            MigrationId = "20260712-pre-unknown"
        };
        var database = new OnlineSchemaDatabaseSnapshot(
            true,
            Coordinate("20260712-schema"),
            [mismatch, duplicate, duplicateAgain, unknown],
            new Dictionary<string, OnlineSchemaBackfillSnapshot>(StringComparer.Ordinal));

        OnlineSchemaCompatibilityReport report = OnlineSchemaCompatibilityEvaluator.Evaluate(
            new OnlineSchemaReleaseManifest(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new OnlineSchemaCompatibilityWindow(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            database,
            [descriptor],
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [descriptor.MigrationId] = metadata
            });

        Assert.Contains(report.Issues, issue => issue.Code == "schema_history_duplicate");
        Assert.Contains(report.Issues, issue => issue.Code == "schema_history_unknown");
        Assert.Contains(report.Issues, issue => issue.Code == "schema_history_checksum_mismatch");
    }

    [Fact]
    public void History_RejectsSchemaCoordinateForgedAsAppliedReleaseIdentity()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-pre-history-release-identity");
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Expand,
            "20260701-release",
            "20260731-release");
        OnlineSchemaDatabaseSnapshot database = Database(
            "20260720-schema",
            new OnlineSchemaMigrationHistorySnapshot(
                descriptor.MigrationId,
                descriptor.Checksum,
                DateTimeOffset.UtcNow,
                SchemaCompatibilityCoordinate.MinimumValue,
                true));

        OnlineSchemaCompatibilityReport report = OnlineSchemaCompatibilityEvaluator.Evaluate(
            new OnlineSchemaReleaseManifest(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260719000000-bbbbbbbbbbbb"),
                new OnlineSchemaCompatibilityWindow(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            database,
            [descriptor],
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [descriptor.MigrationId] = metadata
            });

        Assert.False(report.Ready);
        Assert.Contains(report.Issues, issue => issue.Code == "schema_history_release_id_invalid");
    }

    [Fact]
    public void AppliedContract_BlocksPreviousReleaseOutsideCompatibilityWindow()
    {
        ISchemaMigrationDescriptor descriptor = CreateDescriptor("20260712-post-gated-contract");
        OnlineSchemaMigrationMetadata metadata = CreateMetadata(
            descriptor.MigrationId,
            OnlineSchemaMigrationPhase.Contract,
            "20260720000000-aaaaaaaaaaaa",
            "20260731-release") with
        {
            ContractAfterCoordinate = Coordinate("20260719-contract-fence"),
            MinimumRetentionWindow = TimeSpan.FromDays(7)
        };
        OnlineSchemaDatabaseSnapshot database = Database(
            "20260720-schema",
            new OnlineSchemaMigrationHistorySnapshot(
                descriptor.MigrationId,
                descriptor.Checksum,
                DateTimeOffset.UtcNow,
                "20260720000000-aaaaaaaaaaaa",
                true));

        OnlineSchemaCompatibilityReport report = OnlineSchemaCompatibilityEvaluator.Evaluate(
            new OnlineSchemaReleaseManifest(
                Release("20260720000000-aaaaaaaaaaaa"),
                Release("20260718000000-eeeeeeeeeeee"),
                new OnlineSchemaCompatibilityWindow(Coordinate("20260701-schema"), Coordinate("20260731-schema"))),
            database,
            [descriptor],
            new Dictionary<string, OnlineSchemaMigrationMetadata>
            {
                [descriptor.MigrationId] = metadata
            });

        Assert.Contains(report.Issues, issue => issue.Code == "schema_contract_incompatible");
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

    private static OnlineSchemaMigrationMetadata CreateMetadata(
        string migrationId,
        OnlineSchemaMigrationPhase phase,
        string minimumCoordinate,
        string maximumCoordinate)
        => new(
            migrationId,
            phase,
            new OnlineSchemaCompatibilityWindow(Coordinate(minimumCoordinate), Coordinate(maximumCoordinate)),
            RequiresExclusiveMode: false,
            Destructive: false,
            RollbackMode: OnlineSchemaMigrationRollbackMode.CompatibleCode,
            EstimatedLockRisk: OnlineSchemaMigrationLockRisk.Low,
            BatchSize: null,
            ResumeTokenName: null,
            IntroducedAtCoordinate: Coordinate(minimumCoordinate),
            ContractAfterCoordinate: phase == OnlineSchemaMigrationPhase.Contract ? Coordinate(minimumCoordinate) : null,
            MinimumRetentionWindow: phase == OnlineSchemaMigrationPhase.Contract ? TimeSpan.FromDays(7) : TimeSpan.Zero,
            Validators: ["test-validator"]);

    private static OnlineSchemaDatabaseSnapshot Database(
        string schemaCompatibilityCoordinate,
        params OnlineSchemaMigrationHistorySnapshot[] history)
        => new(
            true,
            Coordinate(schemaCompatibilityCoordinate),
            history,
            new Dictionary<string, OnlineSchemaBackfillSnapshot>(StringComparer.Ordinal));
}
