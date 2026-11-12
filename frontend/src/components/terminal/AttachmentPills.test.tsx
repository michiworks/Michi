import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { API_BASE_URL } from '../../config/env';

// The shell's active workspace; a message's attachments live in its own one.
vi.mock('../../state/chatStore', () => ({
  useChatProjects: vi.fn(() => ({ activeProject: { id: 'ws-user' } })),
  useOptionalChatProjects: vi.fn(() => ({ activeProject: { id: 'ws-user' } })),
}));

import { AttachmentPills } from './AttachmentPills';

describe('AttachmentPills', () => {
  it('renders nothing when items is empty', () => {
    const { container } = render(<AttachmentPills items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('falls back to pill when image has no relPath and no .attachments marker', () => {
    const { getAllByTestId, queryAllByTestId } = render(
      <AttachmentPills
        items={[
          { name: 'photo.jpg', absPath: '/random/photo.jpg' },
        ]}
      />,
    );
    // No thumbnail rendered — falls back to pill
    expect(queryAllByTestId('attachment-thumb')).toHaveLength(0);
    const pills = getAllByTestId('attachment-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toContain('photo.jpg');
  });

  it('renders mix of image thumbnails and file pills', () => {
    const { getAllByTestId, queryAllByTestId } = render(
      <AttachmentPills
        workspaceId="ws-1"
        items={[
          { name: 'image.png', absPath: '/p/.attachments/image.png', relPath: '.attachments/image.png' },
          { name: 'code.ts', absPath: '/p/code.ts' },
          { name: 'photo.webp', absPath: '/p/.attachments/photo.webp', relPath: '.attachments/photo.webp' },
        ]}
      />,
    );
    expect(queryAllByTestId('attachment-thumb')).toHaveLength(2);
    expect(getAllByTestId('attachment-pill')).toHaveLength(1);
  });

  it('builds the thumbnail from the message\'s workspace, not the shell\'s', () => {
    const { getByTestId } = render(
      <AttachmentPills
        workspaceId="ws-assistant"
        items={[{ name: 'diagram.png', absPath: '/data/assistant/.michi/.attachments/diagram.png' }]}
      />,
    );
    expect(getByTestId('attachment-thumb').querySelector('img')!.getAttribute('src'))
      .toBe(`${API_BASE_URL}/files/ws-assistant/.attachments/diagram.png`);
  });

  it('treats a name without an extension as a file, not an image', () => {
    const { getByTestId, queryAllByTestId } = render(
      <AttachmentPills workspaceId="ws-1" items={[{ name: 'png', absPath: '/p/.attachments/png', relPath: '.attachments/png' }]} />,
    );
    expect(queryAllByTestId('attachment-thumb')).toHaveLength(0);
    expect(getByTestId('attachment-pill').textContent).toContain('📄');
  });
});
