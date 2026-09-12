using System.Collections.Immutable;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionWorkerSandboxTests
{
    private const string EchoWasmHex =
        "0061736d01000000010c0260017f017f60027f7f017e0303020001050401010202072603066d656d6f727902000a667375735f616c6c6f6300000c667375735f6578656375746500010a140205004180080b0c002000ad4220862001ad840b";
    private const string NetworkImportWasmHex =
        "0061736d010000000104016000000216010c667375733a6e6574776f726b0566657463680000";

    [Fact]
    public async Task ExecuteAsync_ClosedRuntime_CompletesWithCopiedResult()
    {
        WorkerFixture fixture = await CreateFixtureAsync();

        AuthoringWorkerExecutionResult result = await fixture.Sandbox.ExecuteAsync(
            fixture.Package,
            fixture.Target,
            fixture.Request,
            1);

        Assert.Equal(AuthoringWorkerResultStatus.Completed, result.Status);
        Assert.Equal([4, 5, 6], result.Response?.Payload);
        AuthoringWorkerExecutionReceipt receipt = Assert.IsType<AuthoringWorkerExecutionReceipt>(result.Receipt);
        Assert.Matches("^[0-9a-f]{64}$", receipt.InstanceIdentity);
        Assert.Matches("^[0-9a-f]{64}$", receipt.DocumentIdentitySha256);
        Assert.Matches("^[0-9a-f]{64}$", receipt.RequestIdentitySha256);
        string storedReceipt = JsonSerializer.Serialize(receipt);
        Assert.DoesNotContain("document-1", storedReceipt, StringComparison.Ordinal);
        Assert.DoesNotContain("request-1", storedReceipt, StringComparison.Ordinal);
        Assert.DoesNotContain("AQID", storedReceipt, StringComparison.Ordinal);

        AuthoringWorkerExecutionResult changed = await fixture.Sandbox.ExecuteAsync(
            fixture.Package,
            fixture.Target,
            fixture.Request with { SourceRevision = fixture.Request.SourceRevision + 1 },
            1);
        Assert.NotEqual(receipt.InstanceIdentity, changed.Receipt?.InstanceIdentity);
    }

    [Theory]
    [InlineData("dom")]
    [InlineData("network")]
    [InlineData("filesystem")]
    [InlineData("process")]
    [InlineData("database")]
    [InlineData("private")]
    [InlineData("shared-memory")]
    [InlineData("spawn")]
    public async Task ExecuteAsync_ForbiddenCapabilityProbe_FailsAndTerminates(string capability)
    {
        AuthoringWorkerCapabilityReport report = ClosedReport() with
        {
            Dom = capability == "dom",
            Network = capability == "network",
            FileSystem = capability == "filesystem",
            Process = capability == "process",
            Database = capability == "database",
            HostPrivateObjects = capability == "private",
            SharedMemory = capability == "shared-memory",
            RecursiveWorkerSpawn = capability == "spawn"
        };
        var instance = new TestInstance(report);
        WorkerFixture fixture = await CreateFixtureAsync(instance);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Sandbox.ExecuteAsync(fixture.Package, fixture.Target, fixture.Request, 1));
        Assert.Equal("capability-probe-failed", instance.TerminationReason);
    }

    [Theory]
    [InlineData("https://host/module.js", null)]
    [InlineData("fsus:fs", null)]
    [InlineData(null, "eval")]
    [InlineData(null, "Function")]
    public async Task ExecuteAsync_UnknownImportOrGlobal_FailsClosed(string? import, string? global)
    {
        AuthoringWorkerCapabilityReport report = ClosedReport() with
        {
            Imports = import is null ? [] : [import],
            Globals = global is null ? [] : [global]
        };
        WorkerFixture fixture = await CreateFixtureAsync(new TestInstance(report));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Sandbox.ExecuteAsync(fixture.Package, fixture.Target, fixture.Request, 1));
    }

    [Fact]
    public async Task ExecuteAsync_Timeout_TerminatesAndRejectsLateResult()
    {
        var instance = new TestInstance(ClosedReport()) { NeverComplete = true };
        WorkerFixture fixture = await CreateFixtureAsync(instance);
        AuthoringWorkerRequest request = fixture.Request with
        {
            Deadline = DateTimeOffset.UtcNow.AddMilliseconds(10)
        };

        AuthoringWorkerExecutionResult result = await fixture.Sandbox.ExecuteAsync(
            fixture.Package,
            fixture.Target,
            request,
            1);

        Assert.Equal(AuthoringWorkerResultStatus.TimedOut, result.Status);
        Assert.Null(result.Response);
        Assert.Equal("cancelled-or-timeout", instance.TerminationReason);
    }

    [Fact]
    public async Task ExecuteAsync_CrashIsContainedAsResult()
    {
        var instance = new TestInstance(ClosedReport()) { Crash = true };
        WorkerFixture fixture = await CreateFixtureAsync(instance);

        AuthoringWorkerExecutionResult result = await fixture.Sandbox.ExecuteAsync(
            fixture.Package,
            fixture.Target,
            fixture.Request,
            1);

        Assert.Equal(AuthoringWorkerResultStatus.Crashed, result.Status);
        Assert.Null(result.Response);
        Assert.Equal("worker-crashed", instance.TerminationReason);
    }

    [Fact]
    public async Task ExecuteAsync_StaleDocumentOrUpdateIdentity_RejectsResult()
    {
        WorkerFixture stale = await CreateFixtureAsync(currentRevision: false);
        AuthoringWorkerExecutionResult result = await stale.Sandbox.ExecuteAsync(
            stale.Package,
            stale.Target,
            stale.Request,
            1);
        Assert.Equal(AuthoringWorkerResultStatus.Stale, result.Status);

        WorkerFixture drift = await CreateFixtureAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await drift.Sandbox.ExecuteAsync(
                drift.Package,
                drift.Target,
                drift.Request with
                {
                    RuntimeIdentity = new string('0', 64)
                },
                1));
    }

    [Fact]
    public async Task ExecuteAsync_ModuleDigestMismatch_FailsBeforeRuntimeStart()
    {
        WorkerFixture fixture = await CreateFixtureAsync();
        AuthoringPackageArchiveContents contents = fixture.Package.Contents with
        {
            Entries =
            [
                fixture.Package.Contents.Entries[0] with { Content = [9, 9, 9] }
            ]
        };

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Sandbox.ExecuteAsync(
                fixture.Package with
                {
                    Contents = contents
                },
                fixture.Target,
                fixture.Request,
                1));
    }

    [Fact]
    public async Task ExecuteAsync_TargetOrClosedRequestDrift_FailsBeforeRuntimeStart()
    {
        WorkerFixture fixture = await CreateFixtureAsync();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Sandbox.ExecuteAsync(
                fixture.Package,
                fixture.Target with { ExtensionVersion = "9.9.9" },
                fixture.Request,
                1));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Sandbox.ExecuteAsync(
                fixture.Package,
                fixture.Target,
                fixture.Request with { RequestId = "bad\nrequest" },
                1));
    }

    [Fact]
    public void LinuxRuntimeSource_EnforcesDeclaredMemoryAndClosedModuleBoundary()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src/backend/Infrastructure/AuthoringExtensions/LinuxBubblewrapAuthoringWorkerRuntime.cs"));

        Assert.Contains("inspectMemoryPolicy(moduleBytes)", source, StringComparison.Ordinal);
        Assert.Contains("wasm-memory-policy-invalid", source, StringComparison.Ordinal);
        Assert.Contains("--unshare-all", source, StringComparison.Ordinal);
        Assert.Contains("imports.length !== 0", source, StringComparison.Ordinal);
        Assert.DoesNotContain("eval(", source, StringComparison.Ordinal);
        Assert.DoesNotContain("WebView", source, StringComparison.Ordinal);
        Assert.DoesNotContain("iframe", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("node:net", source, StringComparison.Ordinal);
        Assert.DoesNotContain("node:child_process", source, StringComparison.Ordinal);
    }

    [Fact]
    [SupportedOSPlatform("linux")]
    public async Task LinuxRuntime_ExecutesVerifiedWasmInsideObservedNamespaces()
    {
        Assert.True(OperatingSystem.IsLinux(), "The production authoring worker profile is Linux-only.");
        byte[] module = Convert.FromHexString(EchoWasmHex);
        string moduleDigest = Convert.ToHexStringLower(SHA256.HashData(module));
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-authoring-worker-{Guid.NewGuid():N}");
        string nodePath = File.ResolveLinkTarget("/usr/local/bin/node", true)?.FullName ?? "/usr/local/bin/node";
        var runtime = new LinuxBubblewrapAuthoringWorkerRuntime(new LinuxBubblewrapWorkerOptions(
            "/usr/bin/bwrap",
            nodePath,
            "/usr/lib/x86_64-linux-gnu",
            "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
            root,
            TimeSpan.FromSeconds(5)));
        var descriptor = new AuthoringWorkerLaunchDescriptor(
            new string('a', 64),
            new string('9', 64),
            "acme.author-tools",
            "1.0.0",
            new string('b', 64),
            new string('c', 64),
            "acme.command.format",
            moduleDigest,
            new string('d', 64),
            new string('e', 64),
            new string('f', 64),
            [.. module],
            131_072,
            1024,
            1024);

        await using IAuthoringWorkerSandboxInstance instance = await runtime.StartAsync(descriptor, CancellationToken.None);
        Assert.True(instance.CapabilityReport.ProcessNamespacesObserved);
        Assert.Equal(64, instance.CapabilityReport.RuntimeProfileSha256.Length);
        Assert.False(instance.CapabilityReport.Dom);
        Assert.False(instance.CapabilityReport.Network);
        Assert.False(instance.CapabilityReport.FileSystem);
        Assert.False(instance.CapabilityReport.Process);
        Assert.Empty(instance.CapabilityReport.Imports);

        var request = new AuthoringWorkerRequest(
            1,
            descriptor.RuntimeIdentity,
            descriptor.ExtensionId,
            descriptor.Version,
            descriptor.PackageSha256,
            descriptor.ContributionId,
            "document-1",
            1,
            1,
            "request-1",
            "schema/request-v1",
            "schema/result-v1",
            new string('0', 64),
            DateTimeOffset.UtcNow.AddSeconds(5),
            [1, 2, 3, 4]);
        AuthoringWorkerResponse response = await instance.ExecuteAsync(request, CancellationToken.None);

        Assert.Equal(request.Payload.ToArray(), response.Payload.ToArray());
        Assert.Equal(request.RuntimeIdentity, response.RuntimeIdentity);
        await instance.TerminateAsync("test-complete", CancellationToken.None);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await instance.ExecuteAsync(request, CancellationToken.None));
    }

    [Fact]
    [SupportedOSPlatform("linux")]
    public async Task LinuxRuntime_BenignNetworkImportIsRejectedBeforeReadiness()
    {
        Assert.True(OperatingSystem.IsLinux(), "The production authoring worker profile is Linux-only.");
        byte[] module = Convert.FromHexString(NetworkImportWasmHex);
        string moduleDigest = Convert.ToHexStringLower(SHA256.HashData(module));
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-authoring-worker-{Guid.NewGuid():N}");
        try
        {
            string nodePath = File.ResolveLinkTarget("/usr/local/bin/node", true)?.FullName ?? "/usr/local/bin/node";
            var runtime = new LinuxBubblewrapAuthoringWorkerRuntime(new LinuxBubblewrapWorkerOptions(
                "/usr/bin/bwrap",
                nodePath,
                "/usr/lib/x86_64-linux-gnu",
                "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
                root,
                TimeSpan.FromSeconds(5)));
            var descriptor = new AuthoringWorkerLaunchDescriptor(
                new string('a', 64),
                new string('9', 64),
                "acme.author-tools",
                "1.0.0",
                new string('b', 64),
                new string('c', 64),
                "acme.command.format",
                moduleDigest,
                new string('d', 64),
                new string('e', 64),
                new string('f', 64),
                [.. module],
                131_072,
                1024,
                1024);

            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await runtime.StartAsync(descriptor, CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, true);
            }
        }
    }

    private static async ValueTask<WorkerFixture> CreateFixtureAsync(
        TestInstance? instance = null,
        bool currentRevision = true)
    {
        byte[] archive = "archive"u8.ToArray();
        byte[] module = "wasm-module"u8.ToArray();
        string moduleDigest = Convert.ToHexStringLower(SHA256.HashData(module));
        ImmutableArray<AuthoringPackageEntry> entries =
        [
            new AuthoringPackageEntry("worker/main.wasm", ImmutableArray.Create(module), moduleDigest)
        ];
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions =
            [
                AuthoringExtensionContractsTests.CreateManifest().Contributions[0] with
                {
                    Entrypoint = new AuthoringEntrypointIdentity(
                        AuthoringEntrypointFormat.WasmModule,
                        "worker/main.wasm",
                        moduleDigest)
                }
            ]
        };
        ImmutableArray<byte> manifestBytes = ImmutableArray.Create(JsonSerializer.SerializeToUtf8Bytes(manifest));
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var verifier = new AuthoringPackageVerifier(
            new TrustVerifier(now),
            new ArchiveReader(new AuthoringPackageArchiveContents(manifestBytes, entries)),
            new FixedTimeProvider(now));
        var artifact = new AuthoringPackageArtifact(
            ImmutableArray.Create(archive),
            [1],
            "acme",
            "key-1",
            "approved-source/catalog-1",
            "provenance/build-1",
            Convert.ToHexStringLower(SHA256.HashData(archive)));
        VerifiedAuthoringPackage package = await verifier.VerifyAsync(artifact, AuthoringHostPlatform.ServerLinux);
        AuthoringContributionDeclaration contribution = package.Contract.Manifest.Contributions[0];
        var target = new AuthoringExecutionTarget(
            AuthoringExecutionResolutionStatus.Ready,
            AuthoringExecutionClass.IsolatedWorkerWasm,
            manifest.Id,
            manifest.Version,
            manifest.PackageSha256,
            contribution.Id,
            contribution.Kind,
            contribution.Entrypoint.PathOrAdapterId,
            null,
            new string('d', 64),
            null);
        var request = new AuthoringWorkerRequest(
            1,
            target.RuntimeIdentity,
            target.ExtensionId,
            target.ExtensionVersion,
            target.PackageSha256,
            target.ContributionId,
            "document-1",
            1,
            2,
            "request-1",
            "schema/request-v1",
            "schema/result-v1",
            new string('e', 64),
            now.AddSeconds(5),
            [1, 2, 3]);
        instance ??= new TestInstance(ClosedReport());
        var lifecycleResources = new AuthoringExtensionLifecycleResources(new LifecycleHostResources());
        await lifecycleResources.ActivateAtomicallyAsync(package, [target], 1, CancellationToken.None);
        var sandbox = new AuthoringExtensionWorkerSandbox(
            new TestRuntime(instance),
            new RevisionGate(currentRevision),
            lifecycleResources,
            new FixedTimeProvider(now));
        return new WorkerFixture(package, target, request, sandbox);
    }

    private static AuthoringWorkerCapabilityReport ClosedReport() => new(
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        [],
        [],
        true,
        new string('f', 64));

    private sealed record WorkerFixture(
        VerifiedAuthoringPackage Package,
        AuthoringExecutionTarget Target,
        AuthoringWorkerRequest Request,
        AuthoringExtensionWorkerSandbox Sandbox);

    private sealed class TestRuntime(TestInstance instance) : IAuthoringWorkerSandboxRuntime
    {
        public ValueTask<IAuthoringWorkerSandboxInstance> StartAsync(
            AuthoringWorkerLaunchDescriptor descriptor,
            CancellationToken cancellationToken) => ValueTask.FromResult<IAuthoringWorkerSandboxInstance>(instance);
    }

    private sealed class LifecycleHostResources : IAuthoringLifecycleHostResourceAuthority
    {
        public ValueTask ActivateAtomicallyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            CancellationToken cancellationToken) => ValueTask.CompletedTask;

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(
            string extensionId,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0));
    }

    private sealed class TestInstance(AuthoringWorkerCapabilityReport report) : IAuthoringWorkerSandboxInstance
    {
        public AuthoringWorkerCapabilityReport CapabilityReport => report;

        public bool NeverComplete
        {
            get; init;
        }

        public bool Crash
        {
            get; init;
        }

        public string? TerminationReason
        {
            get; private set;
        }

        public async ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken)
        {
            if (Crash)
            {
                throw new InvalidOperationException("trap");
            }

            if (NeverComplete)
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }

            return new AuthoringWorkerResponse(
                request.SchemaVersion,
                request.RuntimeIdentity,
                request.RequestId,
                request.ResultSchemaReference,
                [4, 5, 6]);
        }

        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            TerminationReason = reason;
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class RevisionGate(bool current) : IAuthoringDocumentRevisionGate
    {
        public ValueTask<bool> IsCurrentAsync(
            string documentId,
            long documentEpoch,
            long sourceRevision,
            CancellationToken cancellationToken) => ValueTask.FromResult(current);
    }

    private sealed class TrustVerifier(DateTimeOffset now) : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(
            string publisher,
            string keyId,
            ReadOnlyMemory<byte> archive,
            ReadOnlyMemory<byte> signature,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted,
                publisher,
                keyId,
                now,
                now.AddMinutes(5),
                new string('d', 64)));
    }

    private sealed class ArchiveReader(AuthoringPackageArchiveContents contents) : IAuthoringPackageArchiveReader
    {
        public ValueTask<AuthoringPackageArchiveContents> ReadAsync(
            ReadOnlyMemory<byte> canonicalArchive,
            CancellationToken cancellationToken) => ValueTask.FromResult(contents);
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
