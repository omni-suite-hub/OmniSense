(async () => {
  try {
    const allScripts = Array.from(document.querySelectorAll('script[src]'));
    const allLinks = Array.from(document.querySelectorAll('a[href], link[href]'));
    const allForms = Array.from(document.querySelectorAll('form'));
    const allInputs = Array.from(document.querySelectorAll('input, textarea, select'));

    const domainSet = new Set();
    const addDomain = (url) => {
      try {
        const u = new URL(url, location.href);
        if (u.hostname && u.hostname !== location.hostname) domainSet.add(u.hostname);
      } catch (e) {}
    };

    allScripts.forEach(s => addDomain(s.src));
    allLinks.forEach(l => addDomain(l.href));

    const scriptDomainSet = new Set();
    allScripts.forEach(s => {
      try {
        const u = new URL(s.src, location.href);
        if (u.hostname && u.hostname !== location.hostname) scriptDomainSet.add(u.hostname);
      } catch (e) {}
    });

    const htmlLower = document.documentElement.innerHTML.toLowerCase();

    // Known tracker patterns
    const trackerPatterns = [
      { name: 'Google Analytics', patterns: ['google-analytics.com', 'googletagmanager.com', 'gtag'] },
      { name: 'Facebook Pixel', patterns: ['facebook.com/tr', 'connect.facebook.net'] },
      { name: 'Twitter/X', patterns: ['twitter.com/i/ads', 'static.ads-twitter.com'] },
      { name: 'LinkedIn Insight', patterns: ['licdn.com', 'linkedin.com/tracking'] },
      { name: 'Baidu Tongji', patterns: ['hm.baidu.com', 'baidu.com/hm.js'] },
      { name: 'Hotjar', patterns: ['hotjar.com'] }
    ];

    const trackers = [];
    trackerPatterns.forEach(({ name, patterns }) => {
      const hits = [];
      [...allScripts.map(s => s.src), htmlLower].forEach(src => {
        if (patterns.some(p => src.includes(p))) hits.push(name);
      });
      if (hits.length) trackers.push(name);
    });

    // Hidden form fields
    const hiddenInputs = allInputs.filter(i => {
      const type = (i.getAttribute('type') || '').toLowerCase();
      const style = window.getComputedStyle(i);
      return type === 'hidden' ||
        (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0);
    });

    // External cookie setters (heuristic via external script domains)
    const hasCookieCode = htmlLower.includes('document.cookie');
    const cookieSetters = Array.from(scriptDomainSet).filter(d => {
      return htmlLower.includes(d) && hasCookieCode;
    });

    const knownAd = new Set(['google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googleadservices.com',
      'facebook.com', 'connect.facebook.net', 'static.ads-twitter.com', 'ads.linkedin.com',
      'hm.baidu.com', 'hotjar.com', 'scorecardresearch.com', 'amazon-adsystem.com']);
    const knownCount = Array.from(domainSet).filter(d => [...knownAd].some(k => d.includes(k))).length;

    const risk = trackers.length > 2 || hiddenInputs.length > 3 ? 'high' : trackers.length > 0 || hiddenInputs.length > 0 ? 'medium' : 'low';

    return {
      risk,
      trackers: [...new Set(trackers)],
      hiddenFields: hiddenInputs.length,
      hiddenFieldNames: hiddenInputs.slice(0, 10).map(i => i.name || i.id || '(unnamed)'),
      cookieSetters: [...new Set(cookieSetters)],
      externalDomains: [...domainSet],
      knownAdDomains: knownCount
    };
  } catch (e) {
    return { risk: 'low', error: e.message };
  }
})();
