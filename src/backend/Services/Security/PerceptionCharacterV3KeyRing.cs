using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Services.Security;

public interface IPerceptionCharacterV3KeyRing
{
    string CurrentTokenVersion
    {
        get;
    }
    string CurrentAnswerVersion
    {
        get;
    }
    bool TryGetTokenKey(string version, out byte[] key);
    bool TryGetAnswerKey(string version, out byte[] key);
}

public sealed partial class PerceptionCharacterV3KeyRing : IPerceptionCharacterV3KeyRing
{
    private static readonly HashSet<string> s_testDigests =
    [
        "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd",
        "2e89abf78a47d7b0b46df24de5e23022c97087537089442013eca82ab863684d"
    ];
    private readonly Dictionary<string, byte[]> _tokenKeys;
    private readonly Dictionary<string, byte[]> _answerKeys;
    public string CurrentTokenVersion
    {
        get;
    }
    public string CurrentAnswerVersion
    {
        get;
    }

    public PerceptionCharacterV3KeyRing(IConfiguration configuration, IHostEnvironment environment)
    {
        IConfigurationSection section = configuration.GetSection("Security:PerceptionCharacterV3");
        CurrentTokenVersion = section["TokenKeyCurrent"] ?? string.Empty;
        CurrentAnswerVersion = section["AnswerKeyCurrent"] ?? string.Empty;
        _tokenKeys = ReadRing(section.GetSection("TokenKeys"), "token", environment.IsEnvironment("Test") && section.GetValue("AllowTestVectors", false));
        _answerKeys = ReadRing(section.GetSection("AnswerKeys"), "answer", environment.IsEnvironment("Test") && section.GetValue("AllowTestVectors", false));
        ValidateCurrent(CurrentTokenVersion, _tokenKeys, "token");
        ValidateCurrent(CurrentAnswerVersion, _answerKeys, "answer");
        foreach (byte[] token in _tokenKeys.Values)
            foreach (byte[] answer in _answerKeys.Values)
                if (CryptographicOperations.FixedTimeEquals(token, answer))
                    throw new InvalidOperationException("PerceptionCharacterV3 token and answer key material must be disjoint.");
    }

    public bool TryGetTokenKey(string version, out byte[] key) => TryGet(_tokenKeys, version, out key);
    public bool TryGetAnswerKey(string version, out byte[] key) => TryGet(_answerKeys, version, out key);

    private static Dictionary<string, byte[]> ReadRing(IConfigurationSection section, string label, bool allowTest)
    {
        var result = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (IConfigurationSection child in section.GetChildren())
        {
            if (!VersionRegex().IsMatch(child.Key))
                throw new InvalidOperationException($"PerceptionCharacterV3 {label} key version is invalid.");
            string encoded = child.Value ?? string.Empty;
            if (encoded.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase) || encoded.Contains("placeholder", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"PerceptionCharacterV3 {label} key is a checked-in placeholder.");
            byte[] key;
            try
            {
                key = encoded.Length == 64 && encoded.All(Uri.IsHexDigit) ? Convert.FromHexString(encoded) : Convert.FromBase64String(encoded);
            }
            catch (FormatException ex)
            {
                throw new InvalidOperationException($"PerceptionCharacterV3 {label} key encoding is invalid.", ex);
            }
            if (key.Length != 32)
                throw new InvalidOperationException($"PerceptionCharacterV3 {label} key must be exactly 256 bits.");
            string digest = Convert.ToHexStringLower(SHA256.HashData(key));
            if (!allowTest && s_testDigests.Contains(digest))
                throw new InvalidOperationException($"PerceptionCharacterV3 {label} key is a checked-in test vector.");
            result.Add(child.Key, key);
        }
        if (result.Count == 0)
            throw new InvalidOperationException($"PerceptionCharacterV3 {label} key ring is missing.");
        return result;
    }

    private static void ValidateCurrent(string current, Dictionary<string, byte[]> ring, string label)
    {
        if (!VersionRegex().IsMatch(current) || !ring.ContainsKey(current))
            throw new InvalidOperationException($"PerceptionCharacterV3 current {label} key version is missing or unknown.");
    }
    private static bool TryGet(Dictionary<string, byte[]> ring, string version, out byte[] key)
    {
        if (ring.TryGetValue(version, out byte[]? stored))
        {
            key = stored;
            return true;
        }
        key = [];
        return false;
    }
    [GeneratedRegex("^[A-Za-z0-9._-]{1,64}$", RegexOptions.CultureInvariant)] private static partial Regex VersionRegex();
}

public sealed class PerceptionCharacterV3StartupGate(
    IPerceptionCharacterV3KeyRing keys,
    IPerceptionCharacterV3ArtifactPool artifactPool,
    IPerceptionCharacterV3ResourcePlanner resourcePlanner) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        _ = keys.CurrentTokenVersion;
        _ = PerceptionCharacterV3CanonicalContract.Value;
        resourcePlanner.Validate();
        await artifactPool.InitializeAsync(cancellationToken).ConfigureAwait(false);
        resourcePlanner.ValidateInventory(
            await artifactPool.GetInventoryAsync(cancellationToken).ConfigureAwait(false));
    }
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
