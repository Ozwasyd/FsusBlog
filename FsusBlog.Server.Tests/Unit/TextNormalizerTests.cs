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

        Assert.Equal("ABC hello", new string(value));
    }
}
