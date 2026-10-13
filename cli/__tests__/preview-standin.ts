// A stand-in for Storybook's preview, for the tests of snap's check that a
// story was given the args its URL asked for. Put on the global `window`, as
// the page functions find it, it treats args as Storybook 10 does: its store
// takes from the URL only values the argTypes options allow; the story is
// given the args aimed at no other target, each through its argType's
// `mapping`, and of those only the ones whose argTypes `if` holds on the
// mapped values, judged when its context is read, so lifting one counts;
// `updateStoryArgs` writes the store unchecked and answers
// `storyArgsUpdated` once the rerender is done, as `resetStoryArgs` does
// once it has put the args it names back as the story had them, or
// removed them; `forceRemount` renders
// again and says `storyRendered`, or, for a story that throws, says
// `storyThrewException` and shows Storybook's error display.

export interface FakeArgType {
  options?: unknown[];
  if?: { arg: string; neq?: unknown; eq?: unknown };
  type?: { name: string };
  control?: { type: string };
  mapping?: Record<string, unknown>;
  target?: string;
}

export function fakePreview(opts: {
  argTypes: Record<string, FakeArgType>;
  initial: Record<string, unknown>;
  url: Record<string, unknown>;
  /** The render's phase when the page is first read; "finished" by default. */
  phase?: string;
  /** Leave `updateStoryArgs` unanswered, as a preview that never confirms. */
  silent?: boolean;
  /** Keep hiding args by their argTypes `if` as first declared, as though lifting one did nothing. */
  ignoreLift?: boolean;
  /** Storybook 7's last phase: a render ends at "completed", or "played" after a play function, never "finished". */
  sb7?: "completed" | "played";
  /** How long a remount stays in its afterEach before it finishes, in ms; Infinity never does. */
  afterEachMs?: number;
  /** A remount throws, as a story given a value it can't render does. */
  remountThrows?: boolean;
  storyId?: string;
  /** The stories of the story's CSF file, by ID, each with its own annotations, which loadCSFFileByStoryId gives; without it the preview can't load a file, as before Storybook 7. */
  csf?: Record<string, { args?: Record<string, unknown>; render?: () => unknown; userStoryFn?: () => unknown; decorators?: unknown[]; play?: () => unknown }>;
}) {
  const storyId = opts.storyId ?? "ui-base-badge--default";
  const story = { argTypes: structuredClone(opts.argTypes) as Record<string, FakeArgType>, parameters: { fileName: "./badge.stories.tsx" } };
  const declared = structuredClone(opts.argTypes) as Record<string, FakeArgType>;
  const stored: Record<string, unknown> = { ...opts.initial };
  for (const [name, value] of Object.entries(opts.url)) {
    const options = story.argTypes[name]?.options;
    if (story.argTypes[name] && (!options || options.includes(value))) stored[name] = value;
  }
  const render = { id: storyId, phase: opts.phase ?? opts.sb7 ?? "finished", story };
  const events: string[] = [];
  /** Whether Storybook's error display shows, as it does once a remount throws. */
  const shown = { error: null as string | null };
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const channel = {
    on: (event: string, listener: (payload: unknown) => void) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
    off: (event: string, listener: (payload: unknown) => void) => listeners.get(event)?.delete(listener),
    emit: (event: string, payload: unknown) => {
      events.push(`${event}@${render.phase}`);
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
      if (event === "updateStoryArgs" && !opts.silent) {
        Object.assign(stored, (payload as { updatedArgs: Record<string, unknown> }).updatedArgs);
        setTimeout(() => channel.emit("storyArgsUpdated", { storyId, args: { ...stored } }), 5);
      }
      // Each arg back to the story's own, and one it has none of gone, as Storybook's reset does.
      if (event === "resetStoryArgs" && !opts.silent) {
        for (const name of (payload as { argNames: string[] }).argNames) {
          if (Object.hasOwn(opts.initial, name)) stored[name] = opts.initial[name];
          else delete stored[name];
        }
        setTimeout(() => channel.emit("storyArgsUpdated", { storyId, args: { ...stored } }), 5);
      }
      if (event === "forceRemount") {
        render.phase = "rendering";
        setTimeout(() => {
          if (opts.remountThrows) {
            render.phase = "errored";
            shown.error = "TypeError: Cannot read properties of undefined";
            channel.emit("storyThrewException", { name: "TypeError", message: "Cannot read properties of undefined" });
            render.phase = "finished";
            return;
          }
          render.phase = "completed";
          channel.emit("storyRendered", storyId);
          if (opts.sb7) {
            render.phase = opts.sb7;
          } else if (opts.afterEachMs) {
            render.phase = "afterEach";
            if (Number.isFinite(opts.afterEachMs)) setTimeout(() => { render.phase = "finished"; }, opts.afterEachMs);
          } else {
            render.phase = "finished";
          }
        }, 5);
      }
    },
  };
  const preview = {
    storyRenders: [render],
    channel,
    storyStoreValue: {
      ...(opts.csf ? { loadCSFFileByStoryId: async () => ({ stories: opts.csf }) } : {}),
      args: { get: () => stored },
      getStoryContext: () => {
        // As Storybook's prepareContext: by target, then mapped, then by `if`.
        const argTypes = opts.ignoreLift ? declared : story.argTypes;
        const untargeted: Record<string, unknown> = {};
        const argsByTarget: Record<string, Record<string, unknown>> = {};
        for (const [name, value] of Object.entries(stored)) {
          const target = story.argTypes[name]?.target;
          if (target) (argsByTarget[target] ??= {})[name] = value;
          else untargeted[name] = value;
        }
        const mapped: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(untargeted)) {
          const mapping = story.argTypes[name]?.mapping;
          mapped[name] = mapping && String(value) in mapping ? mapping[String(value)] : value;
        }
        const args: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(mapped)) {
          const condition = argTypes[name]?.if;
          const shows = !condition || ("eq" in condition ? mapped[condition.arg] === condition.eq : mapped[condition.arg] !== condition.neq);
          if (shows) args[name] = value;
        }
        const targeted = Object.keys(argsByTarget).length ? { argsByTarget: { UNTARGETED: untargeted, ...argsByTarget } } : {};
        return { args, unmappedArgs: { ...stored }, ...targeted, globals: { theme: "light" } };
      },
    },
  };
  return { storyId, preview, render, story, stored, events, shown };
}

/** Runs `fn` with `preview` as the page's Storybook preview, as the page functions find it. */
export async function inPage<T>(preview: unknown, fn: () => Promise<T>): Promise<T> {
  const scope = globalThis as unknown as { window?: unknown };
  scope.window = { __STORYBOOK_PREVIEW__: preview };
  try {
    return await fn();
  } finally {
    delete scope.window;
  }
}

/** The args a story URL asks for, as Storybook parses them: `variant:ghost;disabled:!true`, a number as one. */
export function urlArgs(url: string): Record<string, unknown> {
  const param = new URL(url).searchParams.get("args");
  const args: Record<string, unknown> = {};
  for (const pair of (param ?? "").split(";").filter(Boolean)) {
    const [name, value] = pair.split(":");
    args[name] = value === "!true" ? true : value === "!false" ? false : /^-?[0-9]+(\.[0-9]+)?$/.test(value) ? Number(value) : value;
  }
  return args;
}
