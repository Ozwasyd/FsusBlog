using System.Text.Json;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>Immutable, exact-address journal files in an explicit task-owned directory; no latest discovery.</summary>
internal sealed class DataScaleBatchCheckpointStore
{
    private readonly string _root;

    internal DataScaleBatchCheckpointStore(string taskOwnedRoot)
    {
        if (!Path.IsPathFullyQualified(taskOwnedRoot))
        {
            throw new InvalidOperationException("checkpoint_root_not_absolute");
        }
        _root = Path.GetFullPath(taskOwnedRoot);
        ValidateRoot();
        Directory.CreateDirectory(_root);
    }

    internal async Task PersistAsync(DataScaleBatchCheckpoint checkpoint, CancellationToken cancellationToken)
    {
        string destination = Address(checkpoint.Signature);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(checkpoint);
        if (bytes.Length > 32_768)
        {
            throw new InvalidOperationException("checkpoint_file_bound_exceeded");
        }
        if (File.Exists(destination))
        {
            RefuseSymlink(destination);
            byte[] existing = await ReadBoundedAsync(destination, cancellationToken).ConfigureAwait(false);
            if (!existing.AsSpan().SequenceEqual(bytes))
            {
                throw new InvalidOperationException("checkpoint_existing_bytes_mismatch");
            }
            return;
        }
        string staging = Path.Combine(_root, ".staging-" + Guid.NewGuid().ToString("N"));
        try
        {
            await using (var stream = new FileStream(staging, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await stream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
                stream.Flush(flushToDisk: true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            // No replacement: a raced or changed checkpoint cannot silently acquire this address.
            File.Move(staging, destination, overwrite: false);
        }
        finally
        {
            if (File.Exists(staging))
            {
                File.Delete(staging);
            }
        }
    }

    internal async Task<DataScaleBatchCheckpoint> ReadAsync(string signature,
        DataScaleBatchCheckpointIdentity current, ReadOnlyMemory<byte> taskKey,
        CancellationToken cancellationToken)
    {
        string address = Address(signature);
        RefuseSymlink(address);
        byte[] bytes = await ReadBoundedAsync(address, cancellationToken).ConfigureAwait(false);
        DataScaleBatchCheckpoint checkpoint = JsonSerializer.Deserialize<DataScaleBatchCheckpoint>(bytes)
            ?? throw new InvalidOperationException("checkpoint_document_missing");
        if (checkpoint.Signature != signature)
        {
            throw new InvalidOperationException("checkpoint_address_signature_mismatch");
        }
        checkpoint.Validate(current, taskKey.Span, Enum.GetValues<DataScaleBatchCheckpointStage>());
        return checkpoint;
    }

    private string Address(string signature)
    {
        ValidateRoot();
        if (signature.Length != 64 || signature.AsSpan().ContainsAnyExcept("0123456789abcdef"))
        {
            throw new InvalidOperationException("checkpoint_address_invalid");
        }
        return Path.Combine(_root, "checkpoint-" + signature + ".json");
    }

    private void ValidateRoot()
    {
        for (DirectoryInfo? directory = new(_root); directory is not null; directory = directory.Parent)
        {
            if (directory.LinkTarget is not null)
            {
                throw new InvalidOperationException("checkpoint_root_symlink_refused");
            }
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length is < 1 or > 32_768)
        {
            throw new InvalidOperationException("checkpoint_file_bound_exceeded");
        }
        var bytes = new byte[checked((int)stream.Length)];
        await stream.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false);
        if (stream.Length != bytes.Length)
        {
            throw new InvalidOperationException("checkpoint_file_changed_during_read");
        }
        return bytes;
    }

    private static void RefuseSymlink(string path)
    {
        if (new FileInfo(path).LinkTarget is not null)
        {
            throw new InvalidOperationException("checkpoint_file_symlink_refused");
        }
    }
}
