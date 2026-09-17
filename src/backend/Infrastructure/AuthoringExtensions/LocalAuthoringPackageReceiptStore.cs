using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed class LocalAuthoringPackageReceiptStore : IAuthoringPackageReceiptStore
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 8,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    private readonly string _rootPath;
    private readonly string _lockPath;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public LocalAuthoringPackageReceiptStore(string rootPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootPath);
        _rootPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(rootPath));
        if (string.Equals(_rootPath, Path.GetPathRoot(_rootPath), StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Package receipt root cannot be a filesystem root.");
        }

        EnsurePrivateDirectory(_rootPath);
        _lockPath = Path.Combine(_rootPath, ".append.lock");
    }

    public async ValueTask<AuthoringPackageReceipt?> GetLastAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using FileStream writerLock = OpenWriterLock();
            IReadOnlyList<AuthoringPackageReceipt> receipts = await ReadAllCoreAsync(cancellationToken);
            return receipts.Count == 0 ? null : receipts[^1];
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask<AuthoringPackageReceipt?> GetLastForExtensionAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(extensionId) || extensionId.Length > 128 || HasControl(extensionId))
        {
            throw new AuthoringExtensionContractException("Package receipt extension identity is invalid or unbounded.");
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using FileStream writerLock = OpenWriterLock();
            IReadOnlyList<AuthoringPackageReceipt> receipts = await ReadAllCoreAsync(cancellationToken);
            return receipts.LastOrDefault(receipt =>
                string.Equals(receipt.ExtensionId, extensionId, StringComparison.Ordinal));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask AppendAsync(
        AuthoringPackageReceipt receipt,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using FileStream writerLock = OpenWriterLock();
            IReadOnlyList<AuthoringPackageReceipt> receipts = await ReadAllCoreAsync(cancellationToken);
            AuthoringPackageReceipt? previous = receipts.Count == 0 ? null : receipts[^1];
            if (receipt.Sequence != (previous?.Sequence ?? 0) + 1 ||
                !string.Equals(
                    receipt.PreviousReceiptSha256,
                    previous?.ReceiptSha256 ?? new string('0', 64),
                    StringComparison.Ordinal) ||
                !string.Equals(
                    receipt.ReceiptSha256,
                    AuthoringPackageActivationCoordinator.ComputeReceiptSha256(receipt),
                    StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Package receipt is not the next independently verifiable append.");
            }

            ValidateReceipt(receipt);
            string finalPath = ResolveReceiptPath(receipt);
            string temporaryPath = Path.Combine(
                _rootPath,
                $".receipt-{receipt.Sequence:D20}-{Guid.NewGuid():N}.tmp");
            try
            {
                await WriteNewPrivateFileAsync(
                    temporaryPath,
                    JsonSerializer.SerializeToUtf8Bytes(receipt, s_json),
                    cancellationToken);
                File.Move(temporaryPath, finalPath, overwrite: false);
            }
            catch (IOException exception)
            {
                throw new AuthoringExtensionContractException($"Package receipt append conflicted: {exception.GetType().Name}.");
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private async ValueTask<IReadOnlyList<AuthoringPackageReceipt>> ReadAllCoreAsync(
        CancellationToken cancellationToken)
    {
        string[] files = Directory.EnumerateFiles(_rootPath, "receipt-*.json", SearchOption.TopDirectoryOnly)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var receipts = new List<AuthoringPackageReceipt>(files.Length);
        string previousHash = new('0', 64);
        long sequence = 0;
        foreach (string path in files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RejectReparsePoint(path);
            byte[] bytes = await ReadBoundedAsync(path, 64 * 1024, cancellationToken);
            AuthoringPackageReceipt receipt = AuthoringPackageClosedJson.Deserialize<AuthoringPackageReceipt>(
                bytes,
                s_json,
                "Package receipt");

            sequence++;
            ValidateReceipt(receipt);
            if (receipt.Sequence != sequence ||
                !string.Equals(receipt.PreviousReceiptSha256, previousHash, StringComparison.Ordinal) ||
                !string.Equals(receipt.ReceiptSha256, AuthoringPackageActivationCoordinator.ComputeReceiptSha256(receipt), StringComparison.Ordinal) ||
                !string.Equals(Path.GetFileName(path), ReceiptFileName(receipt), StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Package receipt chain, filename, or digest was tampered.");
            }

            previousHash = receipt.ReceiptSha256;
            receipts.Add(receipt);
        }

        return receipts;
    }

    private static void ValidateReceipt(AuthoringPackageReceipt receipt)
    {
        if (receipt.Sequence < 1 || receipt.Timestamp.Offset != TimeSpan.Zero ||
            !Enum.IsDefined(receipt.Operation) || !Enum.IsDefined(receipt.Outcome) ||
            !Enum.IsDefined(receipt.TrustStatus) ||
            string.IsNullOrWhiteSpace(receipt.ExtensionId) || string.IsNullOrWhiteSpace(receipt.Version) ||
            string.IsNullOrWhiteSpace(receipt.Publisher) || string.IsNullOrWhiteSpace(receipt.KeyId) ||
            HasControl(receipt.ExtensionId) || HasControl(receipt.Version) || HasControl(receipt.Publisher) ||
            HasControl(receipt.KeyId) || HasControl(receipt.FailureCode) ||
            !IsSha256(receipt.PackageIdentity) || !IsSha256(receipt.ArchiveSha256) ||
            !IsSha256(receipt.PackageSha256) || !IsSha256(receipt.ContentSha256) ||
            !IsSha256(receipt.ContractIdentity) || !IsSha256(receipt.KeysetIdentity) ||
            !IsSha256(receipt.PreviousReceiptSha256) ||
            !IsSha256(receipt.ReceiptSha256) ||
            (receipt.PreviousPackageIdentity is not null && !IsSha256(receipt.PreviousPackageIdentity)) ||
            (receipt.PreviousPackageSha256 is not null && !IsSha256(receipt.PreviousPackageSha256)) ||
            (receipt.PreviousPackageIdentity is null) != (receipt.PreviousPackageSha256 is null) ||
            (receipt.Outcome == AuthoringPackageOutcome.Committed && receipt.FailureCode is not null) ||
            (receipt.Outcome != AuthoringPackageOutcome.Committed && string.IsNullOrWhiteSpace(receipt.FailureCode)) ||
            receipt.TrustStatus != AuthoringPackageTrustStatus.Trusted ||
            !AuthoringPackageReferencePolicy.IsBoundedIdentifier(receipt.ExtensionId) ||
            !AuthoringPackageReferencePolicy.IsBoundedIdentifier(receipt.Publisher) ||
            !AuthoringPackageReferencePolicy.IsBoundedIdentifier(receipt.KeyId) ||
            receipt.Version.Length > 64 || !Version.TryParse(receipt.Version, out _))
        {
            throw new AuthoringExtensionContractException("Package receipt contains an invalid or unbounded identity.");
        }
    }

    private FileStream OpenWriterLock()
    {
        try
        {
            FileStream stream = new(
                _lockPath,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None,
                1,
                FileOptions.WriteThrough);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(_lockPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }

            return stream;
        }
        catch (IOException exception)
        {
            throw new AuthoringExtensionContractException($"Package receipt writer is already active: {exception.GetType().Name}.");
        }
    }

    private string ResolveReceiptPath(AuthoringPackageReceipt receipt) =>
        Path.Combine(_rootPath, ReceiptFileName(receipt));

    private static string ReceiptFileName(AuthoringPackageReceipt receipt) =>
        $"receipt-{receipt.Sequence:D20}-{receipt.ReceiptSha256}.json";

    private static async ValueTask WriteNewPrivateFileAsync(
        string path,
        ReadOnlyMemory<byte> content,
        CancellationToken cancellationToken)
    {
        await using (var stream = new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            16 * 1024,
            FileOptions.Asynchronous | FileOptions.WriteThrough))
        {
            await stream.WriteAsync(content, cancellationToken);
            await stream.FlushAsync(cancellationToken);
            stream.Flush(flushToDisk: true);
        }

        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    private static async ValueTask<byte[]> ReadBoundedAsync(
        string path,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length < 1 || info.Length > maximumBytes)
        {
            throw new AuthoringExtensionContractException("Package receipt is missing or outside its byte bound.");
        }

        byte[] bytes = new byte[checked((int)info.Length)];
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            16 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        await stream.ReadExactlyAsync(bytes, cancellationToken);
        return bytes;
    }

    private static void EnsurePrivateDirectory(string path)
    {
        if (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            throw new AuthoringExtensionContractException("Package receipt root crosses a reparse boundary.");
        }

        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    private static void RejectReparsePoint(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            throw new AuthoringExtensionContractException("Package receipt path crosses a reparse boundary.");
        }
    }

    private static bool HasControl(string? value) =>
        value is not null && (value.Length > 256 || value.ContainsAny(['\0', '\r', '\n']));

    private static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
