using System.Buffers;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringContributionKind
{
    Command = 0,
    CommandPaletteMetadata = 1,
    ArticleInspectorReadOnly = 2,
    ArticleLibraryFilter = 3,
    WorkspacePanel = 4,
    ArticlePropertyType = 5,
    ImportProvider = 6,
    ExportProvider = 7,
    PrepublishDiagnostic = 8,
    MarkdownProvider = 9
}

public enum AuthoringCapability
{
    DocumentRangeRead = 0,
    DocumentFullRead = 1,
    SelectionRead = 2,
    DocumentMutationRequest = 3,
    ArticleQuery = 4,
    NetworkDestination = 5,
    FileSystemRootRead = 6,
    FileSystemRootProposeWrite = 7,
    DiagnosticReport = 8,
    StateStorageRead = 9,
    StateStorageWrite = 10
}

public enum AuthoringExecutionClass
{
    TrustedHostAdapter = 0,
    IsolatedWorkerWasm = 1,
    OutOfProcessService = 2
}

public enum AuthoringHostPlatform
{
    Browser = 0,
    AvaloniaDesktop = 1,
    ServerLinux = 2
}

public enum AuthoringEntrypointFormat
{
    HostAdapterIdentity = 0,
    WasmModule = 1,
    ServiceExecutable = 2
}

public enum AuthoringUpdatePolicy
{
    AtomicSwitchWithRollback = 0
}

public enum AuthoringMigrationPolicy
{
    HostDeclarativeOnly = 0
}

public enum AuthoringUninstallPolicy
{
    RemoveAuthorityRetainData = 0,
    RemoveAuthorityAndDataAfterConsent = 1
}

public sealed record AuthoringHostApiRange(int Minimum, int Maximum);

public sealed record AuthoringResourceLimits(
    TimeSpan MaximumCpuTime,
    TimeSpan WallClock,
    long MemoryBytes,
    int MaximumRequestBytes,
    int MaximumResponseBytes,
    int MaximumConcurrentCalls,
    int MaximumQueueDepth,
    int MaximumObjectDepth,
    int MaximumRestarts,
    long MaximumNetworkBytes,
    long MaximumFileBytes,
    long MaximumStateBytes);

public sealed record AuthoringEntrypointIdentity(
    AuthoringEntrypointFormat Format,
    string PathOrAdapterId,
    string ContentSha256);

public sealed record AuthoringContributionDeclaration(
    string Id,
    AuthoringContributionKind Kind,
    AuthoringExecutionClass ExecutionClass,
    AuthoringEntrypointIdentity Entrypoint,
    ImmutableArray<AuthoringCapability> Capabilities);

public sealed record AuthoringExtensionManifest(
    int SchemaVersion,
    int RegistryVersion,
    string Id,
    string Version,
    string PackageSha256,
    string ContentSha256,
    string Publisher,
    string SignatureReference,
    string TrustPolicyReference,
    AuthoringHostApiRange HostApi,
    ImmutableArray<AuthoringHostPlatform> SupportedPlatforms,
    ImmutableArray<AuthoringContributionDeclaration> Contributions,
    AuthoringResourceLimits Limits,
    int StateSchemaVersion,
    int DataSchemaVersion,
    AuthoringUpdatePolicy UpdatePolicy,
    AuthoringMigrationPolicy MigrationPolicy,
    AuthoringUninstallPolicy UninstallPolicy,
    bool AllowExecutionFallback);

public sealed record VerifiedAuthoringExtensionContract(
    AuthoringExtensionManifest Manifest,
    string ContractIdentity,
    string RegistryIdentity);

public sealed record AuthoringCoreAuthorityRegistry(
    ImmutableArray<string> CommandIds,
    ImmutableArray<string> RouteIds,
    ImmutableArray<string> PropertyIds,
    ImmutableArray<string> SavedViewOperatorIds,
    ImmutableArray<string> SecurityPolicyIds);

public sealed record AuthoringExtensionRegistrySnapshot(
    int RegistryVersion,
    ImmutableArray<VerifiedAuthoringExtensionContract> Contracts,
    AuthoringCoreAuthorityRegistry CoreAuthorities,
    string RegistryIdentity);

public sealed class AuthoringExtensionContractException(string message) : InvalidOperationException(message);

public static partial class AuthoringExtensionContractValidator
{
    public const int CurrentSchemaVersion = 1;
    public const int CurrentRegistryVersion = 1;
    public const int CurrentHostApiVersion = 1;
    public const int MaximumContributions = 1000;
    public const int MaximumExtensions = 1000;
    public const int MaximumIdentifierLength = 128;
    public const int MaximumManifestBytes = 1_048_576;

    private static readonly ImmutableHashSet<string> s_manifestFields = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        nameof(AuthoringExtensionManifest.SchemaVersion),
        nameof(AuthoringExtensionManifest.RegistryVersion),
        nameof(AuthoringExtensionManifest.Id),
        nameof(AuthoringExtensionManifest.Version),
        nameof(AuthoringExtensionManifest.PackageSha256),
        nameof(AuthoringExtensionManifest.ContentSha256),
        nameof(AuthoringExtensionManifest.Publisher),
        nameof(AuthoringExtensionManifest.SignatureReference),
        nameof(AuthoringExtensionManifest.TrustPolicyReference),
        nameof(AuthoringExtensionManifest.HostApi),
        nameof(AuthoringExtensionManifest.SupportedPlatforms),
        nameof(AuthoringExtensionManifest.Contributions),
        nameof(AuthoringExtensionManifest.Limits),
        nameof(AuthoringExtensionManifest.StateSchemaVersion),
        nameof(AuthoringExtensionManifest.DataSchemaVersion),
        nameof(AuthoringExtensionManifest.UpdatePolicy),
        nameof(AuthoringExtensionManifest.MigrationPolicy),
        nameof(AuthoringExtensionManifest.UninstallPolicy),
        nameof(AuthoringExtensionManifest.AllowExecutionFallback));

    private static readonly ImmutableHashSet<string> s_hostApiFields = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        nameof(AuthoringHostApiRange.Minimum),
        nameof(AuthoringHostApiRange.Maximum));

    private static readonly ImmutableHashSet<string> s_contributionFields = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        nameof(AuthoringContributionDeclaration.Id),
        nameof(AuthoringContributionDeclaration.Kind),
        nameof(AuthoringContributionDeclaration.ExecutionClass),
        nameof(AuthoringContributionDeclaration.Entrypoint),
        nameof(AuthoringContributionDeclaration.Capabilities));

    private static readonly ImmutableHashSet<string> s_entrypointFields = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        nameof(AuthoringEntrypointIdentity.Format),
        nameof(AuthoringEntrypointIdentity.PathOrAdapterId),
        nameof(AuthoringEntrypointIdentity.ContentSha256));

    private static readonly ImmutableHashSet<string> s_limitFields = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        nameof(AuthoringResourceLimits.MaximumCpuTime),
        nameof(AuthoringResourceLimits.WallClock),
        nameof(AuthoringResourceLimits.MemoryBytes),
        nameof(AuthoringResourceLimits.MaximumRequestBytes),
        nameof(AuthoringResourceLimits.MaximumResponseBytes),
        nameof(AuthoringResourceLimits.MaximumConcurrentCalls),
        nameof(AuthoringResourceLimits.MaximumQueueDepth),
        nameof(AuthoringResourceLimits.MaximumObjectDepth),
        nameof(AuthoringResourceLimits.MaximumRestarts),
        nameof(AuthoringResourceLimits.MaximumNetworkBytes),
        nameof(AuthoringResourceLimits.MaximumFileBytes),
        nameof(AuthoringResourceLimits.MaximumStateBytes));

    private static readonly JsonSerializerOptions s_serializerOptions = new()
    {
        MaxDepth = 16,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static string RegistryIdentity { get; } = ComputeRegistryIdentity();

    public static VerifiedAuthoringExtensionContract ParseAndVerify(
        ReadOnlySpan<byte> utf8Json,
        AuthoringHostPlatform targetPlatform)
    {
        if (utf8Json.IsEmpty || utf8Json.Length > MaximumManifestBytes)
        {
            throw new AuthoringExtensionContractException("Manifest size is outside the closed bound.");
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(utf8Json.ToArray(), new JsonDocumentOptions
            {
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16
            });
            RejectDuplicateProperties(document.RootElement);
            ValidateClosedJsonShape(document.RootElement);
            AuthoringExtensionManifest manifest = JsonSerializer.Deserialize<AuthoringExtensionManifest>(
                utf8Json,
                s_serializerOptions) ?? throw new AuthoringExtensionContractException("Manifest is required.");
            return Verify(manifest, targetPlatform);
        }
        catch (JsonException exception)
        {
            throw new AuthoringExtensionContractException($"Manifest JSON is not closed: {exception.Message}");
        }
    }

    public static VerifiedAuthoringExtensionContract Verify(
        AuthoringExtensionManifest manifest,
        AuthoringHostPlatform targetPlatform = AuthoringHostPlatform.ServerLinux)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        if (manifest.SchemaVersion != CurrentSchemaVersion || manifest.RegistryVersion != CurrentRegistryVersion)
        {
            throw new AuthoringExtensionContractException("Unknown manifest or registry version.");
        }

        RequireIdentifier(manifest.Id, "extension");
        RequireIdentifier(manifest.Publisher, "publisher");
        RequireBoundedReference(manifest.SignatureReference, "signature");
        RequireBoundedReference(manifest.TrustPolicyReference, "trust policy");
        if (string.IsNullOrWhiteSpace(manifest.Version) ||
            manifest.Version.Length > 64 ||
            !VersionPattern().IsMatch(manifest.Version) ||
            !Version.TryParse(manifest.Version, out _))
        {
            throw new AuthoringExtensionContractException("Extension version must be a closed numeric version.");
        }

        RequireDigest(manifest.PackageSha256, "package");
        RequireDigest(manifest.ContentSha256, "content");
        if (manifest.HostApi is null)
        {
            throw new AuthoringExtensionContractException("Host API range is required.");
        }

        if (manifest.HostApi.Minimum < 1 ||
            manifest.HostApi.Maximum < manifest.HostApi.Minimum ||
            manifest.HostApi.Maximum > 1_000_000 ||
            CurrentHostApiVersion < manifest.HostApi.Minimum ||
            CurrentHostApiVersion > manifest.HostApi.Maximum)
        {
            throw new AuthoringExtensionContractException("Host API range is invalid or incompatible.");
        }

        if (!Enum.IsDefined(targetPlatform) ||
            manifest.SupportedPlatforms.IsDefaultOrEmpty ||
            manifest.SupportedPlatforms.Distinct().Count() != manifest.SupportedPlatforms.Length ||
            manifest.SupportedPlatforms.Any(static platform => !Enum.IsDefined(platform)) ||
            !manifest.SupportedPlatforms.Contains(targetPlatform))
        {
            throw new AuthoringExtensionContractException("Target platform is unsupported or ambiguously declared.");
        }

        if (manifest.AllowExecutionFallback)
        {
            throw new AuthoringExtensionContractException("Execution fallback is forbidden.");
        }

        if (manifest.StateSchemaVersion < 1 || manifest.DataSchemaVersion < 1 ||
            manifest.StateSchemaVersion > 1_000_000 || manifest.DataSchemaVersion > 1_000_000 ||
            !Enum.IsDefined(manifest.UpdatePolicy) ||
            !Enum.IsDefined(manifest.MigrationPolicy) ||
            !Enum.IsDefined(manifest.UninstallPolicy))
        {
            throw new AuthoringExtensionContractException("State, data, update, migration, and uninstall policies must be explicit.");
        }

        if (manifest.Contributions.IsDefaultOrEmpty || manifest.Contributions.Length > MaximumContributions)
        {
            throw new AuthoringExtensionContractException("Contribution count is outside the closed bound.");
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthoringContributionDeclaration contribution in manifest.Contributions)
        {
            RequireIdentifier(contribution.Id, "contribution");
            if (!ids.Add(contribution.Id))
            {
                throw new AuthoringExtensionContractException("Contribution identifiers must be globally unique within the package.");
            }

            if (!Enum.IsDefined(contribution.Kind) || !Enum.IsDefined(contribution.ExecutionClass))
            {
                throw new AuthoringExtensionContractException("Contribution type or execution class is not registered.");
            }

            ValidateEntrypoint(contribution.Entrypoint, contribution.ExecutionClass);
            if (contribution.Capabilities.IsDefault)
            {
                throw new AuthoringExtensionContractException("Capabilities must be explicitly empty or declared.");
            }

            if (contribution.Capabilities.Length > Enum.GetValues<AuthoringCapability>().Length ||
                contribution.Capabilities.Distinct().Count() != contribution.Capabilities.Length ||
                contribution.Capabilities.Any(static capability => !Enum.IsDefined(capability)))
            {
                throw new AuthoringExtensionContractException("Capability is duplicated or not registered.");
            }
        }

        ValidateLimits(manifest.Limits);
        AuthoringExtensionManifest snapshot = manifest with
        {
            SupportedPlatforms = [.. manifest.SupportedPlatforms],
            Contributions =
            [
                .. manifest.Contributions.Select(static contribution => contribution with
                {
                    Capabilities = [.. contribution.Capabilities]
                })
            ]
        };
        byte[] canonical = SerializeCanonical(snapshot);
        byte[] registryIdentity = Encoding.ASCII.GetBytes(RegistryIdentity);
        byte[] identityMaterial = new byte[registryIdentity.Length + 1 + canonical.Length];
        registryIdentity.CopyTo(identityMaterial, 0);
        canonical.CopyTo(identityMaterial, registryIdentity.Length + 1);
        string identity = Convert.ToHexStringLower(SHA256.HashData(identityMaterial));
        return new VerifiedAuthoringExtensionContract(snapshot, identity, RegistryIdentity);
    }

    public static AuthoringExtensionRegistrySnapshot CreateRegistry(
        ImmutableArray<VerifiedAuthoringExtensionContract> contracts,
        AuthoringCoreAuthorityRegistry coreAuthorities)
    {
        ArgumentNullException.ThrowIfNull(coreAuthorities);
        if (contracts.IsDefault || contracts.Length > MaximumExtensions)
        {
            throw new AuthoringExtensionContractException("Extension registry count is outside the closed bound.");
        }

        AuthoringCoreAuthorityRegistry coreSnapshot = SnapshotAndValidateCoreAuthorities(coreAuthorities);
        var allIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (string coreId in EnumerateCoreAuthorities(coreSnapshot))
        {
            if (!allIds.Add(coreId))
            {
                throw new AuthoringExtensionContractException("Core authority identifiers must be globally unique.");
            }
        }

        var verifiedContracts = ImmutableArray.CreateBuilder<VerifiedAuthoringExtensionContract>(contracts.Length);
        foreach (VerifiedAuthoringExtensionContract candidate in contracts)
        {
            ArgumentNullException.ThrowIfNull(candidate);
            AuthoringExtensionManifest manifest = candidate.Manifest ??
                throw new AuthoringExtensionContractException("Verified extension manifest is required.");
            AuthoringHostPlatform platform = manifest.SupportedPlatforms.IsDefaultOrEmpty
                ? throw new AuthoringExtensionContractException("A supported platform is required.")
                : manifest.SupportedPlatforms[0];
            VerifiedAuthoringExtensionContract verified = Verify(manifest, platform);
            RequireDigest(candidate.ContractIdentity, "contract");
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(candidate.ContractIdentity),
                    Encoding.ASCII.GetBytes(verified.ContractIdentity)) ||
                !string.Equals(candidate.RegistryIdentity, RegistryIdentity, StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Extension contract identity is stale or tampered.");
            }

            AddGlobalIdentity(allIds, manifest.Id);
            foreach (AuthoringContributionDeclaration contribution in manifest.Contributions)
            {
                AddGlobalIdentity(allIds, contribution.Id);
            }

            verifiedContracts.Add(verified);
        }

        ImmutableArray<VerifiedAuthoringExtensionContract> snapshot =
            [.. verifiedContracts.OrderBy(static contract => contract.Manifest.Id, StringComparer.Ordinal)];
        byte[] canonical = JsonSerializer.SerializeToUtf8Bytes(
            new AuthoringExtensionRegistryIdentityMaterial(
                CurrentRegistryVersion,
                RegistryIdentity,
                [.. snapshot.Select(static contract => contract.ContractIdentity)],
                coreSnapshot),
            s_serializerOptions);
        return new AuthoringExtensionRegistrySnapshot(
            CurrentRegistryVersion,
            snapshot,
            coreSnapshot,
            Convert.ToHexStringLower(SHA256.HashData(canonical)));
    }

    private static byte[] SerializeCanonical(AuthoringExtensionManifest manifest)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using var writer = new Utf8JsonWriter(buffer);
        JsonSerializer.Serialize(writer, manifest, s_serializerOptions);
        writer.Flush();
        return buffer.WrittenSpan.ToArray();
    }

    private static void ValidateEntrypoint(
        AuthoringEntrypointIdentity entrypoint,
        AuthoringExecutionClass executionClass)
    {
        if (entrypoint is null)
        {
            throw new AuthoringExtensionContractException("Entrypoint identity is required.");
        }

        if (string.IsNullOrWhiteSpace(entrypoint.PathOrAdapterId) ||
            entrypoint.PathOrAdapterId.Length > 256 ||
            entrypoint.PathOrAdapterId.Any(char.IsControl) ||
            entrypoint.PathOrAdapterId.Length != entrypoint.PathOrAdapterId.Trim().Length)
        {
            throw new AuthoringExtensionContractException("Entrypoint must be a bounded package path or registered adapter identity.");
        }

        AuthoringEntrypointFormat requiredFormat = executionClass switch
        {
            AuthoringExecutionClass.TrustedHostAdapter => AuthoringEntrypointFormat.HostAdapterIdentity,
            AuthoringExecutionClass.IsolatedWorkerWasm => AuthoringEntrypointFormat.WasmModule,
            AuthoringExecutionClass.OutOfProcessService => AuthoringEntrypointFormat.ServiceExecutable,
            _ => throw new AuthoringExtensionContractException("Execution class is not registered.")
        };
        if (entrypoint.Format != requiredFormat)
        {
            throw new AuthoringExtensionContractException("Entrypoint format does not match the exact execution class.");
        }

        bool validIdentity = entrypoint.Format switch
        {
            AuthoringEntrypointFormat.HostAdapterIdentity => IdentifierPattern().IsMatch(entrypoint.PathOrAdapterId),
            AuthoringEntrypointFormat.WasmModule or AuthoringEntrypointFormat.ServiceExecutable =>
                PackagePathPattern().IsMatch(entrypoint.PathOrAdapterId) &&
                !entrypoint.PathOrAdapterId.StartsWith("/", StringComparison.Ordinal) &&
                !entrypoint.PathOrAdapterId.EndsWith("/", StringComparison.Ordinal) &&
                !entrypoint.PathOrAdapterId.Contains("//", StringComparison.Ordinal) &&
                entrypoint.PathOrAdapterId.Split('/').All(static segment => segment is not "" and not "." and not ".."),
            _ => false
        };
        if (!validIdentity)
        {
            throw new AuthoringExtensionContractException("Entrypoint must not contain a URL, code string, or arbitrary module graph.");
        }

        RequireDigest(entrypoint.ContentSha256, "entrypoint content");
    }

    private static void ValidateLimits(AuthoringResourceLimits limits)
    {
        if (limits is null ||
            limits.MaximumCpuTime <= TimeSpan.Zero || limits.MaximumCpuTime > TimeSpan.FromMinutes(5) ||
            limits.WallClock <= TimeSpan.Zero || limits.WallClock > TimeSpan.FromMinutes(5) ||
            limits.MemoryBytes is < 1 or > 536_870_912 ||
            limits.MaximumRequestBytes is < 1 or > 16_777_216 ||
            limits.MaximumResponseBytes is < 1 or > 16_777_216 ||
            limits.MaximumConcurrentCalls is < 1 or > 32 ||
            limits.MaximumQueueDepth is < 1 or > 1024 ||
            limits.MaximumObjectDepth is < 1 or > 16 ||
            limits.MaximumRestarts is < 0 or > 10 ||
            limits.MaximumNetworkBytes is < 0 or > 1_073_741_824 ||
            limits.MaximumFileBytes is < 0 or > 1_073_741_824 ||
            limits.MaximumStateBytes is < 0 or > 1_073_741_824)
        {
            throw new AuthoringExtensionContractException("Resource limits are missing or outside host bounds.");
        }
    }

    private static void ValidateClosedJsonShape(JsonElement root)
    {
        RequireExactObject(root, s_manifestFields, "manifest");
        RequireExactObject(root.GetProperty(nameof(AuthoringExtensionManifest.HostApi)), s_hostApiFields, "host API");
        RequireExactObject(root.GetProperty(nameof(AuthoringExtensionManifest.Limits)), s_limitFields, "resource limits");

        JsonElement contributions = root.GetProperty(nameof(AuthoringExtensionManifest.Contributions));
        if (contributions.ValueKind != JsonValueKind.Array)
        {
            throw new AuthoringExtensionContractException("Contributions must be a closed array.");
        }

        foreach (JsonElement contribution in contributions.EnumerateArray())
        {
            RequireExactObject(contribution, s_contributionFields, "contribution");
            RequireExactObject(
                contribution.GetProperty(nameof(AuthoringContributionDeclaration.Entrypoint)),
                s_entrypointFields,
                "entrypoint");
        }
    }

    private static void RequireExactObject(
        JsonElement element,
        ImmutableHashSet<string> requiredFields,
        string field)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new AuthoringExtensionContractException($"The {field} object is required.");
        }

        var actualFields = element.EnumerateObject()
            .Select(static property => property.Name)
            .ToImmutableHashSet(StringComparer.Ordinal);
        if (!actualFields.SetEquals(requiredFields))
        {
            throw new AuthoringExtensionContractException($"The {field} object is missing or contains unknown fields.");
        }
    }

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new AuthoringExtensionContractException("Manifest contains a duplicate property.");
                }

                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item);
            }
        }
    }

    private static void RequireIdentifier(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            value.Length > MaximumIdentifierLength ||
            !IdentifierPattern().IsMatch(value))
        {
            throw new AuthoringExtensionContractException($"The {field} identifier is invalid or broad.");
        }

        if (value.StartsWith("fsusblog.core.", StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Core authority overrides are forbidden.");
        }
    }

    private static void RequireBoundedReference(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128 || !ReferencePattern().IsMatch(value))
        {
            throw new AuthoringExtensionContractException($"The {field} reference is invalid.");
        }
    }

    private static void RequireDigest(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || !Sha256Pattern().IsMatch(value))
        {
            throw new AuthoringExtensionContractException($"The {field} identity must be a lowercase SHA-256 digest.");
        }
    }

    private static AuthoringCoreAuthorityRegistry SnapshotAndValidateCoreAuthorities(
        AuthoringCoreAuthorityRegistry authorities) => new(
        SnapshotAuthorityIds(authorities.CommandIds, "command"),
        SnapshotAuthorityIds(authorities.RouteIds, "route"),
        SnapshotAuthorityIds(authorities.PropertyIds, "property"),
        SnapshotAuthorityIds(authorities.SavedViewOperatorIds, "saved-view operator"),
        SnapshotAuthorityIds(authorities.SecurityPolicyIds, "security policy"));

    private static ImmutableArray<string> SnapshotAuthorityIds(ImmutableArray<string> ids, string authority)
    {
        if (ids.IsDefault || ids.Length > MaximumExtensions)
        {
            throw new AuthoringExtensionContractException($"Core {authority} authority count is outside the closed bound.");
        }

        foreach (string id in ids)
        {
            if (string.IsNullOrWhiteSpace(id) ||
                id.Length > 256 ||
                id.Length != id.Trim().Length ||
                id.Any(char.IsControl))
            {
                throw new AuthoringExtensionContractException($"Core {authority} authority identity is invalid or unbounded.");
            }
        }

        return [.. ids.Order(StringComparer.Ordinal)];
    }

    private static IEnumerable<string> EnumerateCoreAuthorities(AuthoringCoreAuthorityRegistry authorities) =>
        authorities.CommandIds
            .Concat(authorities.RouteIds)
            .Concat(authorities.PropertyIds)
            .Concat(authorities.SavedViewOperatorIds)
            .Concat(authorities.SecurityPolicyIds);

    private static void AddGlobalIdentity(HashSet<string> allIds, string id)
    {
        if (!allIds.Add(id))
        {
            throw new AuthoringExtensionContractException(
                "Extension and contribution identifiers must be globally unique and cannot override core authority.");
        }
    }

    private static string ComputeRegistryIdentity()
    {
        string material = string.Join(
            "\n",
            new[]
            {
                $"schema:{CurrentSchemaVersion}",
                $"registry:{CurrentRegistryVersion}",
                $"host-api:{CurrentHostApiVersion}",
                RegistryValues<AuthoringContributionKind>("contribution"),
                RegistryValues<AuthoringCapability>("capability"),
                RegistryValues<AuthoringExecutionClass>("execution-class"),
                RegistryValues<AuthoringHostPlatform>("platform"),
                RegistryValues<AuthoringEntrypointFormat>("entrypoint"),
                RegistryValues<AuthoringUpdatePolicy>("update"),
                RegistryValues<AuthoringMigrationPolicy>("migration"),
                RegistryValues<AuthoringUninstallPolicy>("uninstall")
            });
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
    }

    private static string RegistryValues<T>(string registry)
        where T : struct, Enum => string.Concat(
            registry,
            ":",
            string.Join(",", Enum.GetValues<T>().Select(static value => $"{Convert.ToInt32(value)}={value}")));

    private sealed record AuthoringExtensionRegistryIdentityMaterial(
        int RegistryVersion,
        string ContractRegistryIdentity,
        ImmutableArray<string> ContractIdentities,
        AuthoringCoreAuthorityRegistry CoreAuthorities);

    [GeneratedRegex("^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$", RegexOptions.CultureInvariant)]
    private static partial Regex IdentifierPattern();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._:/-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex ReferencePattern();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Pattern();

    [GeneratedRegex("^[0-9]+(?:\\.[0-9]+){1,3}$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionPattern();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._/-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex PackagePathPattern();
}
