using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed record LinuxBubblewrapServiceOptions(
    string PrlimitPath,
    string BubblewrapPath,
    string PrivateWorkingRoot,
    TimeSpan StartupTimeout);

[SupportedOSPlatform("linux")]
public sealed class LinuxBubblewrapAuthoringServiceRuntime : IAuthoringServiceProcessRuntime
{
    private readonly LinuxBubblewrapServiceOptions _options;

    public LinuxBubblewrapAuthoringServiceRuntime(LinuxBubblewrapServiceOptions options)
    {
        ValidateOptions(options);
        _options = options;
    }

    public async ValueTask<IAuthoringServiceProcess> StartAsync(
        AuthoringServiceLaunchDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        ValidateDescriptor(descriptor);
        string instanceRoot = Path.Combine(
            _options.PrivateWorkingRoot,
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)));
        Directory.CreateDirectory(instanceRoot, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        string executablePath = Path.Combine(instanceRoot, "extension-service");
        await File.WriteAllBytesAsync(executablePath, descriptor.ExecutableBytes.ToArray(), cancellationToken);
        File.SetUnixFileMode(
            executablePath,
            UnixFileMode.UserRead | UnixFileMode.UserExecute);

        Process process;
        try
        {
            process = Process.Start(CreateStartInfo(descriptor, executablePath)) ??
                throw new AuthoringExtensionContractException("Authoring service process did not start.");
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
            string? readyLine = await ReadClosedLineAsync(process.StandardOutput, 4096, startup.Token);
            AuthoringServiceHealthReport health = ParseHealth(readyLine);
            int serviceProcessId = FindSandboxProcessId(process.Id);
            sandboxProcess = Process.GetProcessById(serviceProcessId);
            ulong processStartTicks = AuthoringRuntimeIncarnationLease.ReadStartTicks(serviceProcessId);
            string namespaceIdentity = ObserveNamespaceIsolation(serviceProcessId);
            ObserveOwnedSession(serviceProcessId);
            string isolationIdentity = ComputeProfileIdentity(descriptor, namespaceIdentity);
            var instance = new LinuxBubblewrapServiceProcess(
                process,
                serviceProcessId,
                sandboxProcess,
                processStartTicks,
                instanceRoot,
                descriptor,
                health,
                new AuthoringProcessOwnershipReport(
                    AuthoringProcessOwnershipMechanism.PosixProcessGroup,
                    true,
                    true,
                    isolationIdentity),
                stderrDrain)
            {
                StateSnapshotSupported = readyLine?.EndsWith("\tstate-snapshot-v1", StringComparison.Ordinal) == true
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
        AuthoringServiceLaunchDescriptor descriptor,
        string executablePath)
    {
        var start = new ProcessStartInfo(_options.PrlimitPath)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        int cpuSeconds = Math.Max(1, (int)Math.Ceiling(descriptor.MaximumWallClock.TotalSeconds));
        foreach (string argument in new[]
        {
            $"--as={descriptor.MaximumMemoryBytes}",
            $"--cpu={cpuSeconds}",
            "--nofile=32", "--",
            _options.BubblewrapPath,
            "--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
            "--dir", "/service", "--tmpfs", "/tmp",
            "--ro-bind", Path.GetFullPath(executablePath), "/service/extension",
            "--chdir", "/service", "/service/extension",
            descriptor.RuntimeIdentity,
            descriptor.ExecutableSha256,
            descriptor.TransportSchemaReference,
            descriptor.ContentSha256,
            descriptor.GrantSetDigest
        })
        {
            start.ArgumentList.Add(argument);
        }

        return start;
    }

    private string ComputeProfileIdentity(
        AuthoringServiceLaunchDescriptor descriptor,
        string namespaceIdentity)
    {
        string material = string.Join('\n',
            ComputeFileDigest(_options.PrlimitPath),
            ComputeFileDigest(_options.BubblewrapPath),
            descriptor.ExecutableSha256,
            descriptor.ContentSha256,
            descriptor.GrantSetDigest,
            descriptor.MaximumMemoryBytes,
            descriptor.MaximumRequestBytes,
            descriptor.MaximumResponseBytes,
            descriptor.MaximumWallClock,
            namespaceIdentity,
            "prlimit/bubblewrap/unshare-all/static-elf/v1");
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
    }

    private static AuthoringServiceHealthReport ParseHealth(string? line)
    {
        string[] fields = (line ?? string.Empty).Split('\t');
        if ((fields.Length != 4 && fields.Length != 5) ||
            fields.Length == 5 && fields[4] != "state-snapshot-v1" || !string.Equals(fields[0], "READY", StringComparison.Ordinal) ||
            fields[1].Length != 64 || fields[2].Length != 64 ||
            !string.Equals(fields[3], "authoring-service-transport/v1", StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Service readiness handshake is missing or not closed.");
        }

        return new AuthoringServiceHealthReport(true, fields[1], fields[2], fields[3]);
    }

    private static AuthoringServiceResponse ParseResponse(
        string? line,
        int maximumResponseBytes)
    {
        if (string.IsNullOrEmpty(line) || Encoding.UTF8.GetByteCount(line) > maximumResponseBytes * 2 + 4096)
        {
            throw new AuthoringExtensionContractException("Service response frame is missing or outside its bound.");
        }

        string[] fields = line.Split('\t');
        if (fields.Length != 5 || !string.Equals(fields[0], "RESULT", StringComparison.Ordinal) ||
            !int.TryParse(fields[1], System.Globalization.CultureInfo.InvariantCulture, out int schemaVersion))
        {
            throw new AuthoringExtensionContractException("Service response frame is not closed or versioned.");
        }

        byte[] payload;
        try
        {
            payload = Convert.FromBase64String(fields[4]);
        }
        catch (FormatException)
        {
            throw new AuthoringExtensionContractException("Service response payload is not canonical base64.");
        }

        if (payload.Length > maximumResponseBytes)
        {
            throw new AuthoringExtensionContractException("Service response payload is outside its bound.");
        }

        return new AuthoringServiceResponse(schemaVersion, fields[2], fields[3], [.. payload]);
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
                throw new AuthoringExtensionContractException("Service protocol frame is non-ASCII or outside its bound.");
            }

            if (character[0] != '\r')
            {
                result.Append(character[0]);
            }
        }
    }

    private static string CreateRequestFrame(
        AuthoringServiceRequest request,
        AuthoringServiceLaunchDescriptor descriptor)
    {
        if (ContainsFrameDelimiter(request.RuntimeIdentity) || ContainsFrameDelimiter(request.RequestId) ||
            request.OpaqueGrantIds.Any(ContainsFrameDelimiter) ||
            !request.OpaqueGrantIds.SequenceEqual(descriptor.OpaqueGrantIds) ||
            !string.Equals(
                DigestIdentity(string.Join('\n', request.OpaqueGrantIds.Order(StringComparer.Ordinal))),
                descriptor.GrantSetDigest,
                StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Service request identity contains a transport delimiter.");
        }

        string frame = string.Join('\t',
            "EXEC",
            request.SchemaVersion,
            request.RuntimeIdentity,
            request.RequestId,
            string.Join(',', request.OpaqueGrantIds),
            Convert.ToBase64String(request.Payload.AsSpan()));
        if (Encoding.UTF8.GetByteCount(frame) > descriptor.MaximumRequestBytes * 2 + 4096)
        {
            throw new AuthoringExtensionContractException("Service request frame is outside its bound.");
        }

        return frame;
    }

    private static bool ContainsFrameDelimiter(string value) =>
        value.ContainsAny(['\t', '\r', '\n', ',']);

    private static void ValidateDescriptor(AuthoringServiceLaunchDescriptor descriptor)
    {
        if (descriptor is null || descriptor.ExecutableBytes.IsDefaultOrEmpty ||
            !IsDigest(descriptor.RuntimeIdentity) || !IsDigest(descriptor.PackageSha256) ||
            !IsDigest(descriptor.ContentSha256) || !IsDigest(descriptor.ExecutableSha256) ||
            !IsDigest(descriptor.GrantSetDigest) || descriptor.OpaqueGrantIds.IsDefault ||
            descriptor.OpaqueGrantIds.Length > 32 || descriptor.OpaqueGrantIds.Any(static id => !IsDigest(id)) ||
            !string.Equals(
                DigestIdentity(string.Join('\n', descriptor.OpaqueGrantIds.Order(StringComparer.Ordinal))),
                descriptor.GrantSetDigest,
                StringComparison.Ordinal) ||
            !string.Equals(descriptor.TransportSchemaReference, "authoring-service-transport/v1", StringComparison.Ordinal) ||
            descriptor.MaximumMemoryBytes is < 1 or > 536_870_912 ||
            descriptor.MaximumRequestBytes is < 1 or > 16_777_216 ||
            descriptor.MaximumResponseBytes is < 1 or > 16_777_216 ||
            descriptor.MaximumWallClock <= TimeSpan.Zero || descriptor.MaximumWallClock > TimeSpan.FromMinutes(5) ||
            !CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(descriptor.ExecutableBytes.AsSpan()),
                Convert.FromHexString(descriptor.ExecutableSha256)))
        {
            throw new AuthoringExtensionContractException("Service runtime descriptor is missing, tampered, or outside its bound.");
        }

        ValidateStaticLinuxElf(descriptor.ExecutableBytes.AsSpan());
    }

    private static bool IsDigest(string value) =>
        value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static string DigestIdentity(string material) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));

    private static void ValidateStaticLinuxElf(ReadOnlySpan<byte> executable)
    {
        if (executable.Length < 64 ||
            !executable[..4].SequenceEqual("\u007fELF"u8) ||
            executable[4] != 2 || executable[5] != 1 ||
            BinaryPrimitives.ReadUInt16LittleEndian(executable[18..20]) != 62)
        {
            throw new AuthoringExtensionContractException("Service entrypoint is not a supported Linux x86-64 ELF executable.");
        }

        ulong programOffset = BinaryPrimitives.ReadUInt64LittleEndian(executable[32..40]);
        ushort entrySize = BinaryPrimitives.ReadUInt16LittleEndian(executable[54..56]);
        ushort entryCount = BinaryPrimitives.ReadUInt16LittleEndian(executable[56..58]);
        if (entrySize < 56 || programOffset > (ulong)executable.Length ||
            entryCount > 128 || programOffset + (ulong)entrySize * entryCount > (ulong)executable.Length)
        {
            throw new AuthoringExtensionContractException("Service ELF program table is malformed or unbounded.");
        }

        for (int index = 0; index < entryCount; index++)
        {
            int offset = checked((int)programOffset + index * entrySize);
            if (BinaryPrimitives.ReadUInt32LittleEndian(executable[offset..(offset + 4)]) == 3)
            {
                throw new AuthoringExtensionContractException("Service executable must be static and interpreter-free.");
            }
        }
    }

    private static string ObserveNamespaceIsolation(int processId)
    {
        string[] namespaces = ["mnt", "net", "pid", "user"];
        string[] observed = namespaces.Select(name => File.ResolveLinkTarget(
            $"/proc/{processId}/ns/{name}",
            false)?.Name ?? string.Empty).ToArray();
        string[] host = namespaces.Select(name => File.ResolveLinkTarget(
            $"/proc/self/ns/{name}",
            false)?.Name ?? string.Empty).ToArray();
        if (observed.Any(string.IsNullOrWhiteSpace) || observed.SequenceEqual(host))
        {
            throw new AuthoringExtensionContractException("Service process namespace isolation was not observable.");
        }

        return string.Join('|', namespaces.Zip(observed, static (name, identity) => $"{name}={identity}"));
    }

    private static void ObserveOwnedSession(int processId)
    {
        string stat = File.ReadAllText($"/proc/{processId}/stat");
        int commandEnd = stat.LastIndexOf(')');
        string[] fields = stat[(commandEnd + 2)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        int processGroup = int.Parse(fields[2], System.Globalization.CultureInfo.InvariantCulture);
        int session = int.Parse(fields[3], System.Globalization.CultureInfo.InvariantCulture);
        if (processGroup < 1 || session < 1 || processGroup != session)
        {
            throw new AuthoringExtensionContractException("Service process is not the leader of its owned session.");
        }
    }

    private static int FindSandboxProcessId(int processId)
    {
        int current = processId;
        for (int depth = 0; depth < 8; depth++)
        {
            string childrenPath = $"/proc/{current}/task/{current}/children";
            int[] children = File.Exists(childrenPath)
                ? File.ReadAllText(childrenPath)
                    .Split(' ', StringSplitOptions.RemoveEmptyEntries)
                    .Select(static value => int.Parse(value, System.Globalization.CultureInfo.InvariantCulture))
                    .ToArray()
                : [];
            if (children.Length == 0)
            {
                break;
            }

            if (children.Length != 1)
            {
                throw new AuthoringExtensionContractException("Service process ownership is ambiguous.");
            }

            current = children[0];
        }

        return current;
    }

    private static string ComputeFileDigest(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    private static void ValidateOptions(LinuxBubblewrapServiceOptions options)
    {
        if (!OperatingSystem.IsLinux() || options is null ||
            !IsAbsoluteFile(options.PrlimitPath) || !IsAbsoluteFile(options.BubblewrapPath) ||
            !Path.IsPathFullyQualified(options.PrivateWorkingRoot) ||
            Path.GetPathRoot(options.PrivateWorkingRoot) == Path.TrimEndingDirectorySeparator(options.PrivateWorkingRoot) ||
            options.StartupTimeout <= TimeSpan.Zero || options.StartupTimeout > TimeSpan.FromSeconds(30))
        {
            throw new AuthoringExtensionContractException("Linux service runtime profile is unavailable, broad, or unbounded.");
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

    internal static bool OwnsNativeCustody(
        object owner,
        object descriptor,
        object authority,
        Process custody,
        Process sandbox,
        ulong startTicks,
        string profileIdentity) =>
        owner is LinuxBubblewrapServiceProcess native &&
        native.OwnsNativeCustody(descriptor, authority, custody, sandbox, startTicks, profileIdentity);

    internal static bool OwnsSnapshotLoad(object owner, object authority, AuthoringNativeStateSnapshotBinding binding) =>
        owner is LinuxBubblewrapServiceProcess native && native.OwnsSnapshotLoad(authority, binding);

    internal static ValueTask VerifySnapshotAcceptanceAsync(object owner, AuthoringNativeStateSnapshotAcceptance acceptance,
        AuthoringNativeStateSnapshotBinding binding, CancellationToken cancellationToken) =>
        owner is LinuxBubblewrapServiceProcess native
            ? native.VerifySnapshotAcceptanceAsync(acceptance, binding, cancellationToken)
            : ValueTask.FromException(new AuthoringExtensionContractException("Original native snapshot owner is required."));

    internal static void ReleaseSnapshotAcceptance(object owner, AuthoringNativeStateSnapshotAcceptance acceptance)
    {
        if (owner is not LinuxBubblewrapServiceProcess native)
        {
            throw new AuthoringExtensionContractException("Original native snapshot owner is required.");
        }
        native.ReleaseSnapshotAcceptance(acceptance);
    }

    private sealed class LinuxBubblewrapServiceProcess(
        Process process,
        int serviceProcessId,
        Process sandboxProcess,
        ulong processStartTicks,
        string instanceRoot,
        AuthoringServiceLaunchDescriptor descriptor,
        AuthoringServiceHealthReport health,
        AuthoringProcessOwnershipReport ownership,
        Task stderrDrain) :
        IAuthoringServiceProcess,
        IAuthoringOwnedServiceProcessObservation,
        IAuthoringMeasuredRuntimeInstance
    {
        private readonly SemaphoreSlim _transportLock = new(1, 1);
        private bool _terminated;
        private readonly SemaphoreSlim _lifecycleLock = new(1, 1);
        private readonly object _incarnationOwner = new();
        private AuthoringRuntimeIncarnationLease? _incarnation;
        private bool _disposed;

        public void IssueIncarnation() =>
            _incarnation = AuthoringRuntimeIncarnationLease.Issue(
                this, descriptor, _incarnationOwner, process, sandboxProcess, processStartTicks, ownership.IsolationIdentity);

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
            FindSandboxProcessId(process.Id) == serviceProcessId &&
            string.Equals(profileIdentity, ownership.IsolationIdentity, StringComparison.Ordinal);

        public AuthoringProcessOwnershipReport Ownership { get; } = ownership;

        public string RuntimeIdentity => descriptor.RuntimeIdentity;

        public int ProcessId => serviceProcessId;

        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken) =>
            _terminated || _incarnation is null || !_incarnation.IsCurrentOwner(this)
                ? ValueTask.FromResult(health with
                {
                    ProtocolHandshakeComplete = false
                })
                : ValueTask.FromResult(health);

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
            _incarnation.IsCurrentOwner(this) && _transportLock.CurrentCount == 0;

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
            await _transportLock.WaitAsync(cancellationToken);
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
                if (!StateSnapshotSupported || !health.ProtocolHandshakeComplete ||
                    health.RuntimeIdentity != descriptor.RuntimeIdentity || health.ExecutableSha256 != descriptor.ExecutableSha256 ||
                    health.TransportSchemaReference != descriptor.TransportSchemaReference)
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
                issued = AuthoringNativeStateSnapshotAcceptance.Issue(this, _incarnationOwner, _incarnation!, binding, cancellationToken);
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
                        await TerminateTreeAsync("snapshot-acceptance-failed", CancellationToken.None);
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
                await TerminateTreeAsync("snapshot-custody-changed", CancellationToken.None);
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
                    _transportLock.Release();
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
            string frame = binding.CreateServiceRequestFrame(load, nonce);
            if (Encoding.UTF8.GetByteCount(frame) > descriptor.MaximumRequestBytes * 2 + 4096)
            {
                throw new AuthoringExtensionContractException("Native snapshot request exceeds the original transport budget.");
            }
            await process.StandardInput.WriteLineAsync(frame.AsMemory(), cancellationToken);
            await process.StandardInput.FlushAsync(cancellationToken);
            string? response = await ReadClosedLineAsync(process.StandardOutput,
                descriptor.MaximumResponseBytes * 2 + 4096, cancellationToken);
            string[] fields = response?.Split('\t') ?? [];
            if (fields.Length != 5 || fields[0] != (load ? "STATE_ACCEPTED" : "STATE_CURRENT") ||
                fields[1] != "1" || fields[2] != nonce)
            {
                throw new AuthoringExtensionContractException("Native service did not attest a fresh stored-state readback.");
            }
            binding.VerifyReadback(fields[3], fields[4]);
        }

        public async ValueTask<AuthoringServiceResponse> ExecuteAsync(
            AuthoringServiceRequest request,
            CancellationToken cancellationToken)
        {
            await _transportLock.WaitAsync(cancellationToken);
            try
            {
                if (_terminated || _incarnation is null || !_incarnation.IsCurrentOwner(this))
                {
                    throw new AuthoringExtensionContractException("Authoring service process is terminated.");
                }

                string frame = CreateRequestFrame(request, descriptor);
                await process.StandardInput.WriteLineAsync(frame.AsMemory(), cancellationToken);
                await process.StandardInput.FlushAsync(cancellationToken);
                return ParseResponse(
                    await ReadClosedLineAsync(
                        process.StandardOutput,
                        descriptor.MaximumResponseBytes * 2 + 4096,
                        cancellationToken),
                    descriptor.MaximumResponseBytes);
            }
            finally
            {
                _transportLock.Release();
            }
        }

        public async ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken)
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
                await _transportLock.WaitAsync(CancellationToken.None);
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
                    _transportLock.Release();
                }
            }
            finally
            {
                _lifecycleLock.Release();
            }
        }
    }
}
