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

public sealed class AdminArticleRollbackPostgresTests
{
    [PostgresFact]
    public async Task PublishedRollbackIsAdministratorAttributedAtomicAndIdempotent()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var author = Guid.NewGuid();
        await Execute("insert into public.blog_user values($1,'Article fixture author',true,true,1)", author);
        await Execute("""
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
        await Execute("""
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
        await Execute("""
            update public.article_publication set publication_id=2 where article_id=1;
            alter sequence public.article_publication_publication_id_seq restart with 3
            """);
        await Execute("insert into public.article_command values($1,$2,$3,1,2,'Later publication','Later body',true)",
            author, authorCommand, RandomNumberGenerator.GetBytes(32));
        await Execute("""
            insert into public.article_publication_history(article_id,event_no,revision,publication_no,publication_id,supersedes_id,
                kind,reason,happened_at,actor_id,command_id)
                select 1,2,2,2,2,1,'replace','author-replaced',published_at,$1,$2 from public.article_publication
            """, author, authorCommand);
        await Execute("insert into public.blog_outbox(article_id,revision,kind) values(1,2,'publish')");
        var admin = await CreateAdmin("history-administrator", true);
        var other = await CreateAdmin("other-administrator", true);
        var manager = await CreateAdmin("no-article-grant", false);
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
        await Execute("""
            with record as (
                insert into public.article_revision_responsibility(article_id,revision,responsible_party,basis,reference,recorded_by)
                values(1,1,'Historical claimant','The independent recorded historical source','estate-record-2025',current_user)
                returning id
            )
            insert into public.article_publication_responsibility select 1,1,1,id from record;
            """);
        Assert.True((await service.PreviewArticleRollback(admin.Token, 1, 1, ct)).PackageComplete);
        await Denied(Rejection.Conflict,
            () => service.BeginArticleRollbackStepUp(admin.Token, intent with { ExpectedPublicationId = 998 }, ct));
        Aeds.Decode(await service.BeginArticleRollbackStepUp(admin.Token, intent, ct), FrameType.PasskeyLoginBegin);

        // The browser suite verifies actual user-verifying assertions. Native store integration supplies only the proof row.
        var proof = await SeedProof(admin, intent);
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

        async Task<Admin> CreateAdmin(string handle, bool granted)
        {
            var id = Guid.NewGuid();
            var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            var digest = Store.TokenDigest(token)!;
            await Execute("insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,$2,$3,true,1)",
                id, handle, RandomNumberGenerator.GetBytes(32));
            await Execute("insert into public.admin_passkey_credential values($1,$2,$3,0,false,false)",
                RandomNumberGenerator.GetBytes(32), id, new byte[] { 1 });
            await Execute("insert into public.admin_permission values($1,'admin.manage')", id);
            await Execute("insert into public.admin_session values($1,$2,1,clock_timestamp()+interval '10 minutes')", digest, id);
            if (granted) await Execute("insert into public.admin_permission values($1,$2)", id, CurrentSchema.ArticleWritePermission);
            return new Admin(id, token, digest);
        }

        async Task<string> SeedProof(Admin actor, AdminArticleRollbackIntent command)
        {
            var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            await Execute("""
                insert into public.admin_article_rollback_step_up
                    (digest,principal_id,session_digest,generation,action,body_digest,expires_at,kind)
                values($1,$2,$3,1,3,$4,clock_timestamp()+interval '45 seconds',2)
                """, SHA256.HashData(Encoding.ASCII.GetBytes(token)), actor.Id, actor.Digest,
                AdminPasskeyStore.ArticleRollbackIntentDigest(command));
            return token;
        }

        async Task Execute(string sql, params object[] parameters)
        {
            await using var command = Store.Sql(db, null, sql, parameters);
            await command.ExecuteNonQueryAsync(ct);
        }

        async Task<T> Scalar<T>(string sql, params object[] parameters)
        {
            await using var command = Store.Sql(db, null, sql, parameters);
            return (T)(await command.ExecuteScalarAsync(ct))!;
        }
    }

    private static async Task Denied(Rejection expected, Func<Task> action) =>
        Assert.Equal(expected, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);

    private sealed record Admin(Guid Id, string Token, byte[] Digest);
}
