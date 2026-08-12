using System.Reflection;

using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Validation;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PodSizeCatalogTests
{
    [Fact]
    public void AllCatalogSizesArePositive()
    {
        FieldInfo[] fields = GetSizeFields();

        Assert.NotEmpty(fields);
        Assert.All(
            fields,
            field =>
            {
                int size = Assert.IsType<int>(field.GetValue(null));
                Assert.True(size > 0, $"{field.Name} size must be positive, got {size}");
            });
    }

    [Fact]
    public void AllCatalogSizesMatchPackedContractTypes()
    {
        Type[] contractTypes = typeof(PodSizeCatalog).Assembly.GetTypes();
        MethodInfo sizeOf = typeof(PodContractValidation)
            .GetMethod(nameof(PodContractValidation.SizeOf), BindingFlags.Public | BindingFlags.Static)!;

        foreach (FieldInfo field in GetSizeFields())
        {
            Type contractType = Assert.Single(
                contractTypes,
                type => type.Name == field.Name);
            int expected = Assert.IsType<int>(
                sizeOf.MakeGenericMethod(contractType).Invoke(null, null));

            Assert.Equal(expected, Assert.IsType<int>(field.GetValue(null)));
        }
    }

    [Fact]
    public void CommentPolicyHardcodedSizesMatchPackedContracts()
    {
        // AEDS_V2_PROTOCOL.md delegates payload layout to the packed shared
        // contracts; these are the only catalog entries not derived inline.
        Assert.Equal(41, PodSizeCatalog.CommentPolicySnapshotPod);
        Assert.Equal(
            PodContractValidation.SizeOf<CommentPolicySnapshotPod>(),
            PodSizeCatalog.CommentPolicySnapshotPod);

        Assert.Equal(26, PodSizeCatalog.CommentPolicyUpdateRequestPod);
        Assert.Equal(
            PodContractValidation.SizeOf<CommentPolicyUpdateRequestPod>(),
            PodSizeCatalog.CommentPolicyUpdateRequestPod);
    }

    [Fact]
    public void CurrentFixedLayoutSizesMatchProtocolContracts()
    {
        Assert.Equal(84, PodSizeCatalog.ArticleDetailV3RecordPod);
        Assert.Equal(44, PodSizeCatalog.ArticleDetailV4HeaderPod);
        Assert.Equal(92, PodSizeCatalog.ArticleDetailV4RecordPod);
        Assert.Equal(116, PodSizeCatalog.ArticleDetailV5RecordPod);
        Assert.Equal(48, PodSizeCatalog.ArticleMutationResultPod);
    }

    [Fact]
    public void Utf8FixedSizesIncreaseWithLength()
    {
        Assert.True(PodSizeCatalog.Utf8Fixed32 < PodSizeCatalog.Utf8Fixed64);
        Assert.True(PodSizeCatalog.Utf8Fixed64 < PodSizeCatalog.Utf8Fixed128);
        Assert.True(PodSizeCatalog.Utf8Fixed128 < PodSizeCatalog.Utf8Fixed256);
        Assert.True(PodSizeCatalog.Utf8Fixed256 < PodSizeCatalog.Utf8Fixed512);
    }

    private static FieldInfo[] GetSizeFields()
        => typeof(PodSizeCatalog)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(static field => field.FieldType == typeof(int))
            .ToArray();
}
