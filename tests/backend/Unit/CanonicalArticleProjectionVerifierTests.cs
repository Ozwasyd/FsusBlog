using System.Buffers.Binary;
using System.Collections.Frozen;
using System.Linq.Expressions;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Fixtures;

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
    public async Task VerifyAsync_RereadsBoundOutputsAndFailsClosed(
        string scenario,
        string? expectedViolation)
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
        var revocations = new PublicArtifactRevocationRegistry();
        revocations.Clear(new PublicArtifactTombstone(row.Id, 23, new DateTimeOffset(s_now).ToUnixTimeMilliseconds()));
        var revocationState = Substitute.For<IPublicArtifactRevocationStateStore>();
        revocationState.LoadActiveAsync(Arg.Any<CancellationToken>())
            .Returns(Array.Empty<PublicArtifactTombstone>());
        var cache = Substitute.For<ICacheStringReader>();
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns(scenario == "cache-missing" ? null : "23");
        var verifier = new CanonicalArticleProjectionVerifier(
            db, search, articles, projection, artifact, hot, aot,
            revocations, revocationState, cache, new DefaultRuntimeKeyScope(), clock);
        if (scenario == "latest-metadata")
            row.Title = "latest mutable title";

        if (expectedViolation is not null)
        {
            CanonicalArticleProjectionVerificationException error = await Assert.ThrowsAsync<
                CanonicalArticleProjectionVerificationException>(() => verifier.VerifyAsync(authority));
            Assert.Contains(error.Violations, violation => violation.StartsWith(expectedViolation, StringComparison.Ordinal));
            return;
        }

        CanonicalArticleProjectionOutputAggregate aggregate = scenario == "publication"
            ? await verifier.VerifyAsync(PublicationAuthority(authority))
            : await verifier.VerifyAsync(authority);
        Assert.Empty(aggregate.Failures);
        Assert.Equal(ArticleMutationReplayEdges.Required.Count, aggregate.Edges.Count);
        Assert.All(aggregate.Edges, edge =>
        {
            Assert.Equal(outbox.EventId, edge.EventId);
            Assert.Equal(1801, edge.Coordinates.PublicationId);
            Assert.Equal(CanonicalArticleProjectionVerifier.ComputeTerminalReceiptDigest(edge), edge.TerminalReceiptDigest);
        });
        Assert.Equal(CanonicalArticleProjectionVerifier.ComputeAggregateDigest(aggregate), aggregate.AggregateDigest);
        await projection.Received(1).TryReadAsync(row.Id, Arg.Any<CancellationToken>());
        await artifact.Received(1).TryReadAsync(row.Id, Arg.Any<CancellationToken>());
        await cache.Received(1).GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>());
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
    public void Aggregate_AcceptsSealedLifecycleAndPublicationAuthorities()
    {
        (CanonicalArticleLifecycleReceipt authority, ArticleMutationOutboxEvent outbox) = Fixture();
        CanonicalArticleProjectionOutputAggregate aggregate = Aggregate(authority, outbox);
        CanonicalArticleProjectionVerifier.VerifyAggregate(aggregate, authority);

        CanonicalArticlePublicationReceipt publication = PublicationAuthority(authority);
        CanonicalArticleProjectionOutputAggregate publicationAggregate = aggregate with
        {
            AuthorityReceiptDigest = publication.ReceiptDigest
        };
        publicationAggregate = publicationAggregate with
        {
            AggregateDigest = CanonicalArticleProjectionVerifier.ComputeAggregateDigest(publicationAggregate)
        };
        CanonicalArticleProjectionVerifier.VerifyAggregate(publicationAggregate, publication);
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
