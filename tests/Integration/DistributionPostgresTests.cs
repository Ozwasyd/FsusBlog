using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Xml.Linq;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using Microsoft.Extensions.Configuration;

public sealed class DistributionPostgresTests
{
    private const string Origin = "https://blog.example.test";
    private static readonly XNamespace Atom = "http://www.w3.org/2005/Atom";
    private static readonly XNamespace Sitemap = "http://www.sitemaps.org/schemas/sitemap/0.9";
    private static readonly string[] FeedPaths = ["/feed/rss.xml", "/api/Article/rss", "/feed/atom.xml", "/feed/feed.json", "/sitemap.xml"];

    [Theory]
    [InlineData("https://EXAMPLE.test:443/", "https://example.test")]
    [InlineData(" https://example.test:8443 ", "https://example.test:8443")]
    [InlineData("https://[2001:db8::7]:8443/", "https://[2001:db8::7]:8443")]
    [InlineData("https://bücher.example/", "https://xn--bcher-kva.example")]
    public void CanonicalOriginUsesNormalizedHttpsAuthority(string setting, string expected) =>
        Assert.Equal(expected, PublicSiteConfiguration.ParseOrigin(setting));

    [Theory]
    [InlineData("x")]
    [InlineData("http://example.test")]
    [InlineData("https://example.test:0")]
    [InlineData("https://example.test:99999")]
    [InlineData("https://user:password@example.test")]
    [InlineData("https://example.test/path/..")]
    [InlineData("https://example.test?#")]
    [InlineData("https://example.test?x=y")]
    [InlineData("https://example.test#fragment")]
    [InlineData("https://example.test\\")]
    [InlineData("https://example.test//")]
    [InlineData("https://example.test/%2e")]
    [InlineData("https://example.test\r\nheader")]
    public void UnsupportedOriginFailsAdmission(string setting) =>
        Assert.Throws<InvalidOperationException>(() => PublicSiteConfiguration.ParseOrigin(setting));

    [Fact]
    public void RootSitemapKeepsV1PageBoundaryAndCanonicalNumbers()
    {
        var paths = Enumerable.Range(1, DistributionSnapshot.SitemapPageSize + 1)
            .Select(id => new DistributionSnapshot.Location($"/article/{id}", DateTimeOffset.UnixEpoch)).ToArray();
        var compact = DistributionSnapshot.BuildSitemap(Origin, paths[..^1], CancellationToken.None);
        Assert.Empty(compact.Pages);
        Assert.Equal(DistributionSnapshot.SitemapPageSize, Parse(compact.Root).Root!.Elements(Sitemap + "url").Count());
        var split = DistributionSnapshot.BuildSitemap(Origin, paths, CancellationToken.None);
        Assert.Equal(new[] { Origin + "/sitemap/1.xml", Origin + "/sitemap/2.xml" },
            Parse(split.Root).Descendants(Sitemap + "loc").Select(x => x.Value));
        Assert.Equal(2, split.Pages.Length);
        Assert.Equal(DistributionSnapshot.SitemapPageSize, Parse(split.Pages[0]).Root!.Elements(Sitemap + "url").Count());
        Assert.Equal(Origin + "/article/45001", Assert.Single(Parse(split.Pages[1]).Descendants(Sitemap + "loc")).Value);
    }

    [Fact]
    public void AllFeedsLimitToFiftyOrderedPublicEntries()
    {
        var publishedAt = DateTimeOffset.UnixEpoch.AddDays(1);
        var rows = Enumerable.Range(1, 53).Select(id => new Article(id, 1, id, 1, 1, $"title {id}", "body",
            publishedAt, publishedAt, publishedAt)).ToArray();
        var site = PublicSiteConfiguration.Read(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { [PublicSiteConfiguration.OriginKey] = Origin }).Build());
        var feeds = DistributionSnapshot.Build(new(site, []), rows, CancellationToken.None)!;
        var expected = Enumerable.Range(4, 50).Reverse().Select(id => Origin + $"/article/{id}").ToArray();
        Assert.Equal(expected, Parse(feeds.Rss).Descendants("item").Select(item => item.Element("guid")!.Value));
        Assert.Equal(expected, Parse(feeds.Atom).Descendants(Atom + "entry").Select(item => item.Element(Atom + "id")!.Value));
        using var json = JsonDocument.Parse(feeds.Json);
        Assert.Equal(expected, json.RootElement.GetProperty("items").EnumerateArray().Select(item => item.GetProperty("url").GetString()));
    }

    [PostgresFact]
    public async Task DisabledDistributionDoesNotInferOriginFromRequests()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = deadline.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var server = await ServerProcess.Start(database.ConnectionString, ct, new Dictionary<string, string>
        {
            [PublicSiteConfiguration.OriginKey] = "", ["FSUSBLOG_SITE_PAGES"] = ""
        });
        foreach (var path in FeedPaths.Append("/sitemap/1.xml"))
        {
            using var response = await Read(server.Client, path, ct);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.False(response.Headers.Contains(WireHeaders.SearchIndexGeneration));
        }
        using var robots = await Read(server.Client, "/robots.txt", ct);
        Assert.Equal(HttpStatusCode.OK, robots.StatusCode);
        Assert.Equal("User-agent: *\nDisallow: /\n", await robots.Content.ReadAsStringAsync(ct));
        Assert.DoesNotContain("canonical", await server.Client.GetStringAsync("/", ct));
    }

    [PostgresFact]
    public async Task DistributionFollowsPublishedGenerationAndRemovesWithdrawnContent()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(35));
        var ct = deadline.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        var user = Guid.NewGuid();
        var secret = RandomNumberGenerator.GetBytes(32);
        await FixtureSql.ExecuteAsync(connection, null, ct, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,'distribution-author',true,true,1)", user);
        await FixtureSql.ExecuteAsync(connection, null, ct, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '1 minute')", SHA256.HashData(secret), user);
        await using (var catalog = Store.Sql(connection, null, """
            insert into public.category(id,name) values(11,'Published category'),(12,'Draft category');
            insert into public.tag(id,name) values(41,'Public tag'),(42,'Draft tag');
            insert into public.tag_url_name(name_key,tag_id) values('public tag',41),('public alias',41),('draft tag',42);
            """)) await catalog.ExecuteNonQueryAsync(ct);
        var actor = await new Store(database.DataSource).SignIn(Convert.ToHexStringLower(secret), ct);
        var site = Directory.CreateTempSubdirectory("fsusv2-distribution-pages-");
        try
        {
            // SitePages rejects symlinked ancestors. Canonicalize the system temp root on macOS.
            var path = OperatingSystem.IsMacOS() && (site.FullName.StartsWith("/var/", StringComparison.Ordinal) ||
                site.FullName.StartsWith("/tmp/", StringComparison.Ordinal)) ? "/private" + site.FullName : site.FullName;
            foreach (var slug in new[] { "about", "privacy", "guidelines", "copyright" })
                await File.WriteAllTextAsync(Path.Combine(path, slug + ".md"), $"Public {slug} body.", ct);
            await using var server = await ServerProcess.Start(database.ConnectionString, ct, new Dictionary<string, string>
            {
                [PublicSiteConfiguration.OriginKey] = Origin, ["FSUSBLOG_SITE_PAGES"] = path
            });
            var client = server.Client;
            const string title = "Visible <em>Title</em> & 世界";
            const string publicSummary = "Prefix <script>alert(123)</script> & literal \u0001 value";
            const string unpublished = "DRAFT_ONLY_HIDDEN_PAYLOAD";
            var draft = await Command(WireRoutes.Save, new(0, 0, Guid.NewGuid(), title, publicSummary));
            var privateArticle = await Command(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Other private draft", unpublished));
            var assigned = await Assign(draft, 11, 41);
            await Assign(privateArticle, 12, 42);
            var articlePath = $"/article/{draft.Id}";
            var articleUrl = Origin + articlePath;
            var before = await CurrentGeneration();
            await Absent(articleUrl, title);

            var published = await Command(WireRoutes.Publish, new(draft.Id, assigned.Revision, Guid.NewGuid(), "", ""));
            var generation = await CurrentGeneration();
            Assert.NotEqual(before, generation);
            var rss = await Artifact(FeedPaths[0], "application/rss+xml", generation);
            Assert.Equal(rss, await Artifact(FeedPaths[1], "application/rss+xml", generation));
            var item = Assert.Single(XDocument.Parse(rss).Descendants("item"));
            Assert.Equal(title, item.Element("title")!.Value);
            Assert.Equal(articleUrl, item.Element("guid")!.Value);
            Assert.Contains("&lt;script&gt;", item.Element("description")!.Value);
            Assert.DoesNotContain("<script>", rss);
            Assert.DoesNotContain('\u0001', rss);
            var atom = XDocument.Parse(await Artifact(FeedPaths[2], "application/atom+xml", generation));
            Assert.Equal(articleUrl, Assert.Single(atom.Descendants(Atom + "entry")).Element(Atom + "id")!.Value);
            Assert.DoesNotContain(atom.Descendants(), node => node.Name.LocalName == "script");
            Assert.Contains("\uFFFD", Assert.Single(atom.Descendants(Atom + "summary")).Value);
            var json = await Artifact(FeedPaths[3], "application/feed+json", generation);
            Assert.DoesNotContain("<script>", json);
            using (var feed = JsonDocument.Parse(json))
            {
                var article = Assert.Single(feed.RootElement.GetProperty("items").EnumerateArray());
                Assert.Equal(articleUrl, article.GetProperty("url").GetString());
                Assert.True(article.TryGetProperty("content_text", out var text));
                Assert.Contains("<script>", text.GetString());
                Assert.False(article.TryGetProperty("content_html", out _));
            }
            var sitemap = XDocument.Parse(await Artifact(FeedPaths[4], "application/xml", generation));
            Assert.Equal(new[] { "/", "/archive", "/about", "/privacy", "/guidelines", "/copyright", articlePath, "/category/11", "/tag/41" }
                .Select(value => Origin + value), sitemap.Descendants(Sitemap + "loc").Select(value => value.Value));
            var robots = await Artifact("/robots.txt", "text/plain", generation);
            Assert.Contains("Disallow: /api/", robots);
            Assert.Contains($"Sitemap: {Origin}/sitemap.xml", robots);
            using var noPage = await Read(client, "/sitemap/1.xml", ct);
            Assert.Equal(HttpStatusCode.NotFound, noPage.StatusCode);
            using var head = await Read(client, "/feed/rss.xml", ct, head: true);
            Assert.Equal(HttpStatusCode.OK, head.StatusCode);
            Assert.Equal(generation, Assert.Single(head.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
            Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));
            foreach (var pathUnderOrigin in new[] { "/", "/archive", "/about", articlePath, "/tag/41", "/category/11" })
            {
                using var response = await Read(client, pathUnderOrigin, ct);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                var html = await response.Content.ReadAsStringAsync(ct);
                Assert.Contains($"rel=\"canonical\" href=\"{Origin}{pathUnderOrigin}\"", html);
                Assert.Contains("type=\"application/rss+xml\"", html);
                Assert.DoesNotContain("forged.example", html);
            }

            var saved = await Command(WireRoutes.Save, new(published.Id, published.Revision, Guid.NewGuid(), "New private draft", unpublished));
            Assert.Equal(generation, await CurrentGeneration());
            Assert.Equal(rss, await Artifact(FeedPaths[0], "application/rss+xml", generation));
            var republished = await Command(WireRoutes.Publish, new(saved.Id, saved.Revision, Guid.NewGuid(), "", ""));
            var nextGeneration = await CurrentGeneration();
            Assert.NotEqual(generation, nextGeneration);
            using (var latest = JsonDocument.Parse(await client.GetStringAsync(FeedPaths[3], ct)))
                Assert.Equal(unpublished, Assert.Single(latest.RootElement.GetProperty("items").EnumerateArray()).GetProperty("content_text").GetString());
            await Command(WireRoutes.Retract, new(republished.Id, republished.Revision, Guid.NewGuid(), "", ""));
            Assert.NotEqual(generation, await CurrentGeneration());
            await Absent(articleUrl, title);
            var after = await client.GetStringAsync("/sitemap.xml", ct);
            Assert.DoesNotContain("/category/11", after);
            Assert.DoesNotContain("/tag/41", after);
            using var gone = await Read(client, articlePath, ct);
            Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);

            await using (var lease = Store.Sql(connection, null, """
                select pg_terminate_backend(pid, 3000) from pg_locks
                where locktype='advisory' and database=(select oid from pg_database where datname=current_database())
                    and objsubid=1 and ((classid::bigint << 32) | objid::bigint)=$1 and mode='ExclusiveLock' and granted
                """, InstanceLease.OwnershipKey)) Assert.True((bool)(await lease.ExecuteScalarAsync(ct))!);
            for (var check = 0; check < 100; check++)
            {
                using var ready = await client.GetAsync("/health/ready", ct);
                if (ready.StatusCode == HttpStatusCode.ServiceUnavailable) break;
                await Task.Delay(20, ct);
            }
            foreach (var route in FeedPaths.Append("/robots.txt"))
            {
                using var response = await Read(client, route, ct);
                Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.False(response.Headers.Contains(WireHeaders.SearchIndexGeneration));
            }

            async Task<Draft> Command(string route, ArticleCommand command)
            {
                using var response = await Mutation(route, Wire.EncodeArticleCommand(command));
                return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
            }

            async Task<DraftTaxonomy> Assign(Draft draftValue, int category, int tag)
            {
                using var result = await Mutation(WireRoutes.TaxonomyAssignment,
                    Wire.EncodeTaxonomyAssignment(new(draftValue.Id, draftValue.Revision, Guid.NewGuid(), category, [tag])));
                return Wire.DecodeDraftTaxonomy(await result.Content.ReadAsByteArrayAsync(ct));
            }

            async Task<HttpResponseMessage> Mutation(string route, byte[] frame)
            {
                using var request = SiteAedsFixture.Request(HttpMethod.Post, route, frame, actor.Token, handle: null);
                var response = await client.SendAsync(request, ct);
                response.EnsureSuccessStatusCode();
                return response;
            }

            async Task<string> CurrentGeneration()
            {
                using var response = await Read(client, WireRoutes.PublicIndex, ct);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                return Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            }

            async Task<string> Artifact(string route, string mediaType, string expectedGeneration)
            {
                using var response = await Read(client, route, ct);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                Assert.True(response.Headers.CacheControl?.NoStore);
                Assert.Equal(mediaType, response.Content.Headers.ContentType!.MediaType);
                Assert.Equal(expectedGeneration, Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
                var rendered = await response.Content.ReadAsStringAsync(ct);
                Assert.DoesNotContain(unpublished, rendered);
                Assert.DoesNotContain("forged.example", rendered);
                return rendered;
            }

            async Task Absent(string uri, string name)
            {
                foreach (var route in FeedPaths)
                {
                    var body = await client.GetStringAsync(route, ct);
                    Assert.DoesNotContain(unpublished, body);
                    if (route == DistributionSnapshot.JsonPath)
                    {
                        using var feed = JsonDocument.Parse(body);
                        Assert.Empty(feed.RootElement.GetProperty("items").EnumerateArray());
                    }
                    else
                    {
                        Assert.DoesNotContain(XDocument.Parse(body).Descendants(), element =>
                            element.Value == uri || element.Value == name || element.Value == Origin + "/category/12" || element.Value == Origin + "/tag/42");
                    }
                }
            }
        }
        finally { site.Delete(recursive: true); }
    }

    private static async Task<HttpResponseMessage> Read(HttpClient client, string path, CancellationToken ct, bool head = false)
    {
        using var request = new HttpRequestMessage(head ? HttpMethod.Head : HttpMethod.Get, path);
        request.Headers.Host = "forged.example";
        request.Headers.TryAddWithoutValidation("If-None-Match", "\"previous-generation\"");
        return await client.SendAsync(request, ct);
    }

    private static XDocument Parse(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        return XDocument.Load(stream);
    }
}
