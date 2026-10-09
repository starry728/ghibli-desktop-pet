/**
 * 精选花名册
 *
 * 每一条对应一张从 MyAnimeList 抓取到的角色图（server/data/scraped-characters.json）。
 * 字段说明：
 *   mal        与 MAL 抓取结果匹配的角色名（务必与抓取到的 nameMal 一致）
 *   film       电影 key（见 tools/fetch-pets.mjs 的 FILMS）
 *   zh/ja/en   中文名 / 日文名 / 英文名
 *   rarity     SSR / SR / R / N
 *   element    属性（森 / 海 / 风 / 火 / 光 / 影 / 天空 / 铁 / 土 / 梦 / 水）
 *   emoji      列表里的点缀图标
 *   personality 默认性格标签（AI 生成失败时的兜底，也会作为 AI 的参考）
 *   lineKey    对应 tools/data/lines*.json 中的 charEn；null 表示该角色在片中无经典台词
 */

export const ROSTER = [
  /* ================= 天空之城 / 天空の城ラピュタ ================= */
  { mal: 'Pazu', film: 'laputa', zh: '巴兹', ja: 'パズー', en: 'Pazu', rarity: 'SSR', element: '天空', emoji: '🪂', personality: ['勇敢', '赤诚', '匠人'], lineKey: 'Pazu' },
  { mal: 'Sheeta', film: 'laputa', zh: '希达', ja: 'シータ', en: 'Sheeta', rarity: 'SSR', element: '光', emoji: '💎', personality: ['温柔', '坚韧', '王族'], lineKey: 'Sheeta' },
  { mal: 'Dola', film: 'laputa', zh: '朵拉', ja: 'ドーラ', en: 'Dola', rarity: 'SR', element: '风', emoji: '🏴‍☠️', personality: ['豪爽', '贪财', '护短'], lineKey: 'Dola' },
  { mal: 'Muska', film: 'laputa', zh: '穆斯卡', ja: 'ムスカ', en: 'Muska', rarity: 'SR', element: '影', emoji: '🎩', personality: ['野心', '优雅', '危险'], lineKey: 'Muska' },
  { mal: 'Uncle Pom', film: 'laputa', zh: '波姆爷爷', ja: 'ポムじいさん', en: 'Uncle Pom', rarity: 'R', element: '土', emoji: '⛏️', personality: ['慈祥', '博学', '慢吞吞'], lineKey: 'Uncle Pom' },
  { mal: 'Lui', film: 'laputa', zh: '路易', ja: 'ルイ', en: 'Lui', rarity: 'N', element: '火', emoji: '🔧', personality: ['莽撞', '讲义气'], lineKey: null },
  { mal: 'Shalulu', film: 'laputa', zh: '沙鲁鲁', ja: 'シャルル', en: 'Shalulu', rarity: 'N', element: '火', emoji: '🔩', personality: ['憨直', '力气大'], lineKey: null },
  { mal: 'Train Operator', film: 'laputa', zh: '列车员', ja: '車掌', en: 'Train Operator', rarity: 'N', element: '风', emoji: '🚂', personality: ['沉默', '尽职'], lineKey: null },
  { mal: 'Shogun Mouro', film: 'laputa', zh: '穆罗将军', ja: 'ムロ将軍', en: 'General Mouro', rarity: 'N', element: '铁', emoji: '🪖', personality: ['贪婪', '强硬'], lineKey: null },

  /* ================= 龙猫 / となりのトトロ ================= */
  { mal: 'Totoro', film: 'totoro', zh: '龙猫', ja: 'トトロ', en: 'Totoro', rarity: 'SSR', element: '森', emoji: '🌳', personality: ['憨厚', '温柔', '守护'], lineKey: 'Totoro' },
  { mal: 'Mei Kusakabe', film: 'totoro', zh: '小梅', ja: '草壁メイ', en: 'Mei Kusakabe', rarity: 'SSR', element: '森', emoji: '🌰', personality: ['天真', '莽撞', '好奇'], lineKey: 'Mei' },
  { mal: 'Satsuki Kusakabe', film: 'totoro', zh: '小月', ja: '草壁サツキ', en: 'Satsuki Kusakabe', rarity: 'SR', element: '风', emoji: '🎒', personality: ['懂事', '勇敢', '姐姐'], lineKey: 'Satsuki' },
  { mal: 'Nekobus', film: 'totoro', zh: '猫巴士', ja: 'ネコバス', en: 'Catbus', rarity: 'SR', element: '光', emoji: '🚌', personality: ['热心', '毛茸茸', '夜行'], lineKey: 'Catbus' },
  { mal: 'Tatsuo Kusakabe', film: 'totoro', zh: '草壁达男', ja: '草壁タツオ', en: 'Tatsuo Kusakabe', rarity: 'R', element: '风', emoji: '📖', personality: ['温和', '开明', '学者'], lineKey: 'Tatsuo (Father)' },
  { mal: 'Kanta Oogaki', film: 'totoro', zh: '大垣勘太', ja: '大垣カンタ', en: 'Kanta Oogaki', rarity: 'R', element: '土', emoji: '🧢', personality: ['别扭', '害羞', '热心'], lineKey: 'Kanta Oogaki' },
  { mal: 'Makkuro-Kurosuke', film: 'totoro', zh: '煤灰精灵', ja: 'まっくろくろすけ', en: 'Soot Sprite', rarity: 'R', element: '影', emoji: '⚫', personality: ['成群', '害羞', '爱糖果'], lineKey: null },
  { mal: 'Yasuko Kusakabe', film: 'totoro', zh: '草壁靖子', ja: '草壁靖子', en: 'Yasuko Kusakabe', rarity: 'R', element: '光', emoji: '🏥', personality: ['温柔', '坚强', '母亲'], lineKey: null },
  { mal: "Kanta's Grandmother", film: 'totoro', zh: '勘太的奶奶', ja: 'カンタの祖母', en: "Kanta's Grandmother", rarity: 'N', element: '土', emoji: '🍵', personality: ['唠叨', '慈祥'], lineKey: null },

  /* ================= 千与千寻 / 千と千尋の神隠し ================= */
  { mal: 'Haku', film: 'chihiro', zh: '白龙', ja: 'ハク', en: 'Haku', rarity: 'SSR', element: '水', emoji: '🐉', personality: ['清冷', '忠诚', '龙神'], lineKey: 'Haku' },
  { mal: 'Chihiro Ogino', film: 'chihiro', zh: '荻野千寻', ja: '荻野千尋', en: 'Chihiro Ogino', rarity: 'SSR', element: '光', emoji: '🌸', personality: ['倔强', '善良', '成长'], lineKey: 'Chihiro' },
  { mal: 'Kaonashi', film: 'chihiro', zh: '无脸男', ja: 'カオナシ', en: 'No-Face', rarity: 'SSR', element: '影', emoji: '🎭', personality: ['孤独', '沉默', '渴望'], lineKey: 'No-Face' },
  { mal: 'Kamajii', film: 'chihiro', zh: '锅炉爷爷', ja: '釜爺', en: 'Kamaji', rarity: 'SR', element: '火', emoji: '🔥', personality: ['外冷内热', '六臂', '老练'], lineKey: 'Kamaji' },
  { mal: 'Yubaba', film: 'chihiro', zh: '汤婆婆', ja: '湯婆婆', en: 'Yubaba', rarity: 'SR', element: '火', emoji: '👵', personality: ['贪财', '强势', '契约'], lineKey: 'Yubaba' },
  { mal: 'Zeniba', film: 'chihiro', zh: '钱婆', ja: '銭婆', en: 'Zeniba', rarity: 'SR', element: '光', emoji: '🧶', personality: ['爽朗', '强大', '双胞胎'], lineKey: 'Zeniba' },
  { mal: 'Lin', film: 'chihiro', zh: '小玲', ja: 'リン', en: 'Lin', rarity: 'SR', element: '风', emoji: '🪶', personality: ['泼辣', '仗义', '姐姐'], lineKey: null },
  { mal: 'Oshira-sama', film: 'chihiro', zh: '大御神', ja: 'オシラ様', en: 'Oshira-sama', rarity: 'R', element: '光', emoji: '🥕', personality: ['巨大', '温和', '被伺候'], lineKey: null },
  { mal: 'Ootori-sama', film: 'chihiro', zh: '大鸟神', ja: 'オオトリ様', en: 'Ootori-sama', rarity: 'N', element: '天空', emoji: '🦆', personality: ['神气', '聒噪'], lineKey: null },
  { mal: 'Makkuro-Kurosuke', film: 'chihiro', zh: '煤灰精灵', ja: 'まっくろくろすけ', en: 'Soot Sprite', rarity: 'N', element: '影', emoji: '⚫', personality: ['成群', '搬运工'], lineKey: null },

  /* ================= 哈尔的移动城堡 / ハウルの動く城 ================= */
  { mal: 'Howl', film: 'howl', zh: '哈尔', ja: 'ハウル', en: 'Howl', rarity: 'SSR', element: '火', emoji: '🪶', personality: ['华丽', '怯懦', '深情'], lineKey: 'Howl' },
  { mal: 'Sophie Hatter', film: 'howl', zh: '苏菲', ja: 'ソフィー', en: 'Sophie Hatter', rarity: 'SSR', element: '光', emoji: '👒', personality: ['温柔', '坚韧', '自卑'], lineKey: 'Sophie' },
  { mal: 'Calcifer', film: 'howl', zh: '卡西法', ja: 'カルシファー', en: 'Calcifer', rarity: 'SSR', element: '火', emoji: '🔥', personality: ['毒舌', '傲娇', '恶魔之火'], lineKey: 'Calcifer' },
  { mal: 'Turnip Head', film: 'howl', zh: '芜菁头', ja: 'カブ', en: 'Turnip Head', rarity: 'SR', element: '森', emoji: '🎃', personality: ['沉默', '报恩', '王子'], lineKey: 'Turnip Head / Prince Justin' },
  { mal: 'Markl', film: 'howl', zh: '马鲁克', ja: 'マルクル', en: 'Markl', rarity: 'SR', element: '风', emoji: '🧒', personality: ['机灵', '学徒', '小大人'], lineKey: 'Markl' },
  { mal: 'Witch of the Waste', film: 'howl', zh: '荒野女巫', ja: '荒地の魔女', en: 'Witch of the Waste', rarity: 'SR', element: '影', emoji: '🔮', personality: ['傲慢', '衰老', '执念'], lineKey: 'The Witch of the Waste' },
  { mal: 'Suliman', film: 'howl', zh: '莎莉曼', ja: 'サリマン', en: 'Suliman', rarity: 'SR', element: '光', emoji: '🐕‍🦺', personality: ['威严', '算计', '导师'], lineKey: 'Madam Suliman' },
  { mal: 'Heen', film: 'howl', zh: '因因', ja: 'ヒン', en: 'Heen', rarity: 'R', element: '土', emoji: '🐕', personality: ['老态', '忠诚', '气喘'], lineKey: 'Heen' },
  { mal: 'Lettie Hatter', film: 'howl', zh: '蕾蒂', ja: 'レティー', en: 'Lettie Hatter', rarity: 'R', element: '火', emoji: '☕', personality: ['活泼', '洒脱', '妹妹'], lineKey: null },
  { mal: 'King of Ingary', film: 'howl', zh: '英加里国王', ja: 'インガリ国王', en: 'King of Ingary', rarity: 'N', element: '铁', emoji: '👑', personality: ['懦弱', '被摆布'], lineKey: null },

  /* ================= 悬崖上的金鱼姬 / 崖の上のポニョ ================= */
  { mal: 'Ponyo', film: 'ponyo', zh: '波妞', ja: 'ポニョ', en: 'Ponyo', rarity: 'SSR', element: '海', emoji: '🐠', personality: ['莽撞', '热烈', '金鱼公主'], lineKey: 'Ponyo' },
  { mal: 'Sousuke', film: 'ponyo', zh: '宗介', ja: '宗介', en: 'Sosuke', rarity: 'SSR', element: '海', emoji: '⚓', personality: ['懂事', '坚定', '五岁'], lineKey: 'Sosuke' },
  { mal: 'Fujimoto', film: 'ponyo', zh: '藤本', ja: 'フジモト', en: 'Fujimoto', rarity: 'SR', element: '海', emoji: '🧪', personality: ['偏执', '护女', '科学家'], lineKey: 'Fujimoto' },
  { mal: 'Lisa', film: 'ponyo', zh: '理莎', ja: 'リサ', en: 'Lisa', rarity: 'SR', element: '火', emoji: '🚗', personality: ['爽朗', '强悍', '母亲'], lineKey: 'Lisa' },
  { mal: 'Granmammare', film: 'ponyo', zh: '曼玛莲', ja: 'グランマンマーレ', en: 'Granmammare', rarity: 'SR', element: '海', emoji: '🌊', personality: ['慈爱', '浩瀚', '海之母'], lineKey: 'Granmammare' },
  { mal: 'Koichi', film: 'ponyo', zh: '耕一', ja: '耕一', en: 'Koichi', rarity: 'R', element: '海', emoji: '⛴️', personality: ['常年出海', '寡言'], lineKey: null },
  { mal: 'Yoshie', film: 'ponyo', zh: '芳江', ja: '芳江', en: 'Yoshie', rarity: 'N', element: '土', emoji: '🏡', personality: ['热心', '邻里'], lineKey: null },
  { mal: 'Kumiko', film: 'ponyo', zh: '久美子', ja: '久美子', en: 'Kumiko', rarity: 'N', element: '光', emoji: '🌼', personality: ['友善', '好奇'], lineKey: null },
  { mal: 'Toki', film: 'ponyo', zh: '时婆婆', ja: 'トキ', en: 'Toki', rarity: 'N', element: '光', emoji: '🧶', personality: ['嘴硬', '心软'], lineKey: null },

  /* ================= 起风了 / 風立ちぬ ================= */
  { mal: 'Jirou Horikoshi', film: 'kaze', zh: '堀越二郎', ja: '堀越二郎', en: 'Jiro Horikoshi', rarity: 'SSR', element: '风', emoji: '✈️', personality: ['执着', '温柔', '理想'], lineKey: 'Jiro Horikoshi' },
  { mal: 'Naoko Satomi', film: 'kaze', zh: '里见菜穗子', ja: '里見菜穂子', en: 'Naoko Satomi', rarity: 'SSR', element: '风', emoji: '🎨', personality: ['清丽', '坚强', '病弱'], lineKey: 'Naoko Satomi' },
  { mal: 'Giovanni Caproni', film: 'kaze', zh: '卡普罗尼', ja: 'カプローニ', en: 'Giovanni Caproni', rarity: 'SR', element: '天空', emoji: '🎩', personality: ['豪迈', '梦想家', '意大利人'], lineKey: 'Giovanni Caproni' },
  { mal: 'Kirou Honjou', film: 'kaze', zh: '本庄季郎', ja: '本庄季郎', en: 'Honjo', rarity: 'SR', element: '铁', emoji: '📐', personality: ['理性', '冷峻', '挚友'], lineKey: 'Honjo' },
  { mal: 'Kurokawa', film: 'kaze', zh: '黑川', ja: '黒川', en: 'Kurokawa', rarity: 'R', element: '铁', emoji: '🔧', personality: ['毒舌', '靠谱', '上司'], lineKey: 'Kurokawa' },
  { mal: 'Kayo Horikoshi', film: 'kaze', zh: '堀越加代', ja: '堀越加代', en: 'Kayo Horikoshi', rarity: 'R', element: '光', emoji: '🍙', personality: ['操心', '妹妹'], lineKey: 'Kayo Horikoshi' },
  { mal: 'Wife Kurokawa', film: 'kaze', zh: '黑川夫人', ja: '黒川の妻', en: 'Mrs. Kurokawa', rarity: 'R', element: '光', emoji: '🫖', personality: ['体贴', '周到'], lineKey: 'Mrs. Kurokawa' },
  { mal: 'Castorp', film: 'kaze', zh: '卡斯特鲁普', ja: 'カストルプ', en: 'Castorp', rarity: 'R', element: '风', emoji: '🎿', personality: ['德国人', '潇洒'], lineKey: null },
  { mal: 'Hattori', film: 'kaze', zh: '服部', ja: '服部', en: 'Hattori', rarity: 'N', element: '铁', emoji: '📋', personality: ['官僚', '谨慎'], lineKey: null },

  /* ================= 你想活出怎样的人生 / 君たちはどう生きるか ================= */
  { mal: 'Mahito Maki', film: 'heron', zh: '牧真人', ja: '牧真人', en: 'Mahito Maki', rarity: 'SSR', element: '梦', emoji: '🏹', personality: ['沉默', '敏锐', '少年'], lineKey: 'Mahito Maki' },
  { mal: 'Heron Man', film: 'heron', zh: '苍鹭', ja: '青サギ', en: 'The Grey Heron', rarity: 'SSR', element: '影', emoji: '🐦', personality: ['油滑', '多嘴', '引路'], lineKey: 'The Grey Heron / The Heron Man' },
  { mal: 'Himi', film: 'heron', zh: '火美', ja: 'ヒミ', en: 'Himi', rarity: 'SSR', element: '火', emoji: '🕯️', personality: ['勇敢', '明亮', '母亲'], lineKey: 'Himi' },
  { mal: 'Great Uncle', film: 'heron', zh: '大伯父', ja: '大叔父', en: 'The Great Granduncle', rarity: 'SSR', element: '梦', emoji: '🗼', personality: ['睿智', '苍老', '造物者'], lineKey: 'The Great Granduncle' },
  { mal: 'Kiriko', film: 'heron', zh: '雾子', ja: 'キリコ', en: 'Kiriko', rarity: 'SR', element: '海', emoji: '🛶', personality: ['硬朗', '能干', '老友'], lineKey: 'Kiriko' },
  { mal: 'Parakeet King', film: 'heron', zh: '鹦鹉大王', ja: 'インコ大王', en: 'Parakeet King', rarity: 'SR', element: '铁', emoji: '🦜', personality: ['自大', '暴躁', '滑稽'], lineKey: 'Parakeet King' },
  { mal: 'Warawara', film: 'heron', zh: '哇啦哇啦', ja: 'ワラワラ', en: 'Warawara', rarity: 'R', element: '光', emoji: '☁️', personality: ['成群', '圆滚滚', '转世'], lineKey: 'Warawara' },
  { mal: 'Old Pelican', film: 'heron', zh: '老鹈鹕', ja: '老ペリカン', en: 'Old Pelican', rarity: 'R', element: '影', emoji: '🪶', personality: ['悲苦', '无奈'], lineKey: null },
  { mal: 'Aiko', film: 'heron', zh: '爱子', ja: '愛子', en: 'Aiko', rarity: 'N', element: '光', emoji: '🎎', personality: ['佣人', '和善'], lineKey: null },
  { mal: 'Kazuko', film: 'heron', zh: '和子', ja: '和子', en: 'Kazuko', rarity: 'N', element: '光', emoji: '👘', personality: ['佣人', '好奇'], lineKey: null },
];
