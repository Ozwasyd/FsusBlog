using System.Reflection;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record ReleaseIdentitySnapshot(
    string ReleaseId,
    string ReleaseSlot,
    string CommitSha,
    string ImageRef,
    string ImageDigest,
    bool Configured,
    DateTimeOffset? CreatedAtUtc = null,
    bool CreatedAtConsistent = true);

public static class ReleaseIdentityResponseHeaders
{
    public static void Apply(IHeaderDictionary headers, ReleaseIdentitySnapshot releaseIdentity)
    {
        headers["X-Fsus-Release-Id"] = releaseIdentity.ReleaseId;
        headers["X-Fsus-Release-Slot"] = releaseIdentity.ReleaseSlot;
    }
}

public interface IReleaseIdentityProvider
{
    ReleaseIdentitySnapshot Current
    {
        get;
    }

    ProductionReleaseIdentityHealthCheck CreateHealthCheck(bool requireConfigured);
}

public interface IAssemblyReleaseIdentityProvider
{
    string InformationalVersion
    {
        get;
    }
}

public sealed class EntryAssemblyReleaseIdentityProvider : IAssemblyReleaseIdentityProvider
{
    public string InformationalVersion
        => Assembly.GetEntryAssembly()?
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion
            ?.Trim()
            ?? string.Empty;
}

public sealed class ReleaseIdentityProvider(IConfiguration configuration) : IReleaseIdentityProvider
{
    private readonly ReleaseIdentitySnapshot _current = Resolve(configuration);

    public ReleaseIdentitySnapshot Current => _current;

    public ProductionReleaseIdentityHealthCheck CreateHealthCheck(bool requireConfigured)
    {
        IReadOnlyList<string> errors = Validate(_current, requireConfigured);
        return new ProductionReleaseIdentityHealthCheck(
            errors.Count == 0 ? "ok" : "failed",
            _current.ReleaseId,
            _current.ReleaseSlot,
            _current.CommitSha,
            _current.ImageRef,
            _current.ImageDigest,
            errors.Count == 0 ? null : "release_identity_invalid");
    }

    internal static ReleaseIdentitySnapshot Resolve(IConfiguration configuration)
    {
        string releaseId = Read(configuration, "FSUSBLOG_RELEASE_ID", "Release:Id");
        string releaseSlot = Read(configuration, "FSUSBLOG_RELEASE_SLOT", "Release:Slot");
        string commitSha = Read(configuration, "FSUSBLOG_COMMIT_SHA", "Release:CommitSha");
        string createdAtValue = Read(configuration, "FSUSBLOG_RELEASE_CREATED_AT_UTC", "Release:CreatedAtUtc");
        string imageRef = Read(configuration, "FSUSBLOG_IMAGE_REF", "Release:ImageRef");
        string imageDigest = Read(configuration, "FSUSBLOG_IMAGE_DIGEST", "Release:ImageDigest").ToLowerInvariant();
        bool releaseIdParsed = ReleaseIdContract.TryParse(
            releaseId,
            out DateTimeOffset releaseCreatedAtUtc,
            out _);
        bool createdAtProvided = createdAtValue.Length > 0;
        DateTimeOffset configuredCreatedAtUtc = default;
        bool createdAtParsed = !createdAtProvided || ReleaseIdContract.TryParseCreatedAtUtc(
            createdAtValue,
            out configuredCreatedAtUtc);
        bool configured = releaseId.Length > 0
            && releaseSlot.Length > 0
            && commitSha.Length > 0
            && imageRef.Length > 0
            && imageDigest.Length > 0
            && releaseIdParsed;
        bool createdAtConsistent = !configured ||
            (createdAtParsed &&
             (!createdAtProvided ||
              releaseCreatedAtUtc == configuredCreatedAtUtc.AddTicks(-(configuredCreatedAtUtc.Ticks % TimeSpan.TicksPerSecond))));
        return new ReleaseIdentitySnapshot(
            releaseId.Length == 0 ? "local-unversioned" : releaseId,
            releaseSlot.Length == 0 ? "local" : releaseSlot,
            commitSha.Length == 0 ? new string('0', 40) : commitSha,
            imageRef.Length == 0 ? "local-unversioned" : imageRef,
            imageDigest.Length == 0 ? $"sha256:{new string('0', 64)}" : imageDigest,
            configured,
            releaseIdParsed ? releaseCreatedAtUtc : null,
            createdAtConsistent);
    }

    internal static IReadOnlyList<string> Validate(ReleaseIdentitySnapshot snapshot, bool requireConfigured)
    {
        var errors = new List<string>();
        if (requireConfigured && !snapshot.Configured)
        {
            errors.Add("release_identity_missing");
            return errors;
        }
        if (!snapshot.Configured)
        {
            return errors;
        }
        if (!ReleaseIdContract.TryParse(snapshot.ReleaseId, out DateTimeOffset releaseCreatedAtUtc, out string commitShaPrefix))
        {
            errors.Add("release_id_invalid");
        }
        else if (!System.Text.RegularExpressions.Regex.IsMatch(snapshot.CommitSha, "^[0-9a-f]{40}$"))
        {
            errors.Add("release_commit_invalid");
        }
        else if (!snapshot.CommitSha.StartsWith(commitShaPrefix, StringComparison.Ordinal))
        {
            errors.Add("release_id_commit_mismatch");
        }
        if (snapshot.CreatedAtUtc is null ||
            snapshot.CreatedAtUtc.Value != releaseCreatedAtUtc ||
            !snapshot.CreatedAtConsistent)
        {
            errors.Add("release_id_created_at_mismatch");
        }
        if (!System.Text.RegularExpressions.Regex.IsMatch(snapshot.ReleaseSlot, "^[a-z][a-z0-9-]{0,31}$"))
        {
            errors.Add("release_slot_invalid");
        }
        if (!System.Text.RegularExpressions.Regex.IsMatch(snapshot.ImageDigest, "^sha256:[0-9a-f]{64}$"))
        {
            errors.Add("release_digest_invalid");
        }
        if (!System.Text.RegularExpressions.Regex.IsMatch(
                snapshot.ImageRef,
                "^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[0-9]+(?:/[a-z0-9]+(?:[._/-][a-z0-9]+)*)?)?@sha256:[0-9a-f]{64}$")
            || !snapshot.ImageRef.EndsWith($"@{snapshot.ImageDigest}", StringComparison.Ordinal))
        {
            errors.Add("release_image_ref_invalid");
        }
        return errors;
    }

    private static string Read(IConfiguration configuration, string environmentKey, string fallbackKey)
        => (configuration[environmentKey] ?? configuration[fallbackKey] ?? string.Empty).Trim();
}

public sealed class ReleaseIdentityStartupLogger(
    IReleaseIdentityProvider releaseIdentity,
    IAssemblyReleaseIdentityProvider assemblyReleaseIdentity,
    IWebHostEnvironment environment,
    ILogger<ReleaseIdentityStartupLogger> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        ProductionReleaseIdentityHealthCheck health = releaseIdentity.CreateHealthCheck(environment.IsProduction());
        if (!string.Equals(health.Status, "ok", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Production release identity is missing or invalid.");
        }
        ReleaseIdentitySnapshot current = releaseIdentity.Current;
        string? assemblyIdentityError = ValidateAssemblyInformationalVersion(
            current,
            assemblyReleaseIdentity.InformationalVersion,
            environment.IsProduction());
        if (assemblyIdentityError is not null)
        {
            throw new InvalidOperationException(
                $"Production assembly release identity is invalid: {assemblyIdentityError}.");
        }
        logger.LogInformation(
            "FsusBlog release starting. ReleaseId={ReleaseId} Slot={ReleaseSlot} Commit={CommitSha} ImageRef={ImageRef} ImageDigest={ImageDigest}",
            current.ReleaseId,
            current.ReleaseSlot,
            current.CommitSha,
            current.ImageRef,
            current.ImageDigest);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    internal static string? ValidateAssemblyInformationalVersion(
        ReleaseIdentitySnapshot releaseIdentity,
        string assemblyInformationalVersion,
        bool requireCanonicalIdentity)
    {
        if (!requireCanonicalIdentity)
        {
            return null;
        }

        string candidate = assemblyInformationalVersion.Trim();
        if (candidate.Length == 0 || candidate == ReleaseIdContract.LocalSentinel)
        {
            return "release_assembly_identity_missing";
        }

        return string.Equals(candidate, releaseIdentity.ReleaseId, StringComparison.Ordinal)
            ? null
            : "release_assembly_identity_mismatch";
    }
}
