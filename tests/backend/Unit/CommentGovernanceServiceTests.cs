using System.Security.Cryptography;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CommentGovernanceServiceTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTime s_now = new(2026, 7, 20, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task Reports_DeduplicateAndNeverChangeVisibility()
    {
        await using TestContext context = await CreateContextAsync();
        await context.InsertCommentAsync(101, CommentModerationStatus.Approved, userId: 7);

        CommentReportResult first = await context.Service.ReportAsAccountAsync(101, 9, new("spam", "links"), default);
        CommentReportResult duplicate = await context.Service.ReportAsAccountAsync(101, 9, new("hate", "changed"), default);

        Assert.True(first.Success);
        Assert.True(duplicate.Duplicate);
        Assert.Single(await context.Db.Queryable<CommentReport>().ToListAsync());
        Assert.Equal(CommentModerationStatus.Approved, (await context.Db.Queryable<Comment>().InSingleAsync(101)).ModerationStatus);
    }

    [Fact]
    public async Task AnonymousReportCredential_IsScopedPerComment()
    {
        await using TestContext context = await CreateContextAsync();
        await context.InsertCommentAsync(201, CommentModerationStatus.Approved);
        await context.InsertCommentAsync(202, CommentModerationStatus.Approved);
        const string ScopedCredential = "scoped-credential-with-at-least-thirty-two-bytes";

        Assert.False((await context.Service.ReportAsScopedAnonymousAsync(201, new("privacy", null, "short"), default)).Success);
        Assert.True((await context.Service.ReportAsScopedAnonymousAsync(201, new("privacy", null, ScopedCredential), default)).Success);
        Assert.True((await context.Service.ReportAsScopedAnonymousAsync(201, new("privacy", null, ScopedCredential), default)).Duplicate);
        Assert.True((await context.Service.ReportAsScopedAnonymousAsync(202, new("privacy", null, ScopedCredential), default)).Success);
        List<CommentReport> reports = await context.Db.Queryable<CommentReport>().OrderBy(item => item.CommentId).ToListAsync();
        Assert.Equal(2, reports.Count);
        Assert.NotEqual(reports[0].ReporterScopeHash, reports[1].ReporterScopeHash);
        Assert.All(reports, item => Assert.Null(item.ReporterAccountId));
    }

    [Fact]
    public async Task AnonymousAppeal_IsCapabilityBoundAndLimitedPerDecision()
    {
        await using TestContext context = await CreateContextAsync();
        CommentManagementCapability capability = context.Capabilities.IssueCapability();
        await context.InsertCommentAsync(301, CommentModerationStatus.Hidden, capabilityHash: capability.Commitment);
        await context.InsertDecisionAsync(301, CommentModerationStatus.Hidden, 11);
        CommentManagementChallengeResult firstChallenge = await context.Capabilities.IssueChallengeAsync(301, capability.Secret, CommentManagementPurposes.Appeal, default);

        CommentAppealResult first = await context.Service.AppealAsAnonymousAsync(301, capability.Secret, new("Please review this hidden comment.", firstChallenge.Challenge!), default);
        CommentManagementChallengeResult secondChallenge = await context.Capabilities.IssueChallengeAsync(301, capability.Secret, CommentManagementPurposes.Appeal, default);
        CommentAppealResult second = await context.Service.AppealAsAnonymousAsync(301, capability.Secret, new("A second appeal must be rejected.", secondChallenge.Challenge!), default);

        Assert.True(first.Success);
        Assert.Equal("comment_appeal_limit_reached", second.Code);
        Assert.Null(Assert.Single(await context.Db.Queryable<CommentAuthorAppeal>().ToListAsync()).AccountId);
    }

    [Fact]
    public async Task Review_RequiresDifferentAdmin()
    {
        await using TestContext context = await CreateContextAsync();
        await context.InsertCommentAsync(401, CommentModerationStatus.Rejected, userId: 17);
        await context.InsertDecisionAsync(401, CommentModerationStatus.Rejected, 51);
        string challenge = await context.InsertChallengeAsync(401);
        CommentAppealResult submitted = await context.Service.AppealAsAccountAsync(401, 17, new("The decision should be reviewed independently.", challenge), default);

        CommentAppealResult conflict = await context.Service.ReviewAppealAsync(submitted.AppealId!.Value, 51, new("denied", "Independent review is required."), default);
        CommentAppealResult reviewed = await context.Service.ReviewAppealAsync(submitted.AppealId.Value, 52, new("granted", "The original decision was not justified."), default);

        Assert.Equal("comment_appeal_reviewer_conflict", conflict.Code);
        Assert.True(reviewed.Success);
        CommentAuthorAppeal appeal = await context.Db.Queryable<CommentAuthorAppeal>().InSingleAsync(submitted.AppealId.Value);
        Assert.Equal(52, appeal.ReviewerAdminPrincipalId);
        Assert.Equal("granted", appeal.Decision);
    }

    [Fact]
    public async Task Timeline_RebuildsCurrentProjection()
    {
        await using TestContext context = await CreateContextAsync();
        await context.InsertCommentAsync(501, CommentModerationStatus.Hidden);
        await context.Db.Insertable(new[]
        {
            context.Event(501, CommentModerationEventTypes.Create, null, CommentModerationStatus.Pending),
            context.Event(501, CommentModerationEventTypes.Hide, CommentModerationStatus.Pending, CommentModerationStatus.Hidden)
        }).ExecuteCommandAsync();

        CommentModerationTimelineResult timeline = (await context.Service.ReadTimelineAsync(501, default))!;
        Assert.True(timeline.Consistent);
        Assert.Equal(CommentModerationStatus.Hidden, timeline.ProjectedStatus);
    }

    [Theory]
    [InlineData(CommentModerationStatus.Hidden, "granted")]
    [InlineData(CommentModerationStatus.Rejected, "granted")]
    [InlineData(CommentModerationStatus.Hidden, "denied")]
    [InlineData(CommentModerationStatus.Rejected, "denied")]
    public async Task Review_PreservesContinuousHistoryAndRejectsReplay(CommentModerationStatus previous, string decision)
    {
        await using TestContext context = await CreateContextAsync();
        long appealId = await context.SubmitAppealAsync(previous);
        CommentModerationTimelineResult before = (await context.Service.ReadTimelineAsync(601, default))!;
        Assert.True(before.Consistent);
        string history = System.Text.Json.JsonSerializer.Serialize(before.Events);

        CommentAppealResult reviewed = await context.Service.ReviewAppealAsync(appealId, 52, new(decision, "The decision was independently reviewed."), default);

        Assert.True(reviewed.Success);
        CommentModerationTimelineResult after = (await context.Service.ReadTimelineAsync(601, default))!;
        CommentModerationStatus expected = decision == "granted" ? CommentModerationStatus.Approved : previous;
        CommentModerationEvent appended = after.Events[^1];
        Assert.Equal(previous, appended.PreviousStatus);
        Assert.Equal(expected, appended.NextStatus);
        Assert.Equal(CommentModerationEventTypes.AppealDecision, appended.EventType);
        Assert.Equal(appealId, appended.AppealId);
        Assert.Equal(52, appended.AdminPrincipalId);
        Assert.Equal($"appeal_{decision}", appended.ReasonCode);
        Assert.Equal(context.Clock.Now, appended.OccurredAtUtc);
        Assert.Equal(before.Events.Count + 1, after.Events.Count);
        Assert.Equal(history, System.Text.Json.JsonSerializer.Serialize(after.Events.Take(before.Events.Count)));
        Assert.True(after.Consistent);
        Assert.Equal(expected, after.ProjectedStatus);
        Assert.Equal(expected, after.CurrentStatus);
        CommentAuthorAppeal appeal = await context.Db.Queryable<CommentAuthorAppeal>().InSingleAsync(appealId);
        Assert.Equal("decided", appeal.Status);
        Assert.Equal(decision, appeal.Decision);

        CommentAppealResult replay = await context.Service.ReviewAppealAsync(appealId, 53, new(decision, "The repeated command must not append history."), default);

        Assert.Equal("comment_appeal_not_found", replay.Code);
        Assert.Equal(System.Text.Json.JsonSerializer.Serialize(after.Events),
            System.Text.Json.JsonSerializer.Serialize((await context.Service.ReadTimelineAsync(601, default))!.Events));
    }

    [Theory]
    [InlineData(CommentModerationStatus.Hidden)]
    [InlineData(CommentModerationStatus.Rejected)]
    public async Task Review_EventFailureRollsBackDecisionAndComment(CommentModerationStatus previous)
    {
        await using TestContext context = await CreateContextAsync();
        long appealId = await context.SubmitAppealAsync(previous);
        string history = System.Text.Json.JsonSerializer.Serialize((await context.Service.ReadTimelineAsync(601, default))!.Events);
        await context.Db.Ado.ExecuteCommandAsync("""
            ALTER TABLE comment_moderation_event
            ADD CONSTRAINT reject_appeal_decision CHECK (event_type <> 'appeal_decision');
            """);

        CommentAppealResult failed = await context.Service.ReviewAppealAsync(appealId, 52, new("granted", "This event write is forced to fail."), default);

        Assert.Equal("comment_appeal_conflict", failed.Code);
        CommentAuthorAppeal appeal = await context.Db.Queryable<CommentAuthorAppeal>().InSingleAsync(appealId);
        Assert.Equal("pending", appeal.Status);
        Assert.Null(appeal.Decision);
        Assert.Null(appeal.DecidedAtUtc);
        Assert.Null(appeal.ReviewerAdminPrincipalId);
        Comment comment = await context.Db.Queryable<Comment>().InSingleAsync(601);
        Assert.Equal(previous, comment.ModerationStatus);
        Assert.Null(comment.ModerationReason);
        Assert.Null(comment.ModeratedByAdminPrincipalId);
        Assert.Null(comment.ModeratedAt);
        CommentModerationTimelineResult timeline = (await context.Service.ReadTimelineAsync(601, default))!;
        Assert.True(timeline.Consistent);
        Assert.Equal(history, System.Text.Json.JsonSerializer.Serialize(timeline.Events));
    }

    [Theory]
    [InlineData(CommentModerationStatus.Hidden)]
    [InlineData(CommentModerationStatus.Rejected)]
    public async Task Review_ReviewerConflictDoesNotAppendOrDecide(CommentModerationStatus previous)
    {
        await using TestContext context = await CreateContextAsync();
        long appealId = await context.SubmitAppealAsync(previous);
        string history = System.Text.Json.JsonSerializer.Serialize((await context.Service.ReadTimelineAsync(601, default))!.Events);

        CommentAppealResult failed = await context.Service.ReviewAppealAsync(appealId, 51, new("granted", "The original reviewer cannot decide this appeal."), default);

        Assert.Equal("comment_appeal_reviewer_conflict", failed.Code);
        Assert.Equal("pending", (await context.Db.Queryable<CommentAuthorAppeal>().InSingleAsync(appealId)).Status);
        Assert.Equal(previous, (await context.Db.Queryable<Comment>().InSingleAsync(601)).ModerationStatus);
        Assert.Equal(history, System.Text.Json.JsonSerializer.Serialize((await context.Service.ReadTimelineAsync(601, default))!.Events));
    }

    [Fact]
    public async Task Appeal_WrongAuthorOrCapabilityDoesNotAppend()
    {
        await using TestContext context = await CreateContextAsync();
        await context.SubmitAppealAsync(CommentModerationStatus.Hidden);
        int count = await context.Db.Queryable<CommentModerationEvent>().CountAsync();
        string challenge = await context.InsertChallengeAsync(601);

        CommentAppealResult account = await context.Service.AppealAsAccountAsync(601, 18, new("A different author cannot appeal this comment.", challenge), default);
        CommentAppealResult anonymous = await context.Service.AppealAsAnonymousAsync(601, "incorrect-capability", new("An invalid capability cannot appeal this comment.", challenge), default);

        Assert.Equal("comment_management_not_found", account.Code);
        Assert.Equal("comment_management_capability_invalid", anonymous.Code);
        Assert.Equal(count, await context.Db.Queryable<CommentModerationEvent>().CountAsync());
        Assert.Single(await context.Db.Queryable<CommentAuthorAppeal>().ToListAsync());
    }

    [Theory]
    [InlineData(CommentModerationStatus.Hidden)]
    [InlineData(CommentModerationStatus.Rejected)]
    public async Task Timeline_RejectsExistingGrantedAppealGapWithoutRepair(CommentModerationStatus previous)
    {
        await using TestContext context = await CreateContextAsync();
        await context.InsertCommentAsync(701, CommentModerationStatus.Approved);
        await context.Db.Insertable(new[]
        {
            context.Event(701, CommentModerationEventTypes.Create, null, CommentModerationStatus.Pending),
            context.Event(701, previous == CommentModerationStatus.Hidden ? CommentModerationEventTypes.Hide : CommentModerationEventTypes.Reject,
                CommentModerationStatus.Pending, previous),
            context.Event(701, CommentModerationEventTypes.AppealDecision, CommentModerationStatus.Approved, CommentModerationStatus.Approved)
        }).ExecuteCommandAsync();
        string history = System.Text.Json.JsonSerializer.Serialize(await context.Db.Queryable<CommentModerationEvent>().OrderBy(item => item.Id).ToListAsync());

        CommentModerationTimelineResult timeline = (await context.Service.ReadTimelineAsync(701, default))!;

        Assert.False(timeline.Consistent);
        Assert.Equal(CommentModerationStatus.Approved, timeline.ProjectedStatus);
        Assert.Equal(CommentModerationStatus.Approved, timeline.CurrentStatus);
        Assert.Equal(history, System.Text.Json.JsonSerializer.Serialize(await context.Db.Queryable<CommentModerationEvent>().OrderBy(item => item.Id).ToListAsync()));
    }

    private async Task<TestContext> CreateContextAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        var db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Comment), typeof(CommentReport), typeof(CommentModerationEvent), typeof(CommentManagementChallenge), typeof(CommentAuthorAppeal));
        return new(db);
    }

    private sealed class TestContext : IAsyncDisposable
    {
        public TestContext(SqlSugarClient db)
        {
            Db = db;
            Capabilities = new(db, Clock);
            Service = new(db, Capabilities, Substitute.For<IAuditEventService>(),
                new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Moderation:ReportPepper"] = "test-report-pepper-that-is-at-least-32-characters",
                    ["Moderation:Appeals:RequireDifferentReviewer"] = "true"
                }).Build(), Clock);
        }

        public FixedTimeProvider Clock { get; } = new();

        public SqlSugarClient Db
        {
            get;
        }
        public CommentManagementCapabilityService Capabilities
        {
            get;
        }
        public CommentGovernanceService Service
        {
            get;
        }

        public Task InsertCommentAsync(long id, CommentModerationStatus status, int? userId = null, string? capabilityHash = null)
            => Db.Insertable(new Comment
            {
                Id = id,
                ArticleId = 1,
                Content = "content",
                CreateTime = s_now,
                CurrentVersion = 1,
                UserId = userId,
                AuthorMode = capabilityHash is null ? CommentAuthorModes.Public : CommentAuthorModes.ZkAnonymous,
                ManagementCapabilityHash = capabilityHash,
                ModerationStatus = status,
                Depth = 0
            }).ExecuteCommandAsync();

        public Task InsertDecisionAsync(long commentId, CommentModerationStatus status, long adminId)
            => Db.Insertable(Event(commentId, status == CommentModerationStatus.Hidden ? CommentModerationEventTypes.Hide : CommentModerationEventTypes.Reject,
                CommentModerationStatus.Pending, status, adminId)).ExecuteCommandAsync();

        public CommentModerationEvent Event(long commentId, string type, CommentModerationStatus? previous, CommentModerationStatus next, long? adminId = null)
            => new()
            {
                CommentId = commentId,
                EventType = type,
                PreviousStatus = previous,
                NextStatus = next,
                ActorType = adminId.HasValue ? "admin" : "system",
                TransitionSource = adminId.HasValue ? "admin" : "system",
                AdminPrincipalId = adminId,
                OccurredAtUtc = s_now.AddMinutes(type == CommentModerationEventTypes.Create ? 0 : 1)
            };

        public async Task<string> InsertChallengeAsync(long commentId)
        {
            string challenge = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            await Db.Insertable(new CommentManagementChallenge { ChallengeHash = CommentManagementCapabilityService.ComputeCommitment(challenge), CommentId = commentId, Purpose = CommentManagementPurposes.Appeal, ExpiresAtUtc = s_now.AddMinutes(5) }).ExecuteCommandAsync();
            return challenge;
        }

        public async Task<long> SubmitAppealAsync(CommentModerationStatus status)
        {
            await InsertCommentAsync(601, status, userId: 17);
            await Db.Insertable(Event(601, CommentModerationEventTypes.Create, null, CommentModerationStatus.Pending)).ExecuteCommandAsync();
            await InsertDecisionAsync(601, status, 51);
            Clock.Now = s_now.AddMinutes(2);
            string challenge = await InsertChallengeAsync(601);
            CommentAppealResult submitted = await Service.AppealAsAccountAsync(601, 17, new("Please independently review this decision.", challenge), default);
            Assert.True(submitted.Success);
            Clock.Now = s_now.AddMinutes(3);
            return submitted.AppealId!.Value;
        }

        public ValueTask DisposeAsync()
        {
            Db.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class FixedTimeProvider : TimeProvider
    {
        public DateTime Now { get; set; } = s_now;

        public override DateTimeOffset GetUtcNow() => new(Now);
    }
}
