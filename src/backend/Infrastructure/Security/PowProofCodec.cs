using System.Buffers;
using System.Buffers.Binary;
using System.Buffers.Text;
using System.Text;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Infrastructure.Security;

internal static class PowProofCodec
{
    public const string HeaderName = "X-Fsus-Pow-Proof";

    private const int MaxSaltUtf8Bytes = 128;
    private const int MaxNonceUtf8Bytes = 64;
    private const int MaxSignatureUtf8Bytes = 128;
    private const int MaxBrowserFingerprintUtf8Bytes = 256;

    public static bool TryDecodeBase64Proof(string? encodedProof, out VirtualPowRequest proof)
        => TryDecodeBase64Proof(encodedProof, out proof, out _);

    public static bool TryDecodeBase64Proof(string? encodedProof, out VirtualPowRequest proof, out PowProofDecodeFailure failure)
    {
        proof = new VirtualPowRequest();
        failure = PowProofDecodeFailure.Binary;
        if (string.IsNullOrWhiteSpace(encodedProof))
        {
            return false;
        }

        string normalized = encodedProof.Trim();
        byte[]? rentedBuffer = null;
        try
        {
            int bufferSize = Base64.GetMaxDecodedFromUtf8Length(normalized.Length);
            rentedBuffer = ArrayPool<byte>.Shared.Rent(bufferSize);
            if (!Convert.TryFromBase64String(normalized, rentedBuffer, out int bytesWritten))
            {
                failure = PowProofDecodeFailure.Base64;
                return false;
            }

            bool decoded = TryDecodeBinaryProof(rentedBuffer.AsSpan(0, bytesWritten), out proof);
            failure = decoded ? PowProofDecodeFailure.None : PowProofDecodeFailure.Binary;
            return decoded;
        }
        finally
        {
            if (rentedBuffer is not null)
            {
                ArrayPool<byte>.Shared.Return(rentedBuffer, clearArray: true);
            }
        }
    }

    public static bool TryDecodeBinaryProof(ReadOnlySpan<byte> source, out VirtualPowRequest proof)
    {
        proof = new VirtualPowRequest();
        if (source.Length < 17
            || source[0] != (byte)'F'
            || source[1] != (byte)'P'
            || source[2] != (byte)'O'
            || source[3] != (byte)'W'
            || source[4] != 1)
        {
            return false;
        }

        int difficulty = BinaryPrimitives.ReadInt32LittleEndian(source.Slice(5, sizeof(int)));
        long timestamp = BinaryPrimitives.ReadInt64LittleEndian(source.Slice(9, sizeof(long)));
        int offset = 17;
        if (!TryReadString(source, ref offset, MaxSaltUtf8Bytes, out string salt)
            || !TryReadString(source, ref offset, MaxNonceUtf8Bytes, out string nonce)
            || !TryReadString(source, ref offset, MaxSignatureUtf8Bytes, out string signature)
            || !TryReadString(source, ref offset, MaxBrowserFingerprintUtf8Bytes, out string browserFp)
            || offset != source.Length)
        {
            proof = new VirtualPowRequest();
            return false;
        }

        proof = new VirtualPowRequest
        {
            PowSalt = salt,
            PowNonce = nonce,
            Difficulty = difficulty,
            PowTimestamp = timestamp,
            PowSignature = signature,
            BrowserFp = browserFp
        };
        return true;
    }

    private static bool TryReadString(ReadOnlySpan<byte> source, ref int offset, int maxUtf8Bytes, out string value)
    {
        value = string.Empty;
        if (offset + sizeof(ushort) > source.Length)
        {
            return false;
        }

        int length = BinaryPrimitives.ReadUInt16LittleEndian(source.Slice(offset, sizeof(ushort)));
        offset += sizeof(ushort);
        if (length > maxUtf8Bytes || offset + length > source.Length)
        {
            return false;
        }

        value = Encoding.UTF8.GetString(source.Slice(offset, length));
        offset += length;
        return true;
    }
}

internal enum PowProofDecodeFailure
{
    None,
    Base64,
    Binary
}
