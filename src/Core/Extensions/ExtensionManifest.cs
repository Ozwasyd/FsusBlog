using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace FsusBlog.V2.Core.Extensions;

public enum ExtensionCapability
{
    DocumentRangeRead,
    DocumentFullRead,
    SelectionRead,
    DocumentMutationRequest,
    ArticleQuery,
    NetworkDestination,
    FileSystemRootRead,
    FileSystemRootProposeWrite,
    DiagnosticReport,
    StateStorageRead,
    StateStorageWrite
}

public enum ExtensionPlatform { Browser, AvaloniaDesktop, ServerLinux }

public sealed record ExtensionLimits(TimeSpan MaximumCpuTime, TimeSpan WallClock, long MemoryBytes,
    int MaximumRequestBytes, int MaximumResponseBytes, int MaximumConcurrentCalls, int MaximumQueueDepth,
    int MaximumObjectDepth, int MaximumRestarts, long MaximumNetworkBytes, long MaximumFileBytes, long MaximumStateBytes);

public sealed record ExtensionEntrypoint(int Format, string PathOrAdapterId, string ContentSha256);
public sealed record ExtensionContribution(string Id, int Kind, int ExecutionClass, ExtensionEntrypoint Entrypoint,
    ImmutableArray<ExtensionCapability> Capabilities);
public sealed record ExtensionApiRange(int Minimum, int Maximum);
public sealed record ExtensionManifest(int SchemaVersion, int RegistryVersion, string Id, string Version,
    string PackageSha256, string ContentSha256, string Publisher, string SignatureReference, string TrustPolicyReference,
    ExtensionApiRange HostApi, ImmutableArray<ExtensionPlatform> SupportedPlatforms,
    ImmutableArray<ExtensionContribution> Contributions, ExtensionLimits Limits, int StateSchemaVersion, int DataSchemaVersion,
    int UpdatePolicy, int MigrationPolicy, int UninstallPolicy, bool AllowExecutionFallback);

public sealed class ExtensionRejectedException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

internal static partial class ExtensionManifestReader
{
    internal const int ManifestBytes = 256 * 1024;

    internal static readonly JsonSerializerOptions Json = new()
    {
        MaxDepth = 16,
        RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true,
        AllowDuplicateProperties = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    internal static ExtensionManifest Read(ReadOnlySpan<byte> json, ExtensionPlatform platform)
    {
        if (json.IsEmpty || json.Length > ManifestBytes) throw Reject("manifest-size");
        ExtensionManifest manifest;
        try { manifest = JsonSerializer.Deserialize<ExtensionManifest>(json, Json) ?? throw Reject("manifest-absent"); }
        catch (JsonException) { throw Reject("manifest-shape"); }

        if (manifest.SchemaVersion != 1 || manifest.RegistryVersion != 1 || manifest.AllowExecutionFallback ||
            !IsIdentifier(manifest.Id) || !IsIdentifier(manifest.Publisher) ||
            !IsReference(manifest.SignatureReference) || !IsReference(manifest.TrustPolicyReference) ||
            !IsVersion(manifest.Version) ||
            !IsDigest(manifest.ContentSha256) || !IsDigest(manifest.PackageSha256) ||
            manifest.HostApi.Minimum != 1 || manifest.HostApi.Maximum is < 1 or > 1_000_000 ||
            manifest.StateSchemaVersion is < 1 or > 1_000_000 || manifest.DataSchemaVersion is < 1 or > 1_000_000 ||
            manifest.UpdatePolicy != 0 || manifest.MigrationPolicy != 0 || manifest.UninstallPolicy is not (0 or 1))
            throw Reject("manifest-contract");

        if (manifest.SupportedPlatforms.IsDefaultOrEmpty || manifest.SupportedPlatforms.Length > 3 ||
            manifest.SupportedPlatforms.Any(p => !Enum.IsDefined(p)) ||
            manifest.SupportedPlatforms.Distinct().Count() != manifest.SupportedPlatforms.Length ||
            !manifest.SupportedPlatforms.Contains(platform)) throw Reject("manifest-platform");

        if (manifest.Contributions.IsDefaultOrEmpty || manifest.Contributions.Length > 1000)
            throw Reject("manifest-contributions");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var contribution in manifest.Contributions)
        {
            if (contribution is null || !IsIdentifier(contribution.Id) || !ids.Add(contribution.Id) ||
                contribution.Kind is < 0 or > 9 || contribution.ExecutionClass is < 0 or > 2 ||
                contribution.Entrypoint.Format != contribution.ExecutionClass ||
                !IsDigest(contribution.Entrypoint.ContentSha256) ||
                (contribution.ExecutionClass == 0
                    ? !IsIdentifier(contribution.Entrypoint.PathOrAdapterId)
                    : !IsPackagePath(contribution.Entrypoint.PathOrAdapterId)) || contribution.Capabilities.IsDefault ||
                contribution.Capabilities.Length > 11 || contribution.Capabilities.Any(c => !Enum.IsDefined(c)) ||
                contribution.Capabilities.Distinct().Count() != contribution.Capabilities.Length)
                throw Reject("manifest-contribution");
        }

        var limits = manifest.Limits;
        var maximumTime = TimeSpan.FromMinutes(5);
        if (limits.MaximumCpuTime <= TimeSpan.Zero || limits.MaximumCpuTime > maximumTime ||
            limits.WallClock <= TimeSpan.Zero || limits.WallClock > maximumTime ||
            limits.MemoryBytes is < 1 or > 536_870_912 || limits.MaximumRequestBytes is < 1 or > 16_777_216 ||
            limits.MaximumResponseBytes is < 1 or > 16_777_216 || limits.MaximumConcurrentCalls is < 1 or > 32 ||
            limits.MaximumQueueDepth is < 1 or > 1024 || limits.MaximumObjectDepth is < 1 or > 16 ||
            limits.MaximumRestarts is < 0 or > 10 || limits.MaximumNetworkBytes is < 0 or > 1_073_741_824 ||
            limits.MaximumFileBytes is < 0 or > 1_073_741_824 || limits.MaximumStateBytes is < 0 or > 1_073_741_824)
            throw Reject("manifest-resource-limits");
        return manifest;
    }

    internal static bool IsIdentifier(string value) => value.Length <= 128 && Identifier().IsMatch(value);
    internal static bool IsVersion(string value) => value.Length <= 64 && NumericVersion().IsMatch(value) && Version.TryParse(value, out _);
    internal static bool IsDigest(string value) => value.Length == 64 && value.All(char.IsAsciiHexDigitLower);
    internal static bool IsPackagePath(string value) => value.Length is > 0 and <= 256 && PackagePath().IsMatch(value) &&
        value.Split('/').All(part => part is not ("" or "." or "..") &&
            !part.EndsWith('.') && !part.EndsWith("postinstall", StringComparison.OrdinalIgnoreCase));

    internal static bool IsOpaqueReference(string value, string prefix) =>
        value.Length <= 256 && value.StartsWith(prefix, StringComparison.Ordinal) &&
        IsIdentifier(value[prefix.Length..]);

    private static bool IsReference(string value) => value.Length <= 128 && Reference().IsMatch(value);
    private static ExtensionRejectedException Reject(string code) => new(code);

    [GeneratedRegex("\\A[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex Identifier();

    [GeneratedRegex("\\A[0-9]+(?:\\.[0-9]+){1,3}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex NumericVersion();

    [GeneratedRegex("\\A[A-Za-z0-9][A-Za-z0-9._/-]*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex PackagePath();

    [GeneratedRegex("\\A[A-Za-z0-9][A-Za-z0-9._:/-]*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex Reference();
}
