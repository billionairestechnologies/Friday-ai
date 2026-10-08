/* FridayX webview. Plain JS on purpose: no bundler, no framework, nothing to audit but this file. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const thread = $("thread"), input = $("input"), chipsEl = $("chips"), menu = $("menu");

  let state = { status: "idle", busy: false, models: [], currentModel: "", commands: [], error: "", installHint: "" };
  let context = { file: null };
  let attachments = []; // manual chips: {path, rel, startLine?, endLine?}
  let autoChipOn = true;
  let queue = [];
  let currentAgent = null; // {el, raw}
  let currentThought = null;
  const tools = new Map(); // toolCallId -> {el, data}
  const permEls = new Map();
  let workingEl = null;
  let menuItems = [], menuSel = 0, menuMode = null;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  const toBottom = (force) => { if (force || stick) thread.scrollTop = thread.scrollHeight; };
  let stick = true;
  const jump = el("button", "jump", "↓"); jump.title = "Jump to latest"; jump.hidden = true; document.body.appendChild(jump);
  jump.onclick = () => { stick = true; toBottom(true); };
  thread.addEventListener("scroll", () => { stick = nearBottom(); jump.hidden = stick; });

  // Small, safe markdown: everything is escaped first, then a handful of constructs are re-introduced.
  // Safe markdown: everything is escaped first, then a fixed set of constructs is re-introduced. Covers what answers
  // actually use: headings, nested lists, tables, quotes, rules, code, links, and clickable file paths.
  const FILE_RE = /^(?:\.{0,2}\/)?[\w@.\-]+(?:\/[\w@.\-]+)*\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)?$/;
  function md(src) {
    const blocks = [];
    let t = String(src).replace(/```([\w+-]*)\n([\s\S]*?)(```|$)/g, (_, lang, code) => {
      blocks.push(`<pre><button class="copy">Copy</button><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    t = esc(t);
    const fileLink = (txt) => {
      const m = txt.match(/^(.*?)(?::(\d+)(?:-\d+)?|#L(\d+)(?:-L?\d+)?)?$/);
      const path = m[1], line = m[2] || m[3] || "";
      return `<code class="fp" data-fp="${path}" data-line="${line}" title="Open ${path}">${txt}</code>`;
    };
    const inline = (s) => s
      .replace(/`([^`\n]+)`/g, (_, c) => (FILE_RE.test(c) ? fileLink(c) : `<code>${c}</code>`))
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\[([^\]]+)\]\(((?!https?:)[^)\s]+)\)/g, (_, txt, target) => { const m = target.match(/^(.*?)(?:#L(\d+))?$/); return `<a class="fp" href="#" data-fp="${m[1]}" data-line="${m[2] || ""}">${txt}</a>`; });
    const lines = t.split("\n");
    const out = [];
    const stack = []; // open lists: {type, indent}
    const closeLists = (toIndent = -1) => { while (stack.length && stack[stack.length - 1].indent > toIndent) out.push(`</${stack.pop().type}>`); };
    const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      let m;
      // table: header row, then a |---|---| separator
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[n + 1] || "")) {
        closeLists();
        const head = cells(line); const rows = []; n += 2;
        while (n < lines.length && /^\s*\|.*\|\s*$/.test(lines[n])) rows.push(cells(lines[n++]));
        n--;
        out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { closeLists(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
      else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeLists(); out.push("<hr>"); }
      else if ((m = line.match(/^&gt;\s?(.*)$/))) { closeLists(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
      else if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
        const indent = m[1].replace(/\t/g, "  ").length, type = /\d/.test(m[2]) ? "ol" : "ul";
        const top = stack[stack.length - 1];
        if (!top || indent > top.indent) { stack.push({ type, indent }); out.push(`<${type}>`); }
        else { closeLists(indent); const t2 = stack[stack.length - 1]; if (!t2 || t2.indent < indent) { stack.push({ type, indent }); out.push(`<${type}>`); } else if (t2.type !== type) { out.push(`</${stack.pop().type}>`); stack.push({ type, indent }); out.push(`<${type}>`); } }
        const task = m[3].match(/^\[( |x|X)\]\s+(.*)$/);
        out.push(`<li>${task ? `<input type="checkbox" disabled ${task[1] !== " " ? "checked" : ""}> ${inline(task[2])}` : inline(m[3])}</li>`);
      }
      else if (!line.trim()) { closeLists(); out.push(""); }
      else if (/^\u0000\d+\u0000$/.test(line.trim())) { closeLists(); out.push(line.trim()); }
      else { closeLists(); out.push(`<p>${inline(line)}</p>`); }
    }
    closeLists();
    return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  thread.addEventListener("click", (e) => {
    const b = e.target.closest(".copy");
    if (b) { navigator.clipboard?.writeText(b.parentElement.querySelector("code").innerText); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); }
    const io = e.target.closest(".io2");
    if (io) { io.classList.toggle("open"); const rec = [...tools.values()].find((r) => r.el.contains(io)); if (rec) { rec.openIO = rec.openIO || new Set(); io.classList.contains("open") ? rec.openIO.add(io.dataset.key) : rec.openIO.delete(io.dataset.key); } }
    const fp = e.target.closest("[data-fp]");
    if (fp) { e.preventDefault(); vscode.postMessage({ t: "openFile", path: fp.dataset.fp, line: fp.dataset.line ? +fp.dataset.line : undefined }); }
    const f = e.target.closest("[data-open]");
    if (f) vscode.postMessage({ t: "openFile", path: f.dataset.open, line: f.dataset.line ? +f.dataset.line : undefined });
    const d = e.target.closest("[data-diff]");
    if (d) { const x = JSON.parse(d.dataset.diff); vscode.postMessage({ t: "openDiff", ...x }); }
  });


  // ---------- orbs and mascots (Libraries.dev, MIT) ----------
  // A small thinking orb shows what the agent is doing right now; subagents get a small mascot that works while the
  // subagent runs. All text stays in the IDE's own font (inherit); the canvases follow the IDE theme.
  const FX = () => window.FridayFx;
  const fxTheme = () => (document.body.dataset.theme === "light" || document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light") ? "light" : "dark");
  const BOTS = ["clover", "flower", "triangle", "ghost", "drop", "star", "cat", "droid", "circle", "blob"];
  const hashStr = (str) => { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const ACTIVITY = {
    thinking: { orb: "breathing", text: "Thinking…" }, read: { orb: "searching", text: "Reading…" }, search: { orb: "searching", text: "Searching…" },
    edit: { orb: "composing", text: "Editing…" }, delete: { orb: "composing", text: "Editing…" }, move: { orb: "composing", text: "Editing…" },
    execute: { orb: "working", text: "Running…" }, fetch: { orb: "connecting", text: "Fetching…" }, plan: { orb: "shaping", text: "Planning…" },
    agent: { orb: "weaving", text: "Delegating…" }, wait: { orb: "listening", text: "Waiting for you…" }, idle: { orb: "working", text: "Working…" },
  };
  let activity = "idle"; let thoughtChars = 0;
  function paintWorking(textOverride) {
    if (!workingEl) return;
    const a = ACTIVITY[activity] || ACTIVITY.idle;
    if (!workingEl.querySelector(".orbmount")) workingEl.innerHTML = `<span class="orbmount"></span><span class="wtxt"></span>`;
    const est = activity === "thinking" && thoughtChars > 40 ? ` · ~${Math.round(thoughtChars / 4)} tokens` : "";
    workingEl.querySelector(".wtxt").textContent = textOverride || a.text + est;
    if (FX()) FX().orb(workingEl.querySelector(".orbmount"), { state: a.orb, size: 20, theme: fxTheme() });
  }
  function setActivity(name, textOverride) { activity = name; paintWorking(textOverride); }
  const isSubagent = (d) => !!(d.rawInput && (d.rawInput.subagent_type || d.rawInput.subagentType || d.rawInput.variant === "Task")) || /^(task|agent|subagent)\b|spawn_subagent/i.test(d.title || "");
  // The poll that fetches a subagent's result is plumbing, not a step the person needs to see.
  const isTaskPoll = (d) => (d.rawInput && d.rawInput.variant === "TaskOutput") || /^(Get task output|get_command_or_subagent_output)/i.test(d.title || "") || /^\[subagent:/.test(d.title || "");
  function mountToolFx(rec) {
    const d = rec.data;
    const slot = rec.el.querySelector(".fxmount");
    if (!slot || !FX()) return;
    if (isSubagent(d)) {
      const type = BOTS[hashStr(rec.id) % BOTS.length];
      // The spawn call "completes" the moment the subagent starts; it keeps working until its result comes back.
      FX().bot(slot, { type, state: rec.subDone || d.status === "failed" ? "default" : "working", size: 26 });
    } else if (d.status === "in_progress") {
      FX().orb(slot, { state: (ACTIVITY[d.kind] || ACTIVITY.idle).orb, size: 20, theme: fxTheme() });
    }
  }

  // ---------- rendering ----------
  function empty() {
    thread.innerHTML = "";
    const e = el("div", "empty", `<img src="${window.FRIDAY_LOGO}" alt=""><h3>FridayX</h3><p>Your coding agent, with your Friday plan and models.</p><p>Ask it to build, fix or explain something in this project.</p>`);
    thread.appendChild(e);
  }
  function clearThread() {
    $("title").textContent = "New chat";
    currentAgent = null; currentThought = null; tools.clear(); permEls.clear(); workingEl = null;
    empty();
  }
  function ensureNotEmpty() { const e = thread.querySelector(".empty"); if (e) e.remove(); }
  function add(node) { ensureNotEmpty(); if (workingEl) thread.insertBefore(node, workingEl); else thread.appendChild(node); toBottom(); }

  function addUser(text, chips) {
    currentAgent = null; endThought();
    const m = el("div", "msg user");
    if (chips && chips.length) m.appendChild(el("div", "chips", chips.map((c) => `<span class="chip"><span>${esc(c.label)}</span></span>`).join(" ")));
    m.appendChild(document.createTextNode(text));
    const rw = el("button", "rw", "↩"); rw.title = "Rewind to before this message"; rw.setAttribute("aria-label", "Rewind");
    rw.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ t: "rewind", text }); };
    if (!text.startsWith("/")) m.appendChild(rw);
    add(m); stick = true; toBottom(true);
  }

  function appendAgent(text) {
    endThought();
    if (!currentAgent) { currentAgent = { el: el("div", "msg agent"), raw: "" }; add(currentAgent.el); }
    currentAgent.raw += text;
    scheduleRender(currentAgent);
  }
  const dirty = new Set(); let raf = 0;
  function scheduleRender(a) { dirty.add(a); if (!raf) raf = requestAnimationFrame(() => { raf = 0; for (const x of dirty) x.el.innerHTML = md(x.raw); dirty.clear(); toBottom(); }); }

  function endThought() {
    if (!currentThought) return;
    const secs = Math.max(1, Math.round((Date.now() - currentThought.t0) / 1000));
    currentThought.summary.textContent = `Thought for ${secs}s`; thoughtChars = 0;
    currentThought.el.classList.remove("live");
    currentThought = null;
  }
  function appendThought(text) {
    currentAgent = null;
    if (!currentThought) {
      const d = el("details", "thought live"); const sm = el("summary", "", "Thinking…"); d.appendChild(sm); d.appendChild(el("div"));
      currentThought = { el: d, body: d.lastChild, raw: "", summary: sm, t0: Date.now() }; add(d);
    }
    currentThought.raw += text; currentThought.body.textContent = currentThought.raw; toBottom();
  }

  const KIND_LABEL = { read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search", execute: "Run", think: "Think", fetch: "Fetch", other: "" };

  function textOf(content) {
    return (content || []).map((c) => (c.type === "content" && c.content?.type === "text" ? c.content.text : "")).filter(Boolean).join("\n");
  }
  function pretty(v) { if (v == null) return ""; if (typeof v === "string") return v; try { return JSON.stringify(v, null, 2); } catch { return String(v); } }

  // "Read `src/a.ts`" -> bold verb + the argument in code style, so a step reads like a sentence.
  function headHtml(d, sub) {
    const title = String(d.title || "Tool").replace(/`/g, "");
    if (sub) return `<span class="verb">Subagent</span><code class="arg">${esc(title.replace(/^spawn_subagent$/, "starting…").slice(0, 140))}</code>`;
    const m = title.match(/^(\S+)\s+(.*)$/);
    return m ? `<span class="verb">${esc(m[1])}</span><code class="arg">${esc(m[2].slice(0, 140))}</code>` : `<span class="verb">${esc(title)}</span>`;
  }
  function renderTool(rec) {
    const d = rec.data;
    const status = d.status || "pending";
    rec.el.className = `tool ${status}`;
    const open = rec.el.open;
    const input = d.rawInput?.command ?? d.rawInput?.cmd ?? (d.rawInput && Object.keys(d.rawInput).length ? pretty(d.rawInput) : "");
    const output = textOf(d.content) || (d.rawOutput ? pretty(d.rawOutput) : "");
    let body = "";
    for (const c of d.content || []) {
      if (c.type === "diff") {
        const rel = esc(c.path);
        const oldL = String(c.oldText ?? "").split("\n"), newL = String(c.newText ?? "").split("\n");
        const lines = (c.oldText ? oldL.map((l) => `<div class="l del">- ${esc(l)}</div>`) : []).concat(newL.map((l) => `<div class="l add">+ ${esc(l)}</div>`));
        body += `<button class="linkbtn" data-open="${esc(c.path)}">${rel}</button> <button class="linkbtn" data-diff='${esc(JSON.stringify({ path: c.path, oldText: c.oldText ?? "", newText: c.newText ?? "" }))}'>View diff</button><div class="diff">${lines.slice(0, 200).join("")}</div>`;
      }
    }
    // IN / OUT boxes like other agent UIs: a few lines with a fade, click to expand.
    const io2 = (lbl, txt, key) => `<div class="io2 ${rec.openIO && rec.openIO.has(key) ? "open" : ""}" data-key="${key}"><span class="lbl">${lbl}</span><pre>${esc(txt)}</pre></div>`;
    if (input && !body) body += io2("IN", String(input).slice(0, 4000), "in");
    if (output) body += io2("OUT", output.slice(0, 8000), "out");
    const loc = d.locations && d.locations[0];
    if (loc && !body.includes("data-open")) body += `<button class="linkbtn" data-open="${esc(loc.path)}" ${loc.line ? `data-line="${loc.line}"` : ""}>${esc(loc.path)}${loc.line ? ":" + loc.line : ""}</button>`;
    const sub = !!rec.sub || isSubagent(d), running = d.status === "in_progress" || d.status === "pending" || !d.status;
    rec.sub = sub;
    rec.el.style.display = isTaskPoll(d) ? "none" : "";
    const fxSlot = (sub || (running && d.status === "in_progress")) && FX();
    const old = rec.el.querySelector(".fxmount"); if (old && FX()) FX().unmount(old);
    rec.el.classList.toggle("subagent", sub);
    rec.el.innerHTML = `<summary>${fxSlot ? `<span class="fxmount ${sub ? "bot" : "orb"}"></span>` : `<span class="dot"></span>`}${headHtml(d, sub)}</summary>${body ? `<div class="body">${body}</div>` : ""}`;
    if (open) rec.el.open = true;
    if (fxSlot) mountToolFx(rec);
  }

  function onToolCall(u, replay) {
    currentAgent = null; endThought();
    if (!replay && !isTaskPoll(u) && (u.status === "in_progress" || u.status === "pending" || !u.status)) setActivity(isSubagent(u) ? "agent" : (u.kind && ACTIVITY[u.kind] ? u.kind : "idle"));
    let rec = tools.get(u.toolCallId);
    if (!rec) { rec = { el: el("details", "tool"), data: {}, id: u.toolCallId }; tools.set(u.toolCallId, rec); add(rec.el); }
    Object.assign(rec.data, strip(u));
    // Commands show their IN/OUT right away (that is the whole point of watching a command run); other steps stay collapsed.
    if (!rec.seen) { rec.seen = true; if (rec.data.kind === "execute") rec.el.open = true; }
    // Link a spawn card to its result: the spawn reply names the subagent, the poll's final title carries its id.
    const sid = /subagent_id:\s*([0-9a-f]{8})/i.exec(textOf(rec.data.content) || "");
    if (sid) rec.subId = sid[1].toLowerCase();
    if (/^\[subagent:/.test(u.title || "") && u.status === "completed") {
      const done = /\(([0-9a-f]{8})/i.exec(u.title)?.[1]?.toLowerCase();
      for (const r of tools.values()) if (r.sub && r.subId && r.subId === done) { r.subDone = true; renderTool(r); }
    }
    renderTool(rec);
    // Edits are the thing people want to see happen; keep them open while they stream in.
    if (!replay && rec.data.kind === "edit" && (rec.data.content || []).some((c) => c.type === "diff")) rec.el.open = true;
  }
  function strip(u) { const o = {}; for (const k of ["title", "kind", "status", "rawInput", "rawOutput", "locations"]) if (u[k] != null) o[k] = u[k]; if (u.content) o.content = u.content; return o; }

  function onPlan(entries) {
    currentAgent = null; setActivity("plan");
    let p = thread.querySelector(".plan.live");
    if (!p) { p = el("div", "plan live"); add(p); }
    p.innerHTML = `<h5>Plan</h5><ul>${(entries || []).map((e) => `<li class="${esc(e.status)}">${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"} ${esc(e.content)}</li>`).join("")}</ul>`;
  }

  function onUpdate(u, replay) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": if (u.content?.type === "text") { appendAgent(u.content.text); if (!replay && activity !== "idle") setActivity("idle"); } break;
      case "agent_thought_chunk": if (u.content?.type === "text") { appendThought(u.content.text); if (!replay) { thoughtChars += u.content.text.length; setActivity("thinking"); } } break;
      case "user_message_chunk": if (replay && u.content?.type === "text" && !u.content.text.startsWith("[Editor context")) addUser(u.content.text); break;
      case "tool_call": case "tool_call_update": onToolCall(u, replay); break;
      case "plan": onPlan(u.entries); break;
    }
  }

  function showPermission(m) {
    currentAgent = null; setActivity("wait");
    const p = el("div", "perm");
    const detail = m.rawInput?.command ?? m.rawInput?.path ?? "";
    const diffs = (m.content || []).filter((c) => c.type === "diff");
    const diffHtml = diffs.map((c) => {
      const oldL = c.oldText ? String(c.oldText).split("\n") : [], newL = String(c.newText ?? "").split("\n");
      return `<div class="n"><button class="linkbtn" data-open="${esc(c.path)}">${esc(c.path)}</button> <button class="linkbtn" data-diff='${esc(JSON.stringify({ path: c.path, oldText: c.oldText ?? "", newText: c.newText ?? "" }))}'>Open diff</button></div><div class="diff">${oldL.slice(0, 80).map((l) => `<div class="l del">- ${esc(l)}</div>`).join("")}${newL.slice(0, 120).map((l) => `<div class="l add">+ ${esc(l)}</div>`).join("")}</div>`;
    }).join("");
    p.innerHTML = `<div class="q">${esc(m.title)}</div>${diffHtml || (detail ? `<div class="io ${m.rawInput?.command ? "term" : ""}">${m.rawInput?.command ? '<span class="prompt">$</span> ' : ""}${esc(String(detail).slice(0, 1500))}</div>` : "")}<div class="opts"></div>`;
    const opts = p.querySelector(".opts");
    for (const o of m.options) {
      const b = el("button", /reject|deny/.test(o.kind) ? "reject" : "", esc(o.name));
      b.onclick = () => vscode.postMessage({ t: "permission", reqId: m.reqId, optionId: o.id });
      opts.appendChild(b);
    }
    const c = el("button", "reject", "Cancel"); c.onclick = () => vscode.postMessage({ t: "permission", reqId: m.reqId, optionId: null }); opts.appendChild(c);
    permEls.set(m.reqId, p); add(p); stick = true; toBottom(true);
  }
  function donePermission(m) {
    const p = permEls.get(m.reqId); if (!p) return;
    p.classList.add("done");
    const o = p.querySelector(".opts"); if (o) o.innerHTML = `<span>${m.optionId ? "Answered" : "Cancelled"}</span>`;
  }

  // ---------- gate + state ----------
  function renderState() {
    const gate = $("gate"), ready = state.status === "ready";
    const needsGate = ["auth", "signingIn", "installing", "error"].includes(state.status);
    gate.hidden = !needsGate;
    thread.style.display = needsGate ? "none" : "";
    $("composer").style.display = needsGate && state.status !== "error" ? "none" : "";
    if (state.status === "auth") {
      gate.innerHTML = `<img src="${window.FRIDAY_LOGO}" width="44" height="44" style="border-radius:10px"><h3>Sign in to FridayX</h3><p>Use your Friday account. Your plan, models and usage come with it. Nothing else to install.</p>${state.error ? `<div class="err">${esc(state.error)}</div>` : ""}<button id="g1">Sign in with browser</button>`;
      $("g1").onclick = () => vscode.postMessage({ t: "signIn" });
    } else if (state.status === "signingIn") {
      gate.innerHTML = `<h3>Approve in your browser</h3><p>Check that this code matches the one on the page, then approve.</p><div class="code">${esc(state.device?.code || "")}</div><button id="g1">Open the page again</button><button id="g2" class="secondary">Cancel</button><p class="hint">Waiting for approval…</p>`;
      $("g1").onclick = () => vscode.postMessage({ t: "openUrl", url: state.device?.url });
      $("g2").onclick = () => vscode.postMessage({ t: "cancelSignIn" });
    } else if (state.status === "installing") {
      const n = state.installNote, pct = n && n.percent != null ? n.percent : null;
      gate.innerHTML = `<img src="${window.FRIDAY_LOGO}" width="44" height="44" style="border-radius:10px"><h3>Setting up FridayX</h3><p>FridayX runs on the same <b>friday</b> agent as the terminal CLI. It is being downloaded once, checked against a checksum from your Friday server, and kept inside VS Code's own storage.</p><div class="progress"><i style="width:${pct == null ? 100 : pct}%" class="${pct == null ? "ind" : ""}"></i></div><p class="hint">${esc(n ? n.note : "Checking for the latest version…")}</p>`;
    } else if (state.status === "error") {
      gate.innerHTML = `<h3>FridayX couldn't start</h3><div class="err">${esc(state.error)}</div><button id="g1">Try again</button><button id="g2" class="secondary">Settings</button>`;
      $("g1").onclick = () => vscode.postMessage({ t: "restart" }); $("g2").onclick = () => vscode.postMessage({ t: "settings" });
    }
    $("account").innerHTML = state.account && state.status !== "auth" ? `${esc(state.account.email || state.account.name || "Signed in")} · <button class="linkbtn" id="so">Sign out</button>` : "";
    const so = $("so"); if (so) so.onclick = () => vscode.postMessage({ t: "signOut" });
    const MODES = { ask: "Ask first", plan: "Plan", auto: "Auto-approve" };
    const mb = $("modeBtn"); mb.textContent = (MODES[state.mode] || MODES.ask) + " ▾"; mb.className = "chipbtn " + (state.mode === "plan" ? "plan" : state.mode === "auto" ? "auto" : "");
    const cur = state.models.find((m) => m.id === state.currentModel);
    const mdl = $("modelBtn"); mdl.textContent = cur ? cur.name + " ▾" : ""; mdl.style.display = cur ? "" : "none";
    const send = $("btnSend");
    send.classList.toggle("stop", !!state.busy); send.innerHTML = state.busy ? "&#9632;" : "&#8593;"; send.title = state.busy ? "Stop" : "Send (Enter)";
    $("note").textContent = ready ? "" : state.status === "starting" ? "Starting…" : "";
    if (state.busy && !workingEl) { workingEl = el("div", "working"); thread.appendChild(workingEl); activity = "idle"; paintWorking(); toBottom(); }
    if (!state.busy && workingEl) { const m = workingEl.querySelector(".orbmount"); if (m && FX()) FX().unmount(m); workingEl.remove(); workingEl = null; }
    if (!state.busy && queue.length) { const n = queue.shift(); renderQueue(); doSend(n); }
  }

  function renderQueue() { $("queue").innerHTML = queue.map((q) => `<div class="q">Queued: ${esc(q.slice(0, 80))}</div>`).join(""); }

  // ---------- composer ----------
  function allChips() {
    const chips = attachments.slice();
    if (autoChipOn && context.file && !chips.some((c) => c.path === context.file && !c.startLine === !context.startLine)) {
      chips.unshift({ path: context.file, rel: context.rel, startLine: context.startLine, endLine: context.endLine, auto: true });
    }
    return chips;
  }
  const chipLabel = (c) => c.rel + (c.startLine ? `#L${c.startLine}${c.endLine && c.endLine !== c.startLine ? "-" + c.endLine : ""}` : "");
  function renderChips() {
    chipsEl.innerHTML = "";
    for (const c of allChips()) {
      const chip = el("span", "chip" + (c.auto ? " auto" : ""), `<span title="${esc(c.path)}">${esc(chipLabel(c))}</span>`);
      const x = el("button", "", "×"); x.title = "Remove";
      x.onclick = () => { if (c.auto) autoChipOn = false; else attachments = attachments.filter((a) => a !== c); renderChips(); };
      chip.appendChild(x); chipsEl.appendChild(chip);
    }
  }

  function doSend(text) {
    const chips = allChips().map(({ path, startLine, endLine }) => ({ path, startLine, endLine }));
    vscode.postMessage({ t: "send", text, attachments: chips });
    attachments = []; autoChipOn = true; renderChips();
  }
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = ""; autoGrow(); closeMenu();
    if (state.busy) { queue.push(text); renderQueue(); return; }
    doSend(text);
  }
  function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 220) + "px"; }

  // slash + @ menus
  function openMenu(mode, items) { menuMode = mode; menuItems = items; menuSel = 0; renderMenu(); }
  function closeMenu() { menu.hidden = true; menuMode = null; menuItems = []; }
  function renderMenu() {
    if (!menuItems.length) return closeMenu();
    menu.hidden = false; menu.innerHTML = "";
    menuItems.forEach((it, i) => {
      const row = el("div", "item" + (i === menuSel ? " sel" : ""), `<span>${esc(it.label)}</span><span class="d">${esc(it.detail || "")}</span>`);
      row.onmousedown = (e) => { e.preventDefault(); pick(it); };
      menu.appendChild(row);
    });
  }
  function pick(it) {
    if (menuMode === "slash") { input.value = `/${it.name} `; }
    else if (menuMode === "file") {
      input.value = input.value.replace(/@[^\s@]*$/, "");
      if (!attachments.some((a) => a.path === it.path)) attachments.push({ path: it.path, rel: it.rel });
      renderChips();
    }
    closeMenu(); input.focus(); autoGrow();
  }
  function updateMenus() {
    const v = input.value;
    const slash = v.match(/^\/([\w:-]*)$/);
    if (slash) {
      const q = slash[1].toLowerCase();
      return openMenu("slash", state.commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 30).map((c) => ({ name: c.name, label: "/" + c.name, detail: c.hint ? c.hint + "  " + c.description : c.description })));
    }
    const at = v.match(/@([^\s@]*)$/);
    if (at) return vscode.postMessage({ t: "searchFiles", query: at[1] });
    closeMenu();
  }

  // Pasted or dropped images become attachments (saved to a temp file; the agent reads images by path).
  const sendImage = (f) => { const r = new FileReader(); r.onload = () => vscode.postMessage({ t: "pasteImage", data: String(r.result) }); r.readAsDataURL(f); };
  input.addEventListener("paste", (e) => { const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/")); if (!imgs.length) return; e.preventDefault(); imgs.forEach(sendImage); });
  $("composer").addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
  $("composer").addEventListener("drop", (e) => { const imgs = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/")); if (!imgs.length) return; e.preventDefault(); imgs.forEach(sendImage); });
  input.addEventListener("input", () => { autoGrow(); updateMenus(); });
  input.addEventListener("keydown", (e) => {
    if (!menu.hidden) {
      if (e.key === "ArrowDown") { menuSel = (menuSel + 1) % menuItems.length; renderMenu(); return e.preventDefault(); }
      if (e.key === "ArrowUp") { menuSel = (menuSel - 1 + menuItems.length) % menuItems.length; renderMenu(); return e.preventDefault(); }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { pick(menuItems[menuSel]); return e.preventDefault(); }
      if (e.key === "Escape") { closeMenu(); return e.preventDefault(); }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === "Escape" && state.busy) vscode.postMessage({ t: "cancel" });
  });
  $("btnSend").onclick = () => (state.busy ? vscode.postMessage({ t: "cancel" }) : submit());
  $("btnNew").onclick = () => { queue = []; renderQueue(); closeHistory(); vscode.postMessage({ t: "newChat" }); };
  $("btnAttach").onclick = () => vscode.postMessage({ t: "pickFiles" });
  $("btnSlash").onclick = () => openActions();
  $("btnHistory").onclick = () => { $("manage").hidden = true; const h = $("history"); if (h.hidden) { h.hidden = false; h.innerHTML = "<h4>Loading…</h4>"; vscode.postMessage({ t: "listSessions" }); } else closeHistory(); };
  function closeHistory() { $("history").hidden = true; }


  // ---------- manage: plugins, MCP, skills, settings ----------
  let mg = { tab: "plugins", data: null, msg: null };
  function openManage(tab) { const m = $("manage"); closeHistory(); mg.tab = tab || "plugins"; mg.msg = null; m.hidden = false; if (mg.data) renderManage(); else m.innerHTML = "<p>Loading…</p>"; vscode.postMessage({ t: "manageList" }); }
  const act = (action, name, extra) => vscode.postMessage({ t: "manageAction", action, name, extra });
  function renderManage() {
    const d = mg.data; const root = $("manage"); if (!d) return;
    const tabs = ["plugins", "mcp", "skills", "settings"].map((t) => `<button class="tab ${mg.tab === t ? "on" : ""}" data-tab="${t}">${{ plugins: "Plugins", mcp: "MCP", skills: "Skills", settings: "Settings" }[t]}</button>`).join("");
    let body = "";
    if (d.needsNewChat) body += `<div class="banner"><span>Changes apply to new chats.</span><button class="mini pri" id="mgNew">New chat</button></div>`;
    if (mg.msg) body += `<div class="status">${esc(mg.msg)}</div>`;
    if (mg.tab === "plugins") {
      const inst = d.plugins.filter((p) => p.status !== "available"), avail = d.plugins.filter((p) => p.status === "available");
      body += `<h4>Installed</h4>` + (inst.length ? inst.map((p) => `<div class="row"><div class="main"><div class="n">${esc(p.name)} <span class="d">${esc(p.version || "")}${p.status === "disabled" ? " · disabled" : ""}</span></div><div class="d">${esc(p.description || p.marketplace || "")}</div></div><div class="acts">${p.status === "disabled" ? `<button class="mini" data-a="pluginEnable" data-n="${esc(p.name)}">Enable</button>` : `<button class="mini" data-a="pluginDisable" data-n="${esc(p.name)}">Disable</button>`}<button class="mini" data-a="pluginUpdate" data-n="${esc(p.name)}">Update</button><button class="mini bad" data-a="pluginUninstall" data-n="${esc(p.name)}">Remove</button></div></div>`).join("") : `<p class="d">No plugins installed yet.</p>`);
      body += `<h4>Available</h4>` + (avail.length ? avail.map((p) => `<div class="row"><div class="main"><div class="n">${esc(p.name)} <span class="d">${esc(p.version || "")}</span></div><div class="d">${esc(p.description || "")}</div></div><div class="acts"><button class="mini pri" data-a="pluginInstall" data-n="${esc(p.name)}">Install</button></div></div>`).join("") : `<p class="d">No marketplace plugins found.</p>`);
      body += `<h4>From a repository</h4><form id="plugForm"><input name="src" placeholder="GitHub user/repo, git URL or local path" required><button class="mini pri" type="submit">Install plugin</button></form>`;
    } else if (mg.tab === "mcp") {
      body += `<h4>MCP servers</h4>` + (d.mcp.length ? d.mcp.map((s) => `<div class="row"><div class="main"><div class="n">${esc(s.name)} <span class="d">${esc(s.scope || "")}${s.enabled === false ? " · disabled" : ""}</span></div><div class="d">${esc(s.url || [s.command, ...(s.args || [])].join(" "))}</div></div><div class="acts">${s.enabled === false ? `<button class="mini" data-a="mcpEnable" data-n="${esc(s.name)}">Enable</button>` : `<button class="mini" data-a="mcpDisable" data-n="${esc(s.name)}">Disable</button>`}<button class="mini bad" data-a="mcpRemove" data-n="${esc(s.name)}">Remove</button></div></div>`).join("") : `<p class="d">No MCP servers yet. MCP servers give FridayX tools like databases, browsers and APIs.</p>`);
      body += `<h4>Add a server</h4><form id="mcpForm"><input name="name" placeholder="Name (letters, numbers, - _)" required pattern="[\\w.\\-]{1,60}"><input name="target" placeholder="Command (npx) or URL (https://…)" required><input name="args" placeholder="Arguments, e.g. -y @modelcontextprotocol/server-everything"><select name="scope"><option value="user">For all my projects</option><option value="project">Only this project</option></select><button class="mini pri" type="submit">Add server</button></form>`;
    } else if (mg.tab === "skills") {
      body += `<h4>Skills</h4>` + (d.skills.length ? d.skills.map((s) => `<div class="row"><div class="main"><div class="n">/${esc(s.name)} <span class="d">${esc(s.scope)}</span></div><div class="d">${esc((s.description || "").slice(0, 160))}</div></div><div class="acts"><button class="mini pri" data-use="${esc(s.name)}">Use</button></div></div>`).join("") : `<p class="d">No skills found. Skills are folders with a SKILL.md in ~/.agents/skills, ~/.friday/skills or your project's .friday/skills; plugins can add skills too.</p>`);
    } else {
      body += `<h4>Settings</h4>
        <div class="row"><div class="main"><div class="n">Settings file</div><div class="d">${esc(d.configPath)}${d.shared ? " (shared with the terminal CLI)" : " (private to this extension)"}</div></div><div class="acts"><button class="mini pri" id="mgCfg">Open</button></div></div>
        <div class="row"><div class="main"><div class="n">Project instructions</div><div class="d">FRIDAY.md / AGENTS.md in this project: rules FridayX follows here.</div></div><div class="acts"><button class="mini pri" id="mgInst">Open</button></div></div>
        <div class="row"><div class="main"><div class="n">Extension settings</div><div class="d">Server, shared or private settings, agent override.</div></div><div class="acts"><button class="mini" id="mgExt">Open</button></div></div>
        <div class="row"><div class="main"><div class="n">Agent</div><div class="d">Version ${esc(d.version || "managed elsewhere")}. Updates itself from your Friday server.</div></div><div class="acts"><button class="mini" id="mgUpd">Check for update</button></div></div>
        <div class="row"><div class="main"><div class="n">Account</div><div class="d">${esc(state.account?.email || "")}</div></div><div class="acts"><button class="mini bad" id="mgOut">Sign out</button></div></div>`;
    }
    root.innerHTML = `<div class="tabs">${tabs}</div>${body}`;
    root.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { mg.tab = b.dataset.tab; mg.msg = null; renderManage(); }));
    root.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => { b.disabled = true; b.textContent = "…"; act(b.dataset.a, b.dataset.n); }));
    root.querySelectorAll("[data-use]").forEach((b) => (b.onclick = () => { $("manage").hidden = true; input.value = "/" + b.dataset.use + " "; input.focus(); autoGrow(); }));
    const on = (id, fn) => { const e = $(id); if (e) e.onclick = fn; };
    on("mgNew", () => { $("manage").hidden = true; vscode.postMessage({ t: "newChat" }); });
    on("mgCfg", () => vscode.postMessage({ t: "openConfig" }));
    on("mgInst", () => vscode.postMessage({ t: "openInstructions" }));
    on("mgExt", () => vscode.postMessage({ t: "settings" }));
    on("mgUpd", () => vscode.postMessage({ t: "install" }));
    on("mgOut", () => vscode.postMessage({ t: "signOut" }));
    const pf = $("plugForm"); if (pf) pf.onsubmit = (e) => { e.preventDefault(); act("pluginInstall", new FormData(pf).get("src").trim()); };
    const mf = $("mcpForm"); if (mf) mf.onsubmit = (e) => { e.preventDefault(); const f = new FormData(mf); const t = String(f.get("target")).trim(); act("mcpAdd", String(f.get("name")).trim(), { target: t, transport: /^https?:\/\//.test(t) ? "http" : "stdio", scope: f.get("scope"), args: f.get("args") }); };
  }


  // ---------- usage meter, What's New, agent update ----------
  // Same numbers as the web app: percent of each plan window and when it resets. Nothing in credits or tokens.
  let usage = null, usageOpen = false;
  const fmtReset = (iso) => {
    const ms = new Date(iso).getTime() - Date.now(); if (isNaN(ms)) return "";
    if (ms <= 0) return "resetting";
    const m = Math.round(ms / 60000);
    if (m < 60) return `resets in ${m}m`;
    if (m < 48 * 60) return `resets in ${Math.floor(m / 60)}h ${m % 60}m`;
    return `resets ${new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
  };
  const tone = (p) => (p >= 100 ? "full" : p >= 80 ? "warn" : "");
  function renderUsage() {
    const el = $("usage");
    if (!usage || !usage.windows.length) { el.hidden = true; return; }
    const top = usage.windows.reduce((a, b) => (b.percent > a.percent ? b : a));
    el.hidden = false;
    let html = `<div class="pill"><span>${esc(top.label)} ${top.percent}%</span><span class="bar"><i class="${tone(top.percent)}" style="width:${Math.min(100, top.percent)}%"></i></span><span style="opacity:.7">${esc(top.percent >= 100 ? fmtReset(top.resetsAt) : usage.plan ? usage.plan : "")}</span></div>`;
    if (usageOpen) html += `<div class="all">${usage.windows.map((w) => `<div class="l"><span>${esc(w.label)}</span><span class="bar"><i class="${tone(w.percent)}" style="width:${Math.min(100, w.percent)}%"></i></span><span>${w.percent}%</span><span class="r">${esc(fmtReset(w.resetsAt))}</span></div>`).join("")}</div>`;
    el.innerHTML = html;
    el.title = "Your Friday usage (shared with the web and mobile apps). Click for details.";
  }
  $("usage").onclick = () => { usageOpen = !usageOpen; renderUsage(); if (usageOpen) vscode.postMessage({ t: "refreshUsage" }); };
  setInterval(renderUsage, 60000);

  function noticeCard(key, html, onClose) {
    let c = document.querySelector(`[data-notice="${key}"]`);
    if (c) c.remove();
    c = el("div", "notice-card", html); c.dataset.notice = key;
    const x = el("button", "x", "×"); x.title = "Dismiss"; x.onclick = () => { c.remove(); onClose && onClose(); };
    c.appendChild(x); $("notices").appendChild(c); return c;
  }
  function showWhatsNew(updates) {
    for (const u of updates.slice(0, 3)) {
      const card = noticeCard("wn-" + u.id, `<div class="t">${esc(u.title)}</div><div class="b">${esc(u.body || "")}</div>${u.cta_url && /^https:\/\//.test(u.cta_url) ? `<button class="mini pri go" style="border:0;border-radius:4px;padding:2px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)">${esc(u.cta_label || "Learn more")}</button>` : ""}`, () => vscode.postMessage({ t: "updatesSeen", ids: [u.id] }));
      const go = card.querySelector(".go"); if (go) go.onclick = () => { vscode.postMessage({ t: "openUrl", url: u.cta_url }); vscode.postMessage({ t: "updatesSeen", ids: [u.id], clickedId: u.id }); card.remove(); };
    }
  }
  function showAgentUpdate(v) {
    const card = noticeCard("agent", `<div class="t">FridayX ${esc(v || "")} is ready</div><div class="b">A new version was downloaded. Restart to use it; your chats stay in history.</div><button class="go" style="border:0;border-radius:4px;padding:2px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)">Restart FridayX</button>`);
    card.querySelector(".go").onclick = () => { card.remove(); vscode.postMessage({ t: "restart" }); };
  }


  // ---------- action / option popup ("/" button, mode, model) ----------
  const pop = $("pop"); let popItems = [], popSel = 0, popFilter = false;
  function closePop() { pop.hidden = true; popItems = []; }
  function showPop(items, opts) {
    popItems = items; popSel = 0; popFilter = !!(opts && opts.filter); pop.hidden = false; renderPop("");
    const f = pop.querySelector("input"); if (f) f.focus();
  }
  function renderPop(q) {
    const ql = q.toLowerCase();
    const shown = popItems.filter((i) => i.group || !ql || (i.label + " " + (i.detail || "")).toLowerCase().includes(ql));
    // hide a group header when none of its items survived the filter
    const rows = shown.filter((it, idx) => !it.group || (shown[idx + 1] && !shown[idx + 1].group));
    pop.innerHTML = (popFilter ? `<input placeholder="Filter actions…" value="${esc(q)}">` : "") + rows.map((it, n) => it.group ? `<div class="grp">${esc(it.group)}</div>` : `<div class="it" data-n="${popItems.indexOf(it)}"><span class="ck">${it.check ? "✓" : ""}</span><span class="l">${esc(it.label)}</span><span class="r">${esc(it.detail || "")}</span></div>`).join("");
    const f = pop.querySelector("input"); if (f) { f.oninput = () => { const pos = f.selectionStart; renderPop(f.value); const g = pop.querySelector("input"); g.focus(); g.setSelectionRange(pos, pos); }; f.onkeydown = (e) => { if (e.key === "Escape") closePop(); if (e.key === "Enter") { const first = pop.querySelector(".it"); if (first) first.click(); } }; }
    pop.querySelectorAll(".it").forEach((n) => (n.onclick = () => { const it = popItems[+n.dataset.n]; closePop(); it.run && it.run(); }));
  }
  document.addEventListener("mousedown", (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".chipbtn, #btnSlash")) closePop(); });
  function openActions() {
    const cmds = (state.commands || []).map((c) => ({ label: "/" + c.name, detail: c.description, run: () => { input.value = "/" + c.name + " "; input.focus(); autoGrow(); } }));
    showPop([
      { group: "Context" },
      { label: "Attach file…", run: () => vscode.postMessage({ t: "pickFiles" }) },
      { label: "Mention file from this project…", run: () => { input.value += (input.value && !input.value.endsWith(" ") ? " " : "") + "@"; input.focus(); autoGrow(); vscode.postMessage({ t: "searchFiles", query: "" }); } },
      { label: "New chat", run: () => $("btnNew").click() },
      { label: "Past chats", run: () => $("btnHistory").click() },
      { label: "Rewind…", detail: "go back to before a message", run: () => vscode.postMessage({ t: "rewindPoints" }) },
      { group: "Model" },
      { label: "Switch model…", detail: (state.models.find((m) => m.id === state.currentModel) || {}).name, run: () => openModels() },
      { label: "Mode…", detail: { ask: "Ask first", plan: "Plan", auto: "Auto-approve" }[state.mode || "ask"], run: () => openModes() },
      { group: "Customize" },
      { label: "Plugins…", detail: "marketplace and repositories", run: () => openManage("plugins") },
      { label: "MCP servers…", run: () => openManage("mcp") },
      { label: "Skills…", run: () => openManage("skills") },
      { label: "Settings…", detail: "config, instructions, account", run: () => openManage("settings") },
      ...(cmds.length ? [{ group: "Commands" }, ...cmds] : []),
    ], { filter: true });
  }
  function openModels() { showPop([{ group: "Model" }, ...state.models.map((m) => ({ label: m.name, check: m.id === state.currentModel, run: () => vscode.postMessage({ t: "setModel", modelId: m.id }) }))]); }
  function openModes() {
    const cur = state.mode || "ask";
    showPop([{ group: "Mode" },
      { label: "Ask first", detail: "asks before editing or running", check: cur === "ask", run: () => vscode.postMessage({ t: "setMode", mode: "ask" }) },
      { label: "Plan", detail: "researches and proposes a plan, no edits", check: cur === "plan", run: () => vscode.postMessage({ t: "setMode", mode: "plan" }) },
      { label: "Auto-approve", detail: "edits and runs without asking", check: cur === "auto", run: () => vscode.postMessage({ t: "setMode", mode: "auto" }) }]);
  }
  $("modeBtn").onclick = () => (pop.hidden ? openModes() : closePop());
  $("modelBtn").onclick = () => (pop.hidden ? openModels() : closePop());

  function ago(iso) {
    if (!iso) return "";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(s)) return "";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  // ---------- host messages ----------
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    switch (m.t) {
      case "clear": clearThread(); break;
      case "state": state = m; renderState(); break;
      case "context": context = m; renderChips(); break;
      case "user": addUser(m.text, m.chips); break;
      case "update": onUpdate(m.update, m.replay); break;
      case "retry": paintWorking(`The model is busy, retrying (${m.attempt}/${m.max})…`); break;
      case "title": $("title").textContent = m.title; break;
      case "rewindPoints": showPop(m.points.length ? [{ group: "Rewind to before…" }, ...m.points.slice().reverse().map((p) => ({ label: p.preview.slice(0, 70) || "(message)", detail: p.files ? "files changed" : "chat only", run: () => vscode.postMessage({ t: "rewind", index: p.index }) }))] : [{ group: "Nothing to rewind yet" }]); break;
      case "prefill": input.value = m.text || ""; input.focus(); autoGrow(); break;
      case "usage": usage = m; renderUsage(); break;
      case "whatsNew": showWhatsNew(m.updates); break;
      case "agentUpdate": showAgentUpdate(m.version); break;
      case "manage": mg.data = m; renderManage(); break;
      case "manageResult": mg.msg = m.message; break;
      case "turnEnd": currentAgent = null; endThought(); for (const r of tools.values()) if (r.sub && !r.subDone) { r.subDone = true; renderTool(r); } break;
      case "notice": { const n = el("div", "notice", esc(m.text)); add(n); break; }
      case "permission": showPermission(m); break;
      case "permissionDone": donePermission(m); break;
      case "attach": if (!attachments.some((a) => a.path === m.attachment.path && a.startLine === m.attachment.startLine)) attachments.push({ ...m.attachment, rel: m.rel }); renderChips(); input.focus(); break;
      case "picked": for (const f of m.files) if (!attachments.some((a) => a.path === f.path)) attachments.push(f); renderChips(); break;
      case "fileResults": if (/@[^\s@]*$/.test(input.value)) openMenu("file", m.files.map((f) => ({ ...f, label: f.rel.split("/").pop(), detail: f.rel }))); break;
      case "sessions": {
        const h = $("history"); h.innerHTML = "<h4>Past chats</h4>";
        if (!m.sessions.length) h.appendChild(el("p", "", "No past chats in this project yet."));
        for (const s of m.sessions) {
          const b = el("button", "session", `<span class="t">${esc(s.title)}</span><span class="when">${esc(ago(s.updatedAt))}</span>`);
          b.onclick = () => { closeHistory(); vscode.postMessage({ t: "loadSession", id: s.id }); };
          h.appendChild(b);
        }
        break;
      }
    }
  });

  empty();
  autoGrow();
  vscode.postMessage({ t: "ready" });
})();
