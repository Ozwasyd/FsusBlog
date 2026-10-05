using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;

using Microsoft.Extensions.DependencyInjection;

using StackExchange.Redis;

namespace FsusBlog.Server.Services.Fixtures;

public sealed record PublicContentVerificationIdentity(
    string RunId, string Namespace, string ProfileId, string SourceCommit,
    string SourceFingerprint, string VariantPlanDigest);

public sealed record PublicContentVerificationProof(string Payload, string Digest);

public sealed record PublicContentVerificationRequest(
    PublicContentVerificationIdentity Identity, PublicContentVerificationProof Proof);

public sealed record PublicContentVerificationResult(
    bool Ok, PublicContentVerificationIdentity Identity, string ProofDigest,
    PublicContentObservations Observations,
    IReadOnlyList<PublicContentEntityIdentity> EntityIdentities);

internal sealed record PublicContentVerificationSnapshot(
    PublicContentVerificationIdentity Identity, PublicContentFixtureResult Result,
    IReadOnlyList<CanonicalArticlePublicationReceipt> Publications,
    IReadOnlyList<CanonicalArticleLifecycleReceipt> Lifecycles);

/// <summary>Read-only, prepare-bound verification in the existing public fixture owner.</summary>
public sealed partial class PublicContentFixtureSeeder
{
    private readonly List<CanonicalArticlePublicationReceipt> _verificationPublicationReceipts = [];
    private readonly List<CanonicalArticleLifecycleReceipt> _verificationLifecycleReceipts = [];

    public void ValidateVerificationIdentity(PublicContentVerificationIdentity identity)
    {
        string? runtimeFingerprint = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_SOURCE_FINGERPRINT");
        if (runtimeFingerprint is not null && !runtimeFingerprint.StartsWith("sha256:", StringComparison.Ordinal))
        {
            runtimeFingerprint = "sha256:" + runtimeFingerprint;
        }
        if (new[] { identity.RunId, identity.Namespace, identity.ProfileId,
                identity.SourceCommit, identity.SourceFingerprint, identity.VariantPlanDigest }
            .Any(string.IsNullOrWhiteSpace)
            || identity.SourceCommit != Environment.GetEnvironmentVariable("FSUSBLOG_TEST_SOURCE_COMMIT")
            || identity.SourceFingerprint != runtimeFingerprint)
        {
            throw new InvalidOperationException("public fixture current source identity mismatch");
        }
    }

    public PublicContentVerificationProof IssueVerificationProof(
        PublicContentVerificationIdentity identity, PublicContentFixtureResult result)
    {
        ValidateVerificationIdentity(identity);
        string payload = JsonSerializer.Serialize(new PublicContentVerificationSnapshot(
            identity, result, _verificationPublicationReceipts.ToArray(),
            _verificationLifecycleReceipts.ToArray()), s_json);
        return new(payload, ComputeVerificationMac(payload, VerificationKey()));
    }

    private string VerificationKey()
        => configuration["fsus:localPublicContentFixtureSecret"]
            ?? configuration["fsus:localAuthFixtureSecret"]
            ?? throw new InvalidOperationException("public fixture verification key missing");

    internal static string ComputeVerificationMac(string payload, string key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            throw new InvalidOperationException("public fixture verification key missing");
        }
        return Convert.ToHexString(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();
    }

    internal static PublicContentVerificationSnapshot OpenVerificationProof(
        PublicContentVerificationRequest request, string key)
    {
        if (request.Proof is null || string.IsNullOrEmpty(request.Proof.Payload)
            || request.Proof.Payload.Length > 4 * 1024 * 1024
            || request.Proof.Digest is null || request.Proof.Digest.Length != 64
            || !CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(request.Proof.Digest),
                Encoding.UTF8.GetBytes(ComputeVerificationMac(request.Proof.Payload, key))))
        {
            throw new InvalidOperationException("public fixture verification proof invalid");
        }
        PublicContentVerificationSnapshot snapshot = JsonSerializer.Deserialize<PublicContentVerificationSnapshot>(
            request.Proof.Payload, s_json)
            ?? throw new InvalidOperationException("public fixture verification snapshot missing");
        if (snapshot.Identity != request.Identity)
        {
            throw new InvalidOperationException("public fixture run/profile/source/variant identity mismatch");
        }
        return snapshot;
    }

    private async Task<long> ReadVerificationGenerationAsync(CancellationToken cancellationToken, bool allowAbsent = false)
    {
        string key = serviceProvider.GetRequiredService<ICacheKeyResolver>()
            .BuildKey(CachePolicyId.ArticleListVersion, "main");
        string? value = await serviceProvider.GetRequiredService<IRedisOperationExecutor>()
            .ExecuteAsync(RedisOperationPort.ArticleServiceCache,
                async (connection, _) => (string?)await connection.GetDatabase().StringGetAsync(key).ConfigureAwait(false),
                cancellationToken).ConfigureAwait(false);
        if (value is null && allowAbsent)
        {
            return 0;
        }
        if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long generation)
            || generation < 0)
        {
            throw new InvalidOperationException("public fixture cache generation unavailable");
        }
        return generation;
    }

    private Task<RedisValue[]> ReadVerificationHotSeedAsync(CancellationToken cancellationToken)
    {
        string key = serviceProvider.GetRequiredService<IRuntimeKeyScope>().PrefixKey("blog:top_articles");
        return serviceProvider.GetRequiredService<IRedisOperationExecutor>()
            .ExecuteAsync(RedisOperationPort.ArticleServiceCache,
                (connection, _) => connection.GetDatabase().SortedSetRangeByRankAsync(key, 0, 4, Order.Descending),
                cancellationToken);
    }

    public async Task<PublicContentVerificationResult> VerifyAsync(
        PublicContentVerificationRequest request, CancellationToken cancellationToken = default)
    {
        ValidateVerificationIdentity(request.Identity);
        PublicContentVerificationSnapshot snapshot = OpenVerificationProof(request, VerificationKey());
        PublicContentFixtureResult expected = snapshot.Result;
        string runToken = new(request.Identity.RunId.Where(static ch =>
            char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_').Take(24).ToArray());
        string ownerPrefix = $"fxpc:{request.Identity.Namespace}:{runToken}";
        if (expected.Mode == "public-empty")
        {
            int ownedRows = await db.Queryable<Article>().ClearFilter()
                .Where(item => item.Title.StartsWith(ownerPrefix + ":")).CountAsync(cancellationToken).ConfigureAwait(false);
            int categories = await db.Queryable<Category>().Where(item => item.Name.StartsWith(ownerPrefix + ":"))
                .CountAsync(cancellationToken).ConfigureAwait(false);
            int tags = await db.Queryable<Tag>().Where(item => item.Name.StartsWith(ownerPrefix + ":"))
                .CountAsync(cancellationToken).ConfigureAwait(false);
            if (ownedRows != 0 || categories != 0 || tags != 0)
            {
                throw new InvalidOperationException("public-empty owned database drift");
            }
        }
        foreach (CanonicalArticlePublicationReceipt publication in snapshot.Publications)
        {
            (await CanonicalArticlePublicationVerifier.VerifyAsync(db, publication, cancellationToken)
                .ConfigureAwait(false)).ThrowIfInvalid();
        }
        foreach (CanonicalArticleLifecycleReceipt lifecycle in snapshot.Lifecycles)
        {
            (await CanonicalArticleLifecycleVerifier.VerifyAsync(db, configuration, lifecycle, cancellationToken)
                .ConfigureAwait(false)).ThrowIfInvalid();
        }

        var entities = new List<PublicContentObservedEntity>();
        foreach (PublicContentObservedEntity original in expected.Observations.Database?.Entities ?? [])
        {
            cancellationToken.ThrowIfCancellationRequested();
            Dictionary<string, object?> fields = new(original.Fields);
            if (original.Kind == "article")
            {
                int id = int.Parse(original.Id, CultureInfo.InvariantCulture);
                Article row = await LoadArticleAsync(id, cancellationToken).ConfigureAwait(false)
                    ?? throw new InvalidOperationException($"owned article {id} missing");
                if (!row.Title.StartsWith(ownerPrefix + ":", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("public fixture owned article identity mismatch");
                }
                fields["status"] = row.Status.ToString().ToLowerInvariant();
                fields["deleted"] = row.IsDeleted;
                fields["isDeleted"] = row.IsDeleted;
                fields["currentPublicationId"] = row.CurrentPublicationId;
                fields["currentRevisionId"] = row.CurrentRevisionId;
                fields["revisionIds"] = (await LoadRevisionIdsAsync(id, cancellationToken).ConfigureAwait(false))
                    .Select(static value => value.ToString(CultureInfo.InvariantCulture)).ToArray();
                ArticlePublicationRecord? publication = row.CurrentPublicationId is { } publicationId
                    ? await db.Queryable<ArticlePublicationRecord>().Where(item => item.Id == publicationId && item.ArticleId == id)
                        .FirstAsync(cancellationToken).ConfigureAwait(false)
                    : null;
                if (row.Status == ArticleStatus.Published)
                {
                    ArticleRevision? revision = publication is null ? null
                        : await db.Queryable<ArticleRevision>().Where(item => item.Id == publication.ArticleRevisionId)
                            .FirstAsync(cancellationToken).ConfigureAwait(false);
                    bool bodyAvailable = revision is not null
                        && await db.Queryable<ArticleRevisionContentBlock>().Where(item => item.Id == revision.ContentBlockId)
                            .AnyAsync(cancellationToken).ConfigureAwait(false);
                    if (!bodyAvailable)
                    {
                        throw new InvalidOperationException("public fixture published body/pointer unavailable; verification does not schedule repair");
                    }
                }
                ArticleDetailCoreModel? detail = await articles.GetByIdAsync(new ArticleDetailQuery(id), cancellationToken)
                    .ConfigureAwait(false);
                bool readable = IsCurrentPublicDetail(row, detail, publication?.ArticleRevisionId);
                if (fields.ContainsKey("publicDetailReadable"))
                {
                    fields["publicDetailReadable"] = readable;
                }
                RequireVerificationEquality(original.Fields, fields,
                    "status", "deleted", "currentPublicationId", "currentRevisionId", "revisionIds", "publicDetailReadable");
                CanonicalArticleLifecycleReceipt? lifecycle = snapshot.Lifecycles
                    .SingleOrDefault(item => item.ArticleId == id);
                if (lifecycle is not null)
                {
                    CanonicalArticleProjectionVerifier projectionVerifier = serviceProvider
                        .GetService<CanonicalArticleProjectionVerifier>()
                        ?? throw new InvalidOperationException("canonical article independent projection verifier unavailable");
                    fields["projectionAggregate"] = await projectionVerifier.VerifyAsync(lifecycle, cancellationToken)
                        .ConfigureAwait(false);
                    fields["requiredProjectionEdgesVerified"] = true;
                    RequireVerificationEquality(original.Fields, fields,
                        "projectionAggregate", "requiredProjectionEdgesVerified");
                }
            }
            else if (original.Kind is "category" or "tag")
            {
                int id = int.Parse(original.Id, CultureInfo.InvariantCulture);
                string? name = original.Kind == "category"
                    ? (await db.Queryable<Category>().Where(item => item.Id == id).FirstAsync(cancellationToken).ConfigureAwait(false))?.Name
                    : (await db.Queryable<Tag>().Where(item => item.Id == id).FirstAsync(cancellationToken).ConfigureAwait(false))?.Name;
                if (name is null || !name.StartsWith(ownerPrefix + ":", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("public fixture owned taxonomy identity mismatch");
                }
                fields["name"] = name;
                RequireVerificationEquality(original.Fields, fields, "name");
            }
            else if (original.Kind == "pagination-keyset")
            {
                PublicContentPaginationProjection current = await ReadDeepPaginationProjectionAsync(ownerPrefix, cancellationToken)
                    .ConfigureAwait(false);
                PublicContentPaginationProjection previous = expected.Projection.Pagination
                    ?? throw new InvalidOperationException("pagination verification input missing");
                RequirePaginationVerification(previous, current, articleListCursorCodec);
                foreach (PublicContentPaginationCursor cursor in previous.Cursors)
                {
                    if (!articleListCursorCodec.TryDecode(cursor.Cursor, null, null, string.Empty, 10,
                        current.Generation, ArticleListSortMode.Latest, out ArticleListCursorPosition position))
                    {
                        throw new InvalidOperationException("public fixture pagination cursor unavailable");
                    }
                    CorePageResult<ArticleListCoreModel> page = await articles.GetPageListAsync(new ArticlePageQuery(
                        cursor.LogicalPage, 10, null, null, IsDeleted: false,
                        ListCacheVersion: current.Generation, UseSourceCache: false, Cursor: position),
                        cancellationToken).ConfigureAwait(false);
                    if (page.Items.Count != 10)
                    {
                        throw new InvalidOperationException("public fixture pagination public page incomplete");
                    }
                }
                fields["generation"] = current.Generation;
                fields["articleCount"] = current.ArticleCount;
                fields["ownedArticleCount"] = current.OwnedArticleCount;
            }
            else
            {
                throw new InvalidOperationException($"public fixture unsupported verification entity {original.Kind}");
            }
            entities.Add(new PublicContentObservedEntity
            {
                Kind = original.Kind,
                Id = original.Id,
                Owned = true,
                CapabilityHint = original.CapabilityHint,
                PostconditionId = original.PostconditionId,
                Projection = original.Projection,
                Fields = fields
            });
        }

        RedisValue[] rank = await ReadVerificationHotSeedAsync(cancellationToken).ConfigureAwait(false);
        string[] hot = (await articles.GetHotArticlesAsync(new ArticleCountQuery(5), cancellationToken).ConfigureAwait(false))
            .Select(static item => item.Id.ToString(CultureInfo.InvariantCulture)).ToArray();
        string[] featured = (await articles.GetFeaturedArticlesAsync(new ArticleCountQuery(3), cancellationToken).ConfigureAwait(false))
            .Select(static item => item.Id.ToString(CultureInfo.InvariantCulture)).ToArray();
        long generation = await ReadVerificationGenerationAsync(cancellationToken,
            allowAbsent: expected.Mode == "public-empty").ConfigureAwait(false);
        if (generation != expected.Observations.Cache?.Generation
            || !hot.SequenceEqual(expected.Projection.HotOrder)
            || !rank.Select(static value => value.ToString()).SequenceEqual(hot))
        {
            throw new InvalidOperationException("public fixture cache/generation drift");
        }
        var entries = new List<PublicContentCacheEntry>();
        foreach (PublicContentCacheEntry original in expected.Observations.Cache?.Entries ?? [])
        {
            IReadOnlyList<string> visible = original.Endpoint switch
            {
                "article/hot" => hot,
                "article/featured" => featured,
                "search" => (await searchIndex.SearchAsync(original.SearchToken ?? string.Empty).ConfigureAwait(false))
                    .Select(static item => item.Id.ToString(CultureInfo.InvariantCulture)).ToArray(),
                "article/list/home" => (await articles.GetPageListAsync(new ArticlePageQuery(
                    1, 10, expected.Projection.CategoryId is null ? null : int.Parse(expected.Projection.CategoryId, CultureInfo.InvariantCulture),
                    expected.Projection.TagId is null ? null : int.Parse(expected.Projection.TagId, CultureInfo.InvariantCulture),
                    IsDeleted: false), cancellationToken).ConfigureAwait(false))
                    .Items.Select(static item => item.Id.ToString(CultureInfo.InvariantCulture)).ToArray(),
                _ => throw new InvalidOperationException("public fixture unsupported cache observation")
            };
            if (!visible.SequenceEqual(original.VisibleEntityIds ?? []))
            {
                throw new InvalidOperationException($"public fixture read/cache drift: {original.Endpoint}");
            }
            entries.Add(new PublicContentCacheEntry
            {
                Domain = original.Domain,
                Endpoint = original.Endpoint,
                MatchesDb = true,
                RequireOwnedVisible = original.RequireOwnedVisible,
                VisibleEntityIds = visible,
                SearchToken = original.SearchToken,
                SearchHit = original.Endpoint == "search" && visible.Count > 0
            });
        }
        return new(true, request.Identity, request.Proof.Digest, new PublicContentObservations
        {
            Source = "independent-service-read",
            Database = new() { Namespace = request.Identity.Namespace, Entities = entities },
            Redis = new()
            {
                Namespace = request.Identity.Namespace,
                Keys = [
                new("redis.cache.public", "blog:top_articles", rank.Length > 0, rank.Select(static item => item.ToString()).ToArray())]
            },
            Cache = new() { Namespace = request.Identity.Namespace, Generation = generation, Entries = entries }
        }, expected.EntityIdentities);
    }

    internal static void RequireVerificationEquality(
        IReadOnlyDictionary<string, object?> expected, IReadOnlyDictionary<string, object?> current, params string[] keys)
    {
        foreach (string key in keys.Where(expected.ContainsKey))
        {
            if (!current.TryGetValue(key, out object? value)
                || JsonSerializer.Serialize(expected[key], s_json) != JsonSerializer.Serialize(value, s_json))
            {
                throw new InvalidOperationException($"public fixture database/read drift: {key}");
            }
        }
    }

    internal static bool IsCurrentPublicDetail(Article row, ArticleDetailCoreModel? detail, long? publishedRevisionId)
        => detail is { } value && value.Id == row.Id
            && value.Status == (int)ArticleStatus.Published && !value.IsDeleted
            && row.CurrentPublicationId is not null
            && value.CurrentPublicationId == row.CurrentPublicationId
            && publishedRevisionId is not null && value.CurrentRevisionId == publishedRevisionId;

    internal static void RequirePaginationVerification(
        PublicContentPaginationProjection expected, PublicContentPaginationProjection current, IArticleListCursorCodec codec)
    {
        if (expected.Generation != current.Generation || expected.ArticleCount != current.ArticleCount
            || expected.OwnedArticleCount != current.OwnedArticleCount || expected.Cursors.Count != 3)
        {
            throw new InvalidOperationException("public fixture pagination generation/count drift");
        }
        for (int index = 0; index < current.Cursors.Count; index++)
        {
            PublicContentPaginationCursor previous = expected.Cursors[index];
            PublicContentPaginationCursor actual = current.Cursors[index];
            if (previous.LogicalPage != actual.LogicalPage || previous.BoundaryIdentity != actual.BoundaryIdentity
                || !codec.TryDecode(previous.Cursor, null, null, string.Empty, 10, current.Generation,
                    ArticleListSortMode.Latest, out ArticleListCursorPosition decoded)
                || decoded.Id.ToString(CultureInfo.InvariantCulture) != actual.BoundaryIdentity.ArticleId
                || decoded.CreateTimeUtc != actual.BoundaryIdentity.CreateTimeUtc)
            {
                throw new InvalidOperationException("public fixture pagination cursor drift");
            }
        }
    }
}
