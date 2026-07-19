using System.Globalization;

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

using Npgsql;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class MessageCenterPersistenceIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CreateAccountTicketAsync_CommitsConversationMessageParticipantAndOutboxAtomically()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));

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
            new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(),
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
        AdminConversationQueueState adminQueue = Assert.Single(
            await db.Queryable<AdminConversationQueueState>().ToListAsync());
        Assert.Equal(conversation.Id, adminQueue.ConversationId);
        Assert.Null(adminQueue.LastReadMessageId);
        Assert.Equal(1, adminQueue.UnreadCount);
        Assert.Equal(1, adminQueue.Version);

        await cache.DidNotReceiveWithAnyArgs().TrySetStringIfValueAsync(default, default!, default!, default!, default!, default, default);
        Assert.Empty(notifications.ReceivedCalls());
        List<MessageMutationOutbox> outbox = await db.Queryable<MessageMutationOutbox>().OrderBy(it => it.Id).ToListAsync();
        Assert.Equal(3, outbox.Count);
        Assert.All(outbox, item => Assert.Equal(MessageMutationOutboxStatus.Pending, item.Status));
        Assert.All(outbox, item => Assert.Contains($":{conversation.Id}:", item.DeliveryKey, StringComparison.Ordinal));
        Assert.Equal(3, outbox.Select(static item => item.DeliveryKey).Distinct(StringComparer.Ordinal).Count());
        Assert.Contains(outbox, static item => item.EventKind == MessageMutationOutboxEventKinds.MessageAppend && item.AudienceKind == MessageMutationOutboxAudiences.Admins);
    }

    [Fact]
    public async Task AdminQueueState_SeparatesAccountAdminAndSystemUnreadAndMarksLatestDetailRead()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));
        IUnifiedCache cache = CreatePermissiveUnifiedCache();
        IMessageNotificationStreamPort notifications = Substitute.For<IMessageNotificationStreamPort>();
        MessageCenterService service = CreateService(db, cache, notifications);

        Result<ConversationDetailResponse> created = await service.CreateAccountTicketAsync(42, "queue", "account opens ticket");
        Assert.True(created.IsSuccess, created.Error.Message);
        long conversationId = long.Parse(created.Value!.ConversationId);
        long firstMessageId = long.Parse(Assert.Single(created.Value.Messages).MessageId);

        PageResponse<AdminConversationListItemResponse> unread =
            await service.GetAdminConversationsAsync(20, "unread", null);
        AdminConversationListItemResponse unreadItem = Assert.Single(unread.Items);
        Assert.Equal(conversationId.ToString(), unreadItem.ConversationId);
        Assert.Equal(1, unreadItem.UnreadCount);

        AdminConversationDetailResponse adminDetail = Assert.IsType<AdminConversationDetailResponse>(
            await service.GetAdminConversationDetailAsync(conversationId));
        Assert.Equal(0, adminDetail.UnreadCount);
        AdminConversationQueueState queue = Assert.IsType<AdminConversationQueueState>(
            await db.Queryable<AdminConversationQueueState>().InSingleAsync(conversationId));
        Assert.Equal(firstMessageId, queue.LastReadMessageId);
        Assert.Equal(0, queue.UnreadCount);
        Assert.NotNull(queue.LastReadAt);

        Result<ConversationMessageResponse> adminReply = await service.ReplyAsAdminAsync(
            conversationId,
            "admin reply",
            new AdminMessageActor(7, "admin-session-7"));
        Assert.True(adminReply.IsSuccess, adminReply.Error.Message);
        long adminReplyMessageId = long.Parse(adminReply.Value!.MessageId);
        queue = Assert.IsType<AdminConversationQueueState>(
            await db.Queryable<AdminConversationQueueState>().InSingleAsync(conversationId));
        Assert.Equal(0, queue.UnreadCount);
        ConversationParticipantState participant = Assert.IsType<ConversationParticipantState>(
            await db.Queryable<ConversationParticipantState>()
                .Where(state => state.ConversationId == conversationId && state.AccountId == 42)
                .FirstAsync());
        Assert.Equal(1, participant.UnreadCount);

        Result<ConversationMessageResponse> accountReply = await service.ReplyAsAccountAsync(
            42,
            conversationId,
            adminReplyMessageId,
            "account follows up");
        Assert.True(accountReply.IsSuccess, accountReply.Error.Message);
        long accountReplyMessageId = long.Parse(accountReply.Value!.MessageId);
        queue = Assert.IsType<AdminConversationQueueState>(
            await db.Queryable<AdminConversationQueueState>().InSingleAsync(conversationId));
        Assert.Equal(1, queue.UnreadCount);
        participant = Assert.IsType<ConversationParticipantState>(
            await db.Queryable<ConversationParticipantState>()
                .Where(state => state.ConversationId == conversationId && state.AccountId == 42)
                .FirstAsync());
        Assert.Equal(0, participant.UnreadCount);

        Result<ConversationDetailResponse> systemMessage = await service.SendSystemMessageAsync(
            "system",
            "system notice",
            42,
            AdminMessageActor.System);
        Assert.True(systemMessage.IsSuccess, systemMessage.Error.Message);
        long systemConversationId = long.Parse(systemMessage.Value!.ConversationId);
        long systemMessageId = long.Parse(Assert.Single(systemMessage.Value.Messages).MessageId);
        AdminConversationQueueState systemQueue = Assert.IsType<AdminConversationQueueState>(
            await db.Queryable<AdminConversationQueueState>().InSingleAsync(systemConversationId));
        Assert.Equal(0, systemQueue.UnreadCount);

        unread = await service.GetAdminConversationsAsync(20, "unread", null);
        unreadItem = Assert.Single(unread.Items);
        Assert.Equal(conversationId.ToString(), unreadItem.ConversationId);
        Assert.Equal(1, unreadItem.UnreadCount);

        List<MessageMutationOutbox> deliveries = await db.Queryable<MessageMutationOutbox>().ToListAsync();
        Assert.Contains(
            deliveries,
            item => item.MessageId == adminReplyMessageId
                && item.EventKind == MessageMutationOutboxEventKinds.MessageAppend
                && item.AudienceKind == MessageMutationOutboxAudiences.Account
                && item.TargetAccountId == 42);
        Assert.Contains(
            deliveries,
            item => item.MessageId == accountReplyMessageId
                && item.EventKind == MessageMutationOutboxEventKinds.ReadUpdated
                && item.AudienceKind == MessageMutationOutboxAudiences.Account
                && item.TargetAccountId == 42);
        Assert.Contains(
            deliveries,
            item => item.MessageId == accountReplyMessageId
                && item.EventKind == MessageMutationOutboxEventKinds.MessageAppend
                && item.AudienceKind == MessageMutationOutboxAudiences.Admins);
        Assert.Contains(
            deliveries,
            item => item.MessageId == systemMessageId
                && item.EventKind == MessageMutationOutboxEventKinds.MessageAppend
                && item.AudienceKind == MessageMutationOutboxAudiences.Account
                && item.TargetAccountId == 42);
        Assert.Equal(deliveries.Count, deliveries.Select(static item => item.DeliveryKey).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public async Task AdminProjection_IsViewerAwareMinimalAndConsistentAcrossListDetailAndRealtime()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));
        int accountId = await db.Insertable(new User
        {
            Status = 1,
            IdentityKind = "anonymous_account",
            CreateTime = DateTime.UtcNow
        }).ExecuteReturnIdentityAsync();
        IMessageNotificationStreamPort notifications = Substitute.For<IMessageNotificationStreamPort>();
        MessageCenterService service = CreateService(db, CreatePermissiveUnifiedCache(), notifications);

        Result<ConversationDetailResponse> created = await service.CreateAccountTicketAsync(
            accountId,
            "projection",
            "account message");
        Assert.True(created.IsSuccess, created.Error.Message);
        long conversationId = long.Parse(created.Value!.ConversationId, CultureInfo.InvariantCulture);

        PageResponse<ConversationListItemResponse> accountList = await service.GetAccountConversationsAsync(accountId, 20, null, null);
        ConversationListItemResponse accountItem = Assert.Single(accountList.Items);
        Assert.Equal("你", Assert.IsType<ConversationMessagePreviewResponse>(accountItem.LastMessage).SenderName);
        ConversationDetailResponse accountDetail = Assert.IsType<ConversationDetailResponse>(
            await service.GetAccountConversationDetailAsync(accountId, conversationId));
        Assert.Equal("你", Assert.Single(accountDetail.Messages).SenderName);

        PageResponse<AdminConversationListItemResponse> adminList = await service.GetAdminConversationsAsync(20, null, null);
        AdminConversationListItemResponse adminItem = Assert.Single(adminList.Items);
        Assert.Equal(accountId.ToString(CultureInfo.InvariantCulture), adminItem.CounterpartyAccountId);
        Assert.Equal(CounterpartyAccountStatusValue.Restricted, adminItem.CounterpartyAccountStatus);
        Assert.Equal($"账号 #{accountId}", Assert.IsType<ConversationMessagePreviewResponse>(adminItem.LastMessage).SenderName);

        AdminConversationDetailResponse adminDetail = Assert.IsType<AdminConversationDetailResponse>(
            await service.GetAdminConversationDetailAsync(conversationId));
        Assert.Equal(adminItem.CounterpartyAccountId, adminDetail.CounterpartyAccountId);
        Assert.Equal(adminItem.CounterpartyAccountStatus, adminDetail.CounterpartyAccountStatus);
        Assert.Equal($"账号 #{accountId}", Assert.Single(adminDetail.Messages).SenderName);

        Assert.True(PodBinaryCodec.TryDecodeAdminConversationList(
            PodBinaryCodec.EncodeAdminConversationList(adminList),
            out PageResponse<AdminConversationListItemResponse> listRoundTrip));
        AdminConversationListItemResponse listRoundTripItem = Assert.Single(listRoundTrip.Items);
        Assert.Equal(adminItem.ConversationId, listRoundTripItem.ConversationId);
        Assert.Equal(adminItem.CounterpartyAccountId, listRoundTripItem.CounterpartyAccountId);
        Assert.Equal(adminItem.CounterpartyAccountStatus, listRoundTripItem.CounterpartyAccountStatus);
        Assert.Equal(adminItem.LastMessage?.SenderName, listRoundTripItem.LastMessage?.SenderName);
        Assert.True(PodBinaryCodec.TryDecodeAdminConversationDetail(
            PodBinaryCodec.EncodeAdminConversationDetail(adminDetail),
            out AdminConversationDetailResponse detailRoundTrip));
        Assert.Equal(adminDetail.CounterpartyAccountId, detailRoundTrip.CounterpartyAccountId);
        Assert.Equal(adminDetail.CounterpartyAccountStatus, detailRoundTrip.CounterpartyAccountStatus);
        Assert.Equal(adminDetail.Messages.Select(static message => message.SenderName), detailRoundTrip.Messages.Select(static message => message.SenderName));
        Assert.Equal(adminDetail.Messages.Select(static message => message.Body), detailRoundTrip.Messages.Select(static message => message.Body));

        MessageMutationOutbox adminUpsert = Assert.IsType<MessageMutationOutbox>(
            await db.Queryable<MessageMutationOutbox>()
                .Where(item => item.AudienceKind == MessageMutationOutboxAudiences.Admins && item.EventKind == MessageMutationOutboxEventKinds.ConversationUpsert)
                .FirstAsync());
        await service.DeliverAsync(adminUpsert, CancellationToken.None);
        var upsertCall = notifications.ReceivedCalls().Last(call =>
            call.GetMethodInfo().Name == nameof(IMessageNotificationStreamPort.PublishToAdminUsersAsync) &&
            Equals(call.GetArguments()[0], NotificationStreamEventType.InboxConversationUpsert));
        InboxConversationUpsertPayload realtime = Assert.IsType<InboxConversationUpsertPayload>(upsertCall.GetArguments()[1]);
        AdminConversationListItemResponse realtimeProjection = Assert.IsType<AdminConversationListItemResponse>(realtime.Conversation);
        Assert.Equal(adminItem.CounterpartyAccountId, realtimeProjection.CounterpartyAccountId);
        Assert.Equal(adminItem.CounterpartyAccountStatus, realtimeProjection.CounterpartyAccountStatus);
        Assert.DoesNotContain(
            realtimeProjection.GetType().GetProperties(),
            property => property.Name.Contains("Session", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task AdminQueueState_ConcurrentAccountRepliesIncrementWithoutLostUpdates()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setup,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));
        IUnifiedCache cache = CreatePermissiveUnifiedCache();
        IMessageNotificationStreamPort notifications = Substitute.For<IMessageNotificationStreamPort>();
        MessageCenterService setupService = CreateService(setup, cache, notifications);
        Result<ConversationDetailResponse> created = await setupService.CreateAccountTicketAsync(42, "concurrent", "first");
        Assert.True(created.IsSuccess, created.Error.Message);
        long conversationId = long.Parse(created.Value!.ConversationId);
        long readThroughMessageId = long.Parse(Assert.Single(created.Value.Messages).MessageId);
        Assert.NotNull(await setupService.GetAdminConversationDetailAsync(conversationId));

        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        MessageCenterService first = CreateService(firstDb, cache, notifications);
        MessageCenterService second = CreateService(secondDb, cache, notifications);
        Task<Result<ConversationMessageResponse>> firstReply =
            first.ReplyAsAccountAsync(42, conversationId, readThroughMessageId, "reply one");
        Task<Result<ConversationMessageResponse>> secondReply =
            second.ReplyAsAccountAsync(42, conversationId, readThroughMessageId, "reply two");
        Result<ConversationMessageResponse>[] replies = await Task.WhenAll(firstReply, secondReply);

        Assert.All(replies, result => Assert.True(result.IsSuccess, result.Error.Message));
        AdminConversationQueueState queue = Assert.IsType<AdminConversationQueueState>(
            await setup.Queryable<AdminConversationQueueState>().InSingleAsync(conversationId));
        Assert.Equal(2, queue.UnreadCount);
        Assert.Equal(4, queue.Version);
    }

    [Fact]
    public async Task AdminQueueMaintenance_BackfillsAndRepairsMissingMismatchedAndInvalidState()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));
        const long ConversationId = 8_800;
        DateTime now = DateTime.UtcNow;
        await db.Insertable(new MessageConversation
        {
            Id = ConversationId,
            Subject = "legacy",
            InitiatorAccountId = 42,
            Status = ConversationStatus.Open,
            CreatedByType = MessageSenderType.Account,
            CreatedByAccountId = 42,
            CreatedAt = now,
            UpdatedAt = now,
            LastMessageAt = now
        }).ExecuteCommandAsync();
        await db.Insertable(new[]
        {
            new ConversationMessage
            {
                Id = 8_801,
                ConversationId = ConversationId,
                SenderType = MessageSenderType.Account,
                SenderAccountId = 42,
                Body = "account one",
                CreatedAt = now
            },
            new ConversationMessage
            {
                Id = 8_802,
                ConversationId = ConversationId,
                SenderType = MessageSenderType.Admin,
                SenderAdminPrincipalId = 7,
                Body = "admin",
                CreatedAt = now
            },
            new ConversationMessage
            {
                Id = 8_803,
                ConversationId = ConversationId,
                SenderType = MessageSenderType.Account,
                SenderAccountId = 42,
                Body = "account two",
                CreatedAt = now
            }
        }).ExecuteCommandAsync();
        MessageCenterService service = CreateService(
            db,
            CreatePermissiveUnifiedCache(),
            Substitute.For<IMessageNotificationStreamPort>());

        AdminQueueConsistencyReport report = await service.CheckAdminQueueConsistencyAsync();
        Assert.Equal(1, report.ConversationCount);
        Assert.Equal(1, report.MissingStateCount);
        Assert.Equal(1, report.MismatchedUnreadCount);
        Assert.Equal(0, report.InvalidReadCursorCount);
        Assert.Equal(1, await service.RebuildAdminQueueStateAsync());

        AdminConversationQueueState queue = Assert.IsType<AdminConversationQueueState>(
            await db.Queryable<AdminConversationQueueState>().InSingleAsync(ConversationId));
        Assert.Equal(2, queue.UnreadCount);
        Assert.Null(queue.LastReadMessageId);
        await db.Updateable<AdminConversationQueueState>()
            .SetColumns(state => new AdminConversationQueueState
            {
                LastReadMessageId = 999_999,
                LastReadAt = now,
                UnreadCount = 99
            })
            .Where(state => state.ConversationId == ConversationId)
            .ExecuteCommandAsync();

        report = await service.CheckAdminQueueConsistencyAsync();
        Assert.Equal(1, report.MismatchedUnreadCount);
        Assert.Equal(1, report.InvalidReadCursorCount);
        Assert.Equal(1, await service.RebuildAdminQueueStateAsync());
        queue = Assert.IsType<AdminConversationQueueState>(
            await db.Queryable<AdminConversationQueueState>().InSingleAsync(ConversationId));
        Assert.Null(queue.LastReadMessageId);
        Assert.Null(queue.LastReadAt);
        Assert.Equal(2, queue.UnreadCount);

        report = await service.CheckAdminQueueConsistencyAsync();
        Assert.Equal(0, report.MissingStateCount);
        Assert.Equal(0, report.MismatchedUnreadCount);
        Assert.Equal(0, report.InvalidReadCursorCount);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task AdminReply_WaitsForConcurrentCloseAndRequiresExplicitReopen()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setup,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));
        IUnifiedCache cache = CreatePermissiveUnifiedCache();
        IMessageNotificationStreamPort notifications = Substitute.For<IMessageNotificationStreamPort>();
        MessageCenterService setupService = CreateService(setup, cache, notifications);
        Result<ConversationDetailResponse> created = await setupService.CreateAccountTicketAsync(42, "close barrier", "first");
        Assert.True(created.IsSuccess, created.Error.Message);
        long conversationId = long.Parse(created.Value!.ConversationId);
        notifications.ClearReceivedCalls();

        await using var closeConnection = new NpgsqlConnection(connectionString);
        await closeConnection.OpenAsync();
        await using NpgsqlTransaction closeTransaction = await closeConnection.BeginTransactionAsync();
        await using (var closeCommand = new NpgsqlCommand(
            "UPDATE msg_conversation SET status = @status, updatedat = @now WHERE id = @id;",
            closeConnection,
            closeTransaction))
        {
            closeCommand.Parameters.AddWithValue("status", (int)ConversationStatus.Closed);
            closeCommand.Parameters.AddWithValue("now", DateTime.UtcNow);
            closeCommand.Parameters.AddWithValue("id", conversationId);
            Assert.Equal(1, await closeCommand.ExecuteNonQueryAsync());
        }

        using SqlSugarClient replyDb = PostgresSqlSugarTestClient.Create(connectionString);
        MessageCenterService replyService = CreateService(replyDb, cache, notifications);
        Task<Result<ConversationMessageResponse>> blockedReply = replyService.ReplyAsAdminAsync(
            conversationId,
            "must not cross close",
            new AdminMessageActor(7, "admin-session-7"));
        await closeTransaction.CommitAsync();

        Result<ConversationMessageResponse> closed = await blockedReply;
        Assert.False(closed.IsSuccess);
        Assert.Equal(ErrorCode.Conflict, closed.Error.Code);
        Assert.Equal(1, await setup.Queryable<ConversationMessage>().CountAsync());
        Assert.DoesNotContain(
            notifications.ReceivedCalls(),
            call => call.GetMethodInfo().Name == nameof(IMessageNotificationStreamPort.PublishToUserAsync));

        Result reopened = await setupService.UpdateConversationStatusAsync(
            conversationId,
            ConversationStatusValue.Open,
            new AdminMessageActor(7, "admin-session-7"));
        Assert.True(reopened.IsSuccess, reopened.Error.Message);
        List<MessageMutationOutbox> statusDeliveries = await setup.Queryable<MessageMutationOutbox>()
            .Where(item => item.ConversationId == conversationId)
            .ToListAsync();
        Assert.Contains(
            statusDeliveries,
            item => item.EventKind == MessageMutationOutboxEventKinds.ConversationStatus
                && item.AudienceKind == MessageMutationOutboxAudiences.Account
                && item.TargetAccountId == 42);
        Assert.Contains(
            statusDeliveries,
            item => item.EventKind == MessageMutationOutboxEventKinds.ConversationUpsert
                && item.AudienceKind == MessageMutationOutboxAudiences.Admins
                && item.MessageId == null);
        Result<ConversationMessageResponse> accepted = await replyService.ReplyAsAdminAsync(
            conversationId,
            "accepted after reopen",
            new AdminMessageActor(7, "admin-session-7"));
        Assert.True(accepted.IsSuccess, accepted.Error.Message);
        Assert.Equal(2, await setup.Queryable<ConversationMessage>().CountAsync());
    }

    [Fact]
    public async Task AdminReply_RepeatedSubmissionCommitsDistinctMessagesWithoutUnreadDrift()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));
        MessageCenterService service = CreateService(
            db,
            CreatePermissiveUnifiedCache(),
            Substitute.For<IMessageNotificationStreamPort>());
        Result<ConversationDetailResponse> created = await service.CreateAccountTicketAsync(42, "repeat", "first");
        Assert.True(created.IsSuccess, created.Error.Message);
        long conversationId = long.Parse(created.Value!.ConversationId);

        Result<ConversationMessageResponse> first = await service.ReplyAsAdminAsync(
            conversationId,
            "same request body",
            new AdminMessageActor(7, "admin-session-7"));
        Result<ConversationMessageResponse> second = await service.ReplyAsAdminAsync(
            conversationId,
            "same request body",
            new AdminMessageActor(7, "admin-session-7"));

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(second.IsSuccess, second.Error.Message);
        Assert.NotEqual(first.Value!.MessageId, second.Value!.MessageId);
        Assert.Equal(3, await db.Queryable<ConversationMessage>().CountAsync());
        ConversationParticipantState participant = Assert.IsType<ConversationParticipantState>(
            await db.Queryable<ConversationParticipantState>()
                .Where(state => state.ConversationId == conversationId && state.AccountId == 42)
                .FirstAsync());
        Assert.Equal(2, participant.UnreadCount);
        AdminConversationQueueState adminQueue = Assert.IsType<AdminConversationQueueState>(
            await db.Queryable<AdminConversationQueueState>().InSingleAsync(conversationId));
        Assert.Equal(1, adminQueue.UnreadCount);
    }

    [Fact]
    public async Task AccountReply_InfrastructureFailureRollsBackMessageActivityReadStateAndDelivery()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));
        IMessageNotificationStreamPort notifications = Substitute.For<IMessageNotificationStreamPort>();
        MessageCenterService service = CreateService(db, CreatePermissiveUnifiedCache(), notifications);
        Result<ConversationDetailResponse> created = await service.CreateAccountTicketAsync(42, "rollback", "first");
        Assert.True(created.IsSuccess, created.Error.Message);
        long conversationId = long.Parse(created.Value!.ConversationId);
        long readThroughMessageId = long.Parse(Assert.Single(created.Value.Messages).MessageId);
        MessageConversation before = Assert.IsType<MessageConversation>(
            await db.Queryable<MessageConversation>().InSingleAsync(conversationId));
        ConversationParticipantState participantBefore = Assert.IsType<ConversationParticipantState>(
            await db.Queryable<ConversationParticipantState>()
                .Where(state => state.ConversationId == conversationId && state.AccountId == 42)
                .FirstAsync());
        notifications.ClearReceivedCalls();
        await db.Ado.ExecuteCommandAsync("DROP TABLE msg_admin_queue_state;");

        Result<ConversationMessageResponse> failed = await service.ReplyAsAccountAsync(
            42,
            conversationId,
            readThroughMessageId,
            "must roll back");

        Assert.False(failed.IsSuccess);
        Assert.Equal(ErrorCode.InfraFailure, failed.Error.Code);
        Assert.Equal(1, await db.Queryable<ConversationMessage>().CountAsync());
        MessageConversation after = Assert.IsType<MessageConversation>(
            await db.Queryable<MessageConversation>().InSingleAsync(conversationId));
        Assert.Equal(before.LastMessageAt, after.LastMessageAt);
        Assert.Equal(before.UpdatedAt, after.UpdatedAt);
        ConversationParticipantState participantAfter = Assert.IsType<ConversationParticipantState>(
            await db.Queryable<ConversationParticipantState>()
                .Where(state => state.ConversationId == conversationId && state.AccountId == 42)
                .FirstAsync());
        Assert.Equal(participantBefore.LastReadMessageId, participantAfter.LastReadMessageId);
        Assert.Equal(participantBefore.UnreadCount, participantAfter.UnreadCount);
        Assert.Empty(notifications.ReceivedCalls());
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task AccountReadCursor_DoubleConnectionPreservesSnapshotAcrossInsertReplyAndInternalMessages()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setup,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));

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
        MessageMutationOutbox readDelivery = Assert.IsType<MessageMutationOutbox>(
            await setup.Queryable<MessageMutationOutbox>()
                .Where(item => item.EventKind == MessageMutationOutboxEventKinds.ReadUpdated && item.ReadThroughMessageId == SnapshotMessageId)
                .FirstAsync());
        await first.DeliverAsync(readDelivery, CancellationToken.None);
        await notifications.Received(1).PublishToUserAsync(
            NotificationStreamEventType.InboxReadUpdated,
            AccountId,
            Arg.Is<InboxReadUpdatedPayload>(payload =>
                payload.ConversationId == ConversationId.ToString()
                && payload.LastReadMessageId == SnapshotMessageId.ToString()
                && payload.ConversationUnreadCount == 1),
            "inbox-read-updated",
            readDelivery.DeliveryKey);

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
    public async Task ConversationMessagePagination_TraversesThousandMessageSnapshotWithoutInternalRowsOrDuplicates()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setup,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));

        const int AccountId = 42;
        const long ConversationId = 9_000;
        const int MessageCount = 1_005;
        const long FirstMessageId = 100_000;
        DateTime baseline = new(2026, 7, 19, 8, 0, 0, DateTimeKind.Utc);
        await setup.Insertable(new MessageConversation
        {
            Id = ConversationId,
            Subject = "long thread fixture",
            InitiatorAccountId = AccountId,
            Status = ConversationStatus.Open,
            CreatedByType = MessageSenderType.Account,
            CreatedByAccountId = AccountId,
            CreatedAt = baseline,
            UpdatedAt = baseline.AddSeconds(MessageCount),
            LastMessageAt = baseline.AddSeconds(MessageCount)
        }).ExecuteCommandAsync();

        var messages = new List<ConversationMessage>(MessageCount + 1);
        for (int i = 0; i < MessageCount; i++)
        {
            messages.Add(new ConversationMessage
            {
                Id = FirstMessageId + i,
                ConversationId = ConversationId,
                SenderType = i % 2 == 0 ? MessageSenderType.Account : MessageSenderType.Admin,
                SenderAccountId = i % 2 == 0 ? AccountId : null,
                SenderAdminPrincipalId = i % 2 == 0 ? null : 7,
                SenderAdminSessionId = i % 2 == 0 ? null : "long-thread-fixture",
                Body = $"message-{i:D4}",
                CreatedAt = baseline.AddSeconds(i)
            });
        }
        messages.Add(new ConversationMessage
        {
            Id = 150_000,
            ConversationId = ConversationId,
            SenderType = MessageSenderType.Admin,
            SenderAdminPrincipalId = 7,
            SenderAdminSessionId = "internal-fixture",
            Body = "internal-only",
            IsInternalNote = true,
            CreatedAt = baseline.AddSeconds(MessageCount + 1)
        });
        await setup.Insertable(messages).ExecuteCommandAsync();
        await setup.Insertable(new ConversationParticipantState
        {
            ConversationId = ConversationId,
            AccountId = AccountId,
            UnreadCount = MessageCount,
            UpdatedAt = baseline
        }).ExecuteCommandAsync();

        IUnifiedCache unifiedCache = Substitute.For<IUnifiedCache>();
        IMessageNotificationStreamPort notifications = Substitute.For<IMessageNotificationStreamPort>();
        MessageCenterService service = CreateService(setup, unifiedCache, notifications);
        ConversationDetailResponse page = Assert.IsType<ConversationDetailResponse>(
            await service.GetAccountConversationDetailAsync(AccountId, ConversationId));

        Assert.Equal(50, page.Messages.Count);
        Assert.True(page.HasOlder);
        Assert.Equal((FirstMessageId + MessageCount - 50).ToString(), page.PreviousCursor);
        Assert.Equal((FirstMessageId + MessageCount - 1).ToString(), page.ReadSnapshotMessageId);
        Assert.True(PodBinaryCodec.TryDecodeConversationDetailV3(
            PodBinaryCodec.EncodeConversationDetailV3(page),
            out ConversationDetailResponse roundTrip));
        Assert.Equal(page.PreviousCursor, roundTrip.PreviousCursor);
        Assert.True(roundTrip.HasOlder);

        await setup.Insertable(new ConversationMessage
        {
            Id = 200_000,
            ConversationId = ConversationId,
            SenderType = MessageSenderType.Admin,
            SenderAdminPrincipalId = 8,
            SenderAdminSessionId = "concurrent-fixture",
            Body = "arrived-after-first-page",
            CreatedAt = baseline.AddSeconds(MessageCount + 2)
        }).ExecuteCommandAsync();

        var loaded = new List<ConversationMessageResponse>(page.Messages);
        while (page.HasOlder)
        {
            long beforeMessageId = long.Parse(Assert.IsType<string>(page.PreviousCursor));
            page = Assert.IsType<ConversationDetailResponse>(
                await service.GetAccountConversationDetailAsync(AccountId, ConversationId, beforeMessageId));
            loaded.InsertRange(0, page.Messages);
        }

        Assert.Equal(MessageCount, loaded.Count);
        Assert.Equal(MessageCount, loaded.Select(message => message.MessageId).Distinct().Count());
        Assert.Equal(FirstMessageId.ToString(), loaded[0].MessageId);
        Assert.Equal((FirstMessageId + MessageCount - 1).ToString(), loaded[^1].MessageId);
        Assert.DoesNotContain(loaded, message => message.Body is "internal-only" or "arrived-after-first-page");
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task ConversationCursorPagination_TraversesStableSnapshotWithTiesFiltersAndConcurrentMessage()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setup = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            setup,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState),
            typeof(MessageMutationOutbox));

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

        var adminItems = new List<AdminConversationListItemResponse>();
        PageResponse<AdminConversationListItemResponse> adminPage = await service.GetAdminConversationsAsync(30, "all", null);
        adminItems.AddRange(adminPage.Items);
        while (adminPage.HasMore)
        {
            Assert.True(MessageConversationCursor.TryDecode(adminPage.NextCursor, out MessageConversationCursor cursor));
            adminPage = await service.GetAdminConversationsAsync(30, "all", cursor);
            adminItems.AddRange(adminPage.Items);
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
            new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(),
            NullLogger<MessageCenterService>.Instance);

    private static IUnifiedCache CreatePermissiveUnifiedCache()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(
                CachePolicyId.MessageUnread,
                Arg.Any<string>(),
                1,
                Arg.Any<CancellationToken>())
            .Returns(1);
        cache.TrySetStringIfValueAsync(
                CachePolicyId.MessageUnread,
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                null,
                Arg.Any<CancellationToken>())
            .Returns(true);
        return cache;
    }
}
