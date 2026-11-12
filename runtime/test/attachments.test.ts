import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeLinkedImages, prepareAttachments } from '../src/core/attachments';

describe('prepareAttachments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-'));
  const notes = path.join(dir, 'notes.txt');
  const image = path.join(dir, 'shot.png');
  fs.writeFileSync(notes, 'notes');
  fs.writeFileSync(image, 'png');
  const missing = path.join(dir, 'gone.pdf');
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('names a file once: a file the text already names gets no note line, an unreadable one always does', () => {
    const listed = `fix it\n\n[Attached files: notes.txt — ${notes} | gone.pdf — ${missing}]`;
    const attachments = [{ name: 'notes.txt', absPath: notes }, { name: 'gone.pdf', absPath: missing }];
    assert.equal(prepareAttachments(attachments, listed).promptNote,
      `\n[Attachments]\nThe user attached the following non-image files. They are not inlined in this\nmessage — read them from disk if they are relevant:\n- gone.pdf (could not be read at ${missing})`);
    assert.equal(prepareAttachments([{ name: 'notes.txt', absPath: notes }], listed).promptNote, '');
    assert.match(prepareAttachments([{ name: 'notes.txt', absPath: notes }], 'fix it').promptNote, new RegExp(`- notes\\.txt → ${notes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    assert.match(prepareAttachments([{ name: 'notes.txt', absPath: notes }]).promptNote, /\[Attachments\]/);
  });

  it('lists a linked image only when the text does not name it', () => {
    const { images } = prepareAttachments([{ name: 'shot.png', absPath: image }]);
    assert.equal(describeLinkedImages(images, `[Attached files: shot.png — ${image}]`), '');
    assert.equal(describeLinkedImages(images, 'look'), `\n[Attached images]\nThe user attached these images. Read them with your file tool:\n- shot.png → ${image}`);
  });
});
