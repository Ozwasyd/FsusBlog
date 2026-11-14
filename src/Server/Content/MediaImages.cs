using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Core;
using SkiaSharp;

namespace FsusBlog.V2.Server.Content;

internal enum MediaFormat : short { Png = 1, Jpeg = 2 }
internal enum MediaPhase : short { Pending, Ready, Removing, Removed }

internal sealed record MediaImage(string Name, MediaFormat Format, int Width, int Height, byte[] Bytes, byte[] RequestHash, byte[] Hash)
{
    internal const int MaxBytes = 20 * 1024 * 1024;
    private const int MaxDimension = 8192;
    private const long MaxPixels = 16L * 1024 * 1024;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    internal static string ContentType(MediaFormat format) => format switch
    {
        MediaFormat.Png => "image/png",
        MediaFormat.Jpeg => "image/jpeg",
        _ => throw new ArgumentOutOfRangeException(nameof(format))
    };

    internal static async Task<MediaImage> ReadAsync(Stream body, int length, string name, string contentType, CancellationToken token)
    {
        name = ValidateName(name);
        var format = contentType switch
        {
            "image/png" when Path.GetExtension(name).Equals(".png", StringComparison.OrdinalIgnoreCase) => MediaFormat.Png,
            "image/jpeg" when Path.GetExtension(name).ToLowerInvariant() is ".jpg" or ".jpeg" => MediaFormat.Jpeg,
            _ => throw new BadHttpRequestException("Use a PNG or JPEG file with a matching extension.", StatusCodes.Status415UnsupportedMediaType)
        };
        if (length is < 1 or > MaxBytes) throw Invalid("Invalid image length.");
        var source = new byte[length];
        try { await body.ReadExactlyAsync(source, token); }
        catch (EndOfStreamException) { throw Invalid("Image body ended early."); }
        if (await body.ReadAsync(new byte[1], token) != 0) throw Invalid("Image length changed.");
        token.ThrowIfCancellationRequested();
        return Normalize(name, format, source, token);
    }

    private static string ValidateName(string name)
    {
        try
        {
            if (name.Length > 255 || string.IsNullOrWhiteSpace(name) || Utf8.GetByteCount(name) > 255 ||
                name != name.Trim() || name.Any(character => char.IsControl(character) || character is '/' or '\\'))
                throw Invalid("Invalid image name.");
        }
        catch (EncoderFallbackException) { throw Invalid("Invalid image name."); }
        return name;
    }

    private static MediaImage Normalize(string name, MediaFormat format, byte[] source, CancellationToken token)
    {
        using var reader = new MemoryStream(source, writable: false);
        using var codec = SKCodec.Create(reader);
        var expected = format == MediaFormat.Png ? SKEncodedImageFormat.Png : SKEncodedImageFormat.Jpeg;
        if (codec is null || codec.EncodedFormat != expected || codec.FrameCount > 1 ||
            codec.EncodedOrigin != SKEncodedOrigin.TopLeft)
            throw Invalid("Invalid or unsupported image.");
        var size = codec.Info;
        if (size.Width is < 1 or > MaxDimension || size.Height is < 1 or > MaxDimension || (long)size.Width * size.Height > MaxPixels)
            throw Invalid("Image dimensions exceed the supported limits.");

        var pixels = new SKImageInfo(size.Width, size.Height, SKColorType.Rgba8888,
            format == MediaFormat.Jpeg ? SKAlphaType.Opaque : SKAlphaType.Premul);
        using var bitmap = new SKBitmap();
        if (!bitmap.TryAllocPixels(pixels) || codec.GetPixels(pixels, bitmap.GetPixels()) != SKCodecResult.Success)
            throw Invalid("Could not decode the entire image.");
        token.ThrowIfCancellationRequested();
        using var result = bitmap.Encode(expected, 90);
        if (result is null || result.Size is < 1 or > MaxBytes)
            throw Invalid("Normalized image exceeds the supported limit.");
        var normalized = result.ToArray();

        using var fingerprint = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        fingerprint.AppendData(Utf8.GetBytes(name));
        fingerprint.AppendData([0, (byte)format]);
        fingerprint.AppendData(source);
        token.ThrowIfCancellationRequested();
        return new MediaImage(name, format, size.Width, size.Height, normalized, fingerprint.GetHashAndReset(), SHA256.HashData(normalized));
    }

    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);
}
