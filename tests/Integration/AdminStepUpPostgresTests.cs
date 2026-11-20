using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminStepUpPostgresTests
{
    [PostgresFact]
    public async Task ModerationProofIsScopedAndAtomicWithItsConsumer()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var member = Guid.NewGuid();
        await Execute("insert into public.blog_user(id,name,enabled,generation) values($1,'Site fixture',true,1)", member);
        await FixtureSql.AdminPrincipalAsync(db, null, ct, member, "site-fixture");
        await Execute("""
            with article as (
                insert into public.article(id,owner_id,revision,title,body,deleted) overriding system value
                values(1,$1,1,'Fixture article','Fixture article',false) returning id
            )
            insert into public.article_revision(article_id,revision,title,body,happened_at)
            select id,1,'Fixture article','Fixture article',clock_timestamp() from article
            """, member);
        await Execute("""
            insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
            values(1,1,1,0,0,false,'Original pending comment',3,'Fixture writer','en',clock_timestamp()),
                  (1,2,2,0,0,false,'Another pending comment',3,'Fixture writer','en',clock_timestamp())
            """);
        foreach (var n in new long[] { 1, 2 })
            await Execute("insert into public.comment_submit_command values($1,$2,$3,1,$4)", member, Guid.NewGuid(), RandomNumberGenerator.GetBytes(32), n);

        var moderator = await Admin("moderator", true);
        var other = await Admin("other-moderator", true);
        var siteUser = await fixture.SignInSiteUser("step-up-site-user", ct);
        var service = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var intent = new AdminModerationIntent(1, 1, 0, 1, "Policy reviewed");
        await Denied(Rejection.Unauthorized, () => service.BeginModerationStepUp(siteUser.Token, intent, ct));
        await Denied(Rejection.NotFound, () => service.BeginModerationStepUp(moderator.Token, intent with { CommentId = 3 }, ct));
        var challenge = await service.BeginModerationStepUp(moderator.Token, intent, ct);
        Aeds.Decode(challenge, FrameType.PasskeyLoginBegin);

        // Fixture credentials are synthetic, and this helper never bypasses the runtime's WebAuthn issuer.
        // Native Chrome covers proof issuance. These rows exercise only consumption and its transaction.
        var proof = await SeedProof(moderator.Id, moderator.Digest, lifetime: 45);
        await Denied(Rejection.Unauthorized, () => Consume(other.Token, proof, intent));
        await Denied(Rejection.Unauthorized, () => Consume(moderator.Token, proof, intent with { CommentId = 2 }));
        await Denied(Rejection.Unauthorized, () => Consume(moderator.Token, proof, intent with { Decision = 2 }));
        await Denied(Rejection.Unauthorized, () => Consume(moderator.Token, proof, intent with { Reason = "Different reason" }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.WithModerationProof<bool>(moderator.Token, proof, intent,
            async (connection, transaction, _) =>
            {
                await using var change = Store.Sql(connection, transaction, "update public.comment set moderation_status=1 where article_id=1 and id=1");
                Assert.Equal(1, await change.ExecuteNonQueryAsync(ct));
                throw new InvalidOperationException("Rollback the fixture action.");
            }, ct));
        Assert.Equal(moderator.Id, await Consume(moderator.Token, proof, intent));
        await Denied(Rejection.Unauthorized, () => Consume(moderator.Token, proof, intent));

        proof = await SeedProof(moderator.Id, moderator.Digest, lifetime: -1);
        await Denied(Rejection.Unauthorized, () => Consume(moderator.Token, proof, intent));
        proof = await SeedProof(moderator.Id, moderator.Digest, lifetime: 45);
        await using (var revoke = await db.BeginTransactionAsync(ct))
        {
            await using (var advance = Store.Sql(db, revoke, "update public.admin_principal set generation=2 where id=$1", moderator.Id))
                Assert.Equal(1, await advance.ExecuteNonQueryAsync(ct));
            var waiting = Consume(moderator.Token, proof, intent);
            await using var observer = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var blocked = Store.Sql(observer, null, """
                select exists(select from pg_catalog.pg_stat_activity a
                    where a.datname=current_database() and $1=any(pg_catalog.pg_blocking_pids(a.pid)))
                """, db.ProcessID);
            while (!waiting.IsCompleted && await blocked.ExecuteScalarAsync(ct) is false) await Task.Delay(15, ct);
            Assert.False(waiting.IsCompleted);
            await using (var clear = Store.Sql(db, revoke, "delete from public.admin_session where digest=$1", moderator.Digest))
                Assert.Equal(1, await clear.ExecuteNonQueryAsync(ct));
            await revoke.CommitAsync(ct);
            await Denied(Rejection.Unauthorized, () => waiting);
        }
        await using var count = Store.Sql(db, null, "select count(*) from public.admin_step_up where principal_id=$1", moderator.Id);
        Assert.Equal(0L, await count.ExecuteScalarAsync(ct));

        Task<Guid> Consume(string session, string token, AdminModerationIntent command) =>
            service.WithModerationProof(session, token, command, (_, _, id) => Task.FromResult(id), ct);

        async Task<string> SeedProof(Guid id, byte[] session, int lifetime)
        {
            var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            await Execute("""
                insert into public.admin_step_up(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
                values($1,$2,$3,1,1,$4,null,clock_timestamp()+$5 * interval '1 second',2)
                on conflict (session_digest,kind) do update set digest=excluded.digest,expires_at=excluded.expires_at
                """, SHA256.HashData(System.Text.Encoding.ASCII.GetBytes(token)), id, session, AdminPasskeyStore.IntentDigest(intent), lifetime);
            return token;
        }

        Task<(Guid Id, string Token, byte[] Digest)> Admin(string handle, bool canModerate) =>
            FixtureSql.AdminAsync(db, ct, handle, 10, RandomNumberGenerator.GetBytes(32), [2]);

        Task Execute(string sql, params object[] parameters) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, parameters);
    }

    private static async Task Denied(Rejection expected, Func<Task> action) =>
        Assert.Equal(expected, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);
}
