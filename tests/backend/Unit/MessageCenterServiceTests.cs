using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;
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
        string entity = ReadSource("src/backend/Entities/Message.cs");
        string service = ReadSource("src/backend/Services/NotificationStream/MessageCenterService.cs");
        string ports = ReadSource("src/backend/Interfaces/IMessageService.cs");
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Messages.cs");
        string migration = ReadSource("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");

        Assert.Contains("InitiatorAccountId", entity, StringComparison.Ordinal);
        Assert.Contains("CreatedByAccountId", entity, StringComparison.Ordinal);
        Assert.Contains("CreatedByAdminPrincipalId", entity, StringComparison.Ordinal);
        Assert.Contains("CreatedByAdminSessionId", entity, StringComparison.Ordinal);
        Assert.Contains("SenderAccountId", entity, StringComparison.Ordinal);
        Assert.Contains("SenderAdminPrincipalId", entity, StringComparison.Ordinal);
        Assert.Contains("SenderAdminSessionId", entity, StringComparison.Ordinal);
        Assert.Contains("public int AccountId", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("InitiatorUserId", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("CreatedById", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("SenderId", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("public int UserId", entity, StringComparison.Ordinal);

        Assert.DoesNotContain("Queryable<User>", service, StringComparison.Ordinal);
        Assert.DoesNotContain(".Username", service, StringComparison.Ordinal);
        Assert.DoesNotContain("adminUserId", service, StringComparison.Ordinal);
        Assert.Contains("AdminMessageActor", service, StringComparison.Ordinal);
        Assert.Contains("SenderAdminPrincipalId", service, StringComparison.Ordinal);
        Assert.Contains("SenderAdminSessionId", service, StringComparison.Ordinal);
        Assert.Contains("MessageSenderType.Account", service, StringComparison.Ordinal);
        Assert.Contains("GetAccountConversationsAsync", service, StringComparison.Ordinal);
        Assert.Contains("CreateAccountTicketAsync", service, StringComparison.Ordinal);
        Assert.Contains("ReplyAsAccountAsync", service, StringComparison.Ordinal);
        Assert.Contains("SendAccountTransactionalNoticeAsync", service, StringComparison.Ordinal);
        Assert.Contains("PushAccountStatusAsync", service, StringComparison.Ordinal);
        Assert.Contains("NotificationStreamEventType.AccountStatusChanged", service, StringComparison.Ordinal);
        Assert.Contains("AccountStatusPayload", service, StringComparison.Ordinal);
        Assert.DoesNotContain("MessageSenderType.User", service, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserConversationsAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserConversationDetailAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateUserTicketAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("ReplyAsUserAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("SendUserTransactionalNoticeAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("PushUserStatusAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("NotificationStreamEventType.UserStatusChanged", service, StringComparison.Ordinal);
        Assert.DoesNotContain("UserStatusPayload", service, StringComparison.Ordinal);
        Assert.DoesNotContain("UserConversationRow", service, StringComparison.Ordinal);

        Assert.DoesNotContain("adminUserId", ports, StringComparison.Ordinal);
        Assert.Contains("AdminMessageActor", ports, StringComparison.Ordinal);
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

        Assert.Contains("TryResolveAdminSessionContext", endpoints, StringComparison.Ordinal);
        Assert.Contains("AccountPrincipalContext", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("CurrentUser", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("ResolveCurrentAccountId", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("checked((int)user.Id)", endpoints, StringComparison.Ordinal);
        Assert.Contains("GetAccountConversationsAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("CreateAccountTicketAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("ReplyAsAccountAsync", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserConversationsAsync", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateUserTicketAsync", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("ReplyAsUserAsync", endpoints, StringComparison.Ordinal);

        string outputs = ReadSource("src/shared/Contracts/Outputs/ServerResponseContracts.cs");
        string codec = ReadSource("src/core/Cache/PodBinaryCodec.Message.cs");
        Assert.Contains("Account = 0", outputs, StringComparison.Ordinal);
        Assert.DoesNotContain("ConversationSenderValue.User", outputs, StringComparison.Ordinal);
        Assert.Contains("0 => ConversationSenderValue.Account", codec, StringComparison.Ordinal);
        Assert.DoesNotContain("ConversationSenderValue.User", codec, StringComparison.Ordinal);

        Assert.Contains("msg_conversation", migration, StringComparison.Ordinal);
        Assert.Contains("initiatoraccountid", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("senderadminprincipalid", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("accountid", migration, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void MessageEndpoints_OrdinaryAccountRoutesRequireAnonymousAccountPrincipal()
    {
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Messages.cs");
        string[] ordinaryRoutes =
        [
            "group.MapGet(\"/messages/conversations\"",
            "group.MapGet(\"/messages/conversations/{id:long}\"",
            "group.MapPost(\"/messages/conversations\"",
            "group.MapPost(\"/messages/conversations/{id:long}/reply\"",
            "group.MapPost(\"/messages/conversations/{id:long}/read\""
        ];

        foreach (string route in ordinaryRoutes)
        {
            string block = ExtractRouteBlock(endpoints, route);
            Assert.Contains(".RequireAnonymousAccountPrincipal()", block, StringComparison.Ordinal);
            Assert.DoesNotContain(".RequireAuthorization()", block, StringComparison.Ordinal);
        }

        Assert.Contains("AdminMessageActor", endpoints, StringComparison.Ordinal);
        Assert.Contains(".RequireAdminPermission(AdminPermissions.AdminManage)", endpoints, StringComparison.Ordinal);
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
    public void MarkConversationReadAsync_SourceUsesAtomicLastMessageUpdate()
    {
        string source = ReadSource("src/backend/Services/NotificationStream/MessageCenterService.cs");
        string method = ExtractMethod(
            source,
            "public async Task<Result> MarkConversationReadAsync",
            "public async Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync");

        Assert.Contains("LastReadMessageId = SqlFunc.Subqueryable<ConversationMessage>()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("long? lastMessageId = await db.Queryable<ConversationMessage>()", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".OrderByDescending(it => it.Id)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ReplyAsAccountAsync_SourceUsesTransactionalClosedConversationWriteBarrier()
    {
        string source = ReadSource("src/backend/Services/NotificationStream/MessageCenterService.cs");
        string method = ExtractMethod(
            source,
            "public async Task<Result<ConversationMessageResponse>> ReplyAsAccountAsync",
            "public async Task<Result> MarkConversationReadAsync");
        string conversationLock = ExtractMethod(
            source,
            "private async Task<ReplyConversationLock?> LoadReplyConversationForUpdateAsync",
            "private async Task<ReplyParticipantLock?> LoadReplyParticipantForUpdateAsync");
        string participantLock = ExtractMethod(
            source,
            "private async Task<ReplyParticipantLock?> LoadReplyParticipantForUpdateAsync",
            "private async Task<bool> TryUpdateReplyConversationActivityAsync");
        string participantUpdate = ExtractMethod(
            source,
            "private async Task<bool> TryMarkReplyParticipantReadAsync",
            "private static Result<ConversationMessageResponse> MapReplyAccountWriteOutcome");

        Assert.Contains("LoadReplyConversationForUpdateAsync(conversationId)", method, StringComparison.Ordinal);
        Assert.Contains("LoadReplyParticipantForUpdateAsync(conversationId, accountId)", method, StringComparison.Ordinal);
        Assert.Contains("TryMarkReplyParticipantReadAsync(participant", method, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", conversationLock, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", participantLock, StringComparison.Ordinal);
        Assert.Contains("status <> @ClosedStatus", source, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("lastreadmessageid IS NULL", participantUpdate, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("lastreadmessageid = @PreviousLastReadMessageId", participantUpdate, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ReplyAccountWriteOutcome.Forbidden", method, StringComparison.Ordinal);
        Assert.Contains("ReplyAccountWriteOutcome.Closed", method, StringComparison.Ordinal);
        Assert.Contains("ErrorCode.Conflict", method, StringComparison.Ordinal);
        Assert.True(
            method.IndexOf("LoadReplyConversationForUpdateAsync", StringComparison.Ordinal) < method.IndexOf("db.Insertable(new ConversationMessage", StringComparison.Ordinal),
            "The locked conversation recheck must run before inserting the account reply.");
    }

    [Fact]
    public void PublishPreparedParticipantMessageAsync_SourceUsesStoredUnreadCount()
    {
        string source = ReadSource("src/backend/Services/NotificationStream/MessageCenterService.cs");
        string method = ExtractMethod(
            source,
            "private async Task PublishPreparedParticipantMessageAsync",
            "private async Task PublishAccountConversationUpsertThenMessageAppendAsync");

        Assert.Contains("PublishMessageAppendAsync(conversationId.ToString(), message, participant.UnreadCount, totalUnread, participant.AccountId)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("participant.UnreadCount + 1", method, StringComparison.Ordinal);
    }

    // ── Private static helpers via reflection ──────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(MessageCenterService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }

    private static string ExtractMethod(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return source[start..end];
    }

    private static string ExtractRouteBlock(string source, string routeSignature)
    {
        int start = source.IndexOf(routeSignature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing route marker: {routeSignature}");
        int next = source.IndexOf("\n        group.Map", start + routeSignature.Length, StringComparison.Ordinal);
        if (next < 0)
        {
            next = source.IndexOf("\n    }\n\n    private", start + routeSignature.Length, StringComparison.Ordinal);
        }

        Assert.True(next > start, $"Missing route end: {routeSignature}");
        return source[start..next];
    }

    private static string ReadSource(string relativePath)
        => BackendTestPaths.ReadAllTextFromRoot(relativePath);

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
