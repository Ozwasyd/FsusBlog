namespace FsusBlog.Server.Infrastructure.Operations;

/// <summary>
/// A deployable release identity. Schema compatibility fences intentionally use
/// recorded historical scalar values, not this deployment identity parser.
/// </summary>
public readonly record struct ReleaseId
{
    private ReleaseId(string value)
    {
        Value = value;
    }

    public string Value
    {
        get;
    }

    public static ReleaseId Parse(string value)
    {
        if (!ReleaseIdContract.TryParse(value, out _, out _))
        {
            throw new ArgumentException("ReleaseId must use the canonical release identity format.", nameof(value));
        }

        return new ReleaseId(value);
    }

    public static bool TryParse(string value, out ReleaseId releaseId)
    {
        if (ReleaseIdContract.TryParse(value, out _, out _))
        {
            releaseId = new ReleaseId(value);
            return true;
        }

        releaseId = default;
        return false;
    }

    public override string ToString() => Value;
}
