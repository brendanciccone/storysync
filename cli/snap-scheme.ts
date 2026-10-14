// Which color scheme a story rendered in, and how snap asks Storybook for
// the light one.
//
// Token values are matched by their light theme's, so a component measured
// in a project's dark theme would bind to whichever token's light value its
// dark colors happen to equal. A Storybook that renders dark by default, as
// a theme decorator reading @storybook/addon-themes' `theme` global may, is
// asked for light through its globals, in each story's URL; where that
// can't be done, the component records `scheme: "dark"` and snap says so.

/** The scheme a component was measured in, and what on the page said so. */
export interface SchemeReading {
  scheme: "light" | "dark";
  /** What marked it, as `html.dark` or `html[data-theme="dark"]`; absent where nothing did, which is light. */
  by?: string;
}

/**
 * Runs in the page: the color scheme `el` renders in, from the nearest of
 * it and the elements around it that marks one, as a theme decorator does:
 * a `dark` or `light` class (Tailwind's selector strategy, and
 * addon-themes' withThemeByClassName), or a `data-theme`, `data-mode` or
 * like attribute naming one (withThemeByDataAttribute). Else its computed
 * `color-scheme`, where that is dark alone. Else light: snap's browser
 * prefers light, so a stylesheet that follows the system is light too.
 */
export function colorSchemeInPage(el: Element): SchemeReading {
  const attrs = ["data-theme", "data-mode", "data-color-mode", "data-color-scheme", "data-scheme", "data-bs-theme", "data-mantine-color-scheme"];
  const named = (node: Element) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}`;
  const word = (value: string): "light" | "dark" | null => {
    const parts = value.toLowerCase().split(/[\s_-]+/);
    return parts.includes("dark") ? "dark" : parts.includes("light") ? "light" : null;
  };
  for (let node: Element | null = el; node; node = node.parentElement) {
    for (const cls of Array.from(node.classList)) {
      const lower = cls.toLowerCase();
      const scheme = lower === "dark" || lower === "light"
        ? lower
        : /^(?:theme|mode|scheme)[-_](dark|light)$|^(dark|light)[-_](?:theme|mode|scheme)$/.exec(lower)?.slice(1).find(Boolean);
      if (scheme === "dark" || scheme === "light") return { scheme, by: `${named(node)}.${cls}` };
    }
    for (const attr of attrs) {
      const value = node.getAttribute(attr);
      const scheme = value ? word(value) : null;
      if (scheme) return { scheme, by: `${named(node)}[${attr}="${value}"]` };
    }
  }
  const declared = (getComputedStyle(el).getPropertyValue("color-scheme") || "").trim().toLowerCase();
  if (declared === "dark" || declared === "only dark") return { scheme: "dark", by: `color-scheme: ${declared}` };
  return { scheme: "light" };
}

/** Storybook's globals, as themeGlobalsInPage reads them, for lightGlobals. */
export interface ThemeGlobals {
  /**
   * Each global's value, a string, or a value of another type by its type;
   * `backgrounds.value` for the backgrounds global's, as a URL sets it.
   */
  globals: Record<string, string | { $type: string }>;
  /** The globals a story's URL may set: those the project declares. */
  allowed: string[];
  /** The values a toolbar offers for each global that has a toolbar. */
  options: Record<string, string[]>;
  /**
   * Globals whose value is addon-themes' default theme, as the global is
   * empty and its decorator renders that: a JSX provider's theme marks
   * nothing on the page to read instead.
   */
  defaulted?: string[];
}

/**
 * The scheme Storybook's globals say a story renders in, where the page
 * marks none (colorSchemeInPage's `by` absent): dark where a theme,
 * scheme, mode or appearance global, or the backgrounds global, names
 * dark, as a theme provider that marks nothing may follow. Null where none
 * does.
 */
export function schemeOfGlobals(read: ThemeGlobals | null | undefined): SchemeReading | null {
  if (!read || typeof read.globals !== "object" || read.globals === null) return null;
  for (const [name, value] of Object.entries(read.globals)) {
    if (typeof value !== "string" || !/dark/i.test(value)) continue;
    if (!/theme|scheme|mode|appearance/i.test(name) && name !== "backgrounds.value") continue;
    const defaulted = read.defaulted?.includes(name);
    return { scheme: "dark", by: defaulted ? `addon-themes' default theme, ${value}` : `globals ${name}:${value}` };
  }
  return null;
}

/**
 * Runs in the page: Storybook's globals, those its URL may set, and the
 * values each global's toolbar offers. Null where the preview can't be read.
 */
export function themeGlobalsInPage(): ThemeGlobals | null {
  try {
    interface GlobalsInPage { get?(): Record<string, unknown>; globals?: Record<string, unknown>; allowedGlobalNames?: Set<string> }
    const page = window as unknown as {
      __STORYBOOK_PREVIEW__?: { storyStoreValue?: { userGlobals?: GlobalsInPage; globals?: GlobalsInPage; projectAnnotations?: { globalTypes?: Record<string, unknown> } } };
      __STORYBOOK_ADDONS_CHANNEL__?: { last?(event: string): unknown };
    };
    const preview = page.__STORYBOOK_PREVIEW__;
    const store = preview?.storyStoreValue;
    // Storybook 8.2 and later keep the user's globals apart from a story's own; 7 has one store.
    const held = store?.userGlobals ?? store?.globals;
    if (!store || !held) return null;
    const values = (typeof held.get === "function" ? held.get() : held.globals) ?? {};
    const globals: ThemeGlobals["globals"] = {};
    for (const [name, value] of Object.entries(values)) globals[name] = typeof value === "string" ? value : { $type: value === null ? "null" : typeof value };
    const allowed = held.allowedGlobalNames ? Array.from(held.allowedGlobalNames) : Object.keys(values);
    // The backgrounds global's value, `{ value: "dark" }` from Storybook 8.3, as a URL sets it.
    const backgrounds = (values.backgrounds as { value?: unknown } | null | undefined)?.value;
    if (typeof backgrounds === "string") {
      globals["backgrounds.value"] = backgrounds;
      if (allowed.includes("backgrounds")) allowed.push("backgrounds.value");
    }
    const options: Record<string, string[]> = {};
    for (const [name, type] of Object.entries(store.projectAnnotations?.globalTypes ?? {})) {
      const items = (type as { toolbar?: { items?: unknown } } | null)?.toolbar?.items;
      if (!Array.isArray(items)) continue;
      const values = items.map((item) => (typeof item === "string" ? item : (item as { value?: unknown } | null)?.value)).filter((v): v is string => typeof v === "string");
      if (values.length) options[name] = values;
    }
    // addon-themes' `theme`, empty, is the default its decorator was given,
    // which it sends on the channel as `storybook/themes/REGISTER_THEMES`,
    // with its themes, the toolbar's values.
    // Written out, as this runs in the page, where nothing around it is.
    const registered = (page.__STORYBOOK_ADDONS_CHANNEL__?.last?.("storybook/themes/REGISTER_THEMES") as unknown[] | undefined)?.[0] as { defaultTheme?: unknown; themes?: unknown } | undefined;
    const defaulted: string[] = [];
    if (registered && typeof registered.defaultTheme === "string" && registered.defaultTheme && !values.theme) {
      globals.theme = registered.defaultTheme;
      defaulted.push("theme");
      if (Array.isArray(registered.themes) && !options.theme) options.theme = registered.themes.filter((t): t is string => typeof t === "string");
    }
    return { globals, allowed, options, ...(defaulted.length ? { defaulted } : {}) };
  } catch {
    return null;
  }
}

/** The characters Storybook takes in a URL's globals, as in its args: see isEncodableArgValue. */
const URL_SAFE = /^[A-Za-z0-9 _.-]+$/;

/**
 * The globals to set in a story's URL so Storybook renders the light scheme,
 * from what themeGlobalsInPage read where a story rendered dark: each the
 * URL may set whose value names dark (`dark`, `dark-tritan`) with `light`
 * in its place, a value its toolbar offers where the swap isn't one; and an
 * empty theme, scheme, mode or appearance global, which a decorator
 * defaulting to dark reads, as the toolbar's light value or `light`. Null
 * where there is none to set.
 */
export function lightGlobals(read: ThemeGlobals): Record<string, string> | null {
  const out: Record<string, string> = {};
  const lightOption = (options: string[]) => options.find((o) => /light/i.test(o));
  for (const name of read.allowed) {
    if (!URL_SAFE.test(name)) continue;
    const value = read.globals[name];
    const options = read.options[name] ?? [];
    let light: string | undefined;
    if (typeof value === "string" && /dark/i.test(value)) {
      const swapped = value.replace(/dark/g, "light").replace(/Dark/g, "Light").replace(/DARK/g, "LIGHT");
      light = options.length && !options.includes(swapped) ? lightOption(options) : swapped;
    } else if ((value === undefined || value === "") && /theme|scheme|mode|appearance/i.test(name)) {
      light = lightOption(options) ?? "light";
    }
    if (light && URL_SAFE.test(light)) out[name] = light;
  }
  return Object.keys(out).length ? out : null;
}

/** Globals as a story URL's `globals` parameter writes them: `theme:light`. */
export function globalsParam(globals: Record<string, string>): string {
  return Object.entries(globals).map(([name, value]) => `${name}:${value}`).join(";");
}

/**
 * The warning for a component measured in its dark scheme: by what, why
 * snap couldn't render it light, and what to do. `of` is how many of its
 * measured variants were dark, where not all.
 */
export function describeDarkScheme(by: string | undefined, why: string, of?: { dark: number; measured: number }): string {
  const which = of && of.dark < of.measured ? ` (${of.dark} of ${of.measured} measured variants)` : "";
  return (
    `It was measured in its dark color scheme${by ? ` (${by})` : ""}${which}, as ${why}, so its colors are the dark theme's, ` +
    `recorded as \`scheme: "dark"\`, and \`figma code\` binds them by the tokens' dark values. To measure the light scheme, ` +
    `let the story render light: through a Storybook global its URL can set, such as addon-themes' \`theme\`, or a theme ` +
    `decorator that follows one, then measure it again with --components and --merge.`
  );
}
