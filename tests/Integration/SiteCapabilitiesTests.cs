using System.Diagnostics;
using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Analytics;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Communication;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SiteCapabilitiesTests
{
    private static IConfiguration BuildConfig(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    [Fact]
    public void MinimalConfigActivatesZeroConfigDefaultsWithoutRequiringOptionalPrerequisites()
    {
        var webDist = Path.Combine(Path.GetTempPath(), "fsusblog-cap-dist-" + Guid.NewGuid().ToString("N"));
        var capabilities = SiteCapabilities.Resolve(BuildConfig([]), webDist);

        Assert.False(capabilities.TrustLoopbackProxy);
        Assert.Null(capabilities.PublicSite.Origin);
        Assert.Null(capabilities.SitePasskey);
        Assert.Null(capabilities.AdminIdentity);
        Assert.Null(capabilities.PrivateMediaRoot);
        Assert.Null(capabilities.PublicMediaRoot);
        Assert.Null(capabilities.SitePagesRoot);
        Assert.Null(capabilities.AppearanceRoot);
        Assert.Null(capabilities.TrafficRegionsPath);

        // Unconditional capabilities default ON
        Assert.True(capabilities.PublicCommentSubmissions);
        Assert.True(capabilities.SignedInCommentReplies);
        Assert.True(capabilities.PrivateInboxWrites);
        Assert.True(capabilities.DocumentExportTasks);
        Assert.True(capabilities.PublicHotArticles);
        Assert.True(capabilities.WideSearchCorpus);
        Assert.Equal("auto", capabilities.PublicSearchMode);

        // Prerequisite-gated capabilities stay cleanly off without failing
        Assert.False(capabilities.PrivateMediaResumable);
        Assert.False(capabilities.ArticleReadProof);
        Assert.False(capabilities.SiteTraffic);
        Assert.Null(capabilities.TrafficOrigin);
        Assert.False(capabilities.ReaderRegistration);
        Assert.False(capabilities.SitePersistentRefresh);
        Assert.False(capabilities.AdminInboxReplies);
        Assert.False(capabilities.AdminInboxStatus);
        Assert.False(capabilities.AdminInboxNotice);
        Assert.False(capabilities.AdminInboxSharedRead);
        Assert.False(capabilities.AdminInboxLive);
        Assert.False(capabilities.AdminInboxActivityOrder);
        Assert.False(capabilities.AdminCommentBatch);
        Assert.False(capabilities.AdminArticleRollback);
        Assert.False(capabilities.AdminTagMetadata);
        Assert.False(capabilities.AdminCategoryMetadata);
        Assert.False(capabilities.SitePageEditor);
        Assert.False(capabilities.SiteConfigEditor);
        Assert.True(capabilities.SiteConfigOverrideActive);
        Assert.False(capabilities.OnlineAppearance);
    }

    [Fact]
    public void PublicAndAdminOriginsAutoInferRpIdsAndActivateMatchingCapabilities()
    {
        var webDist = Path.Combine(Path.GetTempPath(), "fsusblog-cap-dist-" + Guid.NewGuid().ToString("N"));
        var capabilities = SiteCapabilities.Resolve(BuildConfig(new()
        {
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
        }), webDist);

        Assert.Equal("https://blog.example.test", capabilities.PublicSite.Origin);
        Assert.Equal(new Uri("https://blog.example.test"), capabilities.SitePasskey?.Origin);
        Assert.Equal("blog.example.test", capabilities.SitePasskey?.RpId);
        Assert.Equal(new Uri("https://admin.example.test"), capabilities.AdminIdentity?.Origin);
        Assert.Equal("admin.example.test", capabilities.AdminIdentity?.RpId);

        Assert.True(capabilities.ArticleReadProof);
        Assert.True(capabilities.SiteTraffic);
        Assert.Equal(new Uri("https://blog.example.test"), capabilities.TrafficOrigin);
        Assert.True(capabilities.ReaderRegistration);
        Assert.True(capabilities.SitePersistentRefresh);
        Assert.True(capabilities.AdminInboxReplies);
        Assert.True(capabilities.AdminInboxStatus);
        Assert.True(capabilities.AdminInboxNotice);
        Assert.True(capabilities.AdminInboxSharedRead);
        Assert.True(capabilities.AdminInboxLive);
        Assert.True(capabilities.AdminInboxActivityOrder);
        Assert.True(capabilities.AdminCommentBatch);
        Assert.True(capabilities.AdminArticleRollback);
        Assert.True(capabilities.AdminTagMetadata);
        Assert.True(capabilities.AdminCategoryMetadata);
        Assert.True(capabilities.SitePageEditor);
        Assert.True(capabilities.SiteConfigEditor);

        // No FSUSBLOG_DATA_DIR / appearance yet -> cleanly false
        Assert.False(capabilities.PrivateMediaResumable);
        Assert.False(capabilities.OnlineAppearance);
    }

    [Fact]
    public void SinglePublicOriginAutoDerivesBothSiteAndAdminPasskeysAndHttpsCapabilities()
    {
        var root = Directory.CreateTempSubdirectory("fsusblog-single-origin-");
        var webDist = Directory.CreateTempSubdirectory("fsusblog-single-dist-");
        try
        {
            var pages = Directory.CreateDirectory(Path.Combine(root.FullName, "site-pages"));
            foreach (var name in new[] { "about.md", "privacy.md", "guidelines.md", "copyright.md" })
                File.WriteAllText(Path.Combine(pages.FullName, name), "# " + name);
            var appearance = Directory.CreateDirectory(Path.Combine(root.FullName, "appearance"));
            File.WriteAllText(Path.Combine(appearance.FullName, "appearance.json"), "{}");

            var capabilities = SiteCapabilities.Resolve(BuildConfig(new()
            {
                [SiteCapabilities.DataDirSetting] = root.FullName,
                [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            }), webDist.FullName);

            Assert.Equal("https://blog.example.test", capabilities.PublicSite.Origin);
            Assert.Equal(new Uri("https://blog.example.test"), capabilities.SitePasskey?.Origin);
            Assert.Equal("blog.example.test", capabilities.SitePasskey?.RpId);
            Assert.Equal(new Uri("https://blog.example.test"), capabilities.AdminIdentity?.Origin);
            Assert.Equal("blog.example.test", capabilities.AdminIdentity?.RpId);
            Assert.True(capabilities.ReaderRegistration);
            Assert.True(capabilities.SitePersistentRefresh);
            Assert.True(capabilities.AdminInboxReplies);
            Assert.True(capabilities.AdminCommentBatch);
            Assert.True(capabilities.AdminArticleRollback);
            Assert.True(capabilities.AdminTagMetadata);
            Assert.True(capabilities.AdminCategoryMetadata);
            Assert.True(capabilities.SitePageEditor);
            Assert.True(capabilities.SiteConfigEditor);
            Assert.True(capabilities.OnlineAppearance);

            // Explicit FSUSBLOG_ADMIN_ORIGIN="" disables all admin capabilities fail-closed on a public-only node
            var publicOnly = SiteCapabilities.Resolve(BuildConfig(new()
            {
                [SiteCapabilities.DataDirSetting] = root.FullName,
                [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
                ["FSUSBLOG_ADMIN_ORIGIN"] = "",
            }), webDist.FullName);

            Assert.Equal(new Uri("https://blog.example.test"), publicOnly.SitePasskey?.Origin);
            Assert.Null(publicOnly.AdminIdentity);
            Assert.False(publicOnly.AdminInboxReplies);
            Assert.False(publicOnly.AdminCommentBatch);
            Assert.False(publicOnly.AdminArticleRollback);
            Assert.False(publicOnly.AdminTagMetadata);
            Assert.False(publicOnly.AdminCategoryMetadata);
            Assert.False(publicOnly.SitePageEditor);
            Assert.False(publicOnly.SiteConfigEditor);
            Assert.False(publicOnly.OnlineAppearance);
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
            Directory.Delete(webDist.FullName, recursive: true);
        }
    }

    [Fact]
    public void DataDirAutoProvisionsMediaAndDiscoversOptionalSubdirectories()
    {
        var root = Directory.CreateTempSubdirectory("fsusblog-datadir-");
        var webDist = Directory.CreateTempSubdirectory("fsusblog-dist-");
        try
        {
            // Empty appearance dir without appearance.json and missing site-pages should not trigger prematurely
            Directory.CreateDirectory(Path.Combine(root.FullName, "appearance"));
            var initial = SiteCapabilities.Resolve(BuildConfig(new()
            {
                [SiteCapabilities.DataDirSetting] = root.FullName,
                [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
                ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
            }), webDist.FullName);

            Assert.Equal(Path.Combine(root.FullName, "private-media"), initial.PrivateMediaRoot);
            Assert.Equal(Path.Combine(root.FullName, "public-media"), initial.PublicMediaRoot);
            Assert.True(Directory.Exists(initial.PrivateMediaRoot));
            Assert.True(Directory.Exists(initial.PublicMediaRoot));
            Assert.True(initial.PrivateMediaResumable);
            Assert.Null(initial.SitePagesRoot);
            Assert.True(initial.SitePageEditor);
            Assert.Null(initial.AppearanceRoot);
            Assert.False(initial.OnlineAppearance);
            Assert.Null(initial.TrafficRegionsPath);

            // Adding all 4 baseline site pages + appearance.json + traffic-regions.json activates discovery
            var pages = Directory.CreateDirectory(Path.Combine(root.FullName, "site-pages"));
            foreach (var name in new[] { "about.md", "privacy.md", "guidelines.md", "copyright.md" })
                File.WriteAllText(Path.Combine(pages.FullName, name), "# " + name);
            File.WriteAllText(Path.Combine(root.FullName, "appearance", "appearance.json"), "{}");
            var regionsFile = Path.Combine(root.FullName, "traffic-regions.json");
            File.WriteAllText(regionsFile, "[]");

            var discovered = SiteCapabilities.Resolve(BuildConfig(new()
            {
                [SiteCapabilities.DataDirSetting] = root.FullName,
                [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
                ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
            }), webDist.FullName);

            Assert.Equal(pages.FullName, discovered.SitePagesRoot);
            Assert.True(discovered.SitePageEditor);
            Assert.Equal(Path.Combine(root.FullName, "appearance"), discovered.AppearanceRoot);
            Assert.True(discovered.OnlineAppearance);
            Assert.Equal(regionsFile, discovered.TrafficRegionsPath);
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
            Directory.Delete(webDist.FullName, recursive: true);
        }
    }

    [Fact]
    public void ExplicitFalseAndEmptyOverridesStayStrictlyFailClosed()
    {
        var root = Directory.CreateTempSubdirectory("fsusblog-datadir-off-");
        var webDist = Directory.CreateTempSubdirectory("fsusblog-dist-off-");
        try
        {
            var pages = Directory.CreateDirectory(Path.Combine(root.FullName, "site-pages"));
            foreach (var name in new[] { "about.md", "privacy.md", "guidelines.md", "copyright.md" })
                File.WriteAllText(Path.Combine(pages.FullName, name), "# " + name);
            Directory.CreateDirectory(Path.Combine(root.FullName, "appearance"));
            File.WriteAllText(Path.Combine(root.FullName, "appearance", "appearance.json"), "{}");

            var capabilities = SiteCapabilities.Resolve(BuildConfig(new()
            {
                [SiteCapabilities.DataDirSetting] = root.FullName,
                [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
                ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
                ["FSUSBLOG_PASSKEY_ORIGIN"] = "",
                [MediaEndpoints.StorageSetting] = "",
                ["FSUSBLOG_SITE_PAGES"] = "",
                [AppearanceAssets.RootSetting] = "",
                [SiteCapabilities.PublicCommentsSetting] = "false",
                [CommentReplies.Setting] = "false",
                [InboxWriteEndpoints.Setting] = "false",
                [DocumentExportEndpoints.Setting] = "false",
                [PublicHotArticles.Setting] = "false",
                [WideSearchCorpusEndpoints.Setting] = "false",
                [SiteCapabilities.PublicSearchModeSetting] = "server",
                [ArticleReadEndpoints.Setting] = "false",
                [SiteTraffic.EnabledSetting] = "false",
                [AdminInboxEndpoints.ReplySetting] = "false",
                [AdminInboxEndpoints.StatusSetting] = "false",
                [AdminInboxEndpoints.NoticeSetting] = "false",
                [AdminInboxEndpoints.SharedReadSetting] = "false",
                [AdminInboxEndpoints.LiveSetting] = "false",
                [InboxActivityFence.Setting] = "false",
                [AdminModerationBatchEndpoints.Setting] = "false",
                [AdminArticleRollbackEndpoints.Setting] = "false",
                [AdminTagMetadataEndpoints.Setting] = "false",
                [AdminTagMetadataEndpoints.CategorySetting] = "false",
                [SitePages.EditorSetting] = "false",
                [PublicSiteConfiguration.EditorSetting] = "false",
            }), webDist.FullName);

            Assert.Null(capabilities.SitePasskey);
            Assert.Null(capabilities.PrivateMediaRoot);
            Assert.Null(capabilities.PublicMediaRoot);
            Assert.Null(capabilities.SitePagesRoot);
            Assert.Null(capabilities.AppearanceRoot);
            Assert.False(capabilities.PublicCommentSubmissions);
            Assert.False(capabilities.SignedInCommentReplies);
            Assert.False(capabilities.PrivateInboxWrites);
            Assert.False(capabilities.DocumentExportTasks);
            Assert.False(capabilities.PublicHotArticles);
            Assert.False(capabilities.WideSearchCorpus);
            Assert.Equal("server", capabilities.PublicSearchMode);
            Assert.False(capabilities.PrivateMediaResumable);
            Assert.False(capabilities.ArticleReadProof);
            Assert.False(capabilities.SiteTraffic);
            Assert.False(capabilities.ReaderRegistration);
            Assert.False(capabilities.SitePersistentRefresh);
            Assert.False(capabilities.AdminInboxReplies);
            Assert.False(capabilities.AdminInboxStatus);
            Assert.False(capabilities.AdminInboxNotice);
            Assert.False(capabilities.AdminInboxSharedRead);
            Assert.False(capabilities.AdminInboxLive);
            Assert.False(capabilities.AdminInboxActivityOrder);
            Assert.False(capabilities.AdminCommentBatch);
            Assert.False(capabilities.AdminArticleRollback);
            Assert.False(capabilities.AdminTagMetadata);
            Assert.False(capabilities.AdminCategoryMetadata);
            Assert.False(capabilities.SitePageEditor);
            Assert.False(capabilities.OnlineAppearance);
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
            Directory.Delete(webDist.FullName, recursive: true);
        }
    }

    [Fact]
    public void InvalidValuesAndExplicitTrueWithoutPrerequisitesFailFast()
    {
        var webDist = Path.Combine(Path.GetTempPath(), "fsusblog-cap-fail-" + Guid.NewGuid().ToString("N"));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [PublicHotArticles.Setting] = "maybe",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [ArticleReadEndpoints.Setting] = "true",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [SiteTraffic.EnabledSetting] = "true",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [SiteCapabilities.ReaderRegistrationSetting] = "true",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_PASSKEY_ORIGIN"] = "",
            [SiteCapabilities.ReaderRegistrationSetting] = "true",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [AdminArticleRollbackEndpoints.Setting] = "true",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [AdminTagMetadataEndpoints.Setting] = "true",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [AdminTagMetadataEndpoints.CategorySetting] = "true",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
            ["FSUSBLOG_ADMIN_RP_ID"] = "other.example.test",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [SiteCapabilities.DataDirSetting] = webDist,
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
            [SitePages.EditorSetting] = "true",
        }), webDist));

        Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(BuildConfig(new()
        {
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
            [AppearanceAssets.OnlineSetting] = "true",
        }), webDist));
    }

    [Fact]
    public void LoopbackAdminOriginActivatesLocalEditingCapabilities()
    {
        var root = Directory.CreateTempSubdirectory("fsusblog-loopback-admin-");
        var webDist = Directory.CreateTempSubdirectory("fsusblog-loopback-dist-");
        try
        {
            var pages = Directory.CreateDirectory(Path.Combine(root.FullName, "site-pages"));
            foreach (var name in new[] { "about.md", "privacy.md", "guidelines.md", "copyright.md" })
                File.WriteAllText(Path.Combine(pages.FullName, name), "# " + name);
            var appearance = Directory.CreateDirectory(Path.Combine(root.FullName, "appearance"));
            File.WriteAllText(Path.Combine(appearance.FullName, "appearance.json"), "{}");

            var capabilities = SiteCapabilities.Resolve(BuildConfig(new()
            {
                [SiteCapabilities.DataDirSetting] = root.FullName,
                ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost:5173",
            }), webDist.FullName);

            Assert.Equal(new Uri("http://localhost:5173"), capabilities.AdminIdentity?.Origin);
            Assert.Equal("localhost", capabilities.AdminIdentity?.RpId);
            Assert.True(capabilities.AdminTagMetadata);
            Assert.True(capabilities.AdminCategoryMetadata);
            Assert.True(capabilities.AdminArticleRollback);
            Assert.True(capabilities.SitePageEditor);
            Assert.True(capabilities.SiteConfigEditor);
            Assert.True(capabilities.OnlineAppearance);
        }
        finally
        {
            Directory.Delete(root.FullName, recursive: true);
            Directory.Delete(webDist.FullName, recursive: true);
        }
    }

    [Fact]
    public async Task MigrateInitSecretsOutputsThreeDistinctValidCryptographicKeys()
    {
        var host = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet";
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null && !File.Exists(Path.Combine(current.FullName, "FsusBlog.V2.slnx")))
            current = current.Parent;
        Assert.NotNull(current);
        var configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name ?? "Release";
        var cliDll = Path.Combine(current.FullName, "src", "Cli", "bin", configuration, "net10.0", "FsusBlog.V2.Cli.dll");
        if (!File.Exists(cliDll))
            cliDll = Path.Combine(current.FullName, "src", "Cli", "bin", "Release", "net10.0", "FsusBlog.V2.Cli.dll");
        Assert.True(File.Exists(cliDll), $"Expected {cliDll} to exist.");

        var start = new ProcessStartInfo(host)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(cliDll);
        start.ArgumentList.Add("init-secrets");

        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start Cli.");
        var stdout = await process.StandardOutput.ReadToEndAsync();
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();

        Assert.Equal(0, process.ExitCode);
        Assert.Equal("", stderr);

        var parsed = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var line in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var split = line.IndexOf('=');
            Assert.True(split > 0, $"Unexpected line: {line}");
            parsed[line[..split]] = line[(split + 1)..];
        }

        Assert.Equal(3, parsed.Count);
        Assert.Equal(64, parsed["FSUSBLOG_TOTP_KEY_HEX"]!.Length);
        Assert.Equal(64, parsed["FSUSBLOG_RECOVERY_KEY_PEPPER_HEX"]!.Length);
        Assert.Equal(64, parsed["FSUSBLOG_SUBSCRIPTION_HMAC_KEY"]!.Length);
        Assert.Equal(3, parsed.Values.Distinct(StringComparer.Ordinal).Count());

        var config = BuildConfig(parsed);
        Assert.NotNull(TotpSecret.Read(config));
        Assert.NotNull(RecoveryKeySecret.Read(config));
        Assert.NotNull(SubscriptionIdentity.Read(parsed["FSUSBLOG_SUBSCRIPTION_HMAC_KEY"]));
    }

    [PostgresFact]
    public async Task ZeroConfigBootActivatesCapabilitiesAndExplicitFalseOverridesStayFailClosed()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (_, readerToken, _) = await fixture.SignInSiteUser("cap-reader", ct, minutes: 5);
        var dataDir = MediaFixture.CreateOwnedTemporaryDirectory("fsusblog-cap-data-");
        using var cleanup = new MediaFixture.DirectoryCleanup(dataDir);

        static void AttachPublicHttps(HttpRequestMessage request)
        {
            request.Headers.Host = "blog.example.test";
            request.Headers.Add("X-Forwarded-Proto", "https");
            request.Headers.Add("X-Forwarded-For", "198.51.100.10");
        }

        // 1. Minimal production-like boot: ONLY DB + origins + DATA_DIR + proxy trust (ZERO feature flags, ZERO RP_IDs)
        await using (var enabled = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
            [SiteCapabilities.DataDirSetting] = dataDir.FullName,
        }, AttachPublicHttps))
        {
            Assert.True(Directory.Exists(Path.Combine(dataDir.FullName, "private-media")));
            Assert.True(Directory.Exists(Path.Combine(dataDir.FullName, "public-media")));

            using (var homeReq = new HttpRequestMessage(HttpMethod.Get, "/"))
            {
                AttachPublicHttps(homeReq);
                using var home = await enabled.Client.SendAsync(homeReq, ct);
                Assert.Equal(HttpStatusCode.OK, home.StatusCode);
                var html = await home.Content.ReadAsStringAsync(ct);
                Assert.Contains(PublicHotArticles.PageMarker, html, StringComparison.Ordinal);
                Assert.Contains(ArticleReadEndpoints.PageMarker, html, StringComparison.Ordinal);
                Assert.Contains(DocumentExportEndpoints.Marker, html, StringComparison.Ordinal);
                Assert.DoesNotContain("fsus-public-search-mode", html, StringComparison.Ordinal);
            }

            foreach (var route in new[]
            {
                WireRoutes.PasskeyAvailability,
                "/api/v2/identity/reader-registration/status.aeds",
                WireRoutes.SiteRefreshAvailability,
            })
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, route);
                AttachPublicHttps(req);
                using var resp = await enabled.Client.SendAsync(req, ct);
                Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
            }

            // Public hot articles endpoint becomes 200 (may transiently warm up with 503)
            var hotRoute = WireRoutes.PublicArticleHot.Replace("{size}", "10");
            HttpStatusCode hotStatus = HttpStatusCode.ServiceUnavailable;
            for (var attempt = 0; attempt < 40 && hotStatus == HttpStatusCode.ServiceUnavailable; attempt++)
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, hotRoute);
                AttachPublicHttps(req);
                using var resp = await enabled.Client.SendAsync(req, ct);
                hotStatus = resp.StatusCode;
                if (hotStatus == HttpStatusCode.ServiceUnavailable) await Task.Delay(50, ct);
            }
            Assert.Equal(HttpStatusCode.OK, hotStatus);

            // Authenticated inbox write availability reports enabled ("1") by default
            using (var inboxAvail = new HttpRequestMessage(HttpMethod.Get, WireRoutes.InboxWriteAvailability))
            {
                AttachPublicHttps(inboxAvail);
                inboxAvail.Headers.Add("Cookie", $"fsus-v2-session={readerToken}");
                using var resp = await enabled.Client.SendAsync(inboxAvail, ct);
                Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
                Assert.Equal("1", Assert.Single(resp.Headers.GetValues(WireHeaders.InboxWriteEnabled)));
            }

            // Admin origin responds cleanly with inferred RP ID and serves /admin document
            using (var adminDoc = new HttpRequestMessage(HttpMethod.Get, "/admin"))
            {
                adminDoc.Headers.Host = "admin.example.test";
                adminDoc.Headers.Add("X-Forwarded-Proto", "https");
                adminDoc.Headers.Add("X-Forwarded-For", "198.51.100.10");
                using var resp = await enabled.Client.SendAsync(adminDoc, ct);
                Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
            }
        }

        // 2. Explicit silent overrides disable each capability fail-closed (404 / omitted markers)
        await using (var disabled = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_PASSKEY_ORIGIN"] = "",
            [PublicHotArticles.Setting] = "false",
            [ArticleReadEndpoints.Setting] = "false",
            [DocumentExportEndpoints.Setting] = "false",
            [SiteCapabilities.PublicCommentsSetting] = "false",
            [InboxWriteEndpoints.Setting] = "false",
            [WideSearchCorpusEndpoints.Setting] = "false",
            [SiteTraffic.EnabledSetting] = "false",
            [SiteCapabilities.PublicSearchModeSetting] = "server",
        }, AttachPublicHttps))
        {
            using (var homeReq = new HttpRequestMessage(HttpMethod.Get, "/"))
            {
                AttachPublicHttps(homeReq);
                using var home = await disabled.Client.SendAsync(homeReq, ct);
                Assert.Equal(HttpStatusCode.OK, home.StatusCode);
                var html = await home.Content.ReadAsStringAsync(ct);
                Assert.DoesNotContain(PublicHotArticles.PageMarker, html, StringComparison.Ordinal);
                Assert.DoesNotContain(ArticleReadEndpoints.PageMarker, html, StringComparison.Ordinal);
                Assert.DoesNotContain(DocumentExportEndpoints.Marker, html, StringComparison.Ordinal);
                Assert.Contains("name=\"fsus-public-search-mode\" content=\"server\"", html, StringComparison.Ordinal);
            }

            foreach (var route in new[]
            {
                WireRoutes.PasskeyAvailability,
                "/api/v2/identity/reader-registration/status.aeds",
                WireRoutes.SiteRefreshAvailability,
                WireRoutes.PublicArticleHot.Replace("{size}", "10"),
                WireRoutes.PublicSearchWideManifest,
            })
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, route);
                AttachPublicHttps(req);
                using var resp = await disabled.Client.SendAsync(req, ct);
                Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
            }

            // Inbox write availability reports disabled ("0") and write endpoint returns 404
            using (var inboxAvail = new HttpRequestMessage(HttpMethod.Get, WireRoutes.InboxWriteAvailability))
            {
                AttachPublicHttps(inboxAvail);
                inboxAvail.Headers.Add("Cookie", $"fsus-v2-session={readerToken}");
                using var resp = await disabled.Client.SendAsync(inboxAvail, ct);
                Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
                Assert.Equal("0", Assert.Single(resp.Headers.GetValues(WireHeaders.InboxWriteEnabled)));
            }
            using (var inboxWrite = new HttpRequestMessage(HttpMethod.Post, WireRoutes.InboxCreatePowChallenge))
            {
                AttachPublicHttps(inboxWrite);
                using var resp = await disabled.Client.SendAsync(inboxWrite, ct);
                Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
            }
        }
    }

    [PostgresFact]
    public async Task UnifiedSingleOriginIsolatesReaderAndAdminSessionsOnSameHost()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (_, readerToken, _) = await fixture.SignInSiteUser("single-origin-reader", ct, minutes: 5);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (_, adminToken, _) = await FixtureSql.AdminAsync(db, ct, "single-origin-admin", 10, [1], [2]);

        static void AttachHttps(HttpRequestMessage request, string host = "blog.example.test")
        {
            request.Headers.Host = host;
            request.Headers.Add("X-Forwarded-Proto", "https");
            request.Headers.Add("X-Forwarded-For", "198.51.100.20");
        }

        var bothCookies = $"fsus-v2-session={readerToken}; __Host-FsusAdminSession={adminToken}";

        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
        }, req => AttachHttps(req)))
        {
            // Both public home and /admin document are served on the single canonical origin
            using (var homeReq = new HttpRequestMessage(HttpMethod.Get, "/"))
            {
                AttachHttps(homeReq);
                using var home = await server.Client.SendAsync(homeReq, ct);
                Assert.Equal(HttpStatusCode.OK, home.StatusCode);
            }
            using (var adminReq = new HttpRequestMessage(HttpMethod.Get, "/admin"))
            {
                AttachHttps(adminReq);
                using var adminDoc = await server.Client.SendAsync(adminReq, ct);
                Assert.Equal(HttpStatusCode.OK, adminDoc.StatusCode);
            }
            using (var wrongHostAdmin = new HttpRequestMessage(HttpMethod.Get, "/admin"))
            {
                AttachHttps(wrongHostAdmin, "other.example.test");
                using var resp = await server.Client.SendAsync(wrongHostAdmin, ct);
                Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
            }

            // Reader session endpoint reads ONLY reader cookie even when admin cookie is also present
            using (var readerBoth = new HttpRequestMessage(HttpMethod.Get, WireRoutes.Session))
            {
                AttachHttps(readerBoth);
                readerBoth.Headers.Add("Cookie", bothCookies);
                using var resp = await server.Client.SendAsync(readerBoth, ct);
                Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
                var session = Wire.DecodeSession(await resp.Content.ReadAsByteArrayAsync(ct));
                Assert.Equal("single-origin-reader", session.Name);
                Assert.False(session.CanAuthor);
            }
            using (var readerWithAdminOnly = new HttpRequestMessage(HttpMethod.Get, WireRoutes.Session))
            {
                AttachHttps(readerWithAdminOnly);
                readerWithAdminOnly.Headers.Add("Cookie", $"__Host-FsusAdminSession={adminToken}");
                using var resp = await server.Client.SendAsync(readerWithAdminOnly, ct);
                Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
            }

            // Authoring session endpoint reads ONLY admin cookie, never reader cookie
            using (var authoringBoth = new HttpRequestMessage(HttpMethod.Get, WireRoutes.AuthoringSession))
            {
                AttachHttps(authoringBoth);
                authoringBoth.Headers.Add("Cookie", bothCookies);
                using var resp = await server.Client.SendAsync(authoringBoth, ct);
                Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
                var session = Wire.DecodeSession(await resp.Content.ReadAsByteArrayAsync(ct));
                Assert.Equal("single-origin-admin", session.Name);
                Assert.True(session.CanAuthor);
            }
            using (var authoringReaderOnly = new HttpRequestMessage(HttpMethod.Get, WireRoutes.AuthoringSession))
            {
                AttachHttps(authoringReaderOnly);
                authoringReaderOnly.Headers.Add("Cookie", $"fsus-v2-session={readerToken}");
                using var resp = await server.Client.SendAsync(authoringReaderOnly, ct);
                Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
            }
            using (var authoringWrongHost = new HttpRequestMessage(HttpMethod.Get, WireRoutes.AuthoringSession))
            {
                AttachHttps(authoringWrongHost, "other.example.test");
                authoringWrongHost.Headers.Add("Cookie", $"__Host-FsusAdminSession={adminToken}");
                using var resp = await server.Client.SendAsync(authoringWrongHost, ct);
                Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
            }

            // Admin identity session endpoint reads ONLY admin cookie
            using (var adminBoth = new HttpRequestMessage(HttpMethod.Get, WireRoutes.AdminSession))
            {
                AttachHttps(adminBoth);
                adminBoth.Headers.Add("Cookie", bothCookies);
                using var resp = await server.Client.SendAsync(adminBoth, ct);
                Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
                var snapshot = Wire.DecodeAdminSessionSnapshot(await resp.Content.ReadAsByteArrayAsync(ct));
                Assert.Equal("single-origin-admin", snapshot.Handle);
            }
            using (var adminReaderOnly = new HttpRequestMessage(HttpMethod.Get, WireRoutes.AdminSession))
            {
                AttachHttps(adminReaderOnly);
                adminReaderOnly.Headers.Add("Cookie", $"fsus-v2-session={readerToken}");
                using var resp = await server.Client.SendAsync(adminReaderOnly, ct);
                Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
            }
        }

        // Explicit FSUSBLOG_ADMIN_ORIGIN="" disables /admin and /api/v2/authoring/* fail-closed
        await using (var publicOnly = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "",
        }, req => AttachHttps(req)))
        {
            using (var homeReq = new HttpRequestMessage(HttpMethod.Get, "/"))
            {
                AttachHttps(homeReq);
                using var home = await publicOnly.Client.SendAsync(homeReq, ct);
                Assert.Equal(HttpStatusCode.OK, home.StatusCode);
            }
            foreach (var blocked in new[] { "/admin", WireRoutes.AdminSession, WireRoutes.AuthoringSession })
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, blocked);
                AttachHttps(req);
                req.Headers.Add("Cookie", $"__Host-FsusAdminSession={adminToken}");
                using var resp = await publicOnly.Client.SendAsync(req, ct);
                Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
            }
        }
    }

    [Fact]
    public async Task ExplicitAdminClosureSkipsPasskeyParsingAndDomainStoresConstructWithoutPasskeyConfig()
    {
        var webDist = Path.Combine(Path.GetTempPath(), "fsusblog-cap-noadmin-" + Guid.NewGuid().ToString("N"));
        var capabilities = SiteCapabilities.Resolve(BuildConfig(new()
        {
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "",
            ["FSUSBLOG_ADMIN_RP_ID"] = "admin.example.test",
        }), webDist);

        Assert.Null(capabilities.AdminIdentity);
        Assert.False(capabilities.AdminArticleRollback);
        Assert.False(capabilities.AdminCommentBatch);
        Assert.False(capabilities.AdminInboxReplies);
        Assert.False(capabilities.AdminTagMetadata);
        Assert.False(capabilities.AdminCategoryMetadata);

        await using var dataSource = Npgsql.NpgsqlDataSource.Create("Host=127.0.0.1;Port=5432;Username=postgres;Database=postgres");
        var gate = new AdminSessionGate(dataSource, null);
        var stepUp = new AdminStepUpService(gate);
        _ = new AdminOperationsStore(gate);
        _ = new AdminSignInHistoryStore(gate);
        _ = new AdminCommentQueueStore(gate);
        _ = new AdminCommentHistoryStore(gate);
        _ = new AdminTaxonomyStore(gate);
        _ = new AdminTagMetadataStore(gate);
        _ = new AdminInboxStore(gate);
        _ = new AdminInboxReadStore(gate);
        _ = new AdminInboxActivityStore(gate);
        _ = new AdminInboxReplyStore(gate);
        _ = new AdminInboxStatusStore(gate);
        _ = new AdminInboxNoticeStore(gate);
        _ = new AdminSitePageStore(gate);
        _ = new AdminAppearanceStore(gate, stepUp);
        _ = new AdminModerationStore(gate, stepUp);
        _ = new AdminModerationBatchStore(gate, stepUp);
        _ = new AdminCommentAppealStore(gate, stepUp);
        _ = new AdminCommentRiskStore(gate, stepUp);
        _ = new AdminArticleRollbackStore(gate, stepUp);
        _ = new AdminArticleArchiveStore(gate, stepUp);
        _ = new AdminArticleTrashRestoreStore(gate, stepUp);
        _ = new AdminArticleTrashPublicationStore(gate, stepUp);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            stepUp.BeginModerationStepUp("session", new AdminModerationIntent(1, 1, 0, 1, "test"), CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            stepUp.CompleteModerationStepUp("session", new PasskeyLoginRequest("token", "id", [], [], [], [], [], false), CancellationToken.None));
    }
}
