using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SchemaMigrationCatalogTests
{
    [Fact]
    public void CurrentManifest_UsesVersionedCatalogsAndStableExecutionPlan()
    {
        SchemaMigrationManifest manifest = SchemaMigrationManifest.Current;

        Assert.Collection(
            manifest.Catalogs,
            catalog => Assert.Equal("legacy-bootstrap-20260418-20260518", catalog.CatalogId),
            catalog => Assert.Equal("identity-security-20260602-20260621", catalog.CatalogId),
            catalog => Assert.Equal("projection-integrity-20260625-20260704", catalog.CatalogId),
            catalog => Assert.Equal("current-20260709-20260716", catalog.CatalogId),
            catalog => Assert.Equal("current-20260719", catalog.CatalogId),
            catalog => Assert.Equal("current-20260720", catalog.CatalogId));
        Assert.Equal(123, manifest.Descriptors.Count);
        const string ExpectedPlanFingerprint = "E3F914111004DEF7664B80A88ADE48ECA0EF2BDD127ECCD5E7FCC7E2C574A0E8";
        string actualPlanFingerprint = ComputePlanFingerprint(manifest.Descriptors);
        Assert.True(
            string.Equals(ExpectedPlanFingerprint, actualPlanFingerprint, StringComparison.Ordinal),
            $"Schema migration plan fingerprint changed: {actualPlanFingerprint}");

        for (int index = 1; index < manifest.Descriptors.Count; index++)
        {
            Assert.True(
                SchemaMigrationExecutionOrder.Instance.Compare(
                    manifest.Descriptors[index - 1],
                    manifest.Descriptors[index]) < 0);
        }
    }

    [Fact]
    public void Create_RecompositionIsIdempotent()
    {
        SchemaMigrationManifest current = SchemaMigrationManifest.Current;

        SchemaMigrationManifest first = SchemaMigrationManifest.Create(
            current.Catalogs,
            current.DeclaredVersionGaps);
        SchemaMigrationManifest second = SchemaMigrationManifest.Create(
            current.Catalogs,
            current.DeclaredVersionGaps);

        Assert.Equal(
            first.Descriptors.Select(DescribeDescriptor),
            second.Descriptors.Select(DescribeDescriptor));
        Assert.Equal(
            ComputePlanFingerprint(current.Descriptors),
            ComputePlanFingerprint(first.Descriptors));
    }

    [Fact]
    public void Create_RejectsDuplicateMigrationIds()
    {
        SchemaMigrationCatalog catalog = CreateCatalog(
            "duplicate",
            new DateOnly(2026, 1, 1),
            [
                CreateDescriptor("20260101-pre-duplicate", SchemaMigrationPhase.PreCodeFirst),
                CreateDescriptor("20260101-pre-duplicate", SchemaMigrationPhase.PreCodeFirst)
            ]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("Duplicate schema migration ids", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsUnstableCatalogOrder()
    {
        SchemaMigrationCatalog catalog = CreateCatalog(
            "unstable",
            new DateOnly(2026, 1, 1),
            [
                CreateDescriptor("20260101-pre-b", SchemaMigrationPhase.PreCodeFirst),
                CreateDescriptor("20260101-pre-a", SchemaMigrationPhase.PreCodeFirst)
            ]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("stable execution order", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsMissingMigrationDependency()
    {
        SchemaMigrationCatalog first = CreateCatalog(
            "first",
            new DateOnly(2026, 1, 1),
            [CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst)]);
        SchemaMigrationCatalog second = CreateCatalog(
            "second",
            new DateOnly(2026, 1, 2),
            [CreateDescriptor("20260102-pre-second", SchemaMigrationPhase.PreCodeFirst)],
            [new SchemaMigrationCatalogDependency("20260101-pre-missing", SchemaMigrationPhase.PreCodeFirst)]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([first, second], []));

        Assert.Contains("depends on missing migration", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsUndeclaredCatalogGap()
    {
        SchemaMigrationCatalog first = CreateCatalog(
            "first",
            new DateOnly(2026, 1, 1),
            [CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst)]);
        SchemaMigrationCatalog second = CreateCatalog(
            "second",
            new DateOnly(2026, 1, 3),
            [CreateDescriptor("20260103-pre-second", SchemaMigrationPhase.PreCodeFirst)],
            [new SchemaMigrationCatalogDependency("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst)]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([first, second], []));

        Assert.Contains("gaps do not match", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsMissingVersionFromContiguousCatalog()
    {
        var catalog = new SchemaMigrationCatalog(
            "contiguous",
            new DateOnly(2026, 1, 1),
            new DateOnly(2026, 1, 3),
            SchemaMigrationGapPolicy.ContiguousVersions,
            [],
            [
                CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst),
                CreateDescriptor("20260103-pre-third", SchemaMigrationPhase.PreCodeFirst)
            ]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("missing 20260102", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsDescriptorOutsideCatalogRange()
    {
        var catalog = new SchemaMigrationCatalog(
            "wrong-range",
            new DateOnly(2026, 1, 2),
            new DateOnly(2026, 1, 2),
            SchemaMigrationGapPolicy.AllowSparseVersions,
            [],
            [CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst)]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("falls outside catalog", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsMigrationIdPhaseMismatch()
    {
        SchemaMigrationCatalog catalog = CreateCatalog(
            "wrong-phase",
            new DateOnly(2026, 1, 1),
            [CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PostCodeFirst)]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("descriptor phase", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ConversationStatusAudit_IsAppendOnlyAndCarriesExactOutboxProjection()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == ConversationStatusAuditMigrationDefinitions.MigrationId);
        string migration = string.Join('\n', descriptor.Steps.Select(step => step.Fingerprint));

        Assert.Contains("msg_conversation_status_event", migration, StringComparison.Ordinal);
        Assert.Contains("previousstatus <> currentstatus", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("adminsessionauditreference", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("BEFORE UPDATE OR DELETE", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("append-only", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("message_mutation_outbox", migration, StringComparison.Ordinal);
        Assert.Contains("conversationstatus", migration, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void MessageUnreadAuthority_ConstrainsAndRepairsProjection()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == MessageUnreadAuthorityMigrationDefinitions.MigrationId);
        string migration = string.Join('\n', descriptor.Steps.Select(step => step.Fingerprint));

        Assert.Contains("ck_msg_participant_unread_nonnegative", migration, StringComparison.Ordinal);
        Assert.Contains("cannot move backwards", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("same conversation", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("isinternalnote = false", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("fsus.message_unread_repair", migration, StringComparison.Ordinal);
        Assert.Contains("msg_admin_queue_state", migration, StringComparison.Ordinal);
    }

    [Fact]
    public void UserSessionAuthenticationContext_IsRegisteredAndBackfillsLegacyRowsFailClosed()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == UserSessionAuthenticationContextMigrationDefinitions.MigrationId);
        string migration = string.Join('\n', descriptor.Steps.Select(step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, descriptor.Phase);
        Assert.Contains("authentication_method", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("authentication_strength", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("authenticated_at_utc", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("authenticated_credential_row_id", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("last_step_up_at_utc", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("last_step_up_method", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("duration_policy", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("legacy_verified", migration, StringComparison.Ordinal);
        Assert.Contains("legacy_unverified", migration, StringComparison.Ordinal);
        Assert.Contains("persistent_30d", migration, StringComparison.Ordinal);
        Assert.Contains("browser_session", migration, StringComparison.Ordinal);
        Assert.Contains("authentication_method SET NOT NULL", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("authentication_strength SET NOT NULL", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("authenticated_at_utc SET NOT NULL", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("duration_policy SET NOT NULL", migration, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void UserSessionModeAuthority_IsRegisteredAndBackfillsAuthoritativeModes()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == UserSessionModeMigrationDefinitions.MigrationId);
        string migration = string.Join('\n', descriptor.Steps.Select(step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains("session_mode", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("revokedat IS NOT NULL THEN 2", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("account.status = 1 THEN 1", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("integer NULL DEFAULT 0", migration, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void UserSessionMetadataMinimization_ScrubsRawValuesAndAddsPrivacySafeColumns()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == UserSessionMetadataMinimizationMigrationDefinitions.MigrationId);
        string migration = string.Join('\n', descriptor.Steps.Select(step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, descriptor.Phase);
        Assert.Contains("device_signal_hash", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("network_signal_hash", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("browser_family", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("os_family", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("form_factor", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SET devicefingerprint = NULL", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SET lastip = NULL", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SET useragent = NULL", migration, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void SourceLayout_PreventsLegacyRegistryDescriptorAggregation()
    {
        var registry = new SchemaMigrationRegistry();
        IReadOnlyList<ISchemaMigrationDescriptor> first = registry.GetDescriptors();
        IReadOnlyList<ISchemaMigrationDescriptor> second = registry.GetDescriptors();
        IReadOnlyList<ISchemaMigrationDescriptor> manifest = SchemaMigrationManifest.Current.Descriptors;

        Assert.Same(first, second);
        Assert.Same(manifest, first);
        Assert.Equal(123, first.Count);
        Assert.Equal(first.Count, first.Select(static descriptor => descriptor.MigrationId).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(
            ComputePlanFingerprint(manifest),
            ComputePlanFingerprint(first));
        Assert.All(first, static descriptor => Assert.IsType<SchemaMigrationDescriptor>(descriptor));
    }

    [Theory]
    [InlineData(nameof(User.IdentityKind), "anonymous_account")]
    [InlineData(nameof(User.AnonymousCredentialLevel), "basic")]
    [InlineData(nameof(User.AnonymousCredentialStatus), "active")]
    public void UserStringDefaults_UseUnquotedSqlSugarLiterals(
        string propertyName,
        string expectedDefault)
    {
        object attribute = typeof(User)
            .GetProperty(propertyName)!
            .GetCustomAttributes(inherit: false)
            .Single(static item => item.GetType().Name == "SugarColumn");
        string actualDefault = Assert.IsType<string>(
            attribute.GetType().GetProperty("DefaultValue")?.GetValue(attribute));

        Assert.Equal(expectedDefault, actualDefault);
        Assert.DoesNotContain("'", actualDefault, StringComparison.Ordinal);
    }

    private static SchemaMigrationCatalog CreateCatalog(
        string catalogId,
        DateOnly version,
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors,
        IReadOnlyList<SchemaMigrationCatalogDependency>? dependencies = null)
        => new(
            catalogId,
            version,
            version,
            SchemaMigrationGapPolicy.AllowSparseVersions,
            dependencies ?? [],
            descriptors);

    private static ISchemaMigrationDescriptor CreateDescriptor(
        string migrationId,
        SchemaMigrationPhase phase)
        => new SchemaMigrationDescriptor(
            migrationId,
            $"Fixture for {migrationId}.",
            phase,
            Transactional: true,
            Steps: []);

    private static string ComputePlanFingerprint(IReadOnlyList<ISchemaMigrationDescriptor> descriptors)
    {
        string plan = string.Join('\n', descriptors.Select(DescribeDescriptor));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(plan)));
    }

    private static string DescribeDescriptor(ISchemaMigrationDescriptor descriptor)
        => $"{descriptor.Phase}|{descriptor.MigrationId}|{descriptor.Checksum}";
}
