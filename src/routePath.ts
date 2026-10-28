export const TAVERN_BASE = "/主菜单/战鸽酒馆";

export function decodePathname(pathname: string) {
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

export function tavernMatch(
  pathname: string,
): { kind: "list" } | { kind: "article"; slug: string } | null {
  const decoded = decodePathname(pathname);
  if (decoded === TAVERN_BASE) return { kind: "list" };
  if (!decoded.startsWith(`${TAVERN_BASE}/`)) return null;
  const slug = decoded.slice(TAVERN_BASE.length + 1).split("/")[0];
  return slug ? { kind: "article", slug } : { kind: "list" };
}
