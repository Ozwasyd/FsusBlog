using System.Text.Json;
using System.Security.Cryptography;

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
        await PersistDocumentAsync(Address(checkpoint.Signature), JsonSerializer.SerializeToUtf8Bytes(checkpoint),
            32_768, cancellationToken).ConfigureAwait(false);
    }

    // Raw evidence for the actual awaited producer callback, not an admission receipt.
    // Original observations/maps are retained; no body, credentials or task key is stored.
    internal async Task<string> PersistNativeAllocationEvidenceAsync(
        IReadOnlyList<DataScaleNativeIdentityObservation> observations,
        IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings> bindings, CancellationToken cancellationToken)
    {
        byte[] bytes = EncodeNativeAllocationEvidence(observations, bindings);
        string digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        await PersistDocumentAsync(Address(digest, "native-allocation-"), bytes, 16 * 1024 * 1024,
            cancellationToken).ConfigureAwait(false);
        return "sha256:" + digest;
    }

    internal async Task VerifyNativeAllocationEvidenceAsync(string contentDigest,
        IReadOnlyList<DataScaleNativeIdentityObservation> observations,
        IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings> bindings, CancellationToken cancellationToken)
    {
        if (!contentDigest.StartsWith("sha256:", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("native_allocation_evidence_digest_invalid");
        }
        string address = Address(contentDigest[7..], "native-allocation-");
        RefuseSymlink(address);
        byte[] bytes = await ReadBoundedAsync(address, cancellationToken, 16 * 1024 * 1024).ConfigureAwait(false);
        byte[] expected = EncodeNativeAllocationEvidence(observations, bindings);
        if (!bytes.AsSpan().SequenceEqual(expected)
            || "sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != contentDigest)
        {
            throw new InvalidOperationException("native_allocation_evidence_changed");
        }
    }

    private static byte[] EncodeNativeAllocationEvidence(IReadOnlyList<DataScaleNativeIdentityObservation> observations,
        IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings> bindings)
    {
        if (observations.Count is < 1 or > 32 || observations.Sum(item => (long)item.RoleIds.Count) is < 1 or > 50_000
            || bindings.Count is < 1 or > 1000 || bindings.Sum(item => (long)item.Value.Ids.Count) > 50_000)
        {
            throw new InvalidOperationException("native_allocation_evidence_roster_bound_exceeded");
        }
        // Account for JSON's worst-case escaping before encoding either copy of
        // the role map. This is a small evidence file, not an unbounded serializer.
        long maximumBytes = 4096;
        void Budget(string value)
        {
            maximumBytes += 6L * value.Length + 64;
            if (maximumBytes > 16 * 1024 * 1024)
            {
                throw new InvalidOperationException("native_allocation_evidence_file_bound_exceeded");
            }
        }
        foreach (DataScaleNativeIdentityObservation observation in observations)
        {
            Budget(observation.Table);
            Budget(observation.Column);
            Budget(observation.OwnedSequence);
            foreach (string role in observation.RoleIds.Keys)
            {
                Budget(role);
            }
        }
        foreach ((string role, ArticleScaleGraphIdentityBindings binding) in bindings)
        {
            Budget(role);
            Budget(binding.PlanDigest);
            Budget(binding.SemanticArticleId);
            Budget(binding.Digest);
            foreach (string nativeRole in binding.Ids.Keys)
            {
                Budget(nativeRole);
            }
        }
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new
        {
            Observations = observations,
            Bindings = bindings
        });
        if (bytes.Length > 16 * 1024 * 1024)
        {
            throw new InvalidOperationException("native_allocation_evidence_file_bound_exceeded");
        }
        return bytes;
    }

    private async Task PersistDocumentAsync(string destination, byte[] bytes, int maximumBytes, CancellationToken cancellationToken)
    {
        if (bytes.Length > maximumBytes)
        {
            throw new InvalidOperationException("checkpoint_file_bound_exceeded");
        }
        if (File.Exists(destination))
        {
            RefuseSymlink(destination);
            byte[] existing = await ReadBoundedAsync(destination, cancellationToken, maximumBytes).ConfigureAwait(false);
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

    private string Address(string signature, string prefix = "checkpoint-")
    {
        ValidateRoot();
        if (signature.Length != 64 || signature.AsSpan().ContainsAnyExcept("0123456789abcdef"))
        {
            throw new InvalidOperationException("checkpoint_address_invalid");
        }
        return Path.Combine(_root, prefix + signature + ".json");
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

    private static async Task<byte[]> ReadBoundedAsync(string path, CancellationToken cancellationToken, int maximumBytes = 32_768)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length < 1 || stream.Length > maximumBytes)
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
