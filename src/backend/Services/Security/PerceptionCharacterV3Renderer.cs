namespace FsusBlog.Server.Services.Security;

public interface IPerceptionCharacterV3Renderer
{
    byte[] RenderVisual(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default);
    byte[] RenderAudio(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default);
}

/// <summary>
/// Fail-closed boundary retained until the encrypted artifact pool owns issuance.
/// The retired request-time raster/WAV generator must never produce a V3 payload.
/// </summary>
public sealed class PerceptionCharacterV3Renderer : IPerceptionCharacterV3Renderer
{
    public byte[] RenderVisual(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default)
        => throw ArtifactPoolRequired();

    public byte[] RenderAudio(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default)
        => throw ArtifactPoolRequired();

    private static InvalidOperationException ArtifactPoolRequired()
        => new("PerceptionCharacterV3 final-media artifact pool is required.");
}
