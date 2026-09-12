/* ============================================================
   Chapterly — tiny markdown renderer (no dependencies)
   Handles the subset our notes use: headings, paragraphs, bold,
   italic, inline code, links, lists, tables, quotes, hr, fences.
   ============================================================ */
"use strict";

const MD = (() => {

  function inline(s) {
    let out = esc(s);
    // inline code first (protect content)
    const codes = [];
    out = out.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000C${codes.length - 1}\u0000`;
    });
    // links [text](url) — only safe protocols
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
      if (/^(https?:\/\/|mailto:|#)/i.test(u)) {
        return `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`;
      }
      return m;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
    out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    out = out.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    return out;
  }

  function render(md) {
    const src = String(md || "").replace(/\r\n?/g, "\n");
    const lines = src.split("\n");
    const html = [];
    let i = 0;

    const flushList = (tag) => { /* placeholder */ };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length;
        html.push(`<h${lvl}>${inline(h[2].replace(/\s*#+\s*$/, ""))}</h${lvl}>`);
        i++; continue;
      }

      // hr
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { html.push("<hr>"); i++; continue; }

      // table
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
        const parseRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
        const head = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
        const t = ["<table><thead><tr>", head.map(c => `<th>${inline(c)}</th>`).join(""), "</tr></thead><tbody>"];
        for (const r of rows) t.push("<tr>", r.map(c => `<td>${inline(c)}</td>`).join(""), "</tr>");
        t.push("</tbody></table>");
        html.push(t.join(""));
        continue;
      }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        html.push(`<blockquote>${render(buf.join("\n"))}</blockquote>`);
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          let content = lines[i].replace(/^\s*[-*+]\s+/, "");
          i++;
          // continuation lines (indented)
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
            content += " " + lines[i].trim(); i++;
          }
          items.push(`<li>${inline(content)}</li>`);
        }
        html.push(`<ul>${items.join("")}</ul>`);
        continue;
      }

      // ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          let content = lines[i].replace(/^\s*\d+[.)]\s+/, "");
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
            content += " " + lines[i].trim(); i++;
          }
          items.push(`<li>${inline(content)}</li>`);
        }
        html.push(`<ol>${items.join("")}</ol>`);
        continue;
      }

      // blank
      if (!line.trim()) { i++; continue; }

      // paragraph
      const buf = [line];
      i++;
      while (
        i < lines.length && lines[i].trim() &&
        !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i]) &&
        !/^\s*(---+|\*\*\*+|___+)\s*$/.test(lines[i])
      ) { buf.push(lines[i]); i++; }
      html.push(`<p>${inline(buf.join(" ").trim())}</p>`);
    }

    return html.join("\n");
  }

  /* ---- post-render pass: wrap "unverified" sentences in <mark> ----
     flaggedSet: Set of normalized sentence strings (MD.normText form).
     splitter: sentence-splitting function (Engine.splitSentences).
     Works per block element: rebuilds the block's HTML wrapping flagged
     sentences. Inline formatting inside a flagged block is flattened. */
  function normText(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  function wrapFlagged(rootEl, flaggedSet, splitter) {
    if (!flaggedSet || !flaggedSet.size || !rootEl) return;
    const blocks = rootEl.querySelectorAll("li, td, p, blockquote");
    for (const block of blocks) {
      // skip nested containers that will be processed via their own children
      if (block.tagName === "BLOCKQUOTE" && block.querySelector("p, li")) continue;
      const text = block.textContent || "";
      if (!text.trim()) continue;
      const sents = splitter(text);
      const hits = sents.filter(s => s && flaggedSet.has(normText(s)));
      if (!hits.length) continue;
      const html = sents.map(s => {
        if (s && flaggedSet.has(normText(s))) {
          return `<mark class="unverified" title="Not matched in the source text — verify this claim.">${esc(s)}</mark>`;
        }
        return esc(s);
      }).join(" ");
      block.innerHTML = html;
    }
  }

  return { render, wrapFlagged, normText };
})();
