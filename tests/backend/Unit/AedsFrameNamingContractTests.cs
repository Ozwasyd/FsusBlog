using FsusBlog.Core.Algorithms;
using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AedsFrameNamingContractTests
{
    [Fact]
    public void PasskeyCredentialFriendlyNameUpdateFrame_ReplacesRenameContract()
    {
        Assert.Equal(68, (ushort)AedsFrameType.PasskeyCredentialFriendlyNameUpdateRequest);
        Assert.NotNull(typeof(PasskeyCredentialFriendlyNameUpdateRequestPod).GetField("FriendlyName"));
        Assert.False(Enum.IsDefined(typeof(AedsFrameType), "PasskeyRenameRequest"));

        string protocol = File.ReadAllText(RepoPath("src/shared/Contracts/Validation/aeds-protocol.json"));
        Assert.Contains("\"name\": \"PasskeyCredentialFriendlyNameUpdateRequest\", \"value\": 68", protocol, StringComparison.Ordinal);
        Assert.DoesNotContain("PasskeyRenameRequest", protocol, StringComparison.Ordinal);

        string spec = File.ReadAllText(RepoPath("src/core/Algorithms/AEDS_V2_PROTOCOL.md"));
        Assert.Contains("PasskeyCredentialFriendlyNameUpdateRequest", spec, StringComparison.Ordinal);
        Assert.Contains("PasskeyCredentialFriendlyNameUpdateRequestPod", spec, StringComparison.Ordinal);
        Assert.DoesNotContain("PasskeyRenameRequest", spec, StringComparison.Ordinal);
    }

    private static string RepoPath(string relativePath)
    {
        string root = AppContext.BaseDirectory;
        for (int i = 0; i < 8; i++)
        {
            string candidate = Path.GetFullPath(Path.Combine(root, relativePath));
            if (File.Exists(candidate))
            {
                return candidate;
            }

            root = Path.GetFullPath(Path.Combine(root, ".."));
        }

        throw new FileNotFoundException($"Unable to locate repository file {relativePath} from {AppContext.BaseDirectory}.");
    }
}
