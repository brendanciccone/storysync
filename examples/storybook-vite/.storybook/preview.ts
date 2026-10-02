// Bundles Inter rather than fetching it.
//
// The font has to satisfy two constraints at once, and most fonts fail one:
//
//   - The browser must actually render it, or `snap` measures a fallback.
//   - Figma's *plugin* context must have it. That context exposes only Google
//     Fonts — no Arial, no Helvetica — so a system font a designer sees in the
//     desktop app's picker is unavailable to the agent doing the push, and
//     Figma substitutes (Arial becomes Arimo, which has no SemiBold, so the
//     weight drifts too).
//
// Installing from npm satisfies both: nothing is fetched at runtime, and Figma
// has Inter with a real Semi Bold.
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
