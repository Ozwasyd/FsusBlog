# 离线平台插件执行

`platform-plugin render ID` 能在 macOS 的独立受限工作进程中执行一个获准的 `article.beforeRenderMarkdown` Hook。它从标准输入读取最多 16 KiB UTF-8 Markdown，成功后仅把转换结果写到标准输出。命令不访问网站、数据库或 HTTP 会话。这个入口与 `extension` 创作扩展管理命令有独立的包格式、批准与执行边界。

将 `FSUSBLOG_PLATFORM_PLUGIN_ROOT` 设为可信运维账号持有的绝对 `0700` 目录。路径不可含符号链接。目录内须有 `0600` 的空 `runner.lock`，运维更换批准目录前应与执行器使用同一把独占锁。`0400` 的 `platform-plugin.json` 须明确写入 `Enabled: true`、`PluginId`、`Permissions: ["article.render"]`、`Key` 和 `Source`。`Key` 使用 `Publisher`、`KeyId`、`SubjectPublicKeyInfo` 字节数组、`ValidFrom`、`ValidUntil`、可选的 `RevokedAt`，`Source` 使用同一批准来源字段 `Reference`、`Provenance`、`Publisher`、`KeyId`、`ArchiveSha256`、`SignatureReference` 和 `TrustPolicyReference`。运维从独立受信渠道配置公钥、来源和归档摘要。包文件名是 `<ArchiveSha256>.fspkg`，权限为 `0400`。没有批准目录时执行失败。

支持固定 v1 `.fspkg` 容器的一个子集。ZIP 必须恰好包含 `manifest.json`、`index.js`、`config.schema.json`、`signature/checksums.json` 和 `signature/signature.sig`。前三项的 SHA-256 由 `checksums.json` 完整声明。受信发布者以 ECDSA SHA-256 P1363 签名该清单的原始字节，同时运维批准整个 ZIP 的 SHA-256。文件不解压到磁盘。

清单要求 v1 字段及 JSON 命名，`fsusblog` 为 `>=1.3.0 <2.0.0`，`author` 为批准的发布者，运行时固定 `javascript`，能力仅 `article.render`。`network`、`filesystem` 为 `false`，`database` 为 `none`。配置仅允许空对象。唯一 Hook 为 `article.beforeRenderMarkdown`，`scope` 为 `local`，`executionMode` 为 `async`，`idempotent` 为 `true`，`priority` 为 0，`failPolicy` 为 `fail-closed`，`timeoutMs` 为 1 至 250。ESM 默认导出必须匹配包 ID，并通过 `hooks` 或 `activate(ctx)` 注册一次声明的 Hook。回调只收到 Markdown 字符串、Hook 名称、空 `items` 和 `next()`。可以返回原文、替换字符串或 `next(string)`。

父进程先完成包审批，再将单次输入交给独立 Jint 4.13.0 进程。macOS Seatbelt 默认拒绝 OS 访问，只允许启动受信 .NET 宿主并读取系统及其实际程序集目录，允许 .NET JIT 所需的执行内存。工作进程先确认系统探测文件无读取权限，然后运行解释器。进程环境只含启动所需变量，脚本不获得 CLR 互操作、Host API、网络、包路径或文件写入接口。Jint 限制语句数、递归、内存分配、数组规模、正则、Promise 和解释时间，子进程 .NET GC 堆设置上界，父进程保留独立的 3 秒期限并等待子进程退出。发布结果前重读批准文件及原始包，复核同一摘要、公钥期限和取消状态。Jint 内存限制为托管分配约束，Seatbelt 使用 macOS 已弃用的 `sandbox-exec` 命令，Linux 无可用入口。 [Jint 运行不受信代码的边界](https://github.com/sebastienros/jint#running-untrusted-code)

使用 `python3 tests/Integration/Migration/platform-plugin.py /absolute/path/FsusBlogV2.Migrate.dll` 测试。夹具用 OpenSSL 创建新的密钥和签名包，执行程序需使用独立的框架依赖 .NET 发布目录，目录只放程序和依赖。在线 Hook 分发、站点前端接入、SQL 注册表、集群协调、Lua、可调用 IO broker 和生产插件隔离资格仍待完成。依据固定 v1 的 `docs/architecture/plugin-foundation.md`、`docs/architecture/plugin-hook-dispatcher.md` 和 `docs/plugins/typescript-sdk.md`。

本机 macOS 使用 .NET SDK 10.0.404、Jint 4.13.0 和锁定的 Acornima 1.6.2 运行测试。原生进程测试覆盖签名转换、信任撤销、脚本环境无宿主句柄、执行与字节上限、登记文件并发变更时拒绝结果、锁争用、包篡改和 FIFO 拒绝。测试暂停本次调用的子进程，确认父进程超时终止并回收子进程。系统日志记录了子进程读取 `/private/etc/hosts` 被拒绝。 [验证日志](../../artifacts/offline-platform-plugin/native.log)

## Linux ARM64 隔离能力检查

原生探针在非特权身份下启动 Bubblewrap，显式要求独立的 user、mount、PID、network、IPC、UTS 和 cgroup 命名空间。它以只读方式挂载探针自身，使用独立 PID 命名空间的 procfs，清空环境和继承描述符，并通过已封存的匿名描述符交付 ARM64 seccomp 白名单。探针读取实际命名空间标识、描述符列表、有效权限及根挂载标志，并验证网络、本机套接字和文件写入的内核拒绝。 [Bubblewrap 0.12.0](https://github.com/containers/bubblewrap/tree/v0.12.0) · [内核 seccomp](https://docs.kernel.org/userspace-api/seccomp_filter.html)

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -static tests/Integration/Migration/linux-plugin-isolation.c -o /tmp/fsus-plugin-probe
python3 tests/Integration/Migration/linux-plugin-isolation.py /tmp/fsus-plugin-probe
```

实测环境为 Debian 13 ARM64，内核 6.12.115、Bubblewrap 0.12.0、GCC 14.2 和 glibc 2.41。默认及 Python 优化模式均通过。探针核对根挂载、程序和 procfs 均为只读，确认有效及环境 capabilities 为零，并验证直接进入探针分支时会拒绝运行。 [原生日志](../../artifacts/linux-plugin-isolation/native.log)

该白名单适用于无依赖的探针。Linux Jint 调用仍禁用。托管 worker 接入还须针对其专用只读运行时及程序集目录验证系统调用规则、实际资源上限和整组回收。 [内核 cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)

## Linux cgroup v2 资源与回收检查

在使用 cgroup v2 的隔离 Linux ARM64 环境中，以可连接 systemd 用户管理器和 D-Bus 会话的非特权账号运行以下测试。它在临时用户服务中运行上面的 Bubblewrap 探针，并分别运行固定的资源测试。测试只接收已编译的静态探针路径。 [systemd v257 资源控制](https://www.freedesktop.org/software/systemd/man/257/systemd.resource-control.html) · [systemd v257 临时服务](https://www.freedesktop.org/software/systemd/man/257/systemd-run.html)

```sh
python3 tests/Integration/Migration/linux-plugin-cgroups.py /tmp/fsus-plugin-probe
```

工作进程在收到测试控制器的许可前等待。控制器先核对本次 systemd 服务的主 PID、实际内核 cgroup 归属、48 MiB 内存上限、禁用交换空间、8 个任务及 25% 的单 CPU 配额。测试用不匹配的内存上限验证启动拒绝，并读取 `pids.events`、`memory.events` 与 `cpu.stat` 记录的内核事件。主动取消和启动客户端被强制退出两种场景分别验证。子进程被暂停后，通过管理器状态、原进程的 pidfd 和 cgroup 清空确认整组回收。 [systemd v257 服务期限](https://www.freedesktop.org/software/systemd/man/257/systemd.service.html) · [cgroup v2 文件](https://docs.kernel.org/admin-guide/cgroup-v2.html)

Debian 13 ARM64 实测使用 systemd 257.13 和用户会话总线。固定负载触发一次任务数量拒绝、一次组内 OOM 终止和 13 次 CPU 节流。主动取消耗时 0.389 秒，启动客户端被强制退出后的整组回收耗时 4.516 秒。结束后确认临时服务和 cgroup 已移除。Linux Jint 执行仍需独立验证托管运行时。 [原生验证及清理日志](../../artifacts/linux-plugin-cgroups)
