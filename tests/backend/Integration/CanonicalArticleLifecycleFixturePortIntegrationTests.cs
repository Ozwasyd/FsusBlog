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
public sealed class CanonicalArticleLifecycleFixturePortIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string TamperKey = "canonical-lifecycle-integration-key-0123456789ab";
    private static readonly DateTime s_now = new(2026, 9, 15, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task ExecuteAsync_ScheduledUpdatePreservesPublicBoundaryAtCurrentBusinessClock()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        const string Variant = CanonicalArticleLifecycleVariants.PublishedScheduledUpdate;
        CanonicalArticleLifecycleResult result = await CreatePort(db).ExecuteAsync(
            new CanonicalArticleLifecycleRequest(
                Binding(adminId, Variant), Plan(Variant, categoryId, tagId, s_now.AddMinutes(1))));
        Article row = await db.Queryable<Article>()
            .Where(item => item.Id == result.Receipt.ArticleId).FirstAsync();
        CanonicalArticleLifecycleOperationReceipt scheduled = Assert.Single(
            result.Receipt.Operations, operation => operation.Operation == "scheduled-update");
        bool publiclyVisible = ArticlePublication.IsPubliclyVisible(row, s_now);
        Assert.True(
            row.CurrentPublicationId == scheduled.BeforePublicationId && publiclyVisible,
            $"businessClock={s_now:O}; due={scheduled.ScheduledPublishAt:O}; "
            + $"oldPublication={scheduled.BeforePublicationId}; currentPublication={row.CurrentPublicationId}; "
            + $"publishedAt={row.PublishedAt:O}; publiclyVisible={publiclyVisible}; "
            + $"authorityVerified={result.Verification.IsValid}");
    }

    [Fact]
    public async Task ExecuteAsync_AllLifecycleVariants_PersistImmutableTimelineAndVerify()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        string[] variants =
        [
            CanonicalArticleLifecycleVariants.Draft,
            CanonicalArticleLifecycleVariants.Scheduled,
            CanonicalArticleLifecycleVariants.Published,
            CanonicalArticleLifecycleVariants.PublishedScheduledUpdate,
            CanonicalArticleLifecycleVariants.Archived,
            CanonicalArticleLifecycleVariants.Deleted,
            CanonicalArticleLifecycleVariants.Restore,
            CanonicalArticleLifecycleVariants.Rollback,
            CanonicalArticleLifecycleVariants.MultipleRevisions,
            CanonicalArticleLifecycleVariants.MultiplePublications
        ];
        foreach (string variant in variants)
        {
            var clock = new MutableTimeProvider(s_now);
            CanonicalArticleLifecycleFixturePort port = CreatePort(db, clock);
            DateTime? scheduledAt = variant is CanonicalArticleLifecycleVariants.Scheduled
                or CanonicalArticleLifecycleVariants.PublishedScheduledUpdate
                ? s_now.AddMinutes(1)
                : null;
            CanonicalArticleLifecycleResult result = await port.ExecuteAsync(
                new CanonicalArticleLifecycleRequest(
                    Binding(adminId, variant),
                    Plan(variant, categoryId, tagId, scheduledAt)));

            Assert.True(result.Verification.IsValid, string.Join(';', result.Verification.Violations));
            Assert.Equal(variant, result.Receipt.Variant);
            Assert.NotEmpty(result.Receipt.Operations);
            Assert.NotEmpty(result.Receipt.RevisionIds);
            Assert.All(
                result.Receipt.Operations,
                operation =>
                {
                    Assert.True(operation.AfterRevisionId > 0);
                    Assert.True(operation.RightsSnapshotId > 0);
                    Assert.True(operation.ResponsibilitySnapshotId > 0);
                    Assert.NotEqual(operation.OutboxEventId, operation.AuditRecordHash);
                });
            if (variant == CanonicalArticleLifecycleVariants.Restore)
            {
                Assert.True(result.Receipt.RevisionIds.Count >= 2);
                Assert.True(result.Receipt.PublicationIds.Count >= 2);
            }
            if (variant == CanonicalArticleLifecycleVariants.Rollback)
            {
                Assert.True(result.Receipt.RevisionIds.Count >= 3);
                Assert.True(result.Receipt.PublicationIds.Count >= 2);
            }
            if (variant == CanonicalArticleLifecycleVariants.PublishedScheduledUpdate)
            {
                CanonicalArticleLifecycleOperationReceipt scheduled = Assert.Single(
                    result.Receipt.Operations,
                    operation => operation.Operation == "scheduled-update");
                Assert.Equal(scheduled.BeforePublicationId, scheduled.AfterPublicationId);
                Assert.True(scheduled.TransitionedAtUtc < scheduled.ScheduledPublishAt);
                Assert.DoesNotContain(result.Receipt.Operations, operation => operation.Operation == "scheduled-publish");
            }
            if (scheduledAt.HasValue)
            {
                clock.Now = scheduledAt.Value;
                result = await port.PublishScheduledAsync(Binding(adminId, variant), result.Receipt);
                CanonicalArticleLifecycleOperationReceipt published = Assert.Single(
                    result.Receipt.Operations,
                    operation => operation.Operation == "scheduled-publish");
                Assert.NotEqual(published.BeforePublicationId, published.AfterPublicationId);
                Assert.True(published.TransitionedAtUtc >= published.ScheduledPublishAt);
                Assert.True(result.Verification.IsValid, string.Join(';', result.Verification.Violations));
            }
        }
    }

    [Theory]
    [InlineData(CanonicalArticleLifecycleVariants.Scheduled, 0)]
    [InlineData(CanonicalArticleLifecycleVariants.Scheduled, 1)]
    [InlineData(CanonicalArticleLifecycleVariants.PublishedScheduledUpdate, 0)]
    [InlineData(CanonicalArticleLifecycleVariants.PublishedScheduledUpdate, 1)]
    public async Task PublishScheduledAsync_UsesBusinessClockAndPreservesImmutableOldPublication(string variant, int delayMilliseconds)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        var clock = new MutableTimeProvider(s_now);
        DateTime dueAt = s_now.AddMinutes(1);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db, clock);
        CanonicalArticleLifecycleFixtureBinding binding = Binding(adminId, variant);
        CanonicalArticleLifecycleResult pending = await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(binding, Plan(variant, categoryId, tagId, dueAt)));
        ArticlePublicationRecord? oldPublication = await db.Queryable<ArticlePublicationRecord>()
            .Where(item => item.Id == pending.Receipt.CurrentPublicationId).FirstAsync();
        string oldPublicationBytes = System.Text.Json.JsonSerializer.Serialize(oldPublication);
        long oldAuditCount = await CountAsync(db, "sys_audit_log");
        long oldOutboxCount = await CountAsync(db, "article_mutation_outbox");
        clock.Now = dueAt.AddMilliseconds(-1);
        CanonicalArticleLifecycleValidationException early = await Assert.ThrowsAsync<CanonicalArticleLifecycleValidationException>(
            () => port.PublishScheduledAsync(binding, pending.Receipt));
        Assert.Equal("scheduled_publication_not_due", early.Code);
        Article before = await db.Queryable<Article>().Where(item => item.Id == pending.Receipt.ArticleId).FirstAsync();
        Assert.Equal(pending.Receipt.CurrentPublicationId, before.CurrentPublicationId);
        Assert.Equal(variant == CanonicalArticleLifecycleVariants.PublishedScheduledUpdate,
            ArticlePublication.IsPubliclyVisible(before, clock.Now));
        Assert.Equal(oldAuditCount, await CountAsync(db, "sys_audit_log"));
        Assert.Equal(oldOutboxCount, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(pending.Receipt.PublicationIds.Count, await CountAsync(db, "article_publication"));

        clock.Now = dueAt.AddMilliseconds(delayMilliseconds);
        CanonicalArticleLifecycleResult published = await port.PublishScheduledAsync(binding, pending.Receipt);
        Assert.True(published.Verification.IsValid, string.Join(';', published.Verification.Violations));
        Assert.Equal(pending.Receipt.RevisionIds, published.Receipt.RevisionIds);
        Assert.Equal(pending.Receipt.PublicationIds.Count + 1, published.Receipt.PublicationIds.Count);
        Assert.NotEqual(pending.Receipt.CurrentPublicationId, published.Receipt.CurrentPublicationId);
        Assert.Equal(pending.Receipt.Operations, published.Receipt.Operations.Take(pending.Receipt.Operations.Count));
        Assert.Equal(clock.Now, published.Receipt.Operations[^1].TransitionedAtUtc);
        Assert.Equal(oldAuditCount + 1, await CountAsync(db, "sys_audit_log"));
        Assert.Equal(oldOutboxCount + 1, await CountAsync(db, "article_mutation_outbox"));
        Article after = await db.Queryable<Article>().Where(item => item.Id == published.Receipt.ArticleId).FirstAsync();
        Assert.True(ArticlePublication.IsPubliclyVisible(after, clock.Now));
        Assert.Null(after.PendingPublicationAt);
        Assert.Null(after.ScheduledPublishAt);
        if (oldPublication is not null)
        {
            ArticlePublicationRecord reloadedOld = await db.Queryable<ArticlePublicationRecord>()
                .Where(item => item.Id == oldPublication.Id).FirstAsync();
            Assert.Equal(oldPublicationBytes, System.Text.Json.JsonSerializer.Serialize(reloadedOld));
        }
        // The verifier must use the observer's clock, not trust a future time supplied in the receipt.
        CanonicalArticleLifecycleVerificationResult premature = await CanonicalArticleLifecycleVerifier.VerifyAsync(
            db, Configuration(), published.Receipt, timeProvider: new FixedTimeProvider(dueAt.AddMilliseconds(-1)));
        Assert.False(premature.IsValid);
        Assert.Contains(premature.Violations, item => item.StartsWith("operation_ahead_of_business_clock:", StringComparison.Ordinal));
        await Assert.ThrowsAsync<InvalidOperationException>(() => port.PublishScheduledAsync(binding, pending.Receipt));
        Assert.Equal(oldAuditCount + 1, await CountAsync(db, "sys_audit_log"));
        Assert.Equal(oldOutboxCount + 1, await CountAsync(db, "article_mutation_outbox"));
    }

    [Theory]
    [InlineData("binding")]
    [InlineData("resealed-binding")]
    [InlineData("capability")]
    [InlineData("revision")]
    [InlineData("schedule")]
    [InlineData("permission")]
    public async Task PublishScheduledAsync_RejectsSourceDriftWithoutPartialFacts(string drift)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        var clock = new MutableTimeProvider(s_now);
        DateTime dueAt = s_now.AddMinutes(1);
        const string Variant = CanonicalArticleLifecycleVariants.PublishedScheduledUpdate;
        CanonicalArticleLifecycleFixturePort port = CreatePort(db, clock);
        CanonicalArticleLifecycleFixtureBinding binding = Binding(adminId, Variant);
        CanonicalArticleLifecycleReceipt receipt = (await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(binding, Plan(Variant, categoryId, tagId, dueAt)))).Receipt;
        clock.Now = dueAt;
        if (drift == "binding")
        {
            binding = binding with
            {
                TemporalContextDigest = "sha256:" + new string('c', 64)
            };
        }
        else if (drift == "resealed-binding")
        {
            binding = binding with
            {
                RunId = "another-run"
            };
            receipt = Seal(receipt with
            {
                RunId = binding.RunId
            });
        }
        else if (drift == "capability")
        {
            binding = binding with
            {
                Capabilities = ["article.write", "unrelated-capability"]
            };
        }
        else if (drift == "revision")
        {
            receipt = Seal(receipt with
            {
                CurrentRevisionId = receipt.CurrentRevisionId + 1
            });
        }
        else if (drift == "schedule")
        {
            receipt = Seal(receipt with
            {
                Operations = receipt.Operations.Select(operation => operation.Operation == "scheduled-update"
                    ? operation with
                    {
                        ScheduledPublishAt = dueAt.AddMilliseconds(-1)
                    } : operation).ToArray()
            });
        }
        else
        {
            await db.Updateable<AdminPrincipal>().SetColumns(item => item.Permissions == string.Empty)
                .Where(item => item.Id == adminId).ExecuteCommandAsync();
        }
        long audits = await CountAsync(db, "sys_audit_log");
        long outbox = await CountAsync(db, "article_mutation_outbox");
        long revisions = await CountAsync(db, "article_revision");
        long publications = await CountAsync(db, "article_publication");
        if (drift == "permission")
        {
            ArticleWriteValidationException error = await Assert.ThrowsAsync<ArticleWriteValidationException>(
                () => port.PublishScheduledAsync(binding, receipt));
            Assert.Equal("article_write_permission_required", error.Code);
        }
        else
        {
            CanonicalArticleLifecycleValidationException error = await Assert.ThrowsAsync<CanonicalArticleLifecycleValidationException>(
                () => port.PublishScheduledAsync(binding, receipt));
            Assert.Equal(drift == "binding" ? "scheduled_receipt_binding_mismatch" : "scheduled_origin_receipt_mismatch", error.Code);
        }
        Assert.Equal(audits, await CountAsync(db, "sys_audit_log"));
        Assert.Equal(outbox, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(revisions, await CountAsync(db, "article_revision"));
        Assert.Equal(publications, await CountAsync(db, "article_publication"));
    }

    [Fact]
    public async Task ExecuteAsync_BusinessClockRegressesDuringWrite_RollsBackAllAuthorityFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db, new RegressingTimeProvider());
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => port.ExecuteAsync(new CanonicalArticleLifecycleRequest(
                Binding(adminId, CanonicalArticleLifecycleVariants.PublishedScheduledUpdate),
                Plan(CanonicalArticleLifecycleVariants.PublishedScheduledUpdate, categoryId, tagId, s_now.AddMinutes(1)))));
        Assert.Contains("operation_ahead_of_business_clock", error.Message, StringComparison.Ordinal);
        Assert.Equal(0, await CountAsync(db, "article"));
        Assert.Equal(0, await CountAsync(db, "article_revision"));
        Assert.Equal(0, await CountAsync(db, "article_publication"));
        Assert.Equal(0, await CountAsync(db, "article_mutation_command"));
        Assert.Equal(0, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(0, await CountAsync(db, "sys_audit_log"));
    }

    [Fact]
    public async Task PublishScheduledAsync_BusinessClockRegressesDuringWrite_RollsBackDueFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        const string Variant = CanonicalArticleLifecycleVariants.PublishedScheduledUpdate;
        CanonicalArticleLifecycleFixtureBinding binding = Binding(adminId, Variant);
        DateTime dueAt = s_now.AddMinutes(1);
        CanonicalArticleLifecycleReceipt pending = (await CreatePort(db).ExecuteAsync(
            new CanonicalArticleLifecycleRequest(binding, Plan(Variant, categoryId, tagId, dueAt)))).Receipt;
        long audits = await CountAsync(db, "sys_audit_log");
        long outbox = await CountAsync(db, "article_mutation_outbox");
        CanonicalArticleLifecycleFixturePort port = CreatePort(db, new RegressingTimeProvider(dueAt, 3));
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => port.PublishScheduledAsync(binding, pending));
        Assert.Contains("operation_ahead_of_business_clock", error.Message, StringComparison.Ordinal);
        Assert.Equal(pending.RevisionIds.Count, await CountAsync(db, "article_revision"));
        Assert.Equal(pending.PublicationIds.Count, await CountAsync(db, "article_publication"));
        Assert.Equal(outbox, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(audits, await CountAsync(db, "sys_audit_log"));
        Article row = await db.Queryable<Article>().Where(item => item.Id == pending.ArticleId).FirstAsync();
        Assert.Equal(pending.CurrentPublicationId, row.CurrentPublicationId);
        Assert.Equal(dueAt, row.PendingPublicationAt);
    }

    [Fact]
    public async Task ExecuteAsync_DuplicateRequest_ReplaysReceiptWithoutNewFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);
        var request = new CanonicalArticleLifecycleRequest(
            Binding(adminId, "idempotent"),
            Plan(CanonicalArticleLifecycleVariants.MultiplePublications, categoryId, tagId),
            Guid.Parse("99b5724c-3a5c-4d90-92e1-c283052eadf8"));

        CanonicalArticleLifecycleResult first = await port.ExecuteAsync(request);
        long articles = await CountAsync(db, "article");
        long revisions = await CountAsync(db, "article_revision");
        long publications = await CountAsync(db, "article_publication");
        long outbox = await CountAsync(db, "article_mutation_outbox");
        long commands = await CountAsync(db, "article_mutation_command");
        long audits = await CountAsync(db, "sys_audit_log");

        CanonicalArticleLifecycleResult replay = await port.ExecuteAsync(request);

        Assert.False(first.IdempotencyReplay);
        Assert.True(replay.IdempotencyReplay);
        Assert.Equal(first.Receipt.ReceiptDigest, replay.Receipt.ReceiptDigest);
        Assert.Equal(first.Receipt.ArticleId, replay.Receipt.ArticleId);
        Assert.Equal(first.Receipt.RevisionIds, replay.Receipt.RevisionIds);
        Assert.Equal(first.Receipt.PublicationIds, replay.Receipt.PublicationIds);
        Assert.Equal(articles, await CountAsync(db, "article"));
        Assert.Equal(revisions, await CountAsync(db, "article_revision"));
        Assert.Equal(publications, await CountAsync(db, "article_publication"));
        Assert.Equal(outbox, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(commands, await CountAsync(db, "article_mutation_command"));
        Assert.Equal(audits, await CountAsync(db, "sys_audit_log"));
    }

    [Fact]
    public async Task ExecuteAsync_SameRequestIdentityWithChangedPlan_ConflictsWithoutExtraWrites()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);
        Guid requestId = Guid.Parse("6eaac6a5-f652-4f71-91a8-b784555d20a8");
        var request = new CanonicalArticleLifecycleRequest(
            Binding(adminId, "conflict"),
            Plan(CanonicalArticleLifecycleVariants.Restore, categoryId, tagId),
            requestId);
        await port.ExecuteAsync(request);
        long revisions = await CountAsync(db, "article_revision");
        long publications = await CountAsync(db, "article_publication");
        long outbox = await CountAsync(db, "article_mutation_outbox");
        long audits = await CountAsync(db, "sys_audit_log");

        CanonicalArticleLifecycleRequest changed = request with
        {
            Plan = request.Plan with
            {
                Title = "Conflicting lifecycle title"
            }
        };
        await Assert.ThrowsAsync<ArticleMutationContentConflictException>(
            () => port.ExecuteAsync(changed));

        Assert.Equal(1, await CountAsync(db, "article"));
        Assert.Equal(revisions, await CountAsync(db, "article_revision"));
        Assert.Equal(publications, await CountAsync(db, "article_publication"));
        Assert.Equal(outbox, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_command"));
        Assert.Equal(audits, await CountAsync(db, "sys_audit_log"));
    }

    [Fact]
    public async Task ExecuteAsync_AuditFailure_RollsBackEveryLifecycleFact()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        InstallFailingAuditTrigger(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);

        await Assert.ThrowsAnyAsync<Exception>(() =>
            port.ExecuteAsync(new CanonicalArticleLifecycleRequest(
                Binding(adminId, "atomic-failure"),
                Plan(CanonicalArticleLifecycleVariants.Restore, categoryId, tagId))));

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
    public async Task ExecuteAsync_AdminWithoutWritePermission_FailsClosedWithoutFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        await db.Updateable<AdminPrincipal>()
            .SetColumns(item => item.Permissions == string.Empty)
            .Where(item => item.Id == adminId)
            .ExecuteCommandAsync();
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);

        ArticleWriteValidationException exception = await Assert.ThrowsAsync<ArticleWriteValidationException>(() =>
            port.ExecuteAsync(new CanonicalArticleLifecycleRequest(
                Binding(adminId, "permission-denied"),
                Plan(CanonicalArticleLifecycleVariants.Published, categoryId, tagId))));

        Assert.Equal("article_write_permission_required", exception.Code);
        Assert.Equal(0, await CountAsync(db, "article"));
        Assert.Equal(0, await CountAsync(db, "article_revision"));
        Assert.Equal(0, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(0, await CountAsync(db, "article_mutation_command"));
        Assert.Equal(0, await CountAsync(db, "sys_audit_log"));
    }

    [Fact]
    public async Task Verifier_RejectsResealedWriterTimeAndScheduledBoundaryTampering()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        var clock = new MutableTimeProvider(s_now);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db, clock);
        CanonicalArticleLifecycleResult result = await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(
                Binding(adminId, "temporal-tamper"),
                Plan(
                    CanonicalArticleLifecycleVariants.PublishedScheduledUpdate,
                    categoryId,
                    tagId,
                    s_now.AddMinutes(1))));
        clock.Now = s_now.AddMinutes(1);
        result = await port.PublishScheduledAsync(Binding(adminId, "temporal-tamper"), result.Receipt);

        CanonicalArticleLifecycleReceipt writerTampered = Seal(result.Receipt with
        {
            WriterContractDigest = "sha256:" + new string('f', 64)
        });
        CanonicalArticleLifecycleVerificationResult verification = await CanonicalArticleLifecycleVerifier
            .VerifyAsync(db, Configuration(), writerTampered);
        Assert.Contains("writer_contract_digest_mismatch", verification.Violations);

        CanonicalArticleLifecycleReceipt temporalTampered = Seal(result.Receipt with
        {
            TemporalContextDigest = "recompute"
        });
        verification = await CanonicalArticleLifecycleVerifier.VerifyAsync(
            db,
            Configuration(),
            temporalTampered);
        Assert.Contains("temporal_context_digest_invalid", verification.Violations);

        CanonicalArticleLifecycleOperationReceipt[] earlyOperations = result.Receipt.Operations
            .Select(operation => operation.Operation == "scheduled-update"
                ? operation with
                {
                    AfterPublicationId = operation.AfterPublicationId.GetValueOrDefault() + 1
                }
                : operation.Operation == "scheduled-publish"
                    ? operation with
                    {
                        TransitionedAtUtc = operation.ScheduledPublishAt!.Value.AddTicks(-1)
                    }
                    : operation)
            .ToArray();
        CanonicalArticleLifecycleReceipt boundaryTampered = Seal(result.Receipt with
        {
            Operations = earlyOperations
        });
        verification = await CanonicalArticleLifecycleVerifier.VerifyAsync(
            db,
            Configuration(),
            boundaryTampered);
        Assert.Contains(
            verification.Violations,
            item => item.Contains("scheduled_update_changed_publication_early", StringComparison.Ordinal));
        Assert.Contains(
            verification.Violations,
            item => item.Contains("scheduled_publish_before_due", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Verifier_RejectsLaterRevisionAuthorityCoordinateDrift()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);
        CanonicalArticleLifecycleResult result = await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(
                Binding(adminId, "later-coordinate-drift"),
                Plan(CanonicalArticleLifecycleVariants.MultipleRevisions, categoryId, tagId)));
        long lastRevisionId = result.Receipt.RevisionIds[^1];
        CanonicalArticleLifecycleOperationReceipt lastOperation = result.Receipt.Operations[^1];

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article_revision SET created_by_admin_principal_id = @AdminId WHERE id = @RevisionId;",
            new SugarParameter("@AdminId", adminId + 1000),
            new SugarParameter("@RevisionId", lastRevisionId));
        await db.Deleteable<ArticleResponsibilitySnapshot>()
            .Where(item => item.ArticleRevisionId == lastRevisionId)
            .ExecuteCommandAsync();
        await db.Deleteable<ArticleMutationOutboxEvent>()
            .Where(item => item.EventId == lastOperation.OutboxEventId)
            .ExecuteCommandAsync();

        CanonicalArticleLifecycleVerificationResult verification = await CanonicalArticleLifecycleVerifier
            .VerifyAsync(db, Configuration(), result.Receipt);
        Assert.Contains(
            verification.Violations,
            item => item == $"revision_admin_mismatch:{lastRevisionId}");
        Assert.Contains(
            verification.Violations,
            item => item == $"responsibility_snapshot_missing_for_revision:{lastRevisionId}");
        Assert.Contains(
            verification.Violations,
            item => item == $"operation_outbox_missing:{lastOperation.TransitionId}");
    }

    [Fact]
    public async Task ExecuteAsync_SameTitleAcrossIncompatibleVariants_UsesDistinctArticles()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);
        const string SharedTitle = "Lifecycle title must not be an identity";
        CanonicalArticleLifecyclePlan publishedPlan =
            Plan(CanonicalArticleLifecycleVariants.Published, categoryId, tagId) with
            {
                SemanticRole = "same-title-published",
                Title = SharedTitle
            };
        CanonicalArticleLifecyclePlan deletedPlan =
            Plan(CanonicalArticleLifecycleVariants.Deleted, categoryId, tagId) with
            {
                SemanticRole = "same-title-deleted",
                Title = SharedTitle
            };

        CanonicalArticleLifecycleResult published = await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(
                Binding(adminId, "same-title-published"),
                publishedPlan));
        CanonicalArticleLifecycleResult deleted = await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(
                Binding(adminId, "same-title-deleted"),
                deletedPlan));

        Assert.NotEqual(published.Receipt.ArticleId, deleted.Receipt.ArticleId);
        Assert.Equal(2, await CountAsync(db, "article"));
        Assert.Equal(2, await CountAsync(db, "article_mutation_command"));
    }

    [Fact]
    public async Task Verifier_RejectsArchivedAndDeletedPublicStateDrift()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);
        CanonicalArticleLifecycleResult archived = await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(
                Binding(adminId, "archived-drift"),
                Plan(CanonicalArticleLifecycleVariants.Archived, categoryId, tagId)));
        CanonicalArticleLifecycleResult deleted = await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(
                Binding(adminId, "deleted-drift"),
                Plan(CanonicalArticleLifecycleVariants.Deleted, categoryId, tagId)));

        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET status = @Published, isdeleted = false
            WHERE id IN (@ArchivedId, @DeletedId);
            """,
            new SugarParameter("@Published", (int)ArticleStatus.Published),
            new SugarParameter("@ArchivedId", archived.Receipt.ArticleId),
            new SugarParameter("@DeletedId", deleted.Receipt.ArticleId));

        CanonicalArticleLifecycleVerificationResult archivedVerification =
            await CanonicalArticleLifecycleVerifier.VerifyAsync(db, Configuration(), archived.Receipt);
        CanonicalArticleLifecycleVerificationResult deletedVerification =
            await CanonicalArticleLifecycleVerifier.VerifyAsync(db, Configuration(), deleted.Receipt);
        Assert.Contains("current_status_mismatch", archivedVerification.Violations);
        Assert.Contains("current_status_mismatch", deletedVerification.Violations);
        Assert.Contains("current_deleted_flag_mismatch", deletedVerification.Violations);
    }

    [Fact]
    public async Task ExecuteAsync_DoesNotWriteDerivedProjectionTables()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
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
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);

        await port.ExecuteAsync(new CanonicalArticleLifecycleRequest(
            Binding(adminId, "no-derived"),
            Plan(CanonicalArticleLifecycleVariants.MultiplePublications, categoryId, tagId)));

        Assert.Equal(0, await CountAsync(db, "article_search_document"));
        Assert.Equal(0, await CountAsync(db, "public_aot_artifact"));
    }

    [Fact]
    public async Task ExecuteAsync_ScheduledPastAndMissingAdmin_FailClosedWithoutFacts()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);

        CanonicalArticleLifecycleValidationException past = await Assert.ThrowsAsync<CanonicalArticleLifecycleValidationException>(
            () => port.ExecuteAsync(new CanonicalArticleLifecycleRequest(
                Binding(adminId, CanonicalArticleLifecycleVariants.Scheduled),
                Plan(
                    CanonicalArticleLifecycleVariants.Scheduled,
                    categoryId,
                    tagId,
                    s_now.AddSeconds(-1)))));
        Assert.Equal("scheduled_at_must_be_future", past.Code);

        await Assert.ThrowsAsync<ArticleWriteValidationException>(() =>
            port.ExecuteAsync(new CanonicalArticleLifecycleRequest(
                Binding(404, CanonicalArticleLifecycleVariants.Published),
                Plan(CanonicalArticleLifecycleVariants.Published, categoryId, tagId))));

        Assert.Equal(0, await CountAsync(db, "article"));
        Assert.Equal(0, await CountAsync(db, "article_revision"));
        Assert.Equal(0, await CountAsync(db, "article_publication"));
        Assert.Equal(0, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(0, await CountAsync(db, "sys_audit_log"));
    }

    [Fact]
    public async Task ExecuteAsync_StaleExpectedRevision_FailsBeforeNewRevision()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);
        CanonicalArticleLifecycleResult created = await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(
                Binding(adminId, "stale-base"),
                Plan(CanonicalArticleLifecycleVariants.Published, categoryId, tagId)));

        // The public port uses a scenario-owned chain.  A stale expected revision is rejected
        // by the shared writer before its revision persistence seam can insert anything.
        db.Ado.BeginTran();
        try
        {
            ArticleRevisionConflictException exception = await Assert.ThrowsAsync<ArticleRevisionConflictException>(() =>
                ArticleLifecycleTransitionWriter.UpdateAsync(
                    db,
                    Configuration(),
                    new ArticleLifecycleTransitionWriter.RevisionRequest(
                        created.Receipt.ArticleId,
                        created.Receipt.CurrentRevisionId + 1,
                        "stale update",
                        "stale update body",
                        "summary",
                        null,
                        categoryId,
                        [tagId],
                        ArticleStatus.Published,
                        null,
                        s_now.AddMinutes(1),
                        adminId,
                        null,
                        Responsibility(),
                        ArticlePublicationTransitionKinds.ImmediatePublish,
                        "stale-base")));
            Assert.Equal("article_revision_conflict", exception.Message);
        }
        finally
        {
            db.Ado.RollbackTran();
        }
        Assert.Equal(1, await CountAsync(db, "article_revision"));
        Assert.Equal(1, await CountAsync(db, "article_publication"));
        Assert.Equal(1, await CountAsync(db, "article_mutation_outbox"));
    }

    [Fact]
    public async Task Verifier_DetectsHistoryAndReceiptTampering()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        long adminId = await EnsureAdminAsync(db);
        (int categoryId, int tagId) = await EnsureTaxonomyAsync(db);
        CanonicalArticleLifecycleFixturePort port = CreatePort(db);
        CanonicalArticleLifecycleResult result = await port.ExecuteAsync(
            new CanonicalArticleLifecycleRequest(
                Binding(adminId, "tamper"),
                Plan(CanonicalArticleLifecycleVariants.MultiplePublications, categoryId, tagId)));

        CanonicalArticleLifecycleReceipt tampered = result.Receipt with
        {
            ContentDigest = "sha256:" + new string('f', 64)
        };
        CanonicalArticleLifecycleVerificationResult verification = await CanonicalArticleLifecycleVerifier.VerifyAsync(
            db,
            Configuration(),
            tampered);
        Assert.False(verification.IsValid);
        Assert.Contains(verification.Violations, item => item == "receipt_digest_tamper_detected");

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article_revision SET title = @Title WHERE id = @Id;",
            new SugarParameter("@Title", "history tampered"),
            new SugarParameter("@Id", result.Receipt.RevisionIds[0]));
        verification = await CanonicalArticleLifecycleVerifier.VerifyAsync(
            db,
            Configuration(),
            result.Receipt);
        Assert.False(verification.IsValid);
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
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem),
            typeof(ArticlePublicationRecord),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleResponsibilitySnapshot),
            typeof(ArticleMutationOutboxEvent),
            typeof(ArticleMutationCommand));
        return db;
    }

    private static CanonicalArticleLifecycleFixturePort CreatePort(SqlSugarClient db, TimeProvider? timeProvider = null)
    {
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, "ok", string.Empty));
        var validator = new ArticlePublicationValidator(db, contentFilter);
        return new CanonicalArticleLifecycleFixturePort(
            db,
            Configuration(),
            validator,
            Substitute.For<IArticlePublicMutationFence>(),
            timeProvider ?? new FixedTimeProvider(s_now));
    }

    private static IConfiguration Configuration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Audit:TamperEvidenceKey"] = TamperKey
            })
            .Build();

    private static CanonicalArticleLifecycleFixtureBinding Binding(long adminId, string variant)
        => new(
            "run-lifecycle",
            "test-ns",
            "profile-lifecycle",
            ["article.write", $"article:{variant}"],
            adminId,
            CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
            "sha256:" + new string('b', 64));

    private static CanonicalArticleLifecyclePlan Plan(
        string variant,
        int categoryId,
        int tagId,
        DateTime? scheduledAt = null)
        => new(
            $"lifecycle-{variant}",
            variant,
            $"Lifecycle {variant}",
            $"# Lifecycle {variant} body",
            "lifecycle summary",
            null,
            categoryId,
            [tagId],
            null,
            Responsibility(),
            scheduledAt);

    private static ArticleResponsibilityDraft Responsibility()
        => new(
            true,
            [new ArticleResponsiblePerson("Lifecycle fixture author", null)],
            null,
            [],
            "lifecycle fixture",
            "issue-2174",
            null,
            null,
            null,
            null,
            null,
            true,
            false,
            false,
            false,
            0);

    private static CanonicalArticleLifecycleReceipt Seal(CanonicalArticleLifecycleReceipt receipt)
        => receipt with
        {
            ReceiptDigest = CanonicalArticleLifecycleFixturePort.ComputeReceiptDigest(
                receipt.WriterContractDigest,
                receipt.TemporalContextDigest,
                receipt.RunId,
                receipt.Namespace,
                receipt.ProfileId,
                receipt.SemanticRole,
                receipt.Variant,
                receipt.AdminPrincipalId,
                receipt.ArticleId,
                receipt.Operations,
                receipt.RevisionIds,
                receipt.PublicationIds,
                receipt.CurrentRevisionId,
                receipt.CurrentPublicationId,
                receipt.CurrentStatus,
                receipt.IsDeleted,
                receipt.ContentDigest,
                receipt.RevisionTimelineDigest)
        };

    private static async Task<long> EnsureAdminAsync(SqlSugarClient db)
    {
        AdminPrincipal? existing = await db.Queryable<AdminPrincipal>().FirstAsync();
        if (existing is not null)
        {
            return existing.Id;
        }
        return await db.Insertable(new AdminPrincipal
        {
            Handle = "lifecycle-admin",
            DisplayName = "Lifecycle Admin",
            Status = AdminPrincipalStatus.Active,
            Permissions = string.Join('\n', AdminPermissions.ArticleWrite, AdminPermissions.ArticlePublish),
            CreatedAtUtc = s_now
        }).ExecuteReturnBigIdentityAsync();
    }

    private static async Task<(int CategoryId, int TagId)> EnsureTaxonomyAsync(SqlSugarClient db)
    {
        int categoryId = await db.Insertable(new Category { Name = "lifecycle-category" }).ExecuteReturnIdentityAsync();
        int tagId = await db.Insertable(new Tag { Name = "lifecycle-tag" }).ExecuteReturnIdentityAsync();
        return (categoryId, tagId);
    }

    private static async Task<long> CountAsync(SqlSugarClient db, string table)
        => await db.Ado.GetIntAsync($"SELECT COUNT(*) FROM {table};");

    private static void InstallFailingAuditTrigger(SqlSugarClient db)
        => db.Ado.ExecuteCommand(
            """
            CREATE OR REPLACE FUNCTION fail_lifecycle_audit_insert()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                RAISE EXCEPTION 'lifecycle audit insert failure';
            END;
            $$;

            CREATE TRIGGER fail_lifecycle_audit_insert
            BEFORE INSERT ON sys_audit_log
            FOR EACH ROW
            EXECUTE FUNCTION fail_lifecycle_audit_insert();
            """);

    private sealed class RegressingTimeProvider(DateTime? initial = null, int readsBeforeRegression = 1) : TimeProvider
    {
        private int _reads;

        public override DateTimeOffset GetUtcNow()
            => new(Interlocked.Increment(ref _reads) <= readsBeforeRegression
                ? initial ?? s_now
                : (initial ?? s_now).AddMilliseconds(-1));
    }

    private sealed class MutableTimeProvider(DateTime now) : TimeProvider
    {
        public DateTime Now { get; set; } = now;

        public override DateTimeOffset GetUtcNow() => new(Now);
    }

    private sealed class FixedTimeProvider(DateTime now) : TimeProvider
    {
        private readonly DateTimeOffset _now = new(now, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _now;
    }
}
