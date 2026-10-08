#!/usr/bin/env node
// **Markdown → .docx**（没有依赖：自己拼 OOXML 包）。
//
// 为什么要有它：比赛/申报那一套材料最后都要**文字版 Word**（模板要往里抄、要打印签字），
// 而仓库里没有 pandoc、也没有 python-docx（2026-10-07 实测）。
//
// 用法：
//   node scripts/md-to-docx.mjs <input.md> <output.docx>
//
// 支持（够用就行，不贪）：`#`~`####` 标题 · 段落 · `-`/`*` 项目符号 · `|` 表格 ·
//   `**粗体**` · `` `代码` ``（按普通文字走） · `>` 引用（按普通段落） · 分隔线（忽略）。
// ⚠️ 不支持的语法**当普通文字**发出去 —— **绝不吞掉内容**（少字比难看严重）。

import nodeFs from 'node:fs';
import nodeZlib from 'node:zlib';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('用法：node scripts/md-to-docx.mjs <input.md> <output.docx>');
  process.exit(2);
}

const md = nodeFs.readFileSync(inPath, 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 行内：`**粗**` 拆成多个 run；别的记号原样留着（不吞字）。 */
function runs(text) {
  const out = [];
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (part === '') continue;
    const bold = part.startsWith('**') && part.endsWith('**');
    const body = bold ? part.slice(2, -2) : part;
    out.push(
      `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="24"/></w:rPr>` +
        `<w:t xml:space="preserve">${esc(body)}</w:t></w:r>`,
    );
  }
  return out.join('') || '<w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve"></w:t></w:r>';
}

const para = (text, { size = 24, bold = false, center = false, indent = false, bullet = false } = {}) => {
  const ppr =
    '<w:pPr>' +
    (center ? '<w:jc w:val="center"/>' : '') +
    (indent || bullet ? '<w:ind w:firstLine="480"/>' : '') +
    '</w:pPr>';
  const body = runs(text);
  const fixed = bold
    ? body.replace(/<w:rPr>/g, '<w:rPr><w:b/>').replace(/<w:sz w:val="24"\/>/g, `<w:sz w:val="${size}"/>`)
    : body.replace(/<w:sz w:val="24"\/>/g, `<w:sz w:val="${size}"/>`);
  return `<w:p>${ppr}${fixed}</w:p>`;
};

/** 表格：真表格（`<w:tbl>`），表头加粗。 */
function table(rows) {
  const width = Math.floor(9360 / Math.max(1, rows[0].length));
  const cell = (text, head) =>
    '<w:tc><w:tcPr>' +
    `<w:tcW w:w="${width}" w:type="dxa"/>` +
    '<w:tcBorders>' +
    ['top', 'left', 'bottom', 'right']
      .map((k) => `<w:${k} w:val="single" w:sz="6" w:color="999999"/>`)
      .join('') +
    '</w:tcBorders></w:tcPr>' +
    para(text, { bold: head }) +
    '</w:tc>';
  const tr = (cells, head) => '<w:tr>' + cells.map((c) => cell(c, head)).join('') + '</w:tr>';
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/></w:tblPr>' +
    tr(rows[0], true) +
    rows.slice(1).map((r) => tr(r, false)).join('') +
    '</w:tbl><w:p/>'
  );
}

const lines = md.split('\n');
const out = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i].replace(/\s+$/, '');
  // 表格：连续以 | 开头的行
  if (/^\s*\|/.test(line)) {
    const rows = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) {
      const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      // 分隔行（|---|）跳过
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      i += 1;
    }
    i -= 1;
    if (rows.length) out.push(table(rows));
    continue;
  }
  if (/^#{1,4}\s/.test(line)) {
    const lvl = line.match(/^#+/)[0].length;
    const text = line.replace(/^#+\s*/, '');
    const sizes = { 1: 36, 2: 28, 3: 26, 4: 24 };
    out.push(para(text, { bold: true, size: sizes[lvl], center: lvl === 1 }));
    continue;
  }
  if (/^\s*[-*]\s+/.test(line)) {
    out.push(para('· ' + line.replace(/^\s*[-*]\s+/, ''), { bullet: true }));
    continue;
  }
  if (/^\s*>\s?/.test(line)) {
    out.push(para(line.replace(/^\s*>\s?/, ''), { indent: true }));
    continue;
  }
  if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) continue; // 分隔线
  if (line.trim() === '') continue;
  out.push(para(line, { indent: true }));
}

const document =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  out.join('') +
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1418" w:bottom="1440" w:left="1418"/></w:sectPr>' +
  '</w:body></w:document>';

const contentTypes =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';
const rels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
  'Target="word/document.xml"/></Relationships>';

// 手写一个最小 zip（**不用压缩**：`stored` 就够，Word 照收）
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0 ^ -1;
    for (const b of buf) c = (c >>> 8) ^ crcTable[(c ^ b) & 0xff];
    return (c ^ -1) >>> 0;
  };
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

nodeFs.writeFileSync(
  outPath,
  zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['word/document.xml', document],
  ]),
);
console.log(`✅ ${outPath}（${nodeFs.statSync(outPath).size} 字节 · 段落/表格 ${out.length} 块）`);
