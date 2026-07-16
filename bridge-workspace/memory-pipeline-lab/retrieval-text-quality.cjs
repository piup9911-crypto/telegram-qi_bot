const acknowledgementPattern = /^(?:嗯+|哦+|噢+|啊+|呀+|哈+|诶+|唉+|呃+|额+|欸+|好+|行+|可以|知道了|收到|谢谢|哈哈+|嘿嘿+|抱抱+|晚安|早安|嗯呢|嗯嗯|好吧|行吧)$/u;

function semanticCharacters(value) {
  return String(value || '').match(/[\p{Script=Han}A-Za-z0-9]/gu) || [];
}

function normalizedSemanticText(value) {
  return semanticCharacters(value).join('').toLowerCase();
}

function classifyRetrievalText(value) {
  const text = String(value || '').trim();
  const semanticText = normalizedSemanticText(text);
  if (!text || !semanticText) {
    return { eligible: false, reason: 'no_semantic_characters', semantic_text: semanticText };
  }
  if (acknowledgementPattern.test(semanticText)) {
    return { eligible: false, reason: 'acknowledgement_only', semantic_text: semanticText };
  }
  return { eligible: true, reason: 'content_bearing', semantic_text: semanticText };
}

function isLowInformationText(value) {
  return !classifyRetrievalText(value).eligible;
}

module.exports = { classifyRetrievalText, isLowInformationText, normalizedSemanticText };
