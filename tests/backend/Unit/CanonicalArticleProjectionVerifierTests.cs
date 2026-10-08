using System.Buffers.Binary;
using System.Collections.Frozen;
using System.Linq.Expressions;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Http;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CanonicalArticleProjectionVerifierTests
{
    private static readonly DateTime s_now = new(2026, 9, 22, 8, 30, 0, DateTimeKind.Utc);

    [Fact]
    public async Task ProjectionWait_TimesOutEvenWhenReaderNeverCompletes()
    {
        var obligations = Substitute.For<IPublicHotArtifactObligationStore>();
        var pending = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        obligations.HasTerminalFailureAsync(Arg.Any<CancellationToken>()).Returns(pending.Task);
        try
        {
            TimeoutException error = await Assert.ThrowsAsync<TimeoutException>(() => PublicContentFixtureSeeder.AwaitPublicHotProjectionAsync(
                obligations, TimeSpan.FromMilliseconds(50), CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal("canonical article public-hot projection convergence timed out", error.Message);
        }
        finally
        {
            pending.TrySetResult(false);
        }
    }

    [Fact]
    public async Task ProjectionWait_PreservesCallerCancellation()
    {
        var obligations = Substitute.For<IPublicHotArtifactObligationStore>();
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => PublicContentFixtureSeeder.AwaitPublicHotProjectionAsync(
            obligations, TimeSpan.FromSeconds(1), cancelled.Token));
    }

    [Theory]
    [InlineData("published")]
    [InlineData("recovered")]
    [InlineData("failed")]
    [InlineData("missing")]
    [InlineData("stale-generation")]
    public async Task ProjectionWait_RequiresUnrecoveredExactPublishedGeneration(string scenario)
    {
        var obligations = Substitute.For<IPublicHotArtifactObligationStore>();
        var obligation = new PublicHotArtifactObligation(
            "bound-obligation", 23, default, [1215], false, new Dictionary<int, long> { [1215] = 1801 },
            scenario == "recovered" ? 2 : 1, PublicHotArtifactObligationState.Published,
            PublicHotArtifactFailureKind.None, s_now, [], scenario == "stale-generation" ? 22 : 23);
        obligations.HasTerminalFailureAsync(Arg.Any<CancellationToken>()).Returns(scenario == "failed");
        obligations.GetActiveAsync(Arg.Any<CancellationToken>()).Returns(scenario == "missing" ? null : obligation);
        Task Wait() => PublicContentFixtureSeeder.AwaitPublicHotProjectionAsync(
            obligations, TimeSpan.FromMilliseconds(50), CancellationToken.None);
        if (scenario == "published")
            await Wait();
        else if (scenario == "stale-generation")
            await Assert.ThrowsAsync<TimeoutException>(Wait);
        else
            await Assert.ThrowsAsync<InvalidOperationException>(Wait);
    }

    // Local read-port simulation, not a claim that a production worker ran.
    // The entry point and AEDS/POD decoding, snapshot, receipts and digests are real.
    [Theory]
    [InlineData("lifecycle", null)]
    [InlineData("publication", null)]
    [InlineData("stale-frame", "aeds_article_detail_coordinate_mismatch")]
    [InlineData("stale-aot", "aot_event_binding_mismatch")]
    [InlineData("search-failed", "search_visibility_mismatch")]
    [InlineData("cache-missing", "article_list_cache_version_invalid")]
    [InlineData("detail-stale", "public_detail_coordinate_mismatch")]
    [InlineData("outbox-missing", "outbox_event_not_exact:")]
    [InlineData("latest-metadata", "article_latest_metadata_disagrees_with_sealed_revision")]
    [InlineData("list-metadata", "public_list_metadata_mismatch")]
    [InlineData("aot-wrong-target", "aot_article_generation_mismatch")]
    [InlineData("aot-document-missing", "aot_current_document_missing")]
    [InlineData("aot-document-stale-publication", "aot_article_output_coordinate_mismatch")]
    [InlineData("aot-document-stale-content", "aot_article_output_content_digest_mismatch")]
    [InlineData("aot-document-stale-rights", "aot_article_output_rights_mismatch")]
    [InlineData("aot-document-unsealed", "aot_article_output_coordinate_mismatch")]
    [InlineData("aot-hydration-missing", "aot_hydration_payload_invalid")]
    [InlineData("aot-document-rights-policy", "aot_article_output_rights_mismatch")]
    [InlineData("lifecycle-relabel", "authority_current_invocation_binding_mismatch")]
    [InlineData("aot-data-id", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-comment", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-rawtext", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-style-rawtext", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-script-rawtext", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-template", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-noscript", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-foreign-script", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-duplicate-id", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-wrong-element", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-hydration-data-id", "aot_hydration_reference_missing")]
    [InlineData("aot-hydration-comment", "aot_hydration_reference_missing")]
    [InlineData("aot-hydration-rawtext", "aot_hydration_reference_missing")]
    [InlineData("aot-hydration-stale-coordinates", "aot_hydration_semantic_mismatch")]
    [InlineData("aot-hydration-inline-shadow", "aot_hydration_reference_missing")]
    [InlineData("aot-hydration-external-url", "aot_hydration_reference_missing")]
    [InlineData("publication-relabel", "publication_current_invocation_binding_mismatch")]
    [InlineData("publication-relabel-invocation", "publication_current_invocation_command_mismatch")]
    [InlineData("publication-command-missing", "publication_current_invocation_command_not_exact")]
    [InlineData("publication-command-duplicate", "publication_current_invocation_command_not_exact")]
    [InlineData("publication-command-stale", "publication_current_invocation_command_mismatch")]
    [InlineData("publication-reference-stale", "publication_canonical_reference_mismatch")]
    [InlineData("publication-audit-stale", "publication_canonical_audit_mismatch")]
    public async Task VerifyAsync_RereadsBoundOutputsAndFailsClosed(
        string scenario,
        string? expectedViolation)
        => await ReadBoundOutputsScenarioAsync(scenario, expectedViolation);

    [Theory]
    [InlineData("aot-cold-wait", null)]
    [InlineData("publication", null)]
    [InlineData("aot-document-missing", "caller-budget-cancelled")]
    [InlineData("aot-never-completes", "caller-budget-cancelled")]
    [InlineData("aot-caller-cancelled", "caller-budget-cancelled")]
    [InlineData("aot-shared-budget", null)]
    [InlineData("aot-document-stale-publication", "aot_article_output_coordinate_mismatch")]
    [InlineData("aot-data-id", "aot_bootstrap_payload_invalid")]
    [InlineData("aot-hydration-missing", "aot_hydration_payload_invalid")]
    [InlineData("stale-aot", "aot_event_binding_mismatch")]
    [InlineData("outbox-missing", "outbox_event_not_exact:")]
    public async Task AwaitCurrentOutput_RereadsOnlyAbsentCurrentDocumentWithinCallerBudget(
        string scenario,
        string? expectedViolation)
        => await ReadBoundOutputsScenarioAsync(scenario, expectedViolation, awaitCurrentOutput: true);

    private static async Task ReadBoundOutputsScenarioAsync(
        string scenario,
        string? expectedViolation,
        bool verifyAggregate = false,
        bool awaitCurrentOutput = false)
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        const string Content = "current content";
        CanonicalArticleLifecycleOperationReceipt operation = authority.Operations[^1] with
        {
            ContentDigest = DigestText(Content)
        };
        authority = authority with
        {
            Operations = [operation],
            ContentDigest = operation.ContentDigest
        };
        authority = authority with
        {
            ReceiptDigest = CanonicalArticleLifecycleFixturePort.ComputeReceiptDigest(
                authority.WriterContractDigest, authority.TemporalContextDigest,
                authority.RunId, authority.Namespace, authority.ProfileId, authority.SemanticRole,
                authority.Variant, authority.AdminPrincipalId, authority.ArticleId, authority.Operations,
                authority.RevisionIds, authority.PublicationIds, authority.CurrentRevisionId,
                authority.CurrentPublicationId, authority.CurrentStatus, authority.IsDeleted,
                authority.ContentDigest, authority.RevisionTimelineDigest)
        };

        var db = Substitute.For<ISqlSugarClient>();
        var events = Substitute.For<ISugarQueryable<ArticleMutationOutboxEvent>>();
        db.Queryable<ArticleMutationOutboxEvent>().Returns(events);
        events.Where(Arg.Any<Expression<Func<ArticleMutationOutboxEvent, bool>>>()).Returns(events);
        events.ToListAsync(Arg.Any<CancellationToken>()).Returns(
            scenario == "outbox-missing" ? [] : new List<ArticleMutationOutboxEvent> { outbox });
        var edges = Substitute.For<ISugarQueryable<ArticleMutationOutboxEdge>>();
        db.Queryable<ArticleMutationOutboxEdge>().Returns(edges);
        edges.Where(Arg.Any<Expression<Func<ArticleMutationOutboxEdge, bool>>>()).Returns(edges);
        edges.ToListAsync(Arg.Any<CancellationToken>()).Returns(CompletedEdges(outbox).ToList());
        var articleRows = Substitute.For<ISugarQueryable<Article>>();
        db.Queryable<Article>().Returns(articleRows);
        articleRows.ClearFilter().Returns(articleRows);
        articleRows.Where(Arg.Any<Expression<Func<Article, bool>>>()).Returns(articleRows);
        var row = new Article
        {
            Id = authority.ArticleId,
            Title = "Fixture article",
            CategoryId = 2,
            Status = ArticleStatus.Published,
            IsDeleted = false,
            PublishedAt = s_now,
            CurrentRevisionId = 1501,
            CurrentPublicationId = 1801
        };
        articleRows.FirstAsync(Arg.Any<CancellationToken>()).Returns(row);
        var revisions = Substitute.For<ISugarQueryable<ArticleRevision>>();
        db.Queryable<ArticleRevision>().Returns(revisions);
        revisions.Where(Arg.Any<Expression<Func<ArticleRevision, bool>>>()).Returns(revisions);
        revisions.FirstAsync(Arg.Any<CancellationToken>()).Returns(new ArticleRevision
        {
            Id = 1501,
            ArticleId = row.Id,
            RevisionNo = 15,
            Title = row.Title,
            CategoryId = 2
        });
        var rightsRows = Substitute.For<ISugarQueryable<ArticleRightsSnapshot>>();
        db.Queryable<ArticleRightsSnapshot>().Returns(rightsRows);
        rightsRows.Where(Arg.Any<Expression<Func<ArticleRightsSnapshot, bool>>>()).Returns(rightsRows);
        var sealedRights = new ArticleRightsSnapshot
        {
            Id = 1601,
            ArticleId = row.Id,
            ArticleRevisionId = 1501,
            RevisionNo = 15,
            PolicyHash = Digest('d'),
            ContentCanonicalHash = Digest('c')
        };
        rightsRows.FirstAsync(Arg.Any<CancellationToken>()).Returns(sealedRights);
        CanonicalArticlePublicationReceipt publication = PublicationAuthority(authority);
        var publicationInvocation = new CanonicalArticlePublicationRequest(
            new CanonicalArticlePublicationFixtureBinding(
                publication.RunId, publication.Namespace, publication.ProfileId, ["public.article.publication"],
                publication.AdminPrincipalId, publication.WriterContractDigest, authority.TemporalContextDigest),
            new CanonicalArticlePublicationPlan(publication.SemanticRole, row.Title, Content, CategoryId: 2));
        var commands = Substitute.For<ISugarQueryable<ArticleMutationCommand>>();
        db.Queryable<ArticleMutationCommand>().Returns(commands);
        commands.Where(Arg.Any<Expression<Func<ArticleMutationCommand, bool>>>()).Returns(commands);
        var command = new ArticleMutationCommand
        {
            AdminPrincipalId = publication.AdminPrincipalId,
            ClientMutationId = CanonicalArticlePublicationFixturePort.DeriveClientMutationId(
                publicationInvocation.Binding.RunId, publicationInvocation.Binding.Namespace,
                publicationInvocation.Plan.SemanticRole).ToString("D"),
            RequestHash = CanonicalArticlePublicationFixturePort.ComputeRequestHash(publicationInvocation.Plan),
            ArticleId = row.Id,
            RevisionId = 1501,
            RevisionNo = 15,
            ReleaseId = scenario == "publication-command-stale" ? 1800 : 1801,
            ReleaseNo = 18,
            RightsSnapshotId = 1601,
            RightsRevisionNo = 15,
            Status = (int)ArticleStatus.Published
        };
        commands.ToListAsync(Arg.Any<CancellationToken>()).Returns(scenario switch
        {
            "publication-command-missing" => [],
            "publication-command-duplicate" => [command, command],
            _ => [command]
        });
        var publications = Substitute.For<ISugarQueryable<ArticlePublicationRecord>>();
        db.Queryable<ArticlePublicationRecord>().Returns(publications);
        publications.Where(Arg.Any<Expression<Func<ArticlePublicationRecord, bool>>>()).Returns(publications);
        publications.FirstAsync(Arg.Any<CancellationToken>()).Returns(new ArticlePublicationRecord
        {
            Id = scenario == "publication-reference-stale" ? 1800 : 1801,
            ArticleId = row.Id,
            ArticleRevisionId = 1501,
            RevisionNo = 15,
            PublicationNo = 18,
            RightsSnapshotId = 1601,
            ResponsibilitySnapshotId = 1701
        });
        var responsibilities = Substitute.For<ISugarQueryable<ArticleResponsibilitySnapshot>>();
        db.Queryable<ArticleResponsibilitySnapshot>().Returns(responsibilities);
        responsibilities.Where(Arg.Any<Expression<Func<ArticleResponsibilitySnapshot, bool>>>()).Returns(responsibilities);
        responsibilities.FirstAsync(Arg.Any<CancellationToken>()).Returns(new ArticleResponsibilitySnapshot
        {
            Id = 1701,
            ArticleId = row.Id,
            ArticleRevisionId = 1501,
            RevisionNo = 15,
            ResponsibilityVersion = 7
        });
        var audits = Substitute.For<ISugarQueryable<AuditLog>>();
        db.Queryable<AuditLog>().Returns(audits);
        audits.Where(Arg.Any<Expression<Func<AuditLog, bool>>>()).Returns(audits);
        audits.ToListAsync(Arg.Any<CancellationToken>()).Returns(new List<AuditLog>
        {
            new()
            {
                ChainId = publication.AuditChainId,
                RecordHash = scenario == "publication-audit-stale" ? "stale-audit" : publication.AuditRecordHash,
                TargetType = "article-canonical-publication", TargetId = row.Id.ToString(),
                ActorId = publication.AdminPrincipalId.ToString(), Outcome = "success",
                EventInfo = CanonicalArticlePublicationFixturePort.ComputeAuditDigest(
                    row.Id, 1501, 1801, 1601, 1701, publication.OutboxEventId)
            }
        });

        var search = Substitute.For<ISearchIndexService, ISearchProjectionEvidenceReader>();
        search.SearchAsync(row.Title).Returns(scenario == "search-failed" ? [] : new List<Article> { row });
        ((ISearchProjectionEvidenceReader)search).ReadAsync(row.Id, Arg.Any<CancellationToken>())
            .Returns(new SearchProjectionEvidence(
                "sealed-search-generation", s_now, Digest('1'), true, row.Id,
                1501, 15, 1801, 18, DigestText(row.Title), Digest('2')));
        ArticleDetailCoreModel detail = ArticleDetail(1501, Content, 1601);
        ReadOnlyMemory<byte> frame = new AedsEncoder().Encode(
            AedsFrameType.ArticleDetail,
            PodBinaryCodec.EncodeArticleDetail(scenario == "stale-frame"
                ? detail with
                {
                    CurrentRevisionId = 1500
                }
                : detail));
        var projection = Substitute.For<IPublicArticleProjectionStore>();
        projection.TryReadAsync(row.Id, Arg.Any<CancellationToken>()).Returns(
            new PublicArticleProjectionReadResult(
                PublicArticleProjectionReadStatus.Found, 23, frame, "\"current\"", s_now));
        var artifact = Substitute.For<IArticleDetailAedsArtifactStore>();
        artifact.TryReadAsync(row.Id, Arg.Any<CancellationToken>()).Returns(new ArticleDetailAedsArtifact(frame));
        var clock = new ProjectionTestTimeProvider();
        var hot = new PublicHotReadStore(timeProvider: clock);
        hot.Publish(new PublicHotReadSnapshot(
            23,
            new Dictionary<int, PublicBinaryArtifact>
            {
                [row.Id] = new(frame, "\"current\"", "public,max-age=60", 23, AedsFrameType.ArticleDetail)
            }.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default, default, FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(23, s_now)));
        var articles = Substitute.For<IArticleCoreGateway>();
        articles.GetByIdAsync(Arg.Any<ArticleDetailQuery>(), Arg.Any<CancellationToken>())
            .Returns(scenario == "detail-stale" ? detail with
            {
                CurrentRevisionId = 1500
            } : detail);
        articles.GetPageListAsync(Arg.Any<ArticlePageQuery>(), Arg.Any<CancellationToken>())
            .Returns(new CorePageResult<ArticleListCoreModel>([
                new(default, row.Id, scenario == "list-metadata" ? "stale title" : row.Title, null, null, null, 5, s_now,
                    detail.Category, [], false, (int)ArticleStatus.Published, null, s_now, 1501, 15, 1801, 18)
            ], 1));
        var aot = new InMemoryPublicAotInvalidationGenerationAuthority();
        if (scenario == "aot-wrong-target")
            await aot.MarkAsync("key", "unrelated-route", outbox.EventId, CancellationToken.None);
        else
            await new PublicAotInvalidationTracker(aot).MarkAllAsync(
                scenario == "stale-aot" ? "old-event" : outbox.EventId);
        var aotArtifacts = Substitute.For<IPublicAotArtifactStore>();
        var lookup = new PublicAotArtifactLookup("aot:article:1215:iv:1", "aot:article:", "assets", "prod-manifest", "zh-CN");
        aotArtifacts.CreateLookup(Arg.Any<HttpContext>(), Arg.Any<PublicAotRouteMatch>()).Returns(lookup);
        aotArtifacts.IsRenderable(Arg.Any<PublicAotCacheEntry>(), lookup).Returns(true);
        var actualRights = new Dictionary<string, object?>
        {
            ["snapshotId"] = scenario == "aot-document-stale-rights" ? "1600" : "1601",
            ["articleRevisionId"] = "1501",
            ["revisionNo"] = 15,
            ["enabled"] = sealedRights.Enabled,
            ["licenseType"] = sealedRights.LicenseType,
            ["copyrightHolder"] = sealedRights.CopyrightHolder,
            ["copyrightYear"] = sealedRights.CopyrightYear,
            ["rightsStatement"] = sealedRights.RightsStatement,
            ["attributionTemplate"] = sealedRights.AttributionTemplate,
            ["copyPolicy"] = sealedRights.CopyPolicy,
            ["maxExcerptChars"] = sealedRights.MaxExcerptChars,
            ["allowCodeCopy"] = sealedRights.AllowCodeCopy,
            ["showPublicBadge"] = sealedRights.ShowPublicBadge,
            ["proofBindingEnabled"] = sealedRights.ProofBindingEnabled,
            ["canonicalUrl"] = sealedRights.CanonicalUrl,
            ["policyHash"] = sealedRights.PolicyHash,
            ["contentCanonicalHash"] = sealedRights.ContentCanonicalHash
        };
        if (scenario == "aot-document-rights-policy")
        {
            actualRights["copyPolicy"] = "forged-copy-policy";
        }
        var aotArticle = new Dictionary<string, object?>
        {
            ["id"] = row.Id,
            ["currentRevisionId"] = "1501",
            ["revisionNo"] = 15,
            ["currentPublicationId"] = scenario == "aot-document-stale-publication" ? "1800" : "1801",
            ["publicationNo"] = 18,
            ["title"] = row.Title,
            ["summary"] = "",
            ["coverImageUrl"] = "",
            ["category"] = new Dictionary<string, object?> { ["id"] = 2 },
            ["tags"] = Array.Empty<object?>(),
            ["content"] = scenario == "aot-document-stale-content" ? "stale content" : Content,
            ["rights"] = actualRights
        };
        if (scenario == "aot-document-unsealed")
        {
            aotArticle.Remove("currentPublicationId");
            aotArticle.Remove("publicationNo");
        }
        string bootstrapPayload = PublicAotBinaryPayload.EncodeObject(
            new Dictionary<string, object?> { ["article"] = aotArticle });
        byte[] hydrationBytes = PublicAotBinaryPayload.EncodeObjectFrame(new Dictionary<string, object?>
        {
            ["articleId"] = row.Id,
            ["currentRevisionId"] = "1501",
            ["revisionNo"] = 15,
            ["currentPublicationId"] = scenario == "aot-hydration-stale-coordinates" ? "1800" : "1801",
            ["publicationNo"] = 18,
            ["title"] = row.Title,
            ["bodyContent"] = Content,
            ["rights"] = actualRights
        });
        string hydrationHash = Convert.ToHexStringLower(SHA256.HashData(hydrationBytes));
        string hydrationUrl = PublicAotDocumentComposer.BuildPayloadSidecarUrl(Convert.ToBase64String(hydrationBytes));
        string bootstrapScript = $"<script id=\"fsus-aot-bootstrap\" type=\"application/octet-stream\">{bootstrapPayload}</script>";
        string hydrationScript = $"<script id=\"fsus-aot-hydration-props\" type=\"application/octet-stream\" data-aeds-src=\"{hydrationUrl}\"></script>";
        string html = scenario switch
        {
            "aot-data-id" => (bootstrapScript + hydrationScript).Replace(" id=", " data-id=", StringComparison.Ordinal),
            "aot-comment" => "<!--" + bootstrapScript + hydrationScript + "-->",
            "aot-rawtext" => "<textarea>" + bootstrapScript + hydrationScript + "</textarea>",
            "aot-style-rawtext" => "<style>" + bootstrapScript + hydrationScript + "</style>",
            "aot-script-rawtext" => "<script>" + bootstrapScript + hydrationScript + "</script>",
            "aot-template" => "<template>" + bootstrapScript + hydrationScript + "</template>",
            "aot-noscript" => "<noscript>" + bootstrapScript + hydrationScript + "</noscript>",
            "aot-foreign-script" => "<svg>" + bootstrapScript + hydrationScript + "</svg>",
            "aot-duplicate-id" => "<div id=\"fsus-aot-bootstrap\"></div>" + bootstrapScript + hydrationScript,
            "aot-wrong-element" => bootstrapScript.Replace("script", "div", StringComparison.Ordinal) + hydrationScript,
            "aot-hydration-data-id" => bootstrapScript + hydrationScript.Replace(" id=", " data-id=", StringComparison.Ordinal),
            "aot-hydration-comment" => bootstrapScript + "<!--" + hydrationScript + "-->",
            "aot-hydration-rawtext" => bootstrapScript + "<textarea>" + hydrationScript + "</textarea>",
            "aot-hydration-inline-shadow" => bootstrapScript + hydrationScript.Replace("</script>",
                PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>
                {
                    ["articleId"] = row.Id,
                    ["bodyContent"] = "stale inline content"
                }) + "</script>", StringComparison.Ordinal),
            "aot-hydration-external-url" => bootstrapScript + hydrationScript.Replace(hydrationUrl,
                "https://external.invalid" + hydrationUrl, StringComparison.Ordinal),
            _ => bootstrapScript + hydrationScript
        };
        var aotEntry = new PublicAotCacheEntry
        {
            CacheKey = lookup.DocumentCacheKey,
            RouteKey = PublicRouteIdentity.BuildArticleRouteKey(row.Id),
            PageId = FsusBlog.Shared.Contracts.Outputs.PublicPageId.ArticleDetail,
            FrontendAssetVersion = "assets",
            ExpiresAtUtc = new DateTimeOffset(s_now.AddHours(1)),
            Value = html
        };
        aotArtifacts.TryGetEntryAsync(lookup, Arg.Any<CancellationToken>())
            .Returns(scenario == "aot-document-missing" ? null : aotEntry);
        if (scenario == "aot-cold-wait")
        {
            aotArtifacts.TryGetEntryAsync(lookup, Arg.Any<CancellationToken>()).Returns(
                Task.FromResult<PublicAotCacheEntry?>(null), Task.FromResult<PublicAotCacheEntry?>(aotEntry));
        }
        CancellationToken? sharedConvergenceToken = null;
        int sharedAotReads = 0;
        if (scenario == "aot-shared-budget")
        {
            aotArtifacts.TryGetEntryAsync(lookup, Arg.Any<CancellationToken>()).Returns(call =>
            {
                Assert.True(sharedConvergenceToken.HasValue);
                Assert.Equal(sharedConvergenceToken.Value, call.Arg<CancellationToken>());
                return Task.FromResult<PublicAotCacheEntry?>(++sharedAotReads == 1 ? null : aotEntry);
            });
        }
        var neverCompletingRead = new TaskCompletionSource<PublicAotCacheEntry?>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (scenario == "aot-never-completes")
        {
            aotArtifacts.TryGetEntryAsync(lookup, Arg.Any<CancellationToken>()).Returns(neverCompletingRead.Task);
        }
        var publicArtifacts = Substitute.For<IPublicArtifactStorage>();
        PublicArtifactKey hydrationKey = PublicArtifactKey.HydrationSidecar(aotEntry.RouteKey, hydrationHash, "assets");
        publicArtifacts.TryReadAsync(hydrationKey, LocalPublicArtifactStorage.AedsMediaType, hydrationHash, Arg.Any<CancellationToken>())
            .Returns(scenario == "aot-hydration-missing" ? null : new PublicArtifactReadResult(
                new PublicArtifactDescriptor(hydrationKey, LocalPublicArtifactStorage.AedsMediaType, hydrationHash, hydrationBytes.Length),
                hydrationBytes));
        var requestContext = Substitute.For<IHttpContextAccessor>();
        requestContext.HttpContext.Returns(new DefaultHttpContext());
        var revocations = new PublicArtifactRevocationRegistry();
        revocations.Clear(new PublicArtifactTombstone(row.Id, 23, new DateTimeOffset(s_now).ToUnixTimeMilliseconds()));
        var revocationState = Substitute.For<IPublicArtifactRevocationStateStore>();
        revocationState.LoadActiveAsync(Arg.Any<CancellationToken>())
            .Returns(Array.Empty<PublicArtifactTombstone>());
        var cache = Substitute.For<ICacheStringReader>();
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns(scenario == "cache-missing" ? null : "23");
        var verifier = new CanonicalArticleProjectionVerifier(
            db, search, articles, projection, artifact, hot, aot, aotArtifacts, publicArtifacts, requestContext,
            revocations, revocationState, cache, new DefaultRuntimeKeyScope(), clock);
        var currentInvocation = new CanonicalArticleLifecycleFixtureBinding(
            authority.RunId, authority.Namespace, authority.ProfileId, ["public.article.multiple-publications"],
            authority.AdminPrincipalId, authority.WriterContractDigest, authority.TemporalContextDigest);
        if (scenario == "latest-metadata")
            row.Title = "latest mutable title";
        if (scenario == "lifecycle-relabel")
        {
            authority = authority with
            {
                RunId = "relabeled-run",
                Namespace = "relabeled-namespace"
            };
            authority = authority with
            {
                ReceiptDigest = CanonicalArticleLifecycleFixturePort.ComputeReceiptDigest(
                    authority.WriterContractDigest, authority.TemporalContextDigest,
                    authority.RunId, authority.Namespace, authority.ProfileId, authority.SemanticRole,
                    authority.Variant, authority.AdminPrincipalId, authority.ArticleId, authority.Operations,
                    authority.RevisionIds, authority.PublicationIds, authority.CurrentRevisionId,
                    authority.CurrentPublicationId, authority.CurrentStatus, authority.IsDeleted,
                    authority.ContentDigest, authority.RevisionTimelineDigest)
            };
        }
        if (scenario is "publication-relabel" or "publication-relabel-invocation")
        {
            publication = publication with
            {
                RunId = "relabeled-run",
                Namespace = "relabeled-namespace"
            };
            if (scenario == "publication-relabel-invocation")
            {
                publicationInvocation = publicationInvocation with
                {
                    Binding = publicationInvocation.Binding with
                    {
                        RunId = publication.RunId,
                        Namespace = publication.Namespace
                    }
                };
            }
        }

        using var callerBudget = new CancellationTokenSource();
        if (awaitCurrentOutput)
        {
            callerBudget.CancelAfter(expectedViolation == "caller-budget-cancelled"
                ? TimeSpan.FromMilliseconds(50) : TimeSpan.FromSeconds(5));
            if (scenario == "aot-caller-cancelled")
                callerBudget.Cancel();
        }
        Task<CanonicalArticleProjectionOutputAggregate> Observe()
        {
            if (awaitCurrentOutput)
            {
                if (scenario == "aot-shared-budget")
                {
                    var obligations = Substitute.For<IPublicHotArtifactObligationStore>();
                    obligations.HasTerminalFailureAsync(Arg.Any<CancellationToken>()).Returns(call =>
                    {
                        sharedConvergenceToken = call.Arg<CancellationToken>();
                        return Task.FromResult(false);
                    });
                    obligations.GetActiveAsync(Arg.Any<CancellationToken>()).Returns(new PublicHotArtifactObligation(
                        "bound-obligation", 23, default, [row.Id], false, new Dictionary<int, long> { [row.Id] = 1801 },
                        1, PublicHotArtifactObligationState.Published, PublicHotArtifactFailureKind.None, s_now, [], 23));
                    return PublicContentFixtureSeeder.AwaitCanonicalArticleProjectionAsync(
                        obligations, token => verifier.VerifyAsync(authority, currentInvocation, token),
                        TimeSpan.FromSeconds(5), callerBudget.Token);
                }
                return scenario.StartsWith("publication", StringComparison.Ordinal)
                    ? verifier.AwaitCurrentOutputAsync(publication, publicationInvocation,
                        PublicContentFixtureSeeder.s_projectionConvergencePollInterval, callerBudget.Token)
                    : verifier.AwaitCurrentOutputAsync(authority, currentInvocation,
                        PublicContentFixtureSeeder.s_projectionConvergencePollInterval, callerBudget.Token);
            }
            return scenario.StartsWith("publication", StringComparison.Ordinal)
                ? verifier.VerifyAsync(publication, publicationInvocation)
                : verifier.VerifyAsync(authority, currentInvocation);
        }

        if (expectedViolation == "caller-budget-cancelled")
        {
            try
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(Observe);
                Assert.True(callerBudget.IsCancellationRequested);
                if (scenario == "aot-caller-cancelled")
                    await aotArtifacts.DidNotReceive().TryGetEntryAsync(lookup, Arg.Any<CancellationToken>());
            }
            finally
            {
                // Settle the simulated reader; cancellation never makes its unfinished
                // observation qualify or leaves test-owned work running after this fixture.
                neverCompletingRead.TrySetCanceled(callerBudget.Token);
            }
            return;
        }

        if (expectedViolation is not null)
        {
            CanonicalArticleProjectionVerificationException error = await Assert.ThrowsAsync<
                CanonicalArticleProjectionVerificationException>(Observe);
            Assert.Contains(error.Violations, violation => violation.StartsWith(expectedViolation, StringComparison.Ordinal));
            if (awaitCurrentOutput)
                await aotArtifacts.Received(1).TryGetEntryAsync(lookup, Arg.Any<CancellationToken>());
            return;
        }

        CanonicalArticleProjectionOutputAggregate aggregate = await Observe();
        if (verifyAggregate)
        {
            if (scenario == "publication")
                await verifier.VerifyAggregateAsync(aggregate, publication, publicationInvocation);
            else
                CanonicalArticleProjectionVerifier.VerifyAggregate(aggregate, authority);
        }
        Assert.Empty(aggregate.Failures);
        Assert.Equal(ArticleMutationReplayEdges.Required.Count, aggregate.Edges.Count);
        Assert.All(aggregate.Edges, edge =>
        {
            Assert.Equal(outbox.EventId, edge.EventId);
            Assert.Equal(1801, edge.Coordinates.PublicationId);
            Assert.Equal(CanonicalArticleProjectionVerifier.ComputeTerminalReceiptDigest(edge), edge.TerminalReceiptDigest);
        });
        Assert.Equal(CanonicalArticleProjectionVerifier.ComputeAggregateDigest(aggregate), aggregate.AggregateDigest);
        int readCount = scenario is "aot-cold-wait" or "aot-shared-budget"
            || (verifyAggregate && scenario == "publication") ? 2 : 1;
        await projection.Received(readCount).TryReadAsync(row.Id, Arg.Any<CancellationToken>());
        await artifact.Received(readCount).TryReadAsync(row.Id, Arg.Any<CancellationToken>());
        await cache.Received(readCount).GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>());
        await aotArtifacts.Received(readCount).TryGetEntryAsync(lookup, Arg.Any<CancellationToken>());
        await publicArtifacts.Received(readCount).TryReadAsync(hydrationKey, LocalPublicArtifactStorage.AedsMediaType, hydrationHash, Arg.Any<CancellationToken>());
    }

    private sealed class ProjectionTestTimeProvider : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(s_now);
    }

    [Fact]
    public void ReceiptDigests_MatchNodeGoldenEnvelopeIncludingEscapedIdentifiers()
    {
        var coordinates = new CanonicalArticleProjectionCoordinates(1215, 1501, 15, 1801, 18, 1601, 1701, 7);
        string digest = Digest('a');
        var edge = new CanonicalArticleProjectionEdgeObservation(
            "event-中文+\"\\\n😀", 2, "search-projection", "production-outbox:search-projection",
            "completed", 1, 23, new string('b', 64), digest, digest, coordinates, string.Empty);
        edge = edge with
        {
            TerminalReceiptDigest = CanonicalArticleProjectionVerifier.ComputeTerminalReceiptDigest(edge)
        };
        Assert.Equal("sha256:b0741ceea3ac62eb4e3c548b14b47df32e96320d8b51e9e110ea4ad1018e1d8d", edge.TerminalReceiptDigest);
        var aggregate = new CanonicalArticleProjectionOutputAggregate(
            CanonicalArticleProjectionVerifier.Schema, "run-中文+\"\\\n😀", "ns", digest,
            ArticleMutationReplayEdges.ContractId, ["search-projection"], coordinates, true,
            digest, digest, digest, digest, digest, digest, digest, digest, digest, [edge], [], string.Empty);
        Assert.Equal("sha256:d06e3e08780c2f137db42ee431d626366313e73dcbe36af34a742d4b86dd7bb6",
            CanonicalArticleProjectionVerifier.ComputeAggregateDigest(aggregate));
    }

    [Fact]
    public void OutboxState_UsesProductionRequiredSetAndAcceptsExactCompletedVector()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        IReadOnlyList<ArticleMutationOutboxEdge> edges = CompletedEdges(outbox);

        IReadOnlyList<string> violations =
            CanonicalArticleProjectionVerifier.VerifyOutboxStateForTests(
                authority,
                [outbox],
                edges);

        Assert.Empty(violations);
        Assert.Equal(
            ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal),
            edges.Select(static edge => edge.EdgeName).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void OutboxState_AcceptsProductionOptionalEdgesWithoutMakingThemRequired()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        var edges = CompletedEdges(outbox).Concat(ArticleMutationReplayEdges.Optional.Select(
            edgeName => new ArticleMutationOutboxEdge
            {
                OutboxEventId = outbox.Id,
                EdgeName = edgeName,
                Status = ArticleMutationOutboxEdgeStatus.Failed,
                AttemptCount = 1,
                LastError = "optional delivery failed"
            })).ToArray();

        Assert.Empty(CanonicalArticleProjectionVerifier.VerifyOutboxStateForTests(
            authority, [outbox], edges));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("failed")]
    [InlineData("skipped-current")]
    [InlineData("delivery-key")]
    [InlineData("zero-attempt")]
    [InlineData("duplicate")]
    [InlineData("unexpected")]
    public void OutboxState_RejectsNonExactOrNonSuccessfulCurrentEdge(string fault)
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        List<ArticleMutationOutboxEdge> edges = CompletedEdges(outbox).ToList();
        ArticleMutationOutboxEdge target = edges[0];
        switch (fault)
        {
            case "missing":
                edges.RemoveAt(0);
                break;
            case "failed":
                target.Status = ArticleMutationOutboxEdgeStatus.Failed;
                target.LastError = "projection failed";
                break;
            case "skipped-current":
                target.Status = ArticleMutationOutboxEdgeStatus.Skipped;
                break;
            case "delivery-key":
                target.DeliveryKey = new string('0', 64);
                break;
            case "zero-attempt":
                target.AttemptCount = 0;
                break;
            case "duplicate":
                edges.Add(target);
                break;
            case "unexpected":
                edges.Add(new ArticleMutationOutboxEdge
                {
                    Id = 999,
                    OutboxEventId = outbox.Id,
                    EdgeName = "manual-repair",
                    Status = ArticleMutationOutboxEdgeStatus.Completed,
                    AttemptCount = 1,
                    UpdatedAt = s_now,
                    DeliveryKey = ArticleMutationDeliveryKey.Build(outbox.EventId, "manual-repair")
                });
                break;
        }

        IReadOnlyList<string> violations =
            CanonicalArticleProjectionVerifier.VerifyOutboxStateForTests(
                authority,
                [outbox],
                edges);

        Assert.NotEmpty(violations);
    }

    [Fact]
    public void OutboxState_AcceptsOnlyProductionSupersededReasonForHistoricalSkippedEdges()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent currentOutbox) = Fixture();
        var historicalVersion = new ArticleVersionCoordinates(
            RevisionId: 1500,
            RevisionNo: 14,
            RightsSnapshotId: 1600,
            ResponsibilitySnapshotId: 1700,
            PublicationId: 1800,
            PublicationNo: 17,
            ResponsibilityVersion: 6);
        var scope = new ArticleMutationScopeSnapshot(2, [3, 4], "published");
        ArticleMutationOutboxEvent historicalOutbox = ArticleMutationOutboxProducer.Create(
            1215,
            ArticleMutationEventTypes.Updated,
            historicalVersion,
            scope,
            scope,
            s_now.AddSeconds(-1),
            s_now.AddSeconds(-1));
        historicalOutbox.Id = 90;
        historicalOutbox.Status = "processed";
        historicalOutbox.ProcessedAt = s_now;
        CanonicalArticleLifecycleOperationReceipt currentOperation = authority.Operations[^1];
        CanonicalArticleLifecycleOperationReceipt historicalOperation = currentOperation with
        {
            TransitionId = "transition-0",
            BeforeRevisionId = 1499,
            BeforeRevisionNo = 13,
            AfterRevisionId = 1500,
            AfterRevisionNo = 14,
            BeforePublicationId = 1799,
            BeforePublicationNo = 16,
            AfterPublicationId = 1800,
            AfterPublicationNo = 17,
            RightsSnapshotId = 1600,
            ResponsibilitySnapshotId = 1700,
            ResponsibilityVersion = 6,
            TransitionedAtUtc = s_now.AddSeconds(-1),
            OutboxEventId = historicalOutbox.EventId,
            OutboxPayloadDigest =
                CanonicalArticleLifecycleFixturePort.ComputeOutboxPayloadDigest(historicalOutbox.PayloadJson)
        };
        authority = authority with
        {
            Operations = [historicalOperation, currentOperation],
            RevisionIds = [1500, 1501],
            PublicationIds = [1800, 1801]
        };
        List<ArticleMutationOutboxEdge> historicalEdges = CompletedEdges(historicalOutbox).ToList();
        foreach (ArticleMutationOutboxEdge edge in historicalEdges)
        {
            edge.Status = ArticleMutationOutboxEdgeStatus.Skipped;
            edge.LastError = "superseded-by-release:1801";
        }
        List<ArticleMutationOutboxEdge> allEdges =
        [
            .. historicalEdges,
            .. CompletedEdges(currentOutbox)
        ];

        IReadOnlyList<string> accepted =
            CanonicalArticleProjectionVerifier.VerifyOutboxStateForTests(
                authority,
                [historicalOutbox, currentOutbox],
                allEdges);

        Assert.Empty(accepted);

        historicalEdges[0].LastError = "superseded-by-release:99999";
        Assert.NotEmpty(CanonicalArticleProjectionVerifier.VerifyOutboxStateForTests(
            authority, [historicalOutbox, currentOutbox], allEdges));

        historicalEdges[0].LastError = "superseded-by-manual:1801";
        IReadOnlyList<string> rejected =
            CanonicalArticleProjectionVerifier.VerifyOutboxStateForTests(
                authority,
                [historicalOutbox, currentOutbox],
                allEdges);

        Assert.Contains(
            rejected,
            violation => violation.StartsWith(
                $"required_edge_not_terminal_success:{historicalOutbox.EventId}:",
                StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("missing-outbox")]
    [InlineData("duplicate-outbox")]
    [InlineData("poison")]
    [InlineData("payload-latest")]
    public void OutboxState_RejectsMissingDuplicatePoisonAndUnsealedCoordinates(string fault)
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        IReadOnlyList<ArticleMutationOutboxEvent> events = [outbox];
        if (fault == "missing-outbox")
        {
            events = [];
        }
        else if (fault == "duplicate-outbox")
        {
            events = [outbox, Clone(outbox)];
        }
        else if (fault == "poison")
        {
            outbox.Status = "poison";
            outbox.ProcessedAt = null;
            outbox.LastError = "recovery required";
        }
        else
        {
            outbox.ArticleRevisionId++;
            outbox.RevisionNo++;
        }

        IReadOnlyList<string> violations =
            CanonicalArticleProjectionVerifier.VerifyOutboxStateForTests(
                authority,
                events,
                CompletedEdges(outbox));

        Assert.NotEmpty(violations);
    }

    [Fact]
    public async Task Aggregate_AcceptsSealedLifecycleAndPublicationAuthorities()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        CanonicalArticleProjectionVerifier.VerifyAggregate(aggregate, authority);

        // Publication's run/namespace are not sealed by the original receipt digest.
        // The positive must use the original current invocation and actual read ports.
        await ReadBoundOutputsScenarioAsync("publication", null, verifyAggregate: true);
        CanonicalArticlePublicationReceipt publication = PublicationAuthority(authority);
        Assert.Empty(CanonicalArticleProjectionVerifier.VerifyOutboxStateForTests(
            publication, [outbox], CompletedEdges(outbox)));
    }

    [Fact]
    public void Aggregate_RejectsTamperedInputAuthorityBeforeTrustingOutputs()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        Assert.Throws<CanonicalArticleProjectionVerificationException>(() =>
            CanonicalArticleProjectionVerifier.VerifyAggregate(
                aggregate, authority with
                {
                    ContentDigest = Digest('0')
                }));
        CanonicalArticlePublicationReceipt publication = PublicationAuthority(authority);
        Assert.Throws<CanonicalArticleProjectionVerificationException>(() =>
            CanonicalArticleProjectionVerifier.VerifyAggregate(
                aggregate, publication with
                {
                    ReceiptDigest = Digest('0')
                }));
    }

    [Fact]
    public void Aggregate_RejectsRelabeledPublicationAuthorityEvenWithResealedAggregate()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticlePublicationReceipt publication = PublicationAuthority(authority);
        CanonicalArticleProjectionOutputAggregate original = Aggregate(authority, outbox);
        foreach ((string runId, string ns) in new[]
        {
            (publication.RunId, publication.Namespace),
            ("relabeled-run", publication.Namespace),
            (publication.RunId, "relabeled-namespace"),
            ("relabeled-run", "relabeled-namespace")
        })
        {
            CanonicalArticlePublicationReceipt relabeled = publication with
            {
                RunId = runId,
                Namespace = ns
            };
            CanonicalArticleProjectionOutputAggregate aggregate = original with
            {
                RunId = runId,
                Namespace = ns,
                AuthorityReceiptDigest = relabeled.ReceiptDigest
            };
            aggregate = aggregate with
            {
                AggregateDigest = CanonicalArticleProjectionVerifier.ComputeAggregateDigest(aggregate)
            };
            CanonicalArticleProjectionVerificationException error = Assert.Throws<
                CanonicalArticleProjectionVerificationException>(() =>
                    CanonicalArticleProjectionVerifier.VerifyAggregate(aggregate, relabeled));
            Assert.Contains("publication_current_run_binding_missing", error.Violations);
        }
    }

    [Fact]
    public void Aggregate_RejectsRequiredSetAndTerminalEdgeDeletionEvenWhenResealed()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        aggregate = aggregate with
        {
            RequiredEdges = aggregate.RequiredEdges.Skip(1).ToArray(),
            Edges = aggregate.Edges.Skip(1).ToArray()
        };
        aggregate = aggregate with
        {
            AggregateDigest = CanonicalArticleProjectionVerifier.ComputeAggregateDigest(aggregate)
        };
        CanonicalArticleProjectionVerificationException error = Assert.Throws<
            CanonicalArticleProjectionVerificationException>(() =>
                CanonicalArticleProjectionVerifier.VerifyAggregate(aggregate, authority));
        Assert.Contains("projection_aggregate_required_edges_mismatch", error.Violations);
        Assert.Contains("projection_aggregate_terminal_vector_mismatch", error.Violations);
    }

    [Fact]
    public void Aggregate_RejectsResealedEdgeVersionAndOutputSubstitution()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        CanonicalArticleProjectionEdgeObservation edge = aggregate.Edges[0] with
        {
            EventVersion = 1,
            OutputDigest = Digest('0')
        };
        edge = edge with
        {
            TerminalReceiptDigest = CanonicalArticleProjectionVerifier.ComputeTerminalReceiptDigest(edge)
        };
        aggregate = aggregate with
        {
            Edges = [edge, .. aggregate.Edges.Skip(1)]
        };
        aggregate = aggregate with
        {
            AggregateDigest = CanonicalArticleProjectionVerifier.ComputeAggregateDigest(aggregate)
        };

        CanonicalArticleProjectionVerificationException error = Assert.Throws<
            CanonicalArticleProjectionVerificationException>(() =>
                CanonicalArticleProjectionVerifier.VerifyAggregate(aggregate, authority));

        Assert.Contains("projection_aggregate_edge_receipt_invalid", error.Violations);
        Assert.Contains("projection_edge_output_digest_mismatch", error.Violations);
    }

    [Fact]
    public void Aggregate_RejectsCrossRunLatestReceiptEvenWhenResealed()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        CanonicalArticleProjectionOutputAggregate crossRun = aggregate with
        {
            RunId = "different-run",
            AggregateDigest = string.Empty
        };
        crossRun = crossRun with
        {
            AggregateDigest = CanonicalArticleProjectionVerifier.ComputeAggregateDigest(crossRun)
        };

        CanonicalArticleProjectionVerificationException error = Assert.Throws<
            CanonicalArticleProjectionVerificationException>(
            () => CanonicalArticleProjectionVerifier.VerifyAggregate(crossRun, authority));

        Assert.Contains("projection_aggregate_authority_binding_mismatch", error.Violations);
    }

    [Fact]
    public void Aggregate_RejectsEdgeAndAggregateTamper()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        CanonicalArticleProjectionEdgeObservation[] edges = aggregate.Edges.ToArray();
        edges[0] = edges[0] with
        {
            OutputDigest = Digest('b')
        };
        CanonicalArticleProjectionOutputAggregate tampered = aggregate with
        {
            Edges = edges
        };

        CanonicalArticleProjectionVerificationException error = Assert.Throws<
            CanonicalArticleProjectionVerificationException>(
            () => CanonicalArticleProjectionVerifier.VerifyAggregate(tampered, authority));

        Assert.Contains("projection_edge_receipt_tamper_detected", error.Violations);
        Assert.Contains("projection_aggregate_digest_tamper_detected", error.Violations);
    }

    [Theory]
    [InlineData("timeout-warning")]
    [InlineData("cancelled")]
    [InlineData("poison")]
    [InlineData("recovery-required")]
    public void Aggregate_RejectsFailureWarningAndIncompleteTerminalVector(string failure)
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        CanonicalArticleProjectionOutputAggregate failed = aggregate with
        {
            Edges = aggregate.Edges.Skip(1).ToArray(),
            Failures = [failure],
            AggregateDigest = string.Empty
        };
        failed = failed with
        {
            AggregateDigest = CanonicalArticleProjectionVerifier.ComputeAggregateDigest(failed)
        };

        CanonicalArticleProjectionVerificationException error = Assert.Throws<
            CanonicalArticleProjectionVerificationException>(
            () => CanonicalArticleProjectionVerifier.VerifyAggregate(failed, authority));

        Assert.Contains("projection_aggregate_contains_failures", error.Violations);
        Assert.Contains("projection_aggregate_terminal_vector_mismatch", error.Violations);
    }

    [Fact]
    public void Aggregate_RejectsResealedOutputAndCurrentCoordinateSubstitution()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        CanonicalArticleProjectionOutputAggregate substituted = aggregate with
        {
            ContentDigest = Digest('0'),
            SearchDigest = "not-a-digest",
            CurrentCoordinates = aggregate.CurrentCoordinates with
            {
                RevisionId = 9999
            },
            AggregateDigest = string.Empty
        };
        substituted = substituted with
        {
            AggregateDigest = CanonicalArticleProjectionVerifier.ComputeAggregateDigest(substituted)
        };

        CanonicalArticleProjectionVerificationException error = Assert.Throws<
            CanonicalArticleProjectionVerificationException>(
            () => CanonicalArticleProjectionVerifier.VerifyAggregate(substituted, authority));

        Assert.Contains("projection_aggregate_authority_binding_mismatch", error.Violations);
        Assert.Contains("projection_aggregate_output_digest_invalid", error.Violations);
        Assert.Contains("projection_aggregate_edge_authority_binding_mismatch", error.Violations);
    }

    [Theory]
    [InlineData("search-query", "search_visibility_mismatch")]
    [InlineData("search-coordinate", "search_projection_coordinate_mismatch")]
    [InlineData("aeds-frame", "aeds_hot_read_frame_digest_mismatch")]
    [InlineData("hot-publication", "hot_read_publication_evidence_invalid")]
    [InlineData("detail-coordinate", "public_detail_coordinate_mismatch")]
    [InlineData("list-coordinate", "public_list_coordinate_mismatch")]
    [InlineData("aot-event", "aot_event_binding_mismatch")]
    public void ProjectionConsistency_RejectsStaleOrDisagreeingProductionOutputs(
        string fault,
        string expectedViolation)
    {
        CanonicalArticleProjectionConsistencyEvidence evidence = ConsistencyEvidence();
        evidence = fault switch
        {
            "search-query" => evidence with
            {
                SearchQueryFound = false
            },
            "search-coordinate" => evidence with
            {
                SearchEvidence = evidence.SearchEvidence with
                {
                    PublicationId = 1800
                }
            },
            "aeds-frame" => evidence with
            {
                AedsArtifactFrameDigest = Digest('0')
            },
            "hot-publication" => evidence with
            {
                HotReadPublicationVerified = false
            },
            "detail-coordinate" => evidence with
            {
                DetailCoordinates = evidence.DetailCoordinates! with
                {
                    RevisionId = 1500
                }
            },
            "list-coordinate" => evidence with
            {
                ListCoordinates = evidence.ListCoordinates! with
                {
                    PublicationNo = 17
                }
            },
            "aot-event" => evidence with
            {
                AotLastMutationId = "stale-event"
            },
            _ => throw new ArgumentOutOfRangeException(nameof(fault), fault, null)
        };

        IReadOnlyList<string> violations =
            CanonicalArticleProjectionVerifier.VerifyProjectionConsistencyForTests(evidence);

        Assert.Contains(expectedViolation, violations);
    }

    [Theory]
    [InlineData("invalid", "aeds_article_detail_frame_invalid")]
    [InlineData("coordinate", "aeds_article_detail_coordinate_mismatch")]
    [InlineData("content", "aeds_article_detail_content_digest_mismatch")]
    [InlineData("rights", "aeds_article_detail_rights_mismatch")]
    public void AedsArticleDetail_RejectsInvalidOrStaleSemanticPayload(
        string fault,
        string expectedViolation)
    {
        var coordinates = new CanonicalArticleProjectionCoordinates(
            1215,
            1501,
            15,
            1801,
            18,
            1601,
            1701,
            7);
        ArticleDetailCoreModel detail = ArticleDetail(
            revisionId: fault == "coordinate" ? 1500 : 1501,
            content: fault == "content" ? "stale content" : "current content",
            rightsSnapshotId: fault == "rights" ? 1600 : 1601);
        ReadOnlyMemory<byte> frame = fault == "invalid"
            ? new byte[] { 0x01, 0x02 }
            : new AedsEncoder().Encode(
                AedsFrameType.ArticleDetail,
                PodBinaryCodec.EncodeArticleDetail(detail));

        IReadOnlyList<string> violations =
            CanonicalArticleProjectionVerifier.VerifyAedsArticleDetailFrameForTests(
                frame,
                coordinates,
                DigestText("current content"));

        Assert.Contains(expectedViolation, violations);
    }

    [Fact]
    public void Aggregate_RejectsResealedEdgeAuthoritySubstitution()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        CanonicalArticleProjectionEdgeObservation[] edges = aggregate.Edges.ToArray();
        edges[0] = edges[0] with
        {
            EventId = "cross-run-event",
            InputDigest = Digest('0'),
            DeliveryKey = new string('0', 64),
            TerminalReceiptDigest = string.Empty
        };
        edges[0] = edges[0] with
        {
            TerminalReceiptDigest =
                CanonicalArticleProjectionVerifier.ComputeTerminalReceiptDigest(edges[0])
        };
        CanonicalArticleProjectionOutputAggregate substituted = aggregate with
        {
            Edges = edges,
            AggregateDigest = string.Empty
        };
        substituted = substituted with
        {
            AggregateDigest = CanonicalArticleProjectionVerifier.ComputeAggregateDigest(substituted)
        };

        CanonicalArticleProjectionVerificationException error = Assert.Throws<
            CanonicalArticleProjectionVerificationException>(
            () => CanonicalArticleProjectionVerifier.VerifyAggregate(substituted, authority));

        Assert.Contains("projection_aggregate_edge_authority_binding_mismatch", error.Violations);
    }

    [Fact]
    public void SearchEvidenceReader_ReadsExactPublishedDocumentCoordinates()
    {
        byte[] artifact = SearchArtifact(
            articleId: 1215,
            title: "sealed search document",
            revisionId: 1501,
            revisionNo: 15,
            publicationId: 1801,
            publicationNo: 18);

        SearchIndexService.SearchProjectionDocumentTestEvidence evidence =
            Assert.IsType<SearchIndexService.SearchProjectionDocumentTestEvidence>(
                SearchIndexService.ReadDocumentEvidenceForTests(artifact, 1215));

        Assert.Equal("sealed search document", evidence.Title);
        Assert.Equal(1501, evidence.RevisionId);
        Assert.Equal(15, evidence.RevisionNo);
        Assert.Equal(1801, evidence.PublicationId);
        Assert.Equal(18, evidence.PublicationNo);
        Assert.Null(SearchIndexService.ReadDocumentEvidenceForTests(artifact, 1216));
    }

    [Fact]
    public void SearchEvidenceReader_RejectsExistenceOnlyArtifactWithInvalidBounds()
    {
        byte[] artifact = SearchArtifact(
            articleId: 1215,
            title: "sealed search document",
            revisionId: 1501,
            revisionNo: 15,
            publicationId: 1801,
            publicationNo: 18);
        BinaryPrimitives.WriteUInt32LittleEndian(artifact.AsSpan(56), uint.MaxValue);

        Assert.Throws<InvalidDataException>(
            () => SearchIndexService.ReadDocumentEvidenceForTests(artifact, 1215));
    }

    [Fact]
    public void SearchEvidenceReader_RejectsMetadataOverlappingStringPool()
    {
        byte[] artifact = SearchArtifact(
            articleId: 1215,
            title: "sealed search document",
            revisionId: 1501,
            revisionNo: 15,
            publicationId: 1801,
            publicationNo: 18);
        BinaryPrimitives.WriteUInt32LittleEndian(artifact.AsSpan(56), 64);

        Assert.Throws<InvalidDataException>(
            () => SearchIndexService.ReadDocumentEvidenceForTests(artifact, 1215));
    }

    [Fact]
    public void SearchEvidenceReader_RejectsInvalidStringPoolEvenWhenArticleIsAbsent()
    {
        byte[] artifact = SearchArtifact(1215, "sealed document", 1501, 15, 1801, 18);
        BinaryPrimitives.WriteUInt32LittleEndian(artifact.AsSpan(56), checked((uint)artifact.Length + 1));
        Assert.Throws<InvalidDataException>(
            () => SearchIndexService.ReadDocumentEvidenceForTests(artifact, 1216));
    }

    [Fact]
    public void PreparedProjectionProof_SealsIndependentInvocationAndRejectsPlanSubstitution()
    {
        PublicContentVerificationSnapshot snapshot = PreparedInvocationSnapshot();
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        string payload = JsonSerializer.Serialize(snapshot, json);
        var proof = new PublicContentVerificationProof(payload,
            PublicContentFixtureSeeder.ComputeVerificationMac(payload, "task-only-projection-key"));
        PublicContentVerificationSnapshot opened = PublicContentFixtureSeeder.OpenVerificationProof(
            new(snapshot.Identity, proof), "task-only-projection-key");
        int articleId = snapshot.Publications[0].ArticleId;

        PublicContentPublicationInvocation publication = PublicContentFixtureSeeder.RequirePublicationInvocation(opened, articleId);
        PublicContentLifecycleInvocation lifecycle = PublicContentFixtureSeeder.RequireLifecycleInvocation(opened, articleId);
        Assert.Equal("Independent invocation bytes", publication.Request.Plan.Content);
        Assert.Equal(snapshot.PublicationInvocations![0].Request.Binding.RunId, publication.Request.Binding.RunId);
        Assert.Equal(snapshot.LifecycleInvocations![0].Binding.TemporalContextDigest, lifecycle.Binding.TemporalContextDigest);
        Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.OpenVerificationProof(
            new(snapshot.Identity, proof with
            {
                Payload = payload.Replace("Independent invocation bytes", "Substituted invocation bytes", StringComparison.Ordinal)
            }), "task-only-projection-key"));
    }

    [Theory]
    [InlineData("publication", "missing")]
    [InlineData("publication", "duplicate")]
    [InlineData("publication", "foreign")]
    [InlineData("publication", "extra")]
    [InlineData("lifecycle", "missing")]
    [InlineData("lifecycle", "duplicate")]
    [InlineData("lifecycle", "foreign")]
    [InlineData("lifecycle", "extra")]
    public void PreparedProjectionProof_RejectsNonExactOriginalInvocationRoster(string kind, string fault)
    {
        PublicContentVerificationSnapshot snapshot = PreparedInvocationSnapshot();
        int articleId = snapshot.Publications[0].ArticleId;
        if (kind == "publication")
        {
            PublicContentPublicationInvocation original = snapshot.PublicationInvocations![0];
            snapshot = snapshot with
            {
                PublicationInvocations = fault switch
                {
                    "missing" => null,
                    "duplicate" => [original, original],
                    "foreign" => [original with { ArticleId = articleId + 1 }],
                    _ => [original, original with { ArticleId = articleId + 1 }]
                }
            };
            Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.RequirePublicationInvocation(snapshot, articleId));
        }
        else
        {
            PublicContentLifecycleInvocation original = snapshot.LifecycleInvocations![0];
            snapshot = snapshot with
            {
                LifecycleInvocations = fault switch
                {
                    "missing" => null,
                    "duplicate" => [original, original],
                    "foreign" => [original with { ArticleId = articleId + 1 }],
                    _ => [original, original with { ArticleId = articleId + 1 }]
                }
            };
            Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.RequireLifecycleInvocation(snapshot, articleId));
        }
    }

    private static PublicContentVerificationSnapshot PreparedInvocationSnapshot()
    {
        var (authority, _) = Fixture();
        CanonicalArticlePublicationReceipt publication = PublicationAuthority(authority);
        var identity = new PublicContentVerificationIdentity(authority.RunId, authority.Namespace,
            authority.ProfileId, new string('a', 40), Digest('b'), Digest('c'));
        var request = new CanonicalArticlePublicationRequest(
            new CanonicalArticlePublicationFixtureBinding(authority.RunId, authority.Namespace,
                authority.ProfileId, ["public.article.published"], authority.AdminPrincipalId,
                publication.WriterContractDigest, authority.TemporalContextDigest),
            new CanonicalArticlePublicationPlan(authority.SemanticRole, "Independent title", "Independent invocation bytes"));
        var lifecycle = new CanonicalArticleLifecycleFixtureBinding(authority.RunId, authority.Namespace,
            authority.ProfileId, ["public.article.published"], authority.AdminPrincipalId,
            authority.WriterContractDigest, authority.TemporalContextDigest);
        return new(identity, null!, [publication], [authority],
            [new(publication.ArticleId, request)], [new(authority.ArticleId, lifecycle)]);
    }

    private static (
        CanonicalArticleLifecycleReceipt Authority,
        ArticleMutationOutboxEvent Outbox) Fixture()
    {
        var version = new ArticleVersionCoordinates(
            RevisionId: 1501,
            RevisionNo: 15,
            RightsSnapshotId: 1601,
            ResponsibilitySnapshotId: 1701,
            PublicationId: 1801,
            PublicationNo: 18,
            ResponsibilityVersion: 7);
        var scope = new ArticleMutationScopeSnapshot(2, [3, 4], "published");
        ArticleMutationOutboxEvent outbox = ArticleMutationOutboxProducer.Create(
            1215,
            ArticleMutationEventTypes.Updated,
            version,
            scope,
            scope,
            s_now,
            s_now);
        outbox.Id = 91;
        outbox.Status = "processed";
        outbox.ProcessedAt = s_now.AddSeconds(1);
        outbox.LastError = null;

        var operation = new CanonicalArticleLifecycleOperationReceipt(
            TransitionId: "transition-1",
            Operation: "update",
            BeforeStatus: ArticleStatus.Published,
            AfterStatus: ArticleStatus.Published,
            BeforeDeleted: false,
            AfterDeleted: false,
            BeforeRevisionId: 1500,
            BeforeRevisionNo: 14,
            AfterRevisionId: 1501,
            AfterRevisionNo: 15,
            BeforePublicationId: 1800,
            BeforePublicationNo: 17,
            AfterPublicationId: 1801,
            AfterPublicationNo: 18,
            RightsSnapshotId: 1601,
            ResponsibilitySnapshotId: 1701,
            ResponsibilityVersion: 7,
            RollbackSourceRevisionId: null,
            TransitionedAtUtc: s_now,
            ScheduledPublishAt: null,
            ContentDigest: Digest('c'),
            OutboxEventId: outbox.EventId,
            OutboxPayloadDigest: CanonicalArticleLifecycleFixturePort.ComputeOutboxPayloadDigest(
                outbox.PayloadJson),
            AuditChainId: "audit-chain",
            AuditRecordHash: Digest('d'));
        var authority = new CanonicalArticleLifecycleReceipt(
            CanonicalArticleLifecycleFixturePort.Schema,
            CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
            Digest('e'),
            "run-2175",
            "namespace-2175",
            "public-content-lifecycle",
            "article-multiple-publications",
            CanonicalArticleLifecycleVariants.MultiplePublications,
            41,
            1215,
            [operation],
            [1501],
            [1801],
            1501,
            1801,
            ArticleStatus.Published,
            false,
            operation.ContentDigest,
            Digest('f'),
            Digest('a'));
        authority = authority with
        {
            ReceiptDigest = CanonicalArticleLifecycleFixturePort.ComputeReceiptDigest(
                authority.WriterContractDigest,
                authority.TemporalContextDigest,
                authority.RunId,
                authority.Namespace,
                authority.ProfileId,
                authority.SemanticRole,
                authority.Variant,
                authority.AdminPrincipalId,
                authority.ArticleId,
                authority.Operations,
                authority.RevisionIds,
                authority.PublicationIds,
                authority.CurrentRevisionId,
                authority.CurrentPublicationId,
                authority.CurrentStatus,
                authority.IsDeleted,
                authority.ContentDigest,
                authority.RevisionTimelineDigest)
        };
        return (authority, outbox);
    }

    private static IReadOnlyList<ArticleMutationOutboxEdge> CompletedEdges(
        ArticleMutationOutboxEvent outbox)
        => ArticleMutationReplayEdges.Required
            .Select((edgeName, index) => new ArticleMutationOutboxEdge
            {
                Id = index + 1,
                OutboxEventId = outbox.Id,
                EdgeName = edgeName,
                Status = ArticleMutationOutboxEdgeStatus.Completed,
                AttemptCount = 1,
                UpdatedAt = s_now.AddSeconds(1),
                DeliveryKey = ArticleMutationDeliveryKey.Build(outbox.EventId, edgeName)
            })
            .ToArray();

    private static CanonicalArticleProjectionConsistencyEvidence ConsistencyEvidence()
    {
        var coordinates = new CanonicalArticleProjectionCoordinates(
            1215,
            1501,
            15,
            1801,
            18,
            1601,
            1701,
            7);
        var versionCoordinates = new CanonicalArticleProjectionVersionCoordinates(
            1501,
            15,
            1801,
            18);
        return new CanonicalArticleProjectionConsistencyEvidence(
            PubliclyVisible: true,
            SearchQueryFound: true,
            SearchQueryTitleMatches: true,
            SearchEvidence: new SearchProjectionEvidence(
                "generation-1",
                s_now,
                Digest('1'),
                true,
                1215,
                1501,
                15,
                1801,
                18,
                Digest('2'),
                Digest('3')),
            ExpectedCoordinates: coordinates,
            ExpectedTitleDigest: Digest('2'),
            AedsProjectionFound: true,
            AedsArtifactFound: true,
            HotReadFound: true,
            HotReadPublicationVerified: true,
            AedsProjectionFrameDigest: Digest('4'),
            AedsArtifactFrameDigest: Digest('4'),
            HotReadFrameDigest: Digest('4'),
            DetailCoordinates: versionCoordinates,
            DetailContentDigest: Digest('5'),
            DetailRightsSnapshotId: 1601,
            ListCoordinates: versionCoordinates,
            ExpectedContentDigest: Digest('5'),
            AotLastMutationId: "event-1",
            ExpectedEventId: "event-1");
    }

    private static ArticleDetailCoreModel ArticleDetail(
        long revisionId,
        string content,
        long rightsSnapshotId)
    {
        var rights = new ArticleRightsCoreModel(
            rightsSnapshotId,
            revisionId,
            15,
            true,
            "CC-BY-4.0",
            "Fixture Author",
            2026,
            null,
            null,
            "append-attribution",
            300,
            true,
            true,
            true,
            "https://example.test/articles/1215",
            Digest('6'),
            DigestText(content),
            null,
            "ready");
        return new ArticleDetailCoreModel(
            default,
            1215,
            "Fixture article",
            content,
            null,
            null,
            5,
            2,
            1,
            false,
            s_now,
            new ArticleCategoryCoreModel(2, "Fixture"),
            [],
            2,
            false,
            (int)ArticleStatus.Published,
            null,
            s_now,
            s_now,
            rights,
            revisionId,
            15,
            1801,
            18);
    }

    private static CanonicalArticleProjectionOutputAggregate Aggregate(
        CanonicalArticleLifecycleReceipt authority,
        ArticleMutationOutboxEvent outbox)
    {
        CanonicalArticleLifecycleOperationReceipt operation = authority.Operations[^1];
        var coordinates = new CanonicalArticleProjectionCoordinates(
            authority.ArticleId,
            operation.AfterRevisionId,
            operation.AfterRevisionNo,
            operation.AfterPublicationId,
            operation.AfterPublicationNo,
            operation.RightsSnapshotId,
            operation.ResponsibilitySnapshotId,
            operation.ResponsibilityVersion);
        CanonicalArticleProjectionEdgeObservation[] edges = CompletedEdges(outbox)
            .OrderBy(static edge => edge.EdgeName, StringComparer.Ordinal)
            .Select(edge =>
            {
                var observation = new CanonicalArticleProjectionEdgeObservation(
                    outbox.EventId,
                    outbox.SchemaVersion,
                    edge.EdgeName,
                    $"production-outbox:{edge.EdgeName}",
                    edge.Status,
                    edge.AttemptCount,
                    outbox.Id,
                    edge.DeliveryKey!,
                    operation.OutboxPayloadDigest,
                    edge.EdgeName switch
                    {
                        ArticleMutationReplayEdges.SearchProjection => Digest('2'),
                        ArticleMutationReplayEdges.PublicAotInvalidation => Digest('3'),
                        ArticleMutationReplayEdges.PublicArtifactRevocation => Digest('4'),
                        ArticleMutationReplayEdges.ArticleDetailAeds => Digest('5'),
                        ArticleMutationReplayEdges.PublicHotRead => Digest('6'),
                        ArticleMutationReplayEdges.TaxonomyProjection => Digest('7'),
                        ArticleMutationReplayEdges.HttpCacheInvalidation => Digest('9'),
                        _ => throw new InvalidOperationException("unexpected production edge")
                    },
                    coordinates,
                    string.Empty);
                return observation with
                {
                    TerminalReceiptDigest =
                        CanonicalArticleProjectionVerifier.ComputeTerminalReceiptDigest(observation)
                };
            })
            .ToArray();
        string[] required = ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray();
        var aggregate = new CanonicalArticleProjectionOutputAggregate(
            CanonicalArticleProjectionVerifier.Schema,
            authority.RunId,
            authority.Namespace,
            authority.ReceiptDigest,
            ArticleMutationReplayEdges.ContractId,
            required,
            coordinates,
            true,
            authority.ContentDigest,
            Digest('2'),
            Digest('3'),
            Digest('4'),
            Digest('5'),
            Digest('6'),
            Digest('7'),
            Digest('8'),
            Digest('9'),
            edges,
            [],
            string.Empty);
        return aggregate with
        {
            AggregateDigest = CanonicalArticleProjectionVerifier.ComputeAggregateDigest(aggregate)
        };
    }

    private static CanonicalArticlePublicationReceipt PublicationAuthority(CanonicalArticleLifecycleReceipt authority)
    {
        CanonicalArticleLifecycleOperationReceipt operation = authority.Operations[^1];
        var receipt = new CanonicalArticlePublicationReceipt(
            CanonicalArticlePublicationFixturePort.Schema,
            Digest('e'),
            authority.RunId,
            authority.Namespace,
            authority.ProfileId,
            authority.SemanticRole,
            authority.AdminPrincipalId,
            authority.ArticleId,
            operation.AfterRevisionId,
            operation.AfterRevisionNo,
            operation.AfterPublicationId!.Value,
            operation.AfterPublicationNo!.Value,
            operation.RightsSnapshotId!.Value,
            Digest('c'),
            Digest('d'),
            operation.ResponsibilitySnapshotId!.Value,
            operation.ResponsibilityVersion!.Value,
            operation.OutboxEventId,
            operation.OutboxPayloadDigest,
            operation.AuditChainId,
            operation.AuditRecordHash,
            authority.ContentDigest,
            ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray(),
            string.Empty);
        return receipt with
        {
            ReceiptDigest = CanonicalArticlePublicationFixturePort.ComputeReceiptDigest(
                receipt.WriterContractDigest,
                receipt.ArticleId,
                receipt.RevisionId,
                receipt.PublicationId,
                receipt.RightsSnapshotId,
                receipt.ContentCanonicalHash,
                receipt.PolicyHash,
                receipt.ResponsibilitySnapshotId,
                receipt.OutboxEventId,
                receipt.OutboxPayloadDigest,
                receipt.AuditChainId,
                receipt.AuditRecordHash,
                receipt.ContentDigest)
        };
    }

    private static ArticleMutationOutboxEvent Clone(ArticleMutationOutboxEvent source)
        => new()
        {
            Id = source.Id + 1,
            EventId = source.EventId,
            AggregateId = source.AggregateId,
            SchemaVersion = source.SchemaVersion,
            ArticleRevisionId = source.ArticleRevisionId,
            RevisionNo = source.RevisionNo,
            RightsSnapshotId = source.RightsSnapshotId,
            ResponsibilitySnapshotId = source.ResponsibilitySnapshotId,
            ResponsibilityVersion = source.ResponsibilityVersion,
            ArticlePublicationId = source.ArticlePublicationId,
            PublicationNo = source.PublicationNo,
            EventType = source.EventType,
            PayloadJson = source.PayloadJson,
            Status = source.Status,
            ProcessedAt = source.ProcessedAt
        };

    private static byte[] SearchArtifact(
        int articleId,
        string title,
        long revisionId,
        int revisionNo,
        long publicationId,
        int publicationNo)
    {
        const int HeaderSize = 72;
        const int DocumentSize = 76;
        const int StringPoolOffset = 152;
        byte[] titleBytes = Encoding.UTF8.GetBytes(title);
        byte[] artifact = new byte[StringPoolOffset + titleBytes.Length];
        Span<byte> span = artifact;
        BinaryPrimitives.WriteUInt32LittleEndian(span, 0x32534846);
        BinaryPrimitives.WriteUInt32LittleEndian(span[4..], 4);
        BinaryPrimitives.WriteUInt32LittleEndian(span[8..], 0);
        BinaryPrimitives.WriteUInt32LittleEndian(span[12..], 1);
        BinaryPrimitives.WriteUInt32LittleEndian(span[20..], 1);
        BinaryPrimitives.WriteUInt32LittleEndian(span[36..], HeaderSize);
        BinaryPrimitives.WriteUInt32LittleEndian(span[40..], HeaderSize);
        BinaryPrimitives.WriteUInt32LittleEndian(span[44..], HeaderSize + DocumentSize);
        BinaryPrimitives.WriteUInt32LittleEndian(span[48..], HeaderSize + DocumentSize);
        BinaryPrimitives.WriteUInt32LittleEndian(span[52..], HeaderSize + DocumentSize);
        BinaryPrimitives.WriteUInt32LittleEndian(span[56..], StringPoolOffset);
        BinaryPrimitives.WriteUInt32LittleEndian(
            span[60..],
            checked((uint)(StringPoolOffset + titleBytes.Length)));

        Span<byte> document = span.Slice(HeaderSize, DocumentSize);
        BinaryPrimitives.WriteUInt32LittleEndian(document, checked((uint)articleId));
        BinaryPrimitives.WriteUInt32LittleEndian(document[20..], 1);
        BinaryPrimitives.WriteUInt16LittleEndian(document[36..], checked((ushort)titleBytes.Length));
        BinaryPrimitives.WriteInt64LittleEndian(document[52..], revisionId);
        BinaryPrimitives.WriteUInt32LittleEndian(document[60..], checked((uint)revisionNo));
        BinaryPrimitives.WriteInt64LittleEndian(document[64..], publicationId);
        BinaryPrimitives.WriteUInt32LittleEndian(document[72..], checked((uint)publicationNo));
        titleBytes.CopyTo(span[StringPoolOffset..]);
        return artifact;
    }

    private static string Digest(char value) => $"sha256:{new string(value, 64)}";

    private static string DigestText(string value)
        => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
