// storysync build template (tpl 2): builds and restyles component sets from
// snap's element trees, one page per call.
//
// `storysync figma code` writes every call as `const DATA = {...};` followed
// by this file, minified, and the agent sends the file unchanged. Nothing
// here is specific to a component: everything is in DATA, which emit
// computes from snap's facts (cli/figma-code.ts), so this file sets plain
// Figma properties and decides nothing about CSS.
//
// DATA = { page, S, sets }
//   S     the call's table of strings and styles; records refer to it by index.
//   sets  [{ id, title, name, props, base, v }], each one part of a set:
//         id, title   the component's Storybook id and title, kept on the set
//                     as shared plugin data, by which it is found again;
//         name        the set's name; props, its variantProperties for the grid;
//         base        records of the part's first variant;
//         v           [[name, slug, i, src, digest, delta]], the part's variants:
//                     src 1 measured, 0 a placeholder for one snap couldn't
//                     measure; delta [[index, [x, y, w, h] | 0, style | -1]]
//                     against base, or { r: records } in full.
//   A record is [key, parent, kind, x, y, w, h, style]: key and style index
//   S, parent indexes the records, kind is F, T, V or I. x and y are relative
//   to the parent's frame; w and h are the frame's size. A style is
//   cli/figma-map.ts's FigmaStyle.
//
// Each variant is converged: its layers are matched to records by the key in
// their shared plugin data `k`, restyled in place (so node ids, and the
// overrides of instances, survive), created where missing, and removed where
// snap no longer measures them. Layers without a key are a designer's: left
// alone and counted. Running a call twice changes nothing the second time.
//
// Branches marked SPIKE(n) take whichever way Figma goes on spike item n
// (cli/figma-spike.ts): each tries the design's choice and falls back.

const NS = 'storysync';
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

// A text's font: the measured family, else Roboto Mono for a mono one, Noto
// Serif for a serif, Inter for any other; at the measured weight, else the
// next toward Regular, in either spelling; italic where the family has it.
// It never throws, and FONTS, returned, names each stand-in.
const STYLES = ['Thin', 'Extra Light', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black'];
const FONTS = {};
const fonts = {};
const loadFont = (family, weight, italic) => {
  const id = family + weight + (italic ? 'i' : '');
  return (fonts[id] = fonts[id] || (async () => {
    const i = Math.min(8, Math.max(0, Math.round((weight || 400) / 100) - 1));
    const d = Math.sign(3 - i);
    const alt = /mono|menlo|monaco|consolas|courier/i.test(family) ? 'Roboto Mono' : /^(?!.*sans).*(serif|georgia|times)/i.test(family) ? 'Noto Serif' : 'Inter';
    for (const f of new Set([family, alt, 'Inter'])) {
      for (const j of new Set([i, i + d, i + 2 * d, 3].filter((j) => (j - 3) * d <= 0))) {
        for (const s of new Set([STYLES[j], STYLES[j].replace(' ', '')])) {
          for (const style of italic ? [j === 3 ? 'Italic' : s + ' Italic', s] : [s]) {
            try {
              await figma.loadFontAsync({ family: f, style });
              if (f !== family || j !== i || (italic && !/Italic/.test(style))) FONTS[family + ' ' + weight + (italic ? ' italic' : '')] = f + ' ' + style;
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
const fallbacks = [];
let at = [];
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
// A paint from a style's: '#rrggbb', [hex, opacity, variable?], or a gradient.
const paint = async (p, property) => {
  if (p.g) {
    return { type: 'GRADIENT_LINEAR', gradientTransform: [p.g.slice(0, 3), p.g.slice(3, 6)], gradientStops: p.s.map(([position, hex]) => ({ position, color: rgba(hex) })) };
  }
  const [hex, opacity, name] = typeof p === 'string' ? [p, 1] : p;
  const out = { type: 'SOLID', color: rgb(hex), opacity };
  const v = name && (await variable('COLOR', name, property));
  return v ? figma.variables.setBoundVariableForPaint(out, 'color', v) : out;
};
// Sets fills or strokes. Figma gives a paint freshly bound to a variable the
// variable's alpha as its opacity: assigning them once more, bound as they
// now are, puts each paint's own opacity back.
const setPaints = async (n, key, list, property) => {
  const paints = [];
  for (const p of list) paints.push(await paint(p, property));
  n[key] = paints;
  if (paints.some((p) => p.boundVariables)) n[key] = n[key].map((p, i) => Object.assign({}, p, { opacity: paints[i].opacity }));
};
const effect = (e) => (e.length === 2
  ? { type: e[0] === 'L' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', radius: e[1], visible: true }
  : Object.assign({ type: e[0] === 'I' ? 'INNER_SHADOW' : 'DROP_SHADOW', color: Object.assign(rgb(e[5]), { a: e[6] }), offset: { x: e[1], y: e[2] }, radius: e[3], spread: e[4], visible: true, blendMode: 'NORMAL' }, e[0] === 'D' ? { showShadowBehindNode: false } : {}));

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

// Imports a vector. SPIKE(1): the markup's size, or its viewBox's with a
// rescale, is chosen by emit; an import Figma refuses leaves an empty,
// keyed frame, which verify scores as the wrong shapes.
const vector = (st) => {
  try {
    const n = figma.createNodeFromSvg(S[st.m]);
    if (st.rs) n.rescale(st.rs);
    return n;
  } catch (e) {
    fallbacks.push([...at, 'svg import failed: ' + String((e && e.message) || e)]);
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
// The fonts a text has now, its own or its ranges', as figma-use's text recipe loads them.
const loadCurrent = async (n) => {
  const now = n.fontName === figma.mixed ? n.getStyledTextSegments(['fontName']).map((s) => s.fontName) : [n.fontName];
  for (const f of now) await figma.loadFontAsync(f).catch(() => {});
};
const fits = (n, kind, st) => (kind === 'T' ? n.type === 'TEXT' : n.type === 'FRAME' && (kind === 'V' ? get(n, 'svg') === st.id : !get(n, 'svg')));
const isFrame = (n) => n.type === 'FRAME' || n.type === 'COMPONENT';
const SIZING = { X: 'FIXED', H: 'HUG', L: 'FILL' };

// Styles one node from its record. Parents come before their children, so a
// child's auto layout parent is set up before the child fills it.
const style = async (n, rec, parent, root) => {
  const [, , kind, x, y, w, h, si] = rec;
  const st = S[si];
  let sizing = st.z || ['X', 'X'];
  if (st.n && !root && get(n, 'svg') !== 'failed') n.name = st.n;
  // Clipping first: whether a shadow's spread takes can depend on it (SPIKE(2)).
  if (kind !== 'T') n.clipsContent = Boolean(st.c);
  n.visible = st.v !== 0;
  n.opacity = st.o === undefined ? 1 : st.o;
  n.blendMode = st.b || (isFrame(n) && kind !== 'T' ? 'PASS_THROUGH' : 'NORMAL');
  const fx = (st.e || []).map(effect);
  try {
    n.effects = fx;
  } catch (e) {
    // SPIKE(2): a shadow's spread Figma refuses on this node is left out.
    if (!fx.some((f) => f.spread)) throw e;
    n.effects = fx.map((f) => Object.assign({}, f, { spread: 0 }));
    fallbacks.push([...at, 'shadow spread left out: ' + String((e && e.message) || e)]);
  }
  if (kind === 'T') {
    const t = st.t;
    const font = await loadFont(t.f, t.w, t.i);
    await loadCurrent(n);
    n.fontName = font;
    n.characters = t.c;
    n.fontSize = t.z;
    n.lineHeight = t.l ? { unit: 'PIXELS', value: t.l } : { unit: 'AUTO' };
    n.letterSpacing = { unit: 'PIXELS', value: t.s || 0 };
    n.textCase = t.tc || 'ORIGINAL';
    n.textDecoration = t.td || 'NONE';
    n.textAlignHorizontal = t.ta || 'LEFT';
    await setPaints(n, 'fills', st.f || [], 'color');
    let ar = t.ar;
    try {
      n.textTruncation = t.tr ? 'ENDING' : 'DISABLED';
      n.maxLines = t.tr || null;
    } catch (e) {
      // SPIKE(3): truncation Figma refuses is built as a box of the measured size.
      if (!t.tr) throw e;
      fallbacks.push([...at, 'truncation refused: ' + String((e && e.message) || e)]);
      n.resize(w, h);
      n.textAutoResize = 'NONE';
      ar = '';
      sizing = [sizing[0] === 'L' ? 'L' : 'X', 'X'];
    }
    if (ar === 'W') n.textAutoResize = 'WIDTH_AND_HEIGHT';
    else if (ar) {
      n.resize(w, h);
      n.textAutoResize = 'HEIGHT';
    }
  } else if (kind === 'V') {
    if (Math.abs(n.width - w) > 0.01 || Math.abs(n.height - h) > 0.01) n.resize(w, h);
    if (st.vb) {
      for (const shape of n.findAll((c) => 'fills' in c)) {
        for (const key of ['fills', 'strokes']) {
          const list = shape[key];
          if (list === figma.mixed || !list.every((p) => p.type === 'SOLID') || !list.some((p) => st.vb[hexOf(p.color)])) continue;
          await setPaints(shape, key, list.map((p) => [hexOf(p.color), p.opacity, st.vb[hexOf(p.color)]]), 'vector');
        }
      }
    }
  } else {
    if (st.im) image(n, st.im);
    else {
      // No longer an image: the images call must not fill it.
      if (get(n, 'img')) put(n, 'img', '');
      await setPaints(n, 'fills', st.f || [], 'fill');
    }
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
    if (Array.isArray(st.r)) [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius] = st.r;
    else n.cornerRadius = st.r || 0;
    if (st.rv) {
      const v = await variable('FLOAT', st.rv, 'radius');
      if (v) for (const corner of ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius']) n.setBoundVariable(corner, v);
    }
    const L = st.L;
    n.layoutMode = L ? (L.m === 'H' ? 'HORIZONTAL' : 'VERTICAL') : 'NONE';
    // Only auto layout reads it: left alone on a frame without, unless an earlier build set it.
    if (L || n.strokesIncludedInLayout) n.strokesIncludedInLayout = Boolean(L && L.i);
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
const converge = async (root, recs) => {
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
    if (get(root, 'svg') !== S[rootStyle].id) {
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
  // Figma refuses to move or restyle a text whose font isn't loaded: load
  // every font the variant's texts have now, and will have, first.
  for (const n of have.values()) if (n.type === 'TEXT') await loadCurrent(n);
  for (const rec of recs) if (rec[2] === 'T') await loadFont(S[rec[7]].t.f, S[rec[7]].t.w, S[rec[7]].t.i);
  const nodes = [root];
  for (let i = 1; i < recs.length; i++) {
    const [ki, , kind, , , , , si] = recs[i];
    const k = S[ki];
    at[2] = k;
    let n = have.get(k);
    have.delete(k);
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
  for (const n of have.values()) if (!n.removed) n.remove();
  for (let i = 0; i < recs.length; i++) {
    const kids = [];
    for (let j = i + 1; j < recs.length; j++) if (recs[j][1] === i) kids.push(nodes[j]);
    if (!kids.length) continue;
    const now = nodes[i].children.filter((c) => get(c, 'k'));
    if (now.length !== kids.length || now.some((c, j) => c !== kids[j])) for (const c of kids) nodes[i].appendChild(c);
  }
  let designer = 0;
  for (let i = 0; i < recs.length; i++) {
    at[2] = S[recs[i][0]];
    await style(nodes[i], recs[i], nodes[recs[i][1]], i === 0);
    if ('children' in nodes[i] && recs[i][2] !== 'V' || i === 0) designer += nodes[i].children.filter((c) => !get(c, 'k') && !get(c, 'vs')).length;
  }
  return { nodes, designer };
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
      if (c.type !== 'TEXT' || c.textAutoResize !== 'WIDTH_AND_HEIGHT') c.resize(recs[j][5], recs[j][6]);
    }
  }
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
// Every set this call builds is found and checked before any is changed,
// so a call refused for one changes nothing.
const found = DATA.sets.map((set) => {
  const want = set.props.length ? 'COMPONENT_SET' : 'COMPONENT';
  const names = set.v.map((v) => v[0]);
  if (new Set(names).size !== names.length) throw new Error('This part names a variant of ' + set.name + ' twice');
  // The set: by name anywhere on the page, else by its storysync id, so a
  // renamed set is found and a copy of one is not; refused as 0.4.0 refused.
  const all = page.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
    .filter((n) => n.parent.type !== 'COMPONENT_SET' && (n.type === want || n.type === 'COMPONENT_SET' || idOf(n)));
  const named = all.filter((n) => n.name === set.name);
  const sets = named.length ? named : all.filter((n) => idOf(n) === set.id);
  const node = sets[0] || null;
  const why = sets.length > 1 ? 'ask the user which to update'
    : node && node.type !== want ? 'this part builds a ' + want + ': ask the user whether to convert it or skip it'
      : node && idOf(node) && idOf(node) !== set.id ? 'it is another component: ask the user whether it is ' + set.id : '';
  if (why) throw new Error('The page has ' + sets.map((n) => n.type + ' "' + n.name + '" (' + n.id + ', id "' + idOf(n) + '")').join(', ') + ': ' + why);
  if (node && set.props.length && node.layoutMode !== 'NONE') {
    throw new Error('The set "' + set.name + '" has auto layout (' + node.layoutMode + '), so x and y do nothing: ask the user whether to turn it off or skip the set');
  }
  const existing = new Map();
  for (const name of names) {
    const same = !node ? [] : want === 'COMPONENT' ? [node] : node.children.filter((c) => c.name === name);
    if (same.length > 1) throw new Error('The set "' + set.name + '" has ' + same.length + ' variants named "' + name + '", not one');
    existing.set(name, same[0] || null);
  }
  return { want, names, node, existing };
});
for (const [s, set] of DATA.sets.entries()) {
  const { want, names, existing } = found[s];
  let node = found[s].node;
  const fresh = !node;
  const below = page.children.reduce((y, n) => Math.max(y, n.y + n.height + 100), 0);
  const created = [];
  const absoluteContainers = [];
  let migrated = 0;
  let designerLayers = 0;
  let first = null;
  try {
    for (const [name, slug, index, src, digest, delta] of set.v) {
      at = [set.title || set.name, slug];
      let variant = existing.get(name);
      if (!variant && first) {
        // A new variant starts as a copy of one already converged, its keys
        // copied explicitly (SPIKE(5)) and the copy's designer layers dropped.
        // An icon root's shapes are kept, and its `svg` with them, or the copy
        // would keep the asset id with no shapes, and never import them.
        variant = first.clone();
        const copy = (from, to) => {
          const a = from.children;
          const b = to.children;
          a.forEach((c, i) => {
            if (get(c, 'vs')) return put(b[i], 'vs', '1');
            if (!get(c, 'k')) return b[i].remove();
            for (const k of ['k', 'svg', 'img']) put(b[i], k, get(c, k));
            if (c.type === 'FRAME' && !get(c, 'svg')) copy(c, b[i]);
          });
        };
        put(variant, 'svg', get(first, 'svg'));
        copy(first, variant);
        created.push(variant);
      } else if (!variant) {
        variant = figma.createComponent();
        variant.fills = [];
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
      const recs = recordsOf(set.base, delta);
      const { nodes, designer } = await converge(variant, recs);
      designerLayers += designer;
      if (src) checkLayout(nodes, recs, slug, absoluteContainers);
      put(variant, 'slug', slug);
      put(variant, 'i', String(index));
      put(variant, 'src', src ? 'measured' : 'unmeasured');
      put(variant, 'tpl', '2');
      put(variant, 'd', digest);
      first = first || variant;
    }
  } catch (e) {
    for (const v of created) if (!v.removed) v.remove();
    throw e;
  }
  if (want === 'COMPONENT') node = first;
  else if (!node) node = figma.combineAsVariants(created, page);
  else for (const v of created) node.appendChild(v);
  put(node, 'id', set.id);
  put(node, 'title', set.title || '');
  if (fresh) Object.assign(node, { name: set.name, x: 0, y: below });
  const overlaps = node.parent.children.filter((n) => n !== node && /^COMPONENT/.test(n.type)
    && n.x < node.x + node.width && node.x < n.x + n.width && n.y < node.y + node.height && node.y < n.y + n.height).length;
  const out = {
    id: node.id, component: set.id, name: node.name, variants: want === 'COMPONENT' ? 1 : node.children.length,
    added: created.length, updated: names.length - created.length, migrated, designerLayers,
    rows: 1, columns: 1, extra: 0, overlaps, absoluteContainers,
  };
  results.push(out);
  if (want === 'COMPONENT') continue;

  // Lays the whole set out by its properties, as 0.4.0 did, and checks it.
  const GAP = 20;
  const axes = set.props.map((p) => [p.name + '=', p.type !== 'BOOLEAN' ? p.values : p.defaultValue === 'true' ? ['true', 'false'] : ['false', 'true']]);
  const byId = (a, b) => (a.node.id > b.node.id) - (a.node.id < b.node.id);
  const byColumn = (a, b) => {
    for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  const cells = [];
  const extra = [];
  for (const n of node.children) {
    const pairs = n.name.split(', ');
    const pos = pairs.length === axes.length ? pairs.map((s, i) => (s.startsWith(axes[i][0]) ? axes[i][1].indexOf(s.slice(axes[i][0].length)) : -1)) : [-1];
    (pos.includes(-1) ? extra : cells).push({ node: n, at: pos, key: pos.slice(1).join() });
  }
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
  const widths = columns.map(() => 0);
  const heights = rows.map(() => 0);
  for (const c of grid) {
    c.row = rowOf.get(c.at[0]);
    c.column = columnOf.get(c.key);
    widths[c.column] = Math.max(widths[c.column], c.node.width);
    heights[c.row] = Math.max(heights[c.row], c.node.height);
  }
  const xs = [GAP];
  const ys = [GAP];
  widths.forEach((w, i) => xs.push(xs[i] + w + GAP));
  heights.forEach((h, i) => ys.push(ys[i] + h + GAP));
  for (const c of grid) {
    c.x = xs[c.column];
    c.y = ys[c.row];
  }
  let across = GAP;
  let bottom = ys[rows.length];
  for (const c of extra) {
    c.x = across;
    c.y = bottom;
    across += c.node.width + GAP;
  }
  if (extra.length) bottom += Math.max(...extra.map((c) => c.node.height)) + GAP;
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
  for (const n of target.slice(kept)) node.appendChild(n);
  const kids = node.children;
  if (kids.length !== order.length || kids.some((n, i) => n.id !== target[i].id)) throw new Error("The set's layers are not in the order it was laid out in");
  for (const c of order) {
    if (Math.abs(c.node.x - c.x) > 0.5 || Math.abs(c.node.y - c.y) > 0.5) throw new Error('Variant "' + c.node.name + '" is not where the layout put it');
  }
  const boxes = kids.map((n) => ({ name: n.name, x: n.x, y: n.y, r: n.x + n.width, b: n.y + n.height }));
  boxes.forEach((a, i) => {
    if (a.x < 0 || a.y < 0 || a.r > node.width || a.b > node.height) throw new Error('Variant "' + a.name + '" lies outside the set');
    for (const b of boxes.slice(i + 1)) {
      if (a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b) throw new Error('Variants "' + a.name + '" and "' + b.name + '" overlap');
    }
  });
  Object.assign(out, { variants: kids.length, rows: rows.length, columns: columns.length, extra: extra.length });
}

return { kind: 'build', tpl: 2, page: page.name, sets: results, uploads, fonts: FONTS, unbound, fallbacks };
