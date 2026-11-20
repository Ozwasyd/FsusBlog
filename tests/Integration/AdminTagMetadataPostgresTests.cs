using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Passkeys;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminTagMetadataPostgresTests
{
    [PostgresFact]
    public async Task UnusedTagChangesRetainAliasesAndAdvanceOnlyTheTaxonomyWatermark()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (id, token, _) = await FixtureSql.AdminAsync(db, ct, "tag-editor", 10, [1], [2]);
        await Sql("insert into public.tag(id,name,description) values(1,'Ancienne','Original description'),(2,'Other',null),(3,'Peer',null)");
        await Sql("insert into public.tag_url_name values('ARCHIVED',2)");

        await using var lease = new InstanceLease(fixture.ConnectionString);
        await lease.Start(NullLogger.Instance, ct, new(AdminTagMetadata: true));
        var admin = new AdminPasskeyStore(fixture.DataSource, lease, new PasskeyConfiguration(new Uri("https://localhost"), "localhost"));
        var publications = Project();
        await publications.Refresh(ct);
        var baseline = publications.Snapshot!;
        Assert.Equal(0L, baseline.TaxonomyEpoch);
        Assert.Equal(1, baseline.Taxonomy.TagByName("Ancienne"));
        var siteUser = await fixture.SignInSiteUser("tag-site-user", ct);
        Assert.Equal(Rejection.Unauthorized, (await Assert.ThrowsAsync<BusinessException>(() => admin.ReadTagMetadata(siteUser.Token, 1, ct))).Rejection);

        var pow = new ScopedPow(TimeProvider.System);
        var first = new AdminTagMetadataCommand(1, 0, Guid.NewGuid(), "Cafe\u0301 nouveau", " Changed description. ");
        var receipt = Wire.DecodeAdminTagMetadata(await Execute(first, Proof(first)));
        Assert.Equal(new AdminTagMetadata(1, 1, "Café nouveau", "Changed description.", true), receipt);
        var changed = publications.Snapshot!;
        Assert.NotEqual(baseline.Generation, changed.Generation);
        Assert.Equal(baseline.Watermark, changed.Watermark);
        Assert.Equal(1L, changed.TaxonomyEpoch);
        Assert.Equal(1, changed.Taxonomy.TagByName("ancienne"));
        Assert.Equal(1, changed.Taxonomy.TagByName("CAFE\u0301 NOUVEAU"));
        Assert.Contains("Changed description.", System.Text.Encoding.UTF8.GetString(changed.Taxonomy.ById(true, 1)!.Value.Html));
        Assert.Equal(receipt, Wire.DecodeAdminTagMetadata(await Execute(first, null)));
        Assert.Same(changed, publications.Snapshot);

        var stale = first with { RequestId = Guid.NewGuid(), Name = "Too late" };
        await Assert.ThrowsAsync<BusinessException>(() => Execute(stale, Proof(stale)));
        var reserved = first with { Id = 3, RequestId = Guid.NewGuid(), Name = "Archived" };
        await Assert.ThrowsAsync<BusinessException>(() => Execute(reserved, Proof(reserved)));
        var collision = first with { Id = 3, RequestId = Guid.NewGuid(), Name = "CAFÉ NOUVEAU" };
        await Assert.ThrowsAsync<BusinessException>(() => Execute(collision, Proof(collision)));
        var wrongProof = first with { Id = 2, RequestId = Guid.NewGuid(), Name = "Other changed" };
        await Assert.ThrowsAsync<ScopedPowFailure>(() => Execute(wrongProof, Proof(wrongProof with { Name = "Different intent" })));
        var cleared = first with { RequestId = Guid.NewGuid(), ExpectedRevision = 1, Description = "    " };
        var clearProof = Proof(cleared);
        var clear = Wire.DecodeAdminTagMetadata(await Execute(cleared, clearProof));
        Assert.Equal(new AdminTagMetadata(1, 2, "Café nouveau", "", true), clear);
        var epochTwo = publications.Snapshot!;
        Assert.NotEqual(changed.Generation, epochTwo.Generation);
        Assert.Same(epochTwo, publications.Snapshot);
        Assert.Equal(2L, await Number("select count(*) from public.tag_url_name where tag_id=1"));
        Assert.Equal(0L, await Number("select count(*) from public.blog_outbox"));
        var noWrite = cleared with { RequestId = Guid.NewGuid(), ExpectedRevision = 2 };
        var noOp = Wire.DecodeAdminTagMetadata(await Execute(noWrite, Proof(noWrite)));
        Assert.False(noOp.Changed);
        Assert.Same(epochTwo, publications.Snapshot);
        Assert.Equal(3L, await Number("select count(*) from public.admin_tag_metadata_command"));
        Assert.Equal(2L, await Number("select count(*) from public.admin_tag_metadata_command where changed"));

        // Same database, newly built instance, no administrator feature detection from the request path.
        var restarted = Project();
        await restarted.Refresh(ct);
        Assert.Equal(epochTwo.Generation, restarted.Snapshot!.Generation);
        Assert.Equal(1, restarted.Snapshot.Taxonomy.TagByName("Ancienne"));
        await Sql("update public.admin_principal set generation=generation+1 where id=$1", id);
        await Assert.ThrowsAsync<BusinessException>(() => Execute(first, null));

        Publications Project() => new(fixture.DataSource, new WebPages("<html><head></head><!--fsus-public-content--></html>"),
            NullLogger<Publications>.Instance, lease);

        Task<byte[]> Execute(AdminTagMetadataCommand change, string? proof)
        {
            var ctx = new DefaultHttpContext();
            ctx.Connection.RemoteIpAddress = IPAddress.Loopback;
            if (proof is not null) ctx.Request.Headers[WireHeaders.PowProof] = proof;
            return publications.AdministrativePublication(invalidate => admin.ChangeTagMetadata(token, change,
                Wire.EncodeAdminTagMetadataCommand(change), ctx, pow, invalidate, ct), ct);
        }

        string Proof(AdminTagMetadataCommand change)
        {
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
            var challenge = pow.Issue(PowScope.AdminTagMetadata, change.Id.ToString(CultureInfo.InvariantCulture), token,
                IPAddress.Loopback, nonce, Wire.EncodeAdminTagMetadataCommand(change));
            return SolveProof(challenge, nonce, ct);
        }

        Task Sql(string text, params object[] values) =>
            FixtureSql.ExecuteAsync(db, null, ct, text, values);

        async Task<long> Number(string text)
        {
            return (long)(await FixtureSql.ScalarAsync(db, null, ct, text))!;
        }
    }

    [PostgresFact]
    public async Task CreateTagReservesCanonicalNameWithoutTakingExistingAliases()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (_, token, _) = await FixtureSql.AdminAsync(db, ct, "tag-creator", 10, [1], [2]);
        await FixtureSql.ExecuteAsync(db, null, ct,
            "insert into public.tag(id,name) values(4,'Retired tag successor'),(70,$1)", "Cafe\u0301 existant");
        await FixtureSql.ExecuteAsync(db, null, ct, "insert into public.tag_url_name values('RETIRED TOPIC',4)");
        await using var lease = new InstanceLease(fixture.ConnectionString);
        await lease.Start(NullLogger.Instance, ct, new(AdminTagMetadata: true));
        var admin = new AdminPasskeyStore(fixture.DataSource, lease, new PasskeyConfiguration(new Uri("https://localhost"), "localhost"));
        var publications = PublicationFixture.Project(fixture.DataSource, lease);
        await publications.Refresh(ct);
        var before = publications.Snapshot!;
        Assert.Equal(4, before.Taxonomy.TagByName("retired topic"));
        Assert.Equal(70, before.Taxonomy.TagByName("CAFÉ EXISTANT"));

        var pow = new ScopedPow(TimeProvider.System);
        var create = new AdminTagMetadataCommand(0, 0, Guid.NewGuid(), " Nouveau cafe\u0301 ", " New tag description. ");
        Assert.Throws<ProtocolException>(() => Wire.EncodeAdminTagMetadataCommand(create));
        var input = Wire.EncodeAdminTagCreateCommand(create);
        Assert.Throws<ProtocolException>(() => Wire.DecodeAdminTagMetadataCommand(input));
        Assert.Equal(create, Wire.DecodeAdminTagCreateCommand(input));
        var output = await Execute(create, await Proof(create));
        var receipt = Wire.DecodeAdminTagMetadata(output);
        Assert.True(receipt.Id > 70);
        Assert.Equal(new AdminTagMetadata(receipt.Id, 1, "Nouveau café", "New tag description.", true), receipt);
        Assert.Equal(receipt with { Changed = false }, await admin.ReadTagMetadata(token, receipt.Id, ct));
        var after = publications.Snapshot!;
        Assert.Equal(before.Watermark, after.Watermark);
        Assert.Equal(before.TaxonomyEpoch + 1, after.TaxonomyEpoch);
        Assert.NotEqual(before.Generation, after.Generation);
        Assert.Equal(receipt.Id, after.Taxonomy.TagByName("NOUVEAU CAFE\u0301"));
        Assert.Equal(0, after.Taxonomy.ById(true, receipt.Id)!.Value.ArticleCount);
        Assert.Equal(receipt.Id, Assert.IsType<int>(await FixtureSql.ScalarAsync(db, null, ct,
            "select tag_id from public.tag_url_name where name_key='NOUVEAU CAFÉ'")));
        Assert.Equal(output, await Execute(create, null));

        foreach (var existing in new[] { " retired topic ", " CAFÉ EXISTANT " })
        {
            var duplicate = create with { RequestId = Guid.NewGuid(), Name = existing };
            var proof = await Proof(duplicate);
            var conflict = await Assert.ThrowsAsync<BusinessException>(() => Execute(duplicate, proof));
            Assert.Equal(Rejection.Conflict, conflict.Rejection);
        }
        var reusedKey = create with { Name = "Different tag" };
        Assert.Equal(Rejection.Conflict, (await Assert.ThrowsAsync<BusinessException>(() => Execute(reusedKey, null))).Rejection);
        Assert.Same(after, publications.Snapshot);
        Assert.Equal(4, after.Taxonomy.TagByName("Retired topic"));
        Assert.Equal(70, after.Taxonomy.TagByName("cafe\u0301 existant"));
        Assert.Equal(3L, await Count("select count(*) from public.tag"));
        Assert.Equal(2L, await Count("select count(*) from public.tag_url_name"));
        Assert.Equal(1L, await Count("select count(*) from public.admin_tag_metadata_command where changed"));
        Assert.Equal(1L, await Count("select count(*) from public.scoped_pow_consumed"));
        Assert.Equal(0L, await Count("select count(*) from public.blog_outbox"));
        Assert.Equal(0L, await Count("select count(*) from public.article_revision_tag"));

        async Task<long> Count(string sql) => Assert.IsType<long>(await FixtureSql.ScalarAsync(db, null, ct, sql));

        Task<byte[]> Execute(AdminTagMetadataCommand value, string? proof)
        {
            var context = Context();
            if (proof is not null) context.Request.Headers[WireHeaders.PowProof] = proof;
            return publications.AdministrativePublication(invalidate => admin.ChangeTagMetadata(token, value,
                Wire.EncodeAdminTagCreateCommand(value), context, pow, invalidate, ct), ct);
        }

        async Task<string> Proof(AdminTagMetadataCommand value)
        {
            var context = Context();
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
            context.Request.Headers[WireHeaders.PowClientNonce] = nonce;
            var frame = await admin.ChangeTagMetadata(token, value, Wire.EncodeAdminTagCreateCommand(value), context, pow, null, ct);
            var body = Aeds.Decode(frame, FrameType.PowChallenge);
            Assert.Equal(WireLayouts.PowChallengeBytes, body.Length);
            return SolveProof(new(Encoding.ASCII.GetString(body[..WireLayouts.PowChallengeSaltBytes]).TrimEnd('\0'),
                BinaryPrimitives.ReadInt32LittleEndian(body[WireLayouts.PowChallengeSaltBytes..]),
                BinaryPrimitives.ReadInt64LittleEndian(body[WireLayouts.PowChallengeTimestampOffset..]),
                Encoding.ASCII.GetString(body[WireLayouts.PowChallengeSignatureOffset..]).TrimEnd('\0')), nonce, ct);
        }

        static DefaultHttpContext Context()
        {
            var context = new DefaultHttpContext();
            context.Connection.RemoteIpAddress = IPAddress.Loopback;
            return context;
        }
    }

    [PostgresFact]
    public async Task LoopbackAdminHttpCreatesEditsDeletesTaxonomyAndPassesSchemaVerification()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (adminId, token, _) = await FixtureSql.AdminAsync(db, ct, "loopback-taxonomy-admin", 10, [1], [2]);
        var cookie = $"{ServerProcess.DefaultAdminCookie}={token}";

        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            // Loopback HTTP admin origin automatically enables tag & category metadata endpoints.
            foreach (var path in new[] { WireRoutes.AdminTagMetadataAvailability, WireRoutes.AdminCategoryMetadataAvailability })
            {
                using var check = AdminRequest(HttpMethod.Get, path);
                using var resp = await server.Client.SendAsync(check, ct);
                Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
            }

            // 1. Tag: create -> edit -> reject cross-origin delete -> delete (AEDS EmptySuccess) -> 404.
            var createTag = new AdminTagMetadataCommand(0, 0, Guid.NewGuid(), "LoopbackTag", "Initial tag note");
            var createdTag = await SubmitTaxonomy(server.Client, WireRoutes.AdminTagCreatePow, WireRoutes.AdminTagCreate,
                HttpMethod.Post, Wire.EncodeAdminTagCreateCommand(createTag), Wire.DecodeAdminTagMetadata);
            Assert.True(createdTag.Id > 0);
            Assert.Equal("LoopbackTag", createdTag.Name);

            var editTag = new AdminTagMetadataCommand(createdTag.Id, createdTag.Revision, Guid.NewGuid(), "LoopbackTagRenamed", "Updated tag note");
            var editedTag = await SubmitTaxonomy(server.Client,
                WireRoutes.AdminTagMetadataPow.Replace("{id:int}", createdTag.Id.ToString(CultureInfo.InvariantCulture)),
                WireRoutes.AdminTagMetadata.Replace("{id:int}", createdTag.Id.ToString(CultureInfo.InvariantCulture)),
                HttpMethod.Put, Wire.EncodeAdminTagMetadataCommand(editTag), Wire.DecodeAdminTagMetadata);
            Assert.Equal("LoopbackTagRenamed", editedTag.Name);
            Assert.Equal("Updated tag note", editedTag.Description);

            var tagDeletePath = WireRoutes.AdminTagDelete.Replace("{id:int}", createdTag.Id.ToString(CultureInfo.InvariantCulture));
            using (var noOrigin = AdminRequest(HttpMethod.Post, tagDeletePath, includeOrigin: false))
            using (var forbidden = await server.Client.SendAsync(noOrigin, ct))
                Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);

            using (var delTag = AdminRequest(HttpMethod.Post, tagDeletePath))
            using (var resp = await server.Client.SendAsync(delTag, ct))
            {
                Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
                Assert.Equal(Aeds.ContentType, resp.Content.Headers.ContentType?.MediaType);
                var payload = Aeds.Decode(await resp.Content.ReadAsByteArrayAsync(ct), FrameType.EmptySuccess);
                Assert.Equal([1, 0, 0, 0], payload.ToArray());
            }

            using (var readDeleted = AdminRequest(HttpMethod.Get,
                WireRoutes.AdminTagMetadata.Replace("{id:int}", createdTag.Id.ToString(CultureInfo.InvariantCulture))))
            using (var resp = await server.Client.SendAsync(readDeleted, ct))
                Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);

            // 2. Category: create -> edit -> conflict while referenced -> delete unreferenced (AEDS EmptySuccess).
            var usedCategory = await SubmitTaxonomy(server.Client, WireRoutes.AdminCategoryCreatePow, WireRoutes.AdminCategoryCreate,
                HttpMethod.Post, Wire.EncodeAdminCategoryMetadataCommand(
                    new AdminTagMetadataCommand(0, 0, Guid.NewGuid(), "ReferencedCat", "In use")), Wire.DecodeAdminCategoryMetadata);
            await using (var tx = await db.BeginTransactionAsync(ct))
            {
                await FixtureSql.ExecuteAsync(db, tx, ct, """
                    insert into public.article(id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                    overriding system value values(100,$1,1,'Draft','Body',null,0,false,clock_timestamp(),clock_timestamp())
                    """, adminId);
                await FixtureSql.ExecuteAsync(db, tx, ct, """
                    insert into public.article_revision(article_id,revision,title,body,happened_at)
                    values(100,1,'Draft','Body',clock_timestamp())
                    """);
                await FixtureSql.ExecuteAsync(db, tx, ct, """
                    insert into public.article_revision_category(article_id,revision,category_id)
                    values(100,1,$1)
                    """, usedCategory.Id);
                await tx.CommitAsync(ct);
            }

            using (var blockedDel = AdminRequest(HttpMethod.Post,
                WireRoutes.AdminCategoryDelete.Replace("{id:int}", usedCategory.Id.ToString(CultureInfo.InvariantCulture))))
            using (var resp = await server.Client.SendAsync(blockedDel, ct))
                Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);

            var freeCategory = await SubmitTaxonomy(server.Client, WireRoutes.AdminCategoryCreatePow, WireRoutes.AdminCategoryCreate,
                HttpMethod.Post, Wire.EncodeAdminCategoryMetadataCommand(
                    new AdminTagMetadataCommand(0, 0, Guid.NewGuid(), "UnusedCat", "Temp")), Wire.DecodeAdminCategoryMetadata);
            var editedCategory = await SubmitTaxonomy(server.Client,
                WireRoutes.AdminCategoryMetadataPow.Replace("{id:int}", freeCategory.Id.ToString(CultureInfo.InvariantCulture)),
                WireRoutes.AdminCategoryMetadata.Replace("{id:int}", freeCategory.Id.ToString(CultureInfo.InvariantCulture)),
                HttpMethod.Put, Wire.EncodeAdminCategoryMetadataCommand(
                    new AdminTagMetadataCommand(freeCategory.Id, freeCategory.Revision, Guid.NewGuid(), "UnusedCat2", "Temp2")),
                Wire.DecodeAdminCategoryMetadata);
            Assert.Equal("UnusedCat2", editedCategory.Name);

            using (var delCat = AdminRequest(HttpMethod.Post,
                WireRoutes.AdminCategoryDelete.Replace("{id:int}", freeCategory.Id.ToString(CultureInfo.InvariantCulture))))
            using (var resp = await server.Client.SendAsync(delCat, ct))
            {
                Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
                Assert.Equal(Aeds.ContentType, resp.Content.Headers.ContentType?.MediaType);
                var payload = Aeds.Decode(await resp.Content.ReadAsByteArrayAsync(ct), FrameType.EmptySuccess);
                Assert.Equal([1, 0, 0, 0], payload.ToArray());
            }
        }

        // 3. After deleting tag & category (removing their FK-bound command rows while advancing taxonomy_epoch),
        //    schema verification and a fresh server startup must succeed cleanly.
        await CurrentSchema.VerifyAsync(db, ct);
        await using (var restarted = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            using var req = AdminRequest(HttpMethod.Get, WireRoutes.AdminCategories);
            using var resp = await restarted.Client.SendAsync(req, ct);
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        }

        HttpRequestMessage AdminRequest(HttpMethod method, string path, bool includeOrigin = true)
        {
            var req = new HttpRequestMessage(method, path);
            req.Headers.Host = ServerProcess.DefaultAdminHost;
            req.Headers.Add("Cookie", cookie);
            if (includeOrigin && method != HttpMethod.Get)
                req.Headers.Add("Origin", ServerProcess.DefaultAdminOrigin);
            return req;
        }

        async Task<AdminTagMetadata> SubmitTaxonomy(HttpClient client, string powPath, string mutationPath,
            HttpMethod method, byte[] frame, Func<ReadOnlySpan<byte>, AdminTagMetadata> decode)
        {
            var nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            PowChallenge challenge;
            using (var powReq = AdminRequest(HttpMethod.Post, powPath))
            {
                powReq.Headers.Add(WireHeaders.PowClientNonce, nonce);
                powReq.Content = new ByteArrayContent(frame);
                powReq.Content.Headers.ContentType = new(Aeds.ContentType);
                using var powResp = await client.SendAsync(powReq, ct);
                Assert.Equal(HttpStatusCode.OK, powResp.StatusCode);
                var body = Aeds.Decode(await powResp.Content.ReadAsByteArrayAsync(ct), FrameType.PowChallenge);
                challenge = new(Encoding.ASCII.GetString(body[..WireLayouts.PowChallengeSaltBytes]).TrimEnd('\0'),
                    BinaryPrimitives.ReadInt32LittleEndian(body[WireLayouts.PowChallengeSaltBytes..]),
                    BinaryPrimitives.ReadInt64LittleEndian(body[WireLayouts.PowChallengeTimestampOffset..]),
                    Encoding.ASCII.GetString(body[WireLayouts.PowChallengeSignatureOffset..]).TrimEnd('\0'));
            }
            using var mutReq = AdminRequest(method, mutationPath);
            mutReq.Headers.Add(WireHeaders.PowProof, SolveProof(challenge, nonce, ct));
            mutReq.Content = new ByteArrayContent(frame);
            mutReq.Content.Headers.ContentType = new(Aeds.ContentType);
            using var mutResp = await client.SendAsync(mutReq, ct);
            Assert.Equal(HttpStatusCode.OK, mutResp.StatusCode);
            Assert.Equal(Aeds.ContentType, mutResp.Content.Headers.ContentType?.MediaType);
            return decode(await mutResp.Content.ReadAsByteArrayAsync(ct));
        }
    }

    internal static string SolveProof(PowChallenge challenge, string clientNonce, CancellationToken ct)
    {
        var number = 0;
        while (!ScopedPow.HasWork(challenge.Salt, number.ToString(CultureInfo.InvariantCulture), clientNonce, challenge.Difficulty))
        {
            ct.ThrowIfCancellationRequested();
            ++number;
        }

        using var output = new MemoryStream();
        using var writer = new BinaryWriter(output);
        writer.Write("FPOW\u0001"u8);
        writer.Write(challenge.Difficulty);
        writer.Write(challenge.Timestamp);
        foreach (var value in new[] { challenge.Salt, number.ToString(CultureInfo.InvariantCulture), challenge.Signature, clientNonce })
        {
            writer.Write((ushort)value.Length);
            writer.Write(System.Text.Encoding.ASCII.GetBytes(value));
        }
        writer.Flush();
        return Convert.ToBase64String(output.ToArray());
    }
}
