using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleTemplateContractTests
{
    private static readonly DateTime s_now = new(2026, 9, 7, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Source_PreservesBytesAndAcceptsOnlyClosedVariables()
    {
        ArticleTemplateSource source = ArticleTemplateSource.FromUtf8(
            "\uFEFF# {{title}}\r\n{{date}} {{author}} {{site_locale}}  \r\n");

        Assert.Equal("\uFEFF# {{title}}\r\n{{date}} {{author}} {{site_locale}}  \r\n", source.GetText());
        Assert.Equal(4, source.VariableTokens.Count);
        Assert.Equal("article_template_variable_unknown", Assert.Throws<ArticleTemplateValidationException>(
            () => ArticleTemplateSource.FromUtf8("{{user_email}}")).Code);
        Assert.Equal("article_template_html_authority_forbidden", Assert.Throws<ArticleTemplateValidationException>(
            () => ArticleTemplateSource.FromUtf8("<script>alert(1)</script>")).Code);
        Assert.Equal("article_template_dynamic_source_forbidden", Assert.Throws<ArticleTemplateValidationException>(
            () => ArticleTemplateSource.FromUtf8("{% include 'remote' %}")).Code);
    }

    [Fact]
    public void PermissionAuthority_BindsPersonalAndSiteManagementToCanonicalPermissions()
    {
        var authority = new ArticleTemplatePermissionAuthority();
        var writer = Actor(AdminPermissions.ArticleWrite);
        var siteManager = Actor(AdminPermissions.ArticleWrite, AdminPermissions.SystemConfig);

        authority.EnsureAllowed(writer, ArticleTemplateContract.PersonalScope(42), ArticleTemplatePermission.Manage);
        authority.EnsureAllowed(writer, ArticleTemplateContract.SiteScope(), ArticleTemplatePermission.Use);
        Assert.Throws<ArticleTemplateAccessDeniedException>(() => authority.EnsureAllowed(
            writer, ArticleTemplateContract.PersonalScope(43), ArticleTemplatePermission.Read));
        Assert.Throws<ArticleTemplateAccessDeniedException>(() => authority.EnsureAllowed(
            writer, ArticleTemplateContract.SiteScope(), ArticleTemplatePermission.Manage));
        authority.EnsureAllowed(siteManager, ArticleTemplateContract.SiteScope(), ArticleTemplatePermission.Manage);
    }

    [Fact]
    public async Task Store_EnforcesCasIdempotencyImmutableVersionsUsageAndTombstone()
    {
        var persistence = new TestPersistence();
        ArticleTemplateStore store = CreateStore(persistence);
        ArticleTemplateActor actor = Actor(AdminPermissions.ArticleWrite);
        ArticleTemplateScope scope = ArticleTemplateContract.PersonalScope(actor.AdminPrincipalId);
        Guid templateId = Guid.NewGuid();
        Guid versionOneId = Guid.NewGuid();
        Guid createRequest = Guid.NewGuid();
        var create = new CreateArticleTemplateCommand(
            actor, scope, templateId, versionOneId, createRequest, 0, " First template ", " initial ",
            ArticleTemplateSource.FromUtf8("# {{title}}\n"),
            new ArticleTemplateDefaults(titlePlaceholder: "Draft"));

        ArticleTemplateWriteReceipt created = await store.CreateAsync(create);
        ArticleTemplateWriteReceipt replay = await store.CreateAsync(create);
        Assert.True(replay.IsIdempotentReplay);
        Assert.Equal(created.ReceiptId, replay.ReceiptId);

        Guid versionTwoId = Guid.NewGuid();
        ArticleTemplateWriteReceipt versioned = await store.CreateVersionAsync(new(
            actor, templateId, versionTwoId, Guid.NewGuid(), 1, 1, 1,
            ArticleTemplateSource.FromUtf8("# {{title}}\nsecond\n"),
            new ArticleTemplateDefaults(summaryPlaceholder: "Summary")));
        Assert.Equal(2, versioned.VersionNumber);
        Assert.Equal("# {{title}}\n", (await store.GetVersionAsync(actor, templateId, versionOneId))!.Source.GetText());
        Assert.Equal("# {{title}}\nsecond\n", (await store.GetVersionAsync(actor, templateId, versionTwoId))!.Source.GetText());

        ArticleTemplateConflictException stale = await Assert.ThrowsAsync<ArticleTemplateConflictException>(
            () => store.CreateVersionAsync(new(
                actor, templateId, Guid.NewGuid(), Guid.NewGuid(), 2, 2, 1,
                ArticleTemplateSource.FromUtf8("stale"), new ArticleTemplateDefaults())));
        Assert.Equal("article_template_version_cas_stale", stale.Code);

        ArticleTemplateConflictException activeDelete = await Assert.ThrowsAsync<ArticleTemplateConflictException>(
            () => store.DeleteAsync(new(actor, templateId, Guid.NewGuid(), 2, 2)));
        Assert.Equal("article_template_delete_requires_retired", activeDelete.Code);
        await store.RetireAsync(new(actor, templateId, Guid.NewGuid(), 2, 2));

        persistence.UsageCount = 1;
        ArticleTemplateConflictException usedDelete = await Assert.ThrowsAsync<ArticleTemplateConflictException>(
            () => store.DeleteAsync(new(actor, templateId, Guid.NewGuid(), 3, 3)));
        Assert.Equal("article_template_delete_in_use", usedDelete.Code);

        persistence.UsageCount = 0;
        ArticleTemplateWriteReceipt deleted = await store.DeleteAsync(new(actor, templateId, Guid.NewGuid(), 3, 3));
        Assert.Equal(ArticleTemplateDeleteDisposition.TombstonedHistoryPreserved, deleted.DeleteDisposition);
        Assert.Equal(2, persistence.Versions.Count);
        await Assert.ThrowsAsync<ArticleTemplateAccessDeniedException>(() => store.GetAsync(actor, templateId));
    }

    [Fact]
    public async Task Store_BoundsPaginationAndVerifierFindsTamperAndStaleReferences()
    {
        var persistence = new TestPersistence();
        var references = new TestReferenceAuthority();
        ArticleTemplateStore store = CreateStore(persistence, references);
        ArticleTemplateActor actor = Actor(AdminPermissions.ArticleWrite);
        ArticleTemplateScope scope = ArticleTemplateContract.PersonalScope(actor.AdminPrincipalId);
        Guid templateId = Guid.NewGuid();
        await store.CreateAsync(new(
            actor, scope, templateId, Guid.NewGuid(), Guid.NewGuid(), 0, "Template", null,
            ArticleTemplateSource.FromUtf8("{{title}}"), new ArticleTemplateDefaults()));

        await Assert.ThrowsAsync<ArticleTemplateValidationException>(
            () => store.ListAsync(actor, scope, null, ArticleTemplateContract.MaxPageSize + 1));
        Assert.True((await store.VerifyAsync(actor, templateId)).Valid);

        ArticleTemplateAuditLink originalLink = persistence.AuditLinks.Single();
        persistence.AuditLinks.Clear();
        ArticleTemplateVerificationResult missingAudit = await store.VerifyAsync(actor, templateId);
        Assert.Contains(missingAudit.Violations, violation => violation.Code == "audit_link_missing");

        persistence.AuditLinks.Add(originalLink);
        persistence.AuditLinks.Add(originalLink);
        ArticleTemplateVerificationResult duplicateAudit = await store.VerifyAsync(actor, templateId);
        Assert.Contains(duplicateAudit.Violations, violation => violation.Code == "audit_link_duplicate");

        persistence.AuditLinks.RemoveAt(1);
        persistence.AuditLinks[0] = originalLink with
        {
            EventInfo = new string('0', 64)
        };
        ArticleTemplateVerificationResult tamperedAudit = await store.VerifyAsync(actor, templateId);
        Assert.Contains(tamperedAudit.Violations, violation => violation.Code == "audit_link_tamper");
        persistence.AuditLinks[0] = originalLink;

        references.Reject = true;
        ArticleTemplateVerificationResult stale = await store.VerifyAsync(actor, templateId);
        Assert.Contains(stale.Violations, violation => violation.Code == "reference_invalid");

        references.Reject = false;
        persistence.Definitions[templateId] = persistence.Definitions[templateId] with
        {
            ContentDigest = new string('0', 64)
        };
        ArticleTemplateVerificationResult tampered = await store.VerifyAsync(actor, templateId);
        Assert.Contains(tampered.Violations, violation => violation.Code == "definition_tamper");
    }

    private static ArticleTemplateStore CreateStore(
        TestPersistence persistence,
        TestReferenceAuthority? references = null)
        => new(
            persistence,
            new ArticleTemplatePermissionAuthority(),
            references ?? new TestReferenceAuthority(),
            new ArticleTemplateVerifier(),
            new FixedTimeProvider(s_now));

    private static ArticleTemplateActor Actor(params string[] permissions) => new(42, permissions);

    private sealed class FixedTimeProvider(DateTime value) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(value);
    }

    private sealed class TestReferenceAuthority : IArticleTemplateReferenceAuthority
    {
        internal bool Reject
        {
            get; set;
        }

        public Task ValidateAsync(
            ArticleTemplateActor actor,
            ArticleTemplateScope scope,
            ArticleTemplateDefaults defaults,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Reject)
            {
                throw new ArticleTemplateReferenceException("stale_reference");
            }
            return Task.CompletedTask;
        }
    }

    private sealed class TestPersistence : IArticleTemplatePersistence
    {
        private readonly Dictionary<(long Actor, Guid Request), (string Digest, Guid Receipt)> _idempotency = [];
        private readonly Dictionary<Guid, ArticleTemplateWriteReceipt> _receipts = [];
        private long _scopeRevision;

        internal Dictionary<Guid, ArticleTemplateDefinition> Definitions { get; } = [];
        internal List<ArticleTemplateVersion> Versions { get; } = [];
        internal List<ArticleTemplateAuditLink> AuditLinks { get; } = [];
        internal long UsageCount
        {
            get; set;
        }

        public Task<ArticleTemplateDefinition?> GetAsync(Guid templateId, CancellationToken cancellationToken = default)
            => Task.FromResult(Definitions.GetValueOrDefault(templateId));

        public Task<ArticleTemplatePage> ListAsync(
            ArticleTemplateScope scope,
            ArticleTemplatePageCursor? cursor,
            int limit,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new ArticleTemplatePage(
                Definitions.Values.Where(item => item.Scope == scope && item.Status != ArticleTemplateStatus.Deleted)
                    .OrderBy(item => item.NameKey, StringComparer.Ordinal).Take(limit).ToArray(),
                null,
                _scopeRevision));

        public Task<ArticleTemplateVersion?> GetVersionAsync(
            Guid templateId,
            Guid versionId,
            CancellationToken cancellationToken = default)
            => Task.FromResult(Versions.SingleOrDefault(
                item => item.TemplateId == templateId && item.VersionId == versionId));

        public Task<ArticleTemplateVersionPage> ListVersionsAsync(
            Guid templateId,
            int? afterVersionNumber,
            int limit,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new ArticleTemplateVersionPage(
                Versions.Where(item => item.TemplateId == templateId
                        && (!afterVersionNumber.HasValue || item.VersionNumber < afterVersionNumber))
                    .OrderByDescending(item => item.VersionNumber).Take(limit).ToArray(),
                null));

        public async Task<ArticleTemplateWriteReceipt> ExecuteAsync(
            ArticleTemplateScope scope,
            long actorAdminPrincipalId,
            Guid requestId,
            string commandDigest,
            Guid templateId,
            Func<ArticleTemplateMutationSnapshot, CancellationToken, Task<ArticleTemplateMutation>> planner,
            CancellationToken cancellationToken = default)
        {
            if (_idempotency.TryGetValue((actorAdminPrincipalId, requestId), out var replay))
            {
                if (replay.Digest != commandDigest)
                {
                    throw new ArticleTemplateConflictException("article_template_idempotency_conflict");
                }
                return _receipts[replay.Receipt] with
                {
                    IsIdempotentReplay = true
                };
            }

            ArticleTemplateDefinition? target = Definitions.GetValueOrDefault(templateId);
            var snapshot = new ArticleTemplateMutationSnapshot(
                scope,
                _scopeRevision,
                Definitions.Values.Where(item => item.Scope == scope).ToArray(),
                target,
                Versions.Where(item => item.TemplateId == templateId).OrderByDescending(item => item.VersionNumber).ToArray(),
                UsageCount);
            ArticleTemplateMutation mutation = await planner(snapshot, cancellationToken);
            _scopeRevision = mutation.Receipt.ScopeRevision;
            Definitions[templateId] = mutation.Definition;
            if (mutation.VersionToInsert is not null)
            {
                Versions.Add(mutation.VersionToInsert);
            }
            _receipts.Add(mutation.Receipt.ReceiptId, mutation.Receipt);
            _idempotency.Add((actorAdminPrincipalId, requestId), (commandDigest, mutation.Receipt.ReceiptId));
            AuditLinks.Add(Link(mutation.Receipt));
            return mutation.Receipt;
        }

        public Task<ArticleTemplateVerificationSnapshot?> ReadVerificationSnapshotAsync(
            Guid templateId,
            int receiptLimit,
            CancellationToken cancellationToken = default)
        {
            if (!Definitions.TryGetValue(templateId, out ArticleTemplateDefinition? definition))
            {
                return Task.FromResult<ArticleTemplateVerificationSnapshot?>(null);
            }
            ArticleTemplateWriteReceipt[] receipts = [.. _receipts.Values
                .Where(item => item.TemplateId == templateId).OrderBy(item => item.TemplateRevision)];
            ArticleTemplateIdempotencyRecord[] idempotency = [.. _idempotency
                .Where(item => _receipts[item.Value.Receipt].TemplateId == templateId)
                .Select(item => new ArticleTemplateIdempotencyRecord(
                    item.Key.Actor, item.Key.Request, item.Value.Digest, item.Value.Receipt))];
            return Task.FromResult<ArticleTemplateVerificationSnapshot?>(new(
                definition,
                Versions.Where(item => item.TemplateId == templateId).ToArray(),
                receipts.Take(receiptLimit).ToArray(),
                idempotency.Take(receiptLimit).ToArray(),
                AuditLinks.Where(link => receipts.Any(receipt => receipt.AuditReference == link.AuditReference)).ToArray(),
                receipts.Length > receiptLimit || idempotency.Length > receiptLimit));
        }

        private static ArticleTemplateAuditLink Link(ArticleTemplateWriteReceipt receipt)
            => new(
                receipt.AuditReference,
                "article",
                "business",
                "article.write",
                "article-template-receipt",
                receipt.AuditReference.ToString("N"),
                receipt.AuditDigest,
                receipt.CommandKind,
                "success",
                IsHighValue: true);
    }
}
