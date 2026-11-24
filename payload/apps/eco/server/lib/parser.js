'use strict';

/**
 * AIWorkKit Eco - progress signal parser.
 *
 * Turns unstructured command output into quantifiable progress. Supports:
 *   - explicit eco markers : @eco 35/100 build label
 *   - percentages            : "Downloading 45.3%"
 *   - ratios                 : "3/10 tasks"
 *   - step wording           : "step 4 of 12", "第 4 步/共 12 步"
 *   - ASCII bars             : "[#####-------]"
 */

const MARKER = /@eco\s+(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*(.*)$/i;
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%/;
const RATIO = /(?:^|[\s(\[])(\d{1,9})\s*\/\s*(\d{1,9})(?:[\s)\]]|$)/;
const STEP = /(?:step|progress|阶段|进度|第)\s*[:=]?\s*(\d{1,9})\s*(?:of|\/|共|步|个)\s*(?:共)?\s*(\d{1,9})/i;
const BAR = /\[([#=>.\-\s]{4,120})\]/;

const NOISE = /^\s*(\$|>)\s|^\s*PS [A-Z]:|^\s*$|warning: |^\s+at /i;

function clean(line) {
  return String(line || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .trim();
}

/**
 * @returns {{current:number|null,total:number|null,percent:number|null,label:string}|null}
 */
function parseLine(rawLine) {
  const line = clean(rawLine);
  if (!line || line.length > 400 || NOISE.test(line)) return null;

  const marker = MARKER.exec(line);
  if (marker) {
    const current = Number(marker[1]);
    const total = marker[2] != null ? Number(marker[2]) : null;
    return {
      current,
      total,
      percent: total ? (current / total) * 100 : null,
      label: (marker[3] || '').trim()
    };
  }

  const step = STEP.exec(line);
  if (step) {
    return { current: Number(step[1]), total: Number(step[2]), percent: null, label: '' };
  }

  const ratio = RATIO.exec(line);
  if (ratio) {
    const current = Number(ratio[1]);
    const total = Number(ratio[2]);
    if (total > 0 && current <= total) {
      return { current, total, percent: null, label: '' };
    }
  }

  const pct = PERCENT.exec(line);
  if (pct) {
    const percent = Number(pct[1]);
    if (percent >= 0 && percent <= 100) {
      return { current: null, total: null, percent, label: '' };
    }
  }

  const bar = BAR.exec(line);
  if (bar) {
    const body = bar[1];
    const filled = (body.match(/[#=>]/g) || []).length;
    const total = body.replace(/\s/g, '').length;
    if (total >= 4 && filled <= total) {
      return { current: filled, total, percent: (filled / total) * 100, label: '' };
    }
  }

  return null;
}

/** Keep the most informative label found on the line (short human text). */
function pickLabel(line) {
  const text = clean(line);
  if (!text) return '';
  const stripped = text.replace(PERCENT, '').replace(/[.\s]{2,}/g, ' ').trim();
  return stripped.slice(0, 120);
}

module.exports = { parseLine, pickLabel, clean };
