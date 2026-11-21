using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Platform;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Cli
{
    private static async Task CreatePublicationCheckpointAsync(NpgsqlConnection db, string[] args, PublicationCheckpointKind kind,
        CancellationToken ct)
    {
        var daily = kind == PublicationCheckpointKind.Daily;
        var required = daily ? 4 : 6;
        if (args.Length < required || args.Length > required + 1)
            throw new ArgumentException("Supply the origin, trusted keys and signed head, then the checkpoint scope. Run --help for usage.");
        var day = default(DateOnly);
        if (daily ? !PublicationCheckpointV2.TryDay(args[3], out day) : !PublicationCheckpointV2.ValidScope(args[3]))
            throw new ArgumentException("Invalid native checkpoint scope.");
        var head = await ReadPublicationCheckpointHead(args[2], args[0], ct);
        var from = daily ? 0 : CheckpointSequence(args[4]);
        var to = daily ? 0 : CheckpointSequence(args[5]);
        long? inclusion = args.Length == required + 1 ? CheckpointSequence(args[required]) : null;
        var midnight = day.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        if (daily && (head.Claim.Sequence > PublicationCheckpointV2.MaxPrefixEntries || head.Claim.AttestedAt < midnight.AddDays(1)))
            throw new ArgumentException("The native daily checkpoint requires the full bounded prefix and a head from on or after the next UTC midnight.");
        if (!daily && (from > to || to > head.Claim.Sequence || to - from >= PublicationCheckpointV2.MaxLeaves ||
            head.Claim.Sequence - from >= PublicationCheckpointV2.MaxPrefixEntries ||
            (inclusion.HasValue && (inclusion.Value < from || inclusion.Value > to))))
            throw new ArgumentException("The checkpoint or inclusion range exceeds the pinned native prefix limits.");

        var (current, keys) = await ReadTransparencyKeysAsync(args[1], ct);
        try
        {
            var configuredCurrent = Environment.GetEnvironmentVariable("IntegrityProof__Signing__CurrentKeyId")?.Trim();
            if (configuredCurrent != current)
                throw new InvalidOperationException("The configured checkpoint signing key differs from the trusted registry's current key.");
            await CurrentSchema.VerifyAsync(db, ct);
            await using var tx = await BeginReadOnlyAsync(db, ct);
            await PrepareStoppedOperationAsync(db, tx, ct);
            if (await CurrentSchema.PublicationTransparencyStateAsync(db, tx, ct) is not true)
                throw new InvalidOperationException("Native publication transparency is inactive.");
            var headKey = await RequireCheckpointKey(db, tx, keys, head.Claim.KeyId, head.Claim.AttestedAt, ct);
            if (headKey.Version != head.Claim.KeyVersion || !headKey.Fingerprint.AsSpan().SequenceEqual(head.Claim.KeySha256) ||
                !headKey.PublicKey.VerifyData(head.Claim.Payload(), head.Signature, HashAlgorithmName.SHA256,
                    DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
                throw new InvalidOperationException("The independently retained native head signature is invalid.");

            var entries = daily ? await ReadDailyCheckpointEntries(db, tx, midnight, head.Claim, ct) :
                await ReadCheckpointRange(db, tx, from, to, head.Claim, ct);
            if (entries.Count == 0 && inclusion.HasValue)
                throw new ArgumentException("An empty native daily checkpoint cannot include a ledger entry.");
            var checkpoint = entries.Count == 0 ? (RootSha256: PublicationCheckpointTreeV2.EmptyDailyRoot(), Inclusion: (PublicationCheckpointWitness?)null) :
                PublicationCheckpointTreeV2.Build(entries, inclusion);
            await using var clock = new NpgsqlCommand("select clock_timestamp()", db, tx);
            if (await clock.ExecuteScalarAsync(ct) is not DateTime issued || issued < head.Claim.AttestedAt)
                throw new InvalidOperationException("The native checkpoint clock precedes its witnessed head.");
            var signer = await RequireCheckpointKey(db, tx, keys, current, issued, ct);
            using var key = NativePublicationSigningKey.Open(
                Environment.GetEnvironmentVariable("IntegrityProof__Signing__NativeV2PrivateKeyFile"),
                signer.PublicKey.ExportSubjectPublicKeyInfo());
            var claim = new PublicationCheckpointV2(args[0], args[3], entries.Count == 0 ? 0 : entries[0].Sequence,
                entries.Count == 0 ? 0 : entries[^1].Sequence, entries.Count, checkpoint.RootSha256, head.Claim.Sequence,
                head.Claim.EntrySha256, current, signer.Version, signer.Fingerprint, issued, kind);
            var signed = SignPublicationCheckpoint(claim, key);
            await tx.CommitAsync(ct);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                checkpoint = signed,
                inclusion = EncodeCheckpointInclusion(checkpoint.Inclusion, daily),
            }));
        }
        finally
        {
            foreach (var key in keys.Values) key.PublicKey.Dispose();
        }
    }

    private static object SignPublicationCheckpoint(PublicationCheckpointV2 claim, ECDsa key) =>
        EncodePublicationCheckpoint(claim, SignPublicationAttestation(claim.Payload(), key));

    private static object EncodePublicationCheckpoint(PublicationCheckpointV2 claim, byte[] signature) => new
    {
        checkpointVersion = 2, kind = "native-publication-checkpoint",
        checkpointKind = claim.Kind == PublicationCheckpointKind.Daily ? "daily" : "release",
        algorithm = ArticlePublicationProofPayloadV2.Algorithm, origin = claim.Origin, scopeKey = claim.ScopeKey,
        fromSequence = DecimalSequence(claim.FromSequence), toSequence = DecimalSequence(claim.ToSequence),
        entryCount = claim.EntryCount, rootSha256 = Convert.ToHexStringLower(claim.RootSha256),
        headSequence = DecimalSequence(claim.HeadSequence), headEntrySha256 = Convert.ToHexStringLower(claim.HeadEntrySha256),
        keyId = claim.KeyId, keyVersion = claim.KeyVersion, keySha256 = Convert.ToHexStringLower(claim.KeySha256),
        attestedAtUtc = ArticlePublicationProofPayloadV2.Time(claim.AttestedAt),
        signature = CanonicalBase64Url(signature),
    };

    private static byte[] SignPublicationAttestation(byte[] payload, ECDsa key) =>
        key.SignData(payload, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    private static object? EncodeCheckpointInclusion(PublicationCheckpointWitness? witness, bool daily)
    {
        if (witness is null) return null;
        var sequence = DecimalSequence(witness.Sequence);
        var siblings = witness.Siblings.Select(Convert.ToHexStringLower).ToArray();
        return daily ? new { sequence, position = witness.Position, entrySha256 = Convert.ToHexStringLower(witness.Entry.EntrySha256), siblings } :
            new { sequence, leafSha256 = Convert.ToHexStringLower(witness.LeafSha256), siblings };
    }

    private static async Task<(PublicationTransparencyHeadV2 Claim, byte[] Signature)> ReadPublicationCheckpointHead(string path,
        string origin, CancellationToken ct)
    {
        try
        {
            using var document = await ReadIntegrityJsonAsync(path, 4096, ct);
            return ReadSignedCheckpointHead(document.RootElement, origin);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or FormatException or
            InvalidOperationException or ArgumentException)
        {
            throw new InvalidOperationException("The supplied native signed head is malformed or belongs to a different origin.");
        }
    }

    private static (PublicationTransparencyHeadV2 Claim, byte[] Signature) ReadSignedCheckpointHead(JsonElement root, string origin)
    {
        string[] fields =
        [
            "headVersion", "kind", "algorithm", "origin", "sequence", "entrySha256",
            "keyId", "keyVersion", "keySha256", "attestedAtUtc", "signature",
        ];
        if (root.EnumerateObject().Count() != fields.Length || fields.Any(name => !root.TryGetProperty(name, out _)) ||
            root.GetProperty("headVersion").GetInt32() != 2 || root.GetProperty("kind").GetString() != "native-publication-log-head" ||
            root.GetProperty("algorithm").GetString() != ArticlePublicationProofPayloadV2.Algorithm ||
            root.GetProperty("origin").GetString() != origin)
            throw new FormatException();
        var claim = new PublicationTransparencyHeadV2(origin, CheckpointSequence(root.GetProperty("sequence").GetString() ?? ""),
            ReadCheckpointDigest(root, "entrySha256"), root.GetProperty("keyId").GetString() ?? "",
            root.GetProperty("keyVersion").GetInt32(), ReadCheckpointDigest(root, "keySha256"),
            TransparencyKeyTime(root, "attestedAtUtc") ?? throw new FormatException());
        _ = claim.Payload();
        var signature = ReadCanonicalBase64Url(root.GetProperty("signature").GetString() ?? "", 86, 86);
        if (signature.Length != 64) throw new FormatException();
        return (claim, signature);
    }

    private static async Task<TransparencyAuditKey> RequireCheckpointKey(NpgsqlConnection db, NpgsqlTransaction tx,
        IReadOnlyDictionary<string, TransparencyAuditKey> keys, string id, DateTimeOffset at, CancellationToken ct)
    {
        if (!keys.TryGetValue(id, out var key) || key.Compromised || at < key.Before || at > key.After ||
            (key.Revoked.HasValue && key.Revoked.Value <= at))
            throw UntrustedCheckpointKey();
        await using var command = new NpgsqlCommand("""
            select version,spki_sha256,not_before,not_after,revoked_at,compromised_at
            from public.publication_proof_key where key_id=$1
            """, db, tx);
        command.Parameters.AddWithValue(id);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct) || row.GetInt32(0) != key.Version || !key.Fingerprint.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(1)) ||
            key.Before != row.GetDateTime(2) || key.After != row.GetDateTime(3) || !row.IsDBNull(5) ||
            (!row.IsDBNull(4) && row.GetDateTime(4) <= at))
            throw UntrustedCheckpointKey();
        return key;
    }

    private static InvalidOperationException UntrustedCheckpointKey() =>
        new("A native checkpoint or head signing key is ineligible at its attested time.");

    private static async Task<List<PublicationCheckpointEntry>> ReadCheckpointRange(NpgsqlConnection db, NpgsqlTransaction tx, long from, long to,
        PublicationTransparencyHeadV2 head, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select seq,prev_sha256,receipt_sha256,entry_sha256
            from public.article_publication_transparency where seq between $1 and $2 order by seq
            """, db, tx);
        query.Parameters.AddWithValue(from);
        query.Parameters.AddWithValue(head.Sequence);
        await using var row = await query.ExecuteReaderAsync(ct);
        var selected = new List<PublicationCheckpointEntry>((int)(to - from + 1));
        var sequence = from - 1;
        byte[]? previous = from == 1 ? new byte[32] : null;
        while (await row.ReadAsync(ct))
        {
            if (row.GetInt64(0) != ++sequence) throw BadCheckpointPrefix();
            var predecessor = row.GetFieldValue<byte[]>(1);
            if (previous is not null && !previous.AsSpan().SequenceEqual(predecessor)) throw BadCheckpointPrefix();
            var value = PublicationTransparencyV2.EntryDigest(sequence, predecessor, row.GetFieldValue<byte[]>(2));
            if (!value.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(3))) throw BadCheckpointPrefix();
            if (sequence <= to) selected.Add(new(sequence, value));
            previous = value;
        }
        if (sequence != head.Sequence || previous is null || !previous.AsSpan().SequenceEqual(head.EntrySha256))
            throw BadCheckpointPrefix();
        return selected;
    }

    private static InvalidOperationException BadCheckpointPrefix() =>
        new("The requested range does not connect to the independently retained native head.");

    private static long CheckpointSequence(string raw)
    {
        if (!long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) ||
            sequence <= 0 || DecimalSequence(sequence) != raw)
            throw new ArgumentException("Native checkpoint sequences are positive decimal int64 coordinates.");
        return sequence;
    }

    private static byte[] ReadCheckpointDigest(JsonElement root, string name)
    {
        var value = root.GetProperty(name).GetString();
        return value is not null && AuditSha256(value) ? Convert.FromHexString(value) : throw new FormatException();
    }

    private static string DecimalSequence(long value) => value.ToString(CultureInfo.InvariantCulture);
}
