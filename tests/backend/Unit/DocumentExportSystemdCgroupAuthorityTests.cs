using System.Diagnostics;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using System.Text;

using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Tests.Helpers;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportSystemdCgroupAuthorityTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"fsusblog-document-export-authority-{Guid.NewGuid():N}");

    [Fact]
    public void ParsesExactSystemdPropertiesAndRejectsMissingUnknownOrDuplicateFields()
    {
        IReadOnlyDictionary<string, string> properties =
            DocumentExportSystemdCgroupAuthority.ParseProperties(
                "LoadState=loaded\nActiveState=active\nControlGroup=/unit\n",
                ["LoadState", "ActiveState", "ControlGroup"]);

        Assert.Equal("loaded", properties["LoadState"]);
        Assert.Equal("active", properties["ActiveState"]);
        Assert.Equal("/unit", properties["ControlGroup"]);
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseProperties(
                "LoadState=loaded\n",
                ["LoadState", "ActiveState"]));
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseProperties(
                "LoadState=loaded\nUnknown=value\n",
                ["LoadState"]));
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseProperties(
                "LoadState=loaded\nLoadState=loaded\n",
                ["LoadState"]));
    }

    [Fact]
    public void ParsesCgroupCountersWithoutSynthesizingMissingMalformedOrDuplicateValues()
    {
        Directory.CreateDirectory(_root);
        string path = Path.Combine(_root, "cpu.stat");
        File.WriteAllText(path, "usage_usec 42000\nuser_usec 31000\nsystem_usec 11000\n", Encoding.ASCII);

        IReadOnlyDictionary<string, long> counters =
            DocumentExportSystemdCgroupAuthority.ParseCounterFile(path);

        Assert.Equal(42000, counters["usage_usec"]);
        Assert.Equal(31000, counters["user_usec"]);
        Assert.Equal(11000, counters["system_usec"]);
        File.WriteAllText(path, "usage_usec -1\n", Encoding.ASCII);
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseCounterFile(path));
        File.WriteAllText(path, "usage_usec 1\nusage_usec 2\n", Encoding.ASCII);
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseCounterFile(path));
        File.WriteAllText(path, "usage_usec\n", Encoding.ASCII);
        Assert.Throws<InvalidDataException>(() =>
            DocumentExportSystemdCgroupAuthority.ParseCounterFile(path));
    }

    [Fact]
    public void RejectsMissingOrNonBinaryCgroupPopulationState()
    {
        Assert.False(DocumentExportSystemdCgroupAuthority.ParsePopulated(
            new Dictionary<string, long>(StringComparer.Ordinal)
            {
                ["populated"] = 0
            }));
        Assert.True(DocumentExportSystemdCgroupAuthority.ParsePopulated(
            new Dictionary<string, long>(StringComparer.Ordinal)
            {
                ["populated"] = 1
            }));
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ParsePopulated(
            new Dictionary<string, long>(StringComparer.Ordinal)));
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ParsePopulated(
            new Dictionary<string, long>(StringComparer.Ordinal)
            {
                ["populated"] = 2
            }));
    }

    [Fact]
    public void ParsesRealSystemctlDurationFormatAndRejectsNonCanonicalValues()
    {
        Assert.Equal(
            20_000_000,
            DocumentExportSystemdCgroupAuthority.ParseSystemdDurationMicroseconds("20s", "RuntimeMaxUSec"));
        Assert.Equal(
            90_000_000,
            DocumentExportSystemdCgroupAuthority.ParseSystemdDurationMicroseconds("1min 30s", "RuntimeMaxUSec"));
        Assert.Equal(
            1_001,
            DocumentExportSystemdCgroupAuthority.ParseSystemdDurationMicroseconds("1ms 1us", "RuntimeMaxUSec"));

        foreach (string invalid in new[]
        {
            "infinity",
            "-1s",
            "1fortnight",
            "1.0000001ms",
            "1s 1min",
            "1s 1s",
            "0s"
        })
        {
            Assert.Throws<InvalidDataException>(() =>
                DocumentExportSystemdCgroupAuthority.ParseSystemdDurationMicroseconds(
                    invalid,
                    "RuntimeMaxUSec"));
        }
    }

    [Fact]
    public void OnlyMissingCgroupPathsCanEnterTerminalSnapshotHandling()
    {
        Assert.True(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new FileNotFoundException()));
        Assert.True(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new DirectoryNotFoundException()));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new IOException("unqualified cgroup read")));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new UnauthorizedAccessException()));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsMissingCgroupException(
            new InvalidDataException("malformed cgroup counters")));
    }

    [Fact]
    public void AdmissionRetryRequiresAQualifiedCgroupRetirementRace()
    {
        Assert.True(DocumentExportSystemdCgroupAuthority.IsAdmissionSnapshotRaceCandidate(
            new FileNotFoundException()));
        Assert.True(DocumentExportSystemdCgroupAuthority.IsAdmissionSnapshotRaceCandidate(
            new IOException("cgroup retired during accounting read")));
        Assert.True(DocumentExportSystemdCgroupAuthority.IsAdmissionSnapshotRaceCandidate(
            new PlatformNotSupportedException("delegated files retired with the cgroup")));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsAdmissionSnapshotRaceCandidate(
            new UnauthorizedAccessException("cgroup accounting is not readable")));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsAdmissionSnapshotRaceCandidate(
            new InvalidDataException("malformed live accounting")));
    }

    [Fact]
    public void RejectsFloatingAuthorityPathsInvalidDigestsAndUnboundedPolling()
    {
        DocumentExportSystemdCgroupAuthorityContract installed =
            DocumentExportSystemdCgroupAuthority.DiscoverInstalledContract();

        Assert.Throws<InvalidDataException>(() => new DocumentExportSystemdCgroupAuthority(
            installed with
            {
                SystemdRunPath = "systemd-run"
            }));
        Assert.Throws<ArgumentException>(() => new DocumentExportSystemdCgroupAuthority(
            installed with
            {
                BubblewrapDigest = "latest"
            }));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new DocumentExportSystemdCgroupAuthority(installed, 0));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new DocumentExportSystemdCgroupAuthority(installed, 1001));
    }

    [Fact]
    public async Task RejectsClosedWorkloadDriftBeforeAnyTransientServiceCanStart()
    {
        DocumentExportSystemdCgroupAuthority authority = new(
            DocumentExportSystemdCgroupAuthority.DiscoverInstalledContract());
        Directory.CreateDirectory(_root);
        var workload = new ProcessStartInfo("/usr/bin/true")
        {
            WorkingDirectory = _root,
            UseShellExecute = false
        };
        workload.ArgumentList.Add("--version");

        await Assert.ThrowsAsync<InvalidDataException>(() => authority.StartAsync(
            new string('a', 32),
            workload,
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets,
            Path.Combine(_root, "stdout.log"),
            Path.Combine(_root, "stderr.log"),
            CancellationToken.None));
    }

    [Fact]
    public async Task RejectsDigestOrVersionDriftBeforeTheBusinessUnitAdmissionCall()
    {
        DocumentExportSystemdCgroupAuthorityContract installed =
            DocumentExportSystemdCgroupAuthority.DiscoverInstalledContract();
        Directory.CreateDirectory(_root);
        ProcessStartInfo workload = ClosedBubblewrapProbe();
        DocumentExportResourceBudgets budgets =
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets;

        DocumentExportSystemdCgroupAuthority digestDrift = new(installed with
        {
            SystemdRunDigest = DocumentExportTestToolFixture.Digest("tampered-systemd-run")
        });
        await Assert.ThrowsAsync<InvalidDataException>(() => digestDrift.StartAsync(
            new string('b', 32),
            workload,
            budgets,
            Path.Combine(_root, "digest-stdout.log"),
            Path.Combine(_root, "digest-stderr.log"),
            CancellationToken.None));

        DocumentExportSystemdCgroupAuthority versionDrift = new(installed with
        {
            BubblewrapVersion = "bwrap unavailable-version"
        });
        await Assert.ThrowsAsync<InvalidDataException>(() => versionDrift.StartAsync(
            new string('c', 32),
            ClosedBubblewrapProbe(),
            budgets,
            Path.Combine(_root, "version-stdout.log"),
            Path.Combine(_root, "version-stderr.log"),
            CancellationToken.None));
    }

    [Fact]
    public async Task StaticContractUsesServicePreStartLimitsAndNeverMisstatesCpuQuotaAsTotalCpu()
    {
        string compiled = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(typeof(DocumentExportSystemdCgroupAuthority)),
            RuntimeMetadataInspection.DescribeConstructors(typeof(DocumentExportSystemdCgroupAuthority)));

        Assert.Contains("--service-type=exec", compiled, StringComparison.Ordinal);
        Assert.Contains("--no-block", compiled, StringComparison.Ordinal);
        Assert.Contains("MemoryMax=", compiled, StringComparison.Ordinal);
        Assert.Contains("MemorySwapMax=0", compiled, StringComparison.Ordinal);
        Assert.Contains("TasksMax=", compiled, StringComparison.Ordinal);
        Assert.Contains("RuntimeMaxSec=", compiled, StringComparison.Ordinal);
        Assert.Contains("KillMode=control-group", compiled, StringComparison.Ordinal);
        Assert.Contains("cgroup.kill", compiled, StringComparison.Ordinal);
        Assert.Contains("cgroup.events", compiled, StringComparison.Ordinal);
        Assert.Contains("usage_usec.sampled-kill", compiled, StringComparison.Ordinal);
        Type authorityType = typeof(DocumentExportSystemdCgroupAuthority);
        MethodInfo processOwner = RequireDeclaredMethod(authorityType, "StartClosedProcess");
        AssertProcessStartOwner(authorityType, processOwner);
        MethodInfo runControlMethod = RequireDeclaredMethod(authorityType, "RunControlAsync");
        Type controlStateMachine = Assert.IsAssignableFrom<AsyncStateMachineAttribute>(
            runControlMethod.GetCustomAttribute<AsyncStateMachineAttribute>()).StateMachineType;
        MethodInfo controlBody = RequireDeclaredMethod(controlStateMachine, "MoveNext");
        MethodInfo versionBody = RequireDeclaredMethod(authorityType, "ReadVersion");
        MethodInfo shellSetter = Assert.IsAssignableFrom<MethodInfo>(
            typeof(ProcessStartInfo).GetProperty(nameof(ProcessStartInfo.UseShellExecute))?.SetMethod);
        Assert.Equal(2, EnumerateDeclaredBodies(authorityType)
            .Sum(method => ReadInstructions(method).Count(instruction => IsCallTo(instruction, shellSetter))));
        AssertClosedShellAssignment(controlBody);
        AssertClosedShellAssignment(versionBody);
        Assert.Equal(1, compiled.Split("System.Diagnostics.Process.Start", StringSplitOptions.None).Length - 1);
        Assert.Equal(2, compiled.Split("System.Diagnostics.ProcessStartInfo.set_UseShellExecute", StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("/bin/sh", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Environment.GetEnvironment", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("CPUQuota", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("cpu.max", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("--scope", compiled, StringComparison.Ordinal);

        DocumentExportSystemdCgroupAuthorityContract contract =
            DocumentExportSystemdCgroupAuthority.DiscoverInstalledContract();
        var authority = new DocumentExportSystemdCgroupAuthority(contract);
        MethodInfo runControl = Assert.IsAssignableFrom<MethodInfo>(typeof(DocumentExportSystemdCgroupAuthority).GetMethod(
            "RunControlAsync", BindingFlags.Instance | BindingFlags.NonPublic));
        Task command = Assert.IsAssignableFrom<Task>(runControl.Invoke(authority,
            ["/bin/true", Array.Empty<string>(), CancellationToken.None]));
        await command;
        object result = Assert.IsAssignableFrom<object>(command.GetType().GetProperty("Result")?.GetValue(command));
        int exitCode = Assert.IsType<int>(result.GetType().GetProperty("ExitCode")?.GetValue(result));
        Assert.Equal(0, exitCode);
    }

    [Fact]
    public void ProcessStartEvidenceRejectsLiteralDecoysAndUncalledNestedStarts()
    {
        Type literalType = typeof(LiteralProcessFixture);
        string literalFacts = RuntimeMetadataInspection.DescribeType(literalType);
        Assert.Equal(1, literalFacts.Split("System.Diagnostics.Process.Start", StringSplitOptions.None).Length - 1);
        Assert.Empty(ProcessStartCalls(literalType));
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() =>
            AssertProcessStartOwner(literalType, RequireDeclaredMethod(literalType, "StartClosedProcess")));

        Type nestedType = typeof(NestedProcessFixture);
        Assert.Equal(2, ProcessStartCalls(nestedType).Count);
        MethodInfo nestedStart = RequireDeclaredMethod(typeof(NestedProcessFixture.Uncalled), "Start");
        Assert.Contains(ProcessStartCalls(nestedType), call => call.Owner == nestedStart);
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() =>
            AssertProcessStartOwner(nestedType, RequireDeclaredMethod(nestedType, "StartClosedProcess")));
    }

    [Fact]
    public void ProcessStartEvidenceAcceptsActualOwnerWithBenignLiteralDecoys()
    {
        Type type = typeof(BenignProcessFixture);
        Assert.Single(ProcessStartCalls(type));
        Assert.Contains("System.Diagnostics.Process.Start", RuntimeMetadataInspection.DescribeType(type), StringComparison.Ordinal);
        AssertProcessStartOwner(type, RequireDeclaredMethod(type, "StartClosedProcess"));
    }

    [Fact]
    public void ClosedShellEvidenceRejectsTrueAndLiteralOnlyAssignments()
    {
        MethodInfo open = RequireDeclaredMethod(typeof(ShellAssignmentFixture), "Open");
        IReadOnlyList<Instruction> openInstructions = ReadInstructions(open);
        int openSetter = Assert.Single(Enumerable.Range(0, openInstructions.Count),
            index => openInstructions[index].Member?.DeclaringType == typeof(ProcessStartInfo)
                && openInstructions[index].Member?.Name == "set_UseShellExecute");
        Assert.True(openSetter > 0);
        Assert.Equal(OpCodes.Ldc_I4_1, openInstructions[openSetter - 1].OpCode);
        Assert.Single(RuntimeMetadataInspection.FindMethodsCallingMember(
            typeof(ShellAssignmentFixture),
            member => member.DeclaringType == typeof(ProcessStartInfo)
                && member.Name == "set_UseShellExecute"));
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertClosedShellAssignment(open));

        MethodInfo literal = RequireDeclaredMethod(typeof(ShellAssignmentFixture), "Literal");
        Assert.Contains("System.Diagnostics.ProcessStartInfo.set_UseShellExecute",
            RuntimeMetadataInspection.DescribeMethods(typeof(ShellAssignmentFixture), "Literal"), StringComparison.Ordinal);
        Assert.DoesNotContain(ReadInstructions(literal), instruction => instruction.Member?.DeclaringType == typeof(ProcessStartInfo));
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertClosedShellAssignment(literal));

        MethodInfo closed = RequireDeclaredMethod(typeof(BenignProcessFixture), "Closed");
        AssertClosedShellAssignment(closed);
    }

    [Fact]
    public void RefusalEvidenceIncludesUncalledNestedMethodBodies()
    {
        Type type = typeof(NestedRefusalFixture);
        string previous = RuntimeMetadataInspection.DescribeType(type);
        MethodInfo nested = RequireDeclaredMethod(typeof(NestedRefusalFixture.Uncalled), "Read");
        Assert.Contains(ReadInstructions(nested), instruction => instruction.Member?.DeclaringType == typeof(Environment)
            && instruction.Member.Name == nameof(Environment.GetEnvironmentVariable));
        string compiled = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(type);
        foreach (string forbidden in new[] { "/bin/sh", "System.Environment.GetEnvironment", "CPUQuota", "cpu.max", "--scope" })
        {
            Assert.DoesNotContain(forbidden, previous, StringComparison.Ordinal);
            Assert.Contains(forbidden, compiled, StringComparison.Ordinal);
            Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => Assert.DoesNotContain(forbidden, compiled, StringComparison.Ordinal));
        }
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private ProcessStartInfo ClosedBubblewrapProbe()
    {
        var workload = new ProcessStartInfo("/usr/bin/bwrap")
        {
            WorkingDirectory = _root,
            UseShellExecute = false
        };
        workload.ArgumentList.Add("--version");
        return workload;
    }

    private const BindingFlags DeclaredMembers = BindingFlags.Instance | BindingFlags.Static
        | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

    private static MethodInfo RequireDeclaredMethod(Type type, string name)
        => Assert.IsAssignableFrom<MethodInfo>(type.GetMethod(name, DeclaredMembers));

    private static IEnumerable<MethodBase> EnumerateDeclaredBodies(Type type)
    {
        foreach (MethodBase method in type.GetMethods(DeclaredMembers).Cast<MethodBase>()
                     .Concat(type.GetConstructors(DeclaredMembers)))
        {
            yield return method;
        }
        if (type.TypeInitializer is { } initializer)
        {
            yield return initializer;
        }
        foreach (Type nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (MethodBase method in EnumerateDeclaredBodies(nested))
            {
                yield return method;
            }
        }
    }

    private static IReadOnlyList<(MethodBase Owner, MethodBase Target)> ProcessStartCalls(Type type)
        => EnumerateDeclaredBodies(type)
            .SelectMany(method => ReadInstructions(method)
                .Where(instruction => (instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt)
                    && instruction.Member?.DeclaringType == typeof(Process)
                    && instruction.Member.Name == nameof(Process.Start))
                .Select(instruction => (method, instruction.Member!)))
            .ToArray();

    private static void AssertProcessStartOwner(Type type, MethodInfo expectedOwner)
    {
        (MethodBase owner, MethodBase target) = Assert.Single(ProcessStartCalls(type));
        Assert.Equal(expectedOwner, owner);
        Assert.Equal(typeof(Process).GetMethod(nameof(Process.Start), [typeof(ProcessStartInfo)]), target);
    }

    private static bool IsCallTo(Instruction instruction, MethodInfo target)
        => (instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt)
            && instruction.Member == target;

    private static void AssertClosedShellAssignment(MethodInfo method)
    {
        MethodInfo setter = Assert.IsAssignableFrom<MethodInfo>(
            typeof(ProcessStartInfo).GetProperty(nameof(ProcessStartInfo.UseShellExecute))?.SetMethod);
        IReadOnlyList<Instruction> instructions = ReadInstructions(method);
        int index = Assert.Single(Enumerable.Range(0, instructions.Count),
            index => IsCallTo(instructions[index], setter));
        Assert.True(index > 0);
        // This binds the fixed literal at this callsite, not control-flow or general dataflow.
        Assert.Equal(OpCodes.Ldc_I4_0, instructions[index - 1].OpCode);
    }

    private static IReadOnlyList<Instruction> ReadInstructions(MethodBase method)
    {
        byte[]? il = method.GetMethodBody()?.GetILAsByteArray();
        if (il is null)
        {
            return [];
        }
        IReadOnlyDictionary<ushort, OpCode> opCodes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.FieldType == typeof(OpCode))
            .Select(field => (OpCode)field.GetValue(null)!)
            .GroupBy(opCode => unchecked((ushort)opCode.Value))
            .ToDictionary(group => group.Key, group => group.First());
        var instructions = new List<Instruction>();
        for (int offset = 0; offset < il.Length;)
        {
            ushort value = il[offset++];
            if (value == 0xfe)
            {
                Assert.True(offset < il.Length);
                value = (ushort)(0xfe00 | il[offset++]);
            }
            Assert.True(opCodes.TryGetValue(value, out OpCode opCode));
            if (opCode.OperandType == OperandType.InlineSwitch)
            {
                Assert.True(offset + 4 <= il.Length);
            }
            int size = opCode.OperandType switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI or OperandType.InlineMethod
                    or OperandType.InlineSig or OperandType.InlineString or OperandType.InlineTok or OperandType.InlineType
                    or OperandType.ShortInlineR => 4,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch => checked(4 + BitConverter.ToInt32(il, offset) * 4),
                _ => -1
            };
            Assert.True(size >= 0 && offset + size <= il.Length);
            MethodBase? member = opCode.OperandType == OperandType.InlineMethod
                ? method.Module.ResolveMethod(BitConverter.ToInt32(il, offset),
                    method.DeclaringType?.IsGenericType == true ? method.DeclaringType.GetGenericArguments() : Type.EmptyTypes,
                    method.IsGenericMethod ? method.GetGenericArguments() : Type.EmptyTypes)
                : null;
            instructions.Add(new Instruction(opCode, member));
            offset += size;
        }
        return instructions;
    }

    private sealed record Instruction(OpCode OpCode, MethodBase? Member);

    private static class LiteralProcessFixture
    {
        public static string StartClosedProcess() => "System.Diagnostics.Process.Start";
    }

    private static class NestedProcessFixture
    {
        public static Process? StartClosedProcess(ProcessStartInfo startInfo) => Process.Start(startInfo);

        public static class Uncalled
        {
            public static Process? Start(ProcessStartInfo startInfo) => Process.Start(startInfo);
        }
    }

    private static class BenignProcessFixture
    {
        public static Process? StartClosedProcess(ProcessStartInfo startInfo)
        {
            GC.KeepAlive("System.Diagnostics.Process.Start");
            return Process.Start(startInfo);
        }

        public static ProcessStartInfo Closed() => new()
        {
            UseShellExecute = false
        };
    }

    private static class ShellAssignmentFixture
    {
        public static ProcessStartInfo Open() => new()
        {
            UseShellExecute = true
        };

        public static string Literal() => "System.Diagnostics.ProcessStartInfo.set_UseShellExecute";
    }

    private static class NestedRefusalFixture
    {
        public static string Benign() => "benign";

        public static class Uncalled
        {
            public static string Read()
            {
                GC.KeepAlive("CPUQuota cpu.max --scope");
                return Environment.GetEnvironmentVariable("PATH") ?? "/bin/sh";
            }
        }
    }
}
