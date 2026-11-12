/**
 * Search terms for Michi Memory's recall index (recallIndex.ts, migration
 * 0071's memory_recall_fts). Pure and deterministic: the same text always
 * gives the same terms, on the document side and on the query side.
 *
 * Text is folded first (normalizeText): NFKC (full-width letters, digits and
 * punctuation become ASCII, half-width katakana full-width), lower case,
 * Latin diacritics removed, and Traditional or Japanese variants of common
 * characters read as their Simplified form (黒 → 黑, 記憶體 → 记忆体; NFKC
 * alone keeps them apart). Then:
 *
 *  - A CJK run (Han, kana, Hangul) is indexed as its character bigrams, so
 *    any two or more characters of it can be found: 中野 in 我已经搬到中野了,
 *    目黑 in 我住在目黑区. SQLite's unicode61 tokenizer would keep a whole run
 *    as one token, and trigram cannot match two characters.
 *  - A latin word of two or more letters (other alphabets too) is a term,
 *    plurals folded (memories → memory), and an English word's -ly, -ed,
 *    -ing and -er too (cooked, cooking → cook; baking → bake; released →
 *    releas, as release folds): foldWord. Joined words are identifiers:
 *    CR-12, v1.2, us-east-1 and foo_bar are kept as one term with the joiners
 *    removed (cr12, v12, useast1, foobar), and their words are terms as well.
 *    Numbers of two or more digits are terms; a number written against a CJK
 *    unit is one too (3岁, 11月, 5433).
 *  - Stop words (STOPWORDS) are never terms.
 *
 * A query is planned as concepts (queryConcepts): Intl.Segmenter('zh') words
 * (read before the variant step, as the text was written) decide which
 * characters belong together, and each concept lists the bigrams that find it. A CJK word subsumes its bigrams: 存储选型 is the two
 * concepts 存储 and 选型, never four bigram hits. The segmenter often splits
 * names and compounds into single characters (目|黑, 端|口, 张|伟); a run of
 * such characters is one concept, and a lone one joins the word next to it
 * (数据|库 → 数据库, found by 数据 alone too). A name holding 一, 可 or 想
 * (沈|一|鸣, 李|想) adds concepts of its own. An identifier's words find it
 * too (noise-cancelling in "noise cancelling").
 *
 * WEAK_TERMS and COMMON_TERMS tell automatic recall's relevance gate
 * (recallIndex.ts) which terms say little about what a text is about.
 */

const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

// ── normalization ────────────────────────────────────────────────────────────

/**
 * Traditional Chinese and Japanese (shinjitai) forms of common characters,
 * as their Simplified form: pairs of variant then Simplified. Partial on
 * purpose (frequent characters, place and tech words); a character missing
 * here still matches itself.
 */
const VARIANT_PAIRS = [
  // Traditional
  '這这個个們们來来說说説说時时會会對对為为爲为與与國国學学開开關关發发髮发問问題题實实現现機机點点種种經经員员',
  '動动長长樣样頭头間间東东書书車车電电話话號号碼码後后還还過过進进運运達达讓让給给從从認认識识覺觉見见聽听讀读',
  '寫写買买賣卖錢钱價价體体變变環环錯错誤误記记憶忆處处區区縣县鄉乡樓楼門门戶户飛飞場场鐵铁線线歲岁兒儿媽妈爺爷',
  '婦妇歡欢愛爱飯饭麵面魚鱼雞鸡豬猪蝦虾蘋苹葉叶華华語语漢汉軟软檢检證证鑰钥帳账賬账銀银費费貸贷總总結结構构組组',
  '織织團团隊队專专務务業业產产質质標标準准規规則则範范優优層层級级節节圓圆張张條条隻只輛辆臺台檯台颱台灣湾廣广',
  '雲云貴贵遼辽寧宁龍龙蘇苏閩闽贛赣魯鲁粵粤瓊琼滬沪濱滨據据庫库檔档資资訊讯網网頁页數数鍵键盤盘腦脑儲储選选擇择',
  '測测試试編编譯译轉转換换應应請请傳传輸输載载鏈链樹树邏逻輯辑維维監监視视審审計计權权註注冊册籤签類类別别屬属',
  '項项預预設设參参執执啟启閉闭佈布釋释歸归刪删複复製制貼贴銷销導导匯汇彙汇叢丛礎础際际階阶圍围適适勢势濾滤篩筛',
  '統统圖图錶表鐘钟鍾钟夠够購购顧顾觀观館馆慣惯獲获穫获積积擊击極极幾几濟济繼继駕驾堅坚簡简漸渐將将獎奖講讲較较',
  '潔洁屆届緊紧盡尽儘尽僅仅驚惊鏡镜競竞舊旧舉举劇剧決决軍军課课擴扩闊阔蘭兰欄栏勞劳樂乐淚泪離离裡里裏里禮礼歷历',
  '曆历麗丽厲厉勵励連连聯联臉脸戀恋練练糧粮兩两諒谅療疗獵猎臨临鄰邻隣邻靈灵齡龄領领劉刘陸陆錄录驢驴亂乱輪轮論论',
  '羅罗馬马嗎吗麥麦滿满貓猫貿贸麼么夢梦彌弥綿绵滅灭鳴鸣謀谋納纳難难鬧闹內内擬拟農农濃浓諾诺歐欧龐庞賠赔噴喷憑凭',
  '撲扑鋪铺舖铺樸朴齊齐騎骑豈岂氣气棄弃牽牵鉛铅遷迁簽签淺浅槍枪牆墙搶抢橋桥僑侨輕轻傾倾慶庆窮穷驅驱勸劝確确擾扰',
  '熱热榮荣灑洒賽赛傘伞喪丧掃扫殺杀曬晒傷伤賞赏燒烧紳绅腎肾滲渗聲声繩绳勝胜聖圣師师詩诗濕湿壽寿獸兽雙双誰谁稅税',
  '順顺碩硕絲丝飼饲鬆松頌颂訴诉肅肃雖虽隨随孫孙損损縮缩瑣琐鎖锁態态攤摊貪贪談谈歎叹嘆叹湯汤燙烫濤涛討讨騰腾廳厅',
  '頹颓襪袜萬万偉伟衛卫違违穩稳聞闻臥卧烏乌無无霧雾係系繫系戲戏細细嚇吓鮮鲜閒闲顯显險险憲宪獻献響响詳详曉晓協协',
  '脅胁謝谢興兴尋寻詢询訓训壓压鴨鸭亞亚煙烟嚴严鹽盐顏颜驗验陽阳養养遙遥藥药醫医儀仪億亿藝艺議议異异陰阴隱隐飲饮',
  '營营贏赢擁拥郵邮猶犹遊游漁渔譽誉園园遠远願愿約约躍跃閱阅韻韵雜杂災灾讚赞贊赞髒脏臟脏責责澤泽賊贼贈赠齋斋債债',
  '戰战漲涨帳帐趙赵針针偵侦診诊陣阵鎮镇爭争鄭郑職职紙纸誌志眾众衆众週周軸轴晝昼諸诸燭烛囑嘱築筑駐驻磚砖賺赚樁桩',
  '莊庄裝装壯壮狀状濁浊綜综縱纵鄒邹鑽钻劑剂罷罢備备貝贝筆笔畢毕邊边賓宾補补倉仓塵尘陳陈稱称誠诚遲迟衝冲蟲虫醜丑',
  '創创詞词聰聪帶带單单擔担黨党燈灯鄧邓敵敌遞递調调釘钉頂顶訂订凍冻鬥斗獨独斷断噸吨奪夺爾尔罰罚訪访墳坟豐丰風风',
  '鳳凤復复負负該该蓋盖幹干趕赶剛刚鋼钢崗岗鞏巩貢贡溝沟櫃柜閡阂紅红護护劃划畫画黃黄揮挥輝辉夥伙貨货艦舰醬酱膠胶',
  '驕骄腳脚糾纠凱凯顆颗墾垦懇恳誇夸塊块寬宽礦矿爛烂憐怜煉炼鍊炼闆板餘余徵征卻却僕仆鈴铃鍋锅鋁铝銅铜鑄铸錦锦錫锡',
  '釣钓鉤钩鈔钞頻频額额頸颈顛颠頓顿須须頒颁頃顷紀纪純纯紗纱紋纹紡纺紛纷絡络絕绝絞绞綁绑綠绿緒绪締缔緩缓績绩繪绘',
  '繳缴續续纖纤纜缆許许評评謂谓譜谱財财貧贫販贩貫贯賀贺賃赁賄贿賤贱賦赋賭赌賴赖軌轨軒轩輔辅輩辈轄辖轟轰閃闪閘闸',
  '閣阁閥阀陰阴飽饱飾饰餃饺餅饼饅馒馮冯駁驳駛驶騙骗驛驿鯨鲸鳥鸟鴻鸿鵝鹅鶴鹤鷹鹰齒齿龜龟爐炉奮奋嬰婴寶宝',
  // Japanese shinjitai
  '黒黑渋涩沢泽浜滨辺边広广斎斋恵惠栄荣県县関关戸户鎌镰縄绳駅驿円圆気气発发図图楽乐薬药鉄铁銭钱転转軽轻経经続续',
  '読读売卖歳岁様样単单収收価价帰归権权対对処处労劳営营実实総总緑绿険险験验検检剣剑亜亚悪恶圧压囲围隠隐衛卫塩盐',
  '応应桜樱穏稳仮假絵绘拡扩覚觉渇渴勧劝巻卷歓欢観观陥陷偽伪戯戏犠牺拠据挙举郷乡暁晓駆驱勲勋掲揭継继鶏鸡芸艺撃击',
  '倹俭圏圈顕显厳严効效鉱矿穀谷砕碎済济剤剂雑杂桟栈賛赞糸丝歯齿児儿釈释従从獣兽縦纵粛肃奨奖焼烧証证乗乘剰剩浄净',
  '畳叠譲让醸酿粋粹酔醉髄髓斉齐摂摄専专戦战騒骚増增臓脏蔵藏帯带滝泷択择団团弾弹遅迟鋳铸庁厅徴征聴听鎮镇逓递伝传',
  '闘斗弐贰悩恼脳脑廃废拝拜髪发抜拔晩晚払拂仏佛舗铺毎每満满黙默訳译揺摇謡谣頼赖覧览竜龙両两猟猎塁垒涙泪霊灵齢龄',
  '録录壊坏懐怀姫姬歩步渉涉島岛宮宫豊丰',
].join('');

const VARIANTS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const chars = [...VARIANT_PAIRS];
  for (let i = 0; i + 1 < chars.length; i += 2) {
    if (chars[i] !== chars[i + 1] && !map.has(chars[i])) map.set(chars[i], chars[i + 1]);
  }
  return map;
})();

const HAS_VARIANT_CANDIDATE = /[㐀-鿿豈-﫿]/u;
const LATIN_MARKS = /(?<=[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{Mn}+/gu;
/** Latin, Greek and Cyrillic letters that may carry a diacritic, or a combining mark. */
const NEEDS_MARK_STRIP = /[\u00c0-\u024f\u0300-\u036f\u0370-\u03ff\u0400-\u04ff\u1e00-\u1eff]/u;

/** NFKC, lower case, ’ ʼ ‘ as ', and diacritics off Latin, Greek and Cyrillic letters (kana keep their marks). */
function foldBase(text: string): string {
  const folded = text.normalize('NFKC').toLowerCase().replace(/[’ʼ‘]/gu, "'");
  return NEEDS_MARK_STRIP.test(folded) ? folded.normalize('NFD').replace(LATIN_MARKS, '').normalize('NFC') : folded;
}

/**
 * Traditional and Japanese variants as Simplified. One BMP character for one,
 * so offsets into foldBase's text stay valid; the segmenter reads the text
 * before this step, as written (東京|都|目黒|区, not 东|京都|目|黑|区).
 */
function foldVariants(text: string): string {
  if (!HAS_VARIANT_CANDIDATE.test(text)) return text;
  let out = '';
  for (const char of text) out += VARIANTS.get(char) ?? char;
  return out;
}

/**
 * The folded form every term comes from: NFKC (full-width forms as ASCII),
 * lower case, ’ ʼ ‘ as ', diacritics off Latin, Greek and Cyrillic letters
 * (café → cafe), and Traditional or Japanese variants of common characters
 * as Simplified (黒 → 黑, 記憶體 → 记忆体).
 */
export function normalizeText(text: string): string {
  return foldVariants(foldBase(text));
}

// ── stop words ───────────────────────────────────────────────────────────────

/** Chinese characters that carry no topic on their own (particles, pronouns, the commonest verbs). */
const ZH_STOP_CHARS = '的了着过吗呢吧啊呀么嘛哦啦喔呗哈嗯哎唉地得之也都就还又很太更最不没别是在有和与及或而且但并把被让给对从向往到于以为因所如若则即这那哪此其我你您他她它们咱个些每各某啥谁怎一来去说用要会能想可该已才再';

/**
 * The stop characters a Chinese name may hold (沈一鸣, 王一凡, 张可欣, 李想, 周可). Not the modals 会, 要 and 能: they
 * sit between a word's last character and a verb (数据|库|会|丢), and in no name.
 */
const NAME_STOP_CHARS = new Set([...'一可想']);
/** Of those, the ones a given name may begin with (一鸣, 一凡, 可欣); 想 begins a verb (想|买). */
const NAME_FIRST_CHARS = new Set([...'一可']);

const ZH_STOP_WORDS = [
  '我们', '你们', '他们', '她们', '它们', '咱们', '大家', '自己', '别人', '人家', '这个', '那个', '这些', '那些', '这样', '那样',
  '这么', '那么', '这里', '那里', '这儿', '那儿', '这边', '那边', '什么', '怎么', '怎样', '怎么样', '为什么', '为何', '哪个', '哪些', '哪天',
  '哪里', '哪儿', '多少', '几个', '一个', '一些', '一下', '一点', '一直', '一样', '一起', '一般', '一定', '一只', '没有', '不是',
  '就是', '还是', '但是', '可是', '因为', '所以', '如果', '虽然', '而且', '或者', '然后', '接着', '已经', '现在', '刚才', '刚刚',
  '时候', '可以', '可能', '应该', '需要', '能够', '知道', '觉得', '认为', '记得', '记住', '忘了', '忘记', '告诉', '说过', '提过',
  '聊过', '好像', '比较', '非常', '特别', '真的', '其实', '当然', '还有', '以及', '关于', '对于', '之前', '之后', '以后', '以前',
  '上次', '下次', '这次', '那次', '今天', '明天', '昨天', '最近', '东西', '事情', '的话', '怎么办', '好的', '谢谢', '请问', '帮我',
  '帮忙', '麻烦', '我的', '你的', '他的', '她的', '我是', '你是', '是不是', '有没有', '能不能', '要不要', '会不会', '不要', '不用',
  '不会', '不能', '下个月', '上个月', '这个月', '一下子', '而不是', '不过', '只是', '只有', '而已', '甚至', '并且', '于是', '否则',
  '除了', '比如', '例如', '另外', '其他', '其它', '之类', '等等', '最后', '首先', '其次', '总之', '同时', '你好', '您好', '哈喽',
  '早上好', '晚上好', '辛苦', '辛苦了',
];

const EN_STOP_WORDS = [
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
  'into', 'about', 'than', 'so', 'not', 'no', 'nor', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'having', 'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their', 'theirs', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'there', 'here', 'all', 'any', 'each', 'some',
  'such', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'just', 'also', 'very', 'too', 'only',
  'own', 'same', 'other', 'more', 'most', 'much', 'many', 'now', 'up', 'down', 'out', 'over', 'again', 'once', 'ok', 'okay',
  'yes', 'yeah', 'please', 'thanks', 'thank', 'let', 'lets', 'im', 'ive', 'id', 'ill', 'dont', 'didnt', 'doesnt', 'isnt',
  'wasnt', 'cant', 'wont', 'youre', 'youve', 'youll', 'theyre', 'theyve', 'weve', 'thats', 'whats', 'remember', 'recall',
  'forget', 'told', 'tell', 'said', 'say', 'mentioned', 'know', 'think', 'thing', 'things', 'something', 'anything', 'get',
  'got', 'eg', 'ie', 'etc', 'vs',
];

/** Words that are never search terms (exported for tests and callers that pick keywords). */
export const STOPWORDS: ReadonlySet<string> = new Set([...ZH_STOP_CHARS, ...ZH_STOP_WORDS, ...EN_STOP_WORDS]);

// ── tokens ───────────────────────────────────────────────────────────────────

const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u30fc';
/** A CJK run, or a run of other letters, digits and marks. */
const TOKEN = new RegExp(`([${CJK_CLASS}]+)|((?:(?![${CJK_CLASS}])[\\p{L}\\p{N}\\p{M}])+)`, 'gu');
/** Joins two words into one identifier when it is the only character between them. */
const JOINERS = new Set(['-', '_', '.', '@', '#', "'"]);
const DIGITS = /^\p{Nd}+$/u;
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\p{Nd}/u;
/** Longer "words" are hashes, keys or encoded data, not something a person searches for. */
const MAX_TERM_CHARS = 64;
/** Programming languages whose names are mostly punctuation. */
const SYMBOL_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/(?<![\p{L}\p{N}])c\+\+(?![\p{L}\p{N}])/gu, ' cplusplus '],
  [/(?<![\p{L}\p{N}])c#(?![\p{L}\p{N}])/gu, ' csharp '],
  [/(?<![\p{L}\p{N}])f#(?![\p{L}\p{N}])/gu, ' fsharp '],
  [/(?<![\p{L}\p{N}.])\.net(?![\p{L}\p{N}])/gu, ' dotnet '],
];

interface Token {
  kind: 'cjk' | 'word';
  text: string;
  /** Offsets in Tokens.text. */
  start: number;
  end: number;
}

interface Tokens {
  /** The text the offsets refer to: foldBase's, symbol names spelled out, variants not yet folded. */
  text: string;
  tokens: Token[];
}

function tokenize(folded: string): Tokens {
  let text = folded;
  for (const [pattern, name] of SYMBOL_NAMES) text = text.replace(pattern, name);
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    tokens.push({ kind: match[1] ? 'cjk' : 'word', text: match[0], start, end: start + match[0].length });
  }
  return { text, tokens };
}

/** memories → memory, branches → branch, deploys → deploy; short words and -ss/-us/-is endings stay. */
function stem(word: string): string {
  if (word.length >= 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length >= 5 && /(?:ss|sh|ch|x|z)es$/u.test(word)) return word.slice(0, -2);
  if (word.length >= 4 && word.endsWith('s') && !/(?:ss|us|is)$/u.test(word)) return word.slice(0, -1);
  return word;
}

// ── word endings ─────────────────────────────────────────────────────────────

/**
 * English words whose ending is no inflection, or that would fold into
 * another word (evening → even, corner → corn, letter → let, cooker → cook,
 * quite → quit, reminder → remind): they stay as they are, plurals aside
 * (evenings → evening).
 */
const FOLD_KEEP: ReadonlySet<string> = new Set(`
  during morning evening nothing ceiling pudding inning outing canning herring earring willing
  embed naked wicked hundred sacred kindred beloved moped tired rugged ragged proceed exceed succeed
  early family italy emily apply reply supply imply comply multiply anomaly monopoly butterfly dragonfly firefly curly
  news quite suite paste
  number corner flower shower mother brother letter matter center summer dinner finger ginger burger hamburger butter
  banner manner master mister server folder rubber hammer ladder danger hunger cancer soccer copper pepper supper bitter
  better litter twitter potter trigger header poster porter quarter charter carter sweater shoulder easter bother cooker
  proper former customer officer lawyer docker sneaker thinker teller getter setter shutter gutter blazer tender ponder
  solder temper differ buffer reminder helper pointer worker finding reasoning
  oliver parker cooper miller fisher archer harper palmer fuller glover salter
  soldier cashier barrier frontier premier courier glacier dossier chandelier cavalier financier
`.split(/\s+/u).filter(Boolean));

/** Forms the rules below would get wrong. */
const FOLD_IRREGULAR: ReadonlyMap<string, string> = new Map([
  ['dying', 'die'], ['lying', 'lie'], ['tying', 'tie'], ['died', 'die'], ['lied', 'lie'], ['tied', 'tie'], ['skis', 'ski'],
  ['gently', 'gentle'], ['subtly', 'subtle'], ['singly', 'single'], ['truly', 'true'], ['pasted', 'paste'], ['pasting', 'paste'],
]);

const ASCII_WORD = /^[a-z]+$/u;

/** a, e, i, o, u, and y after a consonant (Porter's vowels). */
function vowelAt(word: string, i: number): boolean {
  const char = word[i];
  if (char === 'a' || char === 'e' || char === 'i' || char === 'o' || char === 'u') return true;
  return char === 'y' && i > 0 && !vowelAt(word, i - 1);
}

function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i += 1) if (vowelAt(word, i)) return true;
  return false;
}

/** Where Porter's R1 begins: after the first consonant that follows a vowel; the word's length when none does. */
function regionOne(word: string): number {
  for (let i = 1; i < word.length; i += 1) if (vowelAt(word, i - 1) && !vowelAt(word, i)) return i + 1;
  return word.length;
}

/**
 * Porter's short word (hop, bak, writ, us): nothing after its first vowel
 * and the consonant after it, and it ends in a consonant, a vowel and a
 * consonant other than w, x or y (or is a vowel and a consonant). Such a
 * word drops its e before -ed, -ing and -er (hoped, baking, writer) and
 * keeps it otherwise (hope, bake, write).
 */
function shortWord(word: string): boolean {
  const n = word.length;
  if (regionOne(word) < n) return false;
  if (n === 2) return vowelAt(word, 0) && !vowelAt(word, 1);
  return n > 2 && !vowelAt(word, n - 3) && vowelAt(word, n - 2) && !vowelAt(word, n - 1) && !/[wxy]$/u.test(word);
}

/** What is left once -ed, -ing or -er is cut: hopp → hop, cancell → cancel (cancelled), bak → bake, cook stays. */
function restoreE(stemmed: string): string {
  if (stemmed.length >= 4 && /(?:bb|dd|gg|mm|nn|pp|rr|tt)$/u.test(stemmed)) return stemmed.slice(0, -1);
  if (stemmed.length >= 6 && stemmed.endsWith('ell')) return stemmed.slice(0, -1);
  return shortWord(stemmed) ? `${stemmed}e` : stemmed;
}

/** quickly → quick, easily → easy, probably → probable, simply → simple, really → real; belly, silly, fly stay. */
function foldLy(word: string): string {
  if (word.endsWith('ily')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('bly') || word.endsWith('mply')) return `${word.slice(0, -1)}e`;
  const stemmed = word.slice(0, -2);
  if (word.endsWith('lly')) return stemmed.length >= 4 && /(?:al|ful)$/u.test(stemmed) ? stemmed : word;
  return stemmed.length >= 3 && hasVowel(stemmed) ? stemmed : word;
}

/** One of -ly, -ed and -ing: cooked, cooking → cook; agreed → agree; tried → try; need, speed, thing, ring stay. */
function foldInflection(word: string): string {
  const n = word.length;
  if (n >= 5 && word.endsWith('ly')) return foldLy(word);
  if (word.endsWith('eed')) return n >= 5 && regionOne(word) <= n - 3 ? word.slice(0, -1) : word;
  if (n >= 5 && word.endsWith('ied')) return `${word.slice(0, -3)}y`;
  const cut = n >= 4 && word.endsWith('ed') ? 2 : n >= 5 && word.endsWith('ing') ? 3 : 0;
  if (cut === 0) return word;
  const stemmed = word.slice(0, -cut);
  return hasVowel(stemmed) ? restoreE(stemmed) : word;
}

/** -er, after any of those (teachers, considered): teacher → teach, bigger → big, writer → write, happier → happy; user, water, career stay. */
function foldEr(word: string): string {
  if (word.length < 6 || !word.endsWith('er') || word.endsWith('eer') || FOLD_KEEP.has(word)) return word;
  if (word.endsWith('ier')) return `${word.slice(0, -3)}y`;
  const stemmed = word.slice(0, -2);
  return hasVowel(stemmed) ? restoreE(stemmed) : word;
}

/**
 * A final silent e goes unless the word is short (release → releas, as
 * released folds; hope and bake keep theirs, as hoped and baked restore
 * it); after a u it always goes (value, valued → valu).
 */
function finalE(word: string): string {
  const n = word.length;
  if (n < 3 || !word.endsWith('e')) return word;
  if (word[n - 2] === 'u') return n >= 4 ? word.slice(0, -1) : word;
  if (vowelAt(word, n - 2)) return word;
  const stemmed = word.slice(0, -1);
  return shortWord(stemmed) ? word : stemmed;
}

/**
 * The search form of a word: plurals folded (stem), and for an English
 * word -ly, -ed or -ing, then -er, so that cook, cooks, cooked and cooking
 * are one term, as are bake, baked and baking, or release and released.
 * The same on both sides (documents and queries); FOLD_KEEP stops it where
 * an ending is part of the word.
 */
function foldWord(word: string): string {
  const irregular = FOLD_IRREGULAR.get(word);
  if (irregular !== undefined) return FOLD_KEEP.has(irregular) ? irregular : finalE(irregular);
  if (FOLD_KEEP.has(word)) return word;
  const plural = stem(word);
  if (!ASCII_WORD.test(plural) || FOLD_KEEP.has(plural)) return plural;
  return finalE(foldEr(foldInflection(plural)));
}

type LatinType = 'word' | 'identifier' | 'number';

interface LatinTerm {
  term: string;
  type: LatinType;
  /** The words of an identifier (noise-cancelling: nois, cancel), each a term of its own; not the identifier itself. */
  parts: string[];
  /** Characters as written, before endings fold (running: 7, its term run). */
  written: number;
}

function wordTerm(word: string): string | null {
  if (word.length < 2 || word.length > MAX_TERM_CHARS || STOPWORDS.has(word)) return null;
  if (DIGITS.test(word)) return word;
  const folded = HAS_DIGIT.test(word) ? word : foldWord(word);
  return STOPWORDS.has(folded) ? null : folded;
}

function termType(term: string): LatinType {
  return DIGITS.test(term) ? 'number' : HAS_DIGIT.test(term) ? 'identifier' : 'word';
}

/**
 * Word tokens joined by a single joiner character form one identifier
 * (cr-12, foo_bar, user@example.com); one of letters only folds like a
 * word (noise-cancelling → noisecancel, as noisecancelling). An apostrophe
 * makes one word (don't → dont), and a possessive 's is dropped (user's →
 * user). One entry per group that yields a term, with `end` its last
 * token's end.
 */
function latinTerms({ tokens, text }: Tokens): Array<LatinTerm & { end: number }> {
  const out: Array<LatinTerm & { end: number }> = [];
  let i = 0;
  while (i < tokens.length) {
    const first = tokens[i];
    if (first.kind !== 'word') { i += 1; continue; }
    const group: string[] = [first.text];
    let apostrophes = 0;
    let end = first.end;
    let j = i + 1;
    while (j < tokens.length && tokens[j].kind === 'word' && tokens[j].start === end + 1 && JOINERS.has(text[end])) {
      if (text[end] === "'") {
        if (tokens[j].text === 's') { end = tokens[j].end; j += 1; break; }
        apostrophes += 1;
      }
      group.push(tokens[j].text);
      end = tokens[j].end;
      j += 1;
    }
    i = j;
    const joined = group.join('');
    if (group.length === 1 || apostrophes === group.length - 1) {
      const term = wordTerm(joined);
      if (term) out.push({ term, type: termType(term), parts: [], written: [...joined].length, end });
      continue;
    }
    if (joined.length > MAX_TERM_CHARS || STOPWORDS.has(joined)) continue;
    const term = HAS_DIGIT.test(joined) ? joined : foldWord(joined);
    const parts = [...new Set(group.map((part) => (HAS_LETTER.test(part) ? wordTerm(part) : null)))]
      .filter((part): part is string => !!part && part !== term);
    out.push({ term, type: DIGITS.test(joined) ? 'number' : 'identifier', parts, written: [...joined].length, end });
  }
  return out;
}

/** 3岁, 11月, 5点: a number written against the CJK character after it. */
function numberUnit(tokens: Token[], index: number): string | null {
  const token = tokens[index];
  const next = tokens[index + 1];
  if (token.kind !== 'word' || !DIGITS.test(token.text) || token.text.length > 8) return null;
  if (!next || next.kind !== 'cjk' || next.start !== token.end) return null;
  const unit = foldVariants([...next.text][0]);
  return STOPWORDS.has(unit) ? null : `${token.text}${unit}`;
}

function bigrams(run: string): string[] {
  const chars = [...run];
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  return out;
}

/**
 * The distinct terms of a text, in the order they first appear: the bigrams
 * of every CJK run (stop-word bigrams such as 我们 left out), latin words,
 * identifiers and the words inside them, numbers and number-unit pairs.
 * recallIndex writes them, space-joined, as a document's index entry; a
 * query finds a CJK word through its bigrams (queryConcepts).
 */
export function segmentTerms(text: string): string[] {
  const tokenized = tokenize(foldBase(text));
  const { tokens } = tokenized;
  const terms = new Set<string>();
  const latin = latinTerms(tokenized);
  let next = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === 'cjk') {
      for (const pair of bigrams(foldVariants(token.text))) if (!STOPWORDS.has(pair)) terms.add(pair);
      continue;
    }
    while (next < latin.length && latin[next].end <= token.end) {
      terms.add(latin[next].term);
      for (const part of latin[next].parts) terms.add(part);
      next += 1;
    }
    const unit = numberUnit(tokens, i);
    if (unit) terms.add(unit);
  }
  return [...terms];
}

// ── locating ─────────────────────────────────────────────────────────────────

/** normalizeText of each character, and where each folded unit came from in the text. */
function foldWithOffsets(text: string): { folded: string; at: number[] } {
  const whole = normalizeText(text);
  // Folding nearly always keeps the length (NFKC maps full-width forms one for one): the offsets are the same.
  if (whole.length === text.length) return { folded: whole, at: Array.from({ length: whole.length }, (_, i) => i) };
  let folded = '';
  const at: number[] = [];
  let offset = 0;
  for (const char of text) {
    const piece = normalizeText(char);
    for (let k = 0; k < piece.length; k += 1) at.push(offset);
    folded += piece;
    offset += char.length;
  }
  return { folded, at };
}

/**
 * Where a text first holds one of these terms (folded, as RecallHit.matched
 * spells them: a CJK span such as 存储选型, a latin word such as plesiosaur,
 * an identifier such as cr12), trying the terms in order: an offset into the
 * text, or null when it holds none. A word is also found with another ending
 * (memory in memories, bake in baking, cook in cooked), an identifier with
 * its joiners (cr12 in CR-12).
 */
export function locateTerm(text: string, terms: readonly string[]): number | null {
  if (typeof text !== 'string' || !text) return null;
  const { folded, at } = foldWithOffsets(text);
  let compact: { text: string; at: number[] } | null = null;
  for (const term of terms) {
    if (typeof term !== 'string' || !term) continue;
    const exact = folded.indexOf(term);
    if (exact >= 0) return at[exact];
    if (HAS_LETTER.test(term) || HAS_DIGIT.test(term)) {
      compact ??= (() => {
        let joined = '';
        const offsets: number[] = [];
        for (let i = 0; i < folded.length; i += 1) {
          if (JOINERS.has(folded[i])) continue;
          joined += folded[i];
          offsets.push(at[i]);
        }
        return { text: joined, at: offsets };
      })();
      const joined = compact.text.indexOf(term);
      if (joined >= 0) return compact.at[joined];
    }
    // A folded word without its last letter: memor (memories), bak (baking), happ (happily).
    if (/^\p{Script=Latin}{5,}$/u.test(term) || /^\p{Script=Latin}{3,}[ey]$/u.test(term)) {
      const stem = folded.indexOf(term.slice(0, -1));
      if (stem >= 0) return at[stem];
    }
  }
  return null;
}

// ── queries ──────────────────────────────────────────────────────────────────

export type RecallConceptType = 'cjk' | LatinType;

/**
 * One thing a query mentions. A document matches it when it holds any of
 * the atoms; for CJK the atoms are the span's bigrams in order, and the
 * longer the run of consecutive bigrams a document holds, the more of the
 * span it contains.
 */
export interface RecallConcept {
  /** Folded text of the concept: 中野区, 数据库, pnpm, cr12, 3岁, cook (cooked), noisecancel (noise-cancelling). */
  text: string;
  type: RecallConceptType;
  /**
   * Index terms that find it (memory_recall_fts tokens): bigrams of a CJK
   * span, else [text]; an identifier of two or more words adds them
   * ([noisecancel, nois, cancel]), which find it in text that spells them
   * apart (noise cancelling).
   */
  atoms: string[];
  /**
   * The atom range (inclusive) a match must cover to count as the concept
   * itself rather than a part of it. CJK: the word's bigrams, e.g. 中野
   * within 中野区 (null: any bigram counts, as for runs of single
   * characters such as 目黑区). An identifier with words: all its words,
   * {1..n} (the identifier itself, atom 0, counts too). null for other
   * latin terms.
   */
  anchor: { from: number; to: number } | null;
  /**
   * A content concept, which automatic recall's gate needs (spec: a CJK
   * word, a number, an identifier, or a latin word of four or more letters
   * as written: running counts, though its term is run; or an acronym of
   * three capitals as written, NAS). A name's pair with a stop character
   * (周可, nameConcepts) is not one.
   */
  content: boolean;
  /**
   * Each atom is the whole concept on its own (a profile category's words,
   * profileConcepts): a document holds it by holding any one of them, never
   * a run of them.
   */
  alternatives?: boolean;
}

/** Most concepts a query is planned with; a long paste is searched by its first ones. */
const MAX_QUERY_CONCEPTS = 24;
/** Three capital letters as a word of their own (NAS, SSD, GPU, but not the CR of CR-12). */
const ACRONYM = /(?<![\p{L}\p{N}\-_./@#])\p{Lu}{3}(?![\p{L}\p{N}]|[-_./@#][\p{L}\p{N}])/gu;

interface Piece {
  text: string;
  role: 'stop' | 'word' | 'single';
}

/** The segmenter's words of a run as written (before foldVariants), each folded. */
function piecesOf(run: string): Piece[] {
  const pieces: Piece[] = [];
  for (const { segment } of SEGMENTER.segment(run)) {
    const text = foldVariants(segment);
    const role = STOPWORDS.has(text) ? 'stop' : [...text].length === 1 ? 'single' : 'word';
    pieces.push({ text, role });
  }
  return pieces;
}

function cjkConcept(span: string, unit: { start: number; length: number } | null): RecallConcept | null {
  const atoms = bigrams(span).filter((pair) => !STOPWORDS.has(pair));
  if (atoms.length === 0) return null;
  if (atoms.length !== [...span].length - 1) {
    // A stop-word pair inside the span breaks the run arithmetic; search its pairs as they are.
    return { text: span, type: 'cjk', atoms, anchor: null, content: true };
  }
  const anchor = unit ? { from: unit.start, to: unit.start + unit.length - 2 } : null;
  return { text: span, type: 'cjk', atoms, anchor, content: true };
}

/**
 * What a name holding a stop character (NAME_STOP_CHARS) adds to a run's
 * concepts, by the index of its first piece. Such a character between two
 * single ones is a name of three (沈|一|鸣 → 沈一鸣, 张|可|欣 → 张可欣),
 * which a document holds only as the whole of it (the anchor spans every
 * pair). Else a single character and such a character beside it are a pair
 * (李|想 → 李想, 周|可是|谁 → 周可, 一|鸣|是 → 一鸣); the same two characters
 * also meet across two words (下周|可能 holds 周可), so a pair is no content
 * concept: a search the agent asks for finds it, and automatic recall needs
 * another word beside it. `afterNumber`: the first piece is a number's
 * measure word (3|岁|了), no name.
 */
function nameConcepts(pieces: readonly Piece[], afterNumber: boolean): Array<{ at: number; concept: RecallConcept }> {
  const out: Array<{ at: number; concept: RecallConcept }> = [];
  const single = (k: number) => k >= 0 && k < pieces.length && pieces[k].role === 'single' && !(afterNumber && k === 0);
  const nameChar = (k: number) => k >= 0 && k < pieces.length && pieces[k].role === 'stop' && NAME_STOP_CHARS.has(pieces[k].text);
  const inName = new Set<number>();
  for (let k = 1; k + 1 < pieces.length; k += 1) {
    if (!nameChar(k) || !single(k - 1) || !single(k + 1)) continue;
    const concept = cjkConcept(`${pieces[k - 1].text}${pieces[k].text}${pieces[k + 1].text}`, { start: 0, length: 3 });
    if (!concept) continue;
    out.push({ at: k - 1, concept });
    inName.add(k - 1).add(k + 1);
  }
  const pair = (at: number, text: string) => {
    const concept = cjkConcept(text, null);
    if (concept) out.push({ at, concept: { ...concept, content: false } });
  };
  pieces.forEach((piece, k) => {
    if (!single(k) || inName.has(k)) return;
    if (nameChar(k - 1) && NAME_FIRST_CHARS.has(pieces[k - 1].text)) pair(k, `${pieces[k - 1].text}${piece.text}`);
    // The name's second character may begin a stop word (周|可是|谁).
    const after = pieces[k + 1];
    const next = after?.role === 'stop' ? [...after.text][0] : '';
    if (NAME_STOP_CHARS.has(next)) pair(k, `${piece.text}${next}`);
  });
  return out;
}

/**
 * Concepts of one CJK run, in order: each segmenter word that is not a stop
 * word, and each run of single characters the segmenter could not group
 * (names, places, jargon: 目|黑|区, 端|口, 张|伟; one per pair when longer
 * than four). A lone single character joins the word before it, else the
 * word after it (数据|库 → 数据库, 图|数据 → 图数据); the word stays the
 * anchor. A name holding a stop character adds its own concepts
 * (nameConcepts), never taking a character from those: 数据|库|会|丢|数据
 * is still 数据库 and 丢数据. `afterNumber`: the run follows a number
 * directly, so its first character is that number's measure word (3|岁|了),
 * which numberUnit takes.
 */
function runConcepts(run: string, afterNumber = false): RecallConcept[] {
  const pieces = piecesOf(run);
  const found: Array<{ at: number; concept: RecallConcept }> = [];
  const glue = pieces.map(() => ({ prefix: '', suffix: '' }));
  for (let i = 0; i < pieces.length;) {
    if (pieces[i].role !== 'single') { i += 1; continue; }
    let j = i;
    while (j + 1 < pieces.length && pieces[j + 1].role === 'single') j += 1;
    if (j > i) {
      const span = pieces.slice(i, j + 1).map((piece) => piece.text).join('');
      for (const part of j - i + 1 <= 4 ? [span] : bigrams(span)) {
        const concept = cjkConcept(part, null);
        if (concept) found.push({ at: i, concept });
      }
    } else if (i > 0 && pieces[i - 1].role === 'word') {
      glue[i - 1].suffix = pieces[i].text;
    } else if (i + 1 < pieces.length && pieces[i + 1].role === 'word') {
      glue[i + 1].prefix = pieces[i].text;
    }
    i = j + 1;
  }
  pieces.forEach((piece, index) => {
    if (piece.role !== 'word') return;
    const { prefix, suffix } = glue[index];
    const concept = cjkConcept(`${prefix}${piece.text}${suffix}`, { start: prefix ? 1 : 0, length: [...piece.text].length });
    if (concept) found.push({ at: index, concept });
  });
  found.push(...nameConcepts(pieces, afterNumber));
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.concept);
}

/**
 * What a search text asks for, in the order it mentions things, at most
 * `limit` concepts with duplicates merged. Empty when the text holds only
 * stop words.
 */
export function queryConcepts(text: string, limit = MAX_QUERY_CONCEPTS): RecallConcept[] {
  const tokenized = tokenize(foldBase(text));
  const { tokens } = tokenized;
  const latin = latinTerms(tokenized);
  // A three-letter acronym as written (NAS, SSD, GPU) names something specific, however short.
  const acronyms = new Set([...(typeof text === 'string' ? text.normalize('NFKC') : '').matchAll(ACRONYM)]
    .map((match) => wordTerm(foldBase(match[0]))).filter((term): term is string => !!term));
  const out: RecallConcept[] = [];
  const seen = new Map<string, RecallConcept>();
  const add = (concept: RecallConcept) => {
    const key = `${concept.type === 'cjk' ? 'c' : 'l'}:${concept.text}`;
    const known = seen.get(key);
    // run, then running: one concept, content as the longer spelling makes it.
    if (known) { known.content ||= concept.content; return; }
    if (out.length >= limit) return;
    seen.set(key, concept);
    out.push(concept);
  };
  let next = 0;
  for (let i = 0; i < tokens.length && out.length < limit; i += 1) {
    const token = tokens[i];
    if (token.kind === 'cjk') {
      // A run right after a number starts with its measure word (3|岁|了), which numberUnit takes.
      const afterNumber = i > 0 && tokens[i - 1].kind === 'word' && DIGITS.test(tokens[i - 1].text) && tokens[i - 1].end === token.start;
      for (const concept of runConcepts(token.text, afterNumber)) add(concept);
      continue;
    }
    while (next < latin.length && latin[next].end <= token.end) {
      const { term, type, parts, written } = latin[next];
      const content = type !== 'word' || written >= 4 || acronyms.has(term);
      // Two or more words of an identifier are another spelling of it; one word (us-east-1: east) is only a part.
      if (parts.length >= 2) add({ text: term, type, atoms: [term, ...parts], anchor: { from: 1, to: parts.length }, content });
      else add({ text: term, type, atoms: [term], anchor: null, content });
      next += 1;
    }
    const unit = numberUnit(tokens, i);
    if (unit) add({ text: unit, type: 'number', atoms: [unit], anchor: null, content: true });
  }
  return out;
}

// ── weak and common words ────────────────────────────────────────────────────

/**
 * Conversational words in both languages: greetings and fillers, words of
 * time, quantity and degree, verbs of talking, asking, wanting and doing,
 * and the words of asking for advice (suggest, recommend, tips, decide,
 * 推荐, 建议, 选择). A query is full of them ("quick one: what's the difference…",
 * "那天我们聊到的…叫什么名字"), and any old turn holds some. Verbs of
 * preference (喜欢, love, hate) are not among them: what the user likes is
 * what memory is for. like is, for its other uses (like a bun, I'd like to).
 */
const WEAK_WORDS = `
  hey hi hello hmm oh ah wow lol haha btw anyway anyways actually basically honestly literally seriously really quite
  pretty maybe perhaps probably definitely certainly sure right alright cool nice great awesome fine good bad better best
  well kind sort lot bit stuff way guy folks people person someone somebody anyone anybody everyone everybody nobody
  everything nothing whatever however though although even still yet already almost enough else instead together another
  either neither both whether rather further before after between through without within across around against among
  along toward upon onto via per except unless because since while until during ago soon often sometimes usually always
  never ever last next first second third past current recently lately early earlier later today tonight tomorrow
  yesterday morning afternoon evening night day week month year time moment minute hour back end rest fact sense
  matter ask talk chat discuss mention explain describe help need want wish hope try thought knew known wonder guess mean
  meant remind call name look see saw seen find found give gave take took make made go goes went gone come came put keep
  kept start use work happen feel felt seem like forgot forgotten gotten idea question answer problem issue
  point reason example difference compare one two three four five several few less least little big small large long
  short high low new old different similar real true whole full half quick fast slow easy hard simple important main
  general specific particular certain exact possible able likely sorry glad
  suggest suggestion recommend recommendation tip advice advise decide choose consider interesting helpful useful
  对了 话说 顺便 原来 难怪 如此 来着 哈哈 哈哈哈 嘿嘿 嗯嗯 哎呀 好吧 好啊 行吧 没事 没关系 不好意思 抱歉 感谢 多谢 拜托 请教 想问 问问
  问题 情况 地方 方面 部分 方法 办法 方式 原因 结果 意思 区别 差别 不同 例子 内容 样子 种类 类型 别的 一切 所有 全部 整个 大部分
  那只 这只 这种 那种 这件 那件 这位 那位 一种 一天 那天 前几天 前两天 有一天 上回 上周 这周 本周 下周 今年 去年 明年 早上 上午 中午
  下午 晚上 今晚 半天 一会儿 时间 当时 那时 那时候 后来 将来 平时 经常 常常 有时 有时候 偶尔 总是 通常 每天 每次 马上 立刻 刚好 正好
  终于 突然 曾经 一次 两次 几次 几天 一年 几年 很多 好多 许多 不少 名字 叫做 称为 是在 在于 说话 聊天 聊聊 讨论 提到 说到 讲到 聊到
  问过 讲过 说起 提起 解释 介绍 推荐 建议 帮助 想要 希望 准备 开始 结束 继续 完成 使用 用来 用于 工作 进行 看看 看到 听说 听到 发现
  感觉 以为 了解 明白 理解 有点 有些 快速 简单 容易 方便 重要 主要 普通 基本 具体 确实 肯定 也许 大概 似乎 必须 为啥 干嘛
  如何 是否 能否 对比 相比 关系 有关 相关 差不多 有用 有趣 选择 考虑 决定 想法
`;

/**
 * A small prior of everyday words (people, places, food, things, time off):
 * common in any conversation, so one alone says little about which earlier
 * one a message refers to, however few the store holds.
 */
const COMMON_WORDS = `
  home house room family friend kid child parent mom dad wife husband son daughter sister baby boy girl man woman boss
  colleague coworker team member manager school class student teacher job company office meeting project plan task list
  note money price cost pay buy sell shop store market food eat drink water coffee tea breakfast lunch dinner meal car bus
  train drive walk trip travel city country town street place area world life health doctor body hand head eye face heart
  mind phone computer email message video picture photo internet online website app file data system weekend birthday
  party holiday vacation gift weather rain summer winter spring dog cat pet garden clothes shirt shoe bag box table chair
  bed kitchen door window light music song movie book game sport story news paper word letter language english chinese
  家里 家人 朋友 孩子 小孩 父母 爸爸 妈妈 老婆 老公 儿子 女儿 哥哥 姐姐 弟弟 妹妹 同事 老板 领导 同学 老师 学生 学校 公司 单位 办公室
  会议 开会 项目 计划 任务 安排 价格 商店 超市 吃饭 早饭 午饭 晚饭 早餐 午餐 晚餐 咖啡 开车 地铁 公交 出门 旅行 旅游 出差 城市 国家
  地址 世界 生活 身体 健康 医生 医院 手机 电脑 电话 邮件 消息 微信 视频 照片 图片 网站 软件 文件 数据 系统 周末 生日 假期 放假 礼物
  天气 下雨 夏天 冬天 春天 秋天 宠物 衣服 鞋子 房间 房子 厨房 音乐 电影 游戏 运动 故事 新闻 中文 英文 英语 语言 文章
`;

const HAS_CJK = new RegExp(`[${CJK_CLASS}]`, 'u');

/** A word list as the terms queryConcepts gives: latin words folded (foldWord), CJK words as normalizeText writes them. */
function lexicon(words: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const word of words.split(/\s+/u)) {
    const folded = foldBase(word);
    if (!folded) continue;
    const term = HAS_CJK.test(folded) ? foldVariants(folded) : wordTerm(folded);
    if (term && !STOPWORDS.has(term)) out.add(term);
  }
  return out;
}

/**
 * Conversational words (folded terms: like, one, keep, call, 时间, 感觉):
 * they never count toward automatic recall's relevance gate. A search the
 * agent asks for still finds them.
 */
export const WEAK_TERMS: ReadonlySet<string> = lexicon(WEAK_WORDS);

/**
 * Everyday words (folded terms: friend, food, book, 朋友, 电影): a match on
 * one of them alone does not count as rare, however small the store, unless
 * the query asks about nothing else.
 */
export const COMMON_TERMS: ReadonlySet<string> = lexicon(COMMON_WORDS);

// ── profile categories ───────────────────────────────────────────────────────

/**
 * What a fact about the user's own life is filed under, in both languages:
 * where they work, live and study, their family and pets, their phone,
 * computer and car. A memory whose text states one (statement) carries its
 * category's words (profileKeywords: extraction's keywords, the recall
 * index), and a question about it (question: "which company am I at now?",
 * "我住哪？") searches them (profileConcepts), so the two meet though they
 * share no other word ("started a new job at Lumenfield Robotics").
 * Patterns read normalizeText's folded text.
 */
interface ProfileCategory {
  id: string;
  /** The category's words in both languages, the ones a memory carries and a question looks for. */
  words: readonly string[];
  statement: RegExp;
  question: RegExp;
}

const PROFILE_CATEGORIES: readonly ProfileCategory[] = [
  {
    id: 'work',
    words: ['company', 'employer', 'job', 'work', 'workplace', 'career', '公司', '工作', '单位', '雇主', '职业', '上班'],
    statement: /\b(?:works?|worked|working)\s+(?:at|for|as|in)\b|\b(?:jobs?|employer|employed|employee|employment|hired|career|occupation|profession|workplace|internship|company|colleagues?|coworkers?|engineer|developer|designer|analyst|programmer|scientist|researcher|consultant|accountant|lawyer|nurse|teacher)\b|在[^,，。;；]{1,24}?(?:工作|上班|任职|就职|实习)|(?:做|当)(?:一名|一个)?[^,，。;；]{0,12}?(?:师|员|经理)|入职|跳槽|就职|任职|离职|辞职|新工作|工作单位|公司|单位|雇主|职位|岗位|职业|同事|上司|工程师|程序员|设计师|分析师|产品经理/u,
    question: /\bwhere\s+(?:do|did|does|am|was)\s+i\s+(?:work|working|employed)\b|\b(?:which|what)\s+(?:company|firm|employer|organi[sz]ation)\b|\bwho\s+(?:do|did|am)\s+i\s+work(?:ing)?\s+for\b|\bmy\s+(?:company|employer|job|workplace|office|boss|role|position|title|occupation|profession|career)\b|\bwhat\s+(?:do|did)\s+i\s+do\s+for\s+(?:a\s+living|work)\b|\b(?:am\s+i|i'm|i\s+am)\s+(?:working|employed)\s+(?:at|for)\b|(?:哪|哪家|哪个|什么)家?(?:公司|单位)|我(?:现在|目前)?的?(?:公司|单位|工作|雇主|职位|岗位|职业)|(?:在|去)哪(?:儿|里)?(?:上班|工作|实习)|我(?:是)?(?:做|干)什么(?:工作|的)|我.{0,4}什么工作/u,
  },
  {
    id: 'residence',
    words: ['city', 'live', 'residence', '城市', '住在', '居住', '住址', '地址'],
    statement: /\b(?:live[sd]?|living)\s+in\b|\bmov(?:e|ed|ing)\s+to\b|\brelocat\w*|\bbased\s+in\b|\bhome(?:town)?\s+is\b|\b(?:address|apartment|neighbou?rhood|hometown)\b|住在|住的|住到|住进|搬到|搬去|搬来|搬家|定居|老家|家在|居住|租房|住址|地址/u,
    question: /\bwhere\s+(?:do|did|am|was)\s+i\s+(?:live|living|based|staying|move)\b|\b(?:which|what)\s+(?:city|town|country|neighbou?rhood)\b|\bmy\s+(?:city|address|home|hometown|apartment|neighbou?rhood)\b|\bwhere(?:'s|\s+is)\s+my\s+(?:home|place|apartment)\b|\bwhere\s+did\s+i\s+move\b|住(?:在)?哪|(?:哪个|什么|哪座)城市|我(?:现在|目前)?的?(?:城市|地址|住址)|家(?:住)?在哪|搬到了?哪|老家(?:是|在)?哪/u,
  },
  {
    id: 'school',
    words: ['school', 'university', 'college', 'study', 'major', '学校', '大学', '学院', '专业', '读书'],
    statement: /\bstud(?:y|ies|ied|ying)\s+(?:at|in)\b|\benroll\w*|\b(?:university|college|school|kindergarten|preschool|degree|phd|semester|campus)\b|\bmajor(?:ing|ed)?\s+in\b|\bgraduat\w*|\b(?:master|bachelor)'?s\b|读书|上学|念书|读研|读博|就读|大学|学院|学校|小学|中学|初中|高中|幼儿园|专业|研究生|本科|博士|硕士|毕业|学期|年级/u,
    question: /\bwhere\s+(?:do|did|am|was)\s+i\s+(?:study|studying|go\s+to\s+school|graduate)\b|\b(?:which|what)\s+(?:school|university|college|major|degree)\b|\bmy\s+(?:school|university|college|major|degree|semester)\b|(?:哪|哪个|哪所|什么)(?:学校|大学|学院)|我(?:现在|目前)?的?(?:学校|大学|专业|学院)|(?:在)?哪(?:儿|里)?(?:上学|读书|念书|上大学)|(?:学|读)的?(?:什么|哪个)专业/u,
  },
  {
    id: 'family',
    words: ['family', '家人', '家庭'],
    statement: /\b(?:wife|husband|partner|spouse|sons?|daughters?|kids?|children|child|baby|parents?|mom|mother|dad|father|brothers?|sisters?|siblings?|grand(?:ma|pa|mother|father|parents?)|nephew|niece|cousin|family)\b|老婆|妻子|太太|老公|丈夫|爱人|孩子|儿子|女儿|宝宝|父母|爸爸|妈妈|父亲|母亲|哥哥|姐姐|弟弟|妹妹|爷爷|奶奶|外公|外婆|姥姥|姥爷|侄子|侄女|外甥|家人|家里人/u,
    question: /\bmy\s+(?:family|wife|husband|partner|spouse|sons?|daughters?|kids?|children|child|baby|parents|mom|mother|dad|father|brothers?|sisters?|siblings?)\b|我的?(?:家人|家里人|老婆|妻子|太太|老公|丈夫|爱人|孩子|儿子|女儿|宝宝|父母|爸爸|妈妈|父亲|母亲|哥哥|姐姐|弟弟|妹妹)|我家(?:里)?(?:有|几)/u,
  },
  {
    id: 'pet',
    words: ['pet', '宠物'],
    statement: /\b(?:pets?|dogs?|cats?|puppy|kitten|hamster|rabbit|parrot)\b|宠物|小狗|狗狗|养狗|猫咪|小猫|养猫|(?:只|条)(?:狗|猫)|(?:狗|猫)(?:叫|名字)/u,
    question: /\bmy\s+(?:pets?|dogs?|cats?|puppy|kitten)\b|我(?:的|家)?(?:宠物|狗|猫)|我养的/u,
  },
  {
    id: 'phone',
    words: ['phone', 'smartphone', '手机'],
    statement: /\b(?:phone|smartphone|iphone|android|mobile)\b|手机/u,
    question: /\bmy\s+(?:phone|smartphone|mobile|cell(?:\s*phone)?)\b|\b(?:which|what)\s+phone\b|我(?:的|用的?)?(?:什么|哪款|哪个)?手机|(?:什么|哪款)手机/u,
  },
  {
    id: 'computer',
    words: ['computer', 'laptop', '电脑'],
    statement: /\b(?:laptop|computer|macbook|thinkpad|desktop)\b|电脑|笔记本电脑|台式机/u,
    question: /\bmy\s+(?:laptop|computer|pc|macbook|desktop)\b|\b(?:which|what)\s+(?:laptop|computer)\b|我(?:的|用的?)?(?:什么|哪款|哪个)?(?:电脑|笔记本)/u,
  },
  {
    id: 'car',
    words: ['car', 'vehicle', '汽车', '车子'],
    statement: /\b(?:cars?|vehicle|suv|sedan)\b|\bdrives?\s+an?\b|汽车|车子|开车|买车|换车|新车|座驾|私家车/u,
    question: /\bmy\s+(?:car|vehicle)\b|\b(?:which|what)\s+car\b|我(?:的|开的?)?(?:什么|哪款|哪辆)?(?:车|汽车)|开的?(?:什么|哪款)车/u,
  },
];

/**
 * The words of every profile category a memory's text (its body and
 * keywords) states, in both languages: what extraction adds to its keywords
 * and the recall index to its document. [] when it states none.
 */
export function profileKeywords(text: string): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const folded = normalizeText(text);
  return [...new Set(PROFILE_CATEGORIES.filter((category) => category.statement.test(folded)).flatMap((category) => category.words))];
}

/**
 * The bridge from a question about the user's own work, home, school,
 * family, pets or devices ("which company am I at now?", "我住哪个城市？")
 * to the words such memories carry (profileKeywords): one concept per
 * category the question asks about, any of whose words counts
 * (alternatives). Conversational words (work, 工作) and the terms the
 * query's own concepts already search are left out. [] for anything else.
 */
export function profileConcepts(text: string, own: readonly RecallConcept[] = []): RecallConcept[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const folded = normalizeText(text);
  const searched = new Set(own.flatMap((concept) => concept.atoms));
  const out: RecallConcept[] = [];
  for (const category of PROFILE_CATEGORIES) {
    if (!category.question.test(folded)) continue;
    const atoms = [...new Set(category.words.flatMap((word) => {
      const terms = segmentTerms(word);
      // One index term each: a word the index splits (笔记本 → 笔记, 记本) would also find unrelated text.
      return terms.length === 1 && !WEAK_TERMS.has(terms[0]) && !searched.has(terms[0]) ? terms : [];
    }))];
    if (atoms.length > 0) out.push({ text: `@${category.id}`, type: 'word', atoms, anchor: null, content: true, alternatives: true });
  }
  return out;
}
