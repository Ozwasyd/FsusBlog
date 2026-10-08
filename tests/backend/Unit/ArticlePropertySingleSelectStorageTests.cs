using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticlePropertySingleSelectStorageTests
{
    private static readonly Guid s_definition = Guid.Parse("00000000-0000-0000-0000-000000000001");
    private static readonly Guid s_historicalOption = Guid.Parse("00000000-0000-0000-0000-000000000002");

    [Fact]
    public void Storage_RejectsEmptySingleSelectEvenWithMatchingDigest()
    {
        ArticlePropertyValueEntry entry = Entry(Guid.Empty);
        ArticlePropertyDefinitionIntegrityException error = Assert.Throws<ArticlePropertyDefinitionIntegrityException>(() =>
            ArticlePropertyValuePersistence.ValidateStorageEntries([entry], Types()));
        Assert.Equal("article_property_value_storage_options_invalid", error.Message);
        Assert.Throws<ArticlePropertyDefinitionIntegrityException>(() =>
            ArticlePropertyValuePersistence.ComputeFactsetDigest([entry], Types()));
    }

    [Fact]
    public void Read_RejectsEmptyStoredSingleSelect()
    {
        ArticlePropertyDefinitionIntegrityException error = Assert.Throws<ArticlePropertyDefinitionIntegrityException>(() =>
            ArticlePropertyValuePersistence.ReadStoredSingleSelectValue(Guid.Empty));
        Assert.Equal("article_property_value_storage_options_invalid", error.Message);
    }

    [Fact]
    public void Storage_PreservesNonemptyHistoricalSingleSelectAndDefaultOrigin()
    {
        // Storage has no current definition/option lifecycle authority. A nonempty historical
        // identity remains structurally valid when its current option becomes inactive.
        ArticlePropertyValueEntry entry = Entry(s_historicalOption);
        ArticlePropertyValuePersistence.ValidateStorageEntries([entry], Types());
        string digest = ArticlePropertyValuePersistence.ComputeFactsetDigest([entry], Types());
        Assert.Equal(s_historicalOption, Assert.IsType<ArticlePropertySingleSelectValue>(entry.Value).OptionId);
        Assert.Equal(64, digest.Length);
        ArticlePropertyValueEntry appliedDefault = Entry(s_historicalOption, true);
        ArticlePropertyValuePersistence.ValidateStorageEntries([appliedDefault], Types());
        Assert.NotEqual(digest, ArticlePropertyValuePersistence.ComputeFactsetDigest([appliedDefault], Types()));
    }

    [Fact]
    public void Read_PreservesNonemptyHistoricalSingleSelect()
    {
        ArticlePropertySingleSelectValue value = ArticlePropertyValuePersistence.ReadStoredSingleSelectValue(s_historicalOption);
        Assert.Equal(s_historicalOption, value.OptionId);
    }

    private static Dictionary<Guid, ArticlePropertyValueType> Types()
        => new() { [s_definition] = ArticlePropertyValueType.SingleSelect };

    private static ArticlePropertyValueEntry Entry(Guid optionId, bool defaultApplied = false)
    {
        var input = new ArticlePropertyValueInput(s_definition, 1, new string('a', 64),
            ArticlePropertyValuePresence.Present, new ArticlePropertySingleSelectValue(optionId));
        return new(input.DefinitionId, input.DefinitionSchemaRevision, input.DefinitionDigest,
            input.Presence, input.Value, ArticlePropertyValueDigest.ComputeValue(input, defaultApplied), defaultApplied);
    }
}
