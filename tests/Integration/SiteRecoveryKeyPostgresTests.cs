namespace FsusBlog.V2.Integration.Tests;

public sealed class SiteRecoveryKeyPostgresTests
{
    [Fact]
    public void RecoveryKeyUsesThePinnedLookupDomainSaltAndDerivationCost()
    {
        const string key = "frk_000102030405060708090a0b0c0d0e0f_QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8";
        var pepper = Convert.FromHexString("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
        var salt = Convert.FromHexString("101112131415161718191a1b1c1d1e1f");
        var verifier = Convert.FromHexString("672dd13871a11b7055023891a288b95f84452398692a963ed86a395510eedd77");
        var secrets = new RecoveryKeySecret(pepper);

        Assert.Equal("ed3d398c0f016addcbe53331d89284b84829cab0793263c57ef5714ef74ca132",
            Convert.ToHexStringLower(secrets.Lookup(key)));
        Assert.True(secrets.Verify(key, salt, verifier));
        Assert.False(secrets.Verify(WrongSecret(key), salt, verifier));
        salt[0] ^= 1;
        Assert.False(secrets.Verify(key, salt, verifier));
        var issued = secrets.Generate();
        Wire.DecodeRecoveryKeyVerify(Wire.EncodeRecoveryKeyVerify(new(issued.Key)));
        Assert.Equal(issued.Lookup, secrets.Lookup(issued.Key));
        Assert.True(secrets.Verify(issued.Key, issued.Salt, issued.Verifier));
        Assert.NotEqual(issued.Key, secrets.Generate().Key);
    }

    [PostgresFact]
    public async Task CurrentRemovalRequiresFreshAccountRecoveryAndZeroDevicesDoesNotReopenBootstrap()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var service = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var secrets = new RecoveryKeySecret(RandomNumberGenerator.GetBytes(32));
        var owner = await AddAccount(fixture, secrets, "Recovery-only member");
        var other = await AddAccount(fixture, secrets, "Other member");
        var session = await AddSession(fixture, owner.Id);
        var handle = SiteSessions.Id(owner.Id, Store.TokenDigest(session)!);
        var peerTicket = await service.VerifySiteRecoveryKey(secrets, other.Key, NoPow, ct);
        await Denied(() => service.BeginSitePasskeyRemoveCurrent(session, handle, peerTicket, ct));
        var previous = await service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct);
        var proof = await service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct);
        await Denied(() => service.BeginSitePasskeyRemoveCurrent(session, handle, previous, ct));
        var bootstrap = await fixture.SiteSessionAsync(owner.Id, DateTimeOffset.UtcNow.AddMinutes(1));
        await Denied(() => service.BeginSitePasskeyRemoveCurrent(bootstrap.Token, bootstrap.Id, proof, ct));
        var begin = Aeds.Decode(await service.BeginSitePasskeyRemoveCurrent(session, handle, proof, ct), FrameType.PasskeyLoginBegin);
        var token = Encoding.ASCII.GetString(begin.Slice(WireLayouts.PasskeyLoginBeginTokenOffset, 43));
        var credential = await fixture.Scalar<byte[]>("select credential_id from public.passkey_credential where user_id=$1", owner.Id);
        await fixture.Exec("update public.site_recovery_key set used_at=clock_timestamp() where user_id=$1", owner.Id);
        await Denied(() => service.CompleteSitePasskeyRemoveCurrent(session, handle, proof,
            new(token, WebEncoders.Base64UrlEncode(credential), credential, [1], [1], [1], [], false), ct));
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.passkey_credential where user_id=$1", owner.Id));

        await fixture.Exec("delete from public.user_session where user_id=$1", owner.Id);
        await fixture.Exec("delete from public.passkey_credential where user_id=$1", owner.Id);
        var text = await fixture.IssueTicket(owner.Id, ct, minutes: 1);
        await Denied(() => new Store(fixture.DataSource).SignIn(text, ct));
        await Denied(() => service.BeginProvision(text, ct));

        var peer = await AddSession(fixture, other.Id);
        await fixture.Exec("drop table public.site_recovery_rebind, public.site_recovery_flow, public.site_recovery_key");
        await Denied(() => service.BeginSitePasskeyRemoveCurrent(peer, SiteSessions.Id(other.Id, Store.TokenDigest(peer)!), peerTicket, ct));
    }

    [PostgresFact]
    public async Task IssuanceProofCannotCrossSessionPurposeOrReplay()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var service = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var secrets = new RecoveryKeySecret(RandomNumberGenerator.GetBytes(32));
        var owner = await AddAccount(fixture, secrets, "Issuing member");
        var session = await AddSession(fixture, owner.Id);
        var otherSession = await AddSession(fixture, owner.Id);
        var create = new RecoveryKeyOperation(1);
        var rotate = new RecoveryKeyOperation(2);

        var token = await SeedIssueProof(fixture, owner.Id, session);
        await Assert.ThrowsAsync<RecoveryKeyProofRequiredException>(() => service.IssueRecoveryKey(secrets, otherSession, rotate, token, ct));
        await Assert.ThrowsAsync<RecoveryKeyProofRequiredException>(() => service.IssueRecoveryKey(secrets, session, create, token, ct));

        var issued = await service.IssueRecoveryKey(secrets, session, rotate, token, ct);
        Assert.Equal(2L, issued.Version);
        Assert.NotEqual(owner.Key, issued.Key);
        Assert.True(await service.RecoveryKeyStatus(session, ct));
        await Assert.ThrowsAsync<RecoveryKeyProofRequiredException>(() => service.IssueRecoveryKey(secrets, session, rotate, token, ct));
        await Denied(() => service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.site_recovery_flow where user_id=$1", owner.Id));
    }

    [PostgresFact]
    public async Task WrongSecretsStayScopedAndOnlyTheLatestReservationCanBeginRebind()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var service = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var secrets = new RecoveryKeySecret(RandomNumberGenerator.GetBytes(32));
        var owner = await AddAccount(fixture, secrets, "Recoverable member");
        var other = await AddAccount(fixture, secrets, "Unrelated member");

        var scopedFailure = WrongSecret(owner.Key);
        Assert.Equal(secrets.Lookup(owner.Key), secrets.Lookup(scopedFailure));
        for (var attempt = (short)1; attempt <= 8; attempt++)
        {
            await Denied(() => service.VerifySiteRecoveryKey(secrets, scopedFailure, NoPow, ct));
            Assert.Equal(attempt, await fixture.Scalar<short>("select failed_count from public.site_recovery_key where user_id=$1", owner.Id));
        }
        await Denied(() => service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct));
        Assert.Equal((short)8, await fixture.Scalar<short>("select failed_count from public.site_recovery_key where user_id=$1", owner.Id));
        await Denied(() => service.VerifySiteRecoveryKey(secrets, secrets.Generate().Key, NoPow, ct));
        Assert.Equal(2L, await fixture.Scalar<long>("select count(*) from public.site_recovery_key"));
        Assert.Equal((short)0, await fixture.Scalar<short>("select failed_count from public.site_recovery_key where user_id=$1", other.Id));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.site_recovery_rebind"));

        await fixture.Exec("update public.site_recovery_key set failure_until=clock_timestamp()-interval '1 second' where user_id=$1", owner.Id);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.VerifySiteRecoveryKey(secrets, owner.Key,
            (_, _) => throw new InvalidOperationException("Fixture proof refusal"), ct));
        Assert.True(await fixture.Scalar<bool>("select used_at is null from public.site_recovery_key where user_id=$1", owner.Id));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.site_recovery_rebind"));
        var tickets = await Task.WhenAll(service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct),
            service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct));
        Assert.NotEqual(tickets[0], tickets[1]);
        Assert.All(tickets, value => Assert.Matches("^[A-Za-z0-9_-]{43}$", value));
        var latestDigest = await fixture.Scalar<byte[]>("select ticket_digest from public.site_recovery_rebind where user_id=$1", owner.Id);
        var ticket = Assert.Single(tickets, value => MfaStore.FlowDigest(value).SequenceEqual(latestDigest));
        var replaced = Assert.Single(tickets, value => value != ticket);
        await Denied(() => service.BeginRecoveryRebind(replaced, ct));
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.site_recovery_rebind where user_id=$1", owner.Id));
        Assert.True(await fixture.Scalar<bool>("select used_at is null from public.site_recovery_key where user_id=$1", owner.Id));
        Assert.True(await fixture.Scalar<bool>("select used_at is null from public.site_recovery_key where user_id=$1", other.Id));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.user_session"));
        Assert.Equal(2L, await fixture.Scalar<long>("select count(*) from public.passkey_credential"));

        var frame = await service.BeginRecoveryRebind(ticket, ct);
        Aeds.Decode(frame, FrameType.PasskeyRegisterBegin);
        Assert.True(await fixture.Scalar<bool>("""
            select expires_at>clock_timestamp() and challenge_expires_at>clock_timestamp()
                and challenge_expires_at<=expires_at and challenge_expires_at<=clock_timestamp()+interval '2 minutes'
            from public.site_recovery_rebind where user_id=$1
            """, owner.Id));
        var expiry = await fixture.Scalar("select expires_at from public.site_recovery_rebind where user_id=$1", owner.Id);
        var retried = await service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct);
        Assert.Equal(expiry, await fixture.Scalar("select expires_at from public.site_recovery_rebind where user_id=$1", owner.Id));
        await Denied(() => service.BeginRecoveryRebind(ticket, ct));
        Aeds.Decode(await service.BeginRecoveryRebind(retried, ct), FrameType.PasskeyRegisterBegin);
        await fixture.Exec("update public.blog_user set generation=generation+1 where id=$1", owner.Id);
        await Denied(() => service.BeginRecoveryRebind(retried, ct));

        var expiring = await service.VerifySiteRecoveryKey(secrets, other.Key, NoPow, ct);
        await fixture.Exec("update public.site_recovery_rebind set expires_at=clock_timestamp()-interval '1 second' where user_id=$1", other.Id);
        await Denied(() => service.BeginRecoveryRebind(expiring, ct));
        var recovered = await service.VerifySiteRecoveryKey(secrets, other.Key, NoPow, ct);
        Assert.NotEqual(expiring, recovered);
        await Denied(() => service.BeginRecoveryRebind(expiring, ct));
        Aeds.Decode(await service.BeginRecoveryRebind(recovered, ct), FrameType.PasskeyRegisterBegin);
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.user_session"));

        // Seed ordinary sessions only after verifying neither recovery key issued one.
        Assert.True(await service.RecoveryKeyStatus(await AddSession(fixture, owner.Id), ct));
        var pendingSession = await AddSession(fixture, other.Id);
        Assert.True(await service.RecoveryKeyStatus(pendingSession, ct));
        var proof = await SeedIssueProof(fixture, other.Id, pendingSession);
        await Denied(Rejection.Conflict, () =>
            service.IssueRecoveryKey(secrets, pendingSession, new(2), proof, ct));
        Assert.True(await fixture.Scalar<bool>("select used_at is null from public.site_recovery_key where user_id=$1", other.Id));
        Assert.Equal(1L, await fixture.Scalar<long>("select version from public.site_recovery_key where user_id=$1", other.Id));
        await Denied(() => service.RecoveryKeyStatus(ticket, ct));

        // Browser tests cover attestation and writing the durable receipt. Verify its retry boundary here.
        var completion = new PasskeyProvisionRequest(new string('A', 43), "Kg", [42], [1], [1], []);
        var requestDigest = SHA256.HashData(Encoding.ASCII.GetBytes("exact completion frame fixture"));
        await fixture.Exec("""
            update public.site_recovery_rebind set challenge_digest=null,options=null,challenge_expires_at=null,
                completed_at=clock_timestamp(),request_digest=$2 where user_id=$1
            """, owner.Id, requestDigest);
        await fixture.Exec("update public.site_recovery_key set used_at=clock_timestamp() where user_id=$1", owner.Id);
        await Denied(() => service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct));
        await service.CompleteRecoveryRebind(retried, completion, requestDigest, ct);
        await Denied(() => service.CompleteRecoveryRebind(retried, completion, RandomNumberGenerator.GetBytes(32), ct));
        await fixture.Exec("update public.blog_user set generation=generation+1 where id=$1", owner.Id);
        await Denied(() => service.CompleteRecoveryRebind(retried, completion, requestDigest, ct));
    }

    private static string WrongSecret(string key) => key[..37] + (key[37] == 'A' ? 'B' : 'A') + key[38..];

    // Real browser tests exercise scoped proof-of-work. These fixtures verify the runtime's database transaction.
    private static Task NoPow(NpgsqlConnection connection, NpgsqlTransaction transaction) => Task.CompletedTask;

    // Actual user verification and issuance of a step-up proof are covered by browser tests.
    private static async Task<string> SeedIssueProof(ScratchDatabase fixture, Guid owner, string session)
    {
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        await fixture.Exec("""
            insert into public.site_recovery_flow(digest,user_id,generation,session_digest,purpose,kind,options,expires_at)
            select $1,id,generation,$3,2,2,null,clock_timestamp()+interval '45 seconds'
            from public.blog_user where id=$2
            """, MfaStore.FlowDigest(token), owner, Store.TokenDigest(session)!);
        return token;
    }

    private static async Task<Account> AddAccount(ScratchDatabase fixture, RecoveryKeySecret secrets, string name)
    {
        var (id, _) = await fixture.SitePasskeyAccountAsync(name, [2]);
        var generated = secrets.Generate();
        await fixture.Exec("""
            insert into public.site_recovery_key(user_id,lookup_digest,salt,verifier,version,created_at,failed_count)
            values($1,$2,$3,$4,1,clock_timestamp(),0)
            """, id, generated.Lookup, generated.Salt, generated.Verifier);
        return new(id, generated.Key);
    }

    private static async Task<string> AddSession(ScratchDatabase fixture, Guid owner)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await fixture.Exec("""
            insert into public.user_session(digest,user_id,generation,expires_at,passkey_credential_id)
            select $1,u.id,u.generation,clock_timestamp()+interval '2 minutes',p.credential_id
            from public.blog_user u join public.passkey_credential p on p.user_id=u.id where u.id=$2
            """, Store.TokenDigest(token)!, owner);
        return token;
    }

    private sealed record Account(Guid Id, string Key);
}
