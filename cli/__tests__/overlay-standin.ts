// A stand-in for a page showing a story that renders only an overlay's
// closed trigger, for the tests of snap opening it before it measures:
// captureStory's own, and runSnap's, which records how it was opened.

import type { Page } from "playwright-core";
import { fakePreview, inPage, urlArgs } from "./preview-standin.js";
import type { FakeArgType } from "./preview-standin.js";
import {
  applyStoryArgsInPage, blurInPage, captureTreeInPage, overlaySettledInPage, readStoryTreeInPage, storyArgsInPage, storybookErrorInPage,
  triggerOpenInPage,
} from "../snap-browser.js";
import type { StoryNode } from "../snap-normalize.js";

function storyNode(tag: string, slot: string | null, children: object[] = []) {
  return {
    tag, slot, role: null, hasPopup: null, expanded: null, controls: null, state: null, open: false, dir: null, orientation: null, label: null,
    position: "static", rendered: true, styles: {}, children,
  };
}

/**
 * A story that renders only an overlay's closed trigger, with `marks`, as
 * a Dialog's Default story does. Its content opens on `opensOn`: ways of
 * interacting with the trigger, and `arg`, the story's `open` or
 * `defaultOpen` arg set through the stand-in preview, which a story that
 * doesn't pass it on ignores. It shows in a portal while open, unless
 * `inline`, when the trigger says it is open and nothing outside the
 * story's root shows.
 * Everything done to the page is recorded in `done`, in order.
 */
export function overlayPage(opts: {
  marks: Partial<StoryNode>;
  opensOn: ("click" | "hover" | "focus" | "contextmenu" | "arg")[];
  argTypes?: Record<string, FakeArgType>;
  inline?: boolean;
  content?: { slot: string | null; role: string | null };
  /** The first click fails with this, as one on a trigger that never takes it does. */
  clickThrows?: string;
}) {
  const storyId = "ui-radix-dialog--default";
  const done: string[] = [];
  let fake = fakePreview({ storyId, argTypes: opts.argTypes ?? {}, initial: {}, url: {} });
  let interacted = false;
  let clickThrows = opts.clickThrows;
  const open = () => {
    const args = fake.preview.storyStoreValue.getStoryContext().args;
    return interacted || (opts.opensOn.includes("arg") && (args.open === true || args.defaultOpen === true));
  };
  const triggerNode = () => ({
    ...storyNode("button", null), styles: { display: "inline-flex", "background-color": "rgb(23, 23, 23)" }, text: true,
    ...opts.marks,
    ...(open() ? { expanded: "true", state: "open" } : {}),
  });
  const content = opts.content ?? { slot: "dialog-content", role: "dialog" };
  const contentHandle = {
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === overlaySettledInPage) {
        done.push("settled");
        return true;
      }
      if (fn === captureTreeInPage) return { root: { k: "e", tag: "div", box: [0, 0, 448, 170], cs: {}, path: [], kids: [] }, fonts: {} };
      // Whether it has gone, as closeOverlay asks, by a function of its own.
      if (arg === undefined && typeof fn === "function" && /isConnected/.test(String(fn))) return !open();
      return null;
    },
    evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
    boundingBox: async () => ({ x: 416, y: 275, width: 448, height: 170 }),
    dispose: async () => {},
  };
  const act = (how: string) => async (options?: { button?: string }) => {
    const way = how === "click" && options?.button === "right" ? "contextmenu" : how;
    done.push(way);
    if (way === "click" && clickThrows) {
      const message = clickThrows;
      clickThrows = undefined;
      throw new Error(message);
    }
    if ((opts.opensOn as string[]).includes(way)) interacted = true;
  };
  const trigger = {
    click: act("click"), hover: act("hover"), focus: act("focus"),
    evaluate: async (fn: unknown) => {
      if (fn === triggerOpenInPage) return open();
      if (fn === captureTreeInPage) return { root: { k: "e", tag: "button", box: [0, 0, 80, 36], cs: {}, path: [], kids: [] }, fonts: {} };
      return null;
    },
    evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
    boundingBox: async () => ({ x: 600, y: 342, width: 80, height: 36 }),
    dispose: async () => {},
  };
  const container = {
    evaluate: async (fn: unknown, arg: unknown) => (fn === readStoryTreeInPage ? storyNode("div", null, [triggerNode()]) : Array.isArray(arg)),
    evaluateHandle: async () => ({ asElement: () => trigger, dispose: async () => {} }),
  };
  const shown = () => (open() && !opts.inline ? [{ tag: "div", ...content, id: "radix-r1", rendered: true, overlay: true }] : []);
  const page = {
    on: () => {}, off: () => {},
    goto: async (url: string) => {
      fake = fakePreview({ storyId, argTypes: opts.argTypes ?? {}, initial: {}, url: urlArgs(url) });
      interacted = false;
      return null;
    },
    waitForSelector: async () => null,
    addStyleTag: async () => null,
    $: async (selector: string) => (selector === "#storybook-root" ? container : null),
    evaluateHandle: async () => ({
      evaluate: async () => shown(),
      evaluateHandle: async () => ({ asElement: () => contentHandle, dispose: async () => {} }),
      dispose: async () => {},
    }),
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === storybookErrorInPage) return null;
      if (fn === storyArgsInPage || fn === applyStoryArgsInPage) {
        if (fn === applyStoryArgsInPage) {
          const { updates, reset } = arg as { updates: Record<string, unknown>; reset?: string[] };
          done.push(reset ? `reset ${reset.join(",")}` : `set ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(",")}`);
        }
        return inPage(fake.preview, () => (fn as (a: unknown) => Promise<unknown>)(arg));
      }
      if (fn === blurInPage) {
        done.push("blur");
        interacted = interacted && !opts.opensOn.includes("focus");
        return null;
      }
      return arg === undefined ? null : {};
    },
    keyboard: {
      press: async (key: string) => {
        done.push(key);
        if (key === "Escape") interacted = false;
      },
    },
    mouse: { move: async (x: number, y: number) => { done.push(`mouse ${x},${y}`); } },
  };
  return { page: page as unknown as Page, done, open, stored: () => fake.stored };
}
