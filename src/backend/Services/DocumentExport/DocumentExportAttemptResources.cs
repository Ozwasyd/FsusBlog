using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// The job owner creates one resource instance after its worker claim, passes
/// that same instance to every provider stage and verifies it before publishing.
/// Providers without this explicit port cannot qualify multi-stage accounting.
/// </summary>
public interface IDocumentExportAttemptJobProvider : IDocumentExportJobProvider
{
    DocumentExportAttemptResources CreateAttemptResources(
        DocumentExportTask task, DocumentExportFrozenInput input, TimeProvider time);

    Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task, DocumentExportFrozenInput input,
        DocumentExportAttemptResources resources, CancellationToken cancellationToken);

    Task VerifyAsync(
        DocumentExportProviderResult result, DocumentExportTask task, DocumentExportFrozenInput input,
        DocumentExportAttemptResources resources, CancellationToken cancellationToken);
}

/// <summary>
/// One explicit resource owner for a frozen attempt. All stages must share this
/// instance. It starts no process and provides no independent cleanup receipt.
/// Mutable-file accounting retains each stage's observed high-water marks; it
/// does not claim to measure unobserved transient files or kernel I/O traffic.
/// </summary>
public sealed class DocumentExportAttemptResources
{
    private readonly object _sync = new();
    private readonly DocumentExportTask _task;
    private readonly DocumentExportFrozenInput _input;
    private readonly DocumentExportResourceBudgets _maximum;
    private readonly TimeProvider _time;
    private readonly long _startedAt;
    private readonly long _maximumMutableBytes;
    private bool _activeStage;
    private bool _failed;
    private bool _sealed;
    private readonly HashSet<bool> _stageKinds = [];
    private int _completedStages;
    private long _cpuMicroseconds;
    private int _files;
    private long _fileBytes;
    private long _inputBytes;
    private long _outputBytes;
    private long _standardOutputBytes;
    private long _standardErrorBytes;

    internal DocumentExportAttemptResources(DocumentExportTask task, DocumentExportFrozenInput input,
        DocumentExportResourceBudgets maximum, TimeProvider time)
    {
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportSandboxRuntime.ValidateEffectiveBudgets(
            maximum, DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets);
        _task = task;
        _input = input;
        _maximum = maximum;
        _time = time ?? throw new ArgumentNullException(nameof(time));
        _startedAt = time.GetTimestamp();
        // Preserve the original mutable-artifact envelope: MaxFileBytes is the
        // per-file limit, while output and both logs bound the aggregate bytes.
        _maximumMutableBytes = checked(maximum.MaxOutputBytes
            + maximum.MaxStandardOutputBytes + maximum.MaxStandardErrorBytes);
    }

    internal Stage BeginStage(DocumentExportTask task, DocumentExportFrozenInput input,
        DocumentExportResourceBudgets declared, bool canonicalRenderer)
    {
        DocumentExportContractValidator.Validate(task, input);
        lock (_sync)
        {
            if (task.ContentDigest != _task.ContentDigest || input.ContentDigest != _input.ContentDigest)
            {
                _failed = true;
                throw new InvalidDataException("Document export resource owner does not bind this frozen attempt.");
            }
            if (_failed || _sealed || _activeStage || !_stageKinds.Add(canonicalRenderer))
            {
                _failed = true;
                throw new InvalidOperationException("Document export attempt cannot reset, overlap or retry its resource stages.");
            }
            DocumentExportSandboxRuntime.ValidateEffectiveBudgets(declared,
                DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets);
            TimeSpan remainingWall = _maximum.WallTime - _time.GetElapsedTime(_startedAt);
            long remainingCpuTicks = _maximum.CpuTime.Ticks
                - checked(_cpuMicroseconds * TimeSpan.TicksPerMicrosecond);
            long remainingFileBytes = Remaining(_maximumMutableBytes, _fileBytes, "task-file-bytes-budget");
            if (remainingWall <= TimeSpan.Zero || remainingCpuTicks <= 0)
            {
                _failed = true;
                throw Budget(remainingWall <= TimeSpan.Zero ? "task-wall-time-budget" : "task-cpu-time-budget");
            }
            var budgets = declared with
            {
                WallTime = Min(declared.WallTime, remainingWall),
                CpuTime = Min(declared.CpuTime, TimeSpan.FromTicks(remainingCpuTicks)),
                MaxWorkingSetBytes = Math.Min(declared.MaxWorkingSetBytes, _maximum.MaxWorkingSetBytes),
                MaxFileCount = checked((int)Math.Min(declared.MaxFileCount,
                    Remaining(_maximum.MaxFileCount, _files, "task-file-count-budget"))),
                MaxFileBytes = Math.Min(declared.MaxFileBytes, Math.Min(_maximum.MaxFileBytes, remainingFileBytes)),
                MaxInputBytes = Math.Min(declared.MaxInputBytes,
                    Remaining(_maximum.MaxInputBytes, _inputBytes, "task-input-budget")),
                MaxOutputBytes = Math.Min(declared.MaxOutputBytes,
                    Remaining(_maximum.MaxOutputBytes, _outputBytes, "task-output-budget")),
                MaxMessageBytes = Math.Min(declared.MaxMessageBytes, _maximum.MaxMessageBytes),
                MaxStandardOutputBytes = Math.Min(declared.MaxStandardOutputBytes,
                    Remaining(_maximum.MaxStandardOutputBytes, _standardOutputBytes, "task-stdout-budget")),
                MaxStandardErrorBytes = Math.Min(declared.MaxStandardErrorBytes,
                    Remaining(_maximum.MaxStandardErrorBytes, _standardErrorBytes, "task-stderr-budget")),
                MaxProcessCount = Math.Min(declared.MaxProcessCount, _maximum.MaxProcessCount),
                MaxConcurrency = Math.Min(declared.MaxConcurrency, _maximum.MaxConcurrency)
            };
            _activeStage = true;
            return new Stage(this, budgets, remainingFileBytes);
        }
    }

    /// <summary>
    /// A consumer checks this before publishing. It cannot replace verification
    /// of stage plans/receipts, frozen resources or physical cleanup.
    /// </summary>
    public void RequireCompleted()
    {
        lock (_sync)
        {
            if (_failed || _activeStage || _completedStages == 0)
            {
                throw new InvalidDataException("Document export attempt resources are incomplete or failed.");
            }
            if (_time.GetElapsedTime(_startedAt) >= _maximum.WallTime)
            {
                _failed = true;
                throw Budget("task-wall-time-budget");
            }
            _sealed = true;
        }
    }

    internal void AccountHostOutputBytes(long length)
    {
        lock (_sync)
        {
            if (_failed || _sealed || _activeStage || length < 0 || _completedStages == 0)
            {
                _failed = true;
                throw new InvalidDataException("Document export host output has no current completed resource stage.");
            }
            if (length > _maximum.MaxOutputBytes - _outputBytes)
            {
                _failed = true;
                throw Budget("task-output-budget");
            }
            _outputBytes += length;
        }
    }

    private long Remaining(long maximum, long spent, string code)
    {
        if (spent >= maximum)
        {
            _failed = true;
            throw Budget(code);
        }
        return maximum - spent;
    }

    private static TimeSpan Min(TimeSpan first, TimeSpan second) => first <= second ? first : second;

    private static DocumentExportBudgetExceededException Budget(string code)
        => new("Document export attempt exhausted its shared resource budget.", code);

    internal sealed class Stage(DocumentExportAttemptResources owner,
        DocumentExportResourceBudgets budgets, long fileBytesBudget) : IDisposable
    {
        private long _cpu;
        private int _files;
        private long _fileBytes;
        private long _input;
        private long _output;
        private long _stdout;
        private long _stderr;
        private bool _completed;

        internal DocumentExportResourceBudgets Budgets { get; } = budgets;
        internal long FileBytesBudget { get; } = fileBytesBudget;

        internal void Observe(long cpuMicroseconds, int fileCount, long fileBytes,
            long inputBytes, long outputBytes, long standardOutputBytes, long standardErrorBytes)
        {
            if (_completed || cpuMicroseconds < 0 || fileCount < 0 || fileBytes < 0
                || inputBytes < 0 || outputBytes < 0 || standardOutputBytes < 0 || standardErrorBytes < 0)
            {
                throw new InvalidDataException("Document export stage resource observation is invalid.");
            }
            _cpu = Math.Max(_cpu, cpuMicroseconds);
            _files = Math.Max(_files, fileCount);
            _fileBytes = Math.Max(_fileBytes, fileBytes);
            _input = Math.Max(_input, inputBytes);
            _output = Math.Max(_output, outputBytes);
            _stdout = Math.Max(_stdout, standardOutputBytes);
            _stderr = Math.Max(_stderr, standardErrorBytes);
        }

        internal Exception? Complete(bool qualified)
        {
            lock (owner._sync)
            {
                if (_completed)
                {
                    throw new InvalidOperationException("Document export stage accounting was already finalized.");
                }
                _completed = true;
                owner._activeStage = false;
                owner._failed |= !qualified;
                owner._completedStages++;
                try
                {
                    owner._cpuMicroseconds = checked(owner._cpuMicroseconds + _cpu);
                    owner._files = checked(owner._files + _files);
                    owner._fileBytes = checked(owner._fileBytes + _fileBytes);
                    owner._inputBytes = checked(owner._inputBytes + _input);
                    owner._outputBytes = checked(owner._outputBytes + _output);
                    owner._standardOutputBytes = checked(owner._standardOutputBytes + _stdout);
                    owner._standardErrorBytes = checked(owner._standardErrorBytes + _stderr);
                }
                catch (OverflowException)
                {
                    owner._failed = true;
                    return Budget("task-resource-accounting-overflow");
                }
                string? exceeded = owner._cpuMicroseconds > owner._maximum.CpuTime.Ticks / TimeSpan.TicksPerMicrosecond
                    ? "task-cpu-time-budget"
                    : owner._files > owner._maximum.MaxFileCount ? "task-file-count-budget"
                    : owner._fileBytes > owner._maximumMutableBytes ? "task-file-bytes-budget"
                    : owner._inputBytes > owner._maximum.MaxInputBytes ? "task-input-budget"
                    : owner._outputBytes > owner._maximum.MaxOutputBytes ? "task-output-budget"
                    : owner._standardOutputBytes > owner._maximum.MaxStandardOutputBytes ? "task-stdout-budget"
                    : owner._standardErrorBytes > owner._maximum.MaxStandardErrorBytes ? "task-stderr-budget"
                    : null;
                if (exceeded is not null)
                {
                    owner._failed = true;
                    return Budget(exceeded);
                }
                return null;
            }
        }

        public void Dispose()
        {
            if (!_completed)
            {
                _ = Complete(qualified: false);
            }
        }
    }
}
