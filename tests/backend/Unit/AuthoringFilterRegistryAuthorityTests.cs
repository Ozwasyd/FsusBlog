using System.Collections.Immutable;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringFilterRegistryAuthorityTests
{
    private static readonly AuthorSavedViewOwner s_owner = new(7, "primary-site");

    [Fact]
    public async Task SignedPackage_BindsRuntimeDigestWithoutPayloadSelfReference()
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync();
        AuthoringRegisteredFilter registration = Assert.Single(new VerifiedPackageAuthoringFilterSource().Read(package, targets));
        Assert.Equal(AuthoringPackageTrustStatus.Trusted, package.Trust.Status);
        Assert.Equal(package.Contract.Manifest.PackageSha256, registration.Contribution.PackageSha256);
        Assert.Equal(package.PackageIdentity, registration.PackageIdentity);
        Assert.Equal(package.Contract.Manifest.ContentSha256, registration.ContentSha256);
        Assert.Equal(targets[0], registration.Target);
    }

    [Theory]
    [InlineData("self-reference", "filter_package_digest_self_reference")]
    [InlineData("unknown", "filter_json_invalid")]
    [InlineData("identity", "filter_package_binding_drift")]
    [InlineData("version", "filter_package_binding_drift")]
    [InlineData("undeclared", "filter_package_contribution_undeclared")]
    [InlineData("duplicate", "filter_package_entry_partial")]
    [InlineData("empty", "filter_package_entry_partial")]
    public async Task SignedMetadata_RefusesDriftAndUnclosedFields(string mutation, string reason)
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync(mutate: values =>
        {
            JsonObject item = values[0]!.AsObject();
            switch (mutation)
            {
                case "self-reference":
                    item["PackageSha256"] = new string('a', 64);
                    break;
                case "unknown":
                    item["RawSql"] = "SELECT * FROM article";
                    break;
                case "identity":
                    item["PluginId"] = "other.plugin";
                    item["FilterId"] = "other.plugin.filter.status";
                    item["Operators"]![0]!["Id"] = "other.plugin.operator.status";
                    break;
                case "version":
                    item["PluginVersion"] = "2.0.0";
                    break;
                case "undeclared":
                    item["FilterId"] = "acme.author-tools.filter.other";
                    break;
                case "duplicate":
                    values.Add(item.DeepClone());
                    break;
                case "empty":
                    values.Clear();
                    break;
            }
        });
        Assert.Equal(reason, Assert.Throws<AuthoringFilterContractException>(() =>
            new VerifiedPackageAuthoringFilterSource().Read(package, targets)).Code);
    }

    [Theory]
    [InlineData("missing", "filter_package_entry_missing")]
    [InlineData("duplicate", "filter_package_entry_duplicate")]
    [InlineData("bytes", "filter_package_entry_digest_drift")]
    [InlineData("rehashed", "filter_package_payload_drift")]
    [InlineData("link", "filter_package_entry_invalid")]
    public async Task RetainedPackageEntry_RefusesPostVerificationTamper(string mutation, string reason)
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync();
        AuthoringPackageEntry metadata = package.Contents.Entries.Single(static entry =>
            entry.Path == VerifiedPackageAuthoringFilterSource.EntryPath);
        ImmutableArray<AuthoringPackageEntry> entries = mutation switch
        {
            "missing" => [.. package.Contents.Entries.Where(entry => entry != metadata)],
            "duplicate" => [.. package.Contents.Entries, metadata],
            "bytes" => [.. package.Contents.Entries.Select(entry => entry == metadata
                ? entry with { Content = [.. entry.Content, (byte)' '] } : entry)],
            "rehashed" => [.. package.Contents.Entries.Select(entry => entry == metadata
                ? entry with { Content = [.. entry.Content, (byte)' '],
                    ContentSha256 = Digest([.. entry.Content, (byte)' ']) } : entry)],
            _ => [.. package.Contents.Entries.Select(entry => entry == metadata
                ? entry with { IsSymbolicLink = true } : entry)]
        };
        package = package with
        {
            Contents = package.Contents with
            {
                Entries = entries
            }
        };
        Assert.Equal(reason, Assert.Throws<AuthoringFilterContractException>(() =>
            new VerifiedPackageAuthoringFilterSource().Read(package, targets)).Code);
    }

    [Theory]
    [InlineData("runtime")]
    [InlineData("version")]
    [InlineData("entrypoint")]
    [InlineData("kind")]
    [InlineData("blocked")]
    public async Task ExecutionTarget_DriftIsRejected(string mutation)
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync();
        AuthoringExecutionTarget target = mutation switch
        {
            "runtime" => targets[0] with { RuntimeIdentity = "unbound" },
            "version" => targets[0] with { ExtensionVersion = "2.0.0" },
            "entrypoint" => targets[0] with { EntrypointIdentity = "other.wasm" },
            "kind" => targets[0] with { ContributionKind = AuthoringContributionKind.Command },
            _ => targets[0] with { Status = AuthoringExecutionResolutionStatus.BlockedIdentityDrift }
        };
        Assert.Equal("filter_target_binding_drift", Assert.Throws<AuthoringFilterContractException>(() =>
            new VerifiedPackageAuthoringFilterSource().Read(package, [target])).Code);
    }

    [Theory]
    [InlineData(AuthoringCapability.NetworkDestination)]
    [InlineData(AuthoringCapability.FileSystemRootRead)]
    [InlineData(AuthoringCapability.FileSystemRootProposeWrite)]
    [InlineData(AuthoringCapability.DocumentMutationRequest)]
    public async Task FilterCannotGainExternalOrMutationCapabilities(AuthoringCapability capability)
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync(
            capabilities: [AuthoringCapability.ArticleQuery, capability]);
        Assert.Equal("filter_package_capability_forbidden", Assert.Throws<AuthoringFilterContractException>(() =>
            new VerifiedPackageAuthoringFilterSource().Read(package, targets)).Code);
    }

    [Fact]
    public async Task UndeclaredMetadataAndMissingQueryCapabilityAreRejected()
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync(
            kind: AuthoringContributionKind.Command);
        Assert.Equal("filter_package_entry_undeclared", Assert.Throws<AuthoringFilterContractException>(() =>
            new VerifiedPackageAuthoringFilterSource().Read(package, targets)).Code);
        (package, targets) = await PackageAsync(capabilities: []);
        Assert.Equal("filter_package_capability_forbidden", Assert.Throws<AuthoringFilterContractException>(() =>
            new VerifiedPackageAuthoringFilterSource().Read(package, targets)).Code);
    }

    [Fact]
    public async Task Lifecycle_RegistersRevokesAndReinstallsWithoutAuthorizingQuery()
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync();
        AuthoringFilterRegistryAuthority registry = Registry();
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host, registry);
        await resources.ActivateAtomicallyAsync(package, targets, 1, default);
        Assert.Single(registry.Snapshot());
        AuthoringFilterMappingResult mapped = await registry.MapAsync(s_owner, Query(), [Configuration(package)]);
        Assert.Equal(AuthoringFilterMappingStatus.Blocked, mapped.Status);
        Assert.Single(mapped.StructuralQuery!.Conditions);
        Assert.Contains("filter_permission_facts_unavailable", mapped.Reasons);
        Assert.Contains("filter_canonical_executor_unavailable", mapped.Reasons);
        Assert.True((await resources.RevokeAllAsync(package.Contract.Manifest.Id, 1, default)).IsEmpty);
        Assert.Empty(registry.Snapshot());
        AuthoringFilterMappingResult disabled = await registry.MapAsync(s_owner, Query(), [Configuration(package)]);
        Assert.Equal(AuthoringFilterMappingStatus.Unsupported, disabled.Status);
        Assert.Null(disabled.StructuralQuery);
        await resources.ActivateAtomicallyAsync(package, targets, 2, default);
        Assert.Single(registry.Snapshot());
        Assert.Equal(2, host.Activations);
        Assert.Equal(1, host.Revocations);
    }

    [Fact]
    public async Task MissingRegistry_BlocksFilterBeforeHostActivation()
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync();
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        AuthoringFilterContractException failure = await Assert.ThrowsAsync<AuthoringFilterContractException>(async () =>
            await resources.ActivateAtomicallyAsync(package, targets, 1, default));
        Assert.Equal("filter_registry_unavailable", failure.Code);
        Assert.Equal(0, host.Activations);
    }

    [Fact]
    public async Task Conflict_IsRejectedBeforeHostMutationAndDoesNotReplaceActiveMetadata()
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync();
        AuthoringFilterRegistryAuthority registry = Registry();
        registry.ActivateAtomically(package, targets);
        var host = new HostResources();
        await Assert.ThrowsAsync<AuthoringFilterContractException>(async () =>
            await new AuthoringExtensionLifecycleResources(host, registry).ActivateAtomicallyAsync(package, targets, 1, default));
        Assert.Equal(0, host.Activations);
        Assert.Equal(package.PackageIdentity, Assert.Single(registry.Snapshot()).PackageIdentity);
    }

    [Fact]
    public async Task HostActivationFailure_DoesNotPublishFilterRegistration()
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync();
        AuthoringFilterRegistryAuthority registry = Registry();
        var host = new HostResources { FailActivation = true };
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await new AuthoringExtensionLifecycleResources(host, registry).ActivateAtomicallyAsync(package, targets, 1, default));
        Assert.Empty(registry.Snapshot());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RemovalOrReinstallDuringValidatorAwait_RejectsOldStructuralReturn(bool reinstall)
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync();
        var validator = new PausingValidator();
        AuthoringFilterRegistryAuthority registry = Registry(validator);
        registry.ActivateAtomically(package, targets);
        Task<AuthoringFilterMappingResult> pending = registry.MapAsync(s_owner, Query(), [Configuration(package)]);
        await validator.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        registry.Remove(package.Contract.Manifest.Id);
        if (reinstall)
        {
            registry.ActivateAtomically(package, targets);
        }
        validator.Release.SetResult();
        AuthoringFilterMappingResult result = await pending;
        Assert.Equal(reinstall ? AuthoringFilterMappingStatus.NeedsUpdate : AuthoringFilterMappingStatus.Unsupported, result.Status);
        Assert.Null(result.StructuralQuery);
        Assert.Contains(reinstall ? "filter_registration_changed" : "filter_registration_removed", result.Reasons);
    }

    [Fact]
    public async Task CancelledMapping_DoesNotReturnStructuralData()
    {
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) = await PackageAsync();
        AuthoringFilterRegistryAuthority registry = Registry();
        registry.ActivateAtomically(package, targets);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            registry.MapAsync(s_owner, Query(), [Configuration(package)], cancellation.Token));
    }

    private static AuthoringFilterRegistryAuthority Registry(IAuthorSavedViewQueryValidator? validator = null)
        => new(new VerifiedPackageAuthoringFilterSource(), new([], [], [], [], []), validator ?? Validator());

    private static IAuthorSavedViewQueryValidator Validator()
        => new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([]));

    private static AuthorSavedViewQuery Query() => new(1, [], new(
        new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.UpdatedAtField),
        AuthorSavedViewSortDirection.Descending, AuthorSavedViewNullPlacement.Last, "temporal", TimeZoneId: "UTC"), [], 20);

    private static AuthoringFilterConfiguration Configuration(VerifiedAuthoringPackage package) => new(
        1, package.Contract.Manifest.Id, package.Contract.Manifest.Version, package.Contract.Manifest.PackageSha256,
        "acme.author-tools.filter.status", 1, "acme.author-tools.operator.status", 1,
        [new(AuthoringFilterScalarKind.StableIdentity, "draft", null, null, null)], null);

    private static async Task<(VerifiedAuthoringPackage Package, ImmutableArray<AuthoringExecutionTarget> Targets)> PackageAsync(
        string version = "1.0.0", Action<JsonArray>? mutate = null,
        ImmutableArray<AuthoringCapability> capabilities = default,
        AuthoringContributionKind kind = AuthoringContributionKind.ArticleLibraryFilter)
    {
        var contribution = new AuthoringFilterContribution(1, "acme.author-tools", version, new string('a', 64),
            "acme.author-tools.filter.status", 1, 1,
            [new("acme.author-tools.operator.status", 1, "identity.equals",
                new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField),
                AuthorSavedViewValueKind.StableIdentity, AuthorSavedViewNullSemantics.NullNeverMatches,
                new(AuthoringFilterScalarKind.StableIdentity, AuthoringFilterParameterShape.Scalar, 1, 64))],
            [AuthoringFilterPermissionRequirement.AuthorArticleRead], AuthoringFilterIndexRequirement.OwningServerIndex,
            AuthoringFilterLifecyclePolicy.RetainConditionsRequireRevalidation, 1, 1, false, false, false);
        JsonObject payload = JsonSerializer.SerializeToNode(contribution)!.AsObject();
        payload.Remove(nameof(AuthoringFilterContribution.PackageSha256));
        var values = new JsonArray(payload);
        mutate?.Invoke(values);
        byte[] metadata = JsonSerializer.SerializeToUtf8Bytes(values);
        byte[] worker = [0, 97, 115, 109, 1, 0, 0, 0];
        ImmutableArray<AuthoringPackageEntry> entries =
        [
            new(VerifiedPackageAuthoringFilterSource.EntryPath, [.. metadata], Digest(metadata)),
            new("worker/main.wasm", [.. worker], Digest(worker))
        ];
        AuthoringExtensionManifest template = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest manifest = template with
        {
            Version = version,
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions = [template.Contributions[0] with
            {
                Id = contribution.FilterId, Kind = kind,
                Capabilities = capabilities.IsDefault ? [AuthoringCapability.ArticleQuery] : capabilities,
                Entrypoint = template.Contributions[0].Entrypoint with { ContentSha256 = Digest(worker) }
            }]
        };
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
        using ECDsa signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var trust = new EcdsaAuthoringPackageTrustVerifier(new LocalAuthoringPackageKeyset(
            [new("acme", "key-1", [.. signer.ExportSubjectPublicKeyInfo()], now.AddHours(-1), now.AddHours(1))]),
            TimeProvider.System);
        var artifact = new AuthoringPackageArtifact([.. bytes],
            [.. signer.SignData(bytes, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)],
            "acme", "key-1", "approved-source/catalog-1", "provenance/build-1", Digest(bytes));
        VerifiedAuthoringPackage package = await new AuthoringPackageVerifier(trust,
            new ZipAuthoringPackageArchiveReader(), TimeProvider.System).VerifyAsync(artifact, AuthoringHostPlatform.ServerLinux);
        return (package, [new(AuthoringExecutionResolutionStatus.Ready, AuthoringExecutionClass.IsolatedWorkerWasm,
            manifest.Id, manifest.Version, manifest.PackageSha256, contribution.FilterId,
            kind, "worker/main.wasm", null, new string('c', 64), null)]);
    }

    private static string Digest(ReadOnlySpan<byte> value) => Convert.ToHexStringLower(SHA256.HashData(value));

    private sealed class PausingValidator : IAuthorSavedViewQueryValidator
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<AuthorSavedViewQueryValidationResult> ValidateAsync(
            AuthorSavedViewOwner owner, AuthorSavedViewQuery query, CancellationToken cancellationToken = default)
        {
            Entered.SetResult();
            await Release.Task.WaitAsync(cancellationToken);
            return await Validator().ValidateAsync(owner, query, cancellationToken);
        }
    }

    private sealed class HostResources : IAuthoringLifecycleHostResourceAuthority
    {
        public int Activations
        {
            get; private set;
        }
        public int Revocations
        {
            get; private set;
        }
        public bool FailActivation
        {
            get; init;
        }

        public ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken cancellationToken)
        {
            Activations++;
            if (FailActivation)
            {
                throw new InvalidOperationException("host activation failed");
            }
            return ValueTask.CompletedTask;
        }

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(string extensionId, CancellationToken cancellationToken)
        {
            Revocations++;
            return ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0));
        }
    }
}
