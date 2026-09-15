using System.Reflection;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionSecurityMatrixTests
{
    [Fact]
    public void ExecutionAndCapabilityRegistries_AreClosedAndNonBroad()
    {
        Assert.Equal(
            ["TrustedHostAdapter", "IsolatedWorkerWasm", "OutOfProcessService"],
            Enum.GetNames<AuthoringExecutionClass>());
        Assert.DoesNotContain(Enum.GetNames<AuthoringCapability>(), name =>
            name.Equals("All", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("Editor", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("Trusted", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(AuthoringCapability.DocumentRangeRead, Enum.GetValues<AuthoringCapability>());
        Assert.Contains(AuthoringCapability.DocumentFullRead, Enum.GetValues<AuthoringCapability>());
        Assert.Contains(AuthoringCapability.NetworkDestination, Enum.GetValues<AuthoringCapability>());
        Assert.Contains(AuthoringCapability.FileSystemRootRead, Enum.GetValues<AuthoringCapability>());
    }

    [Fact]
    public void ProductionSources_DoNotCreateDirectPrivateHostOrIoEscapeSurface()
    {
        string root = Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src/backend/Infrastructure/AuthoringExtensions");
        Dictionary<string, string> sources = Directory.EnumerateFiles(root, "*.cs")
            .Order(StringComparer.Ordinal)
            .ToDictionary(static path => Path.GetFileName(path)!, File.ReadAllText, StringComparer.Ordinal);
        string source = string.Join('\n', sources.Values);
        foreach (string forbidden in new[]
        {
            "Assembly.Load",
            "Activator.CreateInstance",
            "IServiceProvider",
            "editorRef",
            "Pinia",
            "innerHTML",
            "register(any)",
            "WebView",
            "iframe",
            "eval("
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.OrdinalIgnoreCase);
        }

        Assert.Equal(
            ["LinuxBubblewrapAuthoringServiceRuntime.cs", "LinuxBubblewrapAuthoringWorkerRuntime.cs"],
            sources.Where(static pair => pair.Value.Contains("Process.Start", StringComparison.Ordinal))
                .Select(static pair => pair.Key)
                .Order(StringComparer.Ordinal));
        Assert.Single(sources, static pair => pair.Value.Contains("new HttpClient", StringComparison.Ordinal));
        Assert.Contains("new HttpClient", sources["AuthoringExtensionServiceIoBroker.cs"], StringComparison.Ordinal);
        Assert.DoesNotContain("UseShellExecute = true", source, StringComparison.Ordinal);
        Assert.DoesNotContain("/bin/sh", source, StringComparison.Ordinal);
        Assert.DoesNotContain("cmd.exe", source, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(
            "if (imports.length !== 0)",
            sources["LinuxBubblewrapAuthoringWorkerRuntime.cs"],
            StringComparison.Ordinal);
        Assert.Contains(
            "AllowAutoRedirect = false",
            sources["AuthoringExtensionServiceIoBroker.cs"],
            StringComparison.Ordinal);
        Assert.Contains(
            "--unshare-all",
            sources["LinuxBubblewrapAuthoringServiceRuntime.cs"],
            StringComparison.Ordinal);
        Assert.Contains(
            "--unshare-all",
            sources["LinuxBubblewrapAuthoringWorkerRuntime.cs"],
            StringComparison.Ordinal);
    }

    [Fact]
    public void PublicBoundaryDtos_DoNotExposeObjectDelegateStreamOrReflectionTypes()
    {
        Type[] boundaryTypes = typeof(AuthoringExtensionManifest).Assembly.GetTypes()
            .Where(type => type.IsPublic && type.Namespace == typeof(AuthoringExtensionManifest).Namespace)
            .Where(type => type.Name.StartsWith("Authoring", StringComparison.Ordinal))
            .Where(type => !type.IsInterface)
            .ToArray();
        Type[] forbidden = [typeof(object), typeof(Delegate), typeof(Stream), typeof(Type), typeof(Assembly)];

        foreach (PropertyInfo property in boundaryTypes.SelectMany(static type => type.GetProperties()))
        {
            Assert.DoesNotContain(property.PropertyType, forbidden);
            Assert.False(typeof(Delegate).IsAssignableFrom(property.PropertyType));
            Assert.False(typeof(Stream).IsAssignableFrom(property.PropertyType));
        }
    }

    [Fact]
    public void ReceiptsAndTelemetry_DoNotContainPlaintextContentOrSecretFields()
    {
        Type[] evidenceTypes =
        [
            typeof(AuthoringPackageReceipt),
            typeof(AuthoringLifecycleReceipt),
            typeof(AuthoringBudgetTelemetry),
            typeof(AuthoringBudgetTelemetryIdentity),
            typeof(AuthoringTransactionReceipt)
        ];
        string[] forbidden = ["Text", "Source", "Payload", "Secret", "Token", "Credential", "StateValue"];

        foreach (PropertyInfo property in evidenceTypes.SelectMany(static type => type.GetProperties()))
        {
            Assert.DoesNotContain(forbidden, fragment =>
                property.Name.Contains(fragment, StringComparison.OrdinalIgnoreCase));
        }

        Assert.DoesNotContain(
            typeof(AuthoringBudgetTelemetryIdentity).GetProperties(),
            static property => property.Name is "DocumentId" or "RequestId");
    }

    [Fact]
    public async Task ContractIdentityDrift_InvalidatesOldGrant()
    {
        AuthoringExtensionManifest oldManifest = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest changedManifest = oldManifest with
        {
            DataSchemaVersion = 2
        };
        VerifiedAuthoringExtensionContract oldContract = AuthoringExtensionContractValidator.Verify(oldManifest);
        VerifiedAuthoringExtensionContract changedContract = AuthoringExtensionContractValidator.Verify(changedManifest);
        Assert.NotEqual(oldContract.ContractIdentity, changedContract.ContractIdentity);
        var store = new GrantStore();
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var authority = new AuthoringCapabilityGrantAuthority(store, new FixedTimeProvider(now));
        AuthoringCapabilityGrant grant = await authority.IssueAsync(new AuthoringGrantRequest(
            "grant-request-1",
            oldContract.ContractIdentity,
            oldManifest.Id,
            oldManifest.Version,
            oldManifest.Contributions[0].Id,
            oldManifest.Contributions[0].ExecutionClass,
            AuthoringCapability.DocumentRangeRead,
            "document-1",
            "site-1",
            "read-range",
            null,
            null,
            TimeSpan.FromMinutes(1),
            "approval-1"));
        AuthoringRpcEnvelope drifted = CreateRangeEnvelope(changedContract, grant.GrantDigest, now);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await authority.RequireAsync(
                grant.GrantId,
                drifted,
                AuthoringCapability.DocumentRangeRead));
    }

    [Fact]
    public void FocusedTestAssembly_ContainsEveryChildStageSuite()
    {
        string[] suites = typeof(AuthoringExtensionSecurityMatrixTests).Assembly.GetTypes()
            .Where(static type => type.Namespace == "FsusBlog.Server.Tests")
            .Select(static type => type.Name)
            .ToArray();

        foreach (string required in new[]
        {
            "AuthoringExtensionContractsTests",
            "AuthoringExtensionPackageTests",
            "AuthoringExtensionExecutionResolverTests",
            "AuthoringExtensionWorkerSandboxTests",
            "AuthoringExtensionServiceBrokerTests",
            "AuthoringExtensionRpcTests",
            "AuthoringExtensionLifecycleTests",
            "AuthoringExtensionBudgetTests"
        })
        {
            Assert.Contains(required, suites);
        }
    }

    private static AuthoringRpcEnvelope CreateRangeEnvelope(
        VerifiedAuthoringExtensionContract contract,
        string grantDigest,
        DateTimeOffset now) => new(
            1,
            AuthoringRpcMethod.DocumentRangeRead,
            contract.ContractIdentity,
            contract.Manifest.Id,
            contract.Manifest.Version,
            contract.Manifest.PackageSha256,
            contract.Manifest.ContentSha256,
            contract.Manifest.Contributions[0].Id,
            contract.Manifest.Contributions[0].ExecutionClass,
            "request-1",
            "document-1",
            1,
            1,
            new string('a', 64),
            new string('b', 64),
            new string('c', 64),
            new string('d', 64),
            grantDigest,
            now.AddMinutes(1),
            new AuthoringRpcPayload(DocumentRange: new AuthoringTextRange(0, 8)))
        {
            SiteIdentity = "site-1",
            Purpose = "read-range"
        };

    private sealed class GrantStore : IAuthoringCapabilityGrantStore
    {
        private readonly Dictionary<string, AuthoringCapabilityGrant> _grants = new(StringComparer.Ordinal);

        public ValueTask<AuthoringCapabilityGrant?> FindAsync(string grantId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_grants.GetValueOrDefault(grantId));

        public ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken cancellationToken)
        {
            _grants.Add(grant.GrantId, grant);
            return ValueTask.CompletedTask;
        }

        public ValueTask RevokeAsync(string grantId, CancellationToken cancellationToken)
        {
            _grants.Remove(grantId);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
