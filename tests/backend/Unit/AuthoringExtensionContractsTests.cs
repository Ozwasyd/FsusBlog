using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionContractsTests
{
    [Fact]
    public void Verify_ClosedManifest_ReturnsStableIdentity()
    {
        AuthoringExtensionManifest manifest = CreateManifest();
        VerifiedAuthoringExtensionContract first = AuthoringExtensionContractValidator.Verify(manifest);
        VerifiedAuthoringExtensionContract second = AuthoringExtensionContractValidator.Verify(manifest);

        Assert.Equal(64, first.ContractIdentity.Length);
        Assert.Equal(first.ContractIdentity, second.ContractIdentity);
    }

    [Fact]
    public void Verify_ContractRelevantChanges_InvalidateIdentity()
    {
        VerifiedAuthoringExtensionContract original = AuthoringExtensionContractValidator.Verify(CreateManifest());
        VerifiedAuthoringExtensionContract changed = AuthoringExtensionContractValidator.Verify(CreateManifest() with
        {
            DataSchemaVersion = 2
        });

        Assert.NotEqual(original.ContractIdentity, changed.ContractIdentity);
        Assert.Equal(AuthoringExtensionContractValidator.RegistryIdentity, original.RegistryIdentity);
    }

    [Fact]
    public void CreateRegistry_ProducesStableSnapshotAndRejectsTamperedContract()
    {
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(CreateManifest());
        AuthoringCoreAuthorityRegistry core = CreateCoreAuthorities();

        AuthoringExtensionRegistrySnapshot first = AuthoringExtensionContractValidator.CreateRegistry([contract], core);
        AuthoringExtensionRegistrySnapshot second = AuthoringExtensionContractValidator.CreateRegistry([contract], core);
        AuthoringExtensionRegistrySnapshot coreChanged = AuthoringExtensionContractValidator.CreateRegistry(
            [contract],
            core with { CommandIds = [.. core.CommandIds, "fsusblog.core.command.publish"] });

        Assert.Equal(64, first.RegistryIdentity.Length);
        Assert.Equal(first.RegistryIdentity, second.RegistryIdentity);
        Assert.NotEqual(first.RegistryIdentity, coreChanged.RegistryIdentity);
        Assert.Equal(contract.ContractIdentity, Assert.Single(first.Contracts).ContractIdentity);
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.CreateRegistry(
                [contract with { ContractIdentity = new string('0', 64) }],
                core));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.CreateRegistry(
                [contract with { RegistryIdentity = new string('0', 64) }],
                core));
    }

    [Fact]
    public void CreateRegistry_DuplicateOrCoreAuthorityIdentity_FailsClosed()
    {
        AuthoringExtensionManifest original = CreateManifest();
        VerifiedAuthoringExtensionContract first = AuthoringExtensionContractValidator.Verify(original);
        VerifiedAuthoringExtensionContract duplicateContribution = AuthoringExtensionContractValidator.Verify(
            original with
            {
                Id = "other.author-tools",
                PackageSha256 = new string('d', 64),
                ContentSha256 = new string('e', 64)
            });

        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.CreateRegistry(
                [first, duplicateContribution],
                CreateCoreAuthorities()));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.CreateRegistry(
                [first],
                CreateCoreAuthorities() with { CommandIds = [original.Contributions[0].Id] }));
    }

    [Fact]
    public void Verify_UnknownCapabilityOrExecutionClass_FailsClosed()
    {
        AuthoringContributionDeclaration contribution = CreateManifest().Contributions[0];

        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(CreateManifest() with
            {
                Contributions = [contribution with { Capabilities = [(AuthoringCapability)999] }]
            }));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(CreateManifest() with
            {
                Contributions = [contribution with { ExecutionClass = (AuthoringExecutionClass)999 }]
            }));
    }

    [Theory]
    [InlineData("https://host/module.wasm")]
    [InlineData("eval();")]
    [InlineData("import('module.wasm')")]
    [InlineData("../module.wasm")]
    [InlineData("worker\\module.wasm")]
    public void Verify_ArbitraryEntrypoint_FailsClosed(string entrypoint)
    {
        AuthoringContributionDeclaration contribution = CreateManifest().Contributions[0];

        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(CreateManifest() with
            {
                Contributions =
                [
                    contribution with
                    {
                        Entrypoint = contribution.Entrypoint with { PathOrAdapterId = entrypoint }
                    }
                ]
            }));
    }

    [Fact]
    public void Verify_FallbackCoreOverrideOrUnsupportedPlatform_FailsClosed()
    {
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(CreateManifest() with
            {
                AllowExecutionFallback = true
            }));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(CreateManifest() with
            {
                Id = "fsusblog.core.override"
            }));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(CreateManifest(), AuthoringHostPlatform.Browser));
    }

    [Fact]
    public void ParseAndVerify_UnknownOrDuplicateField_FailsClosed()
    {
        string json = JsonSerializer.Serialize(CreateManifest());
        string unknown = json.Insert(json.Length - 1, ",\"Unreviewed\":true");
        string duplicate = json.Insert(json.Length - 1, ",\"SchemaVersion\":1");

        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.ParseAndVerify(
                System.Text.Encoding.UTF8.GetBytes(unknown),
                AuthoringHostPlatform.ServerLinux));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.ParseAndVerify(
                System.Text.Encoding.UTF8.GetBytes(duplicate),
                AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public void ParseAndVerify_MissingTopLevelOrNestedField_FailsClosed()
    {
        JsonObject missingPublisher = JsonNode.Parse(JsonSerializer.Serialize(CreateManifest()))!.AsObject();
        missingPublisher.Remove(nameof(AuthoringExtensionManifest.Publisher));
        JsonObject missingCpuLimit = JsonNode.Parse(JsonSerializer.Serialize(CreateManifest()))!.AsObject();
        missingCpuLimit[nameof(AuthoringExtensionManifest.Limits)]!
            .AsObject()
            .Remove(nameof(AuthoringResourceLimits.MaximumCpuTime));

        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.ParseAndVerify(
                System.Text.Encoding.UTF8.GetBytes(missingPublisher.ToJsonString()),
                AuthoringHostPlatform.ServerLinux));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.ParseAndVerify(
                System.Text.Encoding.UTF8.GetBytes(missingCpuLimit.ToJsonString()),
                AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public void ParseAndVerify_ManifestSizeBound_FailsClosed()
    {
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.ParseAndVerify(
                new byte[AuthoringExtensionContractValidator.MaximumManifestBytes + 1],
                AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public void Verify_DefaultPermissionsAreExplicitlyEmpty_AndBroadIdentifierIsRejected()
    {
        AuthoringContributionDeclaration contribution = CreateManifest().Contributions[0];
        VerifiedAuthoringExtensionContract verified = AuthoringExtensionContractValidator.Verify(CreateManifest() with
        {
            Contributions = [contribution with { Capabilities = [] }]
        });

        Assert.Empty(verified.Manifest.Contributions[0].Capabilities);
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(CreateManifest() with
            {
                Contributions = [contribution with { Id = "*" }]
            }));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(CreateManifest() with
            {
                Id = $"a.{new string('b', AuthoringExtensionContractValidator.MaximumIdentifierLength)}"
            }));
    }

    [Fact]
    public void Verify_SchemaVersionDigestAndBudgetBounds_FailClosed()
    {
        AuthoringExtensionManifest manifest = CreateManifest();

        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(manifest with { RegistryVersion = 2 }));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(manifest with { PackageSha256 = new string('A', 64) }));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(manifest with
            {
                Limits = manifest.Limits with { MaximumCpuTime = TimeSpan.Zero }
            }));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionContractValidator.Verify(manifest with
            {
                Limits = manifest.Limits with { MaximumNetworkBytes = -1 }
            }));
    }

    [Fact]
    public void Registries_ContainOnlyAdjudicatedClosedValues()
    {
        Assert.Equal(
            [
                "Command",
                "CommandPaletteMetadata",
                "ArticleInspectorReadOnly",
                "ArticleLibraryFilter",
                "WorkspacePanel",
                "ArticlePropertyType",
                "ImportProvider",
                "ExportProvider",
                "PrepublishDiagnostic",
                "MarkdownProvider"
            ],
            Enum.GetNames<AuthoringContributionKind>());
        Assert.Equal(
            [
                "DocumentRangeRead",
                "DocumentFullRead",
                "SelectionRead",
                "DocumentMutationRequest",
                "ArticleQuery",
                "NetworkDestination",
                "FileSystemRootRead",
                "FileSystemRootProposeWrite",
                "DiagnosticReport",
                "StateStorageRead",
                "StateStorageWrite"
            ],
            Enum.GetNames<AuthoringCapability>());
    }

    [Fact]
    public void ContractSource_HasOneRegistryAndNoGenericExecutableRegistrationSurface()
    {
        string sourceDirectory = Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src/backend/Infrastructure/AuthoringExtensions");
        string source = string.Join(
            "\n",
            Directory.EnumerateFiles(sourceDirectory, "*.cs", SearchOption.TopDirectoryOnly)
                .Order(StringComparer.Ordinal)
                .Select(File.ReadAllText));

        Assert.Equal(1, Count(source, "enum AuthoringContributionKind"));
        Assert.Equal(1, Count(source, "enum AuthoringCapability"));
        Assert.DoesNotContain("register(any)", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("dynamic ", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Delegate", source, StringComparison.Ordinal);
        Assert.DoesNotContain("object Payload", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Dictionary<string, object", source, StringComparison.Ordinal);
        Assert.DoesNotContain("JsonElement Payload", source, StringComparison.Ordinal);
    }

    private static int Count(string value, string fragment) =>
        value.Split(fragment, StringSplitOptions.None).Length - 1;

    internal static AuthoringExtensionManifest CreateManifest() => new(
        SchemaVersion: 1,
        RegistryVersion: 1,
        Id: "acme.author-tools",
        Version: "1.0.0",
        PackageSha256: new string('a', 64),
        ContentSha256: new string('b', 64),
        Publisher: "acme",
        SignatureReference: "sig/acme-key-1",
        TrustPolicyReference: "trust/authoring-v1",
        HostApi: new AuthoringHostApiRange(1, 1),
        SupportedPlatforms: [AuthoringHostPlatform.ServerLinux],
        Contributions:
        [
            new AuthoringContributionDeclaration(
                "acme.command.format",
                AuthoringContributionKind.Command,
                AuthoringExecutionClass.IsolatedWorkerWasm,
                new AuthoringEntrypointIdentity(
                    AuthoringEntrypointFormat.WasmModule,
                    "worker/main.wasm",
                    new string('c', 64)),
                ImmutableArray.Create(
                    AuthoringCapability.DocumentRangeRead,
                    AuthoringCapability.DocumentMutationRequest))
        ],
        Limits: new AuthoringResourceLimits(
            TimeSpan.FromSeconds(2),
            TimeSpan.FromSeconds(5),
            64 * 1024 * 1024,
            64 * 1024,
            64 * 1024,
            2,
            8,
            8,
            1,
            0,
            0,
            1024 * 1024),
        StateSchemaVersion: 1,
        DataSchemaVersion: 1,
        UpdatePolicy: AuthoringUpdatePolicy.AtomicSwitchWithRollback,
        MigrationPolicy: AuthoringMigrationPolicy.HostDeclarativeOnly,
        UninstallPolicy: AuthoringUninstallPolicy.RemoveAuthorityRetainData,
        AllowExecutionFallback: false);

    private static AuthoringCoreAuthorityRegistry CreateCoreAuthorities() => new(
        CommandIds: ["fsusblog.core.command.save"],
        RouteIds: ["/admin/article/write"],
        PropertyIds: ["article.title"],
        SavedViewOperatorIds: ["saved-view.and"],
        SecurityPolicyIds: ["security.authoring"]);
}
