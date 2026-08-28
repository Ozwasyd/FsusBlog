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

typedef struct landlock_path_beneath_attr LandlockPathBeneathAttr;
typedef struct landlock_ruleset_attr LandlockRulesetAttr;

static int CreateRuleset(const LandlockRulesetAttr* attr, size_t size, uint32_t flags)
{
    return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int AddRule(int ruleset_fd, const LandlockPathBeneathAttr* attr)
{
    return (int)syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, attr, 0);
}

static int RestrictSelf(int ruleset_fd)
{
    return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, 0);
}

static void Fail(const char* message)
{
    fprintf(stderr, "execution-envelope-landlock: %s: %s\n", message, strerror(errno));
    exit(125);
}

static uint64_t HandledAccessForAbi(int abi)
{
    uint64_t access = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE
                      | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE
                      | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG
                      | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK
                      | LANDLOCK_ACCESS_FS_MAKE_SYM;
    if (abi >= 2)
        access |= LANDLOCK_ACCESS_FS_REFER;
    if (abi >= 3)
        access |= LANDLOCK_ACCESS_FS_TRUNCATE;
    if (abi >= 5)
        access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
    return access;
}

static void AllowPath(int ruleset_fd, const char* path, uint64_t access)
{
    int path_fd = open(path, O_PATH | O_CLOEXEC);
    if (path_fd < 0)
        Fail("cannot open declared filesystem path");
    LandlockPathBeneathAttr rule = {
        .allowed_access = access,
        .parent_fd = path_fd,
    };
    if (AddRule(ruleset_fd, &rule) < 0)
        Fail("cannot add filesystem rule");
    if (close(path_fd) < 0)
        Fail("cannot close filesystem rule path");
}

int main(int argc, char** argv)
{
    if (argc == 2 && strcmp(argv[1], "--version") == 0)
    {
        puts("fsusblog-execution-envelope-landlock 1");
        return 0;
    }
    int separator = -1;
    for (int index = 1; index < argc; ++index)
    {
        if (strcmp(argv[index], "--") == 0)
        {
            separator = index;
            break;
        }
        if (strcmp(argv[index], "--writable") != 0 || index + 1 >= argc)
        {
            fprintf(stderr, "execution-envelope-landlock: invalid arguments\n");
            return 125;
        }
        ++index;
    }
    if (separator < 0 || separator + 1 >= argc)
    {
        fprintf(stderr, "execution-envelope-landlock: command is missing\n");
        return 125;
    }
    if (argv[separator + 1][0] != '/')
    {
        fprintf(stderr, "execution-envelope-landlock: command must be absolute\n");
        return 125;
    }

    int abi = CreateRuleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 1)
        Fail("Landlock ABI is unavailable");
    uint64_t handled_access = HandledAccessForAbi(abi);
    LandlockRulesetAttr ruleset = {
        .handled_access_fs = handled_access,
    };
    int ruleset_fd = CreateRuleset(&ruleset, sizeof(ruleset), 0);
    if (ruleset_fd < 0)
        Fail("cannot create filesystem ruleset");

    uint64_t read_access = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    if (abi >= 5)
        read_access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
    AllowPath(ruleset_fd, "/", read_access);
    for (int index = 1; index < separator; index += 2)
        AllowPath(ruleset_fd, argv[index + 1], handled_access);

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0)
        Fail("cannot set no-new-privileges");
    if (RestrictSelf(ruleset_fd) < 0)
        Fail("cannot apply filesystem ruleset");
    if (close(ruleset_fd) < 0)
        Fail("cannot close filesystem ruleset");

    execv(argv[separator + 1], &argv[separator + 1]);
    Fail("cannot execute correctness command");
    return 125;
}
