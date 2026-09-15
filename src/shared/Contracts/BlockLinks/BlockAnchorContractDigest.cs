using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.BlockLinks;

/// <summary>Computes the canonical digest shared by every block-anchor consumer.</summary>
public static class BlockAnchorContractDigest
{
    public static string ComputeContract()
        => Compute(writer =>
        {
            writer.Add(BlockAnchorSchemas.Contract);
            writer.Add(BlockAnchorSchemas.Version);
            writer.Add(BlockAnchorSchemas.UpstreamContract);
            writer.Add(BlockAnchorSchemas.Grammar);
            writer.Add(BlockAnchorSchemas.SourceMarkerPrefix);
            writer.Add(BlockAnchorSchemas.UrlFragmentPrefix);
            writer.Add(BlockAnchorSchemas.MarkdownRoutePrefix);
            writer.Add(BlockAnchorSchemas.DigestAlgorithm);
            writer.Add(BlockAnchorSchemas.CanonicalSerialization);
            writer.Add(BlockAnchorSchemas.VerificationReceipt);
        });

    public static string ComputeTarget(ArticleBlockTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        return Compute(writer =>
        {
            writer.Add(BlockAnchorSchemas.Contract);
            writer.Add(BlockAnchorSchemas.Version);
            writer.Add(target.ArticleIdentity);
            writer.Add(target.AnchorId.Value);
        });
    }

    public static string ComputeConsumerIdentity(BlockAnchorConsumerIdentity identity)
    {
        ArgumentNullException.ThrowIfNull(identity);
        return Compute(writer =>
        {
            writer.Add(identity.ConsumerKind);
            writer.Add(identity.ConsumerVersion);
            writer.Add(identity.ContractVersion);
            writer.Add(identity.ContractDigest);
            writer.Add(identity.InputDigest);
        });
    }

    public static string ComputeVerification(
        BlockAnchorRoundTripCase roundTrip,
        string sourceMarker,
        string fragment,
        string markdown)
    {
        ArgumentNullException.ThrowIfNull(roundTrip);
        return Compute(writer =>
        {
            writer.Add(BlockAnchorSchemas.Contract);
            writer.Add(BlockAnchorSchemas.Version);
            writer.Add(ComputeTarget(roundTrip.Target));
            writer.Add(roundTrip.CanonicalSlug);
            writer.Add(roundTrip.DisplayText);
            writer.Add(sourceMarker);
            writer.Add(fragment);
            writer.Add(markdown);
        });
    }

    public static bool IsSha256(string? value)
    {
        if (value is null || value.Length != 64)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (!((character is >= '0' and <= '9') || (character is >= 'a' and <= 'f')))
            {
                return false;
            }
        }

        return true;
    }

    internal static string Compute(Action<CanonicalWriter> write)
    {
        using var stream = new MemoryStream();
        var writer = new CanonicalWriter(stream);
        write(writer);
        return Convert.ToHexStringLower(
            SHA256.HashData(stream.GetBuffer().AsSpan(0, checked((int)stream.Length))));
    }

    internal sealed class CanonicalWriter(MemoryStream stream)
    {
        public void Add(string? value)
        {
            if (value is null)
            {
                Add(-1);
                return;
            }

            byte[] bytes = Encoding.UTF8.GetBytes(value);
            Add(bytes.Length);
            stream.Write(bytes);
        }

        public void Add(int value)
        {
            Span<byte> bytes = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32BigEndian(bytes, value);
            stream.Write(bytes);
        }
    }
}
