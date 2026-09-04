# 阅读排版契约

本文只拥有 [`surface-profiles.md`](surface-profiles.md) 中 `reading` 内容的排版。Article、About、Comment 与管理端 Preview 共用 `MarkdownRenderer` 和 `markdown.css`，正文基础基线为 16px、400 字重与 1.8 行高；中文文章叙事正文遵循书籍与经典刊物排版规范，使用两端齐行对齐（`text-align: justify`）、0.015em 微字距补偿与 2em 段落首行缩进；各级标题保持左对齐；document mode（About、法律与政策页面）保持段落零首行缩进与左对齐。入口只声明 `article`、`about` 或 `preview` 语义，不允许在调用方重写正文、引用、列表、标题或代码字体。

## Display、reading 与 metadata

- `display`：文章列表标题使用 18/20/24px 与 1.25/1.2 行高、700 字重；页面级 H1 另由 [`page-title-scale.md`](page-title-scale.md) 约束。
- `reading`：列表摘要使用 14/16px、400、1.7；长文正文与引用使用 16px/400/1.8。Markdown paragraph 只有一条权威规则。
- `metadata`：日期、分类、状态、阅读量和动作使用 12px 或 14px，不能用装饰性微缩文字承载信息。信息文本消费达到 AA 的 muted/tertiary；decorative token 只用于点和 marker。

AOT emergency、hydration 与 SPA takeover 使用同一 reading role、行高和 metadata 档位。Markdown blockquote 继承正文排版，不另行缩小；账户导航、task controls 和其他非阅读文本由 FsusUI 及对应 task 领域文档拥有。

## 加载字重

Reading renderer 只使用 font loader 已确认存在的正文、强调和标题字重，不依赖浏览器合成缺失字重。弱层级用语义颜色表达；正文、metadata/操作强调与标题分别选择已加载的 reading role。通用字体与组件排版权威仍在当前 FsusUI 基线。

`ArticleCommentComposer` 的身份标签、badge、toggle、draft、empty preview、feedback 与 metrics 使用 700；desktop TOC title 使用 700；blockquote 不声明局部字重，继承 Markdown 根的 400。

## Markdown heading 与 document mode

正文内标题使用 24px H1 与 20px H2-H6，均保持左对齐；30px 只保留给页面级标题。Article mode 的 Markdown H1 是 chapter heading，不是第二个 page title，使用 1.4em/700、左对齐和 3em 上间距。Preview/editor 不自动继承 article-only override；需要忠实文章预览时必须显式选择 article mode。

About、privacy、guidelines 与 copyright 使用 `mode="about"` 和 `markdown-body--document`。Document mode 保持自然字距、`text-autospace: normal`、段落零首行缩进、列表零横向 margin 与 1.5em marker padding；article/preview/editor 不继承这些 document overrides。段落、blockquote、列表和代码块从同一阅读列起始，blockquote 继承 16px/400/1.8。

fenced code、inline code、comment code、audit/detail preview、AOT/SSR 与 hydrated 内容统一使用 `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`。代码块使用阅读面语义填充和中性边界，长行只在块内横向滚动，不扩大 reading container。

`data-fsus-surface="reading"` 在所有 motion preference 下都禁止 blur、glow、motion trail、shimmer、pulse、translate、scale、stagger 和 scroll reveal。正文、标题、图片与代码块静态出现；复制反馈、focus/target 定位、阅读进度状态和 media overlay 可以使用功能动效。Light/Dark 只替换语义颜色；375px、768px、1440px 与 150% zoom 不改变 DOM 顺序和排版角色。
