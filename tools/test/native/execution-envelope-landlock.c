#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <linux/landlock.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/stat.h>

/* Linux UAPI added this right in Landlock ABI 5; older headers may omit it. */
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
_Static_assert(LANDLOCK_ACCESS_FS_IOCTL_DEV == (1ULL << 15), "Landlock ioctl right must match the Linux UAPI");

typedef struct landlock_path_beneath_attr LandlockPathBeneathAttr;
typedef struct landlock_ruleset_attr LandlockRulesetAttr;

static int CreateRuleset(const LandlockRulesetAttr* attr, size_t size, uint32_t flags)
{
    return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int AddRule(int rulesetFd, const LandlockPathBeneathAttr* attr)
{
    return (int)syscall(__NR_landlock_add_rule, rulesetFd, LANDLOCK_RULE_PATH_BENEATH, attr, 0);
}

static int RestrictSelf(int rulesetFd)
{
    return (int)syscall(__NR_landlock_restrict_self, rulesetFd, 0);
}

static const char* ErrorTextForPointer(char* message, const char* buffer)
{
    (void)buffer;
    return message == NULL ? "error description unavailable" : message;
}

static const char* ErrorTextForStatus(int status, const char* buffer)
{
    return status == 0 ? buffer : "error description unavailable";
}

static void Fail(const char* message)
{
    /* Preserve the originating syscall error before diagnostic I/O changes errno. */
    const int Error = errno;
    char errorBuffer[1024];
    /* GNU returns a pointer; POSIX returns a status. The type probe is unevaluated. */
    const char* errorMessage = _Generic(strerror_r(Error, errorBuffer, sizeof(errorBuffer)),
        char*: ErrorTextForPointer,
        int: ErrorTextForStatus)(strerror_r(Error, errorBuffer, sizeof(errorBuffer)), errorBuffer);
    fputs("execution-envelope-landlock: ", stderr);
    fputs(message, stderr);
    fputs(": ", stderr);
    fputs(errorMessage, stderr);
    fputc('\n', stderr);
    _Exit(125);
}

static uint64_t HandledAccessForAbi(int abi)
{
    uint64_t access = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE
                      | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE
                      | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG
                      | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK
                      | LANDLOCK_ACCESS_FS_MAKE_SYM;
    if (abi >= 2)
    {
        access |= LANDLOCK_ACCESS_FS_REFER;
    }
    if (abi >= 3)
    {
        access |= LANDLOCK_ACCESS_FS_TRUNCATE;
    }
    if (abi >= 5)
    {
        access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
    }
    return access;
}

static void AllowPath(int rulesetFd, const char* path, uint64_t access)
{
    int pathFd = open(path, O_PATH | O_CLOEXEC);
    if (pathFd < 0)
    {
        Fail("cannot open declared filesystem path");
    }
    LandlockPathBeneathAttr rule = {
        .allowed_access = access,
        .parent_fd = pathFd,
    };
    if (AddRule(rulesetFd, &rule) < 0)
    {
        Fail("cannot add filesystem rule");
    }
    if (close(pathFd) < 0)
    {
        Fail("cannot close filesystem rule path");
    }
}

static unsigned long long ParseIdentity(const char* value)
{
    char* end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(value, &end, 10);
    if (errno || !value[0] || value[0] == '-' || value[0] == '+' || *end)
    {
        errno = EINVAL;
        Fail("invalid owned temporary directory identity");
    }
    return parsed;
}

static void AllowOwnedTemporaryAlias(int rulesetFd, const char* source, const char* device,
                                    const char* inode, const char* uid, uint64_t access)
{
    int sourceFd = open(source, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (sourceFd < 0)
        Fail("cannot open owned temporary directory");
    int aliasFd = open("/tmp", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (aliasFd < 0)
        Fail("cannot open private temporary alias");
    struct stat sourceStat;
    struct stat aliasStat;
    if (fstat(sourceFd, &sourceStat) < 0 || fstat(aliasFd, &aliasStat) < 0)
        Fail("cannot inspect owned temporary alias descriptors");
    if ((unsigned long long)sourceStat.st_dev != ParseIdentity(device)
        || (unsigned long long)sourceStat.st_ino != ParseIdentity(inode)
        || (unsigned long long)sourceStat.st_uid != ParseIdentity(uid)
        || sourceStat.st_dev != aliasStat.st_dev || sourceStat.st_ino != aliasStat.st_ino
        || sourceStat.st_uid != aliasStat.st_uid || (sourceStat.st_mode & 0777) != 0700
        || (aliasStat.st_mode & 0777) != 0700)
    {
        errno = EACCES;
        Fail("owned temporary alias object identity mismatch");
    }
    // Grant through the same descriptor that was verified, never reopen the alias.
    LandlockPathBeneathAttr rule = { .allowed_access = access, .parent_fd = aliasFd };
    if (AddRule(rulesetFd, &rule) < 0)
        Fail("cannot add verified owned temporary alias rule");
    if (close(aliasFd) < 0 || close(sourceFd) < 0)
        Fail("cannot close owned temporary alias descriptors");
    fprintf(stderr, "execution-envelope-landlock: owned-private-tmp-verified device=%s inode=%s uid=%s\n", device, inode, uid);
}

int main(int argc, char** argv)
{
    if (argc == 2 && strcmp(argv[1], "--version") == 0)
    {
        puts("fsusblog-execution-envelope-landlock 2");
        return 0;
    }
    int separator = -1;
    int restrictedReads = 0;
    const char* tempSource = NULL;
    const char* tempDevice = NULL;
    const char* tempInode = NULL;
    const char* tempUid = NULL;
    for (int index = 1; index < argc; ++index)
    {
        if (strcmp(argv[index], "--") == 0)
        {
            separator = index;
            break;
        }
        if (strcmp(argv[index], "--owned-tmp-source") == 0 && index + 7 < argc
            && strcmp(argv[index + 2], "--owned-tmp-device") == 0
            && strcmp(argv[index + 4], "--owned-tmp-inode") == 0
            && strcmp(argv[index + 6], "--owned-tmp-uid") == 0 && !tempSource)
        {
            tempSource = argv[index + 1];
            tempDevice = argv[index + 3];
            tempInode = argv[index + 5];
            tempUid = argv[index + 7];
            index += 7;
            continue;
        }
        if (strcmp(argv[index], "--readable") == 0 || strcmp(argv[index], "--readable-file") == 0)
        {
            restrictedReads = 1;
        }
        if ((strcmp(argv[index], "--writable") != 0 && strcmp(argv[index], "--writable-file") != 0
             && strcmp(argv[index], "--readable") != 0 && strcmp(argv[index], "--readable-file") != 0)
            || index + 1 >= argc)
        {
            fputs("execution-envelope-landlock: invalid arguments\n", stderr);
            return 125;
        }
        ++index;
    }
    if (separator < 0 || separator + 1 >= argc)
    {
        fputs("execution-envelope-landlock: command is missing\n", stderr);
        return 125;
    }
    if (argv[separator + 1][0] != '/')
    {
        fputs("execution-envelope-landlock: command must be absolute\n", stderr);
        return 125;
    }

    int abi = CreateRuleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 1)
    {
        Fail("Landlock ABI is unavailable");
    }
    uint64_t handledAccess = HandledAccessForAbi(abi);
    LandlockRulesetAttr ruleset = {
        .handled_access_fs = handledAccess,
    };
    int rulesetFd = CreateRuleset(&ruleset, sizeof(ruleset), 0);
    if (rulesetFd < 0)
    {
        Fail("cannot create filesystem ruleset");
    }

    uint64_t readAccess = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    if (abi >= 5)
    {
        readAccess |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
    }
    if (!restrictedReads)
    {
        AllowPath(rulesetFd, "/", readAccess);
    }
    if (tempSource)
    {
        AllowOwnedTemporaryAlias(rulesetFd, tempSource, tempDevice, tempInode, tempUid, handledAccess);
    }
    for (int index = 1; index < separator; index += 2)
    {
        if (strcmp(argv[index], "--owned-tmp-source") == 0)
        {
            index += 6;
            continue;
        }
        if (tempSource && strcmp(argv[index + 1], tempSource) == 0)
        {
            continue;
        }
        uint64_t allowedAccess = handledAccess;
        if (strcmp(argv[index], "--readable") == 0)
        {
            allowedAccess = readAccess;
        }
        else if (strcmp(argv[index], "--readable-file") == 0)
        {
            allowedAccess = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE;
        }
        else if (strcmp(argv[index], "--writable-file") == 0)
        {
            allowedAccess = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE;
            if (abi >= 5)
            {
                allowedAccess |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
            }
        }
        AllowPath(rulesetFd, argv[index + 1], allowedAccess);
    }

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0)
    {
        Fail("cannot set no-new-privileges");
    }
    if (RestrictSelf(rulesetFd) < 0)
    {
        Fail("cannot apply filesystem ruleset");
    }
    if (close(rulesetFd) < 0)
    {
        Fail("cannot close filesystem ruleset");
    }

    execv(argv[separator + 1], &argv[separator + 1]);
    Fail("cannot execute correctness command");
    return 125;
}
