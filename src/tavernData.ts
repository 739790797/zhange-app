export const MAX_TAVERN_COMMENTS = 500;
export const MAX_TAVERN_BODY_CHARS = 1_000_000;
const MAX_COMMENT_BODY_LENGTH = 2_000;
const MAX_COMMENT_NAME_LENGTH = 128;
const MAX_COMMENT_DATE_LENGTH = 64;

export type TavernComment = {
  id: number;
  body: string;
  parent_id: number | null;
  created_at?: string;
  author?: { display_name?: string };
};

function positiveInteger(value: unknown): number | null {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && /^\d{1,16}$/.test(value)) parsed = Number(value);
  else return null;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function boundedText(value: unknown, maxLength: number) {
  return limitTavernText(value, maxLength);
}

export function limitTavernText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.slice(0, Math.max(0, maxLength)) : "";
}

export function boundTavernBody(value: unknown) {
  const body = typeof value === "string" ? value : "";
  return {
    text: body.slice(0, MAX_TAVERN_BODY_CHARS),
    truncated: body.length > MAX_TAVERN_BODY_CHARS,
  };
}

export function normalizeTavernComments(raw: unknown) {
  if (!Array.isArray(raw)) return { items: [] as TavernComment[], truncated: false };
  const source = raw.slice(0, MAX_TAVERN_COMMENTS);
  const seen = new Set<number>();
  const items: TavernComment[] = [];
  for (const value of source) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const id = positiveInteger(row.id);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    const parentId =
      row.parent_id == null || row.parent_id === 0 || row.parent_id === "0"
        ? null
        : positiveInteger(row.parent_id);
    const author =
      row.author && typeof row.author === "object" && !Array.isArray(row.author)
        ? (row.author as Record<string, unknown>)
        : null;
    const item: TavernComment = {
      id,
      body: boundedText(row.body, MAX_COMMENT_BODY_LENGTH),
      parent_id: parentId,
    };
    const createdAt = boundedText(row.created_at, MAX_COMMENT_DATE_LENGTH);
    const displayName = author ? boundedText(author.display_name, MAX_COMMENT_NAME_LENGTH) : "";
    if (createdAt) item.created_at = createdAt;
    if (displayName) item.author = { display_name: displayName };
    items.push(item);
  }
  return { items, truncated: raw.length > MAX_TAVERN_COMMENTS };
}

export function orderTavernComments(items: TavernComment[]) {
  const roots: TavernComment[] = [];
  const replies = new Map<number, TavernComment[]>();
  for (const item of items) {
    if (item.parent_id == null) {
      roots.push(item);
      continue;
    }
    const thread = replies.get(item.parent_id) || [];
    thread.push(item);
    replies.set(item.parent_id, thread);
  }
  const ordered: TavernComment[] = [];
  for (const root of roots) {
    ordered.push(root, ...(replies.get(root.id) || []));
  }
  return ordered;
}
