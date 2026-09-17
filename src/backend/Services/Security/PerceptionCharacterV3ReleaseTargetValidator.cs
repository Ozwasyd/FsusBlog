using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Services.Security;

public static class PerceptionCharacterV3ReleaseTargetValidator
{
    public const string PublicTargetPath = "wwwroot/generated/perception-character-v3-release-target.json";

    public static void ValidatePublishedFrontendTarget(string contentRoot)
    {
        string path = Path.Combine(contentRoot, PublicTargetPath.Replace('/', Path.DirectorySeparatorChar));
        byte[] bytes = File.ReadAllBytes(path);
        using JsonDocument document = JsonDocument.Parse(bytes);
        JsonElement root = document.RootElement;
        Require(root, "schema", PerceptionCharacterV3ReleaseTarget.Schema);
        Require(root, "algorithm", PerceptionCharacterV3ReleaseTarget.Algorithm);
        Require(root, "wireName", PerceptionCharacterV3ReleaseTarget.WireName);
        Require(root, "contractDigest", PerceptionCharacterV3ReleaseTarget.ContractDigest);
        Require(root, "aedsSchemaFingerprint", PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint);
        Require(root, "targetFingerprint", PerceptionCharacterV3ReleaseTarget.TargetFingerprint);
    }

    private static void Require(JsonElement root, string propertyName, string expected)
    {
        if (!root.TryGetProperty(propertyName, out JsonElement property)
            || property.ValueKind != JsonValueKind.String
            || !FixedEquals(property.GetString() ?? string.Empty, expected))
        {
            throw new InvalidOperationException(
                $"Published PerceptionCharacterV3 frontend target has a mixed {propertyName}.");
        }
    }

    private static bool FixedEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.UTF8.GetBytes(left);
        byte[] rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length
            && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
}
