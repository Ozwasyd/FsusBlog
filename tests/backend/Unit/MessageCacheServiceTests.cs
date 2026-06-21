using System.Reflection;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.CoreBridge.Caching;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Services.NotificationStream;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MessageCacheServiceTests
{
    [Fact]
    public async Task IncrementUnreadAsync_UsesAccountIdentityPrefix()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var sut = new MessageCacheService(cache);

        await sut.IncrementUnreadAsync(42);

        await cache.Received(1).IncrementAsync(CachePolicyId.MessageUnread, "account:42", 1, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetUnreadAsync_UsesAccountIdentityPrefix()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var sut = new MessageCacheService(cache);

        await sut.SetUnreadAsync(42, 9);

        await cache.Received(1).SetStringAsync(CachePolicyId.MessageUnread, "account:42", "9", null, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetOrLoadUserCommentsAsync_UsesAccountCommentIdentityPrefix()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.AcquireSingleFlightAsync(CachePolicyId.UserCommentCursor, "account:7:comments:123:20", Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<IAsyncDisposable>(NullAsyncDisposable.Instance));
        var sut = new CommentCoreQueryCache(cache);

        await sut.GetOrLoadUserCommentsAsync(
            7,
            123,
            20,
            static () => Task.FromResult(new CoreCursorResult<UserCommentCoreModel>([], null, false)));

        await cache.Received(1).SetRawAsync(
            CachePolicyId.UserCommentCursor,
            "account:7:comments:123:20",
            Arg.Any<byte[]>(),
            TimeSpan.FromMinutes(5),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public void AccountScopedTypes_ExposeAccountIdVocabulary()
    {
        Assert.Equal(
            "AccountId",
            typeof(NotificationStreamUserTarget).GetProperties().Single(property => property.PropertyType == typeof(string)).Name);
        Assert.Contains(
            typeof(CommentCacheInvalidationScope).GetProperties(),
            property => property.Name == "AccountId" && property.PropertyType == typeof(int?));

        ParameterInfo parameter = typeof(IMessageNotificationStreamPort)
            .GetMethod(nameof(IMessageNotificationStreamPort.PublishToUserAsync))!
            .GetParameters()[1];
        Assert.Equal("accountId", parameter.Name);
    }

    private sealed class NullAsyncDisposable : IAsyncDisposable
    {
        public static NullAsyncDisposable Instance { get; } = new();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
