using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Content;
using Microsoft.AspNetCore.WebUtilities;

public sealed class SitePagesOnlinePostgresTests
{
    [PostgresFact]
    public async Task ZeroDiskBaselineAllowsOnlineSitePageCreationLivePublicServeSitemapAndDisabledFallback()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        await using var db = await database.DataSource.OpenConnectionAsync(ct);
        var admin = await FixtureSql.AdminAsync(db, ct, "site-page-admin", 10, RandomNumberGenerator.GetBytes(32), [7]);

        const string origin = "https://blog.example.test";
        var settings = new Dictionary<string, string>
        {
            [PublicSiteConfiguration.OriginKey] = origin,
            ["FSUSBLOG_ADMIN_ORIGIN"] = ServerProcess.DefaultAdminOrigin,
            ["FSUSBLOG_ADMIN_RP_ID"] = ServerProcess.DefaultAdminHost,
            ["FSUSBLOG_SITE_PAGES"] = "",
        };

        await using (var server = await ServerProcess.Start(database.ConnectionString, ct, settings))
        {
            // Initial overview: zero disk files => all 4 pages unconfigured (mask 0), editor header = 1.
            using (var overviewResp = await AdminRequest(server, HttpMethod.Get, WireRoutes.AdminSitePages))
            {
                Assert.Equal(HttpStatusCode.OK, overviewResp.StatusCode);
                Assert.Equal("1", Assert.Single(overviewResp.Headers.GetValues(WireHeaders.AdminSitePageEditor)));
                var overview = Wire.DecodeAdminSitePages(await overviewResp.Content.ReadAsByteArrayAsync(ct));
                Assert.Equal(0, overview.ConfiguredMask);
            }

            // Unconfigured page returns 404 on admin content read and unconfigured + noindex on public HTML.
            using (var unconfiguredAdmin = await AdminRequest(server, HttpMethod.Get, WireRoutes.AdminSitePage.Replace("{slug}", "about")))
                Assert.Equal(HttpStatusCode.NotFound, unconfiguredAdmin.StatusCode);

            using (var publicBefore = await server.Client.GetAsync("/about", ct))
            {
                Assert.Equal(HttpStatusCode.OK, publicBefore.StatusCode);
                Assert.True(publicBefore.Headers.TryGetValues("X-Robots-Tag", out var robots) &&
                    robots.Any(v => v.Contains("noindex", StringComparison.OrdinalIgnoreCase)));
                var html = await publicBefore.Content.ReadAsStringAsync(ct);
                Assert.Contains("data-state=\"unconfigured\"", html);
            }

            // Editor revision endpoint returns empty revision 0 baseline ready for first creation.
            AdminSitePageRevision initial;
            using (var revResp = await AdminRequest(server, HttpMethod.Get, WireRoutes.AdminSitePageRevision.Replace("{slug}", "about")))
            {
                Assert.Equal(HttpStatusCode.OK, revResp.StatusCode);
                initial = Wire.DecodeAdminSitePageRevision(await revResp.Content.ReadAsByteArrayAsync(ct));
            }
            Assert.Equal("about", initial.Slug);
            Assert.Equal(0L, initial.Revision);
            Assert.Equal(string.Empty, initial.Markdown);
            Assert.Equal(SitePagePublicationStore.Digest(string.Empty), initial.Digest);

            // Publish /about with Passkey Step-Up + Scoped PoW.
            const string publishedMd = "# About North Notes\n\nPublished online without disk baseline.\n";
            var intent = new AdminSitePagePublish("about", initial.Revision, initial.Digest, publishedMd);
            var frame = Wire.EncodeAdminSitePagePublish(intent);

            using (var beginResp = await AdminRequest(server, HttpMethod.Post, WireRoutes.AdminSitePageStepUpBegin, frame))
            {
                Assert.Equal(HttpStatusCode.OK, beginResp.StatusCode);
                Aeds.Decode(await beginResp.Content.ReadAsByteArrayAsync(ct), FrameType.PasskeyLoginBegin);
            }

            var stepUpProof = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            await FixtureSql.ExecuteAsync(db, null, ct, """
                insert into public.admin_site_page_step_up(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
                values($1,$2,$3,1,2,$4,null,clock_timestamp()+interval '45 seconds',2)
                on conflict (session_digest,kind) do update set digest=excluded.digest,body_digest=excluded.body_digest,expires_at=excluded.expires_at
                """, SHA256.HashData(Encoding.ASCII.GetBytes(stepUpProof)), admin.Id, admin.Digest,
                AdminSitePageStore.SitePageIntentDigest(intent));

            var clientNonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            string powProof;
            using (var powResp = await AdminRequest(server, HttpMethod.Post, WireRoutes.AdminSitePagePow, frame,
                       new() { [WireHeaders.PowClientNonce] = clientNonce }))
            {
                Assert.Equal(HttpStatusCode.OK, powResp.StatusCode);
                powProof = PowFixture.SolveFrame(await powResp.Content.ReadAsByteArrayAsync(ct), clientNonce, ct);
            }

            using (var publishResp = await AdminRequest(server, HttpMethod.Post, WireRoutes.AdminSitePagePublish, frame,
                       new() { [WireHeaders.MfaProof] = stepUpProof, [WireHeaders.PowProof] = powProof }))
            {
                Assert.Equal(HttpStatusCode.OK, publishResp.StatusCode);
                Aeds.Decode(await publishResp.Content.ReadAsByteArrayAsync(ct), FrameType.EmptySuccess);
            }

            // Overview mask immediately flips bit 0 ("about") to configured!
            using (var overviewAfter = await AdminRequest(server, HttpMethod.Get, WireRoutes.AdminSitePages))
            {
                Assert.Equal(HttpStatusCode.OK, overviewAfter.StatusCode);
                var overview = Wire.DecodeAdminSitePages(await overviewAfter.Content.ReadAsByteArrayAsync(ct));
                Assert.Equal(1, overview.ConfiguredMask);
            }

            // Admin content read and public HTML + AEDS frame + sitemap immediately serve the new published page!
            using (var adminContent = await AdminRequest(server, HttpMethod.Get, WireRoutes.AdminSitePage.Replace("{slug}", "about")))
            {
                Assert.Equal(HttpStatusCode.OK, adminContent.StatusCode);
                var payload = Aeds.Decode(await adminContent.Content.ReadAsByteArrayAsync(ct), FrameType.PageContent);
                Assert.Equal(publishedMd, Encoding.UTF8.GetString(payload[WireLayouts.PageContentBlobOffset..]));
            }

            using (var publicAfter = await server.Client.GetAsync("/about", ct))
            {
                Assert.Equal(HttpStatusCode.OK, publicAfter.StatusCode);
                Assert.False(publicAfter.Headers.Contains("X-Robots-Tag"));
                var html = await publicAfter.Content.ReadAsStringAsync(ct);
                Assert.Contains("data-state=\"published\"", html);
                Assert.Contains("About North Notes", html);
                Assert.Contains("Published online without disk baseline.", html);
            }

            var sitemapXml = XDocument.Parse(await server.Client.GetStringAsync("/sitemap.xml", ct));
            var locs = sitemapXml.Descendants().Where(e => e.Name.LocalName == "loc").Select(e => e.Value).ToArray();
            Assert.Contains(origin + "/about", locs);
            Assert.DoesNotContain(origin + "/privacy", locs);
        }

        // Cold restart with online editor enabled recovers published /about and sitemap automatically!
        await using (var restarted = await ServerProcess.Start(database.ConnectionString, ct, settings))
        {
            using (var overviewResp = await AdminRequest(restarted, HttpMethod.Get, WireRoutes.AdminSitePages))
            {
                Assert.Equal(HttpStatusCode.OK, overviewResp.StatusCode);
                var overview = Wire.DecodeAdminSitePages(await overviewResp.Content.ReadAsByteArrayAsync(ct));
                Assert.Equal(1, overview.ConfiguredMask);
            }

            var sitemapXml = XDocument.Parse(await restarted.Client.GetStringAsync("/sitemap.xml", ct));
            var locs = sitemapXml.Descendants().Where(e => e.Name.LocalName == "loc").Select(e => e.Value).ToArray();
            Assert.Contains(origin + "/about", locs);
        }

        // Explicit FSUSBLOG_SITE_PAGE_EDITOR=false falls back cleanly to unconfigured baseline (no disk files) and closes editor endpoints.
        var disabledSettings = new Dictionary<string, string>(settings)
        {
            [SitePages.EditorSetting] = "false",
        };
        await using (var disabled = await ServerProcess.Start(database.ConnectionString, ct, disabledSettings))
        {
            using (var overviewResp = await AdminRequest(disabled, HttpMethod.Get, WireRoutes.AdminSitePages))
            {
                Assert.Equal(HttpStatusCode.OK, overviewResp.StatusCode);
                Assert.False(overviewResp.Headers.Contains(WireHeaders.AdminSitePageEditor));
                var overview = Wire.DecodeAdminSitePages(await overviewResp.Content.ReadAsByteArrayAsync(ct));
                Assert.Equal(0, overview.ConfiguredMask);
            }

            using (var revResp = await AdminRequest(disabled, HttpMethod.Get, WireRoutes.AdminSitePageRevision.Replace("{slug}", "about")))
                Assert.Equal(HttpStatusCode.NotFound, revResp.StatusCode);

            using (var publicDisabled = await disabled.Client.GetAsync("/about", ct))
            {
                Assert.Equal(HttpStatusCode.OK, publicDisabled.StatusCode);
                Assert.True(publicDisabled.Headers.Contains("X-Robots-Tag"));
                Assert.Contains("data-state=\"unconfigured\"", await publicDisabled.Content.ReadAsStringAsync(ct));
            }
        }

        async Task<HttpResponseMessage> AdminRequest(ServerProcess server, HttpMethod method, string path,
            byte[]? body = null, Dictionary<string, string>? extraHeaders = null)
        {
            using var request = new HttpRequestMessage(method, path);
            request.Headers.Host = ServerProcess.DefaultAdminHost;
            request.Headers.TryAddWithoutValidation("Cookie", $"{ServerProcess.DefaultAdminCookie}={admin.Token}");
            if (method == HttpMethod.Post)
                request.Headers.TryAddWithoutValidation("Origin", ServerProcess.DefaultAdminOrigin);
            if (extraHeaders is not null)
                foreach (var (k, v) in extraHeaders)
                    request.Headers.TryAddWithoutValidation(k, v);
            if (body is not null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            }
            return await server.Client.SendAsync(request, ct);
        }
    }
}
