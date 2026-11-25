namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminStepUpPostgresTests
{
    [PostgresFact]
    public async Task ModerationProofIsScopedAndAtomicWithItsConsumer()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await AdminModerationPostgresTests.AddPendingComment(fixture, ct, "Original pending comment", "Another pending comment");

        var moderator = await fixture.AdminAsync("moderator", 10, RandomNumberGenerator.GetBytes(32), [2], ct);
        var other = await fixture.AdminAsync("other-moderator", 10, RandomNumberGenerator.GetBytes(32), [2], ct);
        var siteUser = await fixture.SignInSiteUser("step-up-site-user", ct);
        var gate = new AdminSessionGate(fixture.DataSource, null);
        var service = new AdminStepUpService(gate, new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost")));
        var intent = new AdminModerationIntent(1, 1, 0, 1, "Policy reviewed");
        await Denied(Rejection.Unauthorized, () => service.BeginModerationStepUp(siteUser.Token, intent, ct));
        await Denied(Rejection.NotFound, () => service.BeginModerationStepUp(moderator.Token, intent with { CommentId = 3 }, ct));
        Aeds.Decode(await service.BeginModerationStepUp(moderator.Token, intent, ct), FrameType.PasskeyLoginBegin);

        // Fixture credentials are synthetic, and this helper never bypasses the runtime's WebAuthn issuer.
        // Native Chrome covers proof issuance. These rows exercise only consumption and its transaction.
        var proof = await SeedProof(moderator.Id, moderator.Digest, lifetime: 45);
        foreach (var (tok, cmd) in new[]
        {
            (other.Token, intent),
            (moderator.Token, intent with { CommentId = 2 }),
            (moderator.Token, intent with { Decision = 2 }),
            (moderator.Token, intent with { Reason = "Different reason" }),
        })
            await Denied(Rejection.Unauthorized, () => Consume(tok, proof, cmd));
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.WithModerationProof<bool>(moderator.Token, proof, intent,
            async (connection, transaction, _) =>
            {
                Assert.Equal(1, await FixtureSql.ExecuteAsync(connection, transaction, ct,
                    "update public.comment set moderation_status=1 where article_id=1 and id=1"));
                throw new InvalidOperationException("Rollback the fixture action.");
            }, ct));
        Assert.Equal(moderator.Id, await Consume(moderator.Token, proof, intent));
        await Denied(Rejection.Unauthorized, () => Consume(moderator.Token, proof, intent));

        proof = await SeedProof(moderator.Id, moderator.Digest, lifetime: -1);
        await Denied(Rejection.Unauthorized, () => Consume(moderator.Token, proof, intent));
        proof = await SeedProof(moderator.Id, moderator.Digest, lifetime: 45);
        var waiting = await fixture.InTx(async (db, revoke) =>
        {
            Assert.Equal(1, await FixtureSql.ExecuteAsync(db, revoke, ct, "update public.admin_principal set generation=2 where id=$1", moderator.Id));
            var pending = Consume(moderator.Token, proof, intent);
            while (!pending.IsCompleted && !await fixture.Scalar<bool>("""
                select exists(select from pg_catalog.pg_stat_activity a
                    where a.datname=current_database() and $1=any(pg_catalog.pg_blocking_pids(a.pid)))
                """, db.ProcessID))
                await Task.Delay(15, ct);
            Assert.False(pending.IsCompleted);
            Assert.Equal(1, await FixtureSql.ExecuteAsync(db, revoke, ct, "delete from public.admin_session where digest=$1", moderator.Digest));
            return pending;
        }, ct);
        await Denied(Rejection.Unauthorized, () => waiting);
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.admin_step_up where principal_id=$1", moderator.Id));

        Task<Guid> Consume(string session, string token, AdminModerationIntent command) =>
            service.WithModerationProof(session, token, command, (_, _, id) => Task.FromResult(id), ct);

        async Task<string> SeedProof(Guid id, byte[] session, int lifetime) =>
            (await fixture.SeedStepUpProof("admin_step_up", id, session, 1, AdminStepUpService.IntentDigest(intent), lifetime, ct)).Token;
    }
}
