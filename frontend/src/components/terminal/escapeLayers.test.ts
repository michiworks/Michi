import { afterEach, describe, expect, it } from 'vitest';
import { markComposerEscape } from '../composerEscape';
import { companionPanelOnScreen, escapeClosesPanelOverPage, escapeIsForPage, focusIsTaken, isInAssistantPanel } from './escapeLayers';

function escape(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  let seen: boolean | null = null;
  let seenAll: boolean | null = null;
  const listen = (e: Event) => { seen = escapeIsForPage(e as KeyboardEvent); };
  const listenAll = (e: Event) => { seenAll = escapeIsForPage(e as KeyboardEvent, 'all'); };
  document.addEventListener('keydown', listen);
  document.addEventListener('keydown', listenAll);
  target.dispatchEvent(event);
  document.removeEventListener('keydown', listen);
  document.removeEventListener('keydown', listenAll);
  return { menus: seen, all: seenAll };
}

function add(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('focusIsTaken', () => {
  it('holds for any form control, not for a button on the page or nothing', () => {
    const host = add('<input type="checkbox"><select></select><textarea></textarea><button>Row</button>');
    for (const el of host.querySelectorAll<HTMLElement>('input, select, textarea')) expect(focusIsTaken(null, el)).toBe(true);
    expect(focusIsTaken(null, host.querySelector('button'))).toBe(false);
    expect(focusIsTaken(null, document.body)).toBe(false);
  });

  it('holds inside an open dialog or menu, unless the composer sits in it too', () => {
    const host = add('<div role="dialog"><button id="a">Switch</button><div id="home"></div></div><div role="menu"><button id="b">Item</button></div><div role="dialog" inert><button id="c">Gone</button></div>');
    const home = host.querySelector('#home');
    expect(focusIsTaken(null, host.querySelector('#a'))).toBe(true);
    expect(focusIsTaken(home, host.querySelector('#a'))).toBe(false);
    expect(focusIsTaken(home, host.querySelector('#b'))).toBe(true);
    expect(focusIsTaken(null, host.querySelector('#c'))).toBe(false);
  });
});

describe('escapeIsForPage', () => {
  it('leaves a plain Esc on the page to the page', () => {
    const host = add('<button>Row</button>');
    expect(escape(host.querySelector('button')!)).toEqual({ menus: true, all: true });
    expect(escape(document.body)).toEqual({ menus: true, all: true });
  });

  it('is not the page’s when it is another key', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    expect(escapeIsForPage(event)).toBe(false);
  });

  it('never lets an Esc pressed inside the assistant panel reach the page', () => {
    const host = add('<div data-assistant-panel><button>Permissions: Ask</button></div>');
    const chip = host.querySelector('button')!;
    expect(isInAssistantPanel(chip)).toBe(true);
    expect(escape(chip)).toEqual({ menus: false, all: false });
  });

  it('treats either of the panel’s marks as the panel (DESIGN-v2 §1.1)', () => {
    const host = add('<aside data-companion-panel><button>Send</button></aside>');
    const button = host.querySelector('button')!;
    expect(isInAssistantPanel(button)).toBe(true);
    expect(escape(button)).toEqual({ menus: false, all: false });
  });

  it('does not count the docked panel as a layer over the page', () => {
    // With focus on the page, an open panel beside it leaves the page its Esc.
    add('<aside data-assistant-panel data-companion-panel><button>Send</button></aside><button id="row">Row</button>');
    expect(escape(document.getElementById('row')!)).toEqual({ menus: true, all: true });
  });

  it('is not the page’s once something handled it, or the composer kept it', () => {
    const host = add('<button>Row</button>');
    const button = host.querySelector('button')!;
    button.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    expect(escape(button)).toEqual({ menus: false, all: false });
    button.addEventListener('keydown', (e) => markComposerEscape(e), { once: true });
    expect(escape(button)).toEqual({ menus: false, all: false });
    expect(escape(button, { isComposing: true } as KeyboardEventInit)).toEqual({ menus: false, all: false });
  });

  it('is not the page’s when it comes from inside an Esc layer (find bar, selection toolbar)', () => {
    const host = add('<div data-escape-layer="pane"><button>next</button></div>');
    expect(escape(host.querySelector('button')!)).toEqual({ menus: false, all: false });
  });

  it('leaves it to an open menu, list or modal wherever the focus is, whichever listener runs first', () => {
    for (const layer of ['<div role="menu"></div>', '<div role="listbox"></div>', '<div role="alertdialog"></div>', '<div aria-modal="true"></div>', '<div data-escape-layer="over"></div>']) {
      const host = add(layer);
      expect(escape(document.body)).toEqual({ menus: false, all: false });
      host.remove();
    }
    // A modal drawer sliding out (aria-hidden) no longer counts.
    const sliding = add('<div role="dialog" aria-modal="true" aria-hidden="true"></div>');
    expect(escape(document.body).menus).toBe(true);
    sliding.remove();
  });

  it('ignores every layer inside one on its way out (inert or aria-hidden)', () => {
    for (const ghost of [
      '<div inert><div role="listbox"></div><div data-escape-layer="pane"></div></div>',
      '<div aria-hidden="true"><div role="menu"></div><div data-escape-layer="over"></div></div>',
      '<div role="menu" inert></div>',
      '<div role="dialog" aria-hidden="true"><div role="dialog"></div><div aria-modal="true"></div></div>',
    ]) {
      const host = add(ghost);
      expect(escape(document.body)).toEqual({ menus: true, all: true });
      host.remove();
    }
  });

  it('says whether the panel is on screen, not once it is on its way out', () => {
    expect(companionPanelOnScreen()).toBe(false);
    const host = add('<aside data-assistant-panel data-companion-panel></aside>');
    expect(companionPanelOnScreen()).toBe(true);
    host.querySelector('aside')!.setAttribute('inert', '');
    expect(companionPanelOnScreen()).toBe(false);
    host.innerHTML = '<div aria-hidden="true"><aside data-companion-panel></aside></div>';
    expect(companionPanelOnScreen()).toBe(false);
  });

  it('closes the panel over the page with the page’s Esc only when nothing else wants it', () => {
    const over = (target: EventTarget, init: KeyboardEventInit = {}) => {
      let seen: boolean | null = null;
      const listen = (e: Event) => { seen = escapeClosesPanelOverPage(e as KeyboardEvent); };
      document.addEventListener('keydown', listen);
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
      document.removeEventListener('keydown', listen);
      return seen;
    };
    const host = add('<button id="row">Row</button>');
    const row = document.getElementById('row')!;
    // No panel: nothing to close.
    expect(over(row)).toBe(false);
    // The panel over the page, as a dialog or not: the page's Esc is the panel's.
    const panel = add('<aside data-assistant-panel data-companion-panel role="dialog"><button id="send">Send</button></aside>');
    expect(over(row)).toBe(true);
    expect(over(row, { key: 'Enter' })).toBe(false);
    // An Esc inside the panel is the panel's own to handle.
    expect(over(document.getElementById('send')!)).toBe(false);
    // A menu, in the panel or anywhere, or another layer keeps the key.
    for (const layer of ['<div role="menu"></div>', '<div role="dialog"></div>', '<div data-escape-layer="shell"></div>']) {
      const extra = add(layer);
      expect(over(row)).toBe(false);
      extra.remove();
    }
    panel.querySelector('aside')!.insertAdjacentHTML('beforeend', '<div role="listbox"></div>');
    expect(over(row)).toBe(false);
    host.remove();
  });

  it('counts a non-modal drawer, the find bar and the sidebar overlay only for the shell under everything', () => {
    for (const layer of ['<div role="dialog"></div>', '<div data-escape-layer="pane"></div>', '<div data-escape-layer="shell"></div>']) {
      const host = add(layer);
      expect(escape(document.body)).toEqual({ menus: true, all: false });
      host.remove();
    }
  });
});
