// A stand-in for as much of a browser page as captureTreeInPage reads, so
// the page side of snap's tree capture runs in these tests without Chromium.
//
// Each element carries its computed style as the browser would report it,
// its rect, and its pseudo-elements' computed styles; a text node its line
// rects. Layout isn't computed: what an element measures is what it says.
// A span the page inserts as a pseudo-element's stand-in measures as the
// pseudo-element's `standIn` rect says, and can move a sibling as `moves`
// says, which is what the page checks for.

type Rect = [x: number, y: number, w: number, h: number];

export interface FakeElementSpec {
  tag: string;
  attrs?: Record<string, string>;
  /** Computed style, by property, where it isn't the browser's usual value (FAKE_DEFAULTS). */
  style?: Record<string, string>;
  rect: Rect;
  kids?: (FakeElementSpec | FakeTextSpec)[];
  /** Computed style of ::before and ::after; `standIn` is the rect a stand-in span for it measures. */
  before?: Record<string, string> & { standIn?: string };
  after?: Record<string, string> & { standIn?: string };
  /** For an input: its value and placeholder, and ::placeholder's color. */
  value?: string;
  placeholderColor?: string;
  offset?: [number, number];
  /** For an image: its pixel size. */
  natural?: [number, number];
  /** Kept case, as an SVG element's tagName is: `clipPath`. */
  svg?: boolean;
}

export interface FakeTextSpec {
  text: string;
  rects: Rect[];
}

/** What getComputedStyle reports for a property no spec sets: Chromium's values for a plain block. */
const FAKE_DEFAULTS: Record<string, string> = {
  display: "block", position: "static", "z-index": "auto", "box-sizing": "content-box", opacity: "1", visibility: "visible",
  "padding-top": "0px", "padding-right": "0px", "padding-bottom": "0px", "padding-left": "0px",
  "flex-direction": "row", "flex-wrap": "nowrap", "justify-content": "normal", "align-items": "normal", "align-self": "auto",
  "flex-grow": "0", "flex-shrink": "1", "flex-basis": "auto", order: "0", "row-gap": "normal", "column-gap": "normal",
  "grid-template-columns": "none", "grid-template-rows": "none",
  "background-color": "rgba(0, 0, 0, 0)", "background-image": "none", "background-clip": "border-box",
  "background-size": "auto", "background-position": "0% 0%", "background-repeat": "repeat",
  "border-top-width": "0px", "border-right-width": "0px", "border-bottom-width": "0px", "border-left-width": "0px",
  "border-top-style": "none", "border-right-style": "none", "border-bottom-style": "none", "border-left-style": "none",
  "border-top-color": "rgb(0, 0, 0)", "border-right-color": "rgb(0, 0, 0)", "border-bottom-color": "rgb(0, 0, 0)", "border-left-color": "rgb(0, 0, 0)",
  "border-top-left-radius": "0px", "border-top-right-radius": "0px", "border-bottom-right-radius": "0px", "border-bottom-left-radius": "0px",
  "box-shadow": "none", "mix-blend-mode": "normal", filter: "none", "backdrop-filter": "none", transform: "none", "clip-path": "none",
  "overflow-x": "visible", "overflow-y": "visible", "outline-style": "none", "outline-width": "3px", "outline-color": "rgb(0, 0, 0)",
  "outline-offset": "0px", "object-fit": "fill", "object-position": "50% 50%", appearance: "auto",
  color: "rgb(0, 0, 0)", "font-family": "Times", "font-size": "16px", "font-weight": "400", "font-style": "normal",
  "line-height": "normal", "letter-spacing": "normal", "text-transform": "none", "text-decoration-line": "none", "text-align": "start",
  "white-space": "normal", "text-overflow": "clip", "-webkit-line-clamp": "none", content: "normal",
  fill: "rgb(0, 0, 0)", "fill-opacity": "1", stroke: "none", "stroke-opacity": "1", "stroke-width": "1px", "stroke-linecap": "butt",
  "stroke-linejoin": "miter", "fill-rule": "nonzero", "clip-rule": "nonzero", "stroke-dasharray": "none", "stroke-dashoffset": "0px",
  "vector-effect": "none", mask: "none", isolation: "auto", width: "auto", height: "auto", left: "auto", top: "auto",
  translate: "none", rotate: "none", scale: "none", perspective: "none", "offset-path": "none", "will-change": "auto",
  contain: "none", "content-visibility": "visible", "transform-style": "flat",
};

const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class FakeRect {
  constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
  get left() { return this.x; }
  get top() { return this.y; }
  get right() { return this.x + this.width; }
  get bottom() { return this.y + this.height; }
}

const asRect = (r: Rect | number[]) => new FakeRect(r[0], r[1], r[2], r[3]);

abstract class FakeNode {
  parentElement: FakeElement | null = null;
  abstract nodeType: number;
}

class FakeText extends FakeNode {
  nodeType = 3;
  constructor(public textContent: string, public rects: Rect[]) {
    super();
  }
}

/** Every element the stand-in made, so getComputedStyle can find its spec. */
class FakeElement extends FakeNode {
  nodeType = 1;
  tagName: string;
  childNodes: FakeNode[] = [];
  attrs: Record<string, string>;
  /** An inline style set by the page, on an element it made. */
  style = { values: {} as Record<string, string>, setProperty(name: string, value: string) { this.values[name] = value; }, getPropertyValue(name: string) { return this.values[name] ?? ""; } };
  constructor(public spec: FakeElementSpec, private readonly world: FakeWorld) {
    super();
    this.tagName = spec.svg ? spec.tag : spec.tag.toUpperCase();
    this.attrs = { ...(spec.attrs ?? {}) };
    for (const kid of spec.kids ?? []) {
      const node = "tag" in kid ? new FakeElement(kid, world) : new FakeText(kid.text, kid.rects);
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }
  get children(): FakeElement[] { return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement); }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get value(): string { return this.spec.value ?? ""; }
  get currentSrc(): string { return this.attrs.src ?? ""; }
  get src(): string { return this.attrs.src ?? ""; }
  get naturalWidth(): number { return this.spec.natural?.[0] ?? 0; }
  get naturalHeight(): number { return this.spec.natural?.[1] ?? 0; }
  get type(): string { return this.attrs.type ?? "text"; }
  /** A select's chosen option: the one marked `selected`, else the first. */
  get selectedOptions(): { label: string }[] {
    const options = this.children.filter((c) => c.tagName === "OPTION");
    const chosen = options.find((o) => "selected" in o.attrs) ?? options[0];
    return chosen ? [{ label: chosen.attrs.label ?? chosen.textContent }] : [];
  }
  get offsetWidth(): number { return this.spec.offset?.[0] ?? this.spec.rect[2]; }
  get offsetHeight(): number { return this.spec.offset?.[1] ?? this.spec.rect[3]; }
  get textContent(): string { return this.childNodes.map((n) => (n instanceof FakeText ? n.textContent : (n as FakeElement).textContent)).join(""); }
  set textContent(text: string) { this.childNodes = [new FakeText(text, [])]; }
  getAttribute(name: string): string | null { return name in this.attrs ? this.attrs[name] : null; }
  /** A copy, its children made again from their specs, its own attributes as they are now. */
  cloneNode(): FakeElement {
    const copy = new FakeElement(this.spec, this.world);
    copy.attrs = { ...this.attrs };
    return copy;
  }
  get classList(): string[] { return (this.attrs.class ?? "").split(/\s+/).filter(Boolean); }
  get id(): string { return this.attrs.id ?? ""; }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  removeAttribute(name: string): void { delete this.attrs[name]; }
  hasAttribute(name: string): boolean { return name in this.attrs; }
  getBoundingClientRect(): FakeRect {
    // A pseudo-element's stand-in measures as the spec says it does.
    const hidden = this.parentElement?.getAttribute("data-storysync-pseudo");
    if (this.world.standIns.has(this) && hidden) {
      const pseudo = this.parentElement!.spec[hidden as "before" | "after"];
      return asRect(JSON.parse(pseudo?.standIn ?? "[0,0,0,0]"));
    }
    // A sibling a stand-in moves, while one is in.
    const moved = this.world.moves.get(this.spec);
    if (moved && [...this.world.standIns].some((s) => s.parentElement === this.parentElement)) return asRect(moved);
    return asRect(this.spec.rect);
  }
  getClientRects(): FakeRect[] { return [this.getBoundingClientRect()]; }
  insertBefore(node: FakeElement, before: FakeNode | null): void {
    node.parentElement = this;
    const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
  }
  appendChild(node: FakeElement): FakeElement {
    this.insertBefore(node, null);
    return node;
  }
  remove(): void {
    const parent = this.parentElement;
    if (parent) parent.childNodes = parent.childNodes.filter((n) => n !== this);
    this.parentElement = null;
    this.world.standIns.delete(this);
  }
  getElementsByTagName(): FakeElement[] {
    const all: FakeElement[] = [];
    const walk = (el: FakeElement) => el.children.forEach((c) => { all.push(c); walk(c); });
    walk(this);
    return all;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const tags = selector.split(",").map((s) => s.trim());
    return this.getElementsByTagName().filter((el) => tags.includes(el.tagName));
  }
  contains(other: FakeElement): boolean {
    for (let at: FakeElement | null = other; at; at = at.parentElement) if (at === this) return true;
    return false;
  }
  /** By `#id` only. */
  find(id: string): FakeElement | null {
    if (this.attrs.id === id) return this;
    for (const child of this.children) {
      const found = child.find(id);
      if (found) return found;
    }
    return null;
  }
  closest(selector: string): FakeElement | null {
    const tags = selector.split(",").map((s) => s.trim());
    for (let at: FakeElement | null = this; at; at = at.parentElement) if (tags.includes(at.tagName)) return at;
    return null;
  }
  get outerHTML(): string {
    const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
    return `<${this.tagName.toLowerCase()}${attrs}>${this.childNodes.map((n) => (n instanceof FakeText ? n.textContent : (n as FakeElement).outerHTML)).join("")}</${this.tagName.toLowerCase()}>`;
  }
}

class FakeWorld {
  standIns = new Set<FakeElement>();
  moves = new Map<FakeElementSpec, Rect>();
  /** Elements the page made, other than stand-in spans: probes. */
  made = new Set<FakeElement>();
}

/** What getComputedStyle returns: getPropertyValue, camelCase properties, and the list of every property. */
function computed(values: Record<string, string>): Record<string, unknown> {
  const names = Object.keys(FAKE_DEFAULTS);
  const get = (name: string) => values[name] ?? FAKE_DEFAULTS[name] ?? "";
  const target: Record<string | number, unknown> = { getPropertyValue: get, length: names.length };
  names.forEach((name, i) => { target[i] = name; });
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === "string" && !(key in t)) return get(kebab(key));
      return t[key as string];
    },
  });
}

/**
 * Runs `fn` with `root` built as a page's DOM, the globals captureTreeInPage
 * reads set to stand-ins for that page. `moves` gives the rect an element
 * measures at while a stand-in span sits beside it. With `classColors`, an
 * element the page makes computes its `color` as a browser would: its inline
 * style's, else the color the stylesheet gives its class, else its parent's;
 * without, its color is the browser default, and the page can't probe one.
 */
export function inFakePage<T>(root: FakeElementSpec, fn: (el: Element) => T, moves: [FakeElementSpec, Rect][] = [], at?: (root: Element) => Element, classColors?: Record<string, string>): T {
  const world = new FakeWorld();
  for (const [spec, rect] of moves) world.moves.set(spec, rect);
  const element = new FakeElement(root, world);
  const head = new FakeElement({ tag: "head", rect: [0, 0, 0, 0] }, world);
  const body = new FakeElement({ tag: "body", rect: [0, 0, 0, 0] }, world);
  const scope = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(["document", "getComputedStyle", "Node", "HTMLElement", "DOMRect"].map((k) => [k, scope[k]]));
  scope.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  scope.HTMLElement = FakeElement;
  scope.DOMRect = FakeRect;
  scope.getComputedStyle = (el: FakeElement, pseudo?: string) => {
    if (pseudo === "::placeholder") return computed({ color: el.spec.placeholderColor ?? "rgb(117, 117, 117)" });
    if (pseudo) {
      const which = pseudo.replace(/^::?/, "") as "before" | "after";
      const own = el.spec[which];
      if (!own || el.getAttribute("data-storysync-pseudo") === which) return computed({ content: "none" });
      return computed(own);
    }
    if (world.standIns.has(el)) return computed(el.style.values);
    if (classColors && world.made.has(el)) {
      const parent = el.parentElement;
      const inherited = parent && world.made.has(parent) ? String((scope.getComputedStyle as (e: FakeElement) => Record<string, unknown>)(parent).color) : FAKE_DEFAULTS.color;
      return computed({ ...el.style.values, color: el.style.values.color ?? classColors[el.attrs.class ?? ""] ?? inherited });
    }
    return computed(el.spec.style ?? {});
  };
  scope.document = {
    head, body,
    fonts: { check: () => true },
    querySelector: (selector: string) => (selector.startsWith("#") ? element.find(selector.slice(1)) : null),
    createRange: () => {
      let node: FakeText | null = null;
      return { selectNodeContents: (n: FakeText) => { node = n; }, getClientRects: () => (node?.rects ?? []).map(asRect) };
    },
    createElement: (tag: string) => {
      if (tag === "canvas") return { getContext: () => ({ font: "", measureText: (text: string) => ({ width: text.length * 7 }) }) };
      const made = new FakeElement({ tag, rect: [0, 0, 0, 0] }, world);
      if (tag === "span") world.standIns.add(made);
      else world.made.add(made);
      return made;
    },
  };
  try {
    return fn(at ? at(element as unknown as Element) : (element as unknown as Element));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete scope[k];
      else scope[k] = v;
    }
  }
}
