namespace FsusBlog.V2.Server.Content;

internal readonly record struct PublicationTransparency(long Sequence, byte[] Hash)
{
    internal static async Task<PublicationTransparency> ReadHead(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        await SqlCommands.QueryOneValue(db, tx, ct,
            "select seq,entry_sha256 from public.article_publication_transparency order by seq desc limit 1",
            row => new PublicationTransparency(row.GetInt64(0), row.GetFieldValue<byte[]>(1))) ?? new(0, new byte[32]);

    internal async Task<PublicationTransparency> Append(NpgsqlConnection db, NpgsqlTransaction tx, long sequence,
        long publication, byte[] transcript, byte[] signature, CancellationToken ct)
    {
        var receipt = PublicationTransparencyV2.ReceiptDigest(transcript, signature);
        var entry = PublicationTransparencyV2.EntryDigest(sequence, Hash, receipt);
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.article_publication_transparency(seq,publication_id,prev_sha256,receipt_sha256,entry_sha256)
            values($1,$2,$3,$4,$5)
            """, sequence, publication, Hash, receipt, entry);
        return new(sequence, entry);
    }
}

internal sealed record PublicationHeadAnchor(long Sequence, byte[] Hash)
{
    internal static PublicationHeadAnchor? Parse(string? value)
    {
        if (value is null) return null;
        if (value == "genesis") return new(0, new byte[32]);
        var separator = value.IndexOf(':');
        if (separator is > 0 and <= 19 && value.Length == separator + 65 &&
            long.TryParse(value.AsSpan(0, separator), NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) &&
            sequence > 0 && sequence.ToString(CultureInfo.InvariantCulture).AsSpan().SequenceEqual(value.AsSpan(0, separator)) &&
            value[(separator + 1)..].All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
            return new(sequence, Convert.FromHexString(value.AsSpan(separator + 1)));
        throw new InvalidOperationException("Public publication head anchor must be genesis or a positive sequence and lowercase SHA-256.");
    }
}

internal sealed class PublicationHead(PublicationProofKeys keys, PublicationHeadAnchor anchor)
{
    internal sealed record Snapshot(PublicationTransparency Tail, byte[] Signature, byte[]? Json)
    {
        internal bool Matches(PublicationTransparency other) =>
            Tail.Sequence == other.Sequence && Tail.Hash.AsSpan().SequenceEqual(other.Hash);
    }

    private Snapshot? _current;
    private (Snapshot Previous, Snapshot Candidate)? _pending;

    internal Snapshot? Current => Volatile.Read(ref _current);
    internal bool HasPendingCommit => _pending.HasValue;

    internal async Task<Snapshot?> Load(NpgsqlConnection db, NpgsqlTransaction tx, bool transparencyActive, CancellationToken ct)
    {
        if (!transparencyActive || !await CurrentSchema.HasPublicationHeadAsync(db, tx, ct)) return null;
        var tail = await PublicationTransparency.ReadHead(db, tx, ct);
        if (anchor.Sequence == 0 && tail.Sequence != 0) return null;
        var attestation = await ReadAttestation(db, tx, tail, ct);
        return attestation is null || (anchor.Sequence != 0 && !await VerifyPrefix(db, tx, tail, ct)) ? null : attestation;
    }

    internal void Publish(Snapshot? value) => Volatile.Write(ref _current, value);
    internal void Observe(PublicationTransparency tail) { if (Current is { } before && !before.Matches(tail)) Publish(null); }

    internal async Task<Snapshot?> Prepare(NpgsqlConnection db, NpgsqlTransaction tx, PublicationTransparency tail,
        DateTimeOffset issueTime, CancellationToken ct)
    {
        if (Current is not { } previous) return null;
        var key = keys.Current;
        if (!key.Allows(issueTime) || tail.Sequence <= previous.Tail.Sequence)
            throw new InvalidOperationException("Native head cannot attest a non-advancing publication ledger.");
        var claim = new PublicationTransparencyHeadV2(keys.Origin, tail.Sequence, tail.Hash, key.Id, key.Version, key.Fingerprint, issueTime);
        var signature = keys.Sign(claim.Payload());
        if (await SqlCommands.Execute(db, tx, ct, """
            insert into public.publication_transparency_head(singleton,seq,entry_sha256,origin,key_id,key_version,key_sha256,attested_at,signature)
            values(true,$1,$2,$3,$4,$5,$6,$7,$8)
            on conflict(singleton) do update set seq=excluded.seq,entry_sha256=excluded.entry_sha256,
              origin=excluded.origin,key_id=excluded.key_id,key_version=excluded.key_version,key_sha256=excluded.key_sha256,
              attested_at=excluded.attested_at,signature=excluded.signature
            where (publication_transparency_head.seq,publication_transparency_head.entry_sha256,publication_transparency_head.signature)=($9,$10,$11)
            """, tail.Sequence, tail.Hash, keys.Origin, key.Id, key.Version, key.Fingerprint, issueTime, signature,
            previous.Tail.Sequence, previous.Tail.Hash, previous.Signature) != 1)
            throw new InvalidOperationException("The durable publication head changed outside the configured writer.");
        return Encode(claim, signature);
    }

    internal void BeginCommit(Snapshot candidate)
    {
        _pending = (Current ?? throw new InvalidOperationException("The current publication head is unavailable."), candidate);
        Publish(null);
    }

    internal void CompleteCommit(Snapshot? value) { _pending = null; Publish(value); }

    internal async Task<Snapshot?> Recover(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        var pending = _pending ?? throw new InvalidOperationException("No publication head commit is pending.");
        var stored = await ReadAttestation(db, tx, await PublicationTransparency.ReadHead(db, tx, ct), ct);
        return stored is not null && (IsSame(stored, pending.Previous) || IsSame(stored, pending.Candidate)) ? stored : null;
    }

    private static bool IsSame(Snapshot observed, Snapshot expected) =>
        observed.Matches(expected.Tail) && observed.Signature.AsSpan().SequenceEqual(expected.Signature);

    private async Task<bool> VerifyPrefix(NpgsqlConnection db, NpgsqlTransaction tx, PublicationTransparency tail, CancellationToken ct)
    {
        if (anchor.Sequence > tail.Sequence) return false;
        await using var read = Store.Sql(db, tx, """
            select seq,prev_sha256,receipt_sha256,entry_sha256 from public.article_publication_transparency
            where seq between $1 and $2 order by seq
            """, anchor.Sequence, tail.Sequence);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct) || row.GetInt64(0) != anchor.Sequence ||
            !anchor.Hash.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(3))) return false;
        var sequence = anchor.Sequence;
        var hash = anchor.Hash;
        while (await row.ReadAsync(ct))
        {
            ++sequence;
            if (row.GetInt64(0) != sequence || !hash.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(1))) return false;
            hash = PublicationTransparencyV2.EntryDigest(sequence, hash, row.GetFieldValue<byte[]>(2));
            if (!hash.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(3))) return false;
        }
        return sequence == tail.Sequence && hash.AsSpan().SequenceEqual(tail.Hash);
    }

    private async Task<Snapshot?> ReadAttestation(NpgsqlConnection db, NpgsqlTransaction tx, PublicationTransparency tail, CancellationToken ct)
    {
        var found = false;
        Snapshot? result = null;
        await SqlCommands.ReadAll(db, tx, ct, """
            select h.seq,h.entry_sha256,h.origin,h.key_id,h.key_version,h.key_sha256,h.attested_at,h.signature,k.revoked_at,k.compromised_at
            from public.publication_transparency_head h join public.publication_proof_key k on k.key_id=h.key_id where h.singleton
            """, row =>
        {
            found = true;
            var claim = new PublicationTransparencyHeadV2(row.GetString(2), row.GetInt64(0), row.GetFieldValue<byte[]>(1),
                row.GetString(3), row.GetInt32(4), row.GetFieldValue<byte[]>(5), row.GetDateTime(6));
            if (claim.Sequence != tail.Sequence || !claim.EntrySha256.AsSpan().SequenceEqual(tail.Hash) || claim.Origin != keys.Origin ||
                !keys.Keys.TryGetValue(claim.KeyId, out var key) || key.Version != claim.KeyVersion ||
                !claim.KeySha256.AsSpan().SequenceEqual(key.Fingerprint) || !row.IsDBNull(9) ||
                (!row.IsDBNull(8) && claim.AttestedAt >= row.GetDateTime(8))) return;
            try
            {
                var signature = row.GetFieldValue<byte[]>(7);
                if (key.VerifySignature(claim.Payload(), claim.AttestedAt, signature)) result = Encode(claim, signature);
            }
            catch (Exception error) when (error is ArgumentException or CryptographicException) { }
        });
        return found ? result : tail.Sequence == 0 ? new(tail, [], null) : null;
    }

    private static Snapshot Encode(PublicationTransparencyHeadV2 claim, byte[] signature) =>
        new(new(claim.Sequence, claim.EntrySha256), signature, JsonSerializer.SerializeToUtf8Bytes(PublicationHeadJson.Project(claim, signature)));
}

internal sealed class PublicationProofs(NpgsqlDataSource db, InstanceLease lease, Publications publications, PublicationProofKeys keys,
    ILogger<PublicationProofs> log) : BackgroundService
{
    private const string Prefix = "/integrity/v2";
    private const string Limit = "publication-proof";
    private const string Json = "application/json; charset=utf-8";
    private readonly Uri _origin = new(keys.Origin);
    private readonly PublicationHead? _publicHead = keys.HeadAnchor is { } anchor ? new(keys, anchor) : null;
    private PublicSnapshot? _scan;
    private bool _transparency;
    private bool _complete;
    private long _after;

    internal static bool IsRoute(PathString path) => path.StartsWithSegments(Prefix);

    internal void Map(WebApplication app, PublicationCheckpointArchive? archive)
    {
        app.MapGet(Prefix + "/keys.json", (HttpContext ctx) =>
        {
            if (!PublicOrigin(ctx)) return Task.CompletedTask;
            lease.RequireCurrent();
            return PublicResponse.Write(ctx, keys.Manifest, Json);
        }).RequireRateLimiting(Limit);
        app.MapGet(Prefix + "/article/{articleId:int}/{publicationId:long}/rights.json",
            (HttpContext ctx, int articleId, long publicationId) => Read(ctx, articleId, publicationId)).RequireRateLimiting(Limit);
        if (_transparency && archive is not null)
            app.MapGet(Prefix + "/article/{articleId:int}/{publicationId:long}/daily-proof.json",
                (HttpContext ctx, int articleId, long publicationId) => Read(ctx, articleId, publicationId, archive)).RequireRateLimiting(Limit);
        if (_publicHead is { } head)
            app.MapGet(Prefix + "/log/head.json", (HttpContext ctx) => ReadHead(ctx, head)).RequireRateLimiting(Limit);
    }

    internal async Task Initialize(CancellationToken ct)
    {
        var loaded = await InstanceLease.RunProtected(db, lease, async (connection, tx) =>
        {
            if (!await CurrentSchema.HasPublicationProofAsync(connection, tx, ct))
                throw new InvalidOperationException("Native publication signing requires the offline publication-proof schema.");
            _transparency = await CurrentSchema.PublicationTransparencyStateAsync(connection, tx, ct) is true;
            if (await SqlCommands.Scalar(connection, tx, ct,
                "select exists (select from public.article_publication_proof where origin<>$1)", keys.Origin) is true)
                throw new InvalidOperationException("The configured signing origin differs from persisted native proofs.");
            await SqlCommands.ReadAll(connection, tx, ct, "select key_id from public.publication_proof_key", rows =>
            {
                if (!keys.Keys.ContainsKey(rows.GetString(0)))
                    throw new InvalidOperationException("Native publication signing requires all previously recorded public keys.");
            });
            foreach (var key in keys.Keys.Values)
                if (await SqlCommands.Execute(connection, tx, ct, """
                    insert into public.publication_proof_key(key_id,version,spki_sha256,not_before,not_after,revoked_at,compromised_at)
                    values($1,$2,$3,$4,$5,$6,$7)
                    on conflict(key_id) do update set revoked_at=coalesce(publication_proof_key.revoked_at,excluded.revoked_at),
                        compromised_at=coalesce(publication_proof_key.compromised_at,excluded.compromised_at)
                    where (publication_proof_key.version,publication_proof_key.spki_sha256,publication_proof_key.not_before,
                           publication_proof_key.not_after)=(excluded.version,excluded.spki_sha256,excluded.not_before,excluded.not_after)
                        and (publication_proof_key.revoked_at is null or publication_proof_key.revoked_at is not distinct from excluded.revoked_at)
                        and (publication_proof_key.compromised_at is null or publication_proof_key.compromised_at is not distinct from excluded.compromised_at)
                    """, key.Id, key.Version, key.Fingerprint, key.NotBefore, key.NotAfter,
                    SqlCommands.Optional(NpgsqlDbType.TimestampTz, key.Revoked), SqlCommands.Optional(NpgsqlDbType.TimestampTz, key.Compromised)) != 1)
                    throw new InvalidOperationException("An existing native publication signing key cannot be rebound or unrevoked.");
            return _publicHead is null ? null : await _publicHead.Load(connection, tx, _transparency, ct);
        }, ct);
        _publicHead?.Publish(loaded);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, lease.Stopped);
        using var delay = new PeriodicTimer(TimeSpan.FromSeconds(2));
        var ct = lifetime.Token;
        try
        {
            while (await delay.WaitForNextTickAsync(ct))
            {
                if (!lease.IsCurrent) return;
                try
                {
                    using var round = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    round.CancelAfter(TimeSpan.FromSeconds(1));
                    await publications.Attest(() => Mint(round.Token), round.Token);
                }
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    log.LogWarning("Native publication proof round failed ({ErrorType}).", error.GetType().Name);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }

    private async Task Mint(CancellationToken ct)
    {
        if (_publicHead is { HasPendingCommit: true } recovering)
            recovering.CompleteCommit(await InstanceLease.RunProtected(db, lease, (c, t) => recovering.Recover(c, t, ct), ct));
        var snapshot = publications.Snapshot;
        if (snapshot is null) return;
        if (!ReferenceEquals(snapshot, _scan)) { _scan = snapshot; _complete = false; _after = 0; }
        if (_complete) return;
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct);
        if (await SqlCommands.Scalar(connection, tx, ct, "select clock_timestamp()") is not DateTime at || !keys.Current.Allows(at)) return;
        var pending = await SqlCommands.QueryList(connection, tx, ct, """
            select c.article_id,c.revision,c.publication_id,c.publication_no,c.published_at,c.rights_snapshot_id,c.outbox_id,
                   c.content_sha256,c.policy_sha256,c.canonical_version
            from public.article_publication_canonical c
            join public.article_publication p on (p.article_id,p.revision,p.publication_id,p.publication_no,p.published_at)=
                (c.article_id,c.revision,c.publication_id,c.publication_no,c.published_at)
            join public.article a on a.id=p.article_id and a.published_revision=p.revision and not a.deleted
            join public.article_revision_rights w on (w.article_id,w.revision)=(p.article_id,p.revision)
            join public.blog_outbox o on o.id=c.outbox_id and o.processed_at is not null
            where c.publication_id>$1 and w.enabled and w.proof_binding_enabled
                and not exists (select from public.article_publication_proof e where e.publication_id=c.publication_id)
            order by c.publication_id limit 8
            """, Binding.Read, _after);
        if (pending.Count == 0) { _complete = true; return; }

        PublicationTransparency? head = null;
        DateTime lastIssued = default;
        foreach (var binding in pending)
        {
            if (!binding.Matches(snapshot.Article(binding.Article))) continue;
            var issued = (DateTime)(await SqlCommands.Scalar(connection, tx, ct, "select clock_timestamp()"))!;
            if (!keys.Current.Allows(issued) || issued < binding.PublishedAt) continue;
            var transcript = ArticlePublicationProofPayloadV2.Build(binding.Claim(keys.Origin, keys.Current, issued));
            var signature = keys.Sign(transcript);
            if (_transparency)
            {
                if (!head.HasValue) { head = await PublicationTransparency.ReadHead(connection, tx, ct); _publicHead?.Observe(head.Value); }
                var sequence = checked(head.Value.Sequence + 1);
                await SqlCommands.Execute(connection, tx, ct, """
                    insert into public.article_publication_proof(publication_id,origin,key_id,key_version,key_sha256,issued_at,signature,transparency_seq)
                    values($1,$2,$3,$4,$5,$6,$7,$8)
                    """, binding.Publication, keys.Origin, keys.Current.Id, keys.Current.Version, keys.Current.Fingerprint, issued, signature, sequence);
                head = await head.Value.Append(connection, tx, sequence, binding.Publication, transcript, signature, ct);
                lastIssued = issued;
            }
            else
                await SqlCommands.Execute(connection, tx, ct, """
                    insert into public.article_publication_proof(publication_id,origin,key_id,key_version,key_sha256,issued_at,signature)
                    values($1,$2,$3,$4,$5,$6,$7)
                    """, binding.Publication, keys.Origin, keys.Current.Id, keys.Current.Version, keys.Current.Fingerprint, issued, signature);
        }
        var sealedHead = head.HasValue && _publicHead is not null ? await _publicHead.Prepare(connection, tx, head.Value, lastIssued, ct) : null;
        if (sealedHead is not null) _publicHead!.BeginCommit(sealedHead);
        await InstanceLease.CommitProtected(tx, lease, ct);
        if (sealedHead is not null) _publicHead!.CompleteCommit(sealedHead);
        _after = pending[^1].Publication;
    }

    private Task ReadHead(HttpContext ctx, PublicationHead head)
    {
        if (!PublicOrigin(ctx)) return Task.CompletedTask;
        lease.RequireCurrent();
        var current = head.Current ?? throw new PublicUnavailableException();
        if (publications.Snapshot is null || !ReferenceEquals(current, head.Current)) throw new PublicUnavailableException();
        if (current.Json is { } bytes) return PublicResponse.Write(ctx, bytes, Json);
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return Task.CompletedTask;
    }

    private async Task Read(HttpContext ctx, int articleId, long publicationId, PublicationCheckpointArchive? archive = null)
    {
        if (!PublicOrigin(ctx)) return;
        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        var article = snapshot.Article(articleId);
        var bytes = article is { Rights.Policy: { Enabled: true, ProofBindingEnabled: true } } && article.Publication == publicationId
            ? await ReadVerified(article, archive, ctx.RequestAborted) : null;
        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        if (bytes is null) { ctx.Response.StatusCode = StatusCodes.Status404NotFound; return; }
        await PublicResponse.Write(ctx, bytes, Json);
    }

    private async Task<byte[]?> ReadVerified(Article article, PublicationCheckpointArchive? archive, CancellationToken request)
    {
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(request, lease.Stopped);
        bounded.CancelAfter(TimeSpan.FromSeconds(1));
        var ct = bounded.Token;
        try
        {
            await using var connection = await db.OpenConnectionAsync(ct);
            var ledgerFields = archive is null ? "" : ",l.seq,l.prev_sha256,l.receipt_sha256,l.entry_sha256";
            var ledgerJoin = archive is null ? "" : "join public.article_publication_transparency l on (l.seq,l.publication_id)=(e.transparency_seq,e.publication_id)";
            await using var command = Store.Sql(connection, null, $"""
                select c.article_id,c.revision,c.publication_id,c.publication_no,c.published_at,c.rights_snapshot_id,c.outbox_id,
                       c.content_sha256,c.policy_sha256,c.canonical_version,e.key_id,e.key_version,e.key_sha256,e.issued_at,e.signature{ledgerFields}
                from public.article_publication_canonical c join public.article_publication_proof e using(publication_id)
                {ledgerJoin}
                join public.publication_proof_key k on k.key_id=e.key_id
                join public.article_publication p on (p.article_id,p.revision,p.publication_id,p.publication_no,p.published_at)=
                    (c.article_id,c.revision,c.publication_id,c.publication_no,c.published_at)
                join public.article a on a.id=p.article_id and a.published_revision=p.revision and not a.deleted
                join public.blog_outbox o on o.id=c.outbox_id and o.processed_at is not null
                where c.publication_id=$1 and c.article_id=$2 and c.revision=$3 and c.rights_snapshot_id=$4 and e.origin=$5
                    and e.issued_at between k.not_before and k.not_after
                    and k.compromised_at is null and (k.revoked_at is null or e.issued_at<k.revoked_at)
                """, article.Publication, article.Id, article.Revision, article.Rights!.SnapshotId, keys.Origin);
            command.CommandTimeout = 1;
            await using var rows = await command.ExecuteReaderAsync(ct);
            if (!await rows.ReadAsync(ct)) return null;
            var binding = Binding.Read(rows);
            if (!keys.Keys.TryGetValue(rows.GetString(10), out var key) || !binding.Matches(article)) return null;
            var claim = binding.Claim(keys.Origin, key, rows.GetDateTime(13)) with
            {
                KeyVersion = rows.GetInt32(11), KeySha256 = rows.GetFieldValue<byte[]>(12)
            };
            var signature = rows.GetFieldValue<byte[]>(14);
            if (!key.Verify(claim, signature)) return null;
            if (archive is null) return Encode(claim, signature);

            var sequence = rows.GetInt64(15);
            var receipt = PublicationTransparencyV2.ReceiptDigest(ArticlePublicationProofPayloadV2.Build(claim), signature);
            if (!receipt.AsSpan().SequenceEqual(rows.GetFieldValue<byte[]>(17))) return null;
            var entry = PublicationTransparencyV2.EntryDigest(sequence, rows.GetFieldValue<byte[]>(16), receipt);
            return entry.AsSpan().SequenceEqual(rows.GetFieldValue<byte[]>(18)) ? archive.FindInclusion(claim.IssuedAt, sequence, entry) : null;
        }
        catch (OperationCanceledException) when (!request.IsCancellationRequested) { throw new PublicUnavailableException(); }
        catch (Exception error) when (error is ArgumentException or ProtocolException or CryptographicException) { return null; }
    }

    private bool PublicOrigin(HttpContext ctx)
    {
        if (ctx.Request.IsHttps && string.Equals(ctx.Request.Host.Value, _origin.Authority, StringComparison.OrdinalIgnoreCase)) return true;
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return false;
    }

    private static byte[] Encode(ArticlePublicationProofV2 claim, byte[] signature) => JsonSerializer.SerializeToUtf8Bytes(new
    {
        proofVersion = 2, canonicalVersion = claim.CanonicalVersion, algorithm = ArticlePublicationProofPayloadV2.Algorithm,
        origin = claim.Origin, articleId = claim.ArticleId, revision = Decimal(claim.Revision), publicationId = Decimal(claim.PublicationId),
        publicationNo = claim.PublicationNo, publishedAtUtc = ArticlePublicationProofPayloadV2.Time(claim.PublishedAt),
        rightsSnapshotId = Decimal(claim.RightsSnapshotId), publicationOutboxId = Decimal(claim.OutboxId),
        contentSha256 = Convert.ToHexStringLower(claim.ContentSha256), policySha256 = Convert.ToHexStringLower(claim.PolicySha256),
        keyId = claim.KeyId, keyVersion = claim.KeyVersion, keySha256 = Convert.ToHexStringLower(claim.KeySha256),
        issuedAtUtc = ArticlePublicationProofPayloadV2.Time(claim.IssuedAt), signature = WebEncoders.Base64UrlEncode(signature),
    });

    private static string Decimal(long value) => value.ToString(CultureInfo.InvariantCulture);

    private sealed record Binding(int Article, long Revision, long Publication, int Number, DateTime PublishedAt, long Rules,
        long Outbox, byte[] Content, byte[] Policy, int Version)
    {
        internal static Binding Read(NpgsqlDataReader row) => new(row.GetInt32(0), row.GetInt64(1), row.GetInt64(2), row.GetInt32(3),
            row.GetDateTime(4), row.GetInt64(5), row.GetInt64(6), row.GetFieldValue<byte[]>(7), row.GetFieldValue<byte[]>(8), row.GetInt32(9));

        internal bool Matches(Article? article)
        {
            if (article is not { Rights: { Policy: { Enabled: true, ProofBindingEnabled: true } policy } rights } ||
                (article.Id, article.Revision, article.Publication, article.PublicationNo, article.PublishedAt, rights.SnapshotId) !=
                (Article, Revision, Publication, Number, (DateTimeOffset)PublishedAt, Rules)) return false;
            var cover = article.CoverMediaDigest is { } digest ? Convert.FromHexString(digest) : null;
            if (Version != (cover is null ? 2 : 3)) return false;
            var content = ArticleCanonicalHashesV2.ContentDigest(new(Article, Revision, article.Title, article.Body, article.Category?.Id,
                article.Tags?.Select(tag => tag.Id).ToArray() ?? [], cover));
            return content.AsSpan().SequenceEqual(Content) && ArticleCanonicalHashesV2.PolicyDigest(policy, content).AsSpan().SequenceEqual(Policy);
        }

        internal ArticlePublicationProofV2 Claim(string origin, ProofPublicKey key, DateTime issued) =>
            new(origin, Article, Revision, Publication, Number, PublishedAt, Rules, Outbox, Content, Policy, key.Id, key.Version,
                key.Fingerprint, issued, Version);
    }
}
