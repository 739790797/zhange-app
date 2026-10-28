import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  assertMapSvgBudget,
  MAX_MAP_SVG_DEPTH,
  MAX_MAP_SVG_NODES,
  sanitizeMapSvg,
} from "../src/svgSanitizer.ts";

const browser = new Window();
for (const name of [
  "CSSStyleRule",
  "CSSStyleSheet",
  "DOMParser",
  "Element",
  "Node",
  "NodeFilter",
  "SVGSVGElement",
]) {
  globalThis[name] = browser[name];
}
globalThis.document = browser.document;

test("accepts SVG trees within the node and depth budgets", () => {
  assert.equal(assertMapSvgBudget(MAX_MAP_SVG_NODES, MAX_MAP_SVG_DEPTH), undefined);
});

test("rejects SVG trees that exceed the node or depth budget", () => {
  assert.throws(() => assertMapSvgBudget(MAX_MAP_SVG_NODES + 1, 0), /内容过于复杂/);
  assert.throws(() => assertMapSvgBudget(1, MAX_MAP_SVG_DEPTH + 1), /内容过于复杂/);
});

test("removes executable elements, event attributes, and external references", () => {
  const svg = sanitizeMapSvg(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
      <script>alert(1)</script>
      <foreignObject><div>not svg</div></foreignObject>
      <use href="https://attacker.test/icon.svg#symbol" />
      <path onload="alert(1)" d="M0 0" fill="url(https://attacker.test/payload.svg#x)" />
      <path id="local-shape" d="M1 1" fill="url(#local-shape)" />
    </svg>
  `);

  assert.equal(svg.localName, "svg");
  assert.equal(svg.classList.contains("zhange-map-svg"), true);
  assert.equal(svg.querySelector("script, foreignObject"), null);
  assert.equal(svg.querySelector("use")?.hasAttribute("href"), false);
  assert.equal(svg.querySelector("[onload]"), null);
  assert.equal(svg.querySelectorAll("path").length, 2);
  assert.equal(svg.querySelectorAll("path")[0].hasAttribute("fill"), false);
  assert.equal(svg.querySelectorAll("path")[1].getAttribute("fill"), "url(#local-shape)");
});

test("scopes safe stylesheet rules and drops external CSS URLs", () => {
  const svg = sanitizeMapSvg(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
      <style>svg path { fill: url(#shape); stroke: red } path:hover { fill: url(https://attacker.test/a.svg#x) }</style>
      <path id="shape" d="M0 0" />
    </svg>
  `);
  const stylesheet = svg.querySelector("style")?.textContent || "";

  assert.match(stylesheet, /\.zhange-map-svg path\{fill:url\(#shape\);stroke:red\}/);
  assert.doesNotMatch(stylesheet, /attacker\.test|:hover/);
});
