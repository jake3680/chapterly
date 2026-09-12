/* ============================================================
   Chapterly — app shell: state, views, tabs, exports, settings
   ============================================================ */
"use strict";

(function () {

  /* ================= state ================= */
  const state = {
    docs: [],
    settings: {
      theme: "auto",
      flags: { flagEnabled: true },
      ai: { baseUrl: "", apiKey: "", model: "", temperature: 0.3 }
    }
  };

  const ui = {
    view: "home",
    activeId: null,
    tab: "notes",
    homeTab: "paste",
    editing: false,
    generating: false,
    controller: null,
    card: { docId: null, order: [], pos: 0, known: new Set(), flipped: false },
    quiz: { answers: {}, submitted: false }
  };

  const save = debounce(persist, 500);
  function persist() {
    const ok = Store.save({ v: 1, docs: state.docs, settings: state.settings });
    if (!ok) toast("Could not save — browser storage is full. Delete some notes.", "err", 5000);
    renderSidebar();
  }

  function activeDoc() {
    return state.docs.find(d => d.id === ui.activeId) || null;
  }

  /* ================= theme ================= */
  const mediaDark = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme() {
    const t = state.settings.theme;
    const dark = t === "dark" || (t === "auto" && mediaDark.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("#btn-theme").textContent = dark ? "☀️" : "🌙";
  }
  mediaDark.addEventListener("change", applyTheme);

  /* ================= view switching ================= */
  function showHome() {
    ui.view = "home";
    ui.activeId = null;
    ui.editing = false;
    $("#view-home").hidden = false;
    $("#view-doc").hidden = true;
    renderSidebar();
  }

  function showDoc(id, tab) {
    const doc = state.docs.find(d => d.id === id);
    if (!doc) { showHome(); return; }
    ui.view = "doc";
    ui.activeId = id;
    ui.tab = tab || "notes";
    ui.editing = false;
    ui.quiz = { answers: {}, submitted: false };
    $("#view-home").hidden = true;
    $("#view-doc").hidden = false;
    closeSidebarMobile();
    renderDoc();
    renderSidebar();
  }

  /* ================= sidebar ================= */
  function renderSidebar() {
    const list = $("#doc-list");
    const q = ($("#doc-search").value || "").toLowerCase().trim();
    const docs = state.docs
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(d => !q || (d.title || "").toLowerCase().includes(q) || (d.sourceText || "").toLowerCase().includes(q));

    list.innerHTML = "";
    if (!docs.length) {
      list.innerHTML = `<div class="doc-list-empty">${state.docs.length ? "No matches." : "No notes yet.<br>Generate your first set →"}</div>`;
    }
    for (const d of docs) {
      const el = document.createElement("div");
      el.className = "doc-item" + (d.id === ui.activeId ? " active" : "");
      el.innerHTML = `
        <div class="doc-item-title">${esc(d.title || "Untitled")}</div>
        <div class="doc-item-sub"><span>${fmtDate(d.updatedAt)}</span><span>·</span><span>${(d.stats && d.stats.inWords) || wordCount(d.sourceText)} words</span>${d.grounding ? `<span>·</span><span>🛡 ${d.grounding.score}%</span>` : ""}</div>
        <button class="doc-item-del" title="Delete">✕</button>`;
      el.addEventListener("click", (e) => {
        if (e.target.closest(".doc-item-del")) return;
        showDoc(d.id);
      });
      el.querySelector(".doc-item-del").addEventListener("click", () => {
        confirmDialog("Delete this note?", `“${d.title || "Untitled"}” will be permanently removed from this browser.`, () => {
          state.docs = state.docs.filter(x => x.id !== d.id);
          if (ui.activeId === d.id) showHome();
          persist();
          toast("Note deleted", "ok");
        });
      });
      list.appendChild(el);
    }
    $("#sidebar-stats").textContent = `${state.docs.length} note${state.docs.length === 1 ? "" : "s"} · saved in this browser`;
  }

  function closeSidebarMobile() {
    $("#sidebar").classList.remove("open");
    $("#sidebar-scrim").classList.remove("show");
  }

  /* ================= home ================= */
  function renderSamples() {
    $("#samples-list").innerHTML = SAMPLES.map((s, i) => `
      <div class="sample-card" data-sample="${i}">
        <div class="sample-emoji">${s.emoji}</div>
        <div class="sample-title">${esc(s.title)}</div>
        <div class="sample-sub">${esc(s.sub)}</div>
      </div>`).join("");
    $$("#samples-list .sample-card").forEach(card => {
      card.addEventListener("click", () => {
        const s = SAMPLES[+card.dataset.sample];
        $("#input-text").value = s.text;
        $("#input-title").value = s.title;
        switchHomeTab("paste");
        updateInputStats();
        toast("Sample loaded — press Generate", "ok");
      });
    });
  }

  function switchHomeTab(name) {
    ui.homeTab = name;
    $$(".input-tab").forEach(t => t.classList.toggle("active", t.dataset.homeTab === name));
    $("#home-panel-paste").hidden = name !== "paste";
    $("#home-panel-upload").hidden = name !== "upload";
    $("#home-panel-samples").hidden = name !== "samples";
  }

  function updateInputStats() {
    const n = wordCount($("#input-text").value);
    const el = $("#input-stats");
    el.textContent = `${n} words` + (n && n < 60 ? " — add a bit more for meaningful notes" : "");
    el.classList.toggle("warn", n > 0 && n < 60);
  }

  /* ================= generation ================= */
  const STEP_ORDER = ["prepare", "analyze", "compose", "verify"];

  function progressShow() {
    $("#progress-overlay").hidden = false;
    $$("#progress-steps li").forEach(li => li.classList.remove("active", "done"));
    setBar(0);
    $("#progress-sub").textContent = "";
    $("#progress-sub").classList.remove("err-text");
    $("#progress-preview").hidden = true;
    $("#progress-preview").textContent = "";
    $("#btn-cancel-gen").hidden = true;
    $("#progress-stage-label").textContent = "Generating notes…";
  }
  function progressStep(name) {
    const idx = STEP_ORDER.indexOf(name);
    $$("#progress-steps li").forEach((li, i) => {
      li.classList.toggle("done", i < idx);
      li.classList.toggle("active", i === idx);
    });
  }
  function setBar(pct) {
    $("#progress-bar-fill").style.width = Math.max(0, Math.min(100, pct)) + "%";
  }
  function progressHide() {
    $("#progress-overlay").hidden = true;
  }

  async function startGeneration(draft, existingId) {
    if (ui.generating) return;
    const text = Engine.normalizeText(draft.text || "");
    const words = wordCount(text);
    if (words < 30) {
      showHomeError("That text is too short to make notes from — paste at least a few paragraphs (30+ words).");
      return;
    }

    const engine = draft.engine || "instant";
    if (engine === "ai" && !state.settings.ai.apiKey) {
      showHomeError("AI engine needs an API key. Open Settings → AI engine (it stays in your browser), or switch to the Instant engine.");
      openSettings();
      return;
    }

    ui.generating = true;
    ui.controller = new AbortController();
    const signal = ui.controller.signal;
    progressShow();
    $("#btn-cancel-gen").hidden = engine !== "ai";

    try {
      let markdown, stats = null;
      progressStep("prepare");
      setBar(8);
      await tick();

      progressStep("analyze");
      setBar(20);

      if (engine === "ai") {
        $("#progress-stage-label").textContent = "AI is reading your chapter…";
        markdown = await AI.generate({
          text, depth: draft.depth, focus: draft.focus, title: draft.title,
          settings: state.settings.ai, signal,
          onStage: (stage, i, n) => {
            if (stage === "analyze") { progressStep("analyze"); setBar(20 + 10 * (n ? i / n : 0)); }
            else if (stage === "compose") {
              progressStep("compose");
              setBar(30 + 50 * (n ? (i - 1) / n : 0));
              $("#progress-stage-label").textContent = n > 1 ? `Writing notes — part ${i} of ${n}` : "Writing notes…";
              $("#progress-sub").textContent = n > 1 ? `The chapter was split into ${n} parts so nothing gets truncated.` : "";
            } else if (stage === "merge") {
              setBar(85);
              $("#progress-stage-label").textContent = "Merging parts into final notes…";
            }
          },
          onDelta: (full, label) => {
            const pv = $("#progress-preview");
            pv.hidden = false;
            pv.textContent = full.slice(-1600);
            pv.scrollTop = pv.scrollHeight;
          }
        });
      } else {
        $("#progress-stage-label").textContent = "Analyzing chapter…";
        $("#progress-sub").textContent = "Instant engine — running entirely in your browser";
        await tick();
        const result = Engine.generateNotes(text, { depth: draft.depth, focus: draft.focus, title: draft.title });
        markdown = result.markdown;
        stats = result.stats;
      }

      progressStep("compose");
      setBar(engine === "ai" ? 88 : 70);
      await tick();

      progressStep("verify");
      setBar(94);
      $("#progress-stage-label").textContent = "Checking every sentence against your text…";
      await tick();
      const grounding = Engine.checkGrounding(markdown, text);
      const built = Engine.buildAll(markdown);

      const now = Date.now();
      const model = engine === "ai" ? (state.settings.ai.model || "AI") : null;
      let doc;
      if (existingId) {
        doc = state.docs.find(d => d.id === existingId);
        Object.assign(doc, {
          notesMd: markdown, stats: stats, grounding: grounding,
          flashcards: built.flashcards, quiz: built.quiz,
          depth: draft.depth, focus: draft.focus, engine, model, updatedAt: now
        });
      } else {
        doc = {
          id: uid(),
          title: (draft.title || result_title(markdown) || "Untitled chapter").trim() || "Untitled chapter",
          createdAt: now, updatedAt: now,
          sourceText: text, sourceName: draft.sourceName || "",
          engine, model, depth: draft.depth, focus: draft.focus || "",
          notesMd: markdown, stats, grounding,
          flashcards: built.flashcards, quiz: built.quiz,
          knownCards: []
        };
        state.docs.unshift(doc);
      }
      if (!stats) {
        doc.stats = doc.stats || { inWords: words, outWords: wordCount(markdown) };
      }
      persist();
      progressStep("verify");
      $$("#progress-steps li").forEach(li => li.classList.add("done"));
      setBar(100);
      await tick();
      progressHide();
      showDoc(doc.id, "notes");
      const integrity = grounding ? `${grounding.score}% source-matched` : "";
      toast(`Notes ready${integrity ? " · " + integrity : ""}`, "ok");
    } catch (e) {
      progressHide();
      if (e && (e.name === "AbortError")) {
        toast("Generation cancelled", "warn");
      } else {
        const msg = e && e.message ? e.message : "Something went wrong during generation.";
        if (ui.view === "home") showHomeError(msg); else toast(msg, "err", 6000);
      }
    } finally {
      ui.generating = false;
      ui.controller = null;
    }

    function result_title(md) {
      const m = (md || "").match(/^#\s+(.+)$/m);
      return m ? m[1].trim() : null;
    }
  }

  function showHomeError(msg) {
    const el = $("#home-error");
    el.textContent = msg;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 9000);
  }

  /* ================= workspace ================= */
  function renderDoc() {
    const doc = activeDoc();
    if (!doc) { showHome(); return; }

    $("#doc-title").value = doc.title || "Untitled chapter";
    $("#doc-depth").value = doc.depth || "standard";

    // meta chips
    const g = doc.grounding;
    const depthLabel = { quick: "⚡ Quick skim", standard: "📗 Standard", deep: "🔎 Deep dive" }[doc.depth] || "📗 Standard";
    const gChip = g
      ? `<span class="chip ${g.score >= 90 ? "good" : g.score >= 70 ? "mid" : "low"}" title="Share of note sentences that were matched against your source text. Flagged sentences are underlined in yellow.">🛡 ${g.score}% source-matched</span>`
      : "";
    $("#doc-meta").innerHTML = `
      <span class="chip">${fmtDate(doc.createdAt)}</span>
      <span class="chip">${(doc.stats && doc.stats.inWords) || wordCount(doc.sourceText)} words in</span>
      <span class="chip">${doc.engine === "ai" ? "🤖 " + esc(doc.model || "AI") : "⚡ Instant engine"}</span>
      <span class="chip">${depthLabel}</span>
      ${gChip}`;

    $("#count-cards").textContent = (doc.flashcards && doc.flashcards.length) || "";
    $("#count-quiz").textContent = (doc.quiz && doc.quiz.length) || "";

    $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === ui.tab));
    $("#panel-notes").hidden = ui.tab !== "notes";
    $("#panel-cards").hidden = ui.tab !== "cards";
    $("#panel-quiz").hidden = ui.tab !== "quiz";
    $("#panel-source").hidden = ui.tab !== "source";

    if (ui.tab === "notes") renderNotes();
    else if (ui.tab === "cards") renderCards();
    else if (ui.tab === "quiz") renderQuiz();
    else if (ui.tab === "source") renderSource();
  }

  /* ---------- notes tab ---------- */
  function renderNotes() {
    const doc = activeDoc();
    if (!doc) return;
    const body = $("#notes-body");
    body.innerHTML = MD.render(doc.notesMd);
    if (state.settings.flags.flagEnabled && doc.grounding && doc.grounding.flagged && doc.grounding.flagged.size) {
      MD.wrapFlagged(body, doc.grounding.flagged, Engine.splitSentences);
    }
  }

  function setEditing(on) {
    const doc = activeDoc();
    if (!doc) return;
    ui.editing = on;
    $("#notes-editor-wrap").hidden = !on;
    $("#notes-body").hidden = on;
    $("#edit-hint").hidden = !on;
    $("#btn-edit-notes").textContent = on ? "👁 Preview" : "✏️ Edit";
    if (on) {
      $("#notes-editor").value = doc.notesMd;
      $("#notes-editor").focus();
    } else {
      renderNotes();
      $("#count-cards").textContent = (doc.flashcards && doc.flashcards.length) || "";
      $("#count-quiz").textContent = (doc.quiz && doc.quiz.length) || "";
      renderDoc();
      ui.tab = "notes";
      // cheap refresh of panels
      $("#panel-notes").hidden = false;
      $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "notes"));
    }
  }

  const recheckIntegrity = debounce(() => {
    const doc = activeDoc();
    if (!doc) return;
    doc.grounding = Engine.checkGrounding(doc.notesMd, doc.sourceText);
    const g = doc.grounding;
    const chip = $(`#doc-meta .chip.good, #doc-meta .chip.mid, #doc-meta .chip.low`);
    if (chip) {
      chip.textContent = `🛡 ${g.score}% source-matched`;
      chip.classList.remove("good", "mid", "low");
      chip.classList.add(g.score >= 90 ? "good" : g.score >= 70 ? "mid" : "low");
    }
    persist();
  }, 1200);

  const onEditorInput = debounce(() => {
    const doc = activeDoc();
    if (!doc || !ui.editing) return;
    doc.notesMd = $("#notes-editor").value;
    doc.updatedAt = Date.now();
    save();
    recheckIntegrity();
  }, 400);

  function finishEditing() {
    const doc = activeDoc();
    if (!doc) return;
    // rebuild study material from the edited notes
    const built = Engine.buildAll(doc.notesMd);
    doc.flashcards = built.flashcards;
    doc.quiz = built.quiz;
    doc.updatedAt = Date.now();
    persist();
    setEditing(false);
    toast("Notes saved — flashcards & quiz rebuilt", "ok");
  }

  /* ---------- flashcards tab ---------- */
  function renderCards() {
    const doc = activeDoc();
    if (!doc) return;
    const cards = doc.flashcards || [];
    $("#cards-empty").hidden = cards.length > 0;
    $("#cards-ui").hidden = cards.length === 0;
    if (ui.card.docId !== doc.id || ui.card.order.length !== cards.length) {
      ui.card = {
        docId: doc.id,
        order: cards.map((_, i) => i),
        pos: 0,
        known: new Set(doc.knownCards || []),
        flipped: false
      };
    }
    showCard();
  }

  function showCard() {
    const doc = activeDoc();
    if (!doc) return;
    const cards = doc.flashcards || [];
    if (!cards.length) return;
    const c = ui.card;
    const done = c.pos >= c.order.length;
    $("#card-area").style.display = done ? "none" : "";
    $(".card-controls").style.display = done ? "none" : "";
    $("#card-done").hidden = !done;
    if (done) {
      $("#card-done-text").textContent = `Deck finished — ${c.known.size} of ${c.order.length} marked as known.`;
      return;
    }
    const card = cards[c.order[c.pos]];
    const tagFront = { definition: "Term", fact: "Fact", question: "Question" }[card.tag] || "Card";
    const tagBack = { definition: "Meaning", fact: "Answer", question: "Answer" }[card.tag] || "Answer";
    $("#card-tag-front").textContent = tagFront;
    $("#card-tag-back").textContent = tagBack;
    $("#card-front-text").textContent = card.front;
    $("#card-back-text").textContent = card.back;
    $("#card3d").classList.remove("flipped");
    c.flipped = false;
    $("#cards-progress").textContent =
      `Card ${c.pos + 1} of ${c.order.length} · ✓ ${c.known.size} known`;
  }

  function cardNav(delta) {
    const c = ui.card;
    c.pos = Math.max(0, Math.min(c.order.length, c.pos + delta));
    showCard();
  }

  function markKnown(known) {
    const doc = activeDoc();
    if (!doc) return;
    const c = ui.card;
    if (c.pos >= c.order.length) return;
    const idx = c.order[c.pos];
    if (known) {
      c.known.add(idx);
      doc.knownCards = [...c.known];
      save();
    } else {
      c.order.push(idx); // review again later in the deck
    }
    c.pos++;
    showCard();
  }

  /* ---------- quiz tab ---------- */
  const LETTERS = ["A", "B", "C", "D", "E"];

  function renderQuiz() {
    const doc = activeDoc();
    if (!doc) return;
    const qs = doc.quiz || [];
    $("#quiz-empty").hidden = qs.length > 0;
    $("#quiz-ui").hidden = qs.length === 0;
    if (!qs.length) return;

    $("#btn-quiz-submit").hidden = ui.quiz.submitted;
    $("#quiz-result").hidden = true;

    $("#quiz-area").innerHTML = qs.map((q, i) => {
      const opts = q.options.map((o, j) => `
        <button class="q-opt" data-q="${i}" data-o="${j}">
          <span class="q-letter">${LETTERS[j] || "•"}</span><span>${esc(o)}</span>
        </button>`).join("");
      return `
        <div class="q-card" data-q="${i}">
          <div class="q-num">Question ${i + 1} of ${qs.length}</div>
          <div class="q-text">${esc(q.q)}${q.text ? `<em class="q-cloze">“${esc(q.text)}”</em>` : ""}</div>
          <div class="q-opts">${opts}</div>
          <div class="q-explain">${esc(q.explain || "")}</div>
        </div>`;
    }).join("");

    $$("#quiz-area .q-opt").forEach(btn => {
      btn.addEventListener("click", () => {
        if (ui.quiz.submitted) return;
        const qi = +btn.dataset.q, oi = +btn.dataset.o;
        ui.quiz.answers[qi] = oi;
        const card = btn.closest(".q-card");
        $$(".q-opt", card).forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
    });

    updateQuizScore();
  }

  function updateQuizScore() {
    const total = Object.keys(ui.quiz.answers).length;
    $("#quiz-score").textContent = total ? `${total} answered` : "";
  }

  function submitQuiz() {
    const doc = activeDoc();
    if (!doc) return;
    const qs = doc.quiz || [];
    const unanswered = qs.filter((_, i) => ui.quiz.answers[i] === undefined).length;
    if (unanswered) {
      toast(`Answer all questions first — ${unanswered} left`, "warn");
      return;
    }
    ui.quiz.submitted = true;
    let correct = 0;
    qs.forEach((q, i) => {
      const card = $(`#quiz-area .q-card[data-q="${i}"]`);
      if (!card) return;
      const picked = ui.quiz.answers[i];
      const isRight = picked === q.answer;
      if (isRight) correct++;
      $$(".q-opt", card).forEach(b => {
        const oi = +b.dataset.o;
        b.disabled = true;
        if (oi === q.answer) b.classList.add("correct");
        else if (oi === picked) b.classList.add("wrong");
        b.classList.remove("selected");
      });
      const ex = $(".q-explain", card);
      ex.classList.add("show", isRight ? "ok" : "bad");
      if (!isRight) ex.textContent = `Correct answer: ${LETTERS[q.answer]} — ` + (q.explain || "");
    });
    const pct = Math.round((correct / qs.length) * 100);
    $("#quiz-result").hidden = false;
    $("#quiz-result").innerHTML = `
      <div class="big">${correct} / ${qs.length}</div>
      <div class="msg">${pct === 100 ? "Perfect! You know this chapter. 🏆" : pct >= 70 ? "Solid — review the ones you missed. 👍" : "Worth another pass through the notes. 💪"}</div>`;
    $("#btn-quiz-submit").hidden = true;
    $("#quiz-score").textContent = `Score: ${pct}%`;
  }

  /* ---------- source tab ---------- */
  function renderSource() {
    const doc = activeDoc();
    if (!doc) return;
    renderSourceText("");
  }

  function renderSourceText(query) {
    const doc = activeDoc();
    if (!doc) return;
    const el = $("#source-body");
    const text = doc.sourceText || "";
    if (!query) {
      el.textContent = text;
      $("#source-count").textContent = "";
      return;
    }
    const q = query.toLowerCase();
    const lower = text.toLowerCase();
    let count = 0, html = "", pos = 0;
    let idx = lower.indexOf(q);
    while (idx !== -1 && count < 500) {
      html += esc(text.slice(pos, idx)) + "<mark>" + esc(text.slice(idx, idx + q.length)) + "</mark>";
      pos = idx + q.length;
      count++;
      idx = lower.indexOf(q, pos);
    }
    html += esc(text.slice(pos));
    el.innerHTML = html;
    $("#source-count").textContent = count ? `${count} match${count === 1 ? "" : "es"}` : "No matches";
    el.scrollTop = 0;
  }

  /* ---------- highlight → notes ---------- */
  function setupHighlightButton() {
    const btn = $("#btn-add-highlight");
    const body = $("#source-body");

    body.addEventListener("mouseup", () => {
      const sel = window.getSelection();
      const text = sel ? String(sel).trim() : "";
      if (!text || text.length < 3 || !body.contains(sel.anchorNode)) {
        btn.hidden = true;
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      btn.hidden = false;
      btn.style.top = Math.max(70, rect.top - 42) + "px";
      btn.style.left = Math.max(12, rect.left) + "px";
      btn.dataset.sel = text;
    });

    document.addEventListener("mousedown", (e) => {
      if (!btn.hidden && !btn.contains(e.target) && !$("#panel-source").contains(e.target)) {
        btn.hidden = true;
      }
    });

    btn.addEventListener("click", () => {
      const doc = activeDoc();
      const sel = (btn.dataset.sel || "").trim();
      if (!doc || !sel) return;
      const quote = sel.split(/\n+/).map(l => "> " + l.trim()).join("\n");
      if (doc.notesMd.includes("## ✍️ My Highlights")) {
        doc.notesMd += "\n" + quote;
      } else {
        doc.notesMd += "\n\n## ✍️ My Highlights\n" + quote;
      }
      doc.updatedAt = Date.now();
      persist();
      btn.hidden = true;
      window.getSelection().removeAllRanges();
      if (ui.tab === "notes") renderNotes();
      recheckIntegrity();
      toast("Added to your notes", "ok");
    });
  }

  /* ---------- exports ---------- */
  function csvForAnki(cards) {
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    return "Front,Back\n" + cards.map(c => q(c.front) + "," + q(c.back)).join("\n");
  }

  function exportCsv() {
    const doc = activeDoc();
    if (!doc || !(doc.flashcards || []).length) { toast("No flashcards to export yet", "warn"); return; }
    download(slugify(doc.title) + "-flashcards.csv", csvForAnki(doc.flashcards), "text/csv;charset=utf-8");
    toast("Flashcards exported — import the CSV into Anki", "ok");
  }

  /* ================= settings modal ================= */
  function openSettings() {
    const s = state.settings;
    $("#set-theme").value = s.theme;
    $("#set-ai-base").value = s.ai.baseUrl || "";
    $("#set-ai-key").value = s.ai.apiKey || "";
    $("#set-ai-model").value = s.ai.model || "";
    $("#set-ai-temp").value = s.ai.temperature ?? 0.3;
    $("#set-ai-temp-val").textContent = s.ai.temperature ?? 0.3;
    $("#ai-test-result").textContent = "";
    $("#modal-settings").hidden = false;
  }
  function closeSettings() { $("#modal-settings").hidden = true; }

  /* ================= confirm modal ================= */
  let confirmCb = null;
  function confirmDialog(title, text, cb) {
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    confirmCb = cb;
    $("#modal-confirm").hidden = false;
  }

  /* ================= events ================= */
  function bindEvents() {
    // topbar
    $("#brand").addEventListener("click", (e) => { e.preventDefault(); showHome(); });
    $("#btn-theme").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme === "dark";
      state.settings.theme = dark ? "light" : "dark";
      applyTheme();
      save();
    });
    $("#btn-settings").addEventListener("click", openSettings);
    $("#btn-sidebar").addEventListener("click", () => {
      $("#sidebar").classList.toggle("open");
      $("#sidebar-scrim").classList.toggle("show");
    });
    $("#sidebar-scrim").addEventListener("click", closeSidebarMobile);

    // sidebar
    $("#btn-new-doc").addEventListener("click", () => { showHome(); switchHomeTab("paste"); $("#input-text").focus(); });
    $("#doc-search").addEventListener("input", renderSidebar);

    // home tabs
    $$(".input-tab").forEach(t => t.addEventListener("click", () => switchHomeTab(t.dataset.homeTab)));
    $("#input-text").addEventListener("input", updateInputStats);

    // upload
    const dz = $("#dropzone"), fi = $("#file-input");
    dz.addEventListener("click", () => fi.click());
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fi.click(); });
    ["dragover", "dragenter"].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    fi.addEventListener("change", () => { if (fi.files[0]) handleFile(fi.files[0]); fi.value = ""; });

    async function handleFile(file) {
      const st = $("#upload-status");
      st.hidden = false;
      st.textContent = "Reading " + file.name + "…";
      try {
        const r = await Readers.readFile(file, (s) => { st.textContent = s; });
        $("#input-text").value = r.text;
        if (!$("#input-title").value) $("#input-title").value = r.name;
        st.textContent = `✓ ${r.name} loaded — ${wordCount(r.text)} words`;
        updateInputStats();
        toast("File loaded — review the text, then Generate", "ok");
      } catch (e) {
        st.textContent = "";
        toast(e.message || "Could not read that file", "err", 6000);
      }
    }

    // generate
    $("#btn-generate").addEventListener("click", () => {
      $("#home-error").hidden = true;
      startGeneration({
        title: $("#input-title").value.trim(),
        text: $("#input-text").value,
        depth: $("#opt-depth").value,
        focus: $("#opt-focus").value.trim(),
        engine: $("#opt-engine").value
      });
    });
    $("#opt-engine").addEventListener("change", (e) => {
      if (e.target.value === "ai" && !state.settings.ai.apiKey) {
        toast("AI engine needs a key — add it in Settings (or stay on Instant)", "warn", 4500);
      }
    });
    $("#btn-cancel-gen").addEventListener("click", () => {
      if (ui.controller) ui.controller.abort();
    });

    // doc head
    $("#doc-title").addEventListener("change", () => {
      const doc = activeDoc();
      if (!doc) return;
      doc.title = $("#doc-title").value.trim() || "Untitled chapter";
      $("#doc-title").value = doc.title;
      doc.updatedAt = Date.now();
      persist();
    });
    $("#doc-depth").addEventListener("change", () => {
      const doc = activeDoc();
      if (doc) { doc.depth = $("#doc-depth").value; save(); }
    });
    $("#btn-regenerate").addEventListener("click", () => {
      const doc = activeDoc();
      if (!doc) return;
      startGeneration({
        title: doc.title,
        text: doc.sourceText,
        depth: $("#doc-depth").value,
        focus: doc.focus || "",
        engine: doc.engine || "instant"
      }, doc.id);
    });

    // export menu
    const menu = $("#export-menu");
    $("#btn-export").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !e.target.closest(".menu-wrap")) menu.hidden = true;
    });
    $("#btn-copy-md").addEventListener("click", async () => {
      const doc = activeDoc();
      if (!doc) return;
      const ok = await copyText(doc.notesMd);
      toast(ok ? "Notes copied as Markdown" : "Copy failed — try the download option", ok ? "ok" : "err");
      menu.hidden = true;
    });
    $("#btn-dl-md").addEventListener("click", () => {
      const doc = activeDoc();
      if (!doc) return;
      download(slugify(doc.title) + "-notes.md", doc.notesMd, "text/markdown;charset=utf-8");
      menu.hidden = true;
      toast("Downloaded .md", "ok");
    });
    $("#btn-dl-csv").addEventListener("click", () => { menu.hidden = true; exportCsv(); });
    $("#btn-print").addEventListener("click", () => { menu.hidden = true; window.print(); });

    // tabs
    $$(".tab").forEach(t => t.addEventListener("click", () => {
      ui.tab = t.dataset.tab;
      renderDoc();
    }));

    // notes toolbar
    $("#btn-edit-notes").addEventListener("click", () => setEditing(!ui.editing));
    $("#btn-edit-done").addEventListener("click", finishEditing);
    $("#notes-editor").addEventListener("input", onEditorInput);
    $("#chk-flag").addEventListener("change", (e) => {
      state.settings.flags.flagEnabled = e.target.checked;
      save();
      renderNotes();
    });

    // flashcards
    $("#card3d").addEventListener("click", () => {
      ui.card.flipped = !ui.card.flipped;
      $("#card3d").classList.toggle("flipped", ui.card.flipped);
    });
    $("#btn-prev-card").addEventListener("click", () => cardNav(-1));
    $("#btn-next-card").addEventListener("click", () => cardNav(1));
    $("#btn-known-card").addEventListener("click", () => markKnown(true));
    $("#btn-again-card").addEventListener("click", () => markKnown(false));
    $("#btn-shuffle-cards").addEventListener("click", () => {
      ui.card.order = shuffle(ui.card.order);
      ui.card.pos = 0;
      showCard();
    });
    $("#btn-reset-cards").addEventListener("click", () => {
      const doc = activeDoc();
      if (!doc) return;
      ui.card = { docId: doc.id, order: (doc.flashcards || []).map((_, i) => i), pos: 0, known: new Set(), flipped: false };
      doc.knownCards = [];
      save();
      showCard();
    });
    $("#btn-cards-again").addEventListener("click", () => {
      const doc = activeDoc();
      if (!doc) return;
      ui.card = { docId: doc.id, order: (doc.flashcards || []).map((_, i) => i), pos: 0, known: new Set(), flipped: false };
      showCard();
    });
    $("#btn-rebuild-cards").addEventListener("click", () => {
      const doc = activeDoc();
      if (!doc) return;
      doc.flashcards = Engine.buildFlashcards(Engine.parseNotes(doc.notesMd));
      persist();
      renderDoc();
      toast("Flashcards rebuilt", "ok");
    });

    // quiz
    $("#btn-quiz-submit").addEventListener("click", submitQuiz);
    $("#btn-quiz-retry").addEventListener("click", () => {
      ui.quiz = { answers: {}, submitted: false };
      renderQuiz();
    });
    $("#btn-rebuild-quiz").addEventListener("click", () => {
      const doc = activeDoc();
      if (!doc) return;
      doc.quiz = Engine.buildQuiz(Engine.parseNotes(doc.notesMd));
      persist();
      renderDoc();
      toast("Quiz rebuilt", "ok");
    });

    // source
    $("#source-search").addEventListener("input", (e) => renderSourceText(e.target.value.trim()));
    setupHighlightButton();

    // settings
    $("#btn-close-settings").addEventListener("click", closeSettings);
    $("#modal-settings").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSettings(); });
    $("#set-theme").addEventListener("change", (e) => { state.settings.theme = e.target.value; applyTheme(); save(); });
    $("#set-ai-base").addEventListener("input", (e) => { state.settings.ai.baseUrl = e.target.value.trim(); save(); });
    $("#set-ai-key").addEventListener("input", (e) => { state.settings.ai.apiKey = e.target.value.trim(); save(); });
    $("#set-ai-model").addEventListener("input", (e) => { state.settings.ai.model = e.target.value.trim(); save(); });
    $("#set-ai-temp").addEventListener("input", (e) => {
      state.settings.ai.temperature = parseFloat(e.target.value);
      $("#set-ai-temp-val").textContent = e.target.value;
      save();
    });
    $("#set-ai-key-toggle").addEventListener("click", () => {
      const k = $("#set-ai-key");
      k.type = k.type === "password" ? "text" : "password";
    });
    $("#btn-test-ai").addEventListener("click", async () => {
      const r = $("#ai-test-result");
      r.textContent = "Testing…";
      r.className = "test-result";
      const res = await AI.testConnection(state.settings.ai);
      r.textContent = res.message;
      r.classList.add(res.ok ? "ok" : "bad");
    });
    $("#btn-clear-data").addEventListener("click", () => {
      confirmDialog("Delete everything?", `All ${state.docs.length} saved notes and settings will be removed from this browser. This cannot be undone.`, () => {
        Store.clear();
        state.docs = [];
        showHome();
        persist();
        toast("All data deleted", "ok");
      });
    });

    // confirm modal
    $("#btn-confirm-yes").addEventListener("click", () => {
      $("#modal-confirm").hidden = true;
      if (confirmCb) { const cb = confirmCb; confirmCb = null; cb(); }
    });
    $("#btn-confirm-no").addEventListener("click", () => { $("#modal-confirm").hidden = true; confirmCb = null; });
    $("#modal-confirm").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) { $("#modal-confirm").hidden = true; confirmCb = null; }
    });

    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

      if (e.key === "Escape") {
        $("#modal-confirm").hidden = true;
        closeSettings();
        $("#export-menu").hidden = true;
        $("#btn-add-highlight").hidden = true;
        return;
      }
      if (mod && e.key === "Enter" && ui.view === "home") {
        e.preventDefault();
        $("#btn-generate").click();
        return;
      }
      if (mod && (e.key === "e" || e.key === "E") && ui.view === "doc" && ui.tab === "notes") {
        e.preventDefault();
        setEditing(!ui.editing);
        return;
      }
      if (e.key === " " && !inField && ui.view === "doc" && ui.tab === "cards") {
        e.preventDefault();
        $("#card3d").click();
      }
    });
  }

  /* ================= init ================= */
  function init() {
    const saved = Store.load();
    if (saved) {
      state.docs = Array.isArray(saved.docs) ? saved.docs : [];
      if (saved.settings) {
        Object.assign(state.settings, saved.settings);
        state.settings.ai = Object.assign({ baseUrl: "", apiKey: "", model: "", temperature: 0.3 }, saved.settings.ai || {});
        state.settings.flags = Object.assign({ flagEnabled: true }, saved.settings.flags || {});
      }
    }
    $("#chk-flag").checked = state.settings.flags.flagEnabled;
    applyTheme();
    renderSamples();
    bindEvents();
    updateInputStats();
    renderSidebar();
    showHome();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

})();
