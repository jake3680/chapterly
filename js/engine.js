/* ============================================================
   Chapterly — Instant (offline) notes engine
   Extractive summarizer: every sentence in the notes comes
   verbatim from the source, so hallucination is impossible by
   construction. Also provides the integrity checker that scores
   AI-generated notes against the source, plus flashcard & quiz
   builders that work from any parsed notes.
   ============================================================ */
"use strict";

const Engine = (() => {

  /* ---------------- stop words ---------------- */
  const STOP = new Set(("a,an,the,and,or,but,if,then,than,so,as,at,by,for,from,in,into,of,on,onto,to,up,down,with,without,within,about,above,below,over,under,again,further,once,here,there,when,where,why,how,all,any,both,each,few,more,most,other,some,such,no,nor,not,only,own,same,too,very,can,will,just,should,now,is,are,was,were,be,been,being,am,do,does,did,doing,have,has,had,having,would,could,might,must,shall,may,i,me,my,we,our,you,your,he,him,his,she,her,it,its,they,them,their,this,that,these,those,what,which,who,whom,whose,while,because,until,after,before,during,between,among,through,also,however,although,though,yet,rather,thus,hence,therefore,upon,per,via,etc,especially,usually,often,sometimes,generally,typically,may,many,much,several,various,different,similar,new,old,first,second,third,next,last,other,one,two,three,four,five,six,seven,eight,nine,ten,even,ever,never,always,let,make,made,take,took,get,got,give,gave,go,goes,went,come,came,use,used,using,see,seen,know,known,think,find,found,say,said,tell,ask,work,put,mean,means,thing,things,way,ways,word,words,term,terms,chapter,book,section,part,example,examples,note,notes").split(","));

  const GENERIC_TERMS = new Set("word,term,process,idea,name,result,reason,problem,question,example,type,kind,way,thing,part,area,place,point,fact,number,amount,level,state,form,system,person,people,time,year,day,man,men,woman,women,group,case,study,order,side,end,start,beginning,change,use,user,value,power,control,life,world,hand,eye,head,home,house,city,country,government,school,student,students,reaction,molecule,stage,stage,stages,cycle,carrier,organism,organisms,structure,feature,method,approach".split(","));

  const ABBR = new Set("mr,mrs,ms,dr,prof,sr,jr,st,mt,vs,etc,eg,ie,fig,figs,approx,inc,ltd,co,corp,no,nos,vol,ch,sec,pp,p,cf,al,capt,sgt,col,gen,rev,hon,dept,univ,est,ca,ed,eds,trans,phd,md,ba,ma,mba,bc,ad,bc,ce,bce,usa,uk,us,eu".split(","));

  const PRONOUN_STARTS = new Set("this,these,those,it,its,they,there,here,he,she,we,you,i,in,on,at,by,for,with,from,but,and,or,if,as,when,while,that,which,who,whose,whom,his,her,their,our,your,my,one,two,some,most,many,such,both,each,every,all,only,not,no,now,then,first,second,next,also,however,although,because,since,after,before,during,between,among,about,into,over,under,again,further,once,why,how,what,where,the,a,an,above,below,meanwhile,moreover,furthermore,likewise,instead,namely,specifically,particularly,today".split(","));

  /* ---------------- text normalization ---------------- */
  function normalizeText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/([a-z])-\n([a-z])/g, "$1$2")
      .replace(/\u00ad/g, "")
      .split("\n").map(l => l.replace(/[ \t]+/g, " ").trimEnd()).join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /* ---------------- sentence splitting ---------------- */
  function splitSentences(par) {
    const out = [];
    let buf = "";
    const push = () => { const s = buf.trim(); if (s) out.push(s); buf = ""; };
    const n = par.length;
    for (let i = 0; i < n; i++) {
      const c = par[i];
      buf += c;
      if (c === "." || c === "!" || c === "?") {
        while (i + 1 < n && /[.!?"')\]]/.test(par[i + 1])) { i++; buf += par[i]; }
        const next = par[i + 1];
        if (next !== undefined && next !== " " && next !== "\n") continue;
        const lastWord = ((buf.match(/[A-Za-z.]+["')\]]*$/) || [""])[0])
          .toLowerCase().replace(/[.]/g, "").replace(/["')\]]/g, "");
        if (c === "." && lastWord.length === 1) continue;   // initials: "J. K."
        if (c === "." && ABBR.has(lastWord)) continue;      // abbreviations
        const after = (par.slice(i + 1).match(/^\s+(\S)/) || [])[1];
        if (after === undefined) { push(); continue; }
        if (c === "." && /[a-z]/.test(after)) continue;     // lowercase continuation
        push();
      }
    }
    push();
    return out;
  }

  /* ---------------- tokenizing & stemming ---------------- */
  function stem(w) {
    if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
    if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
    if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
    return w;
  }

  function tokens(s) {
    return String(s).toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
      .map(stem);
  }

  function normKey(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function stripInlineMd(s) {
    return String(s)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/`([^`]*)`/g, "$1")
      .trim();
  }

  /* ---------------- headings & sections ---------------- */
  function titleCase(s) {
    return s.toLowerCase().replace(/(^|\s)([a-z])/g, (_, a, b) => a + b.toUpperCase());
  }

  function headingOf(line) {
    const t = line.trim();
    if (!t || t.length > 90) return null;
    if (/^\d+$/.test(t)) return null;
    let m;
    if ((m = t.match(/^(#{1,6})\s+(.+)$/))) return { level: Math.min(m[1].length, 3), text: m[2].trim().replace(/\s*#+\s*$/, "") };
    if ((m = t.match(/^(chapter|part|section|unit|lecture|lesson|module)\s+[\dIVXivxlc]+/i)) && t.length <= 90) return { level: 1, text: t.replace(/\s*[.:—-]\s*$/, "") };
    if ((m = t.match(/^\*\*(.+?)\*\*\s*:?$/)) && m[1].length <= 80) return { level: 2, text: m[1] };
    if ((m = t.match(/^\d+(\.\d+)*[.)]?\s+([A-Z].{2,78})$/))) return { level: 2, text: m[2] };
    if (t.length >= 4 && t.length <= 60 && t === t.toUpperCase() && /^[A-Z0-9]/.test(t) && /[A-Z]{2,}/.test(t) && /[ A-Z]/.test(t)) return { level: 2, text: titleCase(t) };
    if ((m = t.match(/^([A-Z][^.!?]{2,58}):$/))) return { level: 2, text: m[1] };
    return null;
  }

  function titleLike(t) {
    if (t.length < 4 || t.length > 70) return false;
    const words = t.split(/\s+/);
    if (words.length < 2 || words.length > 9) return false;
    if (!/^[A-Z0-9"'(]/.test(t)) return false;
    if (/[.,;]/.test(t)) return false;
    // the last word of a heading is virtually never lowercase prose
    const last = words[words.length - 1].replace(/[^A-Za-z]/g, "");
    const FUNC = new Set("of,the,and,a,an,in,to,for,with,on,at,by,as,is,are,or,its,into,from,vs,per".split(","));
    if (last && last === last.toLowerCase() && !FUNC.has(last.toLowerCase())) return false;
    // reject sentences: too many lowercase content words after the first
    let lowerContent = 0;
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/[^A-Za-z]/g, "");
      if (w && w === w.toLowerCase() && !FUNC.has(w.toLowerCase())) lowerContent++;
    }
    if (lowerContent >= Math.max(2, words.length * 0.34)) return false;
    return true;
  }

  function splitTitleBlocks(text) {
    const blocks = [];
    let cur = [];
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (/^#{1,6}\s/.test(line)) {
        if (cur.length) { blocks.push(cur); cur = []; }
        blocks.push([line]);
        continue;
      }
      if (!line) {
        if (cur.length) { blocks.push(cur); cur = []; }
      } else {
        cur.push(line);
      }
    }
    if (cur.length) blocks.push(cur);
    return blocks;
  }

  function splitSections(text) {
    const blocks = splitTitleBlocks(text);
    const sections = [];
    let docTitle = null;
    let seenHeading = false;
    let headingCount = 0;
    let cur = null;

    for (const block of blocks) {
      let head = null;
      if (block.length === 1) {
        head = headingOf(block[0]) || (titleLike(block[0]) ? { level: 2, text: block[0] } : null);
      }
      if (head) {
        headingCount++;
        if (!seenHeading) {
          // first heading in the text is the chapter title, not a section
          docTitle = head.text;
          seenHeading = true;
          continue;
        }
        if (cur && (cur.paras.length || cur.title)) sections.push(cur);
        cur = { title: head.text, paras: [] };
      } else {
        const p = block.join(" ").trim();
        if (!p) continue;
        if (!cur) cur = { title: "", paras: [] };
        cur.paras.push(p);
      }
    }
    if (cur && (cur.paras.length || cur.title)) sections.push(cur);

    if (headingCount === 0) {
      // no headings anywhere → build pseudo-sections so notes still get structure
      const paras = sections.flatMap(s => s.paras);
      const groups = [];
      if (paras.length >= 3) {
        for (let i = 0; i < paras.length; i += 4) groups.push(paras.slice(i, i + 4));
      } else {
        const blob = paras.join(" ");
        const sents = splitSentences(blob);
        for (let i = 0; i < sents.length; i += 8) groups.push([sents.slice(i, i + 8).join(" ")]);
      }
      return { title: null, sections: groups.map((g, i) => ({ title: `Part ${i + 1}`, paras: g })) };
    }
    return { title: docTitle, sections: sections.filter(s => s.paras.length) };
  }

  function guessTitle(text) {
    const clean = normalizeText(text);
    const firstLine = clean.split("\n").find(l => l.trim());
    if (firstLine) {
      const t = firstLine.trim().replace(/^#+\s*/, "").replace(/^\*\*|\*\*$/g, "").replace(/\s*[.:]\s*$/, "");
      if (t.length <= 90 && !/[.!?]$/.test(t)) return t;
    }
    const s = splitSentences(clean)[0];
    return s ? truncate(s, 60) : "Untitled chapter";
  }

  /* ---------------- definitions ---------------- */
  function extractDefinitions(allSents, idfOf, dfCount) {
    const patterns = [
      /^(.{2,60}?)\s+(?:is|are)\s+(?:defined as|known as|called)\s+(.{12,240})$/i,
      /^(.{2,60}?)\s+(?:refers? to|means|describes|denotes)\s+(.{12,240})$/i,
      /^(.{2,60}?)\s+(?:is|are)\s+((?:a|an|the)\s+.{10,240})$/i,
      /^(.{2,60}?)\s+[—–]\s+(.{12,240})$/,
      /^(.{2,60}?)\s+(?:is|are)\s+(.{15,240})$/
    ];
    const defs = new Map();

    for (const s of allSents) {
      if (s.words < 6 || s.words > 70) continue;
      const text = s.text;
      for (const re of patterns) {
        const m = text.match(re);
        if (!m) continue;
        let term = m[1].trim().replace(/^(the|a|an)\s+(term|word|phrase|process|idea|concept|notion)\s+/i, "");
        term = term.replace(/^(the|a|an)\s+/i, "").replace(/["'“”]/g, "").trim();
        const meaning = m[2].trim().replace(/\s*[.;]\s*$/, "");
        if (!term || !meaning) break;
        if (/[,;:]/.test(term)) break;
        if (term.split(/\s+/).length > 5) break;
        const firstWord = term.split(/\s+/)[0].toLowerCase();
        if (PRONOUN_STARTS.has(firstWord)) break;
        if (GENERIC_TERMS.has(term.toLowerCase())) break;
        if (!/[a-z]/i.test(term)) break;
        // topic-likeness: capitalized somewhere, or recurs in the chapter
        const stems = [...new Set(tokens(term))];
        const recurs = stems.length && stems.every(t => dfCount(t) >= 2);
        const capitalized = /^[A-Z]/.test(term) || /\s[A-Z]/.test(term);
        if (!capitalized && !recurs) break;
        const key = normKey(term);
        if (!key) break;
        const importance = stems.reduce((a, t) => a + idfOf(t), 0);
        const prev = defs.get(key);
        if (!prev || meaning.length > prev.meaning.length) {
          defs.set(key, { term: term, meaning: capitalize(meaning), importance: Math.max(importance, prev ? prev.importance : 0) });
        }
        break; // one definition per sentence
      }
    }
    return [...defs.values()].sort((a, b) => b.importance - a.importance);
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /* ---------------- key terms ---------------- */
  function extractKeyTerms(allSents, idfOf, limit = 14) {
    const tf = new Map();
    const surface = new Map();
    const bigrams = new Map();
    for (const s of allSents) {
      const raw = String(s.text).toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);
      const toks = tokens(s.text);
      for (const t of toks) {
        tf.set(t, (tf.get(t) || 0) + 1);
        if (!surface.has(t)) surface.set(t, t);
      }
      for (let i = 0; i < raw.length - 1; i++) {
        const a = raw[i], b = raw[i + 1];
        if (!a || !b) continue;
        const sa = stem(a.replace(/^['-]+|['-]+$/g, "").replace(/'s$/, ""));
        const sb = stem(b.replace(/^['-]+|['-]+$/g, "").replace(/'s$/, ""));
        if (sa.length < 3 || sb.length < 3 || STOP.has(sa) || STOP.has(sb)) continue;
        const key = sa + " " + sb;
        bigrams.set(key, (bigrams.get(key) || 0) + 1);
        if (!surface.has(key)) surface.set(key, a + " " + b);
      }
    }
    const scored = [];
    for (const [t, c] of tf) {
      if (c < 3 || t.length < 3 || /^\d+$/.test(t)) continue;
      scored.push({ term: surface.get(t), score: c * idfOf(t), uni: true });
    }
    for (const [t, c] of bigrams) {
      if (c < 3) continue;
      const [a, b] = t.split(" ");
      scored.push({ term: surface.get(t), score: c * (idfOf(a) + idfOf(b)) * 0.75, uni: false });
    }
    scored.sort((x, y) => y.score - x.score);

    const picked = [];
    const usedWords = new Set();
    for (const item of scored) {
      if (picked.length >= limit) break;
      if (item.uni && !item.term.includes(" ")) {
        // prefer bigrams containing this word when available
        const inBigram = picked.some(p => !p.uni && p.term.split(" ").includes(item.term));
        if (inBigram) continue;
      }
      if (!item.uni) {
        // if we already picked a unigram that is part of this bigram, remove it
        for (let i = picked.length - 1; i >= 0; i--) {
          if (picked[i].uni && item.term.split(" ").includes(picked[i].term)) picked.splice(i, 1);
        }
      }
      picked.push(item);
    }
    return picked.map(p => p.term);
  }

  /* ============================================================
     MAIN GENERATOR
     ============================================================ */
  function generateNotes(text, opts = {}) {
    const depth = opts.depth || "standard";
    const ratio = { quick: 0.16, standard: 0.28, deep: 0.42 }[depth] || 0.28;
    const depthLabel = { quick: "Quick skim", standard: "Standard", deep: "Deep dive" }[depth] || "Standard";

    const clean = normalizeText(text);
    const split = splitSections(clean);
    const rawSections = split.sections;
    const detectedTitle = split.title;

    // build sentence objects
    const doc = rawSections.map((sec, si) => {
      const sents = [];
      sec.paras.forEach((p, pi) => {
        splitSentences(p).forEach((s, si2) => {
          sents.push({ text: s, sec: si, para: pi, idx: si2, words: wordCount(s) });
        });
      });
      return { title: sec.title || "Overview", sents };
    });
    const allSents = doc.flatMap(d => d.sents);
    if (!allSents.length) throw new Error("No readable sentences found in the text.");

    const N = allSents.length;
    const df = new Map();
    for (const s of allSents) {
      for (const t of new Set(tokens(s.text))) df.set(t, (df.get(t) || 0) + 1);
    }
    const idfOf = t => Math.log(1 + N / (1 + (df.get(t) || 0)));
    const dfCount = t => df.get(t) || 0;

    const focusStems = new Set(
      String(opts.focus || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2).map(stem)
    );

    // ---- score sentences ----
    for (const sec of doc) {
      const titleStems = new Set(tokens(sec.title));
      for (const s of sec.sents) {
        const toks = tokens(s.text);
        const uniq = [...new Set(toks)];
        let sc = 0;
        for (const t of uniq) sc += Math.min(idfOf(t), 3.2);
        sc = sc / Math.sqrt(Math.max(toks.length, 3));
        if (s.idx === 0) sc += 0.12; else if (s.idx === 1) sc += 0.05;
        if (s.para === 0) sc += 0.08;
        if (/\d/.test(s.text)) sc += 0.07;
        if (uniq.some(t => titleStems.has(t))) sc += 0.15;
        const focusHits = [...focusStems].filter(t => uniq.includes(t)).length;
        if (focusHits) sc += 0.25 * Math.min(focusHits, 2);
        if (/^(it|they|he|she|this|these|those|there|we|you|his|her|their|its)\b/i.test(s.text)) sc *= 0.65;
        if (s.words < 5) sc *= 0.45;
        if (s.words > 50) sc *= 0.8;
        s.score = sc;
      }
    }

    const globalRank = allSents.slice().sort((a, b) => b.score - a.score);
    const usedGlobal = new Set();

    // ---- TL;DR ----
    const tldr = [];
    const tldrSecs = new Set();
    const tldrTarget = depth === "quick" ? 2 : 3;
    for (const s of globalRank) {
      if (tldr.length >= tldrTarget) break;
      if (s.words < 6) continue;
      if (tldrSecs.has(s.sec)) continue;
      tldrSecs.add(s.sec);
      usedGlobal.add(normKey(s.text));
      tldr.push(s.text);
    }

    // ---- facts & figures ----
    const factCap = { quick: 3, standard: 6, deep: 8 }[depth] || 6;
    const facts = [];
    for (const s of globalRank) {
      if (facts.length >= factCap) break;
      if (!/\d/.test(s.text) || s.words < 5) continue;
      const k = normKey(s.text);
      if (usedGlobal.has(k)) continue;
      usedGlobal.add(k);
      facts.push(s.text);
    }

    // ---- definitions & key terms ----
    const defs = extractDefinitions(allSents, idfOf, dfCount);
    const defCap = { quick: 6, standard: 10, deep: 12 }[depth] || 10;
    defs.length = Math.min(defs.length, defCap);

    const keyTerms = extractKeyTerms(allSents, idfOf, 14);
    const defKeySet = new Set(defs.map(d => normKey(d.term)));

    // fallback concepts: multi-word key terms only (single words pick up junk contexts)
    const concepts = defs.map(d => ({ term: d.term, meaning: d.meaning, defined: true }));
    for (const term of keyTerms) {
      if (concepts.length >= defCap + 2) break;
      if (defKeySet.has(normKey(term))) continue;
      if (!term.includes(" ")) continue;
      const re = new RegExp("\\b" + escapeRegExp(term) + "\\b", "i");
      const best = allSents.filter(s => re.test(s.text)).sort((a, b) => b.score - a.score)[0];
      if (!best) continue;
      concepts.push({ term: capitalize(term), meaning: truncate(best.text, 150), defined: false });
    }

    // ---- detailed notes per section ----
    const detail = doc.map(sec => {
      const n = sec.sents.length;
      if (!n) return { title: sec.title, bullets: [] };
      let keep = Math.max(n >= 4 ? 2 : 1, Math.round(n * ratio));
      if (depth === "deep") keep = Math.max(keep, Math.min(3, n));
      const sorted = sec.sents.slice().sort((a, b) => b.score - a.score);
      const picked = [];
      const usedLocal = new Set();
      const tryAdd = (allowGlobalUsed) => {
        for (const s of sorted) {
          if (picked.length >= keep) break;
          const k = normKey(s.text);
          if (usedLocal.has(k)) continue;
          if (!allowGlobalUsed && usedGlobal.has(k)) continue;
          usedLocal.add(k);
          picked.push(s);
        }
      };
      tryAdd(false);  // prefer sentences not already used in TL;DR / facts
      if (!picked.length) tryAdd(true);
      picked.sort((a, b) => (a.para - b.para) || (a.idx - b.idx));
      return { title: sec.title, bullets: picked.map(s => s.text) };
    }).filter(d => d.bullets.length);

    // ---- remember these ----
    const remCap = { quick: 4, standard: 6, deep: 8 }[depth] || 6;
    const remember = [];
    const seenPara = new Set();
    for (const s of globalRank) {
      if (remember.length >= remCap) break;
      if (s.words < 7) continue;
      const k = normKey(s.text);
      if (usedGlobal.has(k)) continue;
      const pk = s.sec + ":" + s.para;
      if (seenPara.has(pk)) continue;
      seenPara.add(pk);
      usedGlobal.add(k);
      remember.push(s.text);
    }

    // ---- self-check questions ----
    const questions = [];
    for (const d of defs.slice(0, 5)) questions.push(`What is **${d.term}**?`);
    for (const d of defs.slice(0, 3)) questions.push(`Why does **${d.term}** matter in this chapter?`);

    // ---- compose markdown ----
    const inWords = wordCount(clean);
    const title = (opts.title && opts.title.trim()) || detectedTitle || guessTitle(clean);
    const md = [];
    md.push(`# ${title}`);
    md.push("");
    md.push(`> Generated ${new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · Instant engine · ${inWords} words → ${depthLabel} · every sentence below comes from your text`);
    md.push("");
    md.push("## 🎯 TL;DR");
    for (const s of tldr) md.push(`- ${s}`);
    md.push("");
    md.push("## 📌 Key Concepts");
    md.push("| Term | Meaning |");
    md.push("| --- | --- |");
    for (const c of concepts) md.push(`| **${c.term}** | ${c.meaning} |`);
    if (!concepts.length) md.push("_No clear definitions were detected in this text._");
    md.push("");
    md.push("## 📝 Detailed Notes");
    for (const d of detail) {
      md.push("");
      md.push(`### ${d.title}`);
      for (const b of d.bullets) md.push(`- ${b}`);
    }
    if (facts.length) {
      md.push("");
      md.push("## 🔢 Key Facts & Figures");
      for (const f of facts) md.push(`- ${f}`);
    }
    if (remember.length) {
      md.push("");
      md.push("## 🧠 Remember These");
      remember.forEach((r, i) => md.push(`${i + 1}. ${truncate(r, 190)}`));
    }
    if (questions.length) {
      md.push("");
      md.push("## ❓ Self-Check Questions");
      questions.forEach((q, i) => md.push(`${i + 1}. ${q}`));
    }

    const markdown = md.join("\n");
    const stats = {
      inWords: inWords,
      outWords: wordCount(markdown),
      sections: detail.length,
      concepts: concepts.length,
      depth: depth
    };
    return { markdown, stats, title };
  }

  /* ============================================================
     INTEGRITY CHECK — score notes against the source text
     ============================================================ */
  function extractCheckableUnits(md) {
    const units = [];
    let inCode = false;
    for (const line of String(md || "").split("\n")) {
      const t = line.trim();
      if (/^```/.test(t)) { inCode = !inCode; continue; }
      if (inCode || !t) continue;
      if (/^#{1,6}\s/.test(t)) continue;
      if (/^>/.test(t)) {
        const q = t.replace(/^>\s?/, "");
        if (q.includes("·")) continue; // generated-meta line
        units.push(q); continue;
      }
      if (t.startsWith("|")) {
        if (/^\|[\s:|-]+\|$/.test(t)) continue;
        t.replace(/^\||\|$/g, "").split("|").forEach(c => {
          if (c.trim().length > 20) units.push(c.trim());
        });
        continue;
      }
      let m;
      if ((m = line.match(/^\s*[-*+]\s+(.+)$/))) { units.push(m[1]); continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.+)$/))) { units.push(m[1]); continue; }
      units.push(t);
    }
    return units.map(stripInlineMd).filter(u => u.length > 20);
  }

  function checkGrounding(md, sourceText) {
    // index source sentences by stemmed token sets
    const srcUnits = [];
    for (const p of normalizeText(sourceText).split(/\n\s*\n/)) {
      for (const s of splitSentences(p)) {
        const toks = new Set(tokens(s));
        if (toks.size >= 3) srcUnits.push(toks);
      }
    }
    const index = new Map();
    srcUnits.forEach((toks, i) => {
      for (const t of toks) {
        if (!index.has(t)) index.set(t, []);
        index.get(t).push(i);
      }
    });

    const flagged = new Set();
    let totalW = 0, flagW = 0;
    for (const unit of extractCheckableUnits(md)) {
      for (const s of splitSentences(unit)) {
        const toks = new Set(tokens(s));
        if (toks.size < 4) continue;
        const w = toks.size;
        totalW += w;
        const candCount = new Map();
        for (const t of toks) {
          const postings = index.get(t);
          if (postings) for (const i of postings) candCount.set(i, (candCount.get(i) || 0) + 1);
        }
        let best = 0;
        if (candCount.size) {
          const cands = [...candCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(e => e[0]);
          for (const ci of cands) {
            const B = srcUnits[ci];
            let inter = 0;
            for (const t of toks) if (B.has(t)) inter++;
            const sim = inter / Math.sqrt(toks.size * B.size);
            if (sim > best) best = sim;
            if (best > 0.95) break;
          }
        }
        if (best < 0.30) {
          flagW += w;
          flagged.add(MD.normText(s));
        }
      }
    }
    const score = totalW ? Math.round(100 * (1 - flagW / totalW)) : 100;
    return { score: Math.max(0, score), flagged, flaggedCount: flagged.size };
  }

  /* ============================================================
     PARSE NOTES MARKDOWN → structured data (works for AI output too)
     ============================================================ */
  function parseNotes(md) {
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    const out = { title: "", tldr: [], concepts: [], sections: [], facts: [], remember: [], questions: [] };
    let bucket = null, curSection = null;

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let m;

      if ((m = t.match(/^#\s+(.+)$/))) {
        out.title = stripInlineMd(m[1]).replace(/\s*[—–-]\s*chapter notes.*$/i, "").trim();
        bucket = null; curSection = null; continue;
      }
      if ((m = t.match(/^##\s+(.+)$/))) {
        // strip everything non-alphanumeric so "🎯 TL;DR" → "tldr" (the ; in TL;DR breaks naive matching)
        const h = stripInlineMd(m[1]).toLowerCase().replace(/[^a-z0-9]/g, "");
        if (/^tldr|^summary/.test(h)) bucket = "tldr";
        else if (/keyconcepts|keyterms|glossary/.test(h)) bucket = "concepts";
        else if (/keyfacts|facts|figures|numbers/.test(h)) bucket = "facts";
        else if (/remember|takeaways/.test(h)) bucket = "remember";
        else if (/questions|quiz|selfcheck/.test(h)) bucket = "questions";
        else { bucket = "details"; curSection = null; }
        continue;
      }
      if ((m = t.match(/^###\s+(.+)$/))) {
        curSection = { title: stripInlineMd(m[1]), bullets: [] };
        out.sections.push(curSection);
        bucket = "details"; continue;
      }
      if (/^\|/.test(t)) {
        if (/^\|[\s:|-]+\|$/.test(t)) continue;
        const cells = t.replace(/^\||\|$/g, "").split("|").map(c => stripInlineMd(c.trim()));
        if (bucket === "concepts" && cells.length >= 2 && cells[0] && cells[1]) {
          const h0 = normKey(cells[0]);
          if (h0 !== "term" && h0 !== "concept" && h0 !== "front") {
            out.concepts.push({ term: cells[0], meaning: cells[1] });
          }
        }
        continue;
      }
      if (/^>/.test(t)) continue;

      let content = null;
      if ((m = t.match(/^[-*+]\s+(.+)$/))) content = m[1];
      else if ((m = t.match(/^\d+[.)]\s+(.+)$/))) content = m[1];
      else if (bucket === "details" && curSection) content = t;

      if (!content) continue;
      const clean = stripInlineMd(content);
      if (!clean) continue;
      if (bucket === "tldr") out.tldr.push(clean);
      else if (bucket === "facts") out.facts.push(clean);
      else if (bucket === "remember") out.remember.push(clean);
      else if (bucket === "questions") out.questions.push(clean);
      else if (bucket === "details") {
        if (!curSection) { curSection = { title: "Notes", bullets: [] }; out.sections.push(curSection); }
        curSection.bullets.push(clean);
      }
    }
    return out;
  }

  /* ============================================================
     FLASHCARDS & QUIZ
     ============================================================ */
  function buildFlashcards(p) {
    const cards = [];
    const seen = new Set();
    const defs = (p.concepts || []).filter(c => c.term && c.meaning && c.meaning.length > 15);
    for (const d of defs.slice(0, 14)) {
      const key = normKey(d.term);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cards.push({ front: d.term, back: truncate(d.meaning, 280), tag: "definition" });
    }
    for (const f of (p.facts || [])) {
      if (cards.length >= 20) break;
      const m = f.match(/\d[\d,.]*\s?(?:%|percent|billion|million|thousand|tonnes|degrees)?/);
      if (!m) continue;
      const blanked = f.replace(m[0], "_____");
      if (blanked === f || m[0].length > 26) continue;
      cards.push({ front: "Fill in the blank: " + truncate(blanked, 240), back: m[0].trim(), tag: "fact" });
    }
    for (const q of (p.questions || [])) {
      if (cards.length >= 24) break;
      const m = q.match(/^(?:what|who)\s+(?:is|are|was|were)\s+(.+?)\??$/i);
      let answer = null;
      if (m) {
        const term = normKey(m[1]);
        const def = defs.find(c => normKey(c.term) === term);
        if (def) answer = def.meaning;
      }
      if (!answer) {
        const words = q.toLowerCase().match(/[a-z]{4,}/g) || [];
        const def = defs.find(c => words.some(w => c.term.toLowerCase().includes(w)));
        if (def) answer = def.meaning;
      }
      if (answer) {
        const front = stripInlineMd(q);
        if (!seen.has("q:" + normKey(front))) {
          seen.add("q:" + normKey(front));
          cards.push({ front: front, back: truncate(answer, 280), tag: "question" });
        }
      }
    }
    return cards;
  }

  function uniqueOptions(correct, distractors, min = 3, max = 4) {
    const opts = [correct];
    for (const d of distractors) {
      if (opts.length >= max) break;
      if (!opts.includes(d)) opts.push(d);
    }
    return opts.length >= min ? shuffle(opts) : null;
  }

  function buildQuiz(p) {
    const qs = [];
    const defs = (p.concepts || []).filter(c => c.term && c.meaning && c.meaning.length > 15 && c.meaning.length < 400);
    const pickDistractorDefs = (correct, n) =>
      shuffle(defs.filter(d => d !== correct))
        .map(d => truncate(d.meaning, 150))
        .filter(d => d !== truncate(correct.meaning, 150));

    // Type 1 — "which best describes term?"
    for (const d of shuffle(defs.slice(0, 8)).slice(0, 5)) {
      if (defs.length < 2) break;
      const correct = truncate(d.meaning, 150);
      const opts = uniqueOptions(correct, pickDistractorDefs(d, 3));
      if (!opts) continue;
      qs.push({
        q: `Which statement best describes “${d.term}”?`,
        options: opts,
        answer: opts.indexOf(correct),
        explain: `From your notes: “${truncate(d.meaning, 170)}”`
      });
    }

    // Type 2 — cloze (a term may appear in both a definition question and a
    // cloze — different formats, that's fine pedagogically)
    const sentences = [...(p.tldr || [])];
    for (const s of (p.sections || [])) sentences.push(...s.bullets);
    const usedTerms = new Set();
    for (const term of shuffle(defs.map(d => d.term))) {
      if (qs.length >= 8) break;
      if (usedTerms.has(normKey(term))) continue;
      const re = new RegExp("\\b" + escapeRegExp(term) + "\\b", "i");
      const sent = sentences.find(s => re.test(s));
      if (!sent) continue;
      const blanked = sent.replace(re, "_____");
      const distractors = shuffle(defs.map(d => d.term).filter(t => normKey(t) !== normKey(term))).slice(0, 3);
      const opts = uniqueOptions(term, distractors);
      if (!opts) continue;
      usedTerms.add(normKey(term));
      qs.push({
        q: "Complete the statement:",
        text: truncate(blanked, 250),
        options: opts,
        answer: opts.indexOf(term),
        explain: `Original from your notes: “${truncate(sent, 180)}”`
      });
    }

    return qs.slice(0, 8);
  }

  function buildAll(markdown) {
    const parsed = parseNotes(markdown);
    return {
      parsed: parsed,
      flashcards: buildFlashcards(parsed),
      quiz: buildQuiz(parsed)
    };
  }

  return {
    generateNotes: generateNotes,
    checkGrounding: checkGrounding,
    parseNotes: parseNotes,
    buildFlashcards: buildFlashcards,
    buildQuiz: buildQuiz,
    buildAll: buildAll,
    splitSentences: splitSentences,
    guessTitle: guessTitle,
    normalizeText: normalizeText
  };
})();
