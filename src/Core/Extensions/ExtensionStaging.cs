using System.Buffers;
using System.Runtime.ExceptionServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using static FsusBlog.V2.Core.Extensions.ExtensionDisk;

namespace FsusBlog.V2.Core.Extensions;

/// <summary>A private host scratch root. A package can propose data but cannot choose a pathname.</summary>
public sealed class ExtensionStaging(string rootId, DirectoryInfo privateRoot)
{
    private readonly string _path = ExtensionManifestReader.IsIdentifier(rootId) ? ValidatePrivateRoot(privateRoot) :
        throw new ExtensionRejectedException("staging-root-unavailable");

    public async Task<string> Stage(ExtensionAuthority.Operation operation, Stream data, CancellationToken cancellationToken = default)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (operation.Proposal is not ExtensionProposal.StageFile proposal || proposal.Root != rootId)
            throw new ExtensionRejectedException("operation-is-not-staging-for-root");
        var scope = operation.BeginStaging(this, cancellationToken);
        Exception? first = null;
        try { return await StageHeld(operation, proposal, data, scope, cancellationToken); }
        catch (Exception error) { first = error; throw; }
        finally
        {
            try { scope.Dispose(); }
            catch (Exception release) when (first is not null) { throw new AggregateException(first, release); }
        }
    }

    [UnsupportedOSPlatform("windows")]
    private async Task<string> StageHeld(ExtensionAuthority.Operation operation, ExtensionProposal.StageFile proposal, Stream data,
        ExtensionAuthority.Operation.BrokerScope scope, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, scope.Token);
        // The opaque request ID is a leaf name only. CreateNew decides whether this operation owns its content.
        var file = Path.Combine(_path, $"{proposal.RequestId:N}.stage");
        FileStream? owned = null;
        var unnamed = false;
        Exception? workFailure = null;
        Exception? cleanupFailure = null;
        byte[] rented = ArrayPool<byte>.Shared.Rent(64 * 1024);
        string? digest = null;
        try
        {
            ValidatePrivateRoot(new DirectoryInfo(_path));
            operation.RequireActive(timeout.Token);
            // CreateNew is the authority for creation. A failed open never enters the cleanup path.
            owned = new FileStream(file, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.ReadWrite,
                Share = FileShare.None,
                BufferSize = 64 * 1024,
                Options = FileOptions.Asynchronous,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite
            });
            // Remove the name before accepting any content. All subsequent writes and release target the original handle.
            File.Delete(file);
            unnamed = true;
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var remaining = proposal.Length;
            while (remaining > 0)
            {
                operation.RequireActive(cancellationToken);
                var read = await data.ReadAsync(rented.AsMemory(0, Math.Min(rented.Length, remaining)), timeout.Token);
                if (read == 0) throw new ExtensionRejectedException("staging-length");
                operation.RequireActive(cancellationToken);
                await owned.WriteAsync(rented.AsMemory(0, read), timeout.Token);
                hash.AppendData(rented.AsSpan(0, read));
                remaining -= read;
            }
            operation.RequireActive(cancellationToken);
            if (await data.ReadAsync(rented.AsMemory(0, 1), timeout.Token) != 0)
                throw new ExtensionRejectedException("staging-length");
            await owned.FlushAsync(timeout.Token);
            digest = Convert.ToHexStringLower(hash.GetHashAndReset());
        }
        catch (Exception error) { workFailure = error; }
        finally
        {
            if (owned is not null)
            {
                try { await owned.DisposeAsync(); }
                catch (Exception error) { cleanupFailure = error; }
                if (!unnamed)
                {
                    var uncertainty = new ExtensionRejectedException("staging-name-release-unconfirmed");
                    cleanupFailure = cleanupFailure is null ? uncertainty : new AggregateException(uncertainty, cleanupFailure);
                }
            }
            ArrayPool<byte>.Shared.Return(rented, clearArray: true);
        }

        if (workFailure is not null && cleanupFailure is not null) throw new AggregateException(workFailure, cleanupFailure);
        if (workFailure is not null) ExceptionDispatchInfo.Capture(workFailure).Throw();
        if (cleanupFailure is not null) ExceptionDispatchInfo.Capture(cleanupFailure).Throw();
        var receipt = digest ?? throw new InvalidOperationException("Staging completed without a digest.");
        return scope.Complete(receipt, timeout.Token);
    }
}
