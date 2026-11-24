using FsusBlog.V2.Core.Authentication;

namespace FsusBlog.V2.Integration.Tests;

public sealed class MfaPostgresTests
{
    [PostgresFact]
    public async Task SessionAndPurposeBoundProofsRejectReplaysAndRevokedGenerations()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var protector = new TotpSecret(RandomNumberGenerator.GetBytes(32));
        var store = new MfaStore(fixture.DataSource, protector);
        var (id, credential) = await fixture.SitePasskeyAccountAsync("MFA fixture");
        var sessionExpiry = DateTimeOffset.UtcNow.AddMinutes(10);
        var first = await fixture.SiteSessionAsync(id, sessionExpiry, credential: credential);
        var second = await fixture.SiteSessionAsync(id, sessionExpiry, credential: credential);

        var proof = await fixture.InTx(async (db, tx) =>
            await MfaStore.BeginFlow(db, tx, await MfaStore.RequireSession(db, tx, first.Token, ct), MfaStore.Purpose.SetupProof, "", ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => store.BeginSetup(second.Token, proof, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => store.Disable(first.Token, proof, ct));
        var setup = await store.BeginSetup(first.Token, proof, ct);
        Assert.Equal(FrameType.MfaSetupStart, DecodeType(setup));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => store.BeginSetup(first.Token, proof, ct));
        await Denied(() => store.CompleteSetup(second.Token, "000000", ct));

        var sealedSeed = await fixture.Scalar<byte[]>("select sealed_seed from public.mfa_setup where user_id=$1", id);
        var seed = protector.Open(id, sealedSeed);
        Assert.ThrowsAny<CryptographicException>(() => protector.Open(Guid.NewGuid(), sealedSeed));
        sealedSeed[20] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => protector.Open(id, sealedSeed));
        var earlierExpiry = await fixture.Scalar<DateTime>("select expires_at from public.user_session where digest=$1", first.Digest);

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / Totp.StepSeconds;
        var valid = Code(seed, now);
        var invalid = Code(seed, now - 5);
        while (Enumerable.Range(-2, 5).Any(i => Code(seed, now + i) == invalid))
            invalid = ((int.Parse(invalid) + 1) % 1_000_000).ToString("D6");
        await Denied(Rejection.Invalid, () => store.CompleteSetup(first.Token, invalid, ct));
        var (result, newToken, expiry) = await store.CompleteSetup(first.Token, valid, ct);
        Assert.Equal(FrameType.MfaSetupVerify, DecodeType(result));
        Assert.Equal(earlierExpiry, expiry.UtcDateTime);
        Assert.NotEqual(first.Token, newToken);
        await Denied(() => store.Profile(first.Token, ct));
        await Denied(() => store.Profile(second.Token, ct));
        Assert.Equal(FrameType.MfaProfile, DecodeType(await store.Profile(newToken, ct)));

        Assert.True(await fixture.Scalar<bool>("""
            select (select count(*) from public.mfa_recovery_code where user_id=$1) = 8 and
                (select count(*) from public.user_session where user_id=$1) = 1 and
                (select totp_verified_at is not null from public.user_session where digest=$2)
            """, id, Store.TokenDigest(newToken)!));
        CryptographicOperations.ZeroMemory(seed);
    }

    private static FrameType DecodeType(byte[] frame)
    {
        Aeds.Decode(frame, out var type);
        return type;
    }

    private static string Code(byte[] seed, long step)
    {
        Span<byte> counter = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(counter, step);
        var hash = HMACSHA1.HashData(seed, counter);
        return ((BinaryPrimitives.ReadUInt32BigEndian(hash.AsSpan(hash[^1] & 15)) & 0x7fff_ffff) % 1_000_000).ToString("D6");
    }
}
