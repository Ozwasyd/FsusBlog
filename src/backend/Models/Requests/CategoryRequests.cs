namespace FsusBlog.Server.Models.Requests;

public sealed record class CategoryWriteRequest
{
    public required string Name
    {
        get; init;
    }
}
