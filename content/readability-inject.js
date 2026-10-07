(async () => {
  try {
    const moduleUrl = chrome.runtime.getURL('vendor/readability/readability.js');
    const { Readability } = await import(moduleUrl);
    const doc = document.cloneNode(true);
    const article = new Readability(doc).parse();
    if (!article || !article.textContent || article.textContent.trim().length < 80) {
      return { isArticle: false };
    }
    return {
      isArticle: true,
      title: article.title || document.title,
      text: article.textContent,
      excerpt: article.excerpt || article.textContent.slice(0, 240)
    };
  } catch (e) {
    return { isArticle: false, error: e.message };
  }
})();
