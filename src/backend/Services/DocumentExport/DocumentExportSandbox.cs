using System.Diagnostics;
using System.Text;

namespace FsusBlog.Server.Services.DocumentExport;

public sealed record DocumentExportToolContract(
    string ToolId,
    string ToolVersion,
    string ExecutablePath,
    string ExecutableDigest,
    string RuntimeRoot,
    string RuntimeDigest,
    IReadOnlyList<string> Arguments);

public sealed record DocumentExportSandboxPlan(
    string Schema,
    string RunId,
    string TaskDigest,
    string InputDigest,
    string SourceDigest,
    long UserId,
    long SiteId,
    string ProviderId,
    string ProviderVersion,
    string HostBuildDigest,
    string ToolId,
    string ToolVersion,
    string ExecutablePath,
    string ExecutableDigest,
    string RuntimeRoot,
    string RuntimeDigest,
    string CommandDigest,
    string EnvironmentDigest,
    string AuthorityKind,
    string AuthorityIdentityDigest,
    string AuthorityControlEnvironmentDigest,
    string SystemdRunDigest,
    string SystemctlDigest,
    string BubblewrapDigest,
    string CpuAccountingSource,
    int CpuPollIntervalMilliseconds,
    int BrokerProcessOverhead,
    string SandboxClass,
    string NetworkPolicy,
    IReadOnlyList<string> AllowedLoopbackServices,
    DocumentExportResourceBudgets Budgets,
    string BudgetsDigest,
    string ContentDigest);

public sealed record DocumentExportSandboxReceipt(
    string Schema,
    string RunId,
    string PlanDigest,
    string TaskDigest,
    string InputDigest,
    string SourceDigest,
    long UserId,
    long SiteId,
    string HostBuildDigest,
    string ProviderId,
    string ProviderVersion,
    string ToolId,
    string ToolVersion,
    string ExecutableDigest,
    string RuntimeDigest,
    string CommandDigest,
    string EnvironmentDigest,
    string AuthorityKind,
    string AuthorityIdentityDigest,
    string AuthorityControlEnvironmentDigest,
    string UnitName,
    string ControlGroup,
    string ControlGroupDigest,
    bool AuthorityEstablishedBeforeStart,
    string CpuAccountingSource,
    int CpuPollIntervalMilliseconds,
    long CpuBudgetMicroseconds,
    long CpuUsageMicroseconds,
    long CpuObservedOverrunMicroseconds,
    long CpuDetectionLatencyMilliseconds,
    string MemoryAccountingSource,
    long MemoryLimitBytes,
    long MemoryPeakBytes,
    long MemoryMaxEvents,
    long MemoryOomEvents,
    string ProcessAccountingSource,
    int BrokerProcessOverhead,
    int TasksLimit,
    int TasksPeak,
    long TasksMaxEvents,
    string CleanupSource,
    bool CgroupKillIssued,
    long RuntimeMaxMicroseconds,
    string KillMode,
    bool FinalCgroupPopulated,
    bool UnitRemoved,
    bool CgroupRemoved,
    string SandboxClass,
    string NetworkPolicy,
    bool NetworkNamespaceIsolated,
    int NetworkAttemptsAllowed,
    int ExternalWrites,
    int AttemptNumber,
    int RootProcessId,
    long RootProcessStartIdentity,
    string RootProcessStartIdentitySource,
    string Status,
    string FailureCode,
    int ExitCode,
    int TerminationSignal,
    long InputBytes,
    long OutputBytes,
    int OutputFileCount,
    string StandardOutputDigest,
    string StandardErrorDigest,
    string OutputDigest,
    long PeakWorkingSetBytes,
    long CpuMilliseconds,
    long WallMilliseconds,
    int PeakProcessCount,
    int ProcessesRemaining,
    bool ProcessTreeTerminated,
    bool RunDirectoryRemoved,
    string ContentDigest);

public sealed record DocumentExportSandboxResult(
    byte[] OutputBytes,
    DocumentExportSandboxPlan Plan,
    DocumentExportSandboxReceipt Receipt);

/// <summary>
/// Executes one immutable request with bubblewrap. The child gets no host root,
/// inherited environment or network namespace and can only write below its run root.
/// </summary>
public sealed class DocumentExportSandboxRuntime
{
    private readonly string _sandboxRoot;
    private readonly DocumentExportSystemdCgroupAuthority _authority;
    private readonly IReadOnlyDictionary<string, DocumentExportToolContract> _tools;
    private readonly SemaphoreSlim _concurrency;
    private readonly string _hostBuildDigest;
    private readonly IReadOnlyDictionary<string, DocumentExportResourceBudgets> _executionLimits;

    internal string HostBuildDigest => _hostBuildDigest;

    public DocumentExportSandboxRuntime(
        string sandboxRoot,
        IReadOnlyList<DocumentExportToolContract> tools,
        string hostBuildDigest,
        DocumentExportSystemdCgroupAuthority authority,
        IReadOnlyDictionary<string, DocumentExportResourceBudgets>? executionLimits = null)
    {
        if (!Path.IsPathFullyQualified(sandboxRoot))
        {
            throw new ArgumentException("Document export sandbox paths must be absolute.");
        }
        _authority = authority ?? throw new ArgumentNullException(nameof(authority));
        ArgumentNullException.ThrowIfNull(tools);
        DocumentExportContractValidator.RequireDigest(hostBuildDigest, nameof(hostBuildDigest));
        _hostBuildDigest = hostBuildDigest;
        _executionLimits = executionLimits is null
            ? new Dictionary<string, DocumentExportResourceBudgets>(StringComparer.Ordinal)
            : executionLimits.ToDictionary(
                pair => pair.Key,
                pair => pair.Value,
                StringComparer.Ordinal);
        foreach ((string providerId, DocumentExportResourceBudgets limits) in _executionLimits)
        {
            DocumentExportProviderContract? provider = DocumentExportContractCatalog.Providers.SingleOrDefault(
                candidate => candidate.ProviderId == providerId);
            if (provider is null)
            {
                throw new InvalidDataException("Document export execution limits contain an unknown provider identity.");
            }
            ValidateEffectiveBudgets(limits, provider.Budgets);
        }

        var toolMap = new Dictionary<string, DocumentExportToolContract>(StringComparer.Ordinal);
        foreach (DocumentExportToolContract tool in tools.ToArray())
        {
            if (tool is null || string.IsNullOrEmpty(tool.ToolId) || tool.Arguments is null)
            {
                throw new InvalidDataException("Document export tool registry contains a null identity.");
            }
            DocumentExportToolContract frozenTool = tool with
            {
                Arguments = tool.Arguments.ToArray()
            };
            if (!toolMap.TryAdd(frozenTool.ToolId, frozenTool))
            {
                throw new InvalidDataException("Document export tool registry contains duplicate identities.");
            }
        }
        DocumentExportProviderContract[] implementedProviders = DocumentExportContractCatalog.Providers
            .Where(provider => provider.ImplementationAvailable)
            .ToArray();
        if (toolMap.Count != implementedProviders.Length)
        {
            throw new InvalidDataException("Document export tool registry does not exactly match implemented providers.");
        }
        foreach (DocumentExportProviderContract provider in implementedProviders)
        {
            if (!toolMap.TryGetValue(provider.ToolchainId, out DocumentExportToolContract? tool))
            {
                throw new InvalidDataException("Document export tool registry is missing an implemented provider identity.");
            }
            ValidateToolMetadata(provider, tool);
        }
        _tools = toolMap;

        _sandboxRoot = Path.GetFullPath(sandboxRoot);
        Directory.CreateDirectory(_sandboxRoot);
        if (new DirectoryInfo(_sandboxRoot).LinkTarget is not null)
        {
            throw new InvalidDataException("Document export sandbox root cannot be a symbolic link.");
        }
        _concurrency = new SemaphoreSlim(
            implementedProviders.Min(provider => ResolveBudgets(provider).MaxConcurrency));
    }

    public async Task<DocumentExportSandboxResult> ExecuteAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        ReadOnlyMemory<byte> requestBytes,
        CancellationToken cancellationToken = default)
    {
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        DocumentExportResourceBudgets budgets = ResolveBudgets(provider);
        long maximumRequestBytes = Math.Min(budgets.MaxInputBytes, budgets.MaxMessageBytes);
        if (requestBytes.IsEmpty || requestBytes.Length > maximumRequestBytes)
        {
            throw new InvalidDataException(
                "Document export sandbox request must be non-empty and within its input and message budgets.");
        }

        return await ExecuteAsync(
            task,
            input,
            tool,
            async (output, token) => await output.WriteAsync(requestBytes, token),
            cancellationToken);
    }

    public async Task<DocumentExportSandboxResult> ExecuteAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        Func<Stream, CancellationToken, Task> writeRequestAsync,
        CancellationToken cancellationToken = default)
        => await ExecuteWithStageAsync(task, input, tool, writeRequestAsync, SandboxStage.Provider, cancellationToken);

    internal async Task<DocumentExportSandboxResult> ExecuteCanonicalRendererAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        Func<Stream, CancellationToken, Task> writeRequestAsync,
        CancellationToken cancellationToken = default)
    {
        _ = RequireCanonicalRendererProvider(task, input);
        DocumentExportToolContract tool = RequireRegisteredTool("self-contained-html");
        return await ExecuteWithStageAsync(task, input, tool, writeRequestAsync, SandboxStage.CanonicalRenderer, cancellationToken);
    }

    private enum SandboxStage
    {
        Provider,
        CanonicalRenderer
    }

    private async Task<DocumentExportSandboxResult> ExecuteWithStageAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        Func<Stream, CancellationToken, Task> writeRequestAsync,
        SandboxStage stage,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(writeRequestAsync);
        await _concurrency.WaitAsync(cancellationToken);
        try
        {
            return await ExecuteOwnedAsync(task, input, tool, writeRequestAsync, stage, cancellationToken);
        }
        finally
        {
            _concurrency.Release();
        }
    }

    internal DocumentExportToolContract RequireRegisteredTool(string formatId)
    {
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(formatId);
        if (!provider.ImplementationAvailable
            || !_tools.TryGetValue(provider.ToolchainId, out DocumentExportToolContract? tool))
        {
            throw new InvalidOperationException($"Document export format '{formatId}' has no registered tool.");
        }
        return tool;
    }

    private async Task<DocumentExportSandboxResult> ExecuteOwnedAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        Func<Stream, CancellationToken, Task> writeRequestAsync,
        SandboxStage stage,
        CancellationToken cancellationToken)
    {
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (!provider.ImplementationAvailable)
        {
            throw new InvalidOperationException($"Document export format '{task.FormatId}' has no active provider.");
        }
        DocumentExportProviderContract toolProvider = stage == SandboxStage.CanonicalRenderer
            ? RequireCanonicalRendererProvider(task, input)
            : provider;
        DocumentExportResourceBudgets budgets = ResolveBudgets(provider);
        if (stage == SandboxStage.CanonicalRenderer)
        {
            budgets = TightenBudgets(budgets, ResolveBudgets(toolProvider));
        }
        if (!_tools.TryGetValue(toolProvider.ToolchainId, out DocumentExportToolContract? registered)
            || !SameToolContract(registered, tool))
        {
            throw new InvalidDataException("Document export tool is not the exact registered tool identity.");
        }
        tool = registered;
        ValidateToolMetadata(toolProvider, tool);
        string runId = Guid.NewGuid().ToString("N");
        Dictionary<string, string> environment = MinimalEnvironment();
        DocumentExportSandboxPlan plan = SealPlan(new DocumentExportSandboxPlan(
            DocumentExportContractCatalog.SandboxPlanSchema,
            runId,
            task.ContentDigest,
            input.ContentDigest,
            input.SourceDigest,
            input.UserId,
            input.SiteId,
            provider.ProviderId,
            provider.ProviderVersion,
            _hostBuildDigest,
            tool.ToolId,
            tool.ToolVersion,
            tool.ExecutablePath,
            tool.ExecutableDigest,
            tool.RuntimeRoot,
            tool.RuntimeDigest,
            DocumentExportDigest.Compute(tool.Arguments),
            DocumentExportDigest.Compute(environment),
            DocumentExportSystemdCgroupAuthority.AuthorityKind,
            _authority.IdentityDigest,
            _authority.ControlEnvironmentDigest,
            _authority.Contract.SystemdRunDigest,
            _authority.Contract.SystemctlDigest,
            _authority.Contract.BubblewrapDigest,
            DocumentExportSystemdCgroupAuthority.CpuAccountingSource,
            _authority.CpuPollIntervalMilliseconds,
            DocumentExportSystemdCgroupAuthority.BrokerProcessOverhead,
            DocumentExportContractCatalog.SandboxClass,
            DocumentExportContractCatalog.NetworkPolicy,
            [],
            budgets,
            DocumentExportDigest.Compute(budgets),
            string.Empty));
        if (stage == SandboxStage.CanonicalRenderer)
        {
            ValidateCanonicalRendererPlan(plan, task, input, tool, _hostBuildDigest);
        }
        else
        {
            ValidatePlan(plan, task, input, provider, tool, _hostBuildDigest);
        }
        string runRoot = ResolveOwnedPath(_sandboxRoot, runId);
        string inputRoot = Path.Combine(runRoot, "input");
        string outputRoot = Path.Combine(runRoot, "output");
        string workRoot = Path.Combine(runRoot, "work");
        string brokerRoot = Path.Combine(runRoot, "broker");
        string brokerExecutablePath = Path.Combine(brokerRoot, "tool");
        string brokerRuntimeRoot = Path.Combine(brokerRoot, "runtime");
        string standardOutputPath = Path.Combine(runRoot, "stdout.log");
        string standardErrorPath = Path.Combine(runRoot, "stderr.log");
        var stopwatch = Stopwatch.StartNew();
        DocumentExportSystemdCgroupAuthority.Execution? execution = null;
        DocumentExportCgroupCompletion? completion = null;
        DocumentExportCgroupObservation observation = new(0, 0, 0, 0, 0, 0, 0, 0, false);
        int exitCode = -1;
        int terminationSignal = 0;
        int outputFileCount = 0;
        int rootProcessId = 0;
        long rootProcessStartIdentity = 0;
        string rootProcessStartIdentitySource = string.Empty;
        int finalProcessesRemaining = 0;
        string unitName = string.Empty;
        string controlGroup = string.Empty;
        string controlGroupDigest = string.Empty;
        bool authorityEstablishedBeforeStart = false;
        bool cgroupKillIssued = false;
        bool finalCgroupPopulated = false;
        bool unitRemoved = true;
        bool cgroupRemoved = true;
        long cpuDetectionLatencyMilliseconds = 0;
        string standardOutput = string.Empty;
        string standardError = string.Empty;
        bool processTreeTerminated = false;
        bool networkNamespaceIsolated = false;
        bool removed = false;
        long requestBytesLength = 0;
        byte[] outputBytes = [];
        Exception? failure = null;
        string failureCode = "none";
        try
        {
            Directory.CreateDirectory(inputRoot);
            Directory.CreateDirectory(outputRoot);
            Directory.CreateDirectory(workRoot);
            Directory.CreateDirectory(brokerRoot);
            await using (FileStream requestFile = new(
                Path.Combine(inputRoot, "request.json"),
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 64 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan))
            await using (var boundedRequest = new BoundedWriteStream(
                requestFile,
                Math.Min(budgets.MaxInputBytes, budgets.MaxMessageBytes)))
            {
                try
                {
                    await writeRequestAsync(boundedRequest, cancellationToken);
                    await boundedRequest.FlushAsync(cancellationToken);
                }
                finally
                {
                    requestBytesLength = boundedRequest.BytesWritten;
                }
            }
            if (requestBytesLength == 0)
            {
                throw new InvalidDataException("Document export sandbox request is empty.");
            }
            SnapshotTool(tool, brokerExecutablePath, brokerRuntimeRoot);
            ProcessStartInfo startInfo = BuildStartInfo(
                runRoot,
                inputRoot,
                outputRoot,
                workRoot,
                brokerExecutablePath,
                brokerRuntimeRoot,
                tool);
            execution = await _authority.StartAsync(
                runId,
                startInfo,
                budgets,
                standardOutputPath,
                standardErrorPath,
                cancellationToken);
            authorityEstablishedBeforeStart = true;
            networkNamespaceIsolated = true;
            unitRemoved = false;
            cgroupRemoved = false;
            unitName = execution.UnitName;
            controlGroup = execution.ControlGroup;
            controlGroupDigest = DocumentExportDigest.Compute(controlGroup);
            rootProcessId = execution.RootProcessId;
            rootProcessStartIdentity = execution.RootProcessStartIdentity;
            rootProcessStartIdentitySource = execution.RootProcessStartIdentitySource;
            observation = execution.InitialObservation;

            long previousObservationAt = stopwatch.ElapsedMilliseconds;
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                observation = await execution.ObserveAsync(cancellationToken);
                long observedAt = stopwatch.ElapsedMilliseconds;
                if (stopwatch.Elapsed > budgets.WallTime)
                {
                    cgroupKillIssued |= await execution.KillAsync(CancellationToken.None);
                    throw new DocumentExportBudgetExceededException("Document export sandbox exceeded its wall-time budget.", "wall-time-budget");
                }
                if (observation.CpuUsageMicroseconds > execution.CpuBudgetMicroseconds)
                {
                    cpuDetectionLatencyMilliseconds = Math.Max(1, observedAt - previousObservationAt);
                    cgroupKillIssued |= await execution.KillAsync(CancellationToken.None);
                    throw new DocumentExportBudgetExceededException("Document export sandbox exceeded its CPU-time budget.", "cpu-time-budget");
                }
                if (observation.MemoryMaxEvents > 0 || observation.MemoryOomEvents > 0)
                {
                    cgroupKillIssued |= await execution.KillAsync(CancellationToken.None);
                    throw new DocumentExportBudgetExceededException("Document export sandbox exceeded its working-set budget.", "memory-budget");
                }
                if (observation.PidsMaxEvents > 0)
                {
                    cgroupKillIssued |= await execution.KillAsync(CancellationToken.None);
                    throw new DocumentExportBudgetExceededException("Document export sandbox exceeded its process-count budget.", "process-count-budget");
                }
                ValidateLiveLogBudget(standardOutputPath, budgets.MaxStandardOutputBytes, "stdout-budget");
                ValidateLiveLogBudget(standardErrorPath, budgets.MaxStandardErrorBytes, "stderr-budget");
                ValidateRunArtifacts(
                    outputRoot,
                    workRoot,
                    standardOutputPath,
                    standardErrorPath,
                    budgets);
                if (!observation.Populated)
                {
                    break;
                }

                previousObservationAt = observedAt;
                await Task.Delay(_authority.CpuPollIntervalMilliseconds, cancellationToken);
            }

            completion = await execution.ReadCompletionAsync(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            if (observation.CpuUsageMicroseconds > execution.CpuBudgetMicroseconds)
            {
                cpuDetectionLatencyMilliseconds = Math.Max(
                    1,
                    stopwatch.ElapsedMilliseconds - previousObservationAt);
                throw new DocumentExportBudgetExceededException(
                    "Document export sandbox exceeded its CPU-time budget.",
                    "cpu-time-budget");
            }
            if (observation.MemoryMaxEvents > 0 || observation.MemoryOomEvents > 0)
            {
                throw new DocumentExportBudgetExceededException(
                    "Document export sandbox exceeded its working-set budget.",
                    "memory-budget");
            }
            if (observation.PidsMaxEvents > 0)
            {
                throw new DocumentExportBudgetExceededException(
                    "Document export sandbox exceeded its process-count budget.",
                    "process-count-budget");
            }
            if (completion.Result == "timeout")
            {
                throw new DocumentExportBudgetExceededException(
                    "Document export sandbox exceeded its wall-time budget.",
                    "wall-time-budget");
            }
            standardOutput = await ReadBoundedFileAsync(
                standardOutputPath,
                budgets.MaxStandardOutputBytes,
                "stdout-budget",
                cancellationToken);
            standardError = await ReadBoundedFileAsync(
                standardErrorPath,
                budgets.MaxStandardErrorBytes,
                "stderr-budget",
                cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            if (completion.ExitCode != 0)
            {
                string diagnostic = string.IsNullOrWhiteSpace(standardError)
                    ? "no diagnostic"
                    : standardError.Trim();
                throw new InvalidDataException(
                    $"Document export tool failed with exit code {completion.ExitCode} after "
                    + $"{(observation.CpuUsageMicroseconds / 1000d).ToString(System.Globalization.CultureInfo.InvariantCulture)} ms CPU: {diagnostic}");
            }

            (outputBytes, outputFileCount) = await ReadOutputAsync(outputRoot, budgets, cancellationToken);
            ValidateRunArtifacts(
                outputRoot,
                workRoot,
                standardOutputPath,
                standardErrorPath,
                budgets);
            exitCode = completion.ExitCode;
            terminationSignal = completion.TerminationSignal;
            processTreeTerminated = !observation.Populated;
        }
        catch (Exception exception)
        {
            failure = exception;
            failureCode = ClassifyFailure(exception);
            if (exception is DocumentExportCgroupAdmissionCleanupException)
            {
                unitRemoved = false;
                cgroupRemoved = false;
            }
        }
        finally
        {
            if (execution is not null)
            {
                try
                {
                    observation = await execution.ObserveAsync(CancellationToken.None);
                    if (observation.Populated)
                    {
                        cgroupKillIssued |= await execution.KillAsync(CancellationToken.None);
                    }
                    for (int attempt = 0;
                        attempt < 100 && !DocumentExportSystemdCgroupAuthority.IsDrained(observation);
                        attempt++)
                    {
                        await Task.Delay(_authority.CpuPollIntervalMilliseconds, CancellationToken.None);
                        observation = await execution.ObserveAsync(CancellationToken.None);
                    }
                    finalCgroupPopulated = observation.Populated;
                    finalProcessesRemaining = observation.PidsCurrent;
                    processTreeTerminated = !finalCgroupPopulated && finalProcessesRemaining == 0;
                    completion ??= await execution.ReadCompletionAsync(CancellationToken.None);
                    exitCode = completion.ExitCode;
                    terminationSignal = completion.TerminationSignal;
                    DocumentExportCgroupCleanup cleanup = await execution.CleanupAsync(CancellationToken.None);
                    unitRemoved = cleanup.UnitRemoved;
                    cgroupRemoved = cleanup.CgroupRemoved;
                }
                catch (Exception exception)
                {
                    failure ??= exception;
                    failureCode = "process-cleanup";
                }
            }
            else if (failure is not DocumentExportCgroupAdmissionCleanupException)
            {
                processTreeTerminated = true;
                finalProcessesRemaining = 0;
            }

            await CaptureDiagnosticFileAsync(standardOutputPath, budgets.MaxStandardOutputBytes, "stdout-budget", value => standardOutput = value, exception =>
            {
                if (failure is null)
                {
                    failure = exception;
                    failureCode = ClassifyFailure(exception);
                }
            });
            await CaptureDiagnosticFileAsync(standardErrorPath, budgets.MaxStandardErrorBytes, "stderr-budget", value => standardError = value, exception =>
            {
                if (failure is null)
                {
                    failure = exception;
                    failureCode = ClassifyFailure(exception);
                }
            });
            if (failure is null && stopwatch.Elapsed > budgets.WallTime)
            {
                failure = new DocumentExportBudgetExceededException(
                    "Document export sandbox exceeded its wall-time budget.",
                    "wall-time-budget");
                failureCode = "wall-time-budget";
            }
            if (Directory.Exists(outputRoot))
            {
                outputFileCount = Directory.EnumerateFiles(outputRoot, "*", SearchOption.TopDirectoryOnly).Count();
            }
            try
            {
                if (Directory.Exists(runRoot))
                {
                    Directory.Delete(runRoot, recursive: true);
                }
                removed = !Directory.Exists(runRoot);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                failure ??= exception;
                failureCode = "run-directory-cleanup";
                removed = false;
            }
        }

        var terminalFailure = ResolveTerminalFailure(
            failure,
            failureCode,
            cancellationToken,
            processTreeTerminated,
            removed,
            finalProcessesRemaining,
            finalCgroupPopulated,
            unitRemoved,
            cgroupRemoved);
        failure = terminalFailure.Failure;
        failureCode = terminalFailure.FailureCode;
        string status = terminalFailure.Status;
        DocumentExportSandboxReceipt unsigned = new(
            DocumentExportContractCatalog.AttemptReceiptSchema,
            runId,
            plan.ContentDigest,
            task.ContentDigest,
            input.ContentDigest,
            input.SourceDigest,
            input.UserId,
            input.SiteId,
            _hostBuildDigest,
            provider.ProviderId,
            provider.ProviderVersion,
            tool.ToolId,
            tool.ToolVersion,
            tool.ExecutableDigest,
            tool.RuntimeDigest,
            DocumentExportDigest.Compute(tool.Arguments),
            DocumentExportDigest.Compute(environment),
            DocumentExportSystemdCgroupAuthority.AuthorityKind,
            _authority.IdentityDigest,
            _authority.ControlEnvironmentDigest,
            unitName,
            controlGroup,
            controlGroupDigest,
            authorityEstablishedBeforeStart,
            DocumentExportSystemdCgroupAuthority.CpuAccountingSource,
            _authority.CpuPollIntervalMilliseconds,
            ToMicroseconds(plan.Budgets.CpuTime),
            observation.CpuUsageMicroseconds,
            Math.Max(0, observation.CpuUsageMicroseconds - ToMicroseconds(plan.Budgets.CpuTime)),
            cpuDetectionLatencyMilliseconds,
            DocumentExportSystemdCgroupAuthority.MemoryAccountingSource,
            plan.Budgets.MaxWorkingSetBytes,
            observation.MemoryPeakBytes,
            observation.MemoryMaxEvents,
            observation.MemoryOomEvents,
            DocumentExportSystemdCgroupAuthority.ProcessAccountingSource,
            DocumentExportSystemdCgroupAuthority.BrokerProcessOverhead,
            plan.Budgets.MaxProcessCount,
            observation.PidsPeak,
            observation.PidsMaxEvents,
            DocumentExportSystemdCgroupAuthority.CleanupSource,
            cgroupKillIssued,
            ToMicroseconds(plan.Budgets.WallTime),
            authorityEstablishedBeforeStart ? "control-group" : string.Empty,
            finalCgroupPopulated,
            unitRemoved,
            cgroupRemoved,
            DocumentExportContractCatalog.SandboxClass,
            DocumentExportContractCatalog.NetworkPolicy,
            networkNamespaceIsolated,
            0,
            0,
            1,
            rootProcessId,
            rootProcessStartIdentity,
            rootProcessStartIdentitySource,
            status,
            failureCode,
            exitCode,
            terminationSignal,
            requestBytesLength,
            outputBytes.LongLength,
            outputFileCount,
            DocumentExportDigest.ComputeBytes(Encoding.UTF8.GetBytes(standardOutput)),
            DocumentExportDigest.ComputeBytes(Encoding.UTF8.GetBytes(standardError)),
            DocumentExportDigest.ComputeBytes(outputBytes),
            observation.MemoryPeakBytes,
            observation.CpuUsageMicroseconds / 1000,
            stopwatch.ElapsedMilliseconds,
            observation.PidsPeak,
            finalProcessesRemaining,
            processTreeTerminated,
            removed,
            string.Empty);
        DocumentExportSandboxReceipt receipt = unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
        if (failure is null)
        {
            return new DocumentExportSandboxResult(outputBytes, plan, receipt);
        }

        throw failure switch
        {
            OperationCanceledException => new DocumentExportSandboxCancelledException(plan, receipt, failure),
            DocumentExportBudgetExceededException budget => new DocumentExportBudgetExceededException(
                budget.Message,
                budget.FailureCode,
                plan,
                receipt,
                budget),
            _ => new DocumentExportSandboxExecutionException(failure.Message, plan, receipt, failure)
        };
    }

    // Uses the same post-cleanup classification as ExecuteAsync; controls do not
    // replace physical budget enforcement or cleanup qualification.
    internal static (Exception? Failure, string FailureCode, string Status) ResolveTerminalFailure(
        Exception? failure,
        string failureCode,
        CancellationToken cancellationToken,
        bool processTreeTerminated,
        bool removed,
        int finalProcessesRemaining,
        bool finalCgroupPopulated,
        bool unitRemoved,
        bool cgroupRemoved)
    {
        if (ShouldRecordCancellation(failure, cancellationToken))
        {
            failure = new OperationCanceledException("Document export sandbox cancellation was requested.", cancellationToken);
            failureCode = "cancelled";
        }
        if (!processTreeTerminated
            || !removed
            || finalProcessesRemaining != 0
            || finalCgroupPopulated
            || !unitRemoved
            || !cgroupRemoved)
        {
            failure = new InvalidDataException(
                "Document export sandbox cleanup did not reach its qualified state.",
                failure);
            failureCode = "cleanup-unqualified";
        }
        string status = failure switch
        {
            null => "succeeded",
            OperationCanceledException => "cancelled",
            DocumentExportBudgetExceededException => "budget-exceeded",
            _ when !processTreeTerminated
                || !removed
                || finalProcessesRemaining != 0
                || finalCgroupPopulated
                || !unitRemoved
                || !cgroupRemoved => "cleanup-required",
            _ => "failed"
        };
        return (failure, failureCode, status);
    }

    // Cleanup can outlast the caller deadline; cancellation must not replace
    // an already observed failure. Physical cleanup qualification still wins.
    internal static bool ShouldRecordCancellation(
        Exception? failure,
        CancellationToken cancellationToken)
        => failure is null && cancellationToken.IsCancellationRequested;

    public static void ValidateReceipt(
        DocumentExportSandboxReceipt receipt,
        DocumentExportSandboxPlan plan,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest,
        ReadOnlySpan<byte> outputBytes)
    {
        ValidatePlan(plan, task, input, DocumentExportContractCatalog.RequireProvider(task.FormatId), tool, expectedHostBuildDigest);
        ValidateReceiptCore(receipt, plan, task, input, tool, outputBytes);
    }

    internal static void ValidateCanonicalRendererReceipt(
        DocumentExportSandboxReceipt receipt,
        DocumentExportSandboxPlan plan,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest,
        ReadOnlySpan<byte> outputBytes)
    {
        ValidateCanonicalRendererPlan(plan, task, input, tool, expectedHostBuildDigest);
        ValidateReceiptCore(receipt, plan, task, input, tool, outputBytes);
    }

    private static void ValidateReceiptCore(
        DocumentExportSandboxReceipt receipt,
        DocumentExportSandboxPlan plan,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        ReadOnlySpan<byte> outputBytes)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        if (receipt.Schema != DocumentExportContractCatalog.AttemptReceiptSchema
            || receipt.RunId != plan.RunId
            || receipt.PlanDigest != plan.ContentDigest
            || receipt.TaskDigest != task.ContentDigest
            || receipt.InputDigest != input.ContentDigest
            || receipt.SourceDigest != input.SourceDigest
            || receipt.UserId != input.UserId
            || receipt.SiteId != input.SiteId
            || receipt.HostBuildDigest != plan.HostBuildDigest
            || receipt.ProviderId != DocumentExportContractCatalog.RequireProvider(task.FormatId).ProviderId
            || receipt.ProviderVersion != DocumentExportContractCatalog.RequireProvider(task.FormatId).ProviderVersion
            || receipt.ToolId != tool.ToolId
            || receipt.ToolVersion != tool.ToolVersion
            || receipt.ExecutableDigest != tool.ExecutableDigest
            || receipt.RuntimeDigest != tool.RuntimeDigest
            || receipt.CommandDigest != DocumentExportDigest.Compute(tool.Arguments)
            || receipt.EnvironmentDigest != DocumentExportDigest.Compute(MinimalEnvironment())
            || receipt.AuthorityKind != plan.AuthorityKind
            || receipt.AuthorityIdentityDigest != plan.AuthorityIdentityDigest
            || receipt.AuthorityControlEnvironmentDigest != plan.AuthorityControlEnvironmentDigest
            || !receipt.AuthorityEstablishedBeforeStart
            || receipt.UnitName != $"fsusblog-document-export-{receipt.RunId}.service"
            || !receipt.ControlGroup.EndsWith($"/{receipt.UnitName}", StringComparison.Ordinal)
            || receipt.ControlGroupDigest != DocumentExportDigest.Compute(receipt.ControlGroup)
            || receipt.CpuAccountingSource != plan.CpuAccountingSource
            || receipt.CpuPollIntervalMilliseconds != plan.CpuPollIntervalMilliseconds
            || receipt.CpuBudgetMicroseconds != ToMicroseconds(plan.Budgets.CpuTime)
            || receipt.CpuUsageMicroseconds < 0
            || receipt.CpuUsageMicroseconds > receipt.CpuBudgetMicroseconds
            || receipt.CpuObservedOverrunMicroseconds != 0
            || receipt.CpuDetectionLatencyMilliseconds != 0
            || receipt.MemoryAccountingSource != DocumentExportSystemdCgroupAuthority.MemoryAccountingSource
            || receipt.MemoryLimitBytes != plan.Budgets.MaxWorkingSetBytes
            || receipt.MemoryPeakBytes < 0
            || receipt.MemoryPeakBytes > receipt.MemoryLimitBytes
            || receipt.MemoryMaxEvents != 0
            || receipt.MemoryOomEvents != 0
            || receipt.ProcessAccountingSource != DocumentExportSystemdCgroupAuthority.ProcessAccountingSource
            || receipt.BrokerProcessOverhead != plan.BrokerProcessOverhead
            || receipt.TasksLimit != plan.Budgets.MaxProcessCount
            || receipt.TasksPeak < 0
            || receipt.TasksPeak > receipt.TasksLimit
            || receipt.TasksMaxEvents != 0
            || receipt.CleanupSource != DocumentExportSystemdCgroupAuthority.CleanupSource
            || receipt.CgroupKillIssued
            || receipt.RuntimeMaxMicroseconds != ToMicroseconds(plan.Budgets.WallTime)
            || receipt.KillMode != "control-group"
            || receipt.FinalCgroupPopulated
            || !receipt.UnitRemoved
            || !receipt.CgroupRemoved
            || receipt.SandboxClass != DocumentExportContractCatalog.SandboxClass
            || receipt.NetworkPolicy != DocumentExportContractCatalog.NetworkPolicy
            || !receipt.NetworkNamespaceIsolated
            || receipt.NetworkAttemptsAllowed != 0
            || receipt.ExternalWrites != 0
            || receipt.AttemptNumber != 1
            || receipt.RootProcessId <= 0
            || receipt.RootProcessStartIdentity <= 0
            || receipt.RootProcessStartIdentitySource is not ("proc-stat-starttime-ticks" or "systemd-exec-main-start-monotonic-usec")
            || receipt.Status != "succeeded"
            || receipt.FailureCode != "none"
            || receipt.ExitCode != 0
            || receipt.TerminationSignal != 0
            || receipt.InputBytes <= 0
            || receipt.InputBytes > plan.Budgets.MaxInputBytes
            || receipt.InputBytes > plan.Budgets.MaxMessageBytes
            || receipt.OutputBytes != outputBytes.Length
            || receipt.OutputFileCount != 1
            || receipt.OutputDigest != DocumentExportDigest.ComputeBytes(outputBytes)
            || !IsDigest(receipt.StandardOutputDigest)
            || !IsDigest(receipt.StandardErrorDigest)
            || receipt.PeakWorkingSetBytes != receipt.MemoryPeakBytes
            || receipt.CpuMilliseconds != receipt.CpuUsageMicroseconds / 1000
            || receipt.WallMilliseconds < 0
            || receipt.WallMilliseconds > plan.Budgets.WallTime.TotalMilliseconds
            || receipt.PeakProcessCount != receipt.TasksPeak
            || !receipt.ProcessTreeTerminated
            || receipt.ProcessesRemaining != 0
            || !receipt.RunDirectoryRemoved)
        {
            throw new InvalidDataException("Document export sandbox receipt is not qualified.");
        }

        DocumentExportSandboxReceipt unsigned = receipt with
        {
            ContentDigest = string.Empty
        };
        if (receipt.ContentDigest != DocumentExportDigest.Compute(unsigned))
        {
            throw new InvalidDataException("Document export sandbox receipt digest mismatch.");
        }
    }

    public static void ValidateFailureReceipt(
        DocumentExportSandboxReceipt receipt,
        DocumentExportSandboxPlan plan,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest,
        string expectedStatus,
        string expectedFailureCode)
    {
        ValidatePlan(plan, task, input, DocumentExportContractCatalog.RequireProvider(task.FormatId), tool, expectedHostBuildDigest);
        ValidateFailureReceiptCore(receipt, plan, task, input, tool, expectedHostBuildDigest, expectedStatus, expectedFailureCode);
    }

    internal static void ValidateCanonicalRendererFailureReceipt(
        DocumentExportSandboxReceipt receipt,
        DocumentExportSandboxPlan plan,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest,
        string expectedStatus,
        string expectedFailureCode)
    {
        ValidateCanonicalRendererPlan(plan, task, input, tool, expectedHostBuildDigest);
        ValidateFailureReceiptCore(receipt, plan, task, input, tool, expectedHostBuildDigest, expectedStatus, expectedFailureCode);
    }

    private static void ValidateFailureReceiptCore(
        DocumentExportSandboxReceipt receipt,
        DocumentExportSandboxPlan plan,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest,
        string expectedStatus,
        string expectedFailureCode)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        if (receipt.Schema != DocumentExportContractCatalog.AttemptReceiptSchema
            || receipt.RunId != plan.RunId
            || receipt.PlanDigest != plan.ContentDigest
            || receipt.TaskDigest != task.ContentDigest
            || receipt.InputDigest != input.ContentDigest
            || receipt.SourceDigest != input.SourceDigest
            || receipt.UserId != input.UserId
            || receipt.SiteId != input.SiteId
            || receipt.HostBuildDigest != expectedHostBuildDigest
            || receipt.ProviderId != DocumentExportContractCatalog.RequireProvider(task.FormatId).ProviderId
            || receipt.ProviderVersion != DocumentExportContractCatalog.RequireProvider(task.FormatId).ProviderVersion
            || receipt.ToolId != tool.ToolId
            || receipt.ToolVersion != tool.ToolVersion
            || receipt.ExecutableDigest != tool.ExecutableDigest
            || receipt.RuntimeDigest != tool.RuntimeDigest
            || receipt.CommandDigest != DocumentExportDigest.Compute(tool.Arguments)
            || receipt.EnvironmentDigest != DocumentExportDigest.Compute(MinimalEnvironment())
            || receipt.AuthorityKind != plan.AuthorityKind
            || receipt.AuthorityIdentityDigest != plan.AuthorityIdentityDigest
            || receipt.AuthorityControlEnvironmentDigest != plan.AuthorityControlEnvironmentDigest
            || receipt.CpuAccountingSource != plan.CpuAccountingSource
            || receipt.CpuPollIntervalMilliseconds != plan.CpuPollIntervalMilliseconds
            || receipt.CpuBudgetMicroseconds != ToMicroseconds(plan.Budgets.CpuTime)
            || receipt.CpuUsageMicroseconds < 0
            || receipt.CpuObservedOverrunMicroseconds != Math.Max(0, receipt.CpuUsageMicroseconds - receipt.CpuBudgetMicroseconds)
            || receipt.CpuDetectionLatencyMilliseconds < 0
            || receipt.MemoryAccountingSource != DocumentExportSystemdCgroupAuthority.MemoryAccountingSource
            || receipt.MemoryLimitBytes != plan.Budgets.MaxWorkingSetBytes
            || receipt.MemoryPeakBytes < 0
            || receipt.MemoryMaxEvents < 0
            || receipt.MemoryOomEvents < 0
            || receipt.ProcessAccountingSource != DocumentExportSystemdCgroupAuthority.ProcessAccountingSource
            || receipt.BrokerProcessOverhead != plan.BrokerProcessOverhead
            || receipt.TasksLimit != plan.Budgets.MaxProcessCount
            || receipt.TasksPeak < 0
            || receipt.TasksMaxEvents < 0
            || receipt.CleanupSource != DocumentExportSystemdCgroupAuthority.CleanupSource
            || receipt.RuntimeMaxMicroseconds != ToMicroseconds(plan.Budgets.WallTime)
            || receipt.FinalCgroupPopulated
            || !receipt.UnitRemoved
            || !receipt.CgroupRemoved
            || receipt.SandboxClass != DocumentExportContractCatalog.SandboxClass
            || receipt.NetworkPolicy != DocumentExportContractCatalog.NetworkPolicy
            || receipt.NetworkAttemptsAllowed != 0
            || receipt.ExternalWrites != 0
            || receipt.AttemptNumber != 1
            || receipt.RootProcessId < 0
            || receipt.RootProcessStartIdentity < 0
            || (receipt.RootProcessId == 0) != (receipt.RootProcessStartIdentity == 0)
            || (receipt.RootProcessId == 0) != string.IsNullOrEmpty(receipt.RootProcessStartIdentitySource)
            || (receipt.RootProcessId > 0
                && receipt.RootProcessStartIdentitySource is not ("proc-stat-starttime-ticks" or "systemd-exec-main-start-monotonic-usec"))
            || (receipt.RootProcessId == 0) == receipt.NetworkNamespaceIsolated
            || (receipt.RootProcessId == 0) != string.IsNullOrEmpty(receipt.UnitName)
            || (receipt.RootProcessId == 0) != string.IsNullOrEmpty(receipt.ControlGroup)
            || (receipt.RootProcessId == 0) != string.IsNullOrEmpty(receipt.ControlGroupDigest)
            || (receipt.RootProcessId == 0) == receipt.AuthorityEstablishedBeforeStart
            || (receipt.RootProcessId == 0) != string.IsNullOrEmpty(receipt.KillMode)
            || (receipt.RootProcessId > 0
                && (receipt.UnitName != $"fsusblog-document-export-{receipt.RunId}.service"
                    || !receipt.ControlGroup.EndsWith($"/{receipt.UnitName}", StringComparison.Ordinal)
                    || receipt.ControlGroupDigest != DocumentExportDigest.Compute(receipt.ControlGroup)
                    || receipt.KillMode != "control-group"))
            || (receipt.TerminationSignal > 0 && receipt.ExitCode != 128 + receipt.TerminationSignal)
            || receipt.Status != expectedStatus
            || receipt.FailureCode != expectedFailureCode
            || receipt.InputBytes < 0
            || (receipt.RootProcessId > 0 && receipt.InputBytes == 0)
            || receipt.InputBytes > plan.Budgets.MaxInputBytes
            || receipt.InputBytes > plan.Budgets.MaxMessageBytes
            || receipt.OutputBytes < 0
            || receipt.OutputFileCount < 0
            || !IsDigest(receipt.StandardOutputDigest)
            || !IsDigest(receipt.StandardErrorDigest)
            || !IsDigest(receipt.OutputDigest)
            || receipt.PeakWorkingSetBytes != receipt.MemoryPeakBytes
            || receipt.CpuMilliseconds != receipt.CpuUsageMicroseconds / 1000
            || receipt.WallMilliseconds < 0
            || receipt.PeakProcessCount != receipt.TasksPeak
            || !receipt.ProcessTreeTerminated
            || receipt.ProcessesRemaining != 0
            || !receipt.RunDirectoryRemoved)
        {
            throw new InvalidDataException("Document export sandbox failure receipt is not qualified.");
        }

        DocumentExportSandboxReceipt unsigned = receipt with
        {
            ContentDigest = string.Empty
        };
        if (receipt.ContentDigest != DocumentExportDigest.Compute(unsigned))
        {
            throw new InvalidDataException("Document export sandbox failure receipt digest mismatch.");
        }
    }

    public static DocumentExportSandboxPlan SealPlan(DocumentExportSandboxPlan plan)
    {
        DocumentExportSandboxPlan unsigned = plan with
        {
            ContentDigest = string.Empty
        };
        return unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
    }

    public static void ValidatePlan(
        DocumentExportSandboxPlan plan,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportProviderContract provider,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest)
    {
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract expectedProvider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (DocumentExportDigest.Compute(provider) != DocumentExportDigest.Compute(expectedProvider))
        {
            throw new InvalidDataException("Document export sandbox provider drifted from the closed catalog.");
        }
        ValidateToolBinding(expectedProvider, tool);
        ValidatePlanCore(plan, task, input, expectedProvider, tool, expectedHostBuildDigest);
    }

    internal static void ValidateCanonicalRendererPlan(
        DocumentExportSandboxPlan plan,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest)
    {
        DocumentExportProviderContract renderer = RequireCanonicalRendererProvider(task, input);
        ValidateToolBinding(renderer, tool);
        ValidatePlanCore(plan, task, input, DocumentExportContractCatalog.RequireProvider(task.FormatId), tool, expectedHostBuildDigest);
        ValidateEffectiveBudgets(plan.Budgets, renderer.Budgets);
    }

    private static DocumentExportProviderContract RequireCanonicalRendererProvider(
        DocumentExportTask task,
        DocumentExportFrozenInput input)
    {
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract finalProvider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        DocumentExportProviderContract renderer = DocumentExportContractCatalog.RequireProvider("self-contained-html");
        if (!finalProvider.ImplementationAvailable || !renderer.ImplementationAvailable)
        {
            throw new InvalidOperationException($"Document export format '{task.FormatId}' has no active provider.");
        }
        if (finalProvider.RendererId != renderer.RendererId
            || finalProvider.RendererVersion != renderer.RendererVersion)
        {
            throw new InvalidDataException("Document export final provider does not use the canonical renderer binding.");
        }
        return renderer;
    }

    private static void ValidateToolBinding(DocumentExportProviderContract provider, DocumentExportToolContract tool)
    {
        ArgumentNullException.ThrowIfNull(tool);
        DocumentExportProviderExecutionBinding binding = DocumentExportContractCatalog.ExecutionBindings.Single(
            candidate => candidate.ProviderId == provider.ProviderId);
        if (tool.ToolId != provider.ToolchainId
            || tool.ToolVersion != provider.ToolchainVersion
            || tool.ToolId != binding.ToolId
            || tool.ToolVersion != binding.ToolVersion
            || !tool.Arguments.SequenceEqual(binding.ExactArguments, StringComparer.Ordinal))
        {
            throw new InvalidDataException("Document export sandbox tool drifted from the closed execution binding.");
        }
    }

    private static void ValidatePlanCore(
        DocumentExportSandboxPlan plan,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportProviderContract provider,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest)
    {
        DocumentExportSandboxPlan unsigned = plan with
        {
            ContentDigest = string.Empty
        };
        if (plan.Schema != DocumentExportContractCatalog.SandboxPlanSchema
            || !Guid.TryParseExact(plan.RunId, "N", out Guid runId)
            || plan.RunId != runId.ToString("N")
            || plan.TaskDigest != task.ContentDigest
            || plan.InputDigest != input.ContentDigest
            || plan.SourceDigest != input.SourceDigest
            || plan.UserId != input.UserId
            || plan.SiteId != input.SiteId
            || plan.ProviderId != provider.ProviderId
            || plan.ProviderVersion != provider.ProviderVersion
            || plan.HostBuildDigest != expectedHostBuildDigest
            || plan.ToolId != tool.ToolId
            || plan.ToolVersion != tool.ToolVersion
            || plan.ExecutablePath != tool.ExecutablePath
            || plan.ExecutableDigest != tool.ExecutableDigest
            || plan.RuntimeRoot != tool.RuntimeRoot
            || plan.RuntimeDigest != tool.RuntimeDigest
            || plan.CommandDigest != DocumentExportDigest.Compute(tool.Arguments)
            || plan.EnvironmentDigest != DocumentExportDigest.Compute(MinimalEnvironment())
            || plan.AuthorityKind != DocumentExportSystemdCgroupAuthority.AuthorityKind
            || !IsDigest(plan.AuthorityIdentityDigest)
            || !IsDigest(plan.AuthorityControlEnvironmentDigest)
            || !IsDigest(plan.SystemdRunDigest)
            || !IsDigest(plan.SystemctlDigest)
            || !IsDigest(plan.BubblewrapDigest)
            || plan.CpuAccountingSource != DocumentExportSystemdCgroupAuthority.CpuAccountingSource
            || plan.CpuPollIntervalMilliseconds is < 1 or > 1000
            || plan.BrokerProcessOverhead != DocumentExportSystemdCgroupAuthority.BrokerProcessOverhead
            || plan.SandboxClass != DocumentExportContractCatalog.SandboxClass
            || plan.NetworkPolicy != DocumentExportContractCatalog.NetworkPolicy
            || plan.AllowedLoopbackServices.Count != 0
            || plan.BudgetsDigest != DocumentExportDigest.Compute(plan.Budgets)
            || plan.ContentDigest != DocumentExportDigest.Compute(unsigned))
        {
            throw new InvalidDataException("Document export sandbox plan is missing, drifted or tampered.");
        }
        DocumentExportContractValidator.RequireDigest(expectedHostBuildDigest, nameof(expectedHostBuildDigest));
        ValidateEffectiveBudgets(plan.Budgets, provider.Budgets);
    }

    private DocumentExportResourceBudgets ResolveBudgets(DocumentExportProviderContract provider)
    {
        DocumentExportResourceBudgets budgets = _executionLimits.TryGetValue(provider.ProviderId, out DocumentExportResourceBudgets? limits)
            ? limits
            : provider.Budgets;
        ValidateEffectiveBudgets(budgets, provider.Budgets);
        return budgets;
    }

    private static DocumentExportResourceBudgets TightenBudgets(
        DocumentExportResourceBudgets final,
        DocumentExportResourceBudgets renderer)
        => new(
            final.WallTime <= renderer.WallTime ? final.WallTime : renderer.WallTime,
            final.CpuTime <= renderer.CpuTime ? final.CpuTime : renderer.CpuTime,
            Math.Min(final.MaxWorkingSetBytes, renderer.MaxWorkingSetBytes),
            Math.Min(final.MaxFileCount, renderer.MaxFileCount),
            Math.Min(final.MaxFileBytes, renderer.MaxFileBytes),
            Math.Min(final.MaxInputBytes, renderer.MaxInputBytes),
            Math.Min(final.MaxOutputBytes, renderer.MaxOutputBytes),
            Math.Min(final.MaxMessageBytes, renderer.MaxMessageBytes),
            Math.Min(final.MaxStandardOutputBytes, renderer.MaxStandardOutputBytes),
            Math.Min(final.MaxStandardErrorBytes, renderer.MaxStandardErrorBytes),
            Math.Min(final.MaxProcessCount, renderer.MaxProcessCount),
            Math.Min(final.MaxConcurrency, renderer.MaxConcurrency));

    private static void ValidateEffectiveBudgets(
        DocumentExportResourceBudgets actual,
        DocumentExportResourceBudgets maximum)
    {
        ArgumentNullException.ThrowIfNull(actual);
        ArgumentNullException.ThrowIfNull(maximum);
        if (actual.WallTime <= TimeSpan.Zero
            || actual.CpuTime <= TimeSpan.Zero
            || actual.MaxWorkingSetBytes <= 0
            || actual.MaxFileCount <= 0
            || actual.MaxFileBytes <= 0
            || actual.MaxInputBytes <= 0
            || actual.MaxOutputBytes <= 0
            || actual.MaxMessageBytes <= 0
            || actual.MaxStandardOutputBytes <= 0
            || actual.MaxStandardErrorBytes <= 0
            || actual.MaxProcessCount <= 0
            || actual.MaxConcurrency <= 0
            || actual.WallTime > maximum.WallTime
            || actual.CpuTime > maximum.CpuTime
            || actual.MaxWorkingSetBytes > maximum.MaxWorkingSetBytes
            || actual.MaxFileCount > maximum.MaxFileCount
            || actual.MaxFileBytes > maximum.MaxFileBytes
            || actual.MaxInputBytes > maximum.MaxInputBytes
            || actual.MaxOutputBytes > maximum.MaxOutputBytes
            || actual.MaxMessageBytes > maximum.MaxMessageBytes
            || actual.MaxStandardOutputBytes > maximum.MaxStandardOutputBytes
            || actual.MaxStandardErrorBytes > maximum.MaxStandardErrorBytes
            || actual.MaxProcessCount > maximum.MaxProcessCount
            || actual.MaxConcurrency > maximum.MaxConcurrency)
        {
            throw new InvalidDataException("Document export execution limits must be positive and no looser than the provider contract.");
        }
    }

    private ProcessStartInfo BuildStartInfo(
        string runRoot,
        string inputRoot,
        string outputRoot,
        string workRoot,
        string brokerExecutablePath,
        string brokerRuntimeRoot,
        DocumentExportToolContract tool)
    {
        string bubblewrapPath = _authority.Contract.BubblewrapPath;
        if (!File.Exists(bubblewrapPath))
        {
            throw new PlatformNotSupportedException("bubblewrap is required for document export isolation.");
        }

        const string SandboxExecutable = "/broker/tool";
        var startInfo = new ProcessStartInfo(bubblewrapPath)
        {
            UseShellExecute = false,
            WorkingDirectory = runRoot
        };
        // Both aliases mount the stable run-owned work root: temporary files
        // cannot detach a child source directory and are budgeted once with work files.
        AddArguments(startInfo,
            "--unshare-all", "--new-session", "--clearenv",
            "--proc", "/proc", "--dev", "/dev",
            "--bind", workRoot, "/tmp",
            "--dir", "/broker",
            "--ro-bind", brokerExecutablePath, SandboxExecutable,
            "--ro-bind", brokerRuntimeRoot, "/tool",
            "--dir", "/sandbox",
            "--ro-bind", inputRoot, "/sandbox/input",
            "--bind", outputRoot, "/sandbox/output",
            "--bind", workRoot, "/sandbox/work",
            "--chdir", "/sandbox/work",
            "--setenv", "HOME", "/sandbox/work",
            "--setenv", "TMPDIR", "/tmp",
            "--setenv", "LANG", "C.UTF-8",
            "--setenv", "PWD", "/sandbox/work");
        AddArguments(startInfo, "--", SandboxExecutable);
        foreach (string argument in tool.Arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        return startInfo;
    }

    private static void ValidateToolMetadata(DocumentExportProviderContract provider, DocumentExportToolContract tool)
    {
        ArgumentNullException.ThrowIfNull(tool);
        if (tool.ToolId != provider.ToolchainId
            || tool.ToolVersion != provider.ToolchainVersion
            || !Path.IsPathFullyQualified(tool.ExecutablePath)
            || !File.Exists(tool.ExecutablePath)
            || new FileInfo(tool.ExecutablePath).LinkTarget is not null
            || !Path.IsPathFullyQualified(tool.RuntimeRoot)
            || !Directory.Exists(tool.RuntimeRoot)
            || new DirectoryInfo(tool.RuntimeRoot).LinkTarget is not null
            || tool.ExecutableDigest != DocumentExportDigest.ComputeBytes(ReadRegularFile(tool.ExecutablePath))
            || tool.RuntimeDigest != ComputeRuntimeDigest(tool.RuntimeRoot)
            || tool.Arguments.Count != 1
            || tool.Arguments[0] != "render"
            || tool.Arguments.Any(argument => argument.Contains('\0') || argument.Contains('\n') || argument.Contains('\r'))
            || IsShellExecutable(tool.ExecutablePath)
            || tool.Arguments.Any(argument => argument is "-c" or "--command" or "--eval"))
        {
            throw new InvalidDataException("Document export tool contract is invalid or drifted.");
        }
    }

    private static void SnapshotTool(
        DocumentExportToolContract tool,
        string brokerExecutablePath,
        string brokerRuntimeRoot)
    {
        byte[] executableBytes = ReadRegularFile(tool.ExecutablePath);
        if (tool.ExecutableDigest != DocumentExportDigest.ComputeBytes(executableBytes))
        {
            throw new InvalidDataException("Document export executable bytes drifted from the registered identity.");
        }
        File.WriteAllBytes(brokerExecutablePath, executableBytes);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                brokerExecutablePath,
                UnixFileMode.UserRead | UnixFileMode.UserExecute);
        }

        Directory.CreateDirectory(brokerRuntimeRoot);
        string runtimeRoot = Path.GetFullPath(tool.RuntimeRoot);
        IReadOnlyList<string> runtimeFiles = EnumerateOwnedFiles(runtimeRoot);
        var manifest = new List<object>(runtimeFiles.Count);
        foreach (string sourcePath in runtimeFiles.OrderBy(path => path, StringComparer.Ordinal))
        {
            string relativePath = Path.GetRelativePath(runtimeRoot, sourcePath).Replace('\\', '/');
            byte[] bytes = ReadRegularFile(sourcePath);
            manifest.Add(new
            {
                Path = relativePath,
                Digest = DocumentExportDigest.ComputeBytes(bytes)
            });
            string destinationPath = ResolveOwnedPath(brokerRuntimeRoot, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);
            File.WriteAllBytes(destinationPath, bytes);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(destinationPath, File.GetUnixFileMode(sourcePath));
            }
        }
        if (tool.RuntimeDigest != DocumentExportDigest.Compute(manifest))
        {
            throw new InvalidDataException("Document export runtime bytes drifted from the registered identity.");
        }
    }

    private static byte[] ReadRegularFile(string path)
    {
        FileInfo info = new(path);
        if (!info.Exists || info.LinkTarget is not null)
        {
            throw new InvalidDataException("Document export tool identity must contain only regular files.");
        }
        byte[] bytes = File.ReadAllBytes(path);
        info.Refresh();
        if (!info.Exists || info.LinkTarget is not null || info.Length != bytes.LongLength)
        {
            throw new InvalidDataException("Document export tool identity changed while it was being admitted.");
        }
        return bytes;
    }

    public static string ComputeRuntimeDigest(string runtimeRoot)
    {
        string root = Path.GetFullPath(runtimeRoot);
        if (new DirectoryInfo(root).LinkTarget is not null)
        {
            throw new InvalidDataException("Document export tool runtime cannot be a symbolic link.");
        }
        IReadOnlyList<string> files = EnumerateOwnedFiles(root);
        object[] manifest = files
            .OrderBy(path => path, StringComparer.Ordinal)
            .Select(path => (object)new
            {
                Path = Path.GetRelativePath(root, path).Replace('\\', '/'),
                Digest = DocumentExportDigest.ComputeBytes(File.ReadAllBytes(path))
            })
            .ToArray();
        return DocumentExportDigest.Compute(manifest);
    }

    private static async Task<(byte[] Bytes, int FileCount)> ReadOutputAsync(
        string outputRoot,
        DocumentExportResourceBudgets budgets,
        CancellationToken cancellationToken)
    {
        string[] files = Directory.EnumerateFiles(outputRoot, "*", SearchOption.AllDirectories).ToArray();
        if (files.Length != 1 || files.Length > budgets.MaxFileCount)
        {
            throw new InvalidDataException("Document export tool must produce exactly one output file.");
        }
        string outputPath = Path.Combine(outputRoot, "response.json");
        if (!string.Equals(Path.GetFullPath(files[0]), outputPath, StringComparison.Ordinal)
            || new FileInfo(files[0]).LinkTarget is not null)
        {
            throw new InvalidDataException("Document export output path escaped its contract.");
        }
        FileInfo info = new(outputPath);
        if (info.Length > budgets.MaxFileBytes
            || info.Length > budgets.MaxOutputBytes
            || info.Length > budgets.MaxMessageBytes)
        {
            throw new DocumentExportBudgetExceededException(
                "Document export output exceeds its byte budget.",
                "output-budget");
        }
        return (await File.ReadAllBytesAsync(outputPath, cancellationToken), files.Length);
    }

    private static void ValidateRunArtifacts(
        string outputRoot,
        string workRoot,
        string standardOutputPath,
        string standardErrorPath,
        DocumentExportResourceBudgets budgets)
    {
        IReadOnlyList<string> outputFiles = EnumerateOwnedFiles(outputRoot);
        IReadOnlyList<string> workFiles = EnumerateOwnedFiles(workRoot);
        string[] files = [.. outputFiles, .. workFiles, standardOutputPath, standardErrorPath];
        if (files.Length > budgets.MaxFileCount)
        {
            throw new DocumentExportBudgetExceededException(
                "Document export sandbox exceeded its file-count budget.",
                "file-count-budget");
        }

        long totalBytes = 0;
        foreach (string path in files)
        {
            long length = new FileInfo(path).Length;
            if (outputFiles.Contains(path, StringComparer.Ordinal)
                && (length > budgets.MaxOutputBytes || length > budgets.MaxMessageBytes))
            {
                throw new DocumentExportBudgetExceededException(
                    "Document export sandbox exceeded its output byte budget.",
                    "output-budget");
            }
            if (length > budgets.MaxFileBytes)
            {
                throw new DocumentExportBudgetExceededException(
                    "Document export sandbox exceeded its per-file byte budget.",
                    "file-bytes-budget");
            }
            totalBytes = checked(totalBytes + length);
        }
        long maximumMutableBytes = checked(
            budgets.MaxOutputBytes
            + budgets.MaxStandardOutputBytes
            + budgets.MaxStandardErrorBytes);
        if (totalBytes > maximumMutableBytes)
        {
            throw new DocumentExportBudgetExceededException(
                "Document export sandbox exceeded its aggregate file byte budget.",
                "file-bytes-budget");
        }
    }

    private static IReadOnlyList<string> EnumerateOwnedFiles(string root)
    {
        var files = new List<string>();
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count != 0)
        {
            string directory = pending.Pop();
            foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
            {
                FileAttributes attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                {
                    throw new InvalidDataException("Document export sandbox artifact cannot be a symbolic link or reparse point.");
                }
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    pending.Push(entry);
                }
                else
                {
                    files.Add(entry);
                }
            }
        }
        return files;
    }

    private static void ValidateLiveLogBudget(string path, long maximumBytes, string failureCode)
    {
        FileInfo info = new(path);
        if (!info.Exists || info.LinkTarget is not null)
        {
            throw new InvalidDataException("Document export diagnostic stream path drifted.");
        }
        if (info.Length > maximumBytes)
        {
            throw new DocumentExportBudgetExceededException(
                "Document export diagnostic stream exceeded its byte budget.",
                failureCode);
        }
    }

    private static async Task<string> ReadBoundedFileAsync(
        string path,
        long maximumBytes,
        string failureCode,
        CancellationToken cancellationToken)
    {
        ValidateLiveLogBudget(path, maximumBytes, failureCode);
        byte[] bytes = await File.ReadAllBytesAsync(path, cancellationToken);
        if (bytes.LongLength > maximumBytes)
        {
            throw new DocumentExportBudgetExceededException(
                "Document export diagnostic stream exceeded its byte budget.",
                failureCode);
        }
        FileInfo finalInfo = new(path);
        if (!finalInfo.Exists || finalInfo.LinkTarget is not null || finalInfo.Length != bytes.LongLength)
        {
            throw new InvalidDataException("Document export diagnostic stream changed while it was being sealed.");
        }
        return Encoding.UTF8.GetString(bytes);
    }

    private static async Task CaptureDiagnosticFileAsync(
        string path,
        long maximumBytes,
        string failureCode,
        Action<string> capture,
        Action<Exception> captureFailure)
    {
        if (!File.Exists(path))
        {
            capture(string.Empty);
            return;
        }
        try
        {
            capture(await ReadBoundedFileAsync(
                path,
                maximumBytes,
                failureCode,
                CancellationToken.None));
        }
        catch (Exception exception)
        {
            captureFailure(exception);
        }
    }

    internal static string ClassifyFailure(Exception exception)
        => exception switch
        {
            DocumentExportBudgetExceededException budget => budget.FailureCode,
            OperationCanceledException => "cancelled",
            InvalidDataException => "contract-rejected",
            _ => "execution-failed"
        };

    private static bool IsDigest(string value)
    {
        try
        {
            DocumentExportContractValidator.RequireDigest(value, nameof(value));
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static long ToMicroseconds(TimeSpan value)
        => checked((value.Ticks + (TimeSpan.TicksPerMicrosecond - 1)) / TimeSpan.TicksPerMicrosecond);

    private static string ResolveOwnedPath(string root, string relative)
    {
        string candidate = Path.GetFullPath(Path.Combine(root, relative));
        string prefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(prefix, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Document export run path escaped its owner root.");
        }
        return candidate;
    }

    private static void AddArguments(ProcessStartInfo startInfo, params string[] arguments)
    {
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
    }

    private static Dictionary<string, string> MinimalEnvironment()
        => new(StringComparer.Ordinal)
        {
            ["HOME"] = "/sandbox/work",
            ["TMPDIR"] = "/tmp",
            ["LANG"] = "C.UTF-8",
            ["PWD"] = "/sandbox/work"
        };

    private static bool IsShellExecutable(string executablePath)
        => Path.GetFileName(executablePath).ToLowerInvariant() is "sh" or "bash" or "dash" or "zsh" or "fish" or "cmd.exe" or "powershell.exe" or "pwsh";

    private static bool SameToolContract(
        DocumentExportToolContract expected,
        DocumentExportToolContract? actual)
        => actual is not null
            && expected.ToolId == actual.ToolId
            && expected.ToolVersion == actual.ToolVersion
            && expected.ExecutablePath == actual.ExecutablePath
            && expected.ExecutableDigest == actual.ExecutableDigest
            && expected.RuntimeRoot == actual.RuntimeRoot
            && expected.RuntimeDigest == actual.RuntimeDigest
            && actual.Arguments is not null
            && expected.Arguments.SequenceEqual(actual.Arguments, StringComparer.Ordinal);

    private sealed class BoundedWriteStream(Stream inner, long maximumBytes) : Stream
    {
        public long BytesWritten
        {
            get; private set;
        }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => BytesWritten;
        public override long Position
        {
            get => BytesWritten;
            set => throw new NotSupportedException();
        }

        public override void Flush() => inner.Flush();

        public override Task FlushAsync(CancellationToken cancellationToken)
            => inner.FlushAsync(cancellationToken);

        public override void Write(byte[] buffer, int offset, int count)
        {
            EnsureWithinBudget(count);
            inner.Write(buffer, offset, count);
            BytesWritten += count;
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            EnsureWithinBudget(buffer.Length);
            inner.Write(buffer);
            BytesWritten += buffer.Length;
        }

        public override async Task WriteAsync(
            byte[] buffer,
            int offset,
            int count,
            CancellationToken cancellationToken)
        {
            EnsureWithinBudget(count);
            await inner.WriteAsync(buffer.AsMemory(offset, count), cancellationToken);
            BytesWritten += count;
        }

        public override async ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            EnsureWithinBudget(buffer.Length);
            await inner.WriteAsync(buffer, cancellationToken);
            BytesWritten += buffer.Length;
        }

        public override int Read(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin)
            => throw new NotSupportedException();

        public override void SetLength(long value)
            => throw new NotSupportedException();

        private void EnsureWithinBudget(int count)
        {
            if (count < 0 || BytesWritten > maximumBytes - count)
            {
                throw new DocumentExportBudgetExceededException(
                    "Document export sandbox request exceeds its input or message budget.",
                    "input-budget");
            }
        }
    }

}

public class DocumentExportSandboxExecutionException(
    string message,
    DocumentExportSandboxPlan plan,
    DocumentExportSandboxReceipt receipt,
    Exception innerException)
    : Exception(message, innerException)
{
    public DocumentExportSandboxPlan Plan { get; } = plan;

    public DocumentExportSandboxReceipt Receipt { get; } = receipt;
}

public sealed class DocumentExportSandboxCancelledException(
    DocumentExportSandboxPlan plan,
    DocumentExportSandboxReceipt receipt,
    Exception innerException)
    : OperationCanceledException("Document export sandbox execution was cancelled.", innerException)
{
    public DocumentExportSandboxPlan Plan { get; } = plan;

    public DocumentExportSandboxReceipt Receipt { get; } = receipt;
}

public sealed class DocumentExportBudgetExceededException : Exception
{
    internal DocumentExportBudgetExceededException(string message)
        : this(message, "resource-budget")
    {
    }

    internal DocumentExportBudgetExceededException(string message, string failureCode)
        : base(message)
    {
        FailureCode = failureCode;
    }

    internal DocumentExportBudgetExceededException(
        string message,
        string failureCode,
        DocumentExportSandboxPlan plan,
        DocumentExportSandboxReceipt receipt,
        Exception innerException)
        : base(message, innerException)
    {
        FailureCode = failureCode;
        Plan = plan;
        Receipt = receipt;
    }

    public string FailureCode
    {
        get;
    }

    public DocumentExportSandboxPlan? Plan
    {
        get;
    }

    public DocumentExportSandboxReceipt? Receipt
    {
        get;
    }
}
