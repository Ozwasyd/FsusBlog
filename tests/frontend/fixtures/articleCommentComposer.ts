import { createApp, defineComponent, h, reactive, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import '@/assets/main.css'
import ArticleCommentComposer from '@/components/article/ArticleCommentComposer.vue'
import type { CommentAuthorMode } from '@/api/comment'
import type { CommentPrivacyUiState } from '@/privacy/commentPrivacyTypes'
import { createCommentPublicDraftStorageKey, prepareCommentPublicDraftStorage, writeCommentPublicDraft } from '@/privacy/commentPublicDraftStorage'

type Submission = { content: string; authorMode: CommentAuthorMode; confirmed: boolean; mutationId: string }
type ComposerProps = InstanceType<typeof ArticleCommentComposer>['$props']

declare global {
    interface Window {
        articleCommentComposerFixture: {
            submissions: Submission[]
            update: (props: Partial<ComposerProps>) => void
            newSession: () => void
        }
    }
}

const params = new URL(window.location.href).searchParams
const draftPolicy = params.get('draft')
const restoringDraft = draftPolicy === 'matching' || draftPolicy === 'changed'
const props = reactive({
    modelValue: params.has('privateBody') ? '当前私密正文' : '',
    isLoggedIn: true,
    isBanned: false,
    isPowCalculating: false,
    isSubmitting: false,
    redirectPath: '/articles/42',
    replyTarget: null,
    authorMode: (params.get('priorIdentity') === 'public' ? 'public' : 'zk_anonymous') as CommentAuthorMode,
    publicSendConfirmed: params.get('priorIdentity') === 'public',
    anonymousCommentsEnabled: true,
    publicCommentsEnabled: true,
    zkAnonymousEnabled: true,
    articleId: restoringDraft ? 42 : null,
    accountId: restoringDraft ? 7 : null,
    commentMaxChars: 1000,
    commentMaxUtf8Bytes: 4096,
    policySnapshotHash: 'policy-42',
    privacyState: 'ready' as CommentPrivacyUiState,
    displayLanguage: 'zh-CN' as const,
    anonymousScope: 'article:42'
})
if (restoringDraft) {
    const preparation = prepareCommentPublicDraftStorage(localStorage)
    if (!preparation.scopeId) throw new Error('fixture draft storage unavailable')
    const key = createCommentPublicDraftStorageKey({ scopeId: preparation.scopeId, articleId: 42, replyId: null })
    if (!writeCommentPublicDraft(localStorage, key, {
        version: 3,
        content: '待审公开草稿',
        savedAt: Date.now(),
        policyHash: draftPolicy === 'matching' ? 'policy-42' : 'policy-old',
        clientMutationId: '018ff003-1234-7abc-8def-0123456789ab'
    })) throw new Error('fixture draft seed failed')
}
const generation = ref(0)
const submissions: Submission[] = []
window.articleCommentComposerFixture = {
    submissions,
    update: update => Object.assign(props, update),
    newSession: () => {
        props.modelValue = ''
        props.authorMode = 'zk_anonymous'
        props.publicSendConfirmed = false
        generation.value += 1
    }
}

document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }, { path: '/login', component: { render: () => null } }]
})
await router.push('/')
await router.isReady()

const app = createApp(defineComponent({
    setup: () => () => h(ArticleCommentComposer, {
        ...props,
        key: generation.value,
        'onUpdate:modelValue': (content: string) => { props.modelValue = content },
        'onUpdate:authorMode': (mode: CommentAuthorMode) => { props.authorMode = mode },
        'onUpdate:publicSendConfirmed': (confirmed: boolean) => { props.publicSendConfirmed = confirmed },
        onSubmit: (mutationId: string) => submissions.push({
            content: props.modelValue,
            authorMode: props.authorMode,
            confirmed: props.publicSendConfirmed,
            mutationId
        })
    })
}))
app.use(router)
app.mount('#article-comment-composer-fixture')
document.documentElement.dataset.commentComposerFixtureReady = 'true'
