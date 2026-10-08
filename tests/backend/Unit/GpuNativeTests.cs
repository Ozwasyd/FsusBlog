using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Devices;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Tests;

// Unit dispatch tests only: these do not qualify a driver, device, loader, or native API matrix.
public sealed class GpuNativeTests
{
    [Fact]
    public void Disabled_PerformsNoLoadingOrVersionProbe()
    {
        var loader = new Loader();
        GpuNativeDiscoveryResult result = GpuNativeDiscovery.Discover(MemoryCapabilityMode.Disabled,
            CudaPolicy(), loader);

        Assert.Equal(GpuDiscoveryOutcome.Disabled, result.Outcome);
        Assert.Equal(0, loader.Loads);
        Assert.Empty(result.Sessions);
        Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
    }

    [Theory]
    [InlineData("libcuda.so.1")]
    [InlineData("/approved/../libcuda.so.1")]
    public void LoaderPolicy_RejectsSearchNamesAndNoncanonicalPaths(string path)
    {
        Assert.Throws<ArgumentException>(() => new GpuNativeLoadPolicy(GpuNativeBackend.Cuda12,
            [path], [12060], 2));
    }

    [Fact]
    public void LoaderPolicy_CopiesFiniteCallerListsAndRejectsUnboundAbiVersions()
    {
        string[] paths = ["/approved/libcuda.so.1"];
        int[] versions = [12060];
        var policy = new GpuNativeLoadPolicy(GpuNativeBackend.Cuda12, paths, versions, 2);
        paths[0] = "/other/library";
        versions[0] = 13000;
        Assert.Equal("/approved/libcuda.so.1", Assert.Single(policy.ApprovedLibraryPaths));
        Assert.Equal(12060, Assert.Single(policy.ApprovedApiVersions));
        Assert.Throws<ArgumentException>(() => new GpuNativeLoadPolicy(GpuNativeBackend.Cuda12,
            ["/approved/library"], [13000], 2));
        Assert.Throws<ArgumentException>(() => new GpuNativeLoadPolicy(GpuNativeBackend.Hip6,
            ["/approved/library"], [], 2));
        Assert.Throws<ArgumentOutOfRangeException>(() => new GpuNativeLoadPolicy(GpuNativeBackend.Cuda12,
            ["/approved/library"], [12060], 0));
    }

    [Fact]
    public void Discovery_DeviceLimitRejectsBeforeAnySessionOrContextCreation()
    {
        var library = new Library { Version = 12060, DeviceCount = int.MaxValue };
        GpuNativeDiscoveryResult result = GpuNativeDiscovery.Discover(MemoryCapabilityMode.Auto,
            CudaPolicy(), new Loader(library));
        Assert.Equal(GpuDiscoveryOutcome.DeviceLimitExceeded, result.Outcome);
        Assert.Empty(result.Sessions);
        Assert.DoesNotContain(library.Calls, call => call.Symbol == "cuDeviceGetName"
            || call.Symbol == "cuDevicePrimaryCtxRetain");
        Assert.Equal(1, library.Disposals);
    }

    [Fact]
    public void UnapprovedVersion_IsRejectedBeforeInitializationOrFullSymbolBinding()
    {
        var library = new Library { Version = 12050 };
        Assert.Throws<EntryPointNotFoundException>(() => new GpuCudaNativeApi(library, CudaPolicy()));
        Assert.Equal(["cuDriverGetVersion"], library.Symbols);
    }

    [Theory]
    [InlineData(0, GpuDiscoveryOutcome.NoDevice)]
    [InlineData(100, GpuDiscoveryOutcome.NoDevice)]
    [InlineData(800, GpuDiscoveryOutcome.PermissionDenied)]
    [InlineData(999, GpuDiscoveryOutcome.DriverFault)]
    public void Discovery_DistinguishesNativeInitializationOutcomesWithoutQualification(
        int status, GpuDiscoveryOutcome expected)
    {
        var library = new Library { Version = 12060, InitStatus = status };
        GpuNativeDiscoveryResult result = GpuNativeDiscovery.Discover(MemoryCapabilityMode.Auto,
            CudaPolicy(), new Loader(library));
        Assert.Equal(expected, result.Outcome);
        Assert.Empty(result.Sessions);
        Assert.Equal(1, library.Disposals);
        Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
    }

    [Fact]
    public void Discovery_DistinguishesMissingLibraryFromApiMismatchAndLoaderPermissionFailure()
    {
        Assert.Equal(GpuDiscoveryOutcome.MissingLibrary,
            GpuNativeDiscovery.Discover(MemoryCapabilityMode.Auto, CudaPolicy(), new Loader()).Outcome);
        var library = new Library { Version = 12050 };
        Assert.Equal(GpuDiscoveryOutcome.ApiMismatch,
            GpuNativeDiscovery.Discover(MemoryCapabilityMode.Auto, CudaPolicy(), new Loader(library)).Outcome);
        Assert.Equal(1, library.Disposals);
        Assert.Equal(GpuDiscoveryOutcome.PermissionDenied, GpuNativeDiscovery.Discover(
            MemoryCapabilityMode.Auto, CudaPolicy(), new Loader(error: new UnauthorizedAccessException())).Outcome);
    }

    [Fact]
    public void ActualNativeDispatch_UsesBackendSpecificIntegratedEnumCopyDirectionsAndPinnedFlags()
    {
        var cudaLibrary = new Library { Version = 12060 };
        var cuda = new GpuCudaNativeApi(cudaLibrary, CudaPolicy());
        cuda.GetIdentity(0);
        Assert.Equal(18, cudaLibrary.Calls.Last(call => call.Symbol == "cuDeviceGetAttribute").Arguments[0]);
        cuda.AllocateHost(32, readback: false);
        cuda.AllocateHost(32, readback: true);
        Assert.Equal([4u, 0u], cudaLibrary.Calls.Where(call => call.Symbol == "cuMemHostAlloc")
            .Select(call => (uint)call.Arguments[1]).ToArray());
        cuda.CopyUpload(new(1), new(2), 32, 3);
        cuda.CopyReadback(new(2), new(1), 32, 3);
        Assert.Contains(cudaLibrary.Calls, call => call.Symbol == "cuMemcpyHtoDAsync_v2"
            && (ulong)call.Arguments[0] == 2 && (nint)call.Arguments[1] == 1);
        Assert.Contains(cudaLibrary.Calls, call => call.Symbol == "cuMemcpyDtoHAsync_v2"
            && (nint)call.Arguments[0] == 1 && (ulong)call.Arguments[1] == 2);

        var hipLibrary = new Library { Version = 60200000 };
        var hip = new GpuHipNativeApi(hipLibrary,
            new(GpuNativeBackend.Hip6, [hipLibrary.AbsolutePath], [60200000], 2));
        hip.GetIdentity(0);
        Assert.Equal(16, hipLibrary.Calls.Last(call => call.Symbol == "hipDeviceGetAttribute").Arguments[0]);
        hip.CopyUpload(new(1), new(2), 32, 3);
        hip.CopyReadback(new(2), new(1), 32, 3);
        Assert.Equal([1, 2], hipLibrary.Calls.Where(call => call.Symbol == "hipMemcpyAsync")
            .Select(call => (int)call.Arguments[3]).ToArray());
        cuda.Release();
        hip.Release();
    }

    [Fact]
    public void NativeSignatures_PreserveCudaDevicePointersAndHipRuntimePointerWidths()
    {
        MethodInfo cuda = typeof(GpuCudaNativeApi.Upload).GetMethod("Invoke")!;
        Assert.Equal([typeof(ulong), typeof(nint), typeof(nuint), typeof(nint)],
            cuda.GetParameters().Select(value => value.ParameterType).ToArray());
        MethodInfo hip = typeof(GpuHipNativeApi.Copy).GetMethod("Invoke")!;
        Assert.Equal([typeof(nint), typeof(nint), typeof(nuint), typeof(int), typeof(nint)],
            hip.GetParameters().Select(value => value.ParameterType).ToArray());
        Assert.Equal(CallingConvention.Cdecl,
            typeof(GpuCudaNativeApi.Upload).GetCustomAttribute<UnmanagedFunctionPointerAttribute>()!.CallingConvention);
        Assert.Equal(CallingConvention.Cdecl,
            typeof(GpuHipNativeApi.Copy).GetCustomAttribute<UnmanagedFunctionPointerAttribute>()!.CallingConvention);
    }

    [Fact]
    public void CudaProfile_BindsVersionedAllocCopyContextAndEventExports()
    {
        var library = new Library { Version = 12060 };
        var api = new GpuCudaNativeApi(library, CudaPolicy());
        Assert.Contains("cuMemAlloc_v2", library.Symbols);
        Assert.Contains("cuMemcpyHtoDAsync_v2", library.Symbols);
        Assert.Contains("cuMemcpyDtoHAsync_v2", library.Symbols);
        Assert.Contains("cuDevicePrimaryCtxRelease_v2", library.Symbols);
        Assert.Contains("cuMemcpyPeerAsync", library.Symbols);
        Assert.DoesNotContain("cuMemAlloc", library.Symbols);
        api.Release();
        Assert.Equal(1, library.Disposals);
    }

    [Fact]
    public void HipProfile_BindsRuntimeExportsWithoutDeprecatedContextOrVersionDependentPropertyStruct()
    {
        var library = new Library { Version = 60200000 };
        var api = new GpuHipNativeApi(library,
            new(GpuNativeBackend.Hip6, [library.AbsolutePath], [60200000], 2));
        Assert.Contains("hipGetDevice", library.Symbols);
        Assert.Contains("hipSetDevice", library.Symbols);
        Assert.Contains("hipMemcpyAsync", library.Symbols);
        Assert.Contains("hipMemcpyPeerAsync", library.Symbols);
        Assert.DoesNotContain("hipCtxCreate", library.Symbols);
        Assert.DoesNotContain("hipGetDeviceProperties", library.Symbols);
        api.Release();
    }

    [Fact]
    public void PendingSubmission_PreventsCpuAccessFreeAndSessionDisposalUntilExplicitCompletionRelease()
    {
        var api = new Api();
        var session = new GpuNativeSession(api, 0);
        GpuDeviceAddress device = session.AllocateDevice(32);
        GpuHostAddress host = session.AllocateHost(32, false);
        session.WriteHost(host, [1, 2, 3]);
        GpuSubmission submission = session.SubmitUpload(host, device, 32);
        Assert.Equal(GpuCompletion.Pending, session.Query(submission));
        Assert.Throws<InvalidOperationException>(() => session.WriteHost(host, [4]));
        Assert.Throws<InvalidOperationException>(() => session.FreeHost(host));
        Assert.Throws<InvalidOperationException>(() => session.FreeDevice(device));
        Assert.Throws<InvalidOperationException>(() => session.Dispose());
        Assert.Throws<InvalidOperationException>(() => session.ReleaseSubmission(submission));

        api.QueryStatus = 0;
        Assert.Equal(GpuCompletion.Complete, session.Query(submission));
        session.ReleaseSubmission(submission);
        session.FreeHost(host);
        session.FreeDevice(device);
        session.Dispose();
        api.Release();
        Assert.Equal(1, api.Library.Disposals);
        Assert.Equal(1, api.EventReleases);
        Assert.Equal(1, api.StreamReleases);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void FailedCopyOrEventRecord_RetainsEveryNativeHandleAndQuarantinesSession(bool failCopy)
    {
        var api = new Api { FailCopy = failCopy, FailRecord = !failCopy };
        var session = new GpuNativeSession(api, 0);
        GpuDeviceAddress device = session.AllocateDevice(32);
        GpuHostAddress host = session.AllocateHost(32, false);
        Assert.Throws<GpuDriverException>(() => session.SubmitUpload(host, device, 32));
        Assert.Throws<InvalidOperationException>(() => session.AllocateDevice(1));
        Assert.Throws<InvalidOperationException>(() => session.FreeHost(host));
        Assert.Throws<InvalidOperationException>(() => session.FreeDevice(device));
        Assert.Throws<InvalidOperationException>(() => session.Dispose());
        Assert.Equal(0, api.EventReleases);
        Assert.Equal(0, api.StreamReleases);
        Assert.Equal(0, api.ContextReleases);
        Assert.Equal(0, api.Library.Disposals);
        // Fake native memory is test-owned; remove it without invoking the quarantined production path.
        api.CleanupTestMemory();
    }

    [Fact]
    public void EventQueryError_IsStickyUncertaintyEvenIfLaterDispatchReportsSuccess()
    {
        var api = new Api();
        var session = new GpuNativeSession(api, 0);
        GpuDeviceAddress device = session.AllocateDevice(8);
        GpuHostAddress host = session.AllocateHost(8, true);
        GpuSubmission submission = session.SubmitReadback(device, host, 8);
        api.QueryStatus = 700;
        Assert.Equal(GpuCompletion.Uncertain, session.Query(submission));
        api.QueryStatus = 0;
        Assert.Equal(GpuCompletion.Uncertain, session.Query(submission));
        Assert.Throws<InvalidOperationException>(() => session.ReleaseSubmission(submission));
        api.CleanupTestMemory();
    }

    [Fact]
    public void NativePeerSubmission_HoldsBothSessionsAndAllocations()
    {
        var api = new Api();
        var source = new GpuNativeSession(api, 0);
        var destination = new GpuNativeSession(api, 1);
        GpuDeviceAddress from = source.AllocateDevice(16);
        GpuDeviceAddress to = destination.AllocateDevice(16);
        Assert.Equal(MemoryDetection.Present, source.DetectPeerAccess(destination));
        Assert.Equal(0, api.PeerEnables);
        GpuSubmission submission = source.SubmitPeerTransfer(from, destination, to, 16);
        Assert.Equal(1, api.PeerEnables);
        Assert.Throws<InvalidOperationException>(() => source.FreeDevice(from));
        Assert.Throws<InvalidOperationException>(() => destination.FreeDevice(to));
        Assert.Throws<InvalidOperationException>(() => destination.Dispose());
        api.QueryStatus = 0;
        source.ReleaseSubmission(submission);
        Assert.Equal(1, api.PeerDisables);
        source.FreeDevice(from);
        destination.FreeDevice(to);
        source.Dispose();
        destination.Dispose();
        api.Release();
        Assert.Equal(1, api.Library.Disposals);
    }

    [Theory]
    [InlineData(false, 1)]
    [InlineData(true, 0)]
    public void PeerAccess_DisablesOnlyOwnedLinkAfterFinalCompletedOperation(bool alreadyEnabled, int expectedDisables)
    {
        var api = new Api { PeerAlreadyEnabled = alreadyEnabled };
        var source = new GpuNativeSession(api, 0);
        var destination = new GpuNativeSession(api, 1);
        GpuDeviceAddress from = source.AllocateDevice(16);
        GpuDeviceAddress to = destination.AllocateDevice(16);
        GpuSubmission first = source.SubmitPeerTransfer(from, destination, to, 16);
        GpuSubmission second = source.SubmitPeerTransfer(from, destination, to, 16);
        Assert.Equal(1, api.PeerEnables);
        api.QueryStatus = 0;
        source.ReleaseSubmission(first);
        Assert.Equal(0, api.PeerDisables);
        Assert.Throws<InvalidOperationException>(() => destination.FreeDevice(to));
        source.ReleaseSubmission(second);
        Assert.Equal(expectedDisables, api.PeerDisables);
        source.FreeDevice(from);
        destination.FreeDevice(to);
        source.Dispose();
        destination.Dispose();
        api.Release();
    }

    [Fact]
    public void BoundsAndForeignAllocation_FailBeforeNativeEnqueue()
    {
        var api = new Api();
        var session = new GpuNativeSession(api, 0);
        GpuHostAddress host = session.AllocateHost(8, false);
        GpuDeviceAddress device = session.AllocateDevice(8);
        Assert.Throws<ArgumentOutOfRangeException>(() => session.SubmitUpload(host, device, 9));
        Assert.Throws<ArgumentOutOfRangeException>(() => session.SubmitReadback(new(1234), host, 8));
        Assert.Equal(0, api.Copies);
        session.FreeHost(host);
        session.FreeDevice(device);
        session.Dispose();
        api.Release();
    }

    private static GpuNativeLoadPolicy CudaPolicy() => new(GpuNativeBackend.Cuda12,
        ["/approved/libcuda.so.1"], [12060], 2);

    private sealed class Loader(IGpuNativeLibrary? library = null, Exception? error = null) : IGpuNativeLibraryLoader
    {
        public int Loads
        {
            get; private set;
        }
        public IGpuNativeLibrary? TryLoad(string absolutePath)
        {
            Loads++;
            if (error is not null)
            {
                throw error;
            }
            return library;
        }
    }

    private sealed class Library : IGpuNativeLibrary
    {
        public string AbsolutePath => "/approved/libcuda.so.1";
        public int Version
        {
            get; init;
        }
        public int InitStatus
        {
            get; init;
        }
        public int DeviceCount
        {
            get; init;
        }
        public int Disposals
        {
            get; private set;
        }
        public List<string> Symbols { get; } = [];
        public List<(string Symbol, object[] Arguments)> Calls { get; } = [];
        public void Observe(string symbol, object[] arguments) => Calls.Add((symbol, arguments));
        public T Bind<T>(string symbol) where T : Delegate
        {
            Symbols.Add(symbol);
            ParameterExpression[] parameters = typeof(T).GetMethod("Invoke")!.GetParameters()
                .Select(value => Expression.Parameter(value.ParameterType, value.Name)).ToArray();
            var body = new List<Expression>();
            body.Add(Expression.Call(Expression.Constant(this), nameof(Observe), null,
                Expression.Constant(symbol), Expression.NewArrayInit(typeof(object),
                    parameters.Where(value => !value.IsByRef).Select(value => Expression.Convert(value, typeof(object))))));
            foreach (ParameterExpression parameter in parameters.Where(value => value.IsByRef))
            {
                Type type = parameter.Type.IsByRef ? parameter.Type.GetElementType()! : parameter.Type;
                body.Add(Expression.Assign(parameter, symbol is "cuDriverGetVersion" or "hipRuntimeGetVersion"
                    ? Expression.Constant(Version)
                    : symbol is "cuDeviceGetCount" or "hipGetDeviceCount"
                        ? Expression.Constant(DeviceCount) : Expression.Default(type)));
            }
            body.Add(Expression.Constant(symbol is "cuInit" or "hipInit" ? InitStatus : 0));
            return Expression.Lambda<T>(Expression.Block(body), parameters).Compile();
        }
        public void Dispose() => Disposals++;
    }

    private sealed class Api : GpuNativeApi
    {
        private ulong _nextAddress = 100;
        private nint _nextHandle = 100;
        private readonly List<nint> _testHosts = [];
        public Api() : this(new Library())
        {
        }
        private Api(Library library) : base(library) => Library = library;
        public Library Library
        {
            get;
        }
        public override string Backend => "CUDA";
        public int QueryStatus { get; set; } = 600;
        public bool FailCopy
        {
            get; init;
        }
        public bool FailRecord
        {
            get; init;
        }
        public int Copies
        {
            get; private set;
        }
        public int EventReleases
        {
            get; private set;
        }
        public int StreamReleases
        {
            get; private set;
        }
        public int ContextReleases
        {
            get; private set;
        }
        public int PeerEnables
        {
            get; private set;
        }
        public int PeerDisables
        {
            get; private set;
        }
        public bool PeerAlreadyEnabled
        {
            get; init;
        }
        public override int GetDeviceCount() => 2;
        public override GpuDeviceIdentity GetIdentity(int device) => new("CUDA", device.ToString(), "Unit dispatch", 12060, false);
        public override int CreateContext(int device, out nint context)
        {
            context = device + 1;
            return 0;
        }
        public override void DestroyContext(int device, nint context) => ContextReleases++;
        public override nint Enter(int device, nint context) => context;
        public override void Exit(nint token)
        {
        }
        public override GpuDeviceAddress AllocateDevice(long bytes) => new(++_nextAddress);
        public override void FreeDevice(GpuDeviceAddress address)
        {
        }
        public override GpuHostAddress AllocateHost(long bytes, bool readback)
        {
            nint address = Marshal.AllocHGlobal(checked((int)bytes));
            _testHosts.Add(address);
            return new(address);
        }
        public override void FreeHost(GpuHostAddress address)
        {
            Marshal.FreeHGlobal(address.Value);
            _testHosts.Remove(address.Value);
        }
        public override nint CreateStream() => ++_nextHandle;
        public override nint CreateEvent() => ++_nextHandle;
        public override void DestroyStream(nint stream) => StreamReleases++;
        public override void DestroyEvent(nint @event) => EventReleases++;
        public override void CopyUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes, nint stream)
        {
            Copies++;
            if (FailCopy)
            {
                throw new GpuDriverException("unit-copy", 700);
            }
        }
        public override void CopyReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes, nint stream)
            => CopyUpload(destination, source, bytes, stream);
        public override void Record(nint @event, nint stream)
        {
            if (FailRecord)
            {
                throw new GpuDriverException("unit-record", 700);
            }
        }
        public override int Query(nint @event) => QueryStatus;
        public override MemoryDetection CanPeer(int source, int destination) => MemoryDetection.Present;
        public override bool EnablePeer(int destination, nint destinationContext)
        {
            PeerEnables++;
            return !PeerAlreadyEnabled;
        }
        public override void DisablePeer(int destination, nint destinationContext)
        {
            PeerDisables++;
        }
        public override void CopyPeer(GpuDeviceAddress source, int sourceDevice, nint sourceContext,
            GpuDeviceAddress destination, int destinationDevice, nint destinationContext, long bytes, nint stream)
        {
            Copies++;
        }
        public void CleanupTestMemory()
        {
            foreach (nint address in _testHosts)
            {
                Marshal.FreeHGlobal(address);
            }
            _testHosts.Clear();
        }
    }
}
