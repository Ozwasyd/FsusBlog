using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only normalized comments, allocated IDs and temporal envelopes
/// exercise original initial outbox construction. They prove no normalization,
/// allocation, credential, graph, persistence, delivery or canonical admission.
/// Fresh event GUIDs and the entity's NextAttemptAt clock default are not a
/// deterministic/full-envelope or scheduling equivalence claim.
/// </summary>
public sealed class CanonicalCommentInitialOutboxTests
{
    private const string SyntheticDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly DateTime s_createdAt = new(2024, 2, 29, 23, 59, 59, DateTimeKind.Utc);
    private static readonly DateTime s_occurredAt = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(CommentModerationStatus.Pending, null, false)]
    [InlineData(CommentModerationStatus.Pending, 0, false)]
    [InlineData(CommentModerationStatus.Pending, -1, false)]
    [InlineData(CommentModerationStatus.Pending, 8, false)]
    [InlineData(CommentModerationStatus.Approved, null, false)]
    [InlineData(CommentModerationStatus.Approved, 0, false)]
    [InlineData(CommentModerationStatus.Approved, -1, false)]
    [InlineData(CommentModerationStatus.Approved, 8, true)]
    [InlineData(CommentModerationStatus.Rejected, null, false)]
    [InlineData(CommentModerationStatus.Rejected, 0, false)]
    [InlineData(CommentModerationStatus.Rejected, -1, false)]
    [InlineData(CommentModerationStatus.Rejected, 8, false)]
    [InlineData(CommentModerationStatus.Hidden, null, false)]
    [InlineData(CommentModerationStatus.Hidden, 0, false)]
    [InlineData(CommentModerationStatus.Hidden, -1, false)]
    [InlineData(CommentModerationStatus.Hidden, 8, false)]
    public void ResolveInitialOutbox_PreservesOriginalStatusRecipientSelectionAndEventOrder(
        CommentModerationStatus status,
        int? recipient,
        bool requiresReply)
    {
        CommentScaleInitialOutboxFacts facts = Facts();
        facts.NormalizedComment.ModerationStatus = status;
        facts.NormalizedComment.ReplyToUserId = recipient;
        string originalComment = JsonSerializer.Serialize(facts.NormalizedComment);

        IReadOnlyList<CommentMutationOutboxEvent> result = CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal());

        string[] expected = requiresReply
            ? [CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged, CommentMutationEventTypes.ReplyNotificationRequested]
            : [CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged];
        Assert.Equal(expected, result.Select(item => item.EventType));
        Assert.Equal(CommentCommandService.ResolveInitialOutboxEventTypes(status, recipient), result.Select(item => item.EventType));
        Assert.All(result, item =>
        {
            Assert.Equal(status, item.NextStatus);
            Assert.Equal(recipient, item.ReplyToAccountId);
            Assert.Null(item.PreviousStatus);
            Assert.Equal(s_occurredAt, item.OccurredAtUtc);
        });
        Assert.Equal(originalComment, JsonSerializer.Serialize(facts.NormalizedComment));
    }

    [Fact]
    public void ResolveInitialOutbox_PreservesTheSuppliedBusinessEnvelopeFieldsThroughTheOriginalBuilder()
    {
        CommentScaleInitialOutboxFacts facts = Facts();
        string originalComment = JsonSerializer.Serialize(facts.NormalizedComment);

        IReadOnlyList<CommentMutationOutboxEvent> result = CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal());

        Assert.All(result, actual =>
        {
            CommentMutationOutboxEvent original = CommentCommandService.BuildOutboxEvent(actual.EventType,
                facts.NormalizedComment, facts.AllocatedCommentId, s_occurredAt, null, CommentModerationStatus.Approved);
            Assert.Equal(950001, actual.CommentId);
            Assert.Equal(42, actual.ArticleId);
            Assert.Equal(910003, actual.RootId);
            Assert.Equal(910007, actual.ParentId);
            Assert.Equal(7, actual.AccountId);
            Assert.Equal(8, actual.ReplyToAccountId);
            Assert.Null(actual.ActorAdminPrincipalId);
            Assert.Null(actual.PreviousStatus);
            Assert.Equal(CommentModerationStatus.Approved, actual.NextStatus);
            Assert.Equal(s_occurredAt, actual.OccurredAtUtc);
            Assert.Equal(DateTimeKind.Utc, actual.OccurredAtUtc.Kind);
            Assert.Equal(original.CommentId, actual.CommentId);
            Assert.Equal(original.ArticleId, actual.ArticleId);
            Assert.Equal(original.RootId, actual.RootId);
            Assert.Equal(original.ParentId, actual.ParentId);
            Assert.Equal(original.AccountId, actual.AccountId);
            Assert.Equal(original.ReplyToAccountId, actual.ReplyToAccountId);
            Assert.Equal(original.PreviousStatus, actual.PreviousStatus);
            Assert.Equal(original.NextStatus, actual.NextStatus);
            Assert.Equal(original.OccurredAtUtc, actual.OccurredAtUtc);
            Assert.Equal("{}", actual.PayloadJson);
            Assert.Equal(CommentMutationOutboxStatus.Pending, actual.Status);
            Assert.Equal(0, actual.Id);
            Assert.Equal(0, actual.AttemptCount);
            Assert.Equal(0, actual.LeaseGeneration);
            Assert.Null(actual.ClaimToken);
            Assert.Null(actual.ClaimedBy);
            Assert.Null(actual.ClaimedAt);
            Assert.Null(actual.LeaseExpiresAt);
            Assert.Null(actual.LastHeartbeatAt);
            Assert.Null(actual.LastError);
            Assert.Null(actual.ProcessedAtUtc);
            Assert.True(Guid.TryParseExact(actual.EventId, "D", out _));
        });
        Assert.NotEqual(facts.NormalizedComment.CreateTime, result[0].OccurredAtUtc);
        Assert.Equal(originalComment, JsonSerializer.Serialize(facts.NormalizedComment));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(123)]
    [InlineData(8000000000)]
    public void ResolveInitialOutbox_UsesAllocatedIdInsteadOfCommentIdAndOriginalRootFallback(long existingId)
    {
        CommentScaleInitialOutboxFacts facts = Facts();
        facts.NormalizedComment.Id = existingId;
        facts.NormalizedComment.RootId = null;
        facts.NormalizedComment.ParentId = null;

        IReadOnlyList<CommentMutationOutboxEvent> result = CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal());

        Assert.All(result, item =>
        {
            Assert.Equal(facts.AllocatedCommentId, item.CommentId);
            Assert.Equal(facts.AllocatedCommentId, item.RootId);
            Assert.Null(item.ParentId);
        });
        Assert.Equal(existingId, facts.NormalizedComment.Id);
        Assert.Null(facts.NormalizedComment.RootId);
        Assert.Null(facts.NormalizedComment.ParentId);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData(910003L, 910007L)]
    public void ResolveInitialOutbox_RetainsNullableAnonymousActorAndObservedThreadFacts(long? rootId, long? parentId)
    {
        CommentScaleInitialOutboxFacts facts = Facts();
        Comment comment = facts.NormalizedComment;
        comment.AuthorMode = CommentAuthorModes.ZkAnonymous;
        comment.UserId = null;
        comment.ReplyToUserId = null;
        comment.RootId = rootId;
        comment.ParentId = parentId;
        comment.ModerationStatus = CommentModerationStatus.Pending;
        string originalComment = JsonSerializer.Serialize(comment);

        IReadOnlyList<CommentMutationOutboxEvent> result = CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal());

        Assert.Equal(new[] { CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged }, result.Select(item => item.EventType));
        Assert.All(result, item =>
        {
            Assert.Null(item.AccountId);
            Assert.Null(item.ReplyToAccountId);
            Assert.Equal(rootId ?? facts.AllocatedCommentId, item.RootId);
            Assert.Equal(parentId, item.ParentId);
            Assert.Equal(CommentModerationStatus.Pending, item.NextStatus);
        });
        Assert.Equal(originalComment, JsonSerializer.Serialize(comment));
    }

    [Fact]
    public void ResolveInitialOutbox_PreservesOriginalPremoderatedPendingFactsWithoutApplyingBaseModeration()
    {
        CommentScaleInitialOutboxFacts facts = Facts();
        facts.NormalizedComment.ModerationStatus = CommentModerationStatus.Pending;
        facts.NormalizedComment.ModerationReason = "article_policy_premoderated";
        string originalComment = JsonSerializer.Serialize(facts.NormalizedComment);

        IReadOnlyList<CommentMutationOutboxEvent> result = CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal());

        Assert.Equal(new[] { CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged }, result.Select(item => item.EventType));
        Assert.All(result, item => Assert.Equal(CommentModerationStatus.Pending, item.NextStatus));
        Assert.Equal("article_policy_premoderated", facts.NormalizedComment.ModerationReason);
        Assert.Equal(originalComment, JsonSerializer.Serialize(facts.NormalizedComment));
    }

    [Fact]
    public void ResolveInitialOutbox_UsesTheExplicitOriginalRoleRatherThanCommentCreationTime()
    {
        CommentScaleInitialOutboxFacts facts = Facts() with
        {
            OccurredAtRole = "outbox.later"
        };

        IReadOnlyList<CommentMutationOutboxEvent> result = CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal());

        Assert.All(result, item => Assert.Equal(s_occurredAt.AddMilliseconds(1), item.OccurredAtUtc));
        Assert.Equal(s_createdAt, facts.NormalizedComment.CreateTime);
    }

    [Fact]
    public void ResolveInitialOutbox_ReturnsAnIndependentReadonlyRosterOfUnpersistedEntities()
    {
        CommentScaleInitialOutboxFacts facts = Facts();
        IReadOnlyList<CommentMutationOutboxEvent> first = CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal());
        IReadOnlyList<CommentMutationOutboxEvent> second = CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal());

        Assert.NotSame(first, second);
        Assert.NotSame(first[0], second[0]);
        Assert.True(((IList<CommentMutationOutboxEvent>)first).IsReadOnly);
        Assert.Throws<NotSupportedException>(() => ((IList<CommentMutationOutboxEvent>)first).Clear());
        Assert.Equal(first.Select(item => item.EventType), second.Select(item => item.EventType));
        Assert.All(first.Concat(second), item => Assert.Equal(0, item.Id));
        // Entity defaults remain original; no deterministic GUID or NextAttemptAt assertion.
    }

    [Theory]
    [InlineData("facts")]
    [InlineData("temporal")]
    [InlineData("coordinate")]
    [InlineData("occurrence")]
    [InlineData("comment")]
    public void ResolveInitialOutbox_RejectsNullRequiredInputs(string member)
    {
        CommentScaleInitialOutboxFacts facts = Facts();
        ResolvedTemporalRoleContext temporal = Temporal();
        switch (member)
        {
            case "facts":
                facts = null!;
                break;
            case "temporal":
                temporal = null!;
                break;
            case "coordinate":
                facts = facts with
                {
                    Coordinate = null!
                };
                break;
            case "occurrence":
                facts = facts with
                {
                    Coordinate = facts.Coordinate with
                    {
                        Occurrence = null!
                    }
                };
                break;
            case "comment":
                facts = facts with
                {
                    NormalizedComment = null!
                };
                break;
            default:
                throw new InvalidOperationException(member);
        }

        Assert.Throws<ArgumentNullException>(() => CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, temporal));
    }

    [Theory]
    [InlineData("comment-role")]
    [InlineData("scenario-role")]
    [InlineData("article-role")]
    [InlineData("repetition")]
    [InlineData("article-id")]
    [InlineData("article-crossed")]
    [InlineData("allocated-id")]
    [InlineData("time-role")]
    [InlineData("status")]
    public void ResolveInitialOutbox_RejectsInvalidStructuralBindings(string mutation)
    {
        CommentScaleInitialOutboxFacts facts = Facts();
        facts = mutation switch
        {
            "comment-role" => facts with { Coordinate = facts.Coordinate with { CommentRole = " " } },
            "scenario-role" => facts with { Coordinate = facts.Coordinate with { Occurrence = facts.Coordinate.Occurrence with { ScenarioRole = "" } } },
            "article-role" => facts with { Coordinate = facts.Coordinate with { Occurrence = facts.Coordinate.Occurrence with { ArticleTargetRole = " " } } },
            "repetition" => facts with { Coordinate = facts.Coordinate with { Occurrence = facts.Coordinate.Occurrence with { Repetition = -1 } } },
            "article-id" => facts with { ArticleId = 0 },
            "article-crossed" => facts with { ArticleId = 43 },
            "allocated-id" => facts with { AllocatedCommentId = 0 },
            "time-role" => facts with { OccurredAtRole = "" },
            "status" => facts,
            _ => throw new InvalidOperationException(mutation)
        };
        if (mutation == "status")
        {
            facts.NormalizedComment.ModerationStatus = (CommentModerationStatus)999;
        }

        Assert.Throws<InvalidOperationException>(() => CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal()));
    }

    [Fact]
    public void ResolveInitialOutbox_RejectsMissingOriginalTemporalRole()
    {
        CommentScaleInitialOutboxFacts facts = Facts() with
        {
            OccurredAtRole = "unresolved-unit-role"
        };

        Assert.Throws<InvalidOperationException>(() => CanonicalCommentGraphFactory.ResolveInitialOutbox(facts, Temporal()));
    }

    private static CommentScaleInitialOutboxFacts Facts()
        => new(new(new("synthetic-scenario", 0, "synthetic-article-target"), "synthetic-comment"), 42, 950001,
            new Comment
            {
                Id = 123,
                ArticleId = 42,
                Content = "synthetic normalized unit content",
                CreateTime = s_createdAt,
                CurrentVersion = 3,
                AuthorMode = CommentAuthorModes.Public,
                UserId = 7,
                RootId = 910003,
                ParentId = 910007,
                ReplyToUserId = 8,
                ModerationStatus = CommentModerationStatus.Approved,
                ModerationReason = "synthetic-unit-only"
            }, "outbox.created");

    private static ResolvedTemporalRoleContext Temporal()
    {
        // In-memory adapter input only, with no original producer or artifact admission.
        string json = JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "synthetic-unit-only",
                schedulerRunId = "synthetic-unit-only"
            },
            contentDigest = SyntheticDigest,
            roles = new[]
            {
                (Role: "outbox.created", Instant: "2024-03-01T00:00:00.000Z"),
                (Role: "outbox.later", Instant: "2024-03-01T00:00:00.001Z")
            }.Select(item => new
            {
                roleId = item.Role,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc = item.Instant
            })
        });
        return ResolvedTemporalRoleContext.Parse(json, SyntheticDigest);
    }
}
