import { invoke } from "./tauriBridge";

let owned = new Set<string>();
let ready = false;

export function ownedKeyIds() {
  return owned;
}

export function ownedKeyIdsReady() {
  return ready;
}

export function setOwnedKeyIds(ids: Iterable<string>, loaded = true) {
  owned = new Set(ids);
  ready = loaded;
}

export async function loadOwnedKeyIds(): Promise<Set<string> | null> {
  try {
    const data = await invoke<{ item_ids?: string[] }>("site_get", {
      path: "/guides/tarkov/key-owns",
    });
    setOwnedKeyIds(data.item_ids || []);
    return owned;
  } catch {
    return ready ? owned : null;
  }
}
