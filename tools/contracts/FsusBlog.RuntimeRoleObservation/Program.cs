using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Globalization;

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
            deploymentProbe.Application,
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
        ValidateDeploymentBinding(probe, policyRoot, repositoryRoot, expectedSources);
        return probe;
    }

    private static void ValidateDeploymentBinding(
        RuntimeRoleDeploymentProbe probe,
        JsonElement policy,
        string repositoryRoot,
        IReadOnlyDictionary<string, string> expectedSources)
    {
        JsonElement main = policy.GetProperty("mainApplication");
        JsonElement policyOwnership = policy.GetProperty("runtimeRoleOwnership");
        if (probe.Ownership.Process != policyOwnership.GetProperty("process").GetString()
            || probe.Ownership.Container != policyOwnership.GetProperty("container").GetString()
            || probe.Ownership.Service != policyOwnership.GetProperty("service").GetString()
            || probe.Ownership.CoResidency != policyOwnership.GetProperty("coResidency").GetString()
            || probe.Ownership.Separation != policyOwnership.GetProperty("separation").GetString()
            || probe.Ownership.AuthorityState != policyOwnership.GetProperty("authorityState").GetString())
        {
            throw new InvalidOperationException("runtime_role_deployment_ownership_policy_mismatch");
        }

        string[] applicationFields = probe.Application.EnumerateObject()
            .Select(static property => property.Name).Order(StringComparer.Ordinal).ToArray();
        string[] expectedApplicationFields =
        [
            "applicationServiceCount",
            "composeCommandOverride",
            "composeEntrypointOverride",
            "composeService",
            "dockerTarget",
            "effectivePid1",
            "image",
            "pid1Source",
            "processEntrypoint",
            "project",
            "serviceRoster"
        ];
        if (!applicationFields.SequenceEqual(expectedApplicationFields, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("runtime_role_deployment_application_fields_invalid");
        }

        JsonElement application = probe.Application;
        string expectedService = main.GetProperty("composeService").GetString() ?? string.Empty;
        string expectedImage = main.GetProperty("productionImage").GetString() ?? string.Empty;
        string[] expectedEntrypoint = main.GetProperty("productionEntrypoint").EnumerateArray()
            .Select(static value => value.GetString() ?? string.Empty).ToArray();
        string composePath = Path.Combine(repositoryRoot, expectedSources["productionCompose"]);
        string dockerfilePath = Path.Combine(repositoryRoot, expectedSources["dockerfile"]);
        string composeSource = File.ReadAllText(composePath);
        string dockerfileSource = File.ReadAllText(dockerfilePath);
        string[] actualServices = ReadComposeServices(composeSource);
        string[] policyServices = policy.GetProperty("composeServices")
            .GetProperty(expectedSources["productionCompose"]).EnumerateObject()
            .Select(static property => property.Name).Order(StringComparer.Ordinal).ToArray();
        if (!actualServices.SequenceEqual(policyServices, StringComparer.Ordinal)
            || application.GetProperty("serviceRoster").EnumerateArray()
                .Select(static value => value.GetString() ?? string.Empty)
                .Order(StringComparer.Ordinal)
                .SequenceEqual(actualServices, StringComparer.Ordinal) is false)
        {
            throw new InvalidOperationException("runtime_role_deployment_service_roster_mismatch");
        }

        string[] dockerEntrypoint = ReadDockerFinalEntrypoint(
            dockerfileSource,
            main.GetProperty("productionTarget").GetString() ?? string.Empty);
        if (dockerEntrypoint.Length == 0
            || !dockerEntrypoint.SequenceEqual(expectedEntrypoint, StringComparer.Ordinal)
            || !application.GetProperty("processEntrypoint").EnumerateArray()
                .Select(static value => value.GetString() ?? string.Empty)
                .SequenceEqual(dockerEntrypoint, StringComparer.Ordinal)
            || !application.GetProperty("effectivePid1").EnumerateArray()
                .Select(static value => value.GetString() ?? string.Empty)
                .SequenceEqual(dockerEntrypoint, StringComparer.Ordinal))
        {
            throw new InvalidOperationException(
                $"runtime_role_deployment_pid1_mismatch:docker={string.Join('|', dockerEntrypoint)};policy={string.Join('|', expectedEntrypoint)}");
        }

        string serviceBody = ReadComposeServiceBody(composeSource, expectedService);
        if (!Regex.IsMatch(serviceBody, $"(?m)^        image: {Regex.Escape(expectedImage)}$")
            || Regex.IsMatch(serviceBody, "(?m)^        (?:entrypoint|command):")
            || application.GetProperty("composeEntrypointOverride").GetString() != "absent"
            || application.GetProperty("composeCommandOverride").GetString() != "absent"
            || application.GetProperty("image").GetString() != expectedImage
            || application.GetProperty("composeService").GetString() != expectedService
            || application.GetProperty("project").GetString() != main.GetProperty("project").GetString()
            || application.GetProperty("dockerTarget").GetString() != main.GetProperty("productionTarget").GetString()
            || application.GetProperty("applicationServiceCount").GetInt32() != 1
            || application.GetProperty("pid1Source").GetString() != "docker-final-entrypoint-no-compose-override")
        {
            throw new InvalidOperationException("runtime_role_deployment_application_source_mismatch");
        }

        if (!string.Equals(
                CanonicalElement(probe.VolumeTopology),
                CanonicalElement(policy.GetProperty("blueGreenMounts")),
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException("runtime_role_deployment_volume_topology_mismatch");
        }
    }

    private static string[] ReadComposeServices(string source)
    {
        var services = new List<string>();
        bool inServices = false;
        foreach (string raw in source.Replace("\r", string.Empty, StringComparison.Ordinal).Split('\n'))
        {
            if (!inServices)
            {
                inServices = raw == "services:";
                continue;
            }
            if (raw.Length > 0 && !char.IsWhiteSpace(raw[0]) && !raw.TrimStart().StartsWith('#'))
            {
                break;
            }
            if (raw.StartsWith("    ", StringComparison.Ordinal)
                && !raw.StartsWith("        ", StringComparison.Ordinal)
                && raw.TrimEnd().EndsWith(':'))
            {
                services.Add(raw.Trim()[..^1]);
            }
        }
        return services.Order(StringComparer.Ordinal).ToArray();
    }

    private static string ReadComposeServiceBody(string source, string service)
    {
        string marker = $"    {service}:";
        var builder = new StringBuilder();
        bool inService = false;
        foreach (string raw in source.Replace("\r", string.Empty, StringComparison.Ordinal).Split('\n'))
        {
            if (!inService)
            {
                inService = raw == marker;
                continue;
            }
            if (raw.StartsWith("    ", StringComparison.Ordinal)
                && !raw.StartsWith("        ", StringComparison.Ordinal)
                && raw.TrimEnd().EndsWith(':'))
            {
                break;
            }
            if (raw.Length > 0 && !char.IsWhiteSpace(raw[0]))
            {
                break;
            }
            builder.AppendLine(raw);
        }
        return builder.ToString();
    }

    private static string[] ReadDockerFinalEntrypoint(string source, string target)
    {
        string? entrypoint = null;
        bool inTarget = false;
        int commandCount = 0;
        foreach (string line in ReadDockerLogicalLines(source))
        {
            Match from = Regex.Match(line, "^FROM\\s+\\S+(?:\\s+AS\\s+(?<target>[A-Za-z0-9_.-]+))?$", RegexOptions.IgnoreCase);
            if (from.Success)
            {
                inTarget = string.Equals(from.Groups["target"].Value, target, StringComparison.OrdinalIgnoreCase);
                continue;
            }
            if (!inTarget)
            {
                continue;
            }
            if (line.StartsWith("ENTRYPOINT ", StringComparison.OrdinalIgnoreCase))
            {
                if (entrypoint is not null)
                {
                    return [];
                }
                entrypoint = line["ENTRYPOINT ".Length..];
            }
            else if (line.StartsWith("CMD ", StringComparison.OrdinalIgnoreCase))
            {
                commandCount++;
            }
        }
        if (entrypoint is null || commandCount != 0)
        {
            return [];
        }
        using JsonDocument document = JsonDocument.Parse(entrypoint);
        return document.RootElement.EnumerateArray().Select(static value => value.GetString() ?? string.Empty).ToArray();
    }

    private static IReadOnlyList<string> ReadDockerLogicalLines(string source)
    {
        var lines = new List<string>();
        string current = string.Empty;
        foreach (string raw in source.Replace("\r", string.Empty, StringComparison.Ordinal).Split('\n'))
        {
            string trimmed = raw.Trim();
            if (trimmed.Length == 0 || trimmed.StartsWith('#'))
            {
                continue;
            }
            current = current.Length == 0 ? trimmed : $"{current} {trimmed}";
            if (current.EndsWith('\\'))
            {
                current = current[..^1].TrimEnd();
                continue;
            }
            lines.Add(current);
            current = string.Empty;
        }
        if (current.Length > 0)
        {
            lines.Add(current);
        }
        return lines;
    }

    private static string CanonicalElement(JsonElement element)
    {
        var builder = new StringBuilder();
        AppendCanonical(builder, element);
        return builder.ToString();
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
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = new SchemaMigrationRegistry().GetDescriptors();
        IReadOnlyDictionary<string, OnlineSchemaMigrationMetadata> metadataById =
            new OnlineSchemaMigrationCatalog().GetMetadata();
        string[] descriptorIds = descriptors.Select(static descriptor => descriptor.MigrationId)
            .Order(StringComparer.Ordinal).ToArray();
        string[] metadataIds = metadataById.Keys.Order(StringComparer.Ordinal).ToArray();
        if (!descriptorIds.SequenceEqual(metadataIds, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("runtime_role_schema_manifest_catalog_roster_mismatch");
        }

        OnlineSchemaMigrationMetadata expandMetadata = metadataById.Values
            .Where(static metadata => metadata.Phase == OnlineSchemaMigrationPhase.Expand)
            .OrderByDescending(static metadata => metadata.IntroducedAtCoordinate)
            .First();
        SchemaCompatibilityCoordinate coordinate = expandMetadata.IntroducedAtCoordinate;
        ReleaseId releaseId = CreateCatalogReleaseId(
            coordinate,
            descriptors.Single(descriptor => descriptor.MigrationId == expandMetadata.MigrationId).Checksum);
        DateTimeOffset observedAt = DateTimeOffset.ParseExact(
            releaseId.Value[..14],
            "yyyyMMddHHmmss",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
        var descriptorById = descriptors.ToDictionary(
            static descriptor => descriptor.MigrationId,
            StringComparer.Ordinal);
        OnlineSchemaMigrationHistorySnapshot[] history = metadataById.Values
            .OrderBy(static metadata => metadata.MigrationId, StringComparer.Ordinal)
            .Select(metadata => new OnlineSchemaMigrationHistorySnapshot(
                metadata.MigrationId,
                descriptorById[metadata.MigrationId].Checksum,
                observedAt,
                releaseId.Value,
                Succeeded: true))
            .ToArray();
        var database = new OnlineSchemaDatabaseSnapshot(
            HistoryAvailable: true,
            coordinate,
            history,
            new Dictionary<string, OnlineSchemaBackfillSnapshot>(StringComparer.Ordinal));
        var window = new OnlineSchemaCompatibilityWindow(coordinate, coordinate);
        var source = new OnlineSchemaReleaseManifest(releaseId, releaseId, window);
        var target = new OnlineSchemaReleaseManifest(releaseId, releaseId, window);
        OnlineSchemaCompatibilityReport sourceReport = OnlineSchemaCompatibilityEvaluator.Evaluate(
            source, database, metadataById);
        OnlineSchemaCompatibilityReport targetReport = OnlineSchemaCompatibilityEvaluator.Evaluate(
            target, database, metadataById);
        var missingExpandDatabase = database with
        {
            History = history.Where(entry => entry.MigrationId != expandMetadata.MigrationId).ToArray()
        };
        OnlineSchemaCompatibilityReport missingExpand = OnlineSchemaCompatibilityEvaluator.Evaluate(
            target, missingExpandDatabase, metadataById);

        OnlineSchemaMigrationMetadata contractMetadata = metadataById.Values
            .Where(static metadata => metadata.Phase == OnlineSchemaMigrationPhase.Contract
                && metadata.Destructive
                && metadata.RequiresExclusiveMode
                && metadata.ContractAfterCoordinate is not null)
            .OrderBy(static metadata => metadata.MigrationId, StringComparer.Ordinal)
            .First();
        ReleaseId contractFenceRelease = CreateCatalogReleaseId(
            contractMetadata.ContractAfterCoordinate!.Value,
            descriptorById[contractMetadata.MigrationId].Checksum,
            dayOffset: -1);
        DateTimeOffset contractNow = DateTimeOffset.ParseExact(
            contractFenceRelease.Value[..14],
            "yyyyMMddHHmmss",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal).AddHours(1);
        var unsafeContract = new OnlineSchemaContractEvidence(
            CurrentReleaseUsesOldSchema: true,
            PreviousRollbackReleaseUsesOldSchema: true,
            BackfillComplete: false,
            BackfillVerified: false,
            ObservationStartedAtUtc: null,
            BackupRestoreVerifiedAtUtc: null,
            SlotSwitchInProgress: true,
            DestructiveChangeConfirmed: false,
            RollbackManifestSealed: false,
            OldWritesDisabled: false,
            ExclusiveModeEnabled: false);
        IReadOnlyList<string> contractCodes = OnlineSchemaContractGate.Evaluate(
                contractMetadata,
                unsafeContract,
                contractFenceRelease,
                contractFenceRelease,
                contractNow,
                TimeSpan.FromHours(24))
            .Select(static issue => issue.Code)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] missingCodes = missingExpand.Issues.Select(static issue => issue.Code)
            .Order(StringComparer.Ordinal).ToArray();
        string[] expectedMissingCodes = ["schema_expand_pending"];
        string[] expectedContractCodes =
        [
            "schema_contract_backfill_incomplete",
            "schema_contract_backfill_unverified",
            "schema_contract_backup_restore_stale",
            "schema_contract_confirmation_missing",
            "schema_contract_current_release_dependency",
            "schema_contract_exclusive_mode_missing",
            "schema_contract_observation_window",
            "schema_contract_old_writes_enabled",
            "schema_contract_previous_release_dependency",
            "schema_contract_release_window_open",
            "schema_contract_rollback_manifest_open",
            "schema_contract_slot_switch_in_progress"
        ];
        bool eligible = sourceReport.Ready
            && targetReport.Ready
            && missingCodes.SequenceEqual(expectedMissingCodes, StringComparer.Ordinal)
            && contractCodes.SequenceEqual(expectedContractCodes, StringComparer.Ordinal);
        string manifestDigest = DigestJson(descriptors.OrderBy(static descriptor => descriptor.MigrationId)
            .Select(static descriptor => new
            {
                descriptor.MigrationId,
                descriptor.Checksum,
                Phase = descriptor.Phase.ToString(),
                descriptor.Transactional
            }));
        string catalogDigest = DigestJson(metadataById.OrderBy(static pair => pair.Key)
            .Select(static pair => new
            {
                pair.Key,
                Phase = pair.Value.Phase.ToString(),
                Minimum = pair.Value.Compatibility.MinimumCoordinate.Value,
                Maximum = pair.Value.Compatibility.MaximumCoordinate.Value,
                pair.Value.Destructive,
                pair.Value.RequiresExclusiveMode
            }));
        return new SchemaOverlapObservation(
            "fsusblog.online-schema-overlap-observation.v1",
            "current-manifest-catalog-database-model",
            descriptors.Count,
            metadataById.Count,
            manifestDigest,
            catalogDigest,
            sourceReport.Status,
            targetReport.Status,
            missingCodes,
            contractCodes,
            eligible ? "observed-in-current-schema-manifest-probe" : "conflict-unknown",
            eligible);
    }

    private static string DigestJson<T>(T value)
    {
        string json = JsonSerializer.Serialize(value, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
    }

    private static ReleaseId CreateCatalogReleaseId(
        SchemaCompatibilityCoordinate coordinate,
        string checksum,
        int dayOffset = 0)
    {
        string date = coordinate.Value[..8];
        DateOnly releaseDate = DateOnly.ParseExact(date, "yyyyMMdd", CultureInfo.InvariantCulture).AddDays(dayOffset);
        return ReleaseId.Parse($"{releaseDate:yyyyMMdd}000000-{checksum[..12].ToLowerInvariant()}");
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
