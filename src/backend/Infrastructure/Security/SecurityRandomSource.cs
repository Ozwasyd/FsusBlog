using System.Security.Cryptography;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Provides cryptographically secure random bytes behind an injectable security boundary.
/// </summary>
public interface ISecurityRandomSource
{
    byte[] GetBytes(int length);
}

/// <summary>
/// Implements security randomness with the platform cryptographic random-number generator.
/// </summary>
public sealed class CryptographicSecurityRandomSource : ISecurityRandomSource
{
    /// <summary>
    /// Gets the stateless shared cryptographic random source.
    /// </summary>
    public static CryptographicSecurityRandomSource Instance { get; } = new();

    private CryptographicSecurityRandomSource()
    {
    }

    /// <summary>
    /// Allocates and fills a buffer with cryptographically secure random bytes.
    /// </summary>
    /// <param name="length">Positive number of random bytes to generate.</param>
    /// <returns>A new buffer containing the requested number of random bytes.</returns>
    public byte[] GetBytes(int length)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(length);
        return RandomNumberGenerator.GetBytes(length);
    }
}
