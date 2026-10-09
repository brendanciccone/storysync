// storysync readback, template 2: reads back, off the Figma nodes, what
// `storysync figma code` built, for `storysync verify --plan` to score
// element by element against snap.
//
// Data-free. The build stored everything this needs as shared plugin data
// (namespace `storysync`): on each set its Storybook `id` and `title`; on each
// variant its snap `slug`, its index `i` in snap's variant list, its `src`
// (`measured`, or `unmeasured` for a placeholder) and `d`, the digest of the
// facts it was built from; on each layer it built its key `k`; on a vector
// its asset id `svg`. So a call carries no slugs, sources or expected values
// for an agent to fill in, and returns only what Figma has.
//
// A call file is four lines the CLI writes (cli/figma-results.ts
// readbackHeader, as `storysync figma code` writes them), then this
// template:
//
//   const PAGE = "ui/base";
//   const SLICES = [["ui-base-card",0,1,0]];
//   const LIMIT = 15000;
//   const TPL = 2;
//
// PAGE is the page the sets are on, switched to once. Each slice is a set's
// storysync id, the first and last variant index `i` to read, and the node
// to start the first variant at (0, or where a part before it stopped).
// LIMIT is the characters of entries to return: when the next entry would
// pass it, the call stops and returns `more`, the slices left, from which
// `storysync figma next` writes the next call. TPL is the template the CLI
// pairs the call with, this one, 2; any other refuses to run.
//
// It returns, for each set read, its entries by slug, each sealed with the
// checksum verify recomputes (FNV-1a over canonical JSON under the set's id
// and the entry's key, as 0.4.0's template seals): an entry edited, composed
// or copied after this returned it no longer matches. A variant too big for
// one call is split at node boundaries into parts, `slug` then
// `slug#<first node>`, each with `part: [first, count, total]`.
//
// An entry has 0.4.0's thirteen root fields, as its template reads them, so
// an older verify can still score the variant's root, and `boxShadow`; then
// `name`, the variant's name in Figma; `source`; `tpl`; `built`; `tree`, one
// record per keyed layer, depth first in Figma's child order, the variant
// first with key ""; `designerLayers`, the layers nothing keyed, as
// `[name, type, id]` (at most 20; their own layers are not read); `readAt`
// and `checksum`. A later part has only `name`, `source`, `tpl`, `built`,
// `part`, `tree`, `readAt` and `checksum`.
//
// Records have one length per kind (cli/tree-types.ts RECORD), so a template
// cut down to fewer fields is told apart:
//
//   F (15) [k, "F", x, y, w, h, fills, stroke, radius, effects, opacity, blend, clip, visible, id]
//   T (23) [k, "T", x, y, w, h, chars, family, weight, italic, size, lineHeight, letterSpacing,
//           color, textCase, decoration, align, truncation, maxLines, autoResize, opacity, visible, id]
//   V (10) [k, "V", x, y, w, h, shapes, opacity, visible, id]
//
// In the browser's terms, which snap's facts are in: x and y relative to the
// parent's border box, so Figma's x and y plus the parent's stroke outside
// its box, less the layer's own; w and h with the layer's own stroke outside
// its box (all of OUTSIDE, half of CENTER); a radius with it added back.
// fills: the visible paints, bottom to top: `#rrggbb[aa]`;
// `img:<fnv of the bytes>:<scaleMode>:<w>x<h>`, `?` for what can't be read;
// `lin:<css angle>:<#hex@position,…>`; `other:<TYPE>`. stroke: null, or
// `[weight or [t, r, b, l], paints, "solid"|"dashed"|"dotted", "I"|"O"|"C"]`.
// effects: `["D"|"I", x, y, blur, spread, #hex]` or `["L"|"B", radius]`.
// chars: verbatim to 300 characters, else `fnv:<8>:<length>:<first 60>`.
// shapes: `[x, y, w, h, fill, stroke, strokeWeight]` for each shape of the
// vector, relative to it. An image is an F record whose fills hold `img:`.

if (TPL !== 2) throw new Error('This is readback template 2, not ' + TPL);

// Spike-dependent (design section 14, item 7): how use_figma shows what a
// call returns. false returns the object, which the tool writes as JSON;
// true returns it as a JSON string, should the tool turn an object into
// anything else. verify reads either (cli/figma-results.ts).
const RETURN_TEXT = false;

const NS = 'storysync';
const get = (n, key) => n.getSharedPluginData(NS, key);
const r2 = (v) => Math.round(v * 100) / 100;
// Leave canon and fnv as they are: verify computes the same, character for
// character. fnv takes a string (its char codes) or bytes.
const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v !== null && typeof v === 'object'
    ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
    : JSON.stringify(v));
const fnv = (x) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < x.length; i++) h = Math.imul(h ^ (typeof x === 'string' ? x.charCodeAt(i) : x[i]), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};
const seal = (setId, key, fields) => {
  // Through JSON first, as use_figma returns it, so what is sealed is what
  // arrives: an undefined field, or figma.mixed, drops out on both sides.
  const entry = JSON.parse(JSON.stringify(Object.assign(fields, { readAt: new Date().toISOString() })));
  entry.checksum = 'fnv1a:' + fnv(canon({ [setId]: { [key]: entry } }));
  return entry;
};

// A paint's color as snap writes colors: #rrggbb, then the alpha byte when
// under ff, from the color's alpha times the paint's opacity; null for one
// hidden or fully transparent, which draws nothing. + 1e-4: Figma keeps
// opacity as a 32-bit float, so 0.7 reads 0.69999… and would round down.
const hexOf = (p) => {
  if (!p || p.visible === false || !p.color) return null;
  const c = p.color;
  const byte = (n) => n.toString(16).padStart(2, '0');
  const a = Math.round((c.a == null ? 1 : c.a) * (p.opacity == null ? 1 : p.opacity) * 255 + 1e-4);
  return a ? '#' + [c.r, c.g, c.b].map((x) => byte(Math.round(x * 255))).join('') + (a < 255 ? byte(a) : '') : null;
};
const images = {};
const imageOf = async (hash) => {
  if (!images[hash]) {
    const image = figma.getImageByHash(hash);
    let bytes = '?', size = '?';
    try {
      bytes = fnv(await image.getBytesAsync());
      const s = await image.getSizeAsync();
      size = s.width + 'x' + s.height;
    } catch (e) { /* what can't be read stays '?' */ }
    images[hash] = bytes + ':' + size;
  }
  return images[hash];
};
// The visible paints of `n`'s `list`, bottom to top, as the header says.
const paints = async (list, n) => {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (p.visible === false) continue;
    if (p.type === 'SOLID') {
      const hex = hexOf(p);
      if (hex) out.push(hex);
    } else if (p.type === 'IMAGE') {
      const [bytes, size] = p.imageHash ? (await imageOf(p.imageHash)).split(':') : ['?', '?'];
      out.push('img:' + bytes + ':' + p.scaleMode + ':' + size);
    } else if (p.type === 'GRADIENT_LINEAR') {
      // The gradient's line, (0, 0.5) to (1, 0.5) in gradient space, taken
      // back into the layer through the transform's inverse, as a CSS angle
      // in the layer's pixels: 0 up, 90 right.
      const [[a, b, c], [d, e, f]] = p.gradientTransform;
      const det = a * e - b * d;
      const at = (u) => [(e * (u - c) - b * (0.5 - f)) / det, (a * (0.5 - f) - d * (u - c)) / det];
      const [[x0, y0], [x1, y1]] = [at(0), at(1)];
      const deg = (Math.round((Math.atan2((x1 - x0) * n.width, (y0 - y1) * n.height) * 180) / Math.PI) + 360) % 360;
      out.push('lin:' + deg + ':' + p.gradientStops.map((s) => hexOf({ color: s.color, opacity: p.opacity }) + '@' + r2(s.position)).join(','));
    } else out.push('other:' + p.type);
  }
  return out;
};

// Stroke weights per side, top right bottom left, and the part of each
// outside the layer's own box: all of OUTSIDE, half of CENTER.
const weights = (n) => (typeof n.strokeWeight === 'number' ? [1, 1, 1, 1].map(() => n.strokeWeight)
  : [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight]);
const outside = (n) => {
  const share = Array.isArray(n.strokes) && n.strokes.length ? { OUTSIDE: 1, CENTER: 0.5 }[n.strokeAlign] || 0 : 0;
  return share ? weights(n).map((w) => w * share) : [0, 0, 0, 0];
};
const WEIGHTS = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500,
  semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};
const weightOf = (style) => {
  const key = String(style || '').toLowerCase().replace(/[^a-z]/g, '').replace(/italic$/, '');
  return WEIGHTS[key] != null ? WEIGHTS[key] : 400;
};
const SHAPES = /^(VECTOR|ELLIPSE|RECTANGLE|LINE|POLYGON|STAR|BOOLEAN_OPERATION)$/;
const effectsOf = (n) => (Array.isArray(n.effects) ? n.effects : []).filter((e) => e.visible !== false);

// One keyed layer's record. `around` is its parent's stroke outside its box.
const record = async (n, k, around, root) => {
  const own = outside(n);
  const head = [k, 'F', root ? 0 : r2(n.x + around[3] - own[3]), root ? 0 : r2(n.y + around[0] - own[0]),
    r2(n.width + own[1] + own[3]), r2(n.height + own[0] + own[2])];
  const tail = [n.opacity, n.visible ? 1 : 0, n.id];
  if (n.type === 'TEXT') {
    head[1] = 'T';
    const font = typeof n.fontName === 'object' ? n.fontName : null;
    const size = typeof n.fontSize === 'number' ? n.fontSize : null;
    const lh = typeof n.lineHeight === 'object' ? n.lineHeight : null;
    const ls = typeof n.letterSpacing === 'object' ? n.letterSpacing : null;
    const chars = n.characters;
    const fills = await paints(n.fills, n);
    return [...head,
      chars.length > 300 ? 'fnv:' + fnv(chars) + ':' + chars.length + ':' + chars.slice(0, 60) : chars,
      font && font.family, font && weightOf(font.style), font && (/italic/i.test(font.style) ? 1 : 0), size,
      !lh ? null : lh.unit === 'PIXELS' ? r2(lh.value) : lh.unit === 'PERCENT' ? r2((lh.value * size) / 100) : 'auto',
      !ls ? null : r2(ls.unit === 'PIXELS' ? ls.value : (ls.value * size) / 100),
      fills.length ? fills[fills.length - 1] : null,
      n.textCase, n.textDecoration, n.textAlignHorizontal, n.textTruncation, n.maxLines, n.textAutoResize, ...tail];
  }
  if (get(n, 'svg')) {
    head[1] = 'V';
    const box = n.absoluteBoundingBox;
    const shapes = [];
    for (const s of n.findAll((d) => SHAPES.test(d.type))) {
      const b = s.absoluteBoundingBox;
      const [fill] = await paints(s.fills, s), stroke = await paints(s.strokes, s);
      shapes.push([r2(b.x - box.x), r2(b.y - box.y), r2(b.width), r2(b.height), fill || null, stroke[0] || null,
        stroke.length && typeof s.strokeWeight === 'number' ? r2(s.strokeWeight) : null]);
    }
    return [...head, shapes, ...tail];
  }
  // A corner's radius with the stroke outside it, where it is rounded.
  const corner = (r, i) => (r > 0 ? r2(r + Math.max(own[i], own[(i + 3) % 4])) : 0);
  let stroke = null;
  if (Array.isArray(n.strokes) && n.strokes.length) {
    const w = weights(n);
    const dash = n.dashPattern && n.dashPattern.length ? n.dashPattern[0] : 0;
    stroke = [typeof n.strokeWeight === 'number' ? n.strokeWeight : w, await paints(n.strokes, n),
      !dash ? 'solid' : dash > Math.max(...w) ? 'dashed' : 'dotted', { INSIDE: 'I', OUTSIDE: 'O', CENTER: 'C' }[n.strokeAlign]];
  }
  return [...head, await paints(n.fills, n), stroke,
    typeof n.cornerRadius === 'number' ? corner(n.cornerRadius, 0)
      : [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].map(corner),
    effectsOf(n).map((e) => (/SHADOW/.test(e.type)
      ? [e.type === 'INNER_SHADOW' ? 'I' : 'D', r2(e.offset.x), r2(e.offset.y), r2(e.radius), r2(e.spread || 0), hexOf({ color: e.color })]
      : [{ LAYER_BLUR: 'L', BACKGROUND_BLUR: 'B' }[e.type] || e.type, r2(e.radius)])),
    n.opacity, n.blendMode, n.clipsContent ? 1 : 0, ...tail.slice(1)];
};

// A variant's records, depth first in Figma's child order, the variant
// itself first, and the visible layers nothing keyed: a designer's, whose
// own layers are not read. A text has no layers, and a vector's are its
// shapes, read into its record.
const walk = async (variant) => {
  const records = [];
  const designer = [];
  const visit = async (n, around, root) => {
    const k = root ? '' : get(n, 'k');
    if (!k && !root) {
      if (n.visible && designer.length < 20) designer.push([n.name, n.type, n.id]);
      return;
    }
    records.push(await record(n, k, around, root));
    if (n.type !== 'TEXT' && !get(n, 'svg') && 'children' in n) {
      for (const child of n.children) await visit(child, outside(n), false);
    }
  };
  await visit(variant, [0, 0, 0, 0], true);
  return { records, designer };
};

// 0.4.0's root fields, read as its template reads them, so an older verify
// still scores the root; and boxShadow, as snap writes one.
const rootFields = (v) => {
  const fill = v.fills && v.fills[0];
  const stroke = v.strokes && v.strokes[0];
  const own = outside(v);
  const text = v.findOne((n) => n.type === 'TEXT' && get(n, 'k') !== '');
  const font = text && typeof text.fontName === 'object' ? text.fontName : null;
  const dash = v.dashPattern && v.dashPattern.length ? v.dashPattern[0] : 0;
  return {
    source: get(v, 'src') || 'inferred',
    backgroundColor: fill && fill.type === 'SOLID' ? hexOf(fill) : null,
    color: text && text.fills[0] ? hexOf(text.fills[0]) : null,
    borderRadiusUniform: typeof v.cornerRadius === 'number' ? v.cornerRadius : null,
    padding: { top: v.paddingTop, right: v.paddingRight, bottom: v.paddingBottom, left: v.paddingLeft },
    borderUniform: stroke ? {
      width: v.strokeWeight,
      style: !dash ? 'solid' : dash > (typeof v.strokeWeight === 'number' ? v.strokeWeight : v.strokeTopWeight) ? 'dashed' : 'dotted',
      color: hexOf(stroke),
    } : null,
    fontSize: text && typeof text.fontSize === 'number' ? text.fontSize : null,
    fontWeight: font ? weightOf(font.style) : null,
    fontFamily: font ? font.family : null,
    gap: v.layoutMode && v.layoutMode !== 'NONE' ? { row: v.itemSpacing, column: v.itemSpacing } : null,
    opacity: v.opacity,
    width: v.width + own[1] + own[3],
    height: v.height + own[0] + own[2],
    boxShadow: effectsOf(v).filter((e) => /SHADOW/.test(e.type)).map((e) => ({
      offsetX: e.offset.x, offsetY: e.offset.y, blur: e.radius, spread: e.spread || 0, color: hexOf({ color: e.color }), inset: e.type === 'INNER_SHADOW',
    })),
  };
};

const pageKey = (name) => name.toLowerCase().replace(/[ /_-]+/g, '');
const page = figma.root.children.find((p) => pageKey(p.name) === pageKey(PAGE));
if (!page) throw new Error('No page named "' + PAGE + '"');
await figma.setCurrentPageAsync(page);
// Sets, and plain components not inside one, by their storysync id.
const owners = page.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
  .filter((n) => n.type === 'COMPONENT_SET' || !n.parent || n.parent.type !== 'COMPONENT_SET');

const out = { kind: 'read', tpl: TPL, page: page.name, sets: [] };
const size = (v) => JSON.stringify(v).length + 1;
let used = size(out);
for (let s = 0; s < SLICES.length && !out.more; s++) {
  const [id, from, to, start] = SLICES[s];
  const found = owners.filter((n) => get(n, 'id') === id);
  if (found.length !== 1) throw new Error('Found ' + found.length + ' sets with storysync id ' + id + ' on the page "' + page.name + '"');
  const set = found[0];
  const kids = set.type === 'COMPONENT' ? [set] : set.children.filter((c) => c.type === 'COMPONENT');
  const read = { id: set.id, component: id, title: get(set, 'title'), name: set.name, total: kids.length, unbuilt: [], absent: [], entries: {} };
  const byIndex = {};
  const bySlug = {};
  for (const v of kids) {
    const slug = get(v, 'slug');
    if (!slug) {
      read.unbuilt.push(v.name);
      continue;
    }
    // A variant duplicated in Figma keeps the original's plugin data.
    const twin = bySlug[slug] || byIndex[get(v, 'i')];
    if (twin) throw new Error('Variants ' + twin.id + ' and ' + v.id + ' of "' + set.name + '" carry one slug or index: one was duplicated');
    bySlug[slug] = byIndex[get(v, 'i')] = v;
  }
  out.sets.push(read);
  used += size(read);
  for (let i = from; i <= to && !out.more; i++) {
    const v = byIndex[i];
    if (!v) {
      read.absent.push(i);
      continue;
    }
    const slug = get(v, 'slug');
    const { records, designer } = await walk(v);
    const first = i === from ? start || 0 : 0;
    // The entry for records [first, last): the first part carries the root
    // fields, every part what it is a part of.
    const entry = (last) => {
      const key = first ? slug + '#' + first : slug;
      const fields = first ? {} : rootFields(v);
      Object.assign(fields, { name: v === set ? '' : v.name, source: get(v, 'src') || 'inferred', tpl: TPL, built: get(v, 'd') || null });
      if (first || last < records.length) fields.part = [first, last - first, records.length];
      fields.tree = records.slice(first, last);
      if (!first) fields.designerLayers = designer;
      const sealed = seal(set.id, key, fields);
      return { key, sealed, chars: size(key) + size(sealed) };
    };
    let last = records.length;
    let made = entry(last);
    if (used + made.chars > LIMIT) {
      const anything = out.sets.some((r) => Object.keys(r.entries).length);
      // Too big for what is left: the next call reads it, unless nothing
      // is in this one, when it is split into parts at node boundaries,
      // this call taking as many records as fit.
      if (!anything) {
        let lo = 0;
        let hi = records.length - first;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (used + entry(first + mid).chars <= LIMIT) lo = mid;
          else hi = mid - 1;
        }
        if (!lo) throw new Error('A layer of ' + slug + ' passes LIMIT on its own');
        last = first + lo;
        made = entry(last);
      } else last = first;
      if (last > first) {
        read.entries[made.key] = made.sealed;
        used += made.chars;
      }
      out.more = { slices: [[id, i, to, last], ...SLICES.slice(s + 1)] };
      break;
    }
    read.entries[made.key] = made.sealed;
    used += made.chars;
  }
}

// use_figma returns at most 20kb. Fail rather than return a read the limit
// would cut short; a character outside ASCII counted as up to three bytes.
const text = JSON.stringify(out);
const bytes = (RETURN_TEXT ? JSON.stringify(text) : text).length + (text.match(/[^\x00-\x7f]/g) || []).length * 2;
if (bytes > 19000) throw new Error('This read returns ' + bytes + ' bytes, too near 20kb: lower LIMIT');
return RETURN_TEXT ? text : out;
