using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task EnablePublicationTransparencyAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var active = await CurrentSchema.PublicationTransparencyStateAsync(connection, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requirePublicationProof: true, requirePublicationTransparency: active.HasValue);
        if (active is null)
        {
            await ApplySchemaAddition(connection, tx, "zzzz-publication-transparency.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requirePublicationProof: true, requirePublicationTransparency: true);
        }
        if (active is not true)
        {
            await using var old = new NpgsqlCommand("select exists(select from public.article_publication_proof)", connection, tx);
            if (await old.ExecuteScalarAsync(ct) is true)
                throw new InvalidOperationException("Enable publication transparency before any native proof has been issued. No historical receipt was changed.");
            await ExecuteAsync(connection, tx, "alter table public.article_publication_proof alter column transparency_seq set not null", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requirePublicationProof: true, requirePublicationTransparency: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Native publication transparency is active.");
    }

    private static async Task VerifyPublicationTransparencyAsync(NpgsqlConnection connection, string origin, string keyPath, string[] pin,
        CancellationToken ct)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var site) || site.Scheme != Uri.UriSchemeHttps ||
            site.UserInfo.Length != 0 || origin.Length > 256 || site.GetLeftPart(UriPartial.Authority) != origin)
            throw new ArgumentException("Supply the exact HTTPS signing origin.");
        var genesis = new byte[32];
        long? prefix = null;
        byte[]? expected = null;
        if (pin.Length != 0)
        {
            if (pin.Length != 2 || !long.TryParse(pin[0], NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) ||
                sequence <= 0 || sequence.ToString(CultureInfo.InvariantCulture) != pin[0] || !AuditSha256(pin[1]))
                throw new ArgumentException("Supply a positive prefix sequence and a lowercase SHA-256 digest.");
            prefix = sequence;
            expected = Convert.FromHexString(pin[1]);
        }

        var (_, keys) = await ReadTransparencyKeysAsync(keyPath, ct);
        try
        {
            await CurrentSchema.VerifyAsync(connection, ct);
            await using var tx = await BeginReadOnlyAsync(connection, ct);
            if (await CurrentSchema.PublicationTransparencyStateAsync(connection, tx, ct) is not true)
                throw new InvalidOperationException("Native publication transparency is inactive.");

            long sequence = 0, trusted = 0, retired = 0, revoked = 0, compromised = 0;
            var head = genesis;
            byte[]? observed = null;
            await using (var query = new NpgsqlCommand("""
                select l.seq,l.prev_sha256,l.receipt_sha256,l.entry_sha256,
                       p.origin,c.article_id,c.revision,p.publication_id,c.publication_no,c.published_at,c.rights_snapshot_id,
                       c.outbox_id,c.content_sha256,c.policy_sha256,p.key_id,p.key_version,p.key_sha256,p.issued_at,p.signature,
                       k.not_before,k.not_after,k.revoked_at,k.compromised_at,o.processed_at is not null
                from public.article_publication_transparency l
                join public.article_publication_proof p on (p.transparency_seq,p.publication_id)=(l.seq,l.publication_id)
                join public.article_publication_canonical c on c.publication_id=p.publication_id
                join public.publication_proof_key k on k.key_id=p.key_id
                join public.blog_outbox o on o.id=c.outbox_id
                order by l.seq
                """, connection, tx))
            await using (var rows = await query.ExecuteReaderAsync(ct))
            {
                while (await rows.ReadAsync(ct))
                {
                    sequence = checked(sequence + 1);
                    var claim = new ArticlePublicationProofV2(rows.GetString(4), rows.GetInt32(5), rows.GetInt64(6), rows.GetInt64(7), rows.GetInt32(8),
                        rows.GetDateTime(9), rows.GetInt64(10), rows.GetInt64(11), rows.GetFieldValue<byte[]>(12), rows.GetFieldValue<byte[]>(13),
                        rows.GetString(14), rows.GetInt32(15), rows.GetFieldValue<byte[]>(16), rows.GetDateTime(17));
                    if (rows.GetInt64(0) != sequence || !head.AsSpan().SequenceEqual(rows.GetFieldValue<byte[]>(1)) ||
                        claim.Origin != origin || !rows.GetBoolean(23))
                        throw InvalidTransparencyEntry(sequence);
                    var transcript = ArticlePublicationProofPayloadV2.Build(claim);
                    var signature = rows.GetFieldValue<byte[]>(18);
                    var receipt = PublicationTransparencyV2.ReceiptDigest(transcript, signature);
                    head = PublicationTransparencyV2.EntryDigest(sequence, head, receipt);
                    if (!receipt.AsSpan().SequenceEqual(rows.GetFieldValue<byte[]>(2)) ||
                        !head.AsSpan().SequenceEqual(rows.GetFieldValue<byte[]>(3)))
                        throw InvalidTransparencyEntry(sequence);
                    if (!keys.TryGetValue(claim.KeyId, out var key) || key.Version != claim.KeyVersion ||
                        !key.Fingerprint.AsSpan().SequenceEqual(claim.KeySha256) || key.Before != rows.GetDateTime(19) ||
                        key.After != rows.GetDateTime(20) || claim.IssuedAt < key.Before || claim.IssuedAt > key.After ||
                        !key.PublicKey.VerifyData(transcript, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
                        throw new InvalidOperationException($"Native publication transparency signature or key mismatch at sequence {sequence}.");
                    if (key.Compromised || !rows.IsDBNull(22)) compromised++;
                    else
                    {
                        DateTimeOffset? databaseRevoked = rows.IsDBNull(21) ? null : rows.GetDateTime(21);
                        if ((key.Revoked.HasValue && claim.IssuedAt >= key.Revoked.Value) ||
                            (databaseRevoked.HasValue && claim.IssuedAt >= databaseRevoked.Value)) revoked++;
                        else
                        {
                            trusted++;
                            if (key.Revoked.HasValue || databaseRevoked.HasValue) retired++;
                        }
                    }
                    if (prefix == sequence) observed = head;
                }
            }
            await using var count = new NpgsqlCommand("select count(*) from public.article_publication_proof", connection, tx);
            if (await count.ExecuteScalarAsync(ct) is not long retained || retained != sequence)
                throw new InvalidOperationException("The native issuance ledger does not cover every retained proof.");
            if (expected is not null && (observed is null || !observed.AsSpan().SequenceEqual(expected)))
                throw new InvalidOperationException("The supplied native issuance ledger prefix was not found or changed.");
            await tx.CommitAsync(ct);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                version = 2, kind = "native-publication-transparency", origin,
                sequence = sequence.ToString(CultureInfo.InvariantCulture),
                entrySha256 = Convert.ToHexStringLower(head), chainVerified = true, prefixVerified = expected is not null,
                trustStatus = sequence == 0 ? "empty" : revoked + compromised == 0 ? "trusted" : "withheld",
                trustedSignatures = trusted, retiredEligibleSignatures = retired,
                revokedSignatures = revoked, compromisedSignatures = compromised,
            }));
        }
        finally
        {
            foreach (var key in keys.Values) key.PublicKey.Dispose();
        }
    }

    private static InvalidOperationException InvalidTransparencyEntry(long sequence) =>
        new($"Native publication transparency chain failed at sequence {sequence}.");

    private static async Task<(string Current, Dictionary<string, TransparencyAuditKey> Keys)> ReadTransparencyKeysAsync(string path,
        CancellationToken ct)
    {
        var keys = new Dictionary<string, TransparencyAuditKey>(StringComparer.Ordinal);
        try
        {
            using var document = await ReadIntegrityJsonAsync(path, 65_536, ct);
            var root = document.RootElement;
            var entries = root.GetProperty("keys");
            if (root.GetProperty("manifestVersion").GetInt32() != 2 ||
                root.GetProperty("kind").GetString() != "native-publication-proof-keys" ||
                root.GetProperty("algorithm").GetString() != ArticlePublicationProofPayloadV2.Algorithm ||
                entries.GetArrayLength() is < 1 or > 64)
                throw new FormatException();
            foreach (var entry in entries.EnumerateArray())
            {
                var id = entry.GetProperty("keyId").GetString();
                var version = entry.GetProperty("keyVersion").GetInt32();
                if (id is null || !ArticlePublicationProofPayloadV2.ValidKeyId(id) || version <= 0 || keys.ContainsKey(id))
                    throw new FormatException();
                var spki = entry.GetProperty("publicKey").GetString() ?? throw new FormatException();
                var der = ReadCanonicalBase64Url(spki, 32, 256);
                var fingerprint = SHA256.HashData(der);
                var before = TransparencyKeyTime(entry, "notBeforeUtc") ?? throw new FormatException();
                var after = TransparencyKeyTime(entry, "notAfterUtc") ?? throw new FormatException();
                var revoked = TransparencyKeyTime(entry, "revokedAtUtc");
                var compromised = TransparencyKeyTime(entry, "compromisedAtUtc").HasValue;
                if (after < before || entry.GetProperty("keySha256").GetString() != Convert.ToHexStringLower(fingerprint))
                    throw new FormatException();
                var publicKey = ECDsa.Create();
                try
                {
                    publicKey.ImportSubjectPublicKeyInfo(der, out var read);
                    if (read != der.Length || publicKey.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7")
                        throw new FormatException();
                    keys.Add(id, new(version, fingerprint, publicKey, before, after, revoked, compromised));
                }
                catch
                {
                    publicKey.Dispose();
                    throw;
                }
            }
            if (root.GetProperty("currentKeyId").GetString() is not { } current || !keys.ContainsKey(current))
                throw new FormatException();
            return (current, keys);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or FormatException or
            CryptographicException or KeyNotFoundException or InvalidOperationException or ArgumentException)
        {
            foreach (var key in keys.Values) key.PublicKey.Dispose();
            throw new InvalidOperationException("The supplied native publication public key manifest is invalid.");
        }
    }

    private static async Task<JsonDocument> ReadIntegrityJsonAsync(string path, int maximumBytes, CancellationToken ct)
    {
        await using var file = File.OpenRead(path);
        if (file.Length < 1 || file.Length > maximumBytes) throw new FormatException();
        var bytes = new byte[(int)file.Length];
        await file.ReadExactlyAsync(bytes, ct);
        if (file.ReadByte() != -1) throw new FormatException();
        return JsonDocument.Parse(bytes, new JsonDocumentOptions { AllowDuplicateProperties = false });
    }

    private static byte[] ReadCanonicalBase64Url(string value, int minimumCharacters, int maximumCharacters)
    {
        if (value.Length < minimumCharacters || value.Length > maximumCharacters) throw new FormatException();
        var bytes = Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/').PadRight((value.Length + 3) / 4 * 4, '='));
        if (CanonicalBase64Url(bytes) != value) throw new FormatException();
        return bytes;
    }

    private static string CanonicalBase64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static DateTimeOffset? TransparencyKeyTime(JsonElement entry, string field)
    {
        var value = entry.GetProperty(field).GetString();
        if (value is null) return null;
        if (!DateTimeOffset.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var instant))
            throw new FormatException();
        return instant;
    }

    private static bool AuditSha256(string value) => value.Length == 64 &&
        value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    private sealed record TransparencyAuditKey(int Version, byte[] Fingerprint, ECDsa PublicKey, DateTimeOffset Before, DateTimeOffset After,
        DateTimeOffset? Revoked, bool Compromised);
}
