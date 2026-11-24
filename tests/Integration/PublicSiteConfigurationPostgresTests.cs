public sealed class PublicSiteConfigurationPostgresTests
{
    [Theory]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "//example.test/image")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "/assets/../api/binary/media")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "/assets/%2e%2e/oops.png")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "https://user@example.test/icon.png")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:OgImage", "https://example.test/icon.png?credential=one")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:ThemeColor", "#11223344")]
    [InlineData("FSUSBLOG_PUBLIC_COMPLIANCE:ContactEmail", "Name <public@example.test>")]
    [InlineData("FSUSBLOG_PUBLIC_COMPLIANCE:CopyrightStartYear", "1982")]
    [InlineData("FSUSBLOG_PUBLIC_COMPLIANCE:IcpRecordUrl", "https://example.test/without-number")]
    [InlineData("FSUSBLOG_PUBLIC_COMPLIANCE:RegionMode", "request-country")]
    [InlineData("FSUSBLOG_PUBLIC_SEO:Title", "not valid \uFFFE")]
    public void InvalidPublicValueFailsBeforeServing(string key, string value)
    {
        var settings = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { [key] = value }).Build();
        var error = Assert.Throws<InvalidOperationException>(() => PublicSiteConfiguration.Read(settings));
        Assert.Contains(key, error.Message);
        Assert.DoesNotContain(value, error.Message);
    }

    [PostgresFact]
    public async Task PublicPodMetadataHtmlAndFeedsShareOneExplicitSite()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        var settings = new Dictionary<string, string>
        {
            ["FSUSBLOG_PUBLIC_ORIGIN"] = "https://blog.example.test:443/",
            ["FSUSBLOG_PUBLIC_SEO__Title"] = "North & <South>",
            ["FSUSBLOG_PUBLIC_SEO__Description"] = "Visible <script>description</script> & text",
            ["FSUSBLOG_PUBLIC_SEO__Author"] = "Public Author",
            ["FSUSBLOG_PUBLIC_SEO__ThemeColor"] = "#123456",
            ["FSUSBLOG_PUBLIC_SEO__OgImage"] = "/assets/site-social.png",
            ["FSUSBLOG_PUBLIC_SEO__FaviconSvgUrl"] = "/assets/favicon.svg",
            ["FSUSBLOG_PUBLIC_SEO__BaseUrl"] = "https://incorrect-config.example/",
            ["FSUSBLOG_PUBLIC_SEO__AdminLogoUrl"] = "https://admin-private.example/secret",
            ["FSUSBLOG_PUBLIC_SEO__Keywords"] = "private_compatibility_value",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__Enabled"] = "true",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__RegionMode"] = "mainland-cn",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__CopyrightOwner"] = "North Company",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__CopyrightStartYear"] = "2004",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__CopyrightText"] = "Some rights reserved",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__ContentLicenseName"] = "CC BY 4.0",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__ContentLicenseUrl"] = "https://creativecommons.org/licenses/by/4.0/",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__IcpRecordNumber"] = "Sample-public-number",
            ["FSUSBLOG_PUBLIC_COMPLIANCE__ContactEmail"] = "info@example.test",
            ["FSUSBLOG_DB__PoolPassword"] = "postgres-private-placeholder"
        };
        await using var server = await ServerProcess.Start(database.ConnectionString, ct, settings);
        var seo = Read(Aeds.Decode(await ReadFrame(WireRoutes.PublicSeo), FrameType.SeoConfig).ToArray(),
            WireLayouts.SeoConfigPodBytes, WireLayouts.SeoConfigDescriptionOffset);
        Assert.Equal((settings["FSUSBLOG_PUBLIC_SEO__Title"], settings["FSUSBLOG_PUBLIC_SEO__Description"],
            "https://blog.example.test", "#123456", "", ""),
            (seo.Fixed(0, 256), seo.Blob,
                seo.Fixed(WireLayouts.SeoConfigBaseUrlOffset, WireLayouts.SeoConfigFaviconSvgUrlOffset),
                seo.Fixed(WireLayouts.SeoConfigThemeColorOffset, WireLayouts.SeoConfigBackgroundColorOffset),
                seo.Fixed(WireLayouts.SeoConfigKeywordsOffset, WireLayouts.SeoConfigAuthorOffset),
                seo.Fixed(WireLayouts.SeoConfigAdminLogoUrlOffset, WireLayouts.SeoConfigPodBytes)));
        var compliance = Read(Aeds.Decode(await ReadFrame(WireRoutes.PublicCompliance), FrameType.SiteComplianceConfig).ToArray(),
            WireLayouts.SiteCompliancePodBytes, WireLayouts.SiteComplianceCopyrightTextOffset);
        Assert.Equal(((byte)1, "mainland-cn", 2004, "Some rights reserved", "https://beian.miit.gov.cn/", "info@example.test"),
            (compliance.Bytes[0],
                compliance.Fixed(WireLayouts.SiteComplianceRegionModeOffset, WireLayouts.SiteComplianceCopyrightStartYearOffset),
                BinaryPrimitives.ReadInt32LittleEndian(compliance.Bytes.AsSpan(WireLayouts.SiteComplianceCopyrightStartYearOffset)),
                compliance.Blob,
                compliance.Fixed(WireLayouts.SiteComplianceIcpRecordUrlOffset, WireLayouts.SiteCompliancePoliceRecordNumberOffset),
                compliance.Fixed(WireLayouts.SiteComplianceContactEmailOffset, WireLayouts.SiteCompliancePodBytes)));

        var html = await OkString(Request("/"), ct);
        foreach (var present in new[] { "<title>North &amp; &lt;South&gt;</title>", "href=\"https://blog.example.test/\"",
            "rel=\"manifest\" href=\"/manifest.webmanifest\"", "name=\"theme-color\" content=\"#123456\"", "href=\"/assets/favicon.svg\"" })
            Assert.Contains(present, html);
        foreach (var absent in new[] { "<script>description", "meta name=\"keywords\"", "incorrect-config", "forged.example" })
            Assert.DoesNotContain(absent, html);

        using var manifestResponse = Ok(await Request(PublicSiteConfiguration.ManifestPath));
        Assert.True(manifestResponse.Headers.CacheControl!.NoStore);
        Assert.Equal("application/manifest+json", manifestResponse.Content.Headers.ContentType!.MediaType);
        using var manifestDoc = JsonDocument.Parse(await manifestResponse.Content.ReadAsStringAsync(ct));
        Assert.Equal((settings["FSUSBLOG_PUBLIC_SEO__Title"], "#123456", "standalone"),
            (manifestDoc.RootElement.GetProperty("name").GetString(),
                manifestDoc.RootElement.GetProperty("theme_color").GetString(),
                manifestDoc.RootElement.GetProperty("display").GetString()));
        var rss = XDocument.Parse(await server.Client.GetStringAsync("/feed/rss.xml", ct));
        var channel = rss.Root!.Element("channel")!;
        Assert.Equal((seo.Fixed(0, 256), seo.Blob), (channel.Element("title")!.Value, WebUtility.HtmlDecode(channel.Element("description")!.Value)));
        Assert.Contains("North Company", channel.Element("copyright")!.Value);
        using var json = JsonDocument.Parse(await server.Client.GetStringAsync("/feed/feed.json", ct));
        Assert.Equal((seo.Fixed(0, 256), "https://blog.example.test/", "Public Author"),
            (json.RootElement.GetProperty("title").GetString(), json.RootElement.GetProperty("home_page_url").GetString(),
                Assert.Single(json.RootElement.GetProperty("authors").EnumerateArray()).GetProperty("name").GetString()));

        await CheckStatusAsync(NotFound, Request("/api/binary/system/admin/seo"));
        using var head = await Request(WireRoutes.PublicCompliance, HttpMethod.Head);
        Assert.Equal("application/octet-stream", head.Content.Headers.ContentType!.MediaType);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));

        async Task<byte[]> ReadFrame(string path)
        {
            using var response = Ok(await Request(path));
            Assert.True(response.Headers.CacheControl!.NoStore);
            Assert.Equal("application/octet-stream", response.Content.Headers.ContentType!.MediaType);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }

        async Task<HttpResponseMessage> Request(string path, HttpMethod? method = null)
        {
            using var request = new HttpRequestMessage(method ?? HttpMethod.Get, path);
            request.Headers.Host = "forged.example";
            return await server.Client.SendAsync(request, ct);
        }
    }

    [PostgresFact]
    public async Task OnlineSiteConfigOverrideUpdatesPublicReadsHtmlFeedsManifestAndPersistsAcrossRestart()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        var admin = await database.AdminAsync("site-config-admin", 10, RandomNumberGenerator.GetBytes(32), [7], ct);
        var baseSettings = new Dictionary<string, string>
        {
            ["FSUSBLOG_PUBLIC_ORIGIN"] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = ServerProcess.DefaultAdminOrigin,
            ["FSUSBLOG_ADMIN_RP_ID"] = ServerProcess.DefaultAdminHost,
            ["FSUSBLOG_PUBLIC_SEO__Title"] = "Baseline Journal",
            ["FSUSBLOG_PUBLIC_SEO__Description"] = "Baseline description",
            ["FSUSBLOG_PUBLIC_SEO__Author"] = "Baseline Author",
        };

        await using (var server = await ServerProcess.Start(database.ConnectionString, ct, baseSettings))
        {
            using (var sessionResp = Ok(await SiteAedsFixture.AdminSend(server.Client, HttpMethod.Get, WireRoutes.AdminSession, admin.Token, ct)))
                Assert.Equal("1", sessionResp.Headers.GetValues(WireHeaders.AdminSiteConfigEnabled).Single());

            var initial = Wire.DecodeAdminSiteConfigState(await SiteAedsFixture.AdminBytes(server.Client, HttpMethod.Get, WireRoutes.AdminSiteConfig, admin.Token, ct));
            Assert.Equal((0L, "https://blog.example.test", "Baseline Journal", "Baseline Author"),
                (initial.Revision, initial.Origin, initial.Title, initial.Author));

            // Unchanged and invalid commands are rejected before Step-Up.
            var unchanged = new AdminSiteConfigCommand(
                initial.Revision, initial.Digest, initial.Title, initial.Description, initial.Author, initial.OgImage,
                initial.FaviconSvgUrl, initial.FaviconIcoUrl, initial.FaviconPngUrl, initial.AppleTouchIconUrl,
                initial.ManifestName, initial.ManifestShortName, initial.PwaIcon192Url, initial.PwaIcon512Url,
                initial.PwaMaskableIconUrl, initial.ThemeColor, initial.BackgroundColor, initial.SiteLogoUrl,
                initial.SiteLogoDarkUrl, initial.SiteWordmarkUrl, initial.ComplianceEnabled, initial.RegionMode,
                initial.CopyrightStartYear, initial.CopyrightOwner, initial.CopyrightText, initial.ContentLicenseName,
                initial.ContentLicenseUrl, initial.IcpRecordNumber, initial.IcpRecordUrl, initial.PoliceRecordNumber,
                initial.PoliceRecordUrl, initial.PoliceBadgeIconUrl, initial.OperatorName, initial.ContactEmail);
            foreach (var bad in new[] { unchanged, unchanged with { Title = "   " } })
                await SiteAedsFixture.AdminStatus(server.Client, HttpMethod.Post, WireRoutes.AdminSiteConfigStepUpBegin,
                    admin.Token, ct, BadRequest, Wire.EncodeAdminSiteConfigCommand(bad));

            var updatedCmd = new AdminSiteConfigCommand(
                initial.Revision, initial.Digest,
                "Updated Editorial", "Fresh live description", "Editorial Team", "/assets/og-live.png",
                "/assets/favicon-live.svg", "", "", "/assets/apple-live.png",
                "Updated App", "Updated", "/assets/icon-192.png", "/assets/icon-512.png", "/assets/icon-mask.png",
                "#234567", "#f7f8fa", "/assets/brand-logo.svg", "/assets/brand-logo-dark.svg", "/assets/brand-wordmark.svg",
                true, "mainland-cn", 2022, "Editorial Studio", "Published under editorial license.",
                "CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/", "京ICP备2026000001号-1", "",
                "京公网安备11000002000001号", "", "/assets/police-badge.png", "Editorial Studio", "ops@example.test");
            var cmdFrame = Wire.EncodeAdminSiteConfigCommand(updatedCmd);

            // Begin Passkey Step-Up, seed single-use proof, solve real 12-bit scoped PoW, and commit.
            Aeds.Decode(await SiteAedsFixture.AdminBytes(server.Client, HttpMethod.Post, WireRoutes.AdminSiteConfigStepUpBegin, admin.Token, ct, frame: cmdFrame),
                FrameType.PasskeyLoginBegin);
            var (stepUpProof, _) = await database.SeedStepUpProof("admin_site_config_step_up", admin.Id, admin.Digest, 13,
                AdminSiteConfigStore.CommandDigest(updatedCmd), ct: ct);
            var powProof = await SiteAedsFixture.AdminPow(server.Client, WireRoutes.AdminSiteConfigPow, admin.Token, cmdFrame, ct);
            Aeds.Decode(await SiteAedsFixture.AdminBytes(server.Client, HttpMethod.Post, WireRoutes.AdminSiteConfigSave, admin.Token, ct, frame: cmdFrame,
                configure: req => { req.Headers.Add(WireHeaders.MfaProof, stepUpProof); req.Headers.Add(WireHeaders.PowProof, powProof); }),
                FrameType.EmptySuccess);

            // Verify instant hot refresh across AEDS, manifest, SSR HTML, archive shell, and feeds without restart!
            var seoPod = Read(Aeds.Decode(await server.Client.GetByteArrayAsync(WireRoutes.PublicSeo, ct), FrameType.SeoConfig).ToArray(),
                WireLayouts.SeoConfigPodBytes, WireLayouts.SeoConfigDescriptionOffset);
            Assert.Equal(("Updated Editorial", "Fresh live description", "https://blog.example.test",
                "/assets/brand-logo.svg", "/assets/brand-logo-dark.svg", "/assets/brand-wordmark.svg"),
                (seoPod.Fixed(0, 256), seoPod.Blob,
                    seoPod.Fixed(WireLayouts.SeoConfigBaseUrlOffset, WireLayouts.SeoConfigFaviconSvgUrlOffset),
                    seoPod.Fixed(WireLayouts.SeoConfigSiteLogoUrlOffset, WireLayouts.SeoConfigSiteLogoDarkUrlOffset),
                    seoPod.Fixed(WireLayouts.SeoConfigSiteLogoDarkUrlOffset, WireLayouts.SeoConfigSiteWordmarkUrlOffset),
                    seoPod.Fixed(WireLayouts.SeoConfigSiteWordmarkUrlOffset, WireLayouts.SeoConfigAdminLogoUrlOffset)));

            var compPod = Read(Aeds.Decode(await server.Client.GetByteArrayAsync(WireRoutes.PublicCompliance, ct), FrameType.SiteComplianceConfig).ToArray(),
                WireLayouts.SiteCompliancePodBytes, WireLayouts.SiteComplianceCopyrightTextOffset);
            Assert.Equal(((byte)1, "mainland-cn", "https://beian.miit.gov.cn/", "https://beian.mps.gov.cn/", "/assets/police-badge.png"),
                (compPod.Bytes[0],
                    compPod.Fixed(WireLayouts.SiteComplianceRegionModeOffset, WireLayouts.SiteComplianceCopyrightStartYearOffset),
                    compPod.Fixed(WireLayouts.SiteComplianceIcpRecordUrlOffset, WireLayouts.SiteCompliancePoliceRecordNumberOffset),
                    compPod.Fixed(WireLayouts.SiteCompliancePoliceRecordUrlOffset, WireLayouts.SiteCompliancePoliceBadgeIconUrlOffset),
                    compPod.Fixed(WireLayouts.SiteCompliancePoliceBadgeIconUrlOffset, WireLayouts.SiteComplianceOperatorNameOffset)));

            using (var manifestDoc = JsonDocument.Parse(await server.Client.GetStringAsync(PublicSiteConfiguration.ManifestPath, ct)))
                Assert.Equal(("Updated App", "Updated", "#234567", "#f7f8fa", 3),
                    (manifestDoc.RootElement.GetProperty("name").GetString(), manifestDoc.RootElement.GetProperty("short_name").GetString(),
                        manifestDoc.RootElement.GetProperty("theme_color").GetString(), manifestDoc.RootElement.GetProperty("background_color").GetString(),
                        manifestDoc.RootElement.GetProperty("icons").GetArrayLength()));

            var homeHtml = await server.Client.GetStringAsync("/", ct);
            foreach (var expected in new[] { "<title>Updated Editorial</title>", "rel=\"manifest\" href=\"/manifest.webmanifest\"",
                "src=\"/assets/brand-logo.svg\"", "src=\"/assets/brand-wordmark.svg\"" })
                Assert.Contains(expected, homeHtml);
            Assert.Contains("Updated Editorial</title>", await server.Client.GetStringAsync("/archive", ct));

            var rss = XDocument.Parse(await server.Client.GetStringAsync("/feed/rss.xml", ct));
            Assert.Equal("Updated Editorial", rss.Root!.Element("channel")!.Element("title")!.Value);
            Assert.Contains("Editorial Studio", rss.Root!.Element("channel")!.Element("copyright")!.Value);
            using (var feedJson = JsonDocument.Parse(await server.Client.GetStringAsync("/feed/feed.json", ct)))
                Assert.Equal("Updated Editorial", feedJson.RootElement.GetProperty("title").GetString());

            // Stale revision conflict returns 409; admin GET returns revision 1.
            await SiteAedsFixture.AdminStatus(server.Client, HttpMethod.Post, WireRoutes.AdminSiteConfigStepUpBegin, admin.Token, ct, Conflict, cmdFrame);
            var after = Wire.DecodeAdminSiteConfigState(await SiteAedsFixture.AdminBytes(server.Client, HttpMethod.Get, WireRoutes.AdminSiteConfig, admin.Token, ct));
            Assert.Equal((1L, "Updated Editorial"), (after.Revision, after.Title));
        }

        // Restart against same PostgreSQL: committed override persists automatically on startup.
        await using (var restarted = await ServerProcess.Start(database.ConnectionString, ct, baseSettings))
        {
            Assert.Contains("<title>Updated Editorial</title>", await restarted.Client.GetStringAsync("/", ct));
            using var manifestDoc = JsonDocument.Parse(await restarted.Client.GetStringAsync(PublicSiteConfiguration.ManifestPath, ct));
            Assert.Equal("Updated App", manifestDoc.RootElement.GetProperty("name").GetString());
        }

        // Explicit FSUSBLOG_SITE_CONFIG_EDITOR=false hides admin routes and reverts to env baseline while keeping audit rows.
        await using (var disabled = await ServerProcess.Start(database.ConnectionString, ct,
            new Dictionary<string, string>(baseSettings) { [PublicSiteConfiguration.EditorSetting] = "false" }))
        {
            using (var sessionResp = Ok(await SiteAedsFixture.AdminSend(disabled.Client, HttpMethod.Get, WireRoutes.AdminSession, admin.Token, ct)))
                Assert.False(sessionResp.Headers.Contains(WireHeaders.AdminSiteConfigEnabled));
            await SiteAedsFixture.AdminStatus(disabled.Client, HttpMethod.Get, WireRoutes.AdminSiteConfig, admin.Token, ct, NotFound);
            Assert.Contains("<title>Baseline Journal</title>", await disabled.Client.GetStringAsync("/", ct));
        }
    }

    private sealed record Pod(byte[] Bytes, string Blob)
    {
        internal string Fixed(int start, int end) => Encoding.UTF8.GetString(Bytes.AsSpan(start, end - start)).TrimEnd('\0');
    }

    private static Pod Read(byte[] bytes, int podSize, int slice)
    {
        var length = bytes.Length - podSize - 4;
        Assert.Equal((0, length, length), (BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(slice)),
            BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(slice + 4)), BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(podSize))));
        return new(bytes, Encoding.UTF8.GetString(bytes.AsSpan(podSize + 4, length)));
    }
}
