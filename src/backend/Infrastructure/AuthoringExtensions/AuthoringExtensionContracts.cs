using System.Buffers;
using System.Collections.Immutable;
using System.Security.Cryptography;
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
    TimeSpan WallClock,
    long MemoryBytes,
    int MaximumRequestBytes,
    int MaximumResponseBytes,
    int MaximumConcurrentCalls,
    int MaximumQueueDepth,
    int MaximumObjectDepth);

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
    bool AllowExecutionFallback = false);

public sealed record VerifiedAuthoringExtensionContract(
    AuthoringExtensionManifest Manifest,
    string ContractIdentity);

public sealed class AuthoringExtensionContractException(string message) : InvalidOperationException(message);

public static partial class AuthoringExtensionContractValidator
{
    public const int CurrentSchemaVersion = 1;
    public const int CurrentRegistryVersion = 1;
    public const int CurrentHostApiVersion = 1;
    public const int MaximumContributions = 1000;

    private static readonly JsonSerializerOptions s_serializerOptions = new()
    {
        MaxDepth = 16,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static VerifiedAuthoringExtensionContract ParseAndVerify(
        ReadOnlySpan<byte> utf8Json,
        AuthoringHostPlatform targetPlatform)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(utf8Json.ToArray(), new JsonDocumentOptions
            {
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16
            });
            RejectDuplicateProperties(document.RootElement);
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
        if (!Version.TryParse(manifest.Version, out _))
        {
            throw new AuthoringExtensionContractException("Extension version must be a closed numeric version.");
        }

        RequireDigest(manifest.PackageSha256, "package");
        RequireDigest(manifest.ContentSha256, "content");
        if (manifest.HostApi.Minimum < 1 ||
            manifest.HostApi.Maximum < manifest.HostApi.Minimum ||
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

            if (contribution.Capabilities.Distinct().Count() != contribution.Capabilities.Length ||
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
        string identity = Convert.ToHexStringLower(SHA256.HashData(canonical));
        return new VerifiedAuthoringExtensionContract(snapshot, identity);
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
        if (!Enum.IsDefined(entrypoint.Format) ||
            string.IsNullOrWhiteSpace(entrypoint.PathOrAdapterId) ||
            entrypoint.PathOrAdapterId.Length > 256 ||
            entrypoint.PathOrAdapterId.Contains("://", StringComparison.Ordinal) ||
            entrypoint.PathOrAdapterId.Contains("..", StringComparison.Ordinal) ||
            entrypoint.PathOrAdapterId.ContainsAny(['\r', '\n', '{', '}', ';']))
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

        RequireDigest(entrypoint.ContentSha256, "entrypoint content");
    }

    private static void ValidateLimits(AuthoringResourceLimits limits)
    {
        if (limits.WallClock <= TimeSpan.Zero || limits.WallClock > TimeSpan.FromMinutes(5) ||
            limits.MemoryBytes is < 1 or > 536_870_912 ||
            limits.MaximumRequestBytes is < 1 or > 16_777_216 ||
            limits.MaximumResponseBytes is < 1 or > 16_777_216 ||
            limits.MaximumConcurrentCalls is < 1 or > 32 ||
            limits.MaximumQueueDepth is < 1 or > 1024 ||
            limits.MaximumObjectDepth is < 1 or > 16)
        {
            throw new AuthoringExtensionContractException("Resource limits are missing or outside host bounds.");
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
        if (string.IsNullOrWhiteSpace(value) || !IdentifierPattern().IsMatch(value))
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

    [GeneratedRegex("^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$", RegexOptions.CultureInvariant)]
    private static partial Regex IdentifierPattern();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._:/-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex ReferencePattern();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Pattern();
}
