#!/usr/bin/env node
// tools/fontcheck.js — sanity-check the bundled fonts.
// Every font here is used to render digit glyphs (0-9) at generation time, so a
// missing digit silently produces blank images. Reports: TTF magic, glyph count
// for 0-9, and whether the basic punctuation a face needs is present.
'use strict';
const fs = require('fs');
const path = require('path');

const NEEDED = ['0123456789', ':-.°/ APM'];
const dir = path.join(__dirname, '..', 'assets', 'fonts');

// minimal cmap reader (formats 4 and 12 cover every font we bundle)
function cmap(buf) {
  const numTables = buf.readUInt16BE(4);
  let cmapOff = 0;
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    if (buf.toString('ascii', off, off + 4) === 'cmap') cmapOff = buf.readUInt32BE(off + 8);
  }
  const codes = new Set();
  if (!cmapOff) return codes;
  const n = buf.readUInt16BE(cmapOff + 2);
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8;
    const sub = cmapOff + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = buf.readUInt16BE(sub + 6), seg = segX2 / 2;
      const endO = sub + 14, startO = endO + segX2 + 2;
      for (let s = 0; s < seg; s++) {
        const end = buf.readUInt16BE(endO + s * 2), start = buf.readUInt16BE(startO + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) codes.add(c);
      }
    } else if (format === 12) {
      const nGroups = buf.readUInt32BE(sub + 12);
      for (let g = 0; g < nGroups; g++) {
        const o = sub + 16 + g * 12;
        const start = buf.readUInt32BE(o), end = buf.readUInt32BE(o + 4);
        for (let c = start; c <= end && c <= 0xffff; c++) codes.add(c);
      }
    }
  }
  return codes;
}

const files = fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f)).sort();
let bad = 0;
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const magic = buf.readUInt32BE(0);
  const ok = magic === 0x00010000 || magic === 0x74727565 || magic === 0x4f54544f;
  const codes = cmap(buf);
  const missing = [];
  for (const ch of NEEDED) if (!codes.has(ch.codePointAt(0))) missing.push(ch === ' ' ? 'space' : ch);
  const digits = '0123456789'.split('').filter((d) => codes.has(d.codePointAt(0))).length;
  const status = ok && digits === 10 ? 'ok  ' : 'BAD ';
  if (status === 'BAD ') bad++;
  console.log(`${status}${f.padEnd(32)} digits ${digits}/10  glyphs ${String(codes.size).padStart(5)}${missing.length ? `  missing: ${missing.join('')}` : ''}`);
}
console.log(bad ? `\n${bad} font(s) need attention` : `\nall ${files.length} fonts carry 0-9`);
process.exit(bad ? 1 : 0);
