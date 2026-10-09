using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Package-owned metadata only; registration does not authorize a query.</summary>
public sealed record AuthoringRegisteredFilter(
    AuthoringFilterContribution Contribution,
    string PackageIdentity,
    string ContentSha256,
    AuthoringExecutionTarget Target);

/// <summary>Reads the signed entry through the original closed filter parser.</summary>
public sealed class VerifiedPackageAuthoringFilterSource
{
    public const string EntryPath = "authoring/filters.v1.json";

    public ImmutableArray<AuthoringRegisteredFilter> Read(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets)
    {
        ArgumentNullException.ThrowIfNull(package);
        Require(!targets.IsDefault, "filter_targets_missing");
        AuthoringExtensionManifest manifest = package.Contract.Manifest;
        AuthoringContributionDeclaration[] declarations = [.. manifest.Contributions.Where(static declaration =>
            declaration.Kind == AuthoringContributionKind.ArticleLibraryFilter)];
        AuthoringPackageEntry[] entries = [.. package.Contents.Entries.Where(static entry => entry.Path == EntryPath)];
        Require(entries.Length <= 1, "filter_package_entry_duplicate");
        if (declarations.Length == 0)
        {
            Require(entries.Length == 0, "filter_package_entry_undeclared");
            return [];
        }

        Require(entries.Length == 1, "filter_package_entry_missing");
        AuthoringPackageEntry metadata = entries[0];
        Require(!metadata.Content.IsDefaultOrEmpty
            && metadata.Content.Length <= AuthoringFilterContributionContracts.MaximumJsonBytes
            && !metadata.IsSymbolicLink && !metadata.IsReparsePoint && !metadata.IsPostInstallScript,
            "filter_package_entry_invalid");
        Require(Convert.ToHexStringLower(SHA256.HashData(metadata.Content.AsSpan())) == metadata.ContentSha256,
            "filter_package_entry_digest_drift");
        Require(AuthoringPackageVerifier.ComputeContentDigest(package.Contents.Entries) == manifest.ContentSha256
            && AuthoringPackageVerifier.ComputePackageDigest(package.Contents.Entries) == manifest.PackageSha256,
            "filter_package_payload_drift");
        Require(!string.IsNullOrEmpty(package.PackageIdentity), "filter_package_identity_missing");
        Require(targets.Select(static target => target.ContributionId).Distinct(StringComparer.Ordinal).Count()
            == targets.Length, "filter_target_duplicate");

        try
        {
            using JsonDocument document = JsonDocument.Parse(metadata.Content.ToArray(), new JsonDocumentOptions
            {
                MaxDepth = 12
            });
            Require(document.RootElement.ValueKind == JsonValueKind.Array, "filter_package_entry_shape_invalid");
            Require(document.RootElement.GetArrayLength() == declarations.Length
                && declarations.Length <= AuthoringFilterContributionContracts.MaximumContributions,
                "filter_package_entry_partial");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var result = ImmutableArray.CreateBuilder<AuthoringRegisteredFilter>();
            foreach (JsonElement element in document.RootElement.EnumerateArray())
            {
                Require(element.ValueKind == JsonValueKind.Object, "filter_package_entry_shape_invalid");
                // A payload cannot embed the hash of the complete payload containing it.
                // Runtime binding is derived from the already verified manifest, not supplied
                // by the plugin. Duplicate/unknown remaining fields still reach the sole parser.
                Require(!element.TryGetProperty(nameof(AuthoringFilterContribution.PackageSha256), out _),
                    "filter_package_digest_self_reference");
                using var bound = new MemoryStream();
                using (var writer = new Utf8JsonWriter(bound))
                {
                    writer.WriteStartObject();
                    foreach (JsonProperty property in element.EnumerateObject())
                    {
                        property.WriteTo(writer);
                    }
                    writer.WriteString(nameof(AuthoringFilterContribution.PackageSha256), manifest.PackageSha256);
                    writer.WriteEndObject();
                }
                AuthoringFilterContribution contribution = AuthoringFilterContributionContracts.ParseContribution(
                    bound.ToArray());
                Require(seen.Add(contribution.FilterId), "filter_identity_duplicate");
                AuthoringContributionDeclaration declaration = declarations.SingleOrDefault(candidate =>
                    candidate.Id == contribution.FilterId)
                    ?? throw new AuthoringFilterContractException("filter_package_contribution_undeclared");
                AuthoringExecutionTarget target = targets.SingleOrDefault(candidate =>
                    candidate.ContributionId == contribution.FilterId)
                    ?? throw new AuthoringFilterContractException("filter_target_missing");
                Require(contribution.PluginId == manifest.Id && contribution.PluginVersion == manifest.Version
                    && contribution.PackageSha256 == manifest.PackageSha256,
                    "filter_package_binding_drift");
                Require(declaration.Capabilities.Contains(AuthoringCapability.ArticleQuery)
                    && !declaration.Capabilities.Any(static capability => capability is
                        AuthoringCapability.NetworkDestination or AuthoringCapability.FileSystemRootRead
                        or AuthoringCapability.FileSystemRootProposeWrite or AuthoringCapability.DocumentMutationRequest)
                    && declaration.ExecutionClass == AuthoringExecutionClass.IsolatedWorkerWasm,
                    "filter_package_capability_forbidden");
                Require(target.Status == AuthoringExecutionResolutionStatus.Ready
                    && target.ExtensionId == manifest.Id && target.ExtensionVersion == manifest.Version
                    && target.PackageSha256 == manifest.PackageSha256
                    && target.ContributionKind == declaration.Kind && target.ExecutionClass == declaration.ExecutionClass
                    && target.EntrypointIdentity == declaration.Entrypoint.PathOrAdapterId
                    && target.RuntimeIdentity is { Length: 64 }
                    && target.RuntimeIdentity.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f'),
                    "filter_target_binding_drift");
                result.Add(new(contribution, package.PackageIdentity, manifest.ContentSha256, target));
            }
            return result.ToImmutable();
        }
        catch (JsonException)
        {
            throw new AuthoringFilterContractException("filter_package_entry_json_invalid");
        }
    }

    private static void Require(bool condition, string reason)
    {
        if (!condition)
        {
            throw new AuthoringFilterContractException(reason);
        }
    }
}

/// <summary>
/// Lifecycle-owned registrations reuse the sole structural mapper. Neither active
/// metadata nor a current snapshot manufactures permission, index or query authority.
/// </summary>
public sealed class AuthoringFilterRegistryAuthority(
    VerifiedPackageAuthoringFilterSource source,
    AuthoringCoreAuthorityRegistry coreAuthorities,
    IAuthorSavedViewQueryValidator validator)
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, ImmutableArray<AuthoringRegisteredFilter>> _active = new(StringComparer.Ordinal);

    public void ValidateActivation(VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets)
    {
        ImmutableArray<AuthoringRegisteredFilter> registrations = source.Read(package, targets);
        lock (_lock)
        {
            RequireNewActivation(package.Contract.Manifest.Id);
            _ = BuildMapper(_active.Values.SelectMany(static value => value).Concat(registrations));
        }
    }

    public void ActivateAtomically(VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets)
    {
        ImmutableArray<AuthoringRegisteredFilter> registrations = source.Read(package, targets);
        lock (_lock)
        {
            string extensionId = package.Contract.Manifest.Id;
            RequireNewActivation(extensionId);
            _ = BuildMapper(_active.Values.SelectMany(static value => value).Concat(registrations));
            _active.Add(extensionId, registrations);
        }
    }

    public void Remove(string extensionId)
    {
        lock (_lock)
        {
            _active.Remove(extensionId);
        }
    }

    public ImmutableArray<AuthoringRegisteredFilter> Snapshot()
    {
        lock (_lock)
        {
            return [.. _active.Values.SelectMany(static value => value)];
        }
    }

    public async Task<AuthoringFilterMappingResult> MapAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewQuery original,
        ImmutableArray<AuthoringFilterConfiguration> configurations,
        CancellationToken cancellationToken = default)
    {
        if (!configurations.IsDefault && configurations.Any(static configuration => configuration is null))
        {
            return new(AuthoringFilterMappingStatus.Rejected, null, null, ["filter_config_missing"]);
        }
        AuthoringFilterContributionQueryMapper mapper;
        Dictionary<string, ImmutableArray<AuthoringRegisteredFilter>> selected;
        lock (_lock)
        {
            mapper = BuildMapper(_active.Values.SelectMany(static value => value));
            selected = configurations.IsDefault ? new(StringComparer.Ordinal) : configurations
                .Where(static configuration => configuration?.PluginId is not null)
                .Select(static configuration => configuration.PluginId)
                .Distinct(StringComparer.Ordinal).Where(_active.ContainsKey)
                .ToDictionary(static id => id, id => _active[id], StringComparer.Ordinal);
        }
        AuthoringFilterMappingResult result = await mapper.MapAsync(
            owner, original, configurations, cancellationToken: cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        lock (_lock)
        {
            foreach ((string extensionId, ImmutableArray<AuthoringRegisteredFilter> registration) in selected)
            {
                if (!_active.TryGetValue(extensionId, out ImmutableArray<AuthoringRegisteredFilter> current))
                {
                    return new(AuthoringFilterMappingStatus.Unsupported, null, null, ["filter_registration_removed"]);
                }
                if (current != registration)
                {
                    return new(AuthoringFilterMappingStatus.NeedsUpdate, null, null, ["filter_registration_changed"]);
                }
            }
            return result;
        }
    }

    private AuthoringFilterContributionQueryMapper BuildMapper(IEnumerable<AuthoringRegisteredFilter> registrations)
        => new(registrations.Select(static registration => registration.Contribution), coreAuthorities, validator);

    private void RequireNewActivation(string extensionId)
    {
        if (_active.ContainsKey(extensionId))
        {
            throw new AuthoringFilterContractException("filter_registration_already_active");
        }
    }
}
