namespace FsusBlog.Shared.Contracts.Security;

public enum SecurityChallengeExecutionMode : byte
{
    Ui = 0,
    Headless = 1
}

public sealed record SecurityChallengeCapability(
    SecurityChallengeKind Kind,
    string WireName,
    bool KindKnown,
    bool ProviderAvailable,
    bool UiExecutorAvailable,
    bool HeadlessExecutorAvailable,
    bool UiHostAvailable,
    bool HeadlessHostAvailable,
    bool Cancellable,
    IReadOnlySet<string> Surfaces);

public sealed record SecurityChallengeCapabilityResolution(
    SecurityChallengeCapability Capability,
    bool ManifestCompatible,
    bool ProviderAvailable,
    bool ExecutorAvailable,
    bool HostAvailable,
    bool PolicyEligible,
    string? UnavailableReason);

/// <summary>
/// Low-information capability manifest shipped with the server and frontend build.
/// It contains no device, identity, token or proof data.
/// </summary>
public static class SecurityChallengeCapabilityCatalog
{
    public const string ManifestVersion = "2026.07.19.1";
    public const string NotificationSubscribeAction = "notification.subscribe";

    public static readonly IReadOnlyList<SecurityChallengeCapability> All =
    [
        Entry(SecurityChallengeKind.Unknown, false, false, false, false, false, false, false),
        Entry(SecurityChallengeKind.Sha256PowV1, true, true, false, true, false, true, false, NotificationSubscribeAction),
        Entry(SecurityChallengeKind.Argon2IdPoSpaceV1, true, true, false, false, false, false, false),
        Entry(SecurityChallengeKind.CaptchaV1, true, true, true, false, true, false, false, "*"),
        Entry(SecurityChallengeKind.HumanReadProofV1, true, true, false, false, false, false, false),
        Entry(SecurityChallengeKind.PasskeyStepUpV1, true, true, false, false, false, false, false),
        Entry(SecurityChallengeKind.AdminPasskeyStepUpV1, true, true, false, false, false, false, false),
        Entry(SecurityChallengeKind.RecoveryKeyProofV1, true, false, false, false, false, false, false),
        Entry(SecurityChallengeKind.AnonymousCredentialProofV1, true, false, false, false, false, false, false),
        Entry(SecurityChallengeKind.ZkAnonymousCommentProofV1, true, false, false, false, false, false, false),
        Entry(SecurityChallengeKind.PerceptionCharacterV2, true, false, true, false, true, false, true, "*"),
        Entry(SecurityChallengeKind.PerceptionLocalizationV2, true, true, true, false, true, false, true, "*"),
        Entry(SecurityChallengeKind.PerceptionMicroInteractionV2, true, true, true, false, true, false, true, "*"),
        Entry(SecurityChallengeKind.PerceptionTextTaskV2, true, true, true, false, true, false, true, "*")
    ];

    private static readonly IReadOnlyDictionary<SecurityChallengeKind, SecurityChallengeCapability> s_byKind =
        All.ToDictionary(static item => item.Kind);

    public static SecurityChallengeCapability Get(SecurityChallengeKind kind)
        => s_byKind.TryGetValue(kind, out SecurityChallengeCapability? capability)
            ? capability
            : s_byKind[SecurityChallengeKind.Unknown];

    public static SecurityChallengeCapabilityResolution Resolve(
        SecurityChallengeKind kind,
        string? action,
        SecurityChallengeExecutionMode mode,
        string? manifestVersion = null,
        bool? providerAvailable = null)
    {
        SecurityChallengeCapability capability = Get(kind);
        bool compatible = string.IsNullOrWhiteSpace(manifestVersion)
            || string.Equals(manifestVersion, ManifestVersion, StringComparison.Ordinal);
        bool provider = providerAvailable ?? capability.ProviderAvailable;
        bool executor = mode == SecurityChallengeExecutionMode.Ui
            ? capability.UiExecutorAvailable
            : capability.HeadlessExecutorAvailable;
        bool surfaceAvailable = capability.Surfaces.Contains("*")
            || capability.Surfaces.Contains((action ?? string.Empty).Trim());
        bool host = surfaceAvailable && (mode == SecurityChallengeExecutionMode.Ui
            ? capability.UiHostAvailable
            : capability.HeadlessHostAvailable);
        bool eligible = capability.KindKnown && provider && compatible && executor && host;
        string? reason = !capability.KindKnown ? "kind_unknown"
            : !provider ? "provider_unavailable"
            : !compatible ? "version_incompatible"
            : !executor ? "executor_unavailable"
            : !host ? "host_unavailable"
            : null;

        return new SecurityChallengeCapabilityResolution(
            capability,
            compatible,
            provider,
            executor,
            host,
            eligible,
            reason);
    }

    public static SecurityChallengeExecutionMode ResolveMode(string? action)
        => string.Equals((action ?? string.Empty).Trim(), NotificationSubscribeAction, StringComparison.Ordinal)
            ? SecurityChallengeExecutionMode.Headless
            : SecurityChallengeExecutionMode.Ui;

    private static SecurityChallengeCapability Entry(
        SecurityChallengeKind kind,
        bool known,
        bool provider,
        bool uiExecutor,
        bool headlessExecutor,
        bool uiHost,
        bool headlessHost,
        bool cancellable,
        params string[] surfaces)
        => new(
            kind,
            SecurityChallengeContracts.ToWireName(kind),
            known,
            provider,
            uiExecutor,
            headlessExecutor,
            uiHost,
            headlessHost,
            cancellable,
            surfaces.ToHashSet(StringComparer.Ordinal));
}
