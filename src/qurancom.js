'use strict';

/*
 * Quran.com word-by-word transliteration, fetched live.
 *
 * Quran Foundation's developer terms (https://api-docs.quran.foundation/legal/developer-terms)
 * forbid redistributing its content as a bundled dataset and storing it longer
 * than a week. So nothing is written to disk: each surah is fetched when the
 * reader first needs it and kept in memory for this process only (the web
 * reader shuts down minutes after its tab closes). Offline, or if the API
 * refuses, callers fall back to the bundled Tanzil transliteration.
 */

const API = 'https://api.quran.com/api/v4/verses/by_chapter';
const PER_PAGE = 50;
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** surah number -> { at, ayat: string[] } | { at, pending: Promise } */
const cache = new Map();

/** Join a verse's words, skipping the ayah-end marker. */
function joinWords(words) {
  return (words || [])
    .filter((w) => w && w.char_type_name !== 'end')
    .map((w) => w.transliteration && w.transliteration.text)
    .filter((t) => typeof t === 'string' && t.trim())
    .join(' ');
}

async function fetchJson(url, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`quran.com ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transliteration of every ayah in a surah, in order.
 * @param {number} surah
 * @param {{ ayahs: number, fetch?: typeof fetch, now?: () => number }} opts
 * @returns {Promise<string[]>} rejects when offline or the data doesn't line up
 */
async function surahTransliteration(surah, opts) {
  const now = (opts.now || Date.now)();
  const hit = cache.get(surah);
  if (hit && now - hit.at < TTL_MS) return hit.ayat || hit.pending;

  const fetchImpl = opts.fetch || globalThis.fetch;
  const pending = (async () => {
    const ayat = [];
    for (let page = 1; ayat.length < opts.ayahs; page++) {
      const url = `${API}/${surah}?words=true&word_fields=text_uthmani&per_page=${PER_PAGE}&page=${page}`;
      const data = await fetchJson(url, fetchImpl);
      const verses = (data && data.verses) || [];
      if (!verses.length) break;
      for (const v of verses) {
        const [s, a] = String(v.verse_key).split(':').map(Number);
        if (s !== surah || a !== ayat.length + 1) throw new Error(`quran.com order at ${v.verse_key}`);
        ayat.push(joinWords(v.words));
      }
    }
    if (ayat.length !== opts.ayahs || ayat.some((t) => !t)) {
      throw new Error(`quran.com returned ${ayat.length} of ${opts.ayahs} ayat for surah ${surah}`);
    }
    return ayat;
  })();

  cache.set(surah, { at: now, pending });
  try {
    const ayat = await pending;
    cache.set(surah, { at: now, ayat });
    return ayat;
  } catch (err) {
    cache.delete(surah);
    throw err;
  }
}

function clearCache() {
  cache.clear();
}

module.exports = { surahTransliteration, joinWords, clearCache, TTL_MS };
