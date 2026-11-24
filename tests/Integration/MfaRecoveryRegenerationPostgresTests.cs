using FsusBlog.V2.Core.Authentication;

namespace FsusBlog.V2.Integration.Tests;

public sealed class MfaRecoveryRegenerationPostgresTests
{
    [PostgresFact]
    public async Task ActionBoundProofAtomicallyReplacesCodesWithoutChangingAuthenticatorOrSession()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var secrets = new TotpSecret(RandomNumberGenerator.GetBytes(32));
        var mfa = new MfaStore(fixture.DataSource, secrets);
        var sessions = new Store(fixture.DataSource);
        var owner = await AddAccount(fixture, "MFA regeneration owner", secrets, ct);
        var foreign = await AddAccount(fixture, "MFA regeneration foreign", secrets, ct);
        var sibling = await fixture.InTx((db, tx) => MfaStore.IssueSession(db, tx, owner.Id, 1, owner.Credential, mfa: true, persistent: false, ct));
        var ownerHandle = SiteSessions.Id(owner.Id, Store.TokenDigest(owner.Session.Access)!);
        var siblingHandle = SiteSessions.Id(owner.Id, Store.TokenDigest(sibling.Access)!);

        var disable = ReadToken(await mfa.BeginDisable(owner.Session.Access, ct), MfaWire.Disable, verified: false);
        await Denied(() => mfa.VerifyRecoveryRegeneration(owner.Session.Access, Attempt(disable, MfaWire.Regenerate, owner.Codes[0]), ct));
        var disableProof = ReadToken(await mfa.VerifyDisable(owner.Session.Access, Attempt(disable, MfaWire.Disable, owner.Codes[0]), ct),
            MfaWire.Disable, verified: true);
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(owner.Session.Access, disableProof, ct));

        await Denied(Rejection.Conflict, () => mfa.BeginRecoveryRegeneration(owner.Session.Access, ct, siblingHandle));
        var challenge = ReadToken(await mfa.BeginRecoveryRegeneration(owner.Session.Access, ct, ownerHandle), MfaWire.Regenerate, verified: false);
        var attempt = Attempt(challenge, MfaWire.Regenerate, owner.Codes[1]);
        await Denied(() => mfa.VerifyDisable(owner.Session.Access, Attempt(challenge, MfaWire.Disable, owner.Codes[1]), ct));
        await Denied(() => mfa.VerifyRecoveryRegeneration(sibling.Access, attempt, ct));
        await Denied(() => mfa.VerifyRecoveryRegeneration(foreign.Session.Access, attempt, ct));
        await Denied(Rejection.Conflict, () => mfa.VerifyRecoveryRegeneration(owner.Session.Access, attempt, ct, siblingHandle));
        var proof = ReadToken(await mfa.VerifyRecoveryRegeneration(owner.Session.Access, attempt, ct, ownerHandle), MfaWire.Regenerate, verified: true);
        Assert.True(await fixture.Scalar<bool>("""
            select exists (select 1 from public.mfa_flow where digest=$2 and options=$3)
            and not exists (select 1 from public.mfa_flow where digest=$1)
            """, MfaStore.FlowDigest(proof), MfaStore.FlowDigest(proof, MfaWire.Regenerate), MfaWire.Regenerate));
        await Denied(() => mfa.VerifyRecoveryRegeneration(owner.Session.Access, attempt, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.Disable(owner.Session.Access, proof, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(sibling.Access, proof, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(foreign.Session.Access, proof, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(owner.Session.Access, null, ct));
        await Denied(Rejection.Conflict, () => mfa.RegenerateRecoveryCodes(owner.Session.Access, proof, ct, siblingHandle));

        var before = await sessions.WithSession(owner.Session.Access, false, (_, _, actor) => Task.FromResult(actor), ct);
        var profile = await mfa.Profile(owner.Session.Access, ct);
        Assert.Equal(RecoveryDigest(owner.Codes[2]), Assert.Single(await ReadDigests(fixture, owner.Id)));

        await fixture.Exec($"""
            alter table public.mfa_recovery_code add constraint fixture_refuse_new_codes
                check (user_id <> '{owner.Id:D}'::uuid) not valid
            """);
        await Assert.ThrowsAsync<PostgresException>(() => mfa.RegenerateRecoveryCodes(owner.Session.Access, proof, ct));
        Assert.Equal(RecoveryDigest(owner.Codes[2]), Assert.Single(await ReadDigests(fixture, owner.Id)));
        await fixture.Exec("alter table public.mfa_recovery_code drop constraint fixture_refuse_new_codes");

        var concurrent = await Task.WhenAll(TryRedeem(), TryRedeem());
        var result = Assert.Single(concurrent.OfType<byte[]>());
        Assert.Single(concurrent, value => value is null);
        var replacements = ReadCodes(result);
        Assert.Equal(10, replacements.Length);
        Assert.Equal(replacements.Length, replacements.Distinct(StringComparer.Ordinal).Count());
        Assert.All(replacements, code => Assert.Matches("^(?:[0-9A-F]{4}-){7}[0-9A-F]{4}$", code));
        Assert.Equal(replacements.Select(RecoveryDigest).Order(StringComparer.Ordinal), await ReadDigests(fixture, owner.Id));
        Assert.Equal(foreign.Codes.Select(RecoveryDigest).Order(StringComparer.Ordinal), await ReadDigests(fixture, foreign.Id));
        Assert.Equal(before, await sessions.WithSession(owner.Session.Access, false, (_, _, actor) => Task.FromResult(actor), ct));
        Assert.Equal(owner.Id, await sessions.WithSession(sibling.Access, false, (_, _, actor) => Task.FromResult(actor.Id), ct));
        Assert.Equal(profile, await mfa.Profile(owner.Session.Access, ct));
        Assert.True(await new SiteRefreshStore(fixture.DataSource).HasCurrent(owner.Session.Refresh, ct));
        var (sealedSeed, replayFloor) = await fixture.QueryRow("select sealed_seed,last_step from public.mfa_totp where user_id=$1",
            r => (r.GetFieldValue<byte[]>(0), r.GetInt64(1)), owner.Id);
        Assert.Equal(owner.SealedSeed, sealedSeed);
        Assert.Equal(owner.ReplayFloor, replayFloor);

        var login = await BeginLogin(fixture, owner, ct);
        await Denied(() => mfa.FinishLogin(Attempt(login.Token, MfaWire.Login, owner.Codes[2]), login.Binding, false, ct));
        var (signedIn, _) = await mfa.FinishLogin(Attempt(login.Token, MfaWire.Login, replacements[0]), login.Binding, false, ct);
        Assert.Equal(owner.Id, await sessions.WithSession(signedIn.Access, false, (_, _, actor) => Task.FromResult(actor.Id), ct));
        var nextLogin = await BeginLogin(fixture, owner, ct);
        await Denied(() => mfa.FinishLogin(Attempt(nextLogin.Token, MfaWire.Login, replacements[0]), nextLogin.Binding, false, ct));
        Assert.Equal(9, (await ReadDigests(fixture, owner.Id)).Count);

        var staleChallenge = ReadToken(await mfa.BeginRecoveryRegeneration(owner.Session.Access, ct), MfaWire.Regenerate, verified: false);
        var staleProof = ReadToken(await mfa.VerifyRecoveryRegeneration(owner.Session.Access,
            Attempt(staleChallenge, MfaWire.Regenerate, replacements[1]), ct), MfaWire.Regenerate, verified: true);
        await fixture.InTx(async (db, advance) =>
        {
            await FixtureSql.ExecuteAsync(db, advance, ct, "update public.blog_user set generation=2 where id=$1", owner.Id);
            await FixtureSql.ExecuteAsync(db, advance, ct, "update public.user_session set generation=2 where digest=$1", Store.TokenDigest(owner.Session.Access)!);
        });
        Assert.Equal(2L, await sessions.WithSession(owner.Session.Access, false, (_, _, actor) => Task.FromResult(actor.Generation), ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(owner.Session.Access, staleProof, ct));
        Assert.Equal(8, (await ReadDigests(fixture, owner.Id)).Count);

        async Task<byte[]?> TryRedeem()
        {
            try { return await mfa.RegenerateRecoveryCodes(owner.Session.Access, proof, ct, ownerHandle); }
            catch (MfaProofRequiredException) { return null; }
        }
    }

    private sealed record FixtureAccount(Guid Id, byte[] Credential, byte[] SealedSeed, long ReplayFloor,
        SiteRefreshStore.Issued Session, string[] Codes);

    private static Task<FixtureAccount> AddAccount(ScratchDatabase fixture, string name, TotpSecret secrets, CancellationToken ct) =>
        fixture.InTx(async (db, tx) =>
        {
            var account = Guid.NewGuid();
            var credential = RandomNumberGenerator.GetBytes(32);
            var seed = RandomNumberGenerator.GetBytes(Totp.SecretBytes);
            byte[] sealedSeed;
            try { sealedSeed = secrets.Seal(account, seed); }
            finally { CryptographicOperations.ZeroMemory(seed); }
            var replayFloor = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / Totp.StepSeconds;
            await FixtureSql.SiteAccountAsync(db, tx, ct, account, name);
            await FixtureSql.SitePasskeyAsync(db, tx, ct, account, credential, RandomNumberGenerator.GetBytes(32));
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.mfa_totp(user_id,sealed_seed,last_step,verified_at,retry_after,failed_count)
                values($1,$2,$3,clock_timestamp(),clock_timestamp(),0)
                """, account, sealedSeed, replayFloor);
            var codes = new string[3];
            for (var index = 0; index < codes.Length; index++)
            {
                var raw = RandomNumberGenerator.GetBytes(16);
                try
                {
                    var text = Convert.ToHexString(raw);
                    codes[index] = string.Join('-', Enumerable.Range(0, 8).Select(group => text.Substring(group * 4, 4)));
                    await FixtureSql.ExecuteAsync(db, tx, ct, "insert into public.mfa_recovery_code(user_id,digest) values($1,$2)", account, SHA256.HashData(raw));
                }
                finally { CryptographicOperations.ZeroMemory(raw); }
            }
            var issued = await MfaStore.IssueSession(db, tx, account, 1, credential, mfa: true, persistent: true, ct);
            return new FixtureAccount(account, credential, sealedSeed, replayFloor, issued, codes);
        }, ct);

    private static Task<(string Token, string Binding)> BeginLogin(ScratchDatabase fixture, FixtureAccount account, CancellationToken ct) =>
        fixture.InTx(async (db, tx) =>
        {
            var actor = await MfaStore.RequireSession(db, tx, account.Session.Access, ct);
            var binding = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            var bound = actor with { Scope = [.. MfaStore.FlowDigest(binding), .. account.Credential] };
            return (await MfaStore.BeginFlow(db, tx, bound, MfaStore.Purpose.Login, "", ct), binding);
        }, ct);

    private static Task<List<string>> ReadDigests(ScratchDatabase fixture, Guid account) => fixture.QueryRows(
        "select digest from public.mfa_recovery_code where user_id=$1 order by digest",
        r => Convert.ToHexString(r.GetFieldValue<byte[]>(0)), account);

    private static MfaAttempt Attempt(string token, string action, string recovery) => new(token, action, "", recovery);

    private static string ReadToken(byte[] frame, string action, bool verified)
    {
        var payload = Aeds.Decode(frame, FrameType.MfaChallengeResult);
        Assert.Equal(verified ? (byte)1 : (byte)0, payload[4]);
        Assert.Equal((byte)1, payload[5]);
        Assert.Equal(action, ReadFixed(payload.Slice(WireLayouts.MfaChallengeActionOffset, WireLayouts.MfaFixedCodeBytes)));
        var token = ReadFixed(payload.Slice(WireLayouts.MfaChallengeProofOffset, WireLayouts.MfaFixedCodeBytes));
        Assert.Matches("^[A-Za-z0-9_-]{43}$", token);
        return token;
    }

    private static string[] ReadCodes(byte[] frame)
    {
        var payload = Aeds.Decode(frame, FrameType.MfaSetupVerify);
        Assert.Equal((byte)1, payload[0]);
        var count = BinaryPrimitives.ReadInt32LittleEndian(payload[4..]);
        Assert.Equal(10, count);
        Assert.Equal(WireLayouts.MfaSetupVerifyBytes + count * WireLayouts.MfaFixedCodeBytes, payload.Length);
        var codes = new string[count];
        for (var index = 0; index < count; index++)
            codes[index] = ReadFixed(payload.Slice(WireLayouts.MfaSetupVerifyBytes + index * WireLayouts.MfaFixedCodeBytes, WireLayouts.MfaFixedCodeBytes));
        return codes;
    }

    private static string ReadFixed(ReadOnlySpan<byte> bytes) => Encoding.ASCII.GetString(bytes).TrimEnd('\0');
    private static string RecoveryDigest(string code) => Convert.ToHexString(SHA256.HashData(Convert.FromHexString(code.Replace("-", "", StringComparison.Ordinal))));
}
