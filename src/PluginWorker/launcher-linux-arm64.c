#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(FSUS_LINUX_PDF_SEAL)
#include <sys/prctl.h>
#endif

#if !defined(__linux__) || !defined(__aarch64__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error The managed Hook test launcher targets little-endian Linux ARM64.
#endif

#define RETURN(value) BPF_STMT(BPF_RET | BPF_K, value)
#define ALLOW(name) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##name, 0, 1), RETURN(SECCOMP_RET_ALLOW)
#define DENIED (SECCOMP_RET_ERRNO | EPERM)

#if defined(FSUS_LINUX_PDF_SEAL)

// The fixed ELF preload runs after the initial exec and before Python reads input.
__attribute__((constructor)) static void seal_pdf_process(void)
{
    if (prctl(PR_GET_SECCOMP, 0UL, 0UL, 0UL, 0UL) != SECCOMP_MODE_FILTER ||
        prctl(PR_GET_NO_NEW_PRIVS, 0UL, 0UL, 0UL, 0UL) != 1)
        _exit(3);

    struct sock_filter policy[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
        RETURN(SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_execve, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_execveat, 1, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_seccomp, 0, 1),
        RETURN(DENIED),
        RETURN(SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { sizeof(policy) / sizeof(policy[0]), policy };
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &program) != 0)
        _exit(3);

    // A missing target would return ENOENT if the exec admission remained open.
    char *const probe[] = { "/fsus-unavailable", NULL };
    char *const empty[] = { NULL };
    if (execve(probe[0], probe, empty) != -1 || errno != EPERM)
        _exit(3);
}

#else

static const struct sock_filter policy[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
    RETURN(SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1), RETURN(SECCOMP_RET_ERRNO | ENOSYS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 6),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + 4U),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x003d0f00, 0, 1),
    RETURN(SECCOMP_RET_ALLOW), RETURN(DENIED),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_openat, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(O_CLOEXEC | O_DIRECTORY | O_NONBLOCK | O_LARGEFILE | O_NOFOLLOW | O_NOCTTY)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, O_RDONLY, 0, 1),
    RETURN(SECCOMP_RET_ALLOW), RETURN(DENIED),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_ioctl, 0, 1), RETURN(SECCOMP_RET_ERRNO | ENOTTY),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_sched_setaffinity, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 1),
    RETURN(SECCOMP_RET_ALLOW), RETURN(DENIED),
    ALLOW(brk), ALLOW(clock_gettime), ALLOW(clock_getres), ALLOW(clock_nanosleep), ALLOW(close),
    ALLOW(epoll_create1), ALLOW(epoll_ctl), ALLOW(epoll_pwait), ALLOW(eventfd2), ALLOW(execve), ALLOW(exit), ALLOW(exit_group),
    ALLOW(faccessat), ALLOW(faccessat2), ALLOW(fcntl), ALLOW(fstat), ALLOW(fstatfs), ALLOW(ftruncate), ALLOW(futex),
    ALLOW(getcwd), ALLOW(getdents64), ALLOW(getegid), ALLOW(geteuid), ALLOW(getgid), ALLOW(getpid), ALLOW(getppid),
    ALLOW(getrandom), ALLOW(getrlimit), ALLOW(getrusage), ALLOW(getsid), ALLOW(gettid), ALLOW(getuid), ALLOW(lseek),
    ALLOW(madvise), ALLOW(membarrier), ALLOW(memfd_create), ALLOW(mmap), ALLOW(mprotect), ALLOW(mremap), ALLOW(munmap),
    ALLOW(nanosleep), ALLOW(newfstatat), ALLOW(pipe2), ALLOW(ppoll), ALLOW(prctl), ALLOW(pread64), ALLOW(prlimit64),
    ALLOW(read), ALLOW(readlinkat), ALLOW(readv), ALLOW(rseq), ALLOW(rt_sigaction), ALLOW(rt_sigprocmask), ALLOW(rt_sigreturn),
    ALLOW(sched_getaffinity), ALLOW(sched_getparam), ALLOW(sched_getscheduler), ALLOW(sched_get_priority_max), ALLOW(sched_get_priority_min),
    ALLOW(sched_yield), ALLOW(seccomp), ALLOW(set_robust_list), ALLOW(set_tid_address), ALLOW(sigaltstack),
    ALLOW(statfs), ALLOW(statx), ALLOW(sysinfo), ALLOW(tgkill), ALLOW(uname), ALLOW(wait4), ALLOW(write), ALLOW(writev),
    RETURN(DENIED),
};

static int fail(const char *stage)
{
#if defined(FSUS_LINUX_PDF)
    fprintf(stderr, "linux PDF renderer: %s\n", stage);
#else
    fprintf(stderr, "linux managed Hook test: %s\n", stage);
#endif
    return 3;
}

int main(int argc, char *argv[])
{
    struct stat root;
    if (argc != 2 || geteuid() == 0 || argv[1][0] != '/' || strcmp(argv[1], "/") == 0 ||
        lstat(argv[1], &root) != 0 || !S_ISDIR(root.st_mode) || root.st_uid != 0 || (root.st_mode & 0222))
        return fail("expected a separately staged read-only root owned by root");
    if (syscall(SYS_close_range, 3U, ~0U, 0) != 0) return fail("could not clear inherited descriptors");
#if defined(FSUS_LINUX_PDF)
    int filter = memfd_create("fsus-pdf-filter", MFD_ALLOW_SEALING);
#else
    int filter = memfd_create("fsus-managed-hook-filter", MFD_ALLOW_SEALING);
#endif
    if (filter != 3 || write(filter, policy, sizeof(policy)) != (ssize_t)sizeof(policy) || lseek(filter, 0, SEEK_SET) != 0 ||
        fcntl(filter, F_ADD_SEALS, F_SEAL_SEAL | F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK) != 0)
        return fail("could not seal seccomp input");

    char *const environment[] = { NULL };
    char *const options[] = {
        "/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
        "--disable-userns", "--assert-userns-disabled", "--cap-drop", "ALL", "--new-session", "--die-with-parent", "--clearenv",
#if defined(FSUS_LINUX_PDF)
        "--ro-bind", argv[1], "/", "--proc", "/proc", "--remount-ro", "/proc", "--chdir", "/render",
        "--setenv", "HOME", "/render", "--setenv", "TMPDIR", "/render", "--setenv", "XDG_CACHE_HOME", "/render",
        "--setenv", "TZ", "UTC", "--setenv", "FONTCONFIG_FILE", "/render/fonts.conf",
        "--setenv", "LD_LIBRARY_PATH", "/render/lib:/lib/aarch64-linux-gnu",
        "--setenv", "LD_PRELOAD", "/render/lib/fsus-pdf-seal.so",
        "--seccomp", "3", "--", "/render/bin/python3", "-I", "-B", "/render/worker.py", NULL
#else
        "--ro-bind", argv[1], "/", "--proc", "/proc", "--remount-ro", "/proc", "--chdir", "/",
        "--setenv", "DOTNET_EnableDiagnostics", "0", "--setenv", "DOTNET_ROOT", "/dotnet",
        "--setenv", "DOTNET_SYSTEM_TIMEZONE_INVARIANT", "1", "--setenv", "FSUSBLOG_PURE_PLUGIN_WORKER", "1",
        "--seccomp", "3", "--", "/dotnet/dotnet", "/app/FsusBlog.V2.PluginWorker.dll", NULL
#endif
    };
    execve(options[0], options, environment);
    return fail("could not launch mandatory Bubblewrap sandbox");
}

#endif
