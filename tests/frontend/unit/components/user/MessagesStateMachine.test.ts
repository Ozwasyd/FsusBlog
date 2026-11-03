// @vitest-environment happy-dom

import { ElBadge, ElButton, ElOption, ElSelect, ElSkeleton, ElTag } from '@ozwasyd/element-plus'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { describe, expect, it } from 'vitest'
import type {
  ConversationDetailResponse,
  ConversationListItemResponse,
  ConversationMessageResponse
} from '@/api/message'
import MessagesComposePanel from '@/components/user/messages/MessagesComposePanel.vue'
import MessagesConversationList from '@/components/user/messages/MessagesConversationList.vue'
import MessagesThreadPanel from '@/components/user/messages/MessagesThreadPanel.vue'

const ElButtonStub = defineComponent({
  inheritAttrs: false,
  props: {
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false }
  },
  emits: ['click'],
  template: '<button v-bind="$attrs" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>'
})

const ElInputStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    type: { type: String, default: 'text' }
  },
  emits: ['update:modelValue'],
  template: '<textarea v-bind="$attrs" :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />'
})

const PassthroughStub = defineComponent({
  template: '<div><slot /></div>'
})

const EmptyStateStub = defineComponent({
  props: {
    title: { type: String, required: true },
    description: { type: String, required: true }
  },
  template: '<section data-empty-state><h3>{{ title }}</h3><p>{{ description }}</p><slot name="action" /></section>'
})

const globalStubs = {
  ElBadge: PassthroughStub,
  ElButton: ElButtonStub,
  ElDivider: PassthroughStub,
  ElForm: PassthroughStub,
  ElFormItem: PassthroughStub,
  ElInput: ElInputStub,
  ElOption: PassthroughStub,
  ElSelect: PassthroughStub,
  ElSkeleton: defineComponent({ template: '<div data-skeleton />' }),
  ElTag: PassthroughStub,
  MessagesEmptyState: EmptyStateStub
}

const conversation: ConversationListItemResponse = {
  conversationId: 'conversation-17',
  subject: '部署后首页异常',
  status: 0,
  isSystemSource: false,
  canReply: true,
  unreadCount: 2,
  lastMessageAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
  lastMessage: {
    senderType: 0,
    senderName: '读者',
    bodyPreview: '首页加载后出现空白。',
    createdAt: '2026-07-16T00:00:00.000Z'
  }
}

const message: ConversationMessageResponse = {
  messageId: 'message-19',
  conversationId: conversation.conversationId,
  senderType: 0,
  senderName: '读者',
  body: '首页加载后出现空白。',
  createdAt: '2026-07-16T00:00:00.000Z'
}

const detail: ConversationDetailResponse = {
  conversationId: conversation.conversationId,
  readSnapshotMessageId: message.messageId,
  subject: conversation.subject,
  status: conversation.status,
  isSystemSource: false,
  canReply: true,
  unreadCount: 2,
  lastMessageAt: conversation.lastMessageAt,
  messages: [message]
}

const statusLabel = (status: number): string => ['待处理', '跟进中', '已关闭'][status] ?? '未知'
const statusType = (status: number): 'warning' | 'success' | '' => status === 2 ? 'success' : 'warning'

describe('message center component state machines', () => {
  it('moves the conversation list through loading, empty, and selected success states', async () => {
    const wrapper = mount(MessagesConversationList, {
      props: {
        mode: 'account',
        isMobile: false,
        loading: true,
        filter: 'all',
        rows: [],
        hiddenCount: 0,
        hasMore: false,
        loadingMore: false,
        selectedConversationId: '',
        statusLabel,
        statusType,
        conversationRowClass: () => []
      },
      global: { stubs: globalStubs }
    })

    expect(wrapper.get('[data-skeleton]').exists()).toBe(true)

    await wrapper.setProps({ loading: false })
    expect(wrapper.get('[data-empty-state]').text()).toContain('暂无站内信')
    await wrapper.get('[data-empty-state] button').trigger('click')
    expect(wrapper.emitted('createTicket')).toHaveLength(1)

    await wrapper.setProps({
      rows: [{
        ...conversation,
        lastMessageAtText: '今天',
        ariaLabel: '部署后首页异常，2 条未读'
      }],
      selectedConversationId: conversation.conversationId
    })
    const selected = wrapper.get('.messages-conversation-item')
    expect(selected.attributes('aria-current')).toBe('true')
    expect(selected.attributes('aria-label')).toBe('部署后首页异常，2 条未读')
    await selected.trigger('click')
    expect(wrapper.emitted('select')).toEqual([[conversation.conversationId]])
  })

  it('emits one account ticket contract from the mobile compose branch', async () => {
    const wrapper = mount(MessagesComposePanel, {
      props: {
        mode: 'account',
        mobile: true,
        loading: false,
        createSubject: '',
        createBody: ''
      },
      global: { stubs: globalStubs }
    })

    await wrapper.get('[name="ticketSubjectMobile"]').setValue('无法读取文章')
    await wrapper.get('[name="ticketBodyMobile"]').setValue('文章详情返回空状态。')
    await wrapper.get('button').trigger('click')

    expect(wrapper.emitted('update:createSubject')).toEqual([['无法读取文章']])
    expect(wrapper.emitted('update:createBody')).toEqual([['文章详情返回空状态。']])
    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.find('[name="systemTargetAccountIdMobile"]').exists()).toBe(false)
  })

  it('gates replies and exposes mobile back plus admin status actions without real writes', async () => {
    const wrapper = mount(MessagesThreadPanel, {
      props: {
        mode: 'admin',
        isMobile: true,
        loading: false,
        processing: false,
        detail,
        selectionEmpty: false,
        rows: [{
          ...message,
          createdAtText: '今天',
          senderText: '读者',
          bubbleClassName: 'messages-bubble-account',
          motionClass: ''
        }],
        hiddenCount: 0,
        replyBody: '',
        replyLoading: false,
        replyDisabled: false,
        contextAccountText: '读者',
        statusLabel,
        statusType
      },
      global: { stubs: globalStubs }
    })

    expect(wrapper.attributes('aria-busy')).toBe('false')
    expect(wrapper.get('.messages-bubble-body').text()).toBe(message.body)
    expect(wrapper.get('.messages-reply-form button').attributes()).toHaveProperty('disabled')

    await wrapper.get('[aria-controls="messages-list-title"]').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)

    const statusButtons = wrapper.findAll('.messages-actions button')
    await statusButtons[1]!.trigger('click')
    expect(wrapper.emitted('updateStatus')).toEqual([['pending']])

    await wrapper.setProps({ replyBody: '已收到，正在处理。' })
    expect(wrapper.get('.messages-reply-form button').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('.messages-reply-form button').trigger('click')
    expect(wrapper.emitted('reply')).toHaveLength(1)
  })
})

const publicButtonConversation = {
    conversationId: '9007199254740993',
    subject: '部署后的站内信会话',
    status: 0,
    isSystemSource: false,
    canReply: true,
    unreadCount: 2,
    lastMessageAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
    lastMessageAtText: '今天',
    ariaLabel: '部署后的站内信会话，2 条未读',
    lastMessage: {
        senderType: 0,
        senderName: '读者',
        bodyPreview: '请检查部署后的消息列表。',
        createdAt: '2026-10-17T00:00:00.000Z'
    }
} satisfies ConversationListItemResponse & { lastMessageAtText: string; ariaLabel: string; };

function mountPublicButtonList(mode: 'account' | 'admin')
{
    return mount(MessagesConversationList, {
        props: {
            mode,
            isMobile: false,
            loading: false,
            filter: 'all',
            rows: [publicButtonConversation],
            hiddenCount: 0,
            hasMore: false,
            loadingMore: false,
            selectedConversationId: '',
            statusLabel: () => '待处理',
            statusType: () => 'warning',
            conversationRowClass: () => []
        },
        global: {
            components: { ElBadge, ElButton, ElOption, ElSelect, ElSkeleton, ElTag }
        }
    });
}

describe('conversation row public Button integration', () =>
{
    it.each(['account', 'admin'] as const)('delegates one %s selection through the real public Button', async (mode: 'account' | 'admin') =>
    {
        const wrapper = mountPublicButtonList(mode);
        try
        {
            const row = wrapper.get('.messages-conversation-item');
            const button = wrapper.findAllComponents(ElButton).find((candidate) => candidate.element === row.element);

            expect(button).toBeDefined();
            expect(button?.props('text')).toBe(true);
            expect(row.element.tagName).toBe('BUTTON');
            expect(row.attributes('type')).toBe('button');
            expect(row.attributes('aria-label')).toBe(publicButtonConversation.ariaLabel);
            expect(row.findAll('button')).toHaveLength(0);
            expect(row.text()).toContain(publicButtonConversation.subject);
            expect(row.text()).toContain(publicButtonConversation.lastMessage.bodyPreview);
            expect(row.text()).toContain('待处理');
            expect(row.get('time').attributes('datetime')).toBe(publicButtonConversation.lastMessageAt);
            expect(row.get('time').text()).toBe(publicButtonConversation.lastMessageAtText);

            await row.trigger('click');

            expect(wrapper.emitted('select')).toEqual([[publicButtonConversation.conversationId]]);
            expect(wrapper.emitted('createTicket')).toBeUndefined();
            expect(wrapper.emitted('loadMore')).toBeUndefined();

            await wrapper.setProps({
                selectedConversationId: publicButtonConversation.conversationId,
                conversationRowClass: () => ['active']
            });

            expect(row.attributes('aria-current')).toBe('true');
            expect(row.classes()).toContain('active');
            expect(wrapper.emitted('select')).toEqual([[publicButtonConversation.conversationId]]);

            await wrapper.setProps({
                rows: [{ ...publicButtonConversation, subject: '更新后的会话', unreadCount: 3, lastMessageAtText: '刚刚' }]
            });

            expect(row.text()).toContain('更新后的会话');
            expect(row.get('time').text()).toBe('刚刚');
            expect(wrapper.emitted('select')).toHaveLength(1);
        }
        finally
        {
            wrapper.unmount();
        }
    });
});
