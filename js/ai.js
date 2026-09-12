/* ============================================================
   Chapterly — AI engine (bring your own key)
   Works with any OpenAI-compatible /chat/completions endpoint:
   OpenAI, Groq, Together, OpenRouter, LM Studio, Ollama, …
   Long chapters are chunked and merged so nothing is truncated.
   ============================================================ */
"use strict";

const AI = (() => {

  const DEFAULT_BASE = "https://api.openai.com/v1";
  const CHUNK_CHARS = 7000;

  class AIError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  function splitChunks(text, max = CHUNK_CHARS) {
    const paras = String(text).split(/\n\s*\n/);
    const chunks = [];
    let acc = "";
    for (const p of paras) {
      if (acc && (acc + "\n\n" + p).length > max) {
        chunks.push(acc.trim());
        acc = "";
      }
      // a single monster paragraph: hard-split on sentences
      if (p.length > max) {
        if (acc) { chunks.push(acc.trim()); acc = ""; }
        const sents = p.match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [p];
        let buf = "";
        for (const s of sents) {
          if (buf && (buf + s).length > max) { chunks.push(buf.trim()); buf = ""; }
          buf += s;
        }
        acc = buf;
      } else {
        acc += (acc ? "\n\n" : "") + p;
      }
    }
    if (acc.trim()) chunks.push(acc.trim());
    return chunks;
  }

  const DEPTH_GUIDE = {
    quick: "Keep the notes tight (under ~250 words): only the most essential points a student must retain.",
    standard: "Aim for roughly 400–700 words: solid coverage of every major idea.",
    deep: "Be thorough (700–1200 words): cover all sections, include examples, numbers and nuances from the text."
  };

  function systemPrompt(depth, focus) {
    return [
      "You are an expert study-notes writer. You convert textbook chapters into structured revision notes.",
      "STRICT RULES:",
      "1. Ground EVERY statement in the provided text. Never invent facts, names, numbers or definitions that are not there.",
      "2. Prefer the text's own wording and terminology; you may compress but not fabricate.",
      "3. Write in the same language as the source text.",
      "4. Output ONLY Markdown following this EXACT template:",
      "# {Chapter title}",
      "",
      "## 🎯 TL;DR",
      "- (2–3 one-line takeaways)",
      "",
      "## 📌 Key Concepts",
      "| Term | Meaning |",
      "| --- | --- |",
      "| **{term}** | {precise meaning from the text} |",
      "",
      "## 📝 Detailed Notes",
      "### {Section name}",
      "- (bullet points)",
      "",
      "## 🔢 Key Facts & Figures",
      "- (numbers, dates, percentages from the text)",
      "",
      "## 🧠 Remember These",
      "1. (one-line memorizable points)",
      "",
      "## ❓ Self-Check Questions",
      "1. (study questions about the text)",
      "",
      `Length guidance: ${DEPTH_GUIDE[depth] || DEPTH_GUIDE.standard}`,
      focus ? `The student asked to pay special attention to: ${focus}` : ""
    ].filter(Boolean).join("\n");
  }

  /* ---------- low-level streaming call ---------- */
  async function chatStream({ settings, messages, signal, onDelta }) {
    const base = (settings.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    const url = base + "/chat/completions";
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (settings.apiKey || "")
        },
        body: JSON.stringify({
          model: settings.model || "gpt-4o-mini",
          temperature: settings.temperature ?? 0.3,
          stream: true,
          messages: messages
        }),
        signal: signal
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new AIError("Network request failed. Check the Base URL, your connection, and that the endpoint allows browser requests (CORS).", 0);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = (j.error && j.error.message) || "";
      } catch {}
      const map = {
        401: "API key rejected (401). Check the key in Settings.",
        403: "Access denied (403). The key may lack permission for this model.",
        404: "Endpoint or model not found (404). Check the Base URL and model name.",
        429: "Rate limited or out of quota (429). Wait a moment and retry.",
        500: "The AI provider had a server error (500). Retry.",
        502: "Bad gateway from the provider (502). Retry.",
        503: "The provider is temporarily unavailable (503). Retry."
      };
      throw new AIError((map[res.status] || `Request failed (${res.status}).`) + (detail ? " " + detail : ""), res.status);
    }

    if (!res.body) {
      const j = await res.json();
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices && j.choices[0] && (
            (j.choices[0].delta && j.choices[0].delta.content) ||
            (j.choices[0].message && j.choices[0].message.content) || "");
          if (delta) {
            full += delta;
            if (onDelta) onDelta(full, delta);
          }
        } catch {}
      }
    }
    return full;
  }

  /* ---------- main entry ---------- */
  async function generate({ text, depth, focus, title, settings, signal, onStage, onDelta }) {
    if (!settings.apiKey) throw new AIError("No API key set. Open Settings → AI engine and add your key, or switch to the Instant engine.", 401);
    if (!settings.model) throw new AIError("No model set. Open Settings → AI engine and enter a model name (e.g. gpt-4o-mini).", 404);

    const chunks = splitChunks(text);
    const sys = systemPrompt(depth, focus);

    onStage && onStage("analyze", 0, chunks.length);

    if (chunks.length === 1) {
      onStage && onStage("compose", 1, 1);
      const messages = [
        { role: "system", content: sys },
        { role: "user", content: `Chapter${title ? ` (“${title}”)` : ""}:\n\n${chunks[0]}` }
      ];
      const md = await chatStream({ settings, messages, signal, onDelta });
      return cleanup(md);
    }

    // map: notes per chunk
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      onStage && onStage("compose", i + 1, chunks.length);
      const messages = [
        { role: "system", content: sys },
        { role: "user", content: `This is PART ${i + 1} of ${chunks.length} of a chapter${title ? ` (“${title}”)` : ""}. Write the structured notes for THIS PART ONLY. Use the template but skip the "# title" line. Text:\n\n${chunks[i]}` }
      ];
      const part = await chatStream({
        settings, messages, signal,
        onDelta: (full) => onDelta && onDelta(full, `Part ${i + 1}/${chunks.length}`)
      });
      parts.push(part.trim());
    }

    // reduce: merge
    onStage && onStage("merge", chunks.length, chunks.length);
    const mergeMessages = [
      { role: "system", content: sys },
      { role: "user", content: `Below are notes written for ${parts.length} consecutive parts of ONE chapter. Merge them into a single set of final notes: remove duplicates, keep ALL key facts and figures, keep every section of the template (including "# {title}"). Do not lose information that appears in only one part.\n\n${title ? `Chapter title: ${title}\n\n` : ""}${parts.map((p, i) => `=== PART ${i + 1} ===\n${p}`).join("\n\n")}` }
    ];
    const merged = await chatStream({
      settings, messages: mergeMessages, signal,
      onDelta: (full) => onDelta && onDelta(full, "Merging parts")
    });
    return cleanup(merged);
  }

  function cleanup(md) {
    return String(md || "")
      .replace(/^\s*```(?:markdown|md)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  }

  async function testConnection(settings) {
    const base = (settings.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    try {
      const res = await fetch(base + "/models", {
        headers: { "Authorization": "Bearer " + (settings.apiKey || "") }
      });
      if (res.ok) return { ok: true, message: "Connected ✓" };
      if (res.status === 401) return { ok: false, message: "Key rejected (401)" };
      if (res.status === 404) return { ok: false, message: "Endpoint not found (404) — check Base URL" };
      return { ok: false, message: `HTTP ${res.status}` };
    } catch {
      return { ok: false, message: "Network/CORS error — endpoint unreachable from the browser" };
    }
  }

  return { generate: generate, testConnection: testConnection, splitChunks: splitChunks, AIError: AIError, DEFAULT_BASE: DEFAULT_BASE };
})();
