using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
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

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task AccountReadCursor_DoubleConnectionPreservesSnapshotAcrossInsertReplyAndInternalMessages()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setup,
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState));

        const int AccountId = 42;
        const long ConversationId = 1000;
        const long AccountMessageId = 1100;
        const long SnapshotMessageId = 1200;
        DateTime now = DateTime.UtcNow.AddMinutes(-5);
        await setup.Insertable(new MessageConversation
        {
            Id = ConversationId,
            Subject = "read cursor fixture",
            InitiatorAccountId = AccountId,
            Status = ConversationStatus.Open,
            CreatedByType = MessageSenderType.Account,
            CreatedByAccountId = AccountId,
            CreatedAt = now,
            UpdatedAt = now,
            LastMessageAt = now
        }).ExecuteCommandAsync();
        await setup.Insertable(new[]
        {
            new ConversationMessage
            {
                Id = AccountMessageId,
                ConversationId = ConversationId,
                SenderType = MessageSenderType.Account,
                SenderAccountId = AccountId,
                Body = "account opened the ticket",
                CreatedAt = now
            },
            new ConversationMessage
            {
                Id = SnapshotMessageId,
                ConversationId = ConversationId,
                SenderType = MessageSenderType.Admin,
                SenderAdminPrincipalId = 7,
                SenderAdminSessionId = "admin-fixture",
                Body = "visible before detail",
                CreatedAt = now.AddSeconds(1)
            }
        }).ExecuteCommandAsync();
        await setup.Insertable(new ConversationParticipantState
        {
            ConversationId = ConversationId,
            AccountId = AccountId,
            LastReadMessageId = AccountMessageId,
            UnreadCount = 1,
            LastReadAt = now,
            UpdatedAt = now
        }).ExecuteCommandAsync();

        IUnifiedCache unifiedCache = Substitute.For<IUnifiedCache>();
        unifiedCache.IncrementAsync(
                CachePolicyId.MessageUnread,
                Arg.Any<string>(),
                1,
                Arg.Any<CancellationToken>())
            .Returns(1);
        unifiedCache.TrySetStringIfValueAsync(
                CachePolicyId.MessageUnread,
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                null,
                Arg.Any<CancellationToken>())
            .Returns(true);
        IMessageNotificationStreamPort notifications = Substitute.For<IMessageNotificationStreamPort>();
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        MessageCenterService first = CreateService(firstDb, unifiedCache, notifications);

        ConversationDetailResponse detail = Assert.IsType<ConversationDetailResponse>(
            await first.GetAccountConversationDetailAsync(AccountId, ConversationId));
        Assert.Equal(SnapshotMessageId.ToString(), detail.ReadSnapshotMessageId);

        await InsertAdminReplyAsync(secondDb, ConversationId, AccountId, "arrived after detail", 7);

        Result markedSnapshot = await first.MarkConversationReadAsync(AccountId, ConversationId, SnapshotMessageId);
        Assert.True(markedSnapshot.IsSuccess, markedSnapshot.Error.Message);
        ConversationParticipantState participant = Assert.IsType<ConversationParticipantState>(
            await setup.Queryable<ConversationParticipantState>()
                .Where(it => it.ConversationId == ConversationId && it.AccountId == AccountId)
                .FirstAsync());
        Assert.Equal(SnapshotMessageId, participant.LastReadMessageId);
        Assert.Equal(1, participant.UnreadCount);
        await notifications.Received(1).PublishToUserAsync(
            NotificationStreamEventType.InboxReadUpdated,
            AccountId,
            Arg.Is<InboxReadUpdatedPayload>(payload =>
                payload.ConversationId == ConversationId.ToString()
                && payload.LastReadMessageId == SnapshotMessageId.ToString()
                && payload.ConversationUnreadCount == 1),
            "inbox-read-updated");

        Result regressed = await first.MarkConversationReadAsync(AccountId, ConversationId, AccountMessageId);
        Assert.False(regressed.IsSuccess);
        Assert.Equal(ErrorCode.Conflict, regressed.Error.Code);

        long internalMessageId = SnowFlakeSingle.Instance.NextId();
        await secondDb.Insertable(new ConversationMessage
        {
            Id = internalMessageId,
            ConversationId = ConversationId,
            SenderType = MessageSenderType.Admin,
            SenderAdminPrincipalId = 7,
            SenderAdminSessionId = "admin-internal",
            Body = "internal only",
            IsInternalNote = true,
            CreatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();
        Result internalRead = await first.MarkConversationReadAsync(AccountId, ConversationId, internalMessageId);
        Assert.False(internalRead.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, internalRead.Error.Code);

        Task<Result<ConversationMessageResponse>> accountReplyTask =
            first.ReplyAsAccountAsync(AccountId, ConversationId, SnapshotMessageId, "account reply");
        Task adminReplyTask = InsertAdminReplyAsync(
            secondDb,
            ConversationId,
            AccountId,
            "concurrent admin reply",
            8);
        await Task.WhenAll(accountReplyTask, adminReplyTask);
        Result<ConversationMessageResponse> accountReply = await accountReplyTask;
        Assert.True(accountReply.IsSuccess, accountReply.Error.Message);

        participant = Assert.IsType<ConversationParticipantState>(
            await setup.Queryable<ConversationParticipantState>()
                .Where(it => it.ConversationId == ConversationId && it.AccountId == AccountId)
                .FirstAsync());
        Assert.Equal(SnapshotMessageId, participant.LastReadMessageId);
        Assert.Equal(2, participant.UnreadCount);

        ConversationDetailResponse afterConcurrency = Assert.IsType<ConversationDetailResponse>(
            await first.GetAccountConversationDetailAsync(AccountId, ConversationId));
        Assert.Equal(5, afterConcurrency.Messages.Count);
        Assert.DoesNotContain(afterConcurrency.Messages, message => message.MessageId == internalMessageId.ToString());
        Assert.NotEqual(internalMessageId.ToString(), afterConcurrency.ReadSnapshotMessageId);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task ConversationCursorPagination_TraversesStableSnapshotWithTiesFiltersAndConcurrentMessage()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setup,
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState));

        const int AccountId = 42;
        const int ConversationCount = 105;
        DateTime baseline = new(2026, 7, 19, 8, 0, 0, DateTimeKind.Utc);
        var conversations = new List<MessageConversation>(ConversationCount);
        var messages = new List<ConversationMessage>(ConversationCount);
        var participants = new List<ConversationParticipantState>(ConversationCount);
        for (int i = 0; i < ConversationCount; i++)
        {
            long conversationId = 10_000 + i;
            long messageId = 20_000 + i;
            DateTime lastMessageAt = baseline.AddMinutes(-(i / 3));
            conversations.Add(new MessageConversation
            {
                Id = conversationId,
                Subject = $"conversation-{i:D3}",
                InitiatorAccountId = AccountId,
                Status = (ConversationStatus)(i % 3),
                IsSystemSource = i % 10 == 0,
                CreatedByType = MessageSenderType.Account,
                CreatedByAccountId = AccountId,
                CreatedAt = lastMessageAt,
                UpdatedAt = lastMessageAt,
                LastMessageAt = lastMessageAt
            });
            messages.Add(new ConversationMessage
            {
                Id = messageId,
                ConversationId = conversationId,
                SenderType = MessageSenderType.Admin,
                SenderAdminPrincipalId = 7,
                SenderAdminSessionId = "pagination-fixture",
                Body = $"message-{i:D3}",
                CreatedAt = lastMessageAt
            });
            participants.Add(new ConversationParticipantState
            {
                ConversationId = conversationId,
                AccountId = AccountId,
                UnreadCount = i % 2,
                UpdatedAt = lastMessageAt
            });
        }

        await setup.Insertable(conversations).ExecuteCommandAsync();
        await setup.Insertable(messages).ExecuteCommandAsync();
        await setup.Insertable(participants).ExecuteCommandAsync();

        IUnifiedCache unifiedCache = Substitute.For<IUnifiedCache>();
        IMessageNotificationStreamPort notifications = Substitute.For<IMessageNotificationStreamPort>();
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        MessageCenterService service = CreateService(firstDb, unifiedCache, notifications);

        PageResponse<ConversationListItemResponse> page =
            await service.GetAccountConversationsAsync(AccountId, 20, "all", null);
        Assert.Equal(ConversationCount, page.Total);
        Assert.True(page.HasMore);
        Assert.NotNull(page.NextCursor);
        Assert.True(MessageConversationCursor.TryDecode(page.NextCursor, out MessageConversationCursor firstCursor));
        Assert.Equal(20_104, firstCursor.SnapshotMessageId);
        Assert.Equal(conversations[19].Id, firstCursor.ConversationId);
        Assert.Equal(conversations[19].LastMessageAt, firstCursor.LastMessageAt);

        long concurrentConversationId = conversations[25].Id;
        await InsertAdminReplyAsync(secondDb, concurrentConversationId, AccountId, "arrived during pagination", 8);

        var traversed = new List<ConversationListItemResponse>(ConversationCount);
        traversed.AddRange(page.Items);
        while (page.HasMore)
        {
            Assert.True(MessageConversationCursor.TryDecode(page.NextCursor, out MessageConversationCursor cursor));
            page = await service.GetAccountConversationsAsync(AccountId, 20, "all", cursor);
            Assert.NotEmpty(page.Items);
            traversed.AddRange(page.Items);
        }

        long[] expectedOrder = conversations
            .OrderByDescending(static item => item.LastMessageAt)
            .ThenByDescending(static item => item.Id)
            .Select(static item => item.Id)
            .ToArray();
        long[] actualOrder = traversed.Select(static item => long.Parse(item.ConversationId)).ToArray();
        Assert.Equal(ConversationCount, traversed.Count);
        Assert.Equal(ConversationCount, actualOrder.Distinct().Count());
        Assert.Equal(expectedOrder, actualOrder);
        ConversationListItemResponse concurrentItem = Assert.Single(
            traversed,
            item => item.ConversationId == concurrentConversationId.ToString());
        Assert.Equal("message-025", concurrentItem.LastMessage!.BodyPreview);

        var systemItems = new List<ConversationListItemResponse>();
        page = await service.GetAccountConversationsAsync(AccountId, 4, "system", null);
        systemItems.AddRange(page.Items);
        while (page.HasMore)
        {
            Assert.True(MessageConversationCursor.TryDecode(page.NextCursor, out MessageConversationCursor cursor));
            page = await service.GetAccountConversationsAsync(AccountId, 4, "system", cursor);
            systemItems.AddRange(page.Items);
        }
        Assert.Equal(11, systemItems.Count);
        Assert.All(systemItems, static item => Assert.True(item.IsSystemSource));

        List<ConversationListItemResponse> unreadItems =
            await LoadAccountConversationPagesAsync(service, AccountId, 13, "unread");
        Assert.Equal(52, unreadItems.Count);
        Assert.All(unreadItems, static item => Assert.True(item.UnreadCount > 0));

        List<ConversationListItemResponse> openItems =
            await LoadAccountConversationPagesAsync(service, AccountId, 13, "open");
        Assert.Equal(35, openItems.Count);
        Assert.All(openItems, static item => Assert.Equal(ConversationStatusValue.Open, item.Status));

        List<ConversationListItemResponse> closedItems =
            await LoadAccountConversationPagesAsync(service, AccountId, 13, "closed");
        Assert.Equal(35, closedItems.Count);
        Assert.All(closedItems, static item => Assert.Equal(ConversationStatusValue.Closed, item.Status));

        var adminItems = new List<ConversationListItemResponse>();
        page = await service.GetAdminConversationsAsync(30, "all", null);
        adminItems.AddRange(page.Items);
        while (page.HasMore)
        {
            Assert.True(MessageConversationCursor.TryDecode(page.NextCursor, out MessageConversationCursor cursor));
            page = await service.GetAdminConversationsAsync(30, "all", cursor);
            adminItems.AddRange(page.Items);
        }
        Assert.Equal(ConversationCount, adminItems.Count);
        Assert.Equal(ConversationCount, adminItems.Select(static item => item.ConversationId).Distinct().Count());
    }

    private static async Task<List<ConversationListItemResponse>> LoadAccountConversationPagesAsync(
        MessageCenterService service,
        int accountId,
        int size,
        string filter)
    {
        var items = new List<ConversationListItemResponse>();
        PageResponse<ConversationListItemResponse> page =
            await service.GetAccountConversationsAsync(accountId, size, filter, null);
        items.AddRange(page.Items);
        while (page.HasMore)
        {
            Assert.True(MessageConversationCursor.TryDecode(page.NextCursor, out MessageConversationCursor cursor));
            page = await service.GetAccountConversationsAsync(accountId, size, filter, cursor);
            items.AddRange(page.Items);
        }

        Assert.Equal(items.Count, items.Select(static item => item.ConversationId).Distinct().Count());
        return items;
    }

    private static async Task InsertAdminReplyAsync(
        SqlSugarClient db,
        long conversationId,
        int accountId,
        string body,
        int adminPrincipalId)
    {
        long messageId = SnowFlakeSingle.Instance.NextId();
        DateTime now = DateTime.UtcNow;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            int conversationUpdated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE msg_conversation
                SET updatedat = @Now,
                    lastmessageat = @Now
                WHERE id = @ConversationId
                  AND status <> @ClosedStatus;
                """,
                new SugarParameter("@ConversationId", conversationId),
                new SugarParameter("@Now", now),
                new SugarParameter("@ClosedStatus", (int)ConversationStatus.Closed));
            Assert.Equal(1, conversationUpdated);

            await db.Insertable(new ConversationMessage
            {
                Id = messageId,
                ConversationId = conversationId,
                SenderType = MessageSenderType.Admin,
                SenderAdminPrincipalId = adminPrincipalId,
                SenderAdminSessionId = $"admin-{adminPrincipalId}",
                Body = body,
                CreatedAt = now
            }).ExecuteCommandAsync();

            int participantUpdated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE msg_participant_state state
                SET unreadcount = (
                        SELECT COUNT(*)::integer
                        FROM msg_message message
                        WHERE message.conversationid = @ConversationId
                          AND message.id > COALESCE(state.lastreadmessageid, 0)
                          AND message.isinternalnote = false
                          AND NOT (
                              message.sendertype = @AccountSenderType
                              AND message.senderaccountid = @AccountId
                          )
                    ),
                    updatedat = @Now
                WHERE state.conversationid = @ConversationId
                  AND state.accountid = @AccountId;
                """,
                new SugarParameter("@ConversationId", conversationId),
                new SugarParameter("@AccountId", accountId),
                new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
                new SugarParameter("@Now", now));
            Assert.Equal(1, participantUpdated);
        });
        Assert.True(transaction.IsSuccess, transaction.ErrorMessage);
    }

    private static MessageCenterService CreateService(
        SqlSugarClient db,
        IUnifiedCache unifiedCache,
        IMessageNotificationStreamPort notifications)
        => new(
            db,
            new MessageCacheService(unifiedCache, unifiedCache, unifiedCache),
            notifications,
            NullLogger<MessageCenterService>.Instance);
}
