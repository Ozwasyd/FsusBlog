namespace FsusBlog.Server.Interfaces;

public readonly record struct ContentValidationResult(bool IsValid, string ReasonCode, string Message);

public interface IContentFilterService
{
    ContentValidationResult ValidateContent(string text);
    void ReloadKeywords();
}
