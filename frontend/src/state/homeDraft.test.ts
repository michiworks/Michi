import { afterEach, describe, expect, it } from 'vitest';
import { __resetHomeDraftForTests, addToHomeDraft, receiveHomeDraft } from './homeDraft';

afterEach(() => { __resetHomeDraftForTests(); });

describe('homeDraft', () => {
  it('keeps words sent before the Home composer mounts for it, once', () => {
    addToHomeDraft('plan the launch');
    addToHomeDraft('   ');
    const got: string[] = [];
    const stop = receiveHomeDraft((text) => got.push(text));
    expect(got).toEqual(['plan the launch']);
    stop();
    const again: string[] = [];
    receiveHomeDraft((text) => again.push(text));
    expect(again).toEqual([]);
  });

  it('hands words to a composer on screen at once, and none after it unmounts', () => {
    const got: string[] = [];
    const stop = receiveHomeDraft((text) => got.push(text));
    addToHomeDraft('now');
    stop();
    addToHomeDraft('later');
    expect(got).toEqual(['now']);
  });
});
