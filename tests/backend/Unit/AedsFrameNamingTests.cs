using System.Text.Json;

using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Validation;

using CoreFrameType = FsusBlog.Core.Algorithms.AedsFrameType;
using SharedFrameType = FsusBlog.Shared.AedsFrameType;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AedsFrameNamingTests
{
    private const string FriendlyNameFrame = "PasskeyCredentialFriendlyNameUpdateRequest";

    [Fact]
    public void FriendlyNameUpdateFrame_HasOneNumericIdentityAcrossEnumsProtocolAndGoldenCatalog()
    {
        Assert.Equal(68, (ushort)CoreFrameType.PasskeyCredentialFriendlyNameUpdateRequest);
        Assert.Equal(68, (ushort)SharedFrameType.PasskeyCredentialFriendlyNameUpdateRequest);
        Assert.Equal(68, AedsProtocolMetadata.FrameTypes[FriendlyNameFrame]);
        Assert.Equal(68, ReadFrameValue("frames", FriendlyNameFrame));
    }

    [Fact]
    public void FriendlyNameUpdatePod_ExposesFriendlyNameAndRetiredRenameEnumIsAbsent()
    {
        Assert.NotNull(typeof(PasskeyCredentialFriendlyNameUpdateRequestPod).GetField("FriendlyName"));
        Assert.False(Enum.IsDefined(typeof(CoreFrameType), "PasskeyRenameRequest"));
        Assert.False(Enum.IsDefined(typeof(SharedFrameType), "PasskeyRenameRequest"));
        Assert.False(AedsProtocolMetadata.FrameTypes.ContainsKey("PasskeyRenameRequest"));
    }

    private static int ReadFrameValue(string collectionName, string frameName)
    {
        string json = BackendTestPaths.ReadAllTextFromRoot(
            "tests", "backend", "Fixtures", "aeds-golden-catalog.json");
        using JsonDocument document = JsonDocument.Parse(json);
        foreach (JsonElement frame in document.RootElement.GetProperty(collectionName).EnumerateArray())
        {
            if (string.Equals(frame.GetProperty("name").GetString(), frameName, StringComparison.Ordinal))
            {
                return frame.GetProperty("value").GetInt32();
            }
        }

        throw new InvalidOperationException($"Frame {frameName} is missing from the AEDS golden catalog.");
    }
}
