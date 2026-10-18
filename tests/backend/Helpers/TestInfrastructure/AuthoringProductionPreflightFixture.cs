using System.Collections.Immutable;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

using Microsoft.AspNetCore.DataProtection;

using SqlSugar;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.TestInfrastructure;

/// <summary>Real signed archive and persistent owners; this fixture never issues enable approval or a native lease.</summary>
internal sealed class AuthoringProductionPreflightFixture : IDisposable
{
    public const string Purpose = "authoring-filter-preview";
    private readonly string _root = Path.Combine(Path.GetTempPath(), "fsus-authoring-preflight-" + Guid.NewGuid().ToString("N"));
    private readonly ECDsa _signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public FixtureClock Clock { get; } = new();
    public LocalAuthoringPackageRuntime Packages { get; private set; } = null!;
    public LocalAuthoringCapabilityGrantStore Grants { get; private set; } = null!;
    public VerifiedAuthoringPackage Package { get; private set; } = null!;
    public ImmutableArray<AuthoringExecutionTarget> Targets
    {
        get; private set;
    }
    public AuthoringStateScope Scope => new(Package.Contract.Manifest.Id, Package.Contract.Manifest.Version,
        "primary-site", "7", "document-1", Package.Contract.Manifest.StateSchemaVersion);

    public static async Task<AuthoringProductionPreflightFixture> CreateAsync(
        Func<AuthoringExtensionManifest, AuthoringExtensionManifest>? mutate = null,
        bool omitMetadata = false,
        DateTimeOffset? now = null,
        string version = "1.0.0")
    {
        var fixture = new AuthoringProductionPreflightFixture();
        if (now is not null)
        {
            fixture.Clock.Now = now.Value;
        }
        try
        {
            await fixture.InitializeAsync(mutate, omitMetadata, version);
            return fixture;
        }
        catch
        {
            fixture.Dispose();
            throw;
        }
    }

    private async Task InitializeAsync(
        Func<AuthoringExtensionManifest, AuthoringExtensionManifest>? mutate, bool omitMetadata, string version)
    {
        var filter = new AuthoringFilterContribution(1, "acme.author-tools", version, new string('a', 64),
            "acme.author-tools.filter.status", 1, 1,
            [new("acme.author-tools.operator.status", 1, "identity.equals",
                new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField),
                AuthorSavedViewValueKind.StableIdentity, AuthorSavedViewNullSemantics.NullNeverMatches,
                new(AuthoringFilterScalarKind.StableIdentity, AuthoringFilterParameterShape.Scalar, 1, 64))],
            [AuthoringFilterPermissionRequirement.AuthorArticleRead], AuthoringFilterIndexRequirement.OwningServerIndex,
            AuthoringFilterLifecyclePolicy.RetainConditionsRequireRevalidation, 1, 1, false, false, false);
        JsonObject metadata = JsonSerializer.SerializeToNode(filter)!.AsObject();
        metadata.Remove(nameof(AuthoringFilterContribution.PackageSha256));
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(new JsonArray(metadata));
        byte[] worker = [0, 97, 115, 109, 1, 0, 0, 0];
        ImmutableArray<AuthoringPackageEntry> entries = omitMetadata
            ? [new("worker/main.wasm", [.. worker], Digest(worker))]
            : [new("worker/main.wasm", [.. worker], Digest(worker)),
                new(VerifiedPackageAuthoringFilterSource.EntryPath, [.. payload], Digest(payload))];
        AuthoringExtensionManifest template = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest manifest = template with
        {
            Version = version,
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions = [template.Contributions[0] with
            {
                Id = filter.FilterId, Kind = AuthoringContributionKind.ArticleLibraryFilter,
                Capabilities = [AuthoringCapability.ArticleQuery],
                Entrypoint = template.Contributions[0].Entrypoint with { ContentSha256 = Digest(worker) }
            }]
        };
        manifest = mutate?.Invoke(manifest) ?? manifest;
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (Stream output = archive.CreateEntry(ZipAuthoringPackageArchiveReader.ManifestPath).Open())
            {
                output.Write(JsonSerializer.SerializeToUtf8Bytes(manifest));
            }
            foreach (AuthoringPackageEntry entry in entries)
            {
                using Stream output = archive.CreateEntry(entry.Path).Open();
                output.Write(entry.Content.AsSpan());
            }
        }
        byte[] bytes = stream.ToArray();
        var artifact = new AuthoringPackageArtifact([.. bytes],
            [.. _signer.SignData(bytes, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)],
            "acme", "key-1", "approved-source/catalog-1", "provenance/build-1", Digest(bytes));
        AuthoringPackagePublisherKey key = new("acme", "key-1", [.. _signer.ExportSubjectPublicKeyInfo()],
            Clock.Now.AddHours(-1), Clock.Now.AddHours(1));
        Packages = LocalAuthoringPackageComposition.Create(Path.Combine(_root, "packages"),
            AuthoringHostPlatform.ServerLinux, [key], [artifact], Clock);
        _ = await Packages.Activation.InstallOrUpdateFromSourceAsync(artifact.SourceReference);
        Package = (await Packages.Store.GetActiveAsync(manifest.Id, default))!;
        Targets = [await Packages.ExecutionResolver.ResolveAsync(Package, filter.FilterId, AuthoringHostPlatform.ServerLinux)];
        Grants = new(Path.Combine(_root, "grants"),
            DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(_root, "keys"))), Clock);
    }

    public AuthoringExtensionProductionComposition Compose(SqlSugarClient db,
        AuthoringHostPlatform platform = AuthoringHostPlatform.ServerLinux, AuthoringStateScope? scope = null)
        => new(Packages, Grants, new PostgresAuthoringExtensionStateStore(db),
            new PostgresAuthoringLifecycleReceiptStore(db), Clock, platform, scope ?? Scope, Purpose,
            new([], [], [], [], []), ImmutableHashSet<string>.Empty.WithComparer(StringComparer.OrdinalIgnoreCase),
            new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([])));

    public async Task<AuthoringCapabilityGrant> StoreGrantAsync(string? site = null, string? document = null)
    {
        // Seed the actual persistent catalog for diagnostic scope/revocation
        // controls only. These test receipt strings are not issued consent or
        // production approval; every composition admission remains refused.
        AuthoringExecutionTarget target = Targets[0];
        AuthoringCapabilityGrant grant = new("", target.RuntimeIdentity, target.ExtensionId, target.ExtensionVersion,
            target.ContributionId, target.ExecutionClass, AuthoringCapability.ArticleQuery, document ?? Scope.DocumentId!,
            site ?? Scope.SiteId, Purpose, null, null, Clock.Now, Clock.Now.AddMinutes(5),
            "test-existing-grant-receipt", "test-grant-request", "");
        string digest = AuthoringCapabilityGrantAuthority.ComputeGrantDigest(grant);
        grant = grant with
        {
            GrantId = digest,
            GrantDigest = digest
        };
        await Grants.StoreAsync(grant, default);
        return grant;
    }

    public void Dispose()
    {
        _signer.Dispose();
        if (Package is not null)
        {
            // The store seals installed package directories. Only its original
            // mutation owner may deactivate and remove them during test teardown.
            Packages.Store.DeactivateAsync(Package.Contract.Manifest.Id, Package.PackageIdentity, default)
                .AsTask().GetAwaiter().GetResult();
            Packages.Store.RemoveStagedAsync(Package.PackageIdentity, default).AsTask().GetAwaiter().GetResult();
        }
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private static string Digest(ReadOnlySpan<byte> value) => Convert.ToHexStringLower(SHA256.HashData(value));

    internal sealed class FixtureClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = TestTemporalContext.CanonicalBusinessEpochUtc;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
