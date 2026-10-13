#!/usr/bin/env python3
# Writes fonts/: the stand-in faces snap draws text in, set as wide as Figma
# sets them.
#
# Figma lays text out as HarfBuzz does with a font scaled to 1024 units an
# em: each glyph's advance and each kerning value rounded to a 1024th of an
# em, a variable font's deltas rounded on their own (the fourth push's text
# probe, cli/__tests__/fixtures/figma-text-probe-3.json: 1845 advances and
# 7632 kerning pairs of Inter at its nine weights, each as this rule gives
# it). Chrome sets the fonts unrounded, so a label snap measured whole could
# be a few hundredths of a pixel too narrow for Figma, which then cut it
# short: "sales-dashboard.pdf", 139.375 wide in Chrome, needs 139.398 in
# Figma. These faces carry Figma's widths, so Chrome sets text in them as
# Figma does:
#
# - Inter, Latin subset, one static face per weight Figma has, 100 to 900:
#   instanced from @fontsource-variable/inter (Inter 3.19), scaled to 2048
#   units, every advance and kerning value Figma's at that weight.
# - Roboto Mono, upright, Latin and Latin Extended: every advance 1230 of its
#   2048 units, as Figma sets it at every weight (the package has 1229); it
#   stays variable.
#
# Inter's and Roboto Mono's other subsets, Roboto Mono's italics (1202, a
# whole 1024th already) and Noto Serif stay as their packages ship them.
# Each face keeps the SIL Open Font License of the font it comes from
# (fonts/OFL-*.txt) and is renamed, as the license asks of a modified font.
#
#   python3 -m pip install fonttools==4.66.1 brotli uharfbuzz
#   python3 scripts/figma-stand-ins.py [--check]
#
# It fails when a face sets any advance, kerning pair or string the probe
# measured otherwise than Figma did. --check writes nothing and fails when
# fonts/ differs from what it would write. scripts/figma-font-metrics.mjs
# then measures the faces in Chrome into fixtures/figma-fonts.json.

import hashlib
import io
import json
import os
import sys

import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem
from fontTools.varLib import instancer
from fontTools.varLib.varStore import VarStoreInstancer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "fonts")
PROBE = os.path.join(ROOT, "cli", "__tests__", "fixtures", "figma-text-probe-3.json")
PNPM = os.path.join(ROOT, "node_modules", ".pnpm")

INTER = ("@fontsource-variable/inter", "5.0.18")
ROBOTO_MONO = ("@fontsource-variable/roboto-mono", "5.3.0")
WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]
STYLE = {100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black"}
# Figma's scale: units an em.
EM = 1024
# The characters the probe measured, in its order (calls 2 and 4).
CHARS = [chr(32 + i) for i in range(95)] + [chr(160 + i) for i in range(96)] + list("–—‘’“”…•€←→↑↓−×✓")
EXTRA = [chr(c) for c in (0x131, 0x152, 0x153, 0x2BB, 0x2BC, 0x2C6, 0x2DA, 0x2DC, 0x2002, 0x2009, 0x201A, 0x201E, 0x2032, 0x2033, 0x2039, 0x203A, 0x2044, 0x2074, 0x2122)]


def package_dir(name, version):
    path = os.path.join(PNPM, f"{name.replace('/', '+')}@{version}", "node_modules", name)
    if not os.path.isdir(path):
        sys.exit(f"{name}@{version} isn't installed: run pnpm install")
    return path


def em_scale(value, upem):
    """HarfBuzz's em_scale_x for a font scaled to EM units: a font-unit value in EM units, rounded."""
    mult = (EM << 16) // upem
    return (value * mult + 32768) >> 16


def em_scalef(value, upem):
    """HarfBuzz's em_scalef_x: a fractional delta in EM units, rounded half away from zero."""
    v = value * (EM / upem)
    return int(v + 0.5) if v >= 0 else -int(-v + 0.5)


def hb_font(font, weight=None):
    buf = io.BytesIO()
    copy = TTFont(io.BytesIO(font_bytes(font)))
    copy.flavor = None
    copy.save(buf)
    f = hb.Font(hb.Face(hb.Blob(buf.getvalue())))
    f.scale = (EM, EM)
    if weight is not None:
        f.set_variations({"wght": weight})
    return f


def font_bytes(font):
    # The source's timestamp, so the faces come out the same each run.
    font.recalcTimestamp = False
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def advances(font, weight):
    """Each glyph's advance at this weight in EM units, as HarfBuzz scales it."""
    f = hb_font(font, weight)
    return {name: f.get_glyph_h_advance(gid) for gid, name in enumerate(font.getGlyphOrder())}


def kern_lookups(font):
    gpos = font["GPOS"].table
    seen = []
    for rec in gpos.FeatureList.FeatureRecord:
        if rec.FeatureTag == "kern":
            for i in rec.Feature.LookupListIndex:
                if i not in seen:
                    seen.append(i)
    return [gpos.LookupList.Lookup[i] for i in seen]


def value_records(lookup):
    """Every kerning ValueRecord of a lookup, in order."""
    out = []
    for sub in lookup.SubTable:
        if sub.Format == 1:
            for pairset in sub.PairSet:
                out.extend(rec.Value1 for rec in pairset.PairValueRecord)
        else:
            for c1 in sub.Class1Record:
                out.extend(c2.Value1 for c2 in c1.Class2Record)
    return out


def kern_values(font, weight):
    """Each kerning value of the variable font at this weight in EM units: the
    base and its delta each scaled and rounded, as HarfBuzz applies them."""
    fvar = font["fvar"]
    axis = next(a for a in fvar.axes if a.axisTag == "wght")
    lo, mid, hi = axis.minValue, axis.defaultValue, axis.maxValue
    norm = (weight - mid) / (mid - lo) if weight < mid else (weight - mid) / (hi - mid) if weight > mid else 0.0
    # HarfBuzz holds normalized coordinates in 2.14.
    norm = round(norm * 16384) / 16384
    store = font["GDEF"].table.VarStore
    inst = VarStoreInstancer(store, fvar.axes, {"wght": norm})
    upem = font["head"].unitsPerEm
    out = []
    for lookup in kern_lookups(font):
        for rec in value_records(lookup):
            base = getattr(rec, "XAdvance", 0) or 0 if rec is not None else 0
            value = em_scale(base, upem)
            dev = getattr(rec, "XAdvDevice", None) if rec is not None else None
            if dev is not None and dev.DeltaFormat == 0x8000:
                value += em_scalef(inst[(dev.StartSize << 16) + dev.EndSize], upem)
            out.append(value)
    return out


VERTICAL = (("hhea", "ascent"), ("hhea", "descent"), ("hhea", "lineGap"), ("OS/2", "sTypoAscender"), ("OS/2", "sTypoDescender"),
            ("OS/2", "sTypoLineGap"), ("OS/2", "usWinAscent"), ("OS/2", "usWinDescent"))


def vertical(font):
    """Ascent, descent and line gap in EM units, rounded as Figma rounds them,
    so its AUTO line height, (992 + 247) / 1024 em for Inter, is Chrome's
    normal one: font-unit values, before any scaling."""
    upem = font["head"].unitsPerEm
    return {(t, f): em_scale(getattr(font[t], f), upem) for t, f in VERTICAL}


def set_vertical(font, values):
    to = font["head"].unitsPerEm
    for (t, f), value in values.items():
        setattr(font[t], f, value * to // EM)


def rename(font, family, style):
    name = font["name"]
    for nid in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
        name.removeNames(nameID=nid)
    ps = (family + "-" + style).replace(" ", "")
    for nid, value in ((1, family), (2, "Regular"), (3, ps + ";storysync"), (4, f"{family} {style}"), (6, ps), (16, family), (17, style)):
        name.setName(value, nid, 3, 1, 0x409)
    name.setName("Modified by storysync: advances and kerning rounded to a 1024th of an em, as Figma sets them.", 10, 3, 1, 0x409)


def probe_data():
    probe = json.load(open(PROBE, encoding="utf-8"))
    src = open(os.path.join(ROOT, "spikes", "figma-width-probe-2.js"), encoding="utf-8").read()
    start = src.index("const KERNED = unhex('") + len("const KERNED = unhex('")
    kerned = bytes.fromhex(src[start:src.index("'", start)]).decode("latin-1")
    pairs = [kerned[i:i + 2] for i in range(0, len(kerned), 2)]
    adv, kern = {}, {}
    for w in map(str, WEIGHTS):
        adv[w] = dict(zip(CHARS, probe["call2"]["advance"][w]))
        adv[w].update(zip(EXTRA, probe["call4"]["extra"][w]))
        values = probe["call2"]["kern"].get(w) or probe["call3"]["kern"].get(w) or probe["call4"]["kern"].get(w)
        kern[w] = dict(zip(pairs, values))
    strings = [row[:6] for row in probe["call1"]["rows"]]
    return adv, kern, strings


def check_inter(font, weight, adv, kern, strings):
    """The face sets every advance, pair and string the probe measured as Figma did, in 2048ths."""
    f = hb_font(font)
    f.scale = (2048, 2048)

    def width(s):
        buf = hb.Buffer()
        buf.add_str(s)
        buf.guess_segment_properties()
        hb.shape(f, buf, {})
        return sum(p.x_advance for p in buf.glyph_positions)

    w = str(weight)
    cmap = font.getBestCmap()
    wrong = []
    for ch, figma in adv[w].items():
        # Figma sets white space alone 0 wide, so the probe read it between
        # two H; it sets a soft hyphen alone 0 wide too.
        if ord(ch) in cmap and ch != "­":
            got = width("H" + ch + "H") - width("HH") if ch.isspace() else width(ch)
            if got != figma:
                wrong.append(f"{ch!r} {got} for {figma}")
    for pair, figma in kern[w].items():
        # Not a pair ending in white space: Figma's width leaves a trailing space out.
        if not pair[1].isspace() and all(ord(c) in cmap for c in pair):
            got = width(pair) - width(pair[0]) - width(pair[1])
            if got != figma:
                wrong.append(f"{pair!r} {got} for {figma}")
    for s, sw, z, _auto, _big, threshold in strings:
        if sw == weight and len(s) > 1:
            got = width(s) * z / 2048
            if abs(got - threshold) > 1e-4:
                wrong.append(f"{s!r} {got} for {threshold}")
    if wrong:
        sys.exit(f"Inter {weight} isn't set as Figma set it: {'; '.join(wrong[:8])}")


def inter_faces(adv, kern, strings):
    src_path = os.path.join(package_dir(*INTER), "files", "inter-latin-wght-normal.woff2")
    out = {}
    for weight in WEIGHTS:
        varfont = TTFont(src_path)
        widths = advances(varfont, weight)
        kerns = kern_values(varfont, weight)
        font = instancer.instantiateVariableFont(TTFont(src_path), {"wght": weight})
        lines = vertical(font)
        scale_upem(font, 2048)
        set_vertical(font, lines)
        hmtx = font["hmtx"]
        for name, value in widths.items():
            hmtx[name] = (value * 2048 // EM, hmtx[name][1])
        records = [r for lookup in kern_lookups(font) for r in value_records(lookup)]
        if len(records) != len(kerns):
            sys.exit("Inter's kerning changed shape when instanced")
        for rec, value in zip(records, kerns):
            if rec is not None:
                rec.XAdvance = value * 2048 // EM
        font["OS/2"].usWeightClass = weight
        rename(font, "Inter storysync", STYLE[weight])
        check_inter(font, weight, adv, kern, strings)
        out[f"inter-latin-{weight}-normal.woff2"] = font
    return out


def roboto_mono_faces():
    out = {}
    for subset in ("latin", "latin-ext"):
        font = TTFont(os.path.join(package_dir(*ROBOTO_MONO), "files", f"roboto-mono-{subset}-wght-normal.woff2"))
        upem = font["head"].unitsPerEm
        if any(any(row) for data in font["HVAR"].table.VarStore.VarData for row in data.Item):
            sys.exit("Roboto Mono's advances now vary with weight: round them per weight")
        hmtx = font["hmtx"]
        for name in font.getGlyphOrder():
            advance, lsb = hmtx[name]
            hmtx[name] = (em_scale(advance, upem) * upem // EM, lsb)
        set_vertical(font, vertical(font))
        if hmtx["a"][0] != 1230:
            sys.exit(f"Roboto Mono's a is {hmtx['a'][0]}, not the 1230 Figma sets")
        rename(font, "Roboto Mono storysync", "Regular")
        out[f"roboto-mono-{subset}-wght-normal.woff2"] = font
    return out


def woff2(font):
    font.flavor = "woff2"
    return font_bytes(font)


def main():
    check = "--check" in sys.argv
    adv, kern, strings = probe_data()
    faces = {**inter_faces(adv, kern, strings), **roboto_mono_faces()}
    files = {name: woff2(font) for name, font in faces.items()}
    for license_name, pkg in (("OFL-Inter.txt", INTER), ("OFL-Roboto-Mono.txt", ROBOTO_MONO)):
        files[license_name] = open(os.path.join(package_dir(*pkg), "LICENSE"), "rb").read()
    manifest = {
        "about": "The stand-in faces snap draws text in, set as wide as Figma sets them (scripts/figma-stand-ins.py)",
        "packages": {INTER[0]: INTER[1], ROBOTO_MONO[0]: ROBOTO_MONO[1]},
        "sha256": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items()) if name.endswith(".woff2")},
    }
    files["manifest.json"] = (json.dumps(manifest, indent=1) + "\n").encode()
    stale = []
    for name, data in sorted(files.items()):
        path = os.path.join(OUT, name)
        now = open(path, "rb").read() if os.path.exists(path) else None
        if now != data:
            stale.append(name)
            if not check:
                os.makedirs(OUT, exist_ok=True)
                open(path, "wb").write(data)
    if check:
        if stale:
            sys.exit(f"fonts/ differs from what scripts/figma-stand-ins.py writes: {', '.join(stale)}")
        print("fonts/ matches the probe and the installed fonts")
    else:
        print(f"wrote {len(stale)} of {len(files)} files in fonts/")


if __name__ == "__main__":
    main()
