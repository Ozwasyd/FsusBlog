namespace FsusBlog.V2.Integration.Tests;

public sealed class ArticleSummaryPostgresTests
{
    [PostgresFact]
    public async Task SummaryUsesTheOwnedSavedRevisionAndPublishesOnlyItsImmutableValue()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        var store = new Store(db.DataSource);
        var owner = await db.SignIn("Summary owner", ct);
        var stranger = await db.SignIn("Summary stranger", ct);
        var readOnlyAdmin = await db.SignIn("Summary read-only", ct, canAuthor: false);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);

        const string title = "Draft title", body = "body-prefix-fallback 中文", marker = "summaryonlyword";
        const string manual = "🧭 e\u0301\r\n" + marker + " 二行";
        var first = await Change(ArticleAction.Save, 0, 0, title, body);
        Assert.Equal(new ArticleSummary(first.Id, first.Revision, ""), await Read(first.Id, first.Revision));

        var command = new ArticleSummaryCommand(first.Id, first.Revision, Guid.NewGuid(), "  " + manual + " \n");
        var packet = Wire.EncodeArticleSummaryCommand(command);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet, Unauthorized, (readOnlyAdmin.Token, readOnlyAdmin.Handle));
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(command with { Id = 999_999 }), NotFound, (stranger.Token, stranger.Handle));
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet, Conflict, (owner.Token, null));
        var saved = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet));
        Assert.Equal(new Draft(first.Id, first.Revision + 1, title, body, false), saved);
        Assert.Equal(packet, Wire.EncodeArticleSummaryCommand(Wire.DecodeArticleSummaryCommand(packet)));
        Assert.Equal(saved, Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet)));
        Assert.Equal(new ArticleSummary(saved.Id, saved.Revision, manual), await Read(saved.Id, saved.Revision));
        await Send(HttpMethod.Get, SummaryUrl(saved.Id, first.Revision), null, Conflict);
        await Send(HttpMethod.Get, SummaryUrl(saved.Id, saved.Revision), null, NotFound, (stranger.Token, stranger.Handle));
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(command with { Text = "changed" }), Conflict);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(command with { IdempotencyKey = Guid.NewGuid() }), Conflict);
        Assert.Equal((1, 0), (await Count("title-summary"), await Count("title")));
        Assert.DoesNotContain(marker, await PublicIndex());

        var qualified = new AuthorTextQualifiedQuery($"field.summary:{marker.ToUpperInvariant()}", "", null, null, 0, []);
        var found = await Search(qualified);
        Assert.Equal(1, found.Total);
        Assert.Equal(new[] { 1, 0, 0, 0 }, found.StateCounts);
        var hit = Assert.Single(found.Rows);
        var start = manual.IndexOf(marker, StringComparison.Ordinal);
        Assert.Equal((saved.Id, saved.Revision, 3, marker, start, start + marker.Length,
            Encoding.UTF8.GetByteCount(manual[..start]), Encoding.UTF8.GetByteCount(manual[..(start + marker.Length)])),
            (hit.Id, hit.Revision, hit.Field, hit.Snippet[hit.HighlightStart..hit.HighlightEnd],
                hit.SourceStart, hit.SourceEnd, hit.SourceByteStart, hit.SourceByteEnd));
        Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(manual)), hit.SourceDigest);
        var unscoped = Assert.Single((await Search(qualified with { Query = marker })).Rows);
        Assert.Equal(hit.SourceDigest, unscoped.SourceDigest);
        Assert.Equal(hit, unscoped with { SourceDigest = hit.SourceDigest });
        Assert.Empty((await Search(qualified, caller: (stranger.Token, stranger.Handle))).Rows);
        Assert.Empty((await Search(qualified with { UpdatedFromUnixMs = DateTimeOffset.MaxValue.ToUnixTimeMilliseconds() })).Rows);
        var olderBodyOnly = Wire.DecodeAuthorTextFacetedPage(await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch,
            Wire.EncodeAuthorTextFacetedQuery(new(marker, ""))));
        Assert.True(olderBodyOnly.Ready);
        Assert.Empty(olderBodyOnly.Rows);
        await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextFacetedQuery(new(qualified.Query, "")), BadRequest);
        Assert.Empty((await Search(qualified with { Query = "field.summary:body-prefix-fallback" })).Rows);

        var edited = await Change(ArticleAction.Save, saved.Id, saved.Revision, title, body + " second source");
        Assert.Equal(manual, (await Read(edited.Id, edited.Revision)).Text);
        var published = await Change(ArticleAction.Publish, edited.Id, edited.Revision);
        await WaitForIndex(marker, "next-summary");
        Assert.Equal(published.Revision, Assert.Single((await Search(qualified with { Query = qualified.Query + " status:published" })).Rows).Revision);

        var revised = await SaveSummary(published.Id, published.Revision, "next-summary");
        Assert.Equal("next-summary", (await Read(revised.Id, revised.Revision)).Text);
        var summaryBase = SummaryUrl(revised.Id, revised.Revision);
        var historical = $"{summaryBase}&sourceRevision={saved.Revision}";
        var earlier = Wire.DecodeArticleSummary(await Send(HttpMethod.Get, historical));
        Assert.Equal(new ArticleSummary(saved.Id, saved.Revision, manual), earlier);
        Assert.Equal(hit.SourceDigest, SHA256.HashData(Encoding.UTF8.GetBytes(earlier.Text)));
        await Send(HttpMethod.Get, historical, status: NotFound, caller: (stranger.Token, stranger.Handle));
        await Send(HttpMethod.Get, historical, status: Conflict, caller: (owner.Token, stranger.Handle));
        foreach (var invalid in new[] { "", "0", $"0{saved.Revision}", revised.Revision.ToString(),
            (revised.Revision + 1).ToString(), $"{saved.Revision}&sourceRevision={saved.Revision}" })
            await Send(HttpMethod.Get, $"{summaryBase}&sourceRevision={invalid}", status: BadRequest);
        await WaitForIndex(marker, "next-summary");
        Assert.Empty((await Search(qualified)).Rows);

        var restored = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.DraftRollback,
            Wire.EncodeDraftRollback(new(revised.Id, revised.Revision, saved.Revision, Guid.NewGuid(), "Restore saved summary"))));
        await Send(HttpMethod.Get, historical, status: Conflict);
        Assert.Equal((body, manual), (restored.Body, (await Read(restored.Id, restored.Revision)).Text));
        Assert.Equal(restored.Revision, Assert.Single((await Search(qualified)).Rows).Revision);

        var cleared = await SaveSummary(restored.Id, restored.Revision, " \t\r\n ");
        Assert.Equal(("", 0), ((await Read(cleared.Id, cleared.Revision)).Text, await Count("title-summary")));
        Assert.Empty((await Search(qualified)).Rows);
        await Change(ArticleAction.Publish, cleared.Id, cleared.Revision);
        await WaitForIndex("body-prefix-fallback", marker);

        var titleMatch = await Change(ArticleAction.Save, 0, 0, "sharedrank in the title", "Different body");
        var summaryAndBody = await Change(ArticleAction.Save, 0, 0, "Match in two fields", "sharedrank in the body");
        var summaryMatch = await SaveSummary(summaryAndBody.Id, summaryAndBody.Revision, "sharedrank in the summary");
        var bodyMatch = await Change(ArticleAction.Save, 0, 0, "Only in body", "sharedrank at the end");
        Assert.Equal(new[] { (titleMatch.Id, 1), (summaryMatch.Id, 3), (bodyMatch.Id, 2) },
            (await Search(qualified with { Query = "sharedrank" })).Rows.Select(row => (row.Id, row.Field)));

        var pageDrafts = new List<Draft>();
        const string pagingSummary = "private–summary pagingphrase";
        for (var i = 0; i <= WireLimits.AuthorTextSearchRows; i++)
        {
            var draft = await Change(ArticleAction.Save, 0, 0, $"Page {i + 1}", "Different body");
            pageDrafts.Add(await SaveSummary(draft.Id, draft.Revision, pagingSummary));
        }
        var clause = qualified with { Query = "field.summary:pagingphrase" };
        var pending = Wire.DecodeAuthorTextSummaryPage(await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextSummaryQuery(clause)));
        Assert.False(pending.Ready);
        Assert.Empty(pending.Rows);
        var firstPage = await Search(clause);
        Assert.Equal((pageDrafts.Count, WireLimits.AuthorTextSearchRows), (firstPage.Total, firstPage.Rows.Count));
        var continuation = clause with { Cursor = firstPage.NextCursor };
        var tail = await Search(continuation);
        Assert.Equal(firstPage.Total, tail.Total);
        Assert.Equal(pageDrafts.Select(row => row.Id).Order(), firstPage.Rows.Concat(tail.Rows).Select(row => row.Id).Order());
        Assert.All(firstPage.Rows.Concat(tail.Rows), row => Assert.Equal(3, row.Field));
        var last = Assert.Single(tail.Rows);
        await SaveSummary(last.Id, last.Revision, "Other summary");
        await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextSummaryQuery(continuation), Conflict);
        Assert.Equal(pageDrafts.Count - 1, (await Search(clause)).Total);

        const string headingMarker = "headinguniqueword", setextMarker = "setextuniqueword";
        const string headingBody = "\uFEFF首行 🧭\r\n\r\n## " + headingMarker + " **sharedrank** crossover tail\r\n" +
            "\r\nstart gap " + setextMarker + "\r\n------------------------\r\n\r\n```md\r\n# headingfencedonly\r\n```\r\n";
        var headingDraft = await Change(ArticleAction.Save, 0, 0, "Heading fixture", headingBody);
        foreach (var word in new[] { headingMarker, setextMarker })
        {
            var row = Assert.Single((await Search(qualified with { Query = $"FIELD.HEADING:{word}" }, headings: true)).Rows);
            var offset = headingBody.IndexOf(word, StringComparison.Ordinal);
            Assert.Equal((headingDraft.Id, headingDraft.Revision, 4, word, offset, offset + word.Length,
                Encoding.UTF8.GetByteCount(headingBody[..offset]), Encoding.UTF8.GetByteCount(headingBody[..(offset + word.Length)])),
                (row.Id, row.Revision, row.Field, row.Snippet[row.HighlightStart..row.HighlightEnd],
                    row.SourceStart, row.SourceEnd, row.SourceByteStart, row.SourceByteEnd));
            Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(headingBody)), row.SourceDigest);
        }
        Assert.Empty((await Search(qualified with { Query = $"field.heading:{headingMarker}" }, (stranger.Token, stranger.Handle), headings: true)).Rows);
        Assert.Empty((await Search(qualified with { Query = "field.heading:headingfencedonly" }, headings: true)).Rows);
        Assert.Empty((await Search(qualified with { Query = "field.heading:\"tail start\"" }, headings: true)).Rows);
        Assert.Equal(headingDraft.Id, Assert.Single((await Search(qualified with { Query = "field.heading:\"crossover tail\"" }, headings: true)).Rows).Id);
        Assert.Equal(2, Assert.Single((await Search(qualified with { Query = "field.markdown-body:headingfencedonly" }, headings: true)).Rows).Field);
        Assert.Equal(2, Assert.Single((await Search(qualified with { Query = headingMarker })).Rows).Field);
        Assert.Equal(new[] { (titleMatch.Id, 1), (headingDraft.Id, 4), (summaryMatch.Id, 3), (bodyMatch.Id, 2) },
            (await Search(qualified with { Query = "sharedrank" }, headings: true)).Rows.Select(row => (row.Id, row.Field)));

        var nextHeading = await Change(ArticleAction.Save, headingDraft.Id, headingDraft.Revision, "Heading fixture", "# newerheading");
        Assert.Empty((await Search(qualified with { Query = $"field.heading:{headingMarker}" }, headings: true)).Rows);
        Assert.Equal(nextHeading.Revision, Assert.Single((await Search(qualified with { Query = "field.heading:newerheading" }, headings: true)).Rows).Revision);

        var complexDraft = await Change(ArticleAction.Save, 0, 0, "Bounded parser complex body", new string('\n', 4_096) + "complexbodymarker");
        await Send(HttpMethod.Post, WireRoutes.AuthorTextSearch, Wire.EncodeAuthorTextHeadingQuery(qualified with { Query = "field.heading:newerheading" }), UnprocessableEntity);
        Assert.Equal(complexDraft.Id, Assert.Single((await Search(qualified with { Query = "complexbodymarker" })).Rows).Id);

        async Task<Draft> SaveSummary(int id, long rev, string text) => Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave,
            Wire.EncodeArticleSummaryCommand(new(id, rev, Guid.NewGuid(), text))));

        async Task<int> Count(string match) => BinaryPrimitives.ReadInt32LittleEndian(
            Aeds.Decode(await Send(HttpMethod.Get, $"{WireRoutes.AuthorArticles}?match={match}&keyword={marker}"), FrameType.AuthorArticlePage));

        async Task<ArticleSummary> Read(int id, long revision) => Wire.DecodeArticleSummary(await Send(HttpMethod.Get, SummaryUrl(id, revision)));

        async Task<AuthorTextFacetedPage> Search(AuthorTextQualifiedQuery input, (string Token, string? Handle)? caller = null, bool headings = false)
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

        Task<ArticleState> Change(ArticleAction action, int id, long revision, string nextTitle = "", string nextBody = "") =>
            PublicationFixture.EditDraft(store, owner.Token, action, new(id, revision, Guid.NewGuid(), nextTitle, nextBody), ct);

        async Task<string> PublicIndex()
        {
            using var response = await server.Client.GetAsync(WireRoutes.PublicIndex, ct);
            if (response.StatusCode is NotFound or ServiceUnavailable) return "";
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

        Task<byte[]> Send(HttpMethod method, string route, byte[]? frame = null, HttpStatusCode status = OK, (string Token, string? Handle)? caller = null) =>
            SiteAedsFixture.ExpectPrivate(server.Client, method, route, frame, caller?.Token ?? owner.Token, caller is null ? owner.Handle : caller.Value.Handle, status, ct);
    }

    private static string SummaryUrl(int id, long revision) => $"{WireRoutes.ArticleSummary.Replace("{id:int}", id.ToString(), StringComparison.Ordinal)}?revision={revision}";
}
