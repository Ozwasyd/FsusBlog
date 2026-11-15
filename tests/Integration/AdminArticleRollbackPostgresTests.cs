using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class AdminArticleRollbackPostgresTests
{
    [PostgresFact]
    public async Task PublishedRollbackIsAdministratorAttributedAtomicAndIdempotent()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var author = await SeedHistory(db, ct);
        var admin = await CreateAdmin(db, ct, "history-administrator", true);
        var other = await CreateAdmin(db, ct, "other-administrator", true);
        var manager = await CreateAdmin(db, ct, "no-article-grant", false);
        var service = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("https://localhost"), "localhost"));
        var publications = new Publications(fixture.DataSource, new WebPages("<!--fsus-public-content-->"), NullLogger<Publications>.Instance);
        await publications.Refresh(ct);
        var originalProjection = publications.Snapshot!;
        Assert.Equal("Later body", originalProjection.Article(1)!.Body);
        var intent = new AdminArticleRollbackIntent(1, 2, 2, 1, Guid.NewGuid(), "Restore the verified historical publication");
        await Denied(Rejection.Unauthorized, () => service.CheckArticleRollbackAvailability(null, ct));
        await Denied(Rejection.Forbidden, () => service.CheckArticleRollbackAvailability(manager.Token, ct));
        await Denied(Rejection.NotFound, () => service.PreviewArticleRollback(admin.Token, 2, 1, ct));
        Assert.Equal(2, (await service.PreviewArticleRollback(admin.Token, 1, 1, ct)).BlockingReason);
        await Denied(Rejection.Conflict, () => service.BeginArticleRollbackStepUp(admin.Token, intent, ct));
        await SeedResponsibility(db, ct);
        Assert.True((await service.PreviewArticleRollback(admin.Token, 1, 1, ct)).PackageComplete);
        await Denied(Rejection.Conflict,
            () => service.BeginArticleRollbackStepUp(admin.Token, intent with { ExpectedPublicationId = 998 }, ct));
        Aeds.Decode(await service.BeginArticleRollbackStepUp(admin.Token, intent, ct), FrameType.PasskeyLoginBegin);

        // The browser suite verifies actual user-verifying assertions. Native store integration supplies only the proof row.
        var proof = await SeedProof(db, ct, admin, AdminPasskeyStore.ArticleRollbackIntentDigest(intent), action: 3);
        await Denied(Rejection.Forbidden, () => Perform(admin, null, intent));
        await Denied(Rejection.Forbidden, () => Perform(other, proof, intent));
        await Denied(Rejection.Forbidden, () => Perform(admin, proof, intent with { Reason = "A different rollback reason" }));
        await Execute("""
            insert into public.article_revision(article_id,revision,title,body,happened_at)
                values(1,3,'A newer private draft','Keep it intact',clock_timestamp());
            update public.article set revision=3,title='A newer private draft',body='Keep it intact' where id=1;
            """);
        Assert.Equal((int)AdminArticleRollbackBlock.UnpublishedDraft,
            (await service.PreviewArticleRollback(admin.Token, 1, 1, ct)).BlockingReason);
        await Denied(Rejection.Conflict,
            () => service.BeginArticleRollbackStepUp(admin.Token, intent with { ExpectedRevision = 3 }, ct));
        await Denied(Rejection.Conflict, () => Perform(admin, proof, intent));
        Assert.Equal("Keep it intact", await Scalar<string>("select body from public.article where id=1"));
        await Execute("""
            update public.article set revision=2,title='Later publication',body='Later body' where id=1;
            delete from public.article_revision where article_id=1 and revision=3;
            """);
        await Execute("alter table public.blog_outbox add constraint fixture_refusal check (revision <> 3) not valid");
        var failed = await Assert.ThrowsAsync<PostgresException>(() => Perform(admin, proof, intent));
        Assert.Equal(PostgresErrorCodes.CheckViolation, failed.SqlState);
        Assert.Same(originalProjection, publications.Snapshot);
        Assert.Equal(2L, await Scalar<long>("select revision from public.article where id=1"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.admin_article_rollback"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_publication_canonical"));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.admin_article_rollback_step_up where kind=2"));
        await Execute("alter table public.blog_outbox drop constraint fixture_refusal");

        var receipts = await Task.WhenAll(Perform(admin, proof, intent), Perform(admin, proof, intent));
        var result = receipts[0];
        Assert.Equal(result, receipts[1]);
        Assert.Equal(result, await Perform(admin, null, intent));
        await Denied(Rejection.Conflict, () => Perform(admin, proof, intent with { Reason = "Attempt a changed admin replay" }));
        await Denied(Rejection.Forbidden, () => Perform(other, proof, intent));
        Assert.Equal((1, 3L, 1L, 2L, 3), (result.ArticleId, result.Revision, result.SourceRevision, result.PreviousPublicationId, result.PublicationNo));
        Assert.True(result.PublicationId > 2);
        Assert.NotSame(originalProjection, publications.Snapshot);
        var restored = publications.Snapshot!.Article(1)!;
        Assert.Equal("Historical release", restored.Title);
        Assert.Equal("Historical body", restored.Body);
        Assert.Equal(result.PublicationId, restored.Publication);
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.article_publication_canonical c join public.blog_outbox o on o.id=c.outbox_id and o.kind='publish'
            where c.publication_id=$1 and c.revision=$2 and c.rights_snapshot_id=$3 and c.transition='replace'
            """, result.PublicationId, result.Revision, result.RightsSnapshotId));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.article_publication_canonical"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_command where command_id=$1", intent.IdempotencyKey));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.admin_article_rollback_step_up where kind=2"));
        Assert.Equal(author, await Scalar<Guid>("select owner_id from public.article where id=1"));
        Assert.Equal(admin.Id, await Scalar<Guid>("select admin_actor_id from public.article_publication_history where revision=3 and actor_id is null"));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.admin_article_rollback b
              join public.article_publication_rights w on w.id=b.rights_snapshot_id and w.publication_id=b.publication_id
              join public.article_revision_rights r on r.article_id=w.article_id and r.revision=w.revision
              join public.article_revision_responsibility d on d.id=b.responsibility_snapshot_id and d.source_snapshot_id=1
              join public.article_publication_responsibility p on p.publication_id=b.publication_id and p.snapshot_id=d.id
              join public.article_revision_category c on c.article_id=b.article_id and c.revision=b.revision and c.category_id=10
              join public.article_revision_tag t on t.article_id=b.article_id and t.revision=b.revision and t.tag_id=11
            where b.principal_id=$1 and b.command_id=$2 and b.reason=$3
               and r.copyright_holder='Original holder' and d.responsible_party='Historical claimant'
            """, admin.Id, intent.IdempotencyKey, intent.Reason));
        await Execute("delete from public.admin_permission where principal_id=$1 and permission='article.write'", admin.Id);
        await Denied(Rejection.Forbidden, () => Perform(admin, null, intent));

        async Task<AdminArticleRollbackReceipt> Perform(Admin actor, string? assertion, AdminArticleRollbackIntent command) =>
            await publications.AdministrativePublication(
                invalidate => service.ExecuteArticleRollback(actor.Token, assertion, command, invalidate, ct), ct);

        Task Execute(string sql, params object[] parameters) => ExecuteSql(db, ct, sql, parameters);
        Task<T> Scalar<T>(string sql, params object[] parameters) => ScalarSql<T>(db, ct, sql, parameters);
    }

    [PostgresFact]
    public async Task DraftRollbackWithdrawsTheArticleAndRetainsAnIndependentPrivateRelease()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var author = await SeedHistory(db, ct);
        var admin = await CreateAdmin(db, ct, "draft-rollback-admin", true);
        var other = await CreateAdmin(db, ct, "different-admin", true);
        var manager = await CreateAdmin(db, ct, "draft-rollback-without-grant", false);
        var service = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("https://localhost"), "localhost"));
        var publications = new Publications(fixture.DataSource, new WebPages("<!--fsus-public-content-->"), NullLogger<Publications>.Instance);
        await publications.Refresh(ct);
        var originalProjection = publications.Snapshot!;
        Assert.Equal("Later body", originalProjection.Article(1)!.Body);
        var intent = new AdminArticleDraftRollbackIntent(1, 2, 2, 1, Guid.NewGuid(), "Return reviewed history to a private draft", 0);
        var publishedIntent = new AdminArticleRollbackIntent(1, 2, 2, 1, intent.IdempotencyKey, intent.Reason);
        var draftDigest = AdminPasskeyStore.ArticleDraftRollbackIntentDigest(intent);
        var publishedDigest = AdminPasskeyStore.ArticleRollbackIntentDigest(publishedIntent);
        Assert.False(draftDigest.AsSpan().SequenceEqual(publishedDigest));

        await Denied(Rejection.Unauthorized, () => service.CheckArticleDraftRollbackAvailability(null, ct));
        await Denied(Rejection.Forbidden, () => service.CheckArticleDraftRollbackAvailability(manager.Token, ct));
        await service.CheckArticleDraftRollbackAvailability(admin.Token, ct);
        await Denied(Rejection.Conflict, () => service.BeginArticleDraftRollbackStepUp(admin.Token, intent, ct));
        await SeedResponsibility(db, ct);
        await Denied(Rejection.Conflict,
            () => service.BeginArticleDraftRollbackStepUp(admin.Token, intent with { ExpectedPublicationId = 998 }, ct));

        Aeds.Decode(await service.BeginArticleRollbackStepUp(admin.Token, publishedIntent, ct), FrameType.PasskeyLoginBegin);
        var begin = await service.BeginArticleDraftRollbackStepUp(admin.Token, intent, ct);
        var challenge = Aeds.Decode(begin, FrameType.PasskeyLoginBegin);
        var token = Encoding.ASCII.GetString(challenge.Slice(WireLayouts.PasskeyLoginBeginTokenOffset, WireLayouts.PasskeyTokenSize)).TrimEnd('\0');
        await Denied(Rejection.Forbidden, () => service.CompleteArticleRollbackStepUp(admin.Token,
            new PasskeyLoginRequest(token, "", [], [], [], [], [], false), ct));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.admin_article_rollback_step_up
            where session_digest=$1 and kind=1 and action=7 and body_digest=$2
            """, admin.Digest, draftDigest));

        var publishedProof = await SeedProof(db, ct, admin, publishedDigest, action: 3);
        await Denied(Rejection.Forbidden, () => Perform(admin, publishedProof, intent));
        await Execute("delete from public.admin_article_rollback_step_up where session_digest=$1 and kind=2", admin.Digest);
        var proof = await SeedProof(db, ct, admin, draftDigest, action: 7);
        await Denied(Rejection.Forbidden, () => Perform(admin, null, intent));
        await Denied(Rejection.Forbidden, () => Perform(other, proof, intent));
        await Denied(Rejection.Forbidden, () => Perform(admin, proof, intent with { Reason = "Changed reason after verification" }));
        await Denied(Rejection.Forbidden, () => publications.AdministrativePublication(
            invalidate => service.ExecuteArticleRollback(admin.Token, proof, publishedIntent, invalidate, ct), ct));

        var scheduleCommand = Guid.NewGuid();
        await Execute("insert into public.article_command values($1,$2,$3,1,2,'Later publication','Later body',true)",
            author, scheduleCommand, RandomNumberGenerator.GetBytes(32));
        await Execute("""
            insert into public.article_schedule_receipt values($1,$2,clock_timestamp()+interval '1 day',2)
            """, author, scheduleCommand);
        await Execute("""
            insert into public.article_schedule(article_id,revision,actor_id,generation,command_id,due_at)
            values (1,2,$1,1,$2,clock_timestamp()+interval '1 day')
            """, author, scheduleCommand);
        Assert.Equal((int)AdminArticleRollbackBlock.PendingSchedule, (await service.PreviewArticleRollback(admin.Token, 1, 1, ct)).BlockingReason);
        await Denied(Rejection.Conflict, () => Perform(admin, proof, intent));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.article_schedule where article_id=1"));
        await Execute("delete from public.article_schedule where article_id=1");
        await Execute("""
            insert into public.article_revision(article_id,revision,title,body,happened_at)
                values(1,3,'Newer author draft','Preserve the author draft',clock_timestamp());
            update public.article set revision=3,title='Newer author draft',body='Preserve the author draft' where id=1;
            """);
        await Denied(Rejection.Conflict,
            () => service.BeginArticleDraftRollbackStepUp(admin.Token, intent with { ExpectedRevision = 3 }, ct));
        Assert.Equal("Preserve the author draft", await Scalar<string>("select body from public.article where id=1"));
        await Execute("""
            update public.article set revision=2,title='Later publication',body='Later body' where id=1;
            delete from public.article_revision where article_id=1 and revision=3;
            """);

        await Execute("alter table public.blog_outbox add constraint fixture_refusal check (revision <> 3) not valid");
        var failure = await Assert.ThrowsAsync<PostgresException>(() => Perform(admin, proof, intent));
        Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
        Assert.Same(originalProjection, publications.Snapshot);
        Assert.Equal(2L, await Scalar<long>("select published_revision from public.article where id=1"));
        Assert.Equal(2, await Scalar<int>("select publication_count from public.article where id=1"));
        Assert.Equal(2L, await Scalar<long>("select count(*) from public.article_revision where article_id=1"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.admin_article_rollback"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_revision_responsibility where revision=3"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_publication_rights where revision=3"));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.admin_article_rollback_step_up where kind=2 and action=7"));
        await Execute("alter table public.blog_outbox drop constraint fixture_refusal");

        var receipts = await Task.WhenAll(Perform(admin, proof, intent), Perform(admin, proof, intent));
        var result = receipts[0];
        Assert.Equal(result, receipts[1]);
        Assert.Equal(result, await Perform(admin, null, intent));
        Assert.Equal((1, 3L, 1L, 2L, 3, 0),
            (result.ArticleId, result.Revision, result.SourceRevision, result.PreviousPublicationId, result.PublicationNo, result.TargetStatus));
        Assert.True(result.PrivateReleaseId > 2 && result.TransitionedUnixMs > 0);
        await Denied(Rejection.Conflict, () => Perform(admin, null, intent with { Reason = "Different reason for this saved command" }));
        await Denied(Rejection.Conflict, () => publications.AdministrativePublication(
            invalidate => service.ExecuteArticleRollback(admin.Token, null, publishedIntent, invalidate, ct), ct));
        var draftProjection = publications.Snapshot!;
        Assert.Null(draftProjection.Article(1));
        Assert.NotEqual(originalProjection.Generation, draftProjection.Generation);

        Assert.Equal(author, await Scalar<Guid>("select owner_id from public.article where id=1"));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.article where id=1 and revision=3 and published_revision is null
              and publication_count=3 and not deleted and title='Historical release' and body='Historical body'
            """));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_publication where article_id=1"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_command where command_id=$1", intent.IdempotencyKey));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.admin_article_rollback_step_up where kind=2"));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_publication_canonical"));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.blog_outbox where article_id=1 and revision=3 and kind='retract' and processed_at is not null
            """));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.blog_outbox where article_id=1 and revision=3"));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.article_publication_history
            where article_id=1 and event_no=3 and revision=3 and publication_no=3 and publication_id is null
              and supersedes_id=2 and kind='retract' and reason='administrator-rollback-draft'
              and actor_id is null and admin_actor_id=$1 and admin_command_id=$2
            """, admin.Id, intent.IdempotencyKey));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.admin_article_rollback b
              join public.article_publication_rights w on w.id=b.rights_snapshot_id and w.publication_id=b.publication_id
              join public.article_revision_rights r on r.article_id=w.article_id and r.revision=w.revision
              join public.article_revision_responsibility d on d.id=b.responsibility_snapshot_id and d.source_snapshot_id=1
              join public.article_publication_responsibility p on p.publication_id=b.publication_id and p.snapshot_id=d.id
              join public.article_revision_category c on c.article_id=b.article_id and c.revision=b.revision and c.category_id=10
              join public.article_revision_tag t on t.article_id=b.article_id and t.revision=b.revision and t.tag_id=11
            where b.principal_id=$1 and b.command_id=$2 and b.reason=$3 and b.destination=0
              and b.publication_id=$4 and b.rights_snapshot_id=$5 and b.responsibility_snapshot_id=$6
              and r.copyright_holder='Original holder' and r.license_type='CC-BY-4.0' and d.responsible_party='Historical claimant'
            """, admin.Id, intent.IdempotencyKey, intent.Reason, result.PrivateReleaseId, result.RightsSnapshotId,
            result.ResponsibilitySnapshotId));
        await Execute("delete from public.admin_permission where principal_id=$1 and permission='article.write'", admin.Id);
        await Denied(Rejection.Forbidden, () => Perform(admin, null, intent));

        // Restart through Kestrel to exercise the public representations and the owner's private draft.
        var secret = RandomNumberGenerator.GetBytes(32);
        await Execute("insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 minute')",
            SHA256.HashData(secret), author);
        var session = await new Store(fixture.DataSource).SignIn(Convert.ToHexStringLower(secret), ct);
        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct);
        foreach (var path in new[] { "/article/1", WireRoutes.PublicArticle.Replace("{id}", "1", StringComparison.Ordinal) })
        {
            using var response = await restarted.Client.GetAsync(path, ct);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
        }
        using (var search = await restarted.Client.GetAsync(WireRoutes.PublicSearch + "?q=Historical", ct))
        {
            Assert.Equal(HttpStatusCode.OK, search.StatusCode);
            var payload = Aeds.Decode(await search.Content.ReadAsByteArrayAsync(ct), FrameType.ArticleSearch);
            Assert.True(payload[..4].SequenceEqual("FAS4"u8));
            Assert.Equal(0, BinaryPrimitives.ReadInt32LittleEndian(payload[8..]));
        }
        using (var old = new HttpRequestMessage(HttpMethod.Head, $"{WireRoutes.PublicSearchCorpus}?generation={originalProjection.GenerationHeader}"))
        using (var conflict = await restarted.Client.SendAsync(old, ct))
            Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        using (var read = new HttpRequestMessage(HttpMethod.Get, WireRoutes.Draft.Replace("{id:int}", "1", StringComparison.Ordinal)))
        {
            read.Headers.Add("Cookie", $"fsus-v2-session={session.Token}");
            using var response = await restarted.Client.SendAsync(read, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var draft = Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal(new Draft(1, 3, "Historical release", "Historical body", false), draft);
        }
        using (var publish = SiteAedsFixture.Request(HttpMethod.Post, WireRoutes.Publish,
            Wire.EncodeArticleCommand(new(1, 3, Guid.NewGuid(), "", "")), session.Token, handle: null))
        {
            using var response = await restarted.Client.SendAsync(publish, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.article_publication
            where article_id=1 and revision=4 and publication_no=4 and publication_id<>$1
            """, result.PrivateReleaseId));

        Task<AdminArticleDraftRollbackReceipt> Perform(Admin actor, string? assertion, AdminArticleDraftRollbackIntent command) =>
            publications.AdministrativePublication(
                invalidate => service.ExecuteArticleDraftRollback(actor.Token, assertion, command, invalidate, ct), ct);

        Task Execute(string sql, params object[] parameters) => ExecuteSql(db, ct, sql, parameters);
        Task<T> Scalar<T>(string sql, params object[] parameters) => ScalarSql<T>(db, ct, sql, parameters);
    }

    private static async Task<Guid> SeedHistory(NpgsqlConnection db, CancellationToken ct)
    {
        var author = Guid.NewGuid();
        await ExecuteSql(db, ct, "insert into public.blog_user values($1,'Article fixture author',true,true,1)", author);
        await ExecuteSql(db, ct, """
            with article as (
                insert into public.article(owner_id,revision,title,body,published_revision,publication_count,deleted)
                    values($1,2,'Later publication','Later body',2,2,false) returning id
            )
            insert into public.article_revision(article_id,revision,title,body,happened_at)
            select article.id, seed.revision, seed.title, seed.body, seed.happened_at
            from article cross join (values
                (1,'Historical release','Historical body',clock_timestamp()-interval '1 day'),
                (2,'Later publication','Later body',clock_timestamp())) seed(revision,title,body,happened_at)
            """, author);
        await ExecuteSql(db, ct, """
            insert into public.category(id,name) values(10,'Rollback source category'),(20,'Current category');
            insert into public.tag(id,name) values(11,'Rollback source tag'),(21,'Current tag');
            insert into public.article_revision_category values (1,1,10),(1,2,20);
            insert into public.article_revision_tag values (1,1,11),(1,2,21);
            insert into public.article_revision_rights values
                (1,1,true,'CC-BY-4.0','Original holder',2025,'Original license','','append-attribution',40,true,true,false),
                (1,2,true,'all-rights-reserved','Current holder',2026,'Current license','','disabled',0,false,true,false);
            insert into public.article_publication_rights(article_id,publication_id,revision) values(1,1,1),(1,2,2);
            insert into public.article_publication(article_id,revision,publication_no,published_at)
                values(1,2,2,clock_timestamp());
            insert into public.article_publication_history(article_id,event_no,revision,publication_no,publication_id,kind,reason,happened_at)
                select 1,1,1,1,1,'retained-active','pre-history',p.published_at-interval '1 day' from public.article_publication p;
            """);
        // The current historical tail is produced by the independent site-author role, then retained.
        var authorCommand = Guid.NewGuid();
        await ExecuteSql(db, ct, """
            update public.article_publication set publication_id=2 where article_id=1;
            alter sequence public.article_publication_publication_id_seq restart with 3
            """);
        await ExecuteSql(db, ct, "insert into public.article_command values($1,$2,$3,1,2,'Later publication','Later body',true)",
            author, authorCommand, RandomNumberGenerator.GetBytes(32));
        await ExecuteSql(db, ct, """
            insert into public.article_publication_history(article_id,event_no,revision,publication_no,publication_id,supersedes_id,
                kind,reason,happened_at,actor_id,command_id)
                select 1,2,2,2,2,1,'replace','author-replaced',published_at,$1,$2 from public.article_publication
            """, author, authorCommand);
        await ExecuteSql(db, ct, "insert into public.blog_outbox(article_id,revision,kind) values(1,2,'publish')");
        return author;
    }

    private static async Task SeedResponsibility(NpgsqlConnection db, CancellationToken ct)
    {
        await ExecuteSql(db, ct, """
            with record as (
                insert into public.article_revision_responsibility(article_id,revision,responsible_party,basis,reference,recorded_by)
                values(1,1,'Historical claimant','The independent recorded historical source','estate-record-2025',current_user)
                returning id
            )
            insert into public.article_publication_responsibility select 1,1,1,id from record;
            """);
    }

    private static async Task<Admin> CreateAdmin(NpgsqlConnection db, CancellationToken ct, string handle, bool granted)
    {
        var (id, token, digest) = await FixtureSql.AdminAsync(db, ct, handle, 10, RandomNumberGenerator.GetBytes(32), [1],
            granted ? [CurrentSchema.ArticleWritePermission] : []);
        return new Admin(id, token, digest);
    }

    private static async Task<string> SeedProof(NpgsqlConnection db, CancellationToken ct, Admin actor, byte[] fingerprint, int action)
    {
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        await ExecuteSql(db, ct, """
            insert into public.admin_article_rollback_step_up
                (digest,principal_id,session_digest,generation,action,body_digest,expires_at,kind)
            values($1,$2,$3,1,$4,$5,clock_timestamp()+interval '45 seconds',2)
            """, SHA256.HashData(Encoding.ASCII.GetBytes(token)), actor.Id, actor.Digest, action, fingerprint);
        return token;
    }

    private static Task ExecuteSql(NpgsqlConnection db, CancellationToken ct, string sql, params object[] parameters) =>
        FixtureSql.ExecuteAsync(db, null, ct, sql, parameters);

    private static async Task<T> ScalarSql<T>(NpgsqlConnection db, CancellationToken ct, string sql, params object[] parameters)
    {
        return (T)(await FixtureSql.ScalarAsync(db, null, ct, sql, parameters))!;
    }

    private static async Task Denied(Rejection expected, Func<Task> action) =>
        Assert.Equal(expected, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);

    private sealed record Admin(Guid Id, string Token, byte[] Digest);
}
