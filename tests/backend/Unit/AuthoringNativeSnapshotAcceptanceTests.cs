using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

[SupportedOSPlatform("linux")]
public sealed class AuthoringNativeSnapshotAcceptanceTests
{
    // A closed two-page Wasm fixture copies loaded bytes to independent state memory at 65536.
    // Generic execute corrupts that state, allowing an actual stored-state change to be observed.
    private const string StatefulWasmHex = "0061736d0100000001160460017f017f60027f7f017e60027f7f017f6000017e030504000102030504010102020606017f0141000b074e05066d656d6f727902000a667375735f616c6c6f6300000c667375735f6578656375746500010f667375735f73746174655f6c6f6164000213667375735f73746174655f736e617073686f7400030a400405004180080b15004180800441003a00002000ad4220862001ad840b14004180800420002001fc0a00002001240041010b0d00428080044220862300ad840b";
    private const string EchoWasmHex = "0061736d01000000010c0260017f017f60027f7f017e0303020001050401010202072603066d656d6f727902000a667375735f616c6c6f6300000c667375735f6578656375746500010a140205004180080b0c002000ad4220862001ad840b";
    private static readonly string s_operation = new('e', 64);

    [Fact]
    public void Acceptance_IsSealedWithNoPublicConstructorOrPublicIssuer()
    {
        Type type = typeof(AuthoringNativeStateSnapshotAcceptance);
        Assert.True(type.IsSealed);
        Assert.Empty(type.GetConstructors());
        Assert.Empty(type.GetMethods(BindingFlags.Public | BindingFlags.Static));
        Assert.DoesNotContain(type.GetProperties(), property => property.PropertyType == typeof(AuthoringStateSnapshot));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UnsupportedCallerRuntime_CannotSupplyNativeAcceptance(bool service)
    {
        Fixture fixture = await CreateFixtureAsync(service ? [1] : Convert.FromHexString(StatefulWasmHex), service);
        if (service)
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await ((IAuthoringServiceProcess)new CallerService()).AcceptStateSnapshotAsync(
                    fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation, default));
        }
        else
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await ((IAuthoringWorkerSandboxInstance)new CallerWorker()).AcceptStateSnapshotAsync(
                    fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation, default));
        }
    }

    [Theory]
    [InlineData("generation")]
    [InlineData("operation")]
    [InlineData("runtime")]
    [InlineData("version")]
    [InlineData("package")]
    [InlineData("contribution")]
    [InlineData("revision")]
    [InlineData("snapshot-package")]
    [InlineData("state-budget")]
    public async Task OriginalCodecBinding_RejectsMismatchBeforeAnyNativeIssuance(string drift)
    {
        Fixture fixture = await CreateFixtureAsync(Convert.FromHexString(StatefulWasmHex), maximumStateBytes: drift == "state-budget" ? 2 : 1024);
        AuthoringExecutionTarget target = drift switch
        {
            "runtime" => fixture.Target with { RuntimeIdentity = new string('f', 64) },
            "version" => fixture.Target with { ExtensionVersion = "2.0.0" },
            "package" => fixture.Target with { PackageSha256 = new string('f', 64) },
            "contribution" => fixture.Target with { ContributionId = "other.command" },
            _ => fixture.Target
        };
        AuthoringStateSnapshot snapshot = drift switch
        {
            "revision" => fixture.Snapshot with { Revision = fixture.Snapshot.Revision + 1 },
            "snapshot-package" => AuthoringExtensionStateContract.Snapshot(fixture.Snapshot.Scope,
                new string('f', 64), fixture.Snapshot.Revision, fixture.Snapshot.Entries),
            _ => fixture.Snapshot
        };

        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringNativeStateSnapshotBinding.Create(
            fixture.Package, target, snapshot, drift == "generation" ? 0 : 2,
            drift == "operation" ? "not-an-operation" : s_operation, fixture.WorkerDescriptor!));
    }

    [Theory]
    [InlineData("binding")]
    [InlineData("payload")]
    [InlineData("base64")]
    [InlineData("whitespace")]
    [InlineData("digest-only")]
    public async Task ReadbackValidator_RejectsEchoAndChangedStoredBytes(string drift)
    {
        Fixture fixture = await CreateFixtureAsync(Convert.FromHexString(StatefulWasmHex));
        AuthoringNativeStateSnapshotBinding binding = AuthoringNativeStateSnapshotBinding.Create(
            fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation, fixture.WorkerDescriptor!);
        string payload = drift switch
        {
            "payload" => Convert.ToBase64String([9]),
            "base64" => "@@==",
            "whitespace" => Convert.ToBase64String(binding.Bytes) + "\n",
            "digest-only" => fixture.Snapshot.ContentSha256,
            _ => Convert.ToBase64String(binding.Bytes)
        };
        Assert.Throws<AuthoringExtensionContractException>(() => binding.VerifyReadback(
            drift == "binding" ? "foreign" : binding.TransportBinding, payload));
        // This validates bytes only. It cannot issue a native lifetime.
        binding.VerifyReadback(binding.TransportBinding, Convert.ToBase64String(binding.Bytes));
    }

    [Fact]
    public async Task RealRunner_InstallsOriginalSnapshotAndReadsStoredWasmBytesWithoutResendingThem()
    {
        Fixture fixture = await CreateFixtureAsync(Convert.FromHexString(StatefulWasmHex));
        AuthoringNativeStateSnapshotBinding binding = AuthoringNativeStateSnapshotBinding.Create(
            fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation, fixture.WorkerDescriptor!);
        await using var runner = await Runner.StartAsync(Convert.FromHexString(StatefulWasmHex));
        Assert.Equal(1, runner.Ready.GetProperty("stateSnapshotVersion").GetInt32());
        string firstNonce = new('1', 64);
        JsonElement loaded = await runner.SendAsync(new
        {
            kind = "state-load",
            schemaVersion = 1,
            nonce = firstNonce,
            binding = binding.TransportBinding,
            payload = Convert.ToBase64String(binding.Bytes)
        });
        Assert.Equal("state-accepted", loaded.GetProperty("kind").GetString());
        binding.VerifyReadback(loaded.GetProperty("binding").GetString(), loaded.GetProperty("payload").GetString());
        string nextNonce = new('2', 64);
        JsonElement current = await runner.SendAsync(new
        {
            kind = "state-verify",
            schemaVersion = 1,
            nonce = nextNonce
        });
        Assert.Equal(nextNonce, current.GetProperty("nonce").GetString());
        binding.VerifyReadback(current.GetProperty("binding").GetString(), current.GetProperty("payload").GetString());
        await runner.SendAsync(new
        {
            kind = "execute",
            schemaVersion = 1,
            runtimeIdentity = fixture.Target.RuntimeIdentity,
            requestId = "mutate",
            resultSchemaReference = "result/v1",
            payload = "AQ=="
        });
        JsonElement changed = await runner.SendAsync(new
        {
            kind = "state-verify",
            schemaVersion = 1,
            nonce = nextNonce
        });
        Assert.Throws<AuthoringExtensionContractException>(() => binding.VerifyReadback(
            changed.GetProperty("binding").GetString(), changed.GetProperty("payload").GetString()));
        // Extracted original RunnerSource exercises real Node/Wasm storage, without issuing any
        // incarnation or acceptance. It is not evidence of Linux sandbox containment.
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RealRunner_RejectsUnsupportedAbiAndVerifyBeforeLoad(bool supportedAbi)
    {
        await using var runner = await Runner.StartAsync(Convert.FromHexString(supportedAbi ? StatefulWasmHex : EchoWasmHex));
        JsonElement response = await runner.SendAsync(new
        {
            kind = "state-verify",
            schemaVersion = 1,
            nonce = new string('1', 64)
        });
        Assert.Equal("error", response.GetProperty("kind").GetString());
        Assert.Equal(supportedAbi ? "state-not-loaded" : "state-protocol-unavailable-or-invalid",
            response.GetProperty("stableReason").GetString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActualNativeRuntime_HoldsOriginalAcceptedSnapshotThroughVerification(bool service)
    {
        string root = Path.Combine(Path.GetTempPath(), "authoring-native-snapshot-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        IAsyncDisposable? owner = null;
        AuthoringNativeStateSnapshotAcceptance? acceptance = null;
        try
        {
            byte[] module = service ? await CompileServiceAsync(root) : Convert.FromHexString(StatefulWasmHex);
            Fixture fixture = await CreateFixtureAsync(module, service);
            if (service)
            {
                var runtime = new LinuxBubblewrapAuthoringServiceRuntime(new LinuxBubblewrapServiceOptions(
                    "/usr/bin/prlimit", "/usr/bin/bwrap", Path.Combine(root, "native"), TimeSpan.FromSeconds(5)));
                IAuthoringServiceProcess process = await runtime.StartAsync(fixture.ServiceDescriptor!, default);
                owner = process;
                acceptance = await process.AcceptStateSnapshotAsync(fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation, default);
            }
            else
            {
                var runtime = new LinuxBubblewrapAuthoringWorkerRuntime(new LinuxBubblewrapWorkerOptions(
                    "/usr/bin/bwrap", NodePath(), "/usr/lib/x86_64-linux-gnu",
                    "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", Path.Combine(root, "native"), TimeSpan.FromSeconds(5)));
                IAuthoringWorkerSandboxInstance worker = await runtime.StartAsync(fixture.WorkerDescriptor!, default);
                owner = worker;
                acceptance = await worker.AcceptStateSnapshotAsync(fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation, default);
            }
            {
                await acceptance.VerifyCurrentAsync(owner, fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation);
                await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                    await acceptance.VerifyCurrentAsync(new CallerWorker(), fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation));
                await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                    await acceptance.VerifyCurrentAsync(owner, fixture.Package, fixture.Target, fixture.Snapshot, 3, s_operation));
                using var blocked = new CancellationTokenSource(TimeSpan.FromMilliseconds(20));
                if (owner is IAuthoringWorkerSandboxInstance worker)
                {
                    await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
                        await worker.ExecuteAsync(new AuthoringWorkerRequest(1, fixture.Target.RuntimeIdentity,
                            fixture.Target.ExtensionId, fixture.Target.ExtensionVersion, fixture.Target.PackageSha256,
                            fixture.Target.ContributionId, "document", 1, 1, "request", "request/v1", "result/v1",
                            new string('d', 64), DateTimeOffset.UtcNow.AddSeconds(1), [1]), blocked.Token));
                    await worker.TerminateAsync("native-control-complete", default);
                }
                else
                {
                    var process = (IAuthoringServiceProcess)owner;
                    await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
                        await process.ExecuteAsync(new AuthoringServiceRequest(1, fixture.Target.RuntimeIdentity,
                            fixture.Target.ExtensionId, fixture.Target.ExtensionVersion, fixture.Target.PackageSha256,
                            fixture.Target.ContributionId, "document", 1, 1, "request", DateTimeOffset.UtcNow.AddSeconds(1), [], [1]), blocked.Token));
                    await process.TerminateTreeAsync("native-control-complete", default);
                }
                await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                    await acceptance.VerifyCurrentAsync(owner, fixture.Package, fixture.Target, fixture.Snapshot, 2, s_operation));
            }
        }
        finally
        {
            if (acceptance is not null)
                await acceptance.DisposeAsync();
            if (owner is not null)
                await owner.DisposeAsync();
            Directory.Delete(root, true);
        }
    }

    private static async Task<Fixture> CreateFixtureAsync(byte[] module, bool service = false, long maximumStateBytes = 1024)
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
                MaximumStateBytes = maximumStateBytes
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
            "approved-source/catalog-1", "provenance/build-1", Convert.ToHexStringLower(SHA256.HashData(archive))), AuthoringHostPlatform.ServerLinux);
        var target = new AuthoringExecutionTarget(AuthoringExecutionResolutionStatus.Ready, manifest.Contributions[0].ExecutionClass,
            manifest.Id, manifest.Version, manifest.PackageSha256, manifest.Contributions[0].Id, manifest.Contributions[0].Kind,
            path, null, new string('a', 64), null);
        var scope = new AuthoringStateScope(manifest.Id, manifest.Version, "site", "user", null, manifest.StateSchemaVersion);
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

    private sealed class CallerWorker : IAuthoringWorkerSandboxInstance
    {
        public AuthoringWorkerCapabilityReport CapabilityReport => throw new NotSupportedException();
        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(AuthoringWorkerRequest request, CancellationToken token) => throw new NotSupportedException();
        public ValueTask TerminateAsync(string reason, CancellationToken token) => ValueTask.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class CallerService : IAuthoringServiceProcess
    {
        public AuthoringProcessOwnershipReport Ownership => throw new NotSupportedException();
        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken token) => throw new NotSupportedException();
        public ValueTask<AuthoringServiceResponse> ExecuteAsync(AuthoringServiceRequest request, CancellationToken token) => throw new NotSupportedException();
        public ValueTask TerminateTreeAsync(string reason, CancellationToken token) => ValueTask.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class Runner(Process process, string root, Task<string> errors, JsonElement ready) : IAsyncDisposable
    {
        public JsonElement Ready => ready;

        public static async Task<Runner> StartAsync(byte[] module)
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
            foreach (string arg in new[] { runnerPath, "131072", "65536", "65536" })
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

    private static async Task<byte[]> CompileServiceAsync(string root)
    {
        string source = Path.Combine(root, "snapshot-service.c");
        string binary = Path.Combine(root, "snapshot-service");
        await File.WriteAllTextAsync(source, """
            #include <stdio.h>
            #include <string.h>
            static char line[140000], stored[90000], binding[4097];
            int main(int argc, char **argv) {
                if (argc != 6) return 2;
                setvbuf(stdout, NULL, _IOLBF, 0);
                printf("READY\t%s\t%s\t%s\tstate-snapshot-v1\n", argv[1], argv[2], argv[3]);
                while (fgets(line, sizeof(line), stdin)) {
                    if (!strchr(line, '\n')) return 3;
                    line[strcspn(line, "\r\n")] = 0;
                    char *save = NULL, *fields[6]; int count = 0;
                    char *part = strtok_r(line, "\t", &save);
                    while (part && count < 6) { fields[count++] = part; part = strtok_r(NULL, "\t", &save); }
                    if (count == 5 && !strcmp(fields[0], "STATE_APPLY") && !strcmp(fields[1], "1")) {
                        if (strlen(fields[2]) != 64 || strlen(fields[3]) >= sizeof(binding) || strlen(fields[4]) >= sizeof(stored)) return 4;
                        strcpy(binding, fields[3]); strcpy(stored, fields[4]);
                        printf("STATE_ACCEPTED\t1\t%s\t%s\t%s\n", fields[2], binding, stored);
                    } else if (count == 3 && !strcmp(fields[0], "STATE_VERIFY") && !strcmp(fields[1], "1") && stored[0]) {
                        printf("STATE_CURRENT\t1\t%s\t%s\t%s\n", fields[2], binding, stored);
                    } else return 5;
                }
                return 0;
            }
            """);
        var start = new ProcessStartInfo("cc") { RedirectStandardError = true };
        foreach (string arg in new[] { "-static", "-O2", source, "-o", binary })
            start.ArgumentList.Add(arg);
        using Process compiler = Process.Start(start)!;
        Task<string> errors = compiler.StandardError.ReadToEndAsync();
        await compiler.WaitForExitAsync();
        Assert.True(compiler.ExitCode == 0, await errors);
        return await File.ReadAllBytesAsync(binary);
    }
}
