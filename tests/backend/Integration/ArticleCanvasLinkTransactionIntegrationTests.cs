using System.Globalization;
using System.Security.Claims;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Integration;

// These tests exercise the actual production owner against isolated PostgreSQL.
// Fixture claims are not HTTP/session middleware qualification.
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleCanvasLinkTransactionIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ActualOwner_AtomicApplyReplayUndoRedo_PreservesCanvasAndCanonicalOutbox()
    {
        var data = await SeedAsync();
        using SqlSugarClient db = data.Db;
        Assert.NotNull(data.RequestContext.HttpContext);
        Assert.True(data.RequestContext.HttpContext.User.Identity?.IsAuthenticated);
        Assert.Equal(data.Owner.AdminPrincipalId.ToString(CultureInfo.InvariantCulture),
            data.RequestContext.HttpContext.User.FindFirst("admin_id")?.Value);
        IArticleCanvasLinkWriter writer = data.Service;
        ArticleCanvasLinkHistoryResponse initial = await writer.ReadHistoryAsync(data.Owner, data.Request.SourceArticleId);
        Assert.Equal(0, initial.HistoryArticleRevision);
        Assert.Empty(initial.UndoEntries);
        long outboxBefore = await CountAsync(db, "article_mutation_outbox");
        ArticleCanvasLinkReceipt applied = await writer.ConvertAsync(data.Owner, data.Request);
        ArticleCanvasLinkReceipt replay = await writer.ConvertAsync(data.Owner, data.Request);
        Assert.True(replay.IdempotencyReplay);
        Assert.Equal(applied.JournalId, replay.JournalId);
        Assert.Equal(outboxBefore + 1, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal("before\n\n[target](/article/" + data.Request.TargetArticleId + ")", await SourceAsync(db, applied.SourceArticleId));
        ArticleCanvasLinkReceipt undone = await writer.ConvertAsync(data.Owner, HistoryRequest(applied, ArticleCanvasLinkMode.Undo));
        Assert.Equal("before", await SourceAsync(db, applied.SourceArticleId));
        Assert.NotEqual(applied.OriginalBeforeRevision, undone.ArticleRevision);
        ArticleCanvasLinkReceipt redone = await writer.ConvertAsync(data.Owner, HistoryRequest(undone, ArticleCanvasLinkMode.Redo, applied.JournalId));
        Assert.Equal(outboxBefore + 3, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(3, await CountAsync(db, "article_canvas_link_journal"));
        ArticleCanvasLinkHistoryResponse history = await writer.ReadHistoryAsync(data.Owner, applied.SourceArticleId);
        Assert.Equal(redone.ArticleRevision, history.HistoryArticleRevision);
        Assert.Single(history.UndoEntries);
        Assert.Empty(history.RedoEntries);
        Assert.Equal(data.Header, await data.Documents.GetAsync(data.Owner, data.Header.Id));
        Assert.True((await data.Documents.VerifyAsync(data.Owner, data.Header.Id)).Valid);
    }

    [Fact]
    public async Task JournalFailure_RollsBackArticleRevisionBodyOutboxAndHead()
    {
        var data = await SeedAsync();
        using SqlSugarClient db = data.Db;
        long beforeRevision = data.Request.ExpectedArticleRevision;
        long beforeOutbox = await CountAsync(db, "article_mutation_outbox");
        long beforeRevisions = await CountAsync(db, "article_revision");
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION reject_link_journal() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'isolated journal failure'; END $$;
            CREATE TRIGGER reject_link BEFORE INSERT ON article_canvas_link_journal
                FOR EACH ROW EXECUTE FUNCTION reject_link_journal();
            """);
        Exception failure = await Assert.ThrowsAnyAsync<Exception>(() => ((IArticleCanvasLinkWriter)data.Service).ConvertAsync(data.Owner, data.Request));
        Assert.Contains("isolated journal failure", failure.ToString(), StringComparison.Ordinal);
        Assert.Equal("before", await SourceAsync(db, data.Request.SourceArticleId));
        Assert.Equal(beforeRevision, await RevisionAsync(db, data.Request.SourceArticleId));
        Assert.Equal(beforeOutbox, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(beforeRevisions, await CountAsync(db, "article_revision"));
        Assert.Equal(0, await CountAsync(db, "article_canvas_link_journal"));
        Assert.Equal(0, await CountAsync(db, "article_canvas_link_history"));
    }

    [Fact]
    public async Task LaterCanonicalArticleEdit_RejectsOldUndoEvenWithFreshClientRevision()
    {
        var data = await SeedAsync();
        using SqlSugarClient db = data.Db;
        IArticleCanvasLinkWriter writer = data.Service;
        ArticleCanvasLinkReceipt applied = await writer.ConvertAsync(data.Owner, data.Request);
        Assert.True(await data.Service.UpdateAsync(applied.SourceArticleId, new ArticleWriteRequestCoreModel(
            "source", "later edit", "summary", null, data.CategoryId, [], (int)ArticleStatus.Draft, BaseRevisionId: applied.ArticleRevision)));
        long current = await RevisionAsync(db, applied.SourceArticleId);
        await Assert.ThrowsAsync<AuthoringCanvasValidationException>(() => writer.ConvertAsync(data.Owner,
            HistoryRequest(applied, ArticleCanvasLinkMode.Undo) with
            {
                ExpectedArticleRevision = current
            }));
        Assert.Equal("later edit", await SourceAsync(db, applied.SourceArticleId));
        Assert.Equal(1, await CountAsync(db, "article_canvas_link_journal"));
    }

    [Fact]
    public async Task TypedUuidArrays_PreserveZeroOneAndHundredEntryWindows_ThenRefuseOverflow()
    {
        var data = await SeedAsync();
        using SqlSugarClient db = data.Db;
        IArticleCanvasLinkWriter writer = data.Service;
        ArticleCanvasLinkRequest request = data.Request;
        for (int index = 0; index < 100; index++)
        {
            ArticleCanvasLinkReceipt receipt = await writer.ConvertAsync(data.Owner, request);
            request = request with
            {
                RequestId = Guid.CreateVersion7(),
                ExpectedArticleRevision = receipt.ArticleRevision
            };
        }
        ArticleCanvasLinkHistoryResponse history = await writer.ReadHistoryAsync(data.Owner, request.SourceArticleId);
        Assert.Equal(100, history.UndoEntries.Count);
        Assert.Empty(history.RedoEntries);
        await Assert.ThrowsAsync<AuthoringCanvasBudgetExceededException>(() => writer.ConvertAsync(data.Owner, request));
        Assert.Equal(100, await CountAsync(db, "article_canvas_link_journal"));
    }

    private static ArticleCanvasLinkRequest HistoryRequest(ArticleCanvasLinkReceipt receipt, ArticleCanvasLinkMode mode, Guid? target = null)
        => new(Guid.CreateVersion7(), receipt.SourceArticleId, receipt.ArticleRevision, mode,
            target ?? receipt.JournalId, Guid.Empty, 0, string.Empty, Guid.Empty, 0, 0);

    [Fact]
    public async Task CommittedReceipt_ReplaysAfterTargetAndCanvasDeletion_WithoutRewritingSource()
    {
        var data = await SeedAsync();
        using SqlSugarClient db = data.Db;
        IArticleCanvasLinkWriter writer = data.Service;
        ArticleCanvasLinkReceipt applied = await writer.ConvertAsync(data.Owner, data.Request);
        // Actual historical subjects are scalar; no live target/Canvas FK may block recovery.
        await db.Deleteable<Article>().Where(article => article.Id == data.Request.TargetArticleId).ExecuteCommandAsync();
        _ = await data.Documents.DeleteAsync(new DeleteAuthoringCanvasCommand(data.Header.Id, data.Owner,
            data.Header.Revision, Guid.CreateVersion7()));
        long outbox = await CountAsync(db, "article_mutation_outbox");
        ArticleCanvasLinkReceipt replay = await writer.ConvertAsync(data.Owner, data.Request);
        Assert.True(replay.IdempotencyReplay);
        Assert.Equal(applied.JournalId, replay.JournalId);
        Assert.Equal(applied.ArticleRevision, await RevisionAsync(db, applied.SourceArticleId));
        Assert.Equal(outbox, await CountAsync(db, "article_mutation_outbox"));
        await Assert.ThrowsAsync<AuthoringCanvasIdempotencyConflictException>(() => writer.ConvertAsync(data.Owner,
            data.Request with
            {
                ExpectedTargetRevision = data.Request.ExpectedTargetRevision + 1
            }));
    }

    [Fact]
    public async Task DraftHeadingTarget_IsRejectedUntilItsActualPublicationOwnsTheAnchorRevision()
    {
        var data = await SeedAsync();
        using SqlSugarClient db = data.Db;
        Assert.True(await data.Service.UpdateAsync(data.Request.TargetArticleId, new ArticleWriteRequestCoreModel(
            "target", "# Target ^target-anchor", "summary", null, data.CategoryId, [], (int)ArticleStatus.Draft,
            BaseRevisionId: data.Request.ExpectedTargetRevision)));
        long targetRevision = await RevisionAsync(db, data.Request.TargetArticleId);
        var nodes = await data.Documents.ReadNodesAsync(data.Owner, data.Header.Id, null, 256);
        AuthoringCanvasNode node = Assert.Single(nodes.Items, value => value.TargetArticleId == data.Request.TargetArticleId);
        _ = await data.Documents.PutNodeAsync(new PutAuthoringCanvasNodeCommand(data.Header.Id, data.Owner,
            data.Header.Revision, Guid.CreateVersion7(), node with
            {
                Type = AuthoringCanvasNodeType.HeadingReference,
                TargetHeadingIdentity = "target-anchor",
                ReferenceState = AuthoringCanvasReferenceState.Unresolved
            }));
        AuthoringCanvasDocumentHeader header = (await data.Documents.GetAsync(data.Owner, data.Header.Id))!;
        ArticleCanvasLinkRequest request = data.Request with
        {
            CanvasRevision = header.Revision,
            CanvasContentDigest = header.ContentDigest,
            ExpectedTargetRevision = targetRevision
        };
        var rejected = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => ((IArticleCanvasLinkWriter)data.Service).ConvertAsync(data.Owner, request));
        Assert.Equal("article_canvas_link_public_coordinate_unavailable", rejected.Code);
        Assert.Equal("before", await SourceAsync(db, request.SourceArticleId));
        Assert.Equal(0, await CountAsync(db, "article_canvas_link_journal"));

        Assert.True(await data.Service.UpdateAsync(data.Request.TargetArticleId, new ArticleWriteRequestCoreModel(
            "target", "# Target ^target-anchor", "summary", null, data.CategoryId, [], (int)ArticleStatus.Published,
            BaseRevisionId: targetRevision)));
        request = request with
        {
            RequestId = Guid.CreateVersion7(),
            ExpectedTargetRevision = await RevisionAsync(db, request.TargetArticleId)
        };
        ArticleCanvasLinkReceipt applied = await ((IArticleCanvasLinkWriter)data.Service).ConvertAsync(data.Owner, request);
        Assert.Equal(request.ExpectedTargetRevision, applied.TargetRevision);
        Assert.Contains("#target-anchor)", await SourceAsync(db, request.SourceArticleId), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("article-revision")]
    [InlineData("canvas-revision")]
    [InlineData("canvas-digest")]
    [InlineData("target-revision")]
    [InlineData("edge-identity")]
    public async Task StaleCoordinates_RejectWithoutArticleJournalOrOutboxWrite(string mutation)
    {
        var data = await SeedAsync();
        using SqlSugarClient db = data.Db;
        ArticleCanvasLinkRequest request = mutation switch
        {
            "article-revision" => data.Request with { ExpectedArticleRevision = data.Request.ExpectedArticleRevision + 1 },
            "canvas-revision" => data.Request with { CanvasRevision = data.Request.CanvasRevision + 1 },
            "canvas-digest" => data.Request with { CanvasContentDigest = new string('a', 64) },
            "target-revision" => data.Request with { ExpectedTargetRevision = data.Request.ExpectedTargetRevision + 1 },
            "edge-identity" => data.Request with { EdgeId = Guid.CreateVersion7() },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };
        long outbox = await CountAsync(db, "article_mutation_outbox");
        if (mutation == "article-revision")
        {
            await Assert.ThrowsAsync<ArticleRevisionConflictException>(
                () => ((IArticleCanvasLinkWriter)data.Service).ConvertAsync(data.Owner, request));
        }
        else
        {
            await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
                () => ((IArticleCanvasLinkWriter)data.Service).ConvertAsync(data.Owner, request));
        }
        Assert.Equal("before", await SourceAsync(db, data.Request.SourceArticleId));
        Assert.Equal(data.Request.ExpectedArticleRevision, await RevisionAsync(db, data.Request.SourceArticleId));
        Assert.Equal(outbox, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(0, await CountAsync(db, "article_canvas_link_journal"));
        Assert.Equal(0, await CountAsync(db, "article_canvas_link_history"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PrincipalMismatchOrRevokedPermission_RejectsMutationAndPrivateHistory(bool revokePermission)
    {
        var data = await SeedAsync();
        using SqlSugarClient db = data.Db;
        AuthoringCanvasOwner owner = data.Owner;
        if (revokePermission)
        {
            await db.Ado.ExecuteCommandAsync(
                "UPDATE admin_principal SET isroot = false, permissions = '' WHERE id = @Id;",
                new SugarParameter("@Id", owner.AdminPrincipalId));
        }
        else
        {
            owner = owner with
            {
                AdminPrincipalId = owner.AdminPrincipalId + 1
            };
        }
        IArticleCanvasLinkWriter writer = data.Service;
        long outbox = await CountAsync(db, "article_mutation_outbox");
        await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() => writer.ConvertAsync(owner, data.Request));
        await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() => writer.ReadHistoryAsync(owner, data.Request.SourceArticleId));
        Assert.Equal("before", await SourceAsync(db, data.Request.SourceArticleId));
        Assert.Equal(data.Request.ExpectedArticleRevision, await RevisionAsync(db, data.Request.SourceArticleId));
        Assert.Equal(outbox, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(0, await CountAsync(db, "article_canvas_link_journal"));
    }

    [Fact]
    public async Task AlreadyCancelledRequest_LeavesCanonicalArticleAndHistoryUnchanged()
    {
        var data = await SeedAsync();
        using SqlSugarClient db = data.Db;
        long outbox = await CountAsync(db, "article_mutation_outbox");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            ((IArticleCanvasLinkWriter)data.Service).ConvertAsync(data.Owner, data.Request, cancellation.Token));
        Assert.Equal("before", await SourceAsync(db, data.Request.SourceArticleId));
        Assert.Equal(data.Request.ExpectedArticleRevision, await RevisionAsync(db, data.Request.SourceArticleId));
        Assert.Equal(outbox, await CountAsync(db, "article_mutation_outbox"));
        Assert.Equal(0, await CountAsync(db, "article_canvas_link_journal"));
        Assert.Equal(0, await CountAsync(db, "article_canvas_link_history"));
    }

    private static async Task<long> CountAsync(SqlSugarClient db, string table)
        => Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT count(*) FROM " + table), CultureInfo.InvariantCulture);
    private static async Task<long> RevisionAsync(SqlSugarClient db, int id)
        => Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT current_revision_id FROM article WHERE id = @Id", new SugarParameter("@Id", id)), CultureInfo.InvariantCulture);
    private static Task<string> SourceAsync(SqlSugarClient db, int id)
        => db.Ado.GetStringAsync("SELECT markdown_content FROM article_body WHERE article_id = @Id", new SugarParameter("@Id", id));

    private async Task<(SqlSugarClient Db, ArticleService Service, AuthoringCanvasDocumentStore Documents,
        AuthoringCanvasOwner Owner, AuthoringCanvasDocumentHeader Header, ArticleCanvasLinkRequest Request, int CategoryId,
        IHttpContextAccessor RequestContext)> SeedAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(ArticleBody), typeof(ArticleTag), typeof(Category), typeof(Tag),
            typeof(ArticleRevision), typeof(ArticleRevisionContentBlock), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem),
            typeof(ArticleRightsPolicy), typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot), typeof(ArticleRightsProof),
            typeof(ArticlePublicationRecord), typeof(ArticleMutationOutboxEvent), typeof(ArticleMutationCommand), typeof(AdminPrincipal));
        foreach (var migration in new[] { AuthoringCanvasDocumentMigrationDefinitions.BuildMigration(), ArticleCanvasLinkMigrationDefinitions.BuildMigration() })
            foreach (var step in migration.Steps)
                await step.ExecuteAsync(db, CancellationToken.None);
        int category = await db.Insertable(new Category { Name = "isolated-link-category" }).ExecuteReturnIdentityAsync();
        long admin = await db.Insertable(new AdminPrincipal
        {
            Handle = "isolated-link-admin",
            Status = AdminPrincipalStatus.Active,
            IsRoot = true,
            Permissions = AdminPermissions.ArticleWrite
        }).ExecuteReturnBigIdentityAsync();
        var owner = new AuthoringCanvasOwner(admin, "primary-site");
        var documents = new AuthoringCanvasDocumentStore(db, TimeProvider.System);
        ArticleService service = CreateService(db, admin, documents, out IHttpContextAccessor requestContext);
        int source = await service.CreateAsync(new ArticleWriteRequestCoreModel("source", "before", "summary", null, category, [], (int)ArticleStatus.Draft));
        int target = await service.CreateAsync(new ArticleWriteRequestCoreModel("target", "target body", "summary", null, category, [], (int)ArticleStatus.Draft));
        Guid canvas = Guid.CreateVersion7();
        AuthoringCanvasWriteReceipt written = await documents.CreateAsync(new CreateAuthoringCanvasCommand(canvas, owner, "links", new(0, 0, 1), Guid.CreateVersion7()));
        Guid sourceNode = Guid.CreateVersion7(), targetNode = Guid.CreateVersion7(), edge = Guid.CreateVersion7();
        foreach (var node in new[] { new AuthoringCanvasNode(sourceNode, AuthoringCanvasNodeType.ArticleReference, 0, new(0, 0, 200, 100), TargetArticleId: source, ReferenceState: AuthoringCanvasReferenceState.Unresolved),
            new AuthoringCanvasNode(targetNode, AuthoringCanvasNodeType.ArticleReference, 1, new(220, 0, 200, 100), TargetArticleId: target, ReferenceState: AuthoringCanvasReferenceState.Unresolved) })
            written = await documents.PutNodeAsync(new PutAuthoringCanvasNodeCommand(canvas, owner, written.Revision, Guid.CreateVersion7(), node));
        written = await documents.PutEdgeAsync(new PutAuthoringCanvasEdgeCommand(canvas, owner, written.Revision, Guid.CreateVersion7(),
            new AuthoringCanvasEdge(edge, AuthoringCanvasEdgeType.ExplicitReferenceNote, 0, sourceNode, targetNode)));
        AuthoringCanvasDocumentHeader header = (await documents.GetAsync(owner, canvas))!;
        return (db, service, documents, owner, header, new ArticleCanvasLinkRequest(Guid.CreateVersion7(), source,
            await RevisionAsync(db, source), ArticleCanvasLinkMode.Apply, Guid.Empty, canvas, header.Revision, header.ContentDigest,
            edge, target, await RevisionAsync(db, target)), category, requestContext);
    }

    private static ArticleService CreateService(
        SqlSugarClient db,
        long adminId, AuthoringCanvasDocumentStore documents, out IHttpContextAccessor requestContext)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        var runtimeKeyScope = Substitute.For<IRuntimeKeyScope>();
        runtimeKeyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim("admin_id", adminId.ToString(CultureInfo.InvariantCulture)),
             new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
             new Claim("admin_sid", "isolated-provider-fixture")], "fixture"))
        };
        // An AsyncLocal assignment made inside SeedAsync does not flow back to its awaiting caller.
        // Bind this fixture's explicit request context while retaining the production identity checks.
        requestContext = Substitute.For<IHttpContextAccessor>();
        requestContext.HttpContext.Returns(context);

        return new ArticleService(
            _db: db,
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: new ImmediateDbConcurrencyGate(),
            _runtimeKeyScope: runtimeKeyScope,
            _httpContextAccessor: requestContext,
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue(),
            _authoringCanvasDocuments: documents,
            _authoringCanvasCoordinates: new PostgresAuthoringCanvasCoordinateAuthority(db));
    }

}
