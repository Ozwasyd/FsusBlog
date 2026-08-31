using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Migration;
using FsusBlog.RuntimeRoleObservation;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.RuntimeModes;
using FsusBlog.Server.Infrastructure.SchemaMigration;

using Microsoft.Extensions.Configuration;

return RuntimeRoleObservationHost.Run(args);

internal static class RuntimeRoleObservationHost
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static int Run(string[] args)
    {
        string? output = null;
        string? deploymentObservation = null;
        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] is "--output" or "-o")
            {
                output = args.ElementAtOrDefault(++index)
                    ?? throw new InvalidOperationException("--output requires a path");
            }
            else if (args[index] is "--deployment-observation")
            {
                deploymentObservation = args.ElementAtOrDefault(++index)
                    ?? throw new InvalidOperationException("--deployment-observation requires a path");
            }
            else if (args[index] is "--help" or "-h")
            {
                Console.WriteLine("FsusBlog.RuntimeRoleObservation --deployment-observation <path> --output <path>");
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
        if (string.IsNullOrWhiteSpace(deploymentObservation))
        {
            throw new InvalidOperationException("--deployment-observation is required");
        }

        RuntimeRoleObservation observation = Observe(ReadDeploymentProbe(deploymentObservation));
        string directory = Path.GetDirectoryName(Path.GetFullPath(output))
            ?? throw new InvalidOperationException("output directory is invalid");
        Directory.CreateDirectory(directory);
        File.WriteAllText(output, JsonSerializer.Serialize(observation, s_json) + "\n", new UTF8Encoding(false));
        Console.WriteLine($"[runtime-role-observation] ok output={output} digest={observation.ObservationDigest}");
        return 0;
    }

    private static RuntimeRoleObservation Observe(RuntimeRoleDeploymentProbe deploymentProbe)
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
        OwnershipObservation ownership = deploymentProbe.Ownership;
        SchemaOverlapObservation schemaOverlap = ObserveSchemaOverlap();
        var deploymentAuthority = new DeploymentAuthorityObservation(
            deploymentProbe.Schema,
            deploymentProbe.AuthoritySchema,
            deploymentProbe.AuthorityContentDigest,
            deploymentProbe.SourceDigests,
            deploymentProbe.VolumeTopology,
            deploymentProbe.ObservationDigest);
        var unsigned = new
        {
            Schema = "fsusblog.runtime-role-observation.v2",
            Modes = modes,
            StaticRoleCapabilities = capabilities,
            UnsupportedCombinations = unsupported,
            Ownership = ownership,
            DeploymentAuthority = deploymentAuthority,
            SchemaOverlap = schemaOverlap
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
            deploymentAuthority,
            schemaOverlap,
            digest);
    }

    private static RuntimeRoleDeploymentProbe ReadDeploymentProbe(string path)
    {
        var expectedSources = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["policy"] = "tests/governance/monolithic-distributed-architecture.json",
            ["project"] = "src/backend/FsusBlog.Server.csproj",
            ["dockerfile"] = "ops/docker/FsusBlog.Server.Dockerfile",
            ["productionCompose"] = "ops/docker/docker-compose.production.yml"
        };
        byte[] bytes = File.ReadAllBytes(path);
        using JsonDocument document = JsonDocument.Parse(bytes);
        JsonElement root = document.RootElement;
        string[] actual = root.EnumerateObject().Select(static property => property.Name)
            .Order(StringComparer.Ordinal).ToArray();
        string[] expected =
        [
            "application",
            "authorityContentDigest",
            "authoritySchema",
            "observationDigest",
            "ownership",
            "schema",
            "sourceDigests",
            "volumeTopology"
        ];
        if (!actual.SequenceEqual(expected, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("runtime_role_deployment_observation_fields_invalid");
        }
        string canonical = CanonicalObjectWithout(root, "observationDigest");
        string expectedDigest = "sha256:" + Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        string? observedDigest = root.GetProperty("observationDigest").GetString();
        if (!string.Equals(observedDigest, expectedDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("runtime_role_deployment_observation_digest_mismatch");
        }
        RuntimeRoleDeploymentProbe probe = JsonSerializer.Deserialize<RuntimeRoleDeploymentProbe>(bytes, s_json)
            ?? throw new InvalidOperationException("runtime_role_deployment_observation_invalid");
        if (probe.Schema != "fsusblog.runtime-role-deployment-observation.v1"
            || probe.AuthoritySchema != "fsusblog.monolithic-distributed-architecture.v2"
            || !IsSha256Digest(probe.AuthorityContentDigest, prefixed: true)
            || probe.Ownership.AuthorityState != "closed-current"
            || !probe.Ownership.ClaimEligible
            || probe.Ownership.FailureReasons.Count != 0)
        {
            throw new InvalidOperationException("runtime_role_deployment_observation_not_claim_eligible");
        }
        if (!probe.SourceDigests.Keys.Order(StringComparer.Ordinal)
                .SequenceEqual(expectedSources.Keys.Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            throw new InvalidOperationException("runtime_role_deployment_source_roster_invalid");
        }

        string repositoryRoot = Path.GetFullPath(Directory.GetCurrentDirectory());
        string rootBoundary = repositoryRoot.EndsWith(Path.DirectorySeparatorChar)
            ? repositoryRoot
            : repositoryRoot + Path.DirectorySeparatorChar;
        foreach ((string id, string expectedPath) in expectedSources)
        {
            SourceDigestObservation source = probe.SourceDigests[id];
            if (!string.Equals(source.Path, expectedPath, StringComparison.Ordinal)
                || !IsSha256Digest(source.Digest, prefixed: false))
            {
                throw new InvalidOperationException($"runtime_role_deployment_source_shape_invalid:{id}");
            }
            string absolutePath = Path.GetFullPath(Path.Combine(repositoryRoot, source.Path));
            if (!absolutePath.StartsWith(rootBoundary, StringComparison.Ordinal)
                || !File.Exists(absolutePath))
            {
                throw new InvalidOperationException($"runtime_role_deployment_source_missing:{id}");
            }
            string liveDigest = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(absolutePath)))
                .ToLowerInvariant();
            if (!string.Equals(source.Digest, liveDigest, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"runtime_role_deployment_source_digest_mismatch:{id}");
            }
        }

        string policyPath = Path.Combine(repositoryRoot, expectedSources["policy"]);
        using JsonDocument policyDocument = JsonDocument.Parse(File.ReadAllBytes(policyPath));
        JsonElement policyRoot = policyDocument.RootElement;
        string? policySchema = policyRoot.GetProperty("schema").GetString();
        string? policyContentDigest = policyRoot.GetProperty("contentDigest").GetString();
        string computedPolicyDigest = "sha256:" + Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(CanonicalObjectWithout(policyRoot, "contentDigest")))).ToLowerInvariant();
        if (!string.Equals(policySchema, probe.AuthoritySchema, StringComparison.Ordinal)
            || !string.Equals(policyContentDigest, probe.AuthorityContentDigest, StringComparison.Ordinal)
            || !string.Equals(policyContentDigest, computedPolicyDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("runtime_role_deployment_policy_authority_mismatch");
        }
        return probe;
    }

    private static bool IsSha256Digest(string? value, bool prefixed)
    {
        string candidate = value ?? string.Empty;
        if (prefixed && candidate.StartsWith("sha256:", StringComparison.Ordinal))
        {
            candidate = candidate[7..];
        }
        else if (prefixed)
        {
            return false;
        }
        return candidate.Length == 64 && candidate.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');
    }

    private static SchemaOverlapObservation ObserveSchemaOverlap()
    {
        const string MigrationId = "20260716-pre-runtime-observation-expand";
        var descriptor = new SchemaMigrationDescriptor(
            MigrationId,
            "Observe additive Expand compatibility across blue and green runtimes.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps: []);
        SchemaCompatibilityCoordinate minimum = SchemaCompatibilityCoordinate.ParsePersisted(
            "20260701000000-000000000000");
        SchemaCompatibilityCoordinate maximum = SchemaCompatibilityCoordinate.ParsePersisted(
            "20260731000000-ffffffffffff");
        var metadata = new OnlineSchemaMigrationMetadata(
            MigrationId,
            OnlineSchemaMigrationPhase.Expand,
            new OnlineSchemaCompatibilityWindow(minimum, maximum),
            RequiresExclusiveMode: false,
            Destructive: false,
            OnlineSchemaMigrationRollbackMode.CompatibleCode,
            OnlineSchemaMigrationLockRisk.Low,
            BatchSize: null,
            ResumeTokenName: null,
            IntroducedAtCoordinate: minimum,
            ContractAfterCoordinate: null,
            MinimumRetentionWindow: TimeSpan.Zero,
            Validators: ["n_minus_one_read_write"]);
        var metadataById = new Dictionary<string, OnlineSchemaMigrationMetadata>(StringComparer.Ordinal)
        {
            [MigrationId] = metadata
        };
        var history = new OnlineSchemaMigrationHistorySnapshot(
            MigrationId,
            descriptor.Checksum,
            new DateTimeOffset(2026, 7, 16, 0, 0, 0, TimeSpan.Zero),
            "20260716000000-aaaaaaaaaaaa",
            Succeeded: true);
        var database = new OnlineSchemaDatabaseSnapshot(
            HistoryAvailable: true,
            SchemaCompatibilityCoordinate.ParsePersisted("20260716000000-aaaaaaaaaaaa"),
            [history],
            new Dictionary<string, OnlineSchemaBackfillSnapshot>(StringComparer.Ordinal));
        var window = new OnlineSchemaCompatibilityWindow(minimum, maximum);
        var source = new OnlineSchemaReleaseManifest(
            ReleaseId.Parse("20260720000000-bbbbbbbbbbbb"),
            ReleaseId.Parse("20260719000000-aaaaaaaaaaaa"),
            window);
        var target = new OnlineSchemaReleaseManifest(
            ReleaseId.Parse("20260721000000-cccccccccccc"),
            source.ReleaseId,
            window);
        OnlineSchemaCompatibilityReport sourceReport = OnlineSchemaCompatibilityEvaluator.Evaluate(
            source, database, metadataById);
        OnlineSchemaCompatibilityReport targetReport = OnlineSchemaCompatibilityEvaluator.Evaluate(
            target, database, metadataById);
        var missingExpandDatabase = database with
        {
            History = []
        };
        OnlineSchemaCompatibilityReport missingExpand = OnlineSchemaCompatibilityEvaluator.Evaluate(
            target, missingExpandDatabase, metadataById);

        OnlineSchemaMigrationMetadata contractMetadata = metadata with
        {
            Phase = OnlineSchemaMigrationPhase.Contract,
            Destructive = true,
            RequiresExclusiveMode = true,
            RollbackMode = OnlineSchemaMigrationRollbackMode.BackupRestore,
            ContractAfterCoordinate = SchemaCompatibilityCoordinate.ParsePersisted("20260718000000-aaaaaaaaaaaa"),
            MinimumRetentionWindow = TimeSpan.FromDays(7)
        };
        var unsafeContract = new OnlineSchemaContractEvidence(
            CurrentReleaseUsesOldSchema: false,
            PreviousRollbackReleaseUsesOldSchema: true,
            BackfillComplete: true,
            BackfillVerified: true,
            ObservationStartedAtUtc: new DateTimeOffset(2026, 7, 1, 0, 0, 0, TimeSpan.Zero),
            BackupRestoreVerifiedAtUtc: new DateTimeOffset(2026, 7, 21, 0, 0, 0, TimeSpan.Zero),
            SlotSwitchInProgress: true,
            DestructiveChangeConfirmed: false,
            RollbackManifestSealed: false,
            OldWritesDisabled: false,
            ExclusiveModeEnabled: false);
        IReadOnlyList<string> contractCodes = OnlineSchemaContractGate.Evaluate(
                contractMetadata,
                unsafeContract,
                target.ReleaseId,
                source.ReleaseId,
                new DateTimeOffset(2026, 7, 21, 1, 0, 0, TimeSpan.Zero),
                TimeSpan.FromHours(24))
            .Select(static issue => issue.Code)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] missingCodes = missingExpand.Issues.Select(static issue => issue.Code)
            .Order(StringComparer.Ordinal).ToArray();
        bool eligible = sourceReport.Ready
            && targetReport.Ready
            && missingCodes.Contains("schema_expand_pending", StringComparer.Ordinal)
            && contractCodes.Contains("schema_contract_slot_switch_in_progress", StringComparer.Ordinal)
            && contractCodes.Contains("schema_contract_previous_release_dependency", StringComparer.Ordinal);
        return new SchemaOverlapObservation(
            "fsusblog.online-schema-overlap-observation.v1",
            sourceReport.Status,
            targetReport.Status,
            missingCodes,
            contractCodes,
            eligible ? "observed-in-online-schema-runtime-probe" : "conflict-unknown",
            eligible);
    }

    private static string CanonicalObjectWithout(JsonElement value, string omittedProperty)
    {
        var builder = new StringBuilder();
        builder.Append('{');
        bool first = true;
        foreach (JsonProperty property in value.EnumerateObject()
                     .Where(property => property.Name != omittedProperty)
                     .OrderBy(static property => property.Name, StringComparer.Ordinal))
        {
            if (!first)
            {
                builder.Append(',');
            }
            first = false;
            builder.Append(JsonSerializer.Serialize(property.Name));
            builder.Append(':');
            AppendCanonical(builder, property.Value);
        }
        builder.Append('}');
        return builder.ToString();
    }

    private static void AppendCanonical(StringBuilder builder, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                builder.Append('{');
                bool firstProperty = true;
                foreach (JsonProperty property in value.EnumerateObject().OrderBy(
                             static property => property.Name,
                             StringComparer.Ordinal))
                {
                    if (!firstProperty)
                    {
                        builder.Append(',');
                    }
                    firstProperty = false;
                    builder.Append(JsonSerializer.Serialize(property.Name));
                    builder.Append(':');
                    AppendCanonical(builder, property.Value);
                }
                builder.Append('}');
                break;
            case JsonValueKind.Array:
                builder.Append('[');
                bool firstElement = true;
                foreach (JsonElement element in value.EnumerateArray())
                {
                    if (!firstElement)
                    {
                        builder.Append(',');
                    }
                    firstElement = false;
                    AppendCanonical(builder, element);
                }
                builder.Append(']');
                break;
            default:
                builder.Append(value.GetRawText());
                break;
        }
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
