type Mark = { i?: number };

let index = 0;
let max = 0;

function mark(): Mark {
  return { i: index };
}

function readIndex() {
  const state = history.state as Mark | null;
  return typeof state?.i === "number" ? state.i : null;
}

export function bindHistory() {
  const current = readIndex();
  if (current === null) {
    history.replaceState(mark(), "");
    return;
  }
  index = current;
  if (index > max) max = index;
}

export function syncNav() {
  const current = readIndex();
  if (current !== null) index = current;
}

export function canBack() {
  return index > 0;
}

export function canForward() {
  return index < max;
}

export function pushNav(url: string) {
  index += 1;
  max = index;
  history.pushState(mark(), "", url);
  paintHistoryButtons();
}

export function replaceNav(url: string) {
  history.replaceState(mark(), "", url);
}

export function backNav() {
  if (canBack()) history.back();
}

export function forwardNav() {
  if (canForward()) history.forward();
}

export function paintHistoryButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-history]").forEach((button) => {
    button.disabled = button.dataset.history === "back" ? !canBack() : !canForward();
  });
}
