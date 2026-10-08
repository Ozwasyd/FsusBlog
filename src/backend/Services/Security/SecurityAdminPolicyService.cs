using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Services.Security;

public sealed class SecurityAdminPolicyService : ISecurityAdminPolicyService
{
    private const int MaxRuntimeEvents = 512;
    private const int MaxRuntimeSnapshots = 512;
    private readonly object _gate = new();
    private readonly ISecurityRandomSource _randomSource;
    private readonly bool _perceptionCharacterV3Enabled;
    private AntiCrawlerPolicySnapshot _currentAntiCrawler;
    private PowPolicySnapshot _currentPow;
    private SecurityRiskPolicy _currentRiskPolicy;
    private PerceptionSealedV2PolicySnapshot _currentPerceptionV2;
    private PolicyCheckpoint? _previous;
    private long _policyBuildCount;

    private sealed record PolicyCheckpoint(
        SecurityRiskPolicy Policy,
        AntiCrawlerPolicySnapshot AntiCrawler,
        PowPolicySnapshot Pow,
        PerceptionSealedV2PolicySnapshot Perception);

    public long PolicyBuildCount => Interlocked.Read(ref _policyBuildCount);

    private PolicyCheckpoint CaptureCheckpoint()
        => new(_currentRiskPolicy, _currentAntiCrawler, _currentPow, _currentPerceptionV2);

    private void RestoreCheckpoint()
    {
        PolicyCheckpoint current = CaptureCheckpoint();
        PolicyCheckpoint rollback = _previous ?? current;
        Volatile.Write(ref _currentAntiCrawler, rollback.AntiCrawler);
        Volatile.Write(ref _currentPow, rollback.Pow);
        Volatile.Write(ref _currentPerceptionV2, rollback.Perception);
        Volatile.Write(ref _currentRiskPolicy, rollback.Policy);
        _previous = current;
    }

    private void PublishPolicy(SecurityRiskPolicy policy)
        => PublishSealedPolicy(policy.Seal());

    private void PublishSealedPolicy(SecurityRiskPolicy policy)
    {
        Volatile.Write(ref _currentRiskPolicy, policy);
        Interlocked.Increment(ref _policyBuildCount);
    }
    private readonly RiskEventRingBuffer _riskEvents = new(MaxRuntimeEvents);
    private readonly Dictionary<string, SecurityRiskSnapshotResponse> _riskSnapshots = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<AntiCrawlerRuleResponse> _rules;
    private readonly List<AntiCrawlerListEntryResponse> _allowlist = [];
    private readonly List<AntiCrawlerListEntryResponse> _blocklist = [];

    public SecurityAdminPolicyService(
        IConfiguration configuration,
        ISecurityRandomSource? randomSource = null)
    {
        _randomSource = randomSource ?? CryptographicSecurityRandomSource.Instance;
        _perceptionCharacterV3Enabled = SecuritySystemModes.IsEnforcing(
            SecuritySystemModes.Normalize(
                configuration["Security:PerceptionCharacterV3:Enabled"]
                ?? SecuritySystemModes.Disabled));
        DateTimeOffset now = DateTimeOffset.UtcNow;
        _currentAntiCrawler = new AntiCrawlerPolicySnapshot(
            CreateSnapshotId("anti-crawler", now),
            now,
            "configuration",
            "startup",
            BuildDefaultAntiCrawlerOptions(configuration));
        _currentPow = new PowPolicySnapshot(
            CreateSnapshotId("pow", now),
            now,
            "configuration",
            "startup",
            BuildDefaultPowOptions(configuration));
        _currentPerceptionV2 = new PerceptionSealedV2PolicySnapshot(
            CreateSnapshotId("perception-v2", now),
            CreateSnapshotId("perception-v2-policy", now),
            now,
            "configuration",
            "startup",
            null,
            BuildDefaultPerceptionV2Options(configuration));
        _currentRiskPolicy = ApplyCurrentRiskControlConfiguration(
            SecurityRiskPolicyFactory.Create(
                new SecurityRiskPolicyInputs(
                    ReadRequiredCurrentRiskMode(configuration),
                    configuration.GetValue("Security:RiskControl:PublicReadChallenge:Enabled", true),
                    configuration.GetValue("Security:RiskControl:MaxRiskScore", 200),
                    _currentPow.Options.Mode,
                    _perceptionCharacterV3Enabled),
                CreateSnapshotId("risk-control", now),
                now),
            configuration,
            now);
        _currentRiskPolicy = ApplyPerceptionV2Projection(_currentRiskPolicy, _currentPerceptionV2, now).Seal();
        _policyBuildCount = 1;
        _rules =
        [
            CreateRule("fake-crawler", "伪造搜索引擎爬虫", true, "user-agent", "Googlebot|bingbot|Baiduspider|Sogou", "block", 30, "搜索引擎 UA 必须通过 CIDR 或 DNS 验证。", "configuration", now),
            CreateRule("unknown-bot", "未知 bot UA", true, "user-agent", "bot|spider|crawler", "block", 15, "未知 bot 默认进入反爬处置。", "configuration", now),
            CreateRule("tool-user-agent", "工具型 User-Agent", true, "user-agent", "python|curl|wget|httpclient|zgrab", "block", 10, "工具型 UA 默认拒绝公开热路径。", "configuration", now),
            CreateRule("social-preview-scope", "社交预览范围保护", true, "path", "/api", "block", 10, "社交预览 bot 不允许访问 API。", "configuration", now)
        ];
    }

    public AntiCrawlerPolicySnapshot Current => Volatile.Read(ref _currentAntiCrawler);

    public PowPolicySnapshot CurrentPow => Volatile.Read(ref _currentPow);

    public SecurityRiskPolicy CurrentRiskPolicy
        => Volatile.Read(ref _currentRiskPolicy);

    public PerceptionSealedV2PolicySnapshot CurrentPerceptionSealedV2
        => Volatile.Read(ref _currentPerceptionV2);

    public SecurityOverviewResponse BuildSecurityOverview(CrawlerRangeStatus ranges, CrawlerRangesAdminStatus syncStatus)
        => new(
            "ok",
            DateTimeOffset.UtcNow,
            BuildAntiCrawlerSummary(ranges, syncStatus),
            BuildPowOverview(),
            BuildRiskOverview());

    public AntiCrawlerOverviewResponse BuildAntiCrawlerOverview(CrawlerRangeStatus ranges, CrawlerRangesAdminStatus syncStatus)
    {
        AntiCrawlerPolicySnapshot policy = Current;
        return new AntiCrawlerOverviewResponse(
            policy,
            BuildAntiCrawlerSummary(ranges, syncStatus),
            syncStatus,
            ListRiskEvents(SecurityRiskSources.AntiCrawler, null, 50),
            ListRules(),
            ListEntries("allow"),
            ListEntries("block"));
    }

    public PowOverviewResponse BuildPowOverview()
    {
        IReadOnlyList<AntiCrawlerRiskEventResponse> events = ListRiskEvents(null, null, MaxRuntimeEvents);
        DateTimeOffset since = DateTimeOffset.UtcNow.AddHours(-1);
        int validationFailures = 0;
        int replayRejects = 0;
        int challengeRequired = 0;
        foreach (AntiCrawlerRiskEventResponse item in events)
        {
            if (item.OccurredAtUtc < since)
            {
                continue;
            }

            if (string.Equals(item.Source, SecurityRiskSources.Pow, StringComparison.OrdinalIgnoreCase))
            {
                if (string.Equals(item.Reason, nameof(SecurityRiskReason.PowInvalid), StringComparison.Ordinal))
                {
                    validationFailures++;
                }
                else if (string.Equals(item.Reason, nameof(SecurityRiskReason.PowReplay), StringComparison.Ordinal))
                {
                    replayRejects++;
                }
            }
            else if (string.Equals(item.Source, SecurityRiskSources.PublicRead, StringComparison.OrdinalIgnoreCase)
                && string.Equals(item.Reason, nameof(SecurityRiskReason.PublicReadChallengeRequired), StringComparison.Ordinal))
            {
                challengeRequired++;
            }
        }

        return new PowOverviewResponse(
            CurrentPow,
            validationFailures,
            replayRejects,
            challengeRequired,
            "registered:/api/binary/auth/pow-challenge");
    }

    public AntiCrawlerPolicySnapshot UpdateAntiCrawlerOptions(AntiCrawlerOptionsUpdateRequest request, string changedBy)
    {
        lock (_gate)
        {
            AntiCrawlerPolicySnapshot current = _currentAntiCrawler;
            AntiCrawlerPolicyOptions next = ApplyAntiCrawlerOptions(current.Options, request);
            DateTimeOffset now = DateTimeOffset.UtcNow;
            var snapshot = new AntiCrawlerPolicySnapshot(
                CreateSnapshotId("anti-crawler", now),
                now,
                NormalizeActor(changedBy),
                NormalizeReason(request.Reason),
                next);
            _previous = CaptureCheckpoint();
            Volatile.Write(ref _currentAntiCrawler, snapshot);
            RefreshSubsystemPolicy(now, request.PublicReadChallengeEnabled);
            return snapshot;
        }
    }

    public AntiCrawlerPolicySnapshot RollbackAntiCrawlerOptions(string changedBy)
    {
        lock (_gate)
        {
            RestoreCheckpoint();
            return Current;
        }
    }

    public PowPolicySnapshot UpdatePowOptions(PowOptionsUpdateRequest request, string changedBy)
    {
        lock (_gate)
        {
            PowPolicySnapshot current = _currentPow;
            PowPolicyOptions next = ApplyPowOptions(current.Options, request);
            DateTimeOffset now = DateTimeOffset.UtcNow;
            var snapshot = new PowPolicySnapshot(
                CreateSnapshotId("pow", now),
                now,
                NormalizeActor(changedBy),
                NormalizeReason(request.Reason),
                next);
            _previous = CaptureCheckpoint();
            Volatile.Write(ref _currentPow, snapshot);
            RefreshSubsystemPolicy(now);
            return snapshot;
        }
    }

    public PowPolicySnapshot RollbackPowOptions(string changedBy)
    {
        lock (_gate)
        {
            RestoreCheckpoint();
            return CurrentPow;
        }
    }

    public SecurityRiskPolicy UpdateRiskControlPolicy(RiskControlPolicyUpdateRequest request, string changedBy)
    {
        if (request.GlobalMode is not null && request.GlobalMode is not (SecuritySystemModes.Disabled or SecuritySystemModes.Observe or SecuritySystemModes.Enforce or SecuritySystemModes.Strict or SecuritySystemModes.Lockdown))
        {
            throw new ArgumentException("Only current catalog risk modes are admitted.", nameof(request));
        }
        if (request.StrictRiskMultiplierPercent is < 100 or > 1000)
        {
            throw new ArgumentException("Current strict risk multiplier must be between 100 and 1000.", nameof(request));
        }
        EnsurePolicyCapability(
            request.PoSpaceV1Enabled == true,
            SecurityChallengeKind.Argon2IdPoSpaceV1,
            RiskActionNames.CommentCreate,
            nameof(request.PoSpaceV1Enabled));
        lock (_gate)
        {
            SecurityRiskPolicy current = _currentRiskPolicy;
            DateTimeOffset now = DateTimeOffset.UtcNow;
            SecurityRiskPolicy snapshot = ApplyRiskControlUpdate(
                current,
                request,
                now,
                NormalizeActor(changedBy));
            snapshot = ApplyPerceptionV2Projection(snapshot, _currentPerceptionV2, now);
            _previous = CaptureCheckpoint();
            PublishPolicy(snapshot);
            return CurrentRiskPolicy;
        }
    }

    public SecurityRiskPolicy RollbackRiskControlPolicy(string changedBy)
    {
        lock (_gate)
        {
            RestoreCheckpoint();
            return CurrentRiskPolicy;
        }
    }

    public PerceptionSealedV2PolicySnapshot UpdatePerceptionSealedV2Policy(PerceptionSealedV2PolicyUpdateRequest request, string changedBy)
    {
        EnsurePolicyCapability(
            request.PoSpaceFallbackEnabled == true,
            SecurityChallengeKind.Argon2IdPoSpaceV1,
            RiskActionNames.CommentCreate,
            nameof(request.PoSpaceFallbackEnabled));
        lock (_gate)
        {
            PerceptionSealedV2PolicySnapshot current = _currentPerceptionV2;
            DateTimeOffset now = DateTimeOffset.UtcNow;
            PerceptionSealedV2PolicyOptions next = ApplyPerceptionV2Options(current.Options, request);
            var snapshot = new PerceptionSealedV2PolicySnapshot(
                CreateSnapshotId("perception-v2", now),
                CreateSnapshotId("perception-v2-policy", now),
                now,
                NormalizeActor(changedBy),
                NormalizeReason(request.Reason),
                current.SnapshotId,
                next);
            _previous = CaptureCheckpoint();
            Volatile.Write(ref _currentPerceptionV2, snapshot);
            PublishPolicy(ApplyPerceptionV2Projection(_currentRiskPolicy, snapshot, now) with
            {
                SnapshotId = CreateSnapshotId("risk-control", now),
                LastKnownGoodSnapshotId = _currentRiskPolicy.SnapshotId
            });
            return snapshot;
        }
    }

    private static void EnsurePolicyCapability(
        bool enabling,
        SecurityChallengeKind kind,
        string action,
        string parameterName)
    {
        if (!enabling)
        {
            return;
        }

        SecurityChallengeCapabilityResolution capability = SecurityChallengeCapabilityCatalog.Resolve(
            kind,
            action,
            SecurityChallengeExecutionMode.Ui);
        if (!capability.PolicyEligible)
        {
            throw new ArgumentException(
                $"Challenge kind '{capability.Capability.WireName}' is not policy eligible: {capability.UnavailableReason}.",
                parameterName);
        }
    }

    internal static void ValidateChallengePolicy(
        SecurityRiskPolicy snapshot,
        bool perceptionCharacterV3Enabled = true)
    {
        ArgumentNullException.ThrowIfNull(snapshot);

        IEnumerable<SecurityRiskActionPolicy> actions = snapshot.ActionOverrides.Values.Prepend(snapshot.DefaultAction);
        foreach (SecurityRiskActionPolicy action in actions)
        {
            IReadOnlyList<string> baseChallenge = [action.ChallengeKind];
            ValidateChallengeSet(baseChallenge, action, perceptionCharacterV3Enabled);

            IReadOnlyList<string> hardChallenge = action.HardChallengeKinds.Count > 0
                ? action.HardChallengeKinds
                : baseChallenge;
            ValidateChallengeSet(hardChallenge, action, perceptionCharacterV3Enabled);

            foreach (SecurityRiskDecisionBand band in action.DecisionBands)
            {
                if (band.Outcome is not (SecurityRiskPolicyOutcomes.Challenge or SecurityRiskPolicyOutcomes.HardChallenge))
                {
                    continue;
                }

                IReadOnlyList<string> bandChallenge = band.ChallengeKinds.Count > 0
                    ? band.ChallengeKinds
                    : band.Outcome == SecurityRiskPolicyOutcomes.HardChallenge
                        ? hardChallenge
                        : baseChallenge;
                ValidateChallengeSet(bandChallenge, action, perceptionCharacterV3Enabled);
            }
        }
    }

    private static void ValidateChallengeSet(
        IReadOnlyList<string> requiredKinds,
        SecurityRiskActionPolicy action,
        bool perceptionCharacterV3Enabled)
    {
        if (requiredKinds.Count is <= 0 or > SecurityChallengeContracts.MaxAssignmentsPerEnvelope)
        {
            throw new ArgumentException(
                $"challenge_set_count_invalid: action '{action.ActionName}' requires between 1 and {SecurityChallengeContracts.MaxAssignmentsPerEnvelope} members.",
                "snapshot");
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string requiredKind in requiredKinds)
        {
            string normalized = (requiredKind ?? string.Empty).Trim();
            if (normalized.Length == 0 || !SecurityChallengeContracts.TryParseKind(normalized, out SecurityChallengeKind parsed))
            {
                throw new ArgumentException(
                    $"challenge_kind_unknown: action '{action.ActionName}' contains an unknown challenge kind.",
                    "snapshot");
            }

            string wireName = SecurityChallengeContracts.ToWireName(parsed);
            if (!string.Equals(normalized, wireName, StringComparison.Ordinal))
            {
                throw new ArgumentException(
                    $"challenge_kind_noncanonical: action '{action.ActionName}' must use canonical kind '{wireName}'.",
                    "snapshot");
            }

            if (!seen.Add(wireName))
            {
                throw new ArgumentException(
                    $"challenge_set_duplicate: action '{action.ActionName}' repeats challenge kind '{wireName}'.",
                    "snapshot");
            }

            if (parsed == SecurityChallengeKind.PerceptionCharacterV3
                && !perceptionCharacterV3Enabled)
            {
                throw new ArgumentException(
                    $"challenge_provider_disabled: action '{action.ActionName}' cannot use '{wireName}' while its runtime provider is disabled.",
                    "snapshot");
            }

            SecurityChallengeCapabilityResolution capability = SecurityChallengeCapabilityCatalog.Resolve(
                parsed,
                action.ActionName,
                SecurityChallengeCapabilityCatalog.ResolveMode(action.ActionName));
            if (!capability.PolicyEligible
                && !RiskActionRegistry.UsesSpecializedStepUp(action.ActionName, parsed))
            {
                throw new ArgumentException(
                    $"challenge_capability_unavailable: action '{action.ActionName}' cannot use '{wireName}': {capability.UnavailableReason}.",
                    "snapshot");
            }
        }
    }

    public PerceptionSealedV2PolicySnapshot RollbackPerceptionSealedV2Policy(string changedBy)
    {
        lock (_gate)
        {
            RestoreCheckpoint();
            return CurrentPerceptionSealedV2;
        }
    }

    public void ApplyAntiCrawlerPolicySnapshot(AntiCrawlerPolicySnapshot snapshot)
    {
        lock (_gate)
        {
            _previous = CaptureCheckpoint();
            Volatile.Write(ref _currentAntiCrawler, snapshot);
            RefreshSubsystemPolicy(snapshot.UpdatedAtUtc, snapshot.Options.PublicReadChallengeEnabled);
        }
    }

    public void ApplyPowPolicySnapshot(PowPolicySnapshot snapshot)
    {
        lock (_gate)
        {
            _previous = CaptureCheckpoint();
            Volatile.Write(ref _currentPow, snapshot);
            RefreshSubsystemPolicy(snapshot.UpdatedAtUtc);
        }
    }

    public void ApplyRiskControlPolicySnapshot(SecurityRiskPolicy snapshot)
    {
        ValidateChallengePolicy(snapshot, _perceptionCharacterV3Enabled);
        SecurityRiskPolicy sealedPolicy = snapshot.Seal();
        if (snapshot.Digest.Length > 0 && !string.Equals(snapshot.Digest, sealedPolicy.Digest, StringComparison.Ordinal))
        {
            throw new ArgumentException("Canonical risk policy digest does not match its current snapshot.", nameof(snapshot));
        }
        lock (_gate)
        {
            _previous = CaptureCheckpoint();
            PublishSealedPolicy(sealedPolicy);
        }
    }

    public void ApplyPerceptionSealedV2PolicySnapshot(PerceptionSealedV2PolicySnapshot snapshot)
    {
        lock (_gate)
        {
            _previous = CaptureCheckpoint();
            Volatile.Write(ref _currentPerceptionV2, snapshot);
            PublishPolicy(ApplyPerceptionV2Projection(_currentRiskPolicy, snapshot, snapshot.UpdatedAtUtc) with
            {
                SnapshotId = CreateSnapshotId("risk-control", snapshot.UpdatedAtUtc),
                LastKnownGoodSnapshotId = _currentRiskPolicy.SnapshotId
            });
        }
    }

    private void RefreshSubsystemPolicy(DateTimeOffset updatedAtUtc, bool? publicReadEnabled = null)
    {
        var modes = new Dictionary<string, string>(_currentRiskPolicy.SubsystemModes, StringComparer.Ordinal)
        {
            [SecurityRiskSources.AntiCrawler] = SecuritySystemModes.Normalize(_currentAntiCrawler.Options.Mode),
            [SecurityRiskSources.Pow] = SecuritySystemModes.Normalize(_currentPow.Options.Mode)
        };
        var actions = new Dictionary<string, SecurityRiskActionPolicy>(_currentRiskPolicy.ActionOverrides, StringComparer.Ordinal);
        ApplySubsystemSwitch(modes, SecurityRiskSources.PublicRead, publicReadEnabled);
        ApplyActionSwitch(actions, _currentRiskPolicy, RiskActionNames.PublicRead, publicReadEnabled);
        PublishPolicy(_currentRiskPolicy with
        {
            ActionOverrides = actions,
            SnapshotId = CreateSnapshotId("risk-control", updatedAtUtc),
            UpdatedAtUtc = updatedAtUtc,
            LastKnownGoodSnapshotId = _currentRiskPolicy.SnapshotId,
            SubsystemModes = modes
        });
    }

    private static string ReadRequiredCurrentRiskMode(IConfiguration configuration)
    {
        string? mode = configuration["Security:RiskControl:GlobalMode"];
        if (mode is not (SecuritySystemModes.Disabled or SecuritySystemModes.Observe or SecuritySystemModes.Enforce or SecuritySystemModes.Strict or SecuritySystemModes.Lockdown))
        {
            throw new ArgumentException("Security:RiskControl:GlobalMode is required and must use a current catalog mode.", nameof(configuration));
        }
        int maximum = configuration.GetValue("Security:RiskControl:MaxRiskScore", 200);
        if (maximum is < 90 or > 2000)
        {
            throw new ArgumentException("Security:RiskControl:MaxRiskScore must be between 90 and 2000.", nameof(configuration));
        }
        return mode;
    }

    private SecurityRiskPolicy ApplyCurrentRiskControlConfiguration(
        SecurityRiskPolicy snapshot,
        IConfiguration configuration,
        DateTimeOffset updatedAtUtc)
    {
        var request = new RiskControlPolicyUpdateRequest(
            ReadConfigurationValue(configuration, "Security:RiskControl:GlobalMode"),
            ReadConfigurationBoolean(configuration, "Security:RiskControl:PoSpaceV1:Enabled"),
            ReadConfigurationBoolean(configuration, "Security:RiskControl:PublicReadChallenge:Enabled"),
            ReadConfigurationBoolean(configuration, "Security:RiskControl:CommentRiskControl:Enabled"),
            ReadConfigurationBoolean(configuration, "Security:RiskControl:AuthRiskControl:Enabled"),
            ReadConfigurationInt(configuration, "Security:RiskControl:StrictRiskMultiplierPercent"),
            "configuration");
        if (configuration.GetSection("RiskControl").Exists()
            || configuration.GetSection("Security:RiskControl").GetChildren().Any(static child =>
                child.Key is not ("GlobalMode" or "MaxRiskScore" or "StrictRiskMultiplierPercent" or "PoSpaceV1" or "PublicReadChallenge" or "CommentRiskControl" or "AuthRiskControl")
                || (child.Key is "PoSpaceV1" or "PublicReadChallenge" or "CommentRiskControl" or "AuthRiskControl")
                    && child.GetChildren().Any(static option => option.Key != "Enabled")))
        {
            throw new ArgumentException("Only the current Security:RiskControl configuration contract is accepted.", nameof(configuration));
        }
        if (request.GlobalMode is not null && request.GlobalMode is not (SecuritySystemModes.Disabled or SecuritySystemModes.Observe or SecuritySystemModes.Enforce or SecuritySystemModes.Strict or SecuritySystemModes.Lockdown))
        {
            throw new ArgumentException("Security:RiskControl:GlobalMode is invalid.", nameof(configuration));
        }
        if (request.StrictRiskMultiplierPercent is < 100 or > 1000)
        {
            throw new ArgumentException("Security:RiskControl:StrictRiskMultiplierPercent must be between 100 and 1000.", nameof(configuration));
        }

        SecurityRiskPolicy updated = ApplyRiskControlUpdate(snapshot, request, updatedAtUtc, "configuration");
        return updated with
        {
            SnapshotId = snapshot.SnapshotId,
            PolicyVersion = snapshot.PolicyVersion,
            LastKnownGoodSnapshotId = snapshot.LastKnownGoodSnapshotId
        };
    }

    private SecurityRiskPolicy ApplyRiskControlUpdate(
        SecurityRiskPolicy current,
        RiskControlPolicyUpdateRequest request,
        DateTimeOffset updatedAtUtc,
        string changedBy)
    {
        string snapshotId = CreateSnapshotId("risk-control", updatedAtUtc);
        string policyVersion = CreateSnapshotId("risk-policy", updatedAtUtc);
        string globalMode = string.IsNullOrWhiteSpace(request.GlobalMode)
            ? SecuritySystemModes.Normalize(current.GlobalMode)
            : SecuritySystemModes.Normalize(request.GlobalMode);
        var subsystemModes = new Dictionary<string, string>(current.SubsystemModes, StringComparer.Ordinal);
        var actionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(current.ActionOverrides, StringComparer.Ordinal);

        ApplySubsystemSwitch(subsystemModes, SecurityRiskSources.PoSpace, request.PoSpaceV1Enabled);
        ApplySubsystemSwitch(subsystemModes, SecurityRiskSources.PublicRead, request.PublicReadChallengeEnabled);
        ApplySubsystemSwitch(subsystemModes, SecurityRiskSources.CommentGovernance, request.CommentRiskControlEnabled);
        ApplySubsystemSwitch(subsystemModes, SecurityRiskSources.Auth, request.AuthRiskControlEnabled);

        ApplyActionSwitch(actionOverrides, current, RiskActionNames.PublicRead, request.PublicReadChallengeEnabled);
        ApplyActionSwitch(actionOverrides, current, RiskActionNames.CommentCreate, request.CommentRiskControlEnabled);
        ApplyActionSwitch(actionOverrides, current, RiskActionNames.CommentReply, request.CommentRiskControlEnabled);
        ApplyActionSwitch(actionOverrides, current, RiskActionNames.AuthLogin, request.AuthRiskControlEnabled);
        ApplyActionSwitch(actionOverrides, current, RiskActionNames.AuthPasskeyBegin, request.AuthRiskControlEnabled);
        ApplyActionSwitch(actionOverrides, current, RiskActionNames.AuthPasskeyComplete, request.AuthRiskControlEnabled);
        ApplyActionSwitch(actionOverrides, current, RiskActionNames.RecoveryKeyVerify, request.AuthRiskControlEnabled);

        return current with
        {
            SnapshotId = snapshotId,
            PolicyVersion = policyVersion,
            UpdatedAtUtc = updatedAtUtc,
            GlobalMode = globalMode,
            StrictRiskMultiplierPercent = Math.Clamp(
                request.StrictRiskMultiplierPercent ?? current.StrictRiskMultiplierPercent,
                100,
                1000),
            LastKnownGoodSnapshotId = current.SnapshotId,
            ActionOverrides = actionOverrides,
            SubsystemModes = subsystemModes
        };
    }

    private static SecurityRiskPolicy ApplyPerceptionV2Projection(
        SecurityRiskPolicy current,
        PerceptionSealedV2PolicySnapshot perception,
        DateTimeOffset updatedAtUtc)
    {
        PerceptionSealedV2PolicyOptions options = perception.Options;
        var subsystemModes = new Dictionary<string, string>(current.SubsystemModes, StringComparer.Ordinal);
        subsystemModes[SecurityRiskSources.PerceptionLocalization] = ToSubsystemMode(options.Enabled && options.LocalizationEnabled);
        subsystemModes[SecurityRiskSources.PerceptionMicroInteraction] = ToSubsystemMode(options.Enabled && options.MicroInteractionEnabled);
        if (options.Enabled && options.PoSpaceFallbackEnabled)
        {
            subsystemModes[SecurityRiskSources.PoSpace] = SecuritySystemModes.Enforce;
        }

        var actionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(current.ActionOverrides.Count, StringComparer.Ordinal);
        foreach (KeyValuePair<string, SecurityRiskActionPolicy> item in current.ActionOverrides)
        {
            actionOverrides[item.Key] = ProjectPerceptionV2Action(item.Value, options);
        }

        return current with
        {
            UpdatedAtUtc = updatedAtUtc,
            DefaultAction = ProjectPerceptionV2Action(current.DefaultAction, options),
            ActionOverrides = actionOverrides,
            SubsystemModes = subsystemModes
        };
    }

    private static SecurityRiskActionPolicy ProjectPerceptionV2Action(
        SecurityRiskActionPolicy action,
        PerceptionSealedV2PolicyOptions options)
    {
        if (!string.Equals(action.DecisionMatrix, SecurityRiskPolicyFactory.PerceptionSealedV2Matrix, StringComparison.Ordinal)
            || action.DecisionBands.Count == 0)
        {
            return action;
        }

        int earlyRejectThreshold = Math.Clamp(options.EarlyRejectThreshold, 60, 90);
        var bands = new List<SecurityRiskDecisionBand>(action.DecisionBands.Count);
        foreach (SecurityRiskDecisionBand band in action.DecisionBands)
        {
            if (string.Equals(band.Outcome, SecurityRiskPolicyOutcomes.Block, StringComparison.Ordinal)
                && band.MaxScore >= 90)
            {
                bands.Add(band with
                {
                    MinScore = earlyRejectThreshold,
                    MaxScore = Math.Max(earlyRejectThreshold, band.MaxScore),
                    Reason = string.IsNullOrWhiteSpace(band.Reason) ? "perception_sealed_v2_block" : band.Reason
                });
                continue;
            }

            if (band.MinScore < earlyRejectThreshold && band.MaxScore >= earlyRejectThreshold)
            {
                int max = Math.Max(band.MinScore, earlyRejectThreshold - 1);
                bands.Add(band with
                {
                    MaxScore = max
                });
                continue;
            }

            bands.Add(band);
        }

        return action with
        {
            DecisionBands = bands,
            Thresholds = action.Thresholds with
            {
                BlockScore = Math.Min(action.Thresholds.BlockScore, earlyRejectThreshold)
            }
        };
    }

    private static string ToSubsystemMode(bool enabled)
        => enabled ? SecuritySystemModes.Enforce : SecuritySystemModes.Disabled;

    private static void ApplySubsystemSwitch(IDictionary<string, string> subsystemModes, string subsystem, bool? enabled)
    {
        if (!enabled.HasValue)
        {
            return;
        }

        subsystemModes[subsystem] = enabled.Value ? SecuritySystemModes.Enforce : SecuritySystemModes.Disabled;
    }

    private static void ApplyActionSwitch(
        IDictionary<string, SecurityRiskActionPolicy> actionOverrides,
        SecurityRiskPolicy current,
        string actionName,
        bool? enabled)
    {
        if (!enabled.HasValue)
        {
            return;
        }

        SecurityRiskActionPolicy action = current.ResolveActionPolicy(actionName);
        actionOverrides[actionName] = action with
        {
            ActionName = actionName,
            ModeOverride = enabled.Value ? null : SecuritySystemModes.Disabled
        };
    }

    public void RecordRiskEvent(AntiCrawlerRiskEventResponse riskEvent)
    {
        AntiCrawlerPolicyOptions options = Current.Options;
        if (string.Equals(riskEvent.Source, SecurityRiskSources.AntiCrawler, StringComparison.OrdinalIgnoreCase)
            && !options.EventPersistenceEnabled)
        {
            return;
        }

        lock (_gate)
        {
            _riskEvents.Add(riskEvent);
        }
    }

    public void UpsertRiskSnapshot(SecurityRiskSnapshotResponse snapshot)
    {
        lock (_gate)
        {
            _riskSnapshots[snapshot.Subject] = snapshot;
            if (_riskSnapshots.Count <= MaxRuntimeSnapshots)
            {
                return;
            }

            string? oldest = _riskSnapshots
                .OrderBy(static item => item.Value.UpdatedAtUtc)
                .Select(static item => item.Key)
                .FirstOrDefault();
            if (!string.IsNullOrEmpty(oldest))
            {
                _riskSnapshots.Remove(oldest);
            }
        }
    }

    public IReadOnlyList<AntiCrawlerRiskEventResponse> ListRiskEvents(string? source = null, string? reason = null, int limit = 100)
    {
        lock (_gate)
        {
            AntiCrawlerRiskEventResponse[] snapshot = _riskEvents.SnapshotNewestFirst();
            int clampedLimit = Math.Clamp(limit, 1, MaxRuntimeEvents);
            bool hasSource = !string.IsNullOrWhiteSpace(source);
            bool hasReason = !string.IsNullOrWhiteSpace(reason);
            var result = new List<AntiCrawlerRiskEventResponse>(Math.Min(clampedLimit, snapshot.Length));
            for (int i = 0; i < snapshot.Length && result.Count < clampedLimit; i++)
            {
                AntiCrawlerRiskEventResponse item = snapshot[i];
                if (hasSource && !string.Equals(item.Source, source, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (hasReason && !string.Equals(item.Reason, reason, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                result.Add(item);
            }

            return result.ToArray();
        }
    }

    public IReadOnlyList<SecurityRiskSnapshotResponse> ListRiskSnapshots(int limit = 100)
    {
        lock (_gate)
        {
            return _riskSnapshots.Values
                .OrderByDescending(static item => item.Score)
                .ThenByDescending(static item => item.UpdatedAtUtc)
                .Take(Math.Clamp(limit, 1, MaxRuntimeSnapshots))
                .ToArray();
        }
    }

    public IReadOnlyList<AntiCrawlerRuleResponse> ListRules()
    {
        lock (_gate)
        {
            return _rules.OrderBy(static item => item.Name, StringComparer.OrdinalIgnoreCase).ToArray();
        }
    }

    public AntiCrawlerRuleResponse AddRule(AntiCrawlerRuleRequest request, string changedBy)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var rule = CreateRule(
            CreateSnapshotId("rule", now),
            NormalizeName(request.Name, "自定义规则"),
            request.Enabled,
            NormalizeMatchType(request.MatchType),
            request.Pattern.Trim(),
            NormalizeRuleAction(request.Action),
            Math.Clamp(request.Score, 0, 100),
            TextHelpers.TrimOrNull(request.Notes),
            NormalizeActor(changedBy),
            now);
        lock (_gate)
        {
            _rules.Add(rule);
        }

        return rule;
    }

    public AntiCrawlerRuleResponse? UpdateRule(string id, AntiCrawlerRuleRequest request, string changedBy)
    {
        lock (_gate)
        {
            int index = _rules.FindIndex(item => string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase));
            if (index < 0)
            {
                return null;
            }

            AntiCrawlerRuleResponse updated = _rules[index] with
            {
                Name = NormalizeName(request.Name, _rules[index].Name),
                Enabled = request.Enabled,
                MatchType = NormalizeMatchType(request.MatchType),
                Pattern = request.Pattern.Trim(),
                Action = NormalizeRuleAction(request.Action),
                Score = Math.Clamp(request.Score, 0, 100),
                Notes = TextHelpers.TrimOrNull(request.Notes),
                UpdatedAtUtc = DateTimeOffset.UtcNow,
                UpdatedBy = NormalizeActor(changedBy)
            };
            _rules[index] = updated;
            return updated;
        }
    }

    public bool DeleteRule(string id)
    {
        lock (_gate)
        {
            return _rules.RemoveAll(item => string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase)) > 0;
        }
    }

    public IReadOnlyList<AntiCrawlerListEntryResponse> ListEntries(string listType)
    {
        List<AntiCrawlerListEntryResponse> source = ResolveList(listType);
        lock (_gate)
        {
            return source.OrderBy(static item => item.Value, StringComparer.OrdinalIgnoreCase).ToArray();
        }
    }

    public AntiCrawlerListEntryResponse AddEntry(string listType, AntiCrawlerListEntryRequest request, string changedBy)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string normalizedType = NormalizeListType(listType);
        var entry = new AntiCrawlerListEntryResponse(
            CreateSnapshotId(normalizedType, now),
            normalizedType,
            request.Value.Trim(),
            NormalizeMatchType(request.Scope),
            TextHelpers.TrimOrNull(request.Reason),
            request.Enabled,
            now,
            NormalizeActor(changedBy));
        List<AntiCrawlerListEntryResponse> list = ResolveList(normalizedType);
        lock (_gate)
        {
            list.Add(entry);
        }

        return entry;
    }

    public bool DeleteEntry(string listType, string id)
    {
        List<AntiCrawlerListEntryResponse> list = ResolveList(listType);
        lock (_gate)
        {
            return list.RemoveAll(item => string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase)) > 0;
        }
    }

    public AntiCrawlerSimulationResult Simulate(AntiCrawlerSimulationRequest request)
    {
        AntiCrawlerPolicySnapshot policy = Current;
        AntiCrawlerPolicyOptions options = policy.Options;
        SecurityRiskPolicy riskPolicy = CurrentRiskPolicy;
        SecurityRiskActionPolicy actionPolicy = riskPolicy.ResolveActionPolicy(RiskActionNames.PublicRead);
        string mode = SecuritySystemModes.Normalize(actionPolicy.ModeOverride ?? riskPolicy.GlobalMode);
        var matchedRules = new List<string>();
        var matchedLists = new List<string>();
        int scoreDelta = 0;
        bool allowlisted = false;
        bool blocklisted = false;

        lock (_gate)
        {
            foreach (AntiCrawlerListEntryResponse entry in _allowlist.Where(static item => item.Enabled))
            {
                if (Matches(entry.Scope, entry.Value, request))
                {
                    allowlisted = true;
                    matchedLists.Add($"allow:{entry.Value}");
                }
            }

            foreach (AntiCrawlerListEntryResponse entry in _blocklist.Where(static item => item.Enabled))
            {
                if (Matches(entry.Scope, entry.Value, request))
                {
                    blocklisted = true;
                    matchedLists.Add($"block:{entry.Value}");
                }
            }

            foreach (AntiCrawlerRuleResponse rule in _rules.Where(static item => item.Enabled))
            {
                if (!Matches(rule.MatchType, rule.Pattern, request))
                {
                    continue;
                }

                matchedRules.Add($"{rule.Name}:{rule.Action}");
                scoreDelta += rule.Score;
                if (string.Equals(rule.Action, "block", StringComparison.OrdinalIgnoreCase))
                {
                    blocklisted = true;
                }
            }
        }

        int resultingRiskScore = Math.Clamp(request.CurrentRiskScore + scoreDelta, 0, riskPolicy.MaxRiskScore);
        bool wouldRequireChallenge = options.PublicReadChallengeEnabled
            && SecuritySystemModes.IsEnforcing(mode)
            && resultingRiskScore >= actionPolicy.Thresholds.ChallengeScore
            && resultingRiskScore < actionPolicy.Thresholds.BlockScore;
        bool wouldBlock = blocklisted
            || (SecuritySystemModes.IsEnforcing(mode) && resultingRiskScore >= actionPolicy.Thresholds.BlockScore);
        string finalAction = ResolveSimulationAction(mode, allowlisted, wouldBlock, wouldRequireChallenge, matchedRules.Count > 0);

        return new AntiCrawlerSimulationResult(
            mode,
            finalAction,
            options.SearchCrawlerVerificationEnabled && IsSearchCrawlerUserAgent(request.UserAgent),
            options.SocialPreviewGuardEnabled && IsSocialPreviewUserAgent(request.UserAgent),
            wouldRequireChallenge,
            wouldBlock,
            scoreDelta,
            resultingRiskScore,
            matchedRules,
            matchedLists,
            options.SecurityChallengeReference);
    }

    private AntiCrawlerOverviewSummary BuildAntiCrawlerSummary(CrawlerRangeStatus ranges, CrawlerRangesAdminStatus syncStatus)
    {
        AntiCrawlerPolicyOptions options = Current.Options;
        DateTimeOffset now = DateTimeOffset.UtcNow;
        DateTimeOffset hour = now.AddHours(-1);
        DateTimeOffset day = now.AddDays(-1);
        IReadOnlyList<AntiCrawlerRiskEventResponse> events = ListRiskEvents(null, null, MaxRuntimeEvents);
        AntiCrawlerSummaryCounters counters = BuildAntiCrawlerSummaryCounters(events, hour, day);
        return new AntiCrawlerOverviewSummary(
            SecuritySystemModes.Normalize(options.Mode),
            SecuritySystemModes.Normalize(options.Mode) != SecuritySystemModes.Disabled,
            SecuritySystemModes.IsEnforcing(options.Mode),
            counters.LastHourEvents,
            counters.LastDayEvents,
            counters.VerifiedCrawlerEvents,
            counters.FakeCrawlerEvents,
            counters.UnknownBotEvents,
            counters.BlockedUserAgentEvents,
            counters.SocialPreviewEvents,
            ListRiskSnapshots(MaxRuntimeSnapshots).Count,
            ranges.Source,
            ranges.GoogleRanges,
            ranges.BingRanges,
            ranges.LastSyncAt,
            syncStatus.NextSyncAt);
    }

    private SecurityRiskOverviewResponse BuildRiskOverview()
    {
        IReadOnlyList<AntiCrawlerRiskEventResponse> events = ListRiskEvents(null, null, MaxRuntimeEvents);
        IReadOnlyList<SecurityRiskSnapshotResponse> snapshots = ListRiskSnapshots(MaxRuntimeSnapshots);
        DateTimeOffset hour = DateTimeOffset.UtcNow.AddHours(-1);
        DateTimeOffset day = DateTimeOffset.UtcNow.AddDays(-1);
        SecurityRiskOverviewCounters counters = BuildRiskOverviewCounters(
            events,
            snapshots,
            hour,
            day,
            CurrentRiskPolicy.ResolveActionPolicy(RiskActionNames.PublicRead).Thresholds.ChallengeScore);
        return new SecurityRiskOverviewResponse(
            counters.LastHourEvents,
            counters.LastDayEvents,
            counters.SubjectCount,
            counters.ChallengeSubjectCount,
            counters.TopReason,
            counters.TopSource);
    }

    private static AntiCrawlerSummaryCounters BuildAntiCrawlerSummaryCounters(
        IReadOnlyList<AntiCrawlerRiskEventResponse> events,
        DateTimeOffset hour,
        DateTimeOffset day)
    {
        var counters = new AntiCrawlerSummaryCounters();
        foreach (AntiCrawlerRiskEventResponse item in events)
        {
            if (item.OccurredAtUtc >= hour)
            {
                counters.LastHourEvents++;
            }

            if (item.OccurredAtUtc < day)
            {
                continue;
            }

            counters.LastDayEvents++;
            if (item.Detail?.Contains("verified_crawler", StringComparison.OrdinalIgnoreCase) == true)
            {
                counters.VerifiedCrawlerEvents++;
            }

            if (item.Detail?.Contains("social_preview", StringComparison.OrdinalIgnoreCase) == true)
            {
                counters.SocialPreviewEvents++;
            }

            if (!string.Equals(item.Source, SecurityRiskSources.AntiCrawler, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (string.Equals(item.Reason, nameof(SecurityRiskReason.FakeCrawler), StringComparison.Ordinal))
            {
                counters.FakeCrawlerEvents++;
            }
            else if (string.Equals(item.Reason, nameof(SecurityRiskReason.UnknownBot), StringComparison.Ordinal))
            {
                counters.UnknownBotEvents++;
            }
            else if (string.Equals(item.Reason, nameof(SecurityRiskReason.BlockedUserAgent), StringComparison.Ordinal))
            {
                counters.BlockedUserAgentEvents++;
            }
        }

        return counters;
    }

    private static SecurityRiskOverviewCounters BuildRiskOverviewCounters(
        IReadOnlyList<AntiCrawlerRiskEventResponse> events,
        IReadOnlyList<SecurityRiskSnapshotResponse> snapshots,
        DateTimeOffset hour,
        DateTimeOffset day,
        int challengeScore)
    {
        var reasonCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        var sourceCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        int lastHourEvents = 0;
        int lastDayEvents = 0;
        foreach (AntiCrawlerRiskEventResponse item in events)
        {
            if (item.OccurredAtUtc >= hour)
            {
                lastHourEvents++;
            }

            if (item.OccurredAtUtc >= day)
            {
                lastDayEvents++;
            }

            IncrementCounter(reasonCounts, item.Reason);
            IncrementCounter(sourceCounts, item.Source);
        }

        int challengeSubjectCount = 0;
        foreach (SecurityRiskSnapshotResponse snapshot in snapshots)
        {
            if (snapshot.Score >= challengeScore)
            {
                challengeSubjectCount++;
            }
        }

        return new SecurityRiskOverviewCounters(
            lastHourEvents,
            lastDayEvents,
            snapshots.Count,
            challengeSubjectCount,
            TopCounterKey(reasonCounts),
            TopCounterKey(sourceCounts));
    }

    private static void IncrementCounter(Dictionary<string, int> counters, string key)
    {
        counters[key] = counters.TryGetValue(key, out int count) ? count + 1 : 1;
    }

    private static string TopCounterKey(Dictionary<string, int> counters)
    {
        string topKey = "none";
        int topCount = 0;
        foreach ((string key, int count) in counters)
        {
            if (count > topCount)
            {
                topKey = key;
                topCount = count;
            }
        }

        return topKey;
    }

    private struct AntiCrawlerSummaryCounters
    {
        public int LastHourEvents;
        public int LastDayEvents;
        public int VerifiedCrawlerEvents;
        public int FakeCrawlerEvents;
        public int UnknownBotEvents;
        public int BlockedUserAgentEvents;
        public int SocialPreviewEvents;
    }

    private readonly record struct SecurityRiskOverviewCounters(
        int LastHourEvents,
        int LastDayEvents,
        int SubjectCount,
        int ChallengeSubjectCount,
        string TopReason,
        string TopSource);

    private sealed class RiskEventRingBuffer(int capacity)
    {
        private readonly AntiCrawlerRiskEventResponse?[] _items = new AntiCrawlerRiskEventResponse[capacity];
        private int _start;
        private int _count;

        public void Add(AntiCrawlerRiskEventResponse item)
        {
            if (_count < _items.Length)
            {
                _items[(_start + _count) % _items.Length] = item;
                _count++;
                return;
            }

            _items[_start] = item;
            _start = (_start + 1) % _items.Length;
        }

        public AntiCrawlerRiskEventResponse[] SnapshotNewestFirst()
        {
            if (_count == 0)
            {
                return [];
            }

            var snapshot = new AntiCrawlerRiskEventResponse[_count];
            for (int i = 0; i < snapshot.Length; i++)
            {
                int index = (_start + _count - 1 - i + _items.Length) % _items.Length;
                snapshot[i] = _items[index]!;
            }

            return snapshot;
        }
    }

    private static AntiCrawlerPolicyOptions BuildDefaultAntiCrawlerOptions(IConfiguration configuration)
    {
        int minInterval = Math.Clamp(ReadInt(configuration, "Security:CrawlerCidrs:MinUpdateIntervalMinutes", 30), 30, 24 * 60);
        int interval = Math.Max(ReadInt(configuration, "Security:CrawlerCidrs:UpdateIntervalMinutes", 1440), minInterval);
        return new AntiCrawlerPolicyOptions(
            SecuritySystemModes.Normalize(configuration["AntiCrawler:Mode"] ?? configuration["Security:AntiCrawler:Mode"]),
            ReadBool(configuration, "AntiCrawler:PublicReadChallengeEnabled", true),
            ReadBool(configuration, "AntiCrawler:SearchCrawlerVerificationEnabled", true),
            ReadBool(configuration, "AntiCrawler:SocialPreviewGuardEnabled", true),
            ReadBool(configuration, "AntiCrawler:RiskScoringEnabled", true),
            ReadBool(configuration, "AntiCrawler:EventPersistenceEnabled", true),
            ReadBool(configuration, "AntiCrawler:DashboardAggregationEnabled", true),
            ReadBool(configuration, "Security:CrawlerCidrs:Enabled", true),
            ReadBool(configuration, "AntiCrawler:IllegalPathHardAbortEnabled", true),
            Math.Clamp(ReadInt(configuration, "Security:Risk:RequireChallengeScore", 50), 1, 1000),
            Math.Clamp(ReadInt(configuration, "Security:Risk:BlockScore", 100), 1, 1000),
            Math.Clamp(ReadInt(configuration, "Security:Risk:MaxRiskScore", 200), 1, 2000),
            Math.Clamp(ReadInt(configuration, "Security:Risk:DefaultRiskTtlSeconds", 600), 30, 86_400),
            Math.Clamp(ReadInt(configuration, "RateLimiting:FixedIpPermitLimit", 100), 1, 100_000),
            Math.Clamp(ReadInt(configuration, "RateLimiting:FixedIpQueueLimit", 2), 0, 10_000),
            Math.Clamp(ReadInt(configuration, "RateLimiting:VerifiedCrawlerFixedIpPermitLimit", 1000), 1, 100_000),
            Math.Clamp(ReadInt(configuration, "RateLimiting:PublicReadPermitLimit", 120), 1, 100_000),
            Math.Clamp(ReadInt(configuration, "RateLimiting:PublicReadQueueLimit", 2), 0, 10_000),
            Math.Clamp(ReadInt(configuration, "RateLimiting:VerifiedCrawlerPublicReadPermitLimit", 1000), 1, 100_000),
            Math.Clamp(ReadInt(configuration, "RateLimiting:SocialPreviewPublicReadPermitLimit", 30), 1, 100_000),
            Math.Clamp(ReadInt(configuration, "RateLimiting:ReadProofPermitLimit", 30), 1, 100_000),
            interval,
            Math.Clamp(ReadInt(configuration, "Security:CrawlerCidrs:InitialDelaySeconds", 0), 0, 3600),
            minInterval,
            NormalizeUrl(
                configuration["Security:CrawlerCidrs:GoogleUrl"],
                "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
                "Security:CrawlerCidrs:GoogleUrl"),
            NormalizeUrl(
                configuration["Security:CrawlerCidrs:BingUrl"],
                "https://www.bing.com/toolbox/bingbot.json",
                "Security:CrawlerCidrs:BingUrl"),
            NormalizeSnapshotPath(configuration["Security:CrawlerCidrs:SnapshotPath"]),
            ReadStringList(configuration, "AntiCrawler:SocialPreviewAllowedPathPrefixes",
            [
                "/",
                "/article/",
                "/assets/",
                "/uploads/",
                "/favicon.ico",
                "/robots.txt"
            ]),
            ReadStringList(configuration, "AntiCrawler:BlockedUserAgentKeywords",
            [
                "python",
                "java",
                "curl",
                "wget",
                "httpclient",
                "axios",
                "go-http-client",
                "censys",
                "zgrab"
            ]),
            "security.pow");
    }

    private static PowPolicyOptions BuildDefaultPowOptions(IConfiguration configuration)
        => new(
            SecuritySystemModes.Normalize(configuration["Pow:Mode"] ?? SecuritySystemModes.Enforce),
            Math.Clamp(ReadInt(configuration, "Pow:DefaultDifficulty", 4), 1, 12),
            ReadBool(configuration, "Pow:AdaptiveDifficultyEnabled", true),
            Math.Clamp(ReadInt(configuration, "Pow:ProofTtlSeconds", 300), 30, 3600),
            ReadBool(configuration, "Pow:ReplayProtectionEnabled", true),
            ReadBool(configuration, "Pow:RiskScoreLinkEnabled", true),
            "/api/binary/auth/pow-challenge",
            "RedisPowService");

    private static PerceptionSealedV2PolicyOptions BuildDefaultPerceptionV2Options(IConfiguration configuration)
        => new(
            ReadBool(configuration, "Security:PerceptionV2:Enabled", true),
            ReadBool(configuration, "Security:PerceptionV2:Localization:Enabled", true),
            ReadBool(configuration, "Security:PerceptionV2:MicroInteraction:Enabled", false),
            ReadBool(configuration, "Security:PerceptionV2:PoSpaceFallback:Enabled", false),
            Math.Clamp(ReadInt(configuration, "Security:PerceptionV2:EarlyRejectThreshold", 90), 60, 90),
            Math.Clamp(ReadInt(configuration, "Security:PerceptionV2:MaxAttempts", 3), 1, 10),
            Math.Clamp(ReadInt(configuration, "Security:PerceptionV2:MinSolveDurationMs", 750), 0, 10_000),
            Math.Clamp(ReadInt(configuration, "Security:PerceptionV2:MaxSolveDurationMs", 60_000), 1_000, 300_000));

    private AntiCrawlerPolicyOptions ApplyAntiCrawlerOptions(AntiCrawlerPolicyOptions current, AntiCrawlerOptionsUpdateRequest request)
    {
        int minInterval = Math.Clamp(request.CidrMinUpdateIntervalMinutes ?? current.CidrMinUpdateIntervalMinutes, 30, 24 * 60);
        int interval = Math.Max(request.CidrUpdateIntervalMinutes ?? current.CidrUpdateIntervalMinutes, minInterval);
        return current with
        {
            Mode = SecuritySystemModes.Normalize(request.Mode ?? current.Mode),
            PublicReadChallengeEnabled = request.PublicReadChallengeEnabled ?? current.PublicReadChallengeEnabled,
            SearchCrawlerVerificationEnabled = request.SearchCrawlerVerificationEnabled ?? current.SearchCrawlerVerificationEnabled,
            SocialPreviewGuardEnabled = request.SocialPreviewGuardEnabled ?? current.SocialPreviewGuardEnabled,
            RiskScoringEnabled = request.RiskScoringEnabled ?? current.RiskScoringEnabled,
            EventPersistenceEnabled = request.EventPersistenceEnabled ?? current.EventPersistenceEnabled,
            DashboardAggregationEnabled = request.DashboardAggregationEnabled ?? current.DashboardAggregationEnabled,
            CidrAutoUpdateEnabled = request.CidrAutoUpdateEnabled ?? current.CidrAutoUpdateEnabled,
            IllegalPathHardAbortEnabled = request.IllegalPathHardAbortEnabled ?? current.IllegalPathHardAbortEnabled,
            RequireChallengeScore = Math.Clamp(request.RequireChallengeScore ?? current.RequireChallengeScore, 1, 1000),
            BlockScore = Math.Clamp(request.BlockScore ?? current.BlockScore, 1, 1000),
            MaxRiskScore = Math.Clamp(request.MaxRiskScore ?? current.MaxRiskScore, 1, 2000),
            DefaultRiskTtlSeconds = Math.Clamp(request.DefaultRiskTtlSeconds ?? current.DefaultRiskTtlSeconds, 30, 86_400),
            FixedIpPermitLimit = Math.Clamp(request.FixedIpPermitLimit ?? current.FixedIpPermitLimit, 1, 100_000),
            FixedIpQueueLimit = Math.Clamp(request.FixedIpQueueLimit ?? current.FixedIpQueueLimit, 0, 10_000),
            VerifiedCrawlerFixedIpPermitLimit = Math.Clamp(request.VerifiedCrawlerFixedIpPermitLimit ?? current.VerifiedCrawlerFixedIpPermitLimit, 1, 100_000),
            PublicReadPermitLimit = Math.Clamp(request.PublicReadPermitLimit ?? current.PublicReadPermitLimit, 1, 100_000),
            PublicReadQueueLimit = Math.Clamp(request.PublicReadQueueLimit ?? current.PublicReadQueueLimit, 0, 10_000),
            VerifiedCrawlerPublicReadPermitLimit = Math.Clamp(request.VerifiedCrawlerPublicReadPermitLimit ?? current.VerifiedCrawlerPublicReadPermitLimit, 1, 100_000),
            SocialPreviewPublicReadPermitLimit = Math.Clamp(request.SocialPreviewPublicReadPermitLimit ?? current.SocialPreviewPublicReadPermitLimit, 1, 100_000),
            ReadProofPermitLimit = Math.Clamp(request.ReadProofPermitLimit ?? current.ReadProofPermitLimit, 1, 100_000),
            CidrUpdateIntervalMinutes = interval,
            CidrInitialDelaySeconds = Math.Clamp(request.CidrInitialDelaySeconds ?? current.CidrInitialDelaySeconds, 0, 3600),
            CidrMinUpdateIntervalMinutes = minInterval,
            GoogleCrawlerRangesUrl = NormalizeUrl(request.GoogleCrawlerRangesUrl, current.GoogleCrawlerRangesUrl, nameof(request.GoogleCrawlerRangesUrl)),
            BingCrawlerRangesUrl = NormalizeUrl(request.BingCrawlerRangesUrl, current.BingCrawlerRangesUrl, nameof(request.BingCrawlerRangesUrl)),
            SnapshotPath = request.SnapshotPath is null ? current.SnapshotPath : NormalizeSnapshotPath(request.SnapshotPath),
            SocialPreviewAllowedPathPrefixes = NormalizePathPrefixes(request.SocialPreviewAllowedPathPrefixes, current.SocialPreviewAllowedPathPrefixes),
            BlockedUserAgentKeywords = NormalizeKeywords(request.BlockedUserAgentKeywords, current.BlockedUserAgentKeywords)
        };
    }

    private static PowPolicyOptions ApplyPowOptions(PowPolicyOptions current, PowOptionsUpdateRequest request)
        => current with
        {
            Mode = SecuritySystemModes.Normalize(request.Mode ?? current.Mode),
            DefaultDifficulty = Math.Clamp(request.DefaultDifficulty ?? current.DefaultDifficulty, 1, 12),
            AdaptiveDifficultyEnabled = request.AdaptiveDifficultyEnabled ?? current.AdaptiveDifficultyEnabled,
            ProofTtlSeconds = Math.Clamp(request.ProofTtlSeconds ?? current.ProofTtlSeconds, 30, 3600),
            ReplayProtectionEnabled = request.ReplayProtectionEnabled ?? current.ReplayProtectionEnabled,
            RiskScoreLinkEnabled = request.RiskScoreLinkEnabled ?? current.RiskScoreLinkEnabled
        };

    private static PerceptionSealedV2PolicyOptions ApplyPerceptionV2Options(
        PerceptionSealedV2PolicyOptions current,
        PerceptionSealedV2PolicyUpdateRequest request)
    {
        int minSolve = Math.Clamp(request.MinSolveDurationMs ?? current.MinSolveDurationMs, 0, 10_000);
        int maxSolve = Math.Clamp(request.MaxSolveDurationMs ?? current.MaxSolveDurationMs, Math.Max(minSolve + 1, 1_000), 300_000);
        return current with
        {
            Enabled = request.Enabled ?? current.Enabled,
            LocalizationEnabled = request.LocalizationEnabled ?? current.LocalizationEnabled,
            MicroInteractionEnabled = request.MicroInteractionEnabled ?? current.MicroInteractionEnabled,
            PoSpaceFallbackEnabled = request.PoSpaceFallbackEnabled ?? current.PoSpaceFallbackEnabled,
            EarlyRejectThreshold = Math.Clamp(request.EarlyRejectThreshold ?? current.EarlyRejectThreshold, 60, 90),
            MaxAttempts = Math.Clamp(request.MaxAttempts ?? current.MaxAttempts, 1, 10),
            MinSolveDurationMs = minSolve,
            MaxSolveDurationMs = maxSolve
        };
    }

    private List<AntiCrawlerListEntryResponse> ResolveList(string listType)
        => NormalizeListType(listType) == "allow" ? _allowlist : _blocklist;

    private static AntiCrawlerRuleResponse CreateRule(
        string id,
        string name,
        bool enabled,
        string matchType,
        string pattern,
        string action,
        int score,
        string? notes,
        string updatedBy,
        DateTimeOffset updatedAt)
        => new(
            id,
            name,
            enabled,
            NormalizeMatchType(matchType),
            pattern,
            NormalizeRuleAction(action),
            Math.Clamp(score, 0, 100),
            notes,
            updatedAt,
            updatedBy);

    private static bool Matches(string matchType, string pattern, AntiCrawlerSimulationRequest request)
    {
        if (string.IsNullOrWhiteSpace(pattern))
        {
            return false;
        }

        string source = NormalizeMatchType(matchType) switch
        {
            "ip" => request.Ip,
            "path" => request.Path,
            "method" => request.Method,
            _ => request.UserAgent
        };
        return source.Contains(pattern, StringComparison.OrdinalIgnoreCase)
            || pattern.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Any(token => source.Contains(token, StringComparison.OrdinalIgnoreCase));
    }

    private static string ResolveSimulationAction(string mode, bool allowlisted, bool wouldBlock, bool wouldRequireChallenge, bool matchedRule)
    {
        if (allowlisted)
        {
            return "allow";
        }

        if (mode == SecuritySystemModes.Disabled)
        {
            return "disabled_allow";
        }

        if (mode == SecuritySystemModes.Observe)
        {
            return matchedRule ? "observe" : "allow";
        }

        if (wouldBlock)
        {
            return "block";
        }

        return wouldRequireChallenge ? "require_challenge" : "allow";
    }

    private static bool IsSearchCrawlerUserAgent(string userAgent)
        => userAgent.Contains("Googlebot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Google-InspectionTool", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("bingbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("msnbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Baiduspider", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Sogou", StringComparison.OrdinalIgnoreCase);

    private static bool IsSocialPreviewUserAgent(string userAgent)
        => userAgent.Contains("Twitterbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("facebookexternalhit", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Discordbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("Slackbot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("TelegramBot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("LinkedInBot", StringComparison.OrdinalIgnoreCase)
            || userAgent.Contains("WhatsApp", StringComparison.OrdinalIgnoreCase);

    private static IReadOnlyList<string> NormalizePathPrefixes(IReadOnlyList<string>? values, IReadOnlyList<string> fallback)
    {
        if (values is null)
        {
            return fallback;
        }

        string[] normalized = values
            .Select(static value => value.Trim())
            .Where(static value => value.Length > 0)
            .Select(static value => value.StartsWith("/", StringComparison.Ordinal) ? value : $"/{value}")
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(64)
            .ToArray();
        return normalized.Length == 0 ? fallback : normalized;
    }

    private static IReadOnlyList<string> NormalizeKeywords(IReadOnlyList<string>? values, IReadOnlyList<string> fallback)
    {
        if (values is null)
        {
            return fallback;
        }

        string[] normalized = values
            .Select(static value => value.Trim())
            .Where(static value => value.Length is > 0 and <= 64)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(128)
            .ToArray();
        return normalized.Length == 0 ? fallback : normalized;
    }

    private static IReadOnlyList<string> ReadStringList(IConfiguration configuration, string key, IReadOnlyList<string> fallback)
    {
        string? value = configuration[key];
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }

        return NormalizeKeywords(value.Split([',', ';', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries), fallback);
    }

    private static string NormalizeUrl(string? value, string fallback, string settingName)
        => CrawlerRangeUrlPolicy.NormalizeOrThrow(value, fallback, settingName);

    private static string NormalizeListType(string value)
        => string.Equals(value, "allow", StringComparison.OrdinalIgnoreCase) ||
           string.Equals(value, "allowlist", StringComparison.OrdinalIgnoreCase)
            ? "allow"
            : "block";

    private static string NormalizeMatchType(string? value)
        => (TextHelpers.LowerTrimmed(value) ?? "user-agent") switch
        {
            "ip" => "ip",
            "path" => "path",
            "method" => "method",
            "ua" => "user-agent",
            "useragent" => "user-agent",
            _ => "user-agent"
        };

    private static string NormalizeRuleAction(string? value)
        => (TextHelpers.LowerTrimmed(value) ?? "observe") switch
        {
            "allow" => "allow",
            "block" => "block",
            "require_challenge" => "require_challenge",
            "challenge" => "require_challenge",
            _ => "observe"
        };

    private static string NormalizeName(string? value, string fallback)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }

        string trimmed = value.Trim();
        return trimmed[..Math.Min(trimmed.Length, 80)];
    }

    private static string? NormalizeSnapshotPath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string normalized = value.Trim().Replace('\\', '/');
        if (normalized.Length > 160
            || Path.IsPathRooted(normalized)
            || normalized.Contains(':', StringComparison.Ordinal))
        {
            throw new ArgumentException("Security:CrawlerCidrs:SnapshotPath must be a relative path under the crawler snapshot data root.");
        }

        string[] segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0
            || segments.Any(static segment => segment is "." or ".."))
        {
            throw new ArgumentException("Security:CrawlerCidrs:SnapshotPath must not contain empty, current, or parent directory segments.");
        }

        return string.Join('/', segments);
    }

    private static string NormalizeActor(string? actor)
        => string.IsNullOrWhiteSpace(actor) ? "system" : actor.Trim();

    private static string? NormalizeReason(string? reason)
        => string.IsNullOrWhiteSpace(reason) ? null : reason.Trim();

    private static int ReadInt(IConfiguration configuration, string key, int fallback)
        => configuration.GetValue<int?>(key) ?? fallback;

    private static bool ReadBool(IConfiguration configuration, string key, bool fallback)
        => configuration.GetValue<bool?>(key) ?? fallback;

    private static string? ReadConfigurationValue(IConfiguration configuration, params string[] keys)
    {
        foreach (string key in keys)
        {
            string? value = configuration[key];
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value.Trim();
            }
        }

        return null;
    }

    private static bool? ReadConfigurationBoolean(IConfiguration configuration, params string[] keys)
    {
        string? value = ReadConfigurationValue(configuration, keys);
        if (value is null)
        {
            return null;
        }

        return bool.TryParse(value, out bool parsed)
            ? parsed
            : throw new ArgumentException("The current risk-control boolean configuration value is invalid.", nameof(configuration));
    }

    private static int? ReadConfigurationInt(IConfiguration configuration, params string[] keys)
    {
        string? value = ReadConfigurationValue(configuration, keys);
        if (value is null)
        {
            return null;
        }

        return int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out int parsed)
            ? parsed
            : throw new ArgumentException("The current risk-control integer configuration value is invalid.", nameof(configuration));
    }

    private string CreateSnapshotId(string prefix, DateTimeOffset timestamp)
        => $"{prefix}-{timestamp:yyyyMMddHHmmssfff}-{Convert.ToHexStringLower(_randomSource.GetBytes(8))}";
}
