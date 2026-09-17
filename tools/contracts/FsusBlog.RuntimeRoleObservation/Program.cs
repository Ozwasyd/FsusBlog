using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.RuntimeRoleObservation;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.RuntimeModes;

using Microsoft.Extensions.Configuration;

return RuntimeRoleObservationHost.Run(args);

internal static class RuntimeRoleObservationHost
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static int Run(string[] args)
    {
        string? output = null;
        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] is "--output" or "-o")
            {
                output = args.ElementAtOrDefault(++index)
                    ?? throw new InvalidOperationException("--output requires a path");
            }
            else if (args[index] is "--help" or "-h")
            {
                Console.WriteLine("FsusBlog.RuntimeRoleObservation --output <path>");
                return 0;
            }
            else
            {
                throw new InvalidOperationException($"unknown argument: {args[index]}");
            }
        }
        if (string.IsNullOrWhiteSpace(output))
        {
            throw new InvalidOperationException("--output is required");
        }

        RuntimeRoleObservation observation = Observe();
        string directory = Path.GetDirectoryName(Path.GetFullPath(output))
            ?? throw new InvalidOperationException("output directory is invalid");
        Directory.CreateDirectory(directory);
        File.WriteAllText(output, JsonSerializer.Serialize(observation, s_json) + "\n", new UTF8Encoding(false));
        Console.WriteLine($"[runtime-role-observation] ok output={output} digest={observation.ObservationDigest}");
        return 0;
    }

    private static RuntimeRoleObservation Observe()
    {
        string[] roles = FsusRuntimeRoles.All.Order(StringComparer.Ordinal).ToArray();
        RuntimeModeObservation[] modes =
        [
            ObserveMode(FsusRuntimeModes.Single, []),
            ObserveMode(FsusRuntimeModes.StaticRole, roles),
            ObserveMode(FsusRuntimeModes.Adaptive, [])
        ];
        var capabilities = new SortedDictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (string role in roles)
        {
            IConfiguration configuration = Configuration(FsusRuntimeModes.StaticRole, [role]);
            ClusterMembershipOptions membership = ClusterMembershipOptions.FromConfiguration(
                configuration,
                new FixedTimeProvider());
            capabilities[role] = membership.Capabilities
                .Select(static capability => capability.Value)
                .Order(StringComparer.Ordinal)
                .ToArray();
        }

        UnsupportedCombinationObservation[] unsupported =
        [
            ObserveUnsupported("unknown-mode", Configuration("unsupported", [])),
            ObserveUnsupported("static-role-empty", Configuration(FsusRuntimeModes.StaticRole, [])),
            ObserveUnsupported("static-role-unknown", Configuration(FsusRuntimeModes.StaticRole, ["unknown"]))
        ];
        var ownership = new OwnershipObservation(
            "not-expressed-by-runtime-authority",
            "not-expressed-by-runtime-authority",
            "not-expressed-by-runtime-authority",
            "local-invocation-only",
            "not-expressed-by-runtime-authority",
            "conflict-unknown");
        var unsigned = new
        {
            Schema = "fsusblog.runtime-role-observation.v1",
            Modes = modes,
            StaticRoleCapabilities = capabilities,
            UnsupportedCombinations = unsupported,
            Ownership = ownership
        };
        string canonical = JsonSerializer.Serialize(unsigned, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });
        string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        return new RuntimeRoleObservation(
            unsigned.Schema,
            modes,
            capabilities,
            unsupported,
            ownership,
            digest);
    }

    private static RuntimeModeObservation ObserveMode(string mode, string[] roles)
    {
        RuntimeModePlan plan = RuntimeModePlan.FromConfiguration(Configuration(mode, roles));
        return new RuntimeModeObservation(
            plan.Mode,
            plan.StaticRoles.Order(StringComparer.Ordinal).ToArray(),
            plan.ClusterMembershipEnabled,
            plan.AdaptiveSchedulerEnabled,
            plan.DistributedInvalidationEnabled,
            plan.LocalInvocationOnly,
            plan.Mode == FsusRuntimeModes.StaticRole ? "explicit-required" : "optional-ignored");
    }

    private static UnsupportedCombinationObservation ObserveUnsupported(string id, IConfiguration configuration)
    {
        try
        {
            _ = RuntimeModePlan.FromConfiguration(configuration);
            return new UnsupportedCombinationObservation(id, "unexpectedly-accepted");
        }
        catch (InvalidOperationException error)
        {
            return new UnsupportedCombinationObservation(id, error.Message);
        }
    }

    private static IConfiguration Configuration(string mode, string[] roles)
    {
        var values = new Dictionary<string, string?> { ["RuntimeMode:Mode"] = mode };
        for (int index = 0; index < roles.Length; index++)
        {
            values[$"RuntimeMode:StaticRoles:{index}"] = roles[index];
        }
        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }

    private sealed class FixedTimeProvider : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    }
}
