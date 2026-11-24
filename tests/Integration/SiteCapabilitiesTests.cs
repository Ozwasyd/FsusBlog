namespace FsusBlog.V2.Integration.Tests;

public sealed class SiteCapabilitiesTests
{
    private static IConfiguration BuildConfig(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    private static DirectoryInfo CreateSitePages(DirectoryInfo data)
    {
        var pages = Directory.CreateDirectory(Path.Combine(data.FullName, "site-pages"));
        foreach (var name in new[] { "about.md", "privacy.md", "guidelines.md", "copyright.md" })
            File.WriteAllText(Path.Combine(pages.FullName, name), "# " + name);
        return pages;
    }

    private static void WriteAppearanceFixture(DirectoryInfo data)
    {
        var appearance = Directory.CreateDirectory(Path.Combine(data.FullName, "appearance"));
        File.WriteAllText(Path.Combine(appearance.FullName, "appearance.json"), "{}");
    }

    private static void CheckAdminChannels(SiteCapabilities c, Action<bool> check) => Assert.All(
        [c.AdminInboxReplies, c.AdminInboxStatus, c.AdminInboxNotice, c.AdminInboxSharedRead, c.AdminInboxLive, c.AdminInboxActivityOrder, c.AdminCommentBatch], check);

    private static void CheckAdminArticleTools(SiteCapabilities c, Action<bool> check) =>
        Assert.All([c.AdminArticleRollback, c.AdminTagMetadata, c.AdminCategoryMetadata], check);

    [Fact]
    public void MinimalConfigActivatesZeroConfigDefaultsWithoutRequiringOptionalPrerequisites()
    {
        var webDist = Path.Combine(Path.GetTempPath(), "fsusblog-cap-dist-" + Guid.NewGuid().ToString("N"));
        var c = SiteCapabilities.Resolve(BuildConfig([]), webDist);

        Assert.All(new object?[] { c.PublicSite.Origin, c.SitePasskey, c.AdminIdentity, c.PrivateMediaRoot, c.PublicMediaRoot, c.SitePagesRoot, c.AppearanceRoot, c.TrafficRegionsPath, c.TrafficOrigin }, Assert.Null);
        Assert.All([c.PublicCommentSubmissions, c.SignedInCommentReplies, c.PrivateInboxWrites, c.DocumentExportTasks, c.PublicHotArticles, c.WideSearchCorpus, c.SiteConfigOverrideActive], Assert.True);
        Assert.Equal("auto", c.PublicSearchMode);
        Assert.All([c.TrustLoopbackProxy, c.PrivateMediaResumable, c.ArticleReadProof, c.SiteTraffic, c.ReaderRegistration, c.SitePersistentRefresh, c.SitePageEditor, c.SiteConfigEditor, c.OnlineAppearance], Assert.False);
        CheckAdminChannels(c, Assert.False);
        CheckAdminArticleTools(c, Assert.False);
    }

    [Fact]
    public void PublicAndAdminOriginsAutoInferRpIdsAndActivateMatchingCapabilities()
    {
        var webDist = Path.Combine(Path.GetTempPath(), "fsusblog-cap-dist-" + Guid.NewGuid().ToString("N"));
        var c = SiteCapabilities.Resolve(BuildConfig(new()
        {
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
        }), webDist);

        Assert.Equal(("https://blog.example.test", new Uri("https://blog.example.test"), "blog.example.test", new Uri("https://admin.example.test"), "admin.example.test", new Uri("https://blog.example.test")),
            (c.PublicSite.Origin, c.SitePasskey?.Origin, c.SitePasskey?.RpId, c.AdminIdentity?.Origin, c.AdminIdentity?.RpId, c.TrafficOrigin));
        Assert.All([c.ArticleReadProof, c.SiteTraffic, c.ReaderRegistration, c.SitePersistentRefresh, c.SitePageEditor, c.SiteConfigEditor], Assert.True);
        CheckAdminChannels(c, Assert.True);
        CheckAdminArticleTools(c, Assert.True);
        Assert.All([c.PrivateMediaResumable, c.OnlineAppearance], Assert.False);
    }

    [Fact]
    public void SinglePublicOriginAutoDerivesBothSiteAndAdminPasskeysAndHttpsCapabilities()
    {
        using var directories = new SiteFixtureDirectories("fsusblog-single-origin-", "fsusblog-single-dist-");
        var (root, webDist) = directories.Paths;
        CreateSitePages(root);
        WriteAppearanceFixture(root);

        var c = SiteCapabilities.Resolve(BuildConfig(new()
        {
            [SiteCapabilities.DataDirSetting] = root.FullName,
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
        }), webDist.FullName);

        var blogUri = new Uri("https://blog.example.test");
        Assert.Equal(("https://blog.example.test", blogUri, "blog.example.test", blogUri, "blog.example.test"),
            (c.PublicSite.Origin, c.SitePasskey?.Origin, c.SitePasskey?.RpId, c.AdminIdentity?.Origin, c.AdminIdentity?.RpId));
        Assert.All([c.ReaderRegistration, c.SitePersistentRefresh, c.AdminInboxReplies, c.AdminCommentBatch, c.SitePageEditor, c.SiteConfigEditor, c.OnlineAppearance], Assert.True);
        CheckAdminArticleTools(c, Assert.True);

        var publicOnly = SiteCapabilities.Resolve(BuildConfig(new()
        {
            [SiteCapabilities.DataDirSetting] = root.FullName,
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "",
        }), webDist.FullName);

        Assert.Equal(blogUri, publicOnly.SitePasskey?.Origin);
        Assert.Null(publicOnly.AdminIdentity);
        Assert.All([publicOnly.AdminInboxReplies, publicOnly.AdminCommentBatch, publicOnly.SitePageEditor, publicOnly.SiteConfigEditor, publicOnly.OnlineAppearance], Assert.False);
        CheckAdminArticleTools(publicOnly, Assert.False);
    }

    [Fact]
    public void DataDirAutoProvisionsMediaAndDiscoversOptionalSubdirectories()
    {
        using var directories = new SiteFixtureDirectories("fsusblog-datadir-", "fsusblog-dist-");
        var (root, webDist) = directories.Paths;
        Directory.CreateDirectory(Path.Combine(root.FullName, "appearance"));
        Dictionary<string, string?> cfg = new()
        {
            [SiteCapabilities.DataDirSetting] = root.FullName,
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
        };
        var initial = SiteCapabilities.Resolve(BuildConfig(cfg), webDist.FullName);

        Assert.Equal((Path.Combine(root.FullName, "private-media"), Path.Combine(root.FullName, "public-media")),
            (initial.PrivateMediaRoot, initial.PublicMediaRoot));
        Assert.All([Directory.Exists(initial.PrivateMediaRoot), Directory.Exists(initial.PublicMediaRoot), initial.PrivateMediaResumable, initial.SitePageEditor], Assert.True);
        Assert.All(new object?[] { initial.SitePagesRoot, initial.AppearanceRoot, initial.TrafficRegionsPath }, Assert.Null);
        Assert.False(initial.OnlineAppearance);

        var pages = CreateSitePages(root);
        File.WriteAllText(Path.Combine(root.FullName, "appearance", "appearance.json"), "{}");
        var regionsFile = Path.Combine(root.FullName, "traffic-regions.json");
        File.WriteAllText(regionsFile, "[]");

        var discovered = SiteCapabilities.Resolve(BuildConfig(cfg), webDist.FullName);
        Assert.Equal((pages.FullName, Path.Combine(root.FullName, "appearance"), regionsFile),
            (discovered.SitePagesRoot, discovered.AppearanceRoot, discovered.TrafficRegionsPath));
        Assert.All([discovered.SitePageEditor, discovered.OnlineAppearance], Assert.True);
    }

    [Fact]
    public void ExplicitFalseAndEmptyOverridesStayStrictlyFailClosed()
    {
        using var directories = new SiteFixtureDirectories("fsusblog-datadir-off-", "fsusblog-dist-off-");
        var (root, webDist) = directories.Paths;
        CreateSitePages(root);
        WriteAppearanceFixture(root);

        var c = SiteCapabilities.Resolve(BuildConfig(new()
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

        Assert.All(new object?[] { c.SitePasskey, c.PrivateMediaRoot, c.PublicMediaRoot, c.SitePagesRoot, c.AppearanceRoot }, Assert.Null);
        Assert.Equal("server", c.PublicSearchMode);
        Assert.All([c.PublicCommentSubmissions, c.SignedInCommentReplies, c.PrivateInboxWrites, c.DocumentExportTasks, c.PublicHotArticles, c.WideSearchCorpus,
            c.PrivateMediaResumable, c.ArticleReadProof, c.SiteTraffic, c.ReaderRegistration, c.SitePersistentRefresh, c.SitePageEditor, c.OnlineAppearance], Assert.False);
        CheckAdminChannels(c, Assert.False);
        CheckAdminArticleTools(c, Assert.False);
    }

    [Fact]
    public void InvalidValuesAndExplicitTrueWithoutPrerequisitesFailFast()
    {
        var webDist = Path.Combine(Path.GetTempPath(), "fsusblog-cap-fail-" + Guid.NewGuid().ToString("N"));

        void Invalid(params (string Key, string? Value)[] settings) =>
            Assert.Throws<InvalidOperationException>(() => SiteCapabilities.Resolve(
                BuildConfig(settings.ToDictionary(item => item.Key, item => item.Value)), webDist));

        Invalid((PublicHotArticles.Setting, "maybe"));
        Invalid((ArticleReadEndpoints.Setting, "true"));
        Invalid((SiteTraffic.EnabledSetting, "true"));
        Invalid((SiteCapabilities.ReaderRegistrationSetting, "true"));
        Invalid((PublicSiteConfiguration.OriginKey, "https://blog.example.test"),
            ("FSUSBLOG_PASSKEY_ORIGIN", ""),
            (SiteCapabilities.ReaderRegistrationSetting, "true"));
        Invalid((AdminArticleRollbackEndpoints.Setting, "true"));
        Invalid((AdminTagMetadataEndpoints.Setting, "true"));
        Invalid((AdminTagMetadataEndpoints.CategorySetting, "true"));
        Invalid(("FSUSBLOG_ADMIN_ORIGIN", "https://admin.example.test"),
            ("FSUSBLOG_ADMIN_RP_ID", "other.example.test"),
            (PublicSiteConfiguration.OriginKey, "https://blog.example.test"));
        Invalid((SiteCapabilities.DataDirSetting, webDist));
        Invalid(("FSUSBLOG_ADMIN_ORIGIN", "https://admin.example.test"),
            (SitePages.EditorSetting, "true"));
        Invalid((PublicSiteConfiguration.OriginKey, "https://blog.example.test"),
            ("FSUSBLOG_ADMIN_ORIGIN", "https://admin.example.test"),
            (AppearanceAssets.OnlineSetting, "true"));
    }

    [Fact]
    public void LoopbackAdminOriginActivatesLocalEditingCapabilities()
    {
        using var directories = new SiteFixtureDirectories("fsusblog-loopback-admin-", "fsusblog-loopback-dist-");
        var (root, webDist) = directories.Paths;
        CreateSitePages(root);
        WriteAppearanceFixture(root);

        var capabilities = SiteCapabilities.Resolve(BuildConfig(new()
        {
            [SiteCapabilities.DataDirSetting] = root.FullName,
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost:5173",
        }), webDist.FullName);

        Assert.Equal((new Uri("http://localhost:5173"), "localhost"), (capabilities.AdminIdentity?.Origin, capabilities.AdminIdentity?.RpId));
        Assert.All([capabilities.AdminTagMetadata, capabilities.AdminCategoryMetadata, capabilities.AdminArticleRollback,
            capabilities.SitePageEditor, capabilities.SiteConfigEditor, capabilities.OnlineAppearance], Assert.True);
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

    private static void AttachHttps(HttpRequestMessage request, string clientIp, string host = "blog.example.test")
    {
        request.Headers.Host = host;
        request.Headers.Add("X-Forwarded-Proto", "https");
        request.Headers.Add("X-Forwarded-For", clientIp);
    }

    [PostgresFact]
    public async Task ZeroConfigBootActivatesCapabilitiesAndExplicitFalseOverridesStayFailClosed()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (_, readerToken, _) = await fixture.SignInSiteUser("cap-reader", ct, minutes: 5);
        var dataDir = MediaFixture.CreateOwnedTemporaryDirectory("fsusblog-cap-data-");
        using var cleanup = new MediaFixture.DirectoryCleanup(dataDir);

        static void AttachPublicHttps(HttpRequestMessage request) => AttachHttps(request, "198.51.100.10");

        async Task<HttpResponseMessage> HttpsSend(HttpClient client, HttpMethod method, string route, string? cookie = null, string host = "blog.example.test")
        {
            using var req = new HttpRequestMessage(method, route);
            AttachHttps(req, "198.51.100.10", host);
            if (cookie is not null) req.Headers.Add("Cookie", cookie);
            return await client.SendAsync(req, ct);
        }

        await using (var enabled = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin.example.test",
            [SiteCapabilities.DataDirSetting] = dataDir.FullName,
        }, AttachPublicHttps))
        {
            Assert.All(["private-media", "public-media"], dir => Assert.True(Directory.Exists(Path.Combine(dataDir.FullName, dir))));

            var html = await OkString(HttpsSend(enabled.Client, HttpMethod.Get, "/"), ct);
            Assert.All([PublicHotArticles.PageMarker, ArticleReadEndpoints.PageMarker, DocumentExportEndpoints.Marker],
                marker => Assert.Contains(marker, html, StringComparison.Ordinal));
            Assert.DoesNotContain("fsus-public-search-mode", html, StringComparison.Ordinal);

            foreach (var route in new[] { WireRoutes.PasskeyAvailability, "/api/v2/identity/reader-registration/status.aeds", WireRoutes.SiteRefreshAvailability })
                await CheckStatusAsync(OK, HttpsSend(enabled.Client, HttpMethod.Get, route));

            var hotRoute = WireRoutes.PublicArticleHot.Replace("{size}", "10");
            HttpStatusCode hotStatus = ServiceUnavailable;
            for (var attempt = 0; attempt < 40 && hotStatus == ServiceUnavailable; attempt++)
            {
                using var resp = await HttpsSend(enabled.Client, HttpMethod.Get, hotRoute);
                hotStatus = resp.StatusCode;
                if (hotStatus == ServiceUnavailable) await Task.Delay(50, ct);
            }
            Assert.Equal(OK, hotStatus);

            using (var resp = Ok(await HttpsSend(enabled.Client, HttpMethod.Get, WireRoutes.InboxWriteAvailability, $"fsus-v2-session={readerToken}")))
                Assert.Equal("1", Assert.Single(resp.Headers.GetValues(WireHeaders.InboxWriteEnabled)));

            await CheckStatusAsync(OK, HttpsSend(enabled.Client, HttpMethod.Get, "/admin", host: "admin.example.test"));
        }

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
            var html = await OkString(HttpsSend(disabled.Client, HttpMethod.Get, "/"), ct);
            Assert.All([PublicHotArticles.PageMarker, ArticleReadEndpoints.PageMarker, DocumentExportEndpoints.Marker],
                marker => Assert.DoesNotContain(marker, html, StringComparison.Ordinal));
            Assert.Contains("name=\"fsus-public-search-mode\" content=\"server\"", html, StringComparison.Ordinal);

            foreach (var route in new[] { WireRoutes.PasskeyAvailability, "/api/v2/identity/reader-registration/status.aeds",
                WireRoutes.SiteRefreshAvailability, WireRoutes.PublicArticleHot.Replace("{size}", "10"), WireRoutes.PublicSearchWideManifest })
                await CheckStatusAsync(NotFound, HttpsSend(disabled.Client, HttpMethod.Get, route));

            using (var resp = Ok(await HttpsSend(disabled.Client, HttpMethod.Get, WireRoutes.InboxWriteAvailability, $"fsus-v2-session={readerToken}")))
                Assert.Equal("0", Assert.Single(resp.Headers.GetValues(WireHeaders.InboxWriteEnabled)));
            await CheckStatusAsync(NotFound, HttpsSend(disabled.Client, HttpMethod.Post, WireRoutes.InboxCreatePowChallenge));
        }
    }

    [PostgresFact]
    public async Task UnifiedSingleOriginIsolatesReaderAndAdminSessionsOnSameHost()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (_, readerToken, _) = await fixture.SignInSiteUser("single-origin-reader", ct, minutes: 5);
        var (_, adminToken, _) = await fixture.AdminAsync("single-origin-admin", 10, [1], [2]);

        const string clientIp = "198.51.100.20";
        var readerCookie = $"fsus-v2-session={readerToken}";
        var adminCookie = $"__Host-FsusAdminSession={adminToken}";
        var bothCookies = $"{readerCookie}; {adminCookie}";

        async Task ExpectGet(HttpClient client, string path, HttpStatusCode status, string? cookie = null,
            string host = "blog.example.test", Func<HttpContent, Task>? checkContent = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            AttachHttps(request, clientIp, host);
            if (cookie is not null) request.Headers.Add("Cookie", cookie);
            using var response = Expect(status, await client.SendAsync(request, ct));
            if (checkContent is not null) await checkContent(response.Content);
        }

        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
        }, req => AttachHttps(req, clientIp)))
        {
            await ExpectGet(server.Client, "/", OK);
            await ExpectGet(server.Client, "/admin", OK);
            await ExpectGet(server.Client, "/admin", NotFound, host: "other.example.test");

            await ExpectGet(server.Client, WireRoutes.Session, OK, bothCookies, checkContent: async content =>
            {
                var session = Wire.DecodeSession(await content.ReadAsByteArrayAsync(ct));
                Assert.Equal(("single-origin-reader", false), (session.Name, session.CanAuthor));
            });
            await ExpectGet(server.Client, WireRoutes.Session, Unauthorized, adminCookie);

            await ExpectGet(server.Client, WireRoutes.AuthoringSession, OK, bothCookies, checkContent: async content =>
            {
                var session = Wire.DecodeSession(await content.ReadAsByteArrayAsync(ct));
                Assert.Equal(("single-origin-admin", true), (session.Name, session.CanAuthor));
            });
            await ExpectGet(server.Client, WireRoutes.AuthoringSession, Unauthorized, readerCookie);
            await ExpectGet(server.Client, WireRoutes.AuthoringSession, NotFound, adminCookie, "other.example.test");

            await ExpectGet(server.Client, WireRoutes.AdminSession, OK, bothCookies, checkContent: async content =>
                Assert.Equal("single-origin-admin", Wire.DecodeAdminSessionSnapshot(await content.ReadAsByteArrayAsync(ct)).Handle));
            await ExpectGet(server.Client, WireRoutes.AdminSession, Unauthorized, readerCookie);
        }

        await using (var publicOnly = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true",
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "",
        }, req => AttachHttps(req, clientIp)))
        {
            await ExpectGet(publicOnly.Client, "/", OK);
            foreach (var blocked in new[] { "/admin", WireRoutes.AdminSession, WireRoutes.AuthoringSession })
                await ExpectGet(publicOnly.Client, blocked, NotFound, adminCookie);
        }
    }

    [Fact]
    public async Task ExplicitAdminClosureSkipsPasskeyParsingAndDomainStoresConstructWithoutPasskeyConfig()
    {
        var webDist = Path.Combine(Path.GetTempPath(), "fsusblog-cap-noadmin-" + Guid.NewGuid().ToString("N"));
        var c = SiteCapabilities.Resolve(BuildConfig(new()
        {
            [PublicSiteConfiguration.OriginKey] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = "",
            ["FSUSBLOG_ADMIN_RP_ID"] = "admin.example.test",
        }), webDist);

        Assert.Null(c.AdminIdentity);
        Assert.All([c.AdminArticleRollback, c.AdminCommentBatch, c.AdminInboxReplies, c.AdminTagMetadata, c.AdminCategoryMetadata], Assert.False);

        await using var dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=5432;Username=postgres;Database=postgres");
        var gate = new AdminSessionGate(dataSource, null);
        var stepUp = new AdminStepUpService(gate);
        _ = new object[]
        {
            new AdminOperationsStore(gate), new AdminSignInHistoryStore(gate), new AdminCommentQueueStore(gate),
            new AdminCommentHistoryStore(gate), new AdminTaxonomyStore(gate), new AdminTagMetadataStore(gate),
            new AdminInboxStore(gate), new AdminInboxReadStore(gate), new AdminInboxActivityStore(gate),
            new AdminInboxReplyStore(gate), new AdminInboxStatusStore(gate), new AdminInboxNoticeStore(gate),
            new AdminSitePageStore(gate), new AdminAppearanceStore(gate, stepUp), new AdminModerationStore(gate, stepUp),
            new AdminModerationBatchStore(gate, stepUp), new AdminCommentAppealStore(gate, stepUp), new AdminCommentRiskStore(gate, stepUp),
            new AdminArticleRollbackStore(gate, stepUp), new AdminArticleArchiveStore(gate, stepUp),
            new AdminArticleTrashRestoreStore(gate, stepUp), new AdminArticleTrashPublicationStore(gate, stepUp),
        };

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            stepUp.BeginModerationStepUp("session", new AdminModerationIntent(1, 1, 0, 1, "test"), CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            stepUp.CompleteModerationStepUp("session", new PasskeyLoginRequest("token", "id", [], [], [], [], [], false), CancellationToken.None));
    }

    private sealed class SiteFixtureDirectories(string dataPrefix, string webPrefix) : IDisposable
    {
        internal (DirectoryInfo Data, DirectoryInfo Web) Paths { get; } =
            (Directory.CreateTempSubdirectory(dataPrefix), Directory.CreateTempSubdirectory(webPrefix));

        public void Dispose()
        {
            Directory.Delete(Paths.Data.FullName, recursive: true);
            Directory.Delete(Paths.Web.FullName, recursive: true);
        }
    }
}
