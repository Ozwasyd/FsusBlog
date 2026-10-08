import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// AST input admission is a separate semantic query, not a production compile or trusted lint pass.
const ownedCliOriginal = fs.readFileSync(path.join(root, 'tools/test/native/execution-envelope-landlock.c'), 'utf8');
const signature = 'int main(int argc, char** argv)';
const anchor = `${signature}\n{`;
const inject = text => ownedCliOriginal.replace(anchor, `${anchor}\n    ${text}`);
const nullPathGuard = '    if (path == NULL)\n    {\n        errno = EINVAL;\n        Fail("cannot open declared filesystem path");\n    }\n';
assert.ok(ownedCliOriginal.includes(nullPathGuard));
const ownedCliVariants = [
    ['ownedCliOriginal', ownedCliOriginal, true],
    ['different-bytes-same-semantics', '/* Semantic admission does not waive by source hash. */\n' + ownedCliOriginal.replace(/\bargc\b/gu, 'argumentCount').replace(/\bargv\b/gu, 'argumentVector'), true],
    ['missing-null-path-guard', ownedCliOriginal.replace(nullPathGuard, ''), false],
    ['inverted-null-path-guard', ownedCliOriginal.replace('if (path == NULL)', 'if (path != NULL)'), false],
    ['wrong-null-path-error', ownedCliOriginal.replace(nullPathGuard, nullPathGuard.replace('EINVAL', 'EACCES')), false],
    ['null-path-open-substitution', ownedCliOriginal.replace('static void AllowPath', '#define open(path, flags) open(NULL, flags)\nstatic void AllowPath')
        .replace('static unsigned long long ParseIdentity', '#undef open\nstatic unsigned long long ParseIdentity'), false],
    ['null-path-close-substitution', ownedCliOriginal.replace('static void AllowPath', '#define close(fd) close(-1)\nstatic void AllowPath')
        .replace('static unsigned long long ParseIdentity', '#undef close\nstatic unsigned long long ParseIdentity'), false],
    ['envp', ownedCliOriginal.replace(signature, 'int main(int argc, char** argv, char** envp)'), false],
    ['environ', inject('extern char** environ; if (environ[0]) return 125;'), false],
    ['getenv', inject('if (getenv("FSUSBLOG_COMMAND")) return 125;'), false],
    ['secure-getenv', inject('if (secure_getenv("FSUSBLOG_COMMAND")) return 125;'), false],
    ['stdin-fgets', inject('char input[1024]; if (fgets(input, sizeof(input), stdin)) return 125;'), false],
    ['file-open-read', inject('char input[1024]; int fd = open("/owned-input", O_RDONLY); if (read(fd, input, sizeof(input))) return 125;'), false],
    ['raw-stdin-read', inject('char input[1024]; if (read(0, input, sizeof(input))) return 125;'), false],
    ['ipc-pipe-read', inject('int fds[2]; char input[1024]; if (pipe(fds) || read(fds[0], input, sizeof(input))) return 125;'), false],
    ['inet-recv', inject('char input[1024]; int fd = socket(AF_INET, SOCK_STREAM, 0); if (recv(fd, input, sizeof(input), 0)) return 125;').replace('#include <unistd.h>', '#include <unistd.h>\n#include <sys/socket.h>'), false],
    ['unix-recv', inject('char input[1024]; int fd = socket(AF_UNIX, SOCK_STREAM, 0); if (recv(fd, input, sizeof(input), 0)) return 125;').replace('#include <unistd.h>', '#include <unistd.h>\n#include <sys/socket.h>'), false],
    ['opaque-input', inject('extern char* ReceiveExternalCommand(void); if (ReceiveExternalCommand()) return 125;'), false],
    ['indirect-input', inject('extern char* ReceiveExternalCommand(void); char* (*callback)(void) = ReceiveExternalCommand; if (callback()) return 125;'), false],
    ['wrong-syscall', ownedCliOriginal.replace('__NR_landlock_create_ruleset, attr', '__NR_read, attr'), false],
    ['syscall-macro-redefinition', ownedCliOriginal.replace('static int CreateRuleset', '#undef __NR_landlock_create_ruleset\n#define __NR_landlock_create_ruleset __NR_read\nstatic int CreateRuleset'), false],
    ['open-macro-redefinition', ownedCliOriginal.replace('static void AllowPath', '#undef O_PATH\n#define O_PATH O_RDONLY\nstatic void AllowPath'), false],
    ['stream-to-argv-write', ownedCliOriginal.replace('    execv(', '    fputs(argv[separator + 1] = stderr->_IO_read_ptr, stderr);\n    execv('), false],
    ['argv-alias', inject('char** argumentAlias = argv; (void)argumentAlias;'), false],
    ['private-parameter-argv-write', ownedCliOriginal.replace('    int pathFd = open', '    ((char*)path)[0] = 47;\n    int pathFd = open').replace('    execv(', '    AllowPath(rulesetFd, argv[separator + 1], readAccess);\n    execv('), false],
    ['private-parameter-argv-alias', ownedCliOriginal.replace('    int pathFd = open', '    char* writablePath = (char*)path;\n    writablePath[0] = 47;\n    int pathFd = open').replace('    execv(', '    AllowPath(rulesetFd, argv[separator + 1], readAccess);\n    execv('), false],
    ['global-stderr-assembly-alias', ownedCliOriginal.replace('static int CreateRuleset', 'extern FILE* stderr __asm__("stdin");\nstatic int CreateRuleset'), false],
    ['prctl-get-name-argv-write', ownedCliOriginal.replace('prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)', 'prctl(PR_GET_NAME, argv[separator + 1], 0, 0, 0)'), false],
    ['prctl-get-seccomp-ambient-input', inject('if (prctl(PR_GET_SECCOMP, 0, 0, 0, 0)) return 125;'), false],
    ['numeric-pointer-ambient-input', inject('char* ambient = (char*)0x12345678; if (strcmp(ambient, "blocked")) return 125;'), false],
    ['union-pointer-ambient-input', inject('union { unsigned long address; char* pointer; } ambient = { .address = 0x12345678 }; if (strcmp(ambient.pointer, "blocked")) return 125;'), false],
    ['uninitialized-pointer-ambient-input', inject('char* ambient; if (strcmp(ambient, "blocked")) return 125;'), false],
    ['uninitialized-array-ambient-input', inject('char ambient[1024]; if (strcmp(ambient, "blocked")) return 125;'), false],
    ['argv-literal-write', ownedCliOriginal.replace('    execv(', '    argv[separator + 1] = "/foreign-command";\n    execv('), false],
    ['argv-advance-write', ownedCliOriginal.replace('    execv(', '    argv += 1;\n    execv('), false],
    ['function-assembly-alias', ownedCliOriginal.replace('static int CreateRuleset', 'extern long syscall(long number, ...) __asm__("read");\nstatic int CreateRuleset'), false],
    ['header-function-assembly-alias', ownedCliOriginal.replace('static int CreateRuleset', '#include "foreign-input.h"\nstatic int CreateRuleset'), false],
    ['header-variable-assembly-alias', ownedCliOriginal.replace('static int CreateRuleset', '#include "foreign-stream.h"\nstatic int CreateRuleset'), false],
    ['header-variable-definition', ownedCliOriginal.replace('static int CreateRuleset', '#include "foreign-stream-definition.h"\nstatic int CreateRuleset'), false],
    ['header-function-definition-redeclaration-chain', ownedCliOriginal.replace('static int CreateRuleset', '#include "foreign-function-chain.h"\nstatic int CreateRuleset'), false],
    ['late-header-function-definition', `${ownedCliOriginal}\n#include "foreign-function-chain.h"\n`, false],
    ['late-header-variable-definition', `${ownedCliOriginal}\n#include "foreign-stream-definition.h"\n`, false],
    ['data-reading-open', ownedCliOriginal.replace('O_PATH | O_CLOEXEC', 'O_RDONLY | O_CLOEXEC'), false],
    ['stderr-data', inject('if (stderr->_IO_read_ptr) return 125;'), false],
    ['foreign-command-sink', ownedCliOriginal.replace('execv(argv[separator + 1]', 'execv("/foreign-command"'), false],
    ['new-private-function', ownedCliOriginal.replace(signature, 'static char* NewExternalInput(void) { return getenv("INPUT"); }\n' + signature), false]
];


const aliasSignature = 'static void AllowOwnedTemporaryAlias(';
const macro = (definition) => ownedCliOriginal.replace('static unsigned long long ParseIdentity', `${definition}\nstatic unsigned long long ParseIdentity`);
function aliasMacro(definition)
{
    const name = definition.split('(')[0].split(' ').at(-1);
    return ownedCliOriginal.replace(aliasSignature, `${definition}\n${aliasSignature}`)
        .replace(signature, `#undef ${name}\n${signature}`);
}
function renameMetadataLocals(source)
{
    const begin = source.indexOf('static unsigned long long ParseIdentity');
    const end = source.indexOf('int main(', begin);
    const names = new Map(['value', 'end', 'parsed', 'sourceFd', 'aliasFd', 'sourceStat', 'aliasStat',
        'rulesetFd', 'source', 'device', 'inode', 'uid', 'access', 'rule'].map(name => [name, `${name}Private`]));
    const body = source.slice(begin, end).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z0-9_]*/gu,
        token => names.get(token) ?? token);
    return source.slice(0, begin) + body + source.slice(end);
}

ownedCliVariants.push(
    ['metadata-close-source-macro', aliasMacro('#define close(fd) close(sourceFd)'), false],
    ['metadata-close-constant-macro', aliasMacro('#define close(fd) close(-1)'), false],
    ['metadata-open-alias-macro', aliasMacro('#define open(filename, flags) open("/tmp", flags)'), false],
    ['metadata-diagnostic-value-macro', aliasMacro('#define fputs(text, stream) fputs(device, stream)'), false],
    ['metadata-diagnostic-stream-macro', aliasMacro('#define fputs(text, stream) fputs(text, stdout)'), false],
    ['metadata-newline-macro', aliasMacro('#define fputc(character, stream) fputc(0, stream)'), false],
    ['metadata-ruleset-macro', aliasMacro('#define AddRule(fd, rule) AddRule(-1, rule)'), false],
    ['renamed-private-metadata-roles', renameMetadataLocals(ownedCliOriginal), true],
    ['metadata-errno-macro', macro('#undef EACCES\n#define EACCES EINVAL'), false],
    ['unregistered-identical-argv-sink', '#include <unistd.h>\nint main(int argc, char** argv) { (void)argc; execv(argv[1], &argv[1]); return 125; }\n', false],
    ['metadata-to-executable', ownedCliOriginal.replace('execv(argv[separator + 1]', 'execv(tempDevice'), false],
    ['metadata-to-argv', ownedCliOriginal.replace('    execv(', '    argv[separator + 1] = (char*)tempDevice;\n    execv('), false],
    ['metadata-to-separator', ownedCliOriginal.replace('    execv(', '    separator = (int)(uintptr_t)tempDevice;\n    execv('), false],
    ['metadata-end-to-executable', ownedCliOriginal.replace('    return parsed;', '    execv(end, &end);\n    return parsed;'), false],
    ['metadata-member-to-command', ownedCliOriginal.replace('    // Grant through', '    execv((char*)(uintptr_t)sourceStat.st_ino, NULL);\n    // Grant through'), false],
    ['decimal-end-cursor-escape', ownedCliOriginal.replace('    return parsed;', '    fputs(end, stderr);\n    return parsed;'), false],
    ['unchecked-fstat', ownedCliOriginal.replace('if (fstat(sourceFd, &sourceStat) < 0 || fstat(aliasFd, &aliasStat) < 0)', 'if (0)'), false],
    ['weakened-device-comparison', ownedCliOriginal.replace('sourceStat.st_dev != ParseIdentity(device)', 'sourceStat.st_dev == ParseIdentity(device)'), false],
    ['missing-mode-comparison', ownedCliOriginal.replace('|| (sourceStat.st_mode & 0777) != 0700', '|| 0'), false],
    ['alternate-alias', ownedCliOriginal.replace('open("/tmp", O_PATH', 'open("/var/tmp", O_PATH'), false],
    ['data-reading-metadata-open', ownedCliOriginal.replaceAll('O_PATH | O_DIRECTORY', 'O_RDONLY | O_DIRECTORY'), false],
    ['followed-metadata-open', ownedCliOriginal.replaceAll('O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC', 'O_DIRECTORY | O_CLOEXEC'), false],
    ['reopened-rule-descriptor', ownedCliOriginal.replace('.parent_fd = aliasFd', '.parent_fd = open("/tmp", O_PATH | O_CLOEXEC)'), false],
    ['source-rule-descriptor', ownedCliOriginal.replace('.parent_fd = aliasFd', '.parent_fd = sourceFd'), false],
    ['decimal-base', ownedCliOriginal.replace('strtoull(value, &end, 10)', 'strtoull(value, &end, 16)'), false],
    ['decimal-input-getenv', ownedCliOriginal.replace('strtoull(value, &end, 10)', 'strtoull(getenv("INPUT"), &end, 10)'), false],
    ['metadata-pair-reorder', ownedCliOriginal.replace('"--owned-tmp-device"', '"--owned-tmp-inode"'), false],
    ['metadata-option-skip', ownedCliOriginal.replace('            index += 7;', '            index += 5;'), false],
    ['borrowed-metadata-mutation', ownedCliOriginal.replace('    char* end = NULL;', '    ((char*)value)[0] = 47;\n    char* end = NULL;'), false],
    ['borrowed-metadata-alias', ownedCliOriginal.replace('    char* end = NULL;', '    char* alias = (char*)value; (void)alias;\n    char* end = NULL;'), false],
    ['metadata-stat-field-macro', macro('#define st_dev st_ino'), false],
    ['metadata-constant-conversion-macro', macro('#define strtoull(value, end, base) 0ULL'), false],
    ['metadata-conversion-base-macro', macro('#define strtoull(value, end, base) strtoull(value, end, 16)'), false],
    ['metadata-constant-stat-macro', macro('#define fstat(fd, status) 0'), false],
    ['metadata-wrong-stat-macro', macro('#define fstat(fd, status) fstat(aliasFd, status)'), false],
    ['metadata-unknown-typedef', ownedCliOriginal.replace('typedef struct stat FileStatus;', 'typedef struct stat FileStatus;\ntypedef const char* ForeignInput;'), false],
    ['metadata-foreign-layout', ownedCliOriginal.replace('typedef struct stat FileStatus;', 'struct ForeignStatus { unsigned long st_dev, st_ino, st_uid, st_mode; };\ntypedef struct ForeignStatus FileStatus;'), false],
    ['metadata-function-header-alias', ownedCliOriginal.replace(aliasSignature, '#include "foreign-conversion.h"\n' + aliasSignature), false],
    ['metadata-late-function-definition', ownedCliOriginal + '\nunsigned long long strtoull(const char* value, char** end, int base) { (void)value; (void)end; (void)base; return 0; }\n', false]
);

function output(result)
{
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`;
}

for (const [name, source, expectedAdmission] of ownedCliVariants)
{
    test(`unpromoted metadata input v2: ${name}`, () =>
    {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-metadata-cli-ast-'));
        try
        {
            const sourceFile = path.join(directory, 'command-wrapper.c');
            fs.writeFileSync(sourceFile, source);
            fs.writeFileSync(path.join(directory, 'foreign-input.h'), 'extern int strcmp(const char*, const char*) __asm__("getenv");\n');
            fs.writeFileSync(path.join(directory, 'foreign-stream.h'), 'extern FILE* stderr __asm__("stdin");\n');
            fs.writeFileSync(path.join(directory, 'foreign-stream-definition.h'), 'FILE* stderr = 0;\n');
            fs.writeFileSync(path.join(directory, 'foreign-function-chain.h'), 'int strcmp(const char* left, const char* right) { (void)right; return getenv(left) ? 1 : 0; }\nextern int strcmp(const char*, const char*);\n');
            fs.writeFileSync(path.join(directory, 'foreign-conversion.h'), 'extern unsigned long long strtoull(const char*, char**, int) __asm__("__isoc23_strtoull");\n');
            const queried = spawnSync('clang', ['-std=c11', '-O2', '-fsyntax-only', '-Xclang', '-ast-dump=json', sourceFile], {
                encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000
            });
            assert.equal(queried.status, 0, `syntax-valid fixture required: ${output(queried)}`);
            const evaluated = spawnSync(process.execPath, [path.join(root, 'tools/style/command-wrapper-input-ast-v2.mjs'), '--source', sourceFile], {
                input: queried.stdout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000
            });
            assert.equal(evaluated.status, expectedAdmission ? 0 : 1, output(evaluated));
            if (expectedAdmission)
            {
                const observed = JSON.parse(evaluated.stdout);
                assert.deepEqual(observed.ownedInputClasses, ['main.argc', 'main.argv']);
                assert.equal(observed.modelVersion, 'fsusblog.command-wrapper-metadata-input.v2');
                assert.equal(observed.qualificationEligible, false);
                assert.equal(observed.policyPromotion, false);
                assert.deepEqual(observed.analyzerOptions, []);
            }
            else
            {
                assert.match(evaluated.stderr, /AST diagnostic refused:/u);
            }
        }
        finally
        {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
