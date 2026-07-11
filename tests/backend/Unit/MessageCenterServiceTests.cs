using System.Reflection;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.NotificationStream;
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

using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class MessageCenterServiceTests
{
    private static MessageCenterService BuildService()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var cache = new MessageCacheService(Substitute.For<IUnifiedCache>());
        return new MessageCenterService(
            db,
            cache,
            Substitute.For<IMessageNotificationStreamPort>(),
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
        var result = await svc.ReplyAsAccountAsync(1, 999L, "   ");
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
        Assert.Contains(nameof(MessageConversation.InitiatorAccountId), conversation);
        Assert.Contains(nameof(MessageConversation.CreatedByAccountId), conversation);
        Assert.Contains(nameof(MessageConversation.CreatedByAdminPrincipalId), conversation);
        Assert.Contains(nameof(MessageConversation.CreatedByAdminSessionId), conversation);
        Assert.Contains(nameof(ConversationMessage.SenderAccountId), message);
        Assert.Contains(nameof(ConversationMessage.SenderAdminPrincipalId), message);
        Assert.Contains(nameof(ConversationMessage.SenderAdminSessionId), message);
        Assert.Contains(nameof(ConversationParticipantState.AccountId), participant);
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
        string ports = string.Join('\n', queryPorts.Concat(commandPorts).Concat(realtimePorts));
        Assert.DoesNotContain("adminUserId", ports, StringComparison.Ordinal);
        Assert.Contains(nameof(AdminMessageActor), RuntimeMetadataInspection.DescribeType(typeof(AdminMessageActor)), StringComparison.Ordinal);
        Assert.Contains("GetAccountConversationsAsync", ports, StringComparison.Ordinal);
        Assert.Contains("CreateAccountTicketAsync", ports, StringComparison.Ordinal);
        Assert.Contains("ReplyAsAccountAsync", ports, StringComparison.Ordinal);
        Assert.Contains("SendAccountTransactionalNoticeAsync", ports, StringComparison.Ordinal);
        Assert.Contains("PushAccountStatusAsync", ports, StringComparison.Ordinal);
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
    public async Task MessageEndpoints_OrdinaryAccountRoutesRequireAnonymousAccountPrincipal()
    {
        await using WebApplication app = EndpointContractApplication.Create();
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
                .OfType<ClaimsAuthorizationRequirement>()
                .Where(static requirement => requirement.ClaimType == "identity_kind"));
            Assert.Contains(AnonymousIdentityRuntime.AnonymousAccountKind, identity.AllowedValues ?? []);
        }

        RouteEndpoint admin = EndpointContractApplication.Find(
            app,
            "/api/binary/admin/messages/conversations/{id:long}/reply",
            HttpMethods.Post);
        ClaimsAuthorizationRequirement permission = Assert.Single(admin.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>()
            .Where(static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType));
        Assert.Contains(AdminPermissions.AdminManage, permission.AllowedValues ?? []);
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
    public void MarkConversationReadAsync_RuntimeUsesAtomicLastMessageUpdate()
    {
        string method = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "UseTranAsync",
            "TransactionSideEffectGuard.CanPublishAfterCommit",
            "PublishReadUpdatedAsync");
        string transaction = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "LockConversationParticipantReadStateAsync",
            "MarkConversationReadAndReturnLastMessageIdAsync");
        string lockSql = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "FOR UPDATE",
            "msg_participant_state");
        string updateSql = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "RETURNING state.lastreadmessageid");

        Assert.Contains("UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("LockConversationParticipantReadStateAsync", transaction, StringComparison.Ordinal);
        Assert.Contains("MarkConversationReadAndReturnLastMessageIdAsync", transaction, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", lockSql, StringComparison.Ordinal);
        Assert.Contains("RETURNING state.lastreadmessageid", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("TransactionSideEffectGuard.CanPublishAfterCommit", method, StringComparison.Ordinal);
        Assert.Contains("PublishReadUpdatedAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SqlFunc.Subqueryable", transaction, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<ConversationMessage>", transaction, StringComparison.Ordinal);
        Assert.DoesNotContain("OrderByDescending", transaction, StringComparison.Ordinal);
    }

    [Fact]
    public void ReplyAsAccountAsync_RuntimeUsesTransactionalClosedConversationWriteBarrier()
    {
        string method = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "LoadReplyLocksForUpdateAsync",
            "TryMarkReplyParticipantReadAsync");
        string combinedLock = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(MessageCenterService),
            "WITH locked_conversation AS",
            "locked_participant AS");
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
            "lastreadmessageid IS NULL",
            "lastreadmessageid = @PreviousLastReadMessageId");

        Assert.Contains("LoadReplyLocksForUpdateAsync", method, StringComparison.Ordinal);
        Assert.Contains("TryMarkReplyParticipantReadAsync", method, StringComparison.Ordinal);
        Assert.Contains("locked_conversation AS", combinedLock, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("locked_participant AS", combinedLock, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("FOR UPDATE", conversationLock, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", participantLock, StringComparison.Ordinal);
        Assert.Contains("status <> @ClosedStatus", RuntimeMetadataInspection.DescribeType(typeof(MessageCenterService)), StringComparison.OrdinalIgnoreCase);
        Assert.Contains("lastreadmessageid IS NULL", participantUpdate, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("lastreadmessageid = @PreviousLastReadMessageId", participantUpdate, StringComparison.OrdinalIgnoreCase);
        Type writeOutcome = typeof(MessageCenterService).GetNestedType("ReplyAccountWriteOutcome", BindingFlags.NonPublic)!;
        Assert.Contains("Forbidden", Enum.GetNames(writeOutcome));
        Assert.Contains("Closed", Enum.GetNames(writeOutcome));
        MethodInfo outcomeMap = typeof(MessageCenterService).GetMethod(
            "MapReplyAccountWriteOutcome",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        object closed = Enum.Parse(writeOutcome, "Closed");
        Result<ConversationMessageResponse> closedResult = (Result<ConversationMessageResponse>)outcomeMap.Invoke(null, [closed])!;
        Assert.Equal(ErrorCode.Conflict, closedResult.Error.Code);

        IReadOnlyList<string> writeOrder = RuntimeMetadataInspection.DescribeDeclaredMemberReferencesInOrderContaining(
            typeof(MessageCenterService),
            "LoadReplyLocksForUpdateAsync",
            "Insertable");
        Assert.True(
            FindReference(writeOrder, "LoadReplyLocksForUpdateAsync") <
            FindReference(writeOrder, "Insertable"),
            "The locked conversation recheck must run before inserting the account reply.");
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
        Assert.Contains("会话状态已被其他管理员修改", method, StringComparison.Ordinal);
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
            "LoadReplyLocksForUpdateAsync",
            "TryMarkReplyParticipantReadAsync");
        string lastMessageMap = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "LoadLastMessageMapAsync");
        string mapMessages = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            "MapMessagesAsync");

        Assert.Contains("BuildAccountConversationQuery", accountList, StringComparison.Ordinal);
        Assert.Contains("CountAsync", accountList, StringComparison.Ordinal);
        Assert.Contains("ToListAsync", accountList, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", accountList, StringComparison.Ordinal);
        Assert.Contains("BuildAdminConversationQuery", adminList, StringComparison.Ordinal);
        Assert.Contains("CountAsync", adminList, StringComparison.Ordinal);
        Assert.Contains("ToListAsync", adminList, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", adminList, StringComparison.Ordinal);

        Assert.Contains("LoadLastMessagesSingleQueryAsync", lastMessageMap, StringComparison.Ordinal);
        Assert.DoesNotContain("SqlFunc.AggregateMax", lastMessageMap, StringComparison.Ordinal);
        Assert.DoesNotContain("Enumerable.Contains", lastMessageMap, StringComparison.Ordinal);

        Assert.Contains("LoadReplyLocksForUpdateAsync", reply, StringComparison.Ordinal);
        Assert.Contains("WITH locked_conversation AS", RuntimeMetadataInspection.DescribeType(typeof(MessageCenterService)), StringComparison.OrdinalIgnoreCase);
        Assert.Contains("locked_participant AS", RuntimeMetadataInspection.DescribeType(typeof(MessageCenterService)), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("List.Sort", mapMessages, StringComparison.Ordinal);

        string observability = RuntimeMetadataInspection.DescribeType(typeof(FsusObservability));
        Assert.Contains("fsus.message.center.list.elapsed", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.message.center.reply.elapsed", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.message.center.fanout.refresh.elapsed", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.message.center.fanout.build_item.elapsed", observability, StringComparison.Ordinal);
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
}
