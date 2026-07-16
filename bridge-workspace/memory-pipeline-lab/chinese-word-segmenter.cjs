const { Jieba } = require('@node-rs/jieba');
const { dict } = require('@node-rs/jieba/dict');

const ENGINE_VERSION = '@node-rs/jieba@2.0.1-search-v1';

const STOP_WORDS = new Set([
  '的', '了', '吗', '呢', '啊', '呀', '哦', '吧', '嘛', '我', '你', '他', '她', '它',
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '一个', '一些', '什么',
  '怎么', '为什么', '是不是', '有没有', '是否', '哪天', '时候', '后来', '最后',
  '现在', '目前', '之前', '以前', '当时', '已经', '还有', '以及', '或者', '可以'
]);

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanToken(value) {
  return normalize(value).replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
}

function isIndexable(token) {
  if (!token || STOP_WORDS.has(token)) return false;
  if (/^[\p{Script=Han}]+$/u.test(token)) return [...token].length >= 2;
  if (/[a-z0-9]/i.test(token)) return token.replace(/[^a-z0-9]/gi, '').length >= 2;
  return false;
}

function uniqueTokens(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const token = cleanToken(value);
    if (!isIndexable(token) || seen.has(token)) continue;
    seen.add(token);
    output.push(token);
  }
  return output;
}

function dictionaryTerms(values) {
  const terms = [];
  for (const value of values || []) {
    const normalized = normalize(value);
    if (!normalized) continue;
    for (const part of normalized.split(/[\s,，、/|;；:：()[\]{}<>《》]+/u)) {
      const token = cleanToken(part);
      if (!isIndexable(token) || [...token].length > 40) continue;
      terms.push(token);
    }
  }
  return uniqueTokens(terms);
}

function createChineseWordSegmenter(domainTerms = []) {
  const jieba = Jieba.withDict(dict);
  const customTerms = dictionaryTerms(domainTerms);
  if (customTerms.length) {
    const customDictionary = customTerms.map((term) => `${term} 100000 nz`).join('\n') + '\n';
    jieba.loadDict(Buffer.from(customDictionary, 'utf8'));
  }

  function segment(value) {
    const text = normalize(value);
    if (!text) return [];
    const cut = jieba.cutForSearch(text, true);
    const latin = text.match(/[a-z0-9][a-z0-9@._+/-]*/gi) || [];
    return uniqueTokens([...cut, ...latin]);
  }

  function aliasTokens(values) {
    const output = [];
    for (const value of values || []) {
      const normalized = normalize(value);
      if (!normalized) continue;
      output.push(...segment(normalized));
      if (!/\s/u.test(normalized)) output.push(normalized);
    }
    return uniqueTokens(output);
  }

  return {
    engineVersion: ENGINE_VERSION,
    customTerms,
    queryTerms: segment,
    indexDocument(text, aliases = []) {
      return {
        words: segment(text),
        aliases: aliasTokens(aliases)
      };
    }
  };
}

module.exports = {
  ENGINE_VERSION,
  STOP_WORDS,
  createChineseWordSegmenter,
  dictionaryTerms,
  normalize
};
