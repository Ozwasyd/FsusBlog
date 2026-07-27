param(
    [Parameter(Mandatory = $true)]
    [string]$JobName
)

$source = @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class FsusBlogWindowsJobMembers
{
    private const uint JobObjectQuery = 0x0004;
    private const int JobObjectBasicProcessIdList = 3;
    private const int ErrorMoreData = 234;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObject(uint desiredAccess, bool inheritHandle, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static ulong[] Query(string jobName)
    {
        IntPtr job = OpenJobObject(JobObjectQuery, false, jobName);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenJobObject failed");
        }

        try
        {
            int capacity = 4096;
            while (capacity <= 1024 * 1024)
            {
                IntPtr buffer = Marshal.AllocHGlobal(capacity);
                try
                {
                    uint returned;
                    if (!QueryInformationJobObject(
                        job,
                        JobObjectBasicProcessIdList,
                        buffer,
                        (uint)capacity,
                        out returned))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error == ErrorMoreData)
                        {
                            capacity *= 2;
                            continue;
                        }
                        throw new Win32Exception(error, "QueryInformationJobObject failed");
                    }

                    uint assigned = unchecked((uint)Marshal.ReadInt32(buffer, 0));
                    uint listed = unchecked((uint)Marshal.ReadInt32(buffer, 4));
                    if (listed > assigned || 8L + (long)listed * IntPtr.Size > capacity)
                    {
                        throw new InvalidOperationException("Windows Job member list is inconsistent");
                    }
                    List<ulong> processIds = new List<ulong>((int)listed);
                    for (int index = 0; index < listed; index++)
                    {
                        long value = IntPtr.Size == 8
                            ? Marshal.ReadInt64(buffer, 8 + index * IntPtr.Size)
                            : unchecked((uint)Marshal.ReadInt32(buffer, 8 + index * IntPtr.Size));
                        if (value <= 0)
                        {
                            throw new InvalidOperationException("Windows Job returned an invalid process id");
                        }
                        processIds.Add(unchecked((ulong)value));
                    }
                    return processIds.ToArray();
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            throw new InvalidOperationException("Windows Job member list exceeded the bounded query buffer");
        }
        finally
        {
            CloseHandle(job);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$processIds = [FsusBlogWindowsJobMembers]::Query($JobName) |
    Where-Object { $_ -ne [ulong]$PID }
ConvertTo-Json -InputObject @($processIds) -Compress
