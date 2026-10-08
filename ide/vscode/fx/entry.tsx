/**
 * Mounts the Libraries.dev thinking orbs and bot avatars into plain DOM nodes, so the (framework-free) chat UI can
 * use them. One React root per element; `update` re-renders the same root with new props, so a state change cross-fades
 * inside the library instead of re-creating the canvas.
 */
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { ThinkingOrb } from "../vendor/libraries-dev/thinking-orbs/src/ThinkingOrb";
import { BotAvatar } from "../vendor/libraries-dev/bot-avatars/src/BotAvatar";

type Props = Record<string, unknown>;
const roots = new WeakMap<Element, { root: Root; render: (p: Props) => void }>();

function mount(el: Element, component: any, base: Props, props: Props) {
  let rec = roots.get(el);
  if (!rec) {
    const root = createRoot(el);
    rec = { root, render: (p) => root.render(createElement(component, { ...base, ...p })) };
    roots.set(el, rec);
  }
  rec.render(props);
}

(window as any).FridayFx = {
  /** state: working | searching | solving | listening | connecting | weaving | composing | breathing | shaping */
  orb(el: Element, props: Props) { mount(el, ThinkingOrb, { size: 20, theme: "auto" }, props); },
  /** type: clover | flower | triangle | square | blob | ghost | circle | drop | star | droid | mech | alien | ... */
  bot(el: Element, props: Props) { mount(el, BotAvatar, { size: 28 }, props); },
  unmount(el: Element) { roots.get(el)?.root.unmount(); roots.delete(el); },
};
