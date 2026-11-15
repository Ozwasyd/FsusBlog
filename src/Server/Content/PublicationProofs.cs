using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Content;

internal sealed class PublicationProofs(NpgsqlDataSource db, InstanceLease lease, Publications publications, PublicationProofKeys keys,
    ILogger<PublicationProofs> log) : BackgroundService
{
    private const string Prefix = "/integrity/v2";
    private const string Limit = "publication-proof";
    private const string Json = "application/json; charset=utf-8";
    private readonly Uri _origin = new(keys.Origin);
    private PublicSnapshot? _scan;
    private bool _transparency;
    private bool _complete;
    private long _after;

    internal static bool IsRoute(PathString path) => path.StartsWithSegments(Prefix);

    internal void Map(WebApplication app)
    {
        app.MapGet(Prefix + "/keys.json", (HttpContext ctx) =>
        {
            if (!PublicOrigin(ctx)) return Task.CompletedTask;
            lease.RequireCurrent();
            return PublicResponse.Write(ctx, keys.Manifest, Json);
        }).RequireRateLimiting(Limit);
        app.MapGet(Prefix + "/article/{articleId:int}/{publicationId:long}/rights.json",
            (HttpContext ctx, int articleId, long publicationId) => Read(ctx, articleId, publicationId)).RequireRateLimiting(Limit);
    }

    internal async Task Initialize(CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct);
        if (!await CurrentSchema.HasPublicationProofAsync(connection, tx, ct))
            throw new InvalidOperationException("Native publication signing requires the offline publication-proof schema.");
        _transparency = await CurrentSchema.PublicationTransparencyStateAsync(connection, tx, ct) is true;
        await using (var command = Store.Sql(connection, tx, """
            select exists (select from public.article_publication_proof where origin<>$1)
            """, keys.Origin))
            if (await command.ExecuteScalarAsync(ct) is true)
                throw new InvalidOperationException("The configured signing origin differs from persisted native proofs.");
        await using (var command = Store.Sql(connection, tx, "select key_id from public.publication_proof_key"))
        await using (var rows = await command.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct))
                if (!keys.Keys.ContainsKey(rows.GetString(0)))
                    throw new InvalidOperationException("Native publication signing requires all previously recorded public keys.");

        foreach (var key in keys.Keys.Values)
        {
            await using var command = Store.Sql(connection, tx, """
                insert into public.publication_proof_key(key_id,version,spki_sha256,not_before,not_after,revoked_at,compromised_at)
                values($1,$2,$3,$4,$5,$6,$7)
                on conflict(key_id) do update set revoked_at=coalesce(publication_proof_key.revoked_at,excluded.revoked_at),
                    compromised_at=coalesce(publication_proof_key.compromised_at,excluded.compromised_at)
                where (publication_proof_key.version,publication_proof_key.spki_sha256,publication_proof_key.not_before,
                       publication_proof_key.not_after)=(excluded.version,excluded.spki_sha256,excluded.not_before,excluded.not_after)
                    and (publication_proof_key.revoked_at is null or publication_proof_key.revoked_at is not distinct from excluded.revoked_at)
                    and (publication_proof_key.compromised_at is null or publication_proof_key.compromised_at is not distinct from excluded.compromised_at)
                """, key.Id, key.Version, key.Fingerprint, key.NotBefore, key.NotAfter, Timestamp(key.Revoked), Timestamp(key.Compromised));
            if (await command.ExecuteNonQueryAsync(ct) != 1)
                throw new InvalidOperationException("An existing native publication signing key cannot be rebound or unrevoked.");
        }
        await InstanceLease.CommitProtected(tx, lease, ct);
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
        var snapshot = publications.Snapshot;
        if (snapshot is null) return;
        if (!ReferenceEquals(snapshot, _scan)) { _scan = snapshot; _complete = false; _after = 0; }
        if (_complete) return;
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct);
        await using (var clock = Store.Sql(connection, tx, "select clock_timestamp()"))
            if (await clock.ExecuteScalarAsync(ct) is not DateTime at || !keys.Current.Allows(at)) return;
        var pending = new List<Binding>(8);
        await using (var command = Store.Sql(connection, tx, """
            select c.article_id,c.revision,c.publication_id,c.publication_no,c.published_at,c.rights_snapshot_id,c.outbox_id,
                   c.content_sha256,c.policy_sha256
            from public.article_publication_canonical c
            join public.article_publication p on (p.article_id,p.revision,p.publication_id,p.publication_no,p.published_at)=
                (c.article_id,c.revision,c.publication_id,c.publication_no,c.published_at)
            join public.article a on a.id=p.article_id and a.published_revision=p.revision and not a.deleted
            join public.article_revision_rights w on (w.article_id,w.revision)=(p.article_id,p.revision)
            join public.blog_outbox o on o.id=c.outbox_id and o.processed_at is not null
            where c.publication_id>$1 and w.enabled and w.proof_binding_enabled
                and not exists (select from public.article_publication_proof e where e.publication_id=c.publication_id)
            order by c.publication_id limit 8
            """, _after))
        await using (var rows = await command.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct)) pending.Add(Binding.Read(rows));
        if (pending.Count == 0) { _complete = true; return; }

        PublicationTransparency? head = null;
        foreach (var binding in pending)
        {
            if (!binding.Matches(snapshot.Article(binding.Article))) continue;
            await using var clock = Store.Sql(connection, tx, "select clock_timestamp()");
            var issued = (DateTime)(await clock.ExecuteScalarAsync(ct))!;
            if (!keys.Current.Allows(issued) || issued < binding.PublishedAt) continue;
            var claim = binding.Claim(keys.Origin, keys.Current, issued);
            var transcript = ArticlePublicationProofPayloadV2.Build(claim);
            var signature = keys.Sign(transcript);
            if (_transparency)
            {
                head ??= await PublicationTransparency.ReadHead(connection, tx, ct);
                var sequence = checked(head.Value.Sequence + 1);
                await using var insert = Store.Sql(connection, tx, """
                    insert into public.article_publication_proof(publication_id,origin,key_id,key_version,key_sha256,issued_at,signature,transparency_seq)
                    values($1,$2,$3,$4,$5,$6,$7,$8)
                    """, binding.Publication, keys.Origin, keys.Current.Id, keys.Current.Version, keys.Current.Fingerprint, issued, signature, sequence);
                await insert.ExecuteNonQueryAsync(ct);
                head = await head.Value.Append(connection, tx, sequence, binding.Publication, transcript, signature, ct);
            }
            else
            {
                await using var insert = Store.Sql(connection, tx, """
                    insert into public.article_publication_proof(publication_id,origin,key_id,key_version,key_sha256,issued_at,signature)
                    values($1,$2,$3,$4,$5,$6,$7)
                    """, binding.Publication, keys.Origin, keys.Current.Id, keys.Current.Version, keys.Current.Fingerprint, issued, signature);
                await insert.ExecuteNonQueryAsync(ct);
            }
        }
        await InstanceLease.CommitProtected(tx, lease, ct);
        _after = pending[^1].Publication;
    }

    private async Task Read(HttpContext ctx, int articleId, long publicationId)
    {
        if (!PublicOrigin(ctx)) return;
        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        var article = snapshot.Article(articleId);
        var bytes = article is { Rights.Policy: { Enabled: true, ProofBindingEnabled: true } } && article.Publication == publicationId
            ? await ReadVerified(article, ctx.RequestAborted) : null;
        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        if (bytes is null) { ctx.Response.StatusCode = StatusCodes.Status404NotFound; return; }
        await PublicResponse.Write(ctx, bytes, Json);
    }

    private async Task<byte[]?> ReadVerified(Article article, CancellationToken request)
    {
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(request, lease.Stopped);
        bounded.CancelAfter(TimeSpan.FromSeconds(1));
        var ct = bounded.Token;
        try
        {
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var command = Store.Sql(connection, null, """
                select c.article_id,c.revision,c.publication_id,c.publication_no,c.published_at,c.rights_snapshot_id,c.outbox_id,
                       c.content_sha256,c.policy_sha256,e.key_id,e.key_version,e.key_sha256,e.issued_at,e.signature
                from public.article_publication_canonical c join public.article_publication_proof e using(publication_id)
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
            if (!keys.Keys.TryGetValue(rows.GetString(9), out var key) || !binding.Matches(article)) return null;
            var claim = binding.Claim(keys.Origin, key, rows.GetDateTime(12)) with
            {
                KeyVersion = rows.GetInt32(10), KeySha256 = rows.GetFieldValue<byte[]>(11)
            };
            var signature = rows.GetFieldValue<byte[]>(13);
            return key.Verify(claim, signature) ? Encode(claim, signature) : null;
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
        proofVersion = 2, canonicalVersion = 2, algorithm = ArticlePublicationProofPayloadV2.Algorithm,
        origin = claim.Origin, articleId = claim.ArticleId, revision = Decimal(claim.Revision), publicationId = Decimal(claim.PublicationId),
        publicationNo = claim.PublicationNo, publishedAtUtc = ArticlePublicationProofPayloadV2.Time(claim.PublishedAt),
        rightsSnapshotId = Decimal(claim.RightsSnapshotId), publicationOutboxId = Decimal(claim.OutboxId),
        contentSha256 = Convert.ToHexStringLower(claim.ContentSha256), policySha256 = Convert.ToHexStringLower(claim.PolicySha256),
        keyId = claim.KeyId, keyVersion = claim.KeyVersion, keySha256 = Convert.ToHexStringLower(claim.KeySha256),
        issuedAtUtc = ArticlePublicationProofPayloadV2.Time(claim.IssuedAt), signature = WebEncoders.Base64UrlEncode(signature),
    });

    private static string Decimal(long value) => value.ToString(CultureInfo.InvariantCulture);
    private static NpgsqlParameter Timestamp(DateTimeOffset? value) => new() { NpgsqlDbType = NpgsqlDbType.TimestampTz, Value = (object?)value ?? DBNull.Value };

    private sealed record Binding(int Article, long Revision, long Publication, int Number, DateTime PublishedAt, long Rules,
        long Outbox, byte[] Content, byte[] Policy)
    {
        internal static Binding Read(NpgsqlDataReader row) => new(row.GetInt32(0), row.GetInt64(1), row.GetInt64(2), row.GetInt32(3),
            row.GetDateTime(4), row.GetInt64(5), row.GetInt64(6), row.GetFieldValue<byte[]>(7), row.GetFieldValue<byte[]>(8));

        internal bool Matches(Article? article)
        {
            if (article is not { Rights: { Policy: { Enabled: true, ProofBindingEnabled: true } policy } rights } ||
                (article.Id, article.Revision, article.Publication, article.PublicationNo, article.PublishedAt, rights.SnapshotId) !=
                (Article, Revision, Publication, Number, (DateTimeOffset)PublishedAt, Rules)) return false;
            var content = ArticleCanonicalHashesV2.ContentDigest(new(Article, Revision, article.Title, article.Body, article.Category?.Id,
                article.Tags?.Select(tag => tag.Id).ToArray() ?? []));
            return content.AsSpan().SequenceEqual(Content) && ArticleCanonicalHashesV2.PolicyDigest(policy, content).AsSpan().SequenceEqual(Policy);
        }

        internal ArticlePublicationProofV2 Claim(string origin, ProofPublicKey key, DateTime issued) =>
            new(origin, Article, Revision, Publication, Number, PublishedAt, Rules, Outbox, Content, Policy, key.Id, key.Version,
                key.Fingerprint, issued);
    }
}
