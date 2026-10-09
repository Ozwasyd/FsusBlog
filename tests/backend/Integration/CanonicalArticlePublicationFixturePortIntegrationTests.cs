using FsusBlog.Migration.Definitions;
using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class CanonicalArticlePublicationFixturePortIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string TamperKey = "canonical-publication-integration-key-0123456789ab";
    private static readonly string s_digest = "sha256:" + new string('a', 64);
    private static readonly DateTime s_now = new(2026, 9, 14, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task PublishAsync_HappyPath_PersistsSealedCoordinatesAndPassesVerifier()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        CanonicalArticlePublicationRequest request = await CreateRequestAsync(db, semanticRole: "happy-path");

        CanonicalArticlePublicationResult result = await port.PublishAsync(request);
        Assert.False(result.IdempotencyReplay);
        Assert.True(result.Receipt.ArticleId > 0);
        Assert.True(result.Receipt.RevisionId > 0);
        Assert.True(result.Receipt.PublicationId > 0);
        Assert.Equal(1, result.Receipt.RevisionNo);
        Assert.Equal(1, result.Receipt.PublicationNo);
        Assert.False(result.Receipt.ContentCanonicalHash.Contains("recompute", StringComparison.OrdinalIgnoreCase));
        Assert.False(result.Receipt.PolicyHash.Contains("recompute", StringComparison.OrdinalIgnoreCase));

        CanonicalArticlePublicationVerificationResult verified =
            await CanonicalArticlePublicationVerifier.VerifyAsync(db, result.Receipt);
        Assert.True(verified.IsValid, string.Join(';', verified.Violations));

        Assert.Equal(1, await CountAsync(db, "article"));
        Assert.Equal(1, await CountAsync(db, "article_revision"));
        Assert.Equal(1, await CountAsync(db, "article_publication"));
        Assert.Equal(1, await CountAsync(db, "article_rights_snapshot"));
        Assert.Equal(1, await CountAsync(db, "article_responsibility_snapshot"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_command"));
        Assert.Equal(1, await CountAsync(db, "sys_audit_log"));
    }

    [Fact]
    public async Task PublishAsync_DuplicateRequest_ReplaysWithoutNewRevisionOrOutbox()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        CanonicalArticlePublicationRequest request = await CreateRequestAsync(db, semanticRole: "dup-role");

        CanonicalArticlePublicationResult first = await port.PublishAsync(request);
        CanonicalArticlePublicationResult second = await port.PublishAsync(request);

        Assert.False(first.IdempotencyReplay);
        Assert.True(second.IdempotencyReplay);
        Assert.Equal(first.Receipt.ArticleId, second.Receipt.ArticleId);
        Assert.Equal(first.Receipt.RevisionId, second.Receipt.RevisionId);
        Assert.Equal(first.Receipt.OutboxEventId, second.Receipt.OutboxEventId);
        Assert.Equal(first.Receipt.PublicationNo, second.Receipt.PublicationNo);
        Assert.Equal(1, await CountAsync(db, "article"));
        Assert.Equal(1, await CountAsync(db, "article_revision"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_command"));
    }

    [Fact]
    public async Task ProjectionInvocation_RereadsOriginalRequestAndRealPersistedTupleWithoutWrites()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationRequest request = await CreateRequestAsync(db, semanticRole: "projection-current");
        CanonicalArticlePublicationResult result = await CreatePort(db).PublishAsync(request);
        CanonicalArticleProjectionVerifier reader = CreateInvocationOnlyProjectionReader(db);

        // This is the production entry's exact current-invocation read predicate,
        // not a claim that derived workers, renderer or browser ran in this fixture.
        await reader.VerifyPublicationInvocationAsync(result.Receipt, request, CancellationToken.None);

        Assert.Equal(1, await CountAsync(db, "article"));
        Assert.Equal(1, await CountAsync(db, "article_revision"));
        Assert.Equal(1, await CountAsync(db, "article_publication"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_command"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(1, await CountAsync(db, "sys_audit_log"));
    }

    [Theory]
    [InlineData("receipt-only", "publication_current_run_binding_missing")]
    [InlineData("receipt-relabel", "publication_current_invocation_binding_mismatch")]
    [InlineData("invocation-relabel", "publication_current_invocation_command_not_exact")]
    [InlineData("plan-drift", "publication_current_invocation_command_mismatch")]
    [InlineData("rights-drift", "publication_canonical_reference_mismatch")]
    public async Task ProjectionInvocation_RejectsRelabelAndStaleReferencesAgainstRealRows(
        string scenario, string expectedViolation)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationRequest request = await CreateRequestAsync(db, semanticRole: "projection-negative");
        CanonicalArticlePublicationResult result = await CreatePort(db).PublishAsync(request);
        CanonicalArticleProjectionVerifier reader = CreateInvocationOnlyProjectionReader(db);
        await reader.VerifyPublicationInvocationAsync(result.Receipt, request, CancellationToken.None);

        CanonicalArticlePublicationReceipt receipt = result.Receipt;
        if (scenario == "receipt-relabel")
        {
            receipt = receipt with
            {
                RunId = "not-current-run",
                Namespace = "not-current-namespace"
            };
        }
        else if (scenario == "invocation-relabel")
        {
            request = request with
            {
                Binding = request.Binding with
                {
                    RunId = "not-current-run",
                    Namespace = "not-current-namespace"
                }
            };
            receipt = receipt with
            {
                RunId = request.Binding.RunId,
                Namespace = request.Binding.Namespace
            };
        }
        else if (scenario == "plan-drift")
        {
            request = request with
            {
                Plan = request.Plan with
                {
                    Title = "not-the-persisted-plan"
                }
            };
        }
        else if (scenario == "rights-drift")
        {
            receipt = receipt with
            {
                PolicyHash = "sha256:" + new string('f', 64)
            };
        }

        CanonicalArticleProjectionVerificationException error = await Assert.ThrowsAsync<
            CanonicalArticleProjectionVerificationException>(() => scenario == "receipt-only"
                ? reader.VerifyAsync(receipt)
                : reader.VerifyAsync(receipt, request));
        Assert.Contains(expectedViolation, error.Violations);
        Assert.Equal(1, await CountAsync(db, "article"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_command"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(1, await CountAsync(db, "sys_audit_log"));
    }

    [Fact]
    public async Task PublishAsync_CrossPlanSameRunRole_ConflictsWithoutExtraWrites()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        CanonicalArticlePublicationRequest first = await CreateRequestAsync(db, semanticRole: "conflict-role", title: "Title A");
        await port.PublishAsync(first);

        CanonicalArticlePublicationRequest changed = await CreateRequestAsync(
            db,
            semanticRole: "conflict-role",
            title: "Title B",
            content: "Different content body for conflict");

        await Assert.ThrowsAsync<ArticleMutationContentConflictException>(() => port.PublishAsync(changed));
        Assert.Equal(1, await CountAsync(db, "article"));
        Assert.Equal(1, await CountAsync(db, "article_revision"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_outbox"));
    }

    [Fact]
    public async Task PublishAsync_SameTitleDifferentRoles_DoesNotReuseArticle()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        const string SharedTitle = "Shared Title Never Reused";

        CanonicalArticlePublicationResult a = await port.PublishAsync(
            await CreateRequestAsync(db, semanticRole: "title-role-a", title: SharedTitle));
        CanonicalArticlePublicationResult b = await port.PublishAsync(
            await CreateRequestAsync(db, semanticRole: "title-role-b", title: SharedTitle));

        Assert.NotEqual(a.Receipt.ArticleId, b.Receipt.ArticleId);
        Assert.Equal(2, await CountAsync(db, "article"));
        Assert.Equal(2, await CountAsync(db, "article_revision"));
        Assert.Equal(2, await CountAsync(db,
            $"article WHERE title = '{SharedTitle.Replace("'", "''", StringComparison.Ordinal)}'"));
    }

    [Fact]
    public async Task PublishAsync_CrossRunAndAdmin_CreateDistinctAuthorityFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminA = await EnsureAdminAsync(db, handle: "admin-a", id: 11);
        long adminB = await EnsureAdminAsync(db, handle: "admin-b", id: 12);
        CanonicalArticlePublicationFixturePort port = CreatePort(db);

        CanonicalArticlePublicationResult runA = await port.PublishAsync(
            await CreateRequestAsync(db, adminPrincipalId: adminA, runId: "run-a", semanticRole: "shared-role"));
        CanonicalArticlePublicationResult runB = await port.PublishAsync(
            await CreateRequestAsync(db, adminPrincipalId: adminA, runId: "run-b", semanticRole: "shared-role"));
        CanonicalArticlePublicationResult adminOther = await port.PublishAsync(
            await CreateRequestAsync(db, adminPrincipalId: adminB, runId: "run-a", semanticRole: "shared-role"));

        Assert.NotEqual(runA.Receipt.ArticleId, runB.Receipt.ArticleId);
        Assert.NotEqual(runA.Receipt.ArticleId, adminOther.Receipt.ArticleId);
        Assert.Equal(3, await CountAsync(db, "article"));
        Assert.Equal(3, await CountAsync(db, "article_mutation_outbox"));
    }

    [Fact]
    public async Task PublishAsync_PartialWriteFailure_RollsBackAllAuthorityFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        InstallFailingAuditTrigger(db);
        CanonicalArticlePublicationFixturePort port = CreatePort(db);

        CanonicalArticlePublicationRequest request = await CreateRequestAsync(db, semanticRole: "rollback-role");
        await Assert.ThrowsAnyAsync<Exception>(() => port.PublishAsync(request));

        Assert.Equal(0, await CountAsync(db, "article"));
        Assert.Equal(0, await CountAsync(db, "article_body"));
        Assert.Equal(0, await CountAsync(db, "article_revision"));
        Assert.Equal(0, await CountAsync(db, "article_publication"));
        Assert.Equal(0, await CountAsync(db, "article_rights_policy"));
        Assert.Equal(0, await CountAsync(db, "article_rights_snapshot"));
        Assert.Equal(0, await CountAsync(db, "article_responsibility_snapshot"));
        Assert.Equal(0, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(0, await CountAsync(db, "article_mutation_command"));
        Assert.Equal(0, await CountAsync(db, "sys_audit_log"));
    }

    [Fact]
    public async Task Verifier_DetectsPointerMismatchAgainstRealRows()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        CanonicalArticlePublicationResult result = await port.PublishAsync(
            await CreateRequestAsync(db, semanticRole: "pointer-role"));

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET current_revision_id = current_revision_id + 1 WHERE id = @Id;",
            new SugarParameter("@Id", result.Receipt.ArticleId));

        CanonicalArticlePublicationVerificationResult verified =
            await CanonicalArticlePublicationVerifier.VerifyAsync(db, result.Receipt);
        Assert.False(verified.IsValid);
        Assert.Contains(verified.Violations, static v => v.Contains("pointer_current_revision_mismatch", StringComparison.Ordinal));
    }

    [Fact]
    public async Task OutboxPayload_RemainsSealedWhenLatestArticleStateDrifts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        CanonicalArticlePublicationResult result = await port.PublishAsync(
            await CreateRequestAsync(db, semanticRole: "outbox-drift", title: "Sealed Title"));

        ArticleMutationOutboxEvent outbox = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.EventId == result.Receipt.OutboxEventId)
            .FirstAsync();
        string sealedPayload = outbox.PayloadJson;

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET title = @Title WHERE id = @Id;",
            new SugarParameter("@Title", "Drifted Latest Title"),
            new SugarParameter("@Id", result.Receipt.ArticleId));

        ArticleMutationOutboxEvent afterDrift = await db.Queryable<ArticleMutationOutboxEvent>()
            .Where(item => item.EventId == result.Receipt.OutboxEventId)
            .FirstAsync();
        Assert.Equal(sealedPayload, afterDrift.PayloadJson);
        Assert.DoesNotContain("Drifted Latest Title", afterDrift.PayloadJson, StringComparison.Ordinal);
        Assert.Contains($"\"articleRevisionId\":{result.Receipt.RevisionId}", afterDrift.PayloadJson, StringComparison.Ordinal);
        Assert.Contains($"\"releaseId\":{result.Receipt.PublicationId}", afterDrift.PayloadJson, StringComparison.Ordinal);
        Assert.Equal(
            result.Receipt.OutboxPayloadDigest,
            CanonicalArticlePublicationFixturePort.ComputeOutboxPayloadDigest(afterDrift.PayloadJson));
    }

    [Fact]
    public async Task Verifier_DetectsReceiptDigestTamperAgainstPersistedFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        CanonicalArticlePublicationResult result = await port.PublishAsync(
            await CreateRequestAsync(db, semanticRole: "receipt-tamper"));

        CanonicalArticlePublicationReceipt tampered = result.Receipt with
        {
            ReceiptDigest = "sha256:" + new string('f', 64)
        };

        CanonicalArticlePublicationVerificationResult verified =
            await CanonicalArticlePublicationVerifier.VerifyAsync(db, tampered);
        Assert.False(verified.IsValid);
        Assert.Contains(verified.Violations, static v => v.Contains("receipt_digest_tamper_detected", StringComparison.Ordinal));
    }

    [Fact]
    public async Task PublishAsync_DoesNotWriteDerivedProjectionTables()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        // Optional derived tables may be absent in the minimal schema; create empty stubs when missing.
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE IF NOT EXISTS article_search_document (
                article_id int PRIMARY KEY,
                payload text NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS public_aot_artifact (
                article_id int PRIMARY KEY,
                payload text NOT NULL DEFAULT ''
            );
            """);
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        await port.PublishAsync(await CreateRequestAsync(db, semanticRole: "no-derived"));

        Assert.Equal(0, await CountAsync(db, "article_search_document"));
        Assert.Equal(0, await CountAsync(db, "public_aot_artifact"));
        Assert.Equal(1, await CountAsync(db, "article"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_outbox"));
    }

    [Fact]
    public async Task PublishAsync_MissingAdmin_FailsClosedWithZeroWrites()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        CanonicalArticlePublicationRequest request = await CreateRequestAsync(
            db,
            adminPrincipalId: 404,
            semanticRole: "missing-admin",
            ensureAdmin: false);

        CanonicalArticlePublicationValidationException ex =
            await Assert.ThrowsAsync<CanonicalArticlePublicationValidationException>(() => port.PublishAsync(request));
        Assert.Equal("active_admin_required", ex.Code);
        Assert.Equal(0, await CountAsync(db, "article"));
    }

    [Fact]
    public async Task PublishAsync_NullResponsibility_FailsClosed()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CanonicalArticlePublicationFixturePort port = CreatePort(db);
        long adminId = await EnsureAdminAsync(db);
        int categoryId = await EnsureCategoryAsync(db);
        var plan = new CanonicalArticlePublicationPlan(
            SemanticRole: "null-resp",
            Title: "Needs Responsibility",
            Content: "Body content for responsibility gate",
            Summary: "summary",
            CoverImageUrl: "https://example.com/cover.png",
            CategoryId: categoryId,
            TagIds: [],
            Rights: null,
            Responsibility: null);
        var request = new CanonicalArticlePublicationRequest(
            new CanonicalArticlePublicationFixtureBinding(
                "run-null-resp",
                "ns",
                "profile",
                ["article:publish"],
                adminId,
                s_digest,
                s_digest),
            plan);

        CanonicalArticlePublicationValidationException ex =
            await Assert.ThrowsAsync<CanonicalArticlePublicationValidationException>(() => port.PublishAsync(request));
        Assert.Equal("responsibility_required", ex.Code);
        Assert.Equal(0, await CountAsync(db, "article"));
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(AdminPrincipal),
            typeof(AuditLog),
            typeof(Article),
            typeof(ArticleBody),
            typeof(ArticleTag),
            typeof(ArticleRevision),
            typeof(ArticleRevisionContentBlock),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem),
            typeof(ArticlePublicationRecord),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleResponsibilitySnapshot),
            typeof(ArticleMutationOutboxEvent),
            typeof(ArticleMutationCommand),
            typeof(ArticleSourceGeneration),
            typeof(ArticleSourceSequence),
            typeof(ArticleSourceMutation));
        // InitTables may map Length=36 as uuid; production column is varchar(36).
        await db.Ado.ExecuteCommandAsync(
            """
            ALTER TABLE article_mutation_command
            ALTER COLUMN client_mutation_id TYPE varchar(36)
            USING client_mutation_id::text;
            """);
        await fixture.ExecuteAsync(db.CurrentConnectionConfig.ConnectionString,
            ArticleRelationSourceCoordinateMigrationDefinitions.Sql);
        return db;
    }

    private static CanonicalArticleProjectionVerifier CreateInvocationOnlyProjectionReader(SqlSugarClient db)
        // Deliberately unavailable output ports cannot supply manufactured output success.
        // These controls cover only real DB invocation/ref reads; the original seeder
        // supplies all real production ports for full publication projection acceptance.
        => new(db, searchIndex: null!, articles: null!, projectionStore: null!, artifactStore: null!,
            hotReadStore: null!, aotGenerationAuthority: null!, aotArtifactStore: null!,
            publicArtifactStorage: null!, httpContextAccessor: null!, revocationRegistry: null!,
            revocationState: null!, cacheReader: null!, runtimeKeyScope: null!, timeProvider: null!);

    private static CanonicalArticlePublicationFixturePort CreatePort(SqlSugarClient db)
    {
        IConfiguration config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Audit:TamperEvidenceKey"] = TamperKey
            })
            .Build();
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, "ok", string.Empty));
        var validator = new ArticlePublicationValidator(db, contentFilter);
        IArticlePublicMutationFence fence = Substitute.For<IArticlePublicMutationFence>();
        return new CanonicalArticlePublicationFixturePort(
            db,
            config,
            validator,
            fence,
            new FakeTimeProvider(s_now));
    }

    private static async Task<CanonicalArticlePublicationRequest> CreateRequestAsync(
        SqlSugarClient db,
        string semanticRole = "canonical-role",
        string title = "Canonical Title",
        string content = "Canonical markdown body content",
        string runId = "run-1",
        long? adminPrincipalId = null,
        bool ensureAdmin = true)
    {
        long adminId = adminPrincipalId
            ?? (ensureAdmin
                ? await EnsureAdminAsync(db).ConfigureAwait(false)
                : 1L);
        int categoryId = await EnsureCategoryAsync(db).ConfigureAwait(false);
        int tagId = await EnsureTagAsync(db).ConfigureAwait(false);

        var plan = new CanonicalArticlePublicationPlan(
            SemanticRole: semanticRole,
            Title: title,
            Content: content,
            Summary: "summary",
            CoverImageUrl: "https://example.com/cover.png",
            CategoryId: categoryId,
            TagIds: [tagId, tagId],
            Rights: null,
            Responsibility: ValidResponsibility());

        return new CanonicalArticlePublicationRequest(
            new CanonicalArticlePublicationFixtureBinding(
                RunId: runId,
                Namespace: "test-ns",
                ProfileId: "profile-canonical",
                Capabilities: ["article:publish", "article:write"],
                AdminPrincipalId: adminId,
                WriterContractDigest: s_digest,
                TemporalContextDigest: s_digest),
            plan);
    }

    private static ArticleResponsibilityDraft ValidResponsibility()
        => new(
            InheritSiteAuthor: true,
            Authors: [new ArticleResponsiblePerson("Fixture Author", null)],
            Reviewer: null,
            Sources: [],
            UpdateSummary: null,
            UpdateReason: null,
            EffectiveAt: null,
            ConclusionImpact: null,
            Methodology: null,
            Applicability: null,
            Limitations: null,
            ResponsiblePersonConfirmed: true,
            ContainsStrongClaims: false,
            IsSubstantiveUpdate: false,
            RequiresMethodsDisclosure: false,
            ExpectedVersion: 0);

    private static async Task<long> EnsureAdminAsync(SqlSugarClient db, string handle = "canonical-admin", long id = 9)
    {
        AdminPrincipal? existing = await db.Queryable<AdminPrincipal>()
            .Where(item => item.Id == id)
            .FirstAsync();
        if (existing is not null)
        {
            return existing.Id;
        }

        await db.Insertable(new AdminPrincipal
        {
            Handle = handle,
            DisplayName = handle,
            Status = AdminPrincipalStatus.Active,
            Permissions = "[]",
            CreatedAtUtc = s_now
        }).ExecuteCommandAsync();
        await db.Ado.ExecuteCommandAsync(
            "UPDATE admin_principal SET id = @Id WHERE handle = @Handle;",
            new SugarParameter("@Id", id),
            new SugarParameter("@Handle", handle));
        return id;
    }

    private static async Task<int> EnsureCategoryAsync(SqlSugarClient db)
    {
        Category? existing = await db.Queryable<Category>().FirstAsync();
        if (existing is not null)
        {
            return existing.Id;
        }

        return await db.Insertable(new Category { Name = "canonical-category" })
            .ExecuteReturnIdentityAsync();
    }

    private static async Task<int> EnsureTagAsync(SqlSugarClient db)
    {
        Tag? existing = await db.Queryable<Tag>().FirstAsync();
        if (existing is not null)
        {
            return existing.Id;
        }

        return await db.Insertable(new Tag { Name = "canonical-tag" })
            .ExecuteReturnIdentityAsync();
    }

    private static async Task<long> CountAsync(SqlSugarClient db, string tableOrPredicate)
    {
        if (tableOrPredicate.Contains(' ', StringComparison.Ordinal))
        {
            object? scalar = await db.Ado.GetScalarAsync($"SELECT COUNT(*) FROM {tableOrPredicate};");
            return Convert.ToInt64(scalar);
        }

        object? value = await db.Ado.GetScalarAsync($"SELECT COUNT(*) FROM {tableOrPredicate};");
        return Convert.ToInt64(value);
    }

    private static void InstallFailingAuditTrigger(SqlSugarClient db)
        => db.Ado.ExecuteCommand(
            """
            CREATE OR REPLACE FUNCTION fail_canonical_audit_insert()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                RAISE EXCEPTION 'canonical audit insert failure';
            END;
            $$;

            CREATE TRIGGER fail_canonical_audit_insert
            BEFORE INSERT ON sys_audit_log
            FOR EACH ROW
            EXECUTE FUNCTION fail_canonical_audit_insert();
            """);

    private sealed class FakeTimeProvider(DateTime utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(utcNow);
    }
}
