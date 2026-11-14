# 创作扩展包与操作授权

`Core/Extensions` 实现 P5 创作扩展的本地包验证与进程内授权。包格式取自固定 v1 源码的 `AuthoringExtensionPackages` 与 `ZipAuthoringPackageArchiveReader`。`manifest.json` 使用固定字段和数值枚举，发布者对原始 ZIP 字节提供独立的 ECDSA SHA-256 P1363 签名。宿主先配置精确的归档摘要、来源与信任材料，再通过 `ExtensionPackageVerifier.Verify` 验证。验证要求签名、来源记录、三类内容摘要、宿主平台和公钥有效期一致。归档检查限制条目数量和长度，拒绝路径穿越、链接、大小写冲突和解析歧义。

`ExtensionAuthority` 由可信宿主持有。授权同时绑定包、贡献、能力、用途、会话代次、站点、文档和修订。每个请求 ID 在进程内只可获取一次操作。读取范围、读取选区和写入暂存分别使用封闭的请求类型。撤销同意、替换信任、切换包或更新身份坐标后，旧操作在发布前复核会失败，恢复旧坐标也不会恢复旧同意。命令有并发和时间预算。包替换拒绝降级、同版本异内容和不兼容的状态结构切换。

`ExtensionInstallationStore.Create` 要求宿主提供独占的 macOS/Linux `0700` 目录、独立的存储 ID、随机 32 字节 MAC 密钥、批准的来源和发布者信任目录。安装将 ZIP 原字节和分离签名分别按 SHA-256 命名，文件以 `0400` 创建并发布。同名对象复核后复用，摘要不符则拒绝。单写者持锁，信任、激活、停用和版本约束保存在 HMAC-SHA256 账本。账本通过同目录临时文件、文件同步、原子重命名和目录同步落盘。已发布但未被激活记录引用的文件可按摘要安全复用。

`ExtensionInstallationStore.Open` 从账本恢复版本约束和经验证的激活。授予同意、开始操作和同步发布结果之前，重新读取账本和原始安装文件并核验签名、完整内容与当前信任期限。同意与操作保持进程内生命周期。信任轮换会停用现有包并要求重新激活；已到期的发布者密钥不妨碍宿主维护信任或停用包。宿主可将 `Checkpoint` 保存在独立可信存储并在重启时提供，用序号与摘要拒绝对旧账本的完整回放。此模块未注册外部检查点存储；同权限攻击、整卷回滚和断电恢复需要部署环境的独立验证。

`ExtensionStaging` 接受宿主配置的 macOS/Linux 私有 `0700` 目录和可信宿主提供的输入流。具备授权的请求使用 `CreateNew` 获取 `0600` 文件句柄，随即移除路径，再向原始句柄写入有限长度。已有同名文件保留原字节。句柄释放完成并复核请求后才返回摘要收据。释放失败时保留首个工作错误及次要故障。暂存目录及其路径由宿主独占控制，此处没有同操作系统身份恶意重命名或进程崩溃后的 inode 回收证明。

测试使用真实签名 ZIP、受控时钟和本地磁盘，覆盖错误签名、来源、密钥撤销边界、时钟回退、非法条目、版本冲突、越权请求、重放、异步暂存期间撤销、并发同请求和磁盘碰撞。安装测试覆盖第二写者拒绝、打开持久化目录恢复激活、降级、ZIP 和签名篡改、账本篡改、旧账本重放、密钥轮换和签名有效期到期。运行 `dotnet test tests/Core/FsusBlog.V2.Core.Tests.csproj --filter FullyQualifiedName~ExtensionAuthorityTests`。

生产接入仍需宿主管理信任与检查点、真实会话与用户同意、文档和导出的正式 IO broker、运行宿主与隔离验证。v1 通用 `.fspkg` Hook 运行时、主题和字体属于 P5 的独立能力。本模块没有在服务端注册扩展端点或装载入口。

## 离线运维

固定 v1 源码的 `AuthoringEndpoints.OperationsRoutes.cs` 为插件概览、安装和管理鉴权。安装及隔离等敏感操作要求管理员权限和 step-up，隔离和恢复需要明确确认。`AuthoringExtensionLifecycleResources` 记录隔离原因并要求匹配的宿主批准才可清除。v2 通过离线命令对创作扩展实施这一流程，运维权限由主机授予能访问安装目录和独立密钥文件的受信账号。

使用专用主机账号创建空的 `0700` 安装目录和另一个 `0700` 运维目录。将独立的随机 32 字节原始 MAC 密钥保存在 `0400` 文件。为这套存储保留一个非空 UUID。设置 `FSUSBLOG_EXTENSION_ROOT`、`FSUSBLOG_EXTENSION_STORE_ID`、`FSUSBLOG_EXTENSION_MAC_KEY_FILE`，两个路径使用绝对路径，文件及其父路径禁止符号链接。MAC 密钥请保存在安装目录之外。命令不访问 PostgreSQL，也不输出密钥。

`TRUST.json` 是由主机运维审核并提供的 `0400` 配置，放在 `0700` 目录下。它包含 `keys` 和 `sources` 两个数组。每个 `keys` 条目包含 `publisher`、`keyId`、`subjectPublicKeyInfo`、`validFrom`、`validUntil` 和可选的 `revokedAt`。`subjectPublicKeyInfo` 是命名曲线公钥 DER 的字节数组，时间采用带时区的 ISO 8601 格式。每个 `sources` 条目包含 `reference`、`provenance`、`publisher`、`keyId`、`archiveSha256`、`signatureReference` 和 `trustPolicyReference`。`reference` 和 `provenance` 采用 `approved-source/<id>` 和 `provenance/<id>`，归档摘要是 64 位小写十六进制字符串。发布者公钥、来源和精确摘要由运维独立验证。

| 参数 | 操作 |
| --- | --- |
| `extension init TRUST.json` | 初始化空安装目录并返回检查点 |
| `extension status` | 只读核验账本和登记为激活的包，返回检查点、状态和核验失败码 |
| `extension trust SEQUENCE:DIGEST TRUST.json` | 替换信任目录并停用此前激活的包 |
| `extension activate SEQUENCE:DIGEST SOURCE ARCHIVE SIGNATURE` | 用批准来源、ZIP 原字节和 ECDSA P1363 原始签名登记 Linux 宿主激活 |
| `extension deactivate SEQUENCE:DIGEST EXTENSION_ID` | 停用并保留版本约束 |
| `extension quarantine SEQUENCE:DIGEST EXTENSION_ID REASON_CODE` | 隔离并写入原因、时间和隔离收据 |
| `extension release SEQUENCE:DIGEST EXTENSION_ID QUARANTINE_RECEIPT APPROVAL_ID` | 将隔离收据与本次运维批准记录的 UUID 绑定并清除隔离 |

通过 `dotnet /path/to/FsusBlogV2.Migrate.dll` 执行上表命令。初始化和每次变更输出包含 `sequence` 和 `digest` 的 JSON。变更必须传入已核对的当前检查点，格式为 `sequence:digest`。在独立位置保存最新检查点可检测旧账本回放。状态始终报告所读取的检查点，运维可与独立记录比对。包损坏显示 `active-blocked`，仍可依据已认证账本隔离。清除隔离需要独立批准记录且包处于停用状态，再次激活会重新验证归档和有效信任。命令不启动工作进程，`active-verified` 表示安装登记和签名已核验。

端到端测试从 OpenSSL 和 Python 生成新的签名包、信任配置和私有工作目录，通过实际 CLI 进程验证初始化、激活、过期检查点拒绝、损坏状态、隔离和释放。运行 `bash tests/Integration/Migration/extensions.sh "$PWD/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll"`。当前结果来自 macOS 原生工具链。
