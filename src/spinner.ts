function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

export function isPending(text: string) {
  return text.startsWith("正在读取") || text.startsWith("正在加载");
}

export function spin(label = "正在读取", compact = false) {
  return `<div class="spin-host${compact ? " is-compact" : ""}" role="status" aria-busy="true" aria-label="${esc(label)}"><i class="spin${compact ? " is-sm" : ""}"></i></div>`;
}
