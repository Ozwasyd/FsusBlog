using FsusBlog.Core.Cache;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class MessageCenterPersistenceIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CreateAccountTicketAsync_CommitsConversationMessageParticipantAndNotifications()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState));

        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(
                CachePolicyId.MessageUnread,
                "account:42:refresh-version",
                1,
                Arg.Any<CancellationToken>())
            .Returns(1);
        cache.TrySetStringIfValueAsync(
                CachePolicyId.MessageUnread,
                "account:42",
                "0",
                "account:42:refresh-version",
                "1",
                null,
                Arg.Any<CancellationToken>())
            .Returns(true);
        IMessageNotificationStreamPort notifications = Substitute.For<IMessageNotificationStreamPort>();
        var service = new MessageCenterService(
            db,
            new MessageCacheService(cache, cache, cache),
            notifications,
            NullLogger<MessageCenterService>.Instance);

        var result = await service.CreateAccountTicketAsync(
            42,
            "  无法读取文章  ",
            "  文章详情返回空状态。  ");

        Assert.True(result.IsSuccess, result.Error.Message);
        var detail = Assert.IsType<FsusBlog.Shared.Contracts.Outputs.ConversationDetailResponse>(result.Value);
        Assert.Equal("无法读取文章", detail.Subject);
        Assert.Equal(ConversationStatusValue.Open, detail.Status);
        Assert.True(detail.CanReply);
        Assert.Equal(0, detail.UnreadCount);
        ConversationMessageResponse message = Assert.Single(detail.Messages);
        Assert.Equal("文章详情返回空状态。", message.Body);
        Assert.Equal(ConversationSenderValue.Account, message.SenderType);

        MessageConversation conversation = Assert.Single(await db.Queryable<MessageConversation>().ToListAsync());
        Assert.Equal(42, conversation.InitiatorAccountId);
        Assert.Equal(MessageSenderType.Account, conversation.CreatedByType);
        Assert.False(conversation.IsSystemSource);
        ConversationMessage persistedMessage = Assert.Single(await db.Queryable<ConversationMessage>().ToListAsync());
        Assert.Equal(conversation.Id, persistedMessage.ConversationId);
        Assert.Equal(42, persistedMessage.SenderAccountId);
        ConversationParticipantState participant = Assert.Single(
            await db.Queryable<ConversationParticipantState>().ToListAsync());
        Assert.Equal(conversation.Id, participant.ConversationId);
        Assert.Equal(42, participant.AccountId);
        Assert.Equal(persistedMessage.Id, participant.LastReadMessageId);
        Assert.Equal(0, participant.UnreadCount);

        await cache.Received(1).TrySetStringIfValueAsync(
            CachePolicyId.MessageUnread,
            "account:42",
            "0",
            "account:42:refresh-version",
            "1",
            null,
            Arg.Any<CancellationToken>());
        Assert.Equal(
            3,
            notifications.ReceivedCalls().Count(call =>
                call.GetMethodInfo().Name.StartsWith("Publish", StringComparison.Ordinal)));
    }
}
