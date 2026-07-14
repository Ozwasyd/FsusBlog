# Data Protection Key Ring At-Rest Protection

FsusBlog 的 Cookie、antiforgery token 和应用内 Data Protection payload 共用 ASP.NET Core Data Protection。生产蓝绿实例共享同一个可写 key ring，并固定使用 application discriminator `FsusBlog`。共享卷只保存经过 X.509 RSA 证书加密的 key XML；证书私钥来自独立只读 secret mount，不与 key ring、镜像或站点备份共存。

## Production configuration

配置源可以是受控 JSON、secret provider 或环境变量。密码不得提交到仓库；环境变量使用 .NET 双下划线映射，例如 `DataProtection__KeyProtection__CurrentCertificate__Password`。

```json
{
  "DataProtection": {
    "ApplicationName": "FsusBlog",
    "KeyRingPath": "/var/lib/fsusblog/shared/data-protection/keyring",
    "KeyProtection": {
      "Mode": "Certificate",
      "CurrentCertificate": {
        "Path": "/run/secrets/fsusblog-data-protection-current.pfx",
        "Password": ""
      },
      "PreviousCertificates": [
        {
          "Path": "/run/secrets/fsusblog-data-protection-previous.pfx",
          "Password": ""
        }
      ]
    }
  }
}
```

当前证书必须是位于有效期内、包含 RSA 私钥的 PKCS#12/PFX。previous certificate 也必须包含 RSA 私钥，但允许证书自然过期后继续用于限定窗口内的历史 key 解密。证书路径不得位于 `KeyRingPath` 内。两个 slot 必须看到相同的 key ring、current certificate 和 previous certificate 集合。

生产启动会在服务注册和 `ProductionStartupValidator` 两层 fail closed：

- `Mode`、共享 ring、application name 或当前证书配置缺失；
- protector mode 不是 `Certificate`；
- 当前/历史证书不存在、密码错误、格式错误或缺少 RSA 私钥；
- 当前证书尚未生效或已经过期；
- 现有 `key-*.xml` 不含 Data Protection `encryptedSecret` 包装，或 XML 无法安全读取；
- 证书私钥路径位于共享 key ring 内。

错误只报告固定配置类别，不输出证书密码、私钥、key id、物理路径或 key XML。

## Initial migration from a plaintext ring

新增 protector 不会自动重写已经存在的明文 Data Protection key。为避免把“新 key 已加密”误报成“整个 ring 已安全”，生产启动会拒绝包含任何明文 key 的 ring。

首次迁移必须使用受控维护窗口：

1. 保持当前 active slot 服务流量，冻结会生成新 Data Protection payload 的切换操作。
2. 备份旧 ring 到访问受控、加密的迁移介质；不要把当前/历史 PFX 放入同一备份。
3. 为 candidate 准备空的共享 ring 和 current PFX，启动后生成的 key XML 必须包含 `encryptedSecret`，且不得包含明文 `masterKey`。
4. 运行匿名公开读、登录、admin、notification stream 和 binary smoke。切换到新 ring 会使旧 Cookie/antiforgery/Data Protection payload 失效，因此必须把重新登录作为显式迁移影响，而不是静默兼容。
5. 只有 candidate 验证完成后切流。旧 ring 保留在隔离介质中直到回退窗口结束，不得重新挂回新旧 slot 的共享路径。

若业务要求旧 payload 在迁移后继续有效，必须先提供经过独立审查的离线 key re-encryption 工具；当前运行时代码不会自动读取明文 key 再原地改写。

## Certificate rollover and blue-green sequence

证书轮换使用“双证书预发布”，不会删除或覆盖历史 key：

1. 将新证书 B 以只读 secret 同时挂载到 blue 和 green；两槽仍以 A 为 current，并把 B 加入 previous/decrypt 集合。验证两槽都能读取现有 payload。
2. 更新两槽配置，使 B 成为 current、A 进入 previous。先启动 candidate；旧 key 仍由 A 解密，新 key 只由 B 加密。
3. 在 candidate 上触发新 key 生成，验证两个都配置 A+B 的 slot 能双向读取旧/新 payload，再切流。
4. 保留 A，直到所有由 A 加密的 key 及其 payload 最大生命周期结束。之后在维护变更中先移除 A 的解密配置，再删除 A secret；不要删除仍被 ring 引用的 key XML。

不要只在 candidate 挂载 B。active slot 若没有 B 私钥，就无法解密 candidate 生成的新 key，回切后会造成会话中断。

## Monitoring and rollback without restarting the active slot

上线前检查 candidate readiness、固定类别启动错误和共享 ring 读写探针；探针不得返回 key 文件名或内容。运行时若 candidate 出现解密错误：

1. 不修改共享 ring、不删除 key、不撤销 current/previous certificate。
2. 通过现有蓝绿入口把流量切回仍健康的 active slot；active slot 不需要重启。
3. drain candidate，保留失败证据的低基数类别，修复证书集合或 secret mount 后再启动新的 candidate。

只要两个 slot 在轮换前已同时拥有 current+previous 私钥，回切不会改变 Cookie、notification stream 或 binary API 语义。若错误来自误删旧证书或 key，只能从分别受控的 secret/key-ring 备份恢复；不得通过临时关闭 at-rest protector、允许明文 key 或改变 `ApplicationName` 进行降级。

## Verification checklist

- 新生成的每个 `key-*.xml` 都包含 `encryptedSecret`，不含明文 `masterKey`。
- 不持有 current/previous 私钥的 provider 无法解密共享 ring payload。
- blue/green 使用相同 `FsusBlog` discriminator，可双向读取轮换前后 payload。
- production 缺少 protector、证书错误和遗留明文 ring 均 fail closed。
- 匿名、登录、admin、notification stream 和 AEDS binary 路由行为不因 key-at-rest protector 改变。
