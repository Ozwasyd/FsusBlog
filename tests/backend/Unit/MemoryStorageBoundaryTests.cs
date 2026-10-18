using FsusBlog.Server.Infrastructure.Storage;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryStorageBoundaryTests
{
    [Fact]
    public void DefaultSpillSelectionUsesExistingInstanceOwnerWithoutCreatingDirectories()
    {
        string missing = Path.Combine(Path.GetTempPath(), $"mem-layout-{Guid.NewGuid():N}");
        ReleaseStorageLayout first = Layout(missing, "first");
        ReleaseStorageLayout second = Layout(missing, "second");
        string selected = first.GetInstanceTempPath("memory-spill");

        Assert.Equal(Path.Combine(first.Paths.TempRoot, "memory-spill"), selected);
        Assert.NotEqual(selected, second.GetInstanceTempPath("memory-spill"));
        Assert.Equal("memory-spill", Path.GetRelativePath(first.Paths.TempRoot, selected));
        Assert.False(selected.StartsWith(first.Paths.SharedRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal));
        Assert.False(selected.StartsWith(first.Paths.ReleaseDerivedRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal));
        Assert.False(selected.StartsWith(first.Paths.ImmutableAssetRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal));
        Assert.False(Directory.Exists(missing));
    }

    [Theory]
    [InlineData("../shared")]
    [InlineData("memory-spill/../../public-aot")]
    public void ExistingStorageOwnerRejectsEscapingAnInstanceSpillSelection(string relative)
    {
        string missing = Path.Combine(Path.GetTempPath(), $"mem-layout-{Guid.NewGuid():N}");
        ReleaseStorageLayout layout = Layout(missing, "first");
        Assert.Throws<ArgumentException>(() => layout.GetInstanceTempPath(relative));
        Assert.False(Directory.Exists(missing));
    }

    private static ReleaseStorageLayout Layout(string root, string instance)
        => new(Path.Combine(root, "shared"), Path.Combine(root, "derived"),
            Path.Combine(root, "assets"), Path.Combine(root, "instances"),
            "19700101000000-000000000000", "local", instance, Path.Combine(root, "wwwroot"));
}
