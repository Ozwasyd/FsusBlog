using FsusBlog.Server.Services.Authoring;

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
            Array.Empty<IAuthoringCanvasCoordinateFactProvider>());
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
            Array.Empty<IAuthoringCanvasCoordinateFactProvider>());
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
        var source = new AuthoringCanvasReferenceFactSource(reader, [provider]);
        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await source.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);

        IReadOnlyList<AuthoringCanvasReferenceFact> facts = await source.ReadBatchAsync(Query([target], coordinate));

        Assert.Equal(1, provider.BatchReadCount);
        Assert.Equal("Exact block context", facts.Single().ContextSnippet);
        Assert.Equal(AuthoringCanvasReferenceCoordinateState.Current, facts.Single().CoordinateState);

        var mismatched = new AuthoringCanvasReferenceFactSource(
            reader,
            [new DeterministicCoordinateProvider(item => new AuthoringCanvasCoordinateFact(
                item.NodeId,
                item.NodeType,
                item.TargetArticleId + 1,
                40,
                AuthoringCanvasReferenceCoordinateState.Current,
                null))]);
        AuthoringCanvasReferenceAuthorityCoordinate next = await mismatched.ReadAuthorityCoordinateAsync(
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead);
        AuthoringCanvasValidationException exception = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => mismatched.ReadBatchAsync(Query([target], next)));
        Assert.Equal("canvas_reference_coordinate_fact_invalid", exception.Code);
    }

    [Fact]
    public void Source_RejectsMultipleCoordinateAuthoritiesInsteadOfPickingFirst()
    {
        var reader = new DeterministicArticleReader();
        var first = new DeterministicCoordinateProvider(_ => throw new InvalidOperationException());
        var second = new DeterministicCoordinateProvider(_ => throw new InvalidOperationException());

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(() =>
            new AuthoringCanvasReferenceFactSource(reader, [first, second]));

        Assert.Equal("multiple_authoring_canvas_coordinate_fact_providers", exception.Message);
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
            IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            BatchReadCount++;
            return Task.FromResult(Records);
        }
    }

    private sealed class DeterministicCoordinateProvider(
        Func<AuthoringCanvasReferenceTarget, AuthoringCanvasCoordinateFact> project)
        : IAuthoringCanvasCoordinateFactProvider
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
            return Task.FromResult<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>>(
                query.Targets.ToDictionary(static target => target.NodeId, project));
        }
    }
}
