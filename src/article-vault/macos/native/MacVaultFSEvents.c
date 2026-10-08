#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/stat.h>

typedef struct stat MacVaultFileInformation;
typedef struct statfs MacVaultMountInformation;
typedef struct dirent MacVaultDirectoryEntry;
typedef struct attrlist MacVaultAttributeList;

typedef void (*MacVaultCallback)(void*, const char*, uint32_t, uint64_t, int);

typedef struct
{
    int descriptor;
    MacVaultFileInformation rootStat;
    MacVaultMountInformation filesystem;
    bool caseSensitive;
    char rootPath[PATH_MAX];
    char volumeIdentity[37];
    FSEventStreamRef stream;
    dispatch_queue_t queue;
    MacVaultCallback callback;
    void* callbackContext;
    size_t maxBatch;
    bool started;
} MacVaultNative;

// Stable ABI errors: no native path or errno text is emitted as diagnostic content.
enum
{
    MacVaultUnsupported = 1,
    MacVaultRootInvalid = 2,
    MacVaultPathBlocked = 3,
    MacVaultPermission = 4,
    MacVaultMountChanged = 5,
    MacVaultRootLost = 6,
    MacVaultManifestInvalid = 7,
    MacVaultStreamFailed = 8,
    MacVaultBoundExceeded = 9
};

static bool SameMount(const MacVaultMountInformation* left, const MacVaultMountInformation* right)
{
    return memcmp(&left->f_fsid, &right->f_fsid, sizeof(left->f_fsid)) == 0
           && strcmp(left->f_mntonname, right->f_mntonname) == 0
           && strcmp(left->f_mntfromname, right->f_mntfromname) == 0 && strcmp(right->f_fstypename, "apfs") == 0
           && (right->f_flags & MNT_LOCAL) != 0;
}

static int CheckDescriptor(MacVaultNative* vault, int descriptor, bool control)
{
    MacVaultFileInformation information;
    MacVaultMountInformation filesystem;
    char descriptorPath[PATH_MAX];
    char canonical[PATH_MAX];
    if (fstat(descriptor, &information) != 0 || fstatfs(descriptor, &filesystem) != 0)
    {
        return MacVaultPermission;
    }

    if (!SameMount(&vault->filesystem, &filesystem) || information.st_dev != vault->rootStat.st_dev)
    {
        return MacVaultMountChanged;
    }

    size_t rootLength = strlen(vault->rootPath);
    if (fcntl(descriptor, F_GETPATH, descriptorPath) != 0
        || (strcmp(descriptorPath, vault->rootPath) != 0
            && (strncmp(descriptorPath, vault->rootPath, rootLength) != 0 || descriptorPath[rootLength] != '/'))
        || realpath(descriptorPath, canonical) == NULL || strcmp(canonical, descriptorPath) != 0)
    {
        return MacVaultPathBlocked;
    }

    if ((!S_ISDIR(information.st_mode) && !S_ISREG(information.st_mode))
        || (information.st_mode & (S_IRUSR | S_IRGRP | S_IROTH)) == 0
        || (S_ISDIR(information.st_mode) && (information.st_mode & (S_IXUSR | S_IXGRP | S_IXOTH)) == 0)
        || (control
            && (information.st_uid != geteuid() || (information.st_mode & (S_IWGRP | S_IWOTH)) != 0
                || (S_ISREG(information.st_mode) && information.st_nlink != 1))))
    {
        return MacVaultPermission;
    }

    return 0;
}

static int CheckRoot(MacVaultNative* vault)
{
    char canonical[PATH_MAX];
    char descriptorPath[PATH_MAX];
    MacVaultFileInformation current;
    if (realpath(vault->rootPath, canonical) == NULL || strcmp(canonical, vault->rootPath) != 0
        || fcntl(vault->descriptor, F_GETPATH, descriptorPath) != 0 || strcmp(descriptorPath, vault->rootPath) != 0
        || lstat(vault->rootPath, &current) != 0 || !S_ISDIR(current.st_mode)
        || current.st_dev != vault->rootStat.st_dev || current.st_ino != vault->rootStat.st_ino)
    {
        return MacVaultRootLost;
    }

    return CheckDescriptor(vault, vault->descriptor, false);
}

static bool EquivalentName(const char* left, const char* right, bool caseSensitive, bool* valid)
{
    CFStringRef leftString = CFStringCreateWithCString(NULL, left, kCFStringEncodingUTF8);
    CFStringRef rightString = CFStringCreateWithCString(NULL, right, kCFStringEncodingUTF8);
    *valid = leftString != NULL && rightString != NULL;
    bool equivalent = false;
    if (*valid)
    {
        CFOptionFlags flags = kCFCompareNonliteral;
        if (!caseSensitive)
        {
            flags |= kCFCompareCaseInsensitive;
        }

        equivalent = CFStringCompare(leftString, rightString, flags) == kCFCompareEqualTo;
    }

    if (leftString != NULL)
    {
        CFRelease(leftString);
    }

    if (rightString != NULL)
    {
        CFRelease(rightString);
    }

    return equivalent;
}

static int CheckNames(int descriptor, const char* segment, bool caseSensitive, bool rootLevel)
{
    // A separate open file description keeps enumeration offsets local to this observation.
    int enumerationDescriptor = openat(descriptor, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (enumerationDescriptor < 0)
    {
        return MacVaultPermission;
    }

    DIR* directory = fdopendir(enumerationDescriptor);
    if (directory == NULL)
    {
        close(enumerationDescriptor);
        return MacVaultPermission;
    }

    int result = 0;
    size_t count = 0;
    MacVaultDirectoryEntry* entry;
    errno = 0;
    while ((entry = readdir(directory)) != NULL)
    {
        if (++count > 4096)
        {
            result = MacVaultBoundExceeded;
            break;
        }

        bool valid = false;
        bool equivalent = EquivalentName(segment, entry->d_name, caseSensitive, &valid);
        if (!valid || (equivalent && strcmp(segment, entry->d_name) != 0))
        {
            result = MacVaultPathBlocked;
            break;
        }

        if (rootLevel && EquivalentName(".fsus", entry->d_name, false, &valid) && strcmp(".fsus", entry->d_name) != 0)
        {
            result = MacVaultPathBlocked;
            break;
        }

        errno = 0;
    }

    if (result == 0 && errno != 0)
    {
        result = MacVaultPermission;
    }

    closedir(directory);
    return result;
}

static int OpenRelative(MacVaultNative* vault, const char* relativePath, bool allowMissing, int* resultDescriptor)
{
    int result = CheckRoot(vault);
    *resultDescriptor = -1;
    if (result != 0)
    {
        return result;
    }

    size_t length = strnlen(relativePath, 1025);
    if (length == 0 || length > 1024 || relativePath[0] == '/' || relativePath[length - 1] == '/')
    {
        return MacVaultPathBlocked;
    }

    char path[1025];
    memcpy(path, relativePath, length + 1);
    int parent = dup(vault->descriptor);
    if (parent < 0)
    {
        return MacVaultPermission;
    }

    bool control = strncmp(path, ".fsus/", 6) == 0 || strcmp(path, ".fsus") == 0;
    char* segment = path;
    bool rootLevel = true;
    while (segment != NULL)
    {
        char* separator = strchr(segment, '/');
        if (separator != NULL)
        {
            *separator = '\0';
        }

        if (segment[0] == '\0' || strcmp(segment, ".") == 0 || strcmp(segment, "..") == 0)
        {
            result = MacVaultPathBlocked;
            break;
        }

        result = CheckNames(parent, segment, vault->caseSensitive, rootLevel);
        if (result != 0)
        {
            break;
        }

        int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;
        if (separator != NULL)
        {
            flags |= O_DIRECTORY;
        }

        int child = openat(parent, segment, flags);
        if (child < 0)
        {
            if (errno == ENOENT && separator == NULL && allowMissing)
            {
                result = CheckDescriptor(vault, parent, control);
                if (result == 0)
                {
                    // -1 is an audited missing leaf, never admission of a missing ancestor.
                    close(parent);
                    return 0;
                }
            }
            else
            {
                result = errno == EACCES || errno == EPERM ? MacVaultPermission : MacVaultPathBlocked;
            }

            break;
        }

        close(parent);
        parent = child;
        result = CheckDescriptor(vault, parent, control);
        if (result != 0)
        {
            break;
        }

        rootLevel = false;
        segment = separator == NULL ? NULL : separator + 1;
    }

    if (result != 0)
    {
        close(parent);
        return result;
    }

    *resultDescriptor = parent;
    return 0;
}

__attribute__((visibility("default"))) MacVaultNative*
FsusVaultMacOpen(const char* rootPath, uint64_t* fileId, uint32_t* device, int* caseSensitive, int* error)
{
    *error = MacVaultRootInvalid;
    char canonical[PATH_MAX];
    if (rootPath == NULL || rootPath[0] != '/' || realpath(rootPath, canonical) == NULL
        || strcmp(rootPath, canonical) != 0 || strcmp(rootPath, "/") == 0)
    {
        return NULL;
    }

    // Reject links in every root ancestor rather than accepting a realpath alias.
    int descriptor = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    char components[PATH_MAX];
    memcpy(components, rootPath + 1, strlen(rootPath));
    char* state = NULL;
    for (char* segment = strtok_r(components, "/", &state); segment != NULL; segment = strtok_r(NULL, "/", &state))
    {
        int child = openat(descriptor, segment, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        close(descriptor);
        descriptor = child;
        if (descriptor < 0)
        {
            return NULL;
        }
    }

    MacVaultNative* vault = calloc(1, sizeof(*vault));
    if (vault == NULL)
    {
        close(descriptor);
        return NULL;
    }

    vault->descriptor = descriptor;
    memcpy(vault->rootPath, canonical, strlen(canonical) + 1);
    if (fstat(descriptor, &vault->rootStat) != 0 || fstatfs(descriptor, &vault->filesystem) != 0
        || strcmp(vault->filesystem.f_fstypename, "apfs") != 0 || (vault->filesystem.f_flags & MNT_LOCAL) == 0)
    {
        *error = MacVaultUnsupported;
        close(descriptor);
        free(vault);
        return NULL;
    }

    MacVaultAttributeList attributes = {0};
    attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
    attributes.volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES;

    struct
    {
        uint32_t length;
        vol_capabilities_attr_t capabilities;
    } result = {0};

    if (fgetattrlist(descriptor, &attributes, &result, sizeof(result), 0) != 0 || result.length != sizeof(result)
        || (result.capabilities.valid[VOL_CAPABILITIES_FORMAT] & VOL_CAP_FMT_CASE_SENSITIVE) == 0)
    {
        *error = MacVaultUnsupported;
        close(descriptor);
        free(vault);
        return NULL;
    }

    vault->caseSensitive =
        (result.capabilities.capabilities[VOL_CAPABILITIES_FORMAT] & VOL_CAP_FMT_CASE_SENSITIVE) != 0;
    CFUUIDRef uuid = FSEventsCopyUUIDForDevice(vault->rootStat.st_dev);
    CFStringRef uuidString = uuid == NULL ? NULL : CFUUIDCreateString(NULL, uuid);
    bool validUuid =
        uuidString != NULL
        && CFStringGetCString(uuidString, vault->volumeIdentity, sizeof(vault->volumeIdentity), kCFStringEncodingUTF8);
    if (uuidString != NULL)
    {
        CFRelease(uuidString);
    }

    if (uuid != NULL)
    {
        CFRelease(uuid);
    }

    *error = validUuid ? CheckRoot(vault) : MacVaultUnsupported;
    if (*error != 0)
    {
        close(descriptor);
        free(vault);
        return NULL;
    }

    *fileId = vault->rootStat.st_ino;
    *device = (uint32_t)vault->rootStat.st_dev;
    *caseSensitive = vault->caseSensitive ? 1 : 0;
    return vault;
}

__attribute__((visibility("default"))) void FsusVaultMacVolume(MacVaultNative* vault, char* buffer)
{
    memcpy(buffer, vault->volumeIdentity, 37);
}

__attribute__((visibility("default"))) int
FsusVaultMacInspect(MacVaultNative* vault, const char* relativePath, uint64_t* fileId, int* missing)
{
    int descriptor;
    int result = OpenRelative(vault, relativePath, true, &descriptor);
    *fileId = 0;
    *missing = descriptor < 0;
    if (result == 0 && descriptor >= 0)
    {
        MacVaultFileInformation information;
        if (fstat(descriptor, &information) != 0)
        {
            result = MacVaultPermission;
        }
        else
        {
            *fileId = information.st_ino;
        }

        close(descriptor);
    }

    return result;
}

__attribute__((visibility("default"))) int
FsusVaultMacReadManifest(MacVaultNative* vault, unsigned char* buffer, int capacity, int* length)
{
    int descriptor;
    int result = OpenRelative(vault, ".fsus/vault.json", false, &descriptor);
    *length = 0;
    if (result != 0)
    {
        return result;
    }

    MacVaultFileInformation before;
    MacVaultFileInformation after;
    if (capacity <= 0 || fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode) || before.st_size <= 0
        || before.st_size > capacity)
    {
        close(descriptor);
        return MacVaultManifestInvalid;
    }

    while (*length < before.st_size)
    {
        ssize_t readCount = read(descriptor, buffer + *length, (size_t)(before.st_size - *length));
        if (readCount < 0 && errno == EINTR)
        {
            continue;
        }

        if (readCount <= 0)
        {
            result = MacVaultManifestInvalid;
            break;
        }

        *length += (int)readCount;
    }

    if (fstat(descriptor, &after) != 0 || before.st_size != after.st_size
        || memcmp(&before.st_mtimespec, &after.st_mtimespec, sizeof(before.st_mtimespec)) != 0
        || memcmp(&before.st_ctimespec, &after.st_ctimespec, sizeof(before.st_ctimespec)) != 0)
    {
        result = MacVaultManifestInvalid;
    }

    close(descriptor);
    return result;
}

static void Observe(ConstFSEventStreamRef stream,
                    void* context,
                    size_t count,
                    void* paths,
                    const FSEventStreamEventFlags flags[],
                    const FSEventStreamEventId eventIds[])
{
    (void)stream;
    MacVaultNative* vault = context;
    char** eventPaths = paths;
    size_t boundedCount = count > vault->maxBatch ? vault->maxBatch : count;
    for (size_t index = 0; index < boundedCount; index++)
    {
        const char* path = eventPaths[index];
        int error = path == NULL || strnlen(path, PATH_MAX) >= PATH_MAX ? MacVaultPathBlocked : 0;
        vault->callback(vault->callbackContext, error == 0 ? path : NULL, flags[index], eventIds[index], error);
    }

    if (count > boundedCount)
    {
        vault->callback(vault->callbackContext, NULL, 0, 0, MacVaultBoundExceeded);
    }
}

__attribute__((visibility("default"))) int
FsusVaultMacStart(MacVaultNative* vault, MacVaultCallback callback, void* context, int maxBatch)
{
    int result = CheckRoot(vault);
    if (result != 0 || callback == NULL || maxBatch < 8 || maxBatch > 16384 || vault->stream != NULL)
    {
        return result == 0 ? MacVaultStreamFailed : result;
    }

    vault->callback = callback;
    vault->callbackContext = context;
    vault->maxBatch = (size_t)maxBatch;
    CFStringRef root = CFStringCreateWithCString(NULL, vault->rootPath, kCFStringEncodingUTF8);
    if (root == NULL)
    {
        return MacVaultStreamFailed;
    }

    const void* values[] = {root};
    CFArrayRef roots = CFArrayCreate(NULL, values, 1, &kCFTypeArrayCallBacks);
    CFRelease(root);
    if (roots == NULL)
    {
        return MacVaultStreamFailed;
    }

    FSEventStreamContext streamContext = {0, vault, NULL, NULL, NULL};
    vault->stream = FSEventStreamCreate(NULL,
                                        Observe,
                                        &streamContext,
                                        roots,
                                        kFSEventStreamEventIdSinceNow,
                                        0.05,
                                        kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagFileEvents
                                            | kFSEventStreamCreateFlagNoDefer);
    CFRelease(roots);
    if (vault->stream == NULL)
    {
        return MacVaultStreamFailed;
    }

    vault->queue = dispatch_queue_create("fsusblog.article-vault.macos-observer", DISPATCH_QUEUE_SERIAL);
    if (vault->queue == NULL)
    {
        return MacVaultStreamFailed;
    }

    FSEventStreamSetDispatchQueue(vault->stream, vault->queue);
    vault->started = FSEventStreamStart(vault->stream);
    return vault->started ? 0 : MacVaultStreamFailed;
}

static void DrainQueue(void* context)
{
    (void)context;
}

__attribute__((visibility("default"))) void FsusVaultMacClose(MacVaultNative* vault)
{
    if (vault == NULL)
    {
        return;
    }

    if (vault->stream != NULL)
    {
        if (vault->started)
        {
            FSEventStreamStop(vault->stream);
        }

        FSEventStreamInvalidate(vault->stream);
        if (vault->queue != NULL)
        {
            // Drain callbacks before releasing their native and managed contexts.
            dispatch_sync_f(vault->queue, NULL, DrainQueue);
        }

        FSEventStreamRelease(vault->stream);
    }

    if (vault->queue != NULL)
    {
        dispatch_release(vault->queue);
    }

    close(vault->descriptor);
    free(vault);
}
