export const enum AotActionId {
  None = 0,
  ForceJson = 1,
  ForceBinary = 2,
  OpenArticle = 3,
  PageNext = 4,
  PagePrev = 5
}

export function toAotActionId(action: string): AotActionId {
  switch (action) {
    case 'force-json':
      return AotActionId.ForceJson;
    case 'force-binary':
      return AotActionId.ForceBinary;
    case 'open-article':
      return AotActionId.OpenArticle;
    case 'page-next':
      return AotActionId.PageNext;
    case 'page-prev':
      return AotActionId.PagePrev;
    default:
      return AotActionId.None;
  }
}
