using System.Globalization;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Testing;

/// <summary>
/// Test-only .NET adapter for the Node-owned resolved temporal role artifact.
/// It consumes exact instants and never recalculates catalog offsets.
/// </summary>
public sealed class ResolvedTemporalRoleContext
{
    public const string ArtifactEnvironmentVariable = "FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON";
    public const string ArtifactDigestEnvironmentVariable = "FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST";
    private const string ResolvedRolesSchema = "fsusblog.resolved-temporal-roles.v1";
    private readonly IReadOnlyDictionary<string, DateTimeOffset> _roles;

    private ResolvedTemporalRoleContext(
        string producerId,
        string schedulerRunId,
        string contentDigest,
        IReadOnlyDictionary<string, DateTimeOffset> roles)
    {
        ProducerId = producerId;
        SchedulerRunId = schedulerRunId;
        ContentDigest = contentDigest;
        _roles = roles;
    }

    public string ProducerId
    {
        get;
    }

    public string SchedulerRunId
    {
        get;
    }

    public string ContentDigest
    {
        get;
    }

    public static ResolvedTemporalRoleContext FromEnvironment()
    {
        string raw = Environment.GetEnvironmentVariable(ArtifactEnvironmentVariable)
            ?? throw new InvalidOperationException($"{ArtifactEnvironmentVariable} is required.");
        string environmentDigest = Environment.GetEnvironmentVariable(ArtifactDigestEnvironmentVariable)
            ?? throw new InvalidOperationException($"{ArtifactDigestEnvironmentVariable} is required.");
        return Parse(raw, environmentDigest);
    }

    public static ResolvedTemporalRoleContext Parse(string raw, string expectedContentDigest)
    {
        ArgumentNullException.ThrowIfNull(raw);
        if (raw.Length > 1024 * 1024)
        {
            throw new InvalidOperationException("Resolved temporal role artifact exceeds the bounded artifact size.");
        }

        using JsonDocument document = JsonDocument.Parse(raw);
        JsonElement root = document.RootElement;
        RequireString(root, "schema", ResolvedRolesSchema);
        string contentDigest = RequireDigest(root, "contentDigest");
        if (!string.Equals(contentDigest, expectedContentDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Resolved temporal role artifact digest does not match its ingress binding.");
        }

        JsonElement contextIdentity = root.GetProperty("contextIdentity");
        string producerId = RequireText(contextIdentity, "producerId");
        string schedulerRunId = RequireText(contextIdentity, "schedulerRunId");
        var roles = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
        foreach (JsonElement role in root.GetProperty("roles").EnumerateArray())
        {
            string roleId = RequireText(role, "roleId");
            RequireString(role, "clockKind", "business-wall");
            RequireString(role, "semanticEffect", "included");
            RequireString(role, "precision", "millisecond");
            DateTimeOffset instant = ParseUtcInstant(RequireText(role, "instantUtc"), roleId);
            if (!roles.TryAdd(roleId, instant))
            {
                throw new InvalidOperationException($"Resolved temporal role artifact contains duplicate role {roleId}.");
            }
        }

        return new ResolvedTemporalRoleContext(
            producerId,
            schedulerRunId,
            contentDigest,
            roles);
    }

    public DateTimeOffset RequireInstant(string roleId)
        => _roles.TryGetValue(roleId, out DateTimeOffset instant)
            ? instant
            : throw new InvalidOperationException($"Resolved temporal role artifact is missing {roleId}.");

    public TimeSpan RequireDuration(string fromRoleId, string toRoleId)
    {
        TimeSpan duration = RequireInstant(toRoleId) - RequireInstant(fromRoleId);
        return duration > TimeSpan.Zero
            ? duration
            : throw new InvalidOperationException(
                $"Resolved temporal role duration {fromRoleId} to {toRoleId} must be positive.");
    }

    private static DateTimeOffset ParseUtcInstant(string value, string roleId)
    {
        if (!DateTimeOffset.TryParseExact(
                value,
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out DateTimeOffset parsed)
            || parsed.Offset != TimeSpan.Zero)
        {
            throw new InvalidOperationException($"Resolved temporal role {roleId} is not an exact millisecond UTC instant.");
        }

        return parsed;
    }

    private static string RequireDigest(JsonElement parent, string property)
    {
        string value = RequireText(parent, property);
        if (value.Length != 71
            || !value.StartsWith("sha256:", StringComparison.Ordinal)
            || value[7..].Any(static character =>
                !char.IsAsciiHexDigit(character) || char.IsAsciiLetterUpper(character)))
        {
            throw new InvalidOperationException($"Resolved temporal role artifact {property} is not a sha256 digest.");
        }

        return value;
    }

    private static string RequireText(JsonElement parent, string property)
    {
        string? value = parent.GetProperty(property).GetString();
        return !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new InvalidOperationException($"Resolved temporal role artifact {property} is required.");
    }

    private static void RequireString(JsonElement parent, string property, string expected)
    {
        string actual = RequireText(parent, property);
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Resolved temporal role artifact {property} must be {expected}.");
        }
    }
}
