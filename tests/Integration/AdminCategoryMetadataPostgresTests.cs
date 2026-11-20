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

public sealed class AdminCategoryMetadataPostgresTests
{
    [PostgresFact]
    public async Task CreateAndRenameKeepCategoryIdentityAndImmutableArticleCoordinates()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (adminId, token, _) = await FixtureSql.AdminAsync(db, ct, "category-editor", 10, [1], [2]);
        var (_, authorToken, _) = await fixture.SignIn("category-publisher", ct);
        // Existing imports can have supplied IDs independently of the identity sequence.
        await Sql("insert into public.category(id,name) values(1,'Imported category')");
        await Sql("insert into public.tag(id,name) values(1,'Café topics')");
        await Sql("insert into public.tag_url_name values('TAG ARCHIVE',1)");

        await using var lease = new InstanceLease(fixture.ConnectionString);
        await lease.Start(NullLogger.Instance, ct, new(AdminCategoryMetadata: true));
        var admin = new AdminTagMetadataStore(new AdminSessionGate(fixture.DataSource, lease));
        var store = new Store(fixture.DataSource, lease);
        var publications = Project();
        await publications.Refresh(ct);
        var initial = publications.Snapshot!;
        Assert.Equal(0L, initial.TaxonomyEpoch);

        var pow = new ScopedPow(TimeProvider.System);
        var create = new AdminTagMetadataCommand(0, 0, Guid.NewGuid(), " Café topics ", " Original category description. ");
        var siteUser = await fixture.SignInSiteUser("category-site-user", ct);
        var denied = await Assert.ThrowsAsync<BusinessException>(() => admin.ReadCategoryMetadata(siteUser.Token, 1, ct));
        Assert.Equal(Rejection.Unauthorized, denied.Rejection);
        denied = await Assert.ThrowsAsync<BusinessException>(() => Challenge(create, MakeNonce(), siteUser.Token));
        Assert.Equal(Rejection.Unauthorized, denied.Rejection);

        var createFrame = await Execute(create, await Proof(create));
        var created = Wire.DecodeAdminCategoryMetadata(createFrame);
        Assert.True(created.Id > 1);
        Assert.Equal(new AdminTagMetadata(created.Id, 1, "Café topics", "Original category description.", true), created);
        Assert.Equal(created with { Changed = false }, await admin.ReadCategoryMetadata(token, created.Id, ct));

        var initialCategory = publications.Snapshot!;
        Assert.NotEqual(initial.Generation, initialCategory.Generation);
        Assert.Equal(initial.Watermark, initialCategory.Watermark);
        Assert.Equal(1L, initialCategory.TaxonomyEpoch);
        Assert.Equal(0, initialCategory.Taxonomy.ById(false, created.Id)!.Value.ArticleCount);
        Assert.Equal(createFrame, await Execute(create, null));
        Assert.Same(initialCategory, publications.Snapshot);

        var reusedRequest = create with { Name = "Another category" };
        var conflict = await Assert.ThrowsAsync<BusinessException>(() => Execute(reusedRequest, null));
        Assert.Equal(Rejection.Conflict, conflict.Rejection);
        var duplicate = create with { RequestId = Guid.NewGuid(), Name = "Café topics" };
        var duplicateProof = await Proof(duplicate);
        conflict = await Assert.ThrowsAsync<BusinessException>(() => Execute(duplicate, duplicateProof));
        Assert.Equal(Rejection.Conflict, conflict.Rejection);
        Assert.Same(initialCategory, publications.Snapshot);

        var draft = await Edit(ArticleAction.Save, 0, 0, "Public category article", "A public source tied to the category ID.");
        var assigned = await store.WithSession(authorToken, true, (conn, tx, actor) => Store.AssignTaxonomy(conn, tx, actor,
            new TaxonomyAssignment(draft.Id, draft.Revision, Guid.NewGuid(), created.Id, [1]), ct), ct);
        var published = await Edit(ArticleAction.Publish, draft.Id, assigned.Revision);
        var privateDraft = await Edit(ArticleAction.Save, draft.Id, published.Revision, "Private subsequent revision", "Private category source.");
        var before = publications.Snapshot!;
        var publicArticle = Assert.IsType<Article>(before.Article(draft.Id));
        Assert.Equal(new TaxonomyName(created.Id, "Café topics"), publicArticle.Category);
        Assert.NotEqual(privateDraft.Revision, publicArticle.Revision);
        var outboxCount = await Number("select count(*) from public.blog_outbox");
        var revisionCount = await Number("select count(*) from public.article_revision where article_id=$1", draft.Id);

        var rename = new AdminTagMetadataCommand(created.Id, created.Revision, Guid.NewGuid(), "Renamed category", "New category description.");
        var wrongScopeNonce = MakeNonce();
        var wrongScope = pow.Issue(PowScope.AdminTagMetadata, rename.Id.ToString(CultureInfo.InvariantCulture), token,
            IPAddress.Loopback, wrongScopeNonce, Wire.EncodeAdminCategoryMetadataCommand(rename));
        var rejected = await Assert.ThrowsAsync<ScopedPowFailure>(() =>
            Execute(rename, AdminTagMetadataPostgresTests.SolveProof(wrongScope, wrongScopeNonce, ct)));
        Assert.Equal("pow_rejected", rejected.Details);
        Assert.Same(before, publications.Snapshot);

        var renamingProof = await Proof(rename);
        var renameFrame = await Execute(rename, renamingProof);
        var renamed = Wire.DecodeAdminCategoryMetadata(renameFrame);
        Assert.Equal(new AdminTagMetadata(created.Id, 2, "Renamed category", "New category description.", true), renamed);
        Assert.Equal(renamed with { Changed = false }, await admin.ReadCategoryMetadata(token, created.Id, ct));

        var after = publications.Snapshot!;
        Assert.NotEqual(before.Generation, after.Generation);
        Assert.Equal(before.Watermark, after.Watermark);
        Assert.Equal(2L, after.TaxonomyEpoch);
        var publicAfter = Assert.IsType<Article>(after.Article(draft.Id));
        Assert.Equal(publicArticle with { Category = new TaxonomyName(created.Id, "Renamed category"), Tags = publicAfter.Tags }, publicAfter);
        Assert.Equal<TaxonomyName>(publicArticle.Tags!, publicAfter.Tags!);
        var page = after.Taxonomy.ById(false, created.Id)!.Value;
        Assert.Equal(1, page.ArticleCount);
        var html = Encoding.UTF8.GetString(page.Html);
        Assert.Contains("Renamed category", html);
        Assert.Contains("New category description.", html);
        Assert.Contains("Public category article", html);
        Assert.DoesNotContain("Private subsequent revision", html);
        Assert.Equal(1, after.Taxonomy.TagByName("Café topics"));
        Assert.Null(after.Taxonomy.TagByName("Renamed category"));

        Assert.Equal(renameFrame, await Execute(rename, null));
        var stale = rename with { RequestId = Guid.NewGuid(), Name = "Stale change" };
        var staleProof = await Proof(stale);
        conflict = await Assert.ThrowsAsync<BusinessException>(() => Execute(stale, staleProof));
        Assert.Equal(Rejection.Conflict, conflict.Rejection);
        var collidingRename = rename with { RequestId = Guid.NewGuid(), ExpectedRevision = renamed.Revision, Name = "Imported category" };
        var collisionProof = await Proof(collidingRename);
        conflict = await Assert.ThrowsAsync<BusinessException>(() => Execute(collidingRename, collisionProof));
        Assert.Equal(Rejection.Conflict, conflict.Rejection);
        Assert.Same(after, publications.Snapshot);
        Assert.Equal(2L, await Number("select count(*) from public.admin_category_metadata_command"));
        Assert.Equal(2L, await Number("select count(*) from public.scoped_pow_consumed"));
        Assert.Equal(1L, await Number("select count(*) from public.tag_url_name"));
        Assert.Equal(2L, await Number("select count(*) from public.category"));
        Assert.Equal(outboxCount, await Number("select count(*) from public.blog_outbox"));
        Assert.Equal(revisionCount, await Number("select count(*) from public.article_revision where article_id=$1", draft.Id));
        Assert.Equal(3L, await Number("""
            select count(*) from public.article_revision_category
            where article_id=$1 and category_id=$2 and revision in ($3,$4,$5)
            """, draft.Id, created.Id, assigned.Revision, published.Revision, privateDraft.Revision));

        var restarted = Project();
        await restarted.Refresh(ct);
        Assert.Equal(after.Generation, restarted.Snapshot!.Generation);
        Assert.Equal(new TaxonomyName(created.Id, "Renamed category"), restarted.Snapshot.Article(draft.Id)!.Category);
        await Sql("update public.admin_principal set generation=generation+1 where id=$1", adminId);
        denied = await Assert.ThrowsAsync<BusinessException>(() => Execute(rename, null));
        Assert.Equal(Rejection.Unauthorized, denied.Rejection);

        Publications Project() => new(fixture.DataSource, new WebPages("<!--fsus-public-content-->"), NullLogger<Publications>.Instance, lease);

        Task Sql(string sql, params object[] values) => FixtureSql.ExecuteAsync(db, null, ct, sql, values);

        async Task<long> Number(string sql, params object[] values) =>
            Assert.IsType<long>(await FixtureSql.ScalarAsync(db, null, ct, sql, values));

        async Task<ArticleState> Edit(ArticleAction action, int id, long revision, string title = "", string body = "") =>
            (await publications.Command(store, authorToken, action, new(id, revision, Guid.NewGuid(), title, body), ct)).Article;

        Task<byte[]> Execute(AdminTagMetadataCommand change, string? proof)
        {
            var http = Context();
            if (proof is not null) http.Request.Headers[WireHeaders.PowProof] = proof;
            return publications.AdministrativePublication(invalidate => admin.ChangeCategoryMetadata(token, change,
                Wire.EncodeAdminCategoryMetadataCommand(change), http, pow, invalidate, ct), ct);
        }

        Task<byte[]> Challenge(AdminTagMetadataCommand change, string nonce, string? actorToken = null)
        {
            var http = Context();
            http.Request.Headers[WireHeaders.PowClientNonce] = nonce;
            return admin.ChangeCategoryMetadata(actorToken ?? token, change, Wire.EncodeAdminCategoryMetadataCommand(change), http, pow, null, ct);
        }

        async Task<string> Proof(AdminTagMetadataCommand change)
        {
            var nonce = MakeNonce();
            var frame = await Challenge(change, nonce);
            var body = Aeds.Decode(frame, FrameType.PowChallenge);
            Assert.Equal(WireLayouts.PowChallengeBytes, body.Length);
            var challenge = new PowChallenge(Encoding.ASCII.GetString(body[..WireLayouts.PowChallengeSaltBytes]).TrimEnd('\0'),
                BinaryPrimitives.ReadInt32LittleEndian(body[WireLayouts.PowChallengeSaltBytes..]),
                BinaryPrimitives.ReadInt64LittleEndian(body[WireLayouts.PowChallengeTimestampOffset..]),
                Encoding.ASCII.GetString(body[WireLayouts.PowChallengeSignatureOffset..]).TrimEnd('\0'));
            return AdminTagMetadataPostgresTests.SolveProof(challenge, nonce, ct);
        }
    }

    private static string MakeNonce() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16));

    private static DefaultHttpContext Context()
    {
        var http = new DefaultHttpContext();
        http.Connection.RemoteIpAddress = IPAddress.Loopback;
        return http;
    }
}
