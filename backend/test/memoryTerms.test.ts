import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMON_TERMS,
  STOPWORDS,
  WEAK_TERMS,
  locateTerm,
  normalizeText,
  profileConcepts,
  profileKeywords,
  queryConcepts,
  segmentTerms,
  type RecallConcept,
} from '../src/services/memory/memoryTerms';

describe('profile categories', () => {
  test('profileKeywords: a memory that states where the user works, lives or studies, their family, pets or devices gets its category\'s words', () => {
    const cases: Array<[string, string[]]> = [
      ['The user just started a new job at Lumenfield Robotics as a firmware engineer.', ['company', '公司', '工作', 'job', '单位']],
      ['用户在青禾数据工作，做数据分析', ['company', '公司', '工作', 'job']],
      ['用户上个月搬到了成都', ['city', '城市', '住在', 'live', '地址']],
      ['The user lives in Lisbon.', ['city', '城市', '住在']],
      ['用户在读研究生，专业是材料学', ['school', '学校', '专业']],
      ['用户的女儿今年上小学了', ['family', '家人', 'school', '学校']],
      ['The user has a cat named Biscuit.', ['pet', '宠物']],
      ['用户的手机是 Pixel 9', ['phone', '手机']],
      ['The user drives a hybrid SUV.', ['car', '汽车']],
    ];
    for (const [text, words] of cases) {
      const found = profileKeywords(text);
      for (const word of words) assert.ok(found.includes(word), `${text}: ${word} in ${JSON.stringify(found)}`);
    }
    for (const text of ['The staging DB runs on port 5433.', '这个仓库统一用 pnpm', 'The user prefers short answers.', '']) {
      assert.deepEqual(profileKeywords(text), [], text);
    }
  });

  test('profileConcepts: a question about the user\'s own work, home, family… searches its category\'s words as one concept, any of them', () => {
    const plan = (query: string) => profileConcepts(query, queryConcepts(query));
    const work = plan('Remind me, which company am I working at now?');
    assert.deepEqual(work.map((concept) => concept.text), ['@work']);
    assert.equal(work[0]!.alternatives, true);
    assert.equal(work[0]!.content, true);
    for (const atom of ['employ', 'job', '公司', '单位', '雇主', '职业', '上班']) assert.ok(work[0]!.atoms.includes(atom), atom);
    assert.equal(work[0]!.atoms.includes('company'), false, 'the query already searches its own words');
    assert.equal(work[0]!.atoms.some((atom) => WEAK_TERMS.has(atom)), false, 'work, 工作: conversational words');
    for (const [query, category] of [['我现在在哪家公司上班？', '@work'], ['Where do I work these days?', '@work'], ['我现在住在哪个城市？', '@residence'],
      ['which city do I live in now?', '@residence'], ['我的女儿几岁了？', '@family'], ['What school did I go to?', '@school'], ['我家猫叫什么来着', '@pet'],
      ['What phone do I use?', '@phone']] as const) {
      assert.deepEqual(plan(query).map((concept) => concept.text), [category], query);
    }
    for (const query of ['How do I deploy the release branch?', '帮我写一个排序函数', 'What is the capital of France?', '']) {
      assert.deepEqual(plan(query), [], query);
    }
    // Every atom is a document term of a category word, as profileKeywords stores them.
    const terms = new Set(segmentTerms(profileKeywords('The user works at a startup; 用户住在成都').join('\n')));
    for (const concept of [...plan('where do I work?'), ...plan('我住哪？')]) for (const atom of concept.atoms) assert.ok(terms.has(atom), atom);
  });
});

describe('normalizeText', () => {
  const cases: Array<[string, string]> = [
    ['ｐｎｐｍ　ＣＲ－１２', 'pnpm cr-12'],
    ['Deploy From MAIN', 'deploy from main'],
    ['東京都目黒区', '东京都目黑区'],
    ['目黒', '目黑'],
    ['電腦記憶體', '电脑记忆体'],
    ['資料庫選擇', '资料库选择'],
    ['Café NAÏVE Ångström', 'cafe naive angstrom'],
    ['It’s Bob‘s', "it's bob's"],
    ['ｶﾞｷﾞ', 'ガギ'],
    ['我住目黑', '我住目黑'],
    ['', ''],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => assert.equal(normalizeText(input), expected));
  }

  test('kana keep their voicing marks', () => {
    assert.equal(normalizeText('ラーメンが好き'), 'ラーメンが好き');
  });
});

describe('segmentTerms', () => {
  const cases: Array<[string, string[]]> = [
    // CJK runs are indexed as bigrams, so two characters of any run can be found.
    ['我住目黑', ['我住', '住目', '目黑']],
    ['我已搬到中野', ['我已', '已搬', '搬到', '到中', '中野']],
    ['存储选型', ['存储', '储选', '选型']],
    ['图数据库', ['图数', '数据', '据库']],
    // Stop-word pairs (已经, 我们) are left out; punctuation ends a run.
    ['我已经搬到中野了，以后寄快递', ['我已', '经搬', '搬到', '到中', '中野', '野了', '后寄', '寄快', '快递']],
    ['我们讨论了存储选型', ['们讨', '讨论', '论了', '了存', '存储', '储选', '选型']],
    // Identifiers stay whole without their joiners, with their words.
    ['CR-12 已经合并了', ['cr12', 'cr', '经合', '合并', '并了']],
    ['ｃｒ－１２', ['cr12', 'cr']],
    ['v1.2 和 5433', ['v12', 'v1', '5433']],
    ['deploy to us-east-1 from release/2026.11', ['deploy', 'useast1', 'east', 'releas', '202611']],
    ['user@example.com foo_bar', ['userexamplecom', 'user', 'exampl', 'com', 'foobar', 'foo', 'bar']],
    ['React18和Vue3', ['react18', 'vue3']],
    ['C++ and C# on .NET', ['cplusplus', 'csharp', 'dotnet']],
    // Plurals fold; possessives and contractions are one word; stop words go.
    ["The user's memories don't sync; branches fail", ['user', 'memory', 'sync', 'branch', 'fail']],
    ['用 pnpm 而不是 npm', ['pnpm', '而不', 'npm']],
    // Numbers of two or more digits, and a number against its CJK unit.
    ['我女儿3岁，住在2楼', ['我女', '女儿', '3岁', '住在', '2楼']],
    ['11月6日下午3点', ['11', '11月', '6日', '日下', '下午', '3点']],
    // Mixed text, and Traditional / Japanese variants folded.
    ['Michi 的 memory v1.2 发布了，端口是 5433', ['michi', 'memory', 'v12', 'v1', '发布', '布了', '端口', '口是', '5433']],
    ['東京都目黒区', ['东京', '京都', '都目', '目黑', '黑区']],
    ['ラーメン', ['ラー', 'ーメ', 'メン']],
    ['한국어', ['한국', '국어']],
    ['a I 的 了', []],
    ['', []],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => assert.deepEqual(segmentTerms(input), expected));
  }

  test('is deterministic and gives each term once', () => {
    const text = '中野中野 pnpm pnpm Pnpm 中野';
    assert.deepEqual(segmentTerms(text), ['中野', '野中', 'pnpm']);
    assert.deepEqual(segmentTerms(text), segmentTerms(text));
  });

  test('drops hashes and other overlong strings', () => {
    assert.deepEqual(segmentTerms(`key ${'a1'.repeat(40)} value`), ['key', 'valu']);
  });
});

describe('word endings: -ed, -ing, -er and -ly fold the same way in documents and queries', () => {
  /** The one term a word is indexed and searched by. */
  function term(word: string): string {
    const terms = segmentTerms(word);
    const concepts = queryConcepts(word).map((concept) => concept.text);
    assert.deepEqual(concepts, terms, `${word}: query side`);
    assert.equal(terms.length, 1, `${word}: ${terms.join(' ')}`);
    return terms[0];
  }

  test('cook, cooks, cooked and cooking are one term', () => {
    assert.deepEqual(['cook', 'cooks', 'cooked', 'cooking', 'Cooking'].map(term), ['cook', 'cook', 'cook', 'cook', 'cook']);
  });

  test('each family is one term: a dropped e restored, a doubled consonant undone, -ier and -ily as y', () => {
    const families = [
      ['bake', 'bakes', 'baked', 'baking'], ['hope', 'hoped', 'hoping'], ['hop', 'hopped', 'hopping'], ['use', 'used', 'using', 'uses'],
      ['write', 'writes', 'writing', 'writer'], ['code', 'coded', 'coding'], ['style', 'styled', 'styling'], ['plan', 'planned', 'planning', 'planner'],
      ['release', 'released', 'releasing', 'releases'], ['change', 'changed', 'changing'], ['configure', 'configured', 'configuring'],
      ['create', 'created', 'creating'], ['agree', 'agreed', 'agreeing'], ['value', 'valued', 'valuing'], ['add', 'added', 'adding'],
      ['travel', 'travelled', 'traveling', 'traveller'], ['cancel', 'cancelled', 'canceling', 'cancelling'], ['consider', 'considered', 'considering'],
      ['try', 'tried', 'trying', 'tries'], ['study', 'studied', 'studying', 'studies'], ['happy', 'happier', 'happily'], ['die', 'died', 'dying'],
      ['teach', 'teacher', 'teachers'], ['big', 'bigger'], ['quick', 'quickly'], ['real', 'really'], ['careful', 'carefully'],
      ['simple', 'simply'], ['probable', 'probably'], ['deploy', 'deployed', 'deploying', 'deploys'], ['install', 'installed', 'installer'],
    ];
    for (const family of families) {
      const terms = family.map(term);
      assert.equal(new Set(terms).size, 1, `${family.join(', ')}: ${terms.join(', ')}`);
    }
  });

  test('stays apart where an ending is part of the word, or folding would make another word', () => {
    const apart = [
      ['hope', 'hop'], ['plane', 'plan'], ['evening', 'even'], ['morning', 'morn'], ['corner', 'corn'], ['flower', 'flow'], ['shower', 'show'],
      ['number', 'numb'], ['cooker', 'cook'], ['quite', 'quit'], ['suite', 'suit'], ['paste', 'past'], ['pasted', 'past'], ['news', 'new'],
      ['tired', 'tire'], ['early', 'ear'], ['user', 'use'], ['customer', 'custom'], ['officer', 'office'], ['header', 'head'], ['differ', 'diff'],
      // A noun of its own, not the conversational verb (WEAK_TERMS) it would fold into.
      ['reminder', 'remind'], ['helper', 'help'], ['worker', 'work'], ['findings', 'find'],
    ];
    for (const [a, b] of apart) assert.notEqual(term(a), term(b), `${a} / ${b}`);
    // Not inflections at all: no vowel before -ing or -ed, -eed, a short -er word, -lly that is no adverb.
    for (const word of ['ring', 'spring', 'string', 'king', 'bring', 'red', 'shed', 'need', 'speed', 'water', 'paper', 'career', 'engineer', 'belly', 'silly', 'fly', 'during']) {
      assert.equal(term(word), word, word);
    }
    // Only English words fold: größer keeps its -er (ß), other scripts are left alone.
    assert.deepEqual(segmentTerms('größer привет ラーメン'), ['großer', 'привет', 'ラー', 'ーメ', 'メン']);
  });

  test('in sentences: a document and a query that word it differently meet', () => {
    assert.deepEqual(segmentTerms('She baked bread, then we were cooking dinner; the runners kept running happily'),
      ['bake', 'bread', 'cook', 'dinner', 'run', 'kept', 'happy']);
    const doc = new Set(segmentTerms('Celebrating at the café: their cardamom buns are unreal'));
    for (const concept of queryConcepts('the café where I celebrated with cardamom bun')) {
      assert.ok(concept.atoms.some((atom) => doc.has(atom)), concept.text);
    }
  });
});

/** Concepts as compact strings: text<type>[atoms]@anchor. */
function plan(text: string): string[] {
  return queryConcepts(text).map((concept: RecallConcept) => {
    const anchor = concept.anchor ? `@${concept.anchor.from}-${concept.anchor.to}` : '';
    return `${concept.text}<${concept.type}>[${concept.atoms.join(',')}]${anchor}`;
  });
}

describe('queryConcepts', () => {
  const cases: Array<[string, string[]]> = [
    // Characters the segmenter leaves single (目|黑) are one concept, any of whose pairs counts.
    ['我住目黑', ['住目黑<cjk>[住目,目黑]']],
    ['我已搬到中野', ['搬到<cjk>[搬到]@0-0', '中野<cjk>[中野]@0-0']],
    // A word subsumes its bigrams: 存储选型 is two concepts.
    ['存储选型', ['存储<cjk>[存储]@0-0', '选型<cjk>[选型]']],
    // A lone character joins the word next to it; the word stays the anchor.
    ['图数据库', ['图数据库<cjk>[图数,数据,据库]@1-1']],
    ['关系型数据库', ['关系型<cjk>[关系,系型]@0-0', '数据库<cjk>[数据,据库]@0-0']],
    ['中野区有什么好吃的', ['中野区<cjk>[中野,野区]@0-0', '好吃<cjk>[好吃]@0-0']],
    ['本地端口是多少', ['本地<cjk>[本地]@0-0', '端口<cjk>[端口]']],
    // The segmenter reads the text as written, before variants are folded.
    ['東京都目黒区', ['东京<cjk>[东京]@0-0', '目黑区<cjk>[目黑,黑区]@0-0']],
    ['電腦記憶體', ['电脑<cjk>[电脑]@0-0', '记忆体<cjk>[记忆,忆体]@0-1']],
    ['CR-12', ['cr12<identifier>[cr12]']],
    ['pnpm', ['pnpm<word>[pnpm]']],
    ['5433', ['5433<number>[5433]']],
    ['我女儿3岁了', ['女儿<cjk>[女儿]@0-0', '3岁<number>[3岁]']],
    ['Where did we deploy the release branches?', ['deploy<word>[deploy]', 'releas<word>[releas]', 'branch<word>[branch]']],
    ['pnpm 的依赖怎么升级', ['pnpm<word>[pnpm]', '依赖<cjk>[依赖]@0-0', '升级<cjk>[升级]@0-0']],
    // Word endings fold (cooked → cook); an identifier's words are another spelling of it, one word only a part.
    ["I've mentioned a dish I'd cooked", ['dish<word>[dish]', 'cook<word>[cook]']],
    ['noise-cancelling headphones', ['noisecancel<identifier>[noisecancel,nois,cancel]@1-2', 'headphon<word>[headphon]']],
    ['state-of-the-art us-east-1', ['stateoftheart<identifier>[stateoftheart,state,art]@1-2', 'useast1<identifier>[useast1]']],
    // A name written with a one-character stop word (一, 想, 可) is still something to look for (round 10, ported from rem-0200);
    // one of three is held only as a whole.
    ['沈一鸣', ['沈一鸣<cjk>[沈一,一鸣]@0-1']],
    ['沈一鸣的生日是哪天', ['沈一鸣<cjk>[沈一,一鸣]@0-1', '生日<cjk>[生日]@0-0']],
    ['王一凡', ['王一凡<cjk>[王一,一凡]@0-1']],
    ['李想的生日', ['李想<cjk>[李想]', '生日<cjk>[生日]@0-0']],
    ['周可', ['周可<cjk>[周可]']],
    // …which adds to the words around it and takes no character from them (round 10 review): the modals 会, 要 and 能
    // sit between a word's last character and a verb, and a lone character still joins its word.
    ['数据库会丢数据吗', ['数据库<cjk>[数据,据库]@0-0', '丢数据<cjk>[丢数,数据]@1-1']],
    ['我的数据库会丢吗', ['数据库<cjk>[数据,据库]@0-0']],
    ['服务器会挂吗', ['服务器<cjk>[服务,务器]@0-0']],
    ['停车场能停吗', ['停车场<cjk>[停车,车场]@0-0']],
    ['冰箱会坏吗', ['冰箱<cjk>[冰箱]@0-0']],
    ['洗衣机要修了', ['洗衣机<cjk>[洗衣,衣机]@0-0', '修了<cjk>[修了]@0-0']],
    ['我的车要换了吗', ['换了<cjk>[换了]@0-0']],
    ['能帮我写个周报吗', ['写个<cjk>[写个]@0-0', '周报<cjk>[周报]@0-0']],
    ['我朋友沈一鸣', ['朋友沈<cjk>[朋友,友沈]@0-0', '沈一鸣<cjk>[沈一,一鸣]@0-1']],
    // Only stop words: nothing to search for.
    ['你好，今天怎么样？', []],
    ['do you remember what I said?', []],
    ['', []],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => assert.deepEqual(plan(input), expected));
  }

  test('an acronym of three capitals is content as written; the same letters in lower case are not', () => {
    const content = (text: string) => Object.fromEntries(queryConcepts(text).map((concept) => [concept.text, concept.content]));
    assert.equal(content('Should I buy a NAS now?').nas, true);
    assert.equal(content('should i buy a nas now?').nas, false);
    assert.deepEqual([content('SSD or GPU first?').ssd, content('SSD or GPU first?').gpu], [true, true]);
    assert.equal(content('Run it on the dev box').dev, false);
  });

  test('a name the segmenter splits around a stop word is still found through its pairs (王|一|凡是|谁, 周|可是|谁, 朋友|周|可)', () => {
    assert.ok(queryConcepts('王一凡是谁').some((concept) => concept.atoms.includes('王一')));
    assert.ok(queryConcepts('周可是谁').some((concept) => concept.text === '周可'));
    assert.ok(queryConcepts('我朋友周可').some((concept) => concept.text === '周可'));
    assert.ok(queryConcepts('我朋友周可是做什么的').some((concept) => concept.text === '周可'));
    assert.deepEqual(queryConcepts('定了什么').map((concept) => concept.text), [], 'never a particle');
    assert.deepEqual(plan('我女儿3岁了'), ['女儿<cjk>[女儿]@0-0', '3岁<number>[3岁]'], 'a measure word after a number stays with it');
  });

  test('a name\'s pair with a stop character is searched but is no content concept: the same two characters meet across words (下周|可能)', () => {
    const content = (text: string) => Object.fromEntries(queryConcepts(text).map((concept) => [concept.text, concept.content]));
    assert.deepEqual(content('周可是谁'), { 周可: false });
    assert.deepEqual(content('李想的生日'), { 李想: false, 生日: true });
    assert.deepEqual(content('一鸣是谁'), { 一鸣: false });
    assert.equal(content('沈一鸣是谁').沈一鸣, true, 'a name of three is held only as a whole, so it stays content');
    assert.ok(segmentTerms('用户下周可能要去上海出差').includes('周可'));
  });

  test('merges repeated concepts and keeps the order they appear in', () => {
    assert.deepEqual(plan('pnpm 中野 pnpm 中野'), ['pnpm<word>[pnpm]', '中野<cjk>[中野]@0-0']);
  });

  test('plans a long paste by its first concepts', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    const concepts = queryConcepts(words.join(' '));
    assert.equal(concepts.length, 24);
    assert.equal(concepts[0].text, 'wordaa');
  });

  test('every atom of a concept is a document term of the same text', () => {
    for (const text of ['我已经搬到中野了', '图数据库选型', 'CR-12 deploys on us-east-1', '東京都目黒区', '我女儿3岁', 'Noise-cancelling headphones I cooked with', '沈一鸣和李想']) {
      const terms = new Set(segmentTerms(text));
      for (const concept of queryConcepts(text)) {
        for (const atom of concept.atoms) assert.ok(terms.has(atom), `${text}: ${atom}`);
      }
    }
  });

  test('a document that spells an identifier\'s words apart holds them all; one with another word holds only a part', () => {
    const [concept] = queryConcepts('noise-cancelling');
    const parts = concept.atoms.slice(concept.anchor!.from, concept.anchor!.to + 1);
    assert.deepEqual(parts, ['nois', 'cancel']);
    for (const spelling of ['noise cancelling headphones', 'Noise-Canceling headphones', 'the noise cancellation… cancelled noise']) {
      const terms = new Set(segmentTerms(spelling));
      assert.ok(parts.every((part) => terms.has(part)) || terms.has(concept.text), spelling);
    }
    assert.ok(segmentTerms('noisecancelling').includes(concept.text), 'written as one word');
    assert.ok(!parts.every((part) => new Set(segmentTerms('the noise at work')).has(part)));
  });
});

describe('locateTerm', () => {
  test('finds a matched term in the text as written: case, width, variants, endings and joiners aside', () => {
    const text = 'We saw ＰＬＥＳＩＯＳＡＵＲＳ at the 東京 museum; ticket CR-12 and the Golden-Pumpkin stall.';
    assert.equal(locateTerm(text, ['plesiosaur']), text.indexOf('ＰＬＥＳＩＯＳＡＵＲＳ'));
    assert.equal(locateTerm(text, ['东京']), text.indexOf('東京'));
    assert.equal(locateTerm(text, ['cr12']), text.indexOf('CR-12'));
    assert.equal(locateTerm(text, ['goldenpumpkin']), text.indexOf('Golden-Pumpkin'));
    assert.equal(locateTerm('Two memories here', ['memory']), 4);
    // In order: the first term the text holds.
    assert.equal(locateTerm(text, ['nakano', 'museum', 'ticket']), text.indexOf('museum'));
    assert.equal(locateTerm('ﬁne print about 中野', ['中野']), 'ﬁne print about '.length, 'offsets stay right when folding changes the length');
    assert.equal(locateTerm(text, ['nakano']), null);
    assert.equal(locateTerm('', ['x']), null);
  });
});

describe('WEAK_TERMS and COMMON_TERMS', () => {
  test('weak: conversational words in both languages, folded as queries spell them; content words are not', () => {
    assert.ok(WEAK_TERMS.size >= 250 && WEAK_TERMS.size <= 500, String(WEAK_TERMS.size));
    // The concepts of the queries that let unrelated turns in (round-1 intrusion probes int-003/-004/-009/-011/-015, xcv-0008).
    for (const query of ['Quick one, like I keep saying', 'Hey, the other day we were talking about how it works. What was it called?', '别的 快速 时间 感觉']) {
      for (const concept of queryConcepts(query)) assert.ok(WEAK_TERMS.has(concept.text), `${query}: ${concept.text}`);
    }
    for (const word of ['cardamom', 'bakery', 'café', 'pnpm', 'deploy', 'dish', 'cooked', 'headphones', 'Elena', '中野', '降噪', '咖啡馆', '分支']) {
      for (const concept of queryConcepts(word)) assert.ok(!WEAK_TERMS.has(concept.text), word);
    }
  });

  test('weak: the words of asking for advice, which say nothing about what the advice is for', () => {
    // SSP questions ("any suggestions for…", "do you have any helpful tips?") let unrelated turns in by these words alone.
    for (const query of ['Can you suggest some tips? Any recommendations or advice would be helpful and useful.', '你能推荐一下吗，有什么建议',
      'Should I decide now or choose later? Something interesting to consider.']) {
      for (const concept of queryConcepts(query)) assert.ok(WEAK_TERMS.has(concept.text), `${query}: ${concept.text}`);
    }
  });

  test('common: everyday words, never weak; specific ones are neither', () => {
    for (const word of ['friend', 'friends', 'food', 'book', 'birthday', 'office', 'meetings', '朋友', '电影', '周末']) {
      const [concept] = queryConcepts(word);
      assert.ok(COMMON_TERMS.has(concept.text), word);
    }
    for (const term of COMMON_TERMS) assert.ok(!WEAK_TERMS.has(term), term);
    for (const word of ['cook', 'dish', 'cardamom', 'laptop', 'Marmalade', 'pnpm', '降噪耳机', '拉面']) {
      for (const concept of queryConcepts(word)) assert.ok(!COMMON_TERMS.has(concept.text), word);
    }
  });
});

describe('STOPWORDS', () => {
  test('cover Chinese and English function words and memory talk, not content words', () => {
    assert.ok(STOPWORDS.size >= 150, String(STOPWORDS.size));
    for (const word of ['的', '了', '我们', '什么', '已经', '记得', '告诉', 'the', 'and', 'remember', 'dont', 'what']) {
      assert.ok(STOPWORDS.has(word), word);
    }
    for (const word of ['中野', '目黑', '存储', '数据库', 'pnpm', 'deploy', 'memory', '咖啡']) {
      assert.ok(!STOPWORDS.has(word), word);
    }
  });
});
