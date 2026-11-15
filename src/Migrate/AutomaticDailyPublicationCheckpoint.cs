using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Microsoft.Win32.SafeHandles;
using Npgsql;

internal static partial class Migration
{
    private const int DailyArchiveBytes = 4096;
    private const UnixFileMode PrivateDirectory = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode ReadOnlyOwner = UnixFileMode.UserRead;

    private static async Task SealDailyPublicationCheckpointAsync(NpgsqlConnection db, string[] args, CancellationToken ct)
    {
        if (args.Length is < 5 or > 6 || !AuditSha256(args[3]) || !Path.IsPathFullyQualified(args[4]) ||
            Path.GetFullPath(args[4]) != args[4] || !NativeUnixFile.Supported)
            throw new ArgumentException("Supply the independent log anchor and an absolute private output directory on macOS or Linux.");
        var anchor = (Sequence: CheckpointSequence(args[2]), Hash: Convert.FromHexString(args[3]));
        using var directory = NativeUnixFile.OpenDirectory(args[4]);
        if (!NativeUnixFile.HasMode(directory, PrivateDirectory, owned: true))
            throw new InvalidOperationException("The daily checkpoint output directory must be owned by the signer with mode 0700.");

        var signerId = Environment.GetEnvironmentVariable("IntegrityProof__CheckpointSigning__KeyId");
        var (current, keys) = await ReadTransparencyKeysAsync(args[1], ct);
        try
        {
            if (signerId is null || !keys.TryGetValue(signerId, out var standaloneKey) || signerId == current ||
                standaloneKey.Fingerprint.AsSpan().SequenceEqual(keys[current].Fingerprint))
                throw new InvalidOperationException("Automatic daily checkpoints require a separately registered checkpoint signing key.");

            await using var tx = await BeginReadOnlyAsync(db, ct);
            // Transaction start precedes the snapshot. A job crossing midnight cannot seal the new day early.
            await using var clock = new NpgsqlCommand("select transaction_timestamp() where not pg_is_in_recovery()", db, tx);
            if (await clock.ExecuteScalarAsync(ct) is not DateTime at)
                throw new InvalidOperationException("Automatic daily checkpoints require a live PostgreSQL primary.");

            var scope = args.Length == 6 ? args[5] : DateOnly.FromDateTime(at.AddDays(-1)).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            if (!PublicationCheckpointV2.TryDay(scope, out var day)) throw new ArgumentException("Supply a UTC day in YYYY-MM-DD format.");
            var midnight = day.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
            if (midnight.AddDays(1) > at) throw new InvalidOperationException("The requested UTC day is still open.");
            await CurrentSchema.VerifyPublicationCheckpointSchemaAsync(db, tx, ct);
            var latest = await ReadExactDailyTail(db, tx, args[0], at, ct);
            await VerifyAutomaticHead(db, tx, keys, latest.Claim, latest.Signature, ct);
            if (latest.Claim.KeySha256.AsSpan().SequenceEqual(standaloneKey.Fingerprint))
                throw new InvalidOperationException("The automatic checkpoint key must differ from the native head signer.");

            var name = scope + ".json";
            var retained = await ReadAutomaticArchive(directory, name, args[0], scope, at, ct);
            var head = retained?.Head ?? latest.Claim with
            {
                KeyId = signerId, KeyVersion = standaloneKey.Version, KeySha256 = standaloneKey.Fingerprint, AttestedAt = at,
            };
            if (head.AttestedAt < midnight.AddDays(1)) throw BadCheckpointPrefix();
            var entries = await ReadDailyCheckpointEntries(db, tx, midnight, latest.Claim, ct, anchor, head, at);
            var root = entries.Count == 0 ? PublicationCheckpointTreeV2.EmptyDailyRoot() : PublicationCheckpointTreeV2.Build(entries, null).RootSha256;
            var claim = new PublicationCheckpointV2(args[0], scope, entries.Count == 0 ? 0 : entries[0].Sequence,
                entries.Count == 0 ? 0 : entries[^1].Sequence, entries.Count, root, head.Sequence, head.EntrySha256,
                head.KeyId, head.KeyVersion, head.KeySha256, head.AttestedAt, PublicationCheckpointKind.Daily);
            byte[] bytes;
            if (retained is null)
            {
                var signer = await RequireCheckpointKey(db, tx, keys, signerId, at, ct);
                await using var now = new NpgsqlCommand("select clock_timestamp()", db, tx);
                if (await now.ExecuteScalarAsync(ct) is not DateTime completed || completed < at)
                    throw new InvalidOperationException("The database clock moved back during daily checkpoint issuance.");
                using var key = NativePublicationSigningKey.Open(
                    Environment.GetEnvironmentVariable("IntegrityProof__CheckpointSigning__PrivateKeyFile"),
                    signer.PublicKey.ExportSubjectPublicKeyInfo());
                bytes = EncodeAutomaticArchive(head, SignPublicationAttestation(head.Payload(), key), SignPublicationCheckpoint(claim, key));
            }
            else
            {
                var key = await VerifyAutomaticHead(db, tx, keys, head, retained.HeadSignature, ct);
                if (!VerifyPublicationAttestation(key, claim.Payload(), retained.CheckpointSignature))
                    throw new InvalidOperationException("The retained daily checkpoint signature does not match the ledger.");
                bytes = EncodeAutomaticArchive(head, retained.HeadSignature, EncodePublicationCheckpoint(claim, retained.CheckpointSignature));
                if (!bytes.AsSpan().SequenceEqual(retained.Bytes))
                    throw new InvalidOperationException("The retained daily checkpoint bytes were changed.");
            }

            await tx.CommitAsync(ct);
            var path = Path.Combine(args[4], name);
            if (retained is null) WriteAutomaticArchive(path, bytes, ct);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                scopeKey = scope, path, sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)),
                anchor = DecimalSequence(head.Sequence) + ":" + Convert.ToHexStringLower(head.EntrySha256),
            }));
        }
        finally
        {
            foreach (var key in keys.Values) key.PublicKey.Dispose();
        }
    }

    private static async Task<(PublicationTransparencyHeadV2 Claim, byte[] Signature)> ReadExactDailyTail(
        NpgsqlConnection db, NpgsqlTransaction tx, string origin, DateTime at, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select h.seq,h.entry_sha256,h.origin,h.key_id,h.key_version,h.key_sha256,h.attested_at,h.signature
            from public.publication_transparency_head h
            join (select seq,entry_sha256 from public.article_publication_transparency order by seq desc limit 1) tail
              on (h.seq,h.entry_sha256)=(tail.seq,tail.entry_sha256)
            where h.singleton
            """, db, tx);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct) || row.GetInt64(0) > PublicationCheckpointV2.MaxPrefixEntries ||
            row.GetString(2) != origin || row.GetDateTime(6) > at)
            throw new InvalidOperationException("The native log has no eligible exact signed tail at this database snapshot.");
        return (new(origin, row.GetInt64(0), row.GetFieldValue<byte[]>(1), row.GetString(3), row.GetInt32(4),
            row.GetFieldValue<byte[]>(5), row.GetDateTime(6)), row.GetFieldValue<byte[]>(7));
    }

    private static async Task<TransparencyAuditKey> VerifyAutomaticHead(NpgsqlConnection db, NpgsqlTransaction tx,
        IReadOnlyDictionary<string, TransparencyAuditKey> keys, PublicationTransparencyHeadV2 head, byte[] signature, CancellationToken ct)
    {
        var key = await RequireCheckpointKey(db, tx, keys, head.KeyId, head.AttestedAt, ct);
        if (key.Version != head.KeyVersion || !key.Fingerprint.AsSpan().SequenceEqual(head.KeySha256) ||
            !VerifyPublicationAttestation(key, head.Payload(), signature)) throw BadCheckpointPrefix();
        return key;
    }

    private static bool VerifyPublicationAttestation(TransparencyAuditKey key, byte[] payload, byte[] signature) =>
        signature.Length == 64 && key.PublicKey.VerifyData(payload, signature, HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    private static byte[] EncodeAutomaticArchive(PublicationTransparencyHeadV2 head, byte[] signature, object checkpoint) =>
        JsonSerializer.SerializeToUtf8Bytes(new
        {
            archiveVersion = 2,
            head = new
            {
                headVersion = 2, kind = "native-publication-log-head", algorithm = ArticlePublicationProofPayloadV2.Algorithm,
                origin = head.Origin, sequence = DecimalSequence(head.Sequence), entrySha256 = Convert.ToHexStringLower(head.EntrySha256),
                keyId = head.KeyId, keyVersion = head.KeyVersion, keySha256 = Convert.ToHexStringLower(head.KeySha256),
                attestedAtUtc = ArticlePublicationProofPayloadV2.Time(head.AttestedAt), signature = CanonicalBase64Url(signature),
            },
            bridgeReceiptSha256 = Array.Empty<string>(),
            checkpoints = new[] { checkpoint },
        });

    private static async Task<RetainedDailyArchive?> ReadAutomaticArchive(SafeFileHandle directory, string name, string origin, string day,
        DateTime at, CancellationToken ct)
    {
        using var handle = NativeUnixFile.OpenFile(directory, name, NativeUnixFile.FileReadFlags, out var error);
        if (handle is null && error == NativeUnixFile.NotFound) return null;
        if (handle is null || !NativeUnixFile.IsRegular(handle, ReadOnlyOwner, owned: true))
            throw new IOException("The retained daily archive must be a regular file owned by the signer with mode 0400.");
        using var file = new FileStream(handle, FileAccess.Read);
        var bytes = await ReadBoundedArtifactAsync(file, DailyArchiveBytes, ct,
            static () => new IOException("Invalid retained daily archive size."),
            static () => new IOException("The retained daily archive changed while being read."));
        try
        {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { AllowDuplicateProperties = false, MaxDepth = 4 });
            var (head, headSignature) = ReadSignedCheckpointHead(document.RootElement.GetProperty("head"), origin);
            var checkpoints = document.RootElement.GetProperty("checkpoints");
            if (checkpoints.GetArrayLength() != 1 || head.AttestedAt > at ||
                checkpoints[0].GetProperty("scopeKey").GetString() != day) throw new FormatException();
            var signature = ReadCanonicalBase64Url(checkpoints[0].GetProperty("signature").GetString() ?? "", 86, 86);
            return new(bytes, head, headSignature, signature);
        }
        catch (Exception invalid) when (invalid is FormatException or KeyNotFoundException or InvalidOperationException or
                                        JsonException or ArgumentException)
        {
            throw new InvalidOperationException("The retained daily archive is invalid.");
        }
    }

    private static void WriteAutomaticArchive(string path, byte[] bytes, CancellationToken ct)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var pending = path + "." + Guid.NewGuid().ToString("N") + ".pending";
        using (var file = new FileStream(pending, new FileStreamOptions
        {
            Mode = FileMode.CreateNew, Access = FileAccess.Write, UnixCreateMode = ReadOnlyOwner,
        }))
        {
            try { file.Write(bytes); file.Flush(flushToDisk: true); }
            catch { File.Delete(pending); throw; }
        }
        try
        {
            ct.ThrowIfCancellationRequested();
            File.Move(pending, path, overwrite: false);
        }
        finally { File.Delete(pending); }
    }

    private sealed record RetainedDailyArchive(byte[] Bytes, PublicationTransparencyHeadV2 Head, byte[] HeadSignature,
        byte[] CheckpointSignature);
}
