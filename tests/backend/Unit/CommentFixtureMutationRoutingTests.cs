using System.Linq.Expressions;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Security;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary command routing with read-port models; no transaction/native qualification.</summary>
public sealed class CommentFixtureMutationRoutingTests
{
    [Theory]
    [InlineData("edit")]
    [InlineData("soft-delete")]
    [InlineData("moderate")]
    [InlineData("report")]
    [InlineData("appeal")]
    [InlineData("review-appeal")]
    public async Task MutationOnlyEntry_UsesFormalCommandAndRereadsAuthority(string kind)
    {
        var model = new Model(kind);
        CommentFixtureMutationResult result = await model.Port.ExecuteMutationAsync(model.Plan);

        Assert.Equal(model.Plan.CommandDigest, result.CommandDigest);
        Assert.Equal(model.Before.CurrentVersion, result.Before.CurrentVersion);
        Assert.Equal(model.After.CurrentVersion, result.After.CurrentVersion);
        Assert.Equal(model.After.ModerationStatus, result.After.ModerationStatus);
        Assert.Equal(model.After.IsDeleted, result.After.IsDeleted);
        Assert.Equal(2, model.Author.ReceivedCalls().Count(call => call.GetMethodInfo().Name == "ReadRevisionsAsAdminAsync"));
        Assert.Equal(2, model.Governance.ReceivedCalls().Count(call => call.GetMethodInfo().Name == "ReadTimelineAsync"));
        Assert.Empty(model.PublicQueries.ReceivedCalls());
        Assert.Empty(model.InitialComments.ReceivedCalls());
        string json = JsonSerializer.Serialize(result);
        Assert.DoesNotContain("challenge-secret", json, StringComparison.Ordinal);
        Assert.DoesNotContain("claim-secret", json, StringComparison.Ordinal);

        switch (kind)
        {
            case "edit":
                await model.Author.Received(1).EditAsAccountAsync(41, 11,
                    new CommentEditRequest(1, "edited content", "challenge-secret"), CancellationToken.None);
                break;
            case "soft-delete":
                await model.Author.Received(1).DeleteAsAccountAsync(41, 11, "challenge-secret", CancellationToken.None);
                break;
            case "moderate":
                await model.Moderation.Received(1).ModerateCommentAsync(91, 41,
                    ((CommentFixtureModerate)model.Plan.Command).Request, CancellationToken.None);
                break;
            case "report":
                await model.Governance.Received(1).ReportAsAccountAsync(41, 12,
                    ((CommentFixtureReport)model.Plan.Command).Request, CancellationToken.None);
                Assert.Equal(51, result.ReportId);
                break;
            case "appeal":
                await model.Governance.Received(1).AppealAsAccountAsync(41, 11,
                    new CommentAppealRequest("Please review this decision", "challenge-secret"), CancellationToken.None);
                Assert.Equal(61, result.AppealId);
                break;
            case "review-appeal":
                await model.Governance.Received(1).ReviewAppealAsync(61, 92,
                    ((CommentFixtureReviewAppeal)model.Plan.Command).Request, CancellationToken.None);
                Assert.Equal(61, result.AppealId);
                break;
        }
    }

    [Fact]
    public async Task CallerCancellation_StopsBeforeReadOrCommand()
    {
        var model = new Model("edit");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => model.Port.ExecuteMutationAsync(model.Plan,
            cancellation.Token));
        Assert.Empty(model.Db.ReceivedCalls());
        Assert.Empty(model.Author.ReceivedCalls());
        Assert.Empty(model.Governance.ReceivedCalls());
        Assert.Empty(model.Moderation.ReceivedCalls());
    }

    private sealed class Model
    {
        private static readonly DateTime s_now = new(2026, 7, 20, 12, 0, 0, DateTimeKind.Utc);
        private const string Owner = "comment-fixture:namespace:run-1";
        private const string Role = "fixture-root";
        private static string Digest => $"sha256:{new string('a', 64)}";
        public ISqlSugarClient Db { get; } = Substitute.For<ISqlSugarClient>();
        public ICommentAuthorManagementService Author { get; } = Substitute.For<ICommentAuthorManagementService>();
        public ICommentGovernanceService Governance { get; } = Substitute.For<ICommentGovernanceService>();
        public IAuthoringModerationCommands Moderation { get; } = Substitute.For<IAuthoringModerationCommands>();
        public ICommentQueryService PublicQueries { get; } = Substitute.For<ICommentQueryService>();
        public ICommentEndpointService InitialComments { get; } = Substitute.For<ICommentEndpointService>();
        public CommentThreadFixturePort Port
        {
            get;
        }
        public CommentFixtureMutationPlan Plan
        {
            get;
        }
        public Comment Before
        {
            get;
        }
        public Comment After
        {
            get;
        }

        public Model(string kind)
        {
            bool hidden = kind is "appeal" or "review-appeal";
            Before = Row(hidden ? CommentModerationStatus.Hidden : CommentModerationStatus.Approved, 1, false, "initial content");
            After = Row(kind switch
            {
                "edit" => CommentModerationStatus.Pending,
                "soft-delete" => CommentModerationStatus.Hidden,
                "moderate" => CommentModerationStatus.Rejected,
                _ => Before.ModerationStatus
            }, kind is "edit" or "soft-delete" ? 2 : 1, kind == "soft-delete",
                kind == "edit" ? "edited content" : Before.Content);
            var comments = Query<Comment>();
            comments.FirstAsync(Arg.Any<CancellationToken>()).Returns(Before, After);
            var outbox = Query<CommentMutationOutboxEvent>();
            outbox.ToListAsync(Arg.Any<CancellationToken>()).Returns([]);
            var appeals = Query<CommentAuthorAppeal>();
            appeals.FirstAsync(Arg.Any<CancellationToken>()).Returns(new CommentAuthorAppeal
            {
                Id = 61,
                CommentId = 41,
                Status = "pending",
                TargetModerationEventId = 31
            });
            var original = Revision(1, Before.Content, CommentRevisionOperations.Created);
            IReadOnlyList<CommentRevisionResult> afterRevisions = kind is "edit" or "soft-delete"
                ? [original, Revision(2, After.Content, kind == "edit" ? CommentRevisionOperations.Edited : CommentRevisionOperations.Deleted)]
                : [original];
            Author.ReadRevisionsAsAdminAsync(41, Arg.Any<CancellationToken>()).Returns([original], afterRevisions);
            List<CommentModerationEvent> beforeEvents = [Event(30, null, CommentModerationStatus.Approved, CommentModerationEventTypes.Create)];
            if (hidden)
                beforeEvents.Add(Event(31, CommentModerationStatus.Approved, CommentModerationStatus.Hidden, CommentModerationEventTypes.Hide));
            var afterEvents = new List<CommentModerationEvent>(beforeEvents)
            {
                Event(32, Before.ModerationStatus, After.ModerationStatus, kind)
            };
            Governance.ReadTimelineAsync(41, Arg.Any<CancellationToken>()).Returns(
                new CommentModerationTimelineResult(41, Before.ModerationStatus, Before.ModerationStatus, true, beforeEvents),
                new CommentModerationTimelineResult(41, After.ModerationStatus, After.ModerationStatus, true, afterEvents));
            Author.IssueAccountChallengeAsync(41, 11, Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(new CommentManagementChallengeResult(true, "challenge-secret", s_now.AddMinutes(5), null, 1));
            var mutation = new CommentAuthorMutationResult(true, "ok", After.CurrentVersion, After.ModerationStatus);
            Author.EditAsAccountAsync(41, 11, Arg.Any<CommentEditRequest>(), Arg.Any<CancellationToken>()).Returns(mutation);
            Author.DeleteAsAccountAsync(41, 11, Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(mutation);
            Moderation.ModerateCommentAsync(91, 41, Arg.Any<CommentModerationRequest>(), Arg.Any<CancellationToken>()).Returns(true);
            Governance.ReportAsAccountAsync(41, 12, Arg.Any<CommentReportRequest>(), Arg.Any<CancellationToken>())
                .Returns(new CommentReportResult(true, "ok", 51, false));
            Governance.AppealAsAccountAsync(41, 11, Arg.Any<CommentAppealRequest>(), Arg.Any<CancellationToken>())
                .Returns(new CommentAppealResult(true, "ok", 61));
            Governance.ReviewAppealAsync(61, 92, Arg.Any<CommentAppealDecisionRequest>(), Arg.Any<CancellationToken>())
                .Returns(new CommentAppealResult(true, "ok", 61));
            CommentFixtureMutationCommand command = kind switch
            {
                "edit" => new CommentFixtureEdit("edited content"),
                "soft-delete" => new CommentFixtureSoftDelete(),
                "moderate" => new CommentFixtureModerate(91, new CommentModerationRequest(CommentModerationStatus.Rejected,
                    "reviewed decision", ExpectedStatus: Before.ModerationStatus, CommentRowVersion: "comment-version",
                    ClaimToken: "claim-secret", ClaimGeneration: 1, ClaimRowVersion: "claim-version")),
                "report" => new CommentFixtureReport(12, new CommentReportRequest("spam", "observed content")),
                "appeal" => new CommentFixtureAppeal("Please review this decision"),
                "review-appeal" => new CommentFixtureReviewAppeal(61, 92, new CommentAppealDecisionRequest("denied", "Decision remains supported")),
                _ => throw new ArgumentException("Unknown command.", nameof(kind))
            };
            var binding = new CommentFixturePortBinding("run-1", "namespace", "fx-0123456789abcdef01234567", Owner,
                "comments-moderation", ["comment.moderation-matrix", "comment.threaded", "moderation.policy-matrix"], 42,
                Digest, [Digest, $"sha256:{new string('b', 64)}", $"sha256:{new string('c', 64)}"], Digest, Digest,
                Digest, Digest, Digest, Digest, Digest, Digest);
            Plan = new(binding, Role, new CommentThreadFixtureObservationIdentity(41, 11, CommentAuthorModes.Public,
                Digest, "comment.thread.root"), 1, Before.ModerationStatus, beforeEvents[^1].Id, s_now, Digest, Digest,
                Digest, CommentThreadFixturePort.ComputeCommandDigest(command), command)
            {
                ExpectedAppealTargetEventId = hidden ? 31 : null
            };
            Port = new(InitialComments, Substitute.For<ICommentAnonymousFixtureProvider>(),
                Substitute.For<ICommentAnonymousFixtureCapabilityVault>(), Substitute.For<ICommentAnonymousFixtureOperationLedger>(),
                Author, Substitute.For<ICommentManagementCapabilityService>(), PublicQueries, Governance,
                new CommentFixtureCacheProbe(Substitute.For<IRedisOperationExecutor>(), Substitute.For<ICachePolicyRegistry>()),
                Db, Moderation, new FixedClock());
            Db.ClearReceivedCalls();
            Author.ClearReceivedCalls();
            Governance.ClearReceivedCalls();
            Moderation.ClearReceivedCalls();
        }

        private ISugarQueryable<T> Query<T>() where T : class, new()
        {
            var query = Substitute.For<ISugarQueryable<T>>();
            Db.Queryable<T>().Returns(query);
            query.Where(Arg.Any<Expression<Func<T, bool>>>()).Returns(query);
            return query;
        }

        private static Comment Row(CommentModerationStatus status, int version, bool deleted, string content)
            => new()
            {
                Id = 41,
                ArticleId = 42,
                UserId = 11,
                AuthorMode = CommentAuthorModes.Public,
                ClientMutationAccountId = 11,
                ClientMutationId = new Guid(SHA256.HashData(Encoding.UTF8.GetBytes($"{Owner}\0{Role}"))[..16]).ToString("D"),
                Content = content,
                CurrentVersion = version,
                ModerationStatus = status,
                IsDeleted = deleted
            };

        private static CommentRevisionResult Revision(int version, string content, string operation)
            => new(version, content, Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(content))), operation,
                s_now, CommentAuthorModes.Public);

        private static CommentModerationEvent Event(long id, CommentModerationStatus? previous, CommentModerationStatus next, string type)
            => new()
            {
                Id = id,
                CommentId = 41,
                PreviousStatus = previous,
                NextStatus = next,
                EventType = type,
                OccurredAtUtc = s_now
            };

        private sealed class FixedClock : TimeProvider
        {
            public override DateTimeOffset GetUtcNow() => new(s_now);
        }
    }
}
