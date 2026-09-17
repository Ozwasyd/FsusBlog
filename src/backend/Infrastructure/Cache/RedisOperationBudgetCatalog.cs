using System.Collections.Frozen;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Cache;

public enum RedisOperationClass : byte
{
    SecurityAtomic = 0,
    CoordinationLease = 1,
    ContentCacheRead = 2,
    ContentCacheWrite = 3,
    OptionalProjection = 4,
    DistributedDelivery = 5,
    BackgroundMaintenance = 6
}

public enum RedisOperationPort : byte
{
    UnifiedCacheRead = 0,
    UnifiedCacheWrite = 1,
    UnifiedCacheLease = 2,
    UnifiedCacheAtomic = 3,
    SharedDistributedCacheRead = 4,
    SharedDistributedCacheWrite = 5,
    ClusterMembership = 6,
    DistributedInvalidation = 7,
    DistributedStateControl = 8,
    NotificationBacklog = 9,
    ActiveReleaseFence = 10,
    PerceptionCharacterCutover = 11,
    ProductionHealth = 12,
    SecurityChallengeKindCutover = 13,
    PublicAotFileCacheRead = 14,
    PublicAotFileCacheWrite = 15,
    PublicAotInvalidationDelivery = 16,
    PublicAotGeneration = 17,
    PublicAotShellRead = 18,
    PublicAotShellWrite = 19,
    PublicArtifactRevocation = 20,
    PublicHotDeliveryState = 21,
    PublicHotRiskProjection = 22,
    ArticleProjectionInvalidation = 23,
    ArticleServiceCache = 24,
    DemoFixture = 25,
    PerceptionChallenge = 26,
    PerceptionArtifactPool = 27,
    PerceptionState = 28,
    UserSessionValidation = 29,
    UnifiedCacheOptionalProjection = 30,
    UnifiedCacheDistributedDelivery = 31,
    UnifiedCacheInvalidation = 32,
    UnifiedCacheMaintenance = 33,
    PublicAotShellMaintenance = 34,
    ArticleServiceOptionalProjection = 35,
    DistributedStateControlMaintenance = 36,
    NotificationBacklogRead = 37,
    NotificationPublishOrderLease = 38,
    CommentFixture = 39
}

public sealed record RedisOperationBudget(
    RedisOperationClass OperationClass,
    string Id,
    TimeSpan ConnectDeadline,
    TimeSpan CommandDeadline,
    TimeSpan EndToEndDeadline,
    int RetryCount,
    string IdempotencyRequirement,
    string FailAction,
    int MaxConcurrency,
    int CircuitFailureThreshold,
    TimeSpan CircuitOpenDuration,
    bool Foreground);

public sealed record RedisOperationPortDefinition(
    RedisOperationPort Port,
    string Id,
    RedisOperationClass OperationClass,
    bool Idempotent);

public sealed class RedisOperationBudgetCatalog
{
    internal const string ResourceName = "FsusBlog.RedisOperationBudgets.json";
    internal const string Schema = "fsusblog.redis-operation-budgets.v1";
    private static readonly FrozenDictionary<string, RedisOperationClass> s_ids =
        new Dictionary<string, RedisOperationClass>(StringComparer.Ordinal)
        {
            ["security-atomic"] = RedisOperationClass.SecurityAtomic,
            ["coordination-lease"] = RedisOperationClass.CoordinationLease,
            ["content-cache-read"] = RedisOperationClass.ContentCacheRead,
            ["content-cache-write"] = RedisOperationClass.ContentCacheWrite,
            ["optional-projection"] = RedisOperationClass.OptionalProjection,
            ["distributed-delivery"] = RedisOperationClass.DistributedDelivery,
            ["background-maintenance"] = RedisOperationClass.BackgroundMaintenance
        }.ToFrozenDictionary(StringComparer.Ordinal);
    private static readonly FrozenDictionary<string, RedisOperationPort> s_portIds =
        new Dictionary<string, RedisOperationPort>(StringComparer.Ordinal)
        {
            ["unified-cache-read"] = RedisOperationPort.UnifiedCacheRead,
            ["unified-cache-write"] = RedisOperationPort.UnifiedCacheWrite,
            ["unified-cache-lease"] = RedisOperationPort.UnifiedCacheLease,
            ["unified-cache-atomic"] = RedisOperationPort.UnifiedCacheAtomic,
            ["shared-distributed-cache-read"] = RedisOperationPort.SharedDistributedCacheRead,
            ["shared-distributed-cache-write"] = RedisOperationPort.SharedDistributedCacheWrite,
            ["cluster-membership"] = RedisOperationPort.ClusterMembership,
            ["distributed-invalidation"] = RedisOperationPort.DistributedInvalidation,
            ["distributed-state-control"] = RedisOperationPort.DistributedStateControl,
            ["notification-backlog"] = RedisOperationPort.NotificationBacklog,
            ["active-release-fence"] = RedisOperationPort.ActiveReleaseFence,
            ["perception-character-cutover"] = RedisOperationPort.PerceptionCharacterCutover,
            ["production-health"] = RedisOperationPort.ProductionHealth,
            ["security-challenge-kind-cutover"] = RedisOperationPort.SecurityChallengeKindCutover,
            ["public-aot-file-cache-read"] = RedisOperationPort.PublicAotFileCacheRead,
            ["public-aot-file-cache-write"] = RedisOperationPort.PublicAotFileCacheWrite,
            ["public-aot-invalidation-delivery"] = RedisOperationPort.PublicAotInvalidationDelivery,
            ["public-aot-generation"] = RedisOperationPort.PublicAotGeneration,
            ["public-aot-shell-read"] = RedisOperationPort.PublicAotShellRead,
            ["public-aot-shell-write"] = RedisOperationPort.PublicAotShellWrite,
            ["public-artifact-revocation"] = RedisOperationPort.PublicArtifactRevocation,
            ["public-hot-delivery-state"] = RedisOperationPort.PublicHotDeliveryState,
            ["public-hot-risk-projection"] = RedisOperationPort.PublicHotRiskProjection,
            ["article-projection-invalidation"] = RedisOperationPort.ArticleProjectionInvalidation,
            ["article-service-cache"] = RedisOperationPort.ArticleServiceCache,
            ["demo-fixture"] = RedisOperationPort.DemoFixture,
            ["perception-challenge"] = RedisOperationPort.PerceptionChallenge,
            ["perception-artifact-pool"] = RedisOperationPort.PerceptionArtifactPool,
            ["perception-state"] = RedisOperationPort.PerceptionState,
            ["user-session-validation"] = RedisOperationPort.UserSessionValidation,
            ["unified-cache-optional-projection"] = RedisOperationPort.UnifiedCacheOptionalProjection,
            ["unified-cache-distributed-delivery"] = RedisOperationPort.UnifiedCacheDistributedDelivery,
            ["unified-cache-invalidation"] = RedisOperationPort.UnifiedCacheInvalidation,
            ["unified-cache-maintenance"] = RedisOperationPort.UnifiedCacheMaintenance,
            ["public-aot-shell-maintenance"] = RedisOperationPort.PublicAotShellMaintenance,
            ["article-service-optional-projection"] = RedisOperationPort.ArticleServiceOptionalProjection,
            ["distributed-state-control-maintenance"] = RedisOperationPort.DistributedStateControlMaintenance,
            ["notification-backlog-read"] = RedisOperationPort.NotificationBacklogRead,
            ["notification-publish-order-lease"] = RedisOperationPort.NotificationPublishOrderLease,
            ["comment-fixture"] = RedisOperationPort.CommentFixture
        }.ToFrozenDictionary(StringComparer.Ordinal);
    private static readonly FrozenSet<string> s_idempotencyRequirements =
        new[] { "single-attempt-atomic", "single-attempt-ownership", "idempotent-only", "no-retry" }
            .ToFrozenSet(StringComparer.Ordinal);
    private static readonly FrozenSet<string> s_failActions =
        new[]
        {
            "fail-closed",
            "deny-origin-without-lease",
            "bounded-origin-gate",
            "return-result-degraded",
            "use-local-or-base-value",
            "record-degraded-and-replay",
            "defer-maintenance"
        }.ToFrozenSet(StringComparer.Ordinal);

    private readonly FrozenDictionary<RedisOperationClass, RedisOperationBudget> _budgets;
    private readonly FrozenDictionary<RedisOperationPort, RedisOperationPortDefinition> _ports;

    public RedisOperationBudgetCatalog()
    {
        using Stream stream = typeof(RedisOperationBudgetCatalog).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Missing embedded Redis operation budget contract {ResourceName}.");
        using JsonDocument document = JsonDocument.Parse(stream, new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow
        });
        JsonElement root = document.RootElement;
        RequireExactProperties(root, "schema", "version", "operations", "ports");
        if (!string.Equals(root.GetProperty("schema").GetString(), Schema, StringComparison.Ordinal)
            || root.GetProperty("version").GetInt32() != 1)
        {
            throw new InvalidOperationException("Redis operation budget contract schema/version is invalid.");
        }

        var parsed = new Dictionary<RedisOperationClass, RedisOperationBudget>();
        foreach (JsonElement item in root.GetProperty("operations").EnumerateArray())
        {
            RequireExactProperties(
                item,
                "id",
                "connectDeadlineMs",
                "commandDeadlineMs",
                "endToEndDeadlineMs",
                "retryCount",
                "idempotencyRequirement",
                "failAction",
                "maxConcurrency",
                "circuitFailureThreshold",
                "circuitOpenMs",
                "foreground");
            string id = item.GetProperty("id").GetString()
                ?? throw new InvalidOperationException("Redis operation budget id is missing.");
            if (!s_ids.TryGetValue(id, out RedisOperationClass operationClass)
                || parsed.ContainsKey(operationClass))
            {
                throw new InvalidOperationException($"Redis operation budget id is unknown or duplicated: {id}.");
            }

            int connectMs = Positive(item, "connectDeadlineMs");
            int commandMs = Positive(item, "commandDeadlineMs");
            int endToEndMs = Positive(item, "endToEndDeadlineMs");
            int retryCount = item.GetProperty("retryCount").GetInt32();
            int maxConcurrency = Positive(item, "maxConcurrency");
            int circuitFailureThreshold = Positive(item, "circuitFailureThreshold");
            int circuitOpenMs = Positive(item, "circuitOpenMs");
            if (connectMs > endToEndMs || commandMs > endToEndMs || retryCount is < 0 or > 1)
            {
                throw new InvalidOperationException($"Redis operation budget {id} has incoherent deadlines or retry count.");
            }

            string idempotency = RequiredString(item, "idempotencyRequirement");
            string failAction = RequiredString(item, "failAction");
            if (!s_idempotencyRequirements.Contains(idempotency) || !s_failActions.Contains(failAction))
            {
                throw new InvalidOperationException($"Redis operation budget {id} has an unsupported semantic action.");
            }
            if (retryCount > 0 && !string.Equals(idempotency, "idempotent-only", StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"Redis operation budget {id} retries a non-idempotent class.");
            }

            parsed.Add(operationClass, new RedisOperationBudget(
                operationClass,
                id,
                TimeSpan.FromMilliseconds(connectMs),
                TimeSpan.FromMilliseconds(commandMs),
                TimeSpan.FromMilliseconds(endToEndMs),
                retryCount,
                idempotency,
                failAction,
                maxConcurrency,
                circuitFailureThreshold,
                TimeSpan.FromMilliseconds(circuitOpenMs),
                item.GetProperty("foreground").GetBoolean()));
        }

        if (parsed.Count != Enum.GetValues<RedisOperationClass>().Length)
        {
            throw new InvalidOperationException("Every Redis operation class must have exactly one budget.");
        }
        _budgets = parsed.ToFrozenDictionary();

        var ports = new Dictionary<RedisOperationPort, RedisOperationPortDefinition>();
        foreach (JsonElement item in root.GetProperty("ports").EnumerateArray())
        {
            RequireExactProperties(item, "id", "class", "idempotent");
            string id = RequiredString(item, "id");
            string classId = RequiredString(item, "class");
            if (!s_portIds.TryGetValue(id, out RedisOperationPort port)
                || !s_ids.TryGetValue(classId, out RedisOperationClass operationClass)
                || ports.ContainsKey(port))
            {
                throw new InvalidOperationException($"Redis operation port is unknown, duplicated, or has an unknown class: {id}.");
            }

            bool idempotent = item.GetProperty("idempotent").GetBoolean();
            ports.Add(port, new RedisOperationPortDefinition(port, id, operationClass, idempotent));
        }

        if (ports.Count != Enum.GetValues<RedisOperationPort>().Length)
        {
            throw new InvalidOperationException("Every Redis operation port must have exactly one class mapping.");
        }
        _ports = ports.ToFrozenDictionary();
    }

    public RedisOperationBudget Get(RedisOperationClass operationClass)
        => _budgets.TryGetValue(operationClass, out RedisOperationBudget? budget)
            ? budget
            : throw new InvalidOperationException($"Redis operation class is unmapped: {operationClass}.");

    public RedisOperationPortDefinition Get(RedisOperationPort port)
        => _ports.TryGetValue(port, out RedisOperationPortDefinition? definition)
            ? definition
            : throw new InvalidOperationException($"Redis operation port is unmapped: {port}.");

    public IReadOnlyCollection<RedisOperationPortDefinition> Ports => _ports.Values;

    public int TransportTimeoutMilliseconds
        => checked((int)_budgets.Values.Max(static budget => budget.EndToEndDeadline).TotalMilliseconds);

    public int TransportConnectTimeoutMilliseconds
        => checked((int)_budgets.Values.Max(static budget => budget.ConnectDeadline).TotalMilliseconds);

    private static int Positive(JsonElement item, string name)
    {
        int value = item.GetProperty(name).GetInt32();
        return value > 0
            ? value
            : throw new InvalidOperationException($"Redis operation budget {name} must be positive.");
    }

    private static string RequiredString(JsonElement item, string name)
    {
        string? value = item.GetProperty(name).GetString();
        return !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new InvalidOperationException($"Redis operation budget {name} must be non-empty.");
    }

    private static void RequireExactProperties(JsonElement value, params string[] expected)
    {
        string[] actual = value.EnumerateObject().Select(static property => property.Name).Order(StringComparer.Ordinal).ToArray();
        string[] orderedExpected = expected.Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(orderedExpected, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("Redis operation budget contract contains missing or unsupported fields.");
        }
    }
}
