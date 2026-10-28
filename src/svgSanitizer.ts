const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
export const MAX_MAP_SVG_SOURCE_CHARS = 8 * 1024 * 1024;
export const MAX_MAP_SVG_NODES = 50_000;
export const MAX_MAP_SVG_DEPTH = 128;
const MAX_ATTRIBUTE_LENGTH = 256_000;

export function assertMapSvgBudget(nodeCount: number, depth: number) {
  if (nodeCount > MAX_MAP_SVG_NODES || depth > MAX_MAP_SVG_DEPTH) {
    throw new Error("地图 SVG 内容过于复杂");
  }
}

const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "symbol",
  "use",
  "marker",
  "style",
]);

const ATTRIBUTES = new Set([
  "id",
  "class",
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "preserveaspectratio",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "display",
  "visibility",
  "vector-effect",
  "clip-path",
  "clip-rule",
  "mask",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "spreadmethod",
  "patternunits",
  "patterntransform",
  "clippathunits",
  "maskunits",
  "maskcontentunits",
  "markerwidth",
  "markerheight",
  "markerunits",
  "orient",
  "refx",
  "refy",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "data-keep-with-group",
  "href",
  "style",
]);

const STYLE_PROPERTIES = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "display",
  "visibility",
  "vector-effect",
  "clip-path",
  "clip-rule",
  "mask",
  "stop-color",
  "stop-opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
]);

const CSS_VALUE_ATTRIBUTES = new Set(["fill", "stroke", "clip-path", "mask", "stop-color"]);

function safeCssValue(raw: string) {
  const value = raw.trim();
  if (
    !value ||
    /[{}<>]/.test(value) ||
    /[\\\u0000-\u001f]/.test(value) ||
    value.includes("/*") ||
    /expression|javascript:|vbscript:|@import|behavior|-moz-binding/i.test(value)
  )
    return "";
  let unsafeUrl = false;
  const sanitized = value.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    (_match, double: string, single: string, bare: string) => {
      const target = String(double ?? single ?? bare ?? "").trim();
      if (/^#[A-Za-z_][\w:.-]*$/.test(target)) return `url(${target})`;
      unsafeUrl = true;
      return "";
    },
  );
  const withoutSafeLocalUrls = sanitized.replace(/url\(#[A-Za-z_][\w:.-]*\)/gi, "");
  return unsafeUrl || /url\s*\(/i.test(withoutSafeLocalUrls) ? "" : sanitized;
}

function safeDeclarations(style: CSSStyleDeclaration) {
  const declarations: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index).toLowerCase();
    if (!STYLE_PROPERTIES.has(property) || style.getPropertyPriority(property)) continue;
    const value = safeCssValue(style.getPropertyValue(property));
    if (value) declarations.push(`${property}:${value}`);
  }
  return declarations.join(";");
}

function sanitizeStyleAttribute(raw: string) {
  const node = document.createElementNS(SVG_NS, "svg");
  node.setAttribute("style", raw);
  return safeDeclarations(node.style);
}

function safeSelector(raw: string) {
  return /^[-_a-zA-Z0-9.#\s>+~,*]+$/.test(raw.trim());
}

function scopeSelector(selector: string) {
  const trimmed = selector.trim();
  if (/^svg(?:$|[\s>.+#,:])/i.test(trimmed)) return `.zhange-map-svg${trimmed.slice(3)}`;
  return `.zhange-map-svg ${trimmed},.zhange-map-svg${trimmed}`;
}

function sanitizeStylesheet(raw: string) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(raw);
    const rules: string[] = [];
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const selectors = rule.selectorText.split(",").map((selector) => selector.trim());
      if (!selectors.length || selectors.some((selector) => !safeSelector(selector))) continue;
      const declarations = safeDeclarations(rule.style);
      if (!declarations) continue;
      rules.push(`${selectors.map(scopeSelector).join(",")}{${declarations}}`);
    }
    return rules.join("\n");
  } catch {
    return "";
  }
}

function safeHref(raw: string) {
  const value = raw.trim();
  return /^#[A-Za-z_][\w:.-]*$/.test(value) ? value : "";
}

function assertSvgTreeBudget(root: Node) {
  const owner = root.ownerDocument;
  if (!owner) throw new Error("地图 SVG 内容无效");
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_ALL);
  let nodeCount = 1;
  assertMapSvgBudget(nodeCount, 0);
  while (walker.nextNode()) {
    nodeCount += 1;
    let depth = 0;
    let current: Node | null = walker.currentNode;
    while (current && current !== root) {
      depth += 1;
      current = current.parentNode;
    }
    assertMapSvgBudget(nodeCount, depth);
  }
}

function cloneSafe(
  node: Node,
  textAllowed: boolean,
  depth: number,
  budget: { nodes: number },
): Node | null {
  budget.nodes += 1;
  assertMapSvgBudget(budget.nodes, depth);
  if (node.nodeType === Node.TEXT_NODE) {
    return textAllowed ? document.createTextNode(node.textContent || "") : null;
  }
  if (!(node instanceof Element)) return null;
  if (node.namespaceURI && node.namespaceURI !== SVG_NS) return null;
  const name = node.localName;
  if (!ELEMENTS.has(name)) return null;
  if (name === "style") {
    const css = sanitizeStylesheet(node.textContent || "");
    if (!css) return null;
    const style = document.createElementNS(SVG_NS, "style");
    style.textContent = css;
    return style;
  }

  const clean = document.createElementNS(SVG_NS, name);
  for (const attribute of Array.from(node.attributes)) {
    const localName = attribute.localName.toLowerCase();
    if (attribute.namespaceURI && attribute.namespaceURI !== XLINK_NS) continue;
    if (!ATTRIBUTES.has(localName) || attribute.value.length > MAX_ATTRIBUTE_LENGTH) continue;
    let value = attribute.value;
    if (localName === "href") {
      value = safeHref(value);
      if (!value || name !== "use") continue;
    } else if (localName === "style") {
      value = sanitizeStyleAttribute(value);
      if (!value) continue;
    } else if (CSS_VALUE_ATTRIBUTES.has(localName)) {
      value = safeCssValue(value);
      if (!value) continue;
    }
    clean.setAttribute(attribute.name === "xlink:href" ? "href" : attribute.name, value);
  }
  if (name === "svg") clean.classList.add("zhange-map-svg");
  for (const child of Array.from(node.childNodes)) {
    const copy = cloneSafe(child, name === "text" || name === "tspan", depth + 1, budget);
    if (copy) clean.appendChild(copy);
  }
  return clean;
}

export function sanitizeMapSvg(source: string) {
  if (source.length > MAX_MAP_SVG_SOURCE_CHARS) throw new Error("地图 SVG 文件过大");
  const documentNode = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = documentNode.documentElement;
  if (root.localName.toLowerCase() !== "svg" || documentNode.querySelector("parsererror")) {
    throw new Error("地图 SVG 格式无效");
  }
  assertSvgTreeBudget(root);
  const clean = cloneSafe(root, false, 0, { nodes: 0 });
  if (!(clean instanceof SVGSVGElement)) throw new Error("地图 SVG 内容无效");
  return clean;
}
