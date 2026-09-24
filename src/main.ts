import { invoke } from "@tauri-apps/api/core";

type AppConfig = {
  site: string;
  screenshotsDir: string | null;
  logsDir: string | null;
  gamma: number;
  brightness: number;
};

type DisplaySnapshot = {
  gamma: number;
  brightness: number;
  active: boolean;
};

const nav = [
  ["首页", "/app"],
  ["塔科夫", "/guides/tarkov"],
  ["日志与截图", "/guides/tarkov/game-logs"],
  ["个人中心", "/guides/tarkov/me"],
];

const statusEl = document.querySelector<HTMLElement>("#status");
const siteLabel = document.querySelector<HTMLElement>("#site-label");
const siteInput = document.querySelector<HTMLInputElement>("#site-input");
const gammaInput = document.querySelector<HTMLInputElement>("#gamma");
const brightnessInput = document.querySelector<HTMLInputElement>("#brightness");
const readout = document.querySelector<HTMLElement>("#display-readout");
const shotsPath = document.querySelector<HTMLElement>("#shots-path");
const logsPath = document.querySelector<HTMLElement>("#logs-path");

function setStatus(text: string) {
  if (statusEl) statusEl.textContent = text;
}

function showConfig(cfg: AppConfig) {
  if (siteLabel) siteLabel.textContent = cfg.site;
  if (siteInput) siteInput.value = cfg.site;
  if (gammaInput) gammaInput.value = String(cfg.gamma);
  if (brightnessInput) brightnessInput.value = String(cfg.brightness);
  if (shotsPath) shotsPath.textContent = `截图：${cfg.screenshotsDir || "未绑定"}`;
  if (logsPath) logsPath.textContent = `日志：${cfg.logsDir || "未绑定"}`;
  showDisplay({ gamma: cfg.gamma, brightness: cfg.brightness, active: false });
}

function showDisplay(snapshot: DisplaySnapshot) {
  if (readout) {
    readout.textContent = `伽马 ${snapshot.gamma.toFixed(2)} · 明暗 ${snapshot.brightness.toFixed(2)}${snapshot.active ? " · 已套用" : ""}`;
  }
}

async function refresh() {
  const cfg = await invoke<AppConfig>("get_config");
  showConfig(cfg);
  const snapshot = await invoke<DisplaySnapshot>("display_get");
  if (gammaInput) gammaInput.value = String(snapshot.gamma);
  if (brightnessInput) brightnessInput.value = String(snapshot.brightness);
  showDisplay(snapshot);
}

document.querySelector("#nav")?.append(
  ...nav.map(([label, path]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      void invoke("navigate", { path }).catch((err: unknown) => setStatus(String(err)));
    });
    return button;
  }),
);

document.querySelector("#site-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void invoke<AppConfig>("set_site", { site: siteInput?.value ?? "" })
    .then((cfg) => {
      showConfig(cfg);
      setStatus("已保存站点");
    })
    .catch((err: unknown) => setStatus(String(err)));
});

document.querySelector("#apply")?.addEventListener("click", () => {
  void invoke<DisplaySnapshot>("display_apply", {
    gamma: Number(gammaInput?.value),
    brightness: Number(brightnessInput?.value),
  })
    .then((snapshot) => {
      showDisplay(snapshot);
      setStatus("");
    })
    .catch((err: unknown) => setStatus(String(err)));
});

document.querySelector("#restore")?.addEventListener("click", () => {
  void invoke<DisplaySnapshot>("display_restore")
    .then((snapshot) => {
      showDisplay(snapshot);
      setStatus("");
    })
    .catch((err: unknown) => setStatus(String(err)));
});

for (const [id, kind] of [
  ["#bind-shots", "screenshots"],
  ["#bind-logs", "logs"],
] as const) {
  document.querySelector(id)?.addEventListener("click", () => {
    void invoke("tarkov_rebind", { kind })
      .then(() => refresh())
      .catch((err: unknown) => setStatus(String(err)));
  });
}

void refresh().catch((err: unknown) => setStatus(String(err)));
