using System.Buffers;
using System.Buffers.Binary;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Core.Cache;

/// <summary>Reads and writes the closed current-review request; it provides no current-fact grant.</summary>
public static partial class PodBinaryCodec
{
    private static readonly UTF8Encoding s_currentReviewUtf8 = new(false, true);

    /// <summary>Encodes the exact bounded POD, refusing unsupported references before output.</summary>
    public static byte[] EncodeArticleVaultCurrentReviewRequest(ArticleVaultCurrentReviewRequest value)
    {
        if (!ArticleVaultCurrentReviewWireContract.IsValid(value))
        {
            throw new ArgumentException("article_vault_current_review_request_invalid", nameof(value));
        }
        byte[] bytes = new byte[ArticleVaultCurrentReviewWireContract.RequestPayloadBytes];
        Span<byte> span = bytes;
        BinaryPrimitives.WriteUInt32LittleEndian(span, ArticleVaultCurrentReviewWireContract.RequestMagic);
        BinaryPrimitives.WriteUInt16LittleEndian(span[4..], ArticleVaultCurrentReviewWireContract.Version);
        BinaryPrimitives.WriteUInt16LittleEndian(span[6..], value.Checkpoint is null ? (ushort)0 : (ushort)1);
        BinaryPrimitives.WriteInt32LittleEndian(span[8..], value.ArticleId);
        Put(16, 80, value.ResolutionOperationIdentity);
        Put(96, 64, value.ProposalSha256);
        if (value.Checkpoint is { } checkpoint)
        {
            BinaryPrimitives.WriteInt64LittleEndian(span[160..], checkpoint.Sequence);
            Put(168, 64, checkpoint.ContentSha256);
            ArticleVaultOperationIdentity operation = checkpoint.Operation;
            Put(232, 48, operation.Schema);
            BinaryPrimitives.WriteInt32LittleEndian(span[280..], operation.SchemaVersion);
            Put(288, 512, operation.SiteIdentity);
            Put(800, 512, operation.VaultIdentity);
            Put(1312, 512, operation.DeviceIdentity);
            Put(1824, 512, operation.AgentIdentity);
            Put(2336, 512, operation.PlanReference);
            Put(2848, 64, operation.PlanSha256);
            Put(2912, 64, operation.RequestSha256);
            Put(2976, 64, operation.IdempotencySha256);
            BinaryPrimitives.WriteInt64LittleEndian(span[3040..], operation.DeadlineUnixMs);
            Put(3048, 64, operation.OperationIdentity);
            Put(3112, 64, operation.ContentSha256);
        }
        return bytes;

        void Put(int offset, int length, string text)
            => s_currentReviewUtf8.GetBytes(text, bytes.AsSpan(offset, length));
    }

    /// <summary>Writes a fully validated payload atomically to the caller's destination.</summary>
    public static void WriteArticleVaultCurrentReviewRequest(ArticleVaultCurrentReviewRequest value, IBufferWriter<byte> target)
    {
        ArgumentNullException.ThrowIfNull(target);
        byte[] bytes = EncodeArticleVaultCurrentReviewRequest(value);
        bytes.CopyTo(target.GetSpan(bytes.Length));
        target.Advance(bytes.Length);
    }

    /// <summary>Rejects unknown tags, excess bytes, bad padding and partial optional checkpoints.</summary>
    public static bool TryDecodeArticleVaultCurrentReviewRequest(ReadOnlyMemory<byte> source,
        out ArticleVaultCurrentReviewRequest? value)
    {
        value = null;
        ReadOnlySpan<byte> span = source.Span;
        if (span.Length != ArticleVaultCurrentReviewWireContract.RequestPayloadBytes
            || BinaryPrimitives.ReadUInt32LittleEndian(span) != ArticleVaultCurrentReviewWireContract.RequestMagic
            || BinaryPrimitives.ReadUInt16LittleEndian(span[4..]) != ArticleVaultCurrentReviewWireContract.Version
            || BinaryPrimitives.ReadUInt16LittleEndian(span[6..]) > 1
            || BinaryPrimitives.ReadUInt32LittleEndian(span[12..]) != 0)
        {
            return false;
        }
        try
        {
            ArticleVaultCurrentReviewCheckpointReference? checkpoint = null;
            if (BinaryPrimitives.ReadUInt16LittleEndian(span[6..]) == 0)
            {
                if (span[160..].IndexOfAnyExcept((byte)0) >= 0)
                {
                    return false;
                }
            }
            else
            {
                if (BinaryPrimitives.ReadUInt32LittleEndian(span[284..]) != 0)
                {
                    return false;
                }
                var operation = new ArticleVaultOperationIdentity(
                    Get(232, 48), BinaryPrimitives.ReadInt32LittleEndian(span[280..]),
                    Get(288, 512), Get(800, 512), Get(1312, 512), Get(1824, 512), Get(2336, 512),
                    Get(2848, 64), Get(2912, 64), Get(2976, 64), BinaryPrimitives.ReadInt64LittleEndian(span[3040..]),
                    Get(3048, 64), Get(3112, 64));
                checkpoint = new(operation, BinaryPrimitives.ReadInt64LittleEndian(span[160..]), Get(168, 64));
            }
            var decoded = new ArticleVaultCurrentReviewRequest(BinaryPrimitives.ReadInt32LittleEndian(span[8..]),
                Get(16, 80), Get(96, 64), checkpoint);
            if (!ArticleVaultCurrentReviewWireContract.IsValid(decoded))
            {
                return false;
            }
            value = decoded;
            return true;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
        catch (InvalidDataException)
        {
            return false;
        }

        string Get(int offset, int length)
        {
            ReadOnlySpan<byte> field = source.Span.Slice(offset, length);
            int zero = field.IndexOf((byte)0);
            if (zero >= 0)
            {
                if (field[zero..].IndexOfAnyExcept((byte)0) >= 0)
                {
                    throw new InvalidDataException("article_vault_current_review_padding_invalid");
                }
                field = field[..zero];
            }
            return s_currentReviewUtf8.GetString(field);
        }
    }
}
