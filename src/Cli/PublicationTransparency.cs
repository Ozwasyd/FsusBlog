using System.Buffers.Text;
using Microsoft.Win32.SafeHandles;

internal static partial class Cli
{
    private const int DailyArchiveBytes = 4096;
    private const UnixFileMode PrivateDirectory = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode ReadOnlyOwner = UnixFileMode.UserRead;

    private static async Task EnablePublicationTransparencyAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await BeginStoppedOperationAsync(connection, ct);
        var active = await CurrentSchema.PublicationTransparencyStateAsync(connection, tx, ct);
        if (active is null) throw new InvalidOperationException("Native publication transparency storage is not installed.");
        var transparencyCatalog = new CatalogVerificationOptions { Publication = new() { Proof = true, Transparency = true } };
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, transparencyCatalog);
        if (active is not true)
        {
            if (await ScalarAsync(connection, tx, "select exists(select from public.article_publication_proof)", ct) is true)
                throw new InvalidOperationException("Enable publication transparency before any native proof has been issued. No historical receipt was changed.");
            await ExecuteAsync(connection, tx, "alter table public.article_publication_proof alter column transparency_seq set not null", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, transparencyCatalog);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Native publication transparency is active.");
    }

    private static async Task VerifyPublicationTransparencyAsync(NpgsqlConnection connection, string origin, string keyPath, string[] pin, CancellationToken ct)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var site) || site.Scheme != Uri.UriSchemeHttps ||
            site.UserInfo.Length != 0 || origin.Length > 256 || site.GetLeftPart(UriPartial.Authority) != origin)
            throw new ArgumentException("Supply the exact HTTPS signing origin.");
        long? prefix = null;
        byte[]? expected = null;
        if (pin.Length != 0)
        {
            if (pin.Length != 2 || !long.TryParse(pin[0], NumberStyles.None, CultureInfo.InvariantCulture, out var seq) ||
                seq <= 0 || DecimalSequence(seq) != pin[0] || !AuditSha256(pin[1]))
                throw new ArgumentException("Supply a positive prefix sequence and a lowercase SHA-256 digest.");
            prefix = seq;
            expected = Convert.FromHexString(pin[1]);
        }

        var (_, keys) = await ReadTransparencyKeysAsync(keyPath, ct);
        using (keys)
        {
            await CurrentSchema.VerifyAsync(connection, ct);
            await using var tx = await BeginReadOnlyAsync(connection, ct);
            if (await CurrentSchema.PublicationTransparencyStateAsync(connection, tx, ct) is not true)
                throw new InvalidOperationException("Native publication transparency is inactive.");

            long sequence = 0, trusted = 0, retired = 0, revoked = 0, compromised = 0;
            var head = new byte[32];
            byte[]? observed = null;
            await ReadAllAsync(connection, tx, """
                select l.seq,l.prev_sha256,l.receipt_sha256,l.entry_sha256,
                       p.origin,c.article_id,c.revision,p.publication_id,c.publication_no,c.published_at,c.rights_snapshot_id,
                       c.outbox_id,c.content_sha256,c.policy_sha256,p.key_id,p.key_version,p.key_sha256,p.issued_at,p.signature,
                       c.canonical_version,k.not_before,k.not_after,k.revoked_at,k.compromised_at,o.processed_at is not null
                from public.article_publication_transparency l
                join public.article_publication_proof p on (p.transparency_seq,p.publication_id)=(l.seq,l.publication_id)
                join public.article_publication_canonical c on c.publication_id=p.publication_id
                join public.publication_proof_key k on k.key_id=p.key_id
                join public.blog_outbox o on o.id=c.outbox_id order by l.seq
                """, rows =>
            {
                sequence = checked(sequence + 1);
                var claim = ReadNativeLedgerClaim(rows);
                if (rows.GetInt64(0) != sequence || !head.AsSpan().SequenceEqual(rows.GetFieldValue<byte[]>(1)) ||
                    claim.Origin != origin || !rows.GetBoolean(24))
                    throw InvalidTransparencyEntry(sequence);
                var transcript = ArticlePublicationProofPayloadV2.Build(claim);
                var signature = rows.GetFieldValue<byte[]>(18);
                var receipt = PublicationTransparencyV2.ReceiptDigest(transcript, signature);
                head = PublicationTransparencyV2.EntryDigest(sequence, head, receipt);
                if (!receipt.AsSpan().SequenceEqual(rows.GetFieldValue<byte[]>(2)) || !head.AsSpan().SequenceEqual(rows.GetFieldValue<byte[]>(3)))
                    throw InvalidTransparencyEntry(sequence);
                if (!keys.TryGetValue(claim.KeyId, out var key) || key.Version != claim.KeyVersion ||
                    !key.Fingerprint.AsSpan().SequenceEqual(claim.KeySha256) || key.Before != rows.GetDateTime(20) ||
                    key.After != rows.GetDateTime(21) || claim.IssuedAt < key.Before || claim.IssuedAt > key.After ||
                    !key.PublicKey.VerifyData(transcript, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
                    throw new InvalidOperationException($"Native publication transparency signature or key mismatch at sequence {sequence}.");
                if (key.Compromised || !rows.IsDBNull(23)) compromised++;
                else
                {
                    DateTimeOffset? databaseRevoked = rows.IsDBNull(22) ? null : rows.GetDateTime(22);
                    if ((key.Revoked.HasValue && claim.IssuedAt >= key.Revoked.Value) ||
                        (databaseRevoked.HasValue && claim.IssuedAt >= databaseRevoked.Value)) revoked++;
                    else { trusted++; if (key.Revoked.HasValue || databaseRevoked.HasValue) retired++; }
                }
                if (prefix == sequence) observed = head;
            }, ct);
            if (await ScalarAsync(connection, tx, "select count(*) from public.article_publication_proof", ct) is not long retained || retained != sequence)
                throw new InvalidOperationException("The native issuance ledger does not cover every retained proof.");
            if (expected is not null && (observed is null || !observed.AsSpan().SequenceEqual(expected)))
                throw new InvalidOperationException("The supplied native issuance ledger prefix was not found or changed.");
            await tx.CommitAsync(ct);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                version = 2, kind = "native-publication-transparency", origin, sequence = DecimalSequence(sequence),
                entrySha256 = Convert.ToHexStringLower(head), chainVerified = true, prefixVerified = expected is not null,
                trustStatus = sequence == 0 ? "empty" : revoked + compromised == 0 ? "trusted" : "withheld",
                trustedSignatures = trusted, retiredEligibleSignatures = retired, revokedSignatures = revoked, compromisedSignatures = compromised,
            }));
        }
    }

    private static async Task CreatePublicationCheckpointAsync(NpgsqlConnection db, string[] args, PublicationCheckpointKind kind, CancellationToken ct)
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
        using (keys)
        {
            if (Environment.GetEnvironmentVariable("IntegrityProof__Signing__CurrentKeyId")?.Trim() != current)
                throw new InvalidOperationException("The configured checkpoint signing key differs from the trusted registry's current key.");
            await CurrentSchema.VerifyAsync(db, ct);
            await using var tx = await BeginReadOnlyAsync(db, ct);
            await PrepareStoppedOperationAsync(db, tx, ct);
            if (await CurrentSchema.PublicationTransparencyStateAsync(db, tx, ct) is not true)
                throw new InvalidOperationException("Native publication transparency is inactive.");
            await VerifyCheckpointHead(db, tx, keys, head.Claim, head.Signature,
                static () => new InvalidOperationException("The independently retained native head signature is invalid."), ct);

            var entries = daily ? await ReadDailyCheckpointEntries(db, tx, midnight, head.Claim, ct) :
                await ReadCheckpointRange(db, tx, from, to, head.Claim, ct);
            if (entries.Count == 0 && inclusion.HasValue)
                throw new ArgumentException("An empty native daily checkpoint cannot include a ledger entry.");
            var checkpoint = entries.Count == 0
                ? (RootSha256: PublicationCheckpointTreeV2.EmptyDailyRoot(), Inclusion: (PublicationCheckpointWitness?)null)
                : PublicationCheckpointTreeV2.Build(entries, inclusion);
            if (await ScalarAsync(db, tx, "select clock_timestamp()", ct) is not DateTime issued || issued < head.Claim.AttestedAt)
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
            Console.WriteLine(JsonSerializer.Serialize(new { checkpoint = signed, inclusion = EncodeCheckpointInclusion(checkpoint.Inclusion, daily) }));
        }
    }

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
        using (keys)
        {
            if (signerId is null || !keys.TryGetValue(signerId, out var standaloneKey) || signerId == current ||
                standaloneKey.Fingerprint.AsSpan().SequenceEqual(keys[current].Fingerprint))
                throw new InvalidOperationException("Automatic daily checkpoints require a separately registered checkpoint signing key.");

            await using var tx = await BeginReadOnlyAsync(db, ct);
            if (await ScalarAsync(db, tx, "select transaction_timestamp() where not pg_is_in_recovery()", ct) is not DateTime at)
                throw new InvalidOperationException("Automatic daily checkpoints require a live PostgreSQL primary.");

            var scope = args.Length == 6 ? args[5] : DateOnly.FromDateTime(at.AddDays(-1)).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            if (!PublicationCheckpointV2.TryDay(scope, out var day)) throw new ArgumentException("Supply a UTC day in YYYY-MM-DD format.");
            var midnight = day.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
            if (midnight.AddDays(1) > at) throw new InvalidOperationException("The requested UTC day is still open.");
            await CurrentSchema.VerifyPublicationCheckpointSchemaAsync(db, tx, ct);
            var latest = await QueryRequiredAsync(db, tx, """
                select h.seq,h.entry_sha256,h.origin,h.key_id,h.key_version,h.key_sha256,h.attested_at,h.signature
                from public.publication_transparency_head h
                join (select seq,entry_sha256 from public.article_publication_transparency order by seq desc limit 1) tail
                  on (h.seq,h.entry_sha256)=(tail.seq,tail.entry_sha256) where h.singleton
                """, row => row.GetInt64(0) > PublicationCheckpointV2.MaxPrefixEntries || row.GetString(2) != args[0] || row.GetDateTime(6) > at
                    ? throw new InvalidOperationException("The native log has no eligible exact signed tail at this database snapshot.")
                    : (Claim: new PublicationTransparencyHeadV2(args[0], row.GetInt64(0), row.GetFieldValue<byte[]>(1), row.GetString(3),
                        row.GetInt32(4), row.GetFieldValue<byte[]>(5), row.GetDateTime(6)), Signature: row.GetFieldValue<byte[]>(7)),
                static () => new InvalidOperationException("The native log has no eligible exact signed tail at this database snapshot."), ct);
            await VerifyCheckpointHead(db, tx, keys, latest.Claim, latest.Signature, BadCheckpointPrefix, ct);
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
                if (await ScalarAsync(db, tx, "select clock_timestamp()", ct) is not DateTime completed || completed < at)
                    throw new InvalidOperationException("The database clock moved back during daily checkpoint issuance.");
                using var key = NativePublicationSigningKey.Open(
                    Environment.GetEnvironmentVariable("IntegrityProof__CheckpointSigning__PrivateKeyFile"),
                    signer.PublicKey.ExportSubjectPublicKeyInfo());
                bytes = EncodeAutomaticArchive(head, SignPublicationAttestation(head.Payload(), key), SignPublicationCheckpoint(claim, key));
            }
            else
            {
                var key = await VerifyCheckpointHead(db, tx, keys, head, retained.HeadSignature, BadCheckpointPrefix, ct);
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
    }

    private static async Task<List<PublicationCheckpointEntry>> ReadDailyCheckpointEntries(NpgsqlConnection db,
        NpgsqlTransaction tx, DateTime utcMidnight, PublicationTransparencyHeadV2 head, CancellationToken ct,
        (long Sequence, byte[] Hash)? anchor = null, PublicationTransparencyHeadV2? selectedHead = null, DateTime? observedAt = null)
    {
        var until = utcMidnight.AddDays(1);
        long sequence = 0;
        var previous = new byte[32];
        var selected = new List<PublicationCheckpointEntry>();
        selectedHead ??= head;
        var anchored = anchor is null;
        if (selectedHead.Sequence > head.Sequence) throw BadCheckpointPrefix();
        await ReadAllAsync(db, tx, """
            select l.seq,l.prev_sha256,l.receipt_sha256,l.entry_sha256,
                   p.origin,c.article_id,c.revision,p.publication_id,c.publication_no,c.published_at,c.rights_snapshot_id,
                   c.outbox_id,c.content_sha256,c.policy_sha256,p.key_id,p.key_version,p.key_sha256,p.issued_at,p.signature,
                   c.canonical_version,o.processed_at is not null
            from public.article_publication_transparency l
            join public.article_publication_proof p on (p.transparency_seq,p.publication_id)=(l.seq,l.publication_id)
            join public.article_publication_canonical c on c.publication_id=p.publication_id
            join public.blog_outbox o on o.id=c.outbox_id where l.seq <= $1 order by l.seq
            """, row =>
        {
            if (row.GetInt64(0) != ++sequence || !previous.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(1)) || !row.GetBoolean(20))
                throw BadCheckpointPrefix();
            var claim = ReadNativeLedgerClaim(row);
            if (claim.Origin != head.Origin || (observedAt.HasValue && claim.IssuedAt > observedAt.Value)) throw BadCheckpointPrefix();
            var receipt = PublicationTransparencyV2.ReceiptDigest(ArticlePublicationProofPayloadV2.Build(claim), row.GetFieldValue<byte[]>(18));
            if (!receipt.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(2))) throw BadCheckpointPrefix();
            var entry = PublicationTransparencyV2.EntryDigest(sequence, previous, receipt);
            if (!entry.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(3))) throw BadCheckpointPrefix();
            if (anchor is { } pin && sequence == pin.Sequence) anchored = entry.AsSpan().SequenceEqual(pin.Hash);
            if (sequence == selectedHead.Sequence && !entry.AsSpan().SequenceEqual(selectedHead.EntrySha256)) throw BadCheckpointPrefix();
            if (sequence <= selectedHead.Sequence && claim.IssuedAt >= utcMidnight && claim.IssuedAt < until)
            {
                if (selected.Count == PublicationCheckpointV2.MaxLeaves)
                    throw new InvalidOperationException("The selected UTC day exceeds the native checkpoint entry limit.");
                selected.Add(new(sequence, entry));
            }
            previous = entry;
        }, ct, head.Sequence);
        if (!anchored || sequence != head.Sequence || !previous.AsSpan().SequenceEqual(head.EntrySha256)) throw BadCheckpointPrefix();
        return selected;
    }

    private static async Task<List<PublicationCheckpointEntry>> ReadCheckpointRange(NpgsqlConnection db, NpgsqlTransaction tx, long from, long to,
        PublicationTransparencyHeadV2 head, CancellationToken ct)
    {
        var selected = new List<PublicationCheckpointEntry>((int)(to - from + 1));
        var sequence = from - 1;
        byte[]? previous = from == 1 ? new byte[32] : null;
        await ReadAllAsync(db, tx, """
            select seq,prev_sha256,receipt_sha256,entry_sha256 from public.article_publication_transparency where seq between $1 and $2 order by seq
            """, row =>
        {
            if (row.GetInt64(0) != ++sequence) throw BadCheckpointPrefix();
            var predecessor = row.GetFieldValue<byte[]>(1);
            if (previous is not null && !previous.AsSpan().SequenceEqual(predecessor)) throw BadCheckpointPrefix();
            var value = PublicationTransparencyV2.EntryDigest(sequence, predecessor, row.GetFieldValue<byte[]>(2));
            if (!value.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(3))) throw BadCheckpointPrefix();
            if (sequence <= to) selected.Add(new(sequence, value));
            previous = value;
        }, ct, from, head.Sequence);
        if (sequence != head.Sequence || previous is null || !previous.AsSpan().SequenceEqual(head.EntrySha256)) throw BadCheckpointPrefix();
        return selected;
    }

    private static async Task<TransparencyAuditKey> RequireCheckpointKey(NpgsqlConnection db, NpgsqlTransaction tx,
        IReadOnlyDictionary<string, TransparencyAuditKey> keys, string id, DateTimeOffset at, CancellationToken ct)
    {
        if (!keys.TryGetValue(id, out var key) || key.Compromised || at < key.Before || at > key.After ||
            (key.Revoked.HasValue && key.Revoked.Value <= at)) throw UntrustedCheckpointKey();
        return await QueryRequiredAsync(db, tx, """
            select version,spki_sha256,not_before,not_after,revoked_at,compromised_at from public.publication_proof_key where key_id=$1
            """, row => row.GetInt32(0) != key.Version || !key.Fingerprint.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(1)) ||
                key.Before != row.GetDateTime(2) || key.After != row.GetDateTime(3) || !row.IsDBNull(5) ||
                (!row.IsDBNull(4) && row.GetDateTime(4) <= at) ? throw UntrustedCheckpointKey() : key,
            UntrustedCheckpointKey, ct, id);
    }

    private static async Task<TransparencyAuditKey> VerifyCheckpointHead(NpgsqlConnection db, NpgsqlTransaction tx,
        IReadOnlyDictionary<string, TransparencyAuditKey> keys, PublicationTransparencyHeadV2 head, byte[] signature,
        Func<InvalidOperationException> invalidSignature, CancellationToken ct)
    {
        var key = await RequireCheckpointKey(db, tx, keys, head.KeyId, head.AttestedAt, ct);
        if (key.Version != head.KeyVersion || !key.Fingerprint.AsSpan().SequenceEqual(head.KeySha256) ||
            !VerifyPublicationAttestation(key, head.Payload(), signature)) throw invalidSignature();
        return key;
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
        attestedAtUtc = ArticlePublicationProofPayloadV2.Time(claim.AttestedAt), signature = Base64Url.EncodeToString(signature),
    };

    private static byte[] SignPublicationAttestation(byte[] payload, ECDsa key) =>
        key.SignData(payload, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    private static bool VerifyPublicationAttestation(TransparencyAuditKey key, byte[] payload, byte[] signature) =>
        signature.Length == 64 && key.PublicKey.VerifyData(payload, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    private static object? EncodeCheckpointInclusion(PublicationCheckpointWitness? witness, bool daily)
    {
        if (witness is null) return null;
        var sequence = DecimalSequence(witness.Sequence);
        var siblings = witness.Siblings.Select(Convert.ToHexStringLower).ToArray();
        return daily ? new { sequence, position = witness.Position, entrySha256 = Convert.ToHexStringLower(witness.Entry.EntrySha256), siblings } :
            new { sequence, leafSha256 = Convert.ToHexStringLower(witness.LeafSha256), siblings };
    }

    private static async Task<(PublicationTransparencyHeadV2 Claim, byte[] Signature)> ReadPublicationCheckpointHead(string path, string origin, CancellationToken ct)
    {
        try
        {
            using var document = await ReadIntegrityJsonAsync(path, 4096, ct);
            return ReadSignedCheckpointHead(document.RootElement, origin);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or FormatException or InvalidOperationException or ArgumentException)
        { throw new InvalidOperationException("The supplied native signed head is malformed or belongs to a different origin."); }
    }

    private static (PublicationTransparencyHeadV2 Claim, byte[] Signature) ReadSignedCheckpointHead(JsonElement root, string origin)
    {
        string[] fields = ["headVersion", "kind", "algorithm", "origin", "sequence", "entrySha256", "keyId", "keyVersion", "keySha256", "attestedAtUtc", "signature"];
        if (root.EnumerateObject().Count() != fields.Length || fields.Any(name => !root.TryGetProperty(name, out _)) ||
            root.GetProperty("headVersion").GetInt32() != 2 || root.GetProperty("kind").GetString() != "native-publication-log-head" ||
            root.GetProperty("algorithm").GetString() != ArticlePublicationProofPayloadV2.Algorithm || root.GetProperty("origin").GetString() != origin)
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

    private static byte[] EncodeAutomaticArchive(PublicationTransparencyHeadV2 head, byte[] signature, object checkpoint) =>
        JsonSerializer.SerializeToUtf8Bytes(new
        {
            archiveVersion = 2, head = PublicationHeadJson.Project(head, signature),
            bridgeReceiptSha256 = Array.Empty<string>(), checkpoints = new[] { checkpoint },
        });

    private static async Task<RetainedDailyArchive?> ReadAutomaticArchive(SafeFileHandle directory, string name, string origin, string day, DateTime at, CancellationToken ct)
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
            if (checkpoints.GetArrayLength() != 1 || head.AttestedAt > at || checkpoints[0].GetProperty("scopeKey").GetString() != day)
                throw new FormatException();
            var signature = ReadCanonicalBase64Url(checkpoints[0].GetProperty("signature").GetString() ?? "", 86, 86);
            return new(bytes, head, headSignature, signature);
        }
        catch (Exception invalid) when (invalid is FormatException or KeyNotFoundException or InvalidOperationException or JsonException or ArgumentException)
        { throw new InvalidOperationException("The retained daily archive is invalid."); }
    }

    private static void WriteAutomaticArchive(string path, byte[] bytes, CancellationToken ct)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var pending = path + "." + Guid.NewGuid().ToString("N") + ".pending";
        using (var file = new FileStream(pending, new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, UnixCreateMode = ReadOnlyOwner }))
        {
            try { file.Write(bytes); file.Flush(flushToDisk: true); }
            catch { File.Delete(pending); throw; }
        }
        try { ct.ThrowIfCancellationRequested(); File.Move(pending, path, overwrite: false); }
        finally { File.Delete(pending); }
    }

    private static async Task<(string Current, TransparencyKeys Keys)> ReadTransparencyKeysAsync(string path, CancellationToken ct)
    {
        var keys = new TransparencyKeys();
        try
        {
            using var document = await ReadIntegrityJsonAsync(path, 65_536, ct);
            var root = document.RootElement;
            var entries = root.GetProperty("keys");
            if (root.GetProperty("manifestVersion").GetInt32() != 2 || root.GetProperty("kind").GetString() != "native-publication-proof-keys" ||
                root.GetProperty("algorithm").GetString() != ArticlePublicationProofPayloadV2.Algorithm || entries.GetArrayLength() is < 1 or > 64)
                throw new FormatException();
            foreach (var entry in entries.EnumerateArray())
            {
                var id = entry.GetProperty("keyId").GetString();
                var version = entry.GetProperty("keyVersion").GetInt32();
                if (id is null || !ArticlePublicationProofPayloadV2.ValidKeyId(id) || version <= 0 || keys.ContainsKey(id)) throw new FormatException();
                var der = ReadCanonicalBase64Url(entry.GetProperty("publicKey").GetString() ?? throw new FormatException(), 32, 256);
                var fingerprint = SHA256.HashData(der);
                var before = TransparencyKeyTime(entry, "notBeforeUtc") ?? throw new FormatException();
                var after = TransparencyKeyTime(entry, "notAfterUtc") ?? throw new FormatException();
                var revoked = TransparencyKeyTime(entry, "revokedAtUtc");
                var compromised = TransparencyKeyTime(entry, "compromisedAtUtc").HasValue;
                if (after < before || entry.GetProperty("keySha256").GetString() != Convert.ToHexStringLower(fingerprint)) throw new FormatException();
                var publicKey = ECDsa.Create();
                try
                {
                    publicKey.ImportSubjectPublicKeyInfo(der, out var read);
                    if (read != der.Length || publicKey.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7") throw new FormatException();
                    keys.Add(id, new(version, fingerprint, publicKey, before, after, revoked, compromised));
                }
                catch { publicKey.Dispose(); throw; }
            }
            if (root.GetProperty("currentKeyId").GetString() is not { } current || !keys.ContainsKey(current)) throw new FormatException();
            return (current, keys);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or FormatException or
            CryptographicException or KeyNotFoundException or InvalidOperationException or ArgumentException)
        {
            keys.Dispose();
            throw new InvalidOperationException("The supplied native publication public key manifest is invalid.");
        }
    }

    private static async Task<JsonDocument> ReadIntegrityJsonAsync(string path, int maximumBytes, CancellationToken ct)
    {
        await using var file = File.OpenRead(path);
        var bytes = await ReadBoundedArtifactAsync(file, maximumBytes, ct, static () => new FormatException(), static () => new FormatException());
        return JsonDocument.Parse(bytes, new JsonDocumentOptions { AllowDuplicateProperties = false });
    }

    private static byte[] ReadCanonicalBase64Url(string value, int minimumCharacters, int maximumCharacters)
    {
        if (value.Length < minimumCharacters || value.Length > maximumCharacters) throw new FormatException();
        var bytes = Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/').PadRight((value.Length + 3) / 4 * 4, '='));
        if (Base64Url.EncodeToString(bytes) != value) throw new FormatException();
        return bytes;
    }

    private static DateTimeOffset? TransparencyKeyTime(JsonElement entry, string field) =>
        entry.GetProperty(field).GetString() is not { } value ? null
        : DateTimeOffset.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var instant) ? instant : throw new FormatException();

    private static ArticlePublicationProofV2 ReadNativeLedgerClaim(NpgsqlDataReader row) =>
        new(row.GetString(4), row.GetInt32(5), row.GetInt64(6), row.GetInt64(7), row.GetInt32(8),
            row.GetDateTime(9), row.GetInt64(10), row.GetInt64(11), row.GetFieldValue<byte[]>(12), row.GetFieldValue<byte[]>(13),
            row.GetString(14), row.GetInt32(15), row.GetFieldValue<byte[]>(16), row.GetDateTime(17), row.GetInt32(19));

    private static long CheckpointSequence(string raw) =>
        long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) && sequence > 0 && DecimalSequence(sequence) == raw
            ? sequence : throw new ArgumentException("Native checkpoint sequences are positive decimal int64 coordinates.");

    private static byte[] ReadCheckpointDigest(JsonElement root, string name) =>
        root.GetProperty(name).GetString() is { } value && AuditSha256(value) ? Convert.FromHexString(value) : throw new FormatException();

    private static bool AuditSha256(string value) => value.Length == 64 && value.All(char.IsAsciiHexDigitLower);
    private static string DecimalSequence(long value) => value.ToString(CultureInfo.InvariantCulture);
    private static InvalidOperationException InvalidTransparencyEntry(long sequence) => new($"Native publication transparency chain failed at sequence {sequence}.");
    private static InvalidOperationException UntrustedCheckpointKey() => new("A native checkpoint or head signing key is ineligible at its attested time.");
    private static InvalidOperationException BadCheckpointPrefix() => new("The requested range does not connect to the independently retained native head.");

    private sealed class TransparencyKeys() : Dictionary<string, TransparencyAuditKey>(StringComparer.Ordinal), IDisposable
    {
        public void Dispose() { foreach (var key in Values) key.PublicKey.Dispose(); }
    }

    private sealed record TransparencyAuditKey(int Version, byte[] Fingerprint, ECDsa PublicKey, DateTimeOffset Before, DateTimeOffset After, DateTimeOffset? Revoked, bool Compromised);
    private sealed record RetainedDailyArchive(byte[] Bytes, PublicationTransparencyHeadV2 Head, byte[] HeadSignature, byte[] CheckpointSignature);
}
