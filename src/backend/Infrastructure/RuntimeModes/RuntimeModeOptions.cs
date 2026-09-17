namespace FsusBlog.Server.Infrastructure.RuntimeModes;

public static class FsusRuntimeModes
{
    public const string Single = "single";
    public const string StaticRole = "static-role";
    public const string Adaptive = "adaptive";

    public static bool IsKnown(string? value)
        => value is Single or StaticRole or Adaptive;
}

public static class FsusRuntimeRoles
{
    public const string Web = "web";
    public const string Content = "content";
    public const string Security = "security";
    public const string Audit = "audit";
    public const string Maintenance = "maintenance";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        Web,
        Content,
        Security,
        Audit,
        Maintenance
    };
}

public sealed class RuntimeModeOptions
{
    public const string SectionName = "RuntimeMode";

    public string Mode { get; set; } = FsusRuntimeModes.Single;

    public string[] StaticRoles { get; set; } = [];
}

public sealed record RuntimeModePlan(
    string Mode,
    IReadOnlySet<string> StaticRoles,
    bool ClusterMembershipEnabled,
    bool AdaptiveSchedulerEnabled,
    bool DistributedInvalidationEnabled,
    bool LocalInvocationOnly)
{
    public static RuntimeModePlan FromConfiguration(IConfiguration configuration)
    {
        var options = new RuntimeModeOptions();
        configuration.GetSection(RuntimeModeOptions.SectionName).Bind(options);

        string mode = string.IsNullOrWhiteSpace(options.Mode)
            ? FsusRuntimeModes.Single
            : options.Mode.Trim().ToLowerInvariant();
        if (!FsusRuntimeModes.IsKnown(mode))
        {
            throw new InvalidOperationException($"runtime_mode_invalid:{mode}");
        }

        var roles = new HashSet<string>(StringComparer.Ordinal);
        foreach (string configuredRole in options.StaticRoles ?? [])
        {
            string role = configuredRole.Trim().ToLowerInvariant();
            if (!FsusRuntimeRoles.All.Contains(role))
            {
                throw new InvalidOperationException($"runtime_static_role_invalid:{role}");
            }
            roles.Add(role);
        }
        if (mode == FsusRuntimeModes.StaticRole && roles.Count == 0)
        {
            throw new InvalidOperationException("runtime_static_roles_required");
        }

        return mode switch
        {
            FsusRuntimeModes.Single => new RuntimeModePlan(
                mode, roles, false, false, false, true),
            FsusRuntimeModes.StaticRole => new RuntimeModePlan(
                mode, roles, true, false, true, true),
            FsusRuntimeModes.Adaptive => new RuntimeModePlan(
                mode, roles, true, true, true, true),
            _ => throw new InvalidOperationException($"runtime_mode_invalid:{mode}")
        };
    }
}
