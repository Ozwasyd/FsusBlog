namespace FsusBlog.Server.Infrastructure.Themes;

public sealed record CompiledThemeTokens(
    string SchemaVersion,
    string DefaultMode,
    string Css,
    string ContentHash);

public sealed class ThemeTokenException(
    string errorCode,
    string message,
    Exception? innerException = null) : Exception(message, innerException)
{
    public string ErrorCode
    {
        get;
    } = errorCode;
}
