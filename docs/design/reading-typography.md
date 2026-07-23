# 阅读排版契约

Article、About、Comment 与管理端 Preview 共用 `MarkdownRenderer` 和 `markdown.css`，正文唯一基线为 16px、400 字重、1.8 行高、自然字距与左对齐。入口只声明 `article`、`about` 或 `preview` 语义，不允许在调用方重写正文、引用、列表、标题或代码字体。

## Display、reading 与 metadata

- `display`：文章列表标题使用 18/20/24px 与 1.25/1.2 行高、700 字重；页面级 H1 另由 [`page-title-scale.md`](page-title-scale.md) 约束。
- `reading`：列表摘要使用 14/16px、400、1.7；长文正文与引用使用 16px/400/1.8。Markdown paragraph 只有一条权威规则。
- `metadata`：日期、分类、状态、阅读量和动作使用 12px 或 14px，不能用装饰性微缩文字承载信息。信息文本消费达到 AA 的 muted/tertiary；decorative token 只用于点和 marker。

AOT emergency、hydration 与 SPA takeover 使用同一角色、行高和 12/14px metadata。`src/frontend/src` 的 public/account/admin CSS `font-size` 小字号只写 `12px`、`14px` 或 `16px`；`AccountNavigationPanel.vue` 的导航层级是唯一例外，使用 11px 分组标签与 13px 导航项。除该例外外，11px/13px 和 `0.6` 至 `0.9rem/em` 任意小字号均不得回流。Markdown blockquote 继承 16px/400/1.8，不另行缩小。

## 加载字重

CSS 只允许真实加载的 `400`、`500`、`700`；utility 只允许 `font-normal`、`font-medium`、`font-bold`。不得使用 100/200/300/600/800/900 或对应 utility，也不得依赖浏览器合成缺失的粗体或细体。弱层级用颜色表达；标题使用 700，metadata/操作强调使用 500，正文默认 400。

`ArticleCommentComposer` 的身份标签、badge、toggle、draft、empty preview、feedback 与 metrics 使用 700；desktop TOC title 使用 700；blockquote 不声明局部字重，继承 Markdown 根的 400。

## Markdown heading 与 document mode

正文内标题使用 24px H1 与 20px H2-H6，均保持左对齐；30px 只保留给页面级标题。Article mode 的 Markdown H1 是 chapter heading，不是第二个 page title，使用 1.4em/700、左对齐和 3em 上间距。Preview/editor 不自动继承 article-only override；需要忠实文章预览时必须显式选择 article mode。

About、privacy、guidelines 与 copyright 使用 `mode="about"` 和 `markdown-body--document`。Document mode 保持自然字距、`text-autospace: normal`、段落零首行缩进、列表零横向 margin 与 1.5em marker padding；article/preview/editor 不继承这些 document overrides。段落、blockquote、列表和代码块从同一阅读列起始，blockquote 继承 16px/400/1.8。

fenced code、inline code、comment code、audit/detail preview、AOT/SSR 与 hydrated 内容统一使用 `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`。代码块使用阅读面语义填充和中性边界，长行只在块内横向滚动，不扩大 reading container。

`data-fsus-surface="reading"` 禁止 blur、glow、motion trail，以及在 reduced-motion 下继续运行的 shimmer、pulse、translate、scale 或 scroll reveal。Light/Dark 只替换语义颜色；375px、768px、1440px 与 150% zoom 不改变 DOM 顺序和排版角色。
