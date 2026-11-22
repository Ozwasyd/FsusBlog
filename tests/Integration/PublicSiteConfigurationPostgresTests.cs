using static System.Net.HttpStatusCode;
using static FsusBlog.V2.Integration.Tests.HttpResponseAssert;
using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Content;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;

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
        Assert.Equal(settings["FSUSBLOG_PUBLIC_SEO__Title"], seo.Fixed(0, 256));
        Assert.Equal(settings["FSUSBLOG_PUBLIC_SEO__Description"], seo.Blob);
        Assert.Equal("https://blog.example.test", seo.Fixed(WireLayouts.SeoConfigBaseUrlOffset, WireLayouts.SeoConfigFaviconSvgUrlOffset));
        Assert.Equal("#123456", seo.Fixed(WireLayouts.SeoConfigThemeColorOffset, WireLayouts.SeoConfigBackgroundColorOffset));
        Assert.Empty(seo.Fixed(WireLayouts.SeoConfigKeywordsOffset, WireLayouts.SeoConfigAuthorOffset));
        Assert.Empty(seo.Fixed(WireLayouts.SeoConfigAdminLogoUrlOffset, WireLayouts.SeoConfigPodBytes));
        var compliance = Read(Aeds.Decode(await ReadFrame(WireRoutes.PublicCompliance), FrameType.SiteComplianceConfig).ToArray(),
            WireLayouts.SiteCompliancePodBytes, WireLayouts.SiteComplianceCopyrightTextOffset);
        Assert.Equal(1, compliance.Bytes[0]);
        Assert.Equal("mainland-cn", compliance.Fixed(WireLayouts.SiteComplianceRegionModeOffset, WireLayouts.SiteComplianceCopyrightStartYearOffset));
        Assert.Equal(2004, BinaryPrimitives.ReadInt32LittleEndian(compliance.Bytes.AsSpan(WireLayouts.SiteComplianceCopyrightStartYearOffset)));
        Assert.Equal("Some rights reserved", compliance.Blob);
        Assert.Equal("https://beian.miit.gov.cn/", compliance.Fixed(WireLayouts.SiteComplianceIcpRecordUrlOffset, WireLayouts.SiteCompliancePoliceRecordNumberOffset));
        Assert.Equal("info@example.test", compliance.Fixed(WireLayouts.SiteComplianceContactEmailOffset, WireLayouts.SiteCompliancePodBytes));

        using var homeResponse = await Request("/");
        var html = await homeResponse.Content.ReadAsStringAsync(ct);
        Assert.Contains("<title>North &amp; &lt;South&gt;</title>", html);
        Assert.Contains("href=\"https://blog.example.test/\"", html);
        Assert.Contains("rel=\"manifest\" href=\"/manifest.webmanifest\"", html);
        Assert.Contains("name=\"theme-color\" content=\"#123456\"", html);
        Assert.Contains("href=\"/assets/favicon.svg\"", html);
        Assert.DoesNotContain("<script>description", html);
        Assert.DoesNotContain("meta name=\"keywords\"", html);
        Assert.DoesNotContain("incorrect-config", html);
        Assert.DoesNotContain("forged.example", html);

        using var manifestResponse = Ok(await Request(PublicSiteConfiguration.ManifestPath));
        Assert.True(manifestResponse.Headers.CacheControl!.NoStore);
        Assert.Equal("application/manifest+json", manifestResponse.Content.Headers.ContentType!.MediaType);
        using var manifestDoc = JsonDocument.Parse(await manifestResponse.Content.ReadAsStringAsync(ct));
        Assert.Equal(settings["FSUSBLOG_PUBLIC_SEO__Title"], manifestDoc.RootElement.GetProperty("name").GetString());
        Assert.Equal("#123456", manifestDoc.RootElement.GetProperty("theme_color").GetString());
        Assert.Equal("standalone", manifestDoc.RootElement.GetProperty("display").GetString());
        var rss = XDocument.Parse(await server.Client.GetStringAsync("/feed/rss.xml", ct));
        Assert.Equal(seo.Fixed(0, 256), rss.Root!.Element("channel")!.Element("title")!.Value);
        Assert.Equal(seo.Blob, WebUtility.HtmlDecode(rss.Root!.Element("channel")!.Element("description")!.Value));
        Assert.Contains("North Company", rss.Root!.Element("channel")!.Element("copyright")!.Value);
        using var json = JsonDocument.Parse(await server.Client.GetStringAsync("/feed/feed.json", ct));
        Assert.Equal(seo.Fixed(0, 256), json.RootElement.GetProperty("title").GetString());
        Assert.Equal("https://blog.example.test/", json.RootElement.GetProperty("home_page_url").GetString());
        Assert.Equal("Public Author", Assert.Single(json.RootElement.GetProperty("authors").EnumerateArray()).GetProperty("name").GetString());

        using var admin = Expect(NotFound, await Request("/api/binary/system/admin/seo"));
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
        await using var db = await database.DataSource.OpenConnectionAsync(ct);
        var admin = await FixtureSql.AdminAsync(db, ct, "site-config-admin", 10, RandomNumberGenerator.GetBytes(32), [7]);
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
            using (var sessionResp = Ok(await AdminRequest(server, HttpMethod.Get, WireRoutes.AdminSession)))
            {
                Assert.Equal("1", sessionResp.Headers.GetValues(WireHeaders.AdminSiteConfigEnabled).Single());
            }

            AdminSiteConfigState initial;
            using (var readResp = Ok(await AdminRequest(server, HttpMethod.Get, WireRoutes.AdminSiteConfig)))
            {
                initial = Wire.DecodeAdminSiteConfigState(await readResp.Content.ReadAsByteArrayAsync(ct));
            }
            Assert.Equal(0L, initial.Revision);
            Assert.Equal("https://blog.example.test", initial.Origin);
            Assert.Equal("Baseline Journal", initial.Title);
            Assert.Equal("Baseline Author", initial.Author);

            // Unchanged command is rejected before Step-Up.
            var unchanged = new AdminSiteConfigCommand(
                initial.Revision, initial.Digest,
                initial.Title, initial.Description, initial.Author, initial.OgImage,
                initial.FaviconSvgUrl, initial.FaviconIcoUrl, initial.FaviconPngUrl, initial.AppleTouchIconUrl,
                initial.ManifestName, initial.ManifestShortName,
                initial.PwaIcon192Url, initial.PwaIcon512Url, initial.PwaMaskableIconUrl,
                initial.ThemeColor, initial.BackgroundColor,
                initial.SiteLogoUrl, initial.SiteLogoDarkUrl, initial.SiteWordmarkUrl,
                initial.ComplianceEnabled, initial.RegionMode, initial.CopyrightStartYear,
                initial.CopyrightOwner, initial.CopyrightText,
                initial.ContentLicenseName, initial.ContentLicenseUrl,
                initial.IcpRecordNumber, initial.IcpRecordUrl,
                initial.PoliceRecordNumber, initial.PoliceRecordUrl, initial.PoliceBadgeIconUrl,
                initial.OperatorName, initial.ContactEmail);
            CheckStatus(BadRequest, await AdminRequest(server, HttpMethod.Post, WireRoutes.AdminSiteConfigStepUpBegin,
                       Wire.EncodeAdminSiteConfigCommand(unchanged)));

            // Invalid input is rejected cleanly.
            var invalidCmd = unchanged with { Title = "   " };
            CheckStatus(BadRequest, await AdminRequest(server, HttpMethod.Post, WireRoutes.AdminSiteConfigStepUpBegin,
                       Wire.EncodeAdminSiteConfigCommand(invalidCmd)));

            var updatedCmd = new AdminSiteConfigCommand(
                initial.Revision, initial.Digest,
                "Updated Editorial", "Fresh live description", "Editorial Team", "/assets/og-live.png",
                "/assets/favicon-live.svg", "", "", "/assets/apple-live.png",
                "Updated App", "Updated",
                "/assets/icon-192.png", "/assets/icon-512.png", "/assets/icon-mask.png",
                "#234567", "#f7f8fa",
                "/assets/brand-logo.svg", "/assets/brand-logo-dark.svg", "/assets/brand-wordmark.svg",
                true, "mainland-cn", 2022,
                "Editorial Studio", "Published under editorial license.",
                "CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/",
                "京ICP备2026000001号-1", "",
                "京公网安备11000002000001号", "", "/assets/police-badge.png",
                "Editorial Studio", "ops@example.test");
            var cmdFrame = Wire.EncodeAdminSiteConfigCommand(updatedCmd);

            // Begin Passkey Step-Up and verify challenge issuance.
            using (var stepUpBeginResp = Ok(await AdminRequest(server, HttpMethod.Post, WireRoutes.AdminSiteConfigStepUpBegin, cmdFrame)))
            {
                Aeds.Decode(await stepUpBeginResp.Content.ReadAsByteArrayAsync(ct), FrameType.PasskeyLoginBegin);
            }

            // Seed single-use Step-Up proof row bound to exact command digest (same pattern as AdminStepUpPostgresTests).
            var stepUpProof = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            await FixtureSql.ExecuteAsync(db, null, ct, """
                insert into public.admin_site_config_step_up(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
                values($1,$2,$3,1,13,$4,null,clock_timestamp()+interval '45 seconds',2)
                on conflict (session_digest,kind) do update set digest=excluded.digest,body_digest=excluded.body_digest,expires_at=excluded.expires_at
                """, SHA256.HashData(Encoding.ASCII.GetBytes(stepUpProof)), admin.Id, admin.Digest,
                AdminSiteConfigStore.CommandDigest(updatedCmd));

            // Request and solve real 12-bit scoped PoW.
            var clientNonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            string powProof;
            using (var powResp = Ok(await AdminRequest(server, HttpMethod.Post, WireRoutes.AdminSiteConfigPow, cmdFrame,
                       extraHeaders: new() { [WireHeaders.PowClientNonce] = clientNonce })))
            {
                powProof = PowFixture.SolveFrame(await powResp.Content.ReadAsByteArrayAsync(ct), clientNonce, ct);
            }

            using (var saveResp = Ok(await AdminRequest(server, HttpMethod.Post, WireRoutes.AdminSiteConfigSave, cmdFrame,
                       extraHeaders: new() { [WireHeaders.MfaProof] = stepUpProof, [WireHeaders.PowProof] = powProof })))
            {
                Aeds.Decode(await saveResp.Content.ReadAsByteArrayAsync(ct), FrameType.EmptySuccess);
            }

            // Verify instant hot refresh across AEDS, manifest, SSR HTML, archive shell, and feeds without restart!
            var seoFrame = await server.Client.GetByteArrayAsync(WireRoutes.PublicSeo, ct);
            var seoPod = Read(Aeds.Decode(seoFrame, FrameType.SeoConfig).ToArray(),
                WireLayouts.SeoConfigPodBytes, WireLayouts.SeoConfigDescriptionOffset);
            Assert.Equal("Updated Editorial", seoPod.Fixed(0, 256));
            Assert.Equal("Fresh live description", seoPod.Blob);
            Assert.Equal("https://blog.example.test", seoPod.Fixed(WireLayouts.SeoConfigBaseUrlOffset, WireLayouts.SeoConfigFaviconSvgUrlOffset));
            Assert.Equal("/assets/brand-logo.svg", seoPod.Fixed(WireLayouts.SeoConfigSiteLogoUrlOffset, WireLayouts.SeoConfigSiteLogoDarkUrlOffset));
            Assert.Equal("/assets/brand-logo-dark.svg", seoPod.Fixed(WireLayouts.SeoConfigSiteLogoDarkUrlOffset, WireLayouts.SeoConfigSiteWordmarkUrlOffset));
            Assert.Equal("/assets/brand-wordmark.svg", seoPod.Fixed(WireLayouts.SeoConfigSiteWordmarkUrlOffset, WireLayouts.SeoConfigAdminLogoUrlOffset));

            var compFrame = await server.Client.GetByteArrayAsync(WireRoutes.PublicCompliance, ct);
            var compPod = Read(Aeds.Decode(compFrame, FrameType.SiteComplianceConfig).ToArray(),
                WireLayouts.SiteCompliancePodBytes, WireLayouts.SiteComplianceCopyrightTextOffset);
            Assert.Equal(1, compPod.Bytes[0]);
            Assert.Equal("mainland-cn", compPod.Fixed(WireLayouts.SiteComplianceRegionModeOffset, WireLayouts.SiteComplianceCopyrightStartYearOffset));
            Assert.Equal("https://beian.miit.gov.cn/", compPod.Fixed(WireLayouts.SiteComplianceIcpRecordUrlOffset, WireLayouts.SiteCompliancePoliceRecordNumberOffset));
            Assert.Equal("https://beian.mps.gov.cn/", compPod.Fixed(WireLayouts.SiteCompliancePoliceRecordUrlOffset, WireLayouts.SiteCompliancePoliceBadgeIconUrlOffset));
            Assert.Equal("/assets/police-badge.png", compPod.Fixed(WireLayouts.SiteCompliancePoliceBadgeIconUrlOffset, WireLayouts.SiteComplianceOperatorNameOffset));

            using (var manifestDoc = JsonDocument.Parse(await server.Client.GetStringAsync(PublicSiteConfiguration.ManifestPath, ct)))
            {
                Assert.Equal("Updated App", manifestDoc.RootElement.GetProperty("name").GetString());
                Assert.Equal("Updated", manifestDoc.RootElement.GetProperty("short_name").GetString());
                Assert.Equal("#234567", manifestDoc.RootElement.GetProperty("theme_color").GetString());
                Assert.Equal("#f7f8fa", manifestDoc.RootElement.GetProperty("background_color").GetString());
                Assert.Equal(3, manifestDoc.RootElement.GetProperty("icons").GetArrayLength());
            }

            var homeHtml = await server.Client.GetStringAsync("/", ct);
            Assert.Contains("<title>Updated Editorial</title>", homeHtml);
            Assert.Contains("rel=\"manifest\" href=\"/manifest.webmanifest\"", homeHtml);
            Assert.Contains("src=\"/assets/brand-logo.svg\"", homeHtml);
            Assert.Contains("src=\"/assets/brand-wordmark.svg\"", homeHtml);

            var archiveHtml = await server.Client.GetStringAsync("/archive", ct);
            Assert.Contains("Updated Editorial</title>", archiveHtml);

            var rss = XDocument.Parse(await server.Client.GetStringAsync("/feed/rss.xml", ct));
            Assert.Equal("Updated Editorial", rss.Root!.Element("channel")!.Element("title")!.Value);
            Assert.Contains("Editorial Studio", rss.Root!.Element("channel")!.Element("copyright")!.Value);

            using (var feedJson = JsonDocument.Parse(await server.Client.GetStringAsync("/feed/feed.json", ct)))
                Assert.Equal("Updated Editorial", feedJson.RootElement.GetProperty("title").GetString());

            // Stale revision conflict returns 409.
            CheckStatus(Conflict, await AdminRequest(server, HttpMethod.Post, WireRoutes.AdminSiteConfigStepUpBegin, cmdFrame));

            // Admin GET returns revision 1.
            using (var readAfter = await AdminRequest(server, HttpMethod.Get, WireRoutes.AdminSiteConfig))
            {
                var after = Wire.DecodeAdminSiteConfigState(await readAfter.Content.ReadAsByteArrayAsync(ct));
                Assert.Equal(1L, after.Revision);
                Assert.Equal("Updated Editorial", after.Title);
            }
        }

        // Restart against same PostgreSQL: committed override persists automatically on startup.
        await using (var restarted = await ServerProcess.Start(database.ConnectionString, ct, baseSettings))
        {
            var homeHtml = await restarted.Client.GetStringAsync("/", ct);
            Assert.Contains("<title>Updated Editorial</title>", homeHtml);
            using var manifestDoc = JsonDocument.Parse(await restarted.Client.GetStringAsync(PublicSiteConfiguration.ManifestPath, ct));
            Assert.Equal("Updated App", manifestDoc.RootElement.GetProperty("name").GetString());
        }

        // Explicit FSUSBLOG_SITE_CONFIG_EDITOR=false hides admin routes and reverts to env baseline while keeping audit rows.
        await using (var disabled = await ServerProcess.Start(database.ConnectionString, ct, new Dictionary<string, string>(baseSettings)
        {
            [PublicSiteConfiguration.EditorSetting] = "false"
        }))
        {
            using (var sessionResp = Ok(await AdminRequest(disabled, HttpMethod.Get, WireRoutes.AdminSession)))
            {
                Assert.False(sessionResp.Headers.Contains(WireHeaders.AdminSiteConfigEnabled));
            }
            CheckStatus(NotFound, await AdminRequest(disabled, HttpMethod.Get, WireRoutes.AdminSiteConfig));
            var homeHtml = await disabled.Client.GetStringAsync("/", ct);
            Assert.Contains("<title>Baseline Journal</title>", homeHtml);
        }

        async Task<HttpResponseMessage> AdminRequest(ServerProcess target, HttpMethod method, string path,
            byte[]? body = null, Dictionary<string, string>? extraHeaders = null)
        {
            using var req = new HttpRequestMessage(method, path);
            req.Headers.Host = ServerProcess.DefaultAdminHost;
            req.Headers.Add("Cookie", $"{ServerProcess.DefaultAdminCookie}={admin.Token}");
            if (method == HttpMethod.Post)
                req.Headers.Add("Origin", ServerProcess.DefaultAdminOrigin);
            if (extraHeaders is not null)
                foreach (var (key, value) in extraHeaders) req.Headers.Add(key, value);
            if (body is not null)
            {
                req.Content = new ByteArrayContent(body);
                req.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            }
            return await target.Client.SendAsync(req, ct);
        }
    }

    private sealed record Pod(byte[] Bytes, string Blob)
    {
        internal string Fixed(int start, int end) => Encoding.UTF8.GetString(Bytes.AsSpan(start, end - start)).TrimEnd('\0');
    }

    private static Pod Read(byte[] bytes, int podSize, int slice)
    {
        var length = bytes.Length - podSize - 4;
        Assert.Equal(0, BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(slice)));
        Assert.Equal(length, BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(slice + 4)));
        Assert.Equal(length, BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(podSize)));
        return new(bytes, Encoding.UTF8.GetString(bytes.AsSpan(podSize + 4, length)));
    }
}
