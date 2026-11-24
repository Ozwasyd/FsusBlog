public sealed class SitePagesOnlinePostgresTests
{
    [PostgresFact]
    public async Task ZeroDiskBaselineAllowsOnlineSitePageCreationLivePublicServeSitemapAndDisabledFallback()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var admin = await database.AdminAsync("site-page-admin", 10, RandomNumberGenerator.GetBytes(32), [7], ct);
        const string origin = "https://blog.example.test";
        var settings = new Dictionary<string, string>
        {
            [PublicSiteConfiguration.OriginKey] = origin,
            ["FSUSBLOG_ADMIN_ORIGIN"] = ServerProcess.DefaultAdminOrigin,
            ["FSUSBLOG_ADMIN_RP_ID"] = ServerProcess.DefaultAdminHost,
            ["FSUSBLOG_SITE_PAGES"] = "",
        };
        var aboutPage = WireRoutes.AdminSitePage.Replace("{slug}", "about");
        var aboutRevision = WireRoutes.AdminSitePageRevision.Replace("{slug}", "about");

        await using (var server = await ServerProcess.Start(database.ConnectionString, ct, settings))
        {
            var client = server.Client;
            // Initial overview: zero disk files => all 4 pages unconfigured (mask 0), editor header = 1.
            using (var overviewResp = Ok(await SiteAedsFixture.AdminSend(client, HttpMethod.Get, WireRoutes.AdminSitePages, admin.Token, ct)))
            {
                Assert.Equal("1", Assert.Single(overviewResp.Headers.GetValues(WireHeaders.AdminSitePageEditor)));
                Assert.Equal(0, Wire.DecodeAdminSitePages(await overviewResp.Content.ReadAsByteArrayAsync(ct)).ConfiguredMask);
            }

            // Unconfigured page returns 404 on admin content read and unconfigured + noindex on public HTML.
            await SiteAedsFixture.AdminStatus(client, HttpMethod.Get, aboutPage, admin.Token, ct, NotFound);
            using (var publicBefore = Ok(await client.GetAsync("/about", ct)))
            {
                Assert.True(publicBefore.Headers.TryGetValues("X-Robots-Tag", out var robots) &&
                    robots.Any(v => v.Contains("noindex", StringComparison.OrdinalIgnoreCase)));
                Assert.Contains("data-state=\"unconfigured\"", await publicBefore.Content.ReadAsStringAsync(ct));
            }

            // Editor revision endpoint returns empty revision 0 baseline ready for first creation.
            var initial = Wire.DecodeAdminSitePageRevision(await SiteAedsFixture.AdminBytes(client, HttpMethod.Get, aboutRevision, admin.Token, ct));
            Assert.Equal(("about", 0L, string.Empty, SitePagePublicationStore.Digest(string.Empty)),
                (initial.Slug, initial.Revision, initial.Markdown, initial.Digest));

            // Publish /about with Passkey Step-Up + Scoped PoW.
            const string publishedMd = "# About North Notes\n\nPublished online without disk baseline.\n";
            var intent = new AdminSitePagePublish("about", initial.Revision, initial.Digest, publishedMd);
            var frame = Wire.EncodeAdminSitePagePublish(intent);
            Aeds.Decode(await SiteAedsFixture.AdminBytes(client, HttpMethod.Post, WireRoutes.AdminSitePageStepUpBegin, admin.Token, ct, frame: frame),
                FrameType.PasskeyLoginBegin);
            var (stepUpProof, _) = await database.SeedStepUpProof("admin_site_page_step_up", admin.Id, admin.Digest, 2,
                AdminSitePageStore.SitePageIntentDigest(intent), ct: ct);
            var powProof = await SiteAedsFixture.AdminPow(client, WireRoutes.AdminSitePagePow, admin.Token, frame, ct);
            Aeds.Decode(await SiteAedsFixture.AdminBytes(client, HttpMethod.Post, WireRoutes.AdminSitePagePublish, admin.Token, ct, frame: frame,
                configure: req => { req.Headers.TryAddWithoutValidation(WireHeaders.MfaProof, stepUpProof); req.Headers.TryAddWithoutValidation(WireHeaders.PowProof, powProof); }),
                FrameType.EmptySuccess);

            // Overview mask immediately flips bit 0 ("about") to configured!
            Assert.Equal(1, Wire.DecodeAdminSitePages(await SiteAedsFixture.AdminBytes(client, HttpMethod.Get, WireRoutes.AdminSitePages, admin.Token, ct)).ConfiguredMask);

            // Admin content read and public HTML + AEDS frame + sitemap immediately serve the new published page!
            var payload = Aeds.Decode(await SiteAedsFixture.AdminBytes(client, HttpMethod.Get, aboutPage, admin.Token, ct), FrameType.PageContent);
            Assert.Equal(publishedMd, Encoding.UTF8.GetString(payload[WireLayouts.PageContentBlobOffset..]));
            using (var publicAfter = Ok(await client.GetAsync("/about", ct)))
            {
                Assert.False(publicAfter.Headers.Contains("X-Robots-Tag"));
                var html = await publicAfter.Content.ReadAsStringAsync(ct);
                foreach (var expected in new[] { "data-state=\"published\"", "About North Notes", "Published online without disk baseline." })
                    Assert.Contains(expected, html);
            }
            var locs = await SitemapLocs(client);
            Assert.Contains(origin + "/about", locs);
            Assert.DoesNotContain(origin + "/privacy", locs);
        }

        // Cold restart with online editor enabled recovers published /about and sitemap automatically!
        await using (var restarted = await ServerProcess.Start(database.ConnectionString, ct, settings))
        {
            Assert.Equal(1, Wire.DecodeAdminSitePages(await SiteAedsFixture.AdminBytes(restarted.Client, HttpMethod.Get, WireRoutes.AdminSitePages, admin.Token, ct)).ConfiguredMask);
            Assert.Contains(origin + "/about", await SitemapLocs(restarted.Client));
        }

        // Explicit FSUSBLOG_SITE_PAGE_EDITOR=false falls back cleanly to unconfigured baseline (no disk files) and closes editor endpoints.
        await using (var disabled = await ServerProcess.Start(database.ConnectionString, ct,
            new Dictionary<string, string>(settings) { [SitePages.EditorSetting] = "false" }))
        {
            using (var overviewResp = Ok(await SiteAedsFixture.AdminSend(disabled.Client, HttpMethod.Get, WireRoutes.AdminSitePages, admin.Token, ct)))
            {
                Assert.False(overviewResp.Headers.Contains(WireHeaders.AdminSitePageEditor));
                Assert.Equal(0, Wire.DecodeAdminSitePages(await overviewResp.Content.ReadAsByteArrayAsync(ct)).ConfiguredMask);
            }
            await SiteAedsFixture.AdminStatus(disabled.Client, HttpMethod.Get, aboutRevision, admin.Token, ct, NotFound);
            using var publicDisabled = Ok(await disabled.Client.GetAsync("/about", ct));
            Assert.True(publicDisabled.Headers.Contains("X-Robots-Tag"));
            Assert.Contains("data-state=\"unconfigured\"", await publicDisabled.Content.ReadAsStringAsync(ct));
        }

        async Task<string[]> SitemapLocs(HttpClient client) =>
            XDocument.Parse(await client.GetStringAsync("/sitemap.xml", ct)).Descendants()
                .Where(e => e.Name.LocalName == "loc").Select(e => e.Value).ToArray();
    }
}
