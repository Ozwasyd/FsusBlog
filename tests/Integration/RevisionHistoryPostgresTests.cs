public sealed class RevisionHistoryPostgresTests
{
    [PostgresFact]
    public async Task OwnerCanCompareAndRestoreExactDraftWithoutMovingPublicCoordinates()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await fixture.SignIn("Revision owner", ct);
        var outsider = await fixture.SignIn("Revision outsider", ct);
        var reader = await fixture.SignIn("Revision reader", ct, canAuthor: false);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var article = await Write(0, 0, "Original private title", "First body, exact \r\n");
        await fixture.Exec("""
            insert into public.category(id,name) values(1,'Original category'),(2,'Public category');
            insert into public.tag(id,name) values(4,'Original tag');
            """);
        await fixture.Exec("insert into public.article_revision_category values($1,$2,1)", article.Id, article.Revision);
        await fixture.Exec("insert into public.article_revision_tag values($1,$2,4)", article.Id, article.Revision);
        var toPublish = await Write(article.Id, article.Revision, "Public title", "Public body");
        await fixture.Exec("update public.article_revision_category set category_id=2 where article_id=$1 and revision=$2", article.Id, toPublish.Revision);
        var published = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Publish, owner.Token,
            Wire.EncodeArticleCommand(new(article.Id, toPublish.Revision, Guid.NewGuid(), "", ""))));
        Assert.Contains("Public body", await server.Client.GetStringAsync($"/article/{article.Id}", ct));

        var current = published;
        for (var index = 0; index < WireLimits.RevisionHistoryPageSize; index++)
            current = await Write(article.Id, current.Revision, $"private revision {index}", $"Private body {index}");
        var otherArticle = await Write(0, 0, "Another owner-visible article", "Never appears in first history.");
        var first = Wire.DecodeRevisionHistory(await Request(HttpMethod.Get, History(current), owner.Token));
        Assert.Equal((current.Revision, published.Revision, WireLimits.RevisionHistoryPageSize, current.Revision),
            (first.Revision, first.PublishedRevision, first.Items.Count, first.Items[0].Revision));
        Assert.All(first.Items, item => Assert.Equal(0, item.SourceRevision));
        var nextPage = $"&cursor={first.NextCursor}";
        var last = Wire.DecodeRevisionHistory(await Request(HttpMethod.Get, History(current) + nextPage, owner.Token));
        Assert.Equal(new long[] { 3, 2, 1 }, last.Items.Select(item => item.Revision));
        Assert.Empty(last.NextCursor);
        var staleHandle = owner.Handle;
        owner = await fixture.SignIn(owner.Id, ct);
        var firstChar = first.NextCursor[0] == 'A' ? 'B' : 'A';
        foreach (var (route, tok, status) in new[]
        {
            (History(current) + nextPage, (string?)owner.Token, BadRequest),
            (History(otherArticle) + nextPage, owner.Token, BadRequest),
            (History(current) + $"&cursor={firstChar}{first.NextCursor[1..]}", owner.Token, BadRequest),
            (History(current), null, Unauthorized),
            (History(current), outsider.Token, NotFound),
            (History(current), reader.Token, Unauthorized),
        })
            await Request(HttpMethod.Get, route, tok, status: status);

        var compare = WireRoutes.DraftRevisionComparison.Replace("{id:int}", current.Id.ToString())
            .Replace("{sourceRevision:long}", article.Revision.ToString()) + $"?revision={current.Revision}";
        var pair = Wire.DecodeRevisionComparison(await Request(HttpMethod.Get, compare, owner.Token));
        Assert.Equal((current.Title, current.Body, article.Title, article.Body), (pair.Title, pair.Body, pair.SourceTitle, pair.SourceBody));
        await fixture.Exec("update public.article_revision set author_summary=$3 where article_id=$1 and revision=$2", article.Id, article.Revision, "Earlier saved summary");
        await fixture.Exec("update public.article_revision set author_summary=$3 where article_id=$1 and revision=$2", article.Id, current.Revision, "Current saved summary");
        await fixture.Exec("delete from public.article_revision_tag where article_id=$1 and revision=$2", article.Id, current.Revision);
        var metadataRoute = compare + "&map=metadata";
        await Request(HttpMethod.Get, metadataRoute, owner.Token, status: Conflict);
        await Request(HttpMethod.Get, metadataRoute, owner.Token, status: Conflict, handle: staleHandle);
        await Request(HttpMethod.Get, metadataRoute, outsider.Token, status: NotFound, handle: outsider.Handle);
        using (var fields = InboxFixture.Reader(await GetOwned(metadataRoute), FrameType.RevisionMetadataComparison))
        {
            Assert.Equal((article.Id, current.Revision, article.Revision), (fields.ReadInt32(), fields.ReadInt64(), fields.ReadInt64()));
            Assert.Equal(("Current saved summary", 2, "Public category", 0), (InboxFixture.Text(fields), fields.ReadInt32(), InboxFixture.Text(fields), fields.ReadInt32()));
            Assert.Equal(("Earlier saved summary", 1, "Original category", 1, 4, "Original tag"),
                (InboxFixture.Text(fields), fields.ReadInt32(), InboxFixture.Text(fields), fields.ReadInt32(), fields.ReadInt32(), InboxFixture.Text(fields)));
            Assert.Equal(fields.BaseStream.Length, fields.BaseStream.Position);
        }
        await Request(HttpMethod.Get, compare, outsider.Token, status: NotFound);
        Assert.Equal(pair, Wire.DecodeRevisionComparison(await GetOwned(compare)));
        await Request(HttpMethod.Get, compare, owner.Token, status: Conflict, handle: staleHandle);
        await Request(HttpMethod.Get, compare, outsider.Token, status: NotFound, handle: outsider.Handle);
        var input = new DraftRollback(article.Id, current.Revision, article.Revision, Guid.NewGuid(), "Restore the original draft. 📝");
        await Restore(input, reader.Token, Unauthorized);
        await Restore(input with { Id = 999_999 }, owner.Token, NotFound);

        // A failed enqueue must roll back draft, copied taxonomy, command and provenance together.
        await fixture.Exec("alter table public.blog_outbox add constraint test_fail_restore check (kind <> 'draft-rollback')");
        await Restore(input, owner.Token, ServiceUnavailable);
        Assert.Equal((current.Revision, 0L, 0L), (await fixture.Scalar<long>("select revision from public.article where id=$1", article.Id),
            await fixture.Scalar<long>("select count(*) from public.article_rollback"),
            await fixture.Scalar<long>("select count(*) from public.article_command where command_id=$1", input.IdempotencyKey)));
        await fixture.Exec("alter table public.blog_outbox drop constraint test_fail_restore");

        // Concurrent retries serialize and produce the same durable receipt.
        var receipts = await Task.WhenAll(Restore(input, owner.Token), Restore(input, owner.Token));
        Assert.Equal(receipts[0], receipts[1]);
        var restored = Wire.DecodeDraft(receipts[0]);
        Assert.Equal((current.Revision + 1, article.Title, article.Body, true), (restored.Revision, restored.Title, restored.Body, restored.Published));
        await Restore(input with { Reason = "A different valid reason." }, owner.Token, Conflict);
        await Restore(input with { IdempotencyKey = Guid.NewGuid() }, owner.Token, Conflict);
        await Request(HttpMethod.Get, History(current) + nextPage, owner.Token, status: Conflict);
        await Request(HttpMethod.Get, compare, owner.Token, status: Conflict);
        await GetOwned(metadataRoute, Conflict);
        var restoredHistory = Wire.DecodeRevisionHistory(await Request(HttpMethod.Get, History(restored), owner.Token));
        Assert.Equal((input.SourceRevision, input.Reason, published.Revision),
            (restoredHistory.Items[0].SourceRevision, restoredHistory.Items[0].Reason, restoredHistory.PublishedRevision));
        Assert.Equal((published.Revision, 1, 4, 1L, owner.Id), (
            await fixture.Scalar<long>("select revision from public.article_publication where article_id=$1", article.Id),
            await fixture.Scalar<int>("select category_id from public.article_revision_category where article_id=$1 and revision=$2", article.Id, restored.Revision),
            await fixture.Scalar<int>("select tag_id from public.article_revision_tag where article_id=$1 and revision=$2", article.Id, restored.Revision),
            await fixture.Scalar<long>("select count(*) from public.blog_outbox where kind='draft-rollback' and article_id=$1 and revision=$2", article.Id, restored.Revision),
            await fixture.Scalar<Guid>("select actor_id from public.article_rollback where article_id=$1 and revision=$2", article.Id, restored.Revision)));
        var stillPublic = await server.Client.GetStringAsync($"/article/{article.Id}", ct);
        Assert.Contains("Public body", stillPublic);
        Assert.DoesNotContain("First body", stillPublic);
        await Request(HttpMethod.Post, WireRoutes.Publish, owner.Token, Wire.EncodeArticleCommand(new(article.Id, restored.Revision, Guid.NewGuid(), "", "")));
        Assert.Contains("First body", await server.Client.GetStringAsync($"/article/{article.Id}", ct));

        var basis = await Write(0, 0, "Private insertion", "首行 🚢\r\n\r\n正文 marker.");
        const string inserted = "**Earlier**\r\n\r\n";
        var mappedCommand = new ArticleBodyInsertionCommand(basis.Id, basis.Revision, Guid.NewGuid(), basis.Title,
            inserted + basis.Body, 0, inserted.Length);
        var mappedBytes = Wire.EncodeArticleBodyInsertionCommand(mappedCommand);
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, mappedBytes, Conflict, staleHandle);
        var impossible = Wire.EncodeArticleBodyInsertionCommand(mappedCommand with { Offset = 1 });
        await SaveOwned(impossible, BadRequest);
        await AssertInsertionRollback(basis, mappedCommand.IdempotencyKey, mappedBytes, "test_abort_insertion", "length_utf16 < 0");
        var newDraftBytes = await SaveOwned(mappedBytes);
        Assert.Equal(newDraftBytes, await SaveOwned(mappedBytes));
        await SaveOwned(impossible, Conflict);
        var newDraft = Wire.DecodeDraft(newDraftBytes);
        var mapPath = ChainPath(newDraft, basis.Revision).Replace("body-chain", "body-insertion");
        await Request(HttpMethod.Get, mapPath, owner.Token, status: Conflict);
        await Request(HttpMethod.Get, mapPath, outsider.Token, status: NotFound, handle: outsider.Handle);
        Assert.Equal(new DraftRevisionBodyInsertion(basis.Id, newDraft.Revision, basis.Revision, true, 0, inserted.Length,
            Hash(basis.Body), Hash(newDraft.Body), basis.Body, newDraft.Body),
            Wire.DecodeDraftRevisionBodyInsertion(await GetOwned(mapPath)));
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.article_body_insertion where article_id=$1", basis.Id));
        await fixture.Exec("update public.article_body_insertion set body_digest=decode(repeat('11',32),'hex') where article_id=$1", basis.Id);
        Assert.False(Wire.DecodeDraftRevisionBodyInsertion(await GetOwned(mapPath)).Available);

        var twin = await Write(0, 0, "Ambiguous insertion", "aa");
        var twinSaved = Wire.DecodeDraft(await SaveOwned(Wire.EncodeArticleBodyInsertionCommand(
            new(twin.Id, twin.Revision, Guid.NewGuid(), twin.Title, "aaa", 0, 1))));
        Assert.Equal(("aaa", 0L), (twinSaved.Body, await fixture.Scalar<long>("select count(*) from public.article_body_insertion where article_id=$1", twin.Id)));

        var chainBasis = await Write(0, 0, "Insertion sequence", "Alpha 🚢\r\nZeta");
        var metadata = await Write(chainBasis.Id, chainBasis.Revision, "Same saved body", chainBasis.Body);
        const string prefix = "> ", suffix = "\r\nTail";
        var withPrefix = prefix + metadata.Body;
        var sequence = new ArticleBodyInsertionsCommand(metadata.Id, metadata.Revision, Guid.NewGuid(), metadata.Title,
            withPrefix + suffix, [new(0, prefix.Length), new(withPrefix.Length, suffix.Length)]);
        var sequenceFrame = Wire.EncodeArticleBodyInsertionsCommand(sequence);
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, sequenceFrame, Conflict, staleHandle);
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, sequenceFrame, Conflict);
        await SaveOwned(Wire.EncodeArticleBodyInsertionsCommand(sequence with { Insertions = [new(1, prefix.Length), sequence.Insertions[1]] }), BadRequest);
        await AssertInsertionRollback(metadata, sequence.IdempotencyKey, sequenceFrame, "test_abort_sequence", "operations is null");
        var sequenceSaved = await SaveOwned(sequenceFrame);
        Assert.Equal(sequenceSaved, await SaveOwned(sequenceFrame));
        var multiple = Wire.DecodeDraft(sequenceSaved);
        Assert.False(Wire.DecodeDraftRevisionBodyInsertion(await GetOwned(ChainPath(multiple, metadata.Revision).Replace("body-chain", "body-insertion"))).Available);
        Assert.Equal(new[] { 0, prefix.Length, withPrefix.Length, suffix.Length },
            await fixture.Scalar<int[]>("select operations from public.article_body_insertion where article_id=$1 and revision=$2",
                multiple.Id, multiple.Revision));

        const string finalInsertion = "\r\n**End**";
        var final = Wire.DecodeDraft(await SaveOwned(Wire.EncodeArticleBodyInsertionCommand(
            new(multiple.Id, multiple.Revision, Guid.NewGuid(), multiple.Title, multiple.Body + finalInsertion, multiple.Body.Length, finalInsertion.Length))));
        var chainPath = ChainPath(final, chainBasis.Revision);
        await Request(HttpMethod.Get, chainPath, owner.Token, status: Conflict, handle: staleHandle);
        await Request(HttpMethod.Get, chainPath, outsider.Token, status: NotFound, handle: outsider.Handle);
        var chain = Wire.DecodeDraftRevisionBodyInsertionChain(await GetOwned(chainPath));
        Assert.Equal((true, chainBasis.Body, final.Body, 3), (chain.Available, chain.SourceBody, chain.Body, chain.Edges.Count));
        Assert.Empty(chain.Edges[0].Insertions);
        Assert.Equal((Hash(chainBasis.Body), Hash(chainBasis.Body), chain.Edges[0].Digest, Hash(multiple.Body), Hash(final.Body)),
            (chain.Edges[0].Digest, chain.Edges[0].SourceDigest, chain.Edges[1].SourceDigest, chain.Edges[1].Digest, chain.Edges[2].Digest));
        Assert.Equal(sequence.Insertions, chain.Edges[1].Insertions);
        Assert.Equal(new BodyInsertion(multiple.Body.Length, finalInsertion.Length), Assert.Single(chain.Edges[2].Insertions));

        await fixture.Exec("update public.article_body_insertion set operations=ARRAY[0,$3,0,$4] where article_id=$1 and revision=$2",
            multiple.Id, multiple.Revision, prefix.Length, suffix.Length);
        var unavailable = Wire.DecodeDraftRevisionBodyInsertionChain(await GetOwned(chainPath));
        Assert.Equal((false, "", ""), (unavailable.Available, unavailable.SourceBody, unavailable.Body));
        Assert.Empty(unavailable.Edges);
        await fixture.Exec("update public.article_body_insertion set operations=ARRAY[0,$3,$4,$5] where article_id=$1 and revision=$2",
            multiple.Id, multiple.Revision, prefix.Length, withPrefix.Length, suffix.Length);
        var gap = await Write(final.Id, final.Revision, final.Title, final.Body + " ordinary");
        Assert.False(Wire.DecodeDraftRevisionBodyInsertionChain(await GetOwned(ChainPath(gap, chainBasis.Revision))).Available);

        var spliceBasis = await Write(0, 0, "Body edit chain", "Lead 🚢\r\nkeep match\r\nTAIL");
        var withLegacy = Wire.DecodeDraft(await SaveOwned(Wire.EncodeArticleBodyInsertionCommand(
            new(spliceBasis.Id, spliceBasis.Revision, Guid.NewGuid(), spliceBasis.Title, "!" + spliceBasis.Body, 0, 1))));
        var removedLength = "!Lead 🚢\r\n".Length;
        var afterDeletion = withLegacy.Body[removedLength..];
        var replaceOffset = afterDeletion.LastIndexOf("TAIL", StringComparison.Ordinal);
        var spliceSave = new ArticleBodyEditsCommand(withLegacy.Id, withLegacy.Revision, Guid.NewGuid(), withLegacy.Title,
            afterDeletion[..replaceOffset] + "END", [new(0, removedLength, ""), new(replaceOffset, 4, "END")]);
        var spliceFrame = Wire.EncodeArticleBodyEditsCommand(spliceSave);
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, spliceFrame, Conflict, staleHandle);
        await SaveOwned(Wire.EncodeArticleBodyEditsCommand(spliceSave with { Edits = [new(1, removedLength, ""), new(replaceOffset, 4, "END")] }), BadRequest);
        await AssertInsertionRollback(withLegacy, spliceSave.IdempotencyKey, spliceFrame, "test_abort_edits", "edit_texts is null");
        var spliceReceipt = await SaveOwned(spliceFrame);
        Assert.Equal(spliceReceipt, await SaveOwned(spliceFrame));
        var editHead = Wire.DecodeDraft(spliceReceipt);
        var editsPath = ChainPath(editHead, spliceBasis.Revision).Replace("body-chain", "body-edit");
        var priorHandle = owner.Handle;
        owner = await fixture.SignIn(owner.Id, ct);
        await Request(HttpMethod.Get, editsPath, owner.Token, status: Conflict, handle: priorHandle);
        await Request(HttpMethod.Get, editsPath, outsider.Token, status: NotFound, handle: outsider.Handle);
        var editsChain = Wire.DecodeDraftRevisionBodyEditChain(await GetOwned(editsPath));
        Assert.Equal((true, spliceBasis.Body, editHead.Body, 2, Hash(editHead.Body)),
            (editsChain.Available, editsChain.SourceBody, editsChain.Body, editsChain.Edges.Count, editsChain.Edges[1].Digest));
        Assert.Equal(new BodyEdit(0, 0, "!"), Assert.Single(editsChain.Edges[0].Edits));
        Assert.Equal(spliceSave.Edits, editsChain.Edges[1].Edits);
        Assert.False(Wire.DecodeDraftRevisionBodyInsertionChain(await GetOwned(ChainPath(editHead, spliceBasis.Revision))).Available);
        await fixture.Exec("update public.article_body_insertion set edit_texts=ARRAY['','BAD'] where article_id=$1 and revision=$2", editHead.Id, editHead.Revision);
        var invalidChain = Wire.DecodeDraftRevisionBodyEditChain(await GetOwned(editsPath));
        Assert.False(invalidChain.Available);
        Assert.Empty(invalidChain.Edges);

        var repeatedBasis = await Write(0, 0, "Repeated text", "aaa keep");
        var repeatedHead = Wire.DecodeDraft(await SaveOwned(Wire.EncodeArticleBodyEditsCommand(new(repeatedBasis.Id, repeatedBasis.Revision,
            Guid.NewGuid(), repeatedBasis.Title + " edited", repeatedBasis.Body, [new(0, 1, ""), new(0, 0, "a")]))));
        Assert.Equal(repeatedBasis.Body, repeatedHead.Body);
        var repeatedPath = ChainPath(repeatedHead, repeatedBasis.Revision);
        Assert.False(Wire.DecodeDraftRevisionBodyEditChain(await GetOwned(repeatedPath.Replace("body-chain", "body-edit"))).Available);
        Assert.False(Wire.DecodeDraftRevisionBodyInsertionChain(await GetOwned(repeatedPath)).Available);

        await fixture.Exec("alter table public.article_body_insertion drop column operations");
        const string oldStoragePrefix = "## ";
        var nextSequence = new ArticleBodyInsertionsCommand(gap.Id, gap.Revision, Guid.NewGuid(), gap.Title,
            oldStoragePrefix + gap.Body + suffix, [new(0, oldStoragePrefix.Length), new(oldStoragePrefix.Length + gap.Body.Length, suffix.Length)]);
        var olderStorageSave = Wire.DecodeDraft(await SaveOwned(Wire.EncodeArticleBodyInsertionsCommand(nextSequence)));
        Assert.Equal((gap.Revision + 1, nextSequence.Body), (olderStorageSave.Revision, olderStorageSave.Body));
        Assert.False(Wire.DecodeDraftRevisionBodyInsertionChain(await GetOwned(ChainPath(olderStorageSave, gap.Revision))).Available);

        async Task AssertInsertionRollback(Draft head, Guid key, byte[] frame, string constraint, string predicate)
        {
            await fixture.Exec($"alter table public.article_body_insertion add constraint {constraint} check ({predicate})");
            await SaveOwned(frame, ServiceUnavailable);
            Assert.Equal((head.Revision, 0L), (await fixture.Scalar<long>("select revision from public.article where id=$1", head.Id),
                await fixture.Scalar<long>("select count(*) from public.article_command where command_id=$1", key)));
            await fixture.Exec($"alter table public.article_body_insertion drop constraint {constraint}");
        }

        static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
        static string ChainPath(Draft head, long basisRev) => WireRoutes.DraftRevisionComparison.Replace("{id:int}", head.Id.ToString())
            .Replace("{sourceRevision:long}", basisRev.ToString()) + $"?revision={head.Revision}&map=body-chain";
        string History(Draft draft) => WireRoutes.DraftRevisionHistory.Replace("{id:int}", draft.Id.ToString()) + $"?revision={draft.Revision}";
        async Task<Draft> Write(int id, long revision, string title, string body) =>
            Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, Wire.EncodeArticleCommand(new(id, revision, Guid.NewGuid(), title, body))));
        Task<byte[]> SaveOwned(byte[] frame, HttpStatusCode status = OK) => Request(HttpMethod.Post, WireRoutes.Save, owner.Token, frame, status, owner.Handle);
        Task<byte[]> GetOwned(string path, HttpStatusCode status = OK) => Request(HttpMethod.Get, path, owner.Token, status: status, handle: owner.Handle);
        Task<byte[]> Restore(DraftRollback rollback, string token, HttpStatusCode status = OK) =>
            Request(HttpMethod.Post, WireRoutes.DraftRollback, token, Wire.EncodeDraftRollback(rollback), status);

        async Task<byte[]> Request(HttpMethod method, string path, string? token, byte[]? body = null,
            HttpStatusCode status = OK, string? handle = null)
        {
            using var response = await SiteAedsFixture.ExpectPrivateResponse(server.Client, method, path, body, token, handle, status, ct);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
    }

    [PostgresFact]
    public async Task BodyEditsSaveWithoutClaimingProofOnOlderSchema()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        // Reproduce the supported physical shape before body-edit evidence was installed.
        await fixture.Exec("""
            alter table public.article_body_insertion
                drop column edit_texts, alter column offset_utf16 set not null, alter column length_utf16 set not null
            """);
        var (_, token, handle) = await fixture.SignIn("Old schema author", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var draft = await SiteAedsFixture.SaveDraft(server.Client, token, handle, 0, 0, "Saved body", "Omit:keep", ct);
        var bodyEdit = new ArticleBodyEditsCommand(draft.Id, draft.Revision, Guid.NewGuid(), draft.Title, "keep", [new(0, "Omit:".Length, "")]);
        var next = Wire.DecodeDraft(await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Post, WireRoutes.Save,
            Wire.EncodeArticleBodyEditsCommand(bodyEdit), token, handle, OK, ct));
        Assert.Equal((draft.Revision + 1, "keep"), (next.Revision, next.Body));
        var path = WireRoutes.DraftRevisionComparison.Replace("{id:int}", next.Id.ToString())
            .Replace("{sourceRevision:long}", draft.Revision.ToString()) + $"?revision={next.Revision}&map=body-edit";
        var chain = Wire.DecodeDraftRevisionBodyEditChain(await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Get, path, null, token, handle, OK, ct));
        Assert.False(chain.Available);
        Assert.Empty(chain.Edges);
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_body_insertion where article_id=$1", next.Id));
    }
}
