using System.Collections.Immutable;
using System.Diagnostics;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed record LinuxBubblewrapWorkerOptions(
    string BubblewrapPath,
    string NodePath,
    string RuntimeLibraryRoot,
    string DynamicLoaderPath,
    string PrivateWorkingRoot,
    TimeSpan StartupTimeout);

[SupportedOSPlatform("linux")]
public sealed class LinuxBubblewrapAuthoringWorkerRuntime : IAuthoringWorkerSandboxRuntime
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    private const string RunnerSource = """
        import { readFileSync } from 'node:fs';
        import { createInterface } from 'node:readline';

        const moduleBytes = readFileSync('/runtime/module.wasm');
        const maximumMemoryBytes = Number(process.argv[2]);
        const maximumRequestBytes = Number(process.argv[3]);
        const maximumResponseBytes = Number(process.argv[4]);

        const readU32 = (bytes, start) => {
          let value = 0;
          let shift = 0;
          let offset = start;
          for (let count = 0; count < 5 && offset < bytes.length; count += 1) {
            const octet = bytes[offset++];
            value |= (octet & 0x7f) << shift;
            if ((octet & 0x80) === 0) return [value >>> 0, offset];
            shift += 7;
          }
          throw new Error('wasm-u32-invalid');
        };
        const inspectMemoryPolicy = (bytes) => {
          if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 ||
              bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error('wasm-header-invalid');
          let offset = 8;
          let memories = 0;
          while (offset < bytes.length) {
            const sectionId = bytes[offset++];
            let sectionLength;
            [sectionLength, offset] = readU32(bytes, offset);
            const end = offset + sectionLength;
            if (end > bytes.length) throw new Error('wasm-section-outside-boundary');
            if (sectionId === 5) {
              let count;
              [count, offset] = readU32(bytes, offset);
              memories += count;
              if (count !== 1) throw new Error('wasm-memory-count-invalid');
              let flags;
              [flags, offset] = readU32(bytes, offset);
              if ((flags & ~0x03) !== 0 || (flags & 0x01) === 0 || (flags & 0x02) !== 0) {
                throw new Error('wasm-memory-policy-invalid');
              }
              let minimumPages;
              let maximumPages;
              [minimumPages, offset] = readU32(bytes, offset);
              [maximumPages, offset] = readU32(bytes, offset);
              if (minimumPages * 65536 > maximumMemoryBytes || maximumPages * 65536 > maximumMemoryBytes) {
                throw new Error('wasm-memory-outside-budget');
              }
              if (offset !== end) throw new Error('wasm-memory-section-invalid');
            }
            offset = end;
          }
          if (memories !== 1) throw new Error('wasm-memory-count-invalid');
        };
        inspectMemoryPolicy(moduleBytes);
        const module = await WebAssembly.compile(moduleBytes);
        const imports = WebAssembly.Module.imports(module);
        if (imports.length !== 0) throw new Error('wasm-imports-not-empty');
        const instance = await WebAssembly.instantiate(module, Object.freeze({}));
        const { memory, fsus_alloc: allocate, fsus_execute: execute } = instance.exports;
        if (!(memory instanceof WebAssembly.Memory) || typeof allocate !== 'function' || typeof execute !== 'function') {
          throw new Error('wasm-abi-missing');
        }
        if (memory.buffer.byteLength > maximumMemoryBytes ||
            (typeof SharedArrayBuffer !== 'undefined' && memory.buffer instanceof SharedArrayBuffer)) {
          throw new Error('wasm-memory-outside-budget');
        }

        const loadState = instance.exports.fsus_state_load;
        const readState = instance.exports.fsus_state_snapshot;
        const stateSnapshotVersion = typeof loadState === 'function' && typeof readState === 'function' ? 1 : 0;
        let acceptedStateBinding = null;
        const readStoredState = () => {
          const packed = readState();
          if (typeof packed !== 'bigint') throw new Error('state-result-not-i64');
          const pointer = Number((packed >> 32n) & 0xffffffffn);
          const length = Number(packed & 0xffffffffn);
          if (memory.buffer.byteLength > maximumMemoryBytes || length > maximumResponseBytes ||
              pointer + length > memory.buffer.byteLength) throw new Error('state-readback-outside-boundary');
          return Buffer.from(new Uint8Array(memory.buffer, pointer, length));
        };

        const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
        write({
          kind: 'ready',
          dom: false,
          hostPrivateObjects: false,
          network: false,
          fileSystem: false,
          process: false,
          database: false,
          sharedMemory: false,
          recursiveWorkerSpawn: false,
          imports: [],
          globals: ['WebAssembly', 'TextEncoder', 'TextDecoder'],
          initialMemoryBytes: memory.buffer.byteLength,
          stateSnapshotVersion,
        });

        const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
        for await (const line of lines) {
          try {
            if (line.length > maximumRequestBytes * 2 + 4096) throw new Error('request-frame-outside-budget');
            const request = structuredClone(JSON.parse(line));
            if (request.kind === 'state-load' || request.kind === 'state-verify') {
              if (stateSnapshotVersion !== 1 || request.schemaVersion !== 1 ||
                  typeof request.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(request.nonce)) {
                throw new Error('state-protocol-unavailable-or-invalid');
              }
              const load = request.kind === 'state-load';
              const allowed = load ? ['kind', 'schemaVersion', 'nonce', 'binding', 'payload'] : ['kind', 'schemaVersion', 'nonce'];
              if (Object.keys(request).length !== allowed.length || Object.keys(request).some(key => !allowed.includes(key))) {
                throw new Error('state-frame-not-closed');
              }
              if (load) {
                acceptedStateBinding = null;
                if (typeof request.binding !== 'string' || request.binding.length > 4096 ||
                    typeof request.payload !== 'string') throw new Error('state-load-frame-invalid');
                const payload = Buffer.from(request.payload, 'base64');
                if (payload.toString('base64') !== request.payload || payload.byteLength > maximumRequestBytes ||
                    payload.byteLength > maximumResponseBytes) throw new Error('state-load-outside-budget');
                const pointer = Number(allocate(payload.byteLength));
                if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer + payload.byteLength > memory.buffer.byteLength) {
                  throw new Error('state-load-memory-outside-boundary');
                }
                new Uint8Array(memory.buffer, pointer, payload.byteLength).set(payload);
                if (loadState(pointer, payload.byteLength) !== 1 || !readStoredState().equals(payload)) {
                  throw new Error('state-load-not-adopted');
                }
                acceptedStateBinding = request.binding;
              }
              if (acceptedStateBinding === null) throw new Error('state-not-loaded');
              const stored = readStoredState();
              write({ kind: load ? 'state-accepted' : 'state-current', schemaVersion: 1,
                nonce: request.nonce, binding: acceptedStateBinding, payload: stored.toString('base64') });
              continue;
            }
            if (request.kind !== 'execute' || request.schemaVersion !== 1 || typeof request.payload !== 'string') {
              throw new Error('request-frame-invalid');
            }
            const payload = Buffer.from(request.payload, 'base64');
            if (payload.byteLength > maximumRequestBytes) throw new Error('request-payload-outside-budget');
            const pointer = Number(allocate(payload.byteLength));
            if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer + payload.byteLength > memory.buffer.byteLength) {
              throw new Error('request-memory-outside-boundary');
            }
            new Uint8Array(memory.buffer, pointer, payload.byteLength).set(payload);
            const packed = execute(pointer, payload.byteLength);
            if (typeof packed !== 'bigint') throw new Error('wasm-result-not-i64');
            const resultPointer = Number((packed >> 32n) & 0xffffffffn);
            const resultLength = Number(packed & 0xffffffffn);
            if (memory.buffer.byteLength > maximumMemoryBytes || resultLength > maximumResponseBytes ||
                resultPointer + resultLength > memory.buffer.byteLength) {
              throw new Error('result-memory-outside-boundary');
            }
            const result = Buffer.from(new Uint8Array(memory.buffer, resultPointer, resultLength));
            write({
              kind: 'result',
              schemaVersion: request.schemaVersion,
              runtimeIdentity: request.runtimeIdentity,
              requestId: request.requestId,
              resultSchemaReference: request.resultSchemaReference,
              payload: result.toString('base64'),
            });
          } catch (error) {
            write({ kind: 'error', stableReason: error instanceof Error ? error.message : 'worker-failed' });
          }
        }
        """;

    private readonly LinuxBubblewrapWorkerOptions _options;

    public LinuxBubblewrapAuthoringWorkerRuntime(LinuxBubblewrapWorkerOptions options)
    {
        ValidateOptions(options);
        _options = options;
    }

    public async ValueTask<IAuthoringWorkerSandboxInstance> StartAsync(
        AuthoringWorkerLaunchDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        ValidateDescriptor(descriptor);
        string instanceRoot = Path.Combine(
            _options.PrivateWorkingRoot,
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)));
        Directory.CreateDirectory(instanceRoot, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        string modulePath = Path.Combine(instanceRoot, "module.wasm");
        string runnerPath = Path.Combine(instanceRoot, "runner.mjs");
        await File.WriteAllBytesAsync(modulePath, [.. descriptor.ModuleBytes], cancellationToken);
        await File.WriteAllTextAsync(runnerPath, RunnerSource, Encoding.UTF8, cancellationToken);
        File.SetUnixFileMode(modulePath, UnixFileMode.UserRead);
        File.SetUnixFileMode(runnerPath, UnixFileMode.UserRead);

        Process process;
        try
        {
            process = Process.Start(CreateStartInfo(descriptor, modulePath, runnerPath)) ??
                throw new AuthoringExtensionContractException("Worker sandbox process did not start.");
        }
        catch
        {
            TryDeleteInstanceRoot(instanceRoot);
            throw;
        }

        Process? sandboxProcess = null;
        try
        {
            Task stderrDrain = process.StandardError.BaseStream.CopyToAsync(Stream.Null, CancellationToken.None);
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            startup.CancelAfter(_options.StartupTimeout);
            string? readyLine = await ReadClosedLineAsync(
                process.StandardOutput,
                Math.Max(descriptor.MaximumRequestBytes, descriptor.MaximumResponseBytes) * 2 + 4096,
                startup.Token);
            WorkerRunnerMessage ready = ParseMessage(
                readyLine,
                Math.Max(descriptor.MaximumRequestBytes, descriptor.MaximumResponseBytes));
            if (!string.Equals(ready.Kind, "ready", StringComparison.Ordinal) ||
                ready.InitialMemoryBytes is < 1 || ready.InitialMemoryBytes > descriptor.MaximumMemoryBytes)
            {
                throw new AuthoringExtensionContractException("Worker runtime did not complete its bounded module readiness probe.");
            }

            int sandboxProcessId = FindSandboxProcessId(process.Id);
            sandboxProcess = Process.GetProcessById(sandboxProcessId);
            ulong processStartTicks = AuthoringRuntimeIncarnationLease.ReadStartTicks(sandboxProcessId);
            string namespaceIdentity = ObserveNamespaceIsolation(sandboxProcessId);
            string profileIdentity = ComputeProfileIdentity(descriptor, namespaceIdentity);
            var capabilities = new AuthoringWorkerCapabilityReport(
                ready.Dom,
                ready.HostPrivateObjects,
                ready.Network,
                ready.FileSystem,
                ready.Process,
                ready.Database,
                ready.SharedMemory,
                ready.RecursiveWorkerSpawn,
                ready.Imports,
                ready.Globals,
                true,
                profileIdentity);
            var instance = new LinuxBubblewrapWorkerInstance(
                process,
                sandboxProcessId,
                sandboxProcess,
                processStartTicks,
                instanceRoot,
                descriptor,
                capabilities,
                s_json,
                stderrDrain)
            {
                StateSnapshotSupported = ready.StateSnapshotVersion == 1
            };
            instance.IssueIncarnation();
            return instance;
        }
        catch
        {
            await TerminateProcessTreeAsync(process);
            sandboxProcess?.Dispose();
            process.Dispose();
            TryDeleteInstanceRoot(instanceRoot);
            throw;
        }
    }

    private ProcessStartInfo CreateStartInfo(
        AuthoringWorkerLaunchDescriptor descriptor,
        string modulePath,
        string runnerPath)
    {
        var start = new ProcessStartInfo(_options.BubblewrapPath)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (string argument in new[]
        {
            "--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
            "--dir", "/runtime", "--dir", "/usr", "--dir", "/usr/lib", "--dir", "/usr/lib/x86_64-linux-gnu",
            "--dir", "/lib64", "--tmpfs", "/tmp",
            "--ro-bind", Path.GetFullPath(_options.NodePath), "/runtime/node",
            "--ro-bind", Path.GetFullPath(runnerPath), "/runtime/runner.mjs",
            "--ro-bind", Path.GetFullPath(modulePath), "/runtime/module.wasm",
            "--ro-bind", Path.GetFullPath(_options.RuntimeLibraryRoot), "/usr/lib/x86_64-linux-gnu",
            "--ro-bind", Path.GetFullPath(_options.DynamicLoaderPath), "/lib64/ld-linux-x86-64.so.2",
            "--chdir", "/runtime", "/runtime/node", "/runtime/runner.mjs",
            descriptor.MaximumMemoryBytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
            descriptor.MaximumRequestBytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
            descriptor.MaximumResponseBytes.ToString(System.Globalization.CultureInfo.InvariantCulture)
        })
        {
            start.ArgumentList.Add(argument);
        }

        return start;
    }

    private string ComputeProfileIdentity(
        AuthoringWorkerLaunchDescriptor descriptor,
        string namespaceIdentity)
    {
        string material = string.Join('\n',
            ComputeFileDigest(_options.BubblewrapPath),
            ComputeFileDigest(_options.NodePath),
            descriptor.ContentSha256,
            descriptor.ModuleSha256,
            descriptor.InstanceIdentity,
            descriptor.HostApiDigest,
            descriptor.SchemaDigest,
            descriptor.PolicyDigest,
            descriptor.MaximumMemoryBytes,
            descriptor.MaximumRequestBytes,
            descriptor.MaximumResponseBytes,
            namespaceIdentity,
            "bubblewrap/unshare-all/no-wasi/empty-imports/v1");
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
    }

    private static string ObserveNamespaceIsolation(int processId)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("The bubblewrap authoring worker is Linux-only.");
        }

        string[] namespaces = ["mnt", "net", "pid", "user"];
        string[] observed = [.. namespaces.Select(name => File.ResolveLinkTarget(
            $"/proc/{processId}/ns/{name}",
            false)?.Name ?? string.Empty)];
        string[] host = [.. namespaces.Select(name => File.ResolveLinkTarget(
            $"/proc/self/ns/{name}",
            false)?.Name ?? string.Empty)];
        if (observed.Any(string.IsNullOrWhiteSpace) || observed.SequenceEqual(host))
        {
            throw new AuthoringExtensionContractException("Worker process namespace isolation was not observable.");
        }

        return string.Join('|', namespaces.Zip(observed, static (name, identity) => $"{name}={identity}"));
    }

    private static int FindSandboxProcessId(int processId)
    {
        int current = processId;
        for (int depth = 0; depth < 8; depth++)
        {
            string childrenPath = $"/proc/{current}/task/{current}/children";
            if (!File.Exists(childrenPath))
            {
                break;
            }

            int[] children = [.. File.ReadAllText(childrenPath)
                .Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .Select(static value => int.Parse(value, System.Globalization.CultureInfo.InvariantCulture))];
            if (children.Length == 0)
            {
                break;
            }

            if (children.Length != 1)
            {
                throw new AuthoringExtensionContractException("Worker sandbox process ownership is ambiguous.");
            }

            current = children[0];
        }

        return current;
    }

    private static WorkerRunnerMessage ParseMessage(string? line, int maximumMessageBytes)
    {
        if (string.IsNullOrEmpty(line) || Encoding.UTF8.GetByteCount(line) > maximumMessageBytes * 2 + 4096)
        {
            throw new AuthoringExtensionContractException("Worker protocol frame is missing or outside its bound.");
        }

        try
        {
            return JsonSerializer.Deserialize<WorkerRunnerMessage>(line, s_json) ??
                throw new AuthoringExtensionContractException("Worker protocol frame is empty.");
        }
        catch (JsonException exception)
        {
            throw new AuthoringExtensionContractException($"Worker protocol frame is not closed JSON: {exception.Message}");
        }
    }

    private static async ValueTask<string?> ReadClosedLineAsync(
        StreamReader reader,
        int maximumCharacters,
        CancellationToken cancellationToken)
    {
        var result = new StringBuilder(Math.Min(maximumCharacters, 4096));
        char[] character = new char[1];
        while (true)
        {
            int read = await reader.ReadAsync(character.AsMemory(), cancellationToken);
            if (read == 0)
            {
                return result.Length == 0 ? null : result.ToString();
            }

            if (character[0] == '\n')
            {
                return result.ToString();
            }

            if (character[0] > 0x7f || (character[0] != '\r' && result.Length >= maximumCharacters))
            {
                throw new AuthoringExtensionContractException("Worker protocol frame is non-ASCII or outside its bound.");
            }

            if (character[0] != '\r')
            {
                result.Append(character[0]);
            }
        }
    }

    private static string ComputeFileDigest(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    private static void ValidateOptions(LinuxBubblewrapWorkerOptions options)
    {
        if (!OperatingSystem.IsLinux() || options is null ||
            !IsAbsoluteFile(options.BubblewrapPath) || !IsAbsoluteFile(options.NodePath) ||
            !Directory.Exists(options.RuntimeLibraryRoot) || !IsAbsoluteFile(options.DynamicLoaderPath) ||
            !Path.IsPathFullyQualified(options.PrivateWorkingRoot) ||
            Path.GetPathRoot(options.PrivateWorkingRoot) == Path.TrimEndingDirectorySeparator(options.PrivateWorkingRoot) ||
            options.StartupTimeout <= TimeSpan.Zero || options.StartupTimeout > TimeSpan.FromSeconds(30))
        {
            throw new AuthoringExtensionContractException("Linux worker runtime profile is unavailable, broad, or unbounded.");
        }

        Directory.CreateDirectory(
            options.PrivateWorkingRoot,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        File.SetUnixFileMode(
            options.PrivateWorkingRoot,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    private static bool IsAbsoluteFile(string path) =>
        Path.IsPathFullyQualified(path) && File.Exists(path);

    private static void ValidateDescriptor(AuthoringWorkerLaunchDescriptor descriptor)
    {
        if (descriptor is null || descriptor.ModuleBytes.IsDefaultOrEmpty || !IsDigest(descriptor.RuntimeIdentity) ||
            !IsDigest(descriptor.InstanceIdentity) ||
            !IsDigest(descriptor.PackageSha256) || !IsDigest(descriptor.ContentSha256) ||
            !IsDigest(descriptor.ModuleSha256) || !IsDigest(descriptor.HostApiDigest) ||
            !IsDigest(descriptor.SchemaDigest) || !IsDigest(descriptor.PolicyDigest) ||
            descriptor.MaximumMemoryBytes is < 65_536 or > 536_870_912 ||
            descriptor.MaximumRequestBytes is < 1 or > 16_777_216 ||
            descriptor.MaximumResponseBytes is < 1 or > 16_777_216 ||
            !CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(descriptor.ModuleBytes.AsSpan()),
                Convert.FromHexString(descriptor.ModuleSha256)))
        {
            throw new AuthoringExtensionContractException("Worker runtime descriptor is missing, tampered, or outside its bound.");
        }
    }

    private static bool IsDigest(string? value) =>
        value is not null && value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static async ValueTask TerminateProcessTreeAsync(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(true);
                await process.WaitForExitAsync();
            }
        }
        catch (InvalidOperationException) when (process.HasExited)
        {
        }
    }

    private static void TryDeleteInstanceRoot(string instanceRoot)
    {
        try
        {
            if (Directory.Exists(instanceRoot))
            {
                Directory.Delete(instanceRoot, true);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private sealed record WorkerRunnerMessage(
        string Kind,
        bool Dom = false,
        bool HostPrivateObjects = false,
        bool Network = false,
        bool FileSystem = false,
        bool Process = false,
        bool Database = false,
        bool SharedMemory = false,
        bool RecursiveWorkerSpawn = false,
        ImmutableArray<string> Imports = default,
        ImmutableArray<string> Globals = default,
        long InitialMemoryBytes = 0,
        int SchemaVersion = 0,
        string? RuntimeIdentity = null,
        string? RequestId = null,
        string? ResultSchemaReference = null,
        string? Payload = null,
        string? StableReason = null,
        int StateSnapshotVersion = 0,
        string? Nonce = null,
        string? Binding = null);

    internal static bool OwnsNativeCustody(
        object owner,
        object descriptor,
        object authority,
        Process custody,
        Process sandbox,
        ulong startTicks,
        string profileIdentity) =>
        owner is LinuxBubblewrapWorkerInstance native &&
        native.OwnsNativeCustody(descriptor, authority, custody, sandbox, startTicks, profileIdentity);

    internal static bool OwnsSnapshotLoad(object owner, object authority, AuthoringNativeStateSnapshotBinding binding) =>
        owner is LinuxBubblewrapWorkerInstance native && native.OwnsSnapshotLoad(authority, binding);

    internal static ValueTask VerifySnapshotAcceptanceAsync(object owner, AuthoringNativeStateSnapshotAcceptance acceptance,
        AuthoringNativeStateSnapshotBinding binding, CancellationToken cancellationToken) =>
        owner is LinuxBubblewrapWorkerInstance native
            ? native.VerifySnapshotAcceptanceAsync(acceptance, binding, cancellationToken)
            : ValueTask.FromException(new AuthoringExtensionContractException("Original native snapshot owner is required."));

    internal static void ReleaseSnapshotAcceptance(object owner, AuthoringNativeStateSnapshotAcceptance acceptance)
    {
        if (owner is not LinuxBubblewrapWorkerInstance native)
        {
            throw new AuthoringExtensionContractException("Original native snapshot owner is required.");
        }
        native.ReleaseSnapshotAcceptance(acceptance);
    }

    private sealed class LinuxBubblewrapWorkerInstance(
        Process process,
        int sandboxProcessId,
        Process sandboxProcess,
        ulong processStartTicks,
        string instanceRoot,
        AuthoringWorkerLaunchDescriptor descriptor,
        AuthoringWorkerCapabilityReport capabilityReport,
        JsonSerializerOptions json,
        Task stderrDrain) : IAuthoringWorkerSandboxInstance, IAuthoringMeasuredRuntimeInstance
    {
        private readonly SemaphoreSlim _messageLock = new(1, 1);
        private bool _terminated;
        private readonly SemaphoreSlim _lifecycleLock = new(1, 1);
        private readonly object _incarnationOwner = new();
        private AuthoringRuntimeIncarnationLease? _incarnation;
        private bool _disposed;

        public void IssueIncarnation() =>
            _incarnation = AuthoringRuntimeIncarnationLease.Issue(
                this, descriptor, _incarnationOwner, process, sandboxProcess, processStartTicks, capabilityReport.RuntimeProfileSha256);

        public bool OwnsNativeCustody(
            object candidateDescriptor,
            object authority,
            Process custody,
            Process sandbox,
            ulong startTicks,
            string profileIdentity) =>
            _incarnation is null && ReferenceEquals(_incarnationOwner, authority) &&
            ReferenceEquals(descriptor, candidateDescriptor) && ReferenceEquals(process, custody) &&
            ReferenceEquals(sandboxProcess, sandbox) && processStartTicks == startTicks &&
            FindSandboxProcessId(process.Id) == sandboxProcessId &&
            string.Equals(profileIdentity, capabilityReport.RuntimeProfileSha256, StringComparison.Ordinal);

        public AuthoringWorkerCapabilityReport CapabilityReport { get; } = capabilityReport;

        public string RuntimeIdentity => descriptor.RuntimeIdentity;

        public int ProcessId => sandboxProcessId;

        public bool StateSnapshotSupported
        {
            private get; init;
        }
        private readonly Lock _snapshotGate = new();
        private bool _snapshotTransportHeld;
        private bool _snapshotIoActive;
        private AuthoringNativeStateSnapshotBinding? _pendingSnapshot;
        private AuthoringNativeStateSnapshotAcceptance? _snapshotAcceptance;

        public bool OwnsSnapshotLoad(object authority, AuthoringNativeStateSnapshotBinding binding) =>
            ReferenceEquals(authority, _incarnationOwner) && ReferenceEquals(_pendingSnapshot, binding) &&
            _snapshotAcceptance is null && !_terminated && _incarnation is not null &&
            _incarnation.IsCurrentOwner(this) && _messageLock.CurrentCount == 0;

        public async ValueTask<AuthoringNativeStateSnapshotAcceptance> AcceptStateSnapshotAsync(
            VerifiedAuthoringPackage package,
            AuthoringExecutionTarget target,
            AuthoringStateSnapshot appliedSnapshot,
            long runningGeneration,
            string operationSha256,
            CancellationToken cancellationToken)
        {
            AuthoringNativeStateSnapshotBinding binding = AuthoringNativeStateSnapshotBinding.Create(
                package, target, appliedSnapshot, runningGeneration, operationSha256, descriptor);
            await _messageLock.WaitAsync(cancellationToken);
            lock (_snapshotGate)
            {
                _snapshotTransportHeld = true;
                _snapshotIoActive = true;
            }
            bool transportStarted = false;
            bool handedOff = false;
            AuthoringNativeStateSnapshotAcceptance? issued = null;
            try
            {
                RequireSnapshotOwner();
                if (!StateSnapshotSupported)
                {
                    throw new AuthoringExtensionContractException("Native module has no actual snapshot storage protocol.");
                }

                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                deadline.CancelAfter(binding.MaximumWallClock);
                DateTimeOffset cutoff = DateTimeOffset.UtcNow + binding.MaximumWallClock;
                transportStarted = true;
                await ExchangeSnapshotAsync(binding, true, deadline.Token);
                // A load response alone cannot establish adoption. This request sends no state
                // bytes or expected digest: read the original instance's retained state afresh.
                await ExchangeSnapshotAsync(binding, false, deadline.Token);
                CheckSnapshotBoundary(deadline.Token, cutoff);
                _pendingSnapshot = binding;
                issued = AuthoringNativeStateSnapshotAcceptance.Issue(this, _incarnationOwner, _incarnation!, binding);
                _snapshotAcceptance = issued;
                _pendingSnapshot = null;
                CheckSnapshotBoundary(deadline.Token, cutoff);
                handedOff = true;
                return issued;
            }
            catch
            {
                try
                {
                    if (transportStarted)
                    {
                        _incarnation?.Revoke(this, _incarnationOwner);
                        _terminated = true;
                        EndSnapshotIo();
                        await TerminateAsync("snapshot-acceptance-failed", CancellationToken.None);
                    }
                }
                finally
                {
                    if (issued is not null)
                    {
                        await issued.DisposeAsync();
                    }
                }
                throw;
            }
            finally
            {
                _pendingSnapshot = null;
                EndSnapshotIo();
                if (!handedOff && issued is null)
                {
                    ReleaseSnapshotTransport();
                }
            }
        }

        public async ValueTask VerifySnapshotAcceptanceAsync(
            AuthoringNativeStateSnapshotAcceptance acceptance,
            AuthoringNativeStateSnapshotBinding binding,
            CancellationToken cancellationToken)
        {
            lock (_snapshotGate)
            {
                if (!ReferenceEquals(_snapshotAcceptance, acceptance) || !_snapshotTransportHeld || _snapshotIoActive)
                {
                    throw new AuthoringExtensionContractException("Snapshot lifetime does not belong to this native owner.");
                }
                RequireSnapshotOwner();
                _snapshotIoActive = true;
            }
            try
            {
                RequireSnapshotOwner();
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                deadline.CancelAfter(binding.MaximumWallClock);
                DateTimeOffset cutoff = DateTimeOffset.UtcNow + binding.MaximumWallClock;
                await ExchangeSnapshotAsync(binding, false, deadline.Token);
                CheckSnapshotBoundary(deadline.Token, cutoff);
            }
            catch
            {
                _incarnation?.Revoke(this, _incarnationOwner);
                _terminated = true;
                EndSnapshotIo();
                await TerminateAsync("snapshot-custody-changed", CancellationToken.None);
                throw;
            }
            finally
            {
                EndSnapshotIo();
            }
        }

        public void ReleaseSnapshotAcceptance(AuthoringNativeStateSnapshotAcceptance acceptance)
        {
            lock (_snapshotGate)
            {
                if (!ReferenceEquals(_snapshotAcceptance, acceptance) || _snapshotIoActive)
                {
                    throw new AuthoringExtensionContractException("Foreign or in-flight snapshot lifetime cannot release native exclusion.");
                }
                _snapshotAcceptance = null;
                ReleaseSnapshotTransport();
            }
        }

        private void ReleaseSnapshotTransport()
        {
            lock (_snapshotGate)
            {
                if (_snapshotTransportHeld && !_snapshotIoActive)
                {
                    _snapshotTransportHeld = false;
                    _messageLock.Release();
                }
            }
        }

        private void EndSnapshotIo()
        {
            lock (_snapshotGate)
            {
                _snapshotIoActive = false;
                if (_terminated)
                {
                    ReleaseSnapshotTransport();
                }
            }
        }

        private void RequireSnapshotOwner()
        {
            if (_terminated || _incarnation is null || !_incarnation.IsCurrentOwner(this))
            {
                throw new AuthoringExtensionContractException("Native snapshot owner is terminated or revoked.");
            }
        }

        private void CheckSnapshotBoundary(CancellationToken token, DateTimeOffset cutoff)
        {
            token.ThrowIfCancellationRequested();
            if (DateTimeOffset.UtcNow >= cutoff)
            {
                throw new TimeoutException("Native snapshot operation exceeded its exclusive deadline.");
            }
            RequireSnapshotOwner();
        }

        private async ValueTask ExchangeSnapshotAsync(
            AuthoringNativeStateSnapshotBinding binding, bool load, CancellationToken cancellationToken)
        {
            string nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            string frame = load
                ? JsonSerializer.Serialize(new
                {
                    kind = "state-load",
                    schemaVersion = 1,
                    nonce,
                    binding = binding.TransportBinding,
                    payload = Convert.ToBase64String(binding.Bytes)
                }, json)
                : JsonSerializer.Serialize(new
                {
                    kind = "state-verify",
                    schemaVersion = 1,
                    nonce
                }, json);
            if (Encoding.UTF8.GetByteCount(frame) > descriptor.MaximumRequestBytes * 2 + 4096)
            {
                throw new AuthoringExtensionContractException("Native snapshot request exceeds the original transport budget.");
            }
            await process.StandardInput.WriteLineAsync(frame.AsMemory(), cancellationToken);
            await process.StandardInput.FlushAsync(cancellationToken);
            WorkerRunnerMessage response = ParseMessage(await ReadClosedLineAsync(process.StandardOutput,
                descriptor.MaximumResponseBytes * 2 + 4096, cancellationToken), descriptor.MaximumResponseBytes);
            if (response.Kind != (load ? "state-accepted" : "state-current") ||
                response.SchemaVersion != 1 || response.Nonce != nonce)
            {
                throw new AuthoringExtensionContractException("Native worker did not attest a fresh stored-state readback.");
            }
            binding.VerifyReadback(response.Binding, response.Payload);
        }

        public async ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken)
        {
            await _messageLock.WaitAsync(cancellationToken);
            try
            {
                if (_terminated || _incarnation is null || !_incarnation.IsCurrentOwner(this))
                {
                    throw new AuthoringExtensionContractException("Worker instance is terminated.");
                }

                string frame = JsonSerializer.Serialize(new
                {
                    kind = "execute",
                    request.SchemaVersion,
                    request.RuntimeIdentity,
                    request.RequestId,
                    request.ResultSchemaReference,
                    payload = Convert.ToBase64String(request.Payload.AsSpan())
                }, json);
                if (Encoding.UTF8.GetByteCount(frame) > descriptor.MaximumRequestBytes * 2 + 4096)
                {
                    throw new AuthoringExtensionContractException("Worker request frame is outside its bound.");
                }

                await process.StandardInput.WriteLineAsync(frame.AsMemory(), cancellationToken);
                await process.StandardInput.FlushAsync(cancellationToken);
                string? line = await ReadClosedLineAsync(
                    process.StandardOutput,
                    descriptor.MaximumResponseBytes * 2 + 4096,
                    cancellationToken);
                WorkerRunnerMessage message = ParseMessage(line, descriptor.MaximumResponseBytes);
                if (!string.Equals(message.Kind, "result", StringComparison.Ordinal) || message.Payload is null ||
                    message.RuntimeIdentity is null || message.RequestId is null || message.ResultSchemaReference is null)
                {
                    throw new AuthoringExtensionContractException(
                        $"Worker module rejected the closed request: {message.StableReason ?? "worker-failed"}.");
                }

                byte[] payload = Convert.FromBase64String(message.Payload);
                if (payload.Length > descriptor.MaximumResponseBytes)
                {
                    throw new AuthoringExtensionContractException("Worker result payload is outside its bound.");
                }

                return new AuthoringWorkerResponse(
                    message.SchemaVersion,
                    message.RuntimeIdentity,
                    message.RequestId,
                    message.ResultSchemaReference,
                    [.. payload]);
            }
            finally
            {
                _messageLock.Release();
            }
        }

        public async ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            // Revocation precedes every await, including failed or cancelled cleanup attempts.
            _incarnation?.Revoke(this, _incarnationOwner);
            _terminated = true;
            ReleaseSnapshotTransport();
            await _lifecycleLock.WaitAsync(CancellationToken.None);
            try
            {
                if (!_disposed)
                {
                    await TerminateProcessTreeAsync(process);
                    _incarnation?.ConfirmProcessExited(this, _incarnationOwner);
                }
            }
            finally
            {
                _lifecycleLock.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            _incarnation?.Revoke(this, _incarnationOwner);
            _terminated = true;
            ReleaseSnapshotTransport();
            await _lifecycleLock.WaitAsync(CancellationToken.None);
            try
            {
                if (_disposed)
                {
                    return;
                }

                await TerminateProcessTreeAsync(process);
                _incarnation?.ConfirmProcessExited(this, _incarnationOwner);
                await stderrDrain;
                await _messageLock.WaitAsync(CancellationToken.None);
                try
                {
                    TryDeleteInstanceRoot(instanceRoot);
                    if (Directory.Exists(instanceRoot))
                    {
                        throw new IOException("Native runtime working root cleanup has not settled.");
                    }

                    process.Dispose();
                    _incarnation?.ReleaseCustody(this, _incarnationOwner);
                    _disposed = true;
                }
                finally
                {
                    _messageLock.Release();
                }
            }
            finally
            {
                _lifecycleLock.Release();
            }
        }
    }
}
