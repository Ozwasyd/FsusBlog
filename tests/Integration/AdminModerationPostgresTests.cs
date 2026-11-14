using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminModerationPostgresTests
{
    [PostgresFact]
    public async Task ClaimSerializesOwnershipAndFencesEarlierVersions()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await AddPendingComment(db, ct);
        var first = await AddModerator(db, "first-moderator", ct);
        var second = await AddModerator(db, "second-moderator", ct);
        var manager = await AddModerator(db, "manager", ct, canModerate: false);
        var service = CreateStore(fixture);
        var target = new AdminModerationClaimRequest(1, 1);
        await Denied(Rejection.Forbidden, () => service.AcquireCommentClaim(manager.Token, target, ct));

        ClaimAttempt[] results;
        await using (var gate = await db.BeginTransactionAsync(ct))
        {
            await using (var hold = Store.Sql(db, gate, "select 1 from public.comment where article_id=1 and id=1 for update"))
                Assert.Equal(1, await hold.ExecuteScalarAsync(ct));
            var a = Attempt(first);
            var b = Attempt(second);
            await using var observer = await fixture.DataSource.OpenConnectionAsync(ct);
            // The second contender can wait behind the first contender in the row-lock queue.
            await using var blocked = Store.Sql(observer, null, """
                select count(*) from pg_catalog.pg_stat_activity a
                where a.datname=current_database() and a.pid<>pg_backend_pid()
                  and cardinality(pg_catalog.pg_blocking_pids(a.pid))>0
                """);
            while (!a.IsCompleted && !b.IsCompleted && (long)(await blocked.ExecuteScalarAsync(ct))! < 2)
                await Task.Delay(15, ct);
            Assert.False(a.IsCompleted);
            Assert.False(b.IsCompleted);
            await gate.CommitAsync(ct);
            results = await Task.WhenAll(a, b);
        }
        var success = Assert.Single(results, result => result.Claim is not null);
        var conflict = Assert.Single(results, result => result.Denied is not null);
        Assert.Equal(Rejection.Conflict, conflict.Denied);
        var original = success.Claim!;
        Assert.Equal(1L, original.CommentVersion);
        Assert.Equal(1L, original.ClaimGeneration);
        Assert.Equal(1L, original.ClaimVersion);

        await Denied(Rejection.Conflict, () => service.ReleaseCommentClaim(conflict.Admin.Token, original, ct));
        var renewed = await service.RenewCommentClaim(success.Admin.Token, original, ct);
        Assert.Equal(original.ClaimGeneration, renewed.ClaimGeneration);
        Assert.Equal(original.ClaimVersion + 1, renewed.ClaimVersion);
        Assert.Equal(original.CommentVersion, renewed.CommentVersion);
        Assert.True(renewed.ExpiresAt >= original.ExpiresAt);
        await Denied(Rejection.Conflict, () => service.ReleaseCommentClaim(success.Admin.Token, original, ct));
        await service.ReleaseCommentClaim(success.Admin.Token, renewed, ct);

        var reclaimed = await service.AcquireCommentClaim(conflict.Admin.Token, target, ct);
        Assert.Equal(original.ClaimGeneration + 1, reclaimed.ClaimGeneration);
        Assert.True(reclaimed.ClaimVersion > renewed.ClaimVersion);
        Assert.NotEqual(original.ClaimToken, reclaimed.ClaimToken);
        await Execute(db, "update public.admin_comment_claim set expires_at=clock_timestamp()-interval '1 second'", ct);
        await Denied(Rejection.Conflict, () => service.RenewCommentClaim(conflict.Admin.Token, reclaimed, ct));
        var afterExpiry = await service.AcquireCommentClaim(success.Admin.Token, target, ct);
        Assert.Equal(reclaimed.ClaimGeneration + 1, afterExpiry.ClaimGeneration);

        await Execute(db, "delete from public.admin_permission where principal_id=$1 and permission=$2", ct,
            success.Admin.Id, CurrentSchema.CommentModeratePermission);
        await Denied(Rejection.Forbidden, () => service.RenewCommentClaim(success.Admin.Token, afterExpiry, ct));
        await Execute(db, "delete from public.admin_session where digest=$1", ct, success.Admin.Digest);
        await Denied(Rejection.Unauthorized, () => service.ReleaseCommentClaim(success.Admin.Token, afterExpiry, ct));
        var afterRevocation = await service.AcquireCommentClaim(conflict.Admin.Token, target, ct);
        Assert.Equal(afterExpiry.ClaimGeneration + 1, afterRevocation.ClaimGeneration);
        Assert.True(afterRevocation.ClaimVersion > afterExpiry.ClaimVersion);
        await using var live = Store.Sql(db, null, """
            select principal_id from public.admin_comment_claim
            where article_id=1 and comment_id=1 and state=1 and expires_at>clock_timestamp()
            """);
        Assert.Equal(conflict.Admin.Id, await live.ExecuteScalarAsync(ct));

        async Task<ClaimAttempt> Attempt(Moderator moderator)
        {
            try { return new(moderator, await service.AcquireCommentClaim(moderator.Token, target, ct), null); }
            catch (BusinessException error) { return new(moderator, null, error.Rejection); }
        }
    }

    [PostgresFact]
    public async Task DecisionKeepsProofAndClaimUntilAuditCommits()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await AddPendingComment(db, ct);
        var owner = await AddModerator(db, "decision-owner", ct);
        var other = await AddModerator(db, "another-moderator", ct);
        var service = CreateStore(fixture);
        var claim = await service.AcquireCommentClaim(owner.Token, new(1, 1), ct);
        var decision = new AdminModerationDecision(1, 1, 0, 1, "Reviewed the submitted comment", claim.CommentVersion,
            claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion);
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(owner.Token, null, decision, ct));
        await Denied(Rejection.Conflict, () => service.BeginModerationDecisionStepUp(other.Token, decision, ct));
        Aeds.Decode(await service.BeginModerationDecisionStepUp(owner.Token, decision, ct), FrameType.PasskeyLoginBegin);

        // Native Chrome covers actual assertion and proof issuance. This row only seeds the database consumer.
        var staleDecision = decision with { ClaimVersion = claim.ClaimVersion + 1 };
        var (staleProof, _) = await SeedProof(staleDecision);
        await Denied(Rejection.Conflict, () => service.DecideComment(owner.Token, staleProof, staleDecision, ct));

        var (proof, proofDigest) = await SeedProof(decision);

        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(owner.Token, proof,
            decision with { Reason = "A different moderation reason" }, ct));
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(other.Token, proof, decision, ct));
        await Execute(db, "alter table public.admin_comment_moderation add constraint fixture_refuse_audit check (false)", ct);
        var rejected = await Assert.ThrowsAsync<PostgresException>(() => service.DecideComment(owner.Token, proof, decision, ct));
        Assert.Equal(PostgresErrorCodes.CheckViolation, rejected.SqlState);
        await using (var check = Store.Sql(db, null, """
            select c.moderation_status=0 and c.moderation_version=1 and s.state=1 and s.claim_version=$2
                and exists(select from public.admin_step_up where digest=$1)
            from public.comment c join public.admin_comment_claim s on (s.article_id,s.comment_id)=(c.article_id,c.id)
            where c.article_id=1 and c.id=1
            """, proofDigest, claim.ClaimVersion))
            Assert.Equal(true, await check.ExecuteScalarAsync(ct));

        await Execute(db, "alter table public.admin_comment_moderation drop constraint fixture_refuse_audit", ct);
        await service.DecideComment(owner.Token, proof, decision, ct);
        await using var audit = Store.Sql(db, null, """
            select m.principal_id,m.previous_status,m.next_status,m.reason,m.comment_version,c.moderation_status,
                   c.moderation_version,s.state,s.claim_version,
                   exists(select from public.admin_step_up where digest=$1)
            from public.admin_comment_moderation m
            join public.comment c on (c.article_id,c.id)=(m.article_id,m.comment_id)
            join public.admin_comment_claim s on (s.article_id,s.comment_id)=(m.article_id,m.comment_id)
            where m.article_id=1 and m.comment_id=1
            """, proofDigest);
        await using var row = await audit.ExecuteReaderAsync(ct);
        Assert.True(await row.ReadAsync(ct));
        Assert.Equal(owner.Id, row.GetGuid(0));
        Assert.Equal((short)0, row.GetInt16(1));
        Assert.Equal((short)1, row.GetInt16(2));
        Assert.Equal(decision.Reason, row.GetString(3));
        Assert.Equal(claim.CommentVersion, row.GetInt64(4));
        Assert.Equal((short)1, row.GetInt16(5));
        Assert.Equal(claim.CommentVersion + 1, row.GetInt64(6));
        Assert.Equal((short)3, row.GetInt16(7));
        Assert.Equal(claim.ClaimVersion + 1, row.GetInt64(8));
        Assert.False(row.GetBoolean(9));
        Assert.False(await row.ReadAsync(ct));
        await Assert.ThrowsAsync<ModerationProofRequiredException>(() => service.DecideComment(owner.Token, proof, decision, ct));
        await Denied(Rejection.Conflict, () => service.AcquireCommentClaim(other.Token, new(1, 1), ct));

        async Task<(string Token, byte[] Digest)> SeedProof(AdminModerationDecision value)
        {
            var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            var digest = SHA256.HashData(Encoding.ASCII.GetBytes(token));
            await Execute(db, """
                insert into public.admin_step_up(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
                values($1,$2,$3,1,1,$4,null,clock_timestamp()+interval '45 seconds',2)
                on conflict(session_digest,kind) do update set digest=excluded.digest,body_digest=excluded.body_digest,
                    expires_at=excluded.expires_at
                """, ct, digest, owner.Id, owner.Digest, AdminPasskeyStore.DecisionDigest(value));
            return (token, digest);
        }
    }

    private static AdminPasskeyStore CreateStore(ScratchDatabase fixture) =>
        new(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));

    private static async Task AddPendingComment(NpgsqlConnection db, CancellationToken ct)
    {
        var member = Guid.NewGuid();
        await Execute(db, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,'Site fixture',true,true,1)",
            ct, member);
        await Execute(db, """
            with article as (
                insert into public.article(owner_id,revision,title,body,deleted)
                values($1,1,'Fixture article','Fixture article',false) returning id
            )
            insert into public.article_revision(article_id,revision,title,body,happened_at)
            select id,1,'Fixture article','Fixture article',clock_timestamp() from article
            """, ct, member);
        await Execute(db, """
            insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
            values(1,1,1,0,0,false,'Awaiting review',3,'Fixture writer','en',clock_timestamp())
            """, ct);
        await Execute(db, "insert into public.comment_submit_command values($1,$2,$3,1,1)", ct, member,
            Guid.NewGuid(), RandomNumberGenerator.GetBytes(32));
    }

    private static async Task<Moderator> AddModerator(NpgsqlConnection db, string handle, CancellationToken ct, bool canModerate = true)
    {
        var principal = Guid.NewGuid();
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var digest = Store.TokenDigest(token)!;
        await Execute(db, "insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,$2,$3,true,1)",
            ct, principal, handle, RandomNumberGenerator.GetBytes(32));
        await Execute(db, "insert into public.admin_passkey_credential values($1,$2,$3,0,false,false)", ct,
            RandomNumberGenerator.GetBytes(32), principal, new byte[] { 2 });
        await Execute(db, "insert into public.admin_permission values($1,$2)", ct, principal, CurrentSchema.AdminManagePermission);
        if (canModerate)
            await Execute(db, "insert into public.admin_permission values($1,$2)", ct, principal, CurrentSchema.CommentModeratePermission);
        await Execute(db, "insert into public.admin_session values($1,$2,1,clock_timestamp()+interval '10 minutes')", ct, digest, principal);
        return new(principal, token, digest);
    }

    private static async Task Execute(NpgsqlConnection db, string sql, CancellationToken ct, params object[] parameters)
    {
        await using var command = Store.Sql(db, null, sql, parameters);
        await command.ExecuteNonQueryAsync(ct);
    }

    private static async Task Denied(Rejection expected, Func<Task> action) =>
        Assert.Equal(expected, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);

    private sealed record Moderator(Guid Id, string Token, byte[] Digest);
    private sealed record ClaimAttempt(Moderator Admin, AdminModerationClaim? Claim, Rejection? Denied);
}
