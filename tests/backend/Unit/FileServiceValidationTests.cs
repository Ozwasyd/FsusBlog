using System.Reflection;

using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests;

public sealed class FileServiceValidationTests
{
    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(FileService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }

    [Theory]
    [InlineData(null, "")]
    [InlineData("  ", "")]
    [InlineData("  ABC123  ", "abc123")]
    public void NormalizeHash_ReturnsExpected(string? input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeHash", [input]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(null, "")]
    [InlineData("", "")]
    [InlineData(".jpg", ".jpg")]
    [InlineData("jpg", ".jpg")]
    [InlineData("JPG", ".jpg")]
    [InlineData(".WEBP", ".webp")]
    public void NormalizeExtension_ReturnsExpected(string? input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeExtension", [input]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(".jpg", true)]
    [InlineData(".jpeg", true)]
    [InlineData(".png", true)]
    [InlineData(".gif", true)]
    [InlineData(".webp", true)]
    [InlineData(".ico", true)]
    [InlineData(".avif", false)]
    [InlineData(".svg", false)]
    [InlineData(".bmp", false)]
    [InlineData(".exe", false)]
    public void IsAllowedExtension_ReturnsExpected(string ext, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsAllowedExtension", [ext]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("image/jpeg", true)]
    [InlineData("image/png", true)]
    [InlineData("image/gif", true)]
    [InlineData("image/webp", true)]
    [InlineData("image/x-icon", true)]
    [InlineData("image/vnd.microsoft.icon", true)]
    [InlineData("image/avif", false)]
    [InlineData("image/svg+xml", false)]
    [InlineData("image/bmp", false)]
    [InlineData(null, false)]
    [InlineData("", false)]
    public void IsSupportedImageMime_ReturnsExpected(string? mimeType, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsSupportedImageMime", [mimeType]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("image/jpeg", "jpg", true)]
    [InlineData("image/jpeg", "jpeg", true)]
    [InlineData("image/png", "png", true)]
    [InlineData("image/webp", "webp", true)]
    [InlineData("image/x-icon", "ico", true)]
    [InlineData("image/vnd.microsoft.icon", "ico", true)]
    [InlineData("image/jpeg", "png", false)]
    [InlineData("image/svg+xml", "svg", false)]
    [InlineData(null, "jpg", true)]   // null mime means compatible
    [InlineData("", "jpg", true)]     // empty mime means compatible
    public void IsMimeCompatibleWithFormat_ReturnsExpected(string? mimeType, string format, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsMimeCompatibleWithFormat", [mimeType, format]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", true)]  // 64 hex chars
    [InlineData("ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD", true)]   // 64 hex uppercase
    [InlineData("short", false)]
    [InlineData("gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg", false)]  // invalid hex chars
    public void IsValidSha256_ReturnsExpected(string value, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsValidSha256", [value]);
        Assert.Equal(expected, result);
    }
}
