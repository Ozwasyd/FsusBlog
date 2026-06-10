using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

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
    public async Task CreateUserTicketAsync_EmptyBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.CreateUserTicketAsync(1, "subject", "   ");
        Assert.False(result.IsSuccess);
    }

    [Fact]
    public async Task CreateUserTicketAsync_NullBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.CreateUserTicketAsync(1, "subject", null!);
        Assert.False(result.IsSuccess);
    }

    [Fact]
    public async Task ReplyAsUserAsync_EmptyBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.ReplyAsUserAsync(1, 999L, "   ");
        Assert.False(result.IsSuccess);
    }

    [Fact]
    public async Task ReplyAsAdminAsync_EmptyBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.ReplyAsAdminAsync(999L, "   ", 1);
        Assert.False(result.IsSuccess);
    }

    [Fact]
    public async Task SendSystemMessageAsync_EmptyBody_ReturnsFail()
    {
        var svc = BuildService();
        var result = await svc.SendSystemMessageAsync("subject", "   ", null, 1);
        Assert.False(result.IsSuccess);
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

    // ── Private static helpers via reflection ──────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(MessageCenterService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
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
    [InlineData(MessageSenderType.User, ConversationSenderValue.User)]
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
        var dict = new Dictionary<int, string>();
        var result = InvokePrivateStatic<string>("ResolveSenderName", [row, (IReadOnlyDictionary<int, string>)dict]);
        Assert.Equal("系统", result);
    }

    [Fact]
    public void ResolveSenderName_UserWithNameInDict_ReturnsName()
    {
        var row = new ConversationMessage { SenderType = MessageSenderType.User, SenderId = 5 };
        var dict = new Dictionary<int, string> { [5] = "Alice" };
        var result = InvokePrivateStatic<string>("ResolveSenderName", [row, (IReadOnlyDictionary<int, string>)dict]);
        Assert.Equal("Alice", result);
    }

    [Fact]
    public void ResolveSenderName_AdminWithoutDict_Returns管理员()
    {
        var row = new ConversationMessage { SenderType = MessageSenderType.Admin, SenderId = null };
        var dict = new Dictionary<int, string>();
        var result = InvokePrivateStatic<string>("ResolveSenderName", [row, (IReadOnlyDictionary<int, string>)dict]);
        Assert.Equal("管理员", result);
    }

    [Fact]
    public void ResolveSenderName_UserWithoutDict_Returns用户()
    {
        var row = new ConversationMessage { SenderType = MessageSenderType.User, SenderId = null };
        var dict = new Dictionary<int, string>();
        var result = InvokePrivateStatic<string>("ResolveSenderName", [row, (IReadOnlyDictionary<int, string>)dict]);
        Assert.Equal("用户", result);
    }
}
