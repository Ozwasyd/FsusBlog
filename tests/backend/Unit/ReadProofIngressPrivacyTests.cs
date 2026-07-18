using System.Net;

using FsusBlog.Server.Infrastructure.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests;

public sealed class ReadProofIngressPrivacyTests
{
    private static readonly DateTimeOffset s_start = DateTimeOffset.Parse("2026-07-15T10:00:00Z");

    [Fact]
    public void CreatePartition_NormalizesIpv4MappedIpv6WithoutRetainingRawAddress()
    {
        using var partitioner = CreatePartitioner(out _);
        DefaultHttpContext ipv4 = CreateContext("192.0.2.41");
        DefaultHttpContext mapped = CreateContext("::ffff:192.0.2.41");

        string first = partitioner.CreatePartition(ipv4);
        string second = partitioner.CreatePartition(mapped);

        Assert.Equal(first, second);
        Assert.Equal(32, first.Length);
        Assert.DoesNotContain("192.0.2.41", first, StringComparison.Ordinal);
    }

    [Fact]
    public void CreatePartition_AcceptsIpv6AndRotatesAtTheShortEpochBoundary()
    {
        using var partitioner = CreatePartitioner(out MutableTimeProvider time);
        DefaultHttpContext context = CreateContext("2001:db8::41");

        string first = partitioner.CreatePartition(context);
        time.Advance(ReadProofRateLimitPartitioner.PartitionEpochDuration);
        string second = partitioner.CreatePartition(context);

        Assert.NotEqual(first, second);
        Assert.DoesNotContain("2001:db8", first, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("2001:db8", second, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CreatePartition_IgnoresProxyChainsAndMalformedForwardingHeaders()
    {
        using var partitioner = CreatePartitioner(out _);
        DefaultHttpContext proxyChain = CreateContext("198.51.100.22");
        proxyChain.Request.Headers["X-Forwarded-For"] = "203.0.113.10, 10.0.0.4";
        proxyChain.Request.Headers["X-Real-IP"] = "203.0.113.11";
        DefaultHttpContext malformed = CreateContext("198.51.100.22");
        malformed.Request.Headers["X-Forwarded-For"] = "not-an-address, []";
        malformed.Request.Headers["X-Real-IP"] = "also-invalid";

        string first = partitioner.CreatePartition(proxyChain);
        string second = partitioner.CreatePartition(malformed);

        Assert.Equal(first, second);
        Assert.DoesNotContain("203.0.113", first, StringComparison.Ordinal);
        Assert.DoesNotContain("not-an-address", first, StringComparison.Ordinal);
    }

    private static ReadProofRateLimitPartitioner CreatePartitioner(out MutableTimeProvider time)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["HumanReadProof:Dedup:CurrentKeyEpoch"] = "7",
                ["HumanReadProof:Dedup:CurrentKey"] = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8="
            })
            .Build();
        time = new MutableTimeProvider(s_start);
        return new ReadProofRateLimitPartitioner(configuration, time);
    }

    private static DefaultHttpContext CreateContext(string remoteIp)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(remoteIp);
        context.Request.Path = "/api/binary/read-proof/submit.aeds";
        return context;
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        internal void Advance(TimeSpan duration) => _now = _now.Add(duration);
    }
}
