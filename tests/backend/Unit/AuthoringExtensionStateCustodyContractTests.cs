using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionStateCustodyContractTests
{
    [Fact]
    public void ObservationIsOptInAndDoesNotReplaceOriginalPersistenceOrApplyOutput()
    {
        Assert.True(typeof(IAuthoringExtensionStateObservationStore).IsAssignableFrom(typeof(PostgresAuthoringExtensionStateStore)));
        Assert.True(typeof(IAuthoringFencedExtensionStateStore).IsAssignableFrom(typeof(PostgresAuthoringExtensionStateStore)));
        Assert.False(typeof(IAuthoringExtensionStateObservationStore).IsAssignableFrom(typeof(IAuthoringFencedExtensionStateStore)));
        Assert.True(typeof(IAsyncDisposable).IsAssignableFrom(typeof(IAuthoringExtensionStateObservation)));
        Assert.Equal(typeof(ValueTask<AuthoringStateSnapshot>), typeof(IAuthoringFencedExtensionStateStore).GetMethod("ApplyAsync")!.ReturnType);
    }

    [Fact]
    public void ObservationDigestBindsActualBytesFencePhaseAndRetainedMeasurement()
    {
        VerifiedAuthoringPackage package = AuthoringStateProcessWorker.Package("1.0.0", 1);
        AuthoringStateScope scope = AuthoringStateProcessWorker.Scope(package);
        AuthoringStateSnapshot snapshot = AuthoringExtensionStateContract.Snapshot(scope, package.PackageIdentity, 7, [new("key", [1, 2])]);
        var measurement = new AuthoringStateMeasurement(scope, 7, 2, 4, new string('a', 64));
        var observed = new AuthoringObservedState(snapshot, null, measurement);
        var state = new AuthoringStateObservation(observed, null, null);
        AuthoringStateSnapshot changed = AuthoringExtensionStateContract.Snapshot(scope, package.PackageIdentity, 7, [new("key", [3, 4])]);
        Assert.NotEqual(AuthoringExtensionStateContract.Digest(state), AuthoringExtensionStateContract.Digest(state with
        {
            From = observed with
            {
                Snapshot = changed
            }
        }));
        Assert.NotEqual(AuthoringExtensionStateContract.Digest(state), AuthoringExtensionStateContract.Digest(state with
        {
            From = observed with
            {
                Fence = new string('b', 64)
            }
        }));
        Assert.NotEqual(AuthoringExtensionStateContract.Digest(state), AuthoringExtensionStateContract.Digest(state with
        {
            Phase = AuthoringStateMigrationPhase.Completed
        }));
        Assert.NotEqual(AuthoringExtensionStateContract.Digest(state), AuthoringExtensionStateContract.Digest(state with
        {
            From = observed with
            {
                Measurement = measurement with
                {
                    ContentSha256 = new string('c', 64)
                }
            }
        }));
        Assert.Equal(new byte[] { 1, 2 }, snapshot.Entries[0].Value.ToArray());
    }
}
