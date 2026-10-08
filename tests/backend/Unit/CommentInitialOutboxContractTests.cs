using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentInitialOutboxContractTests
{
    [Theory]
    [InlineData(CommentModerationStatus.Approved, 7, true)]
    [InlineData(CommentModerationStatus.Approved, null, false)]
    [InlineData(CommentModerationStatus.Approved, 0, false)]
    [InlineData(CommentModerationStatus.Approved, -1, false)]
    [InlineData(CommentModerationStatus.Pending, 7, false)]
    [InlineData(CommentModerationStatus.Rejected, 7, false)]
    [InlineData(CommentModerationStatus.Hidden, 7, false)]
    public void InitialEvents_ReplyRequiresApprovalAndAnObservedPositiveRecipient(
        CommentModerationStatus status,
        int? recipientId,
        bool replyRequired)
    {
        IReadOnlyList<string> events = CommentCommandService.ResolveInitialOutboxEventTypes(status, recipientId);

        Assert.Equal(
            replyRequired
                ? [CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged, CommentMutationEventTypes.ReplyNotificationRequested]
                : new[] { CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged },
            events);
    }

    [Fact]
    public void InitialEvents_ReturnIndependentListsWithoutSharedMutableSelection()
    {
        IReadOnlyList<string> first = CommentCommandService.ResolveInitialOutboxEventTypes(CommentModerationStatus.Approved, 7);
        IReadOnlyList<string> second = CommentCommandService.ResolveInitialOutboxEventTypes(CommentModerationStatus.Approved, 7);

        Assert.NotSame(first, second);
        Assert.Equal(first, second);
    }

    [Fact]
    public void Envelope_UsesAllocatedIdentityAndExplicitBusinessTimeWithoutChangingCommentFacts()
    {
        DateTime occurredAt = DateTime.UnixEpoch.AddTicks(17);
        var comment = new Comment
        {
            Id = 1,
            ArticleId = 42,
            RootId = 300,
            ParentId = 301,
            UserId = 7,
            ReplyToUserId = 8,
            ModerationStatus = CommentModerationStatus.Approved,
            CurrentVersion = 1
        };

        CommentMutationOutboxEvent envelope = CommentCommandService.BuildOutboxEvent(
            CommentMutationEventTypes.Created,
            comment,
            302,
            occurredAt,
            null,
            CommentModerationStatus.Approved);

        Assert.Equal(CommentMutationEventTypes.Created, envelope.EventType);
        Assert.Equal(302, envelope.CommentId);
        Assert.Equal(42, envelope.ArticleId);
        Assert.Equal(300, envelope.RootId);
        Assert.Equal(301, envelope.ParentId);
        Assert.Equal(7, envelope.AccountId);
        Assert.Equal(8, envelope.ReplyToAccountId);
        Assert.Null(envelope.PreviousStatus);
        Assert.Equal(CommentModerationStatus.Approved, envelope.NextStatus);
        Assert.Equal(occurredAt, envelope.OccurredAtUtc);
        Assert.Equal(0, envelope.Id);
        Assert.True(Guid.TryParseExact(envelope.EventId, "D", out _));
        Assert.Equal(1, comment.Id);
        Assert.Equal(1, comment.CurrentVersion);
        Assert.Equal(300, comment.RootId);
        Assert.Equal(CommentModerationStatus.Approved, comment.ModerationStatus);
    }

    [Fact]
    public void Envelope_TopLevelUsesAllocatedRootAndPreservesNullableAnonymousAccountFacts()
    {
        var comment = new Comment { ArticleId = 42, AuthorMode = CommentAuthorModes.ZkAnonymous };

        CommentMutationOutboxEvent envelope = CommentCommandService.BuildOutboxEvent(
            CommentMutationEventTypes.VisibilityChanged,
            comment,
            302,
            DateTime.UnixEpoch,
            null,
            CommentModerationStatus.Pending);

        Assert.Equal(302, envelope.RootId);
        Assert.Null(envelope.ParentId);
        Assert.Null(envelope.AccountId);
        Assert.Null(envelope.ReplyToAccountId);
        Assert.Equal(CommentModerationStatus.Pending, envelope.NextStatus);
        Assert.Null(comment.RootId);
    }

    [Fact]
    public void InitialOutboxInputs_ArePublicWithoutServiceConstruction()
    {
        Assert.NotNull(typeof(CommentCommandService).GetMethod("BuildOutboxEvent", BindingFlags.Public | BindingFlags.Static));
        Assert.NotNull(typeof(CommentCommandService).GetMethod("ResolveInitialOutboxEventTypes", BindingFlags.Public | BindingFlags.Static));
    }
}
