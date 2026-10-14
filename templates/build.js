// storysync build template (tpl 2): builds and restyles component sets from
// snap's element trees, one page per call.
//
// `storysync figma code` writes every call as `const DATA = {...};`, then
// this file, minified, as the string T, and the agent sends the file
// unchanged. The call checks DATA's checksum, SUM, and this file's, TSUM,
// before it runs T as the body of an async function (cli/checksum.ts,
// callCode): a call changed on its way from the file is refused before
// anything changes. T returns `tc`, 1 where the call checked TSUM, which
// the call says by TC. Nothing here is specific to a component: everything
// is in DATA, which emit computes from snap's facts (cli/figma-code.ts), so
// this file sets plain Figma properties and decides nothing about CSS.
//
// DATA = { page, S, sets }
//   S     the call's table of strings and styles; records refer to it by index.
//   sets  [{ id, title, name, props, base, v, cv?, pin?, od?, end?, rm? }], each
//         one part of a set:
//         id, title   the component's Storybook id and title, kept on the set
//                     as shared plugin data, by which it is found again;
//         name        the set's name; props, its variantProperties for the grid;
//         base        records of the part's first variant;
//         v           [[name, slug, i, src, digest, delta]], the part's variants:
//                     src 1 measured, 0 a placeholder for one snap couldn't
//                     measure; delta [[index, [x, y, w, h] | 0, style | -1]]
//                     against base, or { r: records } in full, or a part of
//                     a variant too big for one call, { r, p: [part, of],
//                     o: its first record's index in the variant, h: its
//                     hash, e: the hashes of the parts before it, c: their
//                     calls };
//         cv          1 where the user said to make the plain component an
//                     earlier push built the first variant of this set;
//         pin         { prop: value } snap pins each prop it left out to;
//         od          { prop: value } the default the last push built each
//                     prop dropped since with;
//         end         1 on the set's last part; rm, 1 there where the user
//                     said to remove the variants no property names now.
//   A record is [key, parent, kind, x, y, w, h, style]: key and style index
//   S, parent indexes the records, kind is F, T, V or I. x and y are relative
//   to the parent's frame; w and h are the frame's size. A style is
//   cli/figma-map.ts's FigmaStyle.
//
// It returns { kind: 'build', tpl: 2, page, sets, uploads, fonts, unbound,
// fallbacks, omitted? }: per set what changed (section 8.2), or `refused`,
// the question for the user that left it as it was, and `stashed`, the
// parts it built and kept for a later call; the image layers to upload_assets, font
// stand-ins, variable names that didn't bind, spike fallbacks taken, and
// how many list entries were left out to keep the response under
// use_figma's 20kb.
//
// Each variant is converged: its layers are matched to records by the key in
// their shared plugin data `k`, restyled in place (so node ids, and the
// overrides of instances, survive), created where missing, and removed where
// snap no longer measures them. An icon whose shapes differ from how the
// build left them is imported again. Layers without a key are a designer's:
// left alone and counted. Running a call twice changes nothing the second
// time.
//
// Branches marked SPIKE(n) guard what spike item n (cli/figma-spike.ts)
// didn't try: each takes the design's choice, which the spike saw Figma
// take, and falls back should Figma refuse it.

const NS = 'storysync';
const NL = String.fromCharCode(10);
const S = DATA.S;
const get = (n, k) => n.getSharedPluginData(NS, k);
const put = (n, k, v) => n.setSharedPluginData(NS, k, v);
const pageKey = (name) => name.toLowerCase().replace(/[ /_-]+/g, '');
let page = figma.root.children.find((p) => pageKey(p.name) === pageKey(DATA.page));
if (!page) {
  page = figma.createPage();
  page.name = DATA.page;
}
await figma.setCurrentPageAsync(page);

// A text style's font: the measured family, by Figma's name for it first,
// the style's `g` (Geist for fontsource's Geist Variable), else its stand-in,
// the style's `a` (Roboto Mono for a mono family, Noto Serif for a serif:
// cli/fonts.ts, which snap measures with too), else Inter; at the measured
// weight, else the next toward Regular, in either spelling; italic where the
// family has it. It never throws, and FONTS, returned, names each stand-in.
const STYLES = ['Thin', 'Extra Light', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black'];
const FONTS = {};
const fonts = {};
const loadFont = (t) => {
  const { f: family, w: weight, i: italic } = t;
  const id = family + weight + (italic ? 'i' : '');
  return (fonts[id] = fonts[id] || (async () => {
    const i = Math.min(8, Math.max(0, Math.round((weight || 400) / 100) - 1));
    const d = Math.sign(3 - i);
    for (const f of new Set([t.g, family, t.a, 'Inter'])) {
      if (f) for (const j of new Set([i, i + d, i + 2 * d, 3].filter((j) => (j - 3) * d <= 0))) {
        for (const s of new Set([STYLES[j], STYLES[j].replace(' ', '')])) {
          for (const style of italic ? [j === 3 ? 'Italic' : s + ' Italic', s] : [s]) {
            try {
              await figma.loadFontAsync({ family: f, style });
              if ((f !== family && f !== t.g) || j !== i || (italic && !/Italic/.test(style))) FONTS[family + ' ' + weight + (italic ? ' italic' : '')] = f + ' ' + style;
              return { family: f, style };
            } catch (e) {}
          }
        }
      }
    }
  })());
};

// Variables by name. A name no local variable has, or several have, leaves
// the value as measured and is listed in `unbound`.
const VARS = {};
for (const v of await figma.variables.getLocalVariablesAsync()) (VARS[v.resolvedType + v.name] = VARS[v.resolvedType + v.name] || []).push(v);
let collections = null;
const unbound = [];
// Where Figma refused what the design asked for and the build fell back
// (SPIKE(n)), or set a text wider than measured (keepLines): [component,
// key, what, variants], once per component, key and what, however many
// variants it happened in.
const fallbacks = [];
const seen = {};
// The texts keepLines set wider than measured, which checkLayout leaves so.
const widened = new Set();
let at = [];
const fallback = (what, e) => {
  const entry = [at[0], at[2] || '', what + ': ' + String((e && e.message) || e).slice(0, 80), 0];
  const id = entry.join(NL);
  (seen[id] = seen[id] || fallbacks[fallbacks.push(entry) - 1])[3]++;
};
const variable = async (type, name, property) => {
  let list = VARS[type + name] || [];
  if (list.length > 1 && type === 'FLOAT') {
    // A radius named like a spacing step: take the one in a radius collection.
    collections = collections || Object.fromEntries((await figma.variables.getLocalVariableCollectionsAsync()).map((c) => [c.id, c.name]));
    const radii = list.filter((v) => /radi|round|corner/i.test(collections[v.variableCollectionId] || ''));
    if (radii.length === 1) list = radii;
  }
  if (list.length === 1) return list[0];
  const entry = [at[0], at[2] || '', property, name + (list.length ? ': ' + list.length + ' variables have this name' : ': no variable has this name')];
  if (!unbound.some((u) => u.join() === entry.join())) unbound.push(entry);
  return null;
};

const rgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });
const rgba = (hex) => Object.assign(rgb(hex), { a: hex.length > 7 ? parseInt(hex.slice(7, 9), 16) / 255 : 1 });
// The color variable a paint or shadow binds to. Figma resolves a bound
// paint again at every explicit mode switch, and gives it its variable's
// alpha as its opacity, a shadow its variable's alpha (probe 7b). So a
// translucent paint of an opaque token names the token's alpha variable,
// `destructive 10%`, which carries the alpha in each mode, and the token
// too (cli/figma-map.ts). Where the file has no such variable, as a plan
// sent without its first call, a paint binds the token at its own
// opacity, as builds before this did, which a mode switch resets to 1, and
// a shadow is left unbound, at its own alpha: each said in `fallbacks`.
const colorVariable = async (name, token, property, shadow) => {
  if (!token) return name ? variable('COLOR', name, property) : null;
  const list = VARS['COLOR' + name] || [];
  if (list.length === 1) return list[0];
  fallback((list.length ? list.length + ' alpha variables named ' : 'no alpha variable ') + name, shadow ? 'shadow unbound' : 'bound to ' + token + ' at its opacity');
  return shadow ? null : variable('COLOR', token, property);
};
// The paints bound to a token in place of their missing alpha variable,
// whose opacity is put back.
const fellBack = new Set();
// A paint from a style's: '#rrggbb', [hex, opacity, variable?, token?], or a gradient.
const paint = async (p, property) => {
  if (p.g) {
    return { type: 'GRADIENT_LINEAR', gradientTransform: [p.g.slice(0, 3), p.g.slice(3, 6)], gradientStops: p.s.map(([position, hex]) => ({ position, color: rgba(hex) })) };
  }
  const [hex, opacity, name, token] = typeof p === 'string' ? [p, 1] : p;
  const out = { type: 'SOLID', color: rgb(hex), opacity };
  const v = await colorVariable(name, token, property);
  if (!v) return out;
  const bound = figma.variables.setBoundVariableForPaint(out, 'color', v);
  if (token && v.name !== name) fellBack.add(bound);
  return bound;
};
// Sets fills or strokes. A paint bound to the variable it was bound to
// before keeps the color and opacity it is assigned, the light theme's as
// measured, where its node is in Dark mode too; one freshly bound takes its
// variable's color and alpha in the mode its node is in (probe 7c, call
// 3). So the paints are cleared first, and each binds afresh: Figma gives
// each the value a mode switch would. Only a paint bound to a token in
// place of its missing alpha variable is assigned once more, bound as it
// now is, with its own opacity put back, which it keeps.
const setPaints = async (n, key, list, property) => {
  const paints = [];
  for (const p of list) paints.push(await paint(p, property));
  if (paints.some((p) => p.boundVariables)) n[key] = [];
  n[key] = paints;
  if (paints.some((p) => fellBack.has(p))) n[key] = n[key].map((p, i) => (fellBack.has(paints[i]) ? Object.assign({}, p, { opacity: paints[i].opacity }) : p));
};
// An effect from a style's: a blur, or a shadow, its color bound where it
// names a variable (e[7]), the alpha variable of the token e[8] where it
// is translucent, from which a freshly bound shadow takes its color and
// alpha, as a paint does.
const effect = async (e) => {
  if (e.length === 2) return { type: e[0] === 'L' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', radius: e[1], visible: true };
  const out = Object.assign({ type: e[0] === 'I' ? 'INNER_SHADOW' : 'DROP_SHADOW', color: Object.assign(rgb(e[5]), { a: e[6] }), offset: { x: e[1], y: e[2] }, radius: e[3], spread: e[4], visible: true, blendMode: 'NORMAL' }, e[0] === 'D' ? { showShadowBehindNode: false } : {});
  const v = await colorVariable(e[7], e[8], 'effect', true);
  return v ? figma.variables.setBoundVariableForEffect(out, 'color', v) : out;
};

// Images already on the page, by asset id: reused rather than uploaded again.
const HASHES = {};
for (const n of page.findAllWithCriteria({ sharedPluginData: { namespace: NS, keys: ['img'] } })) {
  const fill = 'fills' in n && n.fills !== figma.mixed && n.fills.find((p) => p.type === 'IMAGE' && p.imageHash);
  if (fill) HASHES[get(n, 'img')] = fill.imageHash;
}
const uploads = [];
const asked = {};
const image = (n, id) => {
  const fill = n.fills.find((p) => p.type === 'IMAGE' && p.imageHash);
  if (get(n, 'img') === id && fill) return;
  put(n, 'img', id);
  if (HASHES[id]) {
    n.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: HASHES[id] }];
  } else {
    n.fills = [];
    if (!asked[id]) uploads.push([n.id, id]);
    asked[id] = 1;
  }
};

// Imports a vector at the size emit chose: its measured size, since Figma
// scales the strokes with it, or its viewBox's with a rescale. The import's
// frame comes with a fill of its own, which an icon doesn't have. SPIKE(1):
// an import Figma refuses leaves an empty, keyed frame, which verify scores
// as the wrong shapes.
const vector = (st) => {
  try {
    const n = figma.createNodeFromSvg(S[st.m]);
    n.fills = [];
    if (st.rs) n.rescale(st.rs);
    return n;
  } catch (e) {
    fallback('svg import failed', e);
    const n = figma.createFrame();
    n.fills = [];
    n.name = 'svg (import failed)';
    // Not the asset's id, so the next call tries the import again.
    put(n, 'svg', 'failed');
    return n;
  }
};
const make = (kind, st) => {
  if (kind === 'T') return figma.createText();
  if (kind === 'V') return vector(st);
  const n = figma.createFrame();
  n.fills = [];
  return n;
};
// Loads the fonts texts have now, their own or their ranges', as
// figma-use's text recipe does, each once a call. Figma refuses to restyle
// a text whose font isn't loaded, or to move a layer that holds one, a
// designer's text included.
const loaded = {};
const loadFonts = async (texts) => {
  for (const n of texts) {
    for (const f of n.fontName === figma.mixed ? n.getStyledTextSegments(['fontName']).map((s) => s.fontName) : [n.fontName]) {
      const id = f.family + NL + f.style;
      await (loaded[id] = loaded[id] || figma.loadFontAsync(f).catch(() => {}));
    }
  }
};
const textsIn = (n) => (n.type === 'TEXT' ? [n] : n.findAllWithCriteria({ types: ['TEXT'] }));
// An icon's shapes as the build left them: each one's paints and stroke
// weight, kept on the icon as `ink`. The build sets shapes only by importing
// them, so an icon a designer recolored, or whose shapes they changed, no
// longer fits, and is imported again rather than kept as it is.
const ink = (n) => (n.type === 'FRAME' ? n.findAll((c) => 'fills' in c) : n.children.filter((c) => get(c, 'vs')).flatMap((c) => [c].concat('findAll' in c ? c.findAll(() => true) : [])).filter((c) => 'fills' in c))
  .map((c) => [c.fills, c.strokes].map((l) => (l === figma.mixed ? '?' : l.map((p) => (p.visible === false ? '-' : '') + (p.color ? hexOf(p.color) + (p.opacity == null ? 1 : p.opacity) : p.type)).join())).join('/') + '/' + String(c.strokeWeight))
  .join(';');
const inked = (n) => !get(n, 'ink') || get(n, 'ink') === ink(n);
const fits = (n, kind, st) => (kind === 'T' ? n.type === 'TEXT' : n.type === 'FRAME' && (kind === 'V' ? get(n, 'svg') === st.id && inked(n) : !get(n, 'svg')));
const isFrame = (n) => n.type === 'FRAME' || n.type === 'COMPONENT';
const SIZING = { X: 'FIXED', H: 'HUG', L: 'FILL' };
// A text's size first, then textAutoResize, then truncation: Figma turns
// truncation off and clears maxLines on any write of textAutoResize, HEIGHT
// over HEIGHT too, and resize() turns a hugging text NONE (the live text
// probe, 2026-10-09). Set the other way round, every truncated label of the
// third live push came out DISABLED and wrapped.
const setLines = (n, t, w, h) => {
  if (t.ar === 'W') n.textAutoResize = 'WIDTH_AND_HEIGHT';
  else {
    n.resize(w, h);
    n.textAutoResize = t.v ? 'NONE' : 'HEIGHT';
  }
  n.textTruncation = t.tr ? 'ENDING' : 'DISABLED';
  n.maxLines = t.tr || null;
};

// Styles one node from its record. Parents come before their children, so a
// child's auto layout parent is set up before the child fills it.
const style = async (n, rec, parent, root) => {
  const [, , kind, x, y, w, h, si] = rec;
  const st = S[si];
  let sizing = st.z || ['X', 'X'];
  if (st.n && !root && get(n, 'svg') !== 'failed') n.name = st.n;
  // Clipping first, should a spread take only where a frame clips (SPIKE(2)).
  if (kind !== 'T') n.clipsContent = Boolean(st.c);
  n.visible = st.v !== 0;
  n.opacity = st.o === undefined ? 1 : st.o;
  n.blendMode = st.b || (isFrame(n) && kind !== 'T' ? 'PASS_THROUGH' : 'NORMAL');
  const fx = [];
  for (const e of st.e || []) fx.push(await effect(e));
  // Cleared first, as paints are, so each bound shadow takes its
  // variable's value in the mode the node is in.
  if (fx.some((f) => f.boundVariables)) n.effects = [];
  try {
    n.effects = fx;
  } catch (e) {
    // SPIKE(2): a spread Figma refuses on this node is left out. The spike
    // saw a frame keep one, clipped or not; it tried no other kind of node.
    if (!fx.some((f) => f.spread)) throw e;
    n.effects = fx.map((f) => Object.assign({}, f, { spread: 0 }));
    fallback('shadow spread left out', e);
  }
  if (kind === 'T') {
    const t = st.t;
    const font = await loadFont(t);
    await loadFonts([n]);
    n.fontName = font;
    n.characters = t.c;
    if (get(n, 'br')) put(n, 'br', '');
    n.fontSize = t.z;
    n.lineHeight = t.l ? { unit: 'PIXELS', value: t.l } : { unit: 'AUTO' };
    n.letterSpacing = { unit: 'PIXELS', value: t.s || 0 };
    n.textCase = t.tc || 'ORIGINAL';
    n.textDecoration = t.td || 'NONE';
    n.textAlignHorizontal = t.ta || 'LEFT';
    // A control's value (`v`): at its box's middle, or top.
    n.textAlignVertical = t.v === 'C' ? 'CENTER' : 'TOP';
    if (t.b && !t.tr) balance(n, t, w);
    await setPaints(n, 'fills', st.f || [], 'color');
    try {
      setLines(n, t, w, h);
    } catch (e) {
      // SPIKE(3): truncation Figma refuses is built as a box of the measured
      // size. The spike saw ENDING and maxLines taken on a fixed width.
      if (!t.tr) throw e;
      fallback('truncation refused', e);
      n.resize(w, h);
      n.textAutoResize = 'NONE';
      sizing = [sizing[0] === 'L' ? 'L' : 'X', 'X'];
    }
  } else if (kind === 'V') {
    if (Math.abs(n.width - w) > 0.01 || Math.abs(n.height - h) > 0.01) n.resize(w, h);
    if (st.vb) {
      // A translucent shape's paint binds to its alpha variable, by its
      // color and opacity as the import drew them, `#rrggbb@0.5`.
      const at = (p) => hexOf(p.color) + '@' + Math.round(p.opacity * 100) / 100;
      for (const shape of n.findAll((c) => 'fills' in c)) {
        for (const key of ['fills', 'strokes']) {
          const list = shape[key];
          if (list === figma.mixed || !list.every((p) => p.type === 'SOLID') || !list.some((p) => st.vb[hexOf(p.color)])) continue;
          await setPaints(shape, key, list.map((p) => (st.vb[at(p)] ? [hexOf(p.color), p.opacity, st.vb[at(p)], st.vb[hexOf(p.color)]] : [hexOf(p.color), p.opacity, st.vb[hexOf(p.color)]])), 'vector');
        }
      }
    }
    put(n, 'ink', ink(n));
  } else {
    if (st.im) image(n, st.im);
    else {
      // No longer an image: the images call must not fill it.
      if (get(n, 'img')) put(n, 'img', '');
      await setPaints(n, 'fills', st.f || [], 'fill');
      // A fill that draws nothing, for a ring (`rc`, figma-code spreadDrawn).
      if (/f/.test(st.rc || '')) n.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, blendMode: 'MULTIPLY' }];
    }
    if (st.rc || get(n, 'rc')) put(n, 'rc', st.rc || '');
    const s = st.s;
    if (s) {
      await setPaints(n, 'strokes', [s.p], 'stroke');
      if (Array.isArray(s.w)) [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight] = s.w;
      else n.strokeWeight = s.w;
      n.strokeAlign = s.o ? 'OUTSIDE' : 'INSIDE';
      n.dashPattern = s.d || [];
    } else {
      n.strokes = [];
    }
    // A corner bound before, by the variant this one was copied from or an
    // earlier build, and no longer bound by the style, is unbound first: a
    // mode switch resolves a bound corner again, to its variable's radius.
    const corners = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
    if (!st.rv) for (const corner of corners) if (n.boundVariables[corner]) n.setBoundVariable(corner, null);
    if (Array.isArray(st.r)) [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius] = st.r;
    else n.cornerRadius = st.r || 0;
    if (st.rv) {
      const v = await variable('FLOAT', st.rv, 'radius');
      if (v) for (const corner of corners) n.setBoundVariable(corner, v);
    }
    const L = st.L;
    // Figma sets it only on auto layout (probe 8a): a frame copied from one
    // with it, built without, clears it first.
    if (!L && n.layoutMode !== 'NONE' && n.strokesIncludedInLayout) n.strokesIncludedInLayout = false;
    n.layoutMode = L ? (L.m === 'H' ? 'HORIZONTAL' : 'VERTICAL') : 'NONE';
    if (L) n.strokesIncludedInLayout = Boolean(L.i);
    if (L) {
      [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft] = L.p;
      n.itemSpacing = L.g;
      n.primaryAxisAlignItems = L.pa;
      n.counterAxisAlignItems = L.ca;
    }
    n.resize(w, h);
    if (L) {
      const [hh, hv] = L.h;
      n.primaryAxisSizingMode = (L.m === 'H' ? hh : hv) ? 'AUTO' : 'FIXED';
      n.counterAxisSizingMode = (L.m === 'H' ? hv : hh) ? 'AUTO' : 'FIXED';
    }
  }
  if (root) return;
  const auto = parent.layoutMode !== 'NONE';
  if (auto) n.layoutPositioning = st.a ? 'ABSOLUTE' : 'AUTO';
  // A turn (`rt`, Figma's rotation), before the place: Figma turns a layer
  // about its top left corner, which x and y put where emit computed, or
  // auto layout puts where its turned box starts, the box its unturned one
  // would take, turned 180 degrees or 90 when square.
  if ((st.rt || 0) !== n.rotation) n.rotation = st.rt || 0;
  if (auto && !st.a) {
    n.layoutSizingHorizontal = SIZING[sizing[0]];
    n.layoutSizingVertical = SIZING[sizing[1]];
  } else {
    n.x = x;
    n.y = y;
  }
};
const hexOf = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

// Matches a variant's layers to its records by key, creates what is
// missing, removes keyed layers snap no longer measures, puts each parent's
// keyed children in record order after its designer layers, and styles every
// node. Returns the nodes by record index, and the designer layers counted.
// A part of a variant (section: parts) builds its own records, from `pre`:
// those before it are its earlier parts', found by their keys, `miss` said
// where one is gone. Only the last part (`last`) removes what no record
// keys, puts every layer in its order and counts a designer's.
const converge = async (root, recs, pre, last, miss) => {
  // Every font the variant's texts have now, before anything moves.
  await loadFonts(textsIn(root));
  const have = new Map();
  const walk = (n) => {
    for (const c of n.children) {
      const k = get(c, 'k');
      if (!k) continue;
      if (have.has(k)) c.remove();
      else {
        have.set(k, c);
        if (c.type === 'FRAME' && !get(c, 'svg')) walk(c);
      }
    }
  };
  const [, , rootKind, , , , , rootStyle] = recs[0];
  at[2] = '';
  if (rootKind === 'V') {
    // A component whose root is an icon holds the icon's shapes itself,
    // marked so the next icon replaces them and nothing a designer added.
    // It has no keyed layers: any are from when its root was a frame.
    for (const c of root.children) if (get(c, 'k')) c.remove();
    if (get(root, 'svg') !== S[rootStyle].id || !inked(root)) {
      for (const c of root.children) if (get(c, 'vs')) c.remove();
      const icon = vector(S[rootStyle]);
      for (const c of [...icon.children]) {
        put(c, 'vs', '1');
        root.appendChild(c);
      }
      // A failed import is tried again next time, as for any icon.
      put(root, 'svg', get(icon, 'svg') === 'failed' ? 'failed' : S[rootStyle].id);
      icon.remove();
    }
  } else {
    // No longer an icon: its shapes go with it.
    if (get(root, 'svg')) {
      for (const c of root.children) if (get(c, 'vs')) c.remove();
      put(root, 'svg', '');
    }
    walk(root);
  }
  // And every font they will have.
  for (const rec of recs.slice(pre)) if (rec[2] === 'T') await loadFont(S[rec[7]].t);
  const nodes = [root];
  for (let i = 1; i < recs.length; i++) {
    const [ki, , kind, , , , , si] = recs[i];
    const k = S[ki];
    at[2] = k;
    let n = have.get(k);
    have.delete(k);
    if (i < pre) {
      if (!n) throw new Error(miss);
      nodes[i] = n;
      continue;
    }
    if (n && !fits(n, kind, S[si])) {
      n.remove();
      n = null;
    }
    if (!n) {
      n = make(kind, S[si]);
      put(n, 'k', k);
      if (kind === 'V' && get(n, 'svg') !== 'failed') put(n, 'svg', S[si].id);
    }
    nodes[i] = n;
  }
  if (last) for (const n of have.values()) if (!n.removed) n.remove();
  // A new text's default font, before it moves into place.
  await loadFonts(nodes.filter((n) => n.type === 'TEXT'));
  // A part's own layers go into their parents, in order; the last part
  // puts them all in theirs.
  for (let i = 0; i < recs.length; i++) {
    const kids = [];
    for (let j = i + 1; j < recs.length; j++) if (recs[j][1] === i && (last || j >= pre)) kids.push(nodes[j]);
    if (!kids.length) continue;
    const now = nodes[i].children.filter((c) => get(c, 'k'));
    if (!last || now.length !== kids.length || now.some((c, j) => c !== kids[j])) for (const c of kids) if (last || c.parent !== nodes[i]) nodes[i].appendChild(c);
  }
  let designer = 0;
  for (let i = 0; i < recs.length; i++) {
    at[2] = S[recs[i][0]];
    if (i >= pre) await style(nodes[i], recs[i], nodes[recs[i][1]], i === 0);
    if (last && ('children' in nodes[i] && recs[i][2] !== 'V' || i === 0)) designer += nodes[i].children.filter((c) => !get(c, 'k') && !get(c, 'vs')).length;
  }
  return { nodes, designer };
};

// Whether a text wraps in Figma: taller than a line and a half, of its
// line height or Figma's for the font (1.21em to 1.36em), not of the box
// measured, which a row that stretches its items makes taller. Without its
// line limit, as a truncated text wraps where it would be cut.
// A control's value (`v`) is sized to its box: it grows to its lines a moment.
const wraps = (n, t) => {
  const [w, h] = [n.width, n.height];
  if (t.v) n.textAutoResize = 'HEIGHT';
  n.maxLines = null;
  const out = n.height > 1.5 * (t.l || 1.27 * t.z);
  if (t.v) setLines(n, t, w, h);
  n.maxLines = t.tr || null;
  return out;
};

// Breaks a balanced text's lines (`b`: the widest line's width, the line
// count) where the browser did: Chrome balances by filling each line at the
// narrowest width that keeps their count, Figma fills them at the box's.
// Where those differ, a line separator, which Figma keeps (probe 8a), ends
// each line; `br` keeps the characters for the readback. Figma tells a
// break only by height, so the text tries a word more at a time, before
// setLines sizes it.
const balance = (n, t, w) => {
  const words = t.c.split(' ');
  n.textAutoResize = 'HEIGHT';
  const fits = (s, width) => {
    n.resize(width, n.height);
    n.characters = s;
    return n.height <= 1.5 * (t.l || 1.27 * t.z);
  };
  const lines = [words[0]];
  for (const word of words.slice(1)) {
    const longer = lines[lines.length - 1] + ' ' + word;
    if (fits(longer, t.b[0] + 0.5)) lines[lines.length - 1] = longer;
    else lines.push(word);
  }
  const breaks = lines.length === t.b[1] && lines.slice(0, -1).some((l, j) => fits(l + ' ' + lines[j + 1].split(' ')[0], w));
  n.characters = breaks ? lines.join('\u2028') : t.c;
  if (breaks) put(n, 'br', t.c);
};

// Figma sets a hugging text's box to whole pixels (probe 9a: 39.05, 84.4
// and 80.85 by 19.25 are 40, 85 and 81 by 20), so a row of them can end
// past the frame that fixes its width (Breadcrumb's), or narrow a filling
// sibling until it wraps (Item's description beside "Action", 43.13 set
// 44). Where that rounding pushes a layer so, each rounded text is fixed
// at the size the browser drew it, which Figma keeps (probe 9a), and the
// variant is as measured, no frame wider, unless Figma's font sets one
// wider than the browser did; elsewhere they hug, as a designer's labels
// do, and verify takes Figma's whole pixels.
const slack = (nodes, recs) => {
  const round = [];
  let most = 0.05;
  for (let i = 1; i < recs.length; i++) {
    const d = nodes[i].width - recs[i][5];
    if (nodes[i].type === 'TEXT' && nodes[i].textAutoResize === 'WIDTH_AND_HEIGHT' && d > 0 && d < 1) {
      most += d;
      round.push(i);
    }
  }
  for (let i = 1; i < recs.length && round.length; i++) {
    const [n, r] = [nodes[i], recs[i]];
    const p = nodes[r[1]];
    if (!n.visible || p.layoutMode === 'NONE' || n.layoutPositioning === 'ABSOLUTE') continue;
    const past = (end, w) => Math.max(0, end + p.paddingRight - w);
    const d = p.layoutMode === 'HORIZONTAL' && n.layoutGrow ? r[5] - n.width : past(n.x + n.width, p.width) - past(r[3] + r[5], recs[r[1]][5]);
    if (d > 0.01 && d < most) {
      for (const j of round) {
        const [t, r] = [nodes[j], recs[j]];
        const z = S[r[7]].t;
        const fix = () => t.resize(r[5], r[6]);
        fix();
        // Fixed, it must still be one line. Where Figma's font sets it
        // wider than the browser did, it would wrap (probe 9a: Geist wraps
        // "Select a fruit" at 84.5): it hugs, and the frame that fixes its
        // width grows by what it lacks.
        t.textAutoResize = 'HEIGHT';
        const one = t.height <= 1.5 * (z.l || 1.27 * z.z);
        t.textAutoResize = one ? 'NONE' : 'WIDTH_AND_HEIGHT';
        if (one) fix();
        let q = r[1];
        while (q && nodes[q].layoutSizingHorizontal !== 'FIXED') q = recs[q][1];
        const f = nodes[q];
        const v = f.layoutSizingVertical;
        if (one || f.layoutSizingHorizontal !== 'FIXED') continue;
        f.resize(f.width + t.width - r[5], f.height);
        f.layoutSizingVertical = v;
      }
      return;
    }
  }
};

// Room for a text Figma sets wider than the browser did (probe 9a: Geist
// sets Select's "Select a fruit" 85 wide, the browser 84.5): the frame
// that fixes its width, the one it fills, grows by what it lacks, where
// its row has that room free, so the text is drawn whole as measured.
const room = (nodes, recs, i) => {
  const c = nodes[i].clone();
  c.textAutoResize = 'WIDTH_AND_HEIGHT';
  const d = c.width - nodes[i].width;
  c.remove();
  let j = i;
  while (j && nodes[j].layoutSizingHorizontal === 'FILL') j = recs[j][1];
  const f = nodes[j];
  const p = j && nodes[recs[j][1]];
  if (!p || d <= 0 || f.type === 'TEXT' || p.layoutMode === 'NONE' || f.layoutPositioning === 'ABSOLUTE' || f.layoutSizingHorizontal !== 'FIXED') return false;
  const flow = p.children.filter((k) => k.visible && k.layoutPositioning !== 'ABSOLUTE');
  const used = p.layoutMode === 'HORIZONTAL' ? flow.reduce((t, k) => t + k.width, 0) + (p.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 0 : p.itemSpacing * (flow.length - 1)) : f.width;
  if (p.width - p.paddingLeft - p.paddingRight - (p.strokesIncludedInLayout && p.strokes.length ? p.strokeLeftWeight + p.strokeRightWeight : 0) - used < d) return false;
  const v = f.layoutSizingVertical;
  f.resize(f.width + d, f.height);
  if (f.layoutSizingVertical !== v) f.layoutSizingVertical = v;
  return true;
};

// Keeps each text the browser drew whole on one line (`o`), and an input's
// value, so in Figma, once the variant is laid out. Figma's font can set it wider than the box
// it was measured in: Inter is wider than the system-ui a snap from before
// the stand-ins measured, and Figma may one day hold another Inter than
// snap's. At that width it would wrap, or, truncated, end in an ellipsis
// the browser didn't draw. Such a text is built at its own width in Figma
// instead, wider than measured, still truncating should it shrink. One that
// fills its parent can't take a width of its own: where it truncates it is
// named, since verify can't see an ellipsis; where it wraps, verify sees it.
const keepLines = (nodes, recs) => {
  for (let i = 1; i < recs.length; i++) {
    const st = S[recs[i][7]];
    const t = st.t;
    // An input's value is one line whatever its box; a textarea's wraps.
    if (!t || (!t.o && t.v !== 'C') || t.v === 'T') continue;
    const n = nodes[i];
    if (!wraps(n, t)) continue;
    at[2] = S[recs[i][0]];
    const fills = (st.z || [])[0] === 'L' || t.v;
    if (fills && room(nodes, recs, i) && !wraps(n, t)) continue;
    // A value is cut at its box, as the browser clips it.
    if (t.v) n.textTruncation = 'ENDING';
    else if (fills && !t.tr) continue;
    if (!fills) {
      n.textAutoResize = 'WIDTH_AND_HEIGHT';
      if (t.tr) setLines(n, t, n.width, n.height);
      widened.add(n);
    }
    fallback(fills ? 'cut short' : 'kept on one line', 'Figma sets it wider');
  }
};

// Checks each auto layout frame inside Figma (section 8.5): every child in
// its flow must sit where the browser drew it relative to what places it,
// the content edge, its center, or the sibling before it. A frame where
// Figma's auto layout differs is built without it, each child at its
// measured offset, and named in absoluteContainers.
const checkLayout = (nodes, recs, slug, absolute) => {
  for (let i = 0; i < recs.length; i++) {
    const st = S[recs[i][7]];
    const L = st.L;
    if (!L) continue;
    const kids = [];
    for (let j = i + 1; j < recs.length; j++) if (recs[j][1] === i && !S[recs[j][7]].a && S[recs[j][7]].v !== 0) kids.push(j);
    if (!kids.length) continue;
    const H = L.m === 'H';
    const w = st.s && !st.s.o && L.i ? (Array.isArray(st.s.w) ? st.s.w : [st.s.w, st.s.w, st.s.w, st.s.w]) : [0, 0, 0, 0];
    const anchors = (size, boxes) => {
      const [m, ms, c, cs] = H ? [0, 2, 1, 3] : [1, 3, 0, 2];
      const start = H ? L.p[3] + w[3] : L.p[0] + w[0];
      const room = size[ms - 2] - start - (H ? L.p[1] + w[1] : L.p[2] + w[2]);
      const cstart = H ? L.p[0] + w[0] : L.p[3] + w[3];
      const croom = size[cs - 2] - cstart - (H ? L.p[2] + w[2] : L.p[1] + w[1]);
      const sum = boxes.reduce((t, b) => t + b[ms], 0);
      const free = room - sum - L.g * (boxes.length - 1);
      return boxes.map((b, j) => {
        const prev = boxes[j - 1];
        let main;
        if (L.pa === 'SPACE_BETWEEN') main = b[m] - start - boxes.slice(0, j).reduce((t, p) => t + p[ms], 0) - (j * (room - sum)) / Math.max(1, boxes.length - 1);
        else if (L.pa === 'MAX') main = j === boxes.length - 1 ? start + room - b[m] - b[ms] : boxes[j + 1][m] - b[m] - b[ms];
        else main = j ? b[m] - prev[m] - prev[ms] : b[m] - start - (L.pa === 'CENTER' ? free / 2 : 0);
        const fill = (S[recs[kids[j]][7]].z || [])[H ? 1 : 0] === 'L';
        const cross = fill || L.ca === 'MIN' ? b[c] - cstart : L.ca === 'MAX' ? cstart + croom - b[c] - b[cs] : b[c] + b[cs] / 2 - cstart - croom / 2;
        return [main, cross];
      });
    };
    const n = nodes[i];
    const want = anchors([recs[i][5], recs[i][6]], kids.map((j) => recs[j].slice(3, 7)));
    const got = anchors([n.width, n.height], kids.map((j) => [nodes[j].x, nodes[j].y, nodes[j].width, nodes[j].height]));
    let why = '';
    kids.forEach((j, q) => {
      const tol = recs[j][2] === 'T' ? 1 : 0.5;
      for (const a of [0, 1]) {
        const d = got[q][a] - want[q][a];
        if (!why && Math.abs(d) > tol) why = S[recs[j][0]] + ' lands ' + Math.round(d * 100) / 100 + 'px off ' + (a ? 'across' : 'along') + ' the flow';
      }
    });
    if (!why) continue;
    absolute.push([slug, S[recs[i][0]], why]);
    n.layoutMode = 'NONE';
    n.resize(recs[i][5], recs[i][6]);
    for (let j = i + 1; j < recs.length; j++) {
      if (recs[j][1] !== i) continue;
      const c = nodes[j];
      c.x = recs[j][3];
      c.y = recs[j][4];
      if (!widened.has(c) && (c.type !== 'TEXT' || c.textAutoResize !== 'WIDTH_AND_HEIGHT')) c.resize(recs[j][5], recs[j][6]);
    }
  }
};

// Where a variant draws, relative to it: its box, and each visible layer's
// box, stroke, drop shadows and blur that no frame around the layer clips. A
// label wider than its icon button draws past it, as the browser draws it,
// and so do a shadow and an absolute badge; the set's grid gives each
// variant this room. A stroke reaches past the box by its weight OUTSIDE,
// half of it CENTER (an imported vector's), its widest side's; a shadow by
// its radius, spread and both offsets; a blur by its radius. Each is taken
// on every side, and they add up, which is more than draws. A designer's
// slice has none of them, nor a group strokes. A turned layer's box is
// the one its turned corners span, about its x and y.
const drawn = (v) => {
  const d = [0, 0, 0, 0];
  const reach = (n, type, f) => Math.max(0, ...(n.effects || []).map((e) => (e.visible && e.type === type ? f(e) : 0)));
  const add = (n, x, y) => {
    const s = 'strokes' in n && n.strokes.some((p) => p.visible !== false) ? { OUTSIDE: 1, CENTER: 0.5 }[n.strokeAlign] || 0 : 0;
    const o = (s && s * (typeof n.strokeWeight === 'number' ? n.strokeWeight : Math.max(n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight)))
      + reach(n, 'DROP_SHADOW', (e) => e.radius + (e.spread || 0) + Math.abs(e.offset.x) + Math.abs(e.offset.y))
      + reach(n, 'LAYER_BLUR', (e) => e.radius);
    const [[a, b], [c, e]] = n.rotation ? n.relativeTransform : [[1, 0], [0, 1]];
    const xs = [0, a * n.width, b * n.height, a * n.width + b * n.height];
    const ys = [0, c * n.width, e * n.height, c * n.width + e * n.height];
    [x + Math.min(...xs) - o, y + Math.min(...ys) - o, x + Math.max(...xs) + o, y + Math.max(...ys) + o].map((t, i) => (d[i] = Math[i < 2 ? 'min' : 'max'](d[i], t)));
    if (isFrame(n) && !n.clipsContent) for (const c of n.children) if (c.visible) add(c, x + c.x, y + c.y);
  };
  add(v, 0, 0);
  return d;
};

// A variant's records: the base's, changed as its delta says.
const recordsOf = (base, delta) => {
  if (!Array.isArray(delta)) return delta.r;
  const recs = base.map((r) => r.slice());
  for (const [i, box, si] of delta) {
    if (box) recs[i].splice(3, 4, ...box);
    if (si >= 0) recs[i][7] = si;
  }
  return recs;
};

const idOf = (n) => get(n, 'id');
const results = [];
// Whether a lies on b, or on b moved to y.
const hit = (a, b, y = b.y) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < y + b.height && y < a.y + a.height;
// Once the call's sets are built, moves the sets and components a push
// built off one another, each at most once and only one that lies on
// another, taken top first, and of two built here at one height the one
// that grew first, so it stays: a set built here moves below each that
// starts above it and lies on it, and a set one moved, or grew, onto
// moves below what it lies on, as far as clears it and any it lands on
// that starts above it or has moved already, and any layer of a
// designer's it would land on, which never moves. So none moves twice,
// none moves up, and one that lies on nothing stays. Each move is named
// once, in the `moved` of the set whose build set it off: the one that
// grew or moved onto it, or the set itself where it lay on one that
// starts above it. `moves` holds each set moved with the result it is
// named in.
const moves = [];
const settle = (built) => {
  for (const parent of new Set(built.map(([n]) => n.parent))) {
    const ours = (m) => /^COMPONENT/.test(m.type) && idOf(m);
    const all = parent.children;
    const sets = all.filter(ours);
    const done = new Map();
    // The sets that grew first, so of two at one height they are taken first.
    const due = new Map(built.filter(([n]) => n.parent === parent).sort((a, b) => b[2] - a[2]));
    while (due.size) {
      const [n, out] = [...due].reduce((a, b) => (b[0].y < a[0].y ? b : a));
      due.delete(n);
      // Named in the result of a set it lies on that has moved or grew.
      const onto = sets.find((m) => done.has(m) && hit(m, n));
      const by = onto ? done.get(onto) : out;
      let y = n.y;
      // What it lies on at y: a set done, or not due and starting above y,
      // and, once it moves, a designer's layer.
      for (let on; (on = all.filter((m) => m !== n && hit(m, n, y) && (ours(m) ? !due.has(m) && (done.has(m) || m.y < y) : y !== n.y))).length; ) {
        y = Math.max(...on.map((m) => m.y + m.height)) + 100;
      }
      if (y !== n.y) {
        n.y = y;
        (by.moved = by.moved || []).push(n.id);
        moves.push([n, by]);
      }
      done.set(n, by);
      for (const m of sets) if (!done.has(m) && !due.has(m) && hit(m, n)) due.set(m, by);
    }
  }
};
const built = [];
// Each set is checked before it is changed. One the user must answer for
// is left as it is, its result saying why in `refused`, and the call goes
// on to the others.
for (const set of DATA.sets) {
  const want = set.props.length ? 'COMPONENT_SET' : 'COMPONENT';
  // A variant too big for one call comes in parts (`p`: [part, of]), each
  // built by its own call. Each but the last is kept on the page, its
  // strings and styles with it, an icon's markup (a style's `m`) too, so
  // the parts after it find its layers and the last lays the variant out
  // whole, then removes them.
  const key = (slug, k) => 'part ' + set.id + ' ' + slug + ' ' + k;
  const forget = (slug, n) => {
    for (let k = 1; k < n; k++) put(page, key(slug, k), '');
  };
  const keep = (slug, digest, d) => {
    const used = [];
    const ix = {};
    const re = (i) => {
      if (i in ix) return ix[i];
      const j = (ix[i] = used.push(S[i]) - 1);
      if (S[i].m !== undefined) used[j] = Object.assign({}, S[i], { m: re(S[i].m) });
      return j;
    };
    put(page, key(slug, d.p[0]), JSON.stringify({ d: digest, h: d.h, S: used, r: d.r.map((q) => [re(q[0]), ...q.slice(1, 7), re(q[7])]) }));
  };
  let stashed = 0;
  const names = set.v.map((v) => v[0]);
  // The set: by name anywhere on the page, else by its storysync id, so a
  // renamed set is found and a copy of one is not.
  const all = page.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
    .filter((n) => n.parent.type !== 'COMPONENT_SET' && (n.type === want || n.type === 'COMPONENT_SET' || idOf(n)));
  const named = all.filter((n) => n.name === set.name);
  const sets = named.length ? named : all.filter((n) => idOf(n) === set.id);
  let node = sets[0] || null;
  const kids = node && node.type === 'COMPONENT_SET' ? node.children : [];
  const twice = names.find((name) => kids.filter((c) => c.name === name).length > 1);
  // A plain component an earlier push built where a set now goes is made
  // the set's first variant, in place, so its instances stay on it, where
  // the call carries the user's yes (`cv`, figma code --convert).
  const convert = node && node.type === 'COMPONENT' && want === 'COMPONENT_SET' && set.cv;
  const why = new Set(names).size !== names.length ? 'This part names a variant of ' + set.name + ' twice'
    : sets.length > 1 || (node && node.type !== want && !convert) || (node && idOf(node) && idOf(node) !== set.id)
      ? 'The page has ' + sets.map((n) => n.type + ' "' + n.name + '" (' + n.id + ', id "' + idOf(n) + '")').join(', ') + ': '
        + (sets.length > 1 ? 'ask the user which to update'
          : idOf(node) && idOf(node) !== set.id ? 'it is another component: ask the user whether it is ' + set.id
            : 'this part builds a ' + want + ': ask the user whether to convert it' + (want === 'COMPONENT' ? '' : ' in place (figma code --convert)') + ' or skip it')
      : kids.length && node.layoutMode !== 'NONE' ? 'The set "' + set.name + '" has auto layout (' + node.layoutMode + '), so x and y do nothing: ask the user whether to turn it off or skip the set'
        : twice ? 'The set "' + set.name + '" has ' + kids.filter((c) => c.name === twice).length + ' variants named "' + twice + '", not one' : '';
  if (why) {
    // Nor are the parts of its variants kept for it.
    for (const [, slug, , , , d] of set.v) if (d.p) forget(slug, d.p[1]);
    results.push({ component: set.id, name: set.name, refused: why });
    continue;
  }
  let converted = 0;
  if (convert) {
    const plain = node;
    put(plain, 'id', '');
    put(plain, 'title', '');
    node = figma.combineAsVariants([plain], plain.parent, plain.parent.children.indexOf(plain));
    node.name = set.name;
    plain.name = set.props.map((p) => p.name + '=' + p.defaultValue).join(', ');
    converted = 1;
  }
  // Variants an earlier push built under other properties are renamed onto
  // this part's, so their instances follow: a property added takes its
  // default value; of a property dropped, the variant at the value snap now
  // pins it to (`pin`) is kept, else at its old default (`od`, from the
  // last plan), a measured one before a placeholder. The rest stay, extra.
  let renamed = 0;
  const vals = (c) => Object.fromEntries(c.name.split(', ').map((s) => s.split('=')));
  const pairs = (o) => Object.keys(o).sort().map((k) => k + '=' + o[k]).join();
  // An old variant's values in this part's properties, and whether it is at
  // the pinned or default value of each property dropped.
  const onto = (old) => pairs(Object.fromEntries(set.props.map((p) => [p.name, p.name in old ? old[p.name] : p.defaultValue])));
  const same = (old) => Object.keys(old).every((k) => set.props.some((p) => p.name === k) || old[k] === ((set.pin || {})[k] || (set.od || {})[k] || old[k]));
  if (node && node.type === 'COMPONENT_SET') {
    const take = {};
    for (const c of node.children) {
      const old = vals(c);
      const to = names.find((name) => pairs(vals({ name })) === onto(old));
      if (names.includes(c.name) || !get(c, 'slug') || !same(old) || !to || node.children.some((d) => d.name === to)) continue;
      if (!take[to] || (get(c, 'src') === 'measured' && get(take[to], 'src') !== 'measured')) take[to] = c;
    }
    for (const to in take) {
      take[to].name = to;
      renamed++;
    }
  }
  const existing = new Map(names.map((name) => [name, !node ? null : want === 'COMPONENT' ? node : node.children.find((c) => c.name === name) || null]));
  const fresh = !node;
  // Its size before this build, for settle: of two at one height, the one that grew stays.
  const size = node && node.width + node.height;
  const below = page.children.reduce((y, n) => Math.max(y, n.y + n.height + 100), 0);
  const created = [];
  const absoluteContainers = [];
  let migrated = 0;
  let designerLayers = 0;
  let first = null;
  let firstKeys = null;
  const done = [];
  try {
    for (const [name, slug, index, src, digest, delta] of set.v) {
      at = [set.title || set.name, slug];
      let recs = recordsOf(set.base, delta);
      // A part of a variant: the parts before it, as this plan split it (each
      // part's hash `h`, those before it `e`), records and all, first.
      const [k, of] = delta.p || [1, 1];
      const miss = 'Variant ' + slug + ' of ' + set.name + ' is sent in ' + of + ' calls: send call ' + delta.c + ' first, then this one again';
      const before = [];
      for (let j = 1; j < k; j++) {
        const o = JSON.parse(get(page, key(slug, j)) || '{}');
        if (o.d !== digest || o.h !== delta.e[j - 1]) throw new Error(miss);
        const n = S.length;
        S.push(...o.S.map((v) => (v.m !== undefined ? Object.assign({}, v, { m: v.m + n }) : v)));
        before.push(...o.r.map((q) => [q[0] + n, ...q.slice(1, 7), q[7] + n]));
      }
      recs = before.concat(recs);
      const last = k === of;
      if (of > 1 && last) done.push([slug, of]);
      let variant = existing.get(name);
      if (!variant && first && recs.filter((r) => firstKeys.has(r[0])).length * 2 >= recs.length) {
        // A new variant that shares most of its layers with one already
        // converged starts as a copy of it; one that doesn't is made
        // afresh, rather than copied and mostly removed. The copy keeps
        // each layer's plugin data, as the spike saw clone() do (item 5):
        // its keys, and an icon root's `svg` with the shapes marked `vs`.
        // Its designer layers go. Figma puts the copy of a variant on the
        // page, not in its set, so it goes beside its original here.
        variant = first.clone();
        first.parent.insertChild(first.parent.children.indexOf(first) + 1, variant);
        const drop = (n) => {
          for (const c of [...n.children]) {
            if (get(c, 'vs')) continue;
            if (!get(c, 'k')) c.remove();
            else if (c.type === 'FRAME' && !get(c, 'svg')) drop(c);
          }
        };
        drop(variant);
        created.push(variant);
      } else if (!variant) {
        variant = figma.createComponent();
        variant.fills = [];
        // Built in its set, in the mode a designer left the set in: moved
        // there once built, it would be resolved again in that mode, and a
        // paint bound in place of a missing alpha variable lose its opacity
        // (probe 7c, call 4).
        if (node && want === 'COMPONENT_SET') node.appendChild(variant);
        created.push(variant);
      } else if (!get(variant, 'tpl')) {
        // Built by 0.4.0: its label and icon frames are replaced by keyed layers.
        let gone = 0;
        for (const c of variant.children) {
          if (!get(c, 'k') && (c.type === 'TEXT' || (c.type === 'FRAME' && /^Icon \(/.test(c.name)))) {
            c.remove();
            gone++;
          }
        }
        if (gone) migrated++;
      }
      if (want === 'COMPONENT_SET') variant.name = name;
      const { nodes, designer } = await converge(variant, recs, before.length, last, miss);
      if (last) {
        slack(nodes, recs);
        keepLines(nodes, recs);
        designerLayers += designer;
        if (src) checkLayout(nodes, recs, slug, absoluteContainers);
        put(variant, 'slug', slug);
        put(variant, 'i', String(index));
        put(variant, 'src', src ? 'measured' : 'unmeasured');
        put(variant, 'tpl', '2');
        put(variant, 'd', digest);
      } else {
        keep(slug, digest, delta);
        stashed++;
      }
      if (!first) {
        first = variant;
        firstKeys = new Set(recs.map((r) => r[0]));
      }
    }
  } catch (e) {
    for (const v of created) if (!v.removed) v.remove();
    throw e;
  }
  for (const [slug, n] of done) forget(slug, n);
  if (want === 'COMPONENT') node = first;
  else if (!node) node = figma.combineAsVariants(created, page);
  else for (const v of created) node.appendChild(v);
  put(node, 'id', set.id);
  put(node, 'title', set.title || '');
  if (fresh) Object.assign(node, { name: set.name, x: 0, y: below });
  const out = {
    id: node.id, component: set.id, name: node.name, variants: want === 'COMPONENT' ? 1 : node.children.length,
    added: created.length, updated: names.length - created.length, migrated, designerLayers,
    rows: 1, columns: 1, extra: 0, absoluteContainers,
  };
  if (converted) out.converted = 1;
  if (renamed) out.renamed = renamed;
  if (stashed) out.stashed = stashed;
  results.push(out);
  if (want === 'COMPONENT_SET') {
    // Lays the whole set out by its properties, as 0.4.0 did, each variant
    // by where it draws: GAP apart, none over another or past the set. A
    // row's boxes share their top edge and a column's their left, the row as
    // tall as its most above them and below, the column as wide, so the
    // default variant stays top-left, where Figma takes the default from.
    // It checks the layers' order and that each is where it was put.
    const GAP = 20;
    const axes = set.props.map((p) => [p.name + '=', p.type !== 'BOOLEAN' ? p.values : p.defaultValue === 'true' ? ['true', 'false'] : ['false', 'true']]);
    const byId = (a, b) => (a.node.id > b.node.id) - (a.node.id < b.node.id);
    const byColumn = (a, b) => {
      for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
      return 0;
    };
    const cells = [];
    const extra = [];
    let removed = 0;
    const cell = (n, at) => ({ node: n, at, key: at.slice(1).join(), d: drawn(n) });
    const stale = [];
    for (const n of node.children) {
      const named = n.name.split(', ');
      const pos = named.length === axes.length ? named.map((s, i) => (s.startsWith(axes[i][0]) ? axes[i][1].indexOf(s.slice(axes[i][0].length)) : -1)) : [-1];
      if (pos.includes(-1) && set.end && get(n, 'slug')) stale.push(n);
      else (pos.includes(-1) ? extra : cells).push(cell(n, pos));
    }
    // A variant an earlier push built that no property names now, on the
    // set's last part: no longer read back by its index. Its instances move
    // to the variant of its values, where there is one: always where it is
    // at the pinned or old default value of each property dropped, else
    // where the user has the extras removed (`rm`, figma code
    // --remove-extra), which removes one only once none is left on it.
    let swapped = 0;
    for (const n of stale) {
      put(n, 'i', '');
      const old = vals(n);
      const to = cells.find((c) => pairs(vals(c.node)) === onto(old));
      let left = 0;
      for (const i of await n.getInstancesAsync()) {
        try {
          if (!to || !(set.rm || same(old))) throw 0;
          i.swapComponent(to.node);
          swapped++;
        } catch (e) {
          left++;
        }
      }
      if (set.rm && !left) {
        await loadFonts(textsIn(n));
        n.remove();
        removed++;
      } else extra.push(cell(n, [-1]));
    }
    if (swapped) out.swapped = swapped;
    if (removed) out.removed = removed;
    cells.sort((a, b) => a.at[0] - b.at[0] || byColumn(a.at, b.at) || byId(a, b));
    const grid = [];
    for (const c of cells) {
      const last = grid[grid.length - 1];
      (last && last.at[0] === c.at[0] && last.key === c.key ? extra : grid).push(c);
    }
    extra.sort((a, b) => (a.node.name > b.node.name) - (a.node.name < b.node.name) || byId(a, b));
    const rows = [...new Set(grid.map((c) => c.at[0]))];
    const columns = [...new Map(grid.map((c) => [c.key, c.at])).values()].sort(byColumn).map((p) => p.slice(1).join());
    const rowOf = new Map(rows.map((r, i) => [r, i]));
    const columnOf = new Map(columns.map((key, i) => [key, i]));
    // Each column's reach left of its boxes and right of their left edge; each row's above and below its top.
    const lefts = columns.map(() => 0);
    const rights = columns.map(() => 0);
    const tops = rows.map(() => 0);
    const bottoms = rows.map(() => 0);
    for (const c of grid) {
      c.row = rowOf.get(c.at[0]);
      c.column = columnOf.get(c.key);
      lefts[c.column] = Math.max(lefts[c.column], -c.d[0]);
      rights[c.column] = Math.max(rights[c.column], c.d[2]);
      tops[c.row] = Math.max(tops[c.row], -c.d[1]);
      bottoms[c.row] = Math.max(bottoms[c.row], c.d[3]);
    }
    const xs = [GAP];
    const ys = [GAP];
    lefts.forEach((l, i) => xs.push(xs[i] + l + rights[i] + GAP));
    tops.forEach((t, i) => ys.push(ys[i] + t + bottoms[i] + GAP));
    for (const c of grid) {
      c.x = xs[c.column] + lefts[c.column];
      c.y = ys[c.row] + tops[c.row];
    }
    let across = GAP;
    let bottom = ys[rows.length];
    const top = Math.max(0, ...extra.map((c) => -c.d[1]));
    for (const c of extra) {
      c.x = across - c.d[0];
      c.y = bottom + top;
      across += c.d[2] - c.d[0] + GAP;
    }
    if (extra.length) bottom += top + Math.max(...extra.map((c) => c.d[3])) + GAP;
    const order = [...grid, ...extra];
    for (const c of order) {
      c.node.x = c.x;
      c.node.y = c.y;
    }
    node.resizeWithoutConstraints(Math.max(xs[columns.length], across), bottom);
    // The layers panel shows the last child on top: last to first, moving only those out of place.
    const target = order.map((c) => c.node).reverse();
    const before = node.children;
    let kept = 0;
    while (kept < before.length && before[kept].id === target[kept].id) kept++;
    for (const n of target.slice(kept)) {
      // A variant another call built holds texts in fonts this one hasn't loaded.
      await loadFonts(textsIn(n));
      node.appendChild(n);
    }
    const kids = node.children;
    if (kids.length !== order.length || kids.some((n, i) => n.id !== target[i].id)) throw new Error("The set's layers are not in the order it was laid out in");
    for (const c of order) {
      if (Math.abs(c.node.x - c.x) > 0.5 || Math.abs(c.node.y - c.y) > 0.5) throw new Error('Variant "' + c.node.name + '" is not where the layout put it');
    }
    Object.assign(out, { variants: kids.length, rows: rows.length, columns: columns.length, extra: extra.length });
  }
  built.push([node, out, node.width + node.height > size + 0.5]);
}
// No two sets a push built overlap; `overlaps` counts what else each lies
// on once laid out, any layer of its page or section, and what else a set
// it moved lies on, though settle moves none onto anything (a set built
// here that moved counts nothing twice, lying on nothing).
const lying = (node) => node.parent.children.filter((n) => n !== node && hit(n, node)).length;
settle(built);
for (const [node, out] of built) out.overlaps = lying(node);
for (const [node, by] of moves) by.overlaps += lying(node);

// `file`, the file's key, ties the answer to its file: figma code reads
// another plan's answers only where they are the same file's.
const out = { kind: 'build', tpl: 2, tc: TC ? 1 : 0, page: page.name, file: figma.fileKey, sets: results, uploads, fonts: FONTS, unbound, fallbacks };
// use_figma returns at most 20,480 bytes, and refuses a call that would
// return more, keeping none of its changes (the seventh probe), so a build
// whose response grew past it would fail each time it was sent. The lists
// that grow with nodes are halved, longest first, until the response fits,
// and `omitted` says how many entries went.
const lists = [unbound, fallbacks, ...results.map((r) => r.absoluteContainers)];
let omitted = 0;
while (JSON.stringify(out).length > 16000) {
  const list = lists.reduce((a, b) => (b.length > a.length ? b : a));
  if (!list.length) break;
  omitted += list.splice(list.length >> 1).length;
}
if (omitted) out.omitted = omitted;
return out;
