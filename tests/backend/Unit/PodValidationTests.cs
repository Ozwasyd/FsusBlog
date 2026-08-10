using FsusBlog.Shared;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;
using FsusBlog.Shared.Contracts.Validation;

using CoreFrameType = FsusBlog.Core.Algorithms.AedsFrameType;
using SharedFrameType = FsusBlog.Shared.AedsFrameType;
namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// PodContractValidation
// ──────────────────────────────────────────────────────────────────────────────

public class PodContractValidationTests
{
    [Fact]
    public void AreAllPodModelsReferenceFree_ReturnsTrue()
    {
        bool result = PodContractValidation.AreAllPodModelsReferenceFree();
        Assert.True(result);
    }

    [Fact]
    public void SizeOf_Utf8Fixed32_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed32>();
        Assert.True(size > 0);
        Assert.Equal(32, size);
    }

    [Fact]
    public void CommentPushPod_UsesAuthorSnapshotSlotsWithoutLegacyIdentityFields()
    {
        string[] fields = typeof(CommentPushPod)
            .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
            .Select(static field => field.Name)
            .ToArray();

        Assert.Contains("Author", fields);
        Assert.Contains("ReplyToAuthor", fields);
        Assert.DoesNotContain("UserName", fields);
        Assert.DoesNotContain("ReplyToUserId", fields);
    }

    [Fact]
    public void SizeOf_Utf8Fixed64_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed64>();
        Assert.True(size > 0);
        Assert.Equal(64, size);
    }

    [Fact]
    public void SizeOf_Utf8Fixed128_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed128>();
        Assert.True(size > 0);
        Assert.Equal(128, size);
    }

    [Fact]
    public void SizeOf_Utf8Fixed256_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed256>();
        Assert.True(size > 0);
        Assert.Equal(256, size);
    }

    [Fact]
    public void SizeOf_Utf8Fixed512_ReturnsPositive()
    {
        int size = PodContractValidation.SizeOf<Utf8Fixed512>();
        Assert.True(size > 0);
        Assert.Equal(512, size);
    }
}

public class AedsProtocolMetadataTests
{
    [Fact]
    public void Metadata_UsesCurrentFrameHeaderValues()
    {
        Assert.Equal(AedsFrameHeader.VersionValue, AedsProtocolMetadata.FrameVersion);
        Assert.Equal(AedsFrameHeader.Size, AedsProtocolMetadata.FrameHeaderSize);
        Assert.True(AedsProtocolMetadata.SchemaVersion > 0);
    }

    [Fact]
    public void Metadata_FrameTypesMatchSharedEnum()
    {
        foreach (SharedFrameType frameType in Enum.GetValues<SharedFrameType>())
        {
            string name = Enum.GetName(frameType) ?? ((ushort)frameType).ToString();
            Assert.True(AedsProtocolMetadata.FrameTypes.TryGetValue(name, out ushort raw));
            Assert.Equal((ushort)frameType, raw);
        }
    }

    [Fact]
    public void SharedAndCoreFrameTypes_AreAligned()
    {
        var core = Enum.GetValues<CoreFrameType>()
            .ToDictionary(static value => Enum.GetName(value)!, static value => (ushort)value, StringComparer.Ordinal);
        var shared = Enum.GetValues<SharedFrameType>()
            .ToDictionary(static value => Enum.GetName(value)!, static value => (ushort)value, StringComparer.Ordinal);

        Assert.Equal(core.Count, shared.Count);
        foreach ((string name, ushort raw) in core)
        {
            Assert.True(shared.TryGetValue(name, out ushort sharedRaw), $"Missing shared frame type: {name}");
            Assert.Equal(raw, sharedRaw);
        }
    }

    [Fact]
    public void Metadata_PodSizesMatchCatalogFields()
    {
        var fields = typeof(PodSizeCatalog)
            .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
            .Where(static field => field.FieldType == typeof(int))
            .ToArray();

        Assert.Equal(fields.Length, AedsProtocolMetadata.PodSizes.Count);
        for (int i = 0; i < fields.Length; i++)
        {
            var field = fields[i];
            Assert.True(AedsProtocolMetadata.PodSizes.TryGetValue(field.Name, out int size), $"Missing metadata pod size: {field.Name}");
            Assert.Equal((int)(field.GetValue(null) ?? 0), size);
        }
    }
}
