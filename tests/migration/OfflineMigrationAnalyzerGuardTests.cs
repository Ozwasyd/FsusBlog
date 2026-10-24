using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationAnalyzerGuardTests
{
    [Fact]
    public async Task MissingOriginalToolRetainsIdentityRefusalBeforeToolOpen()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-tool-guard-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string input = Path.Combine(root, "input");
            await File.WriteAllTextAsync(input, "synthetic input");
            string missingTool = Path.Combine(root, "unopened-tool");
            var configuration = new OfflineMigrationShellBackupDrillConfiguration(root,
                missingTool, missingTool, missingTool, missingTool, input, null,
                new Dictionary<string, string>(), 2, 2);
            var scope = new OfflineMigrationShellBackupDrillInputScope(
                new(CurrentSchemaProviderKind.PostgreSql, "fixture-instance", "fixture-database"),
                input, input, input, root, Path.Combine(root, "plan.json"));
            // Deserialization can supply null record members despite their declared types.
            var tools = JsonSerializer.Deserialize<OfflineMigrationShellBackupDrillTools>("{}")
                ?? throw new InvalidOperationException("fixture_tools_missing");
            var inputs = new OfflineMigrationShellBackupDrillOwnedInputs(configuration, tools, scope,
                _ => throw new InvalidOperationException("tool_read_not_expected"));

            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
                () => inputs.CreateConfigurationAsync(default));

            Assert.Equal(OperatingSystem.IsLinux()
                ? "offline_backup_tool_configuration_original_tool_identity_required"
                : "offline_backup_tool_configuration_linux_operation_owner_required", error.Message);
            Assert.Equal(new[] { input }, Directory.GetFiles(root));
            Assert.Empty(Directory.GetDirectories(root));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ArtifactPublicationKeepsExactBytesPrivateModeAndNoOverwrite()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-publish-guard-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string path = Path.Combine(root, "artifact");
            byte[] bytes = [1, 2, 3, 4];

            CurrentSchemaArtifactReference reference = await OfflineMigrationArtifactPublisher.PublishAsync(
                path, bytes, default);

            Assert.Equal(path, reference.Reference);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), reference.Sha256);
            Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
            }
            await Assert.ThrowsAsync<IOException>(() => OfflineMigrationArtifactPublisher.PublishAsync(
                path, new byte[] { 5, 6 }, default));
            Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
            Assert.Equal(new[] { path }, Directory.GetFiles(root));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
