namespace FsusBlog.Server.Models.Dtos;

public sealed record class JsonApiResponse<T>(
    bool Success,
    T? Data,
    string? Message = null)
{
    public static JsonApiResponse<T> Ok(T data) => new(true, data);

    public static JsonApiResponse<T> Fail(string message) => new(false, default, message);
}
