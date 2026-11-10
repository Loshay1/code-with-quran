'use strict';

const fs = require('fs');
const path = require('path');
const { clampPosition } = require('./quran');

const TEXT = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'quran-uthmani.json'), 'utf8')
);

/** The opening basmalah — shown as an unnumbered header, not stored per-ayah. */
const BASMALAH = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';

/**
 * Uthmani text of one ayah.
 * @param {number} surah
 * @param {number} ayah
 * @returns {string}
 */
function ayahText(surah, ayah) {
  const pos = clampPosition({ surah, ayah });
  return TEXT[pos.surah][pos.ayah - 1];
}

/**
 * Does this surah open with an (unnumbered) basmalah?
 * Every surah except Al-Fatihah (1, where it is ayah 1) and At-Tawbah (9, none).
 * @param {number} surah
 */
function hasOpeningBasmalah(surah) {
  return surah !== 1 && surah !== 9;
}

/** Convert 255 -> "٢٥٥" (Arabic-Indic digits), for the ۝ ayah marker. */
function toArabicDigits(n) {
  return String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
}

/*
 * Companion texts (translation, transliteration). Loaded on first use so the
 * hook path, which only moves the pointer, never pays to parse them.
 * See data/COMPANION-TEXT-LICENSE.txt.
 */
const companions = {};
function companion(name) {
  if (!(name in companions)) {
    try {
      companions[name] = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'data', name), 'utf8')
      );
    } catch {
      companions[name] = null;
    }
  }
  return companions[name];
}

/**
 * Saheeh International translation of one ayah, verbatim from QuranEnc.
 * @returns {{ text: string, footnotes?: string } | null}
 */
function translationOf(surah, ayah) {
  const data = companion('translation-en-saheeh.json');
  if (!data) return null;
  const pos = clampPosition({ surah, ayah });
  return data[pos.surah][pos.ayah - 1] || null;
}

/**
 * Tanzil English transliteration of one ayah, verbatim.
 * @returns {string | null}
 */
function transliterationOf(surah, ayah) {
  const data = companion('transliteration-en.json');
  if (!data) return null;
  const pos = clampPosition({ surah, ayah });
  return data[pos.surah][pos.ayah - 1] || null;
}

module.exports = {
  BASMALAH,
  ayahText,
  hasOpeningBasmalah,
  toArabicDigits,
  translationOf,
  transliterationOf,
};
