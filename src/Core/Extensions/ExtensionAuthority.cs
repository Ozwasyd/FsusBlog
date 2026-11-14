using static FsusBlog.V2.Core.Extensions.ExtensionManifestReader;

namespace FsusBlog.V2.Core.Extensions;

public sealed record ExtensionOwner(Guid Actor, Guid Session, long SessionGeneration, Guid Site, int Document, long Revision);

public sealed record ExtensionConsent(string ExtensionId, string ContributionId, ExtensionOwner Owner, string Purpose,
    ExtensionCapability Capability, string? FileRoot, int FileBytes, DateTimeOffset ExpiresAt);

public abstract class ExtensionProposal
{
    private ExtensionProposal(Guid requestId, Guid consentId)
    {
        RequestId = requestId;
        ConsentId = consentId;
    }

    public Guid RequestId { get; }
    public Guid ConsentId { get; }

    public sealed class ReadRange(Guid request, Guid consent, int start, int length) : ExtensionProposal(request, consent)
    {
        public int Start { get; } = start;
        public int Length { get; } = length;
    }

    public sealed class ReadSelection(Guid request, Guid consent) : ExtensionProposal(request, consent);

    public sealed class StageFile(Guid request, Guid consent, string root, int length) : ExtensionProposal(request, consent)
    {
        public string Root { get; } = root;
        public int Length { get; } = length;
    }
}

public sealed class ExtensionAuthority
{
    private readonly object _gate;
    private readonly Action<VerifiedExtensionPackage, CancellationToken, bool>? _verifyInstalled;
    private readonly Dictionary<string, VerifiedExtensionPackage> _packages = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ExtensionInstalledVersion> _lastActivated = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, ExtensionOwner> _owners = new();
    private readonly Dictionary<Guid, Grant> _grants = new();
    private readonly HashSet<Guid> _requests = new();
    private readonly Dictionary<VerifiedExtensionPackage, int> _active = new();
    private ExtensionPackageVerifier _verifier;
    private readonly TimeProvider _clock;
    private long _trustRevision;

    public ExtensionAuthority(ExtensionPackageVerifier verifier, TimeProvider clock) : this(verifier, clock, new(), null) { }

    internal ExtensionAuthority(ExtensionPackageVerifier verifier, TimeProvider clock, object gate,
        Action<VerifiedExtensionPackage, CancellationToken, bool>? verifyInstalled)
    {
        _verifier = verifier;
        _clock = clock;
        _gate = gate;
        _verifyInstalled = verifyInstalled;
    }

    public void ReplaceTrust(ExtensionPackageVerifier updated)
    {
        lock (_gate)
        {
            _verifier = updated;
            _trustRevision++;
            _packages.Clear();
            _grants.Clear();
        }
    }

    public VerifiedExtensionPackage Activate(string approvedSource, ReadOnlyMemory<byte> archive, ReadOnlyMemory<byte> signature,
        ExtensionPlatform platform, CancellationToken cancellationToken = default)
    {
        ExtensionPackageVerifier selected;
        long trustRevision;
        lock (_gate) (selected, trustRevision) = (_verifier, _trustRevision);
        var package = selected.Verify(approvedSource, archive, signature, platform, cancellationToken);
        lock (_gate)
        {
            if (_trustRevision != trustRevision) throw Deny("trust-configuration-changed");
            return ActivateVerified(package, null, cancellationToken);
        }
    }

    internal void RestoreVersion(string id, ExtensionInstalledVersion version)
    {
        lock (_gate) _lastActivated.Add(id, version);
    }

    internal VerifiedExtensionPackage ActivateVerified(VerifiedExtensionPackage package, Action<ExtensionInstalledVersion>? persist,
        CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RequireCurrentTrust(package);
            var id = package.Manifest.Id;
            if (_packages.TryGetValue(id, out var active) && active.Identity == package.Identity)
            {
                _verifyInstalled?.Invoke(active, cancellationToken, true);
                RequireCurrentTrust(active);
                return active;
            }
            var installed = ExtensionInstalledVersion.From(package);
            if (_lastActivated.TryGetValue(id, out var prior)) prior.RequireCompatible(installed);
            else if (_lastActivated.Count >= 1024) throw Deny("active-package-limit");
            persist?.Invoke(installed);
            RemoveGrants(id);
            _packages.Remove(id);
            _lastActivated[id] = installed;
            RequireCurrentTrust(package);
            _packages[id] = package;
            return package;
        }
    }

    public void Deactivate(string extensionId)
    {
        lock (_gate)
        {
            _packages.Remove(extensionId);
            RemoveGrants(extensionId);
        }
    }

    public void SetOwner(ExtensionOwner owner)
    {
        if (owner.Actor == Guid.Empty || owner.Site == Guid.Empty || owner.Session == Guid.Empty ||
            owner.SessionGeneration <= 0 || owner.Document <= 0 || owner.Revision <= 0) throw Deny("owner-shape");
        lock (_gate)
        {
            if (_owners.TryGetValue(owner.Actor, out var before))
            {
                if (before == owner) return;
                if (before.SessionGeneration > owner.SessionGeneration ||
                    (before.SessionGeneration == owner.SessionGeneration && before.Session != owner.Session))
                    throw Deny("owner-generation-regressed");
            }
            else if (_owners.Count >= 4096) throw Deny("owner-limit");
            _owners[owner.Actor] = owner;
            foreach (var id in _grants.Where(item => item.Value.Scope.Owner.Actor == owner.Actor).Select(item => item.Key).ToArray())
                _grants.Remove(id);
        }
    }

    public void RevokeConsent(Guid consentId)
    {
        lock (_gate) _grants.Remove(consentId);
    }

    public Guid RecordConsent(ExtensionConsent scope)
    {
        lock (_gate)
        {
            var now = _clock.GetUtcNow();
            foreach (var expired in _grants.Where(item => item.Value.Scope.ExpiresAt <= now).Select(item => item.Key).ToArray())
                _grants.Remove(expired);
            if (_grants.Count >= 4096) throw Deny("consent-limit");

            if (!_owners.TryGetValue(scope.Owner.Actor, out var owner) || owner != scope.Owner ||
                !_packages.TryGetValue(scope.ExtensionId, out var package)) throw Deny("consent-owner-or-package");
            _verifyInstalled?.Invoke(package, CancellationToken.None, true);
            RequireCurrentTrust(package);
            now = _clock.GetUtcNow();
            var contribution = package.Manifest.Contributions.SingleOrDefault(item => item.Id == scope.ContributionId);
            if (contribution is null || contribution.ExecutionClass == 0 || !contribution.Capabilities.Contains(scope.Capability) || scope.ExpiresAt <= now ||
                scope.ExpiresAt - now > TimeSpan.FromMinutes(5) || scope.ExpiresAt > package.ValidUntil ||
                !IsIdentifier(scope.Purpose) || scope.Purpose is "all" or "any") throw Deny("consent-scope");
            var staging = scope.Capability == ExtensionCapability.FileSystemRootProposeWrite;
            if (staging ? scope.FileRoot is null || !IsIdentifier(scope.FileRoot) || scope.FileBytes is < 1 or > 16_777_216 ||
                scope.FileBytes > package.Manifest.Limits.MaximumFileBytes : scope.FileRoot is not null || scope.FileBytes != 0)
                throw Deny("consent-file-scope");
            var id = Guid.NewGuid();
            _grants.Add(id, new Grant(scope, package));
            return id;
        }
    }

    public Operation Begin(ExtensionOwner caller, string contributionId, string purpose, ExtensionProposal proposal,
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!_grants.TryGetValue(proposal.ConsentId, out var grant)) throw Deny("unknown-consent");
            var scope = grant.Scope;
            var active = _active.GetValueOrDefault(grant.Package);
            if (scope.Owner != caller || scope.ContributionId != contributionId || scope.Purpose != purpose ||
                !ProposalMatches(proposal, grant) || proposal.RequestId == Guid.Empty || _requests.Count >= 65_536 ||
                active >= grant.Package.Manifest.Limits.MaximumConcurrentCalls ||
                _requests.Contains(proposal.RequestId)) throw Deny("proposal-scope");
            Recheck(proposal.ConsentId, grant, cancellationToken, verifyInstalled: true);
            _requests.Add(proposal.RequestId);
            _active[grant.Package] = active + 1;
            return new(this, proposal, grant);
        }
    }

    private static bool ProposalMatches(ExtensionProposal proposal, Grant grant) => proposal switch
    {
        ExtensionProposal.ReadRange range => grant.Scope.Capability == ExtensionCapability.DocumentRangeRead && range.Start >= 0 &&
            range.Length > 0 && range.Length <= grant.Package.Manifest.Limits.MaximumResponseBytes && range.Start <= int.MaxValue - range.Length,
        ExtensionProposal.ReadSelection => grant.Scope.Capability == ExtensionCapability.SelectionRead,
        ExtensionProposal.StageFile file => grant.Scope.Capability == ExtensionCapability.FileSystemRootProposeWrite &&
            file.Root == grant.Scope.FileRoot && file.Length > 0 && file.Length <= grant.Scope.FileBytes,
        _ => false
    };

    private void Recheck(Guid consentId, Grant grant, CancellationToken cancellationToken, bool verifyInstalled)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_grants.TryGetValue(consentId, out var current) || !ReferenceEquals(current, grant) ||
            !_owners.TryGetValue(grant.Scope.Owner.Actor, out var owner) || owner != grant.Scope.Owner ||
            !_packages.TryGetValue(grant.Scope.ExtensionId, out var package) || !ReferenceEquals(package, grant.Package) ||
            grant.Scope.ExpiresAt <= _clock.GetUtcNow()) throw Deny("operation-no-longer-current");
        _verifyInstalled?.Invoke(package, cancellationToken, verifyInstalled);
        cancellationToken.ThrowIfCancellationRequested();
        if (grant.Scope.ExpiresAt <= _clock.GetUtcNow()) throw Deny("operation-no-longer-current");
        RequireCurrentTrust(package);
    }

    private void RequireCurrentTrust(VerifiedExtensionPackage package)
    {
        var now = _clock.GetUtcNow();
        if (now < package.CheckedAt || now >= package.ValidUntil) throw Deny("publisher-key-not-current");
    }

    private void RemoveGrants(string extensionId)
    {
        foreach (var id in _grants.Where(item => item.Value.Scope.ExtensionId == extensionId).Select(item => item.Key).ToArray())
            _grants.Remove(id);
    }

    private static ExtensionRejectedException Deny(string code) => new(code);

    internal sealed record Grant(ExtensionConsent Scope, VerifiedExtensionPackage Package);

    public sealed class Operation : IDisposable
    {
        private readonly ExtensionAuthority _authority;
        private readonly Grant _grant;
        private readonly long _started;
        private bool _stagingStarted;
        private bool _closed;

        internal Operation(ExtensionAuthority authority, ExtensionProposal proposal, Grant grant)
        {
            _authority = authority;
            Proposal = proposal;
            _grant = grant;
            _started = authority._clock.GetTimestamp();
        }

        public ExtensionProposal Proposal { get; }

        internal void RequireActive(CancellationToken cancellationToken)
        {
            lock (_authority._gate) Check(cancellationToken);
        }

        internal CancellationTokenSource BeginStaging(CancellationToken cancellationToken)
        {
            lock (_authority._gate)
            {
                Check(cancellationToken);
                if (_stagingStarted) throw Deny("staging-already-started");
                var clock = _authority._clock;
                var wall = _grant.Package.Manifest.Limits.WallClock - clock.GetElapsedTime(_started);
                var consent = _grant.Scope.ExpiresAt - clock.GetUtcNow();
                var remaining = wall < consent ? wall : consent;
                var budget = new CancellationTokenSource(remaining > TimeSpan.Zero ? remaining : TimeSpan.Zero, clock);
                _stagingStarted = true;
                return budget;
            }
        }

        public void Complete(Action publish, CancellationToken cancellationToken = default)
        {
            lock (_authority._gate)
            {
                try
                {
                    Check(cancellationToken, verifyInstalled: true);
                    publish();
                }
                finally { Close(); }
            }
        }

        public void Dispose()
        {
            lock (_authority._gate) Close();
        }

        private void Check(CancellationToken cancellationToken, bool verifyInstalled = false)
        {
            if (_closed) throw Deny("operation-closed");
            if (_authority._clock.GetElapsedTime(_started) >= _grant.Package.Manifest.Limits.WallClock)
                throw Deny("operation-deadline");
            _authority.Recheck(Proposal.ConsentId, _grant, cancellationToken, verifyInstalled);
            if (_authority._clock.GetElapsedTime(_started) >= _grant.Package.Manifest.Limits.WallClock)
                throw Deny("operation-deadline");
        }

        private void Close()
        {
            if (_closed) return;
            _closed = true;
            var left = _authority._active[_grant.Package] - 1;
            if (left == 0) _authority._active.Remove(_grant.Package);
            else _authority._active[_grant.Package] = left;
        }
    }
}

internal sealed record ExtensionInstalledVersion(string Publisher, string Version, string ArchiveDigest, int StateSchema, int DataSchema)
{
    internal static ExtensionInstalledVersion From(VerifiedExtensionPackage package) => new(package.Manifest.Publisher,
        package.Manifest.Version, package.ArchiveDigest, package.Manifest.StateSchemaVersion, package.Manifest.DataSchemaVersion);

    internal void RequireCompatible(ExtensionInstalledVersion next)
    {
        var version = System.Version.Parse(next.Version).CompareTo(System.Version.Parse(Version));
        if (Publisher != next.Publisher || version < 0 || (version == 0 && ArchiveDigest != next.ArchiveDigest) ||
            StateSchema != next.StateSchema || DataSchema != next.DataSchema)
            throw new ExtensionRejectedException("package-version-switch");
    }
}
