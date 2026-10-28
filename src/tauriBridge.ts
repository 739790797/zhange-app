import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error("请在战鸽助手窗口里操作");
  return tauriInvoke<T>(command, args);
}
