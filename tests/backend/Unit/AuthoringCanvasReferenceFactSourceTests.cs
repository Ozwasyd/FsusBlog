using FsusBlog.Server.Services.Authoring;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasReferenceFactSourceTests
{
    private const string CanvasDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    private static readonly AuthoringCanvasOwner s_owner = new(61, "primary-site");

    [Fact]
    public async Task Source_UsesAuthorizedArticleBatchAndExactPinnedRevisionWithoutBodyFacts()
    {
        AuthoringCanvasReferenceTarget[] targets =
        [
            Target(101, AuthoringCanvasNodeType.ArticleReference),
            Target(102, AuthoringCanvasNodeType.HeadingReference, pinnedRevision: 11, heading: "heading-a")
        ];
        var reader = new DeterministicArticleReader
        {
            Records = new Dictionary<int, AuthoringCanvasArticleReferenceRecord>
            {
                [101] = Record(101, 20, "Current 101"),
                [102] = Record(
                    102,
                    22,
                    "Current 102",
                    new AuthoringCanvasArticleRevisionDisplayFact(11, "Pinned 102", "Pinned context"))
            }
        };
        var source = new AuthoringCanvasReferenceFactSource(
            reader,
            new AuthoringCanvasCoordinateFactProvider([]));
        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);

        IReadOnlyList<AuthoringCanvasReferenceFact> facts = await source.ReadBatchAsync(
            Query(targets, coordinate));

        Assert.Equal(1, reader.BatchReadCount);
        Assert.Equal(2, facts.Count);
        Assert.Equal(20, facts[0].ResolvedRevision);
        Assert.Equal("Current 101", facts[0].Title);
        Assert.Equal("/manage/article/edit/101", facts[0].StableRoute);
        Assert.Equal(
            AuthoringCanvasContract.ComputeCommandDigest(
                "canvas-reference-display",
                101,
                20,
                "Current 101",
                "Context 101"),
            facts[0].DisplayProjectionReference);
        Assert.Equal(11, facts[1].ResolvedRevision);
        Assert.Equal("Pinned 102", facts[1].Title);
        Assert.Equal(
            AuthoringCanvasContract.ComputeCommandDigest(
                "canvas-reference-display",
                102,
                22,
                "Current 102",
                "Context 102"),
            facts[1].DisplayProjectionReference);
        Assert.Equal(AuthoringCanvasReferenceCoordinateState.SourceStale, facts[1].CoordinateState);
        Assert.Null(facts[1].ContextSnippet);
    }

    [Theory]
    [InlineData(AuthoringCanvasNodeType.ArticleReference)]
    [InlineData(AuthoringCanvasNodeType.HeadingReference)]
    [InlineData(AuthoringCanvasNodeType.BlockReference)]
    public async Task Source_MissingPinnedRevisionRemainsSourceStaleWithoutLatestDisplayOrOpenIntent(
        AuthoringCanvasNodeType nodeType)
    {
        AuthoringCanvasReferenceTarget target = Target(
            103,
            nodeType,
            pinnedRevision: 11,
            heading: nodeType == AuthoringCanvasNodeType.HeadingReference ? "heading-a" : null,
            block: nodeType == AuthoringCanvasNodeType.BlockReference ? "block-a" : null);
        var reader = new DeterministicArticleReader
        {
            Records = new Dictionary<int, AuthoringCanvasArticleReferenceRecord>
            {
                [103] = Record(
                    103,
                    22,
                    "LATEST DISPLAY MUST NOT ESCAPE",
                    new AuthoringCanvasArticleRevisionDisplayFact(12, "OTHER PIN MUST NOT ESCAPE", "Other context"))
            }
        };
        var source = new AuthoringCanvasReferenceFactSource(
            reader,
            new AuthoringCanvasCoordinateFactProvider([]));
        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);
        AuthoringCanvasReferenceFact fact = Assert.Single(await source.ReadBatchAsync(Query([target], coordinate)));
        AuthoringCanvasReferenceContract.ValidateFact(target, fact);
        Assert.Equal(AuthoringCanvasArticleState.Current, fact.ArticleState);
        Assert.Equal(AuthoringCanvasReferenceCoordinateState.SourceStale, fact.CoordinateState);
        Assert.Equal(22, fact.CurrentRevision);
        Assert.Equal(11, fact.ResolvedRevision);
        Assert.Null(fact.Title);
        Assert.Null(fact.ContextSnippet);
        Assert.Null(fact.StableRoute);
        Assert.Null(fact.DisplayProjectionReference);
        Assert.False(fact.TargetChangedSinceProjection);

        var node = new AuthoringCanvasNode(
            target.NodeId,
            nodeType,
            target.TargetArticleId,
            new AuthoringCanvasGeometry(10, 20, 240, 120),
            TargetArticleId: target.TargetArticleId,
            TargetHeadingIdentity: target.TargetHeadingIdentity,
            TargetBlockIdentity: target.TargetBlockIdentity,
            PinnedTargetRevision: target.PinnedTargetRevision,
            DisplayProjectionReference: target.DisplayProjectionReference,
            ReferenceState: AuthoringCanvasReferenceState.Unresolved);
        var request = new AuthoringCanvasReferenceResolutionRequest(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            7,
            CanvasDigest,
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead,
            [node]);
        IAuthoringCanvasDocumentStore store = Substitute.For<IAuthoringCanvasDocumentStore>();
        store.GetAsync(s_owner, request.CanvasId, Arg.Any<CancellationToken>()).Returns(
            Task.FromResult<AuthoringCanvasDocumentHeader?>(new AuthoringCanvasDocumentHeader(
                request.CanvasId,
                s_owner,
                AuthoringCanvasContract.SchemaVersion,
                request.CanvasRevision,
                "Research",
                new AuthoringCanvasViewport(0, 0, 1),
                1,
                0,
                DateTime.UnixEpoch,
                DateTime.UnixEpoch,
                CanvasDigest)));
        var resolver = new AuthoringCanvasReferenceResolver(
            store,
            source,
            new AuthoringCanvasReferenceProjectionCache(),
            TimeProvider.System);
        AuthoringCanvasReferenceResolutionBatch batch = await resolver.ResolveAsync(request);
        AuthoringCanvasReferenceProjection projection = Assert.Single(batch.Projections);
        Assert.Equal(AuthoringCanvasReferenceProjectionStatus.SourceStale, projection.Status);
        Assert.Equal(11, projection.TargetRevision);
        Assert.Equal(22, projection.CurrentTargetRevision);
        Assert.Null(projection.Title);
        Assert.Null(projection.ContextSnippet);
        Assert.Null(projection.DisplayProjectionReference);
        Assert.Null(projection.OpenIntent);
        Assert.False(projection.UpdateAvailable);
        AuthoringCanvasReferenceResolutionReceiptItem receipt = Assert.Single(batch.Receipt.Items);
        Assert.Equal(AuthoringCanvasReferenceProjectionStatus.SourceStale, receipt.Status);
        Assert.Equal(11, receipt.TargetRevision);
        Assert.Null(receipt.Title);
        Assert.Null(receipt.ContextSnippet);
        Assert.Null(receipt.OpenIntent);
        AuthoringCanvasReferenceVerificationResult verification = await resolver.VerifyAsync(request, batch);
        Assert.True(verification.Valid);
        Assert.Empty(verification.Reasons);
        Assert.Equal(3, reader.BatchReadCount);
    }

    [Fact]
    public async Task Source_RechecksAuthoritativePermissionAndInvalidatesChangedProductionGeneration()
    {
        AuthoringCanvasReferenceTarget target = Target(201, AuthoringCanvasNodeType.ArticleReference);
        var reader = new DeterministicArticleReader
        {
            Records = new Dictionary<int, AuthoringCanvasArticleReferenceRecord>
            {
                [201] = Record(201, 30, "Private title")
            }
        };
        var source = new AuthoringCanvasReferenceFactSource(
            reader,
            new AuthoringCanvasCoordinateFactProvider([]));
        AuthoringCanvasReferenceAuthorityCoordinate first = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);
        AuthoringCanvasReferenceAuthorityCoordinate second = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);
        Assert.Equal(first, second);

        reader.Authority = reader.Authority with
        {
            ContentGeneration = 13
        };
        AuthoringCanvasReferenceAuthorityCoordinate changed = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);
        Assert.NotEqual(second.ContentDigest, changed.ContentDigest);

        reader.Authority = reader.Authority with
        {
            PrincipalGeneration = 10,
            PermissionFingerprint = "permission-revoked",
            Authorized = false
        };
        IReadOnlyList<AuthoringCanvasReferenceFact> facts = await source.ReadBatchAsync(Query([target], changed));

        Assert.Equal(AuthoringCanvasArticleState.PermissionDeniedOrUnknown, facts.Single().ArticleState);
        Assert.Null(facts.Single().Title);
        Assert.Null(facts.Single().ContextSnippet);
        Assert.Null(facts.Single().StableRoute);
        Assert.Equal(0, reader.BatchReadCount);
        Assert.Equal(4, reader.AuthorityReadCount);
    }

    [Fact]
    public async Task Source_ConsumesOneTypedHeadingBlockProviderAndRejectsCoordinateMismatch()
    {
        AuthoringCanvasReferenceTarget target = Target(
            301,
            AuthoringCanvasNodeType.BlockReference,
            block: "block-a");
        var reader = new DeterministicArticleReader
        {
            Records = new Dictionary<int, AuthoringCanvasArticleReferenceRecord>
            {
                [301] = Record(301, 40, "Article 301")
            }
        };
        var provider = new DeterministicCoordinateProvider(target => new AuthoringCanvasCoordinateFact(
            target.NodeId,
            target.NodeType,
            target.TargetArticleId,
            40,
            AuthoringCanvasReferenceCoordinateState.Current,
            "Exact block context"));
        var source = new AuthoringCanvasReferenceFactSource(reader, provider);
        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);

        IReadOnlyList<AuthoringCanvasReferenceFact> facts = await source.ReadBatchAsync(Query([target], coordinate));

        Assert.Equal(1, provider.BatchReadCount);
        Assert.Equal("Exact block context", facts.Single().ContextSnippet);
        Assert.Equal(AuthoringCanvasReferenceCoordinateState.Current, facts.Single().CoordinateState);

        var mismatched = new AuthoringCanvasReferenceFactSource(
            reader,
            new DeterministicCoordinateProvider(item => new AuthoringCanvasCoordinateFact(
                item.NodeId,
                item.NodeType,
                item.TargetArticleId + 1,
                40,
                AuthoringCanvasReferenceCoordinateState.Current,
                null)));
        AuthoringCanvasReferenceAuthorityCoordinate next = await mismatched.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);
        AuthoringCanvasValidationException exception = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => mismatched.ReadBatchAsync(Query([target], next)));
        Assert.Equal("canvas_reference_coordinate_fact_invalid", exception.Code);

        var unexpected = new AuthoringCanvasReferenceFactSource(
            reader,
            new DeterministicCoordinateProvider(
                item => new AuthoringCanvasCoordinateFact(
                    item.NodeId,
                    item.NodeType,
                    item.TargetArticleId,
                    40,
                    AuthoringCanvasReferenceCoordinateState.Current,
                    null),
                appendUnexpected: true));
        AuthoringCanvasReferenceAuthorityCoordinate unexpectedCoordinate =
            await unexpected.ReadAuthorityCoordinateAsync(
                s_owner,
                AuthoringCanvasReferencePermission.ArticleRead);
        AuthoringCanvasValidationException unexpectedFact =
            await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
                () => unexpected.ReadBatchAsync(Query([target], unexpectedCoordinate)));
        Assert.Equal("canvas_reference_coordinate_fact_set_invalid", unexpectedFact.Code);
    }

    [Fact]
    public void CoordinateProvider_RejectsMultipleExternalAuthoritiesInsteadOfPickingFirst()
    {
        var first = new DeterministicCoordinateProvider(_ => throw new InvalidOperationException());
        var second = new DeterministicCoordinateProvider(_ => throw new InvalidOperationException());

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(() =>
            new AuthoringCanvasCoordinateFactProvider([first, second]));

        Assert.Equal("multiple_authoring_canvas_external_coordinate_authorities", exception.Message);
    }

    [Fact]
    public async Task Source_RejectsMismatchedArticleIdentityAndRevisionFacts()
    {
        AuthoringCanvasReferenceTarget target = Target(401, AuthoringCanvasNodeType.ArticleReference);
        var reader = new DeterministicArticleReader
        {
            Records = new Dictionary<int, AuthoringCanvasArticleReferenceRecord>
            {
                [401] = Record(402, 50, "Wrong article")
            }
        };
        var source = new AuthoringCanvasReferenceFactSource(
            reader,
            new AuthoringCanvasCoordinateFactProvider([]));
        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);

        AuthoringCanvasValidationException identity = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => source.ReadBatchAsync(Query([target], coordinate)));
        Assert.Equal("canvas_reference_article_fact_set_invalid", identity.Code);

        reader.Records = new Dictionary<int, AuthoringCanvasArticleReferenceRecord>
        {
            [401] = Record(401, 50, "Wrong revision") with
            {
                CurrentDisplay = new AuthoringCanvasArticleRevisionDisplayFact(49, "Wrong revision", null)
            }
        };
        AuthoringCanvasValidationException revision = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => source.ReadBatchAsync(Query([target], coordinate)));
        Assert.Equal("canvas_reference_article_fact_set_invalid", revision.Code);
    }

    private static AuthoringCanvasReferenceFactQuery Query(
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
        AuthoringCanvasReferenceAuthorityCoordinate coordinate)
        => new(
            Guid.CreateVersion7(),
            7,
            CanvasDigest,
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead,
            coordinate,
            targets);

    private static AuthoringCanvasReferenceTarget Target(
        int articleId,
        AuthoringCanvasNodeType nodeType,
        long? pinnedRevision = null,
        string? heading = null,
        string? block = null)
        => new(
            Guid.CreateVersion7(),
            nodeType,
            articleId,
            heading,
            block,
            pinnedRevision,
            "old-projection");

    private static AuthoringCanvasArticleReferenceRecord Record(
        int articleId,
        long currentRevision,
        string title,
        params AuthoringCanvasArticleRevisionDisplayFact[] pinned)
        => new(
            articleId,
            AuthoringCanvasArticleState.Current,
            currentRevision,
            new AuthoringCanvasArticleRevisionDisplayFact(currentRevision, title, $"Context {articleId}"),
            pinned.ToDictionary(static fact => fact.Revision));

    private sealed class DeterministicArticleReader : IAuthoringCanvasArticleReferenceReader
    {
        public AuthoringCanvasArticleReadAuthority Authority
        {
            get; set;
        } = new(
            9,
            12,
            3,
            5,
            "permission-active",
            true);

        public IReadOnlyDictionary<int, AuthoringCanvasArticleReferenceRecord> Records
        {
            get; set;
        } =
            new Dictionary<int, AuthoringCanvasArticleReferenceRecord>();

        public int AuthorityReadCount
        {
            get; private set;
        }

        public int BatchReadCount
        {
            get; private set;
        }

        public Task<AuthoringCanvasArticleReadAuthority> ReadAuthorityAsync(
            AuthoringCanvasOwner owner,
            AuthoringCanvasReferencePermission permission,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthorityReadCount++;
            return Task.FromResult(Authority);
        }

        public Task<IReadOnlyDictionary<int, AuthoringCanvasArticleReferenceRecord>> ReadBatchAsync(
            AuthoringCanvasOwner owner,
            AuthoringCanvasReferencePermission permission,
            IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            BatchReadCount++;
            return Task.FromResult(Records);
        }
    }

    private sealed class DeterministicCoordinateProvider(
        Func<AuthoringCanvasReferenceTarget, AuthoringCanvasCoordinateFact> project,
        bool appendUnexpected = false)
        : IAuthoringCanvasCoordinateFactProvider, IAuthoringCanvasExternalCoordinateAuthority
    {
        public int BatchReadCount
        {
            get; private set;
        }

        public Task<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>> ReadBatchAsync(
            AuthoringCanvasCoordinateFactQuery query,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            BatchReadCount++;
            Dictionary<Guid, AuthoringCanvasCoordinateFact> facts = query.Targets.ToDictionary(
                static target => target.NodeId,
                project);
            if (appendUnexpected)
            {
                Guid unexpectedNodeId = Guid.CreateVersion7();
                facts.Add(
                    unexpectedNodeId,
                    new AuthoringCanvasCoordinateFact(
                        unexpectedNodeId,
                        AuthoringCanvasNodeType.BlockReference,
                        int.MaxValue,
                        1,
                        AuthoringCanvasReferenceCoordinateState.Current,
                        null));
            }
            return Task.FromResult<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>>(facts);
        }
    }
}
