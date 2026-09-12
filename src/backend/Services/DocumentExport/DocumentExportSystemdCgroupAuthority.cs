using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.DocumentExport;

public sealed record DocumentExportSystemdCgroupAuthorityContract(
    string SystemdRunPath,
    string SystemdRunVersion,
    string SystemdRunDigest,
    string SystemctlPath,
    string SystemctlVersion,
    string SystemctlDigest,
    string BubblewrapPath,
    string BubblewrapVersion,
    string BubblewrapDigest);

public sealed record DocumentExportCgroupObservation(
    long CpuUsageMicroseconds,
    long MemoryCurrentBytes,
    long MemoryPeakBytes,
    long MemoryMaxEvents,
    long MemoryOomEvents,
    int PidsCurrent,
    int PidsPeak,
    long PidsMaxEvents,
    bool Populated);

public sealed record DocumentExportCgroupCompletion(
    string Result,
    string ExitKind,
    int ExitCode,
    int TerminationSignal);

public sealed record DocumentExportCgroupCleanup(
    bool FinalPopulated,
    bool UnitRemoved,
    bool CgroupRemoved);

public sealed class DocumentExportCgroupAdmissionCleanupException : Exception
{
    public DocumentExportCgroupAdmissionCleanupException(Exception innerException)
        : base(
            "Document export transient service admission failed and its cleanup could not be qualified.",
            innerException)
    {
    }
}

/// <summary>
/// Owns one document-export process tree through a user transient service. systemd
/// creates the cgroup and applies its hard memory/pids and wall-time properties
/// before ExecStart. CPU is intentionally different: cgroup v2 exposes cumulative
/// descendant usage but no total-CPU hard limit, so the host samples cpu.stat and
/// kills the cgroup after observing an overrun. Receipts must retain that overshoot.
/// </summary>
public sealed class DocumentExportSystemdCgroupAuthority
{
    public const string AuthorityKind = "systemd-user-transient-service-cgroup-v2";
    public const string CpuAccountingSource = "cgroup-v2.cpu.stat.usage_usec.sampled-kill";
    public const string MemoryAccountingSource = "cgroup-v2.memory.max-memory.peak-memory.events";
    public const string ProcessAccountingSource = "cgroup-v2.pids.max-pids.peak-pids.events";
    public const string CleanupSource = "cgroup-v2.cgroup.kill-cgroup.events.populated";
    public const int BrokerProcessOverhead = 1;

    private const string RequiredSystemdRunPath = "/usr/bin/systemd-run";
    private const string RequiredSystemctlPath = "/usr/bin/systemctl";
    private const string RequiredBubblewrapPath = "/usr/bin/bwrap";
    private const string CgroupRoot = "/sys/fs/cgroup";
    private const string DocumentExportSlice = "app.slice";
    private const int ControlOutputLimitBytes = 128 * 1024;
    private readonly IReadOnlyDictionary<string, string> _controlEnvironment;

    public DocumentExportSystemdCgroupAuthority(
        DocumentExportSystemdCgroupAuthorityContract contract,
        int cpuPollIntervalMilliseconds = 10)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("Document export systemd cgroup authority requires Linux.");
        }
        ArgumentNullException.ThrowIfNull(contract);
        if (cpuPollIntervalMilliseconds is < 1 or > 1000)
        {
            throw new ArgumentOutOfRangeException(
                nameof(cpuPollIntervalMilliseconds),
                "Document export CPU polling must be between 1 and 1000 milliseconds.");
        }

        ValidateContractShape(contract);
        Contract = contract;
        CpuPollIntervalMilliseconds = cpuPollIntervalMilliseconds;
        IdentityDigest = DocumentExportDigest.Compute(contract);
        _controlEnvironment = ResolveControlEnvironment();
        ControlEnvironmentDigest = DocumentExportDigest.Compute(_controlEnvironment);
    }

    public DocumentExportSystemdCgroupAuthorityContract Contract
    {
        get;
    }

    public int CpuPollIntervalMilliseconds
    {
        get;
    }

    public string IdentityDigest
    {
        get;
    }

    public string ControlEnvironmentDigest
    {
        get;
    }

    public static DocumentExportSystemdCgroupAuthorityContract DiscoverInstalledContract()
    {
        return new DocumentExportSystemdCgroupAuthorityContract(
            RequiredSystemdRunPath,
            ReadVersion(RequiredSystemdRunPath),
            ComputeExecutableDigest(RequiredSystemdRunPath),
            RequiredSystemctlPath,
            ReadVersion(RequiredSystemctlPath),
            ComputeExecutableDigest(RequiredSystemctlPath),
            RequiredBubblewrapPath,
            ReadVersion(RequiredBubblewrapPath),
            ComputeExecutableDigest(RequiredBubblewrapPath));
    }

    public async Task<Execution> StartAsync(
        string runId,
        ProcessStartInfo workload,
        DocumentExportResourceBudgets budgets,
        string standardOutputPath,
        string standardErrorPath,
        CancellationToken cancellationToken)
    {
        ValidateRunId(runId);
        ValidateWorkload(workload);
        ValidateOwnedLogPath(workload.WorkingDirectory, standardOutputPath);
        ValidateOwnedLogPath(workload.WorkingDirectory, standardErrorPath);
        await ValidateInstalledIdentityAsync(cancellationToken);

        string unitName = $"fsusblog-document-export-{runId}.service";
        long cpuBudgetMicroseconds = ToPositiveMicroseconds(budgets.CpuTime, nameof(budgets.CpuTime));
        long runtimeMaxMicroseconds = ToPositiveMicroseconds(budgets.WallTime, nameof(budgets.WallTime));
        Directory.CreateDirectory(Path.GetDirectoryName(standardOutputPath)!);
        await File.WriteAllBytesAsync(standardOutputPath, [], cancellationToken);
        await File.WriteAllBytesAsync(standardErrorPath, [], cancellationToken);
        SetOwnerOnlyMode(standardOutputPath);
        SetOwnerOnlyMode(standardErrorPath);

        var arguments = new List<string>
        {
            "--user",
            "--quiet",
            "--no-block",
            $"--unit={unitName}",
            $"--slice={DocumentExportSlice}",
            "--service-type=exec",
            $"--working-directory={workload.WorkingDirectory}",
            "--property=CPUAccounting=yes",
            "--property=MemoryAccounting=yes",
            "--property=TasksAccounting=yes",
            $"--property=MemoryMax={budgets.MaxWorkingSetBytes.ToString(CultureInfo.InvariantCulture)}",
            "--property=MemorySwapMax=0",
            $"--property=TasksMax={HostTasksLimit(budgets).ToString(CultureInfo.InvariantCulture)}",
            $"--property=RuntimeMaxSec={runtimeMaxMicroseconds.ToString(CultureInfo.InvariantCulture)}us",
            "--property=KillMode=control-group",
            "--property=TimeoutStopSec=1s",
            "--property=RemainAfterExit=yes",
            $"--property=StandardOutput=file:{standardOutputPath}",
            $"--property=StandardError=file:{standardErrorPath}",
            "--",
            workload.FileName
        };
        arguments.AddRange(workload.ArgumentList);

        bool unitMayExist = false;
        try
        {
            unitMayExist = true;
            ControlResult launch = await RunControlAsync(
                Contract.SystemdRunPath,
                arguments,
                cancellationToken);
            if (launch.ExitCode != 0)
            {
                throw new PlatformNotSupportedException(
                    $"Document export transient service admission failed: {BoundedDiagnostic(launch)}");
            }

            IReadOnlyDictionary<string, string> properties = await WaitForAdmissionPropertiesAsync(
                unitName,
                cancellationToken,
                "LoadState",
                "ActiveState",
                "SubState",
                "Type",
                "Slice",
                "ControlGroup",
                "MainPID",
                "ExecMainPID",
                "ExecMainStartTimestampMonotonic",
                "Result",
                "ExecMainCode",
                "ExecMainStatus",
                "CPUUsageNSec",
                "MemoryPeak",
                "TasksCurrent",
                "MemoryAccounting",
                "TasksAccounting",
                "MemoryMax",
                "MemorySwapMax",
                "TasksMax",
                "RuntimeMaxUSec",
                "KillMode",
                "RemainAfterExit");
            ValidateAdmissionProperties(properties, budgets, runtimeMaxMicroseconds);
            string controlGroup = RequireProperty(properties, "ControlGroup");
            bool terminalAdmission = IsTerminalAdmission(properties);
            if (terminalAdmission)
            {
                ValidateTerminalAdmissionProperties(properties);
                if (string.IsNullOrEmpty(controlGroup))
                {
                    controlGroup = await ResolveTerminalControlGroupAsync(unitName, cancellationToken);
                }
            }
            string cgroupPath = ResolveCgroupPath(
                unitName,
                controlGroup,
                requireExisting: !terminalAdmission);
            int rootProcessId = ParsePositiveInt(
                FirstNonZeroProperty(properties, "MainPID", "ExecMainPID"),
                "document export root process ID");
            (long rootProcessStartIdentity, string rootProcessStartIdentitySource) =
                ResolveStartIdentity(properties, rootProcessId);
            DocumentExportCgroupObservation initial;
            if (terminalAdmission)
            {
                initial = CreateTerminalObservation(properties);
            }
            else
            {
                ValidateCgroupFilesAndLimits(cgroupPath, budgets);
                initial = ReadObservation(cgroupPath);
            }

            return new Execution(
                this,
                unitName,
                controlGroup,
                cgroupPath,
                rootProcessId,
                rootProcessStartIdentity,
                rootProcessStartIdentitySource,
                cpuBudgetMicroseconds,
                runtimeMaxMicroseconds,
                budgets.MaxWorkingSetBytes,
                budgets.MaxProcessCount,
                initial);
        }
        catch (Exception exception)
        {
            if (unitMayExist)
            {
                bool cleanupQualified = await TryTerminateAndRemoveUnitAsync(unitName);
                if (!cleanupQualified)
                {
                    throw new DocumentExportCgroupAdmissionCleanupException(exception);
                }
            }
            throw;
        }
    }

    private async Task<IReadOnlyDictionary<string, string>> WaitForAdmissionPropertiesAsync(
        string unitName,
        CancellationToken cancellationToken,
        params string[] propertyNames)
    {
        for (int attempt = 0; attempt < 100; attempt++)
        {
            IReadOnlyDictionary<string, string> properties = await QueryUnitAsync(
                unitName,
                cancellationToken,
                propertyNames);
            string loadState = RequireProperty(properties, "LoadState");
            string controlGroup = RequireProperty(properties, "ControlGroup");
            if (loadState == "loaded" && IsTerminalAdmission(properties))
            {
                return properties;
            }
            if (loadState == "loaded" && !string.IsNullOrEmpty(controlGroup))
            {
                string cgroupPath = ResolveCgroupPath(unitName, controlGroup, requireExisting: false);
                if (Directory.Exists(cgroupPath))
                {
                    return properties;
                }
            }
            if (loadState is not ("not-found" or "loaded"))
            {
                throw new InvalidDataException(
                    "Document export transient service returned an unexpected admission state.");
            }
            await Task.Delay(10, cancellationToken);
        }
        throw new InvalidDataException(
            "Document export transient service did not expose its cgroup before the admission deadline.");
    }

    private async Task<string> ResolveTerminalControlGroupAsync(
        string unitName,
        CancellationToken cancellationToken)
    {
        IReadOnlyDictionary<string, string> slice = await QueryUnitAsync(
            DocumentExportSlice,
            cancellationToken,
            "LoadState",
            "ControlGroup");
        string sliceControlGroup = RequireProperty(slice, "ControlGroup");
        if (RequireProperty(slice, "LoadState") != "loaded"
            || string.IsNullOrEmpty(sliceControlGroup)
            || sliceControlGroup.EndsWith("/", StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                "Document export authority could not resolve its fixed transient-service slice.");
        }

        string controlGroup = $"{sliceControlGroup}/{unitName}";
        string cgroupPath = ResolveCgroupPath(unitName, controlGroup, requireExisting: false);
        if (Directory.Exists(cgroupPath))
        {
            throw new InvalidDataException(
                "Document export terminal service retained an unqualified cgroup path.");
        }
        return controlGroup;
    }

    private async Task ValidateInstalledIdentityAsync(CancellationToken cancellationToken)
    {
        ValidateExecutableIdentity(
            Contract.SystemdRunPath,
            Contract.SystemdRunDigest,
            Contract.SystemdRunVersion);
        ValidateExecutableIdentity(
            Contract.SystemctlPath,
            Contract.SystemctlDigest,
            Contract.SystemctlVersion);
        ValidateExecutableIdentity(
            Contract.BubblewrapPath,
            Contract.BubblewrapDigest,
            Contract.BubblewrapVersion);

        await ValidateVersionAsync(
            Contract.SystemdRunPath,
            Contract.SystemdRunVersion,
            cancellationToken);
        await ValidateVersionAsync(
            Contract.SystemctlPath,
            Contract.SystemctlVersion,
            cancellationToken);
        await ValidateVersionAsync(
            Contract.BubblewrapPath,
            Contract.BubblewrapVersion,
            cancellationToken);
    }

    private async Task ValidateVersionAsync(
        string executablePath,
        string expectedVersion,
        CancellationToken cancellationToken)
    {
        ControlResult result = await RunControlAsync(
            executablePath,
            ["--version"],
            cancellationToken);
        string firstLine = FirstLine(result.StandardOutput);
        if (result.ExitCode != 0 || firstLine != expectedVersion)
        {
            throw new InvalidDataException(
                $"Document export authority version drifted for {executablePath}.");
        }
    }

    private async Task<IReadOnlyDictionary<string, string>> QueryUnitAsync(
        string unitName,
        CancellationToken cancellationToken,
        params string[] propertyNames)
    {
        var arguments = new List<string>
        {
            "--user",
            "show",
            unitName,
            "--no-pager"
        };
        foreach (string propertyName in propertyNames)
        {
            arguments.Add($"--property={propertyName}");
        }
        ControlResult result = await RunControlAsync(
            Contract.SystemctlPath,
            arguments,
            cancellationToken);
        if (result.ExitCode != 0)
        {
            throw new InvalidDataException(
                $"Document export authority could not inspect {unitName}: {BoundedDiagnostic(result)}");
        }
        return ParseProperties(result.StandardOutput, propertyNames);
    }

    private async Task<ControlResult> RunControlAsync(
        string executablePath,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo(executablePath)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.Environment.Clear();
        foreach ((string key, string value) in _controlEnvironment)
        {
            startInfo.Environment[key] = value;
        }
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process process = StartClosedProcess(startInfo);
        Task<string> stdout = ReadControlOutputAsync(process.StandardOutput);
        Task<string> stderr = ReadControlOutputAsync(process.StandardError);
        try
        {
            await process.WaitForExitAsync(cancellationToken);
        }
        catch
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
            }
            throw;
        }
        return new ControlResult(process.ExitCode, await stdout, await stderr);
    }

    private async Task<DocumentExportCgroupCompletion> ReadCompletionAsync(
        string unitName,
        CancellationToken cancellationToken)
    {
        IReadOnlyDictionary<string, string> properties = await QueryUnitAsync(
            unitName,
            cancellationToken,
            "Result",
            "ExecMainCode",
            "ExecMainStatus");
        return ParseCompletion(properties);
    }

    private static DocumentExportCgroupCompletion ParseCompletion(
        IReadOnlyDictionary<string, string> properties)
    {
        string result = RequireProperty(properties, "Result");
        string exitKind = RequireProperty(properties, "ExecMainCode");
        int status = ParseNonNegativeInt(
            RequireProperty(properties, "ExecMainStatus"),
            "document export ExecMainStatus");
        return exitKind switch
        {
            "1" or "exited" => new DocumentExportCgroupCompletion(result, "exited", status, 0),
            "2" or "3" or "killed" or "dumped" =>
                new DocumentExportCgroupCompletion(result, exitKind is "2" or "killed" ? "killed" : "dumped", 128 + status, status),
            _ => throw new InvalidDataException("Document export authority returned an unknown exit kind.")
        };
    }

    private async Task<bool> KillAsync(
        string unitName,
        string cgroupPath,
        CancellationToken cancellationToken)
    {
        DocumentExportCgroupObservation observation;
        try
        {
            observation = ReadObservation(cgroupPath);
        }
        catch (Exception exception) when (IsMissingCgroupException(exception))
        {
            _ = await ReadCompletionAsync(unitName, cancellationToken);
            return false;
        }
        if (!observation.Populated)
        {
            return false;
        }

        string killPath = Path.Combine(cgroupPath, "cgroup.kill");
        try
        {
            await File.WriteAllTextAsync(killPath, "1\n", Encoding.ASCII, cancellationToken);
        }
        catch (Exception exception) when (IsMissingCgroupException(exception))
        {
            _ = await ReadCompletionAsync(unitName, cancellationToken);
            return false;
        }
        return true;
    }

    private async Task<DocumentExportCgroupObservation> ObserveAsync(
        string unitName,
        string cgroupPath,
        DocumentExportCgroupObservation lastObservation,
        CancellationToken cancellationToken)
    {
        try
        {
            return ReadObservation(cgroupPath);
        }
        catch (IOException)
        {
            return await ReadTerminalObservationAsync(
                unitName,
                lastObservation,
                cancellationToken);
        }
    }

    private async Task<DocumentExportCgroupObservation> ReadTerminalObservationAsync(
        string unitName,
        DocumentExportCgroupObservation lastObservation,
        CancellationToken cancellationToken)
    {
        for (int attempt = 0; attempt < 100; attempt++)
        {
            IReadOnlyDictionary<string, string> properties = await QueryUnitAsync(
                unitName,
                cancellationToken,
                "LoadState",
                "ActiveState",
                "SubState",
                "Result",
                "ExecMainCode",
                "ExecMainStatus",
                "CPUUsageNSec",
                "MemoryPeak",
                "TasksCurrent");
            if (RequireProperty(properties, "LoadState") != "loaded")
            {
                throw new InvalidDataException(
                    "Document export cgroup disappeared without an exact retained service unit.");
            }
            if (IsTerminalAdmission(properties))
            {
                DocumentExportCgroupObservation terminal = CreateTerminalObservation(properties);
                return terminal with
                {
                    CpuUsageMicroseconds = Math.Max(
                        lastObservation.CpuUsageMicroseconds,
                        terminal.CpuUsageMicroseconds),
                    MemoryPeakBytes = Math.Max(lastObservation.MemoryPeakBytes, terminal.MemoryPeakBytes),
                    MemoryMaxEvents = Math.Max(lastObservation.MemoryMaxEvents, terminal.MemoryMaxEvents),
                    MemoryOomEvents = Math.Max(lastObservation.MemoryOomEvents, terminal.MemoryOomEvents),
                    PidsPeak = lastObservation.PidsPeak,
                    PidsMaxEvents = lastObservation.PidsMaxEvents
                };
            }
            await Task.Delay(10, cancellationToken);
        }
        throw new InvalidDataException(
            "Document export cgroup disappeared before its retained service reached a terminal state.");
    }

    private async Task<DocumentExportCgroupCleanup> CleanupAsync(
        string unitName,
        string cgroupPath,
        DocumentExportCgroupObservation lastObservation,
        CancellationToken cancellationToken)
    {
        DocumentExportCgroupObservation final = await ObserveAsync(
            unitName,
            cgroupPath,
            lastObservation,
            cancellationToken);
        if (final.Populated)
        {
            throw new InvalidDataException("Document export cgroup remained populated before unit cleanup.");
        }

        await RunSystemctlAllowFailureAsync(["--user", "stop", unitName], cancellationToken);
        await RunSystemctlAllowFailureAsync(["--user", "reset-failed", unitName], cancellationToken);

        bool unitRemoved = false;
        bool cgroupRemoved = false;
        for (int attempt = 0; attempt < 50; attempt++)
        {
            unitRemoved = await IsUnitRemovedAsync(unitName, cancellationToken);
            cgroupRemoved = !Directory.Exists(cgroupPath);
            if (unitRemoved && cgroupRemoved)
            {
                break;
            }
            await Task.Delay(10, cancellationToken);
        }
        if (!unitRemoved || !cgroupRemoved)
        {
            throw new InvalidDataException("Document export transient service cleanup did not remove its unit and cgroup.");
        }
        return new DocumentExportCgroupCleanup(false, unitRemoved, cgroupRemoved);
    }

    private async Task<bool> IsUnitRemovedAsync(string unitName, CancellationToken cancellationToken)
    {
        ControlResult result = await RunControlAsync(
            Contract.SystemctlPath,
            ["--user", "show", unitName, "--no-pager", "--property=LoadState"],
            cancellationToken);
        if (result.ExitCode != 0)
        {
            throw new InvalidDataException(
                $"Document export authority could not verify removal of {unitName}: {BoundedDiagnostic(result)}");
        }
        IReadOnlyDictionary<string, string> properties = ParseProperties(result.StandardOutput, ["LoadState"]);
        return RequireProperty(properties, "LoadState") == "not-found";
    }

    private async Task RunSystemctlAllowFailureAsync(
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
        => _ = await RunControlAsync(Contract.SystemctlPath, arguments, cancellationToken);

    private async Task<bool> TryTerminateAndRemoveUnitAsync(string unitName)
    {
        try
        {
            await RunSystemctlAllowFailureAsync(
                ["--user", "kill", "--kill-whom=all", "--signal=KILL", unitName],
                CancellationToken.None);
            await RunSystemctlAllowFailureAsync(
                ["--user", "stop", unitName],
                CancellationToken.None);
            await RunSystemctlAllowFailureAsync(
                ["--user", "reset-failed", unitName],
                CancellationToken.None);
            for (int attempt = 0; attempt < 50; attempt++)
            {
                if (await IsUnitRemovedAsync(unitName, CancellationToken.None))
                {
                    return true;
                }
                await Task.Delay(10, CancellationToken.None);
            }
        }
        catch
        {
            return false;
        }
        return false;
    }

    private static void ValidateAdmissionProperties(
        IReadOnlyDictionary<string, string> properties,
        DocumentExportResourceBudgets budgets,
        long expectedRuntimeMaxMicroseconds)
    {
        string loadState = RequireProperty(properties, "LoadState");
        string activeState = RequireProperty(properties, "ActiveState");
        if (loadState != "loaded"
            || activeState is not ("active" or "activating" or "deactivating" or "failed")
            || RequireProperty(properties, "Type") != "exec"
            || RequireProperty(properties, "Slice") != DocumentExportSlice
            || RequireProperty(properties, "MemoryAccounting") != "yes"
            || RequireProperty(properties, "TasksAccounting") != "yes"
            || RequireProperty(properties, "KillMode") != "control-group"
            || RequireProperty(properties, "RemainAfterExit") != "yes"
            || ParsePositiveLong(RequireProperty(properties, "MemoryMax"), "MemoryMax") != budgets.MaxWorkingSetBytes
            || ParseNonNegativeLong(RequireProperty(properties, "MemorySwapMax"), "MemorySwapMax") != 0
            || ParsePositiveLong(RequireProperty(properties, "TasksMax"), "TasksMax") != HostTasksLimit(budgets)
            || ParseSystemdDurationMicroseconds(
                RequireProperty(properties, "RuntimeMaxUSec"),
                "RuntimeMaxUSec") != expectedRuntimeMaxMicroseconds)
        {
            throw new InvalidDataException(
                "Document export transient service was not admitted with its exact cgroup properties.");
        }
    }

    private static bool IsTerminalAdmission(IReadOnlyDictionary<string, string> properties)
    {
        string activeState = RequireProperty(properties, "ActiveState");
        string subState = RequireProperty(properties, "SubState");
        return (activeState == "active" && subState == "exited")
            || (activeState == "failed" && subState == "failed");
    }

    private static void ValidateTerminalAdmissionProperties(
        IReadOnlyDictionary<string, string> properties)
    {
        if (!IsTerminalAdmission(properties)
            || ParsePositiveInt(
                RequireProperty(properties, "ExecMainPID"),
                "document export terminal root process ID") <= 0
            || ParsePositiveLong(
                RequireProperty(properties, "ExecMainStartTimestampMonotonic"),
                "document export terminal root process start identity") <= 0)
        {
            throw new InvalidDataException(
                "Document export transient service terminal admission was not exact.");
        }
        _ = ParseCompletion(properties);
    }

    private static DocumentExportCgroupObservation CreateTerminalObservation(
        IReadOnlyDictionary<string, string> properties)
    {
        DocumentExportCgroupCompletion completion = ParseCompletion(properties);
        long cpuUsageNanoseconds = ParseNonNegativeLong(
            RequireProperty(properties, "CPUUsageNSec"),
            "CPUUsageNSec");
        long memoryPeakBytes = ParseNonNegativeLong(
            RequireProperty(properties, "MemoryPeak"),
            "MemoryPeak");
        string tasksCurrent = RequireProperty(properties, "TasksCurrent");
        if (tasksCurrent != "[not set]"
            && ParseNonNegativeLong(tasksCurrent, "TasksCurrent") != 0)
        {
            throw new InvalidDataException(
                "Document export terminal service retained an unexpected live task count.");
        }

        bool outOfMemory = completion.Result == "oom-kill";
        return new DocumentExportCgroupObservation(
            cpuUsageNanoseconds / 1000,
            0,
            memoryPeakBytes,
            outOfMemory ? 1 : 0,
            outOfMemory ? 1 : 0,
            0,
            0,
            0,
            false);
    }

    private static void ValidateCgroupFilesAndLimits(
        string cgroupPath,
        DocumentExportResourceBudgets budgets)
    {
        string[] requiredFiles =
        [
            "cpu.stat",
            "memory.current",
            "memory.max",
            "memory.peak",
            "memory.swap.max",
            "memory.events",
            "pids.current",
            "pids.max",
            "pids.peak",
            "pids.events",
            "cgroup.events",
            "cgroup.kill"
        ];
        if (requiredFiles.Any(name => !File.Exists(Path.Combine(cgroupPath, name)))
            || ReadPositiveLongFile(cgroupPath, "memory.max") != budgets.MaxWorkingSetBytes
            || ReadNonNegativeLongFile(cgroupPath, "memory.swap.max") != 0
            || ReadPositiveLongFile(cgroupPath, "pids.max") != HostTasksLimit(budgets))
        {
            throw new PlatformNotSupportedException(
                "Document export requires delegated cgroup v2 CPU, memory, pids, events and kill authority.");
        }

        using var killAuthority = new FileStream(
            Path.Combine(cgroupPath, "cgroup.kill"),
            FileMode.Open,
            FileAccess.Write,
            FileShare.ReadWrite);
    }

    private static DocumentExportCgroupObservation ReadObservation(string cgroupPath)
    {
        IReadOnlyDictionary<string, long> cpu = ParseCounterFile(Path.Combine(cgroupPath, "cpu.stat"));
        IReadOnlyDictionary<string, long> memory = ParseCounterFile(Path.Combine(cgroupPath, "memory.events"));
        IReadOnlyDictionary<string, long> pids = ParseCounterFile(Path.Combine(cgroupPath, "pids.events"));
        IReadOnlyDictionary<string, long> events = ParseCounterFile(Path.Combine(cgroupPath, "cgroup.events"));
        return new DocumentExportCgroupObservation(
            RequireCounter(cpu, "usage_usec"),
            ReadNonNegativeLongFile(cgroupPath, "memory.current"),
            ReadNonNegativeLongFile(cgroupPath, "memory.peak"),
            RequireCounter(memory, "max"),
            checked(RequireCounter(memory, "oom") + RequireCounter(memory, "oom_kill")),
            BusinessProcessCount(ReadNonNegativeLongFile(cgroupPath, "pids.current")),
            BusinessProcessCount(ReadNonNegativeLongFile(cgroupPath, "pids.peak")),
            RequireCounter(pids, "max"),
            ParsePopulated(events));
    }

    public sealed class Execution
    {
        private readonly DocumentExportSystemdCgroupAuthority _authority;
        private DocumentExportCgroupObservation _lastObservation;

        internal Execution(
            DocumentExportSystemdCgroupAuthority authority,
            string unitName,
            string controlGroup,
            string cgroupPath,
            int rootProcessId,
            long rootProcessStartIdentity,
            string rootProcessStartIdentitySource,
            long cpuBudgetMicroseconds,
            long runtimeMaxMicroseconds,
            long memoryLimitBytes,
            int tasksLimit,
            DocumentExportCgroupObservation initialObservation)
        {
            _authority = authority;
            UnitName = unitName;
            ControlGroup = controlGroup;
            CgroupPath = cgroupPath;
            RootProcessId = rootProcessId;
            RootProcessStartIdentity = rootProcessStartIdentity;
            RootProcessStartIdentitySource = rootProcessStartIdentitySource;
            CpuBudgetMicroseconds = cpuBudgetMicroseconds;
            RuntimeMaxMicroseconds = runtimeMaxMicroseconds;
            MemoryLimitBytes = memoryLimitBytes;
            TasksLimit = tasksLimit;
            InitialObservation = initialObservation;
            _lastObservation = initialObservation;
        }

        public string UnitName
        {
            get;
        }

        public string ControlGroup
        {
            get;
        }

        public string CgroupPath
        {
            get;
        }

        public int RootProcessId
        {
            get;
        }

        public long RootProcessStartIdentity
        {
            get;
        }

        public string RootProcessStartIdentitySource
        {
            get;
        }

        public long CpuBudgetMicroseconds
        {
            get;
        }

        public long RuntimeMaxMicroseconds
        {
            get;
        }

        public long MemoryLimitBytes
        {
            get;
        }

        public int TasksLimit
        {
            get;
        }

        public DocumentExportCgroupObservation InitialObservation
        {
            get;
        }

        public async Task<DocumentExportCgroupObservation> ObserveAsync(
            CancellationToken cancellationToken = default)
        {
            _lastObservation = await _authority.ObserveAsync(
                UnitName,
                CgroupPath,
                _lastObservation,
                cancellationToken);
            return _lastObservation;
        }

        public Task<bool> KillAsync(CancellationToken cancellationToken = default)
            => _authority.KillAsync(UnitName, CgroupPath, cancellationToken);

        public Task<DocumentExportCgroupCompletion> ReadCompletionAsync(
            CancellationToken cancellationToken = default)
            => _authority.ReadCompletionAsync(UnitName, cancellationToken);

        public Task<DocumentExportCgroupCleanup> CleanupAsync(
            CancellationToken cancellationToken = default)
            => _authority.CleanupAsync(
                UnitName,
                CgroupPath,
                _lastObservation,
                cancellationToken);
    }

    internal static IReadOnlyDictionary<string, string> ParseProperties(
        string value,
        IReadOnlyCollection<string> expectedNames)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string line in value.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            int separator = line.IndexOf('=');
            if (separator <= 0)
            {
                throw new InvalidDataException("Document export systemd property output is malformed.");
            }
            string name = line[..separator];
            if (!expectedNames.Contains(name, StringComparer.Ordinal)
                || !result.TryAdd(name, line[(separator + 1)..]))
            {
                throw new InvalidDataException("Document export systemd property output drifted or duplicated.");
            }
        }
        if (result.Count != expectedNames.Count || expectedNames.Any(name => !result.ContainsKey(name)))
        {
            throw new InvalidDataException("Document export systemd property output is incomplete.");
        }
        return result;
    }

    internal static IReadOnlyDictionary<string, long> ParseCounterFile(string path)
    {
        string value = File.ReadAllText(path, Encoding.ASCII);
        var counters = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (string line in value.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string[] fields = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length != 2
                || !long.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out long counter)
                || counter < 0
                || !counters.TryAdd(fields[0], counter))
            {
                throw new InvalidDataException("Document export cgroup counter output is malformed.");
            }
        }
        return counters;
    }

    internal static bool ParsePopulated(IReadOnlyDictionary<string, long> events)
    {
        long populated = RequireCounter(events, "populated");
        return populated switch
        {
            0 => false,
            1 => true,
            _ => throw new InvalidDataException("Document export cgroup populated state is not binary.")
        };
    }

    internal static bool IsMissingCgroupException(Exception exception)
        => exception is FileNotFoundException or DirectoryNotFoundException;

    internal static long ParseSystemdDurationMicroseconds(string value, string name)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new InvalidDataException($"Document export {name} is not a finite systemd duration.");
        }

        string[] components = value.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        decimal total = 0;
        int previousRank = int.MaxValue;
        foreach (string component in components)
        {
            int numberLength = 0;
            while (numberLength < component.Length
                && (char.IsAsciiDigit(component[numberLength]) || component[numberLength] == '.'))
            {
                numberLength++;
            }
            if (numberLength == 0
                || numberLength == component.Length
                || !decimal.TryParse(
                    component.AsSpan(0, numberLength),
                    NumberStyles.AllowDecimalPoint,
                    CultureInfo.InvariantCulture,
                    out decimal amount)
                || amount < 0)
            {
                throw new InvalidDataException($"Document export {name} is not a finite systemd duration.");
            }

            (decimal multiplier, int rank) = component[numberLength..] switch
            {
                "d" => (86_400_000_000m, 6),
                "h" => (3_600_000_000m, 5),
                "min" => (60_000_000m, 4),
                "s" => (1_000_000m, 3),
                "ms" => (1_000m, 2),
                "us" => (1m, 1),
                _ => throw new InvalidDataException($"Document export {name} has an unknown systemd duration unit.")
            };
            decimal microseconds = amount * multiplier;
            if (rank >= previousRank || microseconds != decimal.Truncate(microseconds))
            {
                throw new InvalidDataException($"Document export {name} is not a canonical microsecond duration.");
            }
            total = checked(total + microseconds);
            previousRank = rank;
        }
        if (total <= 0 || total > long.MaxValue)
        {
            throw new InvalidDataException($"Document export {name} is not a positive microsecond duration.");
        }
        return decimal.ToInt64(total);
    }

    private static IReadOnlyDictionary<string, string> ResolveControlEnvironment()
    {
        string status = File.ReadAllText("/proc/self/status", Encoding.ASCII);
        string? uidLine = status.Split('\n').FirstOrDefault(line => line.StartsWith("Uid:", StringComparison.Ordinal));
        string? uidValue = uidLine?["Uid:".Length..]
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();
        if (!uint.TryParse(uidValue, NumberStyles.None, CultureInfo.InvariantCulture, out uint uid))
        {
            throw new PlatformNotSupportedException("Document export could not resolve its Linux user-manager identity.");
        }
        string runtimeDirectory = $"/run/user/{uid.ToString(CultureInfo.InvariantCulture)}";
        string busPath = Path.Combine(runtimeDirectory, "bus");
        if (!Directory.Exists(runtimeDirectory)
            || new DirectoryInfo(runtimeDirectory).LinkTarget is not null
            || !Path.Exists(busPath))
        {
            throw new PlatformNotSupportedException("Document export requires an active, owned systemd user manager.");
        }
        return new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["XDG_RUNTIME_DIR"] = runtimeDirectory,
            ["DBUS_SESSION_BUS_ADDRESS"] = $"unix:path={busPath}",
            ["LANG"] = "C.UTF-8"
        };
    }

    private static string ResolveCgroupPath(
        string unitName,
        string controlGroup,
        bool requireExisting = true)
    {
        if (!controlGroup.StartsWith("/", StringComparison.Ordinal)
            || !controlGroup.EndsWith($"/{unitName}", StringComparison.Ordinal))
        {
            throw new InvalidDataException("Document export transient service returned an unexpected cgroup identity.");
        }
        string candidate = Path.GetFullPath(CgroupRoot + controlGroup);
        string requiredPrefix = CgroupRoot + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(requiredPrefix, StringComparison.Ordinal)
            || (requireExisting && !Directory.Exists(candidate))
            || (Directory.Exists(candidate) && new DirectoryInfo(candidate).LinkTarget is not null))
        {
            throw new InvalidDataException("Document export cgroup path escaped or did not exist.");
        }
        return candidate;
    }

    private static (long Value, string Source) ResolveStartIdentity(
        IReadOnlyDictionary<string, string> properties,
        int rootProcessId)
    {
        try
        {
            string stat = File.ReadAllText($"/proc/{rootProcessId.ToString(CultureInfo.InvariantCulture)}/stat", Encoding.ASCII);
            int commandEnd = stat.LastIndexOf(')');
            if (commandEnd >= 0 && commandEnd + 2 <= stat.Length)
            {
                string[] fields = stat[(commandEnd + 2)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (fields.Length > 19
                    && long.TryParse(fields[19], NumberStyles.None, CultureInfo.InvariantCulture, out long startTicks)
                    && startTicks > 0)
                {
                    return (startTicks, "proc-stat-starttime-ticks");
                }
            }
        }
        catch (IOException)
        {
            // A short-lived main process is still bound by systemd's persisted monotonic start identity.
        }
        return (
            ParsePositiveLong(
                RequireProperty(properties, "ExecMainStartTimestampMonotonic"),
                "document export monotonic process start identity"),
            "systemd-exec-main-start-monotonic-usec");
    }

    private static string FirstNonZeroProperty(
        IReadOnlyDictionary<string, string> properties,
        params string[] names)
    {
        foreach (string name in names)
        {
            string value = RequireProperty(properties, name);
            if (value != "0")
            {
                return value;
            }
        }
        throw new InvalidDataException("Document export authority did not retain its root process identity.");
    }

    private static void ValidateContractShape(DocumentExportSystemdCgroupAuthorityContract contract)
    {
        if (contract.SystemdRunPath != RequiredSystemdRunPath
            || contract.SystemctlPath != RequiredSystemctlPath
            || contract.BubblewrapPath != RequiredBubblewrapPath
            || string.IsNullOrWhiteSpace(contract.SystemdRunVersion)
            || string.IsNullOrWhiteSpace(contract.SystemctlVersion)
            || string.IsNullOrWhiteSpace(contract.BubblewrapVersion))
        {
            throw new InvalidDataException("Document export authority requires fixed absolute tool paths and versions.");
        }
        DocumentExportContractValidator.RequireDigest(contract.SystemdRunDigest, nameof(contract.SystemdRunDigest));
        DocumentExportContractValidator.RequireDigest(contract.SystemctlDigest, nameof(contract.SystemctlDigest));
        DocumentExportContractValidator.RequireDigest(contract.BubblewrapDigest, nameof(contract.BubblewrapDigest));
    }

    private static void ValidateExecutableIdentity(string path, string expectedDigest, string expectedVersion)
    {
        FileInfo info = new(path);
        if (!info.Exists
            || info.LinkTarget is not null
            || ComputeExecutableDigest(path) != expectedDigest
            || string.IsNullOrWhiteSpace(expectedVersion))
        {
            throw new InvalidDataException($"Document export authority executable identity drifted for {path}.");
        }
    }

    private static void ValidateWorkload(ProcessStartInfo workload)
    {
        ArgumentNullException.ThrowIfNull(workload);
        if (workload.FileName != RequiredBubblewrapPath
            || workload.UseShellExecute
            || !Path.IsPathFullyQualified(workload.WorkingDirectory)
            || workload.ArgumentList.Count == 0
            || workload.Arguments.Length != 0)
        {
            throw new InvalidDataException("Document export authority accepts only the fixed closed bubblewrap invocation.");
        }
    }

    private static void ValidateOwnedLogPath(string runRoot, string path)
    {
        string root = Path.GetFullPath(runRoot);
        string candidate = Path.GetFullPath(path);
        string prefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(prefix, StringComparison.Ordinal)
            || candidate.Contains(':')
            || candidate.Contains('%')
            || candidate.Contains('\0')
            || candidate.Contains('\n')
            || candidate.Contains('\r'))
        {
            throw new InvalidDataException("Document export authority log path escaped its run root.");
        }
    }

    private static void ValidateRunId(string runId)
    {
        if (runId.Length != 32 || runId.Any(character => !Uri.IsHexDigit(character) || char.IsUpper(character)))
        {
            throw new InvalidDataException("Document export run identity must be 32 lowercase hexadecimal characters.");
        }
    }

    private static async Task<string> ReadControlOutputAsync(StreamReader reader)
    {
        char[] buffer = new char[4096];
        var value = new StringBuilder();
        int observedBytes = 0;
        bool exceeded = false;
        int count;
        while ((count = await reader.ReadAsync(buffer)) != 0)
        {
            observedBytes = checked(observedBytes + Encoding.UTF8.GetByteCount(buffer, 0, count));
            if (!exceeded && observedBytes <= ControlOutputLimitBytes)
            {
                value.Append(buffer, 0, count);
            }
            else
            {
                exceeded = true;
            }
        }
        if (exceeded)
        {
            throw new InvalidDataException("Document export authority control output exceeded its bound.");
        }
        return value.ToString();
    }

    private static string ReadVersion(string executablePath)
    {
        ValidateExecutableForProbe(executablePath);
        var startInfo = new ProcessStartInfo(executablePath)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.Environment.Clear();
        startInfo.Environment["LANG"] = "C.UTF-8";
        startInfo.ArgumentList.Add("--version");
        using Process process = StartClosedProcess(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        string firstLine = FirstLine(stdout);
        if (process.ExitCode != 0 || string.IsNullOrWhiteSpace(firstLine))
        {
            throw new PlatformNotSupportedException(
                $"Document export authority version probe failed: {stderr.Trim()}");
        }
        return firstLine;
    }

    private static void ValidateExecutableForProbe(string executablePath)
    {
        FileInfo info = new(executablePath);
        if (!info.Exists || info.LinkTarget is not null)
        {
            throw new PlatformNotSupportedException(
                $"Document export authority requires the fixed executable {executablePath}.");
        }
    }

    private static Process StartClosedProcess(ProcessStartInfo startInfo)
        => Process.Start(startInfo)
            ?? throw new InvalidOperationException("Document export authority control process did not start.");

    private static string ComputeExecutableDigest(string executablePath)
    {
        ValidateExecutableForProbe(executablePath);
        return $"sha256:{Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(executablePath)))}";
    }

    private static string FirstLine(string value)
        => value.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .FirstOrDefault() ?? string.Empty;

    private static string RequireProperty(IReadOnlyDictionary<string, string> properties, string name)
        => properties.TryGetValue(name, out string? value)
            ? value
            : throw new InvalidDataException($"Document export systemd property {name} is missing.");

    private static long RequireCounter(IReadOnlyDictionary<string, long> counters, string name)
        => counters.TryGetValue(name, out long value)
            ? value
            : throw new InvalidDataException($"Document export cgroup counter {name} is missing.");

    private static long ReadPositiveLongFile(string root, string name)
        => ParsePositiveLong(File.ReadAllText(Path.Combine(root, name), Encoding.ASCII).Trim(), name);

    private static long ReadNonNegativeLongFile(string root, string name)
        => ParseNonNegativeLong(File.ReadAllText(Path.Combine(root, name), Encoding.ASCII).Trim(), name);

    private static long ParsePositiveLong(string value, string name)
    {
        long result = ParseNonNegativeLong(value, name);
        return result > 0
            ? result
            : throw new InvalidDataException($"Document export {name} must be positive.");
    }

    private static long ParseNonNegativeLong(string value, string name)
        => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long result) && result >= 0
            ? result
            : throw new InvalidDataException($"Document export {name} is not a non-negative integer.");

    private static int ParsePositiveInt(string value, string name)
    {
        int result = ParseNonNegativeInt(value, name);
        return result > 0
            ? result
            : throw new InvalidDataException($"Document export {name} must be positive.");
    }

    private static int ParseNonNegativeInt(string value, string name)
        => int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int result) && result >= 0
            ? result
            : throw new InvalidDataException($"Document export {name} is not a non-negative integer.");

    private static long ToPositiveMicroseconds(TimeSpan value, string name)
    {
        if (value <= TimeSpan.Zero)
        {
            throw new InvalidDataException($"Document export {name} must be positive.");
        }
        return checked((long)Math.Ceiling(value.TotalMilliseconds * 1000d));
    }

    private static int HostTasksLimit(DocumentExportResourceBudgets budgets)
        => checked(budgets.MaxProcessCount + BrokerProcessOverhead);

    private static int BusinessProcessCount(long hostProcessCount)
        => checked((int)Math.Max(0, hostProcessCount - BrokerProcessOverhead));

    private static void SetOwnerOnlyMode(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    private static string BoundedDiagnostic(ControlResult result)
    {
        string value = string.IsNullOrWhiteSpace(result.StandardError)
            ? result.StandardOutput
            : result.StandardError;
        value = value.Trim();
        return value.Length <= 1024 ? value : value[..1024];
    }

    private sealed record ControlResult(int ExitCode, string StandardOutput, string StandardError);
}
