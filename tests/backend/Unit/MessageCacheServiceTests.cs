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
        var sut = new MessageCacheService(cache, cache, cache);

        await sut.IncrementUnreadAsync(42);

        await cache.Received(1).IncrementAsync(CachePolicyId.MessageUnread, "account:42", 1, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetUnreadAsync_UsesAccountIdentityPrefix()
    {
        var cache = Substitute.For<IUnifiedCache>();
        var sut = new MessageCacheService(cache, cache, cache);

        await sut.SetUnreadAsync(42, 9);

        await cache.Received(1).SetStringAsync(CachePolicyId.MessageUnread, "account:42", "9", null, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task RefreshUnreadAsync_RetriesWhenVersionCompareAndSetFails()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(CachePolicyId.MessageUnread, "account:42:refresh-version", 1, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(1L), Task.FromResult(2L));
        cache.TrySetStringIfValueAsync(CachePolicyId.MessageUnread, "account:42", "5", "account:42:refresh-version", "1", null, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(false));
        cache.TrySetStringIfValueAsync(CachePolicyId.MessageUnread, "account:42", "7", "account:42:refresh-version", "2", null, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(true));
        int loads = 0;
        var sut = new MessageCacheService(cache, cache, cache);

        int result = await sut.RefreshUnreadAsync(42, () =>
        {
            loads += 1;
            return Task.FromResult(loads == 1 ? 5 : 7);
        });

        Assert.Equal(7, result);
        Assert.Equal(2, loads);
        await cache.Received(2).IncrementAsync(CachePolicyId.MessageUnread, "account:42:refresh-version", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).TrySetStringIfValueAsync(CachePolicyId.MessageUnread, "account:42", "5", "account:42:refresh-version", "1", null, Arg.Any<CancellationToken>());
        await cache.Received(1).TrySetStringIfValueAsync(CachePolicyId.MessageUnread, "account:42", "7", "account:42:refresh-version", "2", null, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetOrLoadUserCommentsAsync_UsesVersionedAccountCommentIdentityPrefix()
    {
        var cache = Substitute.For<IUnifiedCache>();
        const string Identity = "account:7:v:UserCommentCursorVersion:0:0:comments:123:20";
        cache.AcquireSingleFlightAsync(CachePolicyId.UserCommentCursor, Identity, Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<IAsyncDisposable>(NullAsyncDisposable.Instance));
        var sut = new CommentCoreQueryCache(cache, cache, cache, cache);

        await sut.GetOrLoadUserCommentsAsync(
            7,
            123,
            20,
            static () => Task.FromResult(new CoreCursorResult<UserCommentCoreModel>([], null, false)));

        await cache.Received(1).SetRawAsync(
            CachePolicyId.UserCommentCursor,
            Identity,
            Arg.Any<byte[]>(),
            TimeSpan.FromMinutes(5),
            Arg.Any<CancellationToken>());
        await cache.Received(1).GetStringAsync(CachePolicyId.UserCommentCursorVersion, "global", Arg.Any<CancellationToken>());
        await cache.Received(1).GetStringAsync(CachePolicyId.UserCommentCursorVersion, "account:7", Arg.Any<CancellationToken>());
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
