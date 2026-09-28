const DURATION = 200;
const pending = new WeakMap<HTMLElement, Promise<void>>();

function reduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function fadeIn(node: HTMLElement) {
  const visible = !node.hidden && node.classList.contains("is-fade-in") && !node.classList.contains("is-fade-out");
  node.hidden = false;
  node.classList.remove("is-fade-out");
  pending.delete(node);
  if (visible || reduced()) return;
  if (node.classList.contains("is-fade-in")) {
    node.classList.remove("is-fade-in");
    void node.offsetWidth;
  }
  node.classList.add("is-fade-in");
}

export function fadeOut(node: HTMLElement): Promise<void> {
  const running = pending.get(node);
  if (running) return running;
  if (node.hidden) return Promise.resolve();
  if (reduced()) {
    node.hidden = true;
    node.classList.remove("is-fade-in", "is-fade-out");
    return Promise.resolve();
  }
  const job = new Promise<void>((resolve) => {
    const finish = () => {
      node.removeEventListener("animationend", onEnd);
      if (!node.classList.contains("is-fade-out")) {
        pending.delete(node);
        resolve();
        return;
      }
      pending.delete(node);
      node.hidden = true;
      node.classList.remove("is-fade-out");
      resolve();
    };
    const onEnd = (event: AnimationEvent) => {
      if (event.target !== node || event.animationName !== "app-motion-out") return;
      finish();
    };
    node.classList.remove("is-fade-in");
    node.classList.add("is-fade-out");
    node.addEventListener("animationend", onEnd);
    window.setTimeout(finish, DURATION + 60);
  });
  pending.set(node, job);
  return job;
}
