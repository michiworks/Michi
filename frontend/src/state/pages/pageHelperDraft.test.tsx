import { afterEach, describe, expect, it } from 'vitest';
import { dispatchPageHelperDraft, PAGE_HELPER_DRAFT_EVENT, type PageHelperDraftRequest } from './pageHelperDraft';

let drafts: PageHelperDraftRequest[] = [];
const record = (event: Event) => { drafts.push((event as CustomEvent<PageHelperDraftRequest>).detail); };

afterEach(() => {
  window.removeEventListener(PAGE_HELPER_DRAFT_EVENT, record);
  drafts = [];
});

function listen() {
  window.addEventListener(PAGE_HELPER_DRAFT_EVENT, record);
}

describe('page helper draft requests', () => {
  it('emits a draft-only event scoped to the backend, workspace and page, its text trimmed', () => {
    listen();
    dispatchPageHelperDraft({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', text: '  Help debug  ' });
    expect(drafts).toEqual([{ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', text: 'Help debug' }]);
  });

  it('rejects empty and oversized requests', () => {
    listen();
    dispatchPageHelperDraft({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', text: '  ' });
    dispatchPageHelperDraft({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', text: 'x'.repeat(8001) });
    expect(drafts).toEqual([]);
  });

  it('accepts the shared component draft limit of 8,000 characters', () => {
    listen();
    dispatchPageHelperDraft({ backendConnectionId: 'local', workspaceId: 'w', pageId: 'p', text: 'x'.repeat(8000) });
    expect(drafts[0]?.text).toHaveLength(8000);
  });
});
