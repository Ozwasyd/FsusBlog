using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authentication;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Passkeys;
using FsusBlog.V2.Server.Sessions;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class MfaRecoveryRegenerationPostgresTests
{
    [PostgresFact]
    public async Task ActionBoundProofAtomicallyReplacesCodesWithoutChangingAuthenticatorOrSession()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var secrets = new TotpSecret(RandomNumberGenerator.GetBytes(32));
        var mfa = new MfaStore(fixture.DataSource, secrets);
        var sessions = new Store(fixture.DataSource);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await AddAccount(db, "MFA regeneration owner", secrets, ct);
        var foreign = await AddAccount(db, "MFA regeneration foreign", secrets, ct);
        var sibling = await IssueSession(db, owner.Id, owner.Credential, persistent: false, ct);
        var ownerHandle = SiteSessions.Id(owner.Id, Store.TokenDigest(owner.Session.Access)!);
        var siblingHandle = SiteSessions.Id(owner.Id, Store.TokenDigest(sibling.Access)!);

        var disable = ReadToken(await mfa.BeginDisable(owner.Session.Access, ct), MfaWire.Disable, verified: false);
        await Denied(() => mfa.VerifyRecoveryRegeneration(owner.Session.Access, Attempt(disable, MfaWire.Regenerate, owner.Codes[0]), ct));
        var disableProof = ReadToken(await mfa.VerifyDisable(owner.Session.Access, Attempt(disable, MfaWire.Disable, owner.Codes[0]), ct),
            MfaWire.Disable, verified: true);
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(owner.Session.Access, disableProof, ct));

        await Rejected(Rejection.Conflict, () => mfa.BeginRecoveryRegeneration(owner.Session.Access, ct, siblingHandle));
        var challenge = ReadToken(await mfa.BeginRecoveryRegeneration(owner.Session.Access, ct, ownerHandle), MfaWire.Regenerate, verified: false);
        var attempt = Attempt(challenge, MfaWire.Regenerate, owner.Codes[1]);
        await Denied(() => mfa.VerifyDisable(owner.Session.Access, Attempt(challenge, MfaWire.Disable, owner.Codes[1]), ct));
        await Denied(() => mfa.VerifyRecoveryRegeneration(sibling.Access, attempt, ct));
        await Denied(() => mfa.VerifyRecoveryRegeneration(foreign.Session.Access, attempt, ct));
        await Rejected(Rejection.Conflict, () => mfa.VerifyRecoveryRegeneration(owner.Session.Access, attempt, ct, siblingHandle));
        var proof = ReadToken(await mfa.VerifyRecoveryRegeneration(owner.Session.Access, attempt, ct, ownerHandle), MfaWire.Regenerate, verified: true);
        await using (var digest = Store.Sql(db, null, """
            select exists (select 1 from public.mfa_flow where digest=$2 and options=$3)
            and not exists (select 1 from public.mfa_flow where digest=$1)
            """, MfaStore.FlowDigest(proof), MfaStore.FlowDigest(proof, MfaWire.Regenerate), MfaWire.Regenerate))
            Assert.Equal(true, await digest.ExecuteScalarAsync(ct));
        await Denied(() => mfa.VerifyRecoveryRegeneration(owner.Session.Access, attempt, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.Disable(owner.Session.Access, proof, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(sibling.Access, proof, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(foreign.Session.Access, proof, ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(owner.Session.Access, null, ct));
        await Rejected(Rejection.Conflict, () => mfa.RegenerateRecoveryCodes(owner.Session.Access, proof, ct, siblingHandle));

        var before = await sessions.WithSession(owner.Session.Access, false, (_, _, actor) => Task.FromResult(actor), ct);
        var profile = await mfa.Profile(owner.Session.Access, ct);
        Assert.Equal(RecoveryDigest(owner.Codes[2]), Assert.Single(await ReadDigests(db, owner.Id, ct)));

        await using (var blockWrite = Store.Sql(db, null, $"""
            alter table public.mfa_recovery_code add constraint fixture_refuse_new_codes
                check (user_id <> '{owner.Id:D}'::uuid) not valid
            """)) await blockWrite.ExecuteNonQueryAsync(ct);
        await Assert.ThrowsAsync<PostgresException>(() => mfa.RegenerateRecoveryCodes(owner.Session.Access, proof, ct));
        Assert.Equal(RecoveryDigest(owner.Codes[2]), Assert.Single(await ReadDigests(db, owner.Id, ct)));
        await using (var allowWrite = Store.Sql(db, null, "alter table public.mfa_recovery_code drop constraint fixture_refuse_new_codes"))
            await allowWrite.ExecuteNonQueryAsync(ct);

        var concurrent = await Task.WhenAll(TryRedeem(), TryRedeem());
        var result = Assert.Single(concurrent.OfType<byte[]>());
        Assert.Single(concurrent, value => value is null);
        var replacements = ReadCodes(result);
        Assert.Equal(10, replacements.Length);
        Assert.Equal(replacements.Length, replacements.Distinct(StringComparer.Ordinal).Count());
        Assert.All(replacements, code => Assert.Matches("^(?:[0-9A-F]{4}-){7}[0-9A-F]{4}$", code));
        Assert.Equal(replacements.Select(RecoveryDigest).Order(StringComparer.Ordinal), await ReadDigests(db, owner.Id, ct));
        Assert.Equal(foreign.Codes.Select(RecoveryDigest).Order(StringComparer.Ordinal), await ReadDigests(db, foreign.Id, ct));
        Assert.Equal(before, await sessions.WithSession(owner.Session.Access, false, (_, _, actor) => Task.FromResult(actor), ct));
        Assert.Equal(owner.Id, await sessions.WithSession(sibling.Access, false, (_, _, actor) => Task.FromResult(actor.Id), ct));
        Assert.Equal(profile, await mfa.Profile(owner.Session.Access, ct));
        Assert.True(await new SiteRefreshStore(fixture.DataSource).HasCurrent(owner.Session.Refresh, ct));
        await using (var factor = Store.Sql(db, null, "select sealed_seed,last_step from public.mfa_totp where user_id=$1", owner.Id))
        await using (var record = await factor.ExecuteReaderAsync(ct))
        {
            Assert.True(await record.ReadAsync(ct));
            Assert.Equal(owner.SealedSeed, record.GetFieldValue<byte[]>(0));
            Assert.Equal(owner.ReplayFloor, record.GetInt64(1));
        }

        var login = await BeginLogin(db, owner, ct);
        await Denied(() => mfa.FinishLogin(Attempt(login.Token, MfaWire.Login, owner.Codes[2]), login.Binding, false, ct));
        var (signedIn, _) = await mfa.FinishLogin(Attempt(login.Token, MfaWire.Login, replacements[0]), login.Binding, false, ct);
        Assert.Equal(owner.Id, await sessions.WithSession(signedIn.Access, false, (_, _, actor) => Task.FromResult(actor.Id), ct));
        var nextLogin = await BeginLogin(db, owner, ct);
        await Denied(() => mfa.FinishLogin(Attempt(nextLogin.Token, MfaWire.Login, replacements[0]), nextLogin.Binding, false, ct));
        Assert.Equal(9, (await ReadDigests(db, owner.Id, ct)).Length);

        var staleChallenge = ReadToken(await mfa.BeginRecoveryRegeneration(owner.Session.Access, ct), MfaWire.Regenerate, verified: false);
        var staleProof = ReadToken(await mfa.VerifyRecoveryRegeneration(owner.Session.Access,
            Attempt(staleChallenge, MfaWire.Regenerate, replacements[1]), ct), MfaWire.Regenerate, verified: true);
        await using (var advance = await db.BeginTransactionAsync(ct))
        {
            await Execute(db, advance, ct, "update public.blog_user set generation=2 where id=$1", owner.Id);
            await Execute(db, advance, ct, "update public.user_session set generation=2 where digest=$1", Store.TokenDigest(owner.Session.Access)!);
            await advance.CommitAsync(ct);
        }
        Assert.Equal(2L, await sessions.WithSession(owner.Session.Access, false, (_, _, actor) => Task.FromResult(actor.Generation), ct));
        await Assert.ThrowsAsync<MfaProofRequiredException>(() => mfa.RegenerateRecoveryCodes(owner.Session.Access, staleProof, ct));
        Assert.Equal(8, (await ReadDigests(db, owner.Id, ct)).Length);

        async Task<byte[]?> TryRedeem()
        {
            try { return await mfa.RegenerateRecoveryCodes(owner.Session.Access, proof, ct, ownerHandle); }
            catch (MfaProofRequiredException) { return null; }
        }
    }

    private sealed record FixtureAccount(Guid Id, byte[] Credential, byte[] SealedSeed, long ReplayFloor,
        SiteRefreshStore.Issued Session, string[] Codes);

    private static async Task<FixtureAccount> AddAccount(NpgsqlConnection db, string name, TotpSecret secrets, CancellationToken ct)
    {
        var account = Guid.NewGuid();
        var credential = RandomNumberGenerator.GetBytes(32);
        var seed = RandomNumberGenerator.GetBytes(Totp.SecretBytes);
        byte[] sealedSeed;
        try { sealedSeed = secrets.Seal(account, seed); }
        finally { CryptographicOperations.ZeroMemory(seed); }
        var replayFloor = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / Totp.StepSeconds;
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            await FixtureSql.SiteAccountAsync(db, tx, ct, account, name, canAuthor: false);
            await FixtureSql.SitePasskeyAsync(db, tx, ct, account, credential, RandomNumberGenerator.GetBytes(32));
            await Execute(db, tx, ct, """
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
                    await Execute(db, tx, ct, "insert into public.mfa_recovery_code(user_id,digest) values($1,$2)", account, SHA256.HashData(raw));
                }
                finally { CryptographicOperations.ZeroMemory(raw); }
            }
            var issued = await MfaStore.IssueSession(db, tx, account, 1, credential, mfa: true, persistent: true, ct);
            await tx.CommitAsync(ct);
            return new(account, credential, sealedSeed, replayFloor, issued, codes);
        }
    }

    private static async Task<SiteRefreshStore.Issued> IssueSession(NpgsqlConnection db, Guid account, byte[] credential,
        bool persistent, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(ct);
        var issued = await MfaStore.IssueSession(db, tx, account, 1, credential, mfa: true, persistent, ct);
        await tx.CommitAsync(ct);
        return issued;
    }

    private static async Task<(string Token, string Binding)> BeginLogin(NpgsqlConnection db, FixtureAccount account, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(ct);
        var actor = await MfaStore.RequireSession(db, tx, account.Session.Access, ct);
        var binding = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var bound = actor with { Scope = [.. MfaStore.FlowDigest(binding), .. account.Credential] };
        var token = await MfaStore.BeginFlow(db, tx, bound, MfaStore.Purpose.Login, "", ct);
        await tx.CommitAsync(ct);
        return (token, binding);
    }

    private static async Task<string[]> ReadDigests(NpgsqlConnection db, Guid account, CancellationToken ct)
    {
        await using var query = Store.Sql(db, null, "select digest from public.mfa_recovery_code where user_id=$1 order by digest", account);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var digests = new List<string>();
        while (await rows.ReadAsync(ct)) digests.Add(Convert.ToHexString(rows.GetFieldValue<byte[]>(0)));
        return digests.ToArray();
    }

    private static Task Execute(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct, string sql, params object[] args) =>
        FixtureSql.ExecuteAsync(db, tx, ct, sql, args);

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

    private static Task Denied(Func<Task> action) => Rejected(Rejection.Unauthorized, action);

    private static async Task Rejected(Rejection reason, Func<Task> action) =>
        Assert.Equal(reason, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);
}
