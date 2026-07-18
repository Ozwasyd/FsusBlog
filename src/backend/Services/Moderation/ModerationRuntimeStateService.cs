using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Moderation;

public sealed class ModerationRuntimeStateService(
    IConfiguration configuration,
    IWebHostEnvironment environment) : IModerationRuntimeStateService
{
    private static readonly HashSet<string> s_validGlobalStates = new(StringComparer.Ordinal)
    {
        ModerationGlobalStates.Enabled,
        ModerationGlobalStates.ReadOnly,
        ModerationGlobalStates.DisabledToPending,
        ModerationGlobalStates.DisabledPassThrough,
        ModerationGlobalStates.EmergencyLockdown
    };

    private static readonly HashSet<string> s_validRegionStates = new(StringComparer.Ordinal)
    {
        ModerationRegionStates.Enabled,
        ModerationRegionStates.ManualReviewOnly,
        ModerationRegionStates.NoPublicDisplay,
        ModerationRegionStates.ReadOnly,
        ModerationRegionStates.Disabled
    };

    private static readonly HashSet<string> s_validModelProviders = new(StringComparer.Ordinal)
    {
        AntiSpamModerationProviders.None,
        AntiSpamModerationProviders.BuiltIn
    };

    private static readonly HashSet<string> s_mainlandMandatoryDictionaryIds = new(StringComparer.Ordinal)
    {
        "cn-mainland.political-sensitive",
        "cn-mainland.porn-strict",
        "cn-mainland.public-order",
        "cn-mainland.national-security"
    };

    private readonly Lock _gate = new();
    private ModerationRuntimeSnapshot _snapshot = BuildInitialSnapshot(configuration);
    private ModerationModelRuntimeSnapshot? _previousModel;

    public ModerationRuntimeSnapshot Current => Volatile.Read(ref _snapshot);
    public bool IsModelEnabled => Current.Model.Enabled && Current.GlobalState is not ModerationGlobalStates.DisabledToPending and not ModerationGlobalStates.EmergencyLockdown;
    public ModerationModelRuntimeSnapshot CurrentModel => Current.Model;

    public bool IsDictionaryEnabled(string dictionaryId)
        => !Current.DisabledDictionaryIds.Contains(dictionaryId);

    public string GetGlobalState()
        => Current.GlobalState;

    public string GetRegionState(string region)
    {
        string normalized = NormalizeRegion(region);
        return Current.RegionStates.TryGetValue(normalized, out string? state)
            ? state
            : ModerationRegionStates.Enabled;
    }

    public bool IsRegionPolicyDisabled(string region)
        => GetRegionState(region) == ModerationRegionStates.Disabled;

    public bool ShouldRejectNewComment(string submitRegion, out string publicReason)
    {
        publicReason = string.Empty;
        string global = GetGlobalState();
        if (global is ModerationGlobalStates.ReadOnly or ModerationGlobalStates.EmergencyLockdown)
        {
            publicReason = "评论发布暂时关闭。";
            return true;
        }

        string regionState = GetRegionState(submitRegion);
        if (regionState == ModerationRegionStates.ReadOnly)
        {
            publicReason = "当前地区暂时只允许读取评论。";
            return true;
        }

        return false;
    }

    public bool ShouldForceManualReview(string submitRegion)
    {
        string global = GetGlobalState();
        if (global == ModerationGlobalStates.DisabledToPending)
        {
            return true;
        }

        return GetRegionState(submitRegion) is ModerationRegionStates.ManualReviewOnly or ModerationRegionStates.NoPublicDisplay;
    }

    public bool ShouldHideUntilReviewed(string submitRegion)
    {
        string global = GetGlobalState();
        if (global == ModerationGlobalStates.DisabledToPending)
        {
            return true;
        }

        return GetRegionState(submitRegion) == ModerationRegionStates.NoPublicDisplay;
    }

    public Result<ModerationRuntimeSnapshot> SetGlobalState(string state, string? reason, DateTime? expiresAtUtc, string changedBy)
    {
        string normalized = NormalizeState(state);
        if (!s_validGlobalStates.Contains(normalized))
        {
            return Result<ModerationRuntimeSnapshot>.Failure(ErrorCode.Validation, "moderation_global_state_invalid");
        }

        if (environment.IsProduction()
            && normalized == ModerationGlobalStates.DisabledPassThrough
            && !configuration.GetValue<bool>("Moderation:Runtime:AllowProductionPassThrough"))
        {
            return Result<ModerationRuntimeSnapshot>.Failure(ErrorCode.Forbidden, "disabled_pass_through_rejected_in_production");
        }

        lock (_gate)
        {
            ModerationRuntimeSnapshot next = Current with
            {
                SnapshotId = BuildSnapshotId("runtime", normalized, DateTime.UtcNow),
                GlobalState = normalized,
                ChangedAtUtc = DateTime.UtcNow,
                ChangedBy = NormalizeActor(changedBy),
                Reason = TextHelpers.TrimOrNull(reason),
                ExpiresAtUtc = expiresAtUtc,
                LastError = null
            };
            Volatile.Write(ref _snapshot, next);
            return Result<ModerationRuntimeSnapshot>.Success(next);
        }
    }

    public Result<ModerationRuntimeSnapshot> SetRegionState(string region, string state, string? reason, DateTime? expiresAtUtc, string? confirmPhrase, string changedBy)
    {
        string normalizedRegion = NormalizeRegion(region);
        string normalizedState = NormalizeState(state);
        if (!s_validRegionStates.Contains(normalizedState))
        {
            return Result<ModerationRuntimeSnapshot>.Failure(ErrorCode.Validation, "moderation_region_state_invalid");
        }

        if (normalizedRegion == RegionCodes.MainlandChina)
        {
            if (normalizedState == ModerationRegionStates.Disabled)
            {
                return Result<ModerationRuntimeSnapshot>.Failure(ErrorCode.Forbidden, "cn_mainland_disable_rejected");
            }

            if (normalizedState != ModerationRegionStates.Enabled
                && !string.Equals(confirmPhrase, ModerationRuntimeConfirmPhrases.MainlandChange, StringComparison.Ordinal))
            {
                return Result<ModerationRuntimeSnapshot>.Failure(ErrorCode.Forbidden, "cn_mainland_confirmation_required");
            }
        }

        lock (_gate)
        {
            var regionStates = new Dictionary<string, string>(Current.RegionStates, StringComparer.Ordinal);
            if (normalizedState == ModerationRegionStates.Enabled)
            {
                regionStates.Remove(normalizedRegion);
            }
            else
            {
                regionStates[normalizedRegion] = normalizedState;
            }

            ModerationRuntimeSnapshot next = Current with
            {
                SnapshotId = BuildSnapshotId("region", $"{normalizedRegion}:{normalizedState}", DateTime.UtcNow),
                RegionStates = regionStates,
                ChangedAtUtc = DateTime.UtcNow,
                ChangedBy = NormalizeActor(changedBy),
                Reason = TextHelpers.TrimOrNull(reason),
                ExpiresAtUtc = expiresAtUtc,
                LastError = null
            };
            Volatile.Write(ref _snapshot, next);
            return Result<ModerationRuntimeSnapshot>.Success(next);
        }
    }

    public Result<ModerationRuntimeSnapshot> SetDictionaryState(string dictionaryId, bool enabled, string? reason, string? confirmPhrase, string changedBy)
    {
        string normalizedId = (dictionaryId ?? string.Empty).Trim();
        if (normalizedId.Length == 0)
        {
            return Result<ModerationRuntimeSnapshot>.Failure(ErrorCode.Validation, "moderation_dictionary_id_required");
        }

        if (!enabled
            && s_mainlandMandatoryDictionaryIds.Contains(normalizedId)
            && !string.Equals(confirmPhrase, ModerationRuntimeConfirmPhrases.MainlandChange, StringComparison.Ordinal))
        {
            return Result<ModerationRuntimeSnapshot>.Failure(ErrorCode.Forbidden, "cn_mainland_dictionary_confirmation_required");
        }

        lock (_gate)
        {
            var disabled = new HashSet<string>(Current.DisabledDictionaryIds, StringComparer.Ordinal);
            if (enabled)
            {
                disabled.Remove(normalizedId);
            }
            else
            {
                disabled.Add(normalizedId);
            }

            ModerationRuntimeSnapshot next = Current with
            {
                SnapshotId = BuildSnapshotId("dictionary", $"{normalizedId}:{enabled}", DateTime.UtcNow),
                DisabledDictionaryIds = disabled,
                ChangedAtUtc = DateTime.UtcNow,
                ChangedBy = NormalizeActor(changedBy),
                Reason = TextHelpers.TrimOrNull(reason),
                LastError = null
            };
            Volatile.Write(ref _snapshot, next);
            return Result<ModerationRuntimeSnapshot>.Success(next);
        }
    }

    public Result<ModerationRuntimeSnapshot> ReloadModel(string changedBy)
    {
        lock (_gate)
        {
            Result<ModerationModelRuntimeSnapshot> buildResult = BuildModelSnapshotResult(configuration, NormalizeActor(changedBy));
            if (buildResult.IsFailure)
            {
                return Result<ModerationRuntimeSnapshot>.Failure(buildResult.Error);
            }

            ModerationModelRuntimeSnapshot current = Current.Model;
            ModerationModelRuntimeSnapshot nextModel = buildResult.Value!;
            _previousModel = current;
            ModerationRuntimeSnapshot next = Current with
            {
                SnapshotId = BuildSnapshotId("model-reload", nextModel.ConfigChecksum, DateTime.UtcNow),
                Model = nextModel,
                ChangedAtUtc = DateTime.UtcNow,
                ChangedBy = NormalizeActor(changedBy),
                LastError = null
            };
            Volatile.Write(ref _snapshot, next);
            return Result<ModerationRuntimeSnapshot>.Success(next);
        }
    }

    public Result<ModerationRuntimeSnapshot> SetModelRuntime(bool? enabled, string? provider, string? modelProfile, string? thresholdProfile, string? reason, string changedBy)
    {
        lock (_gate)
        {
            ModerationModelRuntimeSnapshot current = Current.Model;
            string resolvedProvider = string.IsNullOrWhiteSpace(provider) ? current.Provider : NormalizeProvider(provider);
            if (!s_validModelProviders.Contains(resolvedProvider))
            {
                return Result<ModerationRuntimeSnapshot>.Failure(ErrorCode.Validation, "moderation_model_provider_invalid");
            }

            bool nextEnabled = enabled ?? current.Enabled;
            FsusAntiSpamModelRuntimeSnapshot? runtime = current.BuiltInRuntime;
            if (nextEnabled)
            {
                Result<FsusAntiSpamModelRuntimeSnapshot> runtimeResult = runtime is null
                    ? LoadBuiltInRuntime(configuration)
                    : Result<FsusAntiSpamModelRuntimeSnapshot>.Success(runtime);
                if (runtimeResult.IsFailure)
                {
                    return Result<ModerationRuntimeSnapshot>.Failure(runtimeResult.Error);
                }

                runtime = runtimeResult.Value!;
                resolvedProvider = AntiSpamModerationProviders.BuiltIn;
            }

            _previousModel = current;
            ModerationModelRuntimeSnapshot nextModel = current with
            {
                SnapshotId = BuildSnapshotId("model", $"{resolvedProvider}:{enabled?.ToString() ?? "same"}", DateTime.UtcNow),
                Enabled = nextEnabled,
                Provider = resolvedProvider,
                ModelProfile = runtime?.ModelProfile ?? TextHelpers.TrimOrNull(modelProfile) ?? current.ModelProfile,
                ThresholdProfile = TextHelpers.TrimOrNull(thresholdProfile) ?? current.ThresholdProfile,
                ContractVersion = runtime?.ContractVersion ?? current.ContractVersion,
                ConfigChecksum = runtime?.ConfigChecksum ?? BuildChecksum($"{enabled}:{resolvedProvider}:{modelProfile}:{thresholdProfile}:{DateTime.UtcNow:O}"),
                LoadedAtUtc = DateTime.UtcNow,
                LoadedBy = NormalizeActor(changedBy),
                Status = "loaded",
                LastError = null,
                RuntimePath = runtime?.RuntimePath ?? current.RuntimePath,
                RuntimeChannel = runtime?.Channel ?? current.RuntimeChannel,
                BuiltInRuntime = runtime
            };
            ModerationRuntimeSnapshot next = Current with
            {
                SnapshotId = BuildSnapshotId("model-runtime", nextModel.ConfigChecksum, DateTime.UtcNow),
                Model = nextModel,
                ChangedAtUtc = DateTime.UtcNow,
                ChangedBy = NormalizeActor(changedBy),
                Reason = TextHelpers.TrimOrNull(reason),
                LastError = null
            };
            Volatile.Write(ref _snapshot, next);
            return Result<ModerationRuntimeSnapshot>.Success(next);
        }
    }

    public Result<ModerationRuntimeSnapshot> RollbackModel(string changedBy)
    {
        lock (_gate)
        {
            if (_previousModel is null)
            {
                return Result<ModerationRuntimeSnapshot>.Failure(ErrorCode.Conflict, "moderation_model_rollback_snapshot_missing");
            }

            ModerationModelRuntimeSnapshot current = Current.Model;
            ModerationModelRuntimeSnapshot rollback = _previousModel with
            {
                LoadedAtUtc = DateTime.UtcNow,
                LoadedBy = NormalizeActor(changedBy),
                Status = "rolled_back"
            };
            _previousModel = current;
            ModerationRuntimeSnapshot next = Current with
            {
                SnapshotId = BuildSnapshotId("model-rollback", rollback.ConfigChecksum, DateTime.UtcNow),
                Model = rollback,
                ChangedAtUtc = DateTime.UtcNow,
                ChangedBy = NormalizeActor(changedBy),
                LastError = null
            };
            Volatile.Write(ref _snapshot, next);
            return Result<ModerationRuntimeSnapshot>.Success(next);
        }
    }

    private static ModerationRuntimeSnapshot BuildInitialSnapshot(IConfiguration configuration)
    {
        DateTime now = DateTime.UtcNow;
        Result<ModerationModelRuntimeSnapshot> modelResult = BuildModelSnapshotResult(configuration, "startup");
        ModerationModelRuntimeSnapshot model = modelResult.IsSuccess
            ? modelResult.Value!
            : new ModerationModelRuntimeSnapshot(
                BuildSnapshotId("model", "startup-invalid", now),
                false,
                AntiSpamModerationProviders.None,
                AntiSpamModerationProviders.None,
                "default",
                AntiSpamModerationContract.DefaultVersion,
                BuildChecksum($"startup-invalid:{modelResult.Error.Message}"),
                now,
                "startup",
                "invalid",
                800,
                true,
                modelResult.Error.Message,
                null,
                "stable",
                null);
        return new ModerationRuntimeSnapshot(
            BuildSnapshotId("runtime", "initial", now),
            ModerationGlobalStates.Enabled,
            new Dictionary<string, string>(StringComparer.Ordinal),
            new HashSet<string>(StringComparer.Ordinal),
            model,
            now,
            "startup",
            null,
            null,
            modelResult.IsFailure ? modelResult.Error.Message : null);
    }

    private static Result<ModerationModelRuntimeSnapshot> BuildModelSnapshotResult(IConfiguration configuration, string loadedBy)
    {
        bool enabled = configuration.GetValue<bool>("Moderation:AntiSpamModel:Enabled");
        string channel = TextHelpers.TrimOrNull(configuration["Moderation:AntiSpamModel:RuntimeChannel"]) ?? "stable";
        string thresholdProfile = configuration["Moderation:AntiSpamModel:ThresholdProfile"] ?? "default";
        int timeoutMs = Math.Clamp(configuration.GetValue<int?>("Moderation:AntiSpamModel:TimeoutMs") ?? 800, 100, 10_000);
        bool failOpen = configuration.GetValue<bool?>("Moderation:AntiSpamModel:FailOpen") ?? true;
        if (!enabled)
        {
            string checksum = BuildChecksum($"disabled:{channel}:{thresholdProfile}:{timeoutMs}:{failOpen}");
            return Result<ModerationModelRuntimeSnapshot>.Success(new ModerationModelRuntimeSnapshot(
                BuildSnapshotId("model", checksum, DateTime.UtcNow),
                false,
                AntiSpamModerationProviders.BuiltIn,
                configuration["Moderation:AntiSpamModel:ModelProfile"] ?? AntiSpamModerationProviders.BuiltIn,
                thresholdProfile,
                configuration["Moderation:AntiSpamModel:ContractVersion"] ?? AntiSpamModerationContract.DefaultVersion,
                checksum,
                DateTime.UtcNow,
                NormalizeActor(loadedBy),
                "disabled",
                timeoutMs,
                failOpen,
                null,
                configuration["Moderation:AntiSpamModel:RuntimePath"],
                channel,
                null));
        }

        Result<FsusAntiSpamModelRuntimeSnapshot> runtimeResult = LoadBuiltInRuntime(configuration);
        if (runtimeResult.IsFailure)
        {
            return Result<ModerationModelRuntimeSnapshot>.Failure(runtimeResult.Error);
        }

        FsusAntiSpamModelRuntimeSnapshot runtime = runtimeResult.Value!;
        return Result<ModerationModelRuntimeSnapshot>.Success(new ModerationModelRuntimeSnapshot(
            BuildSnapshotId("model", runtime.ConfigChecksum, DateTime.UtcNow),
            true,
            AntiSpamModerationProviders.BuiltIn,
            runtime.ModelProfile,
            thresholdProfile,
            runtime.ContractVersion,
            runtime.ConfigChecksum,
            DateTime.UtcNow,
            NormalizeActor(loadedBy),
            "loaded",
            timeoutMs,
            failOpen,
            null,
            runtime.RuntimePath,
            runtime.Channel,
            runtime));
    }

    private static Result<FsusAntiSpamModelRuntimeSnapshot> LoadBuiltInRuntime(IConfiguration configuration)
        => FsusAntiSpamModelRuntimeLoader.TryLoad(
            configuration["Moderation:AntiSpamModel:RuntimePath"],
            new FsusAntiSpamModelRuntimeLoadOptions(
                configuration.GetValue<bool?>("Moderation:AntiSpamModel:RequireSignature") ?? true,
                configuration["Moderation:AntiSpamModel:TrustedSigningKey"],
                TextHelpers.TrimOrNull(configuration["Moderation:AntiSpamModel:RuntimeChannel"]) ?? "stable"));

    private static string NormalizeRegion(string? region)
        => (region ?? string.Empty).Trim().ToUpperInvariant() switch
        {
            "GLOBAL" => RegionCodes.Global,
            "UNKNOWN" or "" => RegionCodes.Unknown,
            "CN" or "CN-MAINLAND" or "MAINLAND" => RegionCodes.MainlandChina,
            "HK" or "CN-HK" => RegionCodes.HongKong,
            "MO" or "CN-MO" => RegionCodes.Macao,
            "TW" or "CN-TW" => RegionCodes.Taiwan,
            "SG" => RegionCodes.Singapore,
            "US" => RegionCodes.UnitedStates,
            "DE" or "EU-DE" => RegionCodes.Germany,
            "EU" => RegionCodes.EuropeanUnion,
            "JP" => RegionCodes.Japan,
            "KR" => RegionCodes.Korea,
            var value => value.Length is > 0 and <= 64 ? value : RegionCodes.Unknown
        };

    private static string NormalizeState(string? value)
        => TextHelpers.LowerTrimmed(value) ?? string.Empty;

    private static string NormalizeProvider(string? provider)
        => (TextHelpers.LowerTrimmed(provider) ?? AntiSpamModerationProviders.None) switch
        {
            "" => AntiSpamModerationProviders.BuiltIn,
            "builtin" or "built-in" or "fsus-antispammodel" => AntiSpamModerationProviders.BuiltIn,
            "none" or "disabled" => AntiSpamModerationProviders.None,
            var value => value
        };

    private static string NormalizeActor(string? actor)
        => string.IsNullOrWhiteSpace(actor) ? "system" : actor.Trim();

    private static string BuildSnapshotId(string scope, string value, DateTime timestamp)
        => $"moderation-runtime:{scope}:{BuildChecksum($"{value}:{timestamp:O}")[..12]}";

    private static string BuildChecksum(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
