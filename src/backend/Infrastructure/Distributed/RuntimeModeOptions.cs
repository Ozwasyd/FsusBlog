namespace FsusBlog.Server.Infrastructure.Distributed;

public enum RuntimeModeKind
{
    Single = 0,
    StaticRole = 1,
    Adaptive = 2
}

public static class RuntimeModeNames
{
    public const string Single = "single";
    public const string StaticRole = "static-role";
    public const string Adaptive = "adaptive";
}

public sealed class RuntimeModeOptions
{
    public const string SectionName = "Runtime";

    public string Mode { get; set; } = RuntimeModeNames.Single;

    public string[] StaticRoles { get; set; } = [];

    public RuntimeModeKind ResolveMode()
    {
        string normalized = string.IsNullOrWhiteSpace(Mode)
            ? RuntimeModeNames.Single
            : Mode.Trim().ToLowerInvariant();
        return normalized switch
        {
            RuntimeModeNames.Single => RuntimeModeKind.Single,
            RuntimeModeNames.StaticRole => RuntimeModeKind.StaticRole,
            RuntimeModeNames.Adaptive => RuntimeModeKind.Adaptive,
            _ => throw new InvalidOperationException($"Unsupported FsusBlog runtime mode '{Mode}'.")
        };
    }

    public bool ClusterComponentsEnabled => ResolveMode() != RuntimeModeKind.Single;

    public bool AdaptiveSchedulingEnabled => ResolveMode() == RuntimeModeKind.Adaptive;

    public bool IsRoleEnabled(string role)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(role);
        return ResolveMode() switch
        {
            RuntimeModeKind.Single => true,
            RuntimeModeKind.Adaptive => true,
            RuntimeModeKind.StaticRole => StaticRoles.Any(
                configured => string.Equals(configured?.Trim(), role.Trim(), StringComparison.OrdinalIgnoreCase)),
            _ => false
        };
    }
}
