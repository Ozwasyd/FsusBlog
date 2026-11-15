using FsusBlogV2.Migrate;

if (args.Length != 0 || !LinuxWorkerBoundary.Seal()) return 3;
using var output = Console.OpenStandardOutput();
await output.WriteAsync("FSUS-JINT-ARM64-V1\n"u8.ToArray());
await output.FlushAsync();
return await PurePluginInterpreter.RunAsync(Console.OpenStandardInput(), output, CancellationToken.None);
