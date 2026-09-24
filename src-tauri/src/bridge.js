(() => {
  const shotsPath = __SCREENSHOTS__;
  const logsPath = __LOGS__;
  const callbacks = { screenshots: new Set(), logs: new Set() };
  let listening = false;

  function tauriInvoke(cmd, args) {
    const api = window.__TAURI__ && window.__TAURI__.core;
    if (!api || typeof api.invoke !== "function") {
      return Promise.reject(new Error("当前站点不能使用本机能力"));
    }
    return api.invoke(cmd, args || {});
  }

  function bytesFromBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function ensureListen() {
    if (listening) return;
    const events = window.__TAURI__ && window.__TAURI__.event;
    if (!events || typeof events.listen !== "function") return;
    listening = true;
    events.listen("tarkov-changed", (event) => {
      const set = callbacks[event.payload];
      if (!set) return;
      set.forEach((cb) => cb());
    });
  }

  function bound(kind, path) {
    if (!path) return undefined;
    return {
      path,
      list(relativeDir) {
        return tauriInvoke("tarkov_list", { kind, relativeDir: relativeDir || "" });
      },
      readBytes(relativePath) {
        return tauriInvoke("tarkov_read_bytes", { kind, relativePath }).then(bytesFromBase64);
      },
      readText(relativePath) {
        return tauriInvoke("tarkov_read_text", { kind, relativePath });
      },
      remove(relativePaths) {
        return tauriInvoke("tarkov_remove", { kind, relativePaths });
      },
      watch(onChange) {
        ensureListen();
        callbacks[kind].add(onChange);
        return () => callbacks[kind].delete(onChange);
      },
    };
  }

  const files = {
    screenshots: bound("screenshots", shotsPath),
    logs: bound("logs", logsPath),
    rebindScreenshots() {
      return tauriInvoke("tarkov_rebind", { kind: "screenshots" }).then((path) => {
        window.__zhangeSetDir("screenshots", path);
      });
    },
    rebindLogs() {
      return tauriInvoke("tarkov_rebind", { kind: "logs" }).then((path) => {
        window.__zhangeSetDir("logs", path);
      });
    },
  };

  window.__zhangeSetDir = (kind, path) => {
    const next = bound(kind, path);
    if (kind === "screenshots") files.screenshots = next;
    if (kind === "logs") files.logs = next;
  };

  window.zhangeAssistant = {
    embed: true,
    tarkovFiles: files,
    display: {
      get: () => tauriInvoke("display_get"),
      apply: (preset) =>
        tauriInvoke("display_apply", {
          gamma: preset.gamma,
          brightness: preset.brightness,
        }),
      restore: () => tauriInvoke("display_restore"),
    },
  };
})();
