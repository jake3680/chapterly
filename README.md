# 📘 Chapterly

**Turn any book chapter into exam-ready notes — instantly, in your browser.**

Chapterly is a study-notes generator inspired by tools like studley.ai, rebuilt
around one idea: *notes you can trust*. It reads a chapter (pasted, or from a
`.txt` / `.md` / `.pdf` / `.docx` file) and produces structured notes, flashcards
and a quiz — then checks every sentence of those notes against your source text.

No signup. No paywall. No server. Your text never leaves the browser unless you
explicitly enable the optional AI engine.

> **Live site: <https://jake3680.github.io/chapterly/>**

---

## Quick start

Open **<https://jake3680.github.io/chapterly/>** — or run it locally by
double-clicking `index.html`, or serve the folder:

```
node test\serve.js        →  http://localhost:8787
```

Then: **Try a sample → Generate notes**. That's the whole onboarding.

## What you get

| Feature | How it works |
| --- | --- |
| 📝 **Structured notes** | TL;DR, key-concepts table, section-by-section details, key facts & figures, takeaways, self-check questions |
| 🛡️ **Integrity check** | Every note sentence is matched against the source; unsupported claims are flagged in yellow with a live "source-matched %" chip |
| ⚡ **Instant engine** | A built-in extractive engine (TF-IDF sentence scoring, definition detection, key-term mining). Works fully offline — and since it copies your text verbatim, hallucination is impossible by construction |
| 🤖 **AI engine (optional)** | Bring your own key for any OpenAI-compatible API (OpenAI, Groq, Together, OpenRouter, Ollama…). Streams live, and output is integrity-checked like everything else |
| 🃏 **Flashcards** | Auto-built definitions, fact cloze cards, question cards. Flip, shuffle, "got it / review again" tracking, **Anki CSV export** |
| ❓ **Quiz** | Definition-match and fill-in-the-blank MCQs with explanations for wrong answers |
| ✍️ **Highlight → notes** | Select any text in the Source tab to add it to your notes as a highlight |
| ✏️ **Fully editable** | Notes are Markdown; edit freely. Flashcards, quiz and integrity score rebuild automatically |
| 📤 **Real export** | Copy Markdown, download `.md`, Anki-ready CSV, print/PDF with a clean print stylesheet |
| 💾 **Autosave** | Everything persists in `localStorage` — close the tab, come back tomorrow |
| 🌗 **Dark / light** | Follows your system theme, toggleable |

## The common problems it fixes

These are the failure modes that plague AI note-making sites — each one is
addressed head-on:

1. **Hallucinated content** — the Instant engine is extractive (verbatim from
   your text). The AI engine has a grounding-enforcing prompt *and* a
   post-generation integrity check that flags sentences not found in the source.
2. **Truncated long chapters** — the AI engine splits long chapters into chunks,
   writes notes per part, then merges them; the ending is never silently
   dropped. (Tested with a 10,000-word chapter: all 25 sections present.)
3. **Signup walls & subscriptions** — no account, no server, no limits. The
   Instant engine needs nothing at all.
4. **Locked, uneditable output** — everything is Markdown you can edit; study
   material rebuilds itself around your edits.
5. **Lost work** — autosave to local storage on every change.
6. **No ownership / no export** — Markdown, PDF (print) and Anki CSV export.
7. **English-only output** — the AI engine is instructed to answer in the
   source language; the Instant engine is language-agnostic for Latin scripts
   (its stop-word list is English-tuned).
8. **Flash of generic summaries** — depth control (Quick skim / Standard /
   Deep dive) and an optional focus field ("definitions and dates for the exam")
   steer what gets kept.

## Using the AI engine

Open **⚙️ Settings → AI engine**:

- **Base URL** — e.g. `https://api.openai.com/v1`, `https://api.groq.com/openai/v1`,
  or `http://localhost:11434/v1` for a local Ollama.
- **API key** — stored *only* in your browser's local storage and sent directly
  to the endpoint you choose.
- **Model** — e.g. `gpt-4o-mini`, `llama3.1`, `mixtral-8x7b`.
- Use **Test connection** to verify, and pick the 🤖 engine on the input card.

Long chapters are streamed in parts with a visible live preview; you can cancel
mid-generation.

## Privacy

- The Instant engine: 100% offline, nothing ever leaves the page.
- The AI engine: your text goes only to the API endpoint you configured, using
  the key stored in your browser. Chapterly has no backend of its own.
- PDF/DOCX extraction happens in your browser (pdf.js / mammoth.js are fetched
  from a CDN only when you open such a file).

## Project structure

```
chapterly/
├── index.html          # app shell
├── css/styles.css      # design system (light/dark/print)
├── js/
│   ├── util.js         # helpers, toasts, storage
│   ├── md.js           # dependency-free markdown renderer + claim flagging
│   ├── data.js         # built-in sample chapters
│   ├── engine.js       # Instant engine: extractive notes, integrity check,
│   │                   #   notes parser, flashcard & quiz builders
│   ├── ai.js           # BYO-key AI client (streaming, chunked map-reduce)
│   ├── readers.js      # txt/md/pdf/docx text extraction
│   └── app.js          # views, tabs, exports, settings
└── test/
    ├── engine.test.js  # headless engine tests (node test\engine.test.js)
    ├── serve.js        # tiny static server for local dev
    └── mock-ai.js      # mock OpenAI-compatible server for AI-path testing
```

## Notes & limits

- `localStorage` holds your library (practical limit of a few MB per browser).
- The Instant engine's stop-word list is English; extraction quality is best on
  well-structured text with headings. Very short texts (<30 words) are rejected.
- Scanned/image-only PDFs have no extractable text and are rejected with a
  clear message — paste the text instead.
