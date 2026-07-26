# 页面级标题比例

本文只拥有 FsusBlog 产品级标题层级；通用 typography、组件标题 geometry 和字体 token 由当前 FsusUI 基线拥有。页面档案及其主视觉焦点见 [`surface-profiles.md`](surface-profiles.md)。

FsusBlog 的页面级标题统一使用编辑出版式 24/30px 比例：375px 等移动视口为 24px，640px 起为 30px，字重 700，移动端行高至少 1.25，桌面端至少 1.2，不使用负字距。

该比例覆盖公共筛选页、账户与管理页、登录/注册/恢复页以及 403/404。错误码是 14px 的辅助标签，不占用 H1；每页只保留一个语义 H1。标题和说明相距 16px，说明为 14px/400，说明和首个表单、筛选或主操作相距 24px。

AOT/SSR、hydration 和 SPA takeover 复用同一 Vue 页面组件与相同 `text-2xl sm:text-3xl` 几何，不维护第二套首帧字号。Light/Dark 只切换颜色角色；150% 缩放与 reduced-motion 不改变标题层级、DOM 顺序或字号档位。

静态门禁拒绝公共、认证和错误页面重新使用 `text-4xl` 及更大 display utility，也拒绝 gradient、glow、text-shadow 或多 H1。账户标题的 CSS 门禁同时固定 24px mobile / 30px desktop，防止旧的全视口 24px 规则回流。

文章详情 header 是该页面唯一 page-title authority，沿用 24/30px、700 和已加载字重；中文多行标题使用 1.15 行高，不用负字距。Article mode 内的 Markdown H1 只是章节标题，具体排版由 [`reading-typography.md`](reading-typography.md) 负责，不得居中或形成第二个 page title。About/document mode、Markdown sanitization 与 metadata separator 不受 page-title 规则重写。
