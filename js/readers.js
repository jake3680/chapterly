/* ============================================================
   Chapterly — file readers
   .txt/.md read natively; .pdf via pdf.js and .docx via mammoth,
   both lazily loaded from CDN only when actually needed (so the
   app works offline without them, and files never leave the
   browser — parsing happens locally).
   ============================================================ */
"use strict";

const Readers = (() => {

  const MAX_BYTES = 20 * 1024 * 1024;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function ensurePdfJs() {
    if (window.pdfjsLib) return;
    const base = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
    await loadScript(base + "pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.js";
  }

  async function readPdf(file, onStatus) {
    onStatus && onStatus("Loading PDF engine…");
    await ensurePdfJs();
    onStatus && onStatus("Extracting text…");
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      onStatus && onStatus(`Extracting text — page ${p}/${pdf.numPages}…`);
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      // group items into lines by y coordinate
      const rows = new Map();
      for (const it of tc.items) {
        if (!it.str) continue;
        const y = Math.round(it.transform[5] / 3) * 3;
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push({ x: it.transform[4], str: it.str });
      }
      const ys = [...rows.keys()].sort((a, b) => b - a);
      const lines = ys.map(y => {
        const items = rows.get(y).sort((a, b) => a.x - b.x);
        let line = "";
        for (const it of items) {
          if (line.endsWith("-")) line = line.slice(0, -1) + it.str;
          else line += (line ? " " : "") + it.str;
        }
        return line;
      });
      pages.push(lines.join("\n"));
    }
    const text = pages.join("\n\n")
      .replace(/([a-z])-\n([a-z])/g, "$1$2")
      .replace(/\n{3,}/g, "\n\n");
    if (wordCount(text) < 40) {
      throw new Error("This PDF has almost no extractable text — it may be a scan. Try a text-based PDF or paste the text.");
    }
    return text;
  }

  async function readDocx(file, onStatus) {
    onStatus && onStatus("Loading DOCX engine…");
    if (!window.mammoth) {
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
    }
    onStatus && onStatus("Extracting text…");
    const buf = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return result.value || "";
  }

  async function readFile(file, onStatus) {
    if (file.size > MAX_BYTES) throw new Error("File is larger than 20 MB.");
    const name = file.name || "chapter";
    const lower = name.toLowerCase();
    let text;
    if (lower.endsWith(".pdf")) {
      text = await readPdf(file, onStatus);
    } else if (lower.endsWith(".docx")) {
      text = await readDocx(file, onStatus);
    } else if (lower.endsWith(".doc")) {
      throw new Error("Old .doc format isn't supported — save as .docx, or copy-paste the text.");
    } else {
      text = await file.text();
    }
    text = Engine.normalizeText(text);
    return { text: text, name: name.replace(/\.[^.]+$/, "") };
  }

  return { readFile: readFile };
})();
