using System.Net;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class CrawlerDetectorServiceTests
{
    [Fact]
    public void IpRadixTree_UsesFlatIntervalsForIpv4Ipv6AndMappedIpv4()
    {
        var tree = new IpRadixTree();
        tree.Add(IPAddress.Parse("66.249.64.0"), 19);
        tree.Add(IPAddress.Parse("2001:4860::"), 32);
        tree.Seal();

        Assert.True(tree.Contains(IPAddress.Parse("66.249.64.1")));
        Assert.True(tree.Contains(IPAddress.Parse("::ffff:66.249.64.1")));
        Assert.False(tree.Contains(IPAddress.Parse("66.250.64.1")));
        Assert.True(tree.Contains(IPAddress.Parse("2001:4860:abcd::1")));
        Assert.False(tree.Contains(IPAddress.Parse("2001:4861::1")));
    }

    [Fact]
    public async Task VerifyByReverseDnsAsync_WhenSemaphoreWaitTimesOut_ReturnsFalse()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new CrawlerDetectorService(NullLogger<CrawlerDetectorService>.Instance, cache);
        var semaphore = (SemaphoreSlim)(typeof(CrawlerDetectorService)
            .GetField("_dnsSemaphore", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            ?.GetValue(service) ?? throw new InvalidOperationException("dns semaphore not found"));

        for (int i = 0; i < 50; i++)
        {
            await semaphore.WaitAsync();
        }

        try
        {
            bool result = await service.VerifyByReverseDnsAsync(IPAddress.Loopback, IPAddress.Loopback.ToString(), TimeSpan.FromMilliseconds(1));
            Assert.False(result);
        }
        finally
        {
            for (int i = 0; i < 50; i++)
            {
                semaphore.Release();
            }
        }
    }
}
