# 私有请求身份代际

前端私有请求统一由 `PrivateRequestRuntime` 分配 generation lease。generation 是仅存在于内存的单调数字，不包含账户、管理员、Cookie、权限或会话标识，也不会写入 URL、存储、遥测和 BroadcastChannel。

## 边界

- `account`：账户 API，以及可能携带账户专属投影的 optional-auth 读取。
- `admin`：独立管理员会话 API。
- `public`：匿名公共读取，不登记身份切换 abort，也不受 generation 变化影响。

generated binary route 从权威 route descriptor 的 `auth` 字段推导 scope。历史 `binaryUrl` 调用必须显式声明 `privateScope`；直接 `fetch` 或 `binaryRequest` 的私有 API 必须通过 `runPrivateRequest`。API Promise 只有在响应 generation 仍等于当前 generation 时才能返回，因此 Pinia、composable 和直接调用者共享同一个提交屏障。

账号退出、会话过期和账号切换会先推进 account generation 并 abort 已登记请求；管理员退出或管理员会话变化只推进 admin generation。optional-auth 公共传输不会被强制 abort，但若包含上一身份投影，其结果会在提交前丢弃。

## 风险与无重启回退

该机制不改变服务端 Session、Cookie、AEDS 帧或 API 响应。旧响应以 `AbortError` 语义退出，既有 composable 的中止分支可安全忽略。若需要回退，只需回滚前端静态资源，无需重启后端；服务端鉴权仍是最终授权边界。账户与管理员 generation 独立，避免账户退出无谓取消仍有效的管理员请求。
