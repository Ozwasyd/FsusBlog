using System.Buffers.Text;
using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Fido2NetLib;
using Fido2NetLib.Objects;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private sealed record LegacyPasskeySelection(Guid SourceSite, Guid TargetSite, int Account, Guid User, string Origin, string Rp);
    private sealed record LegacyPasskeyPlan(int Version, string SourceReference, LegacyPasskeySelection Selection,
        LegacyPostgresSourceSeal Source, string TargetSha256, string CredentialSha256, string BackupSha256, string Nonce, DateTimeOffset Expires);
    private sealed record LegacyPasskeyCredential(byte[] Handle, byte[] Id, byte[] Key, uint Counter, bool Eligible,
        bool BackedUp, DateTimeOffset Created, DateTimeOffset? LastUsed);

    private static async Task<int> RunLegacyPasskeyAsync(string[] args, CancellationToken ct)
    {
        LegacyPasskeyPlan? approved = null;
        byte[]? approvalBytes = null;
        LegacyPasskeySelection selection;
        string backupPath, backupSha;
        if (args is ["plan", var oldSite, var newSite, var account, var user, var origin, var rp, var path, var sha] &&
            int.TryParse(account, NumberStyles.None, CultureInfo.InvariantCulture, out int number))
            (selection, backupPath, backupSha) = (new(ParseLegacySiteId(oldSite), ParseLegacySiteId(newSite), number,
                ParseLegacySiteId(user), origin, rp), path, sha);
        else if (args is ["apply", var review, var reviewSha, _, _, var restore, var restoreSha])
        {
            approvalBytes = await ReadLegacyPasskeyInputAsync(review, reviewSha, 8192, ct);
            approved = JsonSerializer.Deserialize<LegacyPasskeyPlan>(approvalBytes, OwnerMapJson);
            if (approved is not { Version: 1, SourceReference: LegacyReference, Selection: not null, Source: not null } ||
                approved.BackupSha256 != restoreSha || !IsCanonicalIdentityBytes(approved.Nonce, 32, 32) ||
                approved.Expires > DateTimeOffset.UtcNow.AddMinutes(10))
                throw new InvalidOperationException("Invalid independently approved Passkey plan.");
            (selection, backupPath, backupSha) = (approved.Selection, restore, restoreSha);
        }
        else throw new ArgumentException("Use legacy passkey plan or apply with the documented arguments.");

        if (selection.SourceSite == Guid.Empty || selection.TargetSite == Guid.Empty || selection.User == Guid.Empty ||
            selection.SourceSite == selection.TargetSite || selection.Account is < 1 or >= int.MaxValue ||
            selection.Origin != Environment.GetEnvironmentVariable("FSUSBLOG_PASSKEY_ORIGIN") ||
            selection.Rp != Environment.GetEnvironmentVariable("FSUSBLOG_PASSKEY_RP_ID") ||
            !Uri.TryCreate(selection.Origin, UriKind.Absolute, out var originUri) ||
            selection.Origin != originUri.GetLeftPart(UriPartial.Authority) || originUri.UserInfo.Length != 0 ||
            (originUri.Scheme != "https" && (originUri.Scheme != "http" || !originUri.IsLoopback)) ||
            selection.Rp is not { Length: > 0 and <= 253 } || selection.Rp != originUri.IdnHost ||
            (originUri.HostNameType != UriHostNameType.Dns && !originUri.IsLoopback))
            throw new InvalidOperationException("The reviewed old and v2 Passkey RP and origin must match exactly.");

        var backup = await ReadLegacyImportBackupAsync(backupPath, backupSha, ct);
        var target = ParseLegacyRuntimeActivationDatabase("FSUSBLOG_LEGACY_PASSKEY_DB");
        await using var db = new NpgsqlConnection(target.ConnectionString);
        await db.OpenAsync(ct);
        await RequireBackupDatabaseLockAsync(db, ct);
        await using var tx = approved is null ? await BeginReadOnlyAsync(db, ct) : await db.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        await ExecuteAsync(db, tx, "SET LOCAL search_path=pg_catalog", ct);
        await SetBackupRepresentationAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        var targetCluster = await ReadLegacyPostgresClusterAsync(db, tx, ct);
        var targetSha = await FingerprintLegacyPostgresDatabaseAsync(db, tx, targetCluster, ct);
        await using var gate = new NpgsqlCommand("""
            SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses')=''
                AND current_setting('session_replication_role')='origin' AND NOT pg_is_in_recovery()
                AND to_regnamespace('fsus_legacy_candidate') IS NULL
                AND (SELECT version FROM public.v2_schema WHERE singleton)=$2
                AND EXISTS (SELECT FROM public.blog_user WHERE id=$1 AND enabled)
                AND NOT EXISTS (SELECT FROM public.login_ticket WHERE user_id=$1)
                AND NOT EXISTS (SELECT FROM public.user_session WHERE user_id=$1)
                AND NOT EXISTS (SELECT FROM public.passkey_challenge)
                AND NOT EXISTS (SELECT FROM public.mfa_totp WHERE user_id=$1)
            """, db, tx);
        gate.Parameters.AddWithValue(selection.User);
        gate.Parameters.AddWithValue(CurrentSchema.Version);
        if (await gate.ExecuteScalarAsync(ct) is not true ||
            await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct) != selection.TargetSite ||
            await CurrentSchema.RequiresSiteRecoveryAsync(db, tx, selection.User, ct))
            throw new InvalidOperationException("The independent owner or runtime site is not eligible for Passkey import.");

        var (observed, media) = await ReadBackupSiteAsync(db, tx, ct);
        var baseline = backup.Site.Relations;
        if (media.Count != 0 || backup.Site.PostgreSqlMajor != db.PostgreSqlVersion.Major.ToString(CultureInfo.InvariantCulture) ||
            baseline.Count(IsLegacyPasskeyDestinationRelation) != 3 ||
            baseline.Any(row => (row.Name is "passkey_subject" or "passkey_credential") && row.Rows != 0) ||
            !baseline.Where(row => !IsLegacyPasskeyDestinationRelation(row)).SequenceEqual(observed.Where(row => !IsLegacyPasskeyDestinationRelation(row))))
            throw new InvalidOperationException("The Passkey runtime differs from the reviewed rollback baseline.");
        bool pristine = baseline.SequenceEqual(observed);

        var source = ParseLegacySource("postgres");
        await using var oldDb = (NpgsqlConnection)source.Connection;
        await oldDb.OpenAsync(ct);
        await using var oldTx = (NpgsqlTransaction)await BeginLegacyReadAsync(oldDb, ct);
        if (await ReadLegacyPostgresClusterAsync(oldDb, oldTx, ct) == targetCluster)
            throw new InvalidOperationException("Passkey proof requires a separate restored source cluster.");
        var sourceSeal = await SealLegacyPostgresSourceAsync(source, oldDb, oldTx, ct);
        var (credential, credentialSha) = await ReadLegacyPasskeyCredentialAsync(source, oldTx, selection.Account, ct);
        await oldTx.RollbackAsync(ct);
        var observedPlan = new LegacyPasskeyPlan(1, LegacyReference, selection, sourceSeal, targetSha, credentialSha,
            backupSha, approved?.Nonce ?? Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32)),
            approved?.Expires ?? DateTimeOffset.UtcNow.AddMinutes(10));

        if (approved is null)
        {
            if (!pristine) throw new InvalidOperationException("Plan requires a pristine backup-matching Passkey destination.");
            await VerifyLegacyPasskeyDestinationAsync(db, tx, selection, credential, pristine, credential.Counter, ct);
            Console.WriteLine(JsonSerializer.Serialize(observedPlan, Json));
            return 0;
        }
        if (approved != observedPlan || pristine && approved.Expires <= DateTimeOffset.UtcNow)
            throw new InvalidOperationException("The approved Passkey source, destination or validity interval differs.");
        PasskeyLoginRequest assertion;
        try { assertion = PasskeyWire.ReadLogin(await ReadLegacyPasskeyInputAsync(args[3], args[4], 32768, ct)); }
        catch (ProtocolException) { throw new InvalidOperationException("Invalid discoverable Passkey assertion frame."); }
        var verifiedCounter = await VerifyLegacyPasskeyAssertionAsync(selection, credential, SHA256.HashData(approvalBytes!), assertion, ct);
        if (pristine)
        {
            await VerifyLegacyPasskeyDestinationAsync(db, tx, selection, credential, true, credential.Counter, ct);
            await WriteLegacyPasskeyAsync(db, tx, selection, credential, verifiedCounter, ct);
        }
        await VerifyLegacyPasskeyDestinationAsync(db, tx, selection, credential, false, verifiedCounter, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            reviewSha256 = args[2], sourceAccount = selection.Account, result = pristine ? "imported" : "revalidated",
            copiedSessions = 0, copiedMfaSecrets = 0, oldSessions = "reauthenticate",
            oldRecovery = "reenroll separately", oldEnrollmentMetadata = "retained at source"
        }, Json));
        return 0;
    }

    private static bool IsLegacyPasskeyDestinationRelation(BackupRelation row) =>
        row.Name is "passkey_subject" or "passkey_credential" or "passkey_subject_account_id_seq";

    private static async Task<byte[]> ReadLegacyPasskeyInputAsync(string path, string sha, int limit, CancellationToken ct)
    {
        await using var file = OpenLegacyMediaReviewFile(path);
        if (!IsSha256(sha) || file.Length is < 1 || file.Length > limit)
            throw new InvalidOperationException("Invalid pinned Passkey import input.");
        var bytes = new byte[(int)file.Length];
        await file.ReadExactlyAsync(bytes, ct);
        if (file.ReadByte() != -1 || Convert.ToHexStringLower(SHA256.HashData(bytes)) != sha)
            throw new InvalidOperationException("Pinned Passkey import input changed.");
        return bytes;
    }

    private static async Task<uint> VerifyLegacyPasskeyAssertionAsync(LegacyPasskeySelection selection, LegacyPasskeyCredential credential,
        byte[] challenge, PasskeyLoginRequest request, CancellationToken ct)
    {
        if (request.Token != Base64Url.EncodeToString(challenge) || request.CredentialId != Base64Url.EncodeToString(credential.Id) ||
            !request.RawId.AsSpan().SequenceEqual(credential.Id) || !request.UserHandle.AsSpan().SequenceEqual(credential.Handle) ||
            request.RememberMe || request.AuthenticatorData.Length < 37)
            throw new InvalidOperationException("Passkey assertion does not bind the approved source credential and challenge.");
        var verifier = new Fido2(new Fido2Configuration
        {
            ServerDomain = selection.Rp, ServerName = "FsusBlog",
            Origins = new HashSet<string>(StringComparer.Ordinal) { selection.Origin }
        });
        VerifyAssertionResult verified;
        try
        {
            verified = await PasskeyVerification.Assert(verifier, request, new AssertionOptions
            {
                Challenge = challenge, RpId = selection.Rp, UserVerification = UserVerificationRequirement.Required, AllowCredentials = []
            }, credential.Handle, credential.Key, credential.Counter, ct);
        }
        catch (Fido2VerificationException) { throw new InvalidOperationException("The migration Passkey assertion failed native verification."); }
        if ((credential.Counter != 0 || verified.SignCount != 0) && verified.SignCount <= credential.Counter ||
            ((request.AuthenticatorData[32] & 0x08) != 0) != credential.Eligible || verified.IsBackedUp != credential.BackedUp)
            throw new InvalidOperationException("The migration Passkey counter or backup flags do not match the reviewed credential.");
        return verified.SignCount;
    }
}
