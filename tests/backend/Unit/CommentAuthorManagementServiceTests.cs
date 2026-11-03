using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CommentAuthorManagementServiceTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset s_baseline = new(2026, 7, 20, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task PublicAccountEdit_PreservesAssociationAndReturnsCommentToReview()
    {
        await using TestContext context = await CreateContextAsync();
        await context.InsertCommentAsync(id: 101, userId: 7, capabilityHash: null, CommentAuthorModes.Public);
        CommentManagementChallengeResult issued = await context.Service.IssueAccountChallengeAsync(
            101,
            7,
            CommentManagementPurposes.Edit,
            CancellationToken.None);

        CommentAuthorMutationResult result = await context.Service.EditAsAccountAsync(
            101,
            7,
            new CommentEditRequest(1, "edited public content", issued.Challenge!),
            CancellationToken.None);

        Assert.True(result.Success);
        Assert.Equal(2, result.CurrentVersion);
        Assert.Equal(CommentModerationStatus.Pending, result.ModerationStatus);
        Comment stored = await context.Db.Queryable<Comment>().InSingleAsync(101);
        Assert.Equal(7, stored.UserId);
        Assert.Null(stored.ManagementCapabilityHash);
        Assert.Equal("edited public content", stored.Content);
        Assert.Equal(2, stored.CurrentVersion);
        Assert.Equal(CommentModerationStatus.Pending, stored.ModerationStatus);
        Assert.Equal("pending_edit_review", stored.ModerationReason);
        CommentRevision revision = Assert.Single(await context.Db.Queryable<CommentRevision>().ToListAsync());
        Assert.Equal(7, revision.ActorAccountId);
        Assert.Equal(CommentRevisionOperations.Edited, revision.Operation);
    }

    [Fact]
    public async Task PublicAccountEdit_NormalizesBeforeSharedRevisionAndWriterAllocatesRevisionId()
    {
        await using TestContext context = await CreateContextAsync();
        await context.InsertCommentAsync(id: 801, userId: 7, capabilityHash: null, CommentAuthorModes.Public);
        CommentManagementChallengeResult issued = await context.Service.IssueAccountChallengeAsync(
            801, 7, CommentManagementPurposes.Edit, CancellationToken.None);

        CommentAuthorMutationResult result = await context.Service.EditAsAccountAsync(
            801, 7, new CommentEditRequest(1, "  edited public\r\ncontent  ", issued.Challenge!),
            CancellationToken.None);

        Assert.True(result.Success);
        Comment stored = await context.Db.Queryable<Comment>().InSingleAsync(801);
        CommentRevision revision = Assert.Single(await context.Db.Queryable<CommentRevision>().ToListAsync());
        Assert.Equal("edited public\ncontent", stored.Content);
        Assert.Equal(stored.Content, revision.Content);
        Assert.Equal("b884acd127d69531e8a7bdf2c071673064476c44e90baab685c7ebe2dce05629", revision.ContentSha256);
        Assert.True(revision.Id > 0);
        Assert.Equal(801, revision.CommentId);
        Assert.Equal(2, revision.Version);
        Assert.Equal(CommentRevisionOperations.Edited, revision.Operation);
        Assert.Equal(s_baseline.UtcDateTime, revision.CreatedAtUtc);
        Assert.Equal(7, revision.ActorAccountId);
        Assert.Null(revision.ActorAdminPrincipalId);
    }

    [Fact]
    public async Task StrongAnonymousEdit_KeepsAccountAssociationAbsentAndCreatesRevision()
    {
        await using TestContext context = await CreateContextAsync();
        CommentManagementCapability capability = context.Capabilities.IssueCapability();
        await context.InsertCommentAsync(201, userId: null, capability.Commitment, CommentAuthorModes.ZkAnonymous);
        CommentManagementChallengeResult issued = await context.Capabilities.IssueChallengeAsync(
            201,
            capability.Secret,
            CommentManagementPurposes.Edit,
            CancellationToken.None);

        CommentAuthorMutationResult result = await context.Service.EditAsAnonymousAsync(
            201,
            capability.Secret,
            new CommentEditRequest(1, "edited anonymous content", issued.Challenge!),
            CancellationToken.None);

        Assert.True(result.Success);
        Comment stored = await context.Db.Queryable<Comment>().InSingleAsync(201);
        Assert.Null(stored.UserId);
        Assert.Equal(capability.Commitment, stored.ManagementCapabilityHash);
        Assert.Equal(CommentModerationStatus.Pending, stored.ModerationStatus);
        CommentRevision revision = Assert.Single(await context.Db.Queryable<CommentRevision>().ToListAsync());
        Assert.Null(revision.ActorAccountId);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, revision.ActorMode);
    }

    [Fact]
    public async Task EditVersionConflict_DoesNotConsumeChallengeAndFreshVersionCanRetry()
    {
        await using TestContext context = await CreateContextAsync();
        await context.InsertCommentAsync(id: 301, userId: 9, capabilityHash: null, CommentAuthorModes.Public);
        CommentManagementChallengeResult issued = await context.Service.IssueAccountChallengeAsync(
            301,
            9,
            CommentManagementPurposes.Edit,
            CancellationToken.None);

        CommentAuthorMutationResult conflict = await context.Service.EditAsAccountAsync(
            301,
            9,
            new CommentEditRequest(99, "conflicting content", issued.Challenge!),
            CancellationToken.None);
        CommentAuthorMutationResult retry = await context.Service.EditAsAccountAsync(
            301,
            9,
            new CommentEditRequest(1, "retry succeeds", issued.Challenge!),
            CancellationToken.None);

        Assert.False(conflict.Success);
        Assert.Equal("comment_version_conflict", conflict.Code);
        Assert.Equal(1, conflict.CurrentVersion);
        Assert.True(retry.Success);
        Assert.Equal(2, retry.CurrentVersion);
    }

    [Fact]
    public async Task StrongAnonymousDelete_IsSoftDeleteVersionedAndCannotReplayChallenge()
    {
        await using TestContext context = await CreateContextAsync();
        CommentManagementCapability capability = context.Capabilities.IssueCapability();
        await context.InsertCommentAsync(401, userId: null, capability.Commitment, CommentAuthorModes.ZkAnonymous);
        CommentManagementChallengeResult issued = await context.Capabilities.IssueChallengeAsync(
            401,
            capability.Secret,
            CommentManagementPurposes.Delete,
            CancellationToken.None);

        CommentAuthorMutationResult deleted = await context.Service.DeleteAsAnonymousAsync(
            401,
            capability.Secret,
            issued.Challenge!,
            CancellationToken.None);
        CommentAuthorMutationResult replay = await context.Service.DeleteAsAnonymousAsync(
            401,
            capability.Secret,
            issued.Challenge!,
            CancellationToken.None);

        Assert.True(deleted.Success);
        Assert.Equal(2, deleted.CurrentVersion);
        Assert.False(replay.Success);
        Comment stored = await context.Db.Queryable<Comment>().InSingleAsync(401);
        Assert.True(stored.IsDeleted);
        Assert.Equal("author_deleted", stored.DeleteReason);
        Assert.Equal(2, stored.CurrentVersion);
        CommentRevision revision = Assert.Single(await context.Db.Queryable<CommentRevision>().ToListAsync());
        Assert.Equal(CommentRevisionOperations.Deleted, revision.Operation);
        Assert.Null(revision.ActorAccountId);
    }

    [Fact]
    public async Task AccountChallenge_DoesNotAssociateOrAuthorizeStrongAnonymousComment()
    {
        await using TestContext context = await CreateContextAsync();
        CommentManagementCapability capability = context.Capabilities.IssueCapability();
        await context.InsertCommentAsync(501, userId: null, capability.Commitment, CommentAuthorModes.ZkAnonymous);

        CommentManagementChallengeResult issued = await context.Service.IssueAccountChallengeAsync(
            501,
            7,
            CommentManagementPurposes.Edit,
            CancellationToken.None);
        CommentAuthorMutationResult edit = await context.Service.EditAsAccountAsync(
            501,
            7,
            new CommentEditRequest(1, "must not associate account", "unused"),
            CancellationToken.None);

        Assert.False(issued.Issued);
        Assert.Equal("comment_management_not_found", issued.FailureCode);
        Assert.False(edit.Success);
        Assert.Equal("comment_management_not_found", edit.Code);
        Assert.Null((await context.Db.Queryable<Comment>().InSingleAsync(501)).UserId);
    }

    [Fact]
    public async Task PublicAccountDelete_ConsumesChallengeAndRecordsAccountRevision()
    {
        await using TestContext context = await CreateContextAsync();
        await context.InsertCommentAsync(id: 601, userId: 17, capabilityHash: null, CommentAuthorModes.Public);
        CommentManagementChallengeResult issued = await context.Service.IssueAccountChallengeAsync(
            601,
            17,
            CommentManagementPurposes.Delete,
            CancellationToken.None);

        CommentAuthorMutationResult deleted = await context.Service.DeleteAsAccountAsync(
            601,
            17,
            issued.Challenge!,
            CancellationToken.None);
        CommentAuthorMutationResult replay = await context.Service.DeleteAsAccountAsync(
            601,
            17,
            issued.Challenge!,
            CancellationToken.None);

        Assert.True(deleted.Success);
        Assert.False(replay.Success);
        CommentRevision revision = Assert.Single(await context.Db.Queryable<CommentRevision>().ToListAsync());
        Assert.Equal(17, revision.ActorAccountId);
        Assert.Equal(CommentRevisionOperations.Deleted, revision.Operation);
    }

    [Fact]
    public async Task StrongAnonymousStatusAndAppeal_AreCapabilityBoundAndSingleUse()
    {
        await using TestContext context = await CreateContextAsync();
        CommentManagementCapability capability = context.Capabilities.IssueCapability();
        await context.InsertCommentAsync(701, userId: null, capability.Commitment, CommentAuthorModes.ZkAnonymous);
        CommentManagementChallengeResult statusChallenge = await context.Capabilities.IssueChallengeAsync(
            701,
            capability.Secret,
            CommentManagementPurposes.Status,
            CancellationToken.None);

        CommentAuthorStatusResult status = await context.Service.ReadAnonymousStatusAsync(
            701,
            capability.Secret,
            statusChallenge.Challenge!,
            CancellationToken.None);
        CommentAuthorStatusResult replayedStatus = await context.Service.ReadAnonymousStatusAsync(
            701,
            capability.Secret,
            statusChallenge.Challenge!,
            CancellationToken.None);
        CommentManagementChallengeResult appealChallenge = await context.Capabilities.IssueChallengeAsync(
            701,
            capability.Secret,
            CommentManagementPurposes.Appeal,
            CancellationToken.None);
        CommentAuthorMutationResult appeal = await context.Service.AppealAsAnonymousAsync(
            701,
            capability.Secret,
            new CommentAppealRequest("Please review this moderation decision.", appealChallenge.Challenge!),
            CancellationToken.None);

        Assert.True(status.Found);
        Assert.False(replayedStatus.Found);
        Assert.True(appeal.Success);
        CommentAuthorAppeal storedAppeal = Assert.Single(await context.Db.Queryable<CommentAuthorAppeal>().ToListAsync());
        Assert.Null(storedAppeal.AccountId);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, storedAppeal.AuthorMode);
    }

    private async Task<TestContext> CreateContextAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        var db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Comment),
            typeof(CommentManagementChallenge),
            typeof(CommentRevision),
            typeof(CommentAuthorAppeal),
            typeof(CommentModerationEvent));
        return new TestContext(db);
    }

    private sealed class TestContext : IAsyncDisposable
    {
        private readonly ICommentModerationService _moderation;

        public TestContext(SqlSugarClient db)
        {
            Db = db;
            Capabilities = new CommentManagementCapabilityService(db, new FixedTimeProvider(s_baseline));
            _moderation = Substitute.For<ICommentModerationService>();
            _moderation.ResolveSubmissionRegion(
                    Arg.Any<string>(),
                    Arg.Any<int>(),
                    Arg.Any<int>(),
                    Arg.Any<RegionModerationDecision?>())
                .Returns(AllowedRegion());
            _moderation.ResolveInitialState(Arg.Any<CommentActor>(), Arg.Any<RegionModerationDecision>())
                .Returns(new CommentInitialModerationDecision(
                    CommentModerationStatus.Pending,
                    "pending_edit_review"));
            _moderation.PersistVisibilityAsync(
                    Arg.Any<long>(),
                    Arg.Any<RegionModerationDecision>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.CompletedTask);
            _moderation.ApplyPostInsertAsync(
                    Arg.Any<Comment>(),
                    Arg.Any<CommentModerationActorContext>(),
                    Arg.Any<RegionModerationDecision>(),
                    Arg.Any<CancellationToken>())
                .Returns(Task.CompletedTask);

            var contentFilter = Substitute.For<IContentFilterService>();
            contentFilter.ValidateContent(Arg.Any<string>())
                .Returns(new ContentValidationResult(true, "ok", "ok"));
            var outbox = Substitute.For<ICommentMutationOutbox>();
            outbox.EnqueueAsync(Arg.Any<CommentMutationOutboxEvent>(), Arg.Any<CancellationToken>())
                .Returns(Task.CompletedTask);
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Comments:AuthorEditWindowMinutes"] = "30"
                })
                .Build();
            Service = new CommentAuthorManagementService(
                db,
                Capabilities,
                _moderation,
                contentFilter,
                outbox,
                configuration,
                new FixedTimeProvider(s_baseline));
        }

        public SqlSugarClient Db
        {
            get;
        }

        public CommentManagementCapabilityService Capabilities
        {
            get;
        }

        public CommentAuthorManagementService Service
        {
            get;
        }

        public Task<int> InsertCommentAsync(long id, int? userId, string? capabilityHash, string authorMode)
            => Db.Insertable(new Comment
            {
                Id = id,
                ArticleId = 42,
                Content = "original content",
                CreateTime = s_baseline.AddMinutes(-5).UtcDateTime,
                CurrentVersion = 1,
                UserId = userId,
                AuthorMode = authorMode,
                PublicHandle = userId is null ? null : "public-author",
                AnonymousHandle = userId is null ? "anonymous-author" : null,
                ManagementCapabilityHash = capabilityHash,
                ModerationStatus = CommentModerationStatus.Approved,
                ModerationReason = "approved_before_edit"
            }).ExecuteCommandAsync();

        public ValueTask DisposeAsync()
        {
            Db.Dispose();
            return ValueTask.CompletedTask;
        }

        private static RegionModerationDecision AllowedRegion()
            => new(
                true,
                RegionCodes.Global,
                1d,
                "test",
                null,
                [],
                [],
                [],
                "test-policy",
                "allow",
                "allow",
                false,
                false);
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
