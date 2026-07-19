using System.Diagnostics.Metrics;
using System.Reflection;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests;

public sealed class MessageCenterServiceTests
{
    [Fact]
    public void BinaryMessageMutationEndpoints_RequireStableCommandIdentityHeaders()
    {
        string endpoints = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Modules",
            "Endpoints",
            "Binary",
            "BinaryEndpoints.Messages.cs"));

        Assert.Contains("X-Fsus-Client-Mutation-Id", endpoints, StringComparison.Ordinal);
        Assert.Contains("client_mutation_id_required", endpoints, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Source-Event-Id", endpoints, StringComparison.Ordinal);
        Assert.Contains("source_event_id_required", endpoints, StringComparison.Ordinal);
        Assert.Equal(
            typeof(bool),
            typeof(ConversationDetailResponse).GetProperty(nameof(ConversationDetailResponse.IdempotencyReplay))!.PropertyType);
        Assert.Equal(
            typeof(bool),
            typeof(ConversationMessageResponse).GetProperty(nameof(ConversationMessageResponse.IdempotencyReplay))!.PropertyType);
    }

    [Fact]
    public void MessageConversationCursor_RoundTripsSnapshotAndStableSortKey()
    {
        var expected = new MessageConversationCursor(
            987654321,
            new DateTime(2026, 7, 19, 9, 10, 11, DateTimeKind.Utc).AddTicks(120),
            123456789);

        Assert.True(MessageConversationCursor.TryDecode(expected.Encode(), out MessageConversationCursor decoded));
        Assert.Equal(expected, decoded);
        Assert.False(MessageConversationCursor.TryDecode("not-a-cursor", out _));
    }

    private static MessageCenterService BuildService()
    {
        var db = Substitute.For<ISqlSugarClient>();
        IUnifiedCache unifiedCache = Substitute.For<IUnifiedCache>();
        var cache = new MessageCacheService(unifiedCache, unifiedCache, unifiedCache);
        return new MessageCenterService(
            db,
            cache,
            Substitute.For<IMessageNotificationStreamPort>(),
            new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(),
            NullLogger<MessageCenterService>.Instance);
    }

    [Fact]
    public async Task CreateAccountTicketAsync_EmptyBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.CreateAccountTicketAsync(1, "subject", "   ");
        Assert.False(result.IsSuccess);
    }

    [Fact]
    public async Task CreateAccountTicketAsync_NullBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.CreateAccountTicketAsync(1, "subject", null!);
        Assert.False(result.IsSuccess);
    }

    [Fact]
    public async Task ReplyAsAccountAsync_EmptyBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.ReplyAsAccountAsync(1, 999L, 1L, "   ");
        Assert.False(result.IsSuccess);
    }

    [Fact]
    public async Task ReplyAsAdminAsync_EmptyBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.ReplyAsAdminAsync(999L, "   ", new AdminMessageActor(1, "admin-session-1"));
        Assert.False(result.IsSuccess);
    }

    [Fact]
    public async Task SendSystemMessageAsync_EmptyBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.SendSystemMessageAsync("subject", "   ", null, new AdminMessageActor(1, "admin-session-1"));
        Assert.False(result.IsSuccess);
    }

    [Fact]
    public void MessageDomain_UsesAccountAndAdminPrincipalVocabulary()
    {
        string[] conversation = PropertyNames<MessageConversation>();
        string[] message = PropertyNames<ConversationMessage>();
        string[] participant = PropertyNames<ConversationParticipantState>();
        string[] adminQueue = PropertyNames<AdminConversationQueueState>();
        Assert.Contains(nameof(MessageConversation.InitiatorAccountId), conversation);
        Assert.Contains(nameof(MessageConversation.CreatedByAccountId), conversation);
        Assert.Contains(nameof(MessageConversation.CreatedByAdminPrincipalId), conversation);
        Assert.Contains(nameof(MessageConversation.CreatedByAdminSessionId), conversation);
        Assert.Contains(nameof(ConversationMessage.SenderAccountId), message);
        Assert.Contains(nameof(ConversationMessage.SenderAdminPrincipalId), message);
        Assert.Contains(nameof(ConversationMessage.SenderAdminSessionId), message);
        Assert.Contains(nameof(ConversationParticipantState.AccountId), participant);
        Assert.Contains(nameof(AdminConversationQueueState.ConversationId), adminQueue);
        Assert.Contains(nameof(AdminConversationQueueState.LastReadMessageId), adminQueue);
        Assert.Contains(nameof(AdminConversationQueueState.UnreadCount), adminQueue);
        Assert.Contains(nameof(AdminConversationQueueState.LastReadAt), adminQueue);
        Assert.Contains(nameof(AdminConversationQueueState.Version), adminQueue);
        Assert.DoesNotContain("InitiatorUserId", conversation);
        Assert.DoesNotContain("CreatedById", conversation);
        Assert.DoesNotContain("SenderId", message);
        Assert.DoesNotContain("UserId", participant);

        string service = RuntimeMetadataInspection.DescribeType(typeof(MessageCenterService));

        Assert.DoesNotContain("Queryable<User>", service, StringComparison.Ordinal);
        Assert.DoesNotContain("User.get_Username", service, StringComparison.Ordinal);
        Assert.DoesNotContain("adminUserId", service, StringComparison.Ordinal);
        Assert.Contains("AdminMessageActor", service, StringComparison.Ordinal);
        Assert.Contains("SenderAdminPrincipalId", service, StringComparison.Ordinal);
        Assert.Contains("SenderAdminSessionId", service, StringComparison.Ordinal);
        Assert.Contains(nameof(MessageSenderType.Account), Enum.GetNames<MessageSenderType>());
        Assert.Contains("GetAccountConversationsAsync", service, StringComparison.Ordinal);
        Assert.Contains("CreateAccountTicketAsync", service, StringComparison.Ordinal);
        Assert.Contains("ReplyAsAccountAsync", service, StringComparison.Ordinal);
        Assert.Contains("SendAccountTransactionalNoticeAsync", service, StringComparison.Ordinal);
        Assert.Contains("PushAccountStatusAsync", service, StringComparison.Ordinal);
        Assert.Contains("AccountStatusPayload", service, StringComparison.Ordinal);
        Assert.DoesNotContain("User", Enum.GetNames<MessageSenderType>());
        Assert.DoesNotContain("GetUserConversationsAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserConversationDetailAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateUserTicketAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("ReplyAsUserAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("SendUserTransactionalNoticeAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("PushUserStatusAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("UserStatusPayload", service, StringComparison.Ordinal);
        Assert.DoesNotContain("UserConversationRow", service, StringComparison.Ordinal);

        string[] queryPorts = typeof(IMessageQueryService).GetMethods().Select(static methodInfo => methodInfo.Name).ToArray();
        string[] commandPorts = typeof(IMessageCommandService).GetMethods().Select(static methodInfo => methodInfo.Name).ToArray();
        string[] realtimePorts = typeof(IMessageRealtimePublisher).GetMethods().Select(static methodInfo => methodInfo.Name).ToArray();
        string[] maintenancePorts = typeof(IMessageAdminQueueMaintenance).GetMethods().Select(static methodInfo => methodInfo.Name).ToArray();
        string ports = string.Join('\n', queryPorts.Concat(commandPorts).Concat(realtimePorts).Concat(maintenancePorts));
        Assert.DoesNotContain("adminUserId", ports, StringComparison.Ordinal);
        Assert.Contains(nameof(AdminMessageActor), RuntimeMetadataInspection.DescribeType(typeof(AdminMessageActor)), StringComparison.Ordinal);
        Assert.Contains("GetAccountConversationsAsync", ports, StringComparison.Ordinal);
        Assert.Contains("CreateAccountTicketAsync", ports, StringComparison.Ordinal);
        Assert.Contains("ReplyAsAccountAsync", ports, StringComparison.Ordinal);
        Assert.Contains("SendAccountTransactionalNoticeAsync", ports, StringComparison.Ordinal);
        Assert.Contains("PushAccountStatusAsync", ports, StringComparison.Ordinal);
        Assert.Contains("CheckAdminQueueConsistencyAsync", ports, StringComparison.Ordinal);
        Assert.Contains("RebuildAdminQueueStateAsync", ports, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserConversationsAsync", ports, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateUserTicketAsync", ports, StringComparison.Ordinal);
        Assert.DoesNotContain("ReplyAsUserAsync", ports, StringComparison.Ordinal);
        Assert.DoesNotContain("SendUserTransactionalNoticeAsync", ports, StringComparison.Ordinal);
        Assert.DoesNotContain("PushUserStatusAsync", ports, StringComparison.Ordinal);

        string endpoints = RuntimeMetadataInspection.DescribeType(typeof(BinaryEndpoints));
        Assert.Contains("TryResolveAdminSessionContext", endpoints, StringComparison.Ordinal);
        Assert.Contains(nameof(AccountPrincipalContext), endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("ResolveCurrentAccountId", endpoints, StringComparison.Ordinal);
        Assert.Contains("GetAccountConversationsAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("Messages:CursorPaginationEnabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("message_cursor_pagination_disabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("Messages:ThreadPaginationEnabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("message_thread_pagination_disabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("Messages:AdminQueueProjectionEnabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("message_admin_queue_projection_disabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("Messages:AdminAccountProjectionEnabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("message_admin_account_projection_disabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminConversationList", endpoints, StringComparison.Ordinal);
        Assert.Contains("AdminConversationDetail", endpoints, StringComparison.Ordinal);
        Assert.Contains("Messages:ReplyWritesEnabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("message_reply_writes_disabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("Messages:MutationIdempotencyEnabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("message_mutation_idempotency_disabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("Messages:StatusMutationsEnabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("message_status_mutations_disabled", endpoints, StringComparison.Ordinal);
        Assert.Contains("beforeMessageId", endpoints, StringComparison.Ordinal);
        Assert.Contains("ConversationDetailV3", endpoints, StringComparison.Ordinal);
        Assert.Contains("CreateAccountTicketAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("ReplyAsAccountAsync", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserConversationsAsync", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateUserTicketAsync", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("ReplyAsUserAsync", endpoints, StringComparison.Ordinal);

        Assert.Equal(0, (int)ConversationSenderValue.Account);
        Assert.DoesNotContain("User", Enum.GetNames<ConversationSenderValue>());
        MethodInfo toSender = typeof(PodBinaryCodec).GetMethod(
            "ToConversationSender",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        Assert.Equal(
            ConversationSenderValue.Account,
            (ConversationSenderValue)toSender.Invoke(null, [0])!);

        ISchemaMigrationDescriptor identityMigration = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static descriptor => descriptor.MigrationId == "20260620-post-message-account-principal");
        string migration = string.Join('\n', identityMigration.Steps.Select(static step => step.Fingerprint));
        Assert.Contains("msg_conversation", migration, StringComparison.Ordinal);
        Assert.Contains("initiatoraccountid", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("senderadminprincipalid", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("accountid", migration, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task MessageEndpoints_OrdinaryAccountRoutesRequireAnonymousAccountPrincipal()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        (string Route, string Method)[] ordinaryRoutes =
        [
            ("/api/binary/messages/conversations", HttpMethods.Get),
            ("/api/binary/messages/conversations/{id:long}", HttpMethods.Get),
            ("/api/binary/messages/conversations", HttpMethods.Post),
            ("/api/binary/messages/conversations/{id:long}/reply", HttpMethods.Post),
            ("/api/binary/messages/conversations/{id:long}/read", HttpMethods.Post)
        ];

        foreach ((string route, string method) in ordinaryRoutes)
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(app, route, method);
            ClaimsAuthorizationRequirement identity = Assert.Single(endpoint.Metadata
                .GetOrderedMetadata<AuthorizationPolicy>()
                .SelectMany(static policy => policy.Requirements)
                .OfType<ClaimsAuthorizationRequirement>(),
                static requirement => requirement.ClaimType == "identity_kind");
            Assert.Contains(AnonymousIdentityRuntime.AnonymousAccountKind, identity.AllowedValues ?? []);
        }

        (string Route, string Method)[] adminRoutes =
        [
            ("/api/binary/admin/messages/conversations", HttpMethods.Get),
            ("/api/binary/admin/messages/conversations/{id:long}", HttpMethods.Get),
            ("/api/binary/admin/messages/conversations/{id:long}/reply", HttpMethods.Post)
        ];
        foreach ((string route, string method) in adminRoutes)
        {
            RouteEndpoint admin = EndpointContractApplication.Find(app, route, method);
            ClaimsAuthorizationRequirement permission = Assert.Single(admin.Metadata
                .GetOrderedMetadata<AuthorizationPolicy>()
                .SelectMany(static policy => policy.Requirements)
                .OfType<ClaimsAuthorizationRequirement>(),
                static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType);
            Assert.Contains(AdminPermissions.AdminManage, permission.AllowedValues ?? []);
        }
        Assert.Contains("AdminMessageActor", RuntimeMetadataInspection.DescribeType(typeof(BinaryEndpoints)), StringComparison.Ordinal);
    }


    [Fact]
    public void BuildLatestMessageMap_PicksMappedLatestMessagePerConversation()
    {
        IReadOnlyList<(long ConversationId, long MessageId)> latestRows =
        [
            (10, 1001),
            (20, 2002),
            (30, 3003)
        ];

        IReadOnlyDictionary<long, ConversationMessagePreviewResponse> mappedByMessageId =
            new Dictionary<long, ConversationMessagePreviewResponse>
            {
                [1001] = new() { SenderName = "u1", BodyPreview = "first", CreatedAt = DateTime.UtcNow },
                [3003] = new() { SenderName = "u3", BodyPreview = "third", CreatedAt = DateTime.UtcNow }
            };

        Dictionary<long, ConversationMessagePreviewResponse> result =
            MessageCenterService.BuildLatestMessageMap(latestRows, mappedByMessageId);

        Assert.Equal(2, result.Count);
        Assert.Equal("first", result[10].BodyPreview);
        Assert.Equal("third", result[30].BodyPreview);
        Assert.False(result.ContainsKey(20));
    }

    [Fact]
    public void BuildMessagePreviewMap_SkipsInvalidMessageIdAndLogsWarning()
    {
        var logger = new CapturingLogger<MessageCenterService>();
        var createdAt = DateTime.UtcNow;
        IReadOnlyList<ConversationMessageResponse> mapped =
        [
            new()
            {
                MessageId = "not-a-number",
                SenderType = ConversationSenderValue.System,
                SenderName = "system",
                Body = "corrupt",
                CreatedAt = createdAt
            },
            new()
            {
                MessageId = "42",
                SenderType = ConversationSenderValue.Account,
                SenderName = "account",
                Body = "valid",
                CreatedAt = createdAt
            }
        ];

        Dictionary<long, ConversationMessagePreviewResponse> result =
            MessageCenterService.BuildMessagePreviewMap(mapped, logger);

        ConversationMessagePreviewResponse preview = Assert.Single(result).Value;
        Assert.Equal("valid", preview.BodyPreview);
        Assert.Contains(logger.Entries, entry =>
            entry.Level == LogLevel.Warning &&
            entry.Message.Contains("Skipping corrupt message center cache row", StringComparison.Ordinal) &&
            entry.Message.Contains("not-a-number", StringComparison.Ordinal));
    }

    [Fact]
    public void MarkConversationReadAsync_RuntimeUsesExplicitVisibleMonotonicCursor()
    {
        string method = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "UseTranAsync",
            "TransactionSideEffectGuard.CanPublishAfterCommit");
        string transaction = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "LoadReplyParticipantForUpdateAsync",
            "AdvanceParticipantReadThroughAsync",
            "EnqueueMessageDeliveriesAsync");
        string lockSql = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "FOR UPDATE",
            "msg_participant_state");
        string updateSql = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "RETURNING state.unreadcount");

        Assert.Contains("UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadReplyParticipantForUpdateAsync", transaction, StringComparison.Ordinal);
        Assert.Contains("AdvanceParticipantReadThroughAsync", transaction, StringComparison.Ordinal);
        Assert.Contains("EnqueueMessageDeliveriesAsync", transaction, StringComparison.Ordinal);
        Assert.DoesNotContain("PublishReadUpdatedAsync", method, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", lockSql, StringComparison.Ordinal);
        Assert.Contains("message.id > @ReadThroughMessageId", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("message.isinternalnote = false", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("message.senderaccountid = @AccountId", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("RETURNING state.unreadcount", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("MAX(id)", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("TransactionSideEffectGuard.CanPublishAfterCommit", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SqlFunc.Subqueryable", transaction, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<ConversationMessage>", transaction, StringComparison.Ordinal);
        Assert.DoesNotContain("OrderByDescending", transaction, StringComparison.Ordinal);
    }

    [Fact]
    public void AccountAndAdminReplies_ReuseTransactionalClosedConversationWriteBarrier()
    {
        string writeKernel = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "WriteReplyAsync");
        string account = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.ReplyAsAccountAsync));
        string admin = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.ReplyAsAdminAsync));
        string conversationLock = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "FROM msg_conversation",
            "FOR UPDATE");
        string participantLock = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "FROM msg_participant_state",
            "FOR UPDATE");
        string participantUpdate = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "lastreadmessageid = @ReadThroughMessageId",
            "message.isinternalnote = false");

        Assert.Contains("WriteReplyAsync", account, StringComparison.Ordinal);
        Assert.Contains("WriteReplyAsync", admin, StringComparison.Ordinal);
        Assert.Contains("LoadReplyConversationForUpdateAsync", writeKernel, StringComparison.Ordinal);
        Assert.Contains("LoadReplyParticipantForUpdateAsync", writeKernel, StringComparison.Ordinal);
        Assert.Contains("AdvanceParticipantReadThroughAsync", writeKernel, StringComparison.Ordinal);
        Assert.Contains("UseTranAsync", writeKernel, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", conversationLock, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", participantLock, StringComparison.Ordinal);
        Assert.Contains("status = @ExpectedStatus", writeKernel, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("xmin", writeKernel, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("lastreadmessageid = @ReadThroughMessageId", participantUpdate, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("message.isinternalnote = false", participantUpdate, StringComparison.OrdinalIgnoreCase);
        Type replyOutcome = typeof(MessageCenterService).GetNestedType("ReplyWriteStatus", BindingFlags.NonPublic)!;
        Assert.Contains("NotFound", Enum.GetNames(replyOutcome));
        Assert.Contains("Closed", Enum.GetNames(replyOutcome));
        Assert.Contains("Conflict", Enum.GetNames(replyOutcome));
        Assert.Contains("InfraFailure", Enum.GetNames(replyOutcome));
        string outcomeMap = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "MapReplyWriteOutcome");
        Assert.Contains("已读位置不能后退", outcomeMap, StringComparison.Ordinal);
        Assert.Contains("已读位置不属于可见会话消息", outcomeMap, StringComparison.Ordinal);
        Assert.Contains("会话已关闭", outcomeMap, StringComparison.Ordinal);
        Assert.Contains("回复写入失败", outcomeMap, StringComparison.Ordinal);
        Assert.Contains("ReplyDeliveryEvent", RuntimeMetadataInspection.DescribeType(typeof(MessageCenterService)), StringComparison.Ordinal);

        IReadOnlyList<string> writeOrder = RuntimeMetadataInspection.DescribeDeclaredMemberReferencesInOrderContaining(
            typeof(MessageCenterService),
            "LoadReplyConversationForUpdateAsync",
            "Insertable");
        Assert.True(
            FindReference(writeOrder, "LoadReplyConversationForUpdateAsync") <
            FindReference(writeOrder, "Insertable"),
            "The locked conversation recheck must run before inserting either reply kind.");
    }

    [Fact]
    public void UpdateConversationStatusAsync_RuntimeUsesRowVersionAndExpectedStatusGuard()
    {
        PropertyInfo rowVersion = typeof(MessageConversation).GetProperty(nameof(MessageConversation.RowVersion))!;
        Assert.Equal(typeof(string), rowVersion.PropertyType);
        Assert.True(Assert.Single(rowVersion.GetCustomAttributes<SugarColumn>()).IsIgnore);
        string method = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "LoadConversationStatusUpdateStateAsync",
            "TryUpdateConversationStatusAsync");
        string load = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "xmin::text AS row_version");
        string update = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "AND status = @ExpectedStatus",
            "AND xmin::text = @RowVersion");

        Assert.Contains("LoadConversationStatusUpdateStateAsync", method, StringComparison.Ordinal);
        Assert.Contains("TryUpdateConversationStatusAsync", method, StringComparison.Ordinal);
        Assert.Contains("EnqueueMessageDeliveriesAsync", method, StringComparison.Ordinal);
        Assert.Contains(nameof(ConversationStatusEvent), method, StringComparison.Ordinal);
        Assert.Contains("IsAllowedStatusTransition", method, StringComparison.Ordinal);
        Assert.Contains("NoChange", RuntimeMetadataInspection.DescribeType(typeof(MessageCenterService)), StringComparison.Ordinal);
        Assert.Contains("InboxConversationStatusChanged", RuntimeMetadataInspection.DescribeType(typeof(MessageCenterService)), StringComparison.Ordinal);
        Assert.Contains(
            "会话状态已被其他管理员修改",
            RuntimeMetadataInspection.DescribeType(typeof(MessageCenterService)),
            StringComparison.Ordinal);
        Assert.Contains("xmin::text AS row_version", load, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND status = @ExpectedStatus", update, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND xmin::text = @RowVersion", update, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ISugarQueryable.Where", method, StringComparison.Ordinal);
    }

    [Fact]
    public void PublishPreparedParticipantMessageAsync_RuntimeUsesStoredUnreadCount()
    {
        string method = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "PublishMessageAppendAsync",
            "ConversationParticipantState.get_UnreadCount");

        Assert.Contains("PublishMessageAppendAsync", method, StringComparison.Ordinal);
        Assert.Contains("ConversationParticipantState.get_UnreadCount", method, StringComparison.Ordinal);
        Assert.DoesNotContain("op_Addition", method, StringComparison.Ordinal);
    }

    [Fact]
    public void PublishParticipantMessageFanoutAsync_RuntimePreparesPayloadsInBatch()
    {
        string method = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "PrepareParticipantMessageFanoutAsync",
            "Task.WhenAll");

        Assert.Contains("PrepareParticipantMessageFanoutAsync", method, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll", method, StringComparison.Ordinal);
        Assert.DoesNotContain("RefreshUnreadCacheAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildConversationListItemForAccountAsync", method, StringComparison.Ordinal);
        string preparation = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "PrepareParticipantMessageFanoutAsync");
        Assert.Contains("LoadTotalUnreadMapAsync", preparation, StringComparison.Ordinal);
        Assert.Contains("BuildParticipantConversationItemsAsync", preparation, StringComparison.Ordinal);
    }

    [Fact]
    public void MessageCenterRoundTrips_RuntimeAvoidsScopedDbParallelQueriesAndTracksPhases()
    {
        string accountList = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.GetAccountConversationsAsync));
        string adminList = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.GetAdminConversationsAsync));
        string reply = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "LoadReplyConversationForUpdateAsync",
            "AdvanceParticipantReadThroughAsync");
        string lastMessageMap = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "LoadLastMessageMapAsync");
        string mapMessages = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "MapMessagesAsync");

        Assert.Contains("LoadConversationListSnapshotMessageIdAsync", accountList, StringComparison.Ordinal);
        Assert.Contains("CountSnapshotConversationsAsync", accountList, StringComparison.Ordinal);
        Assert.Contains("LoadSnapshotConversationRowsAsync", accountList, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", accountList, StringComparison.Ordinal);
        Assert.Contains("LoadConversationListSnapshotMessageIdAsync", adminList, StringComparison.Ordinal);
        Assert.Contains("CountSnapshotConversationsAsync", adminList, StringComparison.Ordinal);
        Assert.Contains("LoadSnapshotConversationRowsAsync", adminList, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", adminList, StringComparison.Ordinal);

        Assert.Contains("LoadLastMessagesSingleQueryAsync", lastMessageMap, StringComparison.Ordinal);
        Assert.DoesNotContain("SqlFunc.AggregateMax", lastMessageMap, StringComparison.Ordinal);
        Assert.DoesNotContain("Enumerable.Contains", lastMessageMap, StringComparison.Ordinal);

        Assert.Contains("LoadReplyConversationForUpdateAsync", reply, StringComparison.Ordinal);
        Assert.Contains("LoadReplyParticipantForUpdateAsync", reply, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", RuntimeMetadataInspection.DescribeType(typeof(MessageCenterService)), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("List.Sort", mapMessages, StringComparison.Ordinal);

        Assert.Contains("RecordMessageCenterList", accountList, StringComparison.Ordinal);
        Assert.Contains("RecordMessageCenterList", adminList, StringComparison.Ordinal);
        string accountReply = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.ReplyAsAccountAsync));
        Assert.Contains("RecordMessageCenterReply", accountReply, StringComparison.Ordinal);
        string statusMutation = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.UpdateConversationStatusAsync));
        Assert.Contains("RecordMessageCenterStatus", statusMutation, StringComparison.Ordinal);
        string fanout = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "PrepareParticipantMessageFanoutAsync");
        Assert.Contains("RecordMessageCenterFanoutRefresh", fanout, StringComparison.Ordinal);
        Assert.Contains("RecordMessageCenterFanoutBuildItem", fanout, StringComparison.Ordinal);

        var measurements = new HashSet<string>(StringComparer.Ordinal);
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Name.StartsWith("fsus.message.center.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();
        FsusObservability.RecordMessageCenterList("account", TimeSpan.FromMilliseconds(1));
        FsusObservability.RecordMessageCenterReply("account", TimeSpan.FromMilliseconds(1));
        FsusObservability.RecordMessageCenterStatus("open", "pending", "succeeded");
        FsusObservability.RecordMessageCenterFanoutRefresh(TimeSpan.FromMilliseconds(1));
        FsusObservability.RecordMessageCenterFanoutBuildItem(TimeSpan.FromMilliseconds(1));

        Assert.Contains("fsus.message.center.list.elapsed", measurements);
        Assert.Contains("fsus.message.center.reply.elapsed", measurements);
        Assert.Contains("fsus.message.center.status.count", measurements);
        Assert.Contains("fsus.message.center.fanout.refresh.elapsed", measurements);
        Assert.Contains("fsus.message.center.fanout.build_item.elapsed", measurements);
    }

    [Fact]
    public void RefreshUnreadCacheAsync_RuntimeUsesVersionedCacheRefresh()
    {
        string refreshMethod = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "RefreshUnreadCacheAsync");
        string loadMethod = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "LoadTotalUnreadAsync");

        Assert.Contains("MessageCacheService.RefreshUnreadAsync", refreshMethod, StringComparison.Ordinal);
        Assert.Contains("LoadTotalUnreadAsync", refreshMethod, StringComparison.Ordinal);
        Assert.Contains("SumAsync", loadMethod, StringComparison.Ordinal);
        Assert.Contains("ConversationParticipantState.get_UnreadCount", loadMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("MessageCacheService.SetUnreadAsync", refreshMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("MessageCacheService.SetUnreadAsync", loadMethod, StringComparison.Ordinal);
    }

    // ── Private static helpers via reflection ──────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(MessageCenterService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }

    private static string[] PropertyNames<T>()
        => typeof(T).GetProperties().Select(static property => property.Name).ToArray();

    private static int FindReference(IReadOnlyList<string> references, string fact)
    {
        int index = references.ToList().FindIndex(reference => reference.Contains(fact, StringComparison.Ordinal));
        Assert.True(index >= 0, $"Missing runtime reference '{fact}'.");
        return index;
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = [];

        public IDisposable BeginScope<TState>(TState state)
            where TState : notnull
            => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel)
            => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Entries.Add((logLevel, formatter(state, exception)));

        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();

            public void Dispose()
            {
            }
        }
    }

    [Theory]
    [InlineData(null, "")]
    [InlineData("   ", "")]
    [InlineData("hello", "hello")]
    [InlineData("  trimmed  ", "trimmed")]
    public void NormalizeBody_ReturnsExpected(string? input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeBody", [input]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void NormalizeBody_TruncatesAt4000()
    {
        string longBody = new string('a', 5000);
        var result = InvokePrivateStatic<string>("NormalizeBody", [longBody]);
        Assert.Equal(4000, result.Length);
    }

    [Theory]
    [InlineData(null, "fallback", "fallback")]
    [InlineData("   ", "fb", "fb")]
    [InlineData("subject", "fb", "subject")]
    public void NormalizeSubject_ReturnsExpected(string? input, string fallback, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeSubject", [input, fallback]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void NormalizeSubject_TruncatesAt160()
    {
        string longSubject = new string('x', 200);
        var result = InvokePrivateStatic<string>("NormalizeSubject", [longSubject, "fb"]);
        Assert.Equal(160, result.Length);
    }

    [Theory]
    [InlineData(ConversationStatus.Pending, ConversationStatusValue.Pending)]
    [InlineData(ConversationStatus.Closed, ConversationStatusValue.Closed)]
    [InlineData(ConversationStatus.Open, ConversationStatusValue.Open)]
    public void ToStatusValue_ReturnsExpected(ConversationStatus input, ConversationStatusValue expected)
    {
        var result = InvokePrivateStatic<ConversationStatusValue>("ToStatusValue", [(object)input]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(ConversationStatusValue.Pending, ConversationStatus.Pending)]
    [InlineData(ConversationStatusValue.Closed, ConversationStatus.Closed)]
    [InlineData(ConversationStatusValue.Open, ConversationStatus.Open)]
    public void ToStatusEntity_ReturnsExpected(ConversationStatusValue input, ConversationStatus expected)
    {
        var result = InvokePrivateStatic<ConversationStatus>("ToStatusEntity", [(object)input]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(MessageSenderType.Account, ConversationSenderValue.Account)]
    [InlineData(MessageSenderType.Admin, ConversationSenderValue.Admin)]
    [InlineData(MessageSenderType.System, ConversationSenderValue.System)]
    public void ToSenderValue_ReturnsExpected(MessageSenderType input, ConversationSenderValue expected)
    {
        var result = InvokePrivateStatic<ConversationSenderValue>("ToSenderValue", [(object)input]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void ResolveSenderName_SystemSender_Returns系统()
    {
        var row = new ConversationMessage { SenderType = MessageSenderType.System };
        var result = InvokePrivateStatic<string>("ResolveSenderName", [row]);
        Assert.Equal("系统", result);
    }

    [Fact]
    public void ResolveSenderName_AccountSender_Returns你()
    {
        var row = new ConversationMessage { SenderType = MessageSenderType.Account, SenderAccountId = 5 };
        var result = InvokePrivateStatic<string>("ResolveSenderName", [row]);
        Assert.Equal("你", result);
    }

    [Fact]
    public void ResolveSenderName_AdminWithoutDict_Returns管理员()
    {
        var row = new ConversationMessage { SenderType = MessageSenderType.Admin, SenderAdminPrincipalId = 7 };
        var result = InvokePrivateStatic<string>("ResolveSenderName", [row]);
        Assert.Equal("管理员", result);
    }

    [Fact]
    public void ResolveSenderName_AccountWithoutAccount_Returns你()
    {
        var row = new ConversationMessage { SenderType = MessageSenderType.Account, SenderAccountId = null };
        var result = InvokePrivateStatic<string>("ResolveSenderName", [row]);
        Assert.Equal("你", result);
    }

    [Fact]
    public void AdminConversationProjection_IsSeparateMinimalAndViewerAware()
    {
        Assert.Null(typeof(ConversationListItemResponse).GetProperty("CounterpartyAccountId"));
        Assert.Null(typeof(ConversationDetailResponse).GetProperty("CounterpartyAccountId"));
        Assert.NotNull(typeof(AdminConversationListItemResponse).GetProperty("CounterpartyAccountId"));
        Assert.NotNull(typeof(AdminConversationDetailResponse).GetProperty("CounterpartyAccountId"));
        Assert.DoesNotContain(
            typeof(AdminConversationListItemResponse).GetProperties(),
            property => property.Name.Contains("Session", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(
            typeof(AdminConversationDetailResponse).GetProperties(),
            property => property.Name.Contains("Session", StringComparison.OrdinalIgnoreCase));

        string viewerResolver = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "ResolveSenderNameForViewer");
        Assert.Contains("账号 #", viewerResolver, StringComparison.Ordinal);
        Assert.Contains("管理员", viewerResolver, StringComparison.Ordinal);
        Assert.Contains("你", viewerResolver, StringComparison.Ordinal);
    }
}
