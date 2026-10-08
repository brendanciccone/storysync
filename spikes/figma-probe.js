// Figma spike for the element-tree design (section 14): one use_figma call
// that measures what the build and readback templates must not guess about
// Figma, run once, live, before package B finalizes. Send this file as the
// `code` of a use_figma call, unchanged, in a scratch Design file, and only
// with the owner's go-ahead for the writes.
//
// It creates a page named "storysync spike", marks it as its own, switches
// to it, and builds everything there. It removes nothing outside that page:
// a re-run clears only the page it created, and it refuses to touch a page
// of that name it did not create. Delete the page when done.
//
// Two calls:
//   1. MODE = 'probe' measures items 1-9 and creates the frame for item 10,
//      returning its id as `imageNode`.
//      Then upload the Avatar thumbnail fixture to it:
//        upload_assets({ fileKey, count: 1, nodeIds: [imageNode], scaleMode: 'FILL' })
//      and POST the bytes of EXPECT.file (below) to the URL it returns.
//   2. MODE = 'image' reads that image back (item 10) and reuses its hash.
// Save each response unchanged as cli/__tests__/fixtures/figma-spike.json
// (`probe` and `image`), noting for item 7 whether the tool's text showed
// the returned value as an object or as a JSON string.
const MODE = 'probe';
const PAGE = 'storysync spike';
// The thumbnail item 10 uploads: cli/__tests__/fixtures/tree/assets/513d06f54269-262b.jpg.
const EXPECT = { bytes: 2186, fnv: 'ef9497ae', sha1: '0221a8aad9b1a24a8ddb7d59043d07379fc6821d', width: 80, height: 80 };

const t0 = Date.now();
const r = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n === figma.mixed ? 'mixed' : n);
const box = (n) => [n.type, r(n.x), r(n.y), r(n.width), r(n.height)];
const gray = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
const out = { mode: MODE, items: {} };
// Each item on its own: one that throws reports why, and the rest still run.
const item = async (name, fn) => {
  try {
    out.items[name] = await fn();
  } catch (e) {
    out.items[name] = { error: String((e && e.message) || e) };
  }
};

let page = figma.root.children.find((p) => p.name === PAGE);
if (page && page.getSharedPluginData('storysync', 'spike') !== '1') {
  throw new Error('A page named "' + PAGE + '" exists that this probe did not create: rename it, or run the probe in another file');
}
if (!page && MODE === 'image') throw new Error('Run MODE probe first: there is no "' + PAGE + '" page');
if (!page) {
  page = figma.createPage();
  page.name = PAGE;
  page.setSharedPluginData('storysync', 'spike', '1');
}
await figma.setCurrentPageAsync(page);
out.page = page.id;

if (MODE === 'probe') {
  for (const n of [...page.children]) n.remove();

  // 1. SVG import: lucide Mail at 16px from a 24 viewBox; the browser draws its 2px strokes 1.33 wide.
  const MAIL = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/></svg>';
  await item('svg', () => {
    const f = figma.createNodeFromSvg(MAIL);
    const g = figma.createNodeFromSvg(MAIL.replace('width="16" height="16"', 'width="24" height="24"'));
    g.rescale(16 / 24);
    const grouped = figma.createNodeFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><g><circle cx="4" cy="4" r="3"/></g></svg>');
    const kids = (n) => n.children.map((c) => [...box(c), r(c.strokeWeight), c.strokeAlign, c.strokes.length, c.fills.length]);
    return { frame: [...box(f), f.children.length, f.clipsContent, f.fills.length], kids: kids(f), rescaled: kids(g), group: grouped.children.map((c) => c.type), expect: 1.33 };
  });

  // 2. Shadow spread, on a frame that does not clip and one that does.
  await item('shadow', () => {
    const fx = [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 1 }, radius: 2, spread: 1, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false }];
    // Each on its own: Figma may refuse spread on one and not the other.
    const read = (clip) => {
      try {
        const f = figma.createFrame();
        f.resize(40, 40);
        f.clipsContent = clip;
        f.effects = fx;
        return [f.effects[0].spread, f.effects[0].showShadowBehindNode];
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    };
    return { unclipped: read(false), clipped: read(true) };
  });

  // 3. Text: truncation at a fixed width, a hugging label, and what resize() does to a hugging one.
  await item('text', async () => {
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
    const t = figma.createText();
    t.characters = 'sales-dashboard.pdf sales-dashboard.pdf';
    t.fontSize = 14;
    t.lineHeight = { unit: 'PIXELS', value: 20 };
    t.resize(94, 20);
    t.textAutoResize = 'HEIGHT';
    t.textTruncation = 'ENDING';
    t.maxLines = 1;
    const hug = figma.createText();
    hug.fontName = { family: 'Inter', style: 'Medium' };
    hug.characters = 'Login with Email Button';
    hug.fontSize = 14;
    const hugged = [hug.textAutoResize, r(hug.width), r(hug.height)];
    hug.resize(60, 20);
    // Chrome drew this label 154.8 wide in system-ui (risk R1).
    return { truncated: [t.textAutoResize, t.textTruncation, t.maxLines, r(t.width), r(t.height)], hug: hugged, afterResize: [hug.textAutoResize, r(hug.width), r(hug.height)], chrome: 154.8 };
  });

  // 4. Absolute children under auto layout, strokes included in layout by align, per-side weights.
  await item('absolute', () => {
    const p = figma.createFrame();
    p.layoutMode = 'HORIZONTAL';
    p.primaryAxisSizingMode = 'AUTO';
    p.counterAxisSizingMode = 'AUTO';
    p.paddingLeft = 10;
    p.itemSpacing = 4;
    p.strokes = gray;
    p.strokeWeight = 2;
    p.strokesIncludedInLayout = true;
    const kid = (w, h) => {
      const f = figma.createFrame();
      f.resize(w, h);
      p.appendChild(f);
      return f;
    };
    kid(20, 20);
    const o = kid(10, 10);
    o.strokes = gray;
    o.strokeWeight = 3;
    o.strokeAlign = 'OUTSIDE';
    const abs = kid(5, 5);
    abs.layoutPositioning = 'ABSOLUTE';
    abs.x = 3;
    abs.y = 4;
    const at = {};
    for (const align of ['INSIDE', 'CENTER', 'OUTSIDE']) {
      p.strokeAlign = align;
      at[align] = [r(p.width), r(p.height), ...p.children.map((c) => [c.layoutPositioning, r(c.x), r(c.y)])];
    }
    const s = figma.createFrame();
    s.resize(36, 36);
    s.strokes = gray;
    s.strokeTopWeight = 1;
    s.strokeRightWeight = 1;
    s.strokeBottomWeight = 1;
    s.strokeLeftWeight = 0;
    s.strokeAlign = 'OUTSIDE';
    return { at, sides: [r(s.strokeWeight), s.strokeTopWeight, s.strokeLeftWeight, s.strokeAlign, r(s.width)] };
  });

  // 5. Clone: does plugin data come along, on the root and its children, and where does the copy go?
  await item('clone', () => {
    const make = (name) => {
      const c = figma.createComponent();
      c.name = name;
      c.resize(10, 10);
      const k = figma.createFrame();
      c.appendChild(k);
      k.setSharedPluginData('storysync', 'k', 'thumb');
      c.setSharedPluginData('storysync', 'slug', name);
      return c;
    };
    const plain = make('size=a');
    const copy = plain.clone();
    const set = figma.combineAsVariants([make('size=b'), make('size=c')], page);
    const variant = set.children[0].clone();
    return {
      root: copy.getSharedPluginData('storysync', 'slug'), child: copy.children[0].getSharedPluginData('storysync', 'k'),
      parent: copy.parent === plain.parent ? 'same' : copy.parent.type, variantParent: variant.parent.type,
    };
  });

  // 6. Finding nodes by shared plugin data, by a key and by any key.
  await item('search', () => {
    const k = page.findAllWithCriteria({ sharedPluginData: { namespace: 'storysync', keys: ['k'] } });
    return {
      k: k.length, kOrNone: page.findAllWithCriteria({ sharedPluginData: { namespace: 'storysync', keys: ['k', 'none'] } }).length,
      any: page.findAllWithCriteria({ sharedPluginData: { namespace: 'storysync' } }).length, types: [...new Set(k.map((n) => n.type))],
    };
  });

  // 7. The return value: this call returns an object; one field is a JSON string, to see how each is escaped.
  out.items.returned = { object: true, nested: JSON.stringify({ a: 1 }) };

  // 8. Time: 400 frames and 100 text nodes in one call, in an auto-layout frame, with plugin data on each.
  await item('time', async () => {
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    const start = Date.now();
    const holder = figma.createFrame();
    holder.name = 'time';
    holder.layoutMode = 'VERTICAL';
    holder.primaryAxisSizingMode = 'AUTO';
    holder.counterAxisSizingMode = 'AUTO';
    for (let i = 0; i < 400; i++) {
      const f = figma.createFrame();
      f.resize(8, 8);
      f.fills = gray;
      f.cornerRadius = 2;
      f.setSharedPluginData('storysync', 'k', 'f' + i);
      holder.appendChild(f);
    }
    const frames = Date.now() - start;
    for (let i = 0; i < 100; i++) {
      const t = figma.createText();
      t.characters = 'Label ' + i;
      holder.appendChild(t);
    }
    return { frames, texts: Date.now() - start - frames, height: r(holder.height) };
  });

  // 9. Blend mode and dashes read back.
  await item('blend', () => {
    const f = figma.createFrame();
    f.resize(32, 32);
    f.blendMode = 'DARKEN';
    f.strokes = gray;
    f.dashPattern = [3, 3];
    return { blend: f.blendMode, dash: f.dashPattern };
  });

  // Defaults the mock assumes: a new frame's and component's fills, a text's sizing, stroke aligns.
  await item('defaults', () => {
    const f = figma.createFrame();
    const c = figma.createComponent();
    const al = figma.createFrame();
    al.layoutMode = 'HORIZONTAL';
    const v = figma.createVector();
    return { frame: f.fills.length, component: c.fills.length, strokeAlign: [f.strokeAlign, v.strokeAlign], autoLayout: [al.primaryAxisSizingMode, al.counterAxisSizingMode], text: figma.createText().textAutoResize };
  });

  // 10. The frame upload_assets fills, between this call and MODE 'image'.
  const target = figma.createFrame();
  target.name = 'image probe';
  target.resize(32, 32);
  target.fills = [];
  target.setSharedPluginData('storysync', 'img', 'spike');
  out.imageNode = target.id;
} else {
  // 10. Image bytes: are they the bytes uploaded, is the hash their SHA-1, and can another node reuse it?
  await item('image', async () => {
    const node = page.findAllWithCriteria({ sharedPluginData: { namespace: 'storysync', keys: ['img'] } })[0];
    const paint = node && node.fills.find((p) => p.type === 'IMAGE');
    if (!paint) throw new Error('The image probe frame has no IMAGE fill: run upload_assets on imageNode first');
    const image = figma.getImageByHash(paint.imageHash);
    const bytes = await image.getBytesAsync();
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
    const fnv = h.toString(16).padStart(8, '0');
    const size = await image.getSizeAsync();
    const reuse = figma.createFrame();
    reuse.resize(32, 32);
    reuse.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: paint.imageHash }];
    return {
      hash: paint.imageHash, scaleMode: paint.scaleMode, length: bytes.length, fnv, size,
      sameBytes: fnv === EXPECT.fnv && bytes.length === EXPECT.bytes, hashIsSha1: paint.imageHash === EXPECT.sha1,
      sameSize: size.width === EXPECT.width && size.height === EXPECT.height, reused: reuse.fills[0].imageHash === paint.imageHash,
    };
  });
}

out.ms = Date.now() - t0;
return out;
