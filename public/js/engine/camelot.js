const PITCH_TO_SEMITONE = {
  C: 0, 'B#': 0,
  'C#': 1, Db: 1,
  D: 2,
  'D#': 3, Eb: 3,
  E: 4, Fb: 4,
  F: 5, 'E#': 5,
  'F#': 6, Gb: 6,
  G: 7,
  'G#': 8, Ab: 8,
  A: 9,
  'A#': 10, Bb: 10,
  B: 11, Cb: 11,
};

const CAMELOT_TABLE = {
  '0:minor': '5A', '0:major': '8B',
  '1:minor': '12A', '1:major': '3B',
  '2:minor': '7A', '2:major': '10B',
  '3:minor': '2A', '3:major': '5B',
  '4:minor': '9A', '4:major': '12B',
  '5:minor': '4A', '5:major': '7B',
  '6:minor': '11A', '6:major': '2B',
  '7:minor': '6A', '7:major': '9B',
  '8:minor': '1A', '8:major': '4B',
  '9:minor': '8A', '9:major': '11B',
  '10:minor': '3A', '10:major': '6B',
  '11:minor': '10A', '11:major': '1B',
};

export function toCamelot(keyName, scale = 'minor') {
  if (!keyName) return null;
  let cleanKey = String(keyName).trim();
  let cleanScale = String(scale || 'minor').toLowerCase();
  if (/m$/i.test(cleanKey) && cleanKey.length > 1) {
    cleanKey = cleanKey.slice(0, -1);
    cleanScale = 'minor';
  }
  const semi = PITCH_TO_SEMITONE[cleanKey];
  if (semi === undefined) return null;
  const mode = cleanScale.includes('maj') ? 'major' : 'minor';
  return {
    key: `${cleanKey}${mode === 'minor' ? 'm' : ''}`,
    camelot: CAMELOT_TABLE[`${semi}:${mode}`] || null,
    semitone: semi,
    mode,
  };
}

export function parseCamelot(code) {
  if (!code || typeof code !== 'string') return null;
  const m = code.trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
  if (!m) return null;
  return { num: Number(m[1]), letter: m[2] };
}

export function shiftCamelot(code, semitones = 0) {
  const p = parseCamelot(code);
  if (!p) return null;
  const s = Math.round(Number(semitones) || 0);
  if (s === 0) return code;
  // +1 semitone = +7 on Camelot circle of fifths mod 12
  const num = (((p.num - 1) + s * 7) % 12 + 12) % 12 + 1;
  return `${num}${p.letter}`;
}

export function camelotDistance(camelotA, camelotB) {
  const a = parseCamelot(camelotA);
  const b = parseCamelot(camelotB);
  if (!a || !b) return 99;
  const raw = Math.abs(a.num - b.num);
  const wheelDiff = Math.min(raw, 12 - raw);
  if (a.letter === b.letter) return wheelDiff;
  if (wheelDiff === 0) return 1; // relative major/minor (0 steps + letter swap = 1 step!)
  return wheelDiff + 1;
}

export function getHarmonicMatch(camelotA, camelotB) {
  const a = parseCamelot(camelotA);
  const b = parseCamelot(camelotB);
  if (!a || !b) {
    return { score: 14, compatible: true, relation: 'key unknown', semitoneShift: 0 };
  }

  if (a.num === b.num && a.letter === b.letter) {
    return { score: 35, compatible: true, relation: `exact lock (${camelotA})`, semitoneShift: 0 };
  }
  if (a.num === b.num && a.letter !== b.letter) {
    return { score: 31, compatible: true, relation: `relative mod (${camelotA}↔${camelotB})`, semitoneShift: 0 };
  }

  const diff = (b.num - a.num + 12) % 12;
  if (a.letter === b.letter && (diff === 1 || diff === 11)) {
    return {
      score: 29,
      compatible: true,
      relation: diff === 1 ? `energy lift +1 (${camelotA}→${camelotB})` : `smooth drop -1 (${camelotA}→${camelotB})`,
      semitoneShift: 0,
    };
  }
  if (a.letter === b.letter && diff === 2) {
    return {
      score: 24,
      compatible: true,
      relation: `energy boost +2 (${camelotA}→${camelotB})`,
      semitoneShift: 0,
    };
  }
  if (a.letter === b.letter && (diff === 7 || diff === 5)) {
    // 7 Camelot steps = +1 semitone, 5 steps = -1 semitone!
    const shift = diff === 7 ? -1 : 1;
    return {
      score: 22,
      compatible: true,
      relation: `pitch-lock ${shift > 0 ? '+1' : '-1'}st (${camelotA}→${camelotB})`,
      semitoneShift: shift,
    };
  }

  return { score: 6, compatible: false, relation: `clash (${camelotA} vs ${camelotB})`, semitoneShift: 0 };
}
