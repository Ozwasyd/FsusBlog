param(
    [Parameter(Mandatory = $true)]
    [string]$JobName,
    [Parameter(Mandatory = $true)]
    [string]$ReadyFile,
    [Parameter(Mandatory = $true)]
    [string]$StartFile,
    [Parameter(Mandatory = $true)]
    [string]$AssignedFile,
    [Parameter(Mandatory = $true)]
    [string]$ResumeFile,
    [Parameter(Mandatory = $true)]
    [string]$CancelFile,
    [Parameter(Mandatory = $true)]
    [string]$ResultFile,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,
    [Parameter(Mandatory = $true)]
    [string]$CommandBase64,
    [Parameter(Mandatory = $true)]
    [int]$GracefulTerminationMs,
    [Parameter(Mandatory = $true)]
    [int]$ForceTerminationMs,
    [Parameter(Mandatory = $true)]
    [int]$ObservationIntervalMs,
    [Parameter(Mandatory = $true)]
    [int]$ZeroMemberObservations
)

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FsusBlogPhysicalExecutionJob
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNewProcessGroup = 0x00000200;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint WaitObject0 = 0x00000000;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint cb;
        public string reserved;
        public string desktop;
        public string title;
        public uint x;
        public uint y;
        public uint xSize;
        public uint ySize;
        public uint xCountChars;
        public uint yCountChars;
        public uint fillAttribute;
        public ushort showWindow;
        public ushort reserved2;
        public IntPtr reserved2Pointer;
        public IntPtr standardInput;
        public IntPtr standardOutput;
        public IntPtr standardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr process;
        public IntPtr thread;
        public uint processId;
        public uint threadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long perProcessUserTimeLimit;
        public long perJobUserTimeLimit;
        public uint limitFlags;
        public UIntPtr minimumWorkingSetSize;
        public UIntPtr maximumWorkingSetSize;
        public uint activeProcessLimit;
        public UIntPtr affinity;
        public uint priorityClass;
        public uint schedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong readOperationCount;
        public ulong writeOperationCount;
        public ulong otherOperationCount;
        public ulong readTransferCount;
        public ulong writeTransferCount;
        public ulong otherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation basicLimitInformation;
        public IoCounters ioInfo;
        public UIntPtr processMemoryLimit;
        public UIntPtr jobMemoryLimit;
        public UIntPtr peakProcessMemoryUsed;
        public UIntPtr peakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength, out uint returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static ulong[] QueryMembers(IntPtr job)
    {
        int capacity = 65536;
        IntPtr buffer = Marshal.AllocHGlobal(capacity);
        try
        {
            uint returned;
            if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)capacity, out returned))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject failed");
            }
            uint listed = unchecked((uint)Marshal.ReadInt32(buffer, 4));
            if (8L + (long)listed * IntPtr.Size > capacity)
            {
                throw new InvalidOperationException("Windows Job member list exceeded its bounded buffer");
            }
            List<ulong> members = new List<ulong>((int)listed);
            for (int index = 0; index < listed; index++)
            {
                long value = IntPtr.Size == 8
                    ? Marshal.ReadInt64(buffer, 8 + index * IntPtr.Size)
                    : unchecked((uint)Marshal.ReadInt32(buffer, 8 + index * IntPtr.Size));
                if (value <= 0) throw new InvalidOperationException("Windows Job returned an invalid PID");
                members.Add(unchecked((ulong)value));
            }
            return members.ToArray();
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool ObserveEmpty(IntPtr job, int timeoutMs, int intervalMs, int requiredZero)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        int zero = 0;
        do
        {
            if (QueryMembers(job).Length == 0)
            {
                zero++;
                if (zero >= requiredZero) return true;
            }
            else
            {
                zero = 0;
            }
            Thread.Sleep(intervalMs);
        }
        while (DateTime.UtcNow <= deadline);
        return false;
    }

    private static string Json(bool cancelled, bool forced, bool parentResidual, bool empty, uint pid, uint exitCode)
    {
        return "{\"schema\":\"fsusblog.physical-execution-windows-job-result.v1\",\"cancelled\":" +
            cancelled.ToString().ToLowerInvariant() + ",\"forced\":" +
            forced.ToString().ToLowerInvariant() + ",\"parentResidual\":" +
            parentResidual.ToString().ToLowerInvariant() + ",\"empty\":" +
            empty.ToString().ToLowerInvariant() + ",\"pid\":" + pid +
            ",\"exitCode\":" + exitCode + "}";
    }

    public static int Run(string jobName, string readyFile, string startFile, string assignedFile, string resumeFile, string cancelFile, string resultFile, string workingDirectory, string command, int graceMs, int forceMs, int intervalMs, int zeroObservations)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, jobName);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        ProcessInformation child = new ProcessInformation();
        try
        {
            JobObjectExtendedLimitInformation limits = new JobObjectExtendedLimitInformation();
            limits.basicLimitInformation.limitFlags = JobObjectLimitKillOnJobClose;
            int size = Marshal.SizeOf(limits);
            IntPtr pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, pointer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }
            finally { Marshal.FreeHGlobal(pointer); }

            File.WriteAllText(readyFile, jobName, new UTF8Encoding(false));
            while (!File.Exists(startFile)) Thread.Sleep(intervalMs);
            string interpreter = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            StartupInfo startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(startup);
            startup.flags = StartfUseStdHandles;
            startup.standardInput = GetStdHandle(-10);
            startup.standardOutput = GetStdHandle(-11);
            startup.standardError = GetStdHandle(-12);
            StringBuilder commandLine = new StringBuilder("\"" + interpreter + "\" /d /s /c \"" + command + "\"");
            if (!CreateProcess(interpreter, commandLine, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended | CreateNewProcessGroup, IntPtr.Zero, workingDirectory, ref startup, out child))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
            if (!AssignProcessToJobObject(job, child.process))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
            File.WriteAllText(assignedFile, child.processId.ToString(), new UTF8Encoding(false));
            while (!File.Exists(resumeFile)) Thread.Sleep(intervalMs);
            if (ResumeThread(child.thread) == UInt32.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");

            bool cancelled = File.Exists(cancelFile);
            while (!cancelled && WaitForSingleObject(child.process, (uint)intervalMs) != WaitObject0)
            {
                if (!File.Exists(cancelFile)) continue;
                cancelled = true;
            }
            if (cancelled) GenerateConsoleCtrlEvent(1, child.processId);
            bool parentResidual = !cancelled && QueryMembers(job).Length > 0;
            bool forced = false;
            if ((cancelled || parentResidual) && !ObserveEmpty(job, graceMs, intervalMs, zeroObservations))
            {
                forced = true;
                if (!TerminateJobObject(job, 1))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed");
            }
            bool empty = ObserveEmpty(job, forceMs, intervalMs, zeroObservations);
            uint exitCode = 1;
            GetExitCodeProcess(child.process, out exitCode);
            File.WriteAllText(resultFile, Json(cancelled, forced, parentResidual, empty, child.processId, exitCode), new UTF8Encoding(false));
            if (!empty || cancelled || parentResidual) return 1;
            return unchecked((int)exitCode);
        }
        finally
        {
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
            if (child.process != IntPtr.Zero) CloseHandle(child.process);
            CloseHandle(job);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$command = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($CommandBase64))
exit [FsusBlogPhysicalExecutionJob]::Run(
    $JobName,
    $ReadyFile,
    $StartFile,
    $AssignedFile,
    $ResumeFile,
    $CancelFile,
    $ResultFile,
    $WorkingDirectory,
    $command,
    $GracefulTerminationMs,
    $ForceTerminationMs,
    $ObservationIntervalMs,
    $ZeroMemberObservations)
