namespace FsusBlog.Server.Interfaces;

public interface IContentFilterService
{
    (bool isValid, string message) ValidateContent(string text);
    void ReloadKeywords();
}