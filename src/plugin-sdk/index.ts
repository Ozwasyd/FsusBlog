export type PluginCapability =
  | 'article.read'
  | 'article.render'
  | 'article.write.draft'
  | 'comment.read'
  | 'comment.create'
  | 'comment.moderate'
  | 'search.index.write'
  | 'search.query.rewrite'
  | 'media.process'
  | 'plugin.storage.kv'
  | 'plugin.storage.object'
  | 'plugin.log.write'
  | 'network.http.outbound'
  | 'scheduler.job.create'
  | 'admin.ui.extend'
  | 'theme.asset.read'
  | 'user.auth.hook'

export type PluginHookName =
  | 'article.beforeSave'
  | 'article.afterSave'
  | 'article.beforeRenderMarkdown'
  | 'article.afterRenderHtml'
  | 'article.beforePublish'
  | 'article.afterPublish'
  | 'article.beforeDelete'
  | 'comment.beforeCreate'
  | 'comment.afterCreate'
  | 'comment.beforeAudit'
  | 'comment.afterAudit'
  | 'comment.beforeDisplay'
  | 'comment.beforeDelete'
  | 'search.beforeIndex'
  | 'search.afterIndex'
  | 'search.queryRewrite'
  | 'search.resultRank'
  | 'media.beforeUpload'
  | 'media.afterUpload'
  | 'media.beforeProcess'
  | 'media.afterProcess'
  | 'user.beforeLogin'
  | 'user.afterLogin'
  | 'user.beforeRegister'
  | 'system.startup'
  | 'system.shutdown'
  | 'scheduler.tick'
  | 'plugin.activate'
  | 'plugin.deactivate'

export interface ArticleDto {
  id: number
  title: string
  content?: string
  status?: string
  [key: string]: unknown
}

export interface CommentDto {
  id: number
  articleId: number
  content: string
  status?: string
  [key: string]: unknown
}

export interface SearchDto {
  query: string
  fields?: Readonly<Record<string, unknown>>
}

export interface MediaDto {
  assetId: string
  mediaType: string
  size: number
  [key: string]: unknown
}

export interface HookResult<T = unknown> {
  readonly continue: boolean
  readonly value: T
}

export interface HostApi {
  readonly log: {
    write(message: string, level?: 'debug' | 'info' | 'warning' | 'error'): Promise<unknown>
  }
  readonly storage: {
    get(key: string): Promise<unknown>
    put(key: string, value: unknown): Promise<unknown>
    delete(key: string): Promise<unknown>
    getObject(key: string): Promise<unknown>
    putObject(key: string, value: unknown): Promise<unknown>
  }
  readonly article: {
    read(input: Readonly<Record<string, unknown>>): Promise<ArticleDto | null>
    render(input: Readonly<Record<string, unknown>>): Promise<unknown>
    writeDraft(input: Readonly<Record<string, unknown>>): Promise<unknown>
  }
  readonly comment: {
    read(input: Readonly<Record<string, unknown>>): Promise<CommentDto | null>
    create(input: Readonly<Record<string, unknown>>): Promise<unknown>
    moderate(input: Readonly<Record<string, unknown>>): Promise<unknown>
    reject(reason: string): HookResult<{ reason: string }>
  }
  readonly search: {
    rewrite(input: SearchDto): Promise<unknown>
    writeIndex(input: Readonly<Record<string, unknown>>): Promise<unknown>
  }
  readonly media: {
    process(input: MediaDto): Promise<unknown>
  }
  readonly network: {
    request(input: Readonly<Record<string, unknown>>): Promise<unknown>
  }
  readonly scheduler: {
    createJob(input: Readonly<Record<string, unknown>>): Promise<unknown>
  }
  readonly theme: {
    readAsset(input: Readonly<Record<string, unknown>>): Promise<unknown>
  }
}

export interface HookContext<TPayload = unknown> extends HostApi {
  readonly hookName: PluginHookName
  readonly traceId: string
  readonly operationId: string
  readonly payload: TPayload
  readonly items: Readonly<Record<string, unknown>>
  readonly hooks: {
    readonly current: PluginHookName
  }
  next<T = TPayload>(value?: T): HookResult<T>
  stop<T = null>(value?: T): HookResult<T>
}

export type HookHandler<TPayload = unknown, TResult = unknown> = (
  context: HookContext<TPayload>
) => HookResult<TResult> | TResult | void | Promise<HookResult<TResult> | TResult | void>

export interface PluginContext<TConfig extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>> {
  readonly hooks: {
    on<TPayload = unknown, TResult = unknown>(
      name: PluginHookName,
      handler: HookHandler<TPayload, TResult>
    ): void
  }
  readonly config: TConfig
}

export type ConfigOf<TSchema extends Readonly<Record<string, unknown>>> = Readonly<TSchema>

export interface PluginDefinition<TConfig extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>> {
  readonly id: string
  activate(context: PluginContext<TConfig>): void | Promise<void>
}

export function definePlugin<
  TConfig extends Readonly<Record<string, unknown>>,
  TPlugin extends PluginDefinition<TConfig>
>(plugin: TPlugin): TPlugin {
  return plugin
}
