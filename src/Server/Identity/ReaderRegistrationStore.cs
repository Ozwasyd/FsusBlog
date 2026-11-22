using System.Security.Cryptography;
using Fido2NetLib;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Operations;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed partial class PasskeyStore
{
    internal async Task<byte[]> BeginReaderRegistration(string binding,
        Func<NpgsqlConnection, NpgsqlTransaction, Task> admit, CancellationToken ct)
    {
        var token = NewToken();
        var key = ReaderRegistrationKey(token, binding);
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        await admit(db, tx);
        var options = _verifier.RequestRegistration(RandomNumberGenerator.GetBytes(WireLimits.PasskeyUserHandleBytes));
        await SaveChallenge(db, tx, key, options.ToJson(), null, null, null, ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return options.RegistrationFrame(token);
    }

    internal async Task CompleteReaderRegistration(PasskeyProvisionRequest request, string? binding, CancellationToken ct)
    {
        var key = ReaderRegistrationKey(request.Token, binding);
        await using var db = await _source.OpenConnectionAsync(ct);
        // Retire an attempted ceremony before attestation, just like first-Passkey provisioning.
        var challenge = await ConsumeChallenge(db, key, null, ct);
        if (challenge.UserId is not null || challenge.Generation is not null) throw Denied();
        CheckId(request.CredentialId, request.RawId);
        var options = CredentialCreateOptions.FromJson(challenge.Options);
        var id = Guid.NewGuid();
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.blog_user(id,name,enabled,generation) values($1,$2,true,1)
            """, id, "reader-" + id.ToString("N"));
        await using (var subject = Store.Sql(db, tx,
            "insert into public.passkey_subject(user_id,user_handle) values($1,$2)", id, options.User.Id))
            await subject.ExecuteNonQueryAsync(ct);
        await RegisterCredential(db, tx, id, request, options, ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
    }

    internal static string NewReaderRegistrationBinding() => NewToken();

    internal static bool ValidReaderRegistrationToken(string? value)
    {
        if (value is not { Length: 43 } || !value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) return false;
        return WebEncoders.Base64UrlEncode(WebEncoders.Base64UrlDecode(value)) == value;
    }

    private static string ReaderRegistrationKey(string token, string? binding)
    {
        if (!ValidReaderRegistrationToken(token) || !ValidReaderRegistrationToken(binding)) throw Denied();
        return "reader-registration:" + token + ":" + binding;
    }
}
