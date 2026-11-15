using System.Security.Cryptography;
using Fido2NetLib;
using Fido2NetLib.Objects;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore(NpgsqlDataSource source, InstanceLease? lease, PasskeyConfiguration config)
{
    private readonly NpgsqlDataSource _source = source;
    private readonly InstanceLease? _lease = lease;
    private readonly Fido2 _verifier = config.CreateVerifier("FsusBlog administration");
    private const string Permission = CurrentSchema.AdminManagePermission;
    private const int Login = 1;
    private const int Bootstrap = 2;
    private const int ChallengeLimit = 128;
    private const long ChallengeLock = 716729109726707503L;

    internal async Task<(byte[] Frame, string Binding)> BeginLogin(CancellationToken ct)
    {
        var options = _verifier.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [], UserVerification = UserVerificationRequirement.Required
        });
        var (token, binding) = (Token(), Token());
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        await SaveChallenge(db, tx, token, ChallengeDigest(binding, null), Login, null, options.ToJson(), ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return (PasskeyWire.LoginBegin(token, checked((uint)options.Timeout), options.RpId!, options.Challenge), binding);
    }

    internal async Task<(byte[] Frame, string Binding)> BeginBootstrap(string? ticket, CancellationToken ct)
    {
        var digest = Store.TokenDigest(ticket) ?? throw Denied();
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var principal = await BootstrapPrincipal(db, tx, digest, ct);
        var (token, binding) = (Token(), Token());
        var options = _verifier.RequestNewCredential(new RequestNewCredentialParams
        {
            User = new Fido2User { Id = principal.UserHandle, Name = principal.Handle, DisplayName = principal.Handle },
            AuthenticatorSelection = new AuthenticatorSelection
            {
                ResidentKey = ResidentKeyRequirement.Required, UserVerification = UserVerificationRequirement.Required
            },
            AttestationPreference = AttestationConveyancePreference.None
        });
        await SaveChallenge(db, tx, token, ChallengeDigest(binding, digest), Bootstrap, principal, options.ToJson(), ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return (PasskeyWire.ProvisionBegin(token, checked((uint)options.Timeout), options.Rp.Id, options.Rp.Name,
            options.User.Name, options.User.DisplayName, options.User.Id, options.Challenge,
            options.PubKeyCredParams.Select(parameter => (int)parameter.Alg).ToArray()), binding);
    }

    internal async Task CompleteBootstrap(PasskeyProvisionRequest request, string? binding, string? ticket, CancellationToken ct)
    {
        var digest = Store.TokenDigest(ticket) ?? throw Denied();
        await using var db = await _source.OpenConnectionAsync(ct);
        var challenge = await ConsumeChallenge(db, request.Token, ChallengeDigest(binding, digest), Bootstrap, ct);
        RequireCredentialId(request.CredentialId, request.RawId);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var principal = await BootstrapPrincipal(db, tx, digest, ct);
        var options = CredentialCreateOptions.FromJson(challenge.Options);
        if (principal.Id != challenge.Principal || principal.Generation != challenge.Generation ||
            !CryptographicOperations.FixedTimeEquals(options.User.Id, principal.UserHandle)) throw Denied();

        RegisteredPublicKeyCredential verified;
        try
        {
            verified = await PasskeyVerification.Attest(_verifier, request, options, async (candidate, ct) =>
            {
                await using var prior = Store.Sql(db, tx, """
                    select not exists(select 1 from public.admin_passkey_credential where credential_id=$1)
                    """, candidate.CredentialId);
                return (bool)(await prior.ExecuteScalarAsync(ct))!;
            }, ct);
        }
        catch (Fido2VerificationException) { throw Denied(); }

        try
        {
            await Execute(db, tx, ct, """
                insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
                values($1,$2,$3,$4,$5,$6)
                """, verified.Id, principal.Id, verified.PublicKey, (long)verified.SignCount, verified.IsBackupEligible, verified.IsBackedUp);
        }
        catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation) { throw Denied(); }
        await using (var consume = Store.Sql(db, tx, """
            delete from public.admin_invitation where principal_id=$1 and digest=$2 and generation=$3 and expires_at>clock_timestamp()
            """, principal.Id, digest, principal.Generation))
            if (await consume.ExecuteNonQueryAsync(ct) != 1) throw Denied();
        await Execute(db, tx, ct, """
            update public.admin_principal set generation=generation+1,generation_changed_at=clock_timestamp() where id=$1
            """, principal.Id);
        await Execute(db, tx, ct, "delete from public.admin_challenge where principal_id=$1", principal.Id);
        await InstanceLease.CommitProtected(tx, _lease, ct);
    }

    internal async Task<string> CompleteLogin(PasskeyLoginRequest request, string? binding, CancellationToken ct)
    {
        await using var db = await _source.OpenConnectionAsync(ct);
        var challenge = await ConsumeChallenge(db, request.Token, ChallengeDigest(binding, null), Login, ct);
        RequireCredentialId(request.CredentialId, request.RawId);
        if (request.RememberMe || request.AuthenticatorData.Length < 37) throw Denied();
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var principal = await LockPrincipal(db, tx, """
            select principal_id from public.admin_passkey_credential where credential_id=$1
            """, request.RawId, ct);
        if (challenge.StartedAt <= principal.GenerationChangedAt) throw Denied();
        await VerifyCredential(db, tx, principal.Id, principal.UserHandle, request, AssertionOptions.FromJson(challenge.Options), ct);
        var raw = RandomNumberGenerator.GetBytes(32);
        try
        {
            await AdminSignInHistory.RecordAsync(db, tx, principal.Id, SHA256.HashData(raw), principal.Generation, ct);
            await InstanceLease.CommitProtected(tx, _lease, ct);
            return Convert.ToHexStringLower(raw);
        }
        finally { CryptographicOperations.ZeroMemory(raw); }
    }

    private async Task VerifyCredential(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal, byte[] handle,
        PasskeyLoginRequest request, AssertionOptions options, CancellationToken ct, bool requireHandle = true)
    {
        if (request.AuthenticatorData.Length < 37 || (requireHandle || request.UserHandle.Length != 0) &&
            !CryptographicOperations.FixedTimeEquals(handle, request.UserHandle)) throw Denied();
        byte[] key;
        uint counter;
        bool backupEligible;
        await using (var credential = Store.Sql(db, tx, """
            select public_key,sign_count,backup_eligible from public.admin_passkey_credential
            where principal_id=$1 and credential_id=$2 for update
            """, principal, request.RawId))
        await using (var row = await credential.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Denied();
            (key, counter, backupEligible) = (row.GetFieldValue<byte[]>(0), checked((uint)row.GetInt64(1)), row.GetBoolean(2));
        }
        VerifyAssertionResult verified;
        try
        {
            verified = await PasskeyVerification.Assert(_verifier, request, options, handle, key, counter, ct);
        }
        catch (Fido2VerificationException) { throw Denied(); }
        if (((request.AuthenticatorData[32] & 0x08) != 0) != backupEligible) throw Denied();
        await Execute(db, tx, ct, """
            update public.admin_passkey_credential set sign_count=$2,backed_up=$3 where credential_id=$1
            """, request.RawId, (long)verified.SignCount, verified.IsBackedUp);
    }
}
