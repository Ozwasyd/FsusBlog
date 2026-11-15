using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;

namespace FsusBlog.V2.Server.Authoring;

internal static class CanvasBundleStore
{
    internal static CanvasPortableBundle Read(byte[] data)
    {
        try
        {
            return CanvasPortableBundle.Decode(data);
        }
        catch (BusinessException)
        {
            throw Invalid("The Canvas bundle is invalid or exceeds its size limit.");
        }
    }

    internal static CanvasBundlePlan Plan(byte[] data)
    {
        var parsed = Read(data);
        return new(Digest(data), parsed.SourceRevision, parsed.Title, parsed.NodeCount, parsed.EdgeCount,
            parsed.References.Select(reference => new CanvasBundleReference(reference.Slot, (int)reference.Kind,
                reference.RequiresPin, reference.Anchor)).ToArray());
    }

    internal static string Digest(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));

    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);
}
