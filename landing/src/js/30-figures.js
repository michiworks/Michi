/* 30-figures.js (figures): the page drawings (brief §5.11, W1-W3, I1-I3). */
{
  M.take({
    name: 'why',
    steps: [
      [0, 'show', '.why-out'],
      [200, 'show', '.why-chip'],
      // Pops land as the eased pen (--ease-out) passes: branch 310 / continuation
      // 280 from 300 reach the squares at ≈ 331-337 / 383-397 and the nodes at
      // ≈ 328 / 375 (wide and narrow figures alike).
      [300, 'show', '.why-cont, .why-br'],
      [330, 'show', '.why-n3'],
      [335, 'show', '.why-sq1, .why-sl1'],
      [380, 'show', '.why-n4'],
      [390, 'show', '.why-sq2, .why-sl2'],
      [580, 'show', '.why-pdc'],
      [620, 'show', '.why-d1'], [680, 'show', '.why-d2'], [740, 'show', '.why-d3'], [800, 'show', '.why-d4'],
      [880, 'hide', '.why-ct1'], [880, 'show', '.why-ct2'],
      [980, 'show', '.why-back'],
      [1260, 'cls', '.why-ret', '+why-lit'],
      [1760, 'cls', '.why-errand', '+why-faded'],
      [2360, 'hold'],
    ],
  });
  M.take({
    name: 'inherit',
    steps: [
      [0, 'show', '.inh-bracket'],
      [180, 'show', '.inh-blabel'],
      [300, 'show', '.inh-elbow'],
      [560, 'show', '.inh-q'],
      [600, 'cls', '.inh-row4', '+inh-dim'],
      [600, 'show', '.inh-r4label'],
      [800, 'hold'],
    ],
  });
}
