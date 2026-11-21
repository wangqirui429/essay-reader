/**
 * Interface strings.
 *
 * The app ships in Chinese by default and can be switched to English in
 * Settings. Nothing here affects the *contents* of a meaning card: those come
 * from the dictionary and are always Chinese, which is the point of the app.
 *
 * Usage:
 *   t('home.hero')            -> string
 *   t('reader.seen', {n: 3})  -> string with {n} substituted
 */

const STRINGS = {
  zh: {
    'app.name': '英语作文阅读器',
    'app.tagline': '读英语文章，点一下生词就看中文释义',
    'app.description': '阅读英语文章，点击不认识的单词即可固定显示它的中文释义。',

    'nav.essays': '文章',
    'nav.words': '生词本',
    'nav.settings': '设置',
    'nav.main': '主导航',

    'home.hero': '读英语文章，点一下不认识的单词。',
    'home.heroSub': '导入你自己的文章，点任意单词就在它旁边固定显示中文释义。释义会一直留在屏幕上，直到你主动关闭。',
    'home.importTitle': '导入文章',
    'home.titleLabel': '标题',
    'home.titleOptional': '选填',
    'home.titlePlaceholder': '例如：第三单元作文',
    'home.textLabel': '文章内容',
    'home.textRequired': '必填',
    'home.textPlaceholder': '把文章粘贴到这里。段落之间空一行。第一行较短时会作为标题。',
    'home.read': '开始阅读',
    'home.loadFile': '从 .txt 文件导入',
    'home.loadSample': '载入示例文章',
    'home.myEssays': '我的文章',
    'home.empty': '还没有导入文章。在上面粘贴一篇开始吧。',
    'home.dropzone': '把 .txt 文件拖到本页任意位置即可导入。',
    'home.tooShort': '内容太短了，至少要 15 个单词左右。',
    'home.untitled': '未命名文章',
    'home.fileTooShort': '“{name}” 里的英文内容不够。',
    'home.loadingSample': '正在载入示例文章…',
    'home.sampleLoaded': '示例文章已导入。',
    'home.sampleFailed': '示例文章载入失败：{msg}',

    'tile.words': '{n} 词',
    'tile.paragraphs': '{n} 段',
    'tile.lookedUp': '已查 {n} 词',
    'tile.read': '阅读',
    'tile.rename': '重命名',
    'tile.delete': '删除',
    'tile.renamePrompt': '给这篇文章起个新标题：',
    'tile.confirmDelete': '删除《{title}》？生词本里的单词会保留。',
    'tile.deleted': '文章已删除。',

    'reader.back': '‹ 文章列表',
    'reader.untitled': '未命名',
    'reader.meta': '{words} 词 · {paras} 段 · 导入于 {date}',
    'reader.closeAll': '关闭全部卡片',
    'reader.closeAllTitle': '关闭所有释义卡片',
    'reader.controls': '阅读设置',
    'reader.textSize': '字号',
    'reader.smaller': '缩小字号',
    'reader.larger': '放大字号',
    'reader.seen': '已查 {n} 个单词',
    'reader.hint': '点单词查释义；点卡片顶部任意位置即可关闭。',
    'reader.tooManyCards': '最多同时固定 {n} 张卡片，请先关掉一张。',
    'reader.cardsOpen': '{n} 张已打开',
    'reader.allClosed': '已关闭全部释义卡片。',

    'words.title': '生词本',
    'words.lede': '你点过的每个单词都会记在这里，并附上中文释义。',
    'words.search': '按单词或释义搜索',
    'words.export': '导出列表',
    'words.clear': '清空',
    'words.count': '共 {total} 词，显示 {shown} 个',
    'words.empty': '还没有记录。打开一篇文章，点一个不认识的单词试试。',
    'words.noMatch': '没有找到与 “{q}” 匹配的单词。',
    'words.lookups': '{n} 次查询',
    'words.hear': '朗读这个单词',
    'words.remove': '移除',
    'words.removed': '已从生词本移除 “{word}”。',
    'words.alreadyEmpty': '生词本已经是空的了。',
    'words.confirmClear': '清空所有生词？导入的文章不受影响。',
    'words.cleared': '生词本已清空。',
    'words.noMeaning': '未存释义',

    'card.noMeaning': '没有查到这个词的中文释义，可以检查拼写或网络连接。',
    'card.loading': '正在查 “{word}”…',
    'card.loadingDictionary': '词典还在下载，稍等一下，查到就会显示在这里。',
    'card.phrases': '常用短语',
    'card.dictionaryLine': '词典释义',
    'card.sentence': '例句',
    'card.baseForm': '此释义来自该词的原形 “{word}”。',
    'card.fallback': '词典里没有收录这个词，上面的释义来自内置的简表。',
    'card.hear': '朗读这个单词',
    'card.close': '关闭这张卡片',

    'speak.unsupported': '这个浏览器不支持语音朗读。',
    'speak.silent': '语音没有发声：你的设备可能没有安装英语语音包，可在系统设置里添加英语语音后重试。',
    'speak.failed': '语音朗读失败，请再点一次试试。',

    'settings.title': '设置',
    'settings.appearance': '外观',
    'settings.tone': '页面底色',
    'settings.tonePaper': '米色',
    'settings.toneLight': '白色',
    'settings.toneDark': '深色',
    'settings.textSize': '字号',
    'settings.lineWidth': '舒适的行宽',
    'settings.dictionary': '词典',
    'settings.dictNote': '完整的英汉词典内置在应用里，所以每个单词都能离线查询，不需要开电脑。释义、音标和考试标签来自开源的 ECDICT 词库。',
    'settings.dictLoading': '正在载入内置词典…',
    'settings.dictReady': '内置词典已就绪 — 共 {n} 个词条，可离线使用。{extra}',
    'settings.dictServerExtra': '本地服务还在补充常用短语和例句。',
    'settings.dictFailed': '内置词典载入失败：{msg}',
    'settings.phone': '在手机上使用',
    'settings.phoneNote': '这个应用完全在浏览器里运行。在手机上用 Chrome 或 Safari 打开它，选择「添加到主屏幕」，之后就能全屏打开，飞行模式下也照常使用。',
    'settings.installed': '已安装就绪 — 这份副本存在你的设备上，没有网络也能用。',
    'settings.installedBare': '正以已安装应用的方式运行。',
    'settings.offlineReady': '支持离线。打开浏览器菜单并选择「添加到主屏幕」。',
    'settings.offlineNotReady': '本次浏览器会话的离线支持还没有激活。',
    'settings.data': '你的数据',
    'settings.dataNote': '文章和生词只保存在本浏览器里。',
    'settings.export': '下载备份',
    'settings.restore': '恢复备份',
    'settings.wipe': '删除全部数据',
    'settings.confirmWipe': '删除本浏览器里所有导入的文章和生词？',
    'settings.wiped': '已删除全部本地数据。',
    'settings.backupRestored': '备份已恢复。',
    'settings.stats': '已导入文章：{essays}\n文章总词数：{essayWords}\n生词本：{words}\n卡片打开次数：{clicks}',
    'settings.language': '语言',
    'settings.languageNote': '界面语言。单词释义始终为中文。',
    'settings.langZh': '中文',
    'settings.langEn': 'English',

    'settings.account': '账号与同步',
    'settings.accountNote': '连接之后，你在手机和电脑上看到的文章、生词和阅读进度会保持一致。',
    'settings.tokenNote': '同步使用你自己的 GitHub 账号：内容保存在你账号下的一条私密 Gist 里，不经过任何第三方服务器。',
    'settings.token': '访问令牌',
    'settings.tokenPlaceholder': '粘贴令牌（ghp_ 开头）',
    'settings.tokenHelp': '令牌只需要 gist 这一个权限，无法读取你的代码仓库。',
    'settings.connect': '连接',
    'settings.getToken': '获取令牌',
    'settings.signOut': '断开连接',
    'settings.syncNow': '立即同步',
    'settings.signedOut': '已断开连接。本机的文章和生词仍然保留。',

    'sync.syncing': '正在同步…',
    'sync.synced': '已同步 — 刚刚更新。',
    'sync.syncedAgo': '已同步 — {when}。',
    'sync.never': '还没有同步过。',
    'sync.offline': '当前离线，恢复网络后会自动同步。',
    'sync.error': '同步失败：{msg}',
    'sync.expired': '登录已过期，请重新登录。',
    'sync.connecting': '正在连接…',
    'sync.tooLarge': '文章和生词太多了，超出同步容量。',

    'auth.no_token': '请先粘贴访问令牌。',
    'auth.bad_token': '这个令牌无效或已经失效，请重新生成一个。',
    'auth.bad_scope': '这个令牌没有 gist 权限，重新生成时请勾选 gist。',
    'auth.rate_limited': '请求太频繁了，请稍等几分钟再试。',
    'auth.network': '连不上 GitHub，请检查网络。',
    'auth.session_expired': '令牌已失效，请重新连接。',
    'auth.unknown': '出错了：{msg}',

    'time.justNow': '刚刚',
    'time.minutesAgo': '{n} 分钟前',
    'time.hoursAgo': '{n} 小时前',
    'time.daysAgo': '{n} 天前',
  },

  en: {
    'app.name': 'Essay Reader',
    'app.tagline': 'Read English essays. Tap any word you do not know.',
    'app.description': 'Read English essays and pin the Chinese meaning of any word you do not know.',

    'nav.essays': 'Essays',
    'nav.words': 'Saved Words',
    'nav.settings': 'Settings',
    'nav.main': 'Main',

    'home.hero': 'Read English essays. Tap any word you do not know.',
    'home.heroSub': 'Import your own essays, then click a word to pin its Chinese meaning beside it. The meaning stays on screen until you close it — it never disappears by itself.',
    'home.importTitle': 'Import an essay',
    'home.titleLabel': 'Title',
    'home.titleOptional': 'optional',
    'home.titlePlaceholder': 'e.g. My Unit 3 Draft',
    'home.textLabel': 'Essay text',
    'home.textRequired': 'required',
    'home.textPlaceholder': 'Paste your essay here. Use a blank line between paragraphs. A short first line becomes the heading.',
    'home.read': 'Read this essay',
    'home.loadFile': 'Load a .txt file',
    'home.loadSample': 'Load a sample essay',
    'home.myEssays': 'My essays',
    'home.empty': 'Nothing imported yet. Paste an essay above to begin.',
    'home.dropzone': 'Drag a .txt file anywhere on this page to import it.',
    'home.tooShort': 'That is too short. Paste at least about 15 words.',
    'home.untitled': 'Untitled essay',
    'home.fileTooShort': '“{name}” did not contain enough English text.',
    'home.loadingSample': 'Loading the sample essay…',
    'home.sampleLoaded': 'Sample essay imported.',
    'home.sampleFailed': 'Could not load the sample: {msg}',

    'tile.words': '{n} words',
    'tile.paragraphs': '{n} paragraphs',
    'tile.lookedUp': '{n} looked up',
    'tile.read': 'Read',
    'tile.rename': 'Rename',
    'tile.delete': 'Delete',
    'tile.renamePrompt': 'New title for this essay:',
    'tile.confirmDelete': 'Delete “{title}”? Saved words stay in your wordbook.',
    'tile.deleted': 'Essay deleted.',

    'reader.back': '‹ Essays',
    'reader.untitled': 'Untitled',
    'reader.meta': '{words} words · {paras} paragraphs · imported {date}',
    'reader.closeAll': 'Close all cards',
    'reader.closeAllTitle': 'Close every meaning card',
    'reader.controls': 'Reading controls',
    'reader.textSize': 'Text size',
    'reader.smaller': 'Smaller text',
    'reader.larger': 'Larger text',
    'reader.seen': '{n} words looked up',
    'reader.hint': 'Click a word for its meaning. Tap anywhere on the card top to close it.',
    'reader.tooManyCards': 'Only the first {n} cards can stay open. Close one and try again.',
    'reader.cardsOpen': '{n} open',
    'reader.allClosed': 'All meaning cards closed.',

    'words.title': 'Saved words',
    'words.lede': 'Every word you have clicked is recorded here with its Chinese meaning.',
    'words.search': 'Search by word or meaning',
    'words.export': 'Export list',
    'words.clear': 'Clear all',
    'words.count': '{shown} of {total} words',
    'words.empty': 'No words saved yet. Open an essay and click a word you do not know.',
    'words.noMatch': 'Nothing matches “{q}”.',
    'words.lookups': '{n} lookups',
    'words.hear': 'Hear this word',
    'words.remove': 'Remove',
    'words.removed': 'Removed “{word}” from saved words.',
    'words.alreadyEmpty': 'Saved words are already empty.',
    'words.confirmClear': 'Remove every saved word? Your imported essays are not touched.',
    'words.cleared': 'Saved words cleared.',
    'words.noMeaning': 'no meaning stored',

    'card.noMeaning': 'No Chinese meaning was found for this word. Try another spelling, or check your connection.',
    'card.loading': 'Looking up “{word}”…',
    'card.loadingDictionary': 'The dictionary is still downloading. The meaning will appear here as soon as it arrives.',
    'card.phrases': 'Common phrases',
    'card.dictionaryLine': 'Dictionary line',
    'card.sentence': 'In a sentence',
    'card.baseForm': 'Shown from “{word}”, the base form of this word.',
    'card.fallback': 'This word is not in the bundled dictionary; the meaning above comes from a short built-in fallback list.',
    'card.hear': 'Hear this word',
    'card.close': 'Close this card',

    'speak.unsupported': 'This browser cannot read words aloud.',
    'speak.silent': 'No sound: your device may have no English voice installed. Add one in system settings and try again.',
    'speak.failed': 'Speech failed. Try tapping again.',

    'settings.title': 'Settings',
    'settings.appearance': 'Appearance',
    'settings.tone': 'Page tone',
    'settings.tonePaper': 'Paper',
    'settings.toneLight': 'White',
    'settings.toneDark': 'Dark',
    'settings.textSize': 'Text size',
    'settings.lineWidth': 'Comfortable line width',
    'settings.dictionary': 'Dictionary',
    'settings.dictNote': 'The whole English–Chinese dictionary ships inside this app, so every word works with no network and no computer running. Meanings, phonetics and exam tags come from the open ECDICT database.',
    'settings.dictLoading': 'Loading the bundled dictionary…',
    'settings.dictReady': 'Bundled dictionary ready — {n} entries, works offline.{extra}',
    'settings.dictServerExtra': ' A local server is also adding phrases and example sentences.',
    'settings.dictFailed': 'The bundled dictionary could not be loaded: {msg}',
    'settings.phone': 'Use it on your phone',
    'settings.phoneNote': 'This app runs entirely in the browser. On a phone, open it in Chrome or Safari and choose “Add to Home Screen” — it then opens full screen and keeps working in airplane mode.',
    'settings.installed': 'Installed and ready — this copy is stored on your device and works with no network.',
    'settings.installedBare': 'Running as an installed app.',
    'settings.offlineReady': 'Available offline. Open your browser menu and choose “Add to Home Screen”.',
    'settings.offlineNotReady': 'Offline support is not active in this browser session yet.',
    'settings.data': 'Your data',
    'settings.dataNote': 'Essays and saved words are stored only in this browser.',
    'settings.export': 'Download backup',
    'settings.restore': 'Restore backup',
    'settings.wipe': 'Delete everything',
    'settings.confirmWipe': 'Delete every imported essay and saved word in this browser?',
    'settings.wiped': 'All local data deleted.',
    'settings.backupRestored': 'Backup restored.',
    'settings.stats': 'essays imported: {essays}\nwords in those essays: {essayWords}\nwords saved: {words}\ntotal card openings: {clicks}',
    'settings.language': 'Language',
    'settings.languageNote': 'Interface language. Word meanings are always in Chinese.',
    'settings.langZh': '中文',
    'settings.langEn': 'English',

    'settings.account': 'Account & sync',
    'settings.accountNote': 'Connect to keep the same essays, saved words and progress on your phone and your computer.',
    'settings.tokenNote': 'Sync runs through your own GitHub account: the data lives in one private gist in that account and never touches a third-party server.',
    'settings.token': 'Access token',
    'settings.tokenPlaceholder': 'Paste the token (starts with ghp_)',
    'settings.tokenHelp': 'The token needs the gist scope only. It cannot read your repositories.',
    'settings.connect': 'Connect',
    'settings.getToken': 'Get a token',
    'settings.signOut': 'Disconnect',
    'settings.syncNow': 'Sync now',
    'settings.signedOut': 'Disconnected. The essays and words on this device are still here.',

    'sync.syncing': 'Syncing…',
    'sync.synced': 'Synced — just now.',
    'sync.syncedAgo': 'Synced — {when}.',
    'sync.never': 'Not synced yet.',
    'sync.offline': 'Offline. It will sync when the connection returns.',
    'sync.error': 'Sync failed: {msg}',
    'sync.expired': 'Your session expired. Please sign in again.',
    'sync.connecting': 'Connecting…',
    'sync.tooLarge': 'Too many essays and words to fit in the sync store.',

    'auth.no_token': 'Paste an access token first.',
    'auth.bad_token': 'That token is not valid or has expired. Create a new one.',
    'auth.bad_scope': 'That token has no gist permission. Tick gist when you create it.',
    'auth.rate_limited': 'Too many requests. Wait a few minutes and try again.',
    'auth.network': 'Could not reach GitHub. Check your connection.',
    'auth.session_expired': 'That token stopped working. Please connect again.',
    'auth.unknown': 'Something went wrong: {msg}',

    'time.justNow': 'just now',
    'time.minutesAgo': '{n} min ago',
    'time.hoursAgo': '{n} h ago',
    'time.daysAgo': '{n} d ago',
  },
};

const STORAGE_KEY = 'essay-reader:lang';

let current = 'zh';

/** Pick the language to start in: saved choice first, then Chinese. */
export function initLang() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  current = saved === 'en' ? 'en' : 'zh';
  return current;
}

export function getLang() {
  return current;
}

export function setLang(lang) {
  current = lang === 'en' ? 'en' : 'zh';
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    /* best effort */
  }
  document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';
  return current;
}

/**
 * Look up a string, substituting {name} placeholders.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 */
export function t(key, vars) {
  const table = STRINGS[current] || STRINGS.zh;
  let text = table[key];
  if (text == null) {
    // Missing translations surface as the key itself, which is easy to spot.
    return STRINGS.en[key] ?? key;
  }
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/**
 * Apply translations to the static markup: any element with data-i18n is filled
 * with its string, and data-i18n-attr sets attributes like placeholder/title.
 */
export function applyStaticTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    const value = t(key);
    // Keep nested elements (like an optional hint inside a label) intact.
    const onlyText = el.children.length === 0;
    if (onlyText) el.textContent = value;
    else {
      const textNode = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.nodeValue = value;
      else el.textContent = value;
    }
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    // Format: "placeholder:home.textPlaceholder,title:reader.closeAllTitle"
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  if (root === document) {
    document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';
    document.title = t('app.name');
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', t('app.description'));
  }
}
