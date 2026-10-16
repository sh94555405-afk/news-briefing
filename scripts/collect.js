/**
 * 뉴스 수집 & Gemini 요약 스크립트
 * GitHub Actions에서 실행됨
 * 결과: public/news.json
 */

import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR  = path.join(__dirname, '..', 'public');
const OUTPUT      = path.join(OUTPUT_DIR, 'news.json');
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const parser      = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// ── RSS 피드 목록 ──────────────────────────────────────
const FEEDS = [
  { name: '한국경제',      url: 'https://www.hankyung.com/feed/all-news',                                                cat: '경제'  },
  { name: '매일경제',      url: 'https://www.mk.co.kr/rss/40300001/',                                                   cat: '경제'  },
  { name: 'ZDNet Korea',   url: 'https://zdnet.co.kr/rss/',                                                             cat: 'IT'    },
  { name: 'Google 부동산', url: 'https://news.google.com/rss/search?q=부동산&hl=ko&gl=KR&ceid=KR:ko',                  cat: '부동산'},
  { name: 'Google 정치',   url: 'https://news.google.com/rss/search?q=국회+정치&hl=ko&gl=KR&ceid=KR:ko',              cat: '정치'  },
  { name: 'Google 사회',   url: 'https://news.google.com/rss/search?q=사건+사고+사회&hl=ko&gl=KR&ceid=KR:ko',         cat: '사회'  },
  { name: 'Google 국제',   url: 'https://news.google.com/rss/search?q=국제+외교&hl=ko&gl=KR&ceid=KR:ko',              cat: '국제'  },
  { name: 'Google IT',     url: 'https://news.google.com/rss/search?q=IT+인공지능+반도체&hl=ko&gl=KR&ceid=KR:ko',     cat: 'IT'    },
  { name: 'Google 스포츠', url: 'https://news.google.com/rss/search?q=스포츠+야구+축구&hl=ko&gl=KR&ceid=KR:ko',      cat: '스포츠'},
  { name: 'Google 경제',   url: 'https://news.google.com/rss/search?q=경제+금리+환율&hl=ko&gl=KR&ceid=KR:ko',        cat: '경제'  },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0; +https://github.com/sh94555405-afk/news-briefing)',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
};

// ── RSS 수집 ───────────────────────────────────────────
async function fetchFeed(feed) {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(feed.url, { headers: HEADERS, signal: controller.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml  = await res.text();
    const data = parser.parse(xml);

    const channel = data?.rss?.channel || data?.feed;
    if (!channel) throw new Error('채널 없음');

    let items = channel.item || channel.entry || [];
    if (!Array.isArray(items)) items = [items];

    return items.slice(0, 15).map(item => {
      const title   = cleanText(typeof item.title === 'object' ? item.title['#text'] : item.title || '');
      const link    = item.link?.['@_href'] || (typeof item.link === 'string' ? item.link : '') || item.guid?.['#text'] || item.guid || '';
      const desc    = cleanText(item.description || item.summary?.['#text'] || item.summary || item['content:encoded'] || '');
      const pubDate = parseDate(item.pubDate || item.updated || item.published || '');
      if (!title || !link) return null;
      return { title, desc, link, pubDate, source: feed.name, cat: feed.cat };
    }).filter(Boolean);

  } catch (e) {
    console.warn(`⚠️  ${feed.name} 실패: ${e.message}`);
    return [];
  }
}

// ── Gemini 일괄 요약 ───────────────────────────────────
async function summarizeWithGemini(articles) {
  if (!GEMINI_KEY) {
    console.warn('GEMINI_API_KEY 없음 — 요약 건너뜀');
    return articles.map(a => ({ ...a, summary: a.desc.slice(0, 80), importance: 5 }));
  }

  const BATCH = 25;
  const result = [];

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    const prompt = `아래 뉴스 기사들을 분석해서 JSON 배열만 응답해줘. 마크다운 없이 순수 JSON만.
각 항목:
- summary: 한국어 한 문장 요약 (40자 이내)
- importance: 중요도 1~10
- cat: 부동산/경제/정치/사회/문화/IT/국제/스포츠 중 하나

기사:
${batch.map((a, i) => `${i}. [${a.cat}] ${a.title}`).join('\n')}

응답(JSON 배열만):`;

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
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
      const geminiOut = JSON.parse(cleaned);

      batch.forEach((article, idx) => {
        result.push({
          ...article,
          summary:    geminiOut[idx]?.summary    || article.desc.slice(0, 80),
          importance: geminiOut[idx]?.importance || 5,
          cat:        geminiOut[idx]?.cat        || article.cat,
        });
      });

      if (i + BATCH < articles.length) await sleep(1200);
    } catch (e) {
      console.warn(`⚠️  Gemini 배치 실패: ${e.message}`);
      batch.forEach(a => result.push({ ...a, summary: a.desc.slice(0, 80), importance: 5 }));
    }
  }
  return result;
}

// ── 메인 ──────────────────────────────────────────────
async function main() {
  console.log('📡 RSS 수집 시작...');

  // public 폴더 생성 (없으면)
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // 병렬 수집
  const results = await Promise.allSettled(FEEDS.map(f => fetchFeed(f)));
  let articles = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // 중복 제거
  const seen = new Set();
  articles = articles.filter(a => {
    if (seen.has(a.link)) return false;
    seen.add(a.link);
    return true;
  });

  console.log(`✅ ${articles.length}개 기사 수집 완료`);

  if (articles.length === 0) {
    console.error('❌ 수집된 기사가 없습니다');
    process.exit(1);
  }

  console.log('🤖 Gemini 요약 중...');
  articles = await summarizeWithGemini(articles);

  // 중요도 내림차순 정렬
  articles.sort((a, b) => (b.importance - a.importance) || ((b.pubDate || 0) - (a.pubDate || 0)));
  articles = articles.slice(0, 100);

  const output = {
    updatedAt:    new Date().toISOString(),
    updatedAtKST: new Date(Date.now() + 9*60*60*1000).toISOString().slice(0,16).replace('T',' ') + ' KST',
    count:        articles.length,
    articles:     articles.map(a => ({
      ...a,
      pubDate: a.pubDate ? new Date(a.pubDate).toISOString() : null,
      desc:    (a.desc || '').slice(0, 200),
    })),
  };

  await fs.writeFile(OUTPUT, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`💾 저장 완료: ${articles.length}개 기사`);
  console.log(`⏰ ${output.updatedAtKST}`);
}

function cleanText(s) {
  return (s || '').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/\s+/g,' ').trim();
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

main().catch(e => { console.error(e); process.exit(1); });
