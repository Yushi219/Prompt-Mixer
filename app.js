/**
 * Prompt Mixer v3 — static (no build, no backend)
 * - Real-time outputs + real-time summary
 * - "Save" snapshots to history (no Convert)
 * - Draggable split bar (persisted)
 * - Per-category All/Clear
 * - Output actions: Copy / Clear / Undo (custom undo stack)
 *
 * v3.2 behavior fix:
 * - Right textarea is the source of truth.
 * - If user edits an option token (not exactly equal to the option string), the left checkbox auto-unchecks
 *   and that edited token becomes "custom" (unlinked).
 * - Undo/Clear updates left selections.
 * - Left toggles only add/remove exact option strings; never duplicates.
 */

const STORAGE_KEY_STATE = "pm_state_v3";
const STORAGE_KEY_OUTPUTS = "pm_outputs_v3";
const STORAGE_KEY_THEME = "pm_theme_v1";
const STORAGE_KEY_SPLIT = "pm_split_v1";

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function historyKey() { return `pm_history_${todayKey()}`; }
function nowTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
function safeJsonParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

async function loadDefaults() {
  const res = await fetch("./defaults.json");
  if (!res.ok) throw new Error("Failed to load defaults.json");
  return res.json();
}

function saveState(state) { localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(state)); }
function loadState() { return safeJsonParse(localStorage.getItem(STORAGE_KEY_STATE) || "null", null); }
function saveOutputs(map) { localStorage.setItem(STORAGE_KEY_OUTPUTS, JSON.stringify(map || {})); }
function loadOutputs() { return safeJsonParse(localStorage.getItem(STORAGE_KEY_OUTPUTS) || "{}", {}); }

// History per day
function clearOldHistory() {
  const prefix = "pm_history_";
  const tk = todayKey();
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  keys.forEach((k) => { if (k && k.startsWith(prefix) && !k.endsWith(tk)) localStorage.removeItem(k); });
}
function getHistory() { return safeJsonParse(localStorage.getItem(historyKey()) || "[]", []); }
function setHistory(list) { localStorage.setItem(historyKey(), JSON.stringify(list || [])); }

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function copyToClipboard(text) {
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy"); ta.remove();
  });
}

// Theme
function getTheme() {
  const t = localStorage.getItem(STORAGE_KEY_THEME);
  return (t === "light" || t === "dark") ? t : "dark";
}
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEY_THEME, theme);
  const btn = document.getElementById("btnTheme");
  if (btn) btn.textContent = theme === "dark" ? "Light" : "Dark";
}
function toggleTheme() { setTheme(getTheme() === "dark" ? "light" : "dark"); }

// Split
function setSplitBasis(pct) {
  const n = Math.min(80, Math.max(20, pct));
  localStorage.setItem(STORAGE_KEY_SPLIT, String(n));
  document.getElementById("split")?.style.setProperty("--leftBasis", `${n}%`);
}

let state = null;
// outputsByCatId: { [catId]: { text, dirty, undo:[], lastValue } }
let outputsByCatId = loadOutputs();

const elSplit = document.getElementById("split");
const elDragbar = document.getElementById("dragbar");
const elCategories = document.getElementById("categories");
const elOutputs = document.getElementById("outputs");
const elSummary = document.getElementById("summary");

const btnAddCategory = document.getElementById("btnAddCategory");
const btnResetDefaults = document.getElementById("btnResetDefaults");
const btnHistory = document.getElementById("btnHistory");
const btnTheme = document.getElementById("btnTheme");
const btnCopySummary = document.getElementById("btnCopySummary");
const btnSave = document.getElementById("btnSave");

// Bulk modal
const modalOverlay = document.getElementById("modalOverlay");
const modalCategoryName = document.getElementById("modalCategoryName");
const modalLines = document.getElementById("modalLines");
const modalClose = document.getElementById("modalClose");
const modalCancel = document.getElementById("modalCancel");
const modalSave = document.getElementById("modalSave");
const modalDeleteCategory = document.getElementById("modalDeleteCategory");
let modalCatId = null;

// History modal
const historyOverlay = document.getElementById("historyOverlay");
const historyClose = document.getElementById("historyClose");
const historyOk = document.getElementById("historyOk");
const historyList = document.getElementById("historyList");
const historyDateHint = document.getElementById("historyDateHint");
const btnDownloadHistory = document.getElementById("btnDownloadHistory");
const btnClearHistory = document.getElementById("btnClearHistory");

// ---------- Core helpers (NEW) ----------

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * IMPORTANT:
 * Options themselves often contain commas (e.g. "massing, proportions, ...").
 * So we MUST NOT split the output text by comma.
 * Instead, treat each option as an exact token and detect it with a boundary-aware regex:
 *   (^|,\s*) <OPTION> (?=\s*(,|$))
 */
function tokenRegex(opt) {
  const e = escapeRegExp(opt);
  return new RegExp(`(?:^|,\\s*)${e}(?=\\s*(?:,|$))`);
}
function hasOptionToken(text, opt) {
  const t = (text || "").trim();
  if (!t || !opt) return false;
  return tokenRegex(opt).test(t);
}

function addOptionToken(text, opt) {
  const t = (text || "").trim();
  if (!opt) return t;
  if (hasOptionToken(t, opt)) return t;
  if (!t) return opt;
  // ensure no trailing comma before appending
  const base = t.replace(/,\s*$/, "").trim();
  return base ? `${base}, ${opt}` : opt;
}

function removeOptionToken(text, opt) {
  let t = (text || "").trim();
  if (!t || !opt) return t;

  const e = escapeRegExp(opt);

  // 1) remove at start (and eat following separator if present)
  t = t.replace(new RegExp(`^${e}\\s*(?:,\\s*)?`), "");

  // 2) remove elsewhere (eat the leading separator)
  t = t.replace(new RegExp(`(?:,\\s*)${e}`, "g"), "");

  // tidy: strip leading/trailing separators + collapse accidental doubles
  t = t.replace(/^\s*,\s*/, "").replace(/\s*,\s*$/, "");
  t = t.replace(/,\s*,+/g, ", ");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

// Ensure output entry exists (init only)
function ensureOutputEntry(cat) {
  const existing = outputsByCatId[cat.id];
  if (existing) return;
  outputsByCatId[cat.id] = { text: "", dirty: false, undo: [], lastValue: "" };
}

function pushUndo(catId, prevText) {
  const out = outputsByCatId[catId];
  if (!out) return;
  out.undo = out.undo || [];
  out.undo.push(prevText ?? "");
  if (out.undo.length > 120) out.undo.shift();
}

// Right-textarea -> Left-selection reconciliation
function reconcileSelectionFromText(cat, text) {
  const t = (text || "").trim();
  const sel = [];
  (cat.options || []).forEach((opt, i) => {
    if (opt && hasOptionToken(t, opt)) sel.push(i);
  });
  cat.selected = sel;
}


// Build summary from current per-cat outputs
function buildSummary() {
  const blocks = [];
  for (const cat of state.categories) {
    ensureOutputEntry(cat);
    const text = (outputsByCatId[cat.id]?.text || "").trim();
    if (!text) continue;
    blocks.push(text);
  }
  return blocks.join("\n\n");
}
function updateSummary() { elSummary.value = buildSummary(); }

function persist() { saveState(state); saveOutputs(outputsByCatId); }

function isAllSelected(cat) {
  return (cat.selected || []).length === (cat.options || []).length && (cat.options || []).length > 0;
}

// Apply a left checkbox change onto the right text (exact-option-token only)
function applyLeftToggle(cat, idx, checked) {
  ensureOutputEntry(cat);
  const out = outputsByCatId[cat.id];
  const opt = (cat.options || [])[idx];
  if (!opt) return;

  const prev = out.text || "";
  const next = checked ? addOptionToken(prev, opt) : removeOptionToken(prev, opt);

  if (next !== prev) pushUndo(cat.id, prev);

  out.text = next;
  out.lastValue = next;
  out.dirty = true;

  // right is source of truth => derive left selection from text
  reconcileSelectionFromText(cat, next);
}


// Apply "All/Clear" for a category (affects only exact option tokens; custom tokens untouched)
function applyLeftAllClear(cat, selectAll) {
  ensureOutputEntry(cat);
  const out = outputsByCatId[cat.id];
  const prev = out.text || "";

  let next = prev;
  const opts = (cat.options || []).filter(Boolean);

  if (selectAll) {
    for (const s of opts) next = addOptionToken(next, s);
  } else {
    // clear only exact option tokens; keep any custom edits
    for (const s of opts) next = removeOptionToken(next, s);
  }

  if (next !== prev) pushUndo(cat.id, prev);

  out.text = next;
  out.lastValue = next;
  out.dirty = true;

  reconcileSelectionFromText(cat, next);
}


// ---------- UI render ----------

function renderCategories() {
  elCategories.innerHTML = "";

  state.categories.forEach((cat) => {
    const wrap = document.createElement("div");
    wrap.className = "category";

    const top = document.createElement("div");
    top.className = "categoryTop";

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "categoryName";
    name.textContent = cat.name;

    const sub = document.createElement("div");
    sub.className = "categorySub";
    sub.textContent = `${(cat.selected || []).length} selected`;

    left.appendChild(name);
    left.appendChild(sub);

    const btns = document.createElement("div");
    btns.className = "catBtns";

    const btnAll = document.createElement("button");
    btnAll.className = "iconBtn";
    btnAll.textContent = isAllSelected(cat) ? "Clear" : "All";
    btnAll.title = isAllSelected(cat) ? "Clear all selections" : "Select all options";
    btnAll.onclick = () => toggleAll(cat.id);

    const btnEdit = document.createElement("button");
    btnEdit.className = "iconBtn";
    btnEdit.textContent = "Edit";
    btnEdit.onclick = () => openBulkModal(cat.id);

    const btnDelCat = document.createElement("button");
    btnDelCat.className = "iconBtn iconBtnDanger";
    btnDelCat.textContent = "🗑";
    btnDelCat.title = "Delete category";
    btnDelCat.onclick = () => deleteCategory(cat.id);

    btns.appendChild(btnAll);
    btns.appendChild(btnEdit);
    btns.appendChild(btnDelCat);

    top.appendChild(left);
    top.appendChild(btns);

    const opts = document.createElement("div");
    opts.className = "options";

    cat.options.forEach((optText, idx) => {
      const row = document.createElement("label");
      row.className = "optionRow";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = (cat.selected || []).includes(idx);
      cb.onchange = () => toggleOption(cat.id, idx, cb.checked);

      const text = document.createElement("div");
      text.className = "optionText";
      text.textContent = optText;

      row.appendChild(cb);
      row.appendChild(text);

      opts.appendChild(row);
    });

    wrap.appendChild(top);
    wrap.appendChild(opts);
    elCategories.appendChild(wrap);
  });
}

function renderOutputs() {
  elOutputs.innerHTML = "";

  state.categories.forEach((cat) => {
    ensureOutputEntry(cat);
    const outEntry = outputsByCatId[cat.id];

    const block = document.createElement("div");
    block.className = "outputBlock";

    const top = document.createElement("div");
    top.className = "outputTop";

    const left = document.createElement("div");
    const t = document.createElement("div");
    t.className = "categoryName";
    t.textContent = cat.name;
    left.appendChild(t);

    if ((cat.selected || []).length) {
      const meta = document.createElement("div");
      meta.className = "outputMeta";
      meta.textContent = `${(cat.selected || []).length} selected`;
      left.appendChild(meta);
    }

    const actions = document.createElement("div");
    actions.className = "outputActions";

    const btnUndo = document.createElement("button");
    btnUndo.className = "btn btnGhost";
    btnUndo.textContent = "↶";
    btnUndo.title = "Undo";
    btnUndo.onclick = () => undoOutput(cat.id);

    const btnClear = document.createElement("button");
    btnClear.className = "btn btnGhost";
    btnClear.textContent = "Clear";
    btnClear.title = "Clear this output text (also uncheck left options)";
    btnClear.onclick = () => clearOutput(cat.id);

    const btnCopy = document.createElement("button");
    btnCopy.className = "btn";
    btnCopy.textContent = "Copy";
    btnCopy.disabled = !(outEntry.text || "").trim();
    btnCopy.onclick = () => copyToClipboard(outEntry.text);

    actions.appendChild(btnUndo);
    actions.appendChild(btnClear);
    actions.appendChild(btnCopy);

    top.appendChild(left);
    top.appendChild(actions);

    const ta = document.createElement("textarea");
    ta.className = "textarea";
    ta.rows = 4;
    ta.placeholder = "Select options on the left…";
    ta.value = outEntry.text || "";

    // Right textarea is source-of-truth:
    // - Update output text
    // - Reconcile left selection from exact option tokens in text
    ta.addEventListener("input", () => {
      const v = ta.value;

      outEntry.undo = outEntry.undo || [];
      if (outEntry.lastValue !== v) {
        outEntry.undo.push(outEntry.lastValue ?? "");
        if (outEntry.undo.length > 120) outEntry.undo.shift();
        outEntry.lastValue = v;
      }

      outEntry.text = v;
      outEntry.dirty = true;

      // This is the key: user-edited tokens that no longer match options => left unchecks automatically
      reconcileSelectionFromText(cat, v);

      persist();
      renderCategories();     // reflect auto-unchecks immediately
      updateSummary();
      btnCopy.disabled = !(v || "").trim();
    });

    block.appendChild(top);
    block.appendChild(ta);

    elOutputs.appendChild(block);
  });
}

// ---------- Left interactions ----------

function toggleOption(catId, idx, checked) {
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;

  applyLeftToggle(cat, idx, checked);

  persist();
  renderCategories();
  renderOutputs(); // ok to rerender after checkbox click
  updateSummary();
}

function toggleAll(catId) {
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;
  const total = (cat.options || []).length;
  if (!total) return;

  const selectAll = !isAllSelected(cat);
  applyLeftAllClear(cat, selectAll);

  persist();
  renderCategories();
  renderOutputs();
  updateSummary();
}

function deleteCategory(catId) {
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;
  if (!confirm(`Delete category?\n\n${cat.name}`)) return;

  state.categories = state.categories.filter(c => c.id !== catId);
  delete outputsByCatId[catId];
  persist();
  renderCategories();
  renderOutputs();
  updateSummary();
}

function randomId() { return "cat_" + Math.random().toString(16).slice(2, 10); }
function addCategory() {
  const name = prompt("Category name:", "New Category");
  if (!name) return;
  const id = randomId();
  state.categories.unshift({ id, name: name.trim() || "New Category", options: [], selected: [] });
  outputsByCatId[id] = { text: "", dirty: false, undo: [], lastValue: "" };
  persist();
  renderCategories();
  renderOutputs();
  updateSummary();
}

// ---------- Bulk modal ----------

function openBulkModal(catId) {
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;
  modalCatId = catId;
  modalCategoryName.value = cat.name;
  modalLines.value = (cat.options || []).join("\n");
  modalOverlay.classList.remove("hidden");
  modalCategoryName.focus();
  modalCategoryName.select();
}
function closeBulkModal() { modalOverlay.classList.add("hidden"); modalCatId = null; }

function saveBulkModal() {
  const cat = state.categories.find(c => c.id === modalCatId);
  if (!cat) return;
  cat.name = modalCategoryName.value.trim() || cat.name;
  const lines = modalLines.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  cat.options = lines;

  // After options list changes, any existing right text token that no longer matches options
  // becomes custom automatically; and selection must be reconciled from current right text.
  ensureOutputEntry(cat);
  const out = outputsByCatId[cat.id];
  reconcileSelectionFromText(cat, out.text || "");

  persist();
  renderCategories();
  renderOutputs();
  updateSummary();
  closeBulkModal();
}

function deleteFromModal() { const id = modalCatId; closeBulkModal(); deleteCategory(id); }

// ---------- Output actions ----------

function clearOutput(catId) {
  const cat = state.categories.find(c => c.id === catId);
  const out = outputsByCatId[catId];
  if (!cat || !out) return;

  pushUndo(catId, out.text || "");

  out.text = "";
  out.lastValue = "";
  out.dirty = true;

  // Clear means: also uncheck all (since right is source)
  reconcileSelectionFromText(cat, "");

  persist();
  renderCategories();
  renderOutputs();
  updateSummary();
}

function undoOutput(catId) {
  const cat = state.categories.find(c => c.id === catId);
  const out = outputsByCatId[catId];
  if (!cat || !out) return;

  out.undo = out.undo || [];
  if (!out.undo.length) return;

  const prev = out.undo.pop();
  out.text = prev ?? "";
  out.lastValue = out.text;
  out.dirty = true;

  // Undo must update left selections
  reconcileSelectionFromText(cat, out.text);

  persist();
  renderCategories();
  renderOutputs();
  updateSummary();
}

// ---------- Save snapshot ----------

function saveSnapshot() {
  const summary = (elSummary.value || "").trim();
  if (!summary) return alert("Nothing to save yet. Select some options first.");

  const item = { id: "h_" + Math.random().toString(16).slice(2, 10), time: nowTime(), text: summary };
  const hist = getHistory();
  hist.unshift(item);
  setHistory(hist);

  btnSave.textContent = "Saved ✓";
  setTimeout(() => (btnSave.textContent = "Save"), 900);
}

// ---------- History modal ----------

function openHistory() {
  historyDateHint.textContent = `Local date: ${todayKey()} • items: ${getHistory().length}`;
  renderHistoryList();
  historyOverlay.classList.remove("hidden");
}
function closeHistory() { historyOverlay.classList.add("hidden"); }

function renderHistoryList() {
  const hist = getHistory();
  historyList.innerHTML = "";
  if (!hist.length) {
    const empty = document.createElement("div");
    empty.className = "tinyHint";
    empty.textContent = "No history yet. Click Save to store today’s snapshots.";
    historyList.appendChild(empty);
    return;
  }

  hist.forEach((h) => {
    const item = document.createElement("div");
    item.className = "historyItem";

    const top = document.createElement("div");
    top.className = "historyItemTop";

    const left = document.createElement("div");
    const time = document.createElement("div");
    time.className = "historyTime";
    time.textContent = h.time;
    left.appendChild(time);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "10px";
    right.style.alignItems = "center";
    right.style.flexWrap = "wrap";
    right.style.justifyContent = "flex-end";

    const bCopy = document.createElement("button");
    bCopy.className = "btn";
    bCopy.textContent = "Copy";
    bCopy.onclick = () => copyToClipboard(h.text);

    const bDel = document.createElement("button");
    bDel.className = "btn btnGhost";
    bDel.textContent = "Delete";
    bDel.onclick = () => {
      if (!confirm("Delete this history item?")) return;
      setHistory(getHistory().filter(x => x.id !== h.id));
      renderHistoryList();
      historyDateHint.textContent = `Local date: ${todayKey()} • items: ${getHistory().length}`;
    };

    right.appendChild(bCopy);
    right.appendChild(bDel);

    top.appendChild(left);
    top.appendChild(right);

    const preview = document.createElement("div");
    preview.className = "historyPreview";
    preview.textContent = h.text.length > 1200 ? (h.text.slice(0, 1200) + "…") : h.text;

    item.appendChild(top);
    item.appendChild(preview);
    historyList.appendChild(item);
  });
}

function downloadHistoryTxt() {
  const hist = getHistory();
  if (!hist.length) return alert("No history to download today.");
  const lines = [];
  lines.push(`${todayKey()} — Prompt Mixer history`);
  lines.push("");
  hist.slice().reverse().forEach((h) => {
    lines.push(`--- ${h.time} ---`);
    lines.push(h.text);
    lines.push("");
  });
  downloadText(`prompt_mixer_history_${todayKey()}.txt`, lines.join("\n"));
}

function clearHistory() {
  if (!confirm("Clear today’s history?")) return;
  setHistory([]);
  renderHistoryList();
  historyDateHint.textContent = `Local date: ${todayKey()} • items: 0`;
}

// ---------- Reset defaults ----------

async function resetDefaults() {
  if (!confirm("Reset categories & options to defaults?\n(History is not deleted.)")) return;
  const defaults = await loadDefaults();
  state = {
    version: defaults.version || 1,
    categories: defaults.categories.map(c => ({ id: c.id, name: c.name, options: c.options.slice(), selected: [] }))
  };
  outputsByCatId = {};
  persist();
  renderCategories();
  renderOutputs();
  updateSummary();
}

// ---------- Dragbar logic ----------

function setupDragbar() {
  if (!elDragbar || !elSplit) return;
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    const rect = elSplit.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = (x / rect.width) * 100;
    setSplitBasis(pct);
  };

  const onUp = () => {
    dragging = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  elDragbar.addEventListener("mousedown", (e) => {
    dragging = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    e.preventDefault();
  });

  // touch support
  elDragbar.addEventListener("touchstart", (e) => {
    dragging = true;
    const onTouchMove = (ev) => onMove({ clientX: ev.touches[0].clientX });
    const onTouchEnd = () => {
      dragging = false;
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
    e.preventDefault();
  }, { passive: false });
}

// ---------- Init ----------

async function init() {
  setTheme(getTheme());

  const saved = Number(localStorage.getItem(STORAGE_KEY_SPLIT));
  setSplitBasis(Number.isFinite(saved) ? saved : 40);

  clearOldHistory();

  const stored = loadState();
  if (stored && stored.categories) state = stored;
  else {
    const defaults = await loadDefaults();
    state = {
      version: defaults.version || 1,
      categories: defaults.categories.map(c => ({ id: c.id, name: c.name, options: c.options.slice(), selected: [] }))
    };
    saveState(state);
  }

  // normalize state
  state.categories.forEach(c => {
    c.options = c.options || [];
    c.selected = c.selected || [];
  });

  // If there is existing output text in storage, reconcile left selections from it (source-of-truth)
  for (const cat of state.categories) {
    ensureOutputEntry(cat);
    const out = outputsByCatId[cat.id];
    if (out && typeof out.text === "string" && out.text.length) {
      reconcileSelectionFromText(cat, out.text);
    }
  }
  persist();

  renderCategories();
  renderOutputs();
  updateSummary();

  // events
  btnAddCategory.onclick = addCategory;
  btnResetDefaults.onclick = () => resetDefaults().catch(e => alert(e.message));
  btnHistory.onclick = openHistory;
  btnTheme.onclick = toggleTheme;

  btnCopySummary.onclick = () => copyToClipboard(elSummary.value || "");
  btnSave.onclick = saveSnapshot;

  // modals
  modalClose.onclick = closeBulkModal;
  modalCancel.onclick = closeBulkModal;
  modalSave.onclick = saveBulkModal;
  modalDeleteCategory.onclick = deleteFromModal;
  modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeBulkModal(); });

  historyClose.onclick = closeHistory;
  historyOk.onclick = closeHistory;
  historyOverlay.addEventListener("click", (e) => { if (e.target === historyOverlay) closeHistory(); });
  btnDownloadHistory.onclick = downloadHistoryTxt;
  btnClearHistory.onclick = clearHistory;

  setupDragbar();
}

window.addEventListener("DOMContentLoaded", () => init().catch((e) => {
  console.error(e);
  alert("Failed to start app: " + (e.message || e));
}));
