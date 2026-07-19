# 阅读排版契约

Article、About、Comment 与管理端 Preview 共用 `MarkdownRenderer` 和 `markdown.css`，正文唯一基线为 16px、400 字重、1.8 行高、自然字距与左对齐。入口只声明 `article`、`about` 或 `preview` 语义，不允许在调用方重写正文、引用、列表、标题或代码字体。

正文内标题使用 24px H1 与 20px H2-H6，均保持左对齐；30px 只保留给页面级标题。段落、blockquote、列表和代码块的外边界从同一阅读列起始，blockquote 继承正文的 16px/400/1.8，不另行缩小或加负字距。

fenced code、inline code、comment code、audit/detail preview、AOT/SSR 与 hydrated 内容统一使用 `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`。代码块使用阅读面语义填充和中性边界，长行只在块内横向滚动，不扩大 reading container。

`data-fsus-surface="reading"` 禁止 blur、glow、motion trail，以及在 reduced-motion 下继续运行的 shimmer、pulse、translate、scale 或 scroll reveal。Light/Dark 只替换语义颜色；375px、768px、1440px 与 150% zoom 不改变 DOM 顺序和排版角色。
