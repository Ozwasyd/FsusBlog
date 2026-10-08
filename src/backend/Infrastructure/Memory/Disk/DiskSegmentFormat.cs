using System.Buffers.Binary;
using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>Finite capacity limits for the private, reconstructible segment store.</summary>
public sealed record DiskSegmentLimits(int MaxSegments, int MaxRecordsPerSegment, long MaxPayloadBytes,
    long MaxSegmentBytes, int ChunkBytes, int MaxRecoveryFiles, int RecoveryScanBytes = 4096)
{
    // Conservative logical admission allowance for arrays, entries and operation metadata.
    // Physical managed-memory bounds require the owning measured baseline; payloads stay on disk.
    internal long IndexBytes(int records) => checked(512L + records * 512L);
    internal void Validate()
    {
        if (MaxSegments <= 0 || MaxRecordsPerSegment <= 0 || MaxPayloadBytes < 0
            || MaxSegmentBytes < DiskSegmentFormat.HeaderBytes || ChunkBytes < DiskSegmentFormat.RecordBytes
            || ChunkBytes > 1024 * 1024 || MaxRecoveryFiles <= 0
            || RecoveryScanBytes < 4096 || RecoveryScanBytes > 1024 * 1024)
        {
            throw new ArgumentOutOfRangeException(nameof(DiskSegmentLimits));
        }
        _ = checked(IndexBytes(MaxRecordsPerSegment) * MaxSegments);
    }
}

/// <summary>A caller-owned stream and its exact initialized payload length.</summary>
public sealed record DiskSegmentWriteRecord(MemoryContentIdentity Identity, Stream Payload, long PayloadBytes, string? ExpectedSha256 = null);

/// <summary>An immutable disk index entry; offsets are validated against the enclosing segment.</summary>
public sealed record DiskSegmentEntry(MemoryContentIdentity Identity, long PayloadOffset, long PayloadBytes,
    string Sha256);

internal static class DiskSegmentFormat
{
    internal const int HeaderBytes = 64;
    internal const int RecordBytes = 96;
    internal const uint Version = 1;
    internal const ulong CompleteRecord = 0x3154454C504D4F43;
    private static ReadOnlySpan<byte> Magic => "FBSGv001"u8;

    internal static long Size(IReadOnlyList<DiskSegmentWriteRecord> records, DiskSegmentLimits limits)
    {
        if (records.Count == 0 || records.Count > limits.MaxRecordsPerSegment)
        {
            throw new ArgumentOutOfRangeException(nameof(records));
        }
        long size = HeaderBytes;
        for (int index = 0; index < records.Count; index++)
        {
            if (index >= limits.MaxRecordsPerSegment)
            {
                throw new ArgumentOutOfRangeException(nameof(records));
            }
            DiskSegmentWriteRecord record = records[index];
            ArgumentNullException.ThrowIfNull(record);
            record.Identity.Validate();
            if (record.ExpectedSha256 is not null
                && (record.ExpectedSha256.Length != 64 || !record.ExpectedSha256.All(Uri.IsHexDigit)))
            {
                throw new ArgumentException("Expected digest must be SHA-256 hex.", nameof(records));
            }
            ArgumentNullException.ThrowIfNull(record.Payload);
            if (!record.Payload.CanRead || record.PayloadBytes < 0 || record.PayloadBytes > limits.MaxPayloadBytes)
            {
                throw new ArgumentOutOfRangeException(nameof(records));
            }
            size = checked(size + RecordBytes + record.PayloadBytes);
        }
        if (size > limits.MaxSegmentBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(records));
        }
        return size;
    }

    internal static void Write(FileStream file, Guid id, IReadOnlyList<DiskSegmentWriteRecord> records,
        long size, byte[] scratch, CancellationToken cancellationToken)
    {
        Span<byte> header = stackalloc byte[HeaderBytes];
        Header(header, id, records.Count, size, false);
        file.Write(header);
        Span<byte> encoded = stackalloc byte[RecordBytes];
        foreach (DiskSegmentWriteRecord record in records)
        {
            cancellationToken.ThrowIfCancellationRequested();
            long position = file.Position;
            encoded.Clear();
            file.Write(encoded);
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long remaining = record.PayloadBytes;
            while (remaining > 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int requested = (int)Math.Min(scratch.Length, remaining);
                int read = record.Payload.Read(scratch, 0, requested);
                if (read < 0 || read > requested)
                {
                    throw new InvalidDataException("Payload stream violated its bounded read contract.");
                }
                if (read == 0)
                {
                    throw new EndOfStreamException("Payload ended before its declared initialized length.");
                }
                hash.AppendData(scratch, 0, read);
                file.Write(scratch, 0, read);
                remaining -= read;
            }
            long end = file.Position;
            record.Identity.Blob.Value.TryWriteBytes(encoded[..16], bigEndian: true, out _);
            record.Identity.Representation.Value.TryWriteBytes(encoded.Slice(16, 16), bigEndian: true, out _);
            BinaryPrimitives.WriteUInt64LittleEndian(encoded.Slice(32, 8), record.Identity.Generation.Value);
            BinaryPrimitives.WriteInt64LittleEndian(encoded.Slice(40, 8), record.PayloadBytes);
            BinaryPrimitives.WriteInt64LittleEndian(encoded.Slice(48, 8), position + RecordBytes);
            hash.GetHashAndReset(encoded.Slice(56, 32));
            if (record.ExpectedSha256 is not null
                && !CryptographicOperations.FixedTimeEquals(encoded.Slice(56, 32), Convert.FromHexString(record.ExpectedSha256)))
            {
                throw new InvalidDataException("Compaction source integrity changed.");
            }
            BinaryPrimitives.WriteUInt64LittleEndian(encoded.Slice(88, 8), CompleteRecord);
            file.Position = position;
            file.Write(encoded);
            file.Position = end;
        }
        Header(header, id, records.Count, size, true);
        file.Position = 0;
        file.Write(header);
        // Reconstructible cache only: Flush(true) is not a cross-platform power-loss transaction promise.
        file.Flush(flushToDisk: true);
    }

    internal static void ValidatePublishedHeader(FileStream file, Guid id, int records, long bytes,
        CancellationToken cancellationToken)
    {
        file.Position = 0;
        Span<byte> header = stackalloc byte[HeaderBytes];
        ReadExactly(file, header, cancellationToken);
        if (!header[..8].SequenceEqual(Magic)
            || BinaryPrimitives.ReadUInt32LittleEndian(header.Slice(8, 4)) != Version
            || BinaryPrimitives.ReadInt32LittleEndian(header.Slice(12, 4)) != HeaderBytes
            || BinaryPrimitives.ReadInt64LittleEndian(header.Slice(16, 8)) != bytes || file.Length != bytes
            || BinaryPrimitives.ReadInt32LittleEndian(header.Slice(24, 4)) != records
            || BinaryPrimitives.ReadUInt32LittleEndian(header.Slice(28, 4)) != 1
            || new Guid(header.Slice(32, 16), bigEndian: true) != id
            || BinaryPrimitives.ReadUInt64LittleEndian(header.Slice(48, 8)) != 0
            || BinaryPrimitives.ReadUInt64LittleEndian(header.Slice(56, 8)) != 0)
        {
            throw new InvalidDataException("Published segment header changed.");
        }
    }

    internal static bool Supported(FileStream file)
    {
        Span<byte> prefix = stackalloc byte[12];
        file.Position = 0;
        if (file.Length < prefix.Length)
        {
            return true; // A truncated known owner file is reconstructible debris.
        }
        file.ReadExactly(prefix);
        return prefix[..8].SequenceEqual(Magic)
            && BinaryPrimitives.ReadUInt32LittleEndian(prefix[8..]) == Version;
    }

    internal static List<DiskSegmentEntry> Verify(FileStream file, Guid expectedId, DiskSegmentLimits limits,
        byte[] scratch, CancellationToken cancellationToken, int admittedRecords)
    {
        file.Position = 0;
        Span<byte> header = stackalloc byte[HeaderBytes];
        ReadExactly(file, header, cancellationToken);
        int count = BinaryPrimitives.ReadInt32LittleEndian(header.Slice(24, 4));
        long size = BinaryPrimitives.ReadInt64LittleEndian(header.Slice(16, 8));
        if (!header[..8].SequenceEqual(Magic)
            || BinaryPrimitives.ReadUInt32LittleEndian(header.Slice(8, 4)) != Version
            || BinaryPrimitives.ReadInt32LittleEndian(header.Slice(12, 4)) != HeaderBytes
            || BinaryPrimitives.ReadUInt32LittleEndian(header.Slice(28, 4)) != 1
            || new Guid(header.Slice(32, 16), bigEndian: true) != expectedId
            || BinaryPrimitives.ReadUInt64LittleEndian(header.Slice(48, 8)) != 0
            || BinaryPrimitives.ReadUInt64LittleEndian(header.Slice(56, 8)) != 0
            || count <= 0 || count > limits.MaxRecordsPerSegment || count > admittedRecords
            || size < HeaderBytes || size > limits.MaxSegmentBytes || file.Length != size
            || count > (size - HeaderBytes) / RecordBytes)
        {
            throw new InvalidDataException("Unsupported or incomplete private segment header.");
        }
        var entries = new List<DiskSegmentEntry>(count);
        Span<byte> encoded = stackalloc byte[RecordBytes];
        Span<byte> digest = stackalloc byte[32];
        for (int index = 0; index < count; index++)
        {
            if (size - file.Position < RecordBytes)
            {
                throw new InvalidDataException("Record header exceeds segment bounds.");
            }
            ReadExactly(file, encoded, cancellationToken);
            long length = BinaryPrimitives.ReadInt64LittleEndian(encoded.Slice(40, 8));
            long offset = BinaryPrimitives.ReadInt64LittleEndian(encoded.Slice(48, 8));
            if (length < 0 || length > limits.MaxPayloadBytes || offset != file.Position
                || length > size - offset
                || BinaryPrimitives.ReadUInt64LittleEndian(encoded.Slice(88, 8)) != CompleteRecord)
            {
                throw new InvalidDataException("Invalid record bounds or completion state.");
            }
            var identity = new MemoryContentIdentity(new BlobId(new Guid(encoded[..16], bigEndian: true)),
                new ContentGeneration(BinaryPrimitives.ReadUInt64LittleEndian(encoded.Slice(32, 8))),
                new RepresentationId(new Guid(encoded.Slice(16, 16), bigEndian: true)));
            try
            {
                identity.Validate();
            }
            catch (ArgumentException exception)
            {
                throw new InvalidDataException("Invalid record identity.", exception);
            }
            Hash(file, length, scratch, digest, cancellationToken);
            if (!CryptographicOperations.FixedTimeEquals(digest, encoded.Slice(56, 32)))
            {
                throw new InvalidDataException("Record integrity mismatch.");
            }
            if (entries.Any(entry => entry.Identity == identity))
            {
                throw new InvalidDataException("Duplicate representation in one segment.");
            }
            entries.Add(new(identity, offset, length, Convert.ToHexString(digest)));
        }
        if (file.Position != size)
        {
            throw new InvalidDataException("Unindexed segment tail.");
        }
        return entries;
    }

    internal static void Hash(Stream file, long length, byte[] scratch, Span<byte> digest,
        CancellationToken cancellationToken)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long remaining = length;
        while (remaining > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int read = file.Read(scratch, 0, (int)Math.Min(scratch.Length, remaining));
            if (read == 0)
            {
                throw new EndOfStreamException();
            }
            hash.AppendData(scratch, 0, read);
            remaining -= read;
        }
        hash.GetHashAndReset(digest);
    }

    private static void Header(Span<byte> header, Guid id, int count, long size, bool complete)
    {
        header.Clear();
        Magic.CopyTo(header);
        BinaryPrimitives.WriteUInt32LittleEndian(header.Slice(8, 4), Version);
        BinaryPrimitives.WriteInt32LittleEndian(header.Slice(12, 4), HeaderBytes);
        BinaryPrimitives.WriteInt64LittleEndian(header.Slice(16, 8), size);
        BinaryPrimitives.WriteInt32LittleEndian(header.Slice(24, 4), count);
        BinaryPrimitives.WriteUInt32LittleEndian(header.Slice(28, 4), complete ? 1U : 0U);
        id.TryWriteBytes(header.Slice(32, 16), bigEndian: true, out _);
    }

    private static void ReadExactly(Stream file, Span<byte> destination, CancellationToken cancellationToken)
    {
        while (!destination.IsEmpty)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int read = file.Read(destination);
            if (read == 0)
            {
                throw new EndOfStreamException();
            }
            destination = destination[read..];
        }
    }
}
