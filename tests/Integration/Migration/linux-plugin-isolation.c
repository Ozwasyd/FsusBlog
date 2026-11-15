#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__aarch64__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error The native isolation policy targets little-endian Linux ARM64.
#endif

#define ALLOW(name) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##name, 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)

/* This is the static capability probe's allowlist, independent of a future managed worker. */
static const struct sock_filter policy[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    ALLOW(brk), ALLOW(close), ALLOW(execve), ALLOW(exit), ALLOW(exit_group),
    ALLOW(fcntl), ALLOW(fstat), ALLOW(getdents64), ALLOW(getrandom), ALLOW(mprotect), ALLOW(newfstatat),
    ALLOW(prctl), ALLOW(prlimit64), ALLOW(read), ALLOW(readlinkat), ALLOW(rseq),
    ALLOW(set_robust_list), ALLOW(set_tid_address), ALLOW(statfs), ALLOW(write),
    ALLOW(wait4), /* Bubblewrap's filtered PID 1 reaps the static probe. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_openat, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(O_CLOEXEC | O_DIRECTORY | O_NONBLOCK | O_LARGEFILE)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, O_RDONLY, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
};

static int reject(const char *stage)
{
    fprintf(stderr, "linux plugin isolation probe: %s\n", stage);
    return 1;
}

static int path_denied(const char *path, int flags, int expected)
{
    int fd = (int)syscall(SYS_openat, AT_FDCWD, path, flags | O_CLOEXEC, 0);
    if (fd < 0) return errno == expected;
    close(fd);
    return 0;
}

static int readonly(const char *path)
{
    struct statvfs mount;
    return statvfs(path, &mount) == 0 && (mount.f_flag & ST_RDONLY);
}

static int witness(void)
{
    if (prctl(PR_GET_SECCOMP, 0UL, 0UL, 0UL, 0UL) != 2 || prctl(PR_GET_NO_NEW_PRIVS, 0UL, 0UL, 0UL, 0UL) != 1)
        return reject("seccomp and no-new-privileges");
    if (!environ[0] || strcmp(environ[0], "PWD=/") != 0 || environ[1]) return reject("unexpected inherited environment");
    for (int fd = 0; fd <= STDERR_FILENO; ++fd)
        if (fcntl(fd, F_GETFD) < 0) return reject("missing standard descriptor");
    DIR *descriptors = opendir("/proc/self/fd");
    if (!descriptors) return reject("private descriptor directory");
    int own_fd = dirfd(descriptors);
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(descriptors)))
    {
        if (entry->d_name[0] == '.') continue;
        char *end;
        long fd = strtol(entry->d_name, &end, 10);
        if (*end || (fd > STDERR_FILENO && fd != own_fd)) return reject("unexpected inherited descriptor");
    }
    if (errno != 0 || closedir(descriptors) != 0) return reject("private descriptor enumeration");

    char status[4096];
    int info = (int)syscall(SYS_openat, AT_FDCWD, "/proc/self/status", O_RDONLY | O_CLOEXEC, 0);
    if (info < 0) return reject("private process status");
    ssize_t length = read(info, status, sizeof(status) - 1);
    close(info);
    if (length <= 0) return reject("private process status bytes");
    status[length] = '\0';
    if (!strstr(status, "\nCapEff:\t0000000000000000\n") || !strstr(status, "\nCapAmb:\t0000000000000000\n"))
        return reject("capability sets");

    if (!readonly("/") || !readonly("/proc") || !readonly("/probe")) return reject("read-only sandbox mounts");
    if (!path_denied("/etc/passwd", O_RDONLY, ENOENT) || !path_denied("/sys/fs/cgroup", O_RDONLY, ENOENT) ||
        !path_denied("/dev/null", O_RDONLY, ENOENT) ||
        !path_denied("/probe", O_WRONLY, EPERM)) return reject("filesystem isolation");
    if (syscall(SYS_socket, AF_UNIX, SOCK_STREAM, 0) != -1 || errno != EPERM ||
        syscall(SYS_socket, AF_INET, SOCK_STREAM, 0) != -1 || errno != EPERM ||
        syscall(SYS_unshare, CLONE_NEWUSER) != -1 || errno != EPERM)
        return reject("socket and namespace policy");

    static const char *const names[] = { "user", "mnt", "pid", "net", "ipc", "uts", "cgroup" };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); ++i)
    {
        char path[40], key[64];
        snprintf(path, sizeof(path), "/proc/self/ns/%s", names[i]);
        length = syscall(SYS_readlinkat, AT_FDCWD, path, key, sizeof(key) - 1);
        if (length <= 0) return reject("namespace identity");
        key[length] = '\0';
        printf("%s=%s\n", names[i], key);
    }
    puts("seccomp=filter no-new-privileges=1 effective-and-ambient-caps=0 descriptors=stdio mounts=readonly");
    return 0;
}

int main(int argc, char *argv[])
{
    if (argc == 2 && strcmp(argv[1], "--inside") == 0) return witness();
    if (argc != 1 || geteuid() == 0) return reject("expected unprivileged invocation");
    if (syscall(SYS_close_range, 3U, ~0U, 0) != 0) return reject("close inherited descriptors");
    int self = open("/proc/self/exe", O_RDONLY);
    int filter = memfd_create("fsus-plugin-probe-filter", MFD_ALLOW_SEALING);
    if (self != 3 || filter != 4 || write(filter, policy, sizeof(policy)) != (ssize_t)sizeof(policy) || lseek(filter, 0, SEEK_SET) != 0 ||
        fcntl(filter, F_ADD_SEALS, F_SEAL_SEAL | F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK) != 0)
        return reject("sealed launcher descriptors");

    char *const unset[] = { NULL };
    char *const launch[] = {
        "/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
        "--disable-userns", "--assert-userns-disabled", "--cap-drop", "ALL", "--new-session", "--die-with-parent", "--clearenv",
        "--proc", "/proc", "--remount-ro", "/proc", "--perms", "0555", "--ro-bind-data", "3", "/probe",
        "--remount-ro", "/", "--chdir", "/",
        "--seccomp", "4", "--", "/probe", "--inside", NULL
    };
    execve(launch[0], launch, unset);
    return reject("bubblewrap launch");
}
