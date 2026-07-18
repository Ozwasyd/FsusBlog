using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Security;

internal interface IReadProofRateLimitPartitioner
{
    string CreatePartition(HttpContext context);
}

/// <summary>
/// Converts request network identity into a purpose-bound, short-epoch limiter
/// partition before the request enters any asynchronous application path.
/// </summary>
internal sealed class ReadProofRateLimitPartitioner : IReadProofRateLimitPartitioner, IDisposable
{
    internal static readonly TimeSpan PartitionEpochDuration = TimeSpan.FromMinutes(1);

    private const string DedupKeySetting = "HumanReadProof:Dedup:CurrentKey";
    private const string DedupKeyEpochSetting = "HumanReadProof:Dedup:CurrentKeyEpoch";
    private static readonly byte[] KeyDomain = Encoding.UTF8.GetBytes("fsus-human-read/rate-limit-key/v1");
    private readonly byte[] _partitionKey;
    private readonly int _keyEpoch;
    private readonly TimeProvider _timeProvider;

    public ReadProofRateLimitPartitioner(IConfiguration configuration, TimeProvider timeProvider)
    {
        byte[] rootKey;
        try
        {
            rootKey = Convert.FromBase64String(configuration[DedupKeySetting] ?? string.Empty);
        }
        catch (FormatException ex)
        {
            throw new InvalidOperationException($"{DedupKeySetting} must be valid Base64 key material.", ex);
        }

        if (rootKey.Length < 32)
        {
            CryptographicOperations.ZeroMemory(rootKey);
            throw new InvalidOperationException($"{DedupKeySetting} must decode to at least 32 bytes.");
        }

        if (!int.TryParse(
                configuration[DedupKeyEpochSetting],
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out _keyEpoch)
            || _keyEpoch <= 0)
        {
            CryptographicOperations.ZeroMemory(rootKey);
            throw new InvalidOperationException($"{DedupKeyEpochSetting} must be a positive integer.");
        }

        try
        {
            _partitionKey = HMACSHA256.HashData(rootKey, KeyDomain);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(rootKey);
        }

        _timeProvider = timeProvider;
    }

    public string CreatePartition(HttpContext context)
    {
        long window = _timeProvider.GetUtcNow().ToUnixTimeSeconds()
            / checked((long)PartitionEpochDuration.TotalSeconds);
        string normalizedIp = context.GetClientIp();
        string path = context.Request.Path.Value ?? string.Empty;
        byte[] framed = Encoding.UTF8.GetBytes(string.Join('\0',
            "fsus-human-read/rate-limit-partition/v1",
            $"key-epoch:{_keyEpoch.ToString(CultureInfo.InvariantCulture)}",
            $"window:{window.ToString(CultureInfo.InvariantCulture)}",
            $"path:{path}",
            $"ip:{normalizedIp}"));
        try
        {
            byte[] digest = HMACSHA256.HashData(_partitionKey, framed);
            return Convert.ToHexStringLower(digest.AsSpan(0, 16));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(framed);
        }
    }

    public void Dispose() => CryptographicOperations.ZeroMemory(_partitionKey);
}
