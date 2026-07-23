using FsusBlog.Shared.Contracts.Security;

using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Services.Security;

public enum PerceptionCharacterV3ResourceDisposition : byte
{
    AllocateV3 = 1,
    UseCredentialStepUp = 2,
    RequireCheaperProof = 3,
    QueueForModeration = 4,
    Throttle = 5,
    Block = 6,
    Unavailable = 7
}

public enum PerceptionCharacterV3WatermarkState : byte
{
    High = 1,
    Normal = 2,
    Low = 3,
    Critical = 4,
    Empty = 5
}

public enum PerceptionCharacterV3ActionClass : byte
{
    Comment = 1,
    Enrollment = 2,
    AccountRecovery = 3,
    AdminSensitive = 4,
    PublicRead = 5,
    Other = 6
}

public sealed record PerceptionCharacterV3ResourceDecision(
    PerceptionCharacterV3ResourceDisposition Disposition,
    PerceptionCharacterV3WatermarkState Watermark,
    PerceptionCharacterV3ActionClass ActionClass,
    string Reason);

public sealed record PerceptionCharacterV3ResourcePlanInput(
    string Action,
    PerceptionCharacterV3Representation Representation,
    PerceptionCharacterV3PoolInventory Inventory,
    int EscalationLevel,
    int EffectiveRiskScore,
    bool AuthenticatedSession,
    bool PasskeyAssured,
    bool RedisAvailable);

public sealed record PerceptionCharacterV3ReplenishmentInput(
    PerceptionCharacterV3PoolInventory Inventory,
    bool IsPublicRequest,
    bool CpuPressure,
    bool MemoryPressure,
    bool IoPressure,
    bool LatencyPressure);

public sealed record PerceptionCharacterV3ReplenishmentDecision(
    bool Allowed,
    int MaximumEntries,
    long MaximumBytes,
    string Reason);

public interface IPerceptionCharacterV3ResourcePlanner
{
    void Validate();
    void ValidateInventory(PerceptionCharacterV3PoolInventory inventory);
    PerceptionCharacterV3ResourcePlannerOptions CurrentOptions();
    PerceptionCharacterV3ResourceDecision Plan(PerceptionCharacterV3ResourcePlanInput input);
    PerceptionCharacterV3ResourceDecision ResolveLeaseFailure(
        PerceptionCharacterV3ResourceDecision planned,
        PerceptionCharacterV3PoolLeaseOutcome outcome);
    PerceptionCharacterV3ReplenishmentDecision PlanReplenishment(PerceptionCharacterV3ReplenishmentInput input);
}

public sealed class PerceptionCharacterV3ResourcePlannerOptions
{
    public const string SectionName = "Security:PerceptionCharacterV3:Resources";

    public bool AllocationsEnabled { get; init; } = true;
    public int HighWatermark { get; init; } = 100;
    public int LowWatermark { get; init; } = 30;
    public int CriticalWatermark { get; init; } = 10;
    public int TotalHighWatermark { get; init; } = 200;
    public int TotalLowWatermark { get; init; } = 60;
    public int TotalCriticalWatermark { get; init; } = 20;
    public int LeasePerMinute { get; init; } = 120;
    public int LeaseRollingHour { get; init; } = 2_000;
    public long EgressBytesPerMinute { get; init; } = 4 * 1024 * 1024;
    public long EgressBytesRollingHour { get; init; } = 64 * 1024 * 1024;
    public int IpPrefixPerMinute { get; init; } = 12;
    public int DevicePerMinute { get; init; } = 10;
    public int SubjectPerMinute { get; init; } = 8;
    public int ActionPerMinute { get; init; } = 30;
    public int ReplenishmentMaxEntries { get; init; } = 64;
    public long ReplenishmentMaxBytes { get; init; } = 2 * 1024 * 1024;
    public HashSet<string> CriticalActions
    {
        get; init;
    } = new(StringComparer.Ordinal)
    {
        "account.recovery",
        "auth.recovery",
        "admin.security"
    };
    public Dictionary<PerceptionCharacterV3ActionClass, PerceptionCharacterV3ResourceDisposition> ExhaustionDispositions
    {
        get; init;
    } = new()
    {
        [PerceptionCharacterV3ActionClass.Comment] = PerceptionCharacterV3ResourceDisposition.QueueForModeration,
        [PerceptionCharacterV3ActionClass.Enrollment] = PerceptionCharacterV3ResourceDisposition.Block,
        [PerceptionCharacterV3ActionClass.AccountRecovery] = PerceptionCharacterV3ResourceDisposition.Block,
        [PerceptionCharacterV3ActionClass.AdminSensitive] = PerceptionCharacterV3ResourceDisposition.Block,
        [PerceptionCharacterV3ActionClass.PublicRead] = PerceptionCharacterV3ResourceDisposition.RequireCheaperProof,
        [PerceptionCharacterV3ActionClass.Other] = PerceptionCharacterV3ResourceDisposition.Unavailable
    };

    public static PerceptionCharacterV3ResourcePlannerOptions FromConfiguration(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection(SectionName);
        var options = new PerceptionCharacterV3ResourcePlannerOptions
        {
            AllocationsEnabled = section.GetValue("AllocationsEnabled", true),
            HighWatermark = section.GetValue("Watermarks:High", 100),
            LowWatermark = section.GetValue("Watermarks:Low", 30),
            CriticalWatermark = section.GetValue("Watermarks:Critical", 10),
            TotalHighWatermark = section.GetValue("Watermarks:TotalHigh", 200),
            TotalLowWatermark = section.GetValue("Watermarks:TotalLow", 60),
            TotalCriticalWatermark = section.GetValue("Watermarks:TotalCritical", 20),
            LeasePerMinute = section.GetValue("Budgets:LeasePerMinute", 120),
            LeaseRollingHour = section.GetValue("Budgets:LeaseRollingHour", 2_000),
            EgressBytesPerMinute = section.GetValue<long>("Budgets:EgressBytesPerMinute", 4 * 1024 * 1024),
            EgressBytesRollingHour = section.GetValue<long>("Budgets:EgressBytesRollingHour", 64 * 1024 * 1024),
            IpPrefixPerMinute = section.GetValue("Quotas:IpPrefixPerMinute", 12),
            DevicePerMinute = section.GetValue("Quotas:DevicePerMinute", 10),
            SubjectPerMinute = section.GetValue("Quotas:SubjectPerMinute", 8),
            ActionPerMinute = section.GetValue("Quotas:ActionPerMinute", 30),
            ReplenishmentMaxEntries = section.GetValue("Replenishment:MaxEntries", 64),
            ReplenishmentMaxBytes = section.GetValue<long>("Replenishment:MaxBytes", 2 * 1024 * 1024),
            CriticalActions = section.GetSection("CriticalActions").GetChildren()
                .Select(child => child.Value?.Trim())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Cast<string>()
                .ToHashSet(StringComparer.Ordinal),
            ExhaustionDispositions = ReadDispositions(section)
        };
        if (options.CriticalActions.Count == 0)
        {
            options.CriticalActions.UnionWith(["account.recovery", "auth.recovery", "admin.security"]);
        }
        options.Validate();
        return options;
    }

    public void Validate()
    {
        if (CriticalWatermark < 0 || LowWatermark <= CriticalWatermark || HighWatermark <= LowWatermark)
            throw new InvalidOperationException("PerceptionCharacterV3 representation watermarks must be non-negative and ordered critical < low < high.");
        if (TotalCriticalWatermark < 0 || TotalLowWatermark <= TotalCriticalWatermark || TotalHighWatermark <= TotalLowWatermark)
            throw new InvalidOperationException("PerceptionCharacterV3 total watermarks must be non-negative and ordered critical < low < high.");
        if (TotalCriticalWatermark < CriticalWatermark || TotalLowWatermark < LowWatermark || TotalHighWatermark < HighWatermark)
            throw new InvalidOperationException("PerceptionCharacterV3 total watermarks cannot be lower than representation watermarks.");
        if (LeasePerMinute <= 0 || LeaseRollingHour < LeasePerMinute ||
            EgressBytesPerMinute <= 0 || EgressBytesRollingHour < EgressBytesPerMinute)
            throw new InvalidOperationException("PerceptionCharacterV3 lease and egress budgets must be positive and hourly budgets cannot be below minute budgets.");
        if (EgressBytesPerMinute < Math.Max(
                PerceptionCharacterV3Contracts.MaxVisualMediaBytes,
                PerceptionCharacterV3Contracts.MaxAudioMediaBytes))
            throw new InvalidOperationException("PerceptionCharacterV3 minute egress budget cannot fit one maximum-size artifact.");
        if (IpPrefixPerMinute <= 0 || DevicePerMinute <= 0 || SubjectPerMinute <= 0 || ActionPerMinute <= 0)
            throw new InvalidOperationException("PerceptionCharacterV3 quota limits must be positive.");
        if (ReplenishmentMaxEntries <= 0 || ReplenishmentMaxBytes <= 0)
            throw new InvalidOperationException("PerceptionCharacterV3 replenishment bounds must be positive.");
        foreach (PerceptionCharacterV3ActionClass actionClass in Enum.GetValues<PerceptionCharacterV3ActionClass>())
        {
            if (!ExhaustionDispositions.TryGetValue(actionClass, out PerceptionCharacterV3ResourceDisposition disposition) ||
                disposition == PerceptionCharacterV3ResourceDisposition.AllocateV3)
                throw new InvalidOperationException($"PerceptionCharacterV3 exhaustion disposition is missing or unsafe for {actionClass}.");
        }
    }

    private static Dictionary<PerceptionCharacterV3ActionClass, PerceptionCharacterV3ResourceDisposition> ReadDispositions(
        IConfigurationSection section)
    {
        var defaults = new PerceptionCharacterV3ResourcePlannerOptions().ExhaustionDispositions;
        var result = new Dictionary<PerceptionCharacterV3ActionClass, PerceptionCharacterV3ResourceDisposition>();
        foreach (PerceptionCharacterV3ActionClass actionClass in Enum.GetValues<PerceptionCharacterV3ActionClass>())
        {
            string? value = section[$"Dispositions:{actionClass}"];
            result[actionClass] = string.IsNullOrWhiteSpace(value)
                ? defaults[actionClass]
                : Enum.TryParse(value, true, out PerceptionCharacterV3ResourceDisposition parsed) &&
                    parsed != PerceptionCharacterV3ResourceDisposition.AllocateV3
                    ? parsed
                    : throw new InvalidOperationException($"PerceptionCharacterV3 disposition for {actionClass} is invalid.");
        }
        return result;
    }
}

public sealed class PerceptionCharacterV3ResourcePlanner : IPerceptionCharacterV3ResourcePlanner, IDisposable
{
    private PerceptionCharacterV3ResourcePlannerOptions _current;
    private readonly IDisposable? _reloadSubscription;

    public PerceptionCharacterV3ResourcePlanner(IConfiguration configuration)
    {
        _current = PerceptionCharacterV3ResourcePlannerOptions.FromConfiguration(configuration);
        _reloadSubscription = ChangeToken.OnChange(
            configuration.GetReloadToken,
            () =>
            {
                try
                {
                    Volatile.Write(
                        ref _current,
                        PerceptionCharacterV3ResourcePlannerOptions.FromConfiguration(configuration));
                }
                catch (InvalidOperationException)
                {
                    // Preserve the last validated snapshot; invalid reload candidates never reach request decisions.
                }
            });
    }

    internal PerceptionCharacterV3ResourcePlanner(PerceptionCharacterV3ResourcePlannerOptions options)
    {
        options.Validate();
        _current = options;
    }

    public void Validate() => CurrentOptions().Validate();

    public void ValidateInventory(PerceptionCharacterV3PoolInventory inventory)
    {
        ArgumentNullException.ThrowIfNull(inventory);
        PerceptionCharacterV3ResourcePlannerOptions options = CurrentOptions();
        int visualCapacity = checked(inventory.VisualReady + inventory.VisualLeased);
        int audioCapacity = checked(inventory.AudioReady + inventory.AudioLeased);
        int totalCapacity = checked(visualCapacity + audioCapacity);
        if (visualCapacity < options.HighWatermark ||
            audioCapacity < options.HighWatermark ||
            totalCapacity < options.TotalHighWatermark)
            throw new InvalidOperationException("PerceptionCharacterV3 active generation cannot satisfy configured high watermarks.");
    }

    public PerceptionCharacterV3ResourcePlannerOptions CurrentOptions() => Volatile.Read(ref _current);

    public void Dispose() => _reloadSubscription?.Dispose();

    public PerceptionCharacterV3ResourceDecision Plan(PerceptionCharacterV3ResourcePlanInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        PerceptionCharacterV3ResourcePlannerOptions options = CurrentOptions();
        PerceptionCharacterV3ActionClass actionClass = Classify(input.Action);
        PerceptionCharacterV3WatermarkState watermark = Watermark(input, options);
        if (!options.AllocationsEnabled)
            return Exhausted(options, actionClass, watermark, "allocations_disabled");
        if (!input.RedisAvailable || !input.Inventory.RedisAvailable)
            return Exhausted(options, actionClass, watermark, "redis_unavailable");
        if (input.Inventory.Revoked)
            return Exhausted(options, actionClass, watermark, "generation_revoked");
        if (input.Inventory.Corrupted)
            return Exhausted(options, actionClass, watermark, "generation_corrupted");
        if (actionClass == PerceptionCharacterV3ActionClass.PublicRead)
            return new(PerceptionCharacterV3ResourceDisposition.RequireCheaperProof, watermark, actionClass, "public_read_does_not_consume_v3");
        if (input.AuthenticatedSession && input.PasskeyAssured && actionClass is PerceptionCharacterV3ActionClass.Enrollment
            or PerceptionCharacterV3ActionClass.AccountRecovery
            or PerceptionCharacterV3ActionClass.AdminSensitive)
            return new(PerceptionCharacterV3ResourceDisposition.UseCredentialStepUp, watermark, actionClass, "credential_assurance_satisfies_policy");
        if (watermark == PerceptionCharacterV3WatermarkState.Empty)
            return Exhausted(options, actionClass, watermark, "pool_empty");
        bool criticalAction = options.CriticalActions.Any(prefix =>
            input.Action.Equals(prefix, StringComparison.Ordinal) ||
            input.Action.StartsWith(prefix + ".", StringComparison.Ordinal));
        if (watermark == PerceptionCharacterV3WatermarkState.Critical && !criticalAction)
            return Exhausted(options, actionClass, watermark, "critical_reserve");
        if (watermark == PerceptionCharacterV3WatermarkState.Low &&
            actionClass is PerceptionCharacterV3ActionClass.Comment or PerceptionCharacterV3ActionClass.Other &&
            input.EscalationLevel < 2)
            return actionClass == PerceptionCharacterV3ActionClass.Comment
                ? new(PerceptionCharacterV3ResourceDisposition.QueueForModeration, watermark, actionClass, "low_watermark_nonessential")
                : new(PerceptionCharacterV3ResourceDisposition.RequireCheaperProof, watermark, actionClass, "low_watermark_nonessential");
        return new(PerceptionCharacterV3ResourceDisposition.AllocateV3, watermark, actionClass, "capacity_available");
    }

    public PerceptionCharacterV3ReplenishmentDecision PlanReplenishment(PerceptionCharacterV3ReplenishmentInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        PerceptionCharacterV3ResourcePlannerOptions options = CurrentOptions();
        if (input.IsPublicRequest)
            return new(false, 0, 0, "public_request_forbidden");
        if (input.CpuPressure || input.MemoryPressure || input.IoPressure || input.LatencyPressure)
            return new(false, 0, 0, "system_pressure");
        if (input.Inventory.Revoked || input.Inventory.Corrupted || !input.Inventory.RedisAvailable)
            return new(false, 0, 0, "pool_unhealthy");
        if (input.Inventory.VisualReady >= options.HighWatermark &&
            input.Inventory.AudioReady >= options.HighWatermark &&
            input.Inventory.TotalReady >= options.TotalHighWatermark)
            return new(false, 0, 0, "high_watermark");
        return new(true, options.ReplenishmentMaxEntries, options.ReplenishmentMaxBytes, "bounded_idle_replenishment");
    }

    public PerceptionCharacterV3ResourceDecision ResolveLeaseFailure(
        PerceptionCharacterV3ResourceDecision planned,
        PerceptionCharacterV3PoolLeaseOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(planned);
        PerceptionCharacterV3ResourcePlannerOptions options = CurrentOptions();
        return outcome switch
        {
            PerceptionCharacterV3PoolLeaseOutcome.LeaseBudgetExhausted or
            PerceptionCharacterV3PoolLeaseOutcome.EgressBudgetExhausted or
            PerceptionCharacterV3PoolLeaseOutcome.IpPrefixQuotaExhausted or
            PerceptionCharacterV3PoolLeaseOutcome.DeviceQuotaExhausted or
            PerceptionCharacterV3PoolLeaseOutcome.SubjectQuotaExhausted or
            PerceptionCharacterV3PoolLeaseOutcome.ActionQuotaExhausted
                => new(PerceptionCharacterV3ResourceDisposition.Throttle, planned.Watermark, planned.ActionClass,
                    outcome.ToString().ToLowerInvariant()),
            PerceptionCharacterV3PoolLeaseOutcome.Empty
                => Exhausted(options, planned.ActionClass, PerceptionCharacterV3WatermarkState.Empty, "pool_empty_race"),
            PerceptionCharacterV3PoolLeaseOutcome.Revoked
                => Exhausted(options, planned.ActionClass, planned.Watermark, "generation_revoked"),
            PerceptionCharacterV3PoolLeaseOutcome.Corrupted
                => Exhausted(options, planned.ActionClass, planned.Watermark, "generation_corrupted"),
            _ => Exhausted(options, planned.ActionClass, planned.Watermark, "pool_unavailable")
        };
    }

    public static PerceptionCharacterV3ActionClass Classify(string action)
    {
        string normalized = action?.Trim().ToLowerInvariant() ?? string.Empty;
        if (normalized.StartsWith("comment.", StringComparison.Ordinal))
            return PerceptionCharacterV3ActionClass.Comment;
        if (normalized.Contains("enroll", StringComparison.Ordinal) || normalized.Contains("register", StringComparison.Ordinal))
            return PerceptionCharacterV3ActionClass.Enrollment;
        if (normalized.Contains("recovery", StringComparison.Ordinal))
            return PerceptionCharacterV3ActionClass.AccountRecovery;
        if (normalized.StartsWith("admin.", StringComparison.Ordinal))
            return PerceptionCharacterV3ActionClass.AdminSensitive;
        if (normalized.EndsWith(".read", StringComparison.Ordinal) || normalized.StartsWith("public.", StringComparison.Ordinal))
            return PerceptionCharacterV3ActionClass.PublicRead;
        return PerceptionCharacterV3ActionClass.Other;
    }

    private static PerceptionCharacterV3WatermarkState Watermark(
        PerceptionCharacterV3ResourcePlanInput input,
        PerceptionCharacterV3ResourcePlannerOptions options)
    {
        int representationReady = input.Representation == PerceptionCharacterV3Representation.Visual
            ? input.Inventory.VisualReady
            : input.Inventory.AudioReady;
        int totalReady = input.Inventory.TotalReady;
        if (representationReady <= 0 || totalReady <= 0)
            return PerceptionCharacterV3WatermarkState.Empty;
        if (representationReady <= options.CriticalWatermark || totalReady <= options.TotalCriticalWatermark)
            return PerceptionCharacterV3WatermarkState.Critical;
        if (representationReady <= options.LowWatermark || totalReady <= options.TotalLowWatermark)
            return PerceptionCharacterV3WatermarkState.Low;
        if (representationReady >= options.HighWatermark && totalReady >= options.TotalHighWatermark)
            return PerceptionCharacterV3WatermarkState.High;
        return PerceptionCharacterV3WatermarkState.Normal;
    }

    private static PerceptionCharacterV3ResourceDecision Exhausted(
        PerceptionCharacterV3ResourcePlannerOptions options,
        PerceptionCharacterV3ActionClass actionClass,
        PerceptionCharacterV3WatermarkState watermark,
        string reason)
        => new(options.ExhaustionDispositions[actionClass], watermark, actionClass, reason);
}
