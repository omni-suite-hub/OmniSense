/**
 * OmniSense Pattern & Agreement Radar — Pure Core Module
 *
 * Provides pure logic for:
 * 1. Fake countdown timer heuristics & reload-reset detection
 * 2. Overlay / cookie banner detection & reject button heuristics
 * 3. 5-dimensional service agreement / privacy policy risk analysis
 *
 * Zero browser/DOM dependencies so it can be verified directly in Node.js test harnesses.
 */

/**
 * Parses countdown time strings into total seconds.
 * Matches: "14:59", "01:23:45", "10分30秒", "15 mins", "45 sec".
 */
export function parseCountdownText(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.trim();

  // Digital clock format HH:MM:SS or MM:SS
  const clockMatch = s.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
  if (clockMatch) {
    const hours = clockMatch[1] ? parseInt(clockMatch[1], 10) : 0;
    const minutes = parseInt(clockMatch[2], 10);
    const seconds = parseInt(clockMatch[3], 10);
    if (minutes < 60 && seconds < 60) {
      return {
        matched: clockMatch[0],
        totalSeconds: hours * 3600 + minutes * 60 + seconds
      };
    }
  }

  // Spoken / unit format e.g. "15分20秒" or "10 mins" or "限时 15 分钟" // i18n-allow-cjk
  const hourMatch = s.match(/(\d+)\s*(?:小时|hours?|hrs?)/i); // i18n-allow-cjk
  const minMatch = s.match(/(\d+)\s*(?:分|分钟|mins?|minutes?)/i); // i18n-allow-cjk
  const secMatch = s.match(/(\d+)\s*(?:秒|secs?|seconds?)/i); // i18n-allow-cjk

  if (hourMatch || minMatch || secMatch) {
    const h = hourMatch ? parseInt(hourMatch[1], 10) : 0;
    const m = minMatch ? parseInt(minMatch[1], 10) : 0;
    const sec = secMatch ? parseInt(secMatch[1], 10) : 0;
    const total = h * 3600 + m * 60 + sec;
    if (total > 0 && total <= 86400) {
      const matchedParts = [hourMatch?.[0], minMatch?.[0], secMatch?.[0]].filter(Boolean).join(' ');
      return {
        matched: matchedParts,
        totalSeconds: total
      };
    }
  }

  return null;
}

/**
 * Checks whether a countdown timer has reset itself after a page reload or navigation.
 * A genuine countdown has an absolute target deadline; a fake countdown resets to 15:00, 10:00, etc.
 */
export function evaluateCountdownAuthenticity(historyRecord, currentSeconds, now = Date.now()) {
  if (!historyRecord || typeof historyRecord.firstSeen !== 'number') {
    return { isFake: false, confidence: 0, reason: 'first_observation' };
  }

  const elapsedSeconds = Math.max(0, Math.floor((now - historyRecord.firstSeen) / 1000));
  const expectedRemaining = Math.max(0, historyRecord.initialSeconds - elapsedSeconds);

  // If at least 5 seconds elapsed between observations, and the current timer is
  // substantially higher than expected (e.g. it reset back to initial), it's fake.
  if (elapsedSeconds >= 4 && currentSeconds > expectedRemaining + 3) {
    return {
      isFake: true,
      confidence: 0.95,
      reason: 'reset_on_reload',
      initialSeconds: historyRecord.initialSeconds,
      currentSeconds,
      elapsedSeconds
    };
  }

  // Common artificial pressure intervals: exactly 15m (900s), 10m (600s), 5m (300s)
  const isRoundPsychologicalNumber = [300, 600, 900, 1200, 1800].includes(currentSeconds);
  if (isRoundPsychologicalNumber && historyRecord.observedCount > 1) {
    return {
      isFake: true,
      confidence: 0.75,
      reason: 'round_interval_pattern',
      currentSeconds
    };
  }

  return { isFake: false, confidence: 0.2, reason: 'consistent' };
}

/**
 * Checks if a button or element represents a "Reject All / Essential Only" cookie action.
 */
export function isRejectCookieButton(text, extraAttrs = '') {
  const combined = `${text || ''} ${extraAttrs || ''}`.toLowerCase();
  // Negative override: if it says "accept all" or "agree to all", it is NOT a reject button // i18n-allow-cjk
  if (/(accept\s*all|agree\s*to\s*all|allow\s*all|全部同意|接受全部|同意并继续)/i.test(combined)) { // i18n-allow-cjk
    return false;
  }

  const rejectRegex = /(reject\s*all|decline\s*all|refuse\s*all|essential\s*only|necessary\s*only|deny\s*all|仅必要|仅接受必要|不同意|拒绝全部|拒绝|仅必要cookie)/i; // i18n-allow-cjk
  return rejectRegex.test(combined);
}

/**
 * 5 Dimensions of Agreement Risks
 */
export const AGREEMENT_DIMENSIONS = {
  auto_renewal: {
    key: 'auto_renewal',
    weight: 2,
    patterns: [ // i18n-allow-cjk
      /自动续费/i, /连续包月/i, /连续包年/i, /自动扣款/i, /自动续订/i, /自动扣费/i, /到期自动/i, /免密支付/i, // i18n-allow-cjk
      /auto-renew/i, /recurring charge/i, /automatic renewal/i, /recurring payment/i, /continuous subscription/i // i18n-allow-cjk
    ]
  },
  ip_assignment: {
    key: 'ip_assignment',
    weight: 2,
    patterns: [ // i18n-allow-cjk
      /版权归/i, /著作权归/i, /知识产权归平台/i, /所有权归平台/i, /不可撤销的(?:免费)?授权/i, /不可撤销地许可/i, /独占许可/i, /免费使用权/i, /权利让渡/i, // i18n-allow-cjk
      /intellectual property rights/i, /exclusive license/i, /transfer of ownership/i, /irrevocable license/i, /royalty-free license/i, /assigns all rights/i // i18n-allow-cjk
    ]
  },
  privacy_sharing: {
    key: 'privacy_sharing',
    weight: 2,
    patterns: [ // i18n-allow-cjk
      /共享给第三方/i, /商业化(?:使用|开发)/i, /关联公司共享/i, /合作伙伴共享/i, /人脸信息/i, /生物识别/i, /定向推送/i, /个性化广告/i, /商业用途/i, // i18n-allow-cjk
      /share with third parties/i, /commercial purposes/i, /monetize/i, /third-party partners/i, /biometric data/i, /targeted advertising/i // i18n-allow-cjk
    ]
  },
  disclaimer: {
    key: 'disclaimer',
    weight: 1,
    patterns: [ // i18n-allow-cjk
      /概不负责/i, /免除责任/i, /不承担任何责任/i, /不保证/i, /单方修改而无需通知/i, /随时终止服务且不退款/i, /在法律允许的最大范围内免责/i, // i18n-allow-cjk
      /sole discretion/i, /without prior notice/i, /as is without warranty/i, /limitation of liability/i, /hold harmless/i, /waives any claim/i // i18n-allow-cjk
    ]
  },
  jurisdiction: {
    key: 'jurisdiction',
    weight: 1,
    patterns: [ // i18n-allow-cjk
      /仲裁委员会/i, /仲裁裁决/i, /放弃集体诉讼/i, /平台所在地法院/i, /排他性管辖/i, /专属管辖/i, /管辖权/i, // i18n-allow-cjk
      /binding arbitration/i, /class action waiver/i, /exclusive jurisdiction/i, /governing law/i, /dispute resolution/i // i18n-allow-cjk
    ]
  }
};

/**
 * Scans text (terms of service, user agreement, privacy policy) across 5 risk dimensions.
 */
export function scanAgreementRisks(text) {
  if (!text || typeof text !== 'string') {
    return { overallRisk: 'clean', score: 0, findings: [], totalExcerpts: 0 };
  }

  // Split into sentences / clauses
  const rawSentences = text
    .split(/[\r\n。；;!?！？\n\t]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 8 && s.length <= 350);

  const findings = [];
  let totalScore = 0;

  for (const [dimKey, dimDef] of Object.entries(AGREEMENT_DIMENSIONS)) {
    const matchedExcerpts = [];
    for (const sentence of rawSentences) {
      for (const pattern of dimDef.patterns) {
        if (pattern.test(sentence)) {
          matchedExcerpts.push({
            sentence,
            matchedKeyword: sentence.match(pattern)?.[0] || ''
          });
          break;
        }
      }
      if (matchedExcerpts.length >= 4) break; // cap per dimension
    }

    if (matchedExcerpts.length > 0) {
      const dimScore = Math.min(4, matchedExcerpts.length * dimDef.weight);
      totalScore += dimScore;
      findings.push({
        dimension: dimKey,
        weight: dimDef.weight,
        score: dimScore,
        excerpts: matchedExcerpts
      });
    }
  }

  // Compute risk level
  let overallRisk = 'clean';
  if (totalScore >= 6) {
    overallRisk = 'high';
  } else if (totalScore >= 3) {
    overallRisk = 'medium';
  } else if (totalScore >= 1) {
    overallRisk = 'low';
  }

  return {
    overallRisk,
    score: totalScore,
    findings,
    totalExcerpts: findings.reduce((acc, f) => acc + f.excerpts.length, 0)
  };
}
