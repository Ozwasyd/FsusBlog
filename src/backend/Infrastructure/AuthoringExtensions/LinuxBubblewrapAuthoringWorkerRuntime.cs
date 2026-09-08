using System.Collections.Immutable;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Runtime.Versioning;
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
        const maximumMessageBytes = Number(process.argv[3]);
        const module = await WebAssembly.compile(moduleBytes);
        const imports = WebAssembly.Module.imports(module);
        if (imports.length !== 0) throw new Error('wasm-imports-not-empty');
        const instance = await WebAssembly.instantiate(module, Object.freeze({}));
        const { memory, fsus_alloc: allocate, fsus_execute: execute } = instance.exports;
        if (!(memory instanceof WebAssembly.Memory) || typeof allocate !== 'function' || typeof execute !== 'function') {
          throw new Error('wasm-abi-missing');
        }
        if (memory.buffer.byteLength > maximumMemoryBytes) throw new Error('wasm-memory-outside-budget');

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
        });

        const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
        for await (const line of lines) {
          try {
            if (line.length > maximumMessageBytes * 2 + 4096) throw new Error('request-frame-outside-budget');
            const request = structuredClone(JSON.parse(line));
            if (request.kind !== 'execute' || request.schemaVersion !== 1 || typeof request.payload !== 'string') {
              throw new Error('request-frame-invalid');
            }
            const payload = Buffer.from(request.payload, 'base64');
            if (payload.byteLength > maximumMessageBytes) throw new Error('request-payload-outside-budget');
            const pointer = Number(allocate(payload.byteLength));
            if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer + payload.byteLength > memory.buffer.byteLength) {
              throw new Error('request-memory-outside-boundary');
            }
            new Uint8Array(memory.buffer, pointer, payload.byteLength).set(payload);
            const packed = execute(pointer, payload.byteLength);
            if (typeof packed !== 'bigint') throw new Error('wasm-result-not-i64');
            const resultPointer = Number((packed >> 32n) & 0xffffffffn);
            const resultLength = Number(packed & 0xffffffffn);
            if (memory.buffer.byteLength > maximumMemoryBytes || resultLength > maximumMessageBytes ||
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
        await File.WriteAllBytesAsync(modulePath, descriptor.ModuleBytes.ToArray(), cancellationToken);
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

        try
        {
            Task stderrDrain = process.StandardError.BaseStream.CopyToAsync(Stream.Null, CancellationToken.None);
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            startup.CancelAfter(_options.StartupTimeout);
            string? readyLine = await ReadClosedLineAsync(
                process.StandardOutput,
                descriptor.MaximumMessageBytes * 2 + 4096,
                startup.Token);
            WorkerRunnerMessage ready = ParseMessage(readyLine, descriptor.MaximumMessageBytes);
            if (!string.Equals(ready.Kind, "ready", StringComparison.Ordinal) ||
                ready.InitialMemoryBytes is < 1 || ready.InitialMemoryBytes > descriptor.MaximumMemoryBytes)
            {
                throw new AuthoringExtensionContractException("Worker runtime did not complete its bounded module readiness probe.");
            }

            string namespaceIdentity = ObserveNamespaceIsolation(FindSandboxProcessId(process.Id));
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
            return new LinuxBubblewrapWorkerInstance(
                process,
                instanceRoot,
                descriptor,
                capabilities,
                s_json,
                stderrDrain);
        }
        catch
        {
            await TerminateProcessTreeAsync(process);
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
            descriptor.MaximumMessageBytes.ToString(System.Globalization.CultureInfo.InvariantCulture)
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
            descriptor.HostApiDigest,
            descriptor.SchemaDigest,
            descriptor.PolicyDigest,
            descriptor.MaximumMemoryBytes,
            descriptor.MaximumMessageBytes,
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
        string[] observed = namespaces.Select(name => File.ResolveLinkTarget(
            $"/proc/{processId}/ns/{name}",
            false)?.Name ?? string.Empty).ToArray();
        string[] host = namespaces.Select(name => File.ResolveLinkTarget(
            $"/proc/self/ns/{name}",
            false)?.Name ?? string.Empty).ToArray();
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

            int[] children = File.ReadAllText(childrenPath)
                .Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .Select(static value => int.Parse(value, System.Globalization.CultureInfo.InvariantCulture))
                .ToArray();
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
            !IsDigest(descriptor.PackageSha256) || !IsDigest(descriptor.ContentSha256) ||
            !IsDigest(descriptor.ModuleSha256) || !IsDigest(descriptor.HostApiDigest) ||
            !IsDigest(descriptor.SchemaDigest) || !IsDigest(descriptor.PolicyDigest) ||
            descriptor.MaximumMemoryBytes is < 65_536 or > 536_870_912 ||
            descriptor.MaximumMessageBytes is < 1 or > 16_777_216 ||
            !CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(descriptor.ModuleBytes.AsSpan()),
                Convert.FromHexString(descriptor.ModuleSha256)))
        {
            throw new AuthoringExtensionContractException("Worker runtime descriptor is missing, tampered, or outside its bound.");
        }
    }

    private static bool IsDigest(string value) =>
        value.Length == 64 && value.All(static character =>
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
        catch (InvalidOperationException)
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
        string? StableReason = null);

    private sealed class LinuxBubblewrapWorkerInstance(
        Process process,
        string instanceRoot,
        AuthoringWorkerLaunchDescriptor descriptor,
        AuthoringWorkerCapabilityReport capabilityReport,
        JsonSerializerOptions json,
        Task stderrDrain) : IAuthoringWorkerSandboxInstance
    {
        private readonly SemaphoreSlim _messageLock = new(1, 1);
        private bool _terminated;

        public AuthoringWorkerCapabilityReport CapabilityReport { get; } = capabilityReport;

        public async ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken)
        {
            await _messageLock.WaitAsync(cancellationToken);
            try
            {
                if (_terminated || process.HasExited)
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
                if (Encoding.UTF8.GetByteCount(frame) > descriptor.MaximumMessageBytes * 2 + 4096)
                {
                    throw new AuthoringExtensionContractException("Worker request frame is outside its bound.");
                }

                await process.StandardInput.WriteLineAsync(frame.AsMemory(), cancellationToken);
                await process.StandardInput.FlushAsync(cancellationToken);
                string? line = await ReadClosedLineAsync(
                    process.StandardOutput,
                    descriptor.MaximumMessageBytes * 2 + 4096,
                    cancellationToken);
                WorkerRunnerMessage message = ParseMessage(line, descriptor.MaximumMessageBytes);
                if (!string.Equals(message.Kind, "result", StringComparison.Ordinal) || message.Payload is null ||
                    message.RuntimeIdentity is null || message.RequestId is null || message.ResultSchemaReference is null)
                {
                    throw new AuthoringExtensionContractException(
                        $"Worker module rejected the closed request: {message.StableReason ?? "worker-failed"}.");
                }

                byte[] payload = Convert.FromBase64String(message.Payload);
                if (payload.Length > descriptor.MaximumMessageBytes)
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
            _terminated = true;
            await TerminateProcessTreeAsync(process);
        }

        public async ValueTask DisposeAsync()
        {
            await TerminateAsync("dispose", CancellationToken.None);
            await stderrDrain;
            process.Dispose();
            _messageLock.Dispose();
            TryDeleteInstanceRoot(instanceRoot);
        }
    }
}
