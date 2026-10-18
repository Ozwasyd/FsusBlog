using System.Buffers;
using System.Text;

namespace FsusBlog.Server.Infrastructure.PublicAot;

/// <summary>
/// Encodes only the nonce into caller-admitted storage before streaming the original template.
/// The caller retains ownership of the scratch and destination for the complete write.
/// </summary>
internal static class ReservedCspNonceScratchWriter
{
    internal static void Write(
        CspNonceUtf8Template template,
        string nonce,
        IBufferWriter<byte> destination,
        Span<byte> callerAdmittedNonceScratch,
        CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(template);
        ArgumentNullException.ThrowIfNull(destination);

        int nonceByteCount = Encoding.UTF8.GetByteCount(nonce.AsSpan());
        if (nonceByteCount > callerAdmittedNonceScratch.Length)
        {
            throw new ArgumentException(
                "Caller-admitted nonce scratch is smaller than the nonce UTF-8 byte count.",
                nameof(callerAdmittedNonceScratch));
        }

        int nonceLength = Encoding.UTF8.GetBytes(nonce.AsSpan(), callerAdmittedNonceScratch);
        template.Write(destination, callerAdmittedNonceScratch[..nonceLength], token);
    }
}
