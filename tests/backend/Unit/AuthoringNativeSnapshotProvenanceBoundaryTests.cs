using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

[SupportedOSPlatform("linux")]
public sealed class AuthoringNativeSnapshotProvenanceBoundaryTests
{
    private const string StatefulWasmHex = "0061736d0100000001160460017f017f60027f7f017e60027f7f017f6000017e030504000102030504010102020606017f0141000b074e05066d656d6f727902000a667375735f616c6c6f6300000c667375735f6578656375746500010f667375735f73746174655f6c6f6164000213667375735f73746174655f736e617073686f7400030a400405004180080b15004180800441003a00002000ad4220862001ad840b14004180800420002001fc0a00002001240041010b0d00428080044220862300ad840b";
    private static readonly string s_operation = new('e', 64);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SameCodeDifferentProvenance_CannotReuseOriginalLaunchRuntime(bool service)
    {
        byte[] module = Convert.FromHexString(StatefulWasmHex);
        Fixture original = await CreateFixtureAsync(module, service, provenance: "provenance/build-a");
        Fixture other = await CreateFixtureAsync(module, service, provenance: "provenance/build-b");
        Assert.Equal(original.Package.Contract.Manifest.PackageSha256, other.Package.Contract.Manifest.PackageSha256);
        Assert.Equal(original.Package.Contract.Manifest.ContentSha256, other.Package.Contract.Manifest.ContentSha256);
        Assert.NotEqual(original.Package.PackageIdentity, other.Package.PackageIdentity);
        Assert.NotEqual(original.Target.RuntimeIdentity, other.Target.RuntimeIdentity);
        object descriptor = service ? original.ServiceDescriptor! : original.WorkerDescriptor!;
        AuthoringExecutionTarget copied = other.Target with
        {
            RuntimeIdentity = original.Target.RuntimeIdentity
        };

        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringNativeStateSnapshotBinding.Create(
            other.Package, copied, other.Snapshot, 2, s_operation, descriptor));
        AuthoringNativeStateSnapshotBinding.Create(original.Package, original.Target, original.Snapshot, 2, s_operation, descriptor);
        AuthoringNativeStateSnapshotBinding.Create(other.Package, other.Target, other.Snapshot, 2, s_operation,
            service ? other.ServiceDescriptor! : other.WorkerDescriptor!);
    }

    [Theory]
    [InlineData(false, 0)]
    [InlineData(false, 256)]
    [InlineData(true, 0)]
    [InlineData(true, 256)]
    public async Task OriginalValidUnicodeScope_IsAcceptedByHostAndActualRunner(bool service, int unicodeLength)
    {
        Fixture fixture = await CreateFixtureAsync(Convert.FromHexString(StatefulWasmHex), service, unicodeLength: unicodeLength);
        AuthoringNativeStateSnapshotBinding binding = AuthoringNativeStateSnapshotBinding.Create(
            fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation,
            service ? fixture.ServiceDescriptor! : fixture.WorkerDescriptor!);
        if (unicodeLength == 256)
            Assert.True(binding.TransportBinding.Length > 4096);
        if (service)
        {
            await VerifyServiceStorageAsync(unicodeLength, 65536);
            return;
        }
        await using var runner = await Runner.StartAsync(Convert.FromHexString(StatefulWasmHex));
        JsonElement loaded = await runner.SendAsync(new
        {
            kind = "state-load",
            schemaVersion = 1,
            nonce = new string('1', 64),
            binding = binding.TransportBinding,
            payload = Convert.ToBase64String(binding.Bytes)
        });
        Assert.Equal("state-accepted", loaded.GetProperty("kind").GetString());
        binding.VerifyReadback(loaded.GetProperty("binding").GetString(), loaded.GetProperty("payload").GetString());
        // Actual original RunnerSource exercises wire/storage parity for both original codecs.
        // It issues no native incarnation or acceptance and does not qualify sandbox startup.
    }

    [Theory]
    [InlineData(false, -1)]
    [InlineData(false, 0)]
    [InlineData(false, 1)]
    [InlineData(true, -1)]
    [InlineData(true, 0)]
    [InlineData(true, 1)]
    public async Task BindingBudgetBoundary_IsConsistentBeforeNativeIo(bool service, int budgetOffset)
    {
        byte[] module = Convert.FromHexString(StatefulWasmHex);
        Fixture measured = await CreateFixtureAsync(module, service, unicodeLength: 256);
        int metadataLength = AuthoringNativeStateSnapshotBinding.Create(measured.Package, measured.Target,
            measured.Snapshot, 2, s_operation, service ? measured.ServiceDescriptor! : measured.WorkerDescriptor!).TransportBinding.Length;
        int budget = metadataLength + budgetOffset;
        Fixture fixture = await CreateFixtureAsync(module, service, unicodeLength: 256, transportBudget: budget);
        if (budgetOffset < 0)
        {
            Assert.Throws<AuthoringExtensionContractException>(() => AuthoringNativeStateSnapshotBinding.Create(
                fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation,
                service ? fixture.ServiceDescriptor! : fixture.WorkerDescriptor!));
            return;
        }
        AuthoringNativeStateSnapshotBinding binding = AuthoringNativeStateSnapshotBinding.Create(fixture.Package,
            fixture.Target, fixture.Snapshot, 2, s_operation, service ? fixture.ServiceDescriptor! : fixture.WorkerDescriptor!);
        Assert.Equal(metadataLength, binding.TransportBinding.Length);
        if (service)
        {
            await VerifyServiceStorageAsync(256, budget);
            return;
        }
        await using var runner = await Runner.StartAsync(module, budget);
        JsonElement loaded = await runner.SendAsync(new
        {
            kind = "state-load",
            schemaVersion = 1,
            nonce = new string('1', 64),
            binding = binding.TransportBinding,
            payload = Convert.ToBase64String(binding.Bytes)
        });
        Assert.Equal("state-accepted", loaded.GetProperty("kind").GetString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OverLimitOriginalScope_IsRejectedByOriginalCodec(bool service)
    {
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await CreateFixtureAsync(Convert.FromHexString(StatefulWasmHex), service, unicodeLength: 257));
    }

    [Theory]
    [InlineData(false, "surrogate")]
    [InlineData(true, "surrogate")]
    [InlineData(false, "control")]
    [InlineData(true, "control")]
    public async Task MalformedOriginalScope_IsRejectedBeforeNativeIo(bool service, string malformed)
    {
        Fixture fixture = await CreateFixtureAsync(Convert.FromHexString(StatefulWasmHex), service);
        AuthoringStateSnapshot invalid = fixture.Snapshot with
        {
            Scope = fixture.Snapshot.Scope with
            {
                UserId = malformed == "surrogate" ? "bad\ud800" : "bad\nuser"
            }
        };
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringNativeStateSnapshotBinding.Create(
            fixture.Package, fixture.Target, invalid, 2, s_operation,
            service ? fixture.ServiceDescriptor! : fixture.WorkerDescriptor!));
    }

    [Theory]
    [InlineData("binding")]
    [InlineData("budget")]
    [InlineData("payload")]
    [InlineData("nonce")]
    public async Task MalformedWorkerFrame_DoesNotInvalidatePreviouslyStoredState(string malformed)
    {
        Fixture fixture = await CreateFixtureAsync(Convert.FromHexString(StatefulWasmHex));
        AuthoringNativeStateSnapshotBinding binding = AuthoringNativeStateSnapshotBinding.Create(
            fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation, fixture.WorkerDescriptor!);
        await using var runner = await Runner.StartAsync(Convert.FromHexString(StatefulWasmHex));
        JsonElement first = await runner.SendAsync(new
        {
            kind = "state-load",
            schemaVersion = 1,
            nonce = new string('1', 64),
            binding = binding.TransportBinding,
            payload = Convert.ToBase64String(binding.Bytes)
        });
        Assert.Equal("state-accepted", first.GetProperty("kind").GetString());
        JsonElement rejected = await runner.SendAsync(new
        {
            kind = "state-load",
            schemaVersion = 1,
            nonce = malformed == "nonce" ? "bad" : new string('2', 64),
            binding = malformed == "budget" ? new string('A', 65540) : malformed == "binding" ? "bad!" : binding.TransportBinding,
            payload = malformed == "payload" ? "bad!" : Convert.ToBase64String(binding.Bytes)
        });
        Assert.Equal("error", rejected.GetProperty("kind").GetString());
        JsonElement current = await runner.SendAsync(new
        {
            kind = "state-verify",
            schemaVersion = 1,
            nonce = new string('3', 64)
        });
        Assert.Equal("state-current", current.GetProperty("kind").GetString());
        binding.VerifyReadback(current.GetProperty("binding").GetString(), current.GetProperty("payload").GetString());
    }

    // Actual service receiver storage/closed frames only: no native owner or capability is forged.
    private static async Task VerifyServiceStorageAsync(int unicodeLength, int budget)
    {
        string root = Path.Combine(Path.GetTempPath(), "authoring-service-boundary-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        Process? process = null;
        Task<string>? errors = null;
        try
        {
            MethodInfo compile = typeof(AuthoringNativeSnapshotAcceptanceTests).GetMethod("CompileServiceAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
            byte[] executable = await (Task<byte[]>)compile.Invoke(null, [root])!;
            Fixture fixture = await CreateFixtureAsync(executable, true, unicodeLength: unicodeLength, transportBudget: budget);
            AuthoringNativeStateSnapshotBinding binding = AuthoringNativeStateSnapshotBinding.Create(
                fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation, fixture.ServiceDescriptor!);
            var start = new ProcessStartInfo(Path.Combine(root, "snapshot-service"))
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            foreach (string value in new[] { fixture.Target.RuntimeIdentity, fixture.ServiceDescriptor!.ExecutableSha256,
                "authoring-service-transport/v1", fixture.Package.Contract.Manifest.ContentSha256, fixture.ServiceDescriptor.GrantSetDigest })
                start.ArgumentList.Add(value);
            process = Process.Start(start)!;
            errors = process.StandardError.ReadToEndAsync();
            Assert.StartsWith("READY\t", await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)));
            foreach (bool load in new[] { true, false })
            {
                string nonce = new(load ? '1' : '2', 64);
                string frame = binding.CreateServiceRequestFrame(load, nonce);
                Assert.True(System.Text.Encoding.UTF8.GetByteCount(frame) <= budget * 2 + 4096);
                await process.StandardInput.WriteLineAsync(frame);
                await process.StandardInput.FlushAsync();
                string? line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
                Assert.NotNull(line);
                string[] fields = line.Split('\t');
                Assert.Equal(5, fields.Length);
                Assert.Equal(load ? "STATE_ACCEPTED" : "STATE_CURRENT", fields[0]);
                Assert.Equal("1", fields[1]);
                Assert.Equal(nonce, fields[2]);
                binding.VerifyReadback(fields[3], fields[4]);
            }
        }
        finally
        {
            if (process is not null)
            {
                if (!process.HasExited)
                    process.Kill(true);
                await process.WaitForExitAsync();
                if (errors is not null)
                    await errors;
                process.Dispose();
            }
            Directory.Delete(root, true);
        }
    }

    private static async Task<Fixture> CreateFixtureAsync(byte[] module, bool service = false, long maximumStateBytes = 1024, string provenance = "provenance/build-1", int unicodeLength = 0, int transportBudget = 65536)
    {
        string digest = Convert.ToHexStringLower(SHA256.HashData(module));
        string path = service ? "service/extension" : "worker/main.wasm";
        ImmutableArray<AuthoringPackageEntry> entries = [new(path, [.. module], digest)];
        AuthoringExtensionManifest original = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest manifest = original with
        {
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Limits = original.Limits with
            {
                MaximumStateBytes = maximumStateBytes,
                MaximumRequestBytes = transportBudget,
                MaximumResponseBytes = transportBudget
            },
            Contributions = [original.Contributions[0] with
            {
                ExecutionClass = service ? AuthoringExecutionClass.OutOfProcessService : AuthoringExecutionClass.IsolatedWorkerWasm,
                Entrypoint = new(service ? AuthoringEntrypointFormat.ServiceExecutable : AuthoringEntrypointFormat.WasmModule, path, digest)
            }]
        };
        byte[] archive = "native-state-archive"u8.ToArray();
        var contents = new AuthoringPackageArchiveContents([.. JsonSerializer.SerializeToUtf8Bytes(manifest)], entries);
        var verifier = new AuthoringPackageVerifier(new Trust(), new Archive(contents), TimeProvider.System);
        VerifiedAuthoringPackage package = await verifier.VerifyAsync(new AuthoringPackageArtifact([.. archive], [1], "acme", "key-1",
            "approved-source/catalog-1", provenance, Convert.ToHexStringLower(SHA256.HashData(archive))), AuthoringHostPlatform.ServerLinux);
        var resolver = new AuthoringExecutionResolver(new ClosedTrustedAuthoringAdapterRegistry([]),
            new NoSource(), new NoModule(), new Installed());
        AuthoringExecutionTarget target = await resolver.ResolveAsync(package, manifest.Contributions[0].Id, AuthoringHostPlatform.ServerLinux);
        var scope = new AuthoringStateScope(manifest.Id, manifest.Version, unicodeLength == 0 ? "site" : new string('界', unicodeLength),
            unicodeLength == 0 ? "user" : new string('界', unicodeLength),
            unicodeLength == 0 ? null : new string('界', unicodeLength), manifest.StateSchemaVersion);
        AuthoringStateSnapshot snapshot = AuthoringExtensionStateContract.Snapshot(scope, package.PackageIdentity, 4,
            [new AuthoringStateEntry("settings", [1, 2, 3])]);
        var worker = service ? null : new AuthoringWorkerLaunchDescriptor(target.RuntimeIdentity, new string('b', 64), manifest.Id,
            manifest.Version, manifest.PackageSha256, manifest.ContentSha256, target.ContributionId, digest,
            new string('c', 64), new string('d', 64), new string('e', 64), [.. module], manifest.Limits.MemoryBytes,
            manifest.Limits.MaximumRequestBytes, manifest.Limits.MaximumResponseBytes);
        var process = service ? new AuthoringServiceLaunchDescriptor(target.RuntimeIdentity, manifest.Id, manifest.Version,
            manifest.PackageSha256, manifest.ContentSha256, target.ContributionId, digest, [.. module], [],
            Convert.ToHexStringLower(SHA256.HashData([])), "authoring-service-transport/v1", manifest.Limits.MemoryBytes,
            manifest.Limits.MaximumRequestBytes, manifest.Limits.MaximumResponseBytes, manifest.Limits.WallClock) : null;
        return new Fixture(package, target, snapshot, worker, process);
    }

    private static string NodePath() => (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator)
        .Select(path => Path.Combine(path, "node")).First(File.Exists);

    private sealed record Fixture(VerifiedAuthoringPackage Package, AuthoringExecutionTarget Target,
        AuthoringStateSnapshot Snapshot, AuthoringWorkerLaunchDescriptor? WorkerDescriptor, AuthoringServiceLaunchDescriptor? ServiceDescriptor);

    private sealed class Trust : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(string publisher, string keyId, ReadOnlyMemory<byte> archive,
            ReadOnlyMemory<byte> signature, CancellationToken cancellationToken) => ValueTask.FromResult(new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted, publisher, keyId, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(5), new string('d', 64)));
    }

    private sealed class Archive(AuthoringPackageArchiveContents contents) : IAuthoringPackageArchiveReader
    {
        public ValueTask<AuthoringPackageArchiveContents> ReadAsync(ReadOnlyMemory<byte> archive, CancellationToken token) => ValueTask.FromResult(contents);
    }

    private sealed class NoSource : ITrustedAuthoringAdapterSourceVerifier
    {
        public ValueTask<bool> IsCheckedInSourceExactAsync(TrustedAuthoringAdapterDescriptor descriptor, CancellationToken token) => ValueTask.FromResult(false);
    }
    private sealed class NoModule : ITrustedAuthoringAdapterModuleVerifier
    {
        public ValueTask<bool> IsLoadedModuleExactAsync(TrustedAuthoringAdapterDescriptor descriptor, CancellationToken token) => ValueTask.FromResult(false);
    }
    private sealed class Installed : IAuthoringInstalledPackageAuthority
    {
        public ValueTask<bool> IsActiveExactAsync(VerifiedAuthoringPackage package, CancellationToken token) => ValueTask.FromResult(true);
    }
    private sealed class Runner(Process process, string root, Task<string> errors, JsonElement ready) : IAsyncDisposable
    {
        public JsonElement Ready => ready;

        public static async Task<Runner> StartAsync(byte[] module, int budget = 65536)
        {
            string root = Path.Combine(Path.GetTempPath(), "authoring-state-runner-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path.Combine(root, "runtime"));
            string source = (string)typeof(LinuxBubblewrapAuthoringWorkerRuntime).GetField("RunnerSource", BindingFlags.Static | BindingFlags.NonPublic)!.GetRawConstantValue()!;
            string modulePath = Path.Combine(root, "runtime/module.wasm");
            await File.WriteAllBytesAsync(modulePath, module);
            // Only the fixed fixture module pathname is adapted; all production runner logic runs verbatim.
            source = source.Replace("'/runtime/module.wasm'", JsonSerializer.Serialize(modulePath), StringComparison.Ordinal);
            string runnerPath = Path.Combine(root, "runner.mjs");
            await File.WriteAllTextAsync(runnerPath, source);
            var start = new ProcessStartInfo(NodePath()) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (string arg in new[] { runnerPath, "131072", budget.ToString(System.Globalization.CultureInfo.InvariantCulture), budget.ToString(System.Globalization.CultureInfo.InvariantCulture) })
                start.ArgumentList.Add(arg);
            Process process = Process.Start(start)!;
            Task<string> errors = process.StandardError.ReadToEndAsync();
            string? line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.NotNull(line);
            return new Runner(process, root, errors, JsonDocument.Parse(line).RootElement.Clone());
        }

        public async Task<JsonElement> SendAsync(object frame)
        {
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(frame));
            await process.StandardInput.FlushAsync();
            string? line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.NotNull(line);
            return JsonDocument.Parse(line).RootElement.Clone();
        }

        public async ValueTask DisposeAsync()
        {
            if (!process.HasExited)
                process.Kill(true);
            await process.WaitForExitAsync();
            await errors;
            process.Dispose();
            Directory.Delete(root, true);
        }
    }

}
