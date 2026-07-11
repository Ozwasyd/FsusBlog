using System.Security.Cryptography;

namespace FsusBlog.Server.Infrastructure.Security;

public interface ISecurityRandomSource
{
    byte[] GetBytes(int length);
}

public sealed class CryptographicSecurityRandomSource : ISecurityRandomSource
{
    public static CryptographicSecurityRandomSource Instance { get; } = new();

    private CryptographicSecurityRandomSource()
    {
    }

    public byte[] GetBytes(int length)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(length);
        return RandomNumberGenerator.GetBytes(length);
    }
}

