using System.Buffers;
using System.Buffers.Binary;
using System.Text;

using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Core.Cache;

/// <summary>Encodes and validates the shared, closed current upload preview payload.</summary>
public static partial class PodBinaryCodec
{
    /// <summary>Writes a closed header plus the original observed bytes; rejects truncation and noncanonical fields.</summary>
    public static void WriteUploadAssetPreview(UploadAssetPreviewDto value, IBufferWriter<byte> target)
    {
        byte[] header = new byte[UploadAssetPreviewDto.HeaderBytes];
        WritePreviewAscii(header, 0, 64, value.Schema);
        WritePreviewAscii(header, 64, 64, value.UploadId);
        WritePreviewAscii(header, 128, 64, value.AssetId);
        WritePreviewAscii(header, 192, 256, value.PublicUrl);
        WritePreviewAscii(header, 448, 64, value.MimeType);
        WritePreviewAscii(header, 512, 32, value.Extension);
        BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(544), value.SizeBytes);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(552), value.Width);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(556), value.Height);
        WritePreviewAscii(header, 560, 64, value.Sha256);
        WritePreviewAscii(header, 624, 64, value.AssetVersionSha256);
        WritePreviewAscii(header, 688, 64, value.ReferenceLedgerSha256);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(752), value.ReferenceRowCount);
        if (!TryReadPreviewHeader(header, out _) || value.Bytes.Length != value.SizeBytes)
        {
            throw new ArgumentException("upload_asset_preview_invalid", nameof(value));
        }
        target.Write(header);
        target.Write(value.Bytes.Span);
    }

    /// <summary>Encodes one bounded current preview without an AEDS frame header.</summary>
    public static byte[] EncodeUploadAssetPreview(UploadAssetPreviewDto value)
        => EncodeToArray(UploadAssetPreviewDto.HeaderBytes + value.Bytes.Length, writer => WriteUploadAssetPreview(value, writer));

    /// <summary>The bytes borrow the caller-owned payload; no URL resolution, allocation or grant inference occurs.</summary>
    public static bool TryDecodeUploadAssetPreview(ReadOnlyMemory<byte> source, out UploadAssetPreviewDto value)
    {
        value = null!;
        if (source.Length < UploadAssetPreviewDto.HeaderBytes
            || !TryReadPreviewHeader(source.Span[..UploadAssetPreviewDto.HeaderBytes], out var header)
            || source.Length - UploadAssetPreviewDto.HeaderBytes != header.SizeBytes)
        {
            return false;
        }
        value = header with
        {
            Bytes = source[UploadAssetPreviewDto.HeaderBytes..]
        };
        return true;
    }

    private static bool TryReadPreviewHeader(ReadOnlySpan<byte> source, out UploadAssetPreviewDto value)
    {
        value = null!;
        int[] offsets = [0, 64, 128, 192, 448, 512, 560, 624, 688];
        int[] lengths = [64, 64, 64, 256, 64, 32, 64, 64, 64];
        string[] fields = new string[offsets.Length];
        for (int i = 0; i < fields.Length; i++)
        {
            ReadOnlySpan<byte> field = source.Slice(offsets[i], lengths[i]);
            int end = field.IndexOf((byte)0);
            if (end < 0)
                end = field.Length;
            for (int j = 0; j < field.Length; j++)
            {
                if (j < end ? field[j] is < 33 or > 126 : field[j] != 0)
                    return false;
            }
            fields[i] = Encoding.ASCII.GetString(field[..end]);
        }
        long size = BinaryPrimitives.ReadInt64LittleEndian(source[544..]);
        int width = BinaryPrimitives.ReadInt32LittleEndian(source[552..]);
        int height = BinaryPrimitives.ReadInt32LittleEndian(source[556..]);
        int count = BinaryPrimitives.ReadInt32LittleEndian(source[752..]);
        string? expectedMime = fields[5] switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".ico" => "image/x-icon",
            _ => null
        };
        if (fields[0] != UploadAssetPreviewDto.SchemaName || !PreviewHex(fields[1], 32)
            || !Guid.TryParseExact(fields[2], "D", out Guid id) || id.ToString("N") != fields[1]
            || id.ToString("D") != fields[2] || expectedMime is null || expectedMime != fields[4]
            || fields[3] != "/uploads/illustration/" + fields[1] + fields[5]
            || size <= 0 || size > UploadAssetPreviewDto.MaxPreviewBytes || width < 0 || height < 0
            || (width == 0) != (height == 0) || count < 0 || count > 1024
            || BinaryPrimitives.ReadInt32LittleEndian(source[756..]) != 0
            || !PreviewHex(fields[6], 64) || !PreviewHex(fields[7], 64) || !PreviewHex(fields[8], 64))
            return false;
        value = new UploadAssetPreviewDto
        {
            Schema = fields[0],
            UploadId = fields[1],
            AssetId = fields[2],
            PublicUrl = fields[3],
            MimeType = fields[4],
            Extension = fields[5],
            SizeBytes = size,
            Width = width,
            Height = height,
            Sha256 = fields[6],
            AssetVersionSha256 = fields[7],
            ReferenceLedgerSha256 = fields[8],
            ReferenceRowCount = count
        };
        return true;
    }

    private static bool PreviewHex(string value, int length)
        => value.Length == length && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void WritePreviewAscii(Span<byte> target, int offset, int length, string value)
    {
        if (value is null || value.Length > length || value.Any(static character => character is < '!' or > '~'))
            throw new ArgumentException("upload_asset_preview_field_invalid");
        Encoding.ASCII.GetBytes(value, target.Slice(offset, length));
    }
}
