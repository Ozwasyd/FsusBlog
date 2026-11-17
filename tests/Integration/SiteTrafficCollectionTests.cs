using System.Net;
using FsusBlog.V2.Server.Analytics;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SiteTrafficCollectionTests
{
    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("10.1.2.3")]
    [InlineData("172.16.0.1")]
    [InlineData("192.168.1.1")]
    [InlineData("100.64.0.1")]
    [InlineData("169.254.1.1")]
    [InlineData("192.0.2.1")]
    [InlineData("224.0.0.1")]
    [InlineData("::1")]
    [InlineData("fc00::1")]
    [InlineData("fe80::1")]
    [InlineData("2001:db8::1")]
    [InlineData("::ffff:127.0.0.1")]
    public void NonPublicAddressesAreNeverEligible(string address) => Assert.False(SiteTrafficRegions.IsPublic(IPAddress.Parse(address)));

    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("1.1.1.1")]
    [InlineData("2606:4700::1111")]
    [InlineData("::ffff:8.8.8.8")]
    public void PublicAddressesAreEligible(string address) => Assert.True(SiteTrafficRegions.IsPublic(IPAddress.Parse(address)));

    [Theory]
    [InlineData("/", true)]
    [InlineData("/archive", true)]
    [InlineData("/search", true)]
    [InlineData("/about", true)]
    [InlineData("/privacy", true)]
    [InlineData("/guidelines", true)]
    [InlineData("/copyright", true)]
    [InlineData("/article/1", true)]
    [InlineData("/category/2", true)]
    [InlineData("/tag/3", true)]
    [InlineData("/admin", false)]
    [InlineData("/login", false)]
    [InlineData("/api/v2/a", false)]
    [InlineData("/assets/x", false)]
    [InlineData("/article/0", false)]
    [InlineData("/article/-1", false)]
    [InlineData("/article/1/more", false)]
    [InlineData("/user/messagebox", false)]
    public void OnlyExplicitPublicDocumentsAreEligible(string path, bool eligible) => Assert.Equal(eligible, SiteTraffic.PublicDocument(path));

    [Fact]
    public void OfflineMapUsesLongestPrefixAndAnExplicitUnknownBucket()
    {
        var path = Path.GetTempFileName();
        try
        {
            File.WriteAllText(path, """[{"cidr":"8.0.0.0/8","region":"US"},{"cidr":"8.8.0.0/16","region":"US-CA"}]""");
            var map = new SiteTrafficRegions(path);
            Assert.True(map.Configured);
            Assert.Equal("US-CA", map.Resolve(IPAddress.Parse("8.8.8.8")));
            Assert.Equal("US", map.Resolve(IPAddress.Parse("8.1.1.1")));
            Assert.Equal("unknown", map.Resolve(IPAddress.Parse("1.1.1.1")));
            Assert.False(new SiteTrafficRegions(null).Configured);
            File.WriteAllText(path, """[{"cidr":"8.0.0.0/8","region":"unknown"}]""");
            Assert.Throws<InvalidOperationException>(() => new SiteTrafficRegions(path));
        }
        finally { File.Delete(path); }
    }
}
