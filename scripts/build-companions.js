#!/usr/bin/env node
'use strict';

/*
 * Builds the companion texts shown under each ayah in the browser reader:
 *
 *   data/translation-en-saheeh.json   Saheeh International (QuranEnc english_saheeh)
 *   data/transliteration-en.json      Tanzil English transliteration (en.transliteration)
 *
 * Output shape matches data/quran-uthmani.json, keyed by surah number:
 *   translation:     { "<surah>": [{ "text": "...", "footnotes": "..." }, ...] }
 *   transliteration: { "<surah>": ["...", ...] }
 *
 * Both texts are copied verbatim. No word is added, removed or changed; the
 * reader only formats them at display time (it hides QuranEnc's "(n) " verse
 * label, since the page draws its own number, and turns "[n]" into a footnote
 * link). See data/COMPANION-TEXT-LICENSE.txt for sources and terms.
 *
 * Usage:
 *   node scripts/build-companions.js <english_saheeh.json> <quran_transliteration.json>
 *
 *   english_saheeh.json         QuranEnc english_saheeh v1.1.2, as snapshotted in
 *                               github.com/risan/quran-json data/quranenc/english_saheeh.json
 *                               (sha256 c12b5bed64837cb744e075fdd3b79f885aee1522d92468f36c38ff565bfdc439)
 *   quran_transliteration.json  npm quran-json@3.1.2 dist/quran_transliteration.json
 *                               (Tanzil en.transliteration)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAHEEH_SHA256 = 'c12b5bed64837cb744e075fdd3b79f885aee1522d92468f36c38ff565bfdc439';
const TOTAL = 6236;

const [saheehPath, translitPath] = process.argv.slice(2);
if (!saheehPath || !translitPath) {
  console.error(
    'Usage: node scripts/build-companions.js <english_saheeh.json> <quran_transliteration.json>'
  );
  process.exit(1);
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const surahs = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'surahs.json'), 'utf8')
);
const counts = Object.fromEntries(surahs.map((s) => [s.number, s.ayahs]));

/* ─── translation ─────────────────────────────────────────────────────── */

const saheehRaw = fs.readFileSync(saheehPath);
const digest = crypto.createHash('sha256').update(saheehRaw).digest('hex');
if (digest !== SAHEEH_SHA256) fail(`english_saheeh.json sha256 mismatch: ${digest}`);

const saheeh = JSON.parse(saheehRaw.toString('utf8'));
const translation = {};
let tTotal = 0;
for (let n = 1; n <= 114; n++) {
  const verses = saheeh[String(n)];
  if (!Array.isArray(verses) || verses.length !== counts[n]) {
    fail(`translation: surah ${n} has ${verses && verses.length} ayat, expected ${counts[n]}`);
  }
  translation[n] = verses.map((v, i) => {
    if (v.chapter !== n || v.verse !== i + 1) fail(`translation: misnumbered ${n}:${i + 1}`);
    const out = { text: v.text };
    if (v.footnotes) out.footnotes = v.footnotes;
    return out;
  });
  tTotal += verses.length;
}
if (tTotal !== TOTAL) fail(`translation: ${tTotal} ayat, expected ${TOTAL}`);

/* ─── transliteration ─────────────────────────────────────────────────── */

const translitSrc = JSON.parse(fs.readFileSync(translitPath, 'utf8'));
if (!Array.isArray(translitSrc) || translitSrc.length !== 114) {
  fail('transliteration: expected an array of 114 chapters');
}
const transliteration = {};
let rTotal = 0;
for (const ch of translitSrc) {
  const n = ch.id;
  if (!Array.isArray(ch.verses) || ch.verses.length !== counts[n]) {
    fail(`transliteration: surah ${n} has ${ch.verses && ch.verses.length} ayat`);
  }
  transliteration[n] = ch.verses.map((v, i) => {
    if (v.id !== i + 1) fail(`transliteration: misnumbered ${n}:${i + 1}`);
    if (typeof v.transliteration !== 'string' || !v.transliteration.trim()) {
      fail(`transliteration: empty ${n}:${i + 1}`);
    }
    return v.transliteration;
  });
  rTotal += ch.verses.length;
}
if (rTotal !== TOTAL) fail(`transliteration: ${rTotal} ayat, expected ${TOTAL}`);

/* ─── write ───────────────────────────────────────────────────────────── */

const write = (name, obj) => {
  const p = path.join(__dirname, '..', 'data', name);
  fs.writeFileSync(p, JSON.stringify(obj) + '\n');
  console.log(`Wrote ${name} (${Math.round(fs.statSync(p).size / 1024)} KB)`);
};
write('translation-en-saheeh.json', translation);
write('transliteration-en.json', transliteration);
