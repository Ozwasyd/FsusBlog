using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class TextNormalizerTests
{
    [Fact]
    public void NormalizeInPlace_NormalizesAsciiAndFullWidthCharacters()
    {
        Result initialization = TextNormalizer.Initialize(NullLogger.Instance);
        Assert.True(initialization.IsSuccess);

        char[] value = "ＡＢＣ　Hello".ToCharArray();
        TextNormalizer.NormalizeInPlace(value);

        Assert.Equal("abc hello", new string(value));
    }

    [Fact]
    public void NormalizeWithPhraseMappingsForTests_UsesLongestPhraseBeforeCharMap()
    {
        Result initialization = TextNormalizer.Initialize(NullLogger.Instance);
        Assert.True(initialization.IsSuccess);

        string result = TextNormalizer.NormalizeWithPhraseMappingsForTests(
            "乾燥機與伺服器",
            new Dictionary<string, string>
            {
                ["乾燥機"] = "干燥机",
                ["乾燥"] = "干燥",
                ["伺服器"] = "服务器"
            });

        Assert.Equal("干燥机与服务器", result);
    }
}
