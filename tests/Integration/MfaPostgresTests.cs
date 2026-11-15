using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authentication;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Passkeys;
using System.Buffers.Binary;
using System.Security.Cryptography;

namespace FsusBlog.V2.Integration.Tests;

public sealed class MfaPostgresTests
{
    [PostgresFact]
    public async Task SessionAndPurposeBoundProofsRejectReplaysAndRevokedGenerations()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var protector = new TotpSecret(RandomNumberGenerator.GetBytes(32));
        var store = new MfaStore(fixture.DataSource, protector);
        var id = Guid.NewGuid();
        var credential = RandomNumberGenerator.GetBytes(32);
        var firstToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var secondToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var first = Store.TokenDigest(firstToken)!;
        var second = Store.TokenDigest(secondToken)!;
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await FixtureSql.SiteAccountAsync(db, null, ct, id, "MFA fixture", canAuthor: true);
        await FixtureSql.SitePasskeyAsync(db, null, ct, id, credential, RandomNumberGenerator.GetBytes(32));
        foreach (var digest in new[] { first, second })
        {
            await Execute("""
                insert into public.user_session(digest,user_id,generation,expires_at,passkey_credential_id)
                values($1,$2,1,clock_timestamp()+interval '10 minutes',$3)
                """, digest, id, credential);
        }

        string proof;
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            var actor = await MfaStore.RequireSession(db, tx, firstToken, ct);
            proof = await MfaStore.BeginFlow(db, tx, actor, MfaStore.Purpose.SetupProof, "", ct);
            await tx.CommitAsync(ct);
        }
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => store.BeginSetup(secondToken, proof, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => store.Disable(firstToken, proof, ct));
        var setup = await store.BeginSetup(firstToken, proof, ct);
        Assert.Equal(FrameType.MfaSetupStart, DecodeType(setup));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => store.BeginSetup(firstToken, proof, ct));
        await Denied(() => store.CompleteSetup(secondToken, "000000", ct));

        byte[] sealedSeed;
        await using (var query = Store.Sql(db, null, "select sealed_seed from public.mfa_setup where user_id=$1", id))
            sealedSeed = (byte[])(await query.ExecuteScalarAsync(ct))!;
        var seed = protector.Open(id, sealedSeed);
        Assert.ThrowsAny<CryptographicException>(() => protector.Open(Guid.NewGuid(), sealedSeed));
        sealedSeed[20] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => protector.Open(id, sealedSeed));
        DateTime earlierExpiry;
        await using (var query = Store.Sql(db, null, "select expires_at from public.user_session where digest=$1", first))
            earlierExpiry = (DateTime)(await query.ExecuteScalarAsync(ct))!;

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / Totp.StepSeconds;
        var valid = Code(seed, now);
        var invalid = Code(seed, now - 5);
        while (Enumerable.Range(-2, 5).Any(i => Code(seed, now + i) == invalid))
            invalid = ((int.Parse(invalid) + 1) % 1_000_000).ToString("D6");
        Assert.Equal(Rejection.Invalid, (await Assert.ThrowsAsync<BusinessException>(() => store.CompleteSetup(firstToken, invalid, ct))).Rejection);
        var (result, newToken, expiry) = await store.CompleteSetup(firstToken, valid, ct);
        Assert.Equal(FrameType.MfaSetupVerify, DecodeType(result));
        Assert.Equal(earlierExpiry, expiry.UtcDateTime);
        Assert.NotEqual(firstToken, newToken);
        await Denied(() => store.Profile(firstToken, ct));
        await Denied(() => store.Profile(secondToken, ct));
        Assert.Equal(FrameType.MfaProfile, DecodeType(await store.Profile(newToken, ct)));

        await using var verify = Store.Sql(db, null, """
            select (select count(*) from public.mfa_recovery_code where user_id=$1) = 8 and
                (select count(*) from public.user_session where user_id=$1) = 1 and
                (select totp_verified_at is not null from public.user_session where digest=$2)
            """, id, Store.TokenDigest(newToken)!);
        Assert.Equal(true, await verify.ExecuteScalarAsync(ct));
        CryptographicOperations.ZeroMemory(seed);

        Task Execute(string sql, params object[] parameters) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, parameters);
    }

    private static FrameType DecodeType(byte[] frame)
    {
        Aeds.Decode(frame, out var type);
        return type;
    }

    private static async Task Denied(Func<Task> action) =>
        Assert.Equal(Rejection.Unauthorized, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);

    private static string Code(byte[] seed, long step)
    {
        Span<byte> counter = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(counter, step);
        var hash = HMACSHA1.HashData(seed, counter);
        return ((BinaryPrimitives.ReadUInt32BigEndian(hash.AsSpan(hash[^1] & 15)) & 0x7fff_ffff) % 1_000_000).ToString("D6");
    }
}
