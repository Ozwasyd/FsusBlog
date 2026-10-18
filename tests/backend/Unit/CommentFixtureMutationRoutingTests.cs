using System.Linq.Expressions;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

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

    [Theory]
    [InlineData(CommentModerationEventTypes.Hide, false)]
    [InlineData(CommentModerationEventTypes.Hide, true)]
    [InlineData(CommentModerationEventTypes.Reject, false)]
    [InlineData(CommentModerationEventTypes.Reject, true)]
    public async Task AppealTarget_UsesExactDecisionWithLaterNonDecisionAllowed(string eventType, bool laterNonDecision)
    {
        var model = new Model("appeal");
        CommentModerationStatus status = eventType == CommentModerationEventTypes.Hide
            ? CommentModerationStatus.Hidden : CommentModerationStatus.Rejected;
        List<CommentModerationEvent> events =
        [
            new() { Id = 30, CommentId = 41, NextStatus = CommentModerationStatus.Approved,
                EventType = CommentModerationEventTypes.Create },
            new() { Id = 31, CommentId = 41, PreviousStatus = CommentModerationStatus.Approved,
                NextStatus = status, EventType = eventType }
        ];
        if (laterNonDecision)
            events.Add(new CommentModerationEvent { Id = 32, CommentId = 41, PreviousStatus = status,
                NextStatus = status, EventType = "report" });
        CommentFixtureMutationPlan plan = model.SetAppealHistory(events, 31);

        CommentFixtureMutationResult result = await model.Port.ExecuteMutationAsync(plan);

        Assert.Equal(61, result.AppealId);
        Assert.Equal(events.Select(item => item.Id), result.Before.ModerationEvents.Select(item => item.Id));
        await model.Author.Received(1).IssueAccountChallengeAsync(41, 11, CommentManagementPurposes.Appeal,
            CancellationToken.None);
        await model.Governance.Received(1).AppealAsAccountAsync(41, 11,
            new CommentAppealRequest("Please review this decision", "challenge-secret"), CancellationToken.None);
        Assert.Equal(2, model.Governance.ReceivedCalls().Count(call => call.GetMethodInfo().Name == "ReadTimelineAsync"));
        Assert.Empty(model.InitialComments.ReceivedCalls());
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("wrong-type")]
    [InlineData("duplicate")]
    [InlineData("stale-hide")]
    [InlineData("stale-reject")]
    [InlineData("foreign")]
    [InlineData("wrong-owner")]
    [InlineData("wrong-status")]
    [InlineData("stale-last-event")]
    public async Task AppealTarget_RefusesInvalidDecisionBeforeChallengeOrCommand(string kind)
    {
        var model = new Model("appeal");
        List<CommentModerationEvent> events =
        [
            new() { Id = 30, CommentId = 41, NextStatus = CommentModerationStatus.Approved,
                EventType = CommentModerationEventTypes.Create },
            new() { Id = 31, CommentId = 41, PreviousStatus = CommentModerationStatus.Approved,
                NextStatus = CommentModerationStatus.Hidden, EventType = CommentModerationEventTypes.Hide }
        ];
        switch (kind)
        {
            case "wrong-type":
                events[1].EventType = CommentModerationEventTypes.Create;
                break;
            case "duplicate":
                events.Add(new CommentModerationEvent { Id = 31, CommentId = 41,
                    PreviousStatus = CommentModerationStatus.Hidden, NextStatus = CommentModerationStatus.Hidden,
                    EventType = CommentModerationEventTypes.Hide });
                break;
            case "stale-hide":
            case "stale-reject":
                events.Add(new CommentModerationEvent { Id = 32, CommentId = 41,
                    PreviousStatus = CommentModerationStatus.Hidden,
                    NextStatus = kind == "stale-hide" ? CommentModerationStatus.Hidden : CommentModerationStatus.Rejected,
                    EventType = kind == "stale-hide" ? CommentModerationEventTypes.Hide : CommentModerationEventTypes.Reject });
                break;
            case "foreign":
                events[1].CommentId = 42;
                break;
            case "wrong-owner":
                model.Before.UserId = 12;
                break;
            case "wrong-status":
                events[1].NextStatus = CommentModerationStatus.Approved;
                break;
        }
        CommentFixtureMutationPlan plan = model.SetAppealHistory(events, kind == "missing" ? 99 : 31);
        if (kind == "stale-last-event")
            plan = plan with { ExpectedLastModerationEventId = 30 };

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            model.Port.ExecuteMutationAsync(plan));

        string expectedError = kind switch
        {
            "duplicate" or "foreign" => "timeline is inconsistent",
            "wrong-owner" => "not owned",
            "stale-last-event" => "moderation event is stale",
            _ => "appeal decision is missing or stale"
        };
        Assert.Contains(expectedError, error.Message, StringComparison.Ordinal);
        await model.Author.DidNotReceive().IssueAccountChallengeAsync(Arg.Any<long>(), Arg.Any<int>(),
            Arg.Any<string>(), Arg.Any<CancellationToken>());
        await model.Governance.DidNotReceive().AppealAsAccountAsync(Arg.Any<long>(), Arg.Any<int>(),
            Arg.Any<CommentAppealRequest>(), Arg.Any<CancellationToken>());
        await model.Governance.DidNotReceive().AppealAsAnonymousAsync(Arg.Any<long>(), Arg.Any<string>(),
            Arg.Any<CommentAppealRequest>(), Arg.Any<CancellationToken>());
        Assert.Empty(model.Moderation.ReceivedCalls());
        Assert.Empty(model.InitialComments.ReceivedCalls());
        Assert.Empty(model.Queue.ReceivedCalls());
        Assert.Empty(model.Messages.ReceivedCalls());
    }

    [Theory]
    [InlineData(CommentMutationEventTypes.Created)]
    [InlineData(CommentMutationEventTypes.Edited)]
    [InlineData(CommentMutationEventTypes.ReplyNotificationRequested)]
    public async Task DeliveryObservation_ReadsProductionContractsAndModelsWithoutCommands(string eventType)
    {
        var model = new Model("report");
        model.PrepareDelivery(eventType);
        CommentFixtureMutationResult authority = await model.Port.ExecuteMutationAsync(model.Plan);
        model.Author.ClearReceivedCalls();
        model.Governance.ClearReceivedCalls();
        model.Moderation.ClearReceivedCalls();
        CommentFixtureDeliveryObservation result = await model.Port.ObserveDeliveryAsync(authority);

        Assert.Equal(BoundedQueueDeliveryCatalog.Embedded.Digest, result.BoundedQueueCatalogDigest);
        CommentFixtureOutboxObservation observed = Assert.Single(result.Outbox);
        Assert.Equal(CommentMutationOutboxConsumers.RequiredFor(eventType), observed.RequiredConsumers);
        Assert.Empty(observed.MissingConsumers);
        Assert.All(observed.Consumers, consumer => Assert.Equal(3, consumer.LeaseGeneration));
        Assert.Equal("article:42", result.CacheIdentity);
        Assert.Equal("article:42:root:41", result.RootCacheIdentity);
        Assert.Equal("11", result.CacheGeneration);
        Assert.Equal("11", result.RootCacheGeneration);
        await model.RedisDb.Received(1).StringGetAsync("fsus:blog:comment-cursor-version:article:42");
        await model.RedisDb.Received(1).StringGetAsync("fsus:blog:comment-cursor-version:article:42:root:41");
        await model.PublicQueries.Received(1).GetPermalinkContextAsync(42, 41);
        await model.Queue.Received(1).ListCommentModerationQueuePageAsync(null, 100, null, CancellationToken.None);
        Assert.Empty(model.Author.ReceivedCalls());
        Assert.Empty(model.Governance.ReceivedCalls());
        Assert.Empty(model.Moderation.ReceivedCalls());
        Assert.Empty(model.InitialComments.ReceivedCalls());
        if (eventType == CommentMutationEventTypes.ReplyNotificationRequested)
        {
            CommentFixtureReplyNoticeObservation notice = Assert.Single(result.ReplyNotices);
            Assert.Equal(12, notice.CurrentEligibleRecipientAccountId);
            Assert.Equal(12, notice.ObservedRecipientAccountId);
            Assert.True(notice.RecipientApiVisible);
            Assert.Equal("81", Assert.Single(notice.Messages).MessageId);
            await model.Messages.Received(1).GetAccountConversationDetailAsync(12, 71, null, CancellationToken.None);
        }
        else
            Assert.Empty(result.ReplyNotices);
    }

    [Fact]
    public async Task DeliveryObservation_FindsTargetQueueItemAndLeaseBeyondFirstPage()
    {
        var model = new Model("report");
        model.PrepareDelivery(CommentMutationEventTypes.Created);
        CommentFixtureMutationResult authority = await model.Port.ExecuteMutationAsync(model.Plan);
        model.Queue.ListCommentModerationQueuePageAsync(null, 100, null, CancellationToken.None)
            .Returns(new CommentModerationQueueResponse([QueueItem("99")], 1, 0, 0, "opaque-next"));
        var lease = new CommentModerationQueueLeaseResponse("41", "row-41", 1, 2,
            new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc), 91, "active", null, null, null,
            "note", null, 3, "claim-41");
        model.Queue.ListCommentModerationQueuePageAsync(null, 100, "opaque-next", CancellationToken.None)
            .Returns(new CommentModerationQueueResponse([QueueItem("41")], 2, 0, 0, null, [lease]));
        model.Author.ClearReceivedCalls();
        model.Governance.ClearReceivedCalls();
        model.Moderation.ClearReceivedCalls();

        CommentFixtureDeliveryObservation result = await model.Port.ObserveDeliveryAsync(authority);

        CommentFixtureQueueItemObservation item = Assert.Single(result.AdminQueueFirstPage.Items);
        Assert.Equal("41", item.CommentId);
        Assert.Equal(CommentModerationStatus.Pending, item.Status);
        Assert.Equal($"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("content-41")))}",
            item.ContentDigest);
        CommentFixtureQueueLeaseObservation observed = Assert.Single(result.AdminQueueFirstPage.Leases);
        Assert.Equal(lease.CommentId, observed.CommentId);
        Assert.Equal(lease.CommentRowVersion, observed.CommentRowVersion);
        Assert.Equal(lease.OwnerAdminPrincipalId, observed.OwnerAdminPrincipalId);
        Assert.Equal(lease.ClaimGeneration, observed.ClaimGeneration);
        Assert.Equal(lease.ClaimRowVersion, observed.ClaimRowVersion);
        Assert.Equal(lease.LeaseExpiresAtUtc, observed.LeaseExpiresAtUtc);
        Assert.False(result.AdminQueueFirstPage.HasNextPage);
        await model.Queue.Received(1).ListCommentModerationQueuePageAsync(null, 100, null, CancellationToken.None);
        await model.Queue.Received(1).ListCommentModerationQueuePageAsync(null, 100, "opaque-next", CancellationToken.None);
        Assert.Empty(model.Author.ReceivedCalls());
        Assert.Empty(model.Governance.ReceivedCalls());
        Assert.Empty(model.Moderation.ReceivedCalls());
        Assert.Empty(model.InitialComments.ReceivedCalls());
    }

    [Fact]
    public async Task DeliveryObservation_RefusesPartialQueueWhenCursorRepeats()
    {
        var model = new Model("report");
        model.PrepareDelivery(CommentMutationEventTypes.Created);
        CommentFixtureMutationResult authority = await model.Port.ExecuteMutationAsync(model.Plan);
        model.Queue.ListCommentModerationQueuePageAsync(null, 100, Arg.Any<string?>(), CancellationToken.None)
            .Returns(new CommentModerationQueueResponse([], 0, 0, 0, "repeated"));

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            model.Port.ObserveDeliveryAsync(authority));

        Assert.Contains("repeated cursor", error.Message, StringComparison.Ordinal);
        Assert.Equal(2, model.Queue.ReceivedCalls().Count());
        Assert.Empty(model.RedisDb.ReceivedCalls());
        Assert.Empty(model.Messages.ReceivedCalls());
    }

    [Fact]
    public async Task DeliveryObservation_ReadsOlderReplyMessagesInProductionOrder()
    {
        var model = new Model("report");
        model.PrepareDelivery(CommentMutationEventTypes.ReplyNotificationRequested);
        CommentFixtureMutationResult authority = await model.Port.ExecuteMutationAsync(model.Plan);
        model.Messages.GetAccountConversationDetailAsync(12, 71, null, CancellationToken.None)
            .Returns(new ConversationDetailResponse
            {
                ConversationId = "71",
                Messages = [new ConversationMessageResponse { MessageId = "81", ConversationId = "71", Body = "newer" }],
                HasOlder = true,
                PreviousCursor = "81"
            });
        model.Messages.GetAccountConversationDetailAsync(12, 71, 81, CancellationToken.None)
            .Returns(new ConversationDetailResponse
            {
                ConversationId = "71",
                Messages = [new ConversationMessageResponse { MessageId = "79", ConversationId = "71", Body = "older" }]
            });

        CommentFixtureReplyNoticeObservation notice = Assert.Single((await model.Port.ObserveDeliveryAsync(authority)).ReplyNotices);

        Assert.True(notice.RecipientApiVisible);
        Assert.Equal(12, notice.CurrentEligibleRecipientAccountId);
        Assert.Equal(new[] { "79", "81" }, notice.Messages.Select(message => message.MessageId));
        Assert.All(notice.Messages, message => Assert.Equal("71", message.ConversationId));
        await model.Messages.Received(1).GetAccountConversationDetailAsync(12, 71, null, CancellationToken.None);
        await model.Messages.Received(1).GetAccountConversationDetailAsync(12, 71, 81, CancellationToken.None);
    }

    [Fact]
    public async Task DeliveryObservation_RefusesMissingReplyContinuation()
    {
        var model = new Model("report");
        model.PrepareDelivery(CommentMutationEventTypes.ReplyNotificationRequested);
        CommentFixtureMutationResult authority = await model.Port.ExecuteMutationAsync(model.Plan);
        model.Messages.GetAccountConversationDetailAsync(12, 71, null, CancellationToken.None)
            .Returns(new ConversationDetailResponse
            {
                ConversationId = "71",
                Messages = [new ConversationMessageResponse { MessageId = "81", ConversationId = "71" }],
                HasOlder = true,
                PreviousCursor = "81"
            });
        model.Messages.GetAccountConversationDetailAsync(12, 71, 81, CancellationToken.None)
            .Returns((ConversationDetailResponse?)null);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            model.Port.ObserveDeliveryAsync(authority));

        Assert.Contains("continuation is missing", error.Message, StringComparison.Ordinal);
        Assert.Equal(2, model.Messages.ReceivedCalls().Count());
    }

    [Fact]
    public async Task MutationObservation_RejectsBrokenTimelineBeforeCommands()
    {
        var model = new Model("report");
        model.Governance.ReadTimelineAsync(41, CancellationToken.None).Returns(new CommentModerationTimelineResult(
            41, CommentModerationStatus.Approved, CommentModerationStatus.Approved, true,
            [new CommentModerationEvent { Id = 30, CommentId = 41, PreviousStatus = CommentModerationStatus.Hidden,
                NextStatus = CommentModerationStatus.Approved }]));

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            model.Port.ExecuteMutationAsync(model.Plan));

        Assert.Contains("timeline is inconsistent", error.Message, StringComparison.Ordinal);
        await model.Governance.DidNotReceive().ReportAsAccountAsync(Arg.Any<long>(), Arg.Any<int>(),
            Arg.Any<CommentReportRequest>(), Arg.Any<CancellationToken>());
        Assert.Empty(model.Queue.ReceivedCalls());
    }

    [Fact]
    public async Task MutationObservation_RejectsGrantedAppealTimelineGapAfterCommand()
    {
        var model = new Model("review-appeal");
        model.After.ModerationStatus = CommentModerationStatus.Approved;
        var command = new CommentFixtureReviewAppeal(61, 92, new CommentAppealDecisionRequest("granted", "Review granted"));
        CommentFixtureMutationPlan plan = model.Plan with
        {
            Command = command,
            CommandDigest = CommentThreadFixturePort.ComputeCommandDigest(command)
        };
        List<CommentModerationEvent> before =
        [
            new() { Id = 30, CommentId = 41, NextStatus = CommentModerationStatus.Approved },
            new() { Id = 31, CommentId = 41, PreviousStatus = CommentModerationStatus.Approved,
                NextStatus = CommentModerationStatus.Hidden }
        ];
        // Preserve the production gap: the granted event records Approved -> Approved after Hidden.
        model.Governance.ReadTimelineAsync(41, CancellationToken.None).Returns(
            new CommentModerationTimelineResult(41, CommentModerationStatus.Hidden, CommentModerationStatus.Hidden, true, before),
            new CommentModerationTimelineResult(41, CommentModerationStatus.Approved, CommentModerationStatus.Approved, true,
                [.. before, new() { Id = 32, CommentId = 41, PreviousStatus = CommentModerationStatus.Approved,
                    NextStatus = CommentModerationStatus.Approved }]));

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            model.Port.ExecuteMutationAsync(plan));

        Assert.Contains("timeline is inconsistent", error.Message, StringComparison.Ordinal);
        await model.Governance.Received(1).ReviewAppealAsync(61, 92, command.Request, CancellationToken.None);
        Assert.Empty(model.Queue.ReceivedCalls());
        Assert.Empty(model.Messages.ReceivedCalls());
    }

    private static CommentModerationItemResponse QueueItem(string id)
        => new(
            Id: id, ArticleId: 42, ArticleTitle: "article", AuthorDisplayName: "author", Content: $"content-{id}",
            CreateTime: new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc), Status: CommentModerationStatus.Pending,
            Reason: null, ModeratedByAdminPrincipalId: null, ModeratedAt: null, AutoModerated: false,
            ModerationActor: "pending", HitReasons: [], SubmitRegion: null, SubmitRegionConfidence: null,
            BlockedRegions: [], RegionPolicyVersion: null, RegionDecisionReason: null, RegionCanPublish: false,
            RegionRequiresManualReview: true, RegionHideUntilReviewed: true, ModelSignals: [], ModelLabel: null,
            ModelConfidence: null, ModelPrimaryReason: null, ModelProvider: null, ModelUnavailable: false,
            AuthorMode: null, AnonymousDisplayLanguage: null, ModerationSubjectHash: null, NullifierHash: null,
            NullifierStatusLabel: null, AnonymousScope: null, RateClass: null, RequiresModeration: null,
            AnonymousCredentialId: null, CanBlockAnonymousNullifier: false, CanRevokeAnonymousCredential: false);

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
        public IAuthoringModerationQueue Queue { get; } = Substitute.For<IAuthoringModerationQueue>();
        public IMessageQueryService Messages { get; } = Substitute.For<IMessageQueryService>();
        public IDatabase RedisDb { get; } = Substitute.For<IDatabase>();
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
            var redis = Substitute.For<IRedisOperationExecutor>();
            var multiplexer = Substitute.For<IConnectionMultiplexer>();
            multiplexer.GetDatabase().Returns(RedisDb);
            RedisDb.StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns((RedisValue)"11");
            redis.ExecuteAsync(RedisOperationPort.CommentFixture,
                Arg.Any<Func<IConnectionMultiplexer, CancellationToken, Task<RedisValue>>>(), Arg.Any<CancellationToken>())
                .Returns(call => call.ArgAt<Func<IConnectionMultiplexer, CancellationToken, Task<RedisValue>>>(1)(
                    multiplexer, call.ArgAt<CancellationToken>(2)));
            Queue.ListCommentModerationQueuePageAsync(null, 100, null, Arg.Any<CancellationToken>())
                .Returns(new CommentModerationQueueResponse([], 0, 0, 0));
            Port = new(InitialComments, Substitute.For<ICommentAnonymousFixtureProvider>(),
                Substitute.For<ICommentAnonymousFixtureCapabilityVault>(), Substitute.For<ICommentAnonymousFixtureOperationLedger>(),
                Author, Substitute.For<ICommentManagementCapabilityService>(), PublicQueries, Governance,
                new CommentFixtureCacheProbe(redis, new CachePolicyRegistry()),
                Db, Moderation, new FixedClock(), Queue, Messages);
            Db.ClearReceivedCalls();
            Author.ClearReceivedCalls();
            Governance.ClearReceivedCalls();
            Moderation.ClearReceivedCalls();
        }

        public CommentFixtureMutationPlan SetAppealHistory(List<CommentModerationEvent> events, long targetId)
        {
            Before.ModerationStatus = events[^1].NextStatus;
            After.ModerationStatus = Before.ModerationStatus;
            Governance.ReadTimelineAsync(41, Arg.Any<CancellationToken>()).Returns(
                new CommentModerationTimelineResult(41, Before.ModerationStatus, Before.ModerationStatus, true, events),
                new CommentModerationTimelineResult(41, After.ModerationStatus, After.ModerationStatus, true,
                    [.. events, Event(events.Max(item => item.Id) + 1, Before.ModerationStatus,
                        After.ModerationStatus, "appeal")]));
            return Plan with
            {
                ExpectedStatus = Before.ModerationStatus,
                ExpectedLastModerationEventId = events[^1].Id,
                ExpectedAppealTargetEventId = targetId
            };
        }

        public void PrepareDelivery(string eventType)
        {
            var item = new CommentMutationOutboxEvent
            {
                Id = 51,
                EventId = "018ff010-1234-7abc-8def-0123456789ab",
                EventType = eventType,
                ArticleId = 42,
                CommentId = 41,
                RootId = 41,
                ReplyToAccountId = 12,
                Status = CommentMutationOutboxStatus.Processed,
                LeaseGeneration = 3
            };
            Db.Queryable<CommentMutationOutboxEvent>().ToListAsync(Arg.Any<CancellationToken>()).Returns([item]);
            var deliveries = Query<CommentMutationOutboxDelivery>();
            deliveries.ToListAsync(Arg.Any<CancellationToken>()).Returns(CommentMutationOutboxConsumers.RequiredFor(eventType)
                .Select(consumer => new CommentMutationOutboxDelivery
                {
                    OutboxEventId = item.Id,
                    ConsumerName = consumer,
                    Status = CommentMutationOutboxDeliveryStatus.Completed,
                    LeaseGeneration = 3,
                    ResultDigest = new string('b', 64)
                }).ToList());
            var conversations = Query<MessageConversation>();
            conversations.ToListAsync(Arg.Any<CancellationToken>()).Returns([new MessageConversation
            {
                Id = 71,
                InitiatorAccountId = 12,
                IsSystemSource = true,
                SourceMessageId = CommentMutationOutboxWorker.BuildSourceEventId(item.EventId, "reply")
            }]);
            Messages.GetAccountConversationDetailAsync(12, 71, null, Arg.Any<CancellationToken>())
                .Returns(new ConversationDetailResponse
                {
                    ConversationId = "71",
                    Messages = [new ConversationMessageResponse { MessageId = "81", ConversationId = "71" }]
                });
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
