/**
 * 뉴스 수집 & Gemini 요약 스크립트
 * GitHub Actions에서 실행됨
 * 결과: public/news.json
 */

import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, '..', 'public', 'news.json');
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// ── RSS 피드 목록 ──────────────────────────────────────
const FEEDS = [
  { name: '한국경제',      url: 'https://www.hankyung.com/feed/all-news',                                                      cat: '경제'  },
  { name: '연합뉴스 정치', url: 'https://www.yonhapnews.co.kr/rss/politics.xml',                                               cat: '정치'  },
  { name: 'KBS 사회',      url: 'https://news.kbs.co.kr/data/rss/rss_society.xml',                                            cat: '사회'  },
  { name: 'ZDNet Korea',   url: 'https://zdnet.co.kr/rss/',                                                                   cat: 'IT'    },
  { name: '연합뉴스 국제', url: 'https://www.yonhapnews.co.kr/rss/international.xml',                                         cat: '국제'  },
  { name: 'Google 부동산', url: 'https://news.google.com/rss/search?q=부동산&hl=ko&gl=KR&ceid=KR:ko',                        cat: '부동산'},
  { name: 'Google 스포츠', url: 'https://news.google.com/rss/search?q=스포츠+야구+축구&hl=ko&gl=KR&ceid=KR:ko',             cat: '스포츠'},
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0; +https://github.com/sh94555405-afk/news-briefing)',
  'Accept': 'application/rss+xml, application/xml, text/xml',
};

// ── RSS 수집 ───────────────────────────────────────────
async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: HEADERS, timeout: 10000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = await parseStringPromise(xml, { explicitArray: false });

    const channel = parsed?.rss?.channel || parsed?.feed;
    const items = channel?.item || channel?.entry || [];
    const list = Array.isArray(items) ? items : [items];

    return list.slice(0, 12).map(item => ({
      title:   cleanText(item.title?.$?._ || item.title?._ || item.title || ''),
      desc:    cleanText(item.description?._ || item.description || item.summary?._ || item.summary || ''),
      link:    item.link?.href || item.link?._ || item.link || item.guid?._ || item.guid || '',
      pubDate: parseDate(item.pubDate || item.updated || item.published || ''),
      source:  feed.name,
      cat:     feed.cat,
    })).filter(a => a.title && a.link);
  } catch (e) {
    console.warn(`⚠️  ${feed.name} 수집 실패: ${e.message}`);
    return [];
  }
}

// ── Gemini 일괄 요약 ───────────────────────────────────
async function summarizeWithGemini(articles) {
  if (!GEMINI_KEY) {
    console.warn('GEMINI_API_KEY 없음 — 요약 건너뜀');
    return articles.map(a => ({ ...a, summary: a.desc.slice(0, 80), importance: 5 }));
  }

  // 한 번에 최대 30개씩 배치 처리
  const BATCH = 30;
  const result = [];

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    const prompt = `아래 뉴스 기사 목록을 분석해서 JSON 배열로 응답해줘.
각 항목에 대해:
- summary: 한국어 한 문장 요약 (50자 이내)
- importance: 중요도 1~10 (사회적 파급력 기준)
- cat: 카테고리 재분류 (부동산/경제/정치/사회/문화/IT/국제/스포츠 중 하나)

기사 목록:
${batch.map((a, idx) => `${idx}. [${a.cat}] ${a.title}\n${a.desc.slice(0, 100)}`).join('\n\n')}

응답 형식 (JSON만, 마크다운 없이):
[{"summary":"...","importance":8,"cat":"경제"},...]`;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
          }),
        }
      );

      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
      const geminiResults = JSON.parse(cleaned);

      batch.forEach((article, idx) => {
        result.push({
          ...article,
          summary:    geminiResults[idx]?.summary    || article.desc.slice(0, 80),
          importance: geminiResults[idx]?.importance || 5,
          cat:        geminiResults[idx]?.cat        || article.cat,
        });
      });

      // Rate limit 방지
      if (i + BATCH < articles.length) await sleep(1000);

    } catch (e) {
      console.warn(`⚠️  Gemini 배치 ${i} 실패: ${e.message}`);
      batch.forEach(a => result.push({ ...a, summary: a.desc.slice(0, 80), importance: 5 }));
    }
  }

  return result;
}

// ── 메인 ──────────────────────────────────────────────
async function main() {
  console.log('📡 RSS 수집 시작...');

  // 병렬 수집
  const feedResults = await Promise.allSettled(FEEDS.map(f => fetchFeed(f)));
  let articles = feedResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // 중복 제거 (link 기준)
  const seen = new Set();
  articles = articles.filter(a => {
    if (seen.has(a.link)) return false;
    seen.add(a.link);
    return true;
  });

  console.log(`✅ ${articles.length}개 기사 수집 완료`);
  console.log('🤖 Gemini 요약 중...');

  // Gemini 요약
  articles = await summarizeWithGemini(articles);

  // 중요도 내림차순 정렬
  articles.sort((a, b) => (b.importance - a.importance) || (b.pubDate - a.pubDate));

  // 최대 100개
  articles = articles.slice(0, 100);

  // 저장
  const output = {
    updatedAt: new Date().toISOString(),
    updatedAtKST: new Date(Date.now() + 9*60*60*1000).toISOString().replace('T',' ').slice(0,16) + ' KST',
    count: articles.length,
    articles: articles.map(a => ({
      ...a,
      pubDate: a.pubDate ? new Date(a.pubDate).toISOString() : null,
      desc: a.desc.slice(0, 200),
    })),
  };

  await fs.writeFile(OUTPUT, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`💾 ${OUTPUT} 저장 완료 (${articles.length}개)`);
  console.log(`⏰ 업데이트 시각: ${output.updatedAtKST}`);
}

// ── 유틸 ──────────────────────────────────────────────
function cleanText(str) {
  return (str || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.getTime();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

main().catch(e => { console.error(e); process.exit(1); });
