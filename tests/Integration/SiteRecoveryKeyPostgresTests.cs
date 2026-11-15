using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Passkeys;
using FsusBlog.V2.Server.Sessions;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;

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
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var service = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var secrets = new RecoveryKeySecret(RandomNumberGenerator.GetBytes(32));
        var owner = await AddAccount(db, secrets, "Recovery-only member", ct);
        var other = await AddAccount(db, secrets, "Other member", ct);
        var session = await AddSession(db, owner.Id, ct);
        var handle = SiteSessions.Id(owner.Id, Store.TokenDigest(session)!);
        var peerTicket = await service.VerifySiteRecoveryKey(secrets, other.Key, NoPow, ct);
        await Denied(() => service.BeginSitePasskeyRemoveCurrent(session, handle, peerTicket, ct));
        var previous = await service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct);
        var proof = await service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct);
        await Denied(() => service.BeginSitePasskeyRemoveCurrent(session, handle, previous, ct));
        var bootstrapSession = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var bootstrapDigest = Store.TokenDigest(bootstrapSession)!;
        await Execute(db, """
            insert into public.user_session(digest,user_id,generation,expires_at)
            select $1,id,generation,clock_timestamp()+interval '1 minute' from public.blog_user where id=$2
            """, ct, bootstrapDigest, owner.Id);
        await Denied(() => service.BeginSitePasskeyRemoveCurrent(bootstrapSession, SiteSessions.Id(owner.Id, bootstrapDigest), proof, ct));
        var begin = Aeds.Decode(await service.BeginSitePasskeyRemoveCurrent(session, handle, proof, ct), FrameType.PasskeyLoginBegin);
        var token = Encoding.ASCII.GetString(begin.Slice(WireLayouts.PasskeyLoginBeginTokenOffset, 43));
        var credential = Assert.IsType<byte[]>(await Scalar(db, "select credential_id from public.passkey_credential where user_id=$1", ct, owner.Id));
        await Execute(db, "update public.site_recovery_key set used_at=clock_timestamp() where user_id=$1", ct, owner.Id);
        await Denied(() => service.CompleteSitePasskeyRemoveCurrent(session, handle, proof,
            new(token, WebEncoders.Base64UrlEncode(credential), credential, [1], [1], [1], [], false), ct));
        Assert.Equal(1L, await Scalar(db, "select count(*) from public.passkey_credential where user_id=$1", ct, owner.Id));

        await Execute(db, "delete from public.user_session where user_id=$1", ct, owner.Id);
        await Execute(db, "delete from public.passkey_credential where user_id=$1", ct, owner.Id);
        var ticket = RandomNumberGenerator.GetBytes(32);
        await Execute(db, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 minute')",
            ct, SHA256.HashData(ticket), owner.Id);
        var text = Convert.ToHexStringLower(ticket);
        await Denied(() => new Store(fixture.DataSource).SignIn(text, ct));
        await Denied(() => service.BeginProvision(text, ct));

        var peer = await AddSession(db, other.Id, ct);
        await Execute(db, "drop table public.site_recovery_rebind, public.site_recovery_flow, public.site_recovery_key", ct);
        await Denied(() => service.BeginSitePasskeyRemoveCurrent(peer, SiteSessions.Id(other.Id, Store.TokenDigest(peer)!), peerTicket, ct));
    }

    [PostgresFact]
    public async Task IssuanceProofCannotCrossSessionPurposeOrReplay()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var service = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var secrets = new RecoveryKeySecret(RandomNumberGenerator.GetBytes(32));
        var owner = await AddAccount(db, secrets, "Issuing member", ct);
        var session = await AddSession(db, owner.Id, ct);
        var otherSession = await AddSession(db, owner.Id, ct);
        var create = new RecoveryKeyOperation(1);
        var rotate = new RecoveryKeyOperation(2);

        var token = await SeedIssueProof(db, owner.Id, session, ct);
        await Assert.ThrowsAsync<RecoveryKeyProofRequiredException>(() => service.IssueRecoveryKey(secrets, otherSession, rotate, token, ct));
        await Assert.ThrowsAsync<RecoveryKeyProofRequiredException>(() => service.IssueRecoveryKey(secrets, session, create, token, ct));

        var issued = await service.IssueRecoveryKey(secrets, session, rotate, token, ct);
        Assert.Equal(2L, issued.Version);
        Assert.NotEqual(owner.Key, issued.Key);
        Assert.True(await service.RecoveryKeyStatus(session, ct));
        await Assert.ThrowsAsync<RecoveryKeyProofRequiredException>(() => service.IssueRecoveryKey(secrets, session, rotate, token, ct));
        await Denied(() => service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct));
        Assert.Equal(0L, await Scalar(db, "select count(*) from public.site_recovery_flow where user_id=$1", ct, owner.Id));
    }

    [PostgresFact]
    public async Task WrongSecretsStayScopedAndOnlyTheLatestReservationCanBeginRebind()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var service = new PasskeyStore(fixture.DataSource, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var secrets = new RecoveryKeySecret(RandomNumberGenerator.GetBytes(32));
        var owner = await AddAccount(db, secrets, "Recoverable member", ct);
        var other = await AddAccount(db, secrets, "Unrelated member", ct);

        var scopedFailure = WrongSecret(owner.Key);
        Assert.Equal(secrets.Lookup(owner.Key), secrets.Lookup(scopedFailure));
        for (var attempt = (short)1; attempt <= 8; attempt++)
        {
            await Denied(() => service.VerifySiteRecoveryKey(secrets, scopedFailure, NoPow, ct));
            Assert.Equal(attempt, await Scalar(db, "select failed_count from public.site_recovery_key where user_id=$1", ct, owner.Id));
        }
        await Denied(() => service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct));
        Assert.Equal((short)8, await Scalar(db, "select failed_count from public.site_recovery_key where user_id=$1", ct, owner.Id));
        await Denied(() => service.VerifySiteRecoveryKey(secrets, secrets.Generate().Key, NoPow, ct));
        Assert.Equal(2L, await Scalar(db, "select count(*) from public.site_recovery_key", ct));
        Assert.Equal((short)0, await Scalar(db, "select failed_count from public.site_recovery_key where user_id=$1", ct, other.Id));
        Assert.Equal(0L, await Scalar(db, "select count(*) from public.site_recovery_rebind", ct));

        await Execute(db, "update public.site_recovery_key set failure_until=clock_timestamp()-interval '1 second' where user_id=$1", ct, owner.Id);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.VerifySiteRecoveryKey(secrets, owner.Key,
            (_, _) => throw new InvalidOperationException("Fixture proof refusal"), ct));
        Assert.Equal(true, await Scalar(db, "select used_at is null from public.site_recovery_key where user_id=$1", ct, owner.Id));
        Assert.Equal(0L, await Scalar(db, "select count(*) from public.site_recovery_rebind", ct));
        var tickets = await Task.WhenAll(service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct),
            service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct));
        Assert.NotEqual(tickets[0], tickets[1]);
        Assert.All(tickets, value => Assert.Matches("^[A-Za-z0-9_-]{43}$", value));
        var latestDigest = Assert.IsType<byte[]>(await Scalar(db,
            "select ticket_digest from public.site_recovery_rebind where user_id=$1", ct, owner.Id));
        var ticket = Assert.Single(tickets, value => MfaStore.FlowDigest(value).SequenceEqual(latestDigest));
        var replaced = Assert.Single(tickets, value => value != ticket);
        await Denied(() => service.BeginRecoveryRebind(replaced, ct));
        Assert.Equal(1L, await Scalar(db, "select count(*) from public.site_recovery_rebind where user_id=$1", ct, owner.Id));
        Assert.Equal(true, await Scalar(db, "select used_at is null from public.site_recovery_key where user_id=$1", ct, owner.Id));
        Assert.Equal(true, await Scalar(db, "select used_at is null from public.site_recovery_key where user_id=$1", ct, other.Id));
        Assert.Equal(0L, await Scalar(db, "select count(*) from public.user_session", ct));
        Assert.Equal(2L, await Scalar(db, "select count(*) from public.passkey_credential", ct));

        var frame = await service.BeginRecoveryRebind(ticket, ct);
        Aeds.Decode(frame, FrameType.PasskeyRegisterBegin);
        Assert.Equal(true, await Scalar(db, """
            select expires_at>clock_timestamp() and challenge_expires_at>clock_timestamp()
                and challenge_expires_at<=expires_at and challenge_expires_at<=clock_timestamp()+interval '2 minutes'
            from public.site_recovery_rebind where user_id=$1
            """, ct, owner.Id));
        var expiry = await Scalar(db, "select expires_at from public.site_recovery_rebind where user_id=$1", ct, owner.Id);
        var retried = await service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct);
        Assert.Equal(expiry, await Scalar(db, "select expires_at from public.site_recovery_rebind where user_id=$1", ct, owner.Id));
        await Denied(() => service.BeginRecoveryRebind(ticket, ct));
        Aeds.Decode(await service.BeginRecoveryRebind(retried, ct), FrameType.PasskeyRegisterBegin);
        await Execute(db, "update public.blog_user set generation=generation+1 where id=$1", ct, owner.Id);
        await Denied(() => service.BeginRecoveryRebind(retried, ct));

        var expiring = await service.VerifySiteRecoveryKey(secrets, other.Key, NoPow, ct);
        await Execute(db, "update public.site_recovery_rebind set expires_at=clock_timestamp()-interval '1 second' where user_id=$1", ct, other.Id);
        await Denied(() => service.BeginRecoveryRebind(expiring, ct));
        var recovered = await service.VerifySiteRecoveryKey(secrets, other.Key, NoPow, ct);
        Assert.NotEqual(expiring, recovered);
        await Denied(() => service.BeginRecoveryRebind(expiring, ct));
        Aeds.Decode(await service.BeginRecoveryRebind(recovered, ct), FrameType.PasskeyRegisterBegin);
        Assert.Equal(0L, await Scalar(db, "select count(*) from public.user_session", ct));

        // Seed ordinary sessions only after verifying neither recovery key issued one.
        Assert.True(await service.RecoveryKeyStatus(await AddSession(db, owner.Id, ct), ct));
        var pendingSession = await AddSession(db, other.Id, ct);
        Assert.True(await service.RecoveryKeyStatus(pendingSession, ct));
        var proof = await SeedIssueProof(db, other.Id, pendingSession, ct);
        var pendingRotation = await Assert.ThrowsAsync<BusinessException>(() =>
            service.IssueRecoveryKey(secrets, pendingSession, new(2), proof, ct));
        Assert.Equal(Rejection.Conflict, pendingRotation.Rejection);
        Assert.Equal(true, await Scalar(db, "select used_at is null from public.site_recovery_key where user_id=$1", ct, other.Id));
        Assert.Equal(1L, await Scalar(db, "select version from public.site_recovery_key where user_id=$1", ct, other.Id));
        await Denied(() => service.RecoveryKeyStatus(ticket, ct));

        // Browser tests cover attestation and writing the durable receipt. Verify its retry boundary here.
        var completion = new PasskeyProvisionRequest(new string('A', 43), "Kg", [42], [1], [1], []);
        var requestDigest = SHA256.HashData(Encoding.ASCII.GetBytes("exact completion frame fixture"));
        await Execute(db, """
            update public.site_recovery_rebind set challenge_digest=null,options=null,challenge_expires_at=null,
                completed_at=clock_timestamp(),request_digest=$2 where user_id=$1
            """, ct, owner.Id, requestDigest);
        await Execute(db, "update public.site_recovery_key set used_at=clock_timestamp() where user_id=$1", ct, owner.Id);
        await Denied(() => service.VerifySiteRecoveryKey(secrets, owner.Key, NoPow, ct));
        await service.CompleteRecoveryRebind(retried, completion, requestDigest, ct);
        await Denied(() => service.CompleteRecoveryRebind(retried, completion, RandomNumberGenerator.GetBytes(32), ct));
        await Execute(db, "update public.blog_user set generation=generation+1 where id=$1", ct, owner.Id);
        await Denied(() => service.CompleteRecoveryRebind(retried, completion, requestDigest, ct));
    }

    private static string WrongSecret(string key) => key[..37] + (key[37] == 'A' ? 'B' : 'A') + key[38..];

    // Real browser tests exercise scoped proof-of-work. These fixtures verify the runtime's database transaction.
    private static Task NoPow(NpgsqlConnection connection, NpgsqlTransaction transaction) => Task.CompletedTask;

    // Actual user verification and issuance of a step-up proof are covered by browser tests.
    private static async Task<string> SeedIssueProof(NpgsqlConnection db, Guid owner, string session, CancellationToken ct)
    {
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        await Execute(db, """
            insert into public.site_recovery_flow(digest,user_id,generation,session_digest,purpose,kind,options,expires_at)
            select $1,id,generation,$3,2,2,null,clock_timestamp()+interval '45 seconds'
            from public.blog_user where id=$2
            """, ct, MfaStore.FlowDigest(token), owner, Store.TokenDigest(session)!);
        return token;
    }

    private static async Task<Account> AddAccount(NpgsqlConnection db, RecoveryKeySecret secrets, string name, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        await Execute(db, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,false,true,1)", ct, id, name);
        await Execute(db, "insert into public.passkey_subject(user_id,user_handle) values($1,$2)", ct, id, RandomNumberGenerator.GetBytes(32));
        await Execute(db, """
            insert into public.passkey_credential(credential_id,user_id,public_key,sign_count,backup_eligible,backed_up)
            values($1,$2,$3,0,false,false)
            """, ct, RandomNumberGenerator.GetBytes(32), id, new byte[] { 2 });
        var generated = secrets.Generate();
        await Execute(db, """
            insert into public.site_recovery_key(user_id,lookup_digest,salt,verifier,version,created_at,failed_count)
            values($1,$2,$3,$4,1,clock_timestamp(),0)
            """, ct, id, generated.Lookup, generated.Salt, generated.Verifier);
        return new(id, generated.Key);
    }

    private static async Task<string> AddSession(NpgsqlConnection db, Guid owner, CancellationToken ct)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await Execute(db, """
            insert into public.user_session(digest,user_id,generation,expires_at,passkey_credential_id)
            select $1,u.id,u.generation,clock_timestamp()+interval '2 minutes',p.credential_id
            from public.blog_user u join public.passkey_credential p on p.user_id=u.id where u.id=$2
            """, ct, Store.TokenDigest(token)!, owner);
        return token;
    }

    private static async Task<object?> Scalar(NpgsqlConnection db, string sql, CancellationToken ct, params object[] values)
    {
        await using var command = Store.Sql(db, null, sql, values);
        return await command.ExecuteScalarAsync(ct);
    }

    private static async Task Execute(NpgsqlConnection db, string sql, CancellationToken ct, params object[] values)
    {
        await using var command = Store.Sql(db, null, sql, values);
        await command.ExecuteNonQueryAsync(ct);
    }

    private static async Task Denied(Func<Task> operation) =>
        Assert.Equal(Rejection.Unauthorized, (await Assert.ThrowsAsync<BusinessException>(operation)).Rejection);

    private sealed record Account(Guid Id, string Key);
}
