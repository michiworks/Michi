import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CHAT_PERMISSION_CHOICE_ORDER,
  chatPermissionChoice,
  chatPermissionRank,
  companionCheckinMaySendDirectly,
  isWiderChatPermission,
  type ChatPermissionChoice,
} from '../src/index';

describe('how much a chat asks before its tools run (DESIGN-v2 §4, W0 review #8)', () => {
  test('orders the choices ask < approve < trust < yolo', () => {
    assert.deepEqual([...CHAT_PERMISSION_CHOICE_ORDER], ['ask', 'approve', 'trust', 'yolo']);
    assert.deepEqual(CHAT_PERMISSION_CHOICE_ORDER.map(chatPermissionRank), [0, 1, 2, 3]);
    assert.equal(isWiderChatPermission('approve', 'ask'), true, 'Approve for me approves on its own');
    assert.equal(isWiderChatPermission('trust', 'approve'), true);
    assert.equal(isWiderChatPermission('yolo', 'trust'), true);
    assert.equal(isWiderChatPermission('ask', 'ask'), false);
    assert.equal(isWiderChatPermission('ask', 'yolo'), false, 'narrower is never wider');
  });

  test('fails closed on values that are not choices', () => {
    assert.equal(chatPermissionRank('never'), CHAT_PERMISSION_CHOICE_ORDER.length);
    assert.equal(isWiderChatPermission('never' as ChatPermissionChoice, 'yolo'), true);
    assert.equal(isWiderChatPermission('ask', undefined as unknown as ChatPermissionChoice), true);
  });

  test('a check-in sends directly only into a conversation in exactly Ask (Q1)', () => {
    assert.equal(companionCheckinMaySendDirectly('ask'), true);
    for (const choice of ['approve', 'trust', 'yolo', null, undefined] as const) {
      assert.equal(companionCheckinMaySendDirectly(choice), false, String(choice));
    }
    assert.equal(companionCheckinMaySendDirectly(chatPermissionChoice('ask', true)), false, 'Ask with Approve for me is approve');
    assert.equal(companionCheckinMaySendDirectly(chatPermissionChoice('ask', false)), true);
  });
});
