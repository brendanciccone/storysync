// A stand-in for Storybook's preview, for the tests of snap's check that a
// story was given the args its URL asked for. Put on the global `window`, as
// the page functions find it, it treats args as Storybook 10 does: its store
// takes from the URL only values the argTypes options allow; the story is
// given only the args whose argTypes `if` holds, judged when its context is
// read, so lifting one counts; `updateStoryArgs` writes the store unchecked
// and answers `storyArgsUpdated` once the rerender is done; `forceRemount`
// renders again and says `storyRendered`.

export interface FakeArgType { options?: string[]; if?: { arg: string; neq: string }; type?: { name: string }; control?: { type: string } }

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
  storyId?: string;
}) {
  const storyId = opts.storyId ?? "ui-base-badge--default";
  const story = { argTypes: structuredClone(opts.argTypes) as Record<string, FakeArgType>, parameters: { fileName: "./badge.stories.tsx" } };
  const declared = structuredClone(opts.argTypes) as Record<string, FakeArgType>;
  const stored: Record<string, unknown> = { ...opts.initial };
  for (const [name, value] of Object.entries(opts.url)) {
    const options = story.argTypes[name]?.options;
    if (story.argTypes[name] && (!options || options.includes(String(value)))) stored[name] = value;
  }
  const render = { id: storyId, phase: opts.phase ?? "finished", story };
  const events: string[] = [];
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
      if (event === "forceRemount") {
        render.phase = "rendering";
        setTimeout(() => {
          render.phase = "completed";
          channel.emit("storyRendered", storyId);
          render.phase = "finished";
        }, 5);
      }
    },
  };
  const preview = {
    storyRenders: [render],
    channel,
    storyStoreValue: {
      args: { get: () => stored },
      getStoryContext: () => {
        const args: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(stored)) {
          const condition = (opts.ignoreLift ? declared : story.argTypes)[name]?.if;
          if (!condition || stored[condition.arg] !== condition.neq) args[name] = value;
        }
        return { args, unmappedArgs: { ...stored }, globals: { theme: "light" } };
      },
    },
  };
  return { storyId, preview, render, story, stored, events };
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

/** The args a story URL asks for, as Storybook parses them: `variant:ghost;disabled:!true`. */
export function urlArgs(url: string): Record<string, unknown> {
  const param = new URL(url).searchParams.get("args");
  const args: Record<string, unknown> = {};
  for (const pair of (param ?? "").split(";").filter(Boolean)) {
    const [name, value] = pair.split(":");
    args[name] = value === "!true" ? true : value === "!false" ? false : value;
  }
  return args;
}
