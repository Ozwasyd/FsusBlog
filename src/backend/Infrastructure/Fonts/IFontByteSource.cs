using System.Collections.Immutable;

namespace FsusBlog.Server.Infrastructure.Fonts;

/// <summary>
/// Frozen installed face identity. No caller-supplied filesystem path is accepted.
/// The hash is the lowercase SHA-256 used by the existing registry asset store.
/// </summary>
public sealed record FontFaceReadRequest(
    string FontId,
    string Version,
    string Family,
    int Weight,
    string Style,
    string ContentHash);

/// <summary>
/// Owned, immutable bytes and the exact installed identity verified during the read.
/// Byte integrity does not certify glyph coverage, font decoding, or rendering.
/// </summary>
public sealed record FontRegistryFaceBytes(
    FontFaceReadRequest Identity,
    ImmutableArray<byte> Bytes);

/// <summary>
/// Reads a bounded batch from installed registry state under its lifecycle gate.
/// Missing, replaced, oversized, or modified assets fail the entire batch.
/// </summary>
public interface IFontByteSource
{
    Task<IReadOnlyList<FontRegistryFaceBytes>> ReadFaceBytesAsync(
        IReadOnlyList<FontFaceReadRequest> requests,
        long maximumBytes,
        CancellationToken cancellationToken = default);
}
