using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

public sealed class RevisionHistoryPostgresTests
{
    [PostgresFact]
    public async Task OwnerCanCompareAndRestoreExactDraftWithoutMovingPublicCoordinates()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var store = new Store(fixture.DataSource);
        var owner = await SignIn("Revision owner", true);
        var otherSession = await SignIn("Revision owner", true, owner.User.Id);
        var outsider = await SignIn("Revision outsider", true);
        var reader = await SignIn("Revision reader", false);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var article = await Write(0, 0, "Original private title", "First body, exact \r\n");
        await Execute("insert into public.category(id,name) values(1,'Original category'),(2,'Public category')");
        await Execute("insert into public.tag(id,name) values(4,'Original tag')");
        await Execute("insert into public.article_revision_category values($1,$2,1)", article.Id, article.Revision);
        await Execute("insert into public.article_revision_tag values($1,$2,4)", article.Id, article.Revision);
        var toPublish = await Write(article.Id, article.Revision, "Public title", "Public body");
        await Execute("update public.article_revision_category set category_id=2 where article_id=$1 and revision=$2",
            article.Id, toPublish.Revision);
        var published = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Publish, owner.Token,
            Wire.EncodeArticleCommand(new(article.Id, toPublish.Revision, Guid.NewGuid(), "", ""))));
        Assert.Contains("Public body", await server.Client.GetStringAsync($"/article/{article.Id}", ct));

        var current = published;
        for (var index = 0; index < WireLimits.RevisionHistoryPageSize; index++)
            current = await Write(article.Id, current.Revision, $"private revision {index}", $"Private body {index}");
        var otherArticle = await Write(0, 0, "Another owner-visible article", "Never appears in first history.");
        var first = Wire.DecodeRevisionHistory(await Request(HttpMethod.Get, History(current), owner.Token));
        Assert.Equal(current.Revision, first.Revision);
        Assert.Equal(published.Revision, first.PublishedRevision);
        Assert.Equal(WireLimits.RevisionHistoryPageSize, first.Items.Count);
        Assert.Equal(current.Revision, first.Items[0].Revision);
        Assert.All(first.Items, item => Assert.Equal(0, item.SourceRevision));
        var nextPage = $"&cursor={first.NextCursor}";
        var last = Wire.DecodeRevisionHistory(await Request(HttpMethod.Get, History(current) + nextPage, owner.Token));
        Assert.Equal(new long[] { 3, 2, 1 }, last.Items.Select(item => item.Revision));
        Assert.Empty(last.NextCursor);
        await Request(HttpMethod.Get, History(current) + nextPage, otherSession.Token, status: HttpStatusCode.BadRequest);
        await Request(HttpMethod.Get, History(otherArticle) + nextPage, owner.Token, status: HttpStatusCode.BadRequest);
        var firstChar = first.NextCursor[0] == 'A' ? 'B' : 'A';
        await Request(HttpMethod.Get, History(current) + $"&cursor={firstChar}{first.NextCursor[1..]}", owner.Token, status: HttpStatusCode.BadRequest);
        await Request(HttpMethod.Get, History(current), null, status: HttpStatusCode.Unauthorized);
        await Request(HttpMethod.Get, History(current), outsider.Token, status: HttpStatusCode.NotFound);
        await Request(HttpMethod.Get, History(current), reader.Token, status: HttpStatusCode.Forbidden);

        var compare = WireRoutes.DraftRevisionComparison.Replace("{id:int}", current.Id.ToString())
            .Replace("{sourceRevision:long}", article.Revision.ToString()) + $"?revision={current.Revision}";
        var pair = Wire.DecodeRevisionComparison(await Request(HttpMethod.Get, compare, owner.Token));
        Assert.Equal((current.Title, current.Body, article.Title, article.Body), (pair.Title, pair.Body, pair.SourceTitle, pair.SourceBody));
        await Request(HttpMethod.Get, compare, outsider.Token, status: HttpStatusCode.NotFound);
        var ownerHandle = SiteSessions.Id(owner.User.Id, Store.TokenDigest(owner.Token)!);
        Assert.Equal(pair, Wire.DecodeRevisionComparison(await Request(HttpMethod.Get, compare, owner.Token, handle: ownerHandle)));
        await Request(HttpMethod.Get, compare, otherSession.Token, status: HttpStatusCode.Conflict, handle: ownerHandle);
        var outsiderHandle = SiteSessions.Id(outsider.User.Id, Store.TokenDigest(outsider.Token)!);
        await Request(HttpMethod.Get, compare, outsider.Token, status: HttpStatusCode.NotFound, handle: outsiderHandle);
        var input = new DraftRollback(article.Id, current.Revision, article.Revision, Guid.NewGuid(), "Restore the original draft. 📝");
        await Restore(input, outsider.Token, HttpStatusCode.NotFound);

        // A failed enqueue must roll back draft, copied taxonomy, command and provenance together.
        await Execute("alter table public.blog_outbox add constraint test_fail_restore check (kind <> 'draft-rollback')");
        await Restore(input, owner.Token, HttpStatusCode.ServiceUnavailable);
        Assert.Equal(current.Revision, await Scalar<long>("select revision from public.article where id=$1", article.Id));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_rollback"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_command where command_id=$1", input.IdempotencyKey));
        await Execute("alter table public.blog_outbox drop constraint test_fail_restore");

        // Concurrent retries serialize and produce the same durable receipt.
        var receipts = await Task.WhenAll(Restore(input, owner.Token), Restore(input, owner.Token));
        Assert.Equal(receipts[0], receipts[1]);
        var restored = Wire.DecodeDraft(receipts[0]);
        Assert.Equal((current.Revision + 1, article.Title, article.Body, true),
            (restored.Revision, restored.Title, restored.Body, restored.Published));
        await Restore(input with { Reason = "A different valid reason." }, owner.Token, HttpStatusCode.Conflict);
        await Restore(input with { IdempotencyKey = Guid.NewGuid() }, owner.Token, HttpStatusCode.Conflict);
        await Request(HttpMethod.Get, History(current) + nextPage, owner.Token, status: HttpStatusCode.Conflict);
        await Request(HttpMethod.Get, compare, owner.Token, status: HttpStatusCode.Conflict);
        var restoredHistory = Wire.DecodeRevisionHistory(await Request(HttpMethod.Get, History(restored), owner.Token));
        Assert.Equal(input.SourceRevision, restoredHistory.Items[0].SourceRevision);
        Assert.Equal(input.Reason, restoredHistory.Items[0].Reason);
        Assert.Equal(published.Revision, restoredHistory.PublishedRevision);
        Assert.Equal(published.Revision, await Scalar<long>("select revision from public.article_publication where article_id=$1", article.Id));
        Assert.Equal(1, await Scalar<int>("select category_id from public.article_revision_category where article_id=$1 and revision=$2",
            article.Id, restored.Revision));
        Assert.Equal(4, await Scalar<int>("select tag_id from public.article_revision_tag where article_id=$1 and revision=$2",
            article.Id, restored.Revision));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.blog_outbox where kind='draft-rollback' and article_id=$1 and revision=$2",
            article.Id, restored.Revision));
        Assert.Equal(owner.User.Id, await Scalar<Guid>("select actor_id from public.article_rollback where article_id=$1 and revision=$2",
            article.Id, restored.Revision));
        var stillPublic = await server.Client.GetStringAsync($"/article/{article.Id}", ct);
        Assert.Contains("Public body", stillPublic);
        Assert.DoesNotContain("First body", stillPublic);
        await Request(HttpMethod.Post, WireRoutes.Publish, owner.Token,
            Wire.EncodeArticleCommand(new(article.Id, restored.Revision, Guid.NewGuid(), "", "")));
        Assert.Contains("First body", await server.Client.GetStringAsync($"/article/{article.Id}", ct));

        var basis = await Write(0, 0, "Private insertion", "首行 🚢\r\n\r\n正文 marker.");
        const string inserted = "**Earlier**\r\n\r\n";
        var mappedCommand = new ArticleBodyInsertionCommand(basis.Id, basis.Revision, Guid.NewGuid(), basis.Title,
            inserted + basis.Body, 0, inserted.Length);
        var mappedBytes = Wire.EncodeArticleBodyInsertionCommand(mappedCommand);
        await Request(HttpMethod.Post, WireRoutes.Save, otherSession.Token, mappedBytes, HttpStatusCode.Conflict, ownerHandle);
        var impossible = Wire.EncodeArticleBodyInsertionCommand(mappedCommand with { Offset = 1 });
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, impossible, HttpStatusCode.BadRequest, ownerHandle);
        await Execute("alter table public.article_body_insertion add constraint test_abort_insertion check (length_utf16 < 0)");
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, mappedBytes, HttpStatusCode.ServiceUnavailable, ownerHandle);
        Assert.Equal(basis.Revision, await Scalar<long>("select revision from public.article where id=$1", basis.Id));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_command where command_id=$1", mappedCommand.IdempotencyKey));
        await Execute("alter table public.article_body_insertion drop constraint test_abort_insertion");
        var newDraftBytes = await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, mappedBytes, handle: ownerHandle);
        Assert.Equal(newDraftBytes, await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, mappedBytes, handle: ownerHandle));
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, impossible, HttpStatusCode.Conflict, ownerHandle);
        var newDraft = Wire.DecodeDraft(newDraftBytes);
        var mapPath = WireRoutes.DraftRevisionComparison.Replace("{id:int}", basis.Id.ToString())
            .Replace("{sourceRevision:long}", basis.Revision.ToString()) + $"?revision={newDraft.Revision}&map=body-insertion";
        await Request(HttpMethod.Get, mapPath, owner.Token, status: HttpStatusCode.Conflict);
        await Request(HttpMethod.Get, mapPath, outsider.Token, status: HttpStatusCode.NotFound, handle: outsiderHandle);
        var map = Wire.DecodeDraftRevisionBodyInsertion(await Request(HttpMethod.Get, mapPath, owner.Token, handle: ownerHandle));
        Assert.Equal(new DraftRevisionBodyInsertion(basis.Id, newDraft.Revision, basis.Revision, true, 0, inserted.Length,
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(basis.Body))),
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(newDraft.Body))), basis.Body, newDraft.Body), map);
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.article_body_insertion where article_id=$1", basis.Id));
        await Execute("update public.article_body_insertion set body_digest=decode(repeat('11',32),'hex') where article_id=$1", basis.Id);
        Assert.False(Wire.DecodeDraftRevisionBodyInsertion(await Request(HttpMethod.Get, mapPath, owner.Token, handle: ownerHandle)).Available);

        var twin = await Write(0, 0, "Ambiguous insertion", "aa");
        var twinCommand = new ArticleBodyInsertionCommand(twin.Id, twin.Revision, Guid.NewGuid(), twin.Title, "aaa", 0, 1);
        var twinSaved = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Save, owner.Token,
            Wire.EncodeArticleBodyInsertionCommand(twinCommand), handle: ownerHandle));
        Assert.Equal("aaa", twinSaved.Body);
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_body_insertion where article_id=$1", twin.Id));

        var chainBasis = await Write(0, 0, "Insertion sequence", "Alpha 🚢\r\nZeta");
        var metadata = await Write(chainBasis.Id, chainBasis.Revision, "Same saved body", chainBasis.Body);
        const string prefix = "> ";
        const string suffix = "\r\nTail";
        var withPrefix = prefix + metadata.Body;
        var sequence = new ArticleBodyInsertionsCommand(metadata.Id, metadata.Revision, Guid.NewGuid(), metadata.Title,
            withPrefix + suffix, [new(0, prefix.Length), new(withPrefix.Length, suffix.Length)]);
        var sequenceFrame = Wire.EncodeArticleBodyInsertionsCommand(sequence);
        await Request(HttpMethod.Post, WireRoutes.Save, otherSession.Token, sequenceFrame, HttpStatusCode.Conflict, ownerHandle);
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, sequenceFrame, HttpStatusCode.Conflict);
        var wrongSequence = Wire.EncodeArticleBodyInsertionsCommand(sequence with { Insertions = [new(1, prefix.Length), sequence.Insertions[1]] });
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, wrongSequence, HttpStatusCode.BadRequest, ownerHandle);
        await Execute("alter table public.article_body_insertion add constraint test_abort_sequence check (operations is null)");
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, sequenceFrame, HttpStatusCode.ServiceUnavailable, ownerHandle);
        Assert.Equal(metadata.Revision, await Scalar<long>("select revision from public.article where id=$1", metadata.Id));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_command where command_id=$1", sequence.IdempotencyKey));
        await Execute("alter table public.article_body_insertion drop constraint test_abort_sequence");
        var sequenceSaved = await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, sequenceFrame, handle: ownerHandle);
        Assert.Equal(sequenceSaved, await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, sequenceFrame, handle: ownerHandle));
        var multiple = Wire.DecodeDraft(sequenceSaved);
        var oldMap = ChainPath(multiple, metadata.Revision).Replace("body-chain", "body-insertion");
        Assert.False(Wire.DecodeDraftRevisionBodyInsertion(await Request(HttpMethod.Get, oldMap, owner.Token, handle: ownerHandle)).Available);
        Assert.Equal(new[] { 0, prefix.Length, withPrefix.Length, suffix.Length },
            await Scalar<int[]>("select operations from public.article_body_insertion where article_id=$1 and revision=$2",
                multiple.Id, multiple.Revision));

        const string finalInsertion = "\r\n**End**";
        var final = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Save, owner.Token,
            Wire.EncodeArticleBodyInsertionCommand(new(multiple.Id, multiple.Revision, Guid.NewGuid(), multiple.Title,
                multiple.Body + finalInsertion, multiple.Body.Length, finalInsertion.Length)), handle: ownerHandle));
        var chainPath = ChainPath(final, chainBasis.Revision);
        await Request(HttpMethod.Get, chainPath, otherSession.Token, status: HttpStatusCode.Conflict, handle: ownerHandle);
        await Request(HttpMethod.Get, chainPath, outsider.Token, status: HttpStatusCode.NotFound, handle: outsiderHandle);
        var chain = Wire.DecodeDraftRevisionBodyInsertionChain(await Request(HttpMethod.Get, chainPath, owner.Token, handle: ownerHandle));
        Assert.True(chain.Available);
        Assert.Equal((chainBasis.Body, final.Body), (chain.SourceBody, chain.Body));
        Assert.Equal(3, chain.Edges.Count);
        Assert.Empty(chain.Edges[0].Insertions);
        Assert.Equal(Hash(chainBasis.Body), chain.Edges[0].Digest);
        Assert.Equal(chain.Edges[0].SourceDigest, chain.Edges[0].Digest);
        Assert.Equal(sequence.Insertions, chain.Edges[1].Insertions);
        Assert.Equal(chain.Edges[0].Digest, chain.Edges[1].SourceDigest);
        Assert.Equal(Hash(multiple.Body), chain.Edges[1].Digest);
        Assert.Equal(new BodyInsertion(multiple.Body.Length, finalInsertion.Length), Assert.Single(chain.Edges[2].Insertions));
        Assert.Equal(Hash(final.Body), chain.Edges[2].Digest);

        await Execute("update public.article_body_insertion set operations=ARRAY[0,$3,0,$4] where article_id=$1 and revision=$2",
            multiple.Id, multiple.Revision, prefix.Length, suffix.Length);
        var unavailable = Wire.DecodeDraftRevisionBodyInsertionChain(await Request(HttpMethod.Get, chainPath, owner.Token, handle: ownerHandle));
        Assert.Equal((false, "", ""), (unavailable.Available, unavailable.SourceBody, unavailable.Body));
        Assert.Empty(unavailable.Edges);
        await Execute("update public.article_body_insertion set operations=ARRAY[0,$3,$4,$5] where article_id=$1 and revision=$2",
            multiple.Id, multiple.Revision, prefix.Length, withPrefix.Length, suffix.Length);
        var gap = await Write(final.Id, final.Revision, final.Title, final.Body + " ordinary");
        Assert.False(Wire.DecodeDraftRevisionBodyInsertionChain(await Request(HttpMethod.Get, ChainPath(gap, chainBasis.Revision),
            owner.Token, handle: ownerHandle)).Available);

        var spliceBasis = await Write(0, 0, "Body edit chain", "Lead 🚢\r\nkeep match\r\nTAIL");
        var withLegacy = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Save, owner.Token,
            Wire.EncodeArticleBodyInsertionCommand(new(spliceBasis.Id, spliceBasis.Revision, Guid.NewGuid(), spliceBasis.Title,
                "!" + spliceBasis.Body, 0, 1)), handle: ownerHandle));
        var removedLength = "!Lead 🚢\r\n".Length;
        var afterDeletion = withLegacy.Body[removedLength..];
        var replaceOffset = afterDeletion.LastIndexOf("TAIL", StringComparison.Ordinal);
        var spliceSave = new ArticleBodyEditsCommand(withLegacy.Id, withLegacy.Revision, Guid.NewGuid(), withLegacy.Title,
            afterDeletion[..replaceOffset] + "END", [new(0, removedLength, ""), new(replaceOffset, 4, "END")]);
        var spliceFrame = Wire.EncodeArticleBodyEditsCommand(spliceSave);
        await Request(HttpMethod.Post, WireRoutes.Save, otherSession.Token, spliceFrame, HttpStatusCode.Conflict, ownerHandle);
        var invalidSplice = Wire.EncodeArticleBodyEditsCommand(spliceSave with
        {
            Edits = [new(1, removedLength, ""), new(replaceOffset, 4, "END")]
        });
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, invalidSplice, HttpStatusCode.BadRequest, ownerHandle);
        await Execute("alter table public.article_body_insertion add constraint test_abort_edits check (edit_texts is null)");
        await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, spliceFrame, HttpStatusCode.ServiceUnavailable, ownerHandle);
        Assert.Equal(withLegacy.Revision, await Scalar<long>("select revision from public.article where id=$1", withLegacy.Id));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_command where command_id=$1", spliceSave.IdempotencyKey));
        await Execute("alter table public.article_body_insertion drop constraint test_abort_edits");
        var spliceReceipt = await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, spliceFrame, handle: ownerHandle);
        Assert.Equal(spliceReceipt, await Request(HttpMethod.Post, WireRoutes.Save, owner.Token, spliceFrame, handle: ownerHandle));
        var editHead = Wire.DecodeDraft(spliceReceipt);
        var editsPath = ChainPath(editHead, spliceBasis.Revision).Replace("body-chain", "body-edit");
        await Request(HttpMethod.Get, editsPath, otherSession.Token, status: HttpStatusCode.Conflict, handle: ownerHandle);
        await Request(HttpMethod.Get, editsPath, outsider.Token, status: HttpStatusCode.NotFound, handle: outsiderHandle);
        var editsChain = Wire.DecodeDraftRevisionBodyEditChain(await Request(HttpMethod.Get, editsPath, owner.Token, handle: ownerHandle));
        Assert.True(editsChain.Available);
        Assert.Equal((spliceBasis.Body, editHead.Body), (editsChain.SourceBody, editsChain.Body));
        Assert.Equal(2, editsChain.Edges.Count);
        Assert.Equal(new BodyEdit(0, 0, "!"), Assert.Single(editsChain.Edges[0].Edits));
        Assert.Equal(spliceSave.Edits, editsChain.Edges[1].Edits);
        Assert.Equal(Hash(editHead.Body), editsChain.Edges[1].Digest);
        Assert.False(Wire.DecodeDraftRevisionBodyInsertionChain(await Request(HttpMethod.Get, ChainPath(editHead, spliceBasis.Revision),
            owner.Token, handle: ownerHandle)).Available);
        await Execute("update public.article_body_insertion set edit_texts=ARRAY['','BAD'] where article_id=$1 and revision=$2",
            editHead.Id, editHead.Revision);
        var invalidChain = Wire.DecodeDraftRevisionBodyEditChain(await Request(HttpMethod.Get, editsPath, owner.Token, handle: ownerHandle));
        Assert.False(invalidChain.Available);
        Assert.Empty(invalidChain.Edges);

        await Execute("alter table public.article_body_insertion drop column operations");
        const string oldStoragePrefix = "## ";
        var nextSequence = new ArticleBodyInsertionsCommand(gap.Id, gap.Revision, Guid.NewGuid(), gap.Title,
            oldStoragePrefix + gap.Body + suffix,
            [new(0, oldStoragePrefix.Length), new(oldStoragePrefix.Length + gap.Body.Length, suffix.Length)]);
        var olderStorageSave = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Save, owner.Token,
            Wire.EncodeArticleBodyInsertionsCommand(nextSequence), handle: ownerHandle));
        Assert.Equal((gap.Revision + 1, nextSequence.Body), (olderStorageSave.Revision, olderStorageSave.Body));
        Assert.False(Wire.DecodeDraftRevisionBodyInsertionChain(await Request(HttpMethod.Get, ChainPath(olderStorageSave, gap.Revision),
            owner.Token, handle: ownerHandle)).Available);

        static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
        static string ChainPath(Draft head, long basis) => WireRoutes.DraftRevisionComparison.Replace("{id:int}", head.Id.ToString())
            .Replace("{sourceRevision:long}", basis.ToString()) + $"?revision={head.Revision}&map=body-chain";

        async Task<(string Token, FsusBlog.V2.Core.Identity User)> SignIn(string name, bool author, Guid? user = null)
        {
            var id = user ?? Guid.NewGuid();
            if (user is null)
                await Execute("insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)",
                    id, name, author);
            var ticket = RandomNumberGenerator.GetBytes(32);
            await Execute("insert into public.login_ticket values($1,$2,now()+interval '2 minutes')",
                SHA256.HashData(ticket), id);
            return await store.SignIn(Convert.ToHexStringLower(ticket), ct);
        }

        async Task Execute(string sql, params object[] values)
        {
            await using var command = Store.Sql(db, null, sql, values);
            await command.ExecuteNonQueryAsync(ct);
        }

        async Task<T> Scalar<T>(string sql, params object[] values)
        {
            await using var command = Store.Sql(db, null, sql, values);
            return (T)(await command.ExecuteScalarAsync(ct))!;
        }

        string History(Draft draft) => WireRoutes.DraftRevisionHistory.Replace("{id:int}", draft.Id.ToString()) + $"?revision={draft.Revision}";

        async Task<Draft> Write(int id, long revision, string title, string body) =>
            Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Save, owner.Token,
                Wire.EncodeArticleCommand(new(id, revision, Guid.NewGuid(), title, body))));

        Task<byte[]> Restore(DraftRollback rollback, string token, HttpStatusCode status = HttpStatusCode.OK) =>
            Request(HttpMethod.Post, WireRoutes.DraftRollback, token, Wire.EncodeDraftRollback(rollback), status);

        async Task<byte[]> Request(HttpMethod method, string path, string? token, byte[]? body = null,
            HttpStatusCode status = HttpStatusCode.OK, string? handle = null)
        {
            using var request = new HttpRequestMessage(method, path);
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            if (handle is not null) request.Headers.Add(WireHeaders.CurrentSession, handle);
            if (body is not null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new(Aeds.ContentType);
            }
            using var response = await server.Client.SendAsync(request, ct);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            return bytes;
        }
    }

    [PostgresFact]
    public async Task BodyEditsSaveWithoutClaimingProofOnOlderSchema()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        // Reproduce the supported physical shape before body-edit evidence was installed.
        await using (var downgrade = Store.Sql(db, null, """
            alter table public.article_body_insertion
                drop column edit_texts,
                alter column offset_utf16 set not null,
                alter column length_utf16 set not null
            """))
            await downgrade.ExecuteNonQueryAsync(ct);
        var owner = Guid.NewGuid();
        await using (var author = Store.Sql(db, null,
            "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,'Old schema author',true,true,1)", owner))
            await author.ExecuteNonQueryAsync(ct);
        var ticket = RandomNumberGenerator.GetBytes(32);
        await using (var mint = Store.Sql(db, null, "insert into public.login_ticket values($1,$2,now()+interval '2 minutes')",
            SHA256.HashData(ticket), owner))
            await mint.ExecuteNonQueryAsync(ct);
        var (token, actor) = await new Store(fixture.DataSource).SignIn(Convert.ToHexStringLower(ticket), ct);
        var handle = SiteSessions.Id(actor.Id, Store.TokenDigest(token)!);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var draft = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Save,
            Wire.EncodeArticleCommand(new(0, 0, Guid.NewGuid(), "Saved body", "Omit:keep"))));
        var bodyEdit = new ArticleBodyEditsCommand(draft.Id, draft.Revision, Guid.NewGuid(), draft.Title, "keep",
            [new(0, "Omit:".Length, "")]);
        var next = Wire.DecodeDraft(await Request(HttpMethod.Post, WireRoutes.Save, Wire.EncodeArticleBodyEditsCommand(bodyEdit)));
        Assert.Equal((draft.Revision + 1, "keep"), (next.Revision, next.Body));
        var path = WireRoutes.DraftRevisionComparison.Replace("{id:int}", next.Id.ToString())
            .Replace("{sourceRevision:long}", draft.Revision.ToString()) + $"?revision={next.Revision}&map=body-edit";
        var chain = Wire.DecodeDraftRevisionBodyEditChain(await Request(HttpMethod.Get, path));
        Assert.False(chain.Available);
        Assert.Empty(chain.Edges);
        await using var proof = Store.Sql(db, null, "select count(*) from public.article_body_insertion where article_id=$1", next.Id);
        Assert.Equal(0L, (long)(await proof.ExecuteScalarAsync(ct))!);

        async Task<byte[]> Request(HttpMethod method, string route, byte[]? bytes = null)
        {
            using var request = new HttpRequestMessage(method, route);
            request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            request.Headers.Add(WireHeaders.CurrentSession, handle);
            if (bytes is not null)
            {
                request.Content = new ByteArrayContent(bytes);
                request.Content.Headers.ContentType = new(Aeds.ContentType);
            }
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
    }
}
