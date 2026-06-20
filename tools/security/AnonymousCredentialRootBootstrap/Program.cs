using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSugar;
using DbType = SqlSugar.DbType;

namespace FsusBlog.Tools.Security.AnonymousCredentialRootBootstrap;

internal static partial class Program
{
    private const string ExpectedCircuitId = "fsus.anonymous.comment.v2";
    private const ushort ExpectedLayoutVersion = 3;
    private const string TrustedSetupSchema = "fsusblog.zk.trusted-setup-manifest.v1";
    private const string VerifyingKeySchema = "fsusblog.zk.verifying-key-config.v1";
    private const string EvidenceSchema = "fsusblog.anonymous-credential-root-bootstrap-evidence.v1";
    private static readonly HashSet<string> AllowedInputKeys = new(StringComparer.Ordinal)
    {
        "schema",
        "epoch",
        "credentialRootHash",
        "revocationRootHash",
        "issuerPublicKeyHash",
        "circuitId",
        "circuitNumericId",
        "publicInputLayoutVersion",
        "verifyingKeyHash",
        "expiresAt",
        "graceExpiresAt",
        "operatorId",
        "reason"
    };

    public static async Task<int> Main(string[] args)
    {
        var errors = new List<string>();
        try
        {
            CliOptions options = CliOptions.Parse(args);
            BootstrapMaterial material = LoadAndValidateMaterial(options, errors);
            if (errors.Count > 0)
            {
                return ExitFailed(errors);
            }

            RotateEvidence evidence = await RotateAsync(material, options, CancellationToken.None);
            Directory.CreateDirectory(Path.GetDirectoryName(options.EvidencePath) ?? ".");
            await File.WriteAllTextAsync(
                options.EvidencePath,
                $"{JsonSerializer.Serialize(evidence, EvidenceJson.Options)}\n");
            Console.WriteLine($"[anonymous-credential-root-bootstrap:dotnet] ok evidence={ToRepoRelative(options.EvidencePath)}");
            return 0;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            errors.Add(ex.Message);
            return ExitFailed(errors);
        }
    }

    private static BootstrapMaterial LoadAndValidateMaterial(CliOptions options, List<string> errors)
    {
        using JsonDocument inputDocument = ReadJson(options.InputPath, "bootstrap input");
        using JsonDocument trustedSetupDocument = ReadJson(options.TrustedSetupManifestPath, "trusted setup manifest");
        using JsonDocument verifyingKeyDocument = ReadJson(options.VerifyingKeyManifestPath, "verifying key manifest");

        FailOnSensitiveFields(inputDocument.RootElement, "input", errors);
        RejectUnknownInputFields(inputDocument.RootElement, errors);
        BootstrapMaterial material = ValidateInput(inputDocument.RootElement, errors);
        ValidateTrustedSetup(trustedSetupDocument.RootElement, material.VerifyingKeyHash, errors);
        ValidateVerifyingKeyManifest(verifyingKeyDocument.RootElement, material.VerifyingKeyHash, trustedSetupDocument.RootElement, errors);
        return material;
    }

    private static async Task<RotateEvidence> RotateAsync(
        BootstrapMaterial material,
        CliOptions options,
        CancellationToken cancellationToken)
    {
        await using ServiceProvider provider = BuildProvider(options);
        if (options.EnsureSchema)
        {
            await using AsyncServiceScope scope = provider.CreateAsyncScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            EnsureLifecycleSchema(db);
        }

        var writer = provider.GetRequiredService<IAnonymousCredentialRootWriter>();
        var reader = provider.GetRequiredService<IAnonymousCredentialRootReader>();
        var rootService = provider.GetRequiredService<IAnonymousCredentialRootService>();
        var auditSink = provider.GetRequiredService<BootstrapAuditSink>();
        Result<AnonymousCredentialRootRecord> rotated = await writer.RotateAsync(
            new AnonymousCredentialRootRotationRequest(
                material.Epoch,
                material.CredentialRootHash,
                material.RevocationRootHash,
                material.CircuitId,
                material.CircuitNumericId,
                material.VerifyingKeyHash,
                material.PublicInputLayoutVersion,
                material.ExpiresAtUtc,
                material.GraceExpiresAtUtc,
                CircuitMetadata: BuildCircuitMetadata(),
                Reason: material.Reason,
                ActorId: material.OperatorId,
                IssuerPublicKeyHash: material.IssuerPublicKeyHash),
            cancellationToken);
        if (rotated.IsFailure)
        {
            throw new InvalidOperationException(rotated.Error.Message);
        }

        await reader.RefreshAsync(cancellationToken);
        Result<AnonymousCredentialRootSnapshotCoreModel> rootSnapshot = await rootService.GetCurrentSnapshotAsync(cancellationToken);
        bool credentialRootReady = reader.CurrentSnapshot.AcceptedRoots.Any(root =>
            root.Epoch == material.Epoch &&
            string.Equals(root.RootHash, material.CredentialRootHash, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(root.RevocationRootHash, material.RevocationRootHash, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(root.IssuerPublicKeyHash, material.IssuerPublicKeyHash, StringComparison.OrdinalIgnoreCase) &&
            root.GraceExpiresAtUtc > DateTimeOffset.UtcNow);
        if (!credentialRootReady || rootSnapshot.IsFailure)
        {
            throw new InvalidOperationException("anonymous_credential_root_snapshot_not_ready");
        }

        AuditEvent audit = auditSink.RequireHighValueAudit();
        return RotateEvidence.From(material, options, rootSnapshot.Value, reader.CurrentSnapshot, audit);
    }

    private static ServiceProvider BuildProvider(CliOptions options)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
            })
            .Build();

        var services = new ServiceCollection();
        services.AddSingleton(configuration);
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IZkProofVerifier, DisabledZkProofVerifier>();
        services.AddSingleton<IAnonymousCredentialRootService, AnonymousCredentialRootService>();
        services.AddScoped<IAnonymousCredentialRootStore, AnonymousCredentialRootStore>();
        services.AddScoped<ISqlSugarClient>(_ => CreateDb(options.ConnectionString));
        services.AddSingleton<BootstrapAuditSink>();
        services.AddScoped<IAuditEventService>(static sp => sp.GetRequiredService<BootstrapAuditSink>());
        services.AddSingleton<AnonymousCredentialRootLifecycleService>();
        services.AddSingleton<IAnonymousCredentialRootReader>(static sp => sp.GetRequiredService<AnonymousCredentialRootLifecycleService>());
        services.AddSingleton<IAnonymousCredentialRootWriter>(static sp => sp.GetRequiredService<AnonymousCredentialRootLifecycleService>());
        services.AddSingleton<IAnonymousCredentialRevocationService>(static sp => sp.GetRequiredService<AnonymousCredentialRootLifecycleService>());
        services.AddLogging();
        return services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });
    }

    private static ISqlSugarClient CreateDb(string connectionString)
    {
        var config = new ConnectionConfig
        {
            DbType = DbType.PostgreSQL,
            ConnectionString = connectionString,
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true,
            MoreSettings = new ConnMoreSettings
            {
                PgSqlIsAutoToLower = true,
                PgSqlIsAutoToLowerCodeFirst = true
            }
        };

        return new SqlSugarClient(config);
    }

    private static void EnsureLifecycleSchema(ISqlSugarClient db)
        => db.CodeFirst.InitTables<AnonymousCredentialEpoch, AnonymousCredentialRoot, AnonymousCredentialRevocation>();

    private static BootstrapMaterial ValidateInput(JsonElement input, List<string> errors)
    {
        long epoch = ReadPositiveLong(input, "epoch", errors);
        string credentialRootHash = ReadSha256Hex(input, "credentialRootHash", errors);
        string revocationRootHash = ReadSha256Hex(input, "revocationRootHash", errors);
        string issuerPublicKeyHash = ReadSha256Hex(input, "issuerPublicKeyHash", errors);
        string circuitId = ReadString(input, "circuitId");
        uint circuitNumericId = ReadPositiveUInt(input, "circuitNumericId", errors);
        ushort layout = ReadPositiveUShort(input, "publicInputLayoutVersion", errors);
        string verifyingKeyHash = ReadSha256Hex(input, "verifyingKeyHash", errors);
        DateTimeOffset expiresAt = ReadUtcTimestamp(input, "expiresAt", errors);
        DateTimeOffset graceExpiresAt = ReadUtcTimestamp(input, "graceExpiresAt", errors);
        string operatorId = ReadString(input, "operatorId");
        string reason = ReadString(input, "reason");

        if (!string.Equals(circuitId, ExpectedCircuitId, StringComparison.Ordinal))
        {
            errors.Add($"circuit_id must be {ExpectedCircuitId}.");
        }

        if (layout != ExpectedLayoutVersion)
        {
            errors.Add($"public_input_layout_version must be {ExpectedLayoutVersion}.");
        }

        if (string.IsNullOrWhiteSpace(operatorId))
        {
            errors.Add("operatorId is required for offline authorization evidence.");
        }

        if (string.IsNullOrWhiteSpace(reason))
        {
            errors.Add("reason is required for high-value audit correlation.");
        }

        if (expiresAt >= graceExpiresAt)
        {
            errors.Add("expiresAt must be earlier than graceExpiresAt.");
        }

        if (epoch > 0 && IsSha256Hex(issuerPublicKeyHash) && IsSha256Hex(revocationRootHash))
        {
            Result<string> expectedEmptyRevocationRoot =
                AnonymousCredentialRevocationAccumulator.TryComputeCircuitFriendlyRoot(epoch, issuerPublicKeyHash, []);
            if (expectedEmptyRevocationRoot.IsFailure || expectedEmptyRevocationRoot.Value is null)
            {
                errors.Add("revocationRootHash could not be validated against the circuit-friendly empty accumulator.");
            }
            else if (!string.Equals(revocationRootHash, expectedEmptyRevocationRoot.Value, StringComparison.Ordinal))
            {
                errors.Add($"revocationRootHash must equal empty circuit-friendly accumulator root {expectedEmptyRevocationRoot.Value}.");
            }
        }

        return new BootstrapMaterial(
            epoch,
            credentialRootHash,
            revocationRootHash,
            issuerPublicKeyHash,
            circuitId,
            circuitNumericId,
            layout,
            verifyingKeyHash,
            expiresAt,
            graceExpiresAt,
            operatorId,
            reason);
    }

    private static void ValidateTrustedSetup(JsonElement manifest, string expectedVkHash, List<string> errors)
    {
        if (!string.Equals(ReadString(manifest, "schema"), TrustedSetupSchema, StringComparison.Ordinal))
        {
            errors.Add("trusted setup manifest schema is invalid.");
        }

        if (!string.Equals(ReadString(manifest, "circuit_id"), ExpectedCircuitId, StringComparison.Ordinal))
        {
            errors.Add($"trusted setup manifest circuit_id must be {ExpectedCircuitId}.");
        }

        if (ReadInt(manifest, "public_input_layout_version") != ExpectedLayoutVersion)
        {
            errors.Add($"trusted setup manifest public_input_layout_version must be {ExpectedLayoutVersion}.");
        }

        if (!ReadBoolean(manifest, "production_usable"))
        {
            errors.Add("trusted setup manifest production_usable must be true for root bootstrap.");
        }

        if (!string.Equals(ReadString(manifest, "ceremony_status"), "verified", StringComparison.Ordinal))
        {
            errors.Add("trusted setup manifest ceremony_status must be verified for root bootstrap.");
        }

        ValidateManifestHash(ReadString(manifest, "verifying_key_hash"), expectedVkHash, "trusted setup manifest", errors);
    }

    private static void ValidateVerifyingKeyManifest(JsonElement manifest, string expectedVkHash, JsonElement trustedSetup, List<string> errors)
    {
        if (!string.Equals(ReadString(manifest, "schema"), VerifyingKeySchema, StringComparison.Ordinal))
        {
            errors.Add("verifying key manifest schema is invalid.");
        }

        if (!string.Equals(ReadString(manifest, "circuit_id"), ExpectedCircuitId, StringComparison.Ordinal))
        {
            errors.Add($"verifying key manifest circuit_id must be {ExpectedCircuitId}.");
        }

        if (ReadInt(manifest, "public_input_layout_version") != ExpectedLayoutVersion)
        {
            errors.Add($"verifying key manifest public_input_layout_version must be {ExpectedLayoutVersion}.");
        }

        if (!ReadBoolean(manifest, "production_usable"))
        {
            errors.Add("verifying key manifest production_usable must be true for root bootstrap.");
        }

        string manifestVkHash = ReadString(manifest, "verifying_key_hash").ToLowerInvariant();
        string trustedVkHash = ReadString(trustedSetup, "verifying_key_hash").ToLowerInvariant();
        ValidateManifestHash(manifestVkHash, expectedVkHash, "verifying key manifest", errors);
        if (IsSha256Hex(manifestVkHash) && IsSha256Hex(trustedVkHash) && manifestVkHash != trustedVkHash)
        {
            errors.Add("trusted setup manifest verifying_key_hash does not match verifying key manifest.");
        }
    }

    private static void ValidateManifestHash(string rawHash, string expectedVkHash, string label, List<string> errors)
    {
        string normalized = NormalizeHash(rawHash);
        if (!IsSha256Hex(normalized))
        {
            errors.Add($"{label} verifying_key_hash must be a 64-char hex SHA-256 digest.");
        }
        else if (IsPlaceholderHash(normalized))
        {
            errors.Add($"{label} verifying_key_hash must not be a placeholder.");
        }
        else if (!string.Equals(normalized, expectedVkHash, StringComparison.Ordinal))
        {
            errors.Add($"input verifying_key_hash does not match {label}.");
        }
    }

    private static void RejectUnknownInputFields(JsonElement input, List<string> errors)
    {
        if (input.ValueKind != JsonValueKind.Object)
        {
            errors.Add("bootstrap input must be a JSON object.");
            return;
        }

        foreach (JsonProperty property in input.EnumerateObject())
        {
            if (!AllowedInputKeys.Contains(property.Name))
            {
                errors.Add($"unknown bootstrap input field: {property.Name}");
            }
        }
    }

    private static void FailOnSensitiveFields(JsonElement value, string location, List<string> errors)
    {
        if (value.ValueKind == JsonValueKind.Array)
        {
            int index = 0;
            foreach (JsonElement item in value.EnumerateArray())
            {
                FailOnSensitiveFields(item, $"{location}.{index}", errors);
                index++;
            }

            return;
        }

        if (value.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        foreach (JsonProperty property in value.EnumerateObject())
        {
            string childLocation = $"{location}.{property.Name}";
            if (SensitiveKeyRegex().IsMatch(property.Name))
            {
                errors.Add($"sensitive bootstrap input field is forbidden: {childLocation}");
            }

            FailOnSensitiveFields(property.Value, childLocation, errors);
        }
    }

    private static long ReadPositiveLong(JsonElement parent, string propertyName, List<string> errors)
    {
        if (parent.TryGetProperty(propertyName, out JsonElement value) &&
            value.TryGetInt64(out long result) &&
            result > 0)
        {
            return result;
        }

        errors.Add($"{propertyName} must be a positive integer.");
        return 0;
    }

    private static uint ReadPositiveUInt(JsonElement parent, string propertyName, List<string> errors)
    {
        long value = ReadPositiveLong(parent, propertyName, errors);
        if (value > uint.MaxValue)
        {
            errors.Add($"{propertyName} must fit uint32.");
            return 0;
        }

        return (uint)value;
    }

    private static ushort ReadPositiveUShort(JsonElement parent, string propertyName, List<string> errors)
    {
        long value = ReadPositiveLong(parent, propertyName, errors);
        if (value > ushort.MaxValue)
        {
            errors.Add($"{propertyName} must fit uint16.");
            return 0;
        }

        return (ushort)value;
    }

    private static string ReadSha256Hex(JsonElement parent, string propertyName, List<string> errors)
    {
        string normalized = NormalizeHash(ReadString(parent, propertyName));
        if (!IsSha256Hex(normalized))
        {
            errors.Add($"{propertyName} must be a 64-char hex SHA-256 digest.");
        }
        else if (IsPlaceholderHash(normalized))
        {
            errors.Add($"{propertyName} must not be a placeholder hash.");
        }

        return normalized;
    }

    private static DateTimeOffset ReadUtcTimestamp(JsonElement parent, string propertyName, List<string> errors)
    {
        string text = ReadString(parent, propertyName);
        if (!text.EndsWith('Z') ||
            !DateTimeOffset.TryParse(
                text,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out DateTimeOffset timestamp))
        {
            errors.Add($"{propertyName} must be an ISO-8601 UTC timestamp with Z suffix.");
            return DateTimeOffset.UnixEpoch;
        }

        return timestamp;
    }

    private static string ReadString(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out JsonElement value) &&
            value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim() ?? string.Empty
            : string.Empty;

    private static int ReadInt(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out JsonElement value) &&
            value.TryGetInt32(out int result)
            ? result
            : 0;

    private static bool ReadBoolean(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out JsonElement value) &&
            value.ValueKind == JsonValueKind.True;

    private static JsonDocument ReadJson(string file, string label)
    {
        if (!File.Exists(file))
        {
            throw new FileNotFoundException($"{label} is missing: {ToRepoRelative(file)}");
        }

        return JsonDocument.Parse(File.ReadAllText(file));
    }

    private static string NormalizeHash(string value)
        => value.Trim().StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? value.Trim()[2..].ToLowerInvariant()
            : value.Trim().ToLowerInvariant();

    private static bool IsSha256Hex(string value)
        => Sha256Regex().IsMatch(value);

    private static bool IsPlaceholderHash(string value)
    {
        string normalized = value.ToLowerInvariant();
        return normalized.Contains("vk-sha256", StringComparison.Ordinal) ||
            normalized.Contains("placeholder", StringComparison.Ordinal) ||
            normalized.Contains("todo", StringComparison.Ordinal) ||
            normalized.Contains("tbd", StringComparison.Ordinal);
    }

    private static string BuildCircuitMetadata()
        => """
           {"layout":3,"revocationAccumulator":{"algorithm":"circuit-friendly-non-membership.v1","productionZkReady":true,"hash":"mimc7-bn254.v1","tree":"sparse-merkle.v1","depth":128}}
           """;

    private static int ExitFailed(IEnumerable<string> errors)
    {
        foreach (string error in errors)
        {
            Console.Error.WriteLine($"[anonymous-credential-root-bootstrap:dotnet] {error}");
        }

        return 1;
    }

    private static string Sha256File(string file)
        => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(file)));

    private static string ToRepoRelative(string candidate)
    {
        string root = Directory.GetCurrentDirectory();
        string fullPath = Path.GetFullPath(candidate);
        string relative = Path.GetRelativePath(root, fullPath);
        return relative.StartsWith("..", StringComparison.Ordinal) ? fullPath : relative.Replace(Path.DirectorySeparatorChar, '/');
    }

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();

    [GeneratedRegex("(?:issuerPrivateKey|issuer_private_key|privateKey|private_key|credentialSecret|credential_secret|proofWitness|proof_witness|witness|issuerSignature|issuer_signature|credentialOpening|credential_opening)", RegexOptions.CultureInvariant)]
    private static partial Regex SensitiveKeyRegex();

    private sealed record CliOptions(
        string InputPath,
        string TrustedSetupManifestPath,
        string VerifyingKeyManifestPath,
        string EvidencePath,
        string DbType,
        string ConnectionString,
        bool EnsureSchema)
    {
        public static CliOptions Parse(string[] args)
        {
            string? input = null;
            string? trustedSetup = null;
            string? verifyingKey = null;
            string? evidence = null;
            string? dbType = null;
            string? connectionString = null;
            bool ensureSchema = false;

            for (int i = 0; i < args.Length; i++)
            {
                string token = args[i];
                switch (token)
                {
                    case "--input":
                        input = RequireValue(args, ref i, token);
                        break;
                    case "--trusted-setup-manifest":
                        trustedSetup = RequireValue(args, ref i, token);
                        break;
                    case "--verifying-key-manifest":
                        verifyingKey = RequireValue(args, ref i, token);
                        break;
                    case "--evidence":
                        evidence = RequireValue(args, ref i, token);
                        break;
                    case "--db-type":
                        dbType = RequireValue(args, ref i, token);
                        break;
                    case "--connection-string":
                        connectionString = RequireValue(args, ref i, token);
                        break;
                    case "--ensure-schema":
                        ensureSchema = true;
                        break;
                    default:
                        throw new InvalidOperationException($"Unknown argument: {token}");
                }
            }

            if (string.IsNullOrWhiteSpace(input))
            {
                throw new InvalidOperationException("--input is required");
            }

            if (string.IsNullOrWhiteSpace(trustedSetup))
            {
                throw new InvalidOperationException("--trusted-setup-manifest is required");
            }

            if (string.IsNullOrWhiteSpace(verifyingKey))
            {
                throw new InvalidOperationException("--verifying-key-manifest is required");
            }

            if (string.IsNullOrWhiteSpace(evidence))
            {
                throw new InvalidOperationException("--evidence is required");
            }

            if (string.IsNullOrWhiteSpace(dbType) ||
                (!dbType.Equals("postgres", StringComparison.OrdinalIgnoreCase) &&
                 !dbType.Equals("postgresql", StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException("--db-type must be postgres");
            }

            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException("--connection-string is required");
            }

            return new CliOptions(
                Path.GetFullPath(input),
                Path.GetFullPath(trustedSetup),
                Path.GetFullPath(verifyingKey),
                Path.GetFullPath(evidence),
                dbType,
                connectionString,
                ensureSchema);
        }

        private static string RequireValue(string[] args, ref int index, string flag)
        {
            index++;
            if (index >= args.Length || args[index].StartsWith("--", StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"{flag} requires a value");
            }

            return args[index];
        }
    }

    private sealed record BootstrapMaterial(
        long Epoch,
        string CredentialRootHash,
        string RevocationRootHash,
        string IssuerPublicKeyHash,
        string CircuitId,
        uint CircuitNumericId,
        ushort PublicInputLayoutVersion,
        string VerifyingKeyHash,
        DateTimeOffset ExpiresAtUtc,
        DateTimeOffset GraceExpiresAtUtc,
        string OperatorId,
        string Reason);

    private sealed class BootstrapAuditSink : IAuditEventService
    {
        private AuditEvent? _highValueAudit;

        public Task RecordAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RecordHighValueAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
        {
            _highValueAudit = auditEvent with { IsHighValue = true };
            return Task.CompletedTask;
        }

        public AuditEvent RequireHighValueAudit()
            => _highValueAudit ?? throw new InvalidOperationException("anonymous_credential_root_high_value_audit_missing");
    }

    private sealed record RotateEvidence(
        string Schema,
        string Status,
        string GeneratedAtUtc,
        string Mode,
        bool StagingDbRotateSatisfied,
        object RotateContract,
        object RootSnapshot,
        object RuntimeSnapshot,
        object Operator,
        object Manifests,
        object HighValueAudit,
        string[] Checks)
    {
        public static RotateEvidence From(
            BootstrapMaterial material,
            CliOptions options,
            AnonymousCredentialRootSnapshotCoreModel rootSnapshot,
            AnonymousCredentialRootRuntimeSnapshot runtimeSnapshot,
            AuditEvent audit)
            => new(
                EvidenceSchema,
                "rotated",
                DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                "dotnet-root-lifecycle-rotate",
                true,
                new
                {
                    dotnetService = "AnonymousCredentialRootLifecycleService.RotateAsync",
                    requestType = "AnonymousCredentialRootRotationRequest",
                    highValueAuditAction = AuditActionCatalog.AnonymousCredentialRootRotated,
                    requiresAdminStepUpOrOfflineOpsAuthorization = true
                },
                new
                {
                    epoch = material.Epoch,
                    credentialRootHash = material.CredentialRootHash,
                    revocationRootHash = material.RevocationRootHash,
                    issuerPublicKeyHash = material.IssuerPublicKeyHash,
                    circuitId = material.CircuitId,
                    circuitNumericId = material.CircuitNumericId,
                    publicInputLayoutVersion = material.PublicInputLayoutVersion,
                    verifyingKeyHash = material.VerifyingKeyHash,
                    expiresAtUtc = material.ExpiresAtUtc.ToString("O", CultureInfo.InvariantCulture),
                    graceExpiresAtUtc = material.GraceExpiresAtUtc.ToString("O", CultureInfo.InvariantCulture)
                },
                new
                {
                    credentialRootReady = true,
                    binaryRootSnapshotReady = rootSnapshot.CredentialEpoch == material.Epoch,
                    acceptedRootCount = runtimeSnapshot.AcceptedRoots.Count,
                    loadedAtUtc = runtimeSnapshot.LoadedAtUtc.ToString("O", CultureInfo.InvariantCulture)
                },
                new
                {
                    id = material.OperatorId,
                    reason = material.Reason
                },
                new
                {
                    trustedSetup = new
                    {
                        path = ToRepoRelative(options.TrustedSetupManifestPath),
                        sha256 = Sha256File(options.TrustedSetupManifestPath)
                    },
                    verifyingKey = new
                    {
                        path = ToRepoRelative(options.VerifyingKeyManifestPath),
                        sha256 = Sha256File(options.VerifyingKeyManifestPath)
                    }
                },
                new
                {
                    action = audit.Action,
                    outcome = audit.Outcome,
                    severity = audit.Severity,
                    actorType = audit.ActorType,
                    actorId = audit.ActorId,
                    targetType = audit.TargetType,
                    targetId = audit.TargetId,
                    isHighValue = audit.IsHighValue
                },
                [
                    "hash-format-valid",
                    "circuit-id-fsus.anonymous.comment.v2",
                    "public-input-layout-version-3",
                    "verifying-key-hash-bound-to-trusted-setup",
                    "verifying-key-hash-bound-to-config-manifest",
                    "root-lifecycle-rotate-called",
                    "runtime-root-snapshot-refreshed",
                    "high-value-audit-recorded",
                    "evidence-contains-no-private-key-credential-secret-proof-witness"
                ]);
    }

    private static class EvidenceJson
    {
        public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
        {
            WriteIndented = true
        };
    }
}
