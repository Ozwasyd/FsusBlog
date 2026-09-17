using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Shared.Contracts.Localization;

namespace FsusBlog.Server.Tests;

public sealed class LocaleCatalogTests
{
    [Fact]
    public void TryParse_NormalizesOnlyControlledAliases()
    {
        Assert.True(LocaleCatalog.TryParse("zh-tw", out LocaleDescriptor traditionalChinese));
        Assert.Equal("zh-Hant", traditionalChinese.Code);
        Assert.Equal("zh_TW", traditionalChinese.OpenGraphLocale);
        Assert.False(LocaleCatalog.TryParse("zh-XX", out _));
    }

    [Fact]
    public void EnabledCatalog_HasTenUniqueCodesAndStableDefault()
    {
        Assert.Equal(10, LocaleCatalog.Enabled.Count);
        Assert.Equal(10, LocaleCatalog.Enabled.Select(static locale => locale.Code).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal("zh-CN", LocaleCatalog.Default.Code);
    }

    [Fact]
    public void GeneratedEnumMembers_ArePascalCaseAndProjectEveryEnabledCode()
    {
        string[] members = Enum.GetNames<SupportedLocale>();

        Assert.Equal(LocaleCatalog.Enabled.Count, members.Length);
        Assert.All(members, member => Assert.True(char.IsUpper(member[0]), $"{member} must be PascalCase"));
        Assert.Equal(
            LocaleCatalog.Enabled.Select(static descriptor => descriptor.Code).OrderBy(static code => code),
            LocaleCatalog.Enabled
                .Select(static descriptor => descriptor.Locale.ToString())
                .Select(static member => member switch
                {
                    "ZhCN" => "zh-CN",
                    "EnUS" => "en-US",
                    "ZhHant" => "zh-Hant",
                    "JaJP" => "ja-JP",
                    "KoKR" => "ko-KR",
                    "Es419" => "es-419",
                    "FrFR" => "fr-FR",
                    "DeDE" => "de-DE",
                    "PtBR" => "pt-BR",
                    "RuRU" => "ru-RU",
                    _ => throw new InvalidOperationException($"Unexpected generated locale member {member}")
                })
                .OrderBy(static code => code));
    }

    [Fact]
    public void FontLocaleConsumer_NormalizesAndProjectsTheExactGeneratedInventory()
    {
        foreach (LocaleDescriptor descriptor in LocaleCatalog.Enabled)
        {
            Assert.Equal(descriptor.Code, FontLoadingPlanner.NormalizeLocale(descriptor.Code));
            Assert.Equal(descriptor.Script, FontLoadingPlanner.ResolveScript(descriptor.Code, explicitScript: null));
            Assert.Equal(descriptor.Code, FontLoadingPlanner.NormalizeLocale(descriptor.Aliases[0]));
        }

        Assert.Equal("und", FontLoadingPlanner.NormalizeLocale("x-test"));
        Assert.Equal("Hant", FontLoadingPlanner.ResolveScript("zh-tw", explicitScript: null));
    }
}
