namespace FsusBlog.Server.Infrastructure.Execution;

internal readonly record struct RuntimePressureSnapshot(int AvailableWorkerThreads, int AvailableIoThreads)
{
    public static RuntimePressureSnapshot Capture()
    {
        ThreadPool.GetAvailableThreads(out int availableWorkers, out int availableIo);
        return new RuntimePressureSnapshot(availableWorkers, availableIo);
    }
}
