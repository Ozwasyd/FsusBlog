using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure.Sse;

namespace FsusBlog.Server.Tests;

public sealed class SseConnectionManagerTests
{
    [Fact]
    public void TryRemoveBucketIfCurrent_DoesNotRemoveReplacedBucket()
    {
        const string key = "user:42";
        var oldBucket = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        var newBucket = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        newBucket.TryAdd("conn-new", 0);

        var index = new ConcurrentDictionary<string, ConcurrentDictionary<string, byte>>(StringComparer.Ordinal);
        index[key] = oldBucket;
        index[key] = newBucket;

        bool removed = SseConnectionManager.TryRemoveBucketIfCurrent(index, key, oldBucket);

        Assert.False(removed);
        Assert.True(index.TryGetValue(key, out ConcurrentDictionary<string, byte>? currentBucket));
        Assert.Same(newBucket, currentBucket);
    }
}
