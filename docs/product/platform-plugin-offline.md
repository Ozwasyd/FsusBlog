# 离线平台插件执行

`platform-plugin render ID` 能在 macOS 的独立受限工作进程中执行一个获准的 `article.beforeRenderMarkdown` Hook。它从标准输入读取最多 16 KiB UTF-8 Markdown，成功后仅把转换结果写到标准输出。命令不访问网站、数据库或 HTTP 会话。这个入口与 `extension` 创作扩展管理命令有独立的包格式、批准与执行边界。

将 `FSUSBLOG_PLATFORM_PLUGIN_ROOT` 设为可信运维账号持有的绝对 `0700` 目录。路径不可含符号链接。目录内须有 `0600` 的空 `runner.lock`，运维更换批准目录前应与执行器使用同一把独占锁。`0400` 的 `platform-plugin.json` 须明确写入 `Enabled: true`、`PluginId`、`Permissions: ["article.render"]`、`Key` 和 `Source`。`Key` 使用 `Publisher`、`KeyId`、`SubjectPublicKeyInfo` 字节数组、`ValidFrom`、`ValidUntil`、可选的 `RevokedAt`，`Source` 使用同一批准来源字段 `Reference`、`Provenance`、`Publisher`、`KeyId`、`ArchiveSha256`、`SignatureReference` 和 `TrustPolicyReference`。运维从独立受信渠道配置公钥、来源和归档摘要。包文件名是 `<ArchiveSha256>.fspkg`，权限为 `0400`。没有批准目录时执行失败。

支持固定 v1 `.fspkg` 容器的一个子集。ZIP 必须恰好包含 `manifest.json`、`index.js`、`config.schema.json`、`signature/checksums.json` 和 `signature/signature.sig`。前三项的 SHA-256 由 `checksums.json` 完整声明。受信发布者以 ECDSA SHA-256 P1363 签名该清单的原始字节，同时运维批准整个 ZIP 的 SHA-256。文件不解压到磁盘。

清单要求 v1 字段及 JSON 命名，`fsusblog` 为 `>=1.3.0 <2.0.0`，`author` 为批准的发布者，运行时固定 `javascript`，能力仅 `article.render`。`network`、`filesystem` 为 `false`，`database` 为 `none`。配置仅允许空对象。唯一 Hook 为 `article.beforeRenderMarkdown`，`scope` 为 `local`，`executionMode` 为 `async`，`idempotent` 为 `true`，`priority` 为 0，`failPolicy` 为 `fail-closed`，`timeoutMs` 为 1 至 250。ESM 默认导出必须匹配包 ID，并通过 `hooks` 或 `activate(ctx)` 注册一次声明的 Hook。回调只收到 Markdown 字符串、Hook 名称、空 `items` 和 `next()`。可以返回原文、替换字符串或 `next(string)`。

父进程先完成包审批，再将单次输入交给独立 Jint 4.13.0 进程。macOS Seatbelt 默认拒绝 OS 访问，只允许启动受信 .NET 宿主并读取系统及其实际程序集目录，允许 .NET JIT 所需的执行内存。工作进程先确认系统探测文件无读取权限，然后运行解释器。进程环境只含启动所需变量，脚本不获得 CLR 互操作、Host API、网络、包路径或文件写入接口。Jint 限制语句数、递归、内存分配、数组规模、正则、Promise 和解释时间，子进程 .NET GC 堆设置上界，父进程保留独立的 3 秒期限并等待子进程退出。发布结果前重读批准文件及原始包，复核同一摘要、公钥期限和取消状态。Jint 内存限制为托管分配约束，Seatbelt 使用 macOS 已弃用的 `sandbox-exec` 命令，Linux ARM64 可使用下文的独立工作进程。 [Jint 运行不受信代码的边界](https://github.com/sebastienros/jint#running-untrusted-code)

工作进程回收完成后才可发布结果。若工作和回收均出错，标准错误第一行保留最先的工作错误，第二行为 `cleanup=plugin-worker-drain`。调用方取消时保持退出码 130，若回收也出错则同时报告 `plugin-cancelled` 与回收标记。单独的回收失败返回 `plugin-worker-drain`。这些失败均不输出 Markdown、系统路径或原始异常消息。

使用 `python3 tests/Integration/Migration/platform-plugin.py /absolute/path/FsusBlog.V2.Cli.dll` 测试。夹具用 OpenSSL 创建新的密钥和签名包，执行程序需使用独立的框架依赖 .NET 发布目录，目录只放程序和依赖。通用在线 Hook 分发、SQL 注册表、站点用户批准、集群协调、Lua 和可调用 IO broker 仍待完成。依据固定 v1 的 `docs/architecture/plugin-foundation.md`、`docs/architecture/plugin-hook-dispatcher.md` 和 `docs/plugins/typescript-sdk.md`。

本机 macOS 使用 .NET SDK 10.0.404、Jint 4.13.0 和锁定的 Acornima 1.6.2 运行测试。原生进程测试覆盖签名转换、信任撤销、脚本环境无宿主句柄、执行与字节上限、登记文件并发变更时拒绝结果、锁争用、包篡改和 FIFO 拒绝。测试暂停本次调用的子进程，确认父进程超时终止并回收子进程。系统日志记录了子进程读取 `/private/etc/hosts` 被拒绝。

## Linux ARM64 隔离能力检查

原生探针在非特权身份下启动 Bubblewrap，显式要求独立的 user、mount、PID、network、IPC、UTS 和 cgroup 命名空间。它以只读方式挂载探针自身，使用独立 PID 命名空间的 procfs，清空环境和继承描述符，并通过已封存的匿名描述符交付 ARM64 seccomp 白名单。探针读取实际命名空间标识、描述符列表、有效权限及根挂载标志，并验证网络、本机套接字和文件写入的内核拒绝。 [Bubblewrap 0.12.0](https://github.com/containers/bubblewrap/tree/v0.12.0) · [内核 seccomp](https://docs.kernel.org/userspace-api/seccomp_filter.html)

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -static tests/Integration/Migration/linux-plugin-isolation.c -o /tmp/fsus-plugin-probe
python3 tests/Integration/Migration/linux-plugin-isolation.py /tmp/fsus-plugin-probe
```

实测环境为 Debian 13 ARM64，内核 6.12.115、Bubblewrap 0.12.0、GCC 14.2 和 glibc 2.41。默认及 Python 优化模式均通过。探针核对根挂载、程序和 procfs 均为只读，确认有效及环境 capabilities 为零，并验证直接进入探针分支时会拒绝运行。

该白名单适用于无依赖的探针。静态探针用于独立核对宿主的隔离能力。下文的托管 worker 使用不同的系统调用允许列表。 [内核 cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)

## Linux cgroup v2 资源与回收检查

在使用 cgroup v2 的隔离 Linux ARM64 环境中，以可连接 systemd 用户管理器和 D-Bus 会话的非特权账号运行以下测试。它在临时用户服务中运行上面的 Bubblewrap 探针，并分别运行固定的资源测试。测试只接收已编译的静态探针路径。 [systemd v257 资源控制](https://www.freedesktop.org/software/systemd/man/257/systemd.resource-control.html) · [systemd v257 临时服务](https://www.freedesktop.org/software/systemd/man/257/systemd-run.html)

```sh
python3 tests/Integration/Migration/linux-plugin-cgroups.py /tmp/fsus-plugin-probe
```

工作进程在收到测试控制器的许可前等待。控制器先核对本次 systemd 服务的主 PID、实际内核 cgroup 归属、48 MiB 内存上限、禁用交换空间、8 个任务及 25% 的单 CPU 配额。测试用不匹配的内存上限验证启动拒绝，并读取 `pids.events`、`memory.events` 与 `cpu.stat` 记录的内核事件。主动取消和启动客户端被强制退出两种场景分别验证。子进程被暂停后，通过管理器状态、原进程的 pidfd 和 cgroup 清空确认整组回收。 [systemd v257 服务期限](https://www.freedesktop.org/software/systemd/man/257/systemd.service.html) · [cgroup v2 文件](https://docs.kernel.org/admin-guide/cgroup-v2.html)

Debian 13 ARM64 实测使用 systemd 257.13 和用户会话总线。固定负载触发一次任务数量拒绝、一次组内 OOM 终止和 13 次 CPU 节流。主动取消耗时 0.389 秒，启动客户端被强制退出后的整组回收耗时 4.516 秒。结束后确认临时服务和 cgroup 已移除。这组限额用于宿主探针，托管工作进程使用下文的独立限额。

## 离线 Linux ARM64 工作进程

该入口在 Linux 上默认关闭。经核验的 Debian ARM64 环境需要 systemd 用户管理器、D-Bus 会话、cgroup v2 的 CPU、内存和任务控制器、Bubblewrap 0.12.0，以及核验过的 .NET 10.0.404 SDK 与 10.0.15 运行时。可在独立目录连同固定依赖生成工作进程。 [Bubblewrap 0.12.0](https://github.com/containers/bubblewrap/tree/v0.12.0) · [systemd 用户服务](https://www.freedesktop.org/software/systemd/man/257/systemd-run.html)

~~~sh
tools/stage-linux-plugin-worker.sh /absolute/verified-dotnet /absolute/staged-worker
~~~

`src/PluginWorker/FsusBlog.V2.PluginWorker.csproj` 已纳入 `FsusBlog.V2.slnx` 并在项目级保持独立可构建，但解决方案或项目级 `dotnet build` 仅验证受管程序集编译，不扩大平台支持承诺，也不绕过其 Linux ARM64 目标平台限制。受管编译、Linux ARM64 发布封装（`tools/stage-linux-plugin-worker.sh`）与真实沙箱验收（`tests/Integration/Migration/linux-managed-plugin-flow.py` 及前述隔离/cgroup 探针）须分别记账；非 Linux ARM64 环境下后两项记为未执行。

部署者应核对生成的 `payload.sha256` 以及清单自身的 SHA-256，然后将完整工作目录安装在固定的 `/opt/fsusblog-platform-plugin-arm64`。安装目录和内容由 root 持有，其他账号无写权限。保持打包工具设置的文件模式，特别是 `rootfs` 根目录的只读模式。发布内容包括工作进程、.NET 运行时目录和所需的 Debian 动态加载依赖。调用期间保持安装目录稳定，更新时以全新的审核凭证替换。

~~~sh
export FSUSBLOG_PLATFORM_PLUGIN_LINUX=1
export FSUSBLOG_PLATFORM_PLUGIN_LINUX_INSTALL_SHA256=APPROVED_MANIFEST_SHA256
export FSUSBLOG_PLATFORM_PLUGIN_ROOT=/absolute/operator-plugin-registry
printf 'Markdown content\n' | dotnet FsusBlog.V2.Cli.dll platform-plugin render example.site.markdown
~~~

宿主在工作进程启动前检查安装清单和经签名的包。临时 systemd 服务使用 128 MiB 内存、零交换、24 个任务和 100% 的单 CPU 配额。Bubblewrap 从专用只读目录启动 .NET，清空继承环境及额外描述符，隔离网络与 IPC，并加载第一个 seccomp 过滤器。工作进程再把禁止重新执行程序的过滤器同步到 CLR 线程，完成后回报就绪。宿主核对实际 cgroup 限额，只在就绪后传送输入。结果发布前核对进程组退出、已安装字节和包审批。管理器在启动客户端消失后仍实施独立的运行期限。 [内核系统调用过滤和线程同步](https://docs.kernel.org/userspace-api/seccomp_filter.html) · [内核 cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)

安装测试环境后，通过 `python3 tests/Integration/Migration/linux-managed-plugin-flow.py /absolute/FsusBlog.V2.Cli.dll` 复现签名工作流。Debian 13 ARM64 原生测试核对了 206 个安装文件。12 个用例覆盖实际转换、错签名、撤销、输入输出限制、在途批准变化、宿主期限及宿主被强制退出后的回收。测试安装和临时单元已清理。标准站点发行包仍由原发布脚本生成，Linux 工作进程另行部署。

## Linux ARM64 站点作者预览

在相同的 Linux ARM64 部署中，可额外设置 `FSUSBLOG_AUTHOR_PLUGIN_PREVIEW_ID` 为批准包 ID，并配置站点的 `FSUSBLOG_PUBLIC_ORIGIN`。站点使用上面的 `FSUSBLOG_PLATFORM_PLUGIN_ROOT`、Linux 开关及安装摘要。运行站点的非 root 账号必须拥有私有批准目录和可用的 systemd 用户会话，安装目录仍由 root 持有。批准目录须独立于站点 Web 及私有媒体目录。该配置缺省时站点没有预览端点，也不会宣告预览功能。

同源 HTTPS 的 `POST /api/v2/authoring/draft/{id}/plugin-preview.md?revision={revision}` 要求有效站点会话、`X-Fsus-Current-Session` 及当前未删除、未归档的所属文章修订。请求没有正文。`consent=1` 只读取签名和修订坐标，返回 204 与已签名插件的标识、版本、包摘要和一次性授权。作者在 Inspector 看到这些信息并确认后，客户端用 `X-Fsus-Plugin-Consent` 发起实际预览。授权 90 秒有效，绑定站点进程、作者、账号代次、会话、文章、修订和精确运维批准。重复取得授权会替换同会话中的旧授权。 在 Inspector 取消审核会发送 `consent=0` 和同一授权头。服务在同一会话与修订下撤回待用授权，并返回 204。

服务只向工作进程发送本次已确认修订的原始 Markdown，输入与输出各限 16 KiB UTF-8。全站最多运行一个预览，繁忙时返回 429。工作进程继续受原有 cgroup、命名空间、执行期限和回收约束。账号、会话和修订在工作进程退出后复核，批准锁保持到结果送出。批准文件撤回、变化、包失效、工作进程不可用或站点停止时预览失败。

成功响应是 `text/plain; charset=utf-8`，禁止缓存。Inspector 使用本地 FsusUI Markdown Wasm，按允许的语义元素展示结果。链接和图片以惰性文字展示，预览不会请求嵌入资源。该请求只读取当前修订，不保存转换结果，不触发发布流水线。运维批准继续由原有私有目录管理。配置批准一个既有 `article.render` 包后，只有本来可编辑自己文章的账号能够触发预览。 [冻结的 #3665 范围](https://github.com/Fsu0413/FsusBlog/issues/3665)

原生 Debian ARM64 通过真实 PostgreSQL、证书固定的 Kestrel HTTPS 和签名工作进程验证默认关闭、转换、批准失效、越权和旧修订。375px Chrome 经本机 HTTPS 转发连接到实际 worker，验证键盘审核、取消和明确确认后的呈递。发布 Hook、其他用户授权类型和通用 IO broker 仍待验收。
