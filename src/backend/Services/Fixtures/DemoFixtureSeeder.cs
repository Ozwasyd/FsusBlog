// fixture-catalog: producer development-demo
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Integrity;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>
/// Development-only demo dataset seeder (#1718).
/// Writes deterministic fictional demo content through SqlSugar domain entities.
/// Not a correctness producer — profile demo-public is diagnostic only.
/// Idempotent: full replace of owned demo rows on each invocation.
/// </summary>
public interface IDemoFixtureSeeder
{
    Task<DemoFixtureResult> PrepareAsync(
        DemoFixtureRequest request,
        CancellationToken cancellationToken = default);

    Task CleanupAsync(
        IReadOnlyList<DemoEntityIdentity> receiptEntities,
        CancellationToken cancellationToken = default);
}

public sealed record DemoFixtureRequest(
    string? Namespace,
    string? RunId);

public sealed class DemoFixtureResult
{
    public required string Strategy
    {
        get; init;
    }
    public required IReadOnlyList<DemoEntityIdentity> EntityIdentities
    {
        get; init;
    }
    public required DemoObservations Observations
    {
        get; init;
    }
    public required IReadOnlyList<string> ProvidedCapabilities
    {
        get; init;
    }
}

public sealed record DemoEntityIdentity(
    string Kind,
    string Id,
    string? Handle = null,
    string? VariantId = null,
    string? Owner = null,
    string? Digest = null);

public sealed class DemoObservations
{
    public string Source { get; init; } = "service";
    public DemoDatabaseObservation? Database
    {
        get; init;
    }
    public PublicContentRedisObservation? Redis
    {
        get; init;
    }
    public PublicContentCacheObservation? Cache
    {
        get; init;
    }
}

public sealed class DemoDatabaseObservation
{
    public string? Namespace
    {
        get; init;
    }
    public string SchemaIdentity { get; init; } = "public";
    public required IReadOnlyList<DemoObservedEntity> Entities
    {
        get; init;
    }
}

public sealed class DemoObservedEntity
{
    public required string Kind
    {
        get; init;
    }
    public required string Id
    {
        get; init;
    }
    public string? VariantId
    {
        get; init;
    }
    public string? Owner
    {
        get; init;
    }
    public bool Owned { get; init; } = true;
    public string? PostconditionId
    {
        get; init;
    }
    public Dictionary<string, object?> Fields { get; init; } = new();
}

public sealed class DemoFixtureSeeder(
    ISqlSugarClient db,
    IArticleCoreGateway articles,
    IAdminArtifactOperations artifactOperations,
    ISearchIndexService searchIndex,
    ICacheInvalidationDispatcher cacheInvalidation,
    IConnectionMultiplexer redisConnection,
    IRuntimeKeyScope runtimeKeyScope,
    IHostEnvironment hostEnvironment,
    IConfiguration configuration) : IDemoFixtureSeeder
{
    private const string Strategy = "transaction-fixture";
    private const string DiagnosticVariantId = "diagnostic.development.demo.dataset";
    private const string FixtureSecretConfigurationKey = "fsus:localDemoFixtureSecret";
    private const string IdentityDigestDomain = "fsusblog.demo-fixture-identity.v1";

    private const string DemoPrefix = "demo-fixture:";
    private const string OwnerTokenCharacters = "0123456789abcdef";
    private readonly IDatabase _redis = redisConnection.GetDatabase();

    private sealed record DemoFixtureOwner(string Value)
    {
        public string UserHandle => $"demo-reader-{Value[DemoPrefix.Length..]}";
        public string AdminHandle => $"demo-admin-{Value[DemoPrefix.Length..]}";
        public string Marker => Value + ":";

        public static DemoFixtureOwner Create(DemoFixtureRequest request)
        {
            string input = string.Concat(
                request.Namespace?.Trim() ?? "local",
                "\n",
                request.RunId?.Trim() ?? "default");
            string token = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input))).ToLowerInvariant()[..24];
            return new DemoFixtureOwner(DemoPrefix + token);
        }

        public static bool TryParse(string? value, out DemoFixtureOwner? owner)
        {
            owner = null;
            if (value is null
                || !value.StartsWith(DemoPrefix, StringComparison.Ordinal)
                || value.Length != DemoPrefix.Length + 24
                || value.AsSpan(DemoPrefix.Length).IndexOfAnyExcept(OwnerTokenCharacters) >= 0)
            {
                return false;
            }

            owner = new DemoFixtureOwner(value);
            return true;
        }

        public string Name(string variantId) => $"{Value}:{variantId}";
    }

    private sealed record SeededIdentity(int UserId, long AdminPrincipalId);

    private sealed record SeededArticle(int ArticleId, long RevisionId, long PublicationId);

    private sealed record SeededAudit(long SecurityEventId, long ModerationEventId);

    private sealed record DemoArtifactObservation(
        IReadOnlyList<PopularArticleCoreModel> Hot,
        IReadOnlyList<Article> Search);

    private sealed record DemoOwnedRows(
        DemoFixtureOwner Owner,
        int? UserId,
        long? AdminPrincipalId,
        int[] CategoryIds,
        int[] TagIds,
        int[] ArticleIds,
        long[] RevisionIds,
        long[] PublicationIds,
        long[] CommentIds,
        long[] ModerationEventIds,
        long[] AuditIds);

    private enum ExactReceiptDatabaseState
    {
        Present,
        Absent
    }

    public async Task<DemoFixtureResult> PrepareAsync(
        DemoFixtureRequest request,
        CancellationToken cancellationToken = default)
    {
        EnsureDevelopmentOnly();
        string ns = string.IsNullOrWhiteSpace(request.Namespace) ? "local" : request.Namespace.Trim();
        DemoFixtureOwner owner = DemoFixtureOwner.Create(request);
        var entityIdentities = new List<DemoEntityIdentity>();
        var observed = new List<DemoObservedEntity>();
        bool transactionActive = false;
        bool committed = false;
        string fixtureSecret = GetFixtureSecret();

        try
        {
            await db.Ado.BeginTranAsync().ConfigureAwait(false);
            transactionActive = true;

            SeededIdentity identity = await SeedIdentityAsync(owner, cancellationToken).ConfigureAwait(false);

            void AddEntity(
                string kind,
                string id,
                string? handle,
                Dictionary<string, object?>? fields = null)
            {
                var receiptIdentity = new DemoEntityIdentity(
                    kind,
                    id,
                    handle,
                    DiagnosticVariantId,
                    owner.Value);
                entityIdentities.Add(receiptIdentity with
                {
                    Digest = ComputeIdentityDigest(fixtureSecret, receiptIdentity)
                });
                observed.Add(new DemoObservedEntity
                {
                    Kind = kind,
                    Id = id,
                    VariantId = DiagnosticVariantId,
                    Owner = owner.Value,
                    PostconditionId = "development-demo-dataset",
                    Fields = fields ?? new Dictionary<string, object?>()
                });
            }

            int categoryPublicPreview = await EnsureCategoryAsync(owner.Name("category-public-preview"), cancellationToken).ConfigureAwait(false);
            int categoryOperations = await EnsureCategoryAsync(owner.Name("category-operations"), cancellationToken).ConfigureAwait(false);
            int tagDemo = await EnsureTagAsync(owner.Name("tag-demo"), cancellationToken).ConfigureAwait(false);
            int tagAeds = await EnsureTagAsync(owner.Name("tag-aeds"), cancellationToken).ConfigureAwait(false);
            int tagPublicAot = await EnsureTagAsync(owner.Name("tag-public-aot"), cancellationToken).ConfigureAwait(false);
            int tagModeration = await EnsureTagAsync(owner.Name("tag-moderation"), cancellationToken).ConfigureAwait(false);
            AddEntity("category", categoryPublicPreview.ToString(CultureInfo.InvariantCulture), owner.Name("category-public-preview"), new()
            {
                ["role"] = "public-preview"
            });
            AddEntity("category", categoryOperations.ToString(CultureInfo.InvariantCulture), owner.Name("category-operations"), new()
            {
                ["role"] = "operations"
            });
            AddEntity("tag", tagDemo.ToString(CultureInfo.InvariantCulture), owner.Name("tag-demo"), new()
            {
                ["role"] = "demo"
            });
            AddEntity("tag", tagAeds.ToString(CultureInfo.InvariantCulture), owner.Name("tag-aeds"), new()
            {
                ["role"] = "aeds"
            });
            AddEntity("tag", tagPublicAot.ToString(CultureInfo.InvariantCulture), owner.Name("tag-public-aot"), new()
            {
                ["role"] = "public-aot"
            });
            AddEntity("tag", tagModeration.ToString(CultureInfo.InvariantCulture), owner.Name("tag-moderation"), new()
            {
                ["role"] = "moderation"
            });
            AddEntity("user", identity.UserId.ToString(CultureInfo.InvariantCulture), owner.UserHandle, new()
            {
                ["identityKind"] = "anonymous_account",
                ["loginAuthority"] = false
            });
            AddEntity("admin-principal", identity.AdminPrincipalId.ToString(CultureInfo.InvariantCulture), owner.AdminHandle, new()
            {
                ["status"] = "disabled",
                ["permissions"] = string.Empty,
                ["loginAuthority"] = false
            });

            SeededArticle article1 = await SeedArticleAsync(
                identity.AdminPrincipalId,
                owner.Name("article-public-preview") + " Public Preview Walkthrough",
                "A fictional article that explains the local demo surface.",
                "/fixtures/demo-public-preview-route-map.svg",
                categoryPublicPreview,
                42,
                "2026-06-01 10:00:00+00",
                "# Public Preview Walkthrough\n\nThis is deterministic fictional demo content for local development.\n\n- It does not describe a real deployment.\n- It does not contain real user data.\n- It is safe to reset and reseed.",
                [tagDemo, tagPublicAot],
                cancellationToken).ConfigureAwait(false);
            AddEntity("article", article1.ArticleId.ToString(CultureInfo.InvariantCulture), "public-preview", new()
            {
                ["role"] = "public-preview",
                ["status"] = "published",
                ["title"] = "Public Preview Walkthrough",
                ["hasCover"] = true
            });

            SeededArticle article2 = await SeedArticleAsync(
                identity.AdminPrincipalId,
                owner.Name("article-aeds-notes") + " AEDS And Public AOT Notes",
                "A fictional operations note for testing public reading paths.",
                "/fixtures/demo-aeds-frame-inspection.svg",
                categoryOperations,
                18,
                "2026-06-02 10:00:00+00",
                "# AEDS And Public AOT Notes\n\nThis article gives the local UI enough content to render lists, details, search metadata, and moderation examples.",
                [tagDemo, tagAeds],
                cancellationToken).ConfigureAwait(false);
            AddEntity("article", article2.ArticleId.ToString(CultureInfo.InvariantCulture), "aeds-notes", new()
            {
                ["role"] = "aeds-notes",
                ["status"] = "published",
                ["title"] = "AEDS And Public AOT Notes",
                ["hasCover"] = true
            });

            SeededArticle article3 = await SeedArticleAsync(
                identity.AdminPrincipalId,
                owner.Name("article-moderation-queue") + " Moderation Queue Overview",
                "A fictional article demonstrating moderation flows.",
                null,
                categoryOperations,
                7,
                "2026-06-03 10:00:00+00",
                "# Moderation Queue Overview\n\nFictional content for demonstrating the moderation queue in local development.",
                [tagModeration],
                cancellationToken).ConfigureAwait(false);
            AddEntity("article", article3.ArticleId.ToString(CultureInfo.InvariantCulture), "moderation-queue", new()
            {
                ["role"] = "moderation-queue",
                ["status"] = "published",
                ["title"] = "Moderation Queue Overview",
                ["hasCover"] = false
            });

            long comment1 = await SeedCommentAsync(
                owner,
                article1.ArticleId,
                "approved",
                "[demo fixture] This approved comment is fictional and safe for screenshots.",
                "2026-06-01 11:00:00+00",
                moderationStatus: CommentModerationStatus.Approved,
                moderationReason: "demo-approved",
                moderatedAt: "2026-06-01 11:05:00+00",
                cancellationToken).ConfigureAwait(false);
            AddEntity("comment", comment1.ToString(CultureInfo.InvariantCulture), "approved", new()
            {
                ["role"] = "approved",
                ["articleId"] = article1.ArticleId,
                ["authorMode"] = "zk_anonymous",
                ["moderationStatus"] = "approved"
            });

            long comment2 = await SeedCommentAsync(
                owner,
                article2.ArticleId,
                "pending",
                "[demo fixture] This pending moderation item is fictional and repeatable.",
                "2026-06-02 11:00:00+00",
                moderationStatus: CommentModerationStatus.Pending,
                moderationReason: "demo-pending-review",
                moderatedAt: null,
                cancellationToken).ConfigureAwait(false);
            AddEntity("comment", comment2.ToString(CultureInfo.InvariantCulture), "pending", new()
            {
                ["role"] = "pending",
                ["articleId"] = article2.ArticleId,
                ["authorMode"] = "zk_anonymous",
                ["moderationStatus"] = "pending"
            });

            long[] commentIds = [comment1, comment2];
            List<CommentModerationEvent> moderationEvents = await db.Queryable<CommentModerationEvent>()
                .Where(item => commentIds.Contains(item.CommentId))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            if (moderationEvents.Count != 2
                || moderationEvents.GroupBy(static item => item.CommentId).Any(static group => group.Count() != 1))
            {
                throw new InvalidOperationException("canonical demo comment moderation events did not converge");
            }
            CommentModerationEvent approvedEvent = moderationEvents.Single(item => item.CommentId == comment1);
            CommentModerationEvent pendingEvent = moderationEvents.Single(item => item.CommentId == comment2);
            AddEntity("comment-moderation-event", approvedEvent.Id.ToString(CultureInfo.InvariantCulture), "approved", new()
            {
                ["role"] = "approved",
                ["commentId"] = comment1,
                ["eventType"] = approvedEvent.EventType
            });
            AddEntity("comment-moderation-event", pendingEvent.Id.ToString(CultureInfo.InvariantCulture), "pending", new()
            {
                ["role"] = "pending",
                ["commentId"] = comment2,
                ["eventType"] = pendingEvent.EventType
            });

            AddEntity("article-revision", article1.RevisionId.ToString(CultureInfo.InvariantCulture), "public-preview", new()
            {
                ["articleId"] = article1.ArticleId,
                ["revisionNo"] = 1
            });
            AddEntity("article-revision", article2.RevisionId.ToString(CultureInfo.InvariantCulture), "aeds-notes", new()
            {
                ["articleId"] = article2.ArticleId,
                ["revisionNo"] = 1
            });
            AddEntity("article-revision", article3.RevisionId.ToString(CultureInfo.InvariantCulture), "moderation-queue", new()
            {
                ["articleId"] = article3.ArticleId,
                ["revisionNo"] = 1
            });
            AddEntity("article-publication", article1.PublicationId.ToString(CultureInfo.InvariantCulture), "public-preview", new()
            {
                ["articleId"] = article1.ArticleId,
                ["publicationNo"] = 1
            });
            AddEntity("article-publication", article2.PublicationId.ToString(CultureInfo.InvariantCulture), "aeds-notes", new()
            {
                ["articleId"] = article2.ArticleId,
                ["publicationNo"] = 1
            });
            AddEntity("article-publication", article3.PublicationId.ToString(CultureInfo.InvariantCulture), "moderation-queue", new()
            {
                ["articleId"] = article3.ArticleId,
                ["publicationNo"] = 1
            });

            SeededAudit audit = await SeedAuditAsync(
                owner,
                article1.ArticleId,
                comment2,
                cancellationToken).ConfigureAwait(false);
            AddEntity("audit-event", audit.SecurityEventId.ToString(CultureInfo.InvariantCulture), "security", new()
            {
                ["action"] = "anti-crawler.demo-signal"
            });
            AddEntity("audit-event", audit.ModerationEventId.ToString(CultureInfo.InvariantCulture), "moderation", new()
            {
                ["action"] = "comment.moderation.demo-pending"
            });

            await db.Ado.CommitTranAsync().ConfigureAwait(false);
            transactionActive = false;
            committed = true;

            int[] publishedIds = [article1.ArticleId, article2.ArticleId, article3.ArticleId];
            await PublishDemoHotMembershipAsync(
                [(article1.ArticleId, 42), (article2.ArticleId, 18), (article3.ArticleId, 7)],
                cancellationToken).ConfigureAwait(false);
            DemoArtifactObservation artifacts = await RebuildAndObserveAsync(
                publishedIds,
                requirePresent: true,
                cancellationToken).ConfigureAwait(false);

            return new DemoFixtureResult
            {
                Strategy = Strategy,
                EntityIdentities = entityIdentities,
                Observations = new DemoObservations
                {
                    Source = "service",
                    Database = new DemoDatabaseObservation
                    {
                        Namespace = ns,
                        Entities = observed
                    },
                    Redis = new PublicContentRedisObservation
                    {
                        Namespace = ns,
                        Keys =
                        [
                            new(
                                "redis.cache.public",
                                "blog:top_articles",
                                true,
                                artifacts.Hot.Select(item => item.Id.ToString(CultureInfo.InvariantCulture)).ToArray())
                        ]
                    },
                    Cache = new PublicContentCacheObservation
                    {
                        Namespace = ns,
                        Generation = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        Entries =
                        [
                            new PublicContentCacheEntry
                            {
                                Domain = "home",
                                Endpoint = "article/hot",
                                MatchesDb = true,
                                RequireOwnedVisible = true,
                                VisibleEntityIds = artifacts.Hot.Select(item => item.Id.ToString(CultureInfo.InvariantCulture)).ToArray()
                            },
                            new PublicContentCacheEntry
                            {
                                Domain = "search",
                                Endpoint = "search",
                                MatchesDb = true,
                                SearchToken = "fictional",
                                SearchHit = true,
                                VisibleEntityIds = artifacts.Search.Select(item => item.Id.ToString(CultureInfo.InvariantCulture)).ToArray()
                            }
                        ]
                    }
                },
                ProvidedCapabilities = ["development.demo.dataset"]
            };
        }
        catch (Exception failure)
        {
            Exception? recoveryFailure = null;
            if (transactionActive)
            {
                try
                {
                    await db.Ado.RollbackTranAsync().ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    recoveryFailure = error;
                }
            }
            else if (committed && entityIdentities.Count > 0)
            {
                try
                {
                    await CleanupAsync(entityIdentities, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    recoveryFailure = error;
                }
            }

            if (recoveryFailure is not null)
            {
                throw new AggregateException(
                    "demo fixture prepare failed and compensation did not complete",
                    failure,
                    recoveryFailure);
            }

            throw;
        }
    }

    public async Task CleanupAsync(
        IReadOnlyList<DemoEntityIdentity> receiptEntities,
        CancellationToken cancellationToken = default)
    {
        EnsureDevelopmentOnly();
        ArgumentNullException.ThrowIfNull(receiptEntities);
        DemoOwnedRows rows = ParseExactReceipt(receiptEntities);
        bool transactionActive = false;
        bool committed = false;

        try
        {
            await db.Ado.BeginTranAsync().ConfigureAwait(false);
            transactionActive = true;
            _ = await ClassifyExactReceiptRowsAsync(rows, cancellationToken).ConfigureAwait(false);
            await DeleteOwnedRowsAsync(rows, cancellationToken).ConfigureAwait(false);
            await db.Ado.CommitTranAsync().ConfigureAwait(false);
            transactionActive = false;
            committed = true;
        }
        catch
        {
            if (transactionActive)
            {
                await db.Ado.RollbackTranAsync().ConfigureAwait(false);
            }

            throw;
        }

        if (committed)
        {
            await RemoveArticleReadModelsAsync(rows.ArticleIds, cancellationToken).ConfigureAwait(false);
            _ = await RebuildAndObserveAsync(
                rows.ArticleIds,
                requirePresent: false,
                cancellationToken).ConfigureAwait(false);
        }
    }

    private DemoOwnedRows ParseExactReceipt(IReadOnlyList<DemoEntityIdentity> receiptEntities)
    {
        var expectedCounts = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["user"] = 1,
            ["admin-principal"] = 1,
            ["category"] = 2,
            ["tag"] = 4,
            ["article"] = 3,
            ["article-revision"] = 3,
            ["article-publication"] = 3,
            ["comment"] = 2,
            ["comment-moderation-event"] = 2,
            ["audit-event"] = 2
        };
        if (receiptEntities.Count != expectedCounts.Values.Sum()
            || receiptEntities.Select(item => $"{item.Kind}:{item.Id}").Distinct(StringComparer.Ordinal).Count() != receiptEntities.Count
            || receiptEntities.Any(item => !expectedCounts.ContainsKey(item.Kind))
            || expectedCounts.Any(pair => receiptEntities.Count(item => item.Kind == pair.Key) != pair.Value)
            || receiptEntities.Any(item => !string.Equals(item.VariantId, DiagnosticVariantId, StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("demo cleanup requires the exact verified demo receipt identities");
        }

        string[] owners = receiptEntities
            .Select(static item => item.Owner)
            .Where(static item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.Ordinal)
            .Cast<string>()
            .ToArray();
        if (owners.Length != 1
            || receiptEntities.Any(item => !string.Equals(item.Owner, owners[0], StringComparison.Ordinal))
            || !DemoFixtureOwner.TryParse(owners[0], out DemoFixtureOwner? owner)
            || owner is null)
        {
            throw new InvalidOperationException("demo cleanup requires one valid exact receipt owner");
        }

        string fixtureSecret = GetFixtureSecret();
        foreach (DemoEntityIdentity identity in receiptEntities)
        {
            string expectedDigest = ComputeIdentityDigest(fixtureSecret, identity);
            string actualDigest = identity.Digest ?? string.Empty;
            byte[] expectedBytes = Encoding.ASCII.GetBytes(expectedDigest);
            byte[] actualBytes = Encoding.ASCII.GetBytes(actualDigest);
            if (expectedBytes.Length != actualBytes.Length
                || !CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes))
            {
                throw new InvalidOperationException(
                    "demo cleanup receipt identity digest is missing or invalid");
            }
        }

        static bool SameRoles(
            IReadOnlyList<DemoEntityIdentity> entities,
            string kind,
            params string[] roles)
            => entities
                .Where(item => item.Kind == kind)
                .Select(static item => item.Handle)
                .Order(StringComparer.Ordinal)
                .SequenceEqual(roles.Order(StringComparer.Ordinal), StringComparer.Ordinal);

        if (!SameRoles(receiptEntities, "article", "public-preview", "aeds-notes", "moderation-queue")
            || !SameRoles(receiptEntities, "article-revision", "public-preview", "aeds-notes", "moderation-queue")
            || !SameRoles(receiptEntities, "article-publication", "public-preview", "aeds-notes", "moderation-queue")
            || !SameRoles(receiptEntities, "comment", "approved", "pending")
            || !SameRoles(receiptEntities, "comment-moderation-event", "approved", "pending")
            || !SameRoles(receiptEntities, "audit-event", "security", "moderation")
            || receiptEntities.Single(item => item.Kind == "user").Handle != owner.UserHandle
            || receiptEntities.Single(item => item.Kind == "admin-principal").Handle != owner.AdminHandle
            || receiptEntities.Where(item => item.Kind is "category" or "tag")
                .Any(item => item.Handle is null || !item.Handle.StartsWith(owner.Marker, StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("demo cleanup receipt roles do not match the canonical dataset");
        }

        int[] IntIds(string kind)
            => receiptEntities
                .Where(item => item.Kind == kind)
                .Select(item => int.TryParse(item.Id, NumberStyles.None, CultureInfo.InvariantCulture, out int id) && id > 0
                    ? id
                    : throw new InvalidOperationException("invalid positive demo receipt identity"))
                .ToArray();
        long[] LongIds(string kind)
            => receiptEntities
                .Where(item => item.Kind == kind)
                .Select(item => long.TryParse(item.Id, NumberStyles.None, CultureInfo.InvariantCulture, out long id) && id > 0
                    ? id
                    : throw new InvalidOperationException("invalid positive demo receipt identity"))
                .ToArray();

        return new DemoOwnedRows(
            owner,
            IntIds("user").Single(),
            LongIds("admin-principal").Single(),
            IntIds("category"),
            IntIds("tag"),
            IntIds("article"),
            LongIds("article-revision"),
            LongIds("article-publication"),
            LongIds("comment"),
            LongIds("comment-moderation-event"),
            LongIds("audit-event"));
    }

    internal static string ComputeIdentityDigest(
        string secret,
        DemoEntityIdentity identity)
    {
        if (string.IsNullOrWhiteSpace(secret))
        {
            throw new InvalidOperationException(
                "demo fixture identity authority requires a configured local fixture secret");
        }

        string material = string.Join(
            '\n',
            IdentityDigestDomain,
            identity.Owner ?? string.Empty,
            identity.VariantId ?? string.Empty,
            identity.Kind,
            identity.Id,
            identity.Handle ?? string.Empty);
        byte[] digest = HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(secret.Trim()),
            Encoding.UTF8.GetBytes(material));
        return "sha256:" + Convert.ToHexString(digest).ToLowerInvariant();
    }

    private async Task<ExactReceiptDatabaseState> ClassifyExactReceiptRowsAsync(
        DemoOwnedRows rows,
        CancellationToken ct)
    {
        int categoryCount = await db.Queryable<Category>()
            .Where(item => rows.CategoryIds.Contains(item.Id))
            .CountAsync(ct)
            .ConfigureAwait(false);
        int tagCount = await db.Queryable<Tag>()
            .Where(item => rows.TagIds.Contains(item.Id))
            .CountAsync(ct)
            .ConfigureAwait(false);
        int articleCount = await db.Queryable<Article>()
            .Where(item => rows.ArticleIds.Contains(item.Id))
            .CountAsync(ct)
            .ConfigureAwait(false);
        int revisionCount = await db.Queryable<ArticleRevision>()
            .Where(item => rows.RevisionIds.Contains(item.Id))
            .CountAsync(ct)
            .ConfigureAwait(false);
        int publicationCount = await db.Queryable<ArticlePublicationRecord>()
            .Where(item => rows.PublicationIds.Contains(item.Id))
            .CountAsync(ct)
            .ConfigureAwait(false);
        int commentCount = await db.Queryable<Comment>()
            .Where(item => rows.CommentIds.Contains(item.Id))
            .CountAsync(ct)
            .ConfigureAwait(false);
        int moderationEventCount = await db.Queryable<CommentModerationEvent>()
            .Where(item => rows.ModerationEventIds.Contains(item.Id))
            .CountAsync(ct)
            .ConfigureAwait(false);
        int auditCount = await db.Queryable<AuditLog>()
            .Where(item => rows.AuditIds.Contains(item.Id))
            .CountAsync(ct)
            .ConfigureAwait(false);
        int userCount = await db.Queryable<User>()
            .Where(item => item.Id == rows.UserId!.Value)
            .CountAsync(ct)
            .ConfigureAwait(false);
        int adminCount = await db.Queryable<AdminPrincipal>()
            .Where(item => item.Id == rows.AdminPrincipalId!.Value)
            .CountAsync(ct)
            .ConfigureAwait(false);

        int presentCount = categoryCount
            + tagCount
            + articleCount
            + revisionCount
            + publicationCount
            + commentCount
            + moderationEventCount
            + auditCount
            + userCount
            + adminCount;
        int expectedCount = rows.CategoryIds.Length
            + rows.TagIds.Length
            + rows.ArticleIds.Length
            + rows.RevisionIds.Length
            + rows.PublicationIds.Length
            + rows.CommentIds.Length
            + rows.ModerationEventIds.Length
            + rows.AuditIds.Length
            + 2;

        if (presentCount == expectedCount)
        {
            return ExactReceiptDatabaseState.Present;
        }
        if (presentCount == 0)
        {
            return ExactReceiptDatabaseState.Absent;
        }

        throw new InvalidOperationException(
            "demo cleanup found a partial or mismatched exact receipt database state");
    }

    private string GetFixtureSecret()
    {
        string secret = configuration[FixtureSecretConfigurationKey] ?? string.Empty;
        if (string.IsNullOrWhiteSpace(secret))
        {
            throw new InvalidOperationException(
                "demo fixture identity authority requires fsus:localDemoFixtureSecret");
        }

        return secret.Trim();
    }

    private async Task DeleteOwnedRowsAsync(DemoOwnedRows rows, CancellationToken ct)
    {
        if (rows.UserId is null
            && rows.AdminPrincipalId is null
            && rows.CategoryIds.Length == 0
            && rows.TagIds.Length == 0
            && rows.ArticleIds.Length == 0
            && rows.CommentIds.Length == 0
            && rows.AuditIds.Length == 0)
        {
            return;
        }

        ct.ThrowIfCancellationRequested();
        try
        {
            await db.Ado.ExecuteCommandAsync("SET LOCAL session_replication_role = replica;").ConfigureAwait(false);
        }
        catch (Exception error)
        {
            throw new InvalidOperationException(
                "Development demo cleanup requires a PostgreSQL role authorized for transaction-local replica cleanup.",
                error);
        }

        long[] revisionContentBlockIds = rows.RevisionIds.Length == 0
            ? []
            : (await db.Queryable<ArticleRevision>()
                .Where(item => rows.RevisionIds.Contains(item.Id))
                .Select(item => item.ContentBlockId)
                .ToListAsync(ct)
                .ConfigureAwait(false)).ToArray();
        long[] commentOutboxIds = rows.CommentIds.Length == 0
            ? []
            : (await db.Queryable<CommentMutationOutboxEvent>()
                .Where(item => rows.CommentIds.Contains(item.CommentId))
                .Select(item => item.Id)
                .ToListAsync(ct)
                .ConfigureAwait(false)).ToArray();
        long[] articleOutboxIds = rows.ArticleIds.Length == 0
            ? []
            : (await db.Queryable<ArticleMutationOutboxEvent>()
                .Where(item => rows.ArticleIds.Contains(item.AggregateId))
                .Select(item => item.Id)
                .ToListAsync(ct)
                .ConfigureAwait(false)).ToArray();

        if (commentOutboxIds.Length > 0)
        {
            await db.Deleteable<CommentMutationOutboxDelivery>()
                .Where(item => commentOutboxIds.Contains(item.OutboxEventId))
                .ExecuteCommandAsync(ct)
                .ConfigureAwait(false);
        }
        if (rows.CommentIds.Length > 0)
        {
            await db.Deleteable<CommentModerationQueueClaim>().Where(item => rows.CommentIds.Contains(item.CommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentRegionCompliance>().Where(item => rows.CommentIds.Contains(item.CommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentBlockedRegion>().Where(item => rows.CommentIds.Contains(item.CommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentModerationSignal>().Where(item => rows.CommentIds.Contains(item.CommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentReport>().Where(item => rows.CommentIds.Contains(item.CommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentAuthorAppeal>().Where(item => rows.CommentIds.Contains(item.CommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentManagementChallenge>().Where(item => rows.CommentIds.Contains(item.CommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentRevision>().Where(item => rows.CommentIds.Contains(item.CommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentThreadPolicy>().Where(item => rows.CommentIds.Contains(item.RootCommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentMutationOutboxEvent>().Where(item => rows.CommentIds.Contains(item.CommentId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
        }
        if (rows.CommentIds.Length > 0 || rows.ModerationEventIds.Length > 0)
        {
            await db.Deleteable<CommentModerationEvent>()
                .Where(item =>
                    rows.CommentIds.Contains(item.CommentId)
                    || rows.ModerationEventIds.Contains(item.Id))
                .ExecuteCommandAsync(ct)
                .ConfigureAwait(false);
        }
        if (rows.CommentIds.Length > 0)
        {
            await db.Deleteable<Comment>().Where(item => rows.CommentIds.Contains(item.Id)).ExecuteCommandAsync(ct).ConfigureAwait(false);
        }

        if (articleOutboxIds.Length > 0)
        {
            await db.Deleteable<ArticleMutationOutboxEdge>()
                .Where(item => articleOutboxIds.Contains(item.OutboxEventId))
                .ExecuteCommandAsync(ct)
                .ConfigureAwait(false);
        }
        if (rows.ArticleIds.Length > 0)
        {
            await db.Deleteable<ArticleMutationOutboxEvent>().Where(item => rows.ArticleIds.Contains(item.AggregateId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleMutationCommand>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentSlowModeState>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<CommentPolicyAuditEvent>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleCommentPolicy>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleAssetReference>().Where(item => item.ArticleId != null && rows.ArticleIds.Contains(item.ArticleId.Value)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticlePublicTaxonomyProjection>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            string articleIdPlaceholders = string.Join(
                ", ",
                rows.ArticleIds.Select(static (_, index) => $"@ProjectionArticleId{index}"));
            SugarParameter[] articleIdParameters =
            [
                .. rows.ArticleIds.Select(
                    static (articleId, index) =>
                        new SugarParameter($"@ProjectionArticleId{index}", articleId)),
            ];
            await db.Ado.ExecuteCommandAsync(
                $"DELETE FROM public_article_projection WHERE article_id IN ({articleIdPlaceholders});",
                articleIdParameters).ConfigureAwait(false);
            await db.Deleteable<ArticleViewSeed>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleDraft>().Where(item => item.ArticleId != null && rows.ArticleIds.Contains(item.ArticleId.Value)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleTag>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleBody>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticlePublishProof>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleRightsProof>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleResponsibilitySnapshot>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleRightsSnapshot>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<ArticleRightsPolicy>().Where(item => rows.ArticleIds.Contains(item.ArticleId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
        }
        if (rows.PublicationIds.Length > 0)
        {
            await db.Deleteable<ArticlePublicationRecord>().Where(item => rows.PublicationIds.Contains(item.Id)).ExecuteCommandAsync(ct).ConfigureAwait(false);
        }
        if (rows.RevisionIds.Length > 0)
        {
            await db.Deleteable<ArticleRevision>().Where(item => rows.RevisionIds.Contains(item.Id)).ExecuteCommandAsync(ct).ConfigureAwait(false);
        }
        if (rows.ArticleIds.Length > 0)
        {
            await db.Deleteable<Article>().Where(item => rows.ArticleIds.Contains(item.Id)).ExecuteCommandAsync(ct).ConfigureAwait(false);
        }
        if (revisionContentBlockIds.Length > 0)
        {
            long[] retainedContentBlockIds = (await db.Queryable<ArticleRevision>()
                .Where(item => revisionContentBlockIds.Contains(item.ContentBlockId))
                .Select(static item => item.ContentBlockId)
                .ToListAsync(ct)
                .ConfigureAwait(false)).ToArray();
            long[] orphanedContentBlockIds = revisionContentBlockIds
                .Except(retainedContentBlockIds)
                .ToArray();
            if (orphanedContentBlockIds.Length > 0)
            {
                await db.Deleteable<ArticleRevisionContentBlock>()
                    .Where(item => orphanedContentBlockIds.Contains(item.Id))
                    .ExecuteCommandAsync(ct)
                    .ConfigureAwait(false);
            }
        }
        if (rows.AuditIds.Length > 0)
        {
            await db.Deleteable<AuditLog>()
                .Where(item => rows.AuditIds.Contains(item.Id))
                .ExecuteCommandAsync(ct)
                .ConfigureAwait(false);
        }
        if (rows.CategoryIds.Length > 0)
        {
            await db.Deleteable<CategoryPublicArticleCount>().Where(item => rows.CategoryIds.Contains(item.CategoryId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<Category>().Where(item => rows.CategoryIds.Contains(item.Id)).ExecuteCommandAsync(ct).ConfigureAwait(false);
        }
        if (rows.TagIds.Length > 0)
        {
            await db.Deleteable<TagPublicArticleCount>().Where(item => rows.TagIds.Contains(item.TagId)).ExecuteCommandAsync(ct).ConfigureAwait(false);
            await db.Deleteable<Tag>().Where(item => rows.TagIds.Contains(item.Id)).ExecuteCommandAsync(ct).ConfigureAwait(false);
        }
        if (rows.UserId is int userId)
        {
            await db.Deleteable<User>()
                .Where(item => item.Id == userId)
                .ExecuteCommandAsync(ct)
                .ConfigureAwait(false);
        }
        if (rows.AdminPrincipalId is long adminPrincipalId)
        {
            await db.Deleteable<AdminPrincipal>()
                .Where(item => item.Id == adminPrincipalId)
                .ExecuteCommandAsync(ct)
                .ConfigureAwait(false);
        }

        await db.Ado.ExecuteCommandAsync("SET LOCAL session_replication_role = origin;").ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
    }

    private void EnsureDevelopmentOnly()
    {
        if (!hostEnvironment.IsDevelopment() && !hostEnvironment.IsEnvironment("Testing"))
        {
            throw new InvalidOperationException(
                "demo fixture mutation is available only from the Development/test composition root");
        }
    }

    private async Task<DemoArtifactObservation> RebuildAndObserveAsync(
        int[] articleIds,
        bool requirePresent,
        CancellationToken ct)
    {
        AdminCacheActionResponse searchRebuild = await artifactOperations.RunCacheActionAsync(
            new AdminCacheActionRequest("search-rebuild"),
            ct).ConfigureAwait(false);
        if (!string.Equals(searchRebuild.Status, "ok", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"demo search read-model rebuild failed: {searchRebuild.Status} {searchRebuild.Detail}");
        }

        AdminCacheActionResponse hotRebuild = await artifactOperations.RunCacheActionAsync(
            new AdminCacheActionRequest("public-hot-rebuild"),
            ct).ConfigureAwait(false);
        if (hotRebuild.Status is not ("ok" or "queued"))
        {
            throw new InvalidOperationException(
                $"demo public-hot read-model rebuild failed: {hotRebuild.Status} {hotRebuild.Detail}");
        }

        IReadOnlyList<PopularArticleCoreModel> hot = [];
        IReadOnlyList<Article> search = [];
        for (int attempt = 0; attempt < 40; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            hot = await articles.GetHotArticlesAsync(new ArticleCountQuery(10), ct).ConfigureAwait(false);
            search = await searchIndex.SearchAsync("fictional").ConfigureAwait(false);

            bool detailsMatch = true;
            foreach (int articleId in articleIds)
            {
                ArticleDetailCoreModel? detail = await articles.GetByIdAsync(
                    new ArticleDetailQuery(articleId),
                    ct).ConfigureAwait(false);
                if ((detail is not null) != requirePresent)
                {
                    detailsMatch = false;
                    break;
                }
            }

            bool hotMatch = requirePresent
                ? hot.Any(item => articleIds.Contains(item.Id))
                : hot.All(item => !articleIds.Contains(item.Id));
            bool searchMatch = requirePresent
                ? articleIds.All(id => search.Any(item => item.Id == id))
                : search.All(item => !articleIds.Contains(item.Id));
            if (detailsMatch && hotMatch && searchMatch)
            {
                return new DemoArtifactObservation(hot, search);
            }

            await Task.Delay(TimeSpan.FromMilliseconds(250), ct).ConfigureAwait(false);
        }

        throw new InvalidOperationException(
            requirePresent
                ? "demo cache/search read models did not expose every owned published article"
                : "demo cleanup cache/search read models still expose removed receipt article ids");
    }

    private async Task RemoveArticleReadModelsAsync(int[] articleIds, CancellationToken ct)
    {
        string hotKey = runtimeKeyScope.PrefixKey("blog:top_articles");
        foreach (int articleId in articleIds.Distinct())
        {
            ct.ThrowIfCancellationRequested();
            await _redis.SortedSetRemoveAsync(hotKey, articleId).ConfigureAwait(false);
            await cacheInvalidation.InvalidateArticleMutationAsync(articleId, ct).ConfigureAwait(false);
        }
    }

    private async Task PublishDemoHotMembershipAsync(
        IReadOnlyList<(int ArticleId, int Views)> articlesToPublish,
        CancellationToken ct)
    {
        string hotKey = runtimeKeyScope.PrefixKey("blog:top_articles");
        foreach ((int articleId, int views) in articlesToPublish)
        {
            ct.ThrowIfCancellationRequested();
            await _redis.SortedSetAddAsync(hotKey, articleId, views).ConfigureAwait(false);
        }
    }

    private static SugarParameter NullableStringParameter(string name, string? value)
        => new(name, value is null ? DBNull.Value : value)
        {
            DbType = System.Data.DbType.String
        };

    private async Task<SeededIdentity> SeedIdentityAsync(DemoFixtureOwner owner, CancellationToken ct)
    {
        DateTime createdAt = DateTime.Parse(
            "2026-06-01 09:05:00+00",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal);
        string accountSubjectHash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes($"demo-account:{owner.Value}"))).ToLowerInvariant();

        int userId = checked((int)await InsertReturningIdAsync(
            """
            INSERT INTO sys_user (
                public_handle,
                identity_kind,
                account_subject_hash,
                registration_state,
                passkey_enabled,
                passkey_user_handle,
                passkey_signal_version,
                recovery_enabled,
                privacy_initialized_at,
                anonymous_credential_level,
                anonymous_credential_status,
                status,
                banreason,
                createtime,
                mfaenabled,
                riskflags,
                deleted_at,
                deleted_reason
            )
            VALUES (
                @Handle,
                'anonymous_account',
                @AccountSubjectHash,
                'active',
                false,
                NULL,
                0,
                false,
                @CreatedAt,
                'basic',
                'active',
                0,
                NULL,
                @CreatedAt,
                false,
                0,
                NULL,
                NULL
            )
            ON CONFLICT (public_handle)
            DO UPDATE SET
                identity_kind = EXCLUDED.identity_kind,
                account_subject_hash = EXCLUDED.account_subject_hash,
                registration_state = EXCLUDED.registration_state,
                passkey_enabled = false,
                passkey_user_handle = NULL,
                passkey_signal_version = 0,
                recovery_enabled = false,
                privacy_initialized_at = EXCLUDED.privacy_initialized_at,
                anonymous_credential_level = EXCLUDED.anonymous_credential_level,
                anonymous_credential_status = EXCLUDED.anonymous_credential_status,
                status = 0,
                banreason = NULL,
                mfaenabled = false,
                riskflags = 0,
                deleted_at = NULL,
                deleted_reason = NULL
            RETURNING id;
            """,
            ct,
            new SugarParameter("@Handle", owner.UserHandle),
            new SugarParameter("@AccountSubjectHash", accountSubjectHash),
            new SugarParameter("@CreatedAt", createdAt)).ConfigureAwait(false));

        long adminId = await InsertReturningIdAsync(
            """
            INSERT INTO admin_principal (
                handle,
                displayname,
                status,
                isroot,
                permissions,
                createdatutc,
                lastloginatutc,
                totpenabled,
                totpsecretencrypted,
                totpverifiedatutc
            )
            VALUES (
                @Handle,
                'Demo Admin Principal',
                'disabled',
                false,
                '',
                @CreatedAt,
                NULL,
                false,
                NULL,
                NULL
            )
            ON CONFLICT (handle)
            DO UPDATE SET
                displayname = EXCLUDED.displayname,
                status = 'disabled',
                isroot = false,
                permissions = '',
                lastloginatutc = NULL,
                totpenabled = false,
                totpsecretencrypted = NULL,
                totpverifiedatutc = NULL
            RETURNING id;
            """,
            ct,
            new SugarParameter("@Handle", owner.AdminHandle),
            new SugarParameter("@CreatedAt", createdAt.AddMinutes(-5))).ConfigureAwait(false);

        return new SeededIdentity(userId, adminId);
    }

    private async Task<int> EnsureCategoryAsync(string name, CancellationToken ct)
        => checked((int)await InsertReturningIdAsync(
            """
            INSERT INTO category (name)
            VALUES (@Name)
            ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
            RETURNING id;
            """,
            ct,
            new SugarParameter("@Name", name)).ConfigureAwait(false));

    private async Task<long> InsertReturningIdAsync(string sql, CancellationToken ct, params SugarParameter[] parameters)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters).ConfigureAwait(false);
        if (!await reader.ReadAsync(ct).ConfigureAwait(false))
            throw new InvalidOperationException("demo fixture insert did not return an identity");
        return Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
    }

    private async Task<int> EnsureTagAsync(string name, CancellationToken ct)
        => checked((int)await InsertReturningIdAsync(
            """
            INSERT INTO tag (name)
            VALUES (@Name)
            ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
            RETURNING id;
            """,
            ct,
            new SugarParameter("@Name", name)).ConfigureAwait(false));

    private async Task<SeededArticle> SeedArticleAsync(
        long adminPrincipalId,
        string title,
        string summary,
        string? coverImageUrl,
        int categoryId,
        int views,
        string publishedAt,
        string markdown,
        int[] tagIds,
        CancellationToken ct)
    {
        DateTime publishedAtUtc = DateTime.Parse(
            publishedAt,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal);
        DateTime revisionCreatedAt = publishedAtUtc.AddMinutes(5);

        int articleId = checked((int)await InsertReturningIdAsync(
            """
            INSERT INTO article (
                title,
                summary,
                coverimageurl,
                categoryid,
                views,
                createtime,
                metadata_updated_at,
                status,
                scheduled_publish_at,
                published_at,
                last_published_at,
                public_updated_at,
                current_revision_id,
                current_publication_id,
                pending_publication_at,
                archived_at,
                deleted_at,
                isdeleted
            )
            VALUES (
                @Title,
                @Summary,
                @CoverImageUrl,
                @CategoryId,
                @Views,
                @PublishedAt,
                @PublishedAt,
                @Status,
                NULL,
                @PublishedAt,
                @PublishedAt,
                @PublishedAt,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                false
            )
            RETURNING id;
            """,
            ct,
            new SugarParameter("@Title", title),
            new SugarParameter("@Summary", summary),
            NullableStringParameter("@CoverImageUrl", coverImageUrl),
            new SugarParameter("@CategoryId", categoryId),
            new SugarParameter("@Views", views),
            new SugarParameter("@PublishedAt", publishedAtUtc),
            new SugarParameter("@Status", (int)ArticleStatus.Published)).ConfigureAwait(false));

        await db.Insertable(new ArticleBody
        {
            ArticleId = articleId,
            MarkdownContent = markdown,
            UpdatedAt = revisionCreatedAt
        }).ExecuteCommandAsync(ct).ConfigureAwait(false);

        foreach (int tagId in tagIds)
        {
            await db.Insertable(new ArticleTag { ArticleId = articleId, TagId = tagId })
                .ExecuteCommandAsync(ct)
                .ConfigureAwait(false);
        }

        string contentHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(markdown)))
            .ToLowerInvariant();
        long blockId = await InsertReturningIdAsync(
            """
            INSERT INTO article_revision_content_block (
                content_hash,
                markdown_content,
                byte_length,
                created_at
            )
            VALUES (
                @ContentHash,
                @Markdown,
                @ByteLength,
                @CreatedAt
            )
            ON CONFLICT (content_hash)
            DO UPDATE SET content_hash = EXCLUDED.content_hash
            RETURNING id;
            """,
            ct,
            new SugarParameter("@ContentHash", contentHash),
            new SugarParameter("@Markdown", markdown),
            new SugarParameter("@ByteLength", Encoding.UTF8.GetByteCount(markdown)),
            new SugarParameter("@CreatedAt", revisionCreatedAt)).ConfigureAwait(false);

        const int RevisionNo = 1;
        string tagIdList = string.Join(",", tagIds.OrderBy(static id => id));
        long revisionId = await InsertReturningIdAsync(
            """
            INSERT INTO article_revision (
                article_id,
                revision_no,
                title,
                summary,
                cover_image_url,
                categoryid,
                tag_ids,
                content_block_id,
                markdown_content,
                diff_summary,
                created_by_admin_principal_id,
                rollback_source_revision_id,
                rollback_reason,
                created_at
            )
            VALUES (
                @ArticleId,
                @RevisionNo,
                @Title,
                @Summary,
                @CoverImageUrl,
                @CategoryId,
                @TagIds,
                @ContentBlockId,
                '',
                'Deterministic local demo seed',
                @AdminPrincipalId,
                NULL,
                NULL,
                @CreatedAt
            )
            RETURNING id;
            """,
            ct,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RevisionNo", RevisionNo),
            new SugarParameter("@Title", title),
            new SugarParameter("@Summary", summary),
            NullableStringParameter("@CoverImageUrl", coverImageUrl),
            new SugarParameter("@CategoryId", categoryId),
            new SugarParameter("@TagIds", tagIdList),
            new SugarParameter("@ContentBlockId", blockId),
            new SugarParameter("@AdminPrincipalId", adminPrincipalId),
            new SugarParameter("@CreatedAt", revisionCreatedAt)).ConfigureAwait(false);

        const string LicenseType = "all-rights-reserved";
        const string CopyrightHolder = "Fsu's Blog";
        const int CopyrightYear = 2026;
        const string RightsStatement = "\u672c\u6587\u4fdd\u7559\u6240\u6709\u6743\u5229\uff0c\u5f15\u7528\u6216\u8f6c\u8f7d\u8bf7\u9075\u5faa\u9875\u9762\u6807\u6ce8\u7684\u590d\u5236\u7b56\u7565\u3002";
        const string AttributionTemplate = "{title} \u2014 {holder} {url}";
        const string CopyPolicy = "append-attribution";
        const int MaxExcerptChars = 300;
        long policyId = await InsertReturningIdAsync(
            """
            INSERT INTO article_rights_policy (
                article_id,
                enabled,
                license_type,
                copyright_holder,
                copyright_year,
                rights_statement,
                attribution_template,
                copy_policy,
                max_excerpt_chars,
                allow_code_copy,
                show_public_badge,
                proof_binding_enabled,
                created_at,
                updated_at
            )
            VALUES (
                @ArticleId,
                true,
                @LicenseType,
                @CopyrightHolder,
                @CopyrightYear,
                @RightsStatement,
                @AttributionTemplate,
                @CopyPolicy,
                @MaxExcerptChars,
                true,
                true,
                true,
                @CreatedAt,
                @CreatedAt
            )
            RETURNING id;
            """,
            ct,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@LicenseType", LicenseType),
            new SugarParameter("@CopyrightHolder", CopyrightHolder),
            new SugarParameter("@CopyrightYear", CopyrightYear),
            new SugarParameter("@RightsStatement", RightsStatement),
            new SugarParameter("@AttributionTemplate", AttributionTemplate),
            new SugarParameter("@CopyPolicy", CopyPolicy),
            new SugarParameter("@MaxExcerptChars", MaxExcerptChars),
            new SugarParameter("@CreatedAt", publishedAtUtc)).ConfigureAwait(false);

        string contentCanonicalHash = "sha256:" + ArticleCanonicalHashV1.ComputeHashHex(
            new ArticleCanonicalInput(
                ArticleId: articleId,
                ArticleRevisionId: revisionId,
                RevisionNo: RevisionNo,
                PublicRouteKey: $"article:{articleId}",
                Title: title,
                Summary: summary,
                CoverImageUrl: coverImageUrl,
                CategoryId: categoryId,
                TagIds: tagIds,
                Status: (int)ArticleStatus.Published,
                PublishedAt: publishedAtUtc,
                ScheduledPublishAt: null,
                MarkdownContent: markdown));
        string policyHash = ArticleRightsCanonicalHashV1.ComputeHashHex(
            new ArticleRightsCanonicalInput(
                ArticleId: articleId,
                ArticleRevisionId: revisionId,
                RevisionNo: RevisionNo,
                LicenseType: LicenseType,
                CopyrightHolder: CopyrightHolder,
                CopyrightYear: CopyrightYear,
                RightsStatement: RightsStatement,
                AttributionTemplate: AttributionTemplate,
                CopyPolicy: CopyPolicy,
                MaxExcerptChars: MaxExcerptChars,
                AllowCodeCopy: true,
                ShowPublicBadge: true,
                CanonicalUrl: null,
                ContentCanonicalHash: contentCanonicalHash));

        long snapshotId = await InsertReturningIdAsync(
            """
            INSERT INTO article_rights_snapshot (
                article_id,
                article_revision_id,
                revision_no,
                article_rights_policy_id,
                enabled,
                license_type,
                copyright_holder,
                copyright_year,
                rights_statement,
                attribution_template,
                copy_policy,
                max_excerpt_chars,
                allow_code_copy,
                show_public_badge,
                proof_binding_enabled,
                canonical_url,
                policy_hash,
                content_canonical_hash,
                created_at
            )
            VALUES (
                @ArticleId,
                @RevisionId,
                @RevisionNo,
                @PolicyId,
                true,
                @LicenseType,
                @CopyrightHolder,
                @CopyrightYear,
                @RightsStatement,
                @AttributionTemplate,
                @CopyPolicy,
                @MaxExcerptChars,
                true,
                true,
                true,
                NULL,
                @PolicyHash,
                @ContentCanonicalHash,
                @CreatedAt
            )
            RETURNING id;
            """,
            ct,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RevisionId", revisionId),
            new SugarParameter("@RevisionNo", RevisionNo),
            new SugarParameter("@PolicyId", policyId),
            new SugarParameter("@LicenseType", LicenseType),
            new SugarParameter("@CopyrightHolder", CopyrightHolder),
            new SugarParameter("@CopyrightYear", CopyrightYear),
            new SugarParameter("@RightsStatement", RightsStatement),
            new SugarParameter("@AttributionTemplate", AttributionTemplate),
            new SugarParameter("@CopyPolicy", CopyPolicy),
            new SugarParameter("@MaxExcerptChars", MaxExcerptChars),
            new SugarParameter("@PolicyHash", policyHash),
            new SugarParameter("@ContentCanonicalHash", contentCanonicalHash),
            new SugarParameter("@CreatedAt", revisionCreatedAt)).ConfigureAwait(false);

        long publicationId = await InsertReturningIdAsync(
            """
            INSERT INTO article_publication (
                article_id,
                publication_no,
                article_revision_id,
                revision_no,
                rights_snapshot_id,
                responsibility_snapshot_id,
                transition_kind,
                published_at,
                created_at
            )
            VALUES (
                @ArticleId,
                1,
                @RevisionId,
                @RevisionNo,
                @RightsSnapshotId,
                NULL,
                'immediate-publish',
                @PublishedAt,
                @PublishedAt
            )
            RETURNING id;
            """,
            ct,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@RevisionId", revisionId),
            new SugarParameter("@RevisionNo", RevisionNo),
            new SugarParameter("@RightsSnapshotId", snapshotId),
            new SugarParameter("@PublishedAt", publishedAtUtc)).ConfigureAwait(false);

        await db.Updateable<Article>()
            .SetColumns(item => item.CurrentRevisionId == revisionId)
            .SetColumns(item => item.CurrentPublicationId == publicationId)
            .Where(item => item.Id == articleId)
            .ExecuteCommandAsync(ct)
            .ConfigureAwait(false);

        return new SeededArticle(articleId, revisionId, publicationId);
    }

    private async Task<long> SeedCommentAsync(
        DemoFixtureOwner owner,
        int articleId,
        string role,
        string content,
        string createTime,
        CommentModerationStatus moderationStatus,
        string moderationReason,
        string? moderatedAt,
        CancellationToken ct)
    {
        DateTime createTimeUtc = DateTime.Parse(createTime, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal);
        string nullifierHash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes($"demo-nullifier:{owner.Value}:{role}"))).ToLowerInvariant();
        string moderationSubjectHash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes($"demo-moderation-subject:{owner.Value}:{role}"))).ToLowerInvariant();

        var comment = new Comment
        {
            ArticleId = articleId,
            Content = content,
            CreateTime = createTimeUtc,
            CurrentVersion = 1,
            AuthorMode = "zk_anonymous",
            PublicHandle = null,
            AnonymousHandle = owner.UserHandle,
            AnonymousDisplayName = "Demo Reader",
            AnonymousDisplayLanguage = "en",
            AnonymousNullifierHash = nullifierHash,
            AnonymousScope = owner.Name($"comment-{role}"),
            ModerationSubjectHash = moderationSubjectHash,
            CredentialLevel = null,
            ReputationBucket = null,
            AccountAgeBucket = null,
            AnonymousRateClass = "common",
            AnonymousRequiresModeration = moderationStatus == CommentModerationStatus.Pending,
            ParentId = null,
            RootId = null,
            ReplyToCommentId = null,
            Depth = 0,
            IsDeleted = false,
            ModerationStatus = moderationStatus,
            ModerationReason = moderationReason,
            ModeratedAt = moderatedAt is not null
                ? DateTime.Parse(moderatedAt, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal)
                : null
        };
        long commentId = await db.Insertable(comment).ExecuteReturnSnowflakeIdAsync().ConfigureAwait(false);
        if (commentId <= 0)
        {
            throw new InvalidOperationException("canonical demo comment insert did not return an identity");
        }

        await db.Insertable(new CommentRevision
        {
            CommentId = commentId,
            Version = 1,
            Content = content,
            ContentSha256 = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant(),
            Operation = CommentRevisionOperations.Created,
            CreatedAtUtc = createTimeUtc,
            ActorAccountId = null,
            ActorAdminPrincipalId = null,
            ActorMode = "zk_anonymous"
        }).ExecuteCommandAsync(ct).ConfigureAwait(false);

        return commentId;
    }

    private async Task<SeededAudit> SeedAuditAsync(
        DemoFixtureOwner owner,
        int articleId,
        long commentId,
        CancellationToken ct)
    {
        long securityEventId = await InsertReturningIdAsync(
            """
            INSERT INTO sys_audit_log
              (source, type, occurred_at_utc, actor_type, actor_id, actor_role, action,
               target_type, target_id, outcome, severity, is_high_value, trace_id,
               request_path, request_method, ip_hash, user_agent_hash,
               session_id_hash, device_fingerprint_hash, reason_code, event_info, context_json)
            VALUES
              (@Source, 'security', '2026-06-01 12:00:00+00', 'system', @ActorId, NULL,
               'anti-crawler.demo-signal', 'public-read', @target1, 'observed', 'info', false,
               @TraceId, '/articles/public-preview-walkthrough', 'GET',
               @IpHash, @UserAgentHash, NULL, NULL,
               'demo-security-event', 'Fictional anti-crawler demo event', @ContextJson)
            RETURNING id;
            """,
            ct,
            new SugarParameter("@Source", owner.Value),
            new SugarParameter("@ActorId", owner.Name("security-actor")),
            new SugarParameter("@target1", articleId.ToString(CultureInfo.InvariantCulture)),
            new SugarParameter("@TraceId", owner.Name("security-trace")),
            new SugarParameter("@IpHash", owner.Name("fictional-ip-hash")),
            new SugarParameter("@UserAgentHash", owner.Name("fictional-ua-hash")),
            new SugarParameter("@ContextJson", """{"demo":true,"fictional":true}""")).ConfigureAwait(false);

        long moderationEventId = await InsertReturningIdAsync(
            """
            INSERT INTO sys_audit_log
              (source, type, occurred_at_utc, actor_type, actor_id, actor_role, action,
               target_type, target_id, outcome, severity, is_high_value, trace_id,
               request_path, request_method, ip_hash, user_agent_hash,
               session_id_hash, device_fingerprint_hash, reason_code, event_info, context_json)
            VALUES
              (@Source, 'audit', '2026-06-02 12:00:00+00', 'admin_principal', @AdminHandle, NULL,
               'comment.moderation.demo-pending', 'comment', @target2, 'pending', 'info', false,
               @TraceId, '/user/manage/comments', 'POST',
               @IpHash, @UserAgentHash, NULL, NULL,
               'demo-moderation-event', 'Fictional moderation queue demo event', @ContextJson)
            RETURNING id;
            """,
            ct,
            new SugarParameter("@Source", owner.Value),
            new SugarParameter("@AdminHandle", owner.AdminHandle),
            new SugarParameter("@target2", commentId.ToString(CultureInfo.InvariantCulture)),
            new SugarParameter("@TraceId", owner.Name("moderation-trace")),
            new SugarParameter("@IpHash", owner.Name("fictional-ip-hash")),
            new SugarParameter("@UserAgentHash", owner.Name("fictional-ua-hash")),
            new SugarParameter("@ContextJson", """{"demo":true,"fictional":true}""")).ConfigureAwait(false);

        return new SeededAudit(securityEventId, moderationEventId);
    }
}
