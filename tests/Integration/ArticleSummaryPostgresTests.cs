using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ArticleSummaryPostgresTests
{
    [PostgresFact]
    public async Task SummaryUsesTheOwnedSavedRevisionAndPublishesOnlyItsImmutableValue()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        var store = new Store(db.DataSource);
        var owner = await SignIn("Summary owner");
        var stranger = await SignIn("Summary stranger");
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);

        const string title = "Draft title";
        const string body = "body-prefix-fallback 中文";
        const string marker = "summaryonlyword";
        const string manual = "🧭 e\u0301\r\n" + marker + " 二行";
        var first = await Change(ArticleAction.Save, 0, 0, title, body);
        Assert.Equal(new ArticleSummary(first.Id, first.Revision, ""), await Read(first.Id, first.Revision));

        var command = new ArticleSummaryCommand(first.Id, first.Revision, Guid.NewGuid(), "  " + manual + " \n");
        var packet = Wire.EncodeArticleSummaryCommand(command);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet, HttpStatusCode.NotFound, stranger);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet, HttpStatusCode.Conflict, owner with { Handle = null });
        var saved = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet));
        Assert.Equal(new Draft(first.Id, first.Revision + 1, title, body, false), saved);
        Assert.Equal(packet, Wire.EncodeArticleSummaryCommand(Wire.DecodeArticleSummaryCommand(packet)));
        Assert.Equal(saved, Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet)));
        Assert.Equal(new ArticleSummary(saved.Id, saved.Revision, manual), await Read(saved.Id, saved.Revision));
        await Send(HttpMethod.Get, SummaryUrl(saved.Id, first.Revision), null, HttpStatusCode.Conflict);
        await Send(HttpMethod.Get, SummaryUrl(saved.Id, saved.Revision), null, HttpStatusCode.NotFound, stranger);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(command with { Text = "changed" }),
            HttpStatusCode.Conflict);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(command with { IdempotencyKey = Guid.NewGuid() }),
            HttpStatusCode.Conflict);
        Assert.Equal(1, await Count("title-summary"));
        Assert.Equal(0, await Count("title"));
        Assert.DoesNotContain(marker, await PublicIndex());

        var qualified = new AuthorTextQualifiedQuery($"field.summary:{marker.ToUpperInvariant()}", "", null, null, 0, []);
        var found = await Search(qualified);
        Assert.Equal(1, found.Total);
        Assert.Equal(new[] { 1, 0, 0, 0 }, found.StateCounts);
        var hit = Assert.Single(found.Rows);
        var start = manual.IndexOf(marker, StringComparison.Ordinal);
        Assert.Equal((saved.Id, saved.Revision, 3), (hit.Id, hit.Revision, hit.Field));
        Assert.Equal(marker, hit.Snippet[hit.HighlightStart..hit.HighlightEnd]);
        Assert.Equal((start, start + marker.Length), (hit.SourceStart, hit.SourceEnd));
        Assert.Equal((Encoding.UTF8.GetByteCount(manual[..start]), Encoding.UTF8.GetByteCount(manual[..(start + marker.Length)])),
            (hit.SourceByteStart, hit.SourceByteEnd));
        Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(manual)), hit.SourceDigest);
        var unscoped = Assert.Single((await Search(qualified with { Query = marker })).Rows);
        Assert.Equal(hit.SourceDigest, unscoped.SourceDigest);
        Assert.Equal(hit, unscoped with { SourceDigest = hit.SourceDigest });
        Assert.Empty((await Search(qualified, caller: stranger)).Rows);
        Assert.Empty((await Search(qualified with { UpdatedFromUnixMs = DateTimeOffset.MaxValue.ToUnixTimeMilliseconds() })).Rows);
        var olderBodyOnly = Wire.DecodeAuthorTextFacetedPage(await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch,
            Wire.EncodeAuthorTextFacetedQuery(new(marker, ""))));
        Assert.True(olderBodyOnly.Ready);
        Assert.Empty(olderBodyOnly.Rows);
        await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch,
            Wire.EncodeAuthorTextFacetedQuery(new(qualified.Query, "")), HttpStatusCode.BadRequest);
        Assert.Empty((await Search(qualified with { Query = "field.summary:body-prefix-fallback" })).Rows);

        var edited = await Change(ArticleAction.Save, saved.Id, saved.Revision, title, body + " second source");
        Assert.Equal(manual, (await Read(edited.Id, edited.Revision)).Text);
        var published = await Change(ArticleAction.Publish, edited.Id, edited.Revision);
        await WaitForIndex(marker, "next-summary");
        Assert.Equal(published.Revision, Assert.Single((await Search(qualified with { Query = qualified.Query + " status:published" })).Rows).Revision);

        var revised = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(
            new(published.Id, published.Revision, Guid.NewGuid(), "next-summary"))));
        Assert.Equal("next-summary", (await Read(revised.Id, revised.Revision)).Text);
        var summaryBase = SummaryUrl(revised.Id, revised.Revision);
        var historical = $"{summaryBase}&sourceRevision={saved.Revision}";
        var earlier = Wire.DecodeArticleSummary(await Send(HttpMethod.Get, historical));
        Assert.Equal(new ArticleSummary(saved.Id, saved.Revision, manual), earlier);
        Assert.Equal(hit.SourceDigest, SHA256.HashData(Encoding.UTF8.GetBytes(earlier.Text)));
        await Send(HttpMethod.Get, historical, status: HttpStatusCode.NotFound, caller: stranger);
        await Send(HttpMethod.Get, historical, status: HttpStatusCode.Conflict, caller: owner with { Handle = stranger.Handle });
        foreach (var invalid in new[] { "", "0", $"0{saved.Revision}", revised.Revision.ToString(),
            (revised.Revision + 1).ToString(), $"{saved.Revision}&sourceRevision={saved.Revision}" })
            await Send(HttpMethod.Get, $"{summaryBase}&sourceRevision={invalid}", status: HttpStatusCode.BadRequest);
        await WaitForIndex(marker, "next-summary");
        Assert.Empty((await Search(qualified)).Rows);

        var restored = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.DraftRollback,
            Wire.EncodeDraftRollback(new(revised.Id, revised.Revision, saved.Revision, Guid.NewGuid(), "Restore saved summary"))));
        await Send(HttpMethod.Get, historical, status: HttpStatusCode.Conflict);
        Assert.Equal((body, manual), (restored.Body, (await Read(restored.Id, restored.Revision)).Text));
        Assert.Equal(restored.Revision, Assert.Single((await Search(qualified)).Rows).Revision);

        var cleared = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(
            new(restored.Id, restored.Revision, Guid.NewGuid(), " \t\r\n "))));
        Assert.Equal("", (await Read(cleared.Id, cleared.Revision)).Text);
        Assert.Equal(0, await Count("title-summary"));
        Assert.Empty((await Search(qualified)).Rows);
        await Change(ArticleAction.Publish, cleared.Id, cleared.Revision);
        await WaitForIndex("body-prefix-fallback", marker);

        var titleMatch = await Change(ArticleAction.Save, 0, 0, "sharedrank in the title", "Different body");
        var summaryAndBody = await Change(ArticleAction.Save, 0, 0, "Match in two fields", "sharedrank in the body");
        var summaryMatch = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave,
            Wire.EncodeArticleSummaryCommand(new(summaryAndBody.Id, summaryAndBody.Revision, Guid.NewGuid(), "sharedrank in the summary"))));
        var bodyMatch = await Change(ArticleAction.Save, 0, 0, "Only in body", "sharedrank at the end");
        var rankedMatches = (await Search(qualified with { Query = "sharedrank" })).Rows;
        Assert.Equal(new[] { (titleMatch.Id, 1), (summaryMatch.Id, 3), (bodyMatch.Id, 2) }, rankedMatches.Select(row => (row.Id, row.Field)));

        var pageDrafts = new List<Draft>();
        const string pagingSummary = "private–summary pagingphrase";
        for (var i = 0; i <= WireLimits.AuthorTextSearchRows; i++)
        {
            var draft = await Change(ArticleAction.Save, 0, 0, $"Page {i + 1}", "Different body");
            pageDrafts.Add(Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave,
                Wire.EncodeArticleSummaryCommand(new(draft.Id, draft.Revision, Guid.NewGuid(), pagingSummary)))));
        }
        var clause = qualified with { Query = "field.summary:pagingphrase" };
        var pending = Wire.DecodeAuthorTextSummaryPage(await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch,
            Wire.EncodeAuthorTextSummaryQuery(clause)));
        Assert.False(pending.Ready);
        Assert.Empty(pending.Rows);
        var firstPage = await Search(clause);
        Assert.Equal(pageDrafts.Count, firstPage.Total);
        Assert.Equal(WireLimits.AuthorTextSearchRows, firstPage.Rows.Count);
        var continuation = clause with { Cursor = firstPage.NextCursor };
        var tail = await Search(continuation);
        Assert.Equal(firstPage.Total, tail.Total);
        Assert.Equal(pageDrafts.Select(row => row.Id).Order(), firstPage.Rows.Concat(tail.Rows).Select(row => row.Id).Order());
        Assert.All(firstPage.Rows.Concat(tail.Rows), row => Assert.Equal(3, row.Field));
        var last = Assert.Single(tail.Rows);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(
            new(last.Id, last.Revision, Guid.NewGuid(), "Other summary")));
        await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextSummaryQuery(continuation), HttpStatusCode.Conflict);
        Assert.Equal(pageDrafts.Count - 1, (await Search(clause)).Total);

        const string headingMarker = "headinguniqueword";
        const string setextMarker = "setextuniqueword";
        const string headingBody = "\uFEFF首行 🧭\r\n\r\n## " + headingMarker + " **sharedrank** crossover tail\r\n" +
            "\r\nstart gap " + setextMarker + "\r\n------------------------\r\n\r\n```md\r\n# headingfencedonly\r\n```\r\n";
        var headingDraft = await Change(ArticleAction.Save, 0, 0, "Heading fixture", headingBody);
        foreach (var word in new[] { headingMarker, setextMarker })
        {
            var row = Assert.Single((await Search(qualified with { Query = $"FIELD.HEADING:{word}" }, headings: true)).Rows);
            var offset = headingBody.IndexOf(word, StringComparison.Ordinal);
            Assert.Equal((headingDraft.Id, headingDraft.Revision, 4), (row.Id, row.Revision, row.Field));
            Assert.Equal(word, row.Snippet[row.HighlightStart..row.HighlightEnd]);
            Assert.Equal((offset, offset + word.Length), (row.SourceStart, row.SourceEnd));
            Assert.Equal((Encoding.UTF8.GetByteCount(headingBody[..offset]), Encoding.UTF8.GetByteCount(headingBody[..(offset + word.Length)])),
                (row.SourceByteStart, row.SourceByteEnd));
            Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(headingBody)), row.SourceDigest);
        }
        Assert.Empty((await Search(qualified with { Query = $"field.heading:{headingMarker}" }, stranger, headings: true)).Rows);
        Assert.Empty((await Search(qualified with { Query = "field.heading:headingfencedonly" }, headings: true)).Rows);
        Assert.Empty((await Search(qualified with { Query = "field.heading:\"tail start\"" }, headings: true)).Rows);
        Assert.Equal(headingDraft.Id,
            Assert.Single((await Search(qualified with { Query = "field.heading:\"crossover tail\"" }, headings: true)).Rows).Id);
        Assert.Equal(2, Assert.Single((await Search(qualified with { Query = "field.markdown-body:headingfencedonly" }, headings: true)).Rows).Field);
        Assert.Equal(2, Assert.Single((await Search(qualified with { Query = headingMarker })).Rows).Field);
        Assert.Equal(new[] { (titleMatch.Id, 1), (headingDraft.Id, 4), (summaryMatch.Id, 3), (bodyMatch.Id, 2) },
            (await Search(qualified with { Query = "sharedrank" }, headings: true)).Rows.Select(row => (row.Id, row.Field)));

        var nextHeading = await Change(ArticleAction.Save, headingDraft.Id, headingDraft.Revision, "Heading fixture", "# newerheading");
        Assert.Empty((await Search(qualified with { Query = $"field.heading:{headingMarker}" }, headings: true)).Rows);
        Assert.Equal(nextHeading.Revision,
            Assert.Single((await Search(qualified with { Query = "field.heading:newerheading" }, headings: true)).Rows).Revision);

        var complexDraft = await Change(ArticleAction.Save, 0, 0, "Bounded parser complex body", new string('\n', 4_096) + "complexbodymarker");
        await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextHeadingQuery(qualified with { Query = "field.heading:newerheading" }),
            HttpStatusCode.UnprocessableEntity);
        Assert.Equal(complexDraft.Id, Assert.Single((await Search(qualified with { Query = "complexbodymarker" })).Rows).Id);

        async Task<int> Count(string match)
        {
            var frame = await Send(HttpMethod.Get, $"{WireRoutes.AuthorArticles}?match={match}&keyword={marker}");
            return BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(frame, FrameType.AuthorArticlePage));
        }

        async Task<ArticleSummary> Read(int id, long revision) =>
            Wire.DecodeArticleSummary(await Send(HttpMethod.Get, SummaryUrl(id, revision)));

        async Task<AuthorTextFacetedPage> Search(AuthorTextQualifiedQuery input, Actor? caller = null, bool headings = false)
        {
            for (var attempt = 0; attempt < 5; attempt++)
            {
                var query = headings ? Wire.EncodeAuthorTextHeadingQuery(input) : Wire.EncodeAuthorTextSummaryQuery(input);
                var frame = await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch, query, caller: caller);
                var result = headings ? Wire.DecodeAuthorTextHeadingPage(frame) : Wire.DecodeAuthorTextSummaryPage(frame);
                if (result.Ready) return result;
            }
            throw new InvalidOperationException("The summary fixture did not reconcile within five bounded batches.");
        }

        async Task<ArticleState> Change(ArticleAction action, int id, long revision, string nextTitle = "", string nextBody = "") =>
            (await store.WithSession(owner.Token, true, (conn, tx, actor) => Store.Execute(conn, tx, actor, action,
                new(id, revision, Guid.NewGuid(), nextTitle, nextBody), ct), ct)).Article;

        async Task<string> PublicIndex()
        {
            using var response = await server.Client.GetAsync(WireRoutes.PublicIndex, ct);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.ServiceUnavailable) return "";
            response.EnsureSuccessStatusCode();
            return Encoding.UTF8.GetString(await response.Content.ReadAsByteArrayAsync(ct));
        }

        async Task WaitForIndex(string present, string absent)
        {
            for (var attempt = 0; attempt < 80; attempt++)
            {
                var observed = await PublicIndex();
                if (observed.Contains(present, StringComparison.Ordinal) && !observed.Contains(absent, StringComparison.Ordinal)) return;
                await Task.Delay(100, ct);
            }
            throw new InvalidOperationException($"Published index never returned the expected summary {present}.");
        }

        Task<byte[]> Send(HttpMethod method, string route, byte[]? frame = null, HttpStatusCode status = HttpStatusCode.OK,
            Actor? caller = null)
        {
            caller ??= owner;
            return SiteAedsFixture.ExpectPrivate(server.Client, method, route, frame, caller.Token, caller.Handle, status, ct);
        }

        async Task<Actor> SignIn(string name)
        {
            var (_, token, handle) = await db.SignIn(name, ct);
            return new(token, handle);
        }
    }

    private static string SummaryUrl(int id, long revision) => $"{WireRoutes.ArticleSummary.Replace("{id:int}", id.ToString(), StringComparison.Ordinal)}?revision={revision}";

    private sealed record Actor(string Token, string? Handle);
}
