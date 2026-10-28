import { invoke } from "./tauriBridge";
import { fadeIn, fadeOut } from "./motion";
import { noteTaskSynced, reloadTaskProgress } from "./taskFlow";
import { reloadMapTaskProgress } from "./mapTasks";
import {
  cloneTaskProgress,
  readTaskProgress,
  serializeTaskProgress,
  taskProgressPath,
  withTaskGameMode,
  type TaskGameMode,
} from "./taskProgressQueue";
import {
  currentTaskProgressAccountEpoch,
  taskProgressAccountEpochIsCurrent,
} from "./taskProgressQueue";
import { commitLogSyncProgress, indexLogSyncCatalog } from "./logSyncProgress";

type Session = { folder: string; startedAt: string };
type Bundle = { folder: string; files: { name: string; text: string }[] };
type Kind = "started" | "failed" | "completed";
type QuestEvent = { kind: Kind; at: string; taskId: string; sessionMode: string };
type Folded = { kind: Kind; at: string; everCompleted: boolean };

const WIPE_START = "2025-11-15 17:00:00";
const MODE_RE = /Session mode:\s*([^\s|]+)/i;
const KIND_BY_TYPE: Record<number, Kind> = { 10: "started", 11: "failed", 12: "completed" };

let preset: "all" | "wipe" | "7d" | "30d" = "all";
let busy = false;
let cancel = false;

function note(text: string) {
  const node = document.querySelector("#path-note");
  if (node) node.textContent = text;
}

function gameMode(): TaskGameMode {
  return localStorage.getItem("zhange.guides.tarkov.gameMode") === "pve" ? "pve" : "pvp";
}

function modeKind(raw: string) {
  const key = raw.trim().toLowerCase();
  if (key === "pve") return "pve";
  if (key === "pvp" || key === "regular") return "pvp";
  return "";
}

function dayStart(daysAgo: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 00:00:00`;
}

function inRange(startedAt: string, selectedRange = preset) {
  if (!startedAt || selectedRange === "all") return true;
  const from =
    selectedRange === "wipe" ? WIPE_START : selectedRange === "7d" ? dayStart(7) : dayStart(30);
  return startedAt >= from;
}

function taskId(raw: string) {
  const token = raw.trim().split(/\s+/)[0] || "";
  return /^[a-fA-F0-9]{20,32}$/.test(token) ? token.toLowerCase() : "";
}

function extractJson(block: string) {
  const start = block.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let index = start; index < block.length; index += 1) {
    const ch = block[index];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return block.slice(start, index + 1);
    }
  }
  return "";
}

function parseQuests(
  text: string,
  inheritedMode = "",
  selectedMode = gameMode(),
): { events: QuestEvent[]; sessionMode: string } {
  const source = text.replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const events: QuestEvent[] = [];
  let offset = 0;
  let sessionMode = inheritedMode;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    const mode = MODE_RE.exec(line);
    if (mode) {
      sessionMode = mode[1].trim();
      continue;
    }
    if (!line.includes("Got notification | ChatMessageReceived")) continue;
    const next = source.slice(lineStart + 1).search(/\n\d{4}-\d{2}-\d{2} /);
    const block = source.slice(lineStart, next < 0 ? source.length : lineStart + 1 + next);
    const json = extractJson(block);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as { message?: Record<string, unknown> };
      const message = parsed.message || (parsed as Record<string, unknown>);
      const type = Number(message.type ?? message.Type ?? message.status ?? message.Status);
      const kind = KIND_BY_TYPE[type];
      const id = taskId(
        String(
          message.templateId || message.TemplateId || message.questId || message.QuestId || "",
        ),
      );
      const at = /^\d{4}-\d{2}-\d{2}/.exec(line)?.[0] ? line.slice(0, 19) : "";
      if (kind && id) events.push({ kind, at, taskId: id, sessionMode });
    } catch {
      /* 截断的通知块跳过 */
    }
  }
  return {
    events: events.filter((event) => modeKind(event.sessionMode) === selectedMode),
    sessionMode,
  };
}

function fold(events: QuestEvent[]) {
  const next = new Map<string, Folded>();
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  for (const event of ordered) {
    const existing = next.get(event.taskId);
    if (existing && existing.at > event.at) {
      if (event.kind === "completed") next.set(event.taskId, { ...existing, everCompleted: true });
      continue;
    }
    next.set(event.taskId, {
      kind: event.kind,
      at: event.at,
      everCompleted: event.kind === "completed" || Boolean(existing?.everCompleted),
    });
  }
  return next;
}

function stopForCancelOrAccountChange(accountEpoch: number) {
  if (taskProgressAccountEpochIsCurrent(accountEpoch) && cancel) {
    note("已取消，未提交变更。");
    return true;
  }
  return !taskProgressAccountEpochIsCurrent(accountEpoch);
}

export function logSyncBusy() {
  return busy;
}

export function cancelLogSyncForAccountChange() {
  if (busy) cancel = true;
}

export function openLogSync() {
  const box = document.querySelector<HTMLElement>("#log-sync-box");
  if (!box) return;
  fadeIn(box);
  note("本机解析日志，只把任务状态回填到账号，不会上传原文。");
}

export function closeLogSync() {
  const box = document.querySelector<HTMLElement>("#log-sync-box");
  if (box) void fadeOut(box);
}

export function pickLogSyncRange(next: string) {
  if (next === "wipe" || next === "7d" || next === "30d" || next === "all") preset = next;
  document.querySelectorAll<HTMLButtonElement>("[data-sync]").forEach((button) => {
    button.classList.toggle("on", button.dataset.sync === preset);
  });
}

export async function runLogSync() {
  if (busy) {
    cancel = true;
    note("正在取消…");
    return;
  }
  busy = true;
  cancel = false;
  const accountEpoch = currentTaskProgressAccountEpoch();
  const isCurrent = () => !cancel && taskProgressAccountEpochIsCurrent(accountEpoch);
  const selectedMode = gameMode();
  const selectedRange = preset;
  const button = document.querySelector("#log-sync");
  if (button) button.textContent = "取消同步";
  try {
    const sessions = (await invoke<Session[]>("logs_list")).filter((item) =>
      inRange(item.startedAt, selectedRange),
    );
    if (stopForCancelOrAccountChange(accountEpoch)) return;
    if (!sessions.length) {
      note("这个范围内没有启动记录。");
      return;
    }
    const catalogResponse = await invoke<unknown>("site_get", {
      path: withTaskGameMode("/guides/tarkov/tasks?layout=all", selectedMode),
    });
    if (stopForCancelOrAccountChange(accountEpoch)) return;
    const catalog = indexLogSyncCatalog(catalogResponse);
    if (!catalog) {
      throw new Error("无法读取任务目录，日志同步已停止；请检查网络后重试。");
    }
    const { names, prereq, mutex } = catalog;
    const baseProgress = await serializeTaskProgress(async () => {
      if (!isCurrent()) return null;
      const progress = await invoke<Record<string, unknown>>("site_get", {
        path: taskProgressPath(selectedMode),
      });
      if (!isCurrent()) return null;
      return readTaskProgress(progress);
    });
    if (stopForCancelOrAccountChange(accountEpoch) || !baseProgress) return;
    const proposed = cloneTaskProgress(baseProgress);
    const events: QuestEvent[] = [];
    const oldest = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (let index = 0; index < oldest.length; index += 4) {
      if (stopForCancelOrAccountChange(accountEpoch)) return;
      note(`正在解析 ${Math.min(index + 4, oldest.length)} / ${oldest.length}`);
      const chunk = oldest.slice(index, index + 4).map((item) => item.folder);
      const bundles = await invoke<Bundle[]>("logs_read", { folders: chunk });
      if (stopForCancelOrAccountChange(accountEpoch)) return;
      for (const bundle of bundles) {
        let sessionMode = "";
        for (const file of bundle.files) {
          const parsed = parseQuests(file.text, sessionMode, selectedMode);
          sessionMode = parsed.sessionMode || sessionMode;
          events.push(...parsed.events);
        }
      }
    }
    if (stopForCancelOrAccountChange(accountEpoch)) return;
    const folded = fold(events);
    const markDone = (id: string, seen = new Set<string>()) => {
      if (!id || !names.has(id) || seen.has(id)) return;
      seen.add(id);
      proposed.done.add(id);
      proposed.started.delete(id);
      proposed.failed.delete(id);
      for (const other of mutex.get(id) || []) {
        if (names.has(other) && !proposed.done.has(other)) {
          proposed.failed.add(other);
          proposed.started.delete(other);
        }
      }
      for (const parent of prereq.get(id) || []) markDone(parent, seen);
    };
    for (const [id, state] of folded) {
      if (!names.has(id)) continue;
      if (state.everCompleted) markDone(id);
      else if (state.kind === "failed") {
        proposed.failed.add(id);
        proposed.started.delete(id);
      } else {
        if (!proposed.done.has(id)) proposed.started.add(id);
        proposed.failed.delete(id);
      }
    }
    for (const id of new Set([...proposed.done, ...proposed.started, ...proposed.failed])) {
      if (proposed.done.has(id)) {
        proposed.started.delete(id);
        proposed.failed.delete(id);
      } else if (proposed.failed.has(id)) {
        proposed.started.delete(id);
      }
    }
    const result = await commitLogSyncProgress(baseProgress, proposed, {
      isCurrent,
      readLatest: () =>
        invoke<Record<string, unknown>>("site_get", { path: taskProgressPath(selectedMode) }),
      writeProgress: (body) => invoke("site_put", { path: taskProgressPath(selectedMode), body }),
    });
    if (!taskProgressAccountEpochIsCurrent(accountEpoch)) return;
    if (cancel || result.cancelled) {
      note(
        result.wrote
          ? "取消请求到达前，同步请求已提交；未标记为完整同步。"
          : "已取消，未提交变更。",
      );
      if (result.wrote) {
        await Promise.all([reloadTaskProgress(selectedMode), reloadMapTaskProgress(selectedMode)]);
      }
      return;
    }
    const sign = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
    note(
      `已解析 ${String(oldest.length)} 段日志，任务事件 ${events.length} 条。完成 ${sign(result.progress.done.size - result.latest.done.size)}，进行中 ${sign(result.progress.started.size - result.latest.started.size)}，失败 ${sign(result.progress.failed.size - result.latest.failed.size)}。`,
    );
    noteTaskSynced(selectedMode);
    closeLogSync();
    await Promise.all([reloadTaskProgress(selectedMode), reloadMapTaskProgress(selectedMode)]);
  } catch (error) {
    if (taskProgressAccountEpochIsCurrent(accountEpoch)) {
      note(error instanceof Error ? error.message : "同步日志失败");
    }
  } finally {
    busy = false;
    cancel = false;
    if (button) button.textContent = "历史任务同步";
  }
}
