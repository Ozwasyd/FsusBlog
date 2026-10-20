using System.Security.Cryptography;
using System.Text;

using FsusBlog.Migration.Catalogs;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;

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
            catalog => Assert.Equal("current-20260720", catalog.CatalogId),
            catalog =>
            {
                Assert.Equal("current-20260724", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 7, 24), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 7, 24), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(ScheduledPublishIndexMigrationDefinitions.MigrationId, dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260725", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 7, 25), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 7, 25), catalog.EndVersion);
            },
            catalog =>
            {
                Assert.Equal("current-20260726", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 7, 26), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 7, 26), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(CustomizationMigrationDefinitions.MigrationId, dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260727", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 7, 27), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 7, 27), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(
                    DistributedInvalidationConvergenceObligationMigrationDefinitions.MigrationId,
                    dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260728", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 7, 28), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 7, 28), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(
                    DistributedInvalidationDeliveryLedgerMigrationDefinitions.MigrationId,
                    dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260809", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 8, 9), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 8, 9), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(
                    UserLocalePreferenceMigrationDefinitions.MigrationId,
                    dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260826", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 8, 26), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 8, 26), catalog.EndVersion);
            },
            catalog =>
            {
                Assert.Equal("current-20260828", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 8, 28), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 8, 28), catalog.EndVersion);
                Assert.Collection(
                    catalog.Dependencies,
                    dependency =>
                    {
                        Assert.Equal("20260720-pre-user-session-refresh-lineage", dependency.MigrationId);
                        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, dependency.Phase);
                    },
                    dependency =>
                    {
                        Assert.Equal(ContentAssetCutoverMigrationDefinitions.MigrationId, dependency.MigrationId);
                        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
                    });
            },
            catalog =>
            {
                Assert.Equal("current-20260829", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 8, 29), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 8, 29), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(AuthoringCanvasDocumentMigrationDefinitions.MigrationId, dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260904-authoring", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 9, 4), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 9, 4), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(TaxonomyDescriptionMigrationDefinitions.MigrationId, dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260905-article-templates", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 9, 5), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 9, 5), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(AuthorSavedViewMigrationDefinitions.MigrationId, dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260906-authoring-canvas-operations", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 9, 6), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 9, 6), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(ArticleTemplateAuthorityMigrationDefinitions.MigrationId, dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260907-article-vault-execution", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 9, 7), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 9, 7), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(AuthoringCanvasOperationJournalMigrationDefinitions.MigrationId, dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260908-article-create", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 9, 8), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 9, 8), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(ArticleVaultExecutionMigrationDefinitions.MigrationId, dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20260913-ban-state-projection", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 9, 13), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 9, 13), catalog.EndVersion);
                Assert.Contains(
                    catalog.Descriptors,
                    descriptor => descriptor.MigrationId == BanStateProjectionMigrationDefinitions.MigrationId);
                Assert.Contains(
                    catalog.Descriptors,
                    descriptor => descriptor.MigrationId == AdminSessionProjectionMigrationDefinitions.MigrationId);
                Assert.Equal(SchemaMigrationGapPolicy.AllowSparseVersions, catalog.GapPolicy);
                Assert.Collection(
                    catalog.Dependencies,
                    dependency =>
                    {
                        Assert.Equal(ContentAssetCutoverMigrationDefinitions.PrototypeShapeMigrationId, dependency.MigrationId);
                        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, dependency.Phase);
                    },
                    dependency =>
                    {
                        Assert.Equal(ArticleCreateAuthorityMigrationDefinitions.MigrationId, dependency.MigrationId);
                        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
                    });
                Assert.Collection(
                    catalog.Descriptors,
                    descriptor =>
                    {
                        Assert.Equal("20260913-pre-ban-state-generation", descriptor.MigrationId);
                        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, descriptor.Phase);
                        Assert.True(descriptor.Transactional);
                    },
                    descriptor =>
                    {
                        Assert.Equal("20260913-post-admin-session-validation-projection", descriptor.MigrationId);
                        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
                        Assert.True(descriptor.Transactional);
                    });
            },
            catalog =>
            {
                Assert.Equal("current-20260915-authoring", catalog.CatalogId);
                Assert.Equal(
                    new[] { ArticlePropertyDefinitionAuthorityMigrationDefinitions.MigrationId, AuthorRecentArticleHistoryMigrationDefinitions.MigrationId },
                    catalog.Descriptors.Select(static descriptor => descriptor.MigrationId));
                Assert.Equal(new DateOnly(2026, 9, 15), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 9, 15), catalog.EndVersion);
                SchemaMigrationCatalogDependency dependency = Assert.Single(catalog.Dependencies);
                Assert.Equal(AdminSessionProjectionMigrationDefinitions.MigrationId, dependency.MigrationId);
                Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase);
            },
            catalog =>
            {
                Assert.Equal("current-20261002-article-property-definition-command-history", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 10, 2), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 10, 2), catalog.EndVersion);
                Assert.Equal(
                    new[] { ArticlePropertyDefinitionAuthorityMigrationDefinitions.MigrationId, AuthorRecentArticleHistoryMigrationDefinitions.MigrationId },
                    catalog.Dependencies.Select(static dependency => dependency.MigrationId));
                Assert.All(catalog.Dependencies, dependency =>
                    Assert.Equal(SchemaMigrationPhase.PostCodeFirst, dependency.Phase));
            },
            catalog =>
            {
                Assert.Equal("current-20261018-article-source-generation", catalog.CatalogId);
                Assert.Equal(new DateOnly(2026, 10, 18), catalog.StartVersion);
                Assert.Equal(new DateOnly(2026, 10, 18), catalog.EndVersion);
                Assert.Equal(new[] { ArticleSourceGenerationMigrationDefinitions.MigrationId,
                    ArticleSourceReceiptOriginsMigrationDefinitions.MigrationId,
                    TaxonomyMutationReceiptMigrationDefinitions.MigrationId,
                    UserLocaleMutationReceiptMigrationDefinitions.MigrationId },
                    catalog.Descriptors.Select(static descriptor => descriptor.MigrationId));
                Assert.Equal(new[] { ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.MigrationId,
                    UserLocalePreferenceMigrationDefinitions.MigrationId },
                    catalog.Dependencies.Select(static dependency => dependency.MigrationId));
            });
        const string RecentHistoryMigrationId = "20260915-post-author-recent-history";
        Assert.Single(manifest.Descriptors, static descriptor =>
            descriptor.MigrationId == RecentHistoryMigrationId);
        ISchemaMigrationDescriptor[] preRecentDescriptors = manifest.Descriptors
            .Where(static descriptor => descriptor.MigrationId != RecentHistoryMigrationId
                && descriptor.MigrationId != ArticleSourceGenerationMigrationDefinitions.MigrationId
                && descriptor.MigrationId != TaxonomyMutationReceiptMigrationDefinitions.MigrationId
                && descriptor.MigrationId != UserLocaleMutationReceiptMigrationDefinitions.MigrationId
                && descriptor.MigrationId != ArticleSourceReceiptOriginsMigrationDefinitions.MigrationId
                && descriptor.MigrationId != ArticlePropertyDefinitionAuthorityMigrationDefinitions.MigrationId
                && descriptor.MigrationId != ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.MigrationId)
            .ToArray();
        Assert.Equal(145, preRecentDescriptors.Length);
        Assert.Equal(
            "D53AB234D57D3C847748434A7A64810A21D8DA44219CFA895360A96B918A4117",
            ComputePlanFingerprint(preRecentDescriptors));
        Assert.Equal(152, manifest.Descriptors.Count);
        const string ExpectedPlanFingerprint = "F2FBD2AF4569856A7435D044AAD13FABD6B32A5F68EF6DEA8C546E8B234E7F04";
        ISchemaMigrationDescriptor[] historicalDescriptors = manifest.Descriptors
            .Where(descriptor => descriptor.MigrationId != ArticlePropertyDefinitionAuthorityMigrationDefinitions.MigrationId
                && descriptor.MigrationId != ArticleSourceGenerationMigrationDefinitions.MigrationId
                && descriptor.MigrationId != TaxonomyMutationReceiptMigrationDefinitions.MigrationId
                && descriptor.MigrationId != UserLocaleMutationReceiptMigrationDefinitions.MigrationId
                && descriptor.MigrationId != ArticleSourceReceiptOriginsMigrationDefinitions.MigrationId
                && descriptor.MigrationId != ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.MigrationId)
            .ToArray();
        Assert.Equal(146, historicalDescriptors.Length);
        string actualPlanFingerprint = ComputePlanFingerprint(historicalDescriptors);
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
        Assert.Equal(152, first.Count);
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
