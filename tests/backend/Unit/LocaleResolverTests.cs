using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Localization;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LocaleResolverTests
{
    private readonly LocaleResolver _resolver = new();

    public static TheoryData<string?, string, LocaleResolutionSource, string> NegotiationCases => new()
    {
        { "ja-JP", "ja-JP", LocaleResolutionSource.AcceptLanguage, "ja-JP" },
        { "de-DE;q=0.4, fr-FR;q=0.9", "fr-FR", LocaleResolutionSource.AcceptLanguage, "fr-FR" },
        { "zh-HK,zh;q=0.8", "zh-Hant", LocaleResolutionSource.AcceptLanguage, "zh-HK" },
        { "zh-Hant", "zh-Hant", LocaleResolutionSource.AcceptLanguage, "zh-Hant" },
        { "zh-TW", "zh-Hant", LocaleResolutionSource.AcceptLanguage, "zh-TW" },
        { "zh-MO", "zh-Hant", LocaleResolutionSource.AcceptLanguage, "zh-MO" },
        { "zh-SG", "zh-CN", LocaleResolutionSource.AcceptLanguage, "zh-SG" },
        { "zh-Hans", "zh-CN", LocaleResolutionSource.AcceptLanguage, "zh-Hans" },
        { "zh", "zh-CN", LocaleResolutionSource.AcceptLanguage, "zh" },
        { "en", "en-US", LocaleResolutionSource.AcceptLanguage, "en" },
        { "ja", "ja-JP", LocaleResolutionSource.AcceptLanguage, "ja" },
        { "ko", "ko-KR", LocaleResolutionSource.AcceptLanguage, "ko" },
        { "fr", "fr-FR", LocaleResolutionSource.AcceptLanguage, "fr" },
        { "de", "de-DE", LocaleResolutionSource.AcceptLanguage, "de" },
        { "es", "es-419", LocaleResolutionSource.AcceptLanguage, "es" },
        { "es-ES", "es-419", LocaleResolutionSource.AcceptLanguage, "es-ES" },
        { "pt", "pt-BR", LocaleResolutionSource.AcceptLanguage, "pt" },
        { "ru", "ru-RU", LocaleResolutionSource.AcceptLanguage, "ru" },
        { "*", "zh-CN", LocaleResolutionSource.AcceptLanguage, "*" },
        { "zh-CN;q=0,*;q=0.5", "en-US", LocaleResolutionSource.AcceptLanguage, "*" },
        { "ja-JP;q=0,fr-FR;q=0", "zh-CN", LocaleResolutionSource.Default, "" },
        { "en-US;q=0,en;q=1", "zh-CN", LocaleResolutionSource.Default, "" },
        { "en;q=0,en-US;q=1", "zh-CN", LocaleResolutionSource.Default, "" },
        { "zh-TW;q=0,zh-Hant;q=1", "zh-CN", LocaleResolutionSource.Default, "" },
        { "ja-JP;q=0.2,ja-JP;q=0.8,en-US;q=0.5", "ja-JP", LocaleResolutionSource.AcceptLanguage, "ja-JP" },
        { "xx-YY,@@@;q=1,en;q=bogus", "zh-CN", LocaleResolutionSource.Default, "" },
        { "ko;q=0.7,ja;q=0.7", "ko-KR", LocaleResolutionSource.AcceptLanguage, "ko" }
    };

    [Theory]
    [MemberData(nameof(NegotiationCases))]
    public void Resolve_UsesCatalogAliasesQualityAndStableOrder(
        string? acceptLanguage,
        string expectedLocale,
        LocaleResolutionSource expectedSource,
        string expectedRange)
    {
        LocaleResolutionResult result = _resolver.Resolve(new LocaleResolutionInput(
            null,
            acceptLanguage,
            LocaleCatalog.Default));

        Assert.Equal(expectedLocale, result.Locale.Code);
        Assert.Equal(expectedSource, result.Source);
        Assert.Equal(expectedRange, result.MatchedRange);
        Assert.Equal(LocaleCatalog.Digest, result.CatalogDigest);
    }

    [Fact]
    public void Resolve_ValidCookieAlwaysPrecedesHeader()
    {
        LocaleResolutionResult result = _resolver.Resolve(new LocaleResolutionInput(
            LocaleCatalog.Enabled.Single(static locale => locale.Code == "en-US"),
            "ja-JP",
            LocaleCatalog.Default));

        Assert.Equal("en-US", result.Locale.Code);
        Assert.Equal(LocaleResolutionSource.ExplicitCookie, result.Source);
    }

    [Fact]
    public void ResolveForRequest_InvalidCookieFallsThroughToHeader()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers.Cookie = $"{PublicLocaleRequest.CookieName}=forged";
        context.Request.Headers.AcceptLanguage = "ja-JP";

        LocaleResolutionResult result = PublicLocaleRequest.Resolve(context, _resolver);

        Assert.Equal("ja-JP", result.Locale.Code);
        Assert.Equal(LocaleResolutionSource.AcceptLanguage, result.Source);
    }

    [Fact]
    public void CacheIdentity_IsBoundedByCatalogAndNeverUsesRawHeader()
    {
        string[] rawHeaders =
        [
            "ja-JP",
            "ja;q=1",
            "JA-jp;q=0.9",
            "zh-HK",
            "zh-TW",
            "zh-MO",
            "en-GB",
            "fr-CA",
            "de-AT",
            "es-ES",
            "pt-PT",
            "ru",
            "ko",
            "*",
            "unknown"
        ];

        string[] keys = rawHeaders
            .Select(header => _resolver.Resolve(new LocaleResolutionInput(null, header, LocaleCatalog.Default)))
            .Select(result => PublicLocaleCacheIdentity.Build("home", result.Locale))
            .ToArray();

        Assert.True(keys.Distinct(StringComparer.Ordinal).Count() <= LocaleCatalog.Enabled.Count);
        Assert.Equal(
            PublicLocaleCacheIdentity.Build(
                "home",
                _resolver.Resolve(new LocaleResolutionInput(null, "ja-JP", LocaleCatalog.Default)).Locale),
            PublicLocaleCacheIdentity.Build(
                "home",
                _resolver.Resolve(new LocaleResolutionInput(null, "ja;q=1", LocaleCatalog.Default)).Locale));
        Assert.DoesNotContain(keys, static key => key.Contains("q=", StringComparison.Ordinal));
    }
}
