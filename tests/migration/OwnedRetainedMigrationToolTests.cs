using System.Reflection;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Refusal/API controls only. The positive path needs the actual original sealed
// production build and its executing DLL; a byte fixture cannot grant this cap.
public sealed class OwnedRetainedMigrationToolTests
{
    [Fact]
    public async Task CancelledReadRefusesBeforeFilesystemOrProcessWork()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => OwnedRetainedMigrationTool.ReadOriginalAsync(
            "/unread/source", "/unread/artifacts", "/unread/sdk", "/unread/evidence", cancellation.Token));
    }

    [Fact]
    public async Task RelativeInputCannotSelectAnAmbientSource()
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OwnedRetainedMigrationTool.ReadOriginalAsync("relative", "/unread/artifacts", "/unread/sdk", "/unread/evidence",
                cancellation.Token));
        Assert.Equal("migration_retained_read_roots_must_be_explicit_canonical", failure.Message);
    }

    [Fact]
    public async Task ReaderEvidenceCannotPolluteTheSealedProductionInput()
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OwnedRetainedMigrationTool.ReadOriginalAsync("/unread/source", "/unread/artifacts", "/unread/sdk",
                "/unread/artifacts/logs", cancellation.Token));
        Assert.Equal("migration_retained_read_evidence_cannot_modify_inputs", failure.Message);
    }

    [Fact]
    public void CallerJsonStatusExecutableAndExpectedHashesHaveNoCapabilityEntry()
    {
        Type type = typeof(OwnedRetainedMigrationTool);
        Assert.Empty(type.GetConstructors());
        MethodInfo read = type.GetMethod("ReadOriginalAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert.Equal(new[] { "sourceRoot", "artifactRoot", "sdkRoot", "evidenceRoot", "cancellationToken" },
            read.GetParameters().Select(parameter => parameter.Name).ToArray());
        Assert.DoesNotContain(type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static),
            method => method.Name is "FromPlan" or "Import" or "FromObservation");
    }
}
