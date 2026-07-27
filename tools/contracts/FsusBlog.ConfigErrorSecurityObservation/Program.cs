using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

return ConfigErrorSecurityObservationHost.Run(args);

internal static class ConfigErrorSecurityObservationHost
{
    private const string ObservationSchema = "fsusblog.config-error-security-policy-observation.v1";

    private static readonly JsonSerializerOptions s_json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static readonly HashSet<string> s_secretMarkers = new(StringComparer.OrdinalIgnoreCase)
    {
        "secret",
        "password",
        "connectionstring",
        "connection",
        "credential",
        "privatekey",
        "signingkey",
        "tokenkey",
        "answerkey",
        "pepper",
        "attestation",
        "apikey"
    };

    public static int Run(string[] args)
    {
        string? outputPath = null;
        string repositoryRoot = Directory.GetCurrentDirectory();
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] is "--output" or "-o")
            {
                outputPath = args.ElementAtOrDefault(i + 1)
                    ?? throw new InvalidOperationException("--output requires a path");
                i++;
            }
            else if (args[i] is "--repository-root")
            {
                repositoryRoot = args.ElementAtOrDefault(i + 1)
                    ?? throw new InvalidOperationException("--repository-root requires a path");
                i++;
            }
            else if (args[i] is "--help" or "-h")
            {
                Console.WriteLine("FsusBlog.ConfigErrorSecurityObservation --output <path> [--repository-root <path>]");
                return 0;
            }
            else
            {
                throw new InvalidOperationException($"Unknown argument: {args[i]}");
            }
        }

        if (string.IsNullOrWhiteSpace(outputPath))
        {
            throw new InvalidOperationException("--output is required");
        }

        repositoryRoot = Path.GetFullPath(repositoryRoot);
        JsonObject document = Observe(repositoryRoot);
        string withoutDigest = document.ToJsonString(s_json);
        string digest = Sha256Hex(withoutDigest);
        document["observationDigest"] = digest;

        string json = document.ToJsonString(s_json);
        string directory = Path.GetDirectoryName(Path.GetFullPath(outputPath))
            ?? throw new InvalidOperationException("output directory is invalid");
        Directory.CreateDirectory(directory);
        File.WriteAllText(outputPath, json + "\n", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        Console.WriteLine($"[config-error-security-observation] ok output={outputPath} digest={digest}");
        return 0;
    }

    private static JsonObject Observe(string repositoryRoot)
    {
        List<string> failures = [];

        JsonObject configurationFacts = ObserveConfiguration(repositoryRoot, failures);
        JsonObject errorFacts = ObserveErrorCodes(failures);
        JsonObject securityFacts = ObserveSecurity(failures);

        // Refuse ambient process environment values as configuration facts.
        if (Environment.GetEnvironmentVariables().Count > 0
            && configurationFacts["configuration.defaults"] is JsonObject defaults
            && defaults.Any(static entry => entry.Value is JsonObject layer
                && layer["layer"]?.GetValue<string>() == "runtime-environment"))
        {
            failures.Add("runtime environment values must not enter static configuration facts");
        }

        var document = new JsonObject
        {
            ["schema"] = ObservationSchema,
            ["source"] = "compiled-production-constants",
            ["status"] = failures.Count == 0 ? "ok" : "failed",
            ["failureReasons"] = ToJsonArray(failures),
            ["facts"] = new JsonObject
            {
                ["configuration.keys"] = configurationFacts["configuration.keys"]!.DeepClone(),
                ["configuration.defaults"] = configurationFacts["configuration.defaults"]!.DeepClone(),
                ["configuration.allowed-values"] = configurationFacts["configuration.allowed-values"]!.DeepClone(),
                ["configuration.required-production-values"] = configurationFacts["configuration.required-production-values"]!.DeepClone(),
                ["error-codes.public"] = errorFacts["error-codes.public"]!.DeepClone(),
                ["error-codes.transport-mapping"] = errorFacts["error-codes.transport-mapping"]!.DeepClone(),
                ["security.challenge-kinds"] = securityFacts["security.challenge-kinds"]!.DeepClone(),
                ["security.challenge-retired-kinds"] = securityFacts["security.challenge-retired-kinds"]!.DeepClone(),
                ["security.rate-limit-policies"] = securityFacts["security.rate-limit-policies"]!.DeepClone(),
                ["security.cache-policy-classes"] = securityFacts["security.cache-policy-classes"]!.DeepClone(),
                ["security.fail-open-closed-modes"] = securityFacts["security.fail-open-closed-modes"]!.DeepClone(),
                ["security.numeric-boundaries"] = securityFacts["security.numeric-boundaries"]!.DeepClone()
            }
        };

        if (failures.Count > 0)
        {
            Console.Error.WriteLine(
                "config-error-security observation failed coherence checks: " + string.Join("; ", failures));
        }

        return document;
    }

    private static JsonObject ObserveConfiguration(string repositoryRoot, List<string> failures)
    {
        string contractPath = Path.Combine(repositoryRoot, "config/application/backend-configuration-contract.json");
        string appsettingsPath = Path.Combine(repositoryRoot, "src/backend/appsettings.json");
        string productionPath = Path.Combine(repositoryRoot, "src/backend/appsettings.Production.json");

        if (!File.Exists(contractPath))
        {
            failures.Add($"missing configuration contract at {contractPath}");
        }

        if (!File.Exists(appsettingsPath))
        {
            failures.Add($"missing canonical appsettings at {appsettingsPath}");
        }

        // Explicitly refuse example/development overlays as default authority.
        foreach (string forbidden in new[]
                 {
                     "src/backend/appsettings.Development.example.json",
                     "src/backend/appsettings.Development.json",
                     "src/backend/appsettings.example.json",
                     "src/backend/appsettings.Production.example.json"
                 })
        {
            // Observation host never opens these paths; fail if caller forces them via env.
            string? forced = Environment.GetEnvironmentVariable("FSUSBLOG_CONFIG_OBSERVATION_APPSETTINGS");
            if (!string.IsNullOrWhiteSpace(forced)
                && forced.Replace('\\', '/').Contains(forbidden, StringComparison.OrdinalIgnoreCase))
            {
                failures.Add($"refuses example/development appsettings as default authority: {forbidden}");
            }
        }

        var keys = new JsonObject();
        var defaults = new JsonObject();
        var allowedValues = new JsonObject();
        var requiredProduction = new JsonObject();

        if (File.Exists(contractPath))
        {
            using JsonDocument contractDoc = JsonDocument.Parse(File.ReadAllText(contractPath));
            if (!contractDoc.RootElement.TryGetProperty("applicationSettings", out JsonElement settings)
                || settings.ValueKind != JsonValueKind.Array)
            {
                failures.Add("configuration contract missing applicationSettings array");
            }
            else
            {
                foreach (JsonElement setting in settings.EnumerateArray())
                {
                    string key = setting.GetProperty("key").GetString() ?? string.Empty;
                    if (string.IsNullOrWhiteSpace(key))
                    {
                        continue;
                    }

                    bool secret = setting.TryGetProperty("secret", out JsonElement secretEl) && secretEl.GetBoolean();
                    string valueType = setting.TryGetProperty("valueType", out JsonElement typeEl)
                        ? typeEl.GetString() ?? "string"
                        : "string";
                    string requiredStatus = setting.TryGetProperty("requiredStatus", out JsonElement reqEl)
                        ? reqEl.GetString() ?? "optional"
                        : "optional";
                    string requiredWhen = setting.TryGetProperty("requiredWhen", out JsonElement whenEl)
                        ? whenEl.GetString() ?? "optional"
                        : "optional";
                    bool nullable = valueType.StartsWith("nullable-", StringComparison.Ordinal)
                        || (setting.TryGetProperty("allowEmptyBaseValue", out JsonElement emptyEl) && emptyEl.GetBoolean());

                    keys[key] = new JsonObject
                    {
                        ["valueType"] = valueType,
                        ["secret"] = secret,
                        ["nullable"] = nullable,
                        ["requiredStatus"] = requiredStatus,
                        ["requiredWhen"] = requiredWhen,
                        ["layer"] = "canonical-catalog"
                    };

                    bool productionRequired = requiredStatus.Equals("required", StringComparison.OrdinalIgnoreCase)
                        && (requiredWhen.Contains("Production", StringComparison.OrdinalIgnoreCase)
                            || requiredWhen.Equals("required", StringComparison.OrdinalIgnoreCase)
                            || requiredWhen.Equals("always", StringComparison.OrdinalIgnoreCase)
                            || (setting.TryGetProperty("environments", out JsonElement envs)
                                && envs.ValueKind == JsonValueKind.Array
                                && envs.EnumerateArray().Any(static e =>
                                    string.Equals(e.GetString(), "Production", StringComparison.OrdinalIgnoreCase))));

                    if (productionRequired)
                    {
                        requiredProduction[key] = new JsonObject
                        {
                            ["required"] = true,
                            ["requiredWhen"] = requiredWhen,
                            ["valueType"] = valueType,
                            ["secret"] = secret,
                            ["layer"] = "production-required-override",
                            // Never materialize secret values — only the requirement itself.
                            ["valueMaterialized"] = false
                        };
                    }
                }
            }
        }

        // Allowed values from production mode catalogs (pure contracts, not docs).
        allowedValues["AntiCrawler:Mode"] = ToJsonArray(
        [
            SecuritySystemModes.Disabled,
            SecuritySystemModes.Observe,
            SecuritySystemModes.Enforce,
            SecuritySystemModes.Strict,
            SecuritySystemModes.Lockdown
        ]);
        allowedValues["Security:AntiCrawler:Mode"] = allowedValues["AntiCrawler:Mode"]!.DeepClone();

        // Code defaults for security-sensitive knobs (GetValue second args / entity defaults).
        defaults["RateLimiting:FixedIpPermitLimit"] = LayeredDefault(
            codeDefault: 100,
            canonical: null,
            type: "integer",
            unit: "requests-per-window",
            nullable: false);
        defaults["RateLimiting:FixedIpQueueLimit"] = LayeredDefault(2, null, "integer", "queued-requests", false);
        defaults["RateLimiting:PublicReadPermitLimit"] = LayeredDefault(120, null, "integer", "requests-per-window", false);
        defaults["RateLimiting:PublicReadQueueLimit"] = LayeredDefault(2, null, "integer", "queued-requests", false);
        defaults["RateLimiting:ReadProofPermitLimit"] = LayeredDefault(30, null, "integer", "requests-per-window", false);
        defaults["RateLimiting:AdminPermitLimit"] = LayeredDefault(300, null, "integer", "requests-per-window", false);
        defaults["RateLimiting:AdminQueueLimit"] = LayeredDefault(0, null, "integer", "queued-requests", false);
        defaults["RateLimiting:NotificationStreamPermitLimit"] = LayeredDefault(120, null, "integer", "requests-per-window", false);
        defaults["RateLimiting:NotificationStreamQueueLimit"] = LayeredDefault(0, null, "integer", "queued-requests", false);
        defaults["RateLimiting:LoopbackBypassEnabled"] = LayeredDefault(true, null, "boolean", null, false);
        defaults["Security:StepUp:FreshnessMinutes"] = LayeredDefault(5, null, "integer", "minutes", false);
        defaults["AnonymousIdentity:CommentMaxChars"] = LayeredDefault(
            new AnonymousCommentPolicy().CommentMaxChars,
            null,
            "integer",
            "characters",
            false);
        defaults["AnonymousIdentity:CommentMaxUtf8Bytes"] = LayeredDefault(
            new AnonymousCommentPolicy().CommentMaxUtf8Bytes,
            null,
            "integer",
            "bytes",
            false);

        if (File.Exists(appsettingsPath))
        {
            try
            {
                string raw = File.ReadAllText(appsettingsPath);
                JsonNode? root = JsonNode.Parse(StripJsonComments(raw));
                if (root is JsonObject appsettings)
                {
                    foreach ((string leafKey, JsonNode? value) in FlattenLeaves(appsettings))
                    {
                        if (IsSecretKey(leafKey) || IsSecretValue(value))
                        {
                            // Record presence only — never the secret material.
                            if (!defaults.ContainsKey(leafKey))
                            {
                                defaults[leafKey] = new JsonObject
                                {
                                    ["type"] = "secret",
                                    ["secret"] = true,
                                    ["nullable"] = true,
                                    ["layers"] = new JsonObject
                                    {
                                        ["canonical-repository-config"] = new JsonObject
                                        {
                                            ["present"] = true,
                                            ["valueMaterialized"] = false
                                        }
                                    }
                                };
                            }

                            continue;
                        }

                        JsonObject entry = defaults[leafKey] as JsonObject
                            ?? new JsonObject
                            {
                                ["type"] = InferType(value),
                                ["secret"] = false,
                                ["nullable"] = value is null || value is JsonValue jv && jv.GetValueKind() is JsonValueKind.Null,
                                ["layers"] = new JsonObject()
                            };
                        if (entry["layers"] is not JsonObject layers)
                        {
                            layers = new JsonObject();
                            entry["layers"] = layers;
                        }

                        layers["canonical-repository-config"] = new JsonObject
                        {
                            ["value"] = value?.DeepClone(),
                            ["layer"] = "canonical-repository-config"
                        };
                        if (entry["unit"] is null && leafKey.EndsWith("Minutes", StringComparison.Ordinal))
                        {
                            entry["unit"] = "minutes";
                        }
                        else if (entry["unit"] is null && leafKey.EndsWith("Seconds", StringComparison.Ordinal))
                        {
                            entry["unit"] = "seconds";
                        }
                        else if (entry["unit"] is null && leafKey.EndsWith("Days", StringComparison.Ordinal))
                        {
                            entry["unit"] = "days";
                        }

                        defaults[leafKey] = entry;
                    }
                }
            }
            catch (Exception ex)
            {
                failures.Add($"canonical appsettings parse failed: {ex.Message}");
            }
        }

        // Production overlay contributes required-production presence only (no secret values).
        if (File.Exists(productionPath))
        {
            try
            {
                string raw = File.ReadAllText(productionPath);
                JsonNode? root = JsonNode.Parse(StripJsonComments(raw));
                if (root is JsonObject production)
                {
                    foreach ((string leafKey, JsonNode? value) in FlattenLeaves(production))
                    {
                        if (IsSecretKey(leafKey) || IsSecretValue(value))
                        {
                            continue;
                        }

                        if (requiredProduction[leafKey] is JsonObject required)
                        {
                            required["hasProductionOverlayKey"] = true;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                failures.Add($"production appsettings parse failed: {ex.Message}");
            }
        }

        // Sort keys deterministically by rewriting into ordered objects.
        return new JsonObject
        {
            ["configuration.keys"] = SortObject(keys),
            ["configuration.defaults"] = SortObject(defaults),
            ["configuration.allowed-values"] = SortObject(allowedValues),
            ["configuration.required-production-values"] = SortObject(requiredProduction)
        };
    }

    private static JsonObject ObserveErrorCodes(List<string> failures)
    {
        string[] publicCodes = Enum.GetValues<ErrorCode>()
            .Where(static code => code != ErrorCode.None)
            .Select(static code => code.ToString())
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static code => code, StringComparer.Ordinal)
            .ToArray();

        if (publicCodes.Length == 0)
        {
            failures.Add("error-codes.public must not be empty");
        }

        var transport = new JsonObject();
        // Status → ErrorCode authority from ApiErrorSemanticMapper (production mapper).
        foreach ((int status, string label) in new (int, string)[]
                 {
                     (400, "400"),
                     (401, "401"),
                     (403, "403"),
                     (404, "404"),
                     (409, "409"),
                     (423, "423"),
                     (500, "500")
                 })
        {
            ErrorCode mapped = ApiErrorSemanticMapper.MapErrorCode(status);
            transport[label] = new JsonObject
            {
                ["httpStatus"] = status,
                ["errorCode"] = mapped.ToString(),
                ["direction"] = "status-to-error-code"
            };
        }

        // ErrorCode → Status authority.
        foreach (ErrorCode code in Enum.GetValues<ErrorCode>().Where(static c => c != ErrorCode.None && c != ErrorCode.Unknown))
        {
            int status = ApiErrorSemanticMapper.MapStatusCode(ErrorDetail.Create(code, code.ToString()));
            transport[$"code:{code}"] = new JsonObject
            {
                ["errorCode"] = code.ToString(),
                ["httpStatus"] = status,
                ["direction"] = "error-code-to-status"
            };
        }

        return new JsonObject
        {
            ["error-codes.public"] = ToJsonArray(publicCodes),
            ["error-codes.transport-mapping"] = SortObject(transport)
        };
    }

    private static JsonObject ObserveSecurity(List<string> failures)
    {
        string[] activeKinds = SecurityChallengeContracts.SupportedKinds
            .Select(SecurityChallengeContracts.ToWireName)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();

        // Production currently has no retired challenge wire names remaining in the catalog.
        // Keep an explicit empty set so active/retired stay partitioned (never merge).
        string[] retiredKinds = Array.Empty<string>();

        if (activeKinds.Intersect(retiredKinds, StringComparer.Ordinal).Any())
        {
            failures.Add("retired challenge kinds must not appear in the active set");
        }

        // Capability catalog must cover every supported kind.
        foreach (SecurityChallengeKind kind in SecurityChallengeContracts.SupportedKinds)
        {
            SecurityChallengeCapability capability = SecurityChallengeCapabilityCatalog.Get(kind);
            if (!capability.KindKnown)
            {
                failures.Add($"supported kind {kind} is not KindKnown in capability catalog");
            }
        }

        var ratePolicies = new JsonObject
        {
            ["fixed_ip"] = new JsonObject
            {
                ["policyId"] = "fixed_ip",
                ["window"] = Boundary(1, "minutes", inclusiveMin: true, inclusiveMax: true),
                ["codeDefaultPermitLimit"] = Boundary(100, "requests-per-window", true, true),
                ["permitLimitClamp"] = RangeBoundary(1, 100_000, "requests-per-window", true, true),
                ["failMode"] = "fail-closed"
            },
            ["public_read"] = new JsonObject
            {
                ["policyId"] = "public_read",
                ["window"] = Boundary(1, "minutes", true, true),
                ["codeDefaultPermitLimit"] = Boundary(120, "requests-per-window", true, true),
                ["permitLimitClamp"] = RangeBoundary(1, 100_000, "requests-per-window", true, true),
                ["failMode"] = "fail-closed"
            },
            ["read_proof"] = new JsonObject
            {
                ["policyId"] = "read_proof",
                ["window"] = Boundary(1, "minutes", true, true),
                ["codeDefaultPermitLimit"] = Boundary(30, "requests-per-window", true, true),
                ["permitLimitClamp"] = RangeBoundary(1, 100_000, "requests-per-window", true, true),
                ["failMode"] = "fail-closed"
            },
            ["notification_stream"] = new JsonObject
            {
                ["policyId"] = "notification_stream",
                ["window"] = Boundary(1, "minutes", true, true),
                ["codeDefaultPermitLimit"] = Boundary(120, "requests-per-window", true, true),
                ["permitLimitClamp"] = RangeBoundary(1, 100_000, "requests-per-window", true, true),
                ["failMode"] = "fail-closed"
            },
            ["security_challenge_verify"] = new JsonObject
            {
                ["policyId"] = "security_challenge_verify",
                ["cachePolicyId"] = CachePolicyId.SecurityChallengeVerifyRateLimit.ToString(),
                ["maxAttempts"] = Boundary(3, "attempts", true, true),
                ["cacheExpiry"] = Boundary(2, "minutes", true, true),
                ["failMode"] = "fail-closed"
            }
        };

        var cacheClasses = new JsonObject();
        var registry = new CachePolicyRegistry();
        foreach (CachePolicyId id in Enum.GetValues<CachePolicyId>().Where(static value => value != CachePolicyId.None))
        {
            if (!registry.TryGet(id, out CachePolicy policy))
            {
                // Some enum members may be reserved without registry rows; skip without inventing.
                continue;
            }

            cacheClasses[id.ToString()] = new JsonObject
            {
                ["id"] = id.ToString(),
                ["domain"] = policy.Domain,
                ["resource"] = policy.Resource,
                ["securityCritical"] = policy.SecurityCritical,
                ["l1Ttl"] = Duration(policy.L1Ttl),
                ["l2Ttl"] = Duration(policy.L2Ttl),
                ["negativeTtl"] = policy.NegativeTtl is TimeSpan negative ? Duration(negative) : null,
                ["class"] = policy.SecurityCritical ? "security-critical" : policy.Domain
            };
        }

        var failModes = new JsonObject
        {
            ["rate-limiter-rejection"] = "fail-closed",
            ["security-challenge-verify"] = "fail-closed",
            ["production-startup-validation"] = "fail-closed",
            ["capability-manifest-mismatch"] = "fail-closed",
            ["challenge-envelope-cas"] = "fail-closed",
            ["plugin-hook-default"] = "fail-closed",
            ["zk-production-gate"] = "fail-closed"
        };

        var numericBoundaries = new JsonObject
        {
            ["security.step-up.freshness-minutes"] = new JsonObject
            {
                ["configurationKey"] = MfaChallengeService.ProofFreshnessMinutesConfigurationKey,
                ["default"] = Boundary(5, "minutes", true, true),
                ["minimum"] = Boundary(MfaChallengeService.MinimumProofFreshnessMinutes, "minutes", true, true),
                ["maximum"] = Boundary(MfaChallengeService.MaximumProofFreshnessMinutes, "minutes", true, true),
                ["bound"] = "inclusive-inclusive"
            },
            ["security.challenge.max-assignments-per-envelope"] = Boundary(
                SecurityChallengeContracts.MaxAssignmentsPerEnvelope,
                "assignments",
                true,
                true),
            ["security.rate-limit.permit-limit"] = RangeBoundary(1, 100_000, "requests-per-window", true, true),
            ["security.rate-limit.queue-limit"] = RangeBoundary(0, 10_000, "queued-requests", true, true),
            ["security.challenge-verify.max-attempts"] = Boundary(3, "attempts", true, true),
            ["security.challenge-verify.cache-expiry"] = Boundary(2, "minutes", true, true),
            ["moderation.comment-max-chars.default"] = Boundary(
                new AnonymousCommentPolicy().CommentMaxChars,
                "characters",
                true,
                true),
            ["moderation.comment-max-utf8-bytes.default"] = Boundary(
                new AnonymousCommentPolicy().CommentMaxUtf8Bytes,
                "bytes",
                true,
                true)
        };

        return new JsonObject
        {
            ["security.challenge-kinds"] = new JsonObject
            {
                ["active"] = ToJsonArray(activeKinds),
                ["manifestVersion"] = SecurityChallengeCapabilityCatalog.ManifestVersion
            },
            ["security.challenge-retired-kinds"] = ToJsonArray(retiredKinds),
            ["security.rate-limit-policies"] = SortObject(ratePolicies),
            ["security.cache-policy-classes"] = SortObject(cacheClasses),
            ["security.fail-open-closed-modes"] = SortObject(failModes),
            ["security.numeric-boundaries"] = SortObject(numericBoundaries)
        };
    }

    private static JsonObject LayeredDefault(
        object? codeDefault,
        object? canonical,
        string type,
        string? unit,
        bool nullable)
    {
        var layers = new JsonObject();
        if (codeDefault is not null)
        {
            layers["code-default"] = new JsonObject
            {
                ["value"] = JsonValue.Create(codeDefault),
                ["layer"] = "code-default"
            };
        }

        if (canonical is not null)
        {
            layers["canonical-repository-config"] = new JsonObject
            {
                ["value"] = JsonValue.Create(canonical),
                ["layer"] = "canonical-repository-config"
            };
        }

        var entry = new JsonObject
        {
            ["type"] = type,
            ["nullable"] = nullable,
            ["secret"] = false,
            ["layers"] = layers
        };
        if (unit is not null)
        {
            entry["unit"] = unit;
        }

        return entry;
    }

    private static JsonObject Boundary(double value, string unit, bool inclusiveMin, bool inclusiveMax)
        => new()
        {
            ["value"] = value,
            ["unit"] = unit,
            ["inclusiveMin"] = inclusiveMin,
            ["inclusiveMax"] = inclusiveMax,
            ["bound"] = $"{(inclusiveMin ? "inclusive" : "exclusive")}-{(inclusiveMax ? "inclusive" : "exclusive")}"
        };

    private static JsonObject RangeBoundary(
        double min,
        double max,
        string unit,
        bool inclusiveMin,
        bool inclusiveMax)
        => new()
        {
            ["min"] = min,
            ["max"] = max,
            ["unit"] = unit,
            ["inclusiveMin"] = inclusiveMin,
            ["inclusiveMax"] = inclusiveMax,
            ["bound"] = $"{(inclusiveMin ? "inclusive" : "exclusive")}-{(inclusiveMax ? "inclusive" : "exclusive")}"
        };

    private static JsonObject Duration(TimeSpan value)
    {
        if (value == Timeout.InfiniteTimeSpan)
        {
            return new JsonObject
            {
                ["value"] = -1,
                ["unit"] = "infinite"
            };
        }

        if (value == TimeSpan.Zero)
        {
            return new JsonObject
            {
                ["value"] = 0,
                ["unit"] = "seconds"
            };
        }

        if (value.TotalDays >= 1 && value == TimeSpan.FromDays(value.TotalDays))
        {
            return new JsonObject
            {
                ["value"] = value.TotalDays,
                ["unit"] = "days"
            };
        }

        if (value.TotalHours >= 1 && value == TimeSpan.FromHours(value.TotalHours))
        {
            return new JsonObject
            {
                ["value"] = value.TotalHours,
                ["unit"] = "hours"
            };
        }

        if (value.TotalMinutes >= 1 && value == TimeSpan.FromMinutes(value.TotalMinutes))
        {
            return new JsonObject
            {
                ["value"] = value.TotalMinutes,
                ["unit"] = "minutes"
            };
        }

        return new JsonObject
        {
            ["value"] = value.TotalSeconds,
            ["unit"] = "seconds"
        };
    }

    private static IEnumerable<(string Key, JsonNode? Value)> FlattenLeaves(JsonObject root, string prefix = "")
    {
        foreach ((string propertyName, JsonNode? child) in root.OrderBy(static entry => entry.Key, StringComparer.Ordinal))
        {
            string key = string.IsNullOrEmpty(prefix) ? propertyName : $"{prefix}:{propertyName}";
            if (child is JsonObject nested)
            {
                foreach ((string leafKey, JsonNode? leafValue) in FlattenLeaves(nested, key))
                {
                    yield return (leafKey, leafValue);
                }
            }
            else
            {
                yield return (key, child);
            }
        }
    }

    private static bool IsSecretKey(string key)
    {
        string compact = key.Replace(":", string.Empty, StringComparison.Ordinal)
            .Replace("_", string.Empty, StringComparison.Ordinal)
            .Replace("-", string.Empty, StringComparison.Ordinal);
        return s_secretMarkers.Any(marker => compact.Contains(marker, StringComparison.OrdinalIgnoreCase))
            || key.Contains("ConnectionStrings", StringComparison.OrdinalIgnoreCase)
            || key.Contains("SecretKey", StringComparison.OrdinalIgnoreCase)
            || key.Contains("SigningKey", StringComparison.OrdinalIgnoreCase)
            || key.Contains("Password", StringComparison.OrdinalIgnoreCase)
            || key.Contains("PrivateKey", StringComparison.OrdinalIgnoreCase)
            || key.Contains("Pepper", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsSecretValue(JsonNode? value)
    {
        if (value is not JsonValue jsonValue || jsonValue.GetValueKind() != JsonValueKind.String)
        {
            return false;
        }

        string text = jsonValue.GetValue<string>() ?? string.Empty;
        // Never emit long opaque material that looks like a credential.
        return text.Length >= 32 && Regex.IsMatch(text, "^[A-Za-z0-9+/=_-]+$", RegexOptions.CultureInvariant);
    }

    private static string InferType(JsonNode? value)
        => value switch
        {
            null => "null",
            JsonValue jv when jv.GetValueKind() == JsonValueKind.True || jv.GetValueKind() == JsonValueKind.False => "boolean",
            JsonValue jv when jv.GetValueKind() == JsonValueKind.Number => "number",
            JsonValue jv when jv.GetValueKind() == JsonValueKind.String => "string",
            JsonArray => "array",
            JsonObject => "object",
            _ => "unknown"
        };

    private static string StripJsonComments(string source)
    {
        var output = new StringBuilder(source.Length);
        bool inString = false;
        bool escaped = false;
        bool lineComment = false;
        bool blockComment = false;
        for (int i = 0; i < source.Length; i++)
        {
            char c = source[i];
            char next = i + 1 < source.Length ? source[i + 1] : '\0';
            if (lineComment)
            {
                if (c == '\n')
                {
                    lineComment = false;
                    output.Append(c);
                }

                continue;
            }

            if (blockComment)
            {
                if (c == '*' && next == '/')
                {
                    blockComment = false;
                    i++;
                }

                continue;
            }

            if (inString)
            {
                output.Append(c);
                if (escaped)
                {
                    escaped = false;
                }
                else if (c == '\\')
                {
                    escaped = true;
                }
                else if (c == '"')
                {
                    inString = false;
                }

                continue;
            }

            if (c == '"')
            {
                inString = true;
                output.Append(c);
            }
            else if (c == '/' && next == '/')
            {
                lineComment = true;
                i++;
            }
            else if (c == '/' && next == '*')
            {
                blockComment = true;
                i++;
            }
            else
            {
                output.Append(c);
            }
        }

        return output.ToString();
    }

    private static JsonObject SortObject(JsonObject source)
    {
        var sorted = new JsonObject();
        foreach ((string key, JsonNode? value) in source.OrderBy(static entry => entry.Key, StringComparer.Ordinal))
        {
            sorted[key] = value?.DeepClone();
        }

        return sorted;
    }

    private static JsonArray ToJsonArray(IReadOnlyList<string> values)
    {
        var array = new JsonArray();
        foreach (string value in values)
        {
            array.Add(value);
        }

        return array;
    }

    private static string Sha256Hex(string text)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(text));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
