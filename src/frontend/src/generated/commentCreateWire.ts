// Generated from src/shared/Contracts/Validation/aeds-protocol.json. Run npm run generate:aeds-protocol from src/frontend.
export const COMMENT_CREATE_POD_BYTES = 73;
export const COMMENT_CREATE_OFFSETS = Object.freeze({
  "articleId": 0,
  "hasParentId": 4,
  "hasRootId": 5,
  "hasReplyToCommentId": 6,
  "authorMode": 7,
  "publicSendExplicitlySelected": 8,
  "parentId": 9,
  "rootId": 17,
  "replyToCommentId": 25,
  "anonymousScope": 33,
  "displayLanguage": 41,
  "proofToken": 49,
  "zkProof": 57,
  "content": 65
} as const);
export interface CommentCreateDto
{
    clientMutationId?: string;
    articleId: number;
    content: string;
    parentId?: string | null;
    rootId?: string | null;
    replyToCommentId?: string | null;
    authorMode: 'public';
    publicSendExplicitlySelected: boolean;
    displayLanguage: 'zh-CN' | 'en';
    powSalt?: string;
    powSignature?: string;
    powTimestamp?: number;
    difficulty?: number;
    powNonce?: string;
    browserFp?: string;
}
