import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatTokenCount } from '../src/index';

describe('formatTokenCount', () => {
  test('rounds the label before it picks k or M', () => {
    const cases: Array<[number, string]> = [
      [0, '0'],
      [999, '999'],
      [1_000, '1k'],
      [9_949, '9.9k'],
      [9_960, '10k'],
      [10_000, '10k'],
      [999_499, '999k'],
      [999_500, '1M'],
      [999_950, '1M'],
      [1_000_000, '1M'],
      [1_250_000, '1.3M'],
      [12_500_000, '13M'],
    ];
    for (const [tokens, label] of cases) assert.equal(formatTokenCount(tokens), label, String(tokens));
  });

  test('keeps one decimal when asked to be precise', () => {
    const cases: Array<[number, string]> = [
      [500, '500'],
      [15_000, '15.0k'],
      [79_500, '79.5k'],
      [999_960, '1.0M'],
      [1_500_000, '1.5M'],
    ];
    for (const [tokens, label] of cases) assert.equal(formatTokenCount(tokens, { precise: true }), label, String(tokens));
  });
});
