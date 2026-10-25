'use strict';

// Script files: .textream (a JSON array of page strings, same as the Mac
// app), plain text and Markdown, and PowerPoint presenter notes.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

async function readDocument(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pptx') return { pages: await extractPptxNotes(fs.readFileSync(file)), imported: true };
  if (ext === '.key') {
    throw new Error('Keynote files can\'t be imported directly. In Keynote, choose File → Export To → PowerPoint, then open the .pptx.');
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (ext === '.textream') {
    const pages = JSON.parse(raw);
    if (!Array.isArray(pages) || !pages.every((p) => typeof p === 'string')) {
      throw new Error('This .textream file is not valid.');
    }
    return { pages: pages.length ? pages : [''], imported: false };
  }
  return { pages: [raw.replace(/\r\n/g, '\n')], imported: true };
}

function writeDocument(file, pages) {
  fs.writeFileSync(file, JSON.stringify(pages));
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e] ?? m;
  });
}

/// Text of one notesSlide XML. Skips the slide-number, slide-image, date,
/// header and footer placeholders, like PresentationNotesExtractor.swift.
function parseNotesXml(xml) {
  const paragraphs = [];
  const shapes = xml.split(/<p:sp[\s>]/).slice(1);
  for (const shape of shapes) {
    const ph = shape.match(/<p:ph\b[^>]*?type="([^"]+)"/);
    if (ph && ['sldNum', 'sldImg', 'dt', 'hdr', 'ftr'].includes(ph[1])) continue;
    const body = shape.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/);
    if (!body) continue;
    const paras = body[1].match(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g) || [];
    for (const p of paras) {
      let text = '';
      const parts = p.match(/<a:t>[\s\S]*?<\/a:t>|<a:t\/>|<a:br\/>|<a:br>[\s\S]*?<\/a:br>/g) || [];
      for (const part of parts) {
        if (part.startsWith('<a:br')) text += '\n';
        else if (part !== '<a:t/>') text += decodeXml(part.slice(5, -6));
      }
      paragraphs.push(text);
    }
  }
  return paragraphs.join('\n');
}

function relTargets(xml) {
  const map = {};
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/);
    const target = m[0].match(/\bTarget="([^"]+)"/);
    if (id && target) map[id[1]] = target[1];
  }
  return map;
}

/// Notes files in the order the slides appear in the deck. notesSlideN
/// numbering drifts from slide order when slides are moved, so follow
/// presentation.xml → slide → notes relationships. Null if anything is
/// missing.
async function notesInSlideOrder(zip) {
  const read = async (name) => (zip.file(name) ? zip.file(name).async('string') : null);
  const pres = await read('ppt/presentation.xml');
  const presRels = await read('ppt/_rels/presentation.xml.rels');
  if (!pres || !presRels) return null;
  const targets = relTargets(presRels);
  const ids = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => m[1]);
  const result = [];
  for (const id of ids) {
    if (!targets[id]) continue;
    const slide = path.posix.normalize(path.posix.join('ppt', targets[id]));
    const rels = await read(path.posix.join(path.posix.dirname(slide), '_rels', `${path.posix.basename(slide)}.rels`));
    if (!rels) continue;
    const notes = Object.values(relTargets(rels)).find((t) => /notesSlide\d+\.xml$/.test(t));
    if (notes) result.push(path.posix.normalize(path.posix.join(path.posix.dirname(slide), notes)));
  }
  return result.length ? result.filter((n) => zip.file(n)) : null;
}

async function extractPptxNotes(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (e) {
    throw new Error('Could not read this PowerPoint file.');
  }
  const names = (await notesInSlideOrder(zip)) || Object.keys(zip.files)
    .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const pages = [];
  for (const name of names) {
    const text = parseNotesXml(await zip.file(name).async('string')).trim();
    if (text && !/^\d+$/.test(text)) pages.push(text);
  }
  if (!pages.length) throw new Error('No presenter notes found in this presentation.');
  return pages;
}

module.exports = { readDocument, writeDocument, extractPptxNotes, parseNotesXml };
