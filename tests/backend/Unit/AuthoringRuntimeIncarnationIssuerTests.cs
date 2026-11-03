using System.Diagnostics;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

[SupportedOSPlatform("linux")]
public sealed class AuthoringRuntimeIncarnationIssuerTests
{
    private const string EchoWasmHex = "0061736d01000000010c0260017f017f60027f7f017e0303020001050401010202072603066d656d6f727902000a667375735f616c6c6f6300000c667375735f6578656375746500010a140205004180080b0c002000ad4220862001ad840b";

    [Fact]
    public void Capability_IsSealedAndHasNoPublicConstructorOrStringIssuer()
    {
        Type capability = typeof(AuthoringRuntimeIncarnationLease);
        Assert.True(capability.IsSealed);
        Assert.Empty(capability.GetConstructors());
        Assert.DoesNotContain(capability.GetMethods(BindingFlags.Public | BindingFlags.Static), method =>
            method.ReturnType == capability);
        Assert.DoesNotContain(capability.GetProperties(), property => property.Name.Contains("Generation", StringComparison.Ordinal));
    }

    [Fact]
    public async Task LegacyScalarConsumers_RemainClosedWithoutOwnedIncarnation()
    {
        var source = new LinuxProcAuthoringResourceMeasurementSource();
        string identity = new('a', 64);
        Assert.Throws<AuthoringExtensionContractException>(() => source.Register(identity, Environment.ProcessId));
        Assert.Throws<AuthoringExtensionContractException>(() => source.Unregister(identity, Environment.ProcessId));
        Assert.Throws<AuthoringExtensionContractException>(() => source.RecordRestart(identity));
        Assert.Throws<AuthoringExtensionContractException>(() => source.RecordBrokeredUsage(identity, 1, 2, 3));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await source.MeasureAsync(BudgetIdentity(identity), default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CallerMeasuredInterface_CannotIssueAuthority(bool service)
    {
        object descriptor = CreateDescriptor(service);
        var caller = new CallerInstance();
        Assert.False(Observe(caller, descriptor, out _));
        using Process current = Process.GetCurrentProcess();
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringRuntimeIncarnationLease.Issue(caller, descriptor, new object(), current, current, AuthoringRuntimeIncarnationLease.ReadStartTicks(current.Id), new string('b', 64)));
    }

    // Controlled private-owner tests bypass startup through reflection, retain real task-owned sleep
    // processes, and exercise capability/custody only. They do not qualify native sandbox isolation.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwners_SameDescriptorHasDifferentCapabilitiesAndPreservesWireIdentity(bool service)
    {
        object descriptor = CreateDescriptor(service);
        await using var first = ControlledOwner.Create(descriptor);
        await using var second = ControlledOwner.Create(descriptor);
        Assert.NotSame(first.Lease, second.Lease);
        Assert.Equal(first.Lease.RuntimeIdentity, second.Lease.RuntimeIdentity);
        Assert.True(first.Lease.IsCurrentOwner(first.Owner));
        Assert.False(first.Lease.IsCurrentOwner(second.Owner));
        Assert.True(second.Lease.IsCurrentOwner(second.Owner));
        Assert.Equal(new string('a', 64), first.Lease.RuntimeIdentity);
        Assert.Equal(new string('b', 64), first.Lease.RuntimeProfileSha256);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_RejectsDescriptorCloneForwarderAndCapabilityCopies(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        object clone = fixture.Descriptor switch
        {
            AuthoringWorkerLaunchDescriptor worker => worker with { },
            AuthoringServiceLaunchDescriptor process => process with { },
            _ => throw new InvalidOperationException()
        };
        Assert.False(Observe(fixture.Owner, clone, out _));
        object copiedOwner = MemberwiseCopy(fixture.Owner);
        Assert.False(Observe(copiedOwner, fixture.Descriptor, out _));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
        {
            if (copiedOwner is IAuthoringWorkerSandboxInstance worker)
            {
                await worker.TerminateAsync("clone", default);
            }
            else
            {
                await ((IAuthoringServiceProcess)copiedOwner).TerminateTreeAsync("clone", default);
            }
        });
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await ((IAsyncDisposable)copiedOwner).DisposeAsync());
        var copiedLease = (AuthoringRuntimeIncarnationLease)MemberwiseCopy(fixture.Lease);
        Assert.False(copiedLease.IsCurrentOwner(fixture.Owner));
        var forwarding = new CallerInstance(fixture.Owner);
        Assert.False(Observe(forwarding, fixture.Descriptor, out _));
        Assert.False(fixture.Lease.IsCurrentOwner(forwarding));
        var source = new LinuxProcAuthoringResourceMeasurementSource();
        Assert.Throws<AuthoringExtensionContractException>(() => source.Register(copiedOwner, fixture.Lease));
        Assert.Throws<AuthoringExtensionContractException>(() => source.Register(fixture.Owner, copiedLease));
        string json = JsonSerializer.Serialize(fixture.Lease);
        Assert.Throws<NotSupportedException>(() => JsonSerializer.Deserialize<AuthoringRuntimeIncarnationLease>(json));
        Assert.True(fixture.Lease.IsCurrentOwner(fixture.Owner));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_CallerCannotReleaseCustodyOrDeclareAReplacementIssuer(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        object foreignAuthority = new();
        Assert.Throws<AuthoringExtensionContractException>(() => fixture.Lease.Revoke(fixture.Owner, foreignAuthority));
        Assert.Throws<AuthoringExtensionContractException>(() => fixture.Lease.ReleaseCustody(fixture.Owner, foreignAuthority));
        Assert.Throws<AuthoringExtensionContractException>(() => fixture.Lease.ConfirmProcessExited(fixture.Owner, foreignAuthority));
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringRuntimeIncarnationLease.Issue(
            fixture.Owner, fixture.Descriptor, foreignAuthority, fixture.Custody, fixture.Rescue,
            AuthoringRuntimeIncarnationLease.ReadStartTicks(fixture.Rescue.Id), new string('b', 64)));
        Assert.True(fixture.Lease.IsCurrentOwner(fixture.Owner));
        Assert.True(fixture.Lease.CustodyRetained);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledMeasurement_IsPerIncarnationAndNeverAcceptsStringConsumer(bool service)
    {
        object descriptor = CreateDescriptor(service);
        await using var first = ControlledOwner.Create(descriptor);
        await using var second = ControlledOwner.Create(descriptor);
        var source = new LinuxProcAuthoringResourceMeasurementSource();
        source.Register(first.Owner, first.Lease);
        source.RecordBrokeredUsage(first.Owner, first.Lease, 11, 12, 13);
        source.Register(second.Owner, second.Lease);
        AuthoringResourceMeasurement initial = await source.MeasureAsync(BudgetIdentity(first.Lease.RuntimeIdentity), first.Owner, first.Lease, default);
        Assert.Equal((11L, 12L, 13L), (initial.NetworkBytes, initial.FileBytes, initial.StateBytes));
        Assert.True(initial.MemoryBytes > 0);
        source.Register(first.Owner, first.Lease);
        AuthoringResourceMeasurement repeated = await source.MeasureAsync(BudgetIdentity(first.Lease.RuntimeIdentity), first.Owner, first.Lease, default);
        Assert.Equal(11, repeated.NetworkBytes);
        Assert.True(repeated.CpuTime >= initial.CpuTime);
        AuthoringResourceMeasurement next = await source.MeasureAsync(BudgetIdentity(second.Lease.RuntimeIdentity), second.Owner, second.Lease, default);
        Assert.Equal((0L, 0L, 0L), (next.NetworkBytes, next.FileBytes, next.StateBytes));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await source.MeasureAsync(BudgetIdentity(first.Lease.RuntimeIdentity), second.Owner, first.Lease, default));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await source.MeasureAsync(BudgetIdentity(new string('f', 64)), first.Owner, first.Lease, default));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await source.MeasureAsync(BudgetIdentity(first.Lease.RuntimeIdentity), default));
        await first.TerminateAsync();
        Assert.Throws<AuthoringExtensionContractException>(() => source.Register(first.Owner, first.Lease));
        Assert.Throws<AuthoringExtensionContractException>(() => source.RecordBrokeredUsage(first.Owner, first.Lease, 1, 1, 1));
        Assert.True(second.Lease.IsCurrentOwner(second.Owner));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledMeasurement_RejectsCounterRegressionInsteadOfAssumingRestart(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        var source = new LinuxProcAuthoringResourceMeasurementSource();
        source.Register(fixture.Owner, fixture.Lease);
        await source.MeasureAsync(BudgetIdentity(fixture.Lease.RuntimeIdentity), fixture.Owner, fixture.Lease, default);
        object entries = typeof(LinuxProcAuthoringResourceMeasurementSource).GetField("_entries", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(source)!;
        object?[] arguments = [fixture.Lease, null];
        Assert.True((bool)entries.GetType().GetMethod("TryGetValue")!.Invoke(entries, arguments)!);
        object entry = arguments[1]!;
        entry.GetType().GetField("_cpu", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(entry, TimeSpan.MaxValue);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await source.MeasureAsync(BudgetIdentity(fixture.Lease.RuntimeIdentity), fixture.Owner, fixture.Lease, default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_ProcessBirthMismatchPermanentlyRevokesEvenWithSamePid(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        FieldInfo birth = typeof(AuthoringRuntimeIncarnationLease).GetField("_startTicks", BindingFlags.NonPublic | BindingFlags.Instance)!;
        object original = birth.GetValue(fixture.Lease)!;
        birth.SetValue(fixture.Lease, 0UL);
        Assert.False(fixture.Lease.IsCurrentOwner(fixture.Owner));
        birth.SetValue(fixture.Lease, original);
        Assert.False(Observe(fixture.Owner, fixture.Descriptor, out _));
        Assert.True(fixture.Lease.CustodyRetained);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_ExitedInstanceCannotRejoinOrBeRestoredByReplacement(bool service)
    {
        object descriptor = CreateDescriptor(service);
        await using var first = ControlledOwner.Create(descriptor);
        first.Rescue.Kill(true);
        await first.Rescue.WaitForExitAsync();
        Assert.False(Observe(first.Owner, descriptor, out _));
        await using var replacement = ControlledOwner.Create(descriptor);
        Assert.True(replacement.Lease.IsCurrentOwner(replacement.Owner));
        Assert.False(first.Lease.IsCurrentOwner(first.Owner));
        Assert.False(first.Lease.IsCurrentOwner(replacement.Owner));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_TerminateRevokesBeforeWaitingAndReleasesOnlyAfterDisposeSettles(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        var gate = (SemaphoreSlim)fixture.Owner.GetType().GetField("_lifecycleLock", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(fixture.Owner)!;
        await gate.WaitAsync();
        Task termination = fixture.TerminateAsync().AsTask();
        try
        {
            Assert.False(termination.IsCompleted);
            Assert.False(Observe(fixture.Owner, fixture.Descriptor, out _));
            Assert.True(fixture.Lease.CustodyRetained);
            Assert.False(fixture.Rescue.HasExited);
        }
        finally
        {
            gate.Release();
        }
        await termination;
        Assert.True(fixture.Lease.CustodyRetained);
        await fixture.DisposeOwnerAsync();
        Assert.False(fixture.Lease.CustodyRetained);
        await fixture.DisposeOwnerAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_TerminationFailureRevokesButRetainsCustody(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        fixture.Custody.Dispose();
        await Assert.ThrowsAnyAsync<InvalidOperationException>(async () => await fixture.TerminateAsync());
        Assert.False(Observe(fixture.Owner, fixture.Descriptor, out _));
        Assert.True(fixture.Lease.CustodyRetained);
        Assert.False(fixture.Rescue.HasExited);
        await Assert.ThrowsAnyAsync<InvalidOperationException>(async () => await fixture.DisposeOwnerAsync());
        Assert.True(fixture.Lease.CustodyRetained);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_DisposeWaitsForTransportBeforeReleasingCustody(bool service)
    {
        var drain = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service), drain.Task);
        Task disposal = fixture.DisposeOwnerAsync().AsTask();
        try
        {
            await fixture.Rescue.WaitForExitAsync();
            Assert.False(disposal.IsCompleted);
            Assert.False(Observe(fixture.Owner, fixture.Descriptor, out _));
            Assert.True(fixture.Lease.CustodyRetained);
        }
        finally
        {
            drain.TrySetResult();
        }
        await disposal;
        Assert.False(fixture.Lease.CustodyRetained);
        Assert.False(Directory.Exists(fixture.Root));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_DisposeWaitsForInFlightTransportSettlement(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        string field = service ? "_transportLock" : "_messageLock";
        var transport = (SemaphoreSlim)fixture.Owner.GetType().GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(fixture.Owner)!;
        await transport.WaitAsync();
        Task disposal = fixture.DisposeOwnerAsync().AsTask();
        try
        {
            await fixture.Rescue.WaitForExitAsync();
            Assert.False(disposal.IsCompleted);
            Assert.True(fixture.Lease.CustodyRetained);
        }
        finally
        {
            transport.Release();
        }
        await disposal;
        Assert.False(fixture.Lease.CustodyRetained);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_ConcurrentTerminateAndDisposeSettleOnce(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        await Task.WhenAll(fixture.TerminateAsync().AsTask(), fixture.DisposeOwnerAsync().AsTask(), fixture.DisposeOwnerAsync().AsTask());
        Assert.False(fixture.Lease.CustodyRetained);
        Assert.False(Observe(fixture.Owner, fixture.Descriptor, out _));
        Assert.False(Directory.Exists(fixture.Root));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_ResourceTrackerCanReadOnlyOriginalLiveDescriptor(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        if (service)
        {
            var owner = (IAuthoringServiceProcess)fixture.Owner;
            Assert.True(AuthoringRuntimeIncarnationLease.TryObserveService(owner, out var lease));
            Assert.Same(fixture.Lease, lease);
            Assert.Same(fixture.Descriptor, lease.GetServiceDescriptor(owner));
            await fixture.TerminateAsync();
            Assert.False(AuthoringRuntimeIncarnationLease.TryObserveService(owner, out _));
            Assert.Throws<AuthoringExtensionContractException>(() => lease.GetServiceDescriptor(owner));
        }
        else
        {
            var owner = (IAuthoringWorkerSandboxInstance)fixture.Owner;
            Assert.True(AuthoringRuntimeIncarnationLease.TryObserveWorker(owner, out var lease));
            Assert.Same(fixture.Lease, lease);
            Assert.Same(fixture.Descriptor, lease.GetWorkerDescriptor(owner));
            await fixture.TerminateAsync();
            Assert.False(AuthoringRuntimeIncarnationLease.TryObserveWorker(owner, out _));
            Assert.Throws<AuthoringExtensionContractException>(() => lease.GetWorkerDescriptor(owner));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlledOwner_WorkingRootFailureRetainsCustodyUntilSuccessfulRetry(bool service)
    {
        await using var fixture = ControlledOwner.Create(CreateDescriptor(service));
        File.WriteAllText(Path.Combine(fixture.Root, "owned-file"), "owned");
        File.SetUnixFileMode(fixture.Root, UnixFileMode.None);
        try
        {
            await Assert.ThrowsAsync<IOException>(async () => await fixture.DisposeOwnerAsync());
            Assert.True(fixture.Lease.CustodyRetained);
            Assert.False(Observe(fixture.Owner, fixture.Descriptor, out _));
        }
        finally
        {
            File.SetUnixFileMode(fixture.Root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        await fixture.DisposeOwnerAsync();
        Assert.False(fixture.Lease.CustodyRetained);
        Assert.False(Directory.Exists(fixture.Root));
    }

    [Fact]
    public async Task FailedRealProcessReadiness_DoesNotRegisterAnIncarnation()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-incarnation-failed-{Guid.NewGuid():N}");
        try
        {
            var native = new LinuxBubblewrapAuthoringWorkerRuntime(new(
                "/usr/bin/false", "/usr/bin/true", "/usr/lib/x86_64-linux-gnu",
                "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", root, TimeSpan.FromSeconds(5)));
            var ledger = new CountingLedger();
            var runtime = new MeasuredAuthoringWorkerRuntime(native, ledger);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await runtime.StartAsync((AuthoringWorkerLaunchDescriptor)CreateDescriptor(false), default));
            Assert.Equal(0, ledger.Registrations);
            Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, true);
            }
        }
    }

    [Fact]
    public async Task FailedRealServiceReadiness_DoesNotRegisterAnIncarnation()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-incarnation-service-failed-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(root);
            string source = Path.Combine(BackendTestPaths.RepositoryRoot, "tests/backend/Fixtures/AuthoringExtensions/echo-service.c");
            string output = Path.Combine(root, "echo-service");
            var start = new ProcessStartInfo("/usr/bin/cc") { UseShellExecute = false };
            foreach (string argument in new[] { "-static", "-O2", "-o", output, source })
            {
                start.ArgumentList.Add(argument);
            }
            using Process compiler = Process.Start(start)!;
            await compiler.WaitForExitAsync();
            Assert.Equal(0, compiler.ExitCode);
            byte[] bytes = await File.ReadAllBytesAsync(output);
            var descriptor = (AuthoringServiceLaunchDescriptor)CreateDescriptor(true);
            descriptor = descriptor with
            {
                ExecutableBytes = [.. bytes],
                ExecutableSha256 = Digest(bytes)
            };
            string instances = Path.Combine(root, "instances");
            var native = new LinuxBubblewrapAuthoringServiceRuntime(new("/usr/bin/false", "/usr/bin/bwrap", instances, TimeSpan.FromSeconds(5)));
            var ledger = new CountingLedger();
            var runtime = new MeasuredAuthoringServiceRuntime(native, ledger);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await runtime.StartAsync(descriptor, default));
            Assert.Equal(0, ledger.Registrations);
            Assert.Empty(Directory.EnumerateFileSystemEntries(instances));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, true);
            }
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [Trait("Category", "NativeSandbox")]
    public async Task NativeRuntime_TwoRealStartsIssueDistinctNonTransferableCapabilities(bool service)
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-incarnation-native-{Guid.NewGuid():N}");
        try
        {
            if (service)
            {
                string source = Path.Combine(BackendTestPaths.RepositoryRoot, "tests/backend/Fixtures/AuthoringExtensions/echo-service.c");
                Directory.CreateDirectory(root);
                string output = Path.Combine(root, "echo-service");
                var start = new ProcessStartInfo("/usr/bin/cc") { UseShellExecute = false };
                foreach (string argument in new[] { "-static", "-O2", "-o", output, source })
                {
                    start.ArgumentList.Add(argument);
                }
                using Process compiler = Process.Start(start)!;
                await compiler.WaitForExitAsync();
                Assert.Equal(0, compiler.ExitCode);
                byte[] bytes = await File.ReadAllBytesAsync(output);
                var descriptor = (AuthoringServiceLaunchDescriptor)CreateDescriptor(true);
                descriptor = descriptor with
                {
                    ExecutableBytes = [.. bytes],
                    ExecutableSha256 = Digest(bytes)
                };
                var runtime = new LinuxBubblewrapAuthoringServiceRuntime(new("/usr/bin/prlimit", "/usr/bin/bwrap", Path.Combine(root, "instances"), TimeSpan.FromSeconds(5)));
                await using IAuthoringServiceProcess first = await runtime.StartAsync(descriptor, default);
                await using IAuthoringServiceProcess second = await runtime.StartAsync(descriptor, default);
                Assert.True(AuthoringRuntimeIncarnationLease.TryObserveService(first, descriptor, out var one));
                Assert.True(AuthoringRuntimeIncarnationLease.TryObserveService(second, descriptor, out var two));
                Assert.NotSame(one, two);
                Assert.False(AuthoringRuntimeIncarnationLease.TryObserveService(first, descriptor with
                {
                }, out _));
                Assert.False(one.IsCurrentOwner(second));
                await first.TerminateTreeAsync("native-test", default);
                Assert.False(AuthoringRuntimeIncarnationLease.TryObserveService(first, descriptor, out _));
                Assert.True(two.IsCurrentOwner(second));
            }
            else
            {
                var descriptor = (AuthoringWorkerLaunchDescriptor)CreateDescriptor(false);
                var runtime = new LinuxBubblewrapAuthoringWorkerRuntime(new("/usr/bin/bwrap", "/usr/local/bin/node", "/usr/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", root, TimeSpan.FromSeconds(5)));
                await using IAuthoringWorkerSandboxInstance first = await runtime.StartAsync(descriptor, default);
                await using IAuthoringWorkerSandboxInstance second = await runtime.StartAsync(descriptor, default);
                Assert.True(AuthoringRuntimeIncarnationLease.TryObserveWorker(first, descriptor, out var one));
                Assert.True(AuthoringRuntimeIncarnationLease.TryObserveWorker(second, descriptor, out var two));
                Assert.NotSame(one, two);
                Assert.False(AuthoringRuntimeIncarnationLease.TryObserveWorker(first, descriptor with
                {
                }, out _));
                Assert.False(one.IsCurrentOwner(second));
                await first.TerminateAsync("native-test", default);
                Assert.False(AuthoringRuntimeIncarnationLease.TryObserveWorker(first, descriptor, out _));
                Assert.True(two.IsCurrentOwner(second));
            }
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, true);
            }
        }
    }

    private static object CreateDescriptor(bool service)
    {
        byte[] module = Convert.FromHexString(EchoWasmHex);
        return service
            ? new AuthoringServiceLaunchDescriptor(new string('a', 64), "acme.author-tools", "1.0.0", new string('c', 64), new string('d', 64), "acme.command.format", Digest(module), [.. module], [], Digest([]), "authoring-service-transport/v1", 67_108_864, 1024, 1024, TimeSpan.FromSeconds(5))
            : new AuthoringWorkerLaunchDescriptor(new string('a', 64), new string('9', 64), "acme.author-tools", "1.0.0", new string('c', 64), new string('d', 64), "acme.command.format", Digest(module), new string('e', 64), new string('f', 64), new string('0', 64), [.. module], 131_072, 1024, 1024);
    }

    private static string Digest(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static AuthoringBudgetIdentity BudgetIdentity(string runtimeIdentity) =>
        new(runtimeIdentity, "acme.author-tools", "1.0.0", new string('c', 64), "acme.command.format", "document-1", "request-1", 1, new string('0', 64));

    private static bool Observe(object owner, object descriptor, out AuthoringRuntimeIncarnationLease? lease) =>
        descriptor is AuthoringWorkerLaunchDescriptor worker
            ? AuthoringRuntimeIncarnationLease.TryObserveWorker((IAuthoringWorkerSandboxInstance)owner, worker, out lease)
            : AuthoringRuntimeIncarnationLease.TryObserveService((IAuthoringServiceProcess)owner, (AuthoringServiceLaunchDescriptor)descriptor, out lease);

    private static object MemberwiseCopy(object value) =>
        typeof(object).GetMethod("MemberwiseClone", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(value, null)!;

    private sealed class ControlledOwner : IAsyncDisposable
    {
        private ControlledOwner(object descriptor, Process custody, Process rescue, object owner, string root)
        {
            Descriptor = descriptor;
            Custody = custody;
            Rescue = rescue;
            Owner = owner;
            Root = root;
            owner.GetType().GetMethod("IssueIncarnation")!.Invoke(owner, null);
            Assert.True(Observe(owner, descriptor, out var lease));
            Lease = lease!;
        }

        public object Descriptor
        {
            get;
        }
        public Process Custody
        {
            get;
        }
        public Process Rescue
        {
            get;
        }
        public object Owner
        {
            get;
        }
        public string Root
        {
            get;
        }
        public AuthoringRuntimeIncarnationLease Lease
        {
            get;
        }

        public static ControlledOwner Create(object descriptor, Task? drain = null)
        {
            string root = Path.Combine(Path.GetTempPath(), $"fsusblog-incarnation-controlled-{Guid.NewGuid():N}");
            Directory.CreateDirectory(root);
            Process custody = Process.Start(new ProcessStartInfo("/usr/bin/sleep", "60") { UseShellExecute = false })!;
            Process rescue = Process.GetProcessById(custody.Id);
            bool service = descriptor is AuthoringServiceLaunchDescriptor;
            Type runtime = service ? typeof(LinuxBubblewrapAuthoringServiceRuntime) : typeof(LinuxBubblewrapAuthoringWorkerRuntime);
            Type ownerType = runtime.GetNestedType(service ? "LinuxBubblewrapServiceProcess" : "LinuxBubblewrapWorkerInstance", BindingFlags.NonPublic)!;
            Process sandbox = Process.GetProcessById(custody.Id);
            ulong birth = AuthoringRuntimeIncarnationLease.ReadStartTicks(custody.Id);
            object[] arguments = service
                ? [custody, custody.Id, sandbox, birth, root, descriptor, new AuthoringServiceHealthReport(true, new string('a', 64), new string('b', 64), "authoring-service-transport/v1"), new AuthoringProcessOwnershipReport(AuthoringProcessOwnershipMechanism.PosixProcessGroup, true, true, new string('b', 64)), drain ?? Task.CompletedTask]
                : [custody, custody.Id, sandbox, birth, root, descriptor, new AuthoringWorkerCapabilityReport(false, false, false, false, false, false, false, false, [], [], true, new string('b', 64)), new JsonSerializerOptions(), drain ?? Task.CompletedTask];
            object owner = Activator.CreateInstance(ownerType, arguments)!;
            return new ControlledOwner(descriptor, custody, rescue, owner, root);
        }

        public ValueTask TerminateAsync() => Owner is IAuthoringWorkerSandboxInstance worker
            ? worker.TerminateAsync("controlled-test", default)
            : ((IAuthoringServiceProcess)Owner).TerminateTreeAsync("controlled-test", default);

        public ValueTask DisposeOwnerAsync() => ((IAsyncDisposable)Owner).DisposeAsync();

        public async ValueTask DisposeAsync()
        {
            if (!Rescue.HasExited)
            {
                Rescue.Kill(true);
                await Rescue.WaitForExitAsync();
            }
            try
            {
                await DisposeOwnerAsync();
            }
            catch (InvalidOperationException)
            {
                // A deliberately disposed custody handle cannot be repaired by the unit fixture.
            }
            finally
            {
                Rescue.Dispose();
                Custody.Dispose();
                if (Directory.Exists(Root))
                {
                    Directory.Delete(Root, true);
                }
            }
        }
    }

    private sealed class CountingLedger : IAuthoringRuntimeResourceLedger
    {
        public int Registrations
        {
            get; private set;
        }
        public void Register(object owner, AuthoringRuntimeIncarnationLease incarnation) => Registrations++;
        public void Register(string runtimeIdentity, int processId) => throw new NotSupportedException();
        public void Unregister(string runtimeIdentity, int processId) => throw new NotSupportedException();
        public void RecordRestart(string runtimeIdentity) => throw new NotSupportedException();
        public void RecordBrokeredUsage(string runtimeIdentity, long networkBytes, long fileBytes, long stateBytes) => throw new NotSupportedException();
    }

    private sealed class CallerInstance(object? inner = null) : IAuthoringWorkerSandboxInstance, IAuthoringServiceProcess, IAuthoringMeasuredRuntimeInstance
    {
        public string RuntimeIdentity => inner is IAuthoringMeasuredRuntimeInstance measured ? measured.RuntimeIdentity : new('a', 64);
        public int ProcessId => inner is IAuthoringMeasuredRuntimeInstance measured ? measured.ProcessId : Environment.ProcessId;
        public AuthoringWorkerCapabilityReport CapabilityReport => new(false, false, false, false, false, false, false, false, [], [], true, new string('b', 64));
        public AuthoringProcessOwnershipReport Ownership => new(AuthoringProcessOwnershipMechanism.PosixProcessGroup, true, true, new string('b', 64));
        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(AuthoringWorkerRequest request, CancellationToken cancellationToken) =>
            inner is IAuthoringWorkerSandboxInstance worker ? worker.ExecuteAsync(request, cancellationToken) : throw new NotSupportedException();
        public ValueTask<AuthoringServiceResponse> ExecuteAsync(AuthoringServiceRequest request, CancellationToken cancellationToken) =>
            inner is IAuthoringServiceProcess service ? service.ExecuteAsync(request, cancellationToken) : throw new NotSupportedException();
        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken) => throw new NotSupportedException();
        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
