using System.Collections.Immutable;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.RuntimeRoleObservation;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
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

        string repositoryRoot = Path.GetFullPath(Directory.GetCurrentDirectory());
        string outputPath = ResolveContainedWritableFile(repositoryRoot, output, "output");
        string deploymentObservationPath = ResolveContainedRegularFile(
            repositoryRoot,
            deploymentObservation,
            "deployment-observation",
            allowAbsolute: true);
        CurrentSchemaContractObservation currentSchemaContract = ObserveCurrentSchemaContract();
        RuntimeRoleObservation observation = Observe(ReadDeploymentProbe(deploymentObservationPath), currentSchemaContract);
        string directory = Path.GetDirectoryName(outputPath)
            ?? throw new InvalidOperationException("output directory is invalid");
        Directory.CreateDirectory(directory);
        File.WriteAllText(outputPath, JsonSerializer.Serialize(observation, s_json) + "\n", new UTF8Encoding(false));
        Console.WriteLine($"[runtime-role-observation] ok output={outputPath} digest={observation.ObservationDigest}");
        return 0;
    }

    private static RuntimeRoleObservation Observe(
        RuntimeRoleDeploymentProbe deploymentProbe,
        CurrentSchemaContractObservation currentSchemaContract)
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
        var deploymentAuthority = new DeploymentAuthorityObservation(
            deploymentProbe.Schema,
            deploymentProbe.AuthoritySchema,
            deploymentProbe.AuthorityContentDigest,
            deploymentProbe.SourceDigests,
            deploymentProbe.EffectiveCompose,
            deploymentProbe.Application,
            deploymentProbe.VolumeTopology,
            deploymentProbe.ObservationDigest);
        var unsigned = new
        {
            Schema = "fsusblog.runtime-role-observation.v3",
            Modes = modes,
            StaticRoleCapabilities = capabilities,
            UnsupportedCombinations = unsupported,
            Ownership = ownership,
            DeploymentAuthority = deploymentAuthority,
            CurrentSchemaContract = currentSchemaContract
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
            currentSchemaContract,
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
            "effectiveCompose",
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
        foreach ((string id, string expectedPath) in expectedSources)
        {
            SourceDigestObservation source = probe.SourceDigests[id];
            if (!string.Equals(source.Path, expectedPath, StringComparison.Ordinal)
                || !IsSha256Digest(source.Digest, prefixed: false))
            {
                throw new InvalidOperationException($"runtime_role_deployment_source_shape_invalid:{id}");
            }
            string absolutePath = ResolveContainedRegularFile(repositoryRoot, source.Path, id);
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

    private static string ResolveContainedRegularFile(
        string repositoryRoot,
        string relativePath,
        string label,
        bool allowAbsolute = false)
    {
        string root = Path.GetFullPath(repositoryRoot).TrimEnd(Path.DirectorySeparatorChar);
        string rootPhysical = Path.GetFullPath(
            new DirectoryInfo(root).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? root);
        if (!string.Equals(root, rootPhysical, StringComparison.Ordinal)
            || (!allowAbsolute && Path.IsPathRooted(relativePath)))
        {
            throw new InvalidOperationException($"runtime_role_source_path_not_canonical:{label}");
        }
        string normalizedInput = relativePath.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar);
        string[] rawSegments = normalizedInput.Split(Path.DirectorySeparatorChar);
        int rootSegmentOffset = Path.IsPathRooted(normalizedInput) ? 1 : 0;
        if (rawSegments.Skip(rootSegmentOffset).Any(static segment => segment is "" or "." or ".."))
        {
            throw new InvalidOperationException($"runtime_role_source_path_not_canonical:{label}");
        }
        string candidate = allowAbsolute && Path.IsPathRooted(relativePath)
            ? Path.GetFullPath(normalizedInput)
            : Path.GetFullPath(Path.Combine(root, normalizedInput));
        string relative = Path.GetRelativePath(root, candidate);
        string[] segments = relative.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries);
        if (relative is "." or ".."
            || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || Path.IsPathRooted(relative)
            || relative == ".git"
            || relative.StartsWith($".git{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || segments.Any(static segment => segment is "." or ".."))
        {
            throw new InvalidOperationException($"runtime_role_source_path_not_canonical:{label}");
        }
        string current = root;
        foreach (string segment in segments)
        {
            current = Path.Combine(current, segment);
            FileSystemInfo metadata = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : new FileInfo(current);
            if (metadata.LinkTarget is not null)
            {
                throw new InvalidOperationException($"runtime_role_source_symlink_or_missing:{label}");
            }
            if (!metadata.Exists)
            {
                if (string.Equals(Path.GetFullPath(current), candidate, StringComparison.Ordinal))
                {
                    break;
                }
                continue;
            }
            string physical = Path.GetFullPath(
                metadata.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? metadata.FullName);
            if (!string.Equals(physical, Path.GetFullPath(current), StringComparison.Ordinal)
                || (!physical.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                    && !string.Equals(physical, root, StringComparison.Ordinal)))
            {
                throw new InvalidOperationException($"runtime_role_source_physical_escape:{label}");
            }
        }
        if (!File.Exists(candidate) || new FileInfo(candidate).LinkTarget is not null)
        {
            throw new InvalidOperationException($"runtime_role_source_not_regular:{label}");
        }
        return candidate;
    }

    private static string ResolveContainedWritableFile(
        string repositoryRoot,
        string suppliedPath,
        string label)
    {
        string root = Path.GetFullPath(repositoryRoot).TrimEnd(Path.DirectorySeparatorChar);
        string rootPhysical = Path.GetFullPath(
            new DirectoryInfo(root).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? root);
        if (!string.Equals(root, rootPhysical, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(suppliedPath))
        {
            throw new InvalidOperationException($"runtime_role_output_path_not_canonical:{label}");
        }
        string normalizedInput = suppliedPath.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar);
        string[] rawSegments = normalizedInput.Split(Path.DirectorySeparatorChar);
        int rootSegmentOffset = Path.IsPathRooted(normalizedInput) ? 1 : 0;
        if (rawSegments.Skip(rootSegmentOffset)
            .Any(static segment => segment is "" or "." or ".."))
        {
            throw new InvalidOperationException($"runtime_role_output_path_not_canonical:{label}");
        }
        string candidate = Path.IsPathRooted(normalizedInput)
            ? Path.GetFullPath(normalizedInput)
            : Path.GetFullPath(Path.Combine(root, normalizedInput));
        string relative = Path.GetRelativePath(root, candidate);
        string[] segments = relative.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries);
        if (relative is "." or ".."
            || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || Path.IsPathRooted(relative)
            || relative == ".git"
            || relative.StartsWith($".git{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || segments.Any(static segment => segment is "." or ".."))
        {
            throw new InvalidOperationException($"runtime_role_output_path_not_canonical:{label}");
        }
        string current = root;
        foreach (string segment in segments)
        {
            current = Path.Combine(current, segment);
            FileSystemInfo metadata = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : new FileInfo(current);
            if (metadata.LinkTarget is not null)
            {
                throw new InvalidOperationException($"runtime_role_output_path_symlink:{label}");
            }
            if (!metadata.Exists)
            {
                break;
            }
            string physical = Path.GetFullPath(
                metadata.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? metadata.FullName);
            if (!string.Equals(physical, Path.GetFullPath(current), StringComparison.Ordinal)
                || (!physical.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                    && !string.Equals(physical, root, StringComparison.Ordinal)))
            {
                throw new InvalidOperationException($"runtime_role_output_path_escape:{label}");
            }
        }
        if (Directory.Exists(candidate)
            || (File.Exists(candidate) && new FileInfo(candidate).LinkTarget is not null))
        {
            throw new InvalidOperationException($"runtime_role_output_path_not_regular:{label}");
        }
        return candidate;
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
        string dockerfileSource = File.ReadAllText(dockerfilePath);
        JsonElement liveEffectiveCompose = ObserveEffectiveComposeModel(
            repositoryRoot,
            expectedSources["productionCompose"]);
        if (!string.Equals(
                CanonicalElement(probe.EffectiveCompose),
                CanonicalElement(liveEffectiveCompose),
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException("runtime_role_deployment_effective_compose_mismatch");
        }
        JsonElement allProfileServices = liveEffectiveCompose.GetProperty("allProfileServices");
        JsonElement defaultServices = liveEffectiveCompose.GetProperty("defaultServices");
        string[] actualServices = allProfileServices.EnumerateObject()
            .Select(static property => property.Name).Order(StringComparer.Ordinal).ToArray();
        string[] policyServices = policy.GetProperty("composeServices")
            .GetProperty(expectedSources["productionCompose"]).EnumerateObject()
            .Select(static property => property.Name).Order(StringComparer.Ordinal).ToArray();
        if (!actualServices.SequenceEqual(policyServices, StringComparer.Ordinal)
            || !defaultServices.EnumerateObject().Select(static property => property.Name)
                .Order(StringComparer.Ordinal).SequenceEqual(policyServices, StringComparer.Ordinal)
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

        JsonElement effectiveService = allProfileServices.GetProperty(expectedService);
        if (effectiveService.GetProperty("image").GetString() != expectedImage
            || effectiveService.GetProperty("build").ValueKind != JsonValueKind.Null
            || effectiveService.GetProperty("pullPolicy").GetString() != "always"
            || effectiveService.GetProperty("profiles").GetArrayLength() != 0
            || effectiveService.GetProperty("entrypoint").ValueKind != JsonValueKind.Null
            || effectiveService.GetProperty("command").ValueKind != JsonValueKind.Null
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

    private static JsonElement ObserveEffectiveComposeModel(string repositoryRoot, string sourcePath)
    {
        DockerComposeOracleIdentity oracleIdentity = ResolveDockerComposeOracleIdentity(repositoryRoot);
        JsonElement Project(bool allProfiles)
        {
            var start = new ProcessStartInfo(oracleIdentity.DockerCanonicalPath)
            {
                WorkingDirectory = repositoryRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            start.ArgumentList.Add("compose");
            start.ArgumentList.Add("-f");
            start.ArgumentList.Add(sourcePath);
            if (allProfiles)
            {
                start.ArgumentList.Add("--profile");
                start.ArgumentList.Add("*");
            }
            start.ArgumentList.Add("config");
            start.ArgumentList.Add("--format");
            start.ArgumentList.Add("json");
            start.ArgumentList.Add("--no-interpolate");
            using Process process = Process.Start(start)
                ?? throw new InvalidOperationException("runtime_role_compose_oracle_start_failed");
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException($"runtime_role_compose_oracle_failed:{error.Trim()}");
            }
            using JsonDocument document = JsonDocument.Parse(output);
            var services = new SortedDictionary<string, object?>(StringComparer.Ordinal);
            foreach (JsonProperty property in document.RootElement.GetProperty("services").EnumerateObject())
            {
                JsonElement service = property.Value;
                if (!allProfiles
                    && service.TryGetProperty("profiles", out JsonElement activeProfiles)
                    && activeProfiles.GetArrayLength() > 0)
                {
                    continue;
                }
                services[property.Name] = new SortedDictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["image"] = service.TryGetProperty("image", out JsonElement image) ? image.GetString() : null,
                    ["build"] = service.TryGetProperty("build", out JsonElement build)
                        ? JsonSerializer.Deserialize<object?>(build.GetRawText()) : null,
                    ["pullPolicy"] = service.TryGetProperty("pull_policy", out JsonElement pullPolicy)
                        ? pullPolicy.GetString() : null,
                    ["profiles"] = service.TryGetProperty("profiles", out JsonElement profiles)
                        ? profiles.EnumerateArray().Select(static value => value.GetString() ?? string.Empty)
                            .Order(StringComparer.Ordinal).ToArray()
                        : [],
                    ["entrypoint"] = service.TryGetProperty("entrypoint", out JsonElement entrypoint)
                        ? JsonSerializer.Deserialize<object?>(entrypoint.GetRawText()) : null,
                    ["command"] = service.TryGetProperty("command", out JsonElement command)
                        ? JsonSerializer.Deserialize<object?>(command.GetRawText()) : null
                };
            }
            return JsonSerializer.SerializeToElement(services, s_json);
        }

        var unsigned = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["oracle"] = "docker-compose-config-json-no-interpolate",
            ["oracleVersion"] = oracleIdentity.ComposeVersion,
            ["dockerExecutable"] = new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["canonicalPath"] = oracleIdentity.DockerCanonicalPath,
                ["digest"] = oracleIdentity.DockerDigest,
                ["version"] = oracleIdentity.DockerVersion
            },
            ["composeImplementation"] = new SortedDictionary<string, object?>(StringComparer.Ordinal)
            {
                ["canonicalPath"] = oracleIdentity.ComposeCanonicalPath,
                ["digest"] = oracleIdentity.ComposeDigest,
                ["version"] = oracleIdentity.ComposeVersion
            },
            ["sourcePath"] = sourcePath,
            ["defaultServices"] = Project(allProfiles: false),
            ["allProfileServices"] = Project(allProfiles: true)
        };
        JsonElement unsignedElement = JsonSerializer.SerializeToElement(unsigned, s_json);
        string digest = "sha256:" + Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(CanonicalElement(unsignedElement)))).ToLowerInvariant();
        unsigned["modelDigest"] = digest;
        return JsonSerializer.SerializeToElement(unsigned, s_json);
    }

    private sealed record DockerComposeOracleIdentity(
        string DockerCanonicalPath,
        string DockerDigest,
        string DockerVersion,
        string ComposeCanonicalPath,
        string ComposeDigest,
        string ComposeVersion);

    private static DockerComposeOracleIdentity ResolveDockerComposeOracleIdentity(string repositoryRoot)
    {
        string dockerPath = ResolveTrustedExecutableFromPath("docker");
        string dockerVersion = RunProcess(
            repositoryRoot,
            dockerPath,
            ["version", "--format", "{{.Client.Version}}"]
        ).Trim();
        string pluginInventory = RunProcess(
            repositoryRoot,
            dockerPath,
            ["info", "--format", "{{json .ClientInfo.Plugins}}"]
        );
        using JsonDocument plugins = JsonDocument.Parse(pluginInventory);
        JsonElement[] compose = plugins.RootElement.EnumerateArray()
            .Where(static entry => entry.TryGetProperty("Name", out JsonElement name)
                && name.GetString() == "compose")
            .ToArray();
        if (compose.Length != 1
            || !compose[0].TryGetProperty("Path", out JsonElement composePathElement)
            || string.IsNullOrWhiteSpace(composePathElement.GetString())
            || !compose[0].TryGetProperty("Version", out JsonElement composeVersionElement))
        {
            throw new InvalidOperationException("runtime_role_compose_implementation_identity_unavailable");
        }
        string composePath = ResolveTrustedCanonicalExecutable(
            composePathElement.GetString()!,
            "Docker Compose");
        string composeVersion = RunProcess(
            repositoryRoot,
            dockerPath,
            ["compose", "version", "--short"]
        ).Trim();
        if (!string.Equals(
                composeVersion.TrimStart('v'),
                (composeVersionElement.GetString() ?? string.Empty).TrimStart('v'),
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException("runtime_role_compose_implementation_version_mismatch");
        }
        return new DockerComposeOracleIdentity(
            dockerPath,
            DigestFile(dockerPath)["sha256:".Length..],
            dockerVersion,
            composePath,
            DigestFile(composePath)["sha256:".Length..],
            composeVersion);
    }

    private static string ResolveTrustedExecutableFromPath(string name)
    {
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            string candidate = Path.GetFullPath(Path.Combine(directory, name));
            if (File.Exists(candidate))
            {
                return ResolveTrustedCanonicalExecutable(candidate, name);
            }
        }
        throw new InvalidOperationException($"runtime_role_external_oracle_path_missing:{name}");
    }

    private static string ResolveTrustedCanonicalExecutable(string candidate, string label)
    {
        var lexical = new FileInfo(Path.GetFullPath(candidate));
        FileSystemInfo resolved = lexical.ResolveLinkTarget(returnFinalTarget: true) ?? lexical;
        string canonical = Path.GetFullPath(resolved.FullName);
        var metadata = new FileInfo(canonical);
        string[] trustedRoots = ["/usr/bin", "/usr/local/bin", "/usr/lib/docker", "/usr/libexec/docker"];
        if (!OperatingSystem.IsLinux())
        {
            throw new InvalidOperationException("runtime_role_external_oracle_requires_linux");
        }
        UnixFileMode mode = File.GetUnixFileMode(canonical);
        if (!metadata.Exists
            || metadata.LinkTarget is not null
            || !trustedRoots.Any(root => canonical == root
                || canonical.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            || (mode & (UnixFileMode.GroupWrite | UnixFileMode.OtherWrite)) != 0)
        {
            throw new InvalidOperationException(
                $"runtime_role_external_oracle_untrusted:{label}:{canonical}");
        }
        return canonical;
    }

    private static string RunProcess(string workingDirectory, string fileName, IReadOnlyList<string> arguments)
    {
        var start = new ProcessStartInfo(fileName)
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        foreach (string argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }
        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("runtime_role_external_oracle_start_failed");
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"runtime_role_external_oracle_failed:{fileName}:{error.Trim()}");
        }
        return output;
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

    private static CurrentSchemaContractObservation ObserveCurrentSchemaContract()
    {
        var probe = ProbeCurrentSchemaProductionContract();
        var observation = new CurrentSchemaContractObservation(
            "fsusblog.current-schema-code-contract-observation.v1",
            "pre-runtime", "compiled-production-code-model", CurrentSchemaReceiptCodec.Format,
            CurrentSchemaReceiptCodec.MaximumEncodedBytes, true, false,
            typeof(CurrentSchemaReceiptCodec).FullName!, typeof(CurrentSchemaReceiptAdmission).FullName!,
            true, probe.ArtifactSha256, probe.ContentDigest,
            ["canonical-codec-roundtrip", "whole-artifact-admission-contract", "artifact-sha-distinct-from-content-seal"],
            probe.Refusals, string.Empty);
        string canonical = JsonSerializer.Serialize(observation, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });
        return observation with
        {
            ObservationDigest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)))
        };
    }

    // These deterministic fixture values exercise the real production codec and
    // admission value validator. No fixture is issued, published, or read as a
    // native receipt, and no database/issuer is invoked before static admission.
    private static (string ArtifactSha256, string ContentDigest,
        IReadOnlyDictionary<string, string> Refusals) ProbeCurrentSchemaProductionContract()
    {
        string digest = new('a', 64);
        var target = new CurrentSchemaTargetIdentity(
            "contract-fixture-model", "contract-fixture-extractor", "contract-fixture-generator", digest, digest);
        var database = new CurrentSchemaDatabaseIdentity(
            CurrentSchemaProviderKind.PostgreSql, "contract-fixture-instance", "contract-fixture-database");
        var fixture = new CurrentSchemaReceipt(
            CurrentSchemaReceiptCodec.Format, CurrentSchemaReceiptStatus.VerifiedCurrent,
            target, "contract-fixture-source", "contract-fixture-version", digest, digest,
            Reference("plan"), Reference("apply"), [Reference("checkpoint")], database, digest,
            [new CurrentSchemaStepPostcondition("contract-fixture-step", "contract-fixture-predicate", digest, digest, digest)],
            Reference("backup-package"), Reference("backup-manifest"), Reference("restore-drill"),
            ImmutableArray<CurrentSchemaArtifactReference>.Empty,
            new CurrentSchemaVerifierIdentity(new string('b', 40), digest, digest, digest),
            ImmutableArray<string>.Empty, string.Empty);
        fixture = Reseal(fixture);
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(fixture);
        string artifactSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var actual = new CurrentSchemaAdmissionObservation(target, database, digest);
        if (!CurrentSchemaReceiptCodec.Serialize(CurrentSchemaReceiptCodec.Deserialize(bytes))
                .AsSpan().SequenceEqual(bytes))
        {
            throw new InvalidOperationException("runtime_role_current_contract_roundtrip_failed");
        }
        if (CurrentSchemaReceiptAdmission.Validate(bytes, artifactSha256, actual).ContentDigest != fixture.ContentDigest
            || artifactSha256 == fixture.ContentDigest)
        {
            throw new InvalidOperationException("runtime_role_current_contract_positive_failed");
        }
        var refusals = new SortedDictionary<string, string>(StringComparer.Ordinal);
        Refuse("old-format", "current_receipt_shape_invalid", () =>
            CurrentSchemaReceiptCodec.Serialize(Reseal(fixture with { Format = "fsusblog.current-schema-receipt.v2" })));
        Refuse("empty-bytes", "current_receipt_size_invalid", () => CurrentSchemaReceiptCodec.Deserialize(ReadOnlyMemory<byte>.Empty));
        Refuse("oversized-bytes", "current_receipt_size_invalid", () =>
            CurrentSchemaReceiptCodec.Deserialize(new byte[CurrentSchemaReceiptCodec.MaximumEncodedBytes + 1]));
        string json = Encoding.UTF8.GetString(bytes);
        Refuse("missing-status", "current_receipt_json_invalid", () =>
            CurrentSchemaReceiptCodec.Deserialize(Encoding.UTF8.GetBytes(json.Replace("\"status\":\"verified-current\",", string.Empty, StringComparison.Ordinal))));
        Refuse("unknown-member", "current_receipt_json_invalid", () =>
            CurrentSchemaReceiptCodec.Deserialize(Encoding.UTF8.GetBytes("{\"unexpected\":true," + json[1..])));
        Refuse("duplicate-member", "current_receipt_json_invalid", () =>
            CurrentSchemaReceiptCodec.Deserialize(Encoding.UTF8.GetBytes("{\"format\":\"duplicate\"," + json[1..])));
        Refuse("unknown-status", "current_receipt_json_invalid", () =>
            CurrentSchemaReceiptCodec.Deserialize(Encoding.UTF8.GetBytes(json.Replace("verified-current", "ready", StringComparison.Ordinal))));
        Refuse("unknown-provider", "current_receipt_provider_unknown", () =>
            CurrentSchemaReceiptCodec.Serialize(Reseal(fixture with { Database = database with { Provider = (CurrentSchemaProviderKind)int.MaxValue } })));
        Refuse("missing-plan", "current_receipt_reference_missing", () =>
            CurrentSchemaReceiptCodec.Serialize(Reseal(fixture with { Plan = null! })));
        Refuse("latest-reference", "current_receipt_latest_reference_forbidden", () =>
            CurrentSchemaReceiptCodec.Serialize(Reseal(fixture with { Plan = new CurrentSchemaArtifactReference("contract-fixture/latest/plan", digest) })));
        Refuse("duplicate-checkpoint", "current_receipt_reference_duplicate", () =>
            CurrentSchemaReceiptCodec.Serialize(Reseal(fixture with { Checkpoints = [Reference("checkpoint"), Reference("checkpoint")] })));
        Refuse("semantic-mismatch", "current_receipt_postcondition_failed", () =>
            CurrentSchemaReceiptCodec.Serialize(Reseal(fixture with { SemanticPostconditions = [fixture.SemanticPostconditions[0] with { ActualDigest = new string('c', 64) }] })));
        Refuse("content-seal-drift", "current_receipt_digest_mismatch", () =>
            CurrentSchemaReceiptCodec.Serialize(fixture with { ContentDigest = new string('d', 64) }));
        Refuse("whole-file-drift", "current_receipt_artifact_digest_mismatch", () =>
            CurrentSchemaReceiptAdmission.Validate(bytes, new string('d', 64), actual));
        Refuse("content-seal-as-file-sha", "current_receipt_artifact_digest_mismatch", () =>
            CurrentSchemaReceiptAdmission.Validate(bytes, fixture.ContentDigest, actual));
        Refuse("target-swap", "current_receipt_live_admission_mismatch", () =>
            CurrentSchemaReceiptAdmission.Validate(bytes, artifactSha256, actual with { Target = target with { SourceDigest = new string('c', 64) } }));
        Refuse("database-swap", "current_receipt_live_admission_mismatch", () =>
            CurrentSchemaReceiptAdmission.Validate(bytes, artifactSha256, actual with { Database = database with { DatabaseId = "other-contract-fixture" } }));
        Refuse("provider-swap", "current_receipt_live_admission_mismatch", () =>
            CurrentSchemaReceiptAdmission.Validate(bytes, artifactSha256, actual with { Database = database with { Provider = CurrentSchemaProviderKind.MySql } }));
        Refuse("physical-schema-swap", "current_receipt_live_admission_mismatch", () =>
            CurrentSchemaReceiptAdmission.Validate(bytes, artifactSha256, actual with { ActualSchemaDigest = new string('c', 64) }));
        byte[] rejected = CurrentSchemaReceiptCodec.Serialize(Reseal(fixture with
        {
            Status = CurrentSchemaReceiptStatus.Rejected,
            Reasons = ["contract_fixture_rejected"]
        }));
        Refuse("rejected-status", "current_receipt_live_admission_mismatch", () =>
            CurrentSchemaReceiptAdmission.Validate(rejected, Convert.ToHexStringLower(SHA256.HashData(rejected)), actual));
        return (artifactSha256, fixture.ContentDigest, refusals);

        CurrentSchemaArtifactReference Reference(string name) => new("contract-fixture/" + name, digest);
        static CurrentSchemaReceipt Reseal(CurrentSchemaReceipt value)
            => value with { ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(value) };
        void Refuse(string id, string expectedCode, Action action)
        {
            try
            {
                action();
            }
            catch (InvalidOperationException error) when (error.Message == expectedCode)
            {
                refusals.Add(id, error.Message);
                return;
            }
            throw new InvalidOperationException("runtime_role_current_contract_refusal_failed:" + id);
        }
    }

    private static string DigestFile(string path)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

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
