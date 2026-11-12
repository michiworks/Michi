/* 60-recall.js (verbs): #recall, brief §5.9, R1-R2. */
{
  // A row grows in running while its spacer shrinks (60-recall.css).
  const row = (t, n) => [[t, 'tool', '.rec-r' + n, 'run'], [t, 'hide', '.rec-p' + n]];
  const S = '.rec-send';
  M.take({
    name: 'recall',
    seed: 23,
    steps: [
      [150, 'type', '.rec-draft', { rate: 26, until: 1250 }], [150, 'cls', S, '-is-empty'],
      [1300, 'press', S], [1300, 'clear', '.rec-draft'], [1300, 'cls', S, '+is-stop'],
      [1300, 'text', '.rec-title', 'How did we fix the Tokyo deploy?'], [1300, 'show', '.rec-u'],
      [1400, 'loop', '.rec-pane', 'is-streaming'],
      [1500, 'show', '.rec-l'], [1500, 'group', '.rec-g', 'run'],
      ...row(1780, 1), ...row(2040, 2), ...row(2300, 3),
      [2080, 'tool', '.rec-r1', 'done'], [2080, 'text', '.rec-gm', '1/3'],
      [2340, 'tool', '.rec-r2', 'done'], [2340, 'text', '.rec-gm', '2/3'],
      [2600, 'tool', '.rec-r3', 'done'], [2600, 'group', '.rec-g', 'done'], [2600, 'text', '.rec-gm', '0.3s'],
      [2700, 'stream', '.rec-s1', { rate: 40, jitter: 8, until: 3440 }],
      [3460, 'strike', '.rec-strike'],
      [3520, 'stream', '.rec-s2', { rate: 40, jitter: 8, until: 5100 }],
      [5150, 'loop', '.rec-pane', 'is-streaming', false], [5150, 'cls', S, '-is-stop +is-empty'],
      [5600, 'hold'],
    ],
  });
}
