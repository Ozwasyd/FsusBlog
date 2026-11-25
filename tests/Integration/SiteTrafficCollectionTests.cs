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

    [PostgresFact]
    public async Task LoopbackAdminReadsSeededSiteTrafficWithoutCollectingHttpRequests()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (_, adminToken, _) = await fixture.AdminAsync("loopback-traffic-admin", 10, [1], [2], ct);

        await fixture.InTx(async (db, tx) =>
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.site_traffic_daily (day, region, views)
                values
                  ((now() at time zone 'UTC')::date - 1, 'CN-SH', 30),
                  ((now() at time zone 'UTC')::date, 'CN-SH', 12),
                  ((now() at time zone 'UTC')::date, 'US', 18),
                  ((now() at time zone 'UTC')::date, 'unknown', 5)
                """);
        }, ct);

        using var dataDir = MediaFixture.OwnedTempDirectory("fsusblog-loopback-traffic-");
        await File.WriteAllTextAsync(Path.Combine(dataDir.FullName, "traffic-regions.json"),
            """[{"cidr":"192.0.2.0/24","region":"CN-SH"},{"cidr":"203.0.113.0/24","region":"US"}]""", ct);

        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [SiteCapabilities.DataDirSetting] = dataDir.FullName,
        }))
        {
            using (var home = await server.Client.GetAsync("/", ct))
                Assert.Equal(OK, home.StatusCode);

            var frame = await SiteAedsFixture.AdminBytes(server.Client, HttpMethod.Get, WireRoutes.AdminSiteTraffic, adminToken, ct);
            var snapshot = DecodeTraffic(frame);
            Assert.True(snapshot.Enabled);
            Assert.True(snapshot.RegionsConfigured);
            Assert.Equal(30, snapshot.Days.Count);
            Assert.Equal(65, snapshot.Days.Sum(day => day.Views));
            Assert.Equal([new SiteTrafficRegion("CN-SH", 42), new SiteTrafficRegion("US", 18), new SiteTrafficRegion("unknown", 5)],
                snapshot.Regions);
        }

        await using (var disabled = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [SiteCapabilities.DataDirSetting] = dataDir.FullName,
            [SiteTraffic.EnabledSetting] = "false",
        }))
        {
            var frame = await SiteAedsFixture.AdminBytes(disabled.Client, HttpMethod.Get, WireRoutes.AdminSiteTraffic, adminToken, ct);
            var snapshot = DecodeTraffic(frame);
            Assert.False(snapshot.Enabled);
            Assert.False(snapshot.RegionsConfigured);
            Assert.Empty(snapshot.Days);
            Assert.Empty(snapshot.Regions);
        }
    }

    private static AdminSiteTraffic DecodeTraffic(byte[] frame)
    {
        var payload = Aeds.Decode(frame, FrameType.AdminSiteTraffic);
        var pos = 0;
        var enabled = ReadBool(payload, ref pos);
        var regionsConfigured = ReadBool(payload, ref pos);
        var dayCount = ReadInt32(payload, ref pos);
        var days = new List<SiteTrafficDay>(dayCount);
        for (var i = 0; i < dayCount; i++)
            days.Add(new(ReadText(payload, ref pos), ReadInt64(payload, ref pos)));
        var regionCount = ReadInt32(payload, ref pos);
        var regions = new List<SiteTrafficRegion>(regionCount);
        for (var i = 0; i < regionCount; i++)
            regions.Add(new(ReadText(payload, ref pos), ReadInt64(payload, ref pos)));
        Assert.Equal(payload.Length, pos);
        return new(enabled, regionsConfigured, days, regions);

        static bool ReadBool(ReadOnlySpan<byte> data, ref int offset) => data[offset++] switch
        {
            0 => false,
            1 => true,
            var value => throw new InvalidOperationException($"Unexpected boolean byte {value}.")
        };
        static int ReadInt32(ReadOnlySpan<byte> data, ref int offset) { var value = BinaryPrimitives.ReadInt32LittleEndian(data[offset..]); offset += 4; return value; }
        static long ReadInt64(ReadOnlySpan<byte> data, ref int offset) { var value = BinaryPrimitives.ReadInt64LittleEndian(data[offset..]); offset += 8; return value; }
        static string ReadText(ReadOnlySpan<byte> data, ref int offset)
        {
            var len = ReadInt32(data, ref offset);
            var text = Encoding.UTF8.GetString(data.Slice(offset, len));
            offset += len;
            return text;
        }
    }
}
