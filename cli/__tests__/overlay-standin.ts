// A stand-in for a page showing a story that renders only an overlay's
// closed trigger, for the tests of snap opening it before it measures:
// captureStory's own, and runSnap's, which records how it was opened.

import type { Page } from "playwright-core";
import { fakePreview, inPage, urlArgs } from "./preview-standin.js";
import type { FakeArgType } from "./preview-standin.js";
import {
  applyStoryArgsInPage, blurInPage, captureTreeInPage, goneInPage, overlaySettledInPage, readStoryTreeInPage, storyArgsInPage, storybookErrorInPage,
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
 * doesn't pass it on ignores. While open it shows `where`: in a portal
 * (the default), inline beside the trigger, which names it in
 * `aria-controls`, or nowhere, though the trigger says it is open.
 * With `closesOnLeave`, it closes as the pointer leaves the page, as one
 * that opens while hovered over does; with `escapeIgnored`, Escape doesn't
 * close it; with `staysOpen`, nothing does, a remount included. A remount
 * otherwise renders it closed. Everything done to the page is recorded
 * in `done`, in order.
 */
export function overlayPage(opts: {
  marks: Partial<StoryNode>;
  opensOn: ("click" | "hover" | "focus" | "contextmenu" | "arg")[];
  argTypes?: Record<string, FakeArgType>;
  where?: "portal" | "inline" | "nowhere";
  content?: { slot: string | null; role: string | null };
  /** The first click fails with this, as one on a trigger that never takes it does. */
  clickThrows?: string;
  closesOnLeave?: boolean;
  escapeIgnored?: boolean;
  staysOpen?: boolean;
}) {
  const storyId = "ui-radix-dialog--default";
  const done: string[] = [];
  // What each tree read was asked to read, in order.
  const treeArgs: { around?: boolean }[] = [];
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
    ...(open() ? { expanded: "true", state: "open", controls: "radix-r1" } : {}),
  });
  const content = opts.content ?? { slot: "dialog-content", role: "dialog" };
  const contentHandle = {
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === overlaySettledInPage) {
        done.push("settled");
        return true;
      }
      if (fn === captureTreeInPage) {
        treeArgs.push(arg as { around?: boolean });
        return { root: { k: "e", tag: "div", box: [0, 0, 448, 170], cs: {}, path: [], kids: [] }, fonts: {} };
      }
      if (fn === goneInPage) return !open();
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
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === triggerOpenInPage) return open();
      if (fn === captureTreeInPage) {
        treeArgs.push(arg as { around?: boolean });
        return { root: { k: "e", tag: "button", box: [0, 0, 80, 36], cs: {}, path: [], kids: [] }, fonts: {} };
      }
      return null;
    },
    evaluateHandle: async () => ({ asElement: () => null, dispose: async () => {} }),
    boundingBox: async () => ({ x: 600, y: 342, width: 80, height: 36 }),
    dispose: async () => {},
  };
  const container = {
    evaluate: async (fn: unknown, arg: unknown) => {
      if (fn !== readStoryTreeInPage) return Array.isArray(arg);
      const inline = open() && opts.where === "inline" ? [{ ...storyNode("div", content.slot), role: content.role, id: "radix-r1", styles: { "background-color": "rgb(255, 255, 255)" } }] : [];
      return storyNode("div", null, [triggerNode(), ...inline]);
    },
    evaluateHandle: async (_fn: unknown, path: number[]) => ({ asElement: () => (path[0] === 1 ? contentHandle : trigger), dispose: async () => {} }),
  };
  const shown = () => (open() && (opts.where ?? "portal") === "portal" ? [{ tag: "div", ...content, id: "radix-r1", rendered: true, overlay: true }] : []);
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
          const { updates, reset, remount } = arg as { updates: Record<string, unknown>; reset?: string[]; remount?: boolean };
          done.push(remount ? "remount" : reset ? `reset ${reset.join(",")}` : `set ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(",")}`);
          // Rendered from scratch: what interacting opened is gone.
          if (!opts.staysOpen) interacted = false;
        }
        return inPage(fake.preview, () => (fn as (a: unknown) => Promise<unknown>)(arg));
      }
      if (fn === blurInPage) {
        done.push("blur");
        if (!opts.staysOpen) interacted = interacted && !opts.opensOn.includes("focus");
        return null;
      }
      return arg === undefined ? null : {};
    },
    keyboard: {
      press: async (key: string) => {
        done.push(key);
        if (key === "Escape" && !opts.escapeIgnored && !opts.staysOpen) interacted = false;
      },
    },
    mouse: {
      move: async (x: number, y: number) => {
        done.push(`mouse ${x},${y}`);
        if (opts.closesOnLeave && x < 0) interacted = false;
      },
    },
  };
  return { page: page as unknown as Page, done, open, stored: () => fake.stored, treeArgs };
}
