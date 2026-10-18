using System.Collections.Immutable;
using System.Net;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringServiceGrantResolutionExpiryTests
{
    private static readonly DateTimeOffset s_start = new(2026, 10, 18, 0, 0, 0, TimeSpan.Zero);
    private static readonly ImmutableArray<IPAddress> s_addresses = [IPAddress.Parse("93.184.216.34")];
    private static readonly string s_root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "fsusblog-grant-expiry-owned"));

    [Theory]
    [InlineData(1, -1, false)]
    [InlineData(1, 0, false)]
    [InlineData(1, 1, false)]
    [InlineData(2, -1, false)]
    [InlineData(2, 0, false)]
    [InlineData(2, 1, false)]
    [InlineData(1, -1, true)]
    [InlineData(1, 0, true)]
    [InlineData(1, 1, true)]
    [InlineData(2, -1, true)]
    [InlineData(2, 0, true)]
    [InlineData(2, 1, true)]
    public async Task NetworkResolution_ExpiryIsExclusiveAfterEachDnsAwait(
        int suspendedCall,
        int completionOffsetTicks,
        bool validateOnly)
    {
        var clock = new MutableTimeProvider(s_start);
        var gate = new ResolutionGate();
        var resolver = new ControlledAddressResolver(gate, suspendedCall);
        var validator = CreateValidator(clock, resolver, new ControlledPathVerifier(new ResolutionGate()));
        AuthoringNetworkGrant grant = CreateNetworkGrant();

        Task operation = ResolveNetworkAsync(validator, grant, validateOnly);
        await gate.WaitUntilEnteredAsync();
        Assert.False(operation.IsCompleted);
        clock.UtcNow = grant.ExpiresAt.AddTicks(completionOffsetTicks);
        gate.Release();

        if (completionOffsetTicks >= 0)
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => operation);
            Assert.Equal(suspendedCall, resolver.Calls);
        }
        else
        {
            await operation;
            Assert.Equal(2, resolver.Calls);
        }
    }

    [Theory]
    [InlineData(-1, false)]
    [InlineData(0, false)]
    [InlineData(1, false)]
    [InlineData(-1, true)]
    [InlineData(0, true)]
    [InlineData(1, true)]
    public async Task FileResolution_ExpiryIsExclusiveAfterPathAwait(int completionOffsetTicks, bool validateOnly)
    {
        var clock = new MutableTimeProvider(s_start);
        var gate = new ResolutionGate();
        var verifier = new ControlledPathVerifier(gate);
        var validator = CreateValidator(clock, new ControlledAddressResolver(new ResolutionGate(), 0), verifier);
        AuthoringFileGrant grant = CreateFileGrant();

        Task operation = ResolveFileAsync(validator, grant, validateOnly);
        await gate.WaitUntilEnteredAsync();
        Assert.False(operation.IsCompleted);
        clock.UtcNow = grant.ExpiresAt.AddTicks(completionOffsetTicks);
        gate.Release();

        if (completionOffsetTicks >= 0)
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => operation);
        }
        else
        {
            await operation;
        }
        Assert.Equal(1, verifier.Calls);
    }

    [Theory]
    [InlineData(1, false, false)]
    [InlineData(2, false, false)]
    [InlineData(1, true, false)]
    [InlineData(2, true, false)]
    [InlineData(1, false, true)]
    [InlineData(2, false, true)]
    [InlineData(1, true, true)]
    [InlineData(2, true, true)]
    public async Task NetworkResolution_CancellationIsRecheckedAfterEachDnsAwait(
        int suspendedCall,
        bool validateOnly,
        bool alsoExpired)
    {
        using var cancellation = new CancellationTokenSource();
        var clock = new MutableTimeProvider(s_start);
        var gate = new ResolutionGate();
        var resolver = new ControlledAddressResolver(gate, suspendedCall);
        var validator = CreateValidator(clock, resolver, new ControlledPathVerifier(new ResolutionGate()));
        AuthoringNetworkGrant grant = CreateNetworkGrant();

        Task operation = ResolveNetworkAsync(validator, grant, validateOnly, cancellation.Token);
        await gate.WaitUntilEnteredAsync();
        Assert.False(operation.IsCompleted);
        cancellation.Cancel();
        if (alsoExpired)
        {
            clock.UtcNow = grant.ExpiresAt;
        }
        gate.Release();

        OperationCanceledException exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
        Assert.Equal(cancellation.Token, exception.CancellationToken);
        Assert.Equal(cancellation.Token, resolver.LastCancellationToken);
        Assert.Equal(suspendedCall, resolver.Calls);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task FileResolution_CancellationIsRecheckedAfterPathAwait(bool validateOnly, bool alsoExpired)
    {
        using var cancellation = new CancellationTokenSource();
        var clock = new MutableTimeProvider(s_start);
        var gate = new ResolutionGate();
        var verifier = new ControlledPathVerifier(gate);
        var validator = CreateValidator(clock, new ControlledAddressResolver(new ResolutionGate(), 0), verifier);
        AuthoringFileGrant grant = CreateFileGrant();

        Task operation = ResolveFileAsync(validator, grant, validateOnly, cancellation.Token);
        await gate.WaitUntilEnteredAsync();
        Assert.False(operation.IsCompleted);
        cancellation.Cancel();
        if (alsoExpired)
        {
            clock.UtcNow = grant.ExpiresAt;
        }
        gate.Release();

        OperationCanceledException exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
        Assert.Equal(cancellation.Token, exception.CancellationToken);
        Assert.Equal(cancellation.Token, verifier.LastCancellationToken);
        Assert.Equal(1, verifier.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Resolution_AlreadyExpiredGrantsFailBeforeResolvers(bool validateOnly)
    {
        AuthoringNetworkGrant networkGrant = CreateNetworkGrant();
        AuthoringFileGrant fileGrant = CreateFileGrant();
        var resolver = new ControlledAddressResolver(new ResolutionGate(), 0);
        var verifier = new ControlledPathVerifier(new ResolutionGate());
        var validator = CreateValidator(new MutableTimeProvider(networkGrant.ExpiresAt), resolver, verifier);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            ResolveNetworkAsync(validator, networkGrant, validateOnly));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            ResolveFileAsync(validator, fileGrant, validateOnly));
        Assert.Equal(0, resolver.Calls);
        Assert.Equal(0, verifier.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Resolution_AlreadyCancelledRequestsFailBeforeResolvers(bool validateOnly)
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var resolver = new ControlledAddressResolver(new ResolutionGate(), 0);
        var verifier = new ControlledPathVerifier(new ResolutionGate());
        var validator = CreateValidator(new MutableTimeProvider(s_start), resolver, verifier);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            ResolveNetworkAsync(validator, CreateNetworkGrant(), validateOnly, cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            ResolveFileAsync(validator, CreateFileGrant(), validateOnly, cancellation.Token));
        Assert.Equal(0, resolver.Calls);
        Assert.Equal(0, verifier.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ValidateNetworkAsync_DnsRebinding_FailsClosed(bool validateOnly)
    {
        var gate = new ResolutionGate();
        var resolver = new ControlledAddressResolver(gate, 2, rebind: true);
        var validator = CreateValidator(new MutableTimeProvider(s_start), resolver, new ControlledPathVerifier(new ResolutionGate()));

        Task operation = ResolveNetworkAsync(validator, CreateNetworkGrant(), validateOnly);
        await gate.WaitUntilEnteredAsync();
        gate.Release();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => operation);
        Assert.Equal(2, resolver.Calls);
    }

    [Theory]
    [InlineData(true, false, false)]
    [InlineData(true, false, true)]
    [InlineData(false, true, false)]
    [InlineData(false, true, true)]
    public async Task ValidateFileAsync_ReparseBoundary_FailsClosed(
        bool hasReparseBoundary,
        bool escapesRoot,
        bool validateOnly)
    {
        var gate = new ResolutionGate();
        var verifier = new ControlledPathVerifier(gate, hasReparseBoundary, escapesRoot);
        var validator = CreateValidator(new MutableTimeProvider(s_start), new ControlledAddressResolver(new ResolutionGate(), 0), verifier);

        Task operation = ResolveFileAsync(validator, CreateFileGrant(), validateOnly);
        await gate.WaitUntilEnteredAsync();
        gate.Release();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => operation);
        Assert.Equal(1, verifier.Calls);
    }

    private static AuthoringServiceGrantValidator CreateValidator(
        TimeProvider clock,
        IAuthoringNetworkAddressResolver resolver,
        IAuthoringFilePathVerifier verifier) =>
        new(resolver, verifier, clock, ImmutableHashSet.Create(StringComparer.Ordinal, s_root));

    private static AuthoringNetworkGrant CreateNetworkGrant() =>
        new(new string('a', 64), new string('b', 64), "example.com", 443, "import", true, 1024, s_start.AddMinutes(1));

    private static AuthoringFileGrant CreateFileGrant() =>
        new(new string('a', 64), new string('b', 64), s_root, "file.txt", AuthoringFileGrantOperation.Read, "import", 1024, s_start.AddMinutes(1));

    private static async Task ResolveNetworkAsync(
        AuthoringServiceGrantValidator validator,
        AuthoringNetworkGrant grant,
        bool validateOnly,
        CancellationToken cancellationToken = default)
    {
        if (validateOnly)
        {
            await validator.ValidateNetworkAsync(grant, grant.RuntimeIdentity, cancellationToken);
        }
        else
        {
            ImmutableArray<IPAddress> addresses = await validator.ResolveNetworkAsync(grant, grant.RuntimeIdentity, cancellationToken);
            Assert.Equal<IPAddress>(s_addresses, addresses);
        }
    }

    private static async Task ResolveFileAsync(
        AuthoringServiceGrantValidator validator,
        AuthoringFileGrant grant,
        bool validateOnly,
        CancellationToken cancellationToken = default)
    {
        if (validateOnly)
        {
            await validator.ValidateFileAsync(grant, grant.RuntimeIdentity, cancellationToken);
        }
        else
        {
            string path = await validator.ResolveFileAsync(grant, grant.RuntimeIdentity, cancellationToken);
            Assert.Equal(Path.Combine(s_root, grant.RelativePath), path);
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = now;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    private sealed class ResolutionGate
    {
        private readonly TaskCompletionSource _entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _released = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task WaitUntilEnteredAsync() => _entered.Task.WaitAsync(TimeSpan.FromSeconds(10));

        public async Task SuspendAsync()
        {
            _entered.SetResult();
            await _released.Task;
        }

        public void Release() => _released.SetResult();
    }

    private sealed class ControlledAddressResolver(ResolutionGate gate, int suspendedCall, bool rebind = false)
        : IAuthoringNetworkAddressResolver
    {
        public int Calls { get; private set; }

        public CancellationToken LastCancellationToken { get; private set; }

        public async ValueTask<ImmutableArray<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken)
        {
            Assert.Equal("example.com", host);
            LastCancellationToken = cancellationToken;
            Calls++;
            if (Calls == suspendedCall)
            {
                // Deliberately complete despite cancellation: the validator owns the final check.
                await gate.SuspendAsync();
            }
            return rebind && Calls == 2 ? [IPAddress.Loopback] : s_addresses;
        }
    }

    private sealed class ControlledPathVerifier(ResolutionGate gate, bool hasReparseBoundary = false, bool escapesRoot = false)
        : IAuthoringFilePathVerifier
    {
        public int Calls { get; private set; }

        public CancellationToken LastCancellationToken { get; private set; }

        public async ValueTask<(string CanonicalPath, bool HasReparseBoundary)> ResolveAsync(
            string canonicalRoot,
            string relativePath,
            CancellationToken cancellationToken)
        {
            Assert.Equal(s_root, canonicalRoot);
            Assert.Equal("file.txt", relativePath);
            LastCancellationToken = cancellationToken;
            Calls++;
            // Deliberately complete despite cancellation, just like the DNS resolver.
            await gate.SuspendAsync();
            return (escapesRoot ? Path.Combine(s_root + "-other", relativePath) : Path.Combine(canonicalRoot, relativePath), hasReparseBoundary);
        }
    }
}
