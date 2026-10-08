using System.Buffers.Binary;
using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>Successful verified bytes copied to caller-owned private staging.</summary>
public sealed record DiskSegmentCopy(long BytesWritten);

/// <summary>
/// Holds an immutable record and its bounded I/O reservation. A copy target is private staging:
/// bytes are usable only after a successful integrity result, and remain caller-owned on failure.
/// A competing copy returns BudgetRejected; callers own any scheduling or retry policy.
/// </summary>
public sealed class DiskSegmentLease : IDisposable
{
    private readonly object _gate = new();
    private readonly FileStream _file;
    private readonly Guid _segmentId;
    private readonly int _records;
    private readonly long _bytes;
    private byte[] _scratch;
    private readonly IDisposable _reservation;
    private readonly Action _release;
    private bool _disposed;
    private bool _copying;
    private bool _disposeRequested;

    internal DiskSegmentLease(FileStream file, Guid segmentId, int records, long bytes, DiskSegmentEntry entry, byte[] scratch,
        IDisposable reservation, Action release)
    {
        _file = file;
        _segmentId = segmentId;
        _records = records;
        _bytes = bytes;
        Entry = entry;
        _scratch = scratch;
        _reservation = reservation;
        _release = release;
        PayloadStream = new PayloadView(file, entry.PayloadOffset, entry.PayloadBytes);
    }

    public DiskSegmentEntry Entry
    {
        get;
    }
    internal Stream PayloadStream
    {
        get;
    }

    public MemoryOperationResult<DiskSegmentCopy> CopyTo(Stream privateStaging,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(privateStaging);
        MemoryOperationResult<DiskSegmentCopy> result;
        bool release = false;
        if (!Monitor.TryEnter(_gate))
        {
            return MemoryOperationResult<DiskSegmentCopy>.Reject(MemoryFailure.BudgetRejected);
        }
        try
        {
            try
            {
                if (_disposed || _disposeRequested)
                {
                    return MemoryOperationResult<DiskSegmentCopy>.Reject(MemoryFailure.StaleLocation);
                }
                if (_copying || !privateStaging.CanWrite)
                {
                    return MemoryOperationResult<DiskSegmentCopy>.Reject(MemoryFailure.OwnershipViolation);
                }
                _copying = true;
                try
                {
                    Verify(_file, _segmentId, _records, _bytes, Entry, _scratch, cancellationToken);
                    _file.Position = Entry.PayloadOffset;
                    using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    long remaining = Entry.PayloadBytes;
                    while (remaining > 0)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        int read = _file.Read(_scratch, 0, (int)Math.Min(remaining, _scratch.Length));
                        if (read == 0)
                        {
                            throw new EndOfStreamException();
                        }
                        hash.AppendData(_scratch, 0, read);
                        privateStaging.Write(_scratch, 0, read);
                        remaining -= read;
                    }
                    if (!CryptographicOperations.FixedTimeEquals(hash.GetHashAndReset(), Convert.FromHexString(Entry.Sha256)))
                    {
                        throw new InvalidDataException("Record changed during copy.");
                    }
                    result = MemoryOperationResult<DiskSegmentCopy>.Success(new(Entry.PayloadBytes));
                }
                catch (Exception exception) when (DiskSegmentStore.KnownFailure(exception))
                {
                    result = MemoryOperationResult<DiskSegmentCopy>.Reject(DiskSegmentStore.Failure(exception));
                }
                finally
                {
                    _copying = false;
                    if (_disposeRequested)
                    {
                        Close();
                        release = true;
                    }
                }
            }
            finally
            {
                Monitor.Exit(_gate);
            }
            return result;
        }
        finally
        {
            if (release)
            {
                _release();
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }
            _disposeRequested = true;
            // A caller-owned target may dispose this lease reentrantly from Write.
            // Preserve the active operation's file, scratch and charge until it exits.
            if (_copying)
            {
                return;
            }
            Close();
        }
        _release();
    }

    private void Close()
    {
        _disposed = true;
        _file.Dispose();
        _scratch = [];
        _reservation.Dispose();
    }

    internal static void Verify(FileStream file, Guid segmentId, int records, long bytes, DiskSegmentEntry entry, byte[] scratch,
        CancellationToken cancellationToken)
    {
        DiskSegmentFormat.ValidatePublishedHeader(file, segmentId, records, bytes, cancellationToken);
        if (entry.PayloadOffset < DiskSegmentFormat.HeaderBytes + DiskSegmentFormat.RecordBytes
            || entry.PayloadBytes < 0 || entry.PayloadOffset > file.Length
            || entry.PayloadBytes > file.Length - entry.PayloadOffset)
        {
            throw new InvalidDataException("Indexed record is outside its backing.");
        }
        Span<byte> encoded = stackalloc byte[DiskSegmentFormat.RecordBytes];
        file.Position = entry.PayloadOffset - DiskSegmentFormat.RecordBytes;
        file.ReadExactly(encoded);
        if (new Guid(encoded[..16], bigEndian: true) != entry.Identity.Blob.Value
            || new Guid(encoded.Slice(16, 16), bigEndian: true) != entry.Identity.Representation.Value
            || BinaryPrimitives.ReadUInt64LittleEndian(encoded.Slice(32, 8)) != entry.Identity.Generation.Value
            || BinaryPrimitives.ReadInt64LittleEndian(encoded.Slice(40, 8)) != entry.PayloadBytes
            || BinaryPrimitives.ReadInt64LittleEndian(encoded.Slice(48, 8)) != entry.PayloadOffset
            || BinaryPrimitives.ReadUInt64LittleEndian(encoded.Slice(88, 8)) != DiskSegmentFormat.CompleteRecord
            || !CryptographicOperations.FixedTimeEquals(encoded.Slice(56, 32), Convert.FromHexString(entry.Sha256)))
        {
            throw new InvalidDataException("Indexed representation changed.");
        }
        Span<byte> digest = stackalloc byte[32];
        DiskSegmentFormat.Hash(file, entry.PayloadBytes, scratch, digest, cancellationToken);
        if (!CryptographicOperations.FixedTimeEquals(digest, encoded.Slice(56, 32)))
        {
            throw new InvalidDataException("Indexed payload integrity mismatch.");
        }
    }

    private sealed class PayloadView(FileStream file, long offset, long length) : Stream
    {
        private long _position;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position
        {
            get => _position;
            set => throw new NotSupportedException();
        }
        public override int Read(byte[] buffer, int bufferOffset, int count)
        {
            file.Position = checked(offset + _position);
            int read = file.Read(buffer, bufferOffset, (int)Math.Min(count, length - _position));
            _position += read;
            return read;
        }
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long seekOffset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int bufferOffset, int count) => throw new NotSupportedException();
    }
}
