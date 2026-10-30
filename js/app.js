/* ==========================================================================
 * m4ster-sprite-gen — free, open-source, unlimited 2D sprite generator.
 * Runs 100% client-side. The only network call is the AI image source
 * (Pollinations, no auth). Everything after generation is deterministic:
 * same input pixels -> same output pixels, every time.
 *
 * Pipeline: prompt -> row gen -> alpha cleanup -> frame extract -> atlas pack
 * ========================================================================== */

"use strict";

const $ = (s) => document.querySelector(s);

/* ---------------- utils ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fail(msg) { throw new Error(msg); }

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/* weighted euclidean color distance */
function colorDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
}

/* ---------------- global state ---------------- */

const state = {
  category: "character",
  source: "ai",            // ai | procedural
  aiModel: "auto", // provider id from the model switcher (AI_PROVIDERS)
  aiStyle: "still",        // character AI: "still" (one drawing, animated in-house) | "strip"
  charStash: null,         // user's character-panel picks (states/frames/style…), kept across re-renders
  key: { r: 255, g: 0, b: 255 },
  rows: [],                // [{ name, frames:[canvas], order:[idx], fps, loop }]
  originals: [],           // untouched extracted frames, parallel to rows
  revision: null,          // run-revision stamp; curation (order) is tied to it
  atlas: null,             // { canvas, manifest, pngName, jsonName }
  busy: false,
  strict: false,           // retry mode: appends the strict isolation clause to prompts
  slicer: null,            // v6.6 dedicated slicer: { sheet, imgW, imgH, rows, cols, mode, bg, knockout, margin, pad, ox, oy, pieces:[{canvas,empty,rect}], selection:[], fps, playback }
  pixelart: null,          // v6.5 image→pixel-art: { src:{data,w,h}, imgW, imgH, w, h, colors, dither, scale, out }
};

/* non-destructive curation sidecar: order lives here, never in the frames */
function curation() {
  return { revision: state.revision, order: Object.fromEntries(state.rows.map(r => [r.name, r.order])) };
}

/* ---------------- stepper ---------------- */

const STEPS = ["prompt", "row", "alpha", "extract", "atlas", "done"];

function setStep(name, status, msg) {
  const li = document.querySelector(`#stepper li[data-step="${name}"]`);
  if (!li) return;
  li.classList.remove("active", "done", "error", "warn");
  if (status) li.classList.add(status);
  if (msg) stageMsg(msg, status === "error" ? "err" : status === "warn" ? "warn" : undefined);
}

function resetSteps() {
  document.querySelectorAll("#stepper li").forEach(li => li.classList.remove("active", "done", "error", "warn"));
}

function stageMsg(msg, kind) {
  const el = $("#stageMsg");
  el.textContent = msg;
  el.classList.toggle("err", kind === true || kind === "err");
  el.classList.toggle("warn", kind === "warn");
}

function showStage(canvas, msg) {
  const st = $("#stage");
  st.width = canvas.width; st.height = canvas.height;
  st.getContext("2d").drawImage(canvas, 0, 0);
  if (msg) stageMsg(msg);
}

/* drop the stage canvas so a fresh failure never sits under stale pixels
 * from a previous run (confusing: old strip + new error on top of it) */
function clearStage() {
  const st = $("#stage");
  st.width = 2; st.height = 2;
  st.getContext("2d").clearRect(0, 0, 2, 2);
  stageMsg("");
}

/* ---------------- per-category params UI ---------------- */

const CATEGORY_DEFAULTS = {
  character: { states: ["idle", "walk"], frames: 4, style: "clean 2d", view: "side", archetype: "biped", palette: "classic" },
  tile:      { size: 128, pattern: "grass" },
  ui:        { kind: "button", states: 3 },
  effect:    { type: "explosion", frames: 8 },
  pixelart:  { w: 64, h: 64, colors: 16 },
  slicer:    { rows: 3, cols: 9, mode: "grid", bg: "black", knockout: true, margin: 0, pad: 0, ox: 0, oy: 0, fps: 8, playback: "loop" },
};

const STATE_FPS = { idle: 6, walk: 8, run: 10, jump: 8, attack: 10 };

function renderParams() {
  const cat = state.category;
  const box = $("#params");
  /* the user's own picks survive re-renders (tab hops, gallery opens) —
   * defaults only fill a panel the user hasn't touched yet */
  const d = (cat === "character" && state.charStash)
    ? { ...CATEGORY_DEFAULTS[cat], ...state.charStash }
    : CATEGORY_DEFAULTS[cat];

  if (cat === "character") {
    box.innerHTML = `
      <div class="field-label">Animation states <span class="dim" id="stateCostNote">(one AI call per state)</span></div>
      <div class="states-grid" id="stateRow">
        ${["idle", "walk", "run", "jump", "attack", "death"].map(s =>
          `<label class="chk"><input type="checkbox" data-state="${s}" ${d.states.includes(s) ? "checked" : ""}>${s}</label>`).join("")}
      </div>
      <div class="pgrid">
        <div class="pfield"><label for="pFrames">Frames / state</label><input type="number" id="pFrames" min="2" max="12" value="${d.frames}"></div>
        <div class="pfield"><label for="pStyle">Style</label><select id="pStyle">${styleOptionsHtml()}</select></div>
        <div class="pfield"><label for="pView">View</label><select id="pView"><option value="side">side</option><option value="front">front</option><option value="3/4 top-down">top 3/4</option><option value="top-down">top-down 90°</option></select></div>
        <div class="pfield"><label>Facing</label><div class="seg" id="pFlipSeg" style="grid-template-columns:repeat(2,minmax(0,1fr))"><button type="button" class="seg-btn${state.flipX ? "" : " active"}" data-flip="0" title="face right">&#8594; right</button><button type="button" class="seg-btn${state.flipX ? " active" : ""}" data-flip="1" title="face left">&#8592; left</button></div></div>
        <div class="pfield"><label for="pArch">Archetype</label><select id="pArch">
          ${[["biped", "biped"], ["quadruped", "quadruped"], ["flyer", "flyer / bird"], ["slime", "slime"], ["robot", "robot"], ["ghost", "ghost"]]
            .map(([v, lbl]) => `<option value="${v}" ${v === d.archetype ? "selected" : ""}>${lbl}</option>`).join("")}
        </select></div>
        <div class="pfield"><label for="pPal">Palette</label><div class="pal-row"><select id="pPal">
          ${["classic", "ember", "frost", "toxic", "royal", "shadow"].map(pl => `<option ${pl === d.palette ? "selected" : ""}>${pl}</option>`).join("")}
        </select><button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button></div></div>
      </div>`;
  } else if (cat === "tile") {
    box.innerHTML = `
      <div class="pgrid">
        <div class="pfield"><label for="pSize">Tile size</label><select id="pSize">
          ${[32, 64, 128, 256].map(s => `<option value="${s}" ${s === d.size ? "selected" : ""}>${s}px</option>`).join("")}
        </select></div>
        <div class="pfield"><label for="pPattern">Procedural pattern</label><div class="pal-row"><select id="pPattern">
          ${TILE_PATTERNS.map(pat => `<option ${pat === d.pattern ? "selected" : ""}>${pat}</option>`).join("")}
        </select><button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button></div></div>
      </div><div class="dim" style="margin-top:8px">Tiles export edge-to-edge (no keying) and preview in a 3&times;3 wrap.</div>`;
  } else if (cat === "ui") {
    box.innerHTML = `
      <div class="pgrid">
        <div class="pfield"><label for="pKind">UI element</label><select id="pKind">
          ${[["button", "button"], ["icon", "icon"], ["panel", "panel"], ["coin", "coin"], ["gem", "gem"], ["heart", "heart"], ["star", "star"], ["health", "health bar"]]
            .map(([v, lbl]) => `<option value="${v}" ${v === d.kind ? "selected" : ""}>${lbl}</option>`).join("")}
        </select></div>
        <div class="pfield"><label for="pStates">Variants</label><div class="pal-row"><input type="number" id="pStates" min="1" max="4" value="${d.states}"><button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button></div></div>
      </div><div class="dim" style="margin-top:8px">Variants = normal / hover / pressed style states, extracted left to right.</div>`;
  } else if (cat === "pixelart") {
    const px = pxState();
    box.innerHTML = `
      <div class="field-label">Image &rarr; pixel art <span class="dim">(100% offline)</span></div><div class="row"><button type="button" class="btn-ghost" id="pxPick" style="text-align:center">Upload image</button><input type="file" id="pxFile" accept="image/*" hidden></div><div class="field-label">Output size</div><div class="px-dims" id="pxDims">
        ${[16, 32, 48, 64, 96, 128].map(s => `<button type="button" class="seg-btn${s === px.w ? " active" : ""}" data-px="${s}">${s}</button>`).join("")}
        <button type="button" class="seg-btn" id="pxOrigBtn" title="use the uploaded image's original dimensions">Original</button>
      </div><div class="row" style="margin-top:8px"><span class="dim">W</span><input type="number" class="num" id="pxW" min="8" max="1024" value="${px.w}"><span class="dim">H</span><input type="number" class="num" id="pxH" min="8" max="1024" value="${px.h}"></div><div class="field-label">Tile grid <span class="dim">(tilemap overlay)</span></div><div class="row"><label class="chk"><input type="checkbox" id="pxGrid"${px.grid ? " checked" : ""}> show grid</label><select id="pxTile" aria-label="tile size">${[8, 16, 24, 32, 48, 64].map(t => `<option value="${t}"${t === px.tile ? " selected" : ""}>${t}px tiles</option>`).join("")}</select><span class="dim" id="pxTileCount"></span></div><div class="field-label">Colors</div><div class="row"><select id="pxColors" class="grow">
          ${[[2, "2 colors"], [4, "4 colors"], [8, "8 colors"], [16, "16 colors"], [32, "32 colors"], [256, "256 colors"], [0, "Full color"]].map(([v, lbl]) => `<option value="${v}"${v === px.colors ? " selected" : ""}>${lbl}</option>`).join("")}
        </select></div><label class="chk"><input type="checkbox" id="pxDither"${px.dither ? " checked" : ""}> dithering <span class="dim">(Floyd&ndash;Steinberg)</span></label><div class="row" style="margin-top:8px"><span class="dim">preview</span><input type="range" id="pxScale" min="2" max="16" value="${px.scale}" class="grow" aria-label="preview scale"><span class="dim" id="pxScaleVal">&times;${px.scale}</span></div><button type="button" class="btn-ghost px-download" id="pxDownload">Download pixel art</button><div class="dim">Upload any image — it never leaves your browser.</div>`;
    wirePixelArt();
  } else if (cat === "slicer") {
    const sl = slState();
    box.innerHTML = `
      <div class="field-label">Sprite slicer <span class="dim">(100% offline)</span></div><div class="row"><button type="button" class="btn-ghost" id="slPick" style="text-align:center">Upload sheet</button><input type="file" id="slFile" accept="image/*" hidden></div><div class="field-label">Mode</div><div class="seg" id="slModeSeg"><button type="button" class="seg-btn${sl.mode === "grid" ? " active" : ""}" data-mode="grid">Grid</button><button type="button" class="seg-btn${sl.mode === "auto" ? " active" : ""}" data-mode="auto">Auto-detect</button></div><div id="slGridRow"${sl.mode === "grid" ? "" : " hidden"}><div class="sl-row"><span class="dim">rows</span><input type="range" id="slRows" min="1" max="32" value="${sl.rows}" aria-label="grid rows"><span class="sl-val" id="slRowsVal">${sl.rows}</span></div><div class="sl-row"><span class="dim">cols</span><input type="range" id="slCols" min="1" max="32" value="${sl.cols}" aria-label="grid columns"><span class="sl-val" id="slColsVal">${sl.cols}</span></div><div class="sl-grid4"><label>margin<input type="number" class="num" id="slMargin" min="0" max="200" value="${sl.margin}"></label><label>padding<input type="number" class="num" id="slPad" min="0" max="200" value="${sl.pad}"></label><label>offset x<input type="number" class="num" id="slOx" min="0" max="500" value="${sl.ox}"></label><label>offset y<input type="number" class="num" id="slOy" min="0" max="500" value="${sl.oy}"></label></div></div><div class="sl-readout" id="slReadout">upload a sheet to start</div><div class="field-label">Background <span class="dim">(treated as empty)</span></div><div class="seg cols4" id="slBgSeg">
        ${[["transparent", "Alpha"], ["black", "Black"], ["white", "White"], ["chroma", "Key"]].map(([v, lbl]) => `<button type="button" class="seg-btn${v === sl.bg ? " active" : ""}" data-bg="${v}">${lbl}</button>`).join("")}
      </div><label class="knock-row"><input type="checkbox" id="slKnockout"${sl.knockout ? " checked" : ""}> Knockout bg &rarr; transparent</label><div class="sl-pick-row"><button type="button" class="btn-ghost" id="slSelectAll">Select all</button><button type="button" class="btn-ghost" id="slClear">Clear</button><button type="button" class="btn-ghost" id="slReslice">Re-slice</button></div><div class="sl-hint">Click pieces in order &mdash; 1st = frame 1. Empty cells flagged.</div><div class="field-label">Playback</div><div class="row"><span class="dim">fps</span><select id="slFps">${[6, 8, 12, 24].map(f => `<option value="${f}"${f === sl.fps ? " selected" : ""}>${f} fps</option>`).join("")}</select></div><div class="seg" id="slPlaybackSeg" style="margin-top:8px">
        ${[["loop", "Loop"], ["once", "Once"], ["pingpong", "Ping-pong"]].map(([v, lbl]) => `<button type="button" class="seg-btn${v === sl.playback ? " active" : ""}" data-playback="${v}">${lbl}</button>`).join("")}
      </div><button type="button" class="btn-ghost sl-download" id="slDownload" disabled>Download animation <span class="dim">PNG + JSON</span></button><button type="button" class="btn-ghost sl-download" id="slCells" disabled>Download cells <span class="dim">individual PNGs</span></button><div class="dim">100% offline.</div>`;
    wireSlicer();
  } else {
    box.innerHTML = `
      <div class="field-label">Effect</div><div class="row"><select id="pType" class="grow">
          ${["explosion", "fire", "smoke", "sparkle", "ring", "slash", "particles", "power-up", "magic", "heal", "portal"]
            .map(t => `<option ${t === d.type ? "selected" : ""}>${t}</option>`).join("")}
        </select><span class="dim">frames</span><input type="number" class="num" id="pFrames" min="4" max="16" value="${d.frames}"><button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button></div>`;
  }

  const prompts = {
    character: "zombie pirate with a rusty hook hand",
    tile: "mossy dungeon floor stones",
    ui: "round fantasy RPG menu button, gold trim",
    effect: "fiery explosion with smoke",
    pixelart: "not used — upload an image instead",
    slicer: "not used — upload a sheet instead",
  };
  $("#prompt").placeholder = "e.g. " + prompts[cat];

  // shuffle button: re-roll the procedural variant with a fresh random seed
  const sh = $("#pShuffle");
  if (sh) sh.onclick = () => runPipeline();
  syncStudio();
}

function readParams() {
  const cat = state.category;
  if (cat === "character") {
    const states = [...document.querySelectorAll("#stateRow input:checked")].map(i => i.dataset.state);
    return {
      states, frames: clampInt($("#pFrames").value, 2, 12, 4),
      style: $("#pStyle").value, view: $("#pView").value,
      archetype: $("#pArch").value, palette: $("#pPal").value,
    };
  }
  if (cat === "tile") return { size: +$("#pSize").value, pattern: $("#pPattern").value };
  if (cat === "ui") return { kind: $("#pKind").value, states: clampInt($("#pStates").value, 1, 4, 3) };
  return { type: $("#pType").value, frames: clampInt($("#pFrames").value, 4, 16, 8) };
}

function clampInt(v, lo, hi, fb) {
  v = parseInt(v, 10);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
}

function describe(fallback) {
  const t = $("#prompt").value.trim() || fallback;
  const b = boostPromptText(state.category, t);
  state.lastBoost = b;
  return b.text;
}

/* ---------------- prompt booster ----------------
 * One-word prompts ("Zombie") make the free model guess — and it guesses
 * badly. Short descriptions get auto-expanded with the style/view/structure/
 * palette guidance a sprite prompt needs. 8+ words are left alone. The exact
 * prompt sent to the AI is shown in the UI (collapsible) so it's never magic. */

const BOOST_BITS = {
  character: ["single character only, no extra figures or limbs", "bold readable silhouette",
    "limited harmonious color palette", "crisp clean edges", "game-ready sprite"],
  effect: ["bold simple shapes, readable at small size", "limited harmonious color palette",
    "smooth color falloff", "no smoke text artifacts"],
  ui: ["crisp vector-clean edges", "subtle depth, no photorealism", "limited harmonious color palette"],
  tile: ["cohesive limited color palette", "no focal object, pure texture", "even detail distribution"],
};

function boostPromptText(cat, raw) {
  const base = (raw || "").trim();
  if (!base) return { text: base, boosted: false };
  const words = base.split(/\s+/).filter(Boolean);
  if (words.length >= 8) return { text: base, boosted: false };
  const bits = BOOST_BITS[cat] || [];
  return { text: base + ", " + bits.join(", "), boosted: true };
}

function showPromptPeek(prompt) {
  /* the boosted prompt used to be dumped into a panel under the prompt
   * box — a wall of debug text nobody asked to read. Boosting still
   * happens; it just stays silent now. Kept as a no-op so callers and
   * state.lastBoost bookkeeping stay exactly as they were. */
}

/* ---------------- prompt builder ----------------
 * The model gets one row-strip per animation state on a flat chroma key,
 * with an explicit slot hint (one pose per invisible vertical slot).
 * Extraction is content-based, so the hint is a nudge, not a contract. */

function keyName() {
  const k = state.key;
  if (k.r === 255 && k.g === 0 && k.b === 255) return "magenta";
  if (k.r === 0 && k.g === 255 && k.b === 0) return "green";
  if (k.r === 0 && k.g === 120 && k.b === 255) return "blue";
  if (k.r === 255 && k.g === 255 && k.b === 255) return "white";
  return "black";
}

function buildPrompt(cat, p, sub, strict) {
  const key = keyName();
  // Flat-key phrasing is load-bearing: the model loves gradients/washes, and
  // anything but a solid single-color background defeats chroma extraction.
  const flatBg = `solid flat single-color ${key} background, absolutely no gradient, ` +
    `no shading, no vignette, no scenery, no floor, no backdrop details`;
  const strictClause = strict
    ? ` CRITICAL: every frame must be fully isolated — if any two frames touch, overlap, ` +
      `or merge into one shape the output is unusable. Keep wide empty ${key} gaps on all sides of each frame, ` +
      `and keep the background perfectly flat with zero gradient or shading.`
    : "";
  if (cat === "character") {
    return `2D game character sprite, ${describe("brave knight")}, ${p.style} style, ${(p.archetype || "biped")} body plan, ${sub} animation: ` +
      `${p.frames} SEPARATE non-overlapping poses in ONE horizontal row, ` +
      `large clear gaps of flat ${key} between every pose, ` +
      `poses never touching or blending into each other, each pose centered in its own slot, ` +
      `${p.view} view, full body visible, feet aligned on the same ground line, ` +
      `clean flat colors, bold readable silhouette, ` +
      flatBg + `, no shadows, no outline glow, no text, no watermark, game asset` + strictClause;
  }
  if (cat === "tile") {
    return `seamless tileable 2D game texture, ${describe("mossy dungeon floor")}, ` +
      `fills the entire square image edge to edge, repeating pattern with no visible seams, ` +
      `flat game art, no characters, no text, no watermark`;
  }
  if (cat === "ui") {
    return `2D game UI ${p.kind}, ${describe("round fantasy RPG menu button")}, ` +
      `${p.states} SEPARATE non-overlapping variations in ONE horizontal row left to right (normal, hover, pressed states), ` +
      `large clear gaps of flat ${key} between variations, never touching, ` +
      `each centered in its own slot, clean vector game UI style, ` +
      flatBg + `, no text letters, no watermark` + strictClause;
  }
  return `2D game effect sprite sequence, ${describe("fiery explosion")}, ${p.type} effect, ` +
    `${p.frames} SEPARATE non-overlapping frames in ONE horizontal row left to right, ` +
    `showing the burst progression from ignition to dissipation, each burst stage centered in its own slot, ` +
    `large clear gaps of flat ${key} between every frame, ` +
    `frames never touching, overlapping, or blending into each other, ` +
    `vibrant flat game art, ` + flatBg + `, no text, no watermark` + strictClause;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------- AI model switcher (v6.8) ----------------
 * Every provider honours one contract: prompt + size in, one image bitmap
 * out. Each entry declares what it needs up front — no key, a free key, or a
 * paid key — and a provider that can't run fails loudly with instructions
 * instead of quietly swapping in a weaker model behind the user's back.
 * Keys live only in this browser's localStorage; they are never uploaded
 * anywhere except the provider the user picked. */

const AI_PROVIDERS = {
  "auto": {
    note: "Auto chain: Deliberate → Juggernaut XL → Dreamshaper → AlbedoBase XL → Stable Diffusion → Flat-2D Animerge (your FLUX keys slot in near the front if saved). Your live queue position shows while you wait; if the Horde QUEUE is the bottleneck it jumps to Space FLUX instead of hopping models. A free AI Horde key (below) gets priority — the anonymous line runs hundreds deep at peak.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue. Stored only in this browser's localStorage.`, auto: true
  },
  "horde-novaflat": {
    note: "Free, no key. Nova Flat XL — flat-shaded XL style, sprite-friendly.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Nova Flat XL"
  },
  "horde-animagine": {
    note: "Free, no key. Animagine XL — polished modern anime.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Animagine XL"
  },
  "horde-anything5": {
    note: "Free, no key. Anything v5 — anime all-rounder.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Anything v5"
  },
  "horde-dreamshaper": {
    note: "Free, no key. Dreamshaper — the classic all-rounder (SD 1.5).",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Dreamshaper"
  },
  "horde-photon": {
    note: "Free, no key. Photon — clean realistic-leaning renders. Few workers — may queue a while.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Photon"
  },
  "horde-absreality": {
    note: "Free, no key. AbsoluteReality — realistic characters.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "AbsoluteReality"
  },
  "horde-flux": {
    note: "Free, no key. FLUX.1 Schnell on community GPUs — top-tier quality, usually 30–90s in the queue.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Flux.1-Schnell fp8 (Compact)"
  },
  "horde-dreamshaper-xl": {
    note: "Free, no key. DreamShaper XL — versatile, great for game art.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "DreamShaper XL"
  },
  "horde-albedo": {
    note: "Free, no key. AlbedoBase XL — sharp, detailed SDXL renders.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "AlbedoBase XL (SDXL)"
  },
  "horde-rev": {
    note: "Free, no key. Rev Animated — anime and animated-style characters.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Rev Animated"
  },
  "horde-flat2d": {
    note: "Free, no key. Flat-2D Animerge — flat 2D style, made for sprites.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Flat-2D Animerge"
  },
  "horde-pixel": {
    note: "Free, no key. AIO Pixel Art — the pixel-art specialist.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "AIO Pixel Art"
  },
  "horde-counterfeit": {
    note: "Free, no key. Counterfeit — polished anime renders.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Counterfeit"
  },
  "horde-realvis": {
    note: "Free, no key. Realistic Vision — realistic characters and portraits.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Realistic Vision"
  },
  "horde-icbinp": {
    note: "Free, no key. ICBINP — photoreal people and scenes.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "ICBINP - I Can't Believe It's Not Photography"
  },
  "horde-anything": {
    note: "Free, no key. Anything Diffusion — the anime classic.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Anything Diffusion"
  },
  "horde-zimage": {
    note: "Free, no key. Z-Image-Turbo — new, fast, crisp.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Z-Image-Turbo"
  },
  "horde-sdxl": {
    note: "Free, no key. SDXL 1.0 — the solid base model.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "SDXL 1.0"
  },
  "horde-ghibli": {
    note: "Free, no key. Ghibli Diffusion — soft storybook look.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Ghibli Diffusion"
  },
  "horde-deliberate": {
    note: "Free. The default. The anonymous queue can crawl at peak (hundreds deep) — a free Horde key gets priority.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Deliberate"
  },
  "horde-juggernaut": {
    note: "Free, no key. Best free quality — can sit in the queue 1–3 min.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "Juggernaut XL"
  },
  "horde-sd": {
    note: "Free, no key. The Horde's quickest model.",
    keyField: "aihorde", keyLabel: "AI Horde key", keyHint: `Free key: register at <a href="https://aihorde.net/register" target="_blank" rel="noopener">aihorde.net/register</a>, copy your API key, paste it here. Anonymous works too — a key just gets priority in the queue (the anonymous line runs hundreds deep at peak). Stored only in this browser's localStorage.`, hordeModel: "stable_diffusion"
  },
  "pol-flux": {
    note: "Real FLUX quality.",
    keyField: "pollinations", keyLabel: "Pollinations key",
    keyHint: `Free key: sign in at <a href="https://enter.pollinations.ai" target="_blank" rel="noopener">enter.pollinations.ai</a>, create a key, paste it here. Stored only in this browser's localStorage.`
  },
  "hf-flux": {
    note: "FLUX.1 schnell through Hugging Face — fast FLUX renders.",
    keyField: "huggingface", keyLabel: "Hugging Face token",
    keyHint: `Free token: <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">huggingface.co/settings/tokens</a> → New token (Read) → paste here. Stored only in this browser's localStorage.`
  },
  "space-flux": {
    note: "Free, no key. FLUX.1-schnell on the official Black Forest Labs Space — proven in the lab at ~5s per still with the flattest keyable backgrounds of any provider here. Runs on the shared free ZeroGPU pool (same pool as the 3D Lab); if you've saved a Hugging Face token for HF FLUX it automatically boosts this too.",
    keyField: null
  }
};

const LS_AI_MODEL = "m4ster.aiModel";
const LS_AI_KEYS = "m4ster.aiKeys";

function aiKeys() {
  try { return JSON.parse(localStorage.getItem(LS_AI_KEYS) || "{}"); }
  catch (e) { return {}; }
}
function aiKeyFor(providerId) {
  const p = AI_PROVIDERS[providerId];
  if (!p || !p.keyField) return "";
  return (aiKeys()[p.keyField] || "").trim();
}
function needKey(providerId) {
  const p = AI_PROVIDERS[providerId];
  const key = aiKeyFor(providerId);
  if (!key) {
    fail(`This model needs your ${p.keyLabel} — paste it under "AI model" first (it's free to get, see the hint there). Nothing was generated.`);
  }
  return key;
}

/* fit a requested size into a provider's box: sides are multiples of 64,
 * neither side above maxSide, total area near maxPixels */
function fitSize(w, h, maxSide, maxPixels) {
  let scale = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
  const r64 = n => Math.max(64, Math.round((n * scale) / 64) * 64);
  return { w: r64(w), h: r64(h) };
}

async function blobToBitmap(blob) { return createImageBitmap(blob); }

async function hordeGenerate(prompt, w, h, model, onStatus, apiKey) {
  /* anonymous Horde jobs are capped at 512×512 worth of pixels total —
   * ask for more and the submit is refused outright (HTTP 403) */
  const size = fitSize(w, h, 1024, 512 * 512);
  const headers = {
    "Content-Type": "application/json",
    "apikey": apiKey || "0000000000",
    "Client-Agent": "m4ster-framelab:6.8:web"
  };
  let jobId = null;
  try {
    const res = await fetch("https://stablehorde.net/api/v2/generate/async", {
      method: "POST", headers,
      body: JSON.stringify({
        prompt,
        params: {
          width: size.w, height: size.h, steps: 25,
          sampler_name: "k_euler_a", cfg_scale: 7,
          seed: String((Math.random() * 1e9) | 0),
          negative_prompt: "gradient, vignette, border, frame, backdrop, scenery, " +
            "splash shape, decorative background, floor, shadow, watermark, text, " +
            "3d render, photorealistic, blurry, multiple characters"
        },
        models: [model], nsfw: false, r2: false
      })
    });
    if (!res.ok) fail(`AI Horde rejected the job (HTTP ${res.status}). The free queue may be full — wait a bit and retry.`);
    jobId = (await res.json()).id;
  } catch (e) {
    if (e && /^AI Horde/.test(e.message)) throw e;
    fail("AI Horde is unreachable right now (network). Retry in a moment, or pick another model.");
  }
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    let chk;
    try {
      const r = await fetch(`https://stablehorde.net/api/v2/generate/check/${jobId}`, { headers });
      chk = await r.json();
    } catch (e) { continue; } // transient poll miss — keep waiting
    if (chk.faulted) fail("AI Horde dropped the job (a worker failed mid-render). Retry — the queue usually clears fast.");
    if (!chk.done) {
      if (onStatus) {
        if (chk.queue_position > 0) onStatus(`AI Horde · ${model} — in queue, position ${chk.queue_position}…`);
        else onStatus(`AI Horde · ${model} — rendering…`);
      }
      continue;
    }
    const fin = await fetch(`https://stablehorde.net/api/v2/generate/status/${jobId}`, { headers });
    const data = await fin.json();
    const gen = data.generations && data.generations[0];
    if (!gen || !gen.img) fail("AI Horde finished but returned no image. Retry once — if it repeats, pick another model.");
    if (/^https?:/.test(gen.img)) {
      const imgRes = await fetch(gen.img, { mode: "cors" });
      return blobToBitmap(await imgRes.blob());
    }
    const bin = atob(gen.img);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return blobToBitmap(new Blob([bytes], { type: "image/webp" }));
  }
  if (apiKey) fail("AI Horde took over 5 minutes in the queue — timed out, even with your key. The Horde is slammed right now; retry in a few minutes.");
  fail("AI Horde took over 5 minutes in the queue — timed out. The anonymous queue runs hundreds deep at peak; a free AI Horde key (paste it under \"AI model\") gets priority and usually clears in 1–2 minutes.");
}

async function hfGenerate(prompt, w, h, token, onStatus) {
  const size = fitSize(w, h, 1024, 1024 * 1024);
  const url = "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell";
  const opts = {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: prompt, parameters: { width: size.w, height: size.h } })
  };
  let res = await fetch(url, opts);
  if (res.status === 503) {
    let wait = 15;
    try { const j = await res.json(); wait = Math.min(30, Math.ceil(j.estimated_time || 15)); } catch (e) {}
    if (onStatus) onStatus(`Hugging Face — model warming up, ~${wait}s…`);
    await sleep(wait * 1000);
    res = await fetch(url, opts);
  }
  if (res.status === 401 || res.status === 403) {
    fail("Hugging Face rejected that token. Check the token under \"AI model\" (needs Read access) and retry.");
  }
  if (!res.ok) fail(`Hugging Face image request failed (HTTP ${res.status}). Free tokens have tight rate limits — wait a minute and retry.`);
  return blobToBitmap(await res.blob());
}

async function polFluxGenerate(prompt, w, h, key, onStatus) {
  const seed = (Math.random() * 1e9) | 0;
  const url = "https://gen.pollinations.ai/image/" + encodeURIComponent(prompt) +
    `?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux&key=${encodeURIComponent(key)}`;
  let res;
  try { res = await fetch(url, { mode: "cors" }); }
  catch (e) { fail("Pollinations FLUX is unreachable right now (network). Retry in a moment."); }
  if (res.status === 401 || res.status === 403) {
    fail("Pollinations rejected that key. Check the key under \"AI model\" (from enter.pollinations.ai) and retry.");
  }
  if (!res.ok) fail(`Pollinations FLUX request failed (HTTP ${res.status}). Retry in a moment.`);
  return blobToBitmap(await res.blob());
}

/* HF Space FLUX.1-schnell (Phase 2 Trial A, proven 2026-10-20): anonymous
 * Gradio queue on the official BFL Space — fn 2 "infer", one session per
 * run, SSE until process_completed. A saved HF token (the same one the
 * hf-flux slot stores) is sent when present: it lifts the ZeroGPU quota. */
async function spaceFluxGenerate(prompt, w, h, onStatus) {
  const host = "https://black-forest-labs-flux-1-schnell.hf.space";
  const clamp = n => Math.max(256, Math.min(1024, Math.round(n / 16) * 16));
  const headers = { "Content-Type": "application/json" };
  const token = (aiKeys()["huggingface"] || "").trim();
  if (token) headers["Authorization"] = "Bearer " + token;
  const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const deadline = Date.now() + 5 * 60 * 1000;
  const timedFetch = async (url, opts) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
    try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
    finally { clearTimeout(t); }
  };
  try {
    if (onStatus) onStatus("Space FLUX — joining the free GPU queue…");
    const join = await timedFetch(host + "/gradio_api/queue/join", {
      method: "POST", headers,
      body: JSON.stringify({ fn_index: 2, data: [prompt, 0, true, clamp(w), clamp(h), 4], session_hash: session })
    });
    if (!join.ok) fail(`Space FLUX couldn't take the job (HTTP ${join.status}). The free GPU pool may be drained — retry in a bit, or pick another model.`);
    if (onStatus) onStatus("Space FLUX — generating (usually a few seconds)…");
    const res = await timedFetch(host + "/gradio_api/queue/data?session_hash=" + encodeURIComponent(session), { headers });
    if (!res.ok || !res.body) fail("Space FLUX queue stream failed. Retry in a moment.");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.indexOf("data:") !== 0) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (evt.msg === "process_completed") {
          const out = evt.output || {};
          if (evt.success === false || !out.data || !out.data[0]) {
            fail("Space FLUX reported a failure: " + String(out.error || evt.error || "unknown error"));
          }
          const fd = out.data[0];
          const url = fd && fd.url ? fd.url : (fd && fd.path ? host + "/gradio_api/file=" + fd.path : null);
          if (!url) fail("Space FLUX finished but returned no image. Retry once — if it repeats, pick another model.");
          const imgRes = await timedFetch(url, { headers });
          if (!imgRes.ok) fail("Space FLUX image download failed (HTTP " + imgRes.status + ").");
          return blobToBitmap(await imgRes.blob());
        }
        if (evt.msg === "process_error") {
          fail("Space FLUX reported an error: " + String(evt.error || "unknown error"));
        }
      }
    }
    fail("Space FLUX queue stream ended early. Retry in a moment.");
  } catch (e) {
    if (e && e.message && /^(Space FLUX|This model|Unknown AI)/.test(e.message)) throw e;
    if (e && e.name === "AbortError") fail("Space FLUX took over 5 minutes in the free queue — timed out. Retry, or pick another model.");
    fail("Space FLUX is unreachable right now (network). Retry in a moment, or pick another model.");
  }
}

/* the one door every AI image comes through */
async function aiGenerateWith(id, prompt, w, h, onStatus) {
  const p = AI_PROVIDERS[id];
  if (p.hordeModel) return hordeGenerate(prompt, w, h, p.hordeModel, onStatus, aiKeyFor(id));
  if (id === "pol-flux") return polFluxGenerate(prompt, w, h, needKey(id), onStatus);
  if (id === "hf-flux") return hfGenerate(prompt, w, h, needKey(id), onStatus);
  if (id === "space-flux") return spaceFluxGenerate(prompt, w, h, onStatus);
  fail("Unknown AI model selected — pick one from the list.");
}

/* AUTO chain — Phase 1 trial order (HUB roadmap, 2026-10-20; supersedes
 * the earlier 16-model ranked chain — the manual
 * dropdown still carries the full roster). Saved FLUX keys slot in near
 * the front. */
const AI_AUTO_CHAIN = [
  "horde-deliberate", "horde-juggernaut", "horde-dreamshaper",
  "horde-albedo", "horde-sd", "horde-flat2d"
];
const AI_MODEL_NAMES = {
  "horde-flux": "FLUX.1 Schnell", "horde-juggernaut": "Juggernaut XL",
  "horde-dreamshaper-xl": "DreamShaper XL", "horde-deliberate": "Deliberate",
  "horde-albedo": "AlbedoBase XL", "horde-rev": "Rev Animated",
  "horde-flat2d": "Flat-2D Animerge", "horde-pixel": "AIO Pixel Art",
  "horde-counterfeit": "Counterfeit", "horde-realvis": "Realistic Vision",
  "horde-icbinp": "ICBINP", "horde-anything": "Anything Diffusion",
  "horde-zimage": "Z-Image-Turbo", "horde-sdxl": "SDXL 1.0",
  "horde-ghibli": "Ghibli Diffusion", "horde-sd": "Stable Diffusion",
  "horde-novaflat": "Nova Flat XL", "horde-animagine": "Animagine XL",
  "horde-anything5": "Anything v5", "horde-dreamshaper": "Dreamshaper",
  "horde-photon": "Photon", "horde-absreality": "AbsoluteReality",
  "pol-flux": "Pollinations FLUX", "hf-flux": "HF FLUX.1",
  "space-flux": "Space FLUX"
};

/* AUTO mode: walk the free chain; a limit, a refusal or a dead queue on one
 * model is not a failure — it is the signal to switch to the next one. Only
 * when EVERY model in the chain is down does the run fail loud. */
async function aiGenerateImage(prompt, w, h, onStatus) {
  const id = AI_PROVIDERS[state.aiModel] ? state.aiModel : "auto";
  if (id !== "auto") return aiGenerateWith(id, prompt, w, h, onStatus);
  const chain = AI_AUTO_CHAIN.slice();
  if (aiKeyFor("hf-flux")) chain.splice(1, 0, "hf-flux");
  if (aiKeyFor("pol-flux")) chain.splice(2, 0, "pol-flux");
  let lastErr = null;
  let fluxDetour = false;
  for (let i = 0; i < chain.length; i++) {
    const mid = chain[i];
    try {
      if (i > 0) onStatus(`auto: switched to ${AI_MODEL_NAMES[mid]}`);
      return await aiGenerateWith(mid, prompt, w, h, onStatus);
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      /* a Horde queue timeout means the QUEUE is the bottleneck, not the
       * model — hopping to the next Horde model just re-queues behind the
       * same anonymous line. Detour to Space FLUX once; if that also
       * fails, stop loud and honest instead of cycling for half an hour. */
      if (/took over 5 minutes/.test(msg) && mid.indexOf("horde-") === 0 && !fluxDetour) {
        fluxDetour = true;
        chain.splice(i + 1, chain.length - (i + 1), "space-flux");
        onStatus("auto: the Horde queue is the bottleneck today — trying Space FLUX instead…");
        setStatusBar("warn");
        continue;
      }
      if (mid === "space-flux" && fluxDetour) break;
      const next = chain[i + 1];
      if (next) {
        onStatus(`auto: ${AI_MODEL_NAMES[mid]} unavailable (${msg.slice(0, 90)}) — switching to ${AI_MODEL_NAMES[next]}…`);
        setStatusBar("warn");
      }
    }
  }
  if (fluxDetour) fail("The free queues are slammed right now — Horde timed out in line and Space FLUX couldn't run either. A free AI Horde key (under \"AI model\") skips most of the Horde queue; otherwise give it a few minutes.");
  fail(`Every free model in the auto chain is unavailable right now. Last word: ${lastErr ? lastErr.message : "unknown"} — retry in a minute, the queues clear fast.`);
}

/* ===== Model Preference picker — Meshy copy (TEST build) =====
 * Meshy's model dropdown is a rich popup: sections, one row per model
 * with an icon, the model name, a small meta chip and a one-line
 * description, checkmark on the current pick. Ours works the same on
 * BOTH selects (2D #aiModel, 3D #m3Provider). The native <select>
 * stays in the DOM as the single source of truth — picking a row sets
 * select.value and dispatches a real change event, so every existing
 * listener (state save, key row, notes, 3D description) keeps working.
 * The popup is portaled to <body>: position:fixed inside the wizard's
 * animated ancestors would render offset. */
function mpParseOption(opt, groupLabel) {
  const raw = opt.textContent.trim().replace(/^⚡\s*/, "");
  const parts = raw.split(" — ");
  const left = parts[0];
  const desc = parts.slice(1).join(" — ");
  const dot = left.split(" · ");
  let source = "", name = left;
  if (dot.length > 1) { source = dot[0]; name = dot.slice(1).join(" · "); }
  let chip = "";
  const M3_TIERS = { sf3d: "FAST", instantmesh: "BALANCED", trellis: "BALANCED", trellis2: "QUALITY", "hunyuan-mini": "FAST" };
  if (M3_TIERS[opt.value]) chip = M3_TIERS[opt.value];
  const tm = raw.match(/~?\s?(\d+(?:\.\d+)?s)\b/);
  if (chip) { /* tier label wins */ }
  else if (opt.value === "auto") chip = "AUTO";
  else if (/free key/i.test(groupLabel || "")) chip = "FREE KEY";
  else if (tm) chip = "~" + tm[1];
  return { value: opt.value, name: name, source: source, desc: desc, chip: chip };
}
function mpSections(sel) {
  const secs = [];
  const pushOpt = (label, opt) => {
    let s = secs.find((x) => x.label === label);
    if (!s) { s = { label: label, rows: [] }; secs.push(s); }
    s.rows.push(mpParseOption(opt, label));
  };
  Array.prototype.forEach.call(sel.children, (child) => {
    if (child.tagName === "OPTGROUP") {
      Array.prototype.forEach.call(child.children, (opt) => pushOpt(child.label, opt));
    } else if (child.tagName === "OPTION") {
      pushOpt(child.value === "auto" ? "Auto" : "Models", child);
    }
  });
  return secs;
}
let mpOpenFor = null; // { btn, sel } while the popup is open
function mpClose() {
  const pop = document.getElementById("mpPop");
  if (pop) pop.hidden = true;
  if (mpOpenFor) mpOpenFor.btn.setAttribute("aria-expanded", "false");
  mpOpenFor = null;
}
/* ===== My Assets — Meshy copy (TEST build) =====
 * Meshy's Assets page: search, All / Images / Models / Animation
 * filters, batch selection, thumbnail grid. Ours is filled with the
 * visitor's OWN work from this session — 2D rows from state.rows and
 * 3D meshes registered by the studio — because the hub has no
 * accounts by design. Nothing is uploaded anywhere. */
window.M3_ASSET_LIST = window.M3_ASSET_LIST || [];
const assetsState = { filter: "all", query: "", batch: false, selected: new Set() };
function assetsItems() {
  const items = [];
  if (typeof state !== "undefined" && state.rows) {
    state.rows.forEach((r, i) => {
      if (!r.frames || !r.frames[0]) return;
      items.push({
        id: "2d-" + i,
        kind: r.frames.length > 1 ? "animation" : "image",
        name: r.name || "Sprite",
        thumb: null, canvas: r.frames[0],
        frames: r.frames.length
      });
    });
  }
  window.M3_ASSET_LIST.forEach((m, i) => {
    items.push({ id: "3d-" + i, kind: "model", name: m.name, thumb: m.thumb, url: m.url, objUrl: m.objUrl || null });
  });
  return items.reverse();
}
function assetsDownload(item) {
  const a = document.createElement("a");
  if (item.kind === "model") {
    a.href = item.url;
    a.download = "framelab-mesh.glb";
  } else {
    a.href = item.canvas.toDataURL("image/png");
    a.download = (item.name || "sprite").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() + ".png";
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function renderAssets() {
  const grid = document.getElementById("assetsGrid");
  const empty = document.getElementById("assetsEmpty");
  if (!grid) return;
  const q = assetsState.query.toLowerCase();
  const items = assetsItems().filter((it) =>
    (assetsState.filter === "all" || it.kind === assetsState.filter) &&
    (!q || it.name.toLowerCase().indexOf(q) >= 0));
  grid.innerHTML = "";
  items.slice(0, 30).forEach((it) => {
    const card = document.createElement("div");
    card.className = "asset-card" + (assetsState.selected.has(it.id) ? " picked" : "");
    const img = document.createElement("img");
    img.className = "asset-thumb";
    img.alt = it.name;
    if (it.kind === "model") {
      if (it.thumb) img.src = it.thumb;
      else { img.alt = "3D mesh"; }
    } else {
      try { img.src = it.canvas.toDataURL("image/png"); } catch (e) { /* tainted canvas — skip thumb */ }
    }
    card.appendChild(img);
    if (it.kind === "model" && !it.thumb) {
      const cube = document.createElement("div");
      cube.className = "asset-cube";
      cube.textContent = "▣";
      card.appendChild(cube);
    }
    const meta = document.createElement("div");
    meta.className = "asset-meta";
    const nm = document.createElement("span");
    nm.className = "asset-name";
    nm.textContent = it.name;
    const tag = document.createElement("span");
    tag.className = "asset-tag";
    tag.textContent = it.kind === "model" ? "Model" : it.kind === "animation" ? "Animation · " + it.frames + "f" : "Image";
    meta.appendChild(nm);
    meta.appendChild(tag);
    card.appendChild(meta);
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "asset-dl";
    dl.title = "Download";
    dl.textContent = "⬇";
    dl.addEventListener("click", (e) => { e.stopPropagation(); assetsDownload(it); });
    card.appendChild(dl);
    if (assetsState.batch) {
      const cb = document.createElement("span");
      cb.className = "asset-check";
      cb.textContent = assetsState.selected.has(it.id) ? "✓" : "";
      card.appendChild(cb);
    }
    card.addEventListener("click", () => {
      if (assetsState.batch) {
        if (assetsState.selected.has(it.id)) assetsState.selected.delete(it.id);
        else assetsState.selected.add(it.id);
        assetsSyncFoot();
        renderAssets();
        return;
      }
      const f = document.getElementById(it.kind === "model" ? "flip3d" : "flip2d");
      if (f) f.click();
      const target = document.getElementById(it.kind === "model" ? "lab3d" : "tool");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    grid.appendChild(card);
  });
  if (empty) {
    empty.hidden = items.length > 0;
    if (items.length === 0 && assetsItems().length > 0) empty.textContent = "No assets match that filter.";
    else if (items.length === 0) empty.textContent = "Nothing here yet — generate a sprite or a mesh and it shows up here.";
  }
  assetsSyncFoot();
}
function assetsSyncFoot() {
  const foot = document.getElementById("assetsFoot");
  const count = document.getElementById("assetsSelCount");
  if (foot) foot.hidden = !(assetsState.batch && assetsState.selected.size > 0);
  if (count) count.textContent = assetsState.selected.size + " selected";
}
function wireAssets() {
  const grid = document.getElementById("assetsGrid");
  if (!grid) return;
  document.querySelectorAll(".assets-fbtn[data-f]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".assets-fbtn[data-f]").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    assetsState.filter = b.getAttribute("data-f");
    renderAssets();
  }));
  const search = document.getElementById("assetsSearch");
  if (search) search.addEventListener("input", () => { assetsState.query = search.value.trim(); renderAssets(); });
  const batch = document.getElementById("assetsBatch");
  if (batch) batch.addEventListener("change", () => {
    assetsState.batch = batch.checked;
    if (!batch.checked) assetsState.selected.clear();
    renderAssets();
  });
  const dlSel = document.getElementById("assetsDlSel");
  if (dlSel) dlSel.addEventListener("click", () => {
    assetsItems().filter((it) => assetsState.selected.has(it.id)).forEach((it, i) => {
      setTimeout(() => assetsDownload(it), i * 350);
    });
  });
  const clearSel = document.getElementById("assetsClearSel");
  if (clearSel) clearSel.addEventListener("click", () => { assetsState.selected.clear(); renderAssets(); });
  const up = document.getElementById("assetsUpload");
  const up3d = document.getElementById("assetsUpload3d");
  const glbFile = document.getElementById("assetsGlbFile");
  if (up3d && glbFile) {
    up3d.addEventListener("click", () => glbFile.click());
    glbFile.addEventListener("change", () => {
      const f = glbFile.files && glbFile.files[0];
      if (f && window.M3_LOAD_GLB) window.M3_LOAD_GLB(URL.createObjectURL(f), f.name);
      glbFile.value = "";
    });
  }
  if (up) up.addEventListener("click", () => {
    const f3 = document.getElementById("flip3d");
    if (f3) f3.click();
    const fi = document.getElementById("m3File");
    if (fi) fi.click();
  });
  ["flip2d", "flip3d"].forEach((id) => {
    const f = document.getElementById(id);
    if (f) f.addEventListener("click", () => setTimeout(renderAssets, 60));
  });
  renderAssets();
}
window.renderAssets = renderAssets;

function wireModelPicker(btnId, selId) {
  const btn = document.getElementById(btnId);
  const sel = document.getElementById(selId);
  const pop = document.getElementById("mpPop");
  if (!btn || !sel || !pop) return;
  const nameEl = btn.querySelector(".mp-name");
  const chipEl = btn.querySelector(".mp-chip");
  function refreshTrigger() {
    const opt = sel.options[sel.selectedIndex];
    if (!opt) return;
    const r = mpParseOption(opt, "");
    if (nameEl) nameEl.textContent = (r.source ? r.source + " · " : "") + r.name;
    if (chipEl) { chipEl.textContent = r.chip || ""; chipEl.hidden = !r.chip; }
  }
  sel.addEventListener("change", refreshTrigger);
  refreshTrigger();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (mpOpenFor && mpOpenFor.sel === sel) { mpClose(); return; }
    mpClose();
    const list = pop.querySelector(".mp-list");
    const titleEl = pop.querySelector(".mp-title");
    if (titleEl) titleEl.textContent = btn.getAttribute("data-mp-title") || "Model Preference";
    list.innerHTML = "";
    mpSections(sel).forEach((sec) => {
      const h = document.createElement("div");
      h.className = "mp-sec";
      h.textContent = sec.label;
      list.appendChild(h);
      sec.rows.forEach((r) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "mp-row" + (r.value === sel.value ? " sel" : "");
        const ic = document.createElement("span");
        ic.className = "mp-ic";
        ic.textContent = r.value === "auto" ? "⚡" : r.source.indexOf("Horde") >= 0 ? "◆" : r.chip === "FREE KEY" ? "●" : "▲";
        const main = document.createElement("span");
        main.className = "mp-main";
        const nm = document.createElement("span");
        nm.className = "mp-rname";
        nm.textContent = (r.source ? r.source + " · " : "") + r.name;
        if (r.chip) {
          const ch = document.createElement("span");
          ch.className = "mp-rchip";
          ch.textContent = r.chip;
          nm.appendChild(ch);
        }
        main.appendChild(nm);
        if (r.desc) {
          const ds = document.createElement("span");
          ds.className = "mp-rdesc";
          ds.textContent = r.desc;
          main.appendChild(ds);
        }
        const ck = document.createElement("span");
        ck.className = "mp-check";
        ck.textContent = r.value === sel.value ? "✓" : "";
        row.appendChild(ic);
        row.appendChild(main);
        row.appendChild(ck);
        row.addEventListener("click", () => {
          sel.value = r.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          refreshTrigger();
          mpClose();
        });
        list.appendChild(row);
      });
    });
    pop.hidden = false;
    mpOpenFor = { btn: btn, sel: sel };
    btn.setAttribute("aria-expanded", "true");
    const rect = btn.getBoundingClientRect();
    const pw = Math.min(430, window.innerWidth - 16);
    pop.style.width = pw + "px";
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8)) + "px";
    const below = window.innerHeight - rect.bottom;
    if (below < 340 && rect.top > below) {
      pop.style.top = "auto";
      pop.style.bottom = (window.innerHeight - rect.top + 8) + "px";
    } else {
      pop.style.bottom = "auto";
      pop.style.top = (rect.bottom + 8) + "px";
    }
  });
}
document.addEventListener("click", (e) => {
  const pop = document.getElementById("mpPop");
  if (!pop || pop.hidden || !mpOpenFor) return;
  if (!pop.contains(e.target) && e.target !== mpOpenFor.btn && !mpOpenFor.btn.contains(e.target)) mpClose();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") mpClose(); });
window.addEventListener("resize", () => mpClose());

/* switcher UI: visibility, key row, notes — driven by the provider table */
function syncAiModelUI() {
  const sel = document.getElementById("aiModel");
  const box = document.getElementById("aiModelBox");
  if (!sel || !box) return;
  box.hidden = state.source !== "ai";
  sel.value = AI_PROVIDERS[state.aiModel] ? state.aiModel : "horde-deliberate";
  const p = AI_PROVIDERS[sel.value];
  const keyRow = document.getElementById("aiKeyRow");
  const keyInput = document.getElementById("aiKey");
  const hint = document.getElementById("aiKeyHint");
  const note = document.getElementById("aiModelNote");
  if (p.keyField) {
    keyRow.hidden = false;
    keyInput.placeholder = `paste your ${p.keyLabel}`;
    keyInput.value = aiKeys()[p.keyField] || "";
    hint.innerHTML = p.keyHint;
  } else {
    keyRow.hidden = true;
  }
  note.textContent = p.note || "";
  const styleRow = document.getElementById("aiStyleRow");
  if (styleRow) {
    styleRow.hidden = !(state.source === "ai" && state.category === "character");
    styleRow.querySelectorAll(".seg-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.style === state.aiStyle));
  }
  const costNote = document.getElementById("stateCostNote");
  if (costNote) {
    costNote.textContent = state.source === "ai" && state.aiStyle === "still"
      ? "(one AI call total — states animated in-house)"
      : "(one AI call per state)";
  }
  const genNote = document.querySelector(".gen-note");
  if (genNote) {
    genNote.textContent = state.source === "ai"
      ? "AI models run free on AI Horde — no key needed."
      : "Procedural runs 100% offline — no network at all.";
  }
  syncStudio();
}

async function genRowAI(prompt, frames, cellH, label) {
  // Wide strip: one cell per frame. Keep the strip >=1024px wide so frames
  // carry usable detail (the model returns blurry mush at small sizes).
  const h = cellH || 384;
  const w = Math.min(2048, Math.max(1024, h * frames));
  const bmp = await aiGenerateImage(prompt, w, h, (msg) => {
    setStep("row", "active", `row gen [${label}] — ${msg}`);
  });
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  return c;
}

/* sample the background colour that is actually there (corners average).
 * Models drift from the textbook key colour — magenta comes back dusty
 * pink, grey-blue, cream — so keying anchors to the sampled colour. */
function sampleKeyColor(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const s = Math.max(2, Math.min(12, (Math.min(w, h) / 20) | 0));
  const pts = [[0, 0], [w - s, 0], [0, h - s], [w - s, h - s]];
  let r = 0, g = 0, b = 0, n = 0;
  for (const [x, y] of pts) {
    const d = ctx.getImageData(x, y, s, s).data;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/* flood keying for AI stills: region-grow from every border pixel. A pixel
 * joins the background only if BOTH hold: it is close to the background
 * pixel it grew from (small per-step step — this eats gradients and
 * vignettes), AND it is still within a capped total distance of the
 * sampled background colour. The cap is what stops the flood leaking
 * through a soft painterly edge and eating the whole character — with
 * chain-similarity alone, a washed-out render loses everything but its
 * outlines. The cap adapts: it is loosened by how far the background
 * colour itself drifts between the image corners (a flat backdrop keeps
 * the cap tight; a vignette earns headroom). */
function floodKey(src, tol = 12) {
  const w = src.width, h = src.height;
  const ctx = src.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const bgc = sampleKeyColor(src);
  const cornerCols = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  });
  let spread = 0;
  for (const a of cornerCols) for (const b of cornerCols) {
    spread = Math.max(spread, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]));
  }
  const cap = spread + 190;
  const withinCap = i => {
    const a = i * 4;
    return Math.abs(d[a] - bgc.r) + Math.abs(d[a + 1] - bgc.g) + Math.abs(d[a + 2] - bgc.b) <= cap;
  };
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = i => { if (!bg[i] && withinCap(i)) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  const near = (i, j) => {
    const a = i * 4, b = j * 4;
    return Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]) <= tol;
  };
  while (stack.length) {
    const cur = stack.pop();
    const cx = cur % w, cy = (cur / w) | 0;
    if (cx > 0)     { const n = cur - 1; if (!bg[n] && near(cur, n)) push(n); }
    if (cx < w - 1) { const n = cur + 1; if (!bg[n] && near(cur, n)) push(n); }
    if (cy > 0)     { const n = cur - w; if (!bg[n] && near(cur, n)) push(n); }
    if (cy < h - 1) { const n = cur + w; if (!bg[n] && near(cur, n)) push(n); }
  }
  /* pass 2 — the skirt: background-coloured pixels hugging the keyed
   * region (gradient skirts, soft ground shadows) erode inward, three
   * pixels deep. The cap still protects saturated character colours,
   * and the shallow depth protects flat character whites — a white
   * cape loses only its outermost shading, not its body. */
  const cap2 = cap + 130;
  const within2 = i => {
    const a = i * 4;
    return Math.abs(d[a] - bgc.r) + Math.abs(d[a + 1] - bgc.g) + Math.abs(d[a + 2] - bgc.b) <= cap2;
  };
  for (let pass = 0; pass < 3; pass++) {
    const add = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bg[i] || !within2(i)) continue;
      if ((x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w])) add.push(i);
    }
    if (!add.length) break;
    for (const i of add) bg[i] = 1;
  }
  /* pass 3 — enclosed pockets: a cluster of background-coloured
   * pixels that the real background cannot touch — every neighbour
   * is subject-coloured, none touches the border — is backdrop
   * trapped inside the silhouette (the white patch between a
   * knight's legs). A white cape survives: its outer edge borders
   * the keyed background all along, so it is never enclosed. */
  {
    const seen = new Uint8Array(w * h);
    const stack3 = [];
    for (let start = 0; start < w * h; start++) {
      if (bg[start] || seen[start] || !within2(start)) continue;
      const cluster = [];
      let enclosed = true;
      seen[start] = 1; stack3.push(start);
      while (stack3.length) {
        const cur = stack3.pop();
        cluster.push(cur);
        const cx = cur % w, cy = (cur / w) | 0;
        if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) enclosed = false;
        const ns = [cx > 0 ? cur - 1 : -1, cx < w - 1 ? cur + 1 : -1, cy > 0 ? cur - w : -1, cy < h - 1 ? cur + w : -1];
        for (const n of ns) {
          if (n < 0) continue;
          if (bg[n]) { enclosed = false; continue; }
          if (!seen[n] && within2(n)) { seen[n] = 1; stack3.push(n); }
        }
      }
      if (enclosed && cluster.length < w * h * 0.12) for (const i of cluster) bg[i] = 1;
    }
  }
  for (let i = 0; i < w * h; i++) if (bg[i]) d[i * 4 + 3] = 0;
  const out = makeCanvas(w, h);
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}

/* keep only the largest connected blob of a keyed still, clear the rest.
 * Models ignore "one character" often enough (mini sprite sheets, stray
 * marks, the Pollinations watermark in a corner) — extraction merges their
 * bounding boxes into the cell, so without this pass the junk rides along
 * inside every frame. */
function keepLargestBlob(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const label = new Int32Array(w * h).fill(-1);
  let best = -1, bestSize = 0, next = 0;
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || d[start * 4 + 3] <= 12) continue;
    let size = 0;
    label[start] = next;
    stack.push(start);
    while (stack.length) {
      const cur = stack.pop();
      size++;
      const cx = cur % w, cy = (cur / w) | 0;
      if (cx > 0)     { const n = cur - 1; if (label[n] === -1 && d[n * 4 + 3] > 12) { label[n] = next; stack.push(n); } }
      if (cx < w - 1) { const n = cur + 1; if (label[n] === -1 && d[n * 4 + 3] > 12) { label[n] = next; stack.push(n); } }
      if (cy > 0)     { const n = cur - w; if (label[n] === -1 && d[n * 4 + 3] > 12) { label[n] = next; stack.push(n); } }
      if (cy < h - 1) { const n = cur + w; if (label[n] === -1 && d[n * 4 + 3] > 12) { label[n] = next; stack.push(n); } }
    }
    if (size > bestSize) { bestSize = size; best = next; }
    next++;
  }
  if (best < 0) return canvas;
  for (let i = 0; i < w * h; i++) if (label[i] !== best) d[i * 4 + 3] = 0;
  const out = makeCanvas(w, h);
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}

/* fraction of pixels keying cleared (sampled). Near zero = the backdrop
 * is still fully attached and the "sprite" would be a bobbing rectangle */
function clearedFrac(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let clear = 0, n = 0;
  for (let i = 3; i < d.length; i += 16) { n++; if (d[i] <= 12) clear++; }
  return n ? clear / n : 0;
}

/* did keying eat the subject? the middle of the frame should still hold a
 * solid share of opaque pixels — a standing character lives there */
function hollowCenter(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const x0 = (w * 0.3) | 0, x1 = (w * 0.7) | 0, y0 = (h * 0.25) | 0, y1 = (h * 0.8) | 0;
  let opaque = 0, total = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    total++;
    if (d[(y * w + x) * 4 + 3] > 12) opaque++;
  }
  return total === 0 || opaque / total < 0.03;
}

/* ---------------- alpha cleanup: chroma key + despill ----------------
 * Hard-key pixels inside the color-distance ball, then soft-alpha + despill
 * on the anti-aliased fringe so silhouettes keep clean edges instead of
 * getting chewed into a hard cut. Key is chosen away from the subject hue. */

function chromaKey(src, key, threshold = 60, fringe = 40) {
  const w = src.width, h = src.height;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  const img = sctx.getImageData(0, 0, w, h);
  const d = img.data;

  // key dominance vector: which channels the key color "owns" (for despill)
  const lum = (key.r + key.g + key.b) / 3;
  const kd = [Math.max(0, key.r - lum), Math.max(0, key.g - lum), Math.max(0, key.b - lum)];

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const dist = colorDist(r, g, b, key.r, key.g, key.b);

    if (dist <= threshold) {
      d[i + 3] = 0; // fully keyed out
    } else if (dist <= threshold + fringe) {
      // fringe: soft alpha + despill (pull rgb away from the key color)
      const f = (dist - threshold) / fringe;      // 0 at key edge -> 1 at clean
      const spill = (1 - f) * 0.85;
      d[i]     = Math.max(0, r - spill * kd[0]);
      d[i + 1] = Math.max(0, g - spill * kd[1]);
      d[i + 2] = Math.max(0, b - spill * kd[2]);
      d[i + 3] = Math.round(255 * f);
    }
  }

  const out = makeCanvas(w, h);
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}
/* ---------------- frame extraction ----------------
 * Content-based, not slot-based: flood-fill alpha blobs, take the N biggest
 * as pose seeds, sort left-to-right, attach stray blobs to the nearest seed,
 * crop + fit each into its cell. If N poses can't be recovered we FAIL LOUDLY
 * — no silent slot fallback, no guessed frames. */

function extractFrames(strip, count, opts = {}) {
  const align = opts.align || "bottom"; // bottom | center
  const w = strip.width, h = strip.height;
  const ctx = strip.getContext("2d", { willReadFrequently: true });
  const px = ctx.getImageData(0, 0, w, h).data;
  const visited = new Uint8Array(w * h);
  const comps = [];
  const stack = [];

  const alphaAt = (x, y) => px[(y * w + x) * 4 + 3];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (visited[idx] || alphaAt(x, y) <= 12) continue;
      // flood fill this blob
      let x0 = x, x1 = x, y0 = y, y1 = y, area = 0, sx = 0;
      stack.push(idx);
      visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % w, cy = (cur / w) | 0;
        area++; sx += cx;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        // 4-neighbors
        if (cx > 0) { const n = cur - 1; if (!visited[n] && px[n * 4 + 3] > 12) { visited[n] = 1; stack.push(n); } }
        if (cx < w - 1) { const n = cur + 1; if (!visited[n] && px[n * 4 + 3] > 12) { visited[n] = 1; stack.push(n); } }
        if (cy > 0) { const n = cur - w; if (!visited[n] && px[n * 4 + 3] > 12) { visited[n] = 1; stack.push(n); } }
        if (cy < h - 1) { const n = cur + w; if (!visited[n] && px[n * 4 + 3] > 12) { visited[n] = 1; stack.push(n); } }
      }
      comps.push({ x0, x1, y0, y1, area, cx: sx / area });
    }
  }

  let totalAlpha = 0;
  for (const c of comps) totalAlpha += c.area;
  if (totalAlpha === 0) fail("extraction found zero non-transparent pixels — the whole strip keyed out. Try a different background key color.");

  // noise floor: drop specks
  const kept = comps.filter(c => c.area >= Math.max(60, totalAlpha * 0.0015));
  kept.sort((a, b) => b.area - a.area);

  if (kept.length < count) {
    fail(`extraction recovered ${kept.length} pose blob${kept.length === 1 ? "" : "s"} but needs ${count}. ` +
      `The AI strip probably merged poses or left the key in. Regenerate the row or lower the frame count.`);
  }
  const seeds = kept.slice(0, count);

  // attach remaining blobs to the nearest seed by x-center
  const groups = seeds.map(s => ({ seed: s, blobs: [s] }));
  for (let i = count; i < kept.length; i++) {
    const c = kept[i];
    let best = null, bestD = Infinity;
    for (const g of groups) {
      const dd = Math.abs(c.cx - g.seed.cx);
      if (dd < bestD) { bestD = dd; best = g; }
    }
    if (bestD < w / count) best.blobs.push(c);
    // else: unattached noise, dropped
  }

  // sanity: every seed must own a meaningful share of the ink
  for (const g of groups) {
    const ga = g.blobs.reduce((a, b) => a + b.area, 0);
    if (ga < totalAlpha * 0.01) {
      fail(`one recovered pose owns <1% of the sprite ink — the strip is malformed. Regenerate the row.`);
    }
  }

  // sort left to right, fit into cells
  groups.sort((a, b) => a.seed.cx - b.seed.cx);
  const cellW = Math.ceil(w / count), cellH = h;
  const frames = groups.map(g => {
    let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
    for (const b of g.blobs) {
      x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1);
      y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1);
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // never upscale: scale <= 1.0, aspect-preserving
    const s = Math.min((cellW * 0.94) / bw, (cellH * 0.94) / bh, 1);
    const dw = Math.max(1, Math.round(bw * s)), dh = Math.max(1, Math.round(bh * s));
    const cell = makeCanvas(cellW, cellH);
    const cctx = cell.getContext("2d");
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = "high";
    const dx = Math.round((cellW - dw) / 2);
    const dy = align === "bottom"
      ? Math.round(cellH - dh - cellH * 0.03)
      : Math.round((cellH - dh) / 2);
    cctx.drawImage(strip, x0, y0, bw, bh, dx, dy, dw, dh);
    return cell;
  });

  return frames;
}

/* ---------------- key-coverage sanity check ----------------
 * The model sometimes ignores the flat-background instruction and returns a
 * gradient/wash instead — chroma keying can't cleanly strip that. Measure how
 * much of the strip actually keyed out (alpha <= 12); if it's suspiciously
 * low, warn amber and offer the retry path instead of failing silently later. */

function checkKeyCoverage(keyed) {
  const w = keyed.width, h = keyed.height;
  const d = keyed.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let clear = 0, sampled = 0;
  for (let i = 3; i < d.length; i += 16) { // sample every 4th pixel
    sampled++;
    if (d[i] <= 12) clear++;
  }
  const cov = clear / sampled;
  if (cov < 0.30) {
    stageMsg(`background isn't flat — key covered only ${Math.round(cov * 100)}% of the strip. Extraction may be messy.`, "warn");
    showRetry(`Background came back as a gradient/wash instead of flat ${keyName()}. ` +
      `Retry with a stricter prompt, or pick a different background key.`);
    return false;
  }
  return true;
}

/* ---------------- slot-slice fallback ----------------
 * When blob recovery can't find N poses (merged strip, leftover key wash),
 * slice the strip into N even slots and content-crop each slot instead of
 * dying. Frames are flagged slotSliced:true in the manifest — amber warning,
 * not a red dead end. Loud fail remains only when there is no ink at all. */

function sliceSlots(strip, count, opts = {}) {
  const align = opts.align || "bottom";
  const w = strip.width, h = strip.height;
  const ctx = strip.getContext("2d", { willReadFrequently: true });
  const px = ctx.getImageData(0, 0, w, h).data;
  const slotW = w / count;
  const frames = [];
  for (let s = 0; s < count; s++) {
    const sx0 = Math.floor(s * slotW), sx1 = Math.min(w, Math.ceil((s + 1) * slotW));
    let x0 = sx1, x1 = sx0, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = sx0; x < sx1; x++) {
        if (px[(y * w + x) * 4 + 3] > 12) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    const cell = makeCanvas(Math.ceil(slotW), h);
    const cctx = cell.getContext("2d");
    if (x1 >= x0) {
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const sc = Math.min((slotW * 0.94) / bw, (h * 0.94) / bh, 1);
      const dw = Math.max(1, Math.round(bw * sc)), dh = Math.max(1, Math.round(bh * sc));
      const dx = Math.round((slotW - dw) / 2);
      const dy = align === "bottom" ? Math.round(h - dh - h * 0.03) : Math.round((h - dh) / 2);
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = "high";
      cctx.drawImage(strip, x0, y0, bw, bh, dx, dy, dw, dh);
    }
    frames.push(cell);
  }
  return frames;
}

function extractFramesRobust(strip, count, opts = {}) {
  try {
    return { frames: extractFrames(strip, count, opts), method: "blobs" };
  } catch (e) {
    if (/zero non-transparent pixels/.test(e.message)) throw e; // nothing to slice
    return { frames: sliceSlots(strip, count, opts), method: "slots", warning: e.message };
  }
}

function noteExtraction(ex, count, unit) {
  if (ex.method === "slots") {
    setStep("extract", "warn", `slot-sliced ${ex.frames.length}/${count} ${unit} (even slots — verify edges)`);
    stageMsg(`blob recovery failed (${ex.warning}) — fell back to even slot slicing. ` +
      `Frames flagged slotSliced in the manifest; check edges before shipping.`, "warn");
  } else {
    setStep("extract", "done", `extracted ${ex.frames.length}/${count} ${unit}`);
  }
  return ex.method === "slots";
}

/* ---------------- retry bar (recovery path, not a dead end) ---------------- */

function hideRetry() { $("#retryBar").hidden = true; }
function showRetry(msg) {
  $("#retryMsg").textContent = msg;
  $("#retryBar").hidden = false;
  setStatusBar("warn"); // a decision is on the table — bars go amber
}

function setBusy(b) {
  state.busy = b;
  document.querySelectorAll(".generate").forEach(x => { x.disabled = b; });
}

/* ---------------- atlas packing + manifest ----------------
 * Contract (borrowed from the component-row playbook):
 * atlas = one state per row, frames left-to-right;
 * manifest carries absolute frame rects + per-state fps/durations + loop flags.
 * Game code consumes the rects — it never recomputes them. */

function buildAtlas(rows, pad = 2) {
  const rowCells = rows.map(r => {
    let cw = 0, ch = 0;
    for (const f of r.frames) { cw = Math.max(cw, f.width); ch = Math.max(ch, f.height); }
    return { cw, ch };
  });
  const sheetW = Math.max(...rows.map((r, i) => rowCells[i].cw * r.frames.length + pad * 2));
  const sheetH = rowCells.reduce((a, c) => a + c.ch, 0) + pad * (rows.length + 1);

  const sheet = makeCanvas(sheetW, sheetH);
  const sctx = sheet.getContext("2d");

  const frameLayout = { padding: pad, rows: {} };
  const animations = {};
  let y = pad;

  rows.forEach((r, ri) => {
    const { cw, ch } = rowCells[ri];
    const rects = [];
    r.order.forEach((fi, i) => {
      const f = r.frames[fi];
      const x = pad + i * cw;
      drawFrameAt(sctx, f, x, y);
      rects.push({ x, y, w: cw, h: ch });
    });
    frameLayout.rows[r.name] = { row: ri, cellWidth: cw, cellHeight: ch, rects };
    const fps = r.fps || 8;
    animations[r.name] = {
      row: ri,
      frames: r.order.length,
      fps,
      loop: r.loop !== false,
      facing: state.flipX ? "left" : "right",
      durationsMs: r.order.map(() => Math.round(1000 / fps)),
      frameOrder: r.order.slice(),
      slotSliced: !!r.slotSliced, // true when blob recovery failed and even slots were cut
    };
    y += ch + pad;
  });

  const manifest = {
    tool: BRAND.tool,
    version: "2.2.0",
    engine: "component-row",
    runRevision: state.revision,
    atlas: "m4ster-sprite-sheet.png",
    sheetWidth: sheetW,
    sheetHeight: sheetH,
    frameLayout,
    animations,
    curation: curation(),
  };

  return { canvas: sheet, manifest, pngName: "m4ster-sprite-sheet.png", jsonName: "m4ster-sprite-atlas.json" };
}

/* ---------------- frames strip UI (non-destructive reorder) ---------------- */

function renderFramesUI() {
  const box = $("#framesRow");
  box.innerHTML = "";
  let total = 0;

  state.rows.forEach((r, ri) => {
    r.order.forEach((fi, oi) => {
      total++;
      const card = document.createElement("div");
      card.className = "frame-card";
      const cv = document.createElement("canvas");
      cv.width = r.frames[fi].width; cv.height = r.frames[fi].height;
      const fc = cv.getContext("2d");
      if (state.flipX) { fc.translate(cv.width, 0); fc.scale(-1, 1); }
      fc.drawImage(r.frames[fi], 0, 0);
      cv.title = "click to download this frame";
      cv.style.cursor = "pointer";
      cv.onclick = () => downloadCanvas(cv, `m4ster-${r.name}-frame${oi}.png`);
      card.appendChild(cv);
      const nm = document.createElement("span");
      nm.className = "fname";
      nm.textContent = `${r.name} · ${oi + 1}`;
      card.appendChild(nm);
      const mv = document.createElement("div");
      mv.className = "mv";
      const left = document.createElement("button");
      left.textContent = "◀"; left.title = "move earlier";
      left.onclick = () => moveFrame(ri, oi, -1);
      const right = document.createElement("button");
      right.textContent = "▶"; right.title = "move later";
      right.onclick = () => moveFrame(ri, oi, 1);
      mv.appendChild(left); mv.appendChild(right);
      card.appendChild(mv);
      box.appendChild(card);
    });
  });

  $("#framesMeta").textContent = total ? `· ${total} frames, rev ${state.revision}` : "";
}

function moveFrame(ri, oi, dir) {
  const r = state.rows[ri];
  const ni = oi + dir;
  if (ni < 0 || ni >= r.order.length) return;
  const o = r.order;
  [o[oi], o[ni]] = [o[ni], o[oi]];
  // rebuild atlas so the manifest order matches (originals untouched)
  state.atlas = buildAtlas(state.rows);
  renderFramesUI();
  showStage(state.atlas.canvas, `atlas rebuilt — frame order now [${r.order.join(", ")}] (rev ${state.revision})`);
}

/* ---------------- animated preview ---------------- */

let previewRAF = 0, previewRow = 0, previewT = 0;

function startPreview() {
  cancelAnimationFrame(previewRAF);
  cancelAnimationFrame(slicerRAF);
  const sel = $("#previewState");
  sel.innerHTML = "";
  sel.disabled = false;
  state.rows.forEach((r, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = r.name;
    sel.appendChild(o);
  });
  if (!state.rows.length) return;
  previewRow = 0;
  sel.onchange = () => { previewRow = +sel.value; previewT = 0; };

  const pc = $("#preview");
  const pctx = pc.getContext("2d");
  pctx.imageSmoothingEnabled = false;
  let last = performance.now();

  function tick(now) {
    previewRAF = requestAnimationFrame(tick);
    const r = state.rows[previewRow];
    if (!r) return;
    const fps = +$("#previewFps").value || 8;
    if (now - last < 1000 / fps) return;
    last = now;
    previewT = (previewT + 1) % r.order.length;
    const f = r.frames[r.order[previewT]];
    pctx.clearRect(0, 0, pc.width, pc.height);

    if (r.tileable) {
      // 3x3 wrap check
      const tw = f.width, th = f.height;
      const s = Math.min(pc.width / (tw * 3), pc.height / (th * 3));
      const dw = tw * s, dh = th * s;
      const ox = (pc.width - dw * 3) / 2, oy = (pc.height - dh * 3) / 2;
      for (let iy = 0; iy < 3; iy++)
        for (let ix = 0; ix < 3; ix++)
          pctx.drawImage(f, ox + ix * dw, oy + iy * dh, dw, dh);
      $("#previewMeta").textContent = `· ${r.name} · 3×3 tile check`;
    } else {
      const s = Math.min(pc.width / f.width, pc.height / f.height, 8);
      const dw = Math.max(1, Math.round(f.width * s)), dh = Math.max(1, Math.round(f.height * s));
      pctx.save();
      if (state.flipX) { pctx.translate(pc.width, 0); pctx.scale(-1, 1); }
      pctx.drawImage(f, (pc.width - dw) / 2, (pc.height - dh) / 2, dw, dh);
      pctx.restore();
      $("#previewMeta").textContent = `· ${r.name} · frame ${previewT + 1}/${r.order.length}`;
    }
  }
  tick(last);
}

/* ---------------- export ---------------- */

function downloadCanvas(canvas, filename) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function wireExport() {
  $("#dlSheet").onclick = () => state.atlas && downloadCanvas(state.atlas.canvas, state.atlas.pngName || "m4ster-sprite-sheet.png");
  $("#dlJson").onclick = () => state.atlas && downloadJSON(state.atlas.manifest, state.atlas.jsonName || "m4ster-sprite-atlas.json");
  $("#dlAnim").onclick = () => {
    // one button, both files: the picked animation as sheet PNG + manifest JSON
    if (!state.atlas) return;
    downloadCanvas(state.atlas.canvas, state.atlas.pngName || "m4ster-sprite-sheet.png");
    setTimeout(() => downloadJSON(state.atlas.manifest, state.atlas.jsonName || "m4ster-sprite-atlas.json"), 400);
  };
  const godotBtn = $("#dlGodot");
  if (godotBtn) godotBtn.onclick = () => { downloadGodotPack().catch(e => stageMsg("Godot export failed: " + e.message, true)); };
  const unityBtn = $("#dlUnity");
  if (unityBtn) unityBtn.onclick = () => { downloadUnityPack().catch(e => stageMsg("Unity export failed: " + e.message, true)); };
  $("#dlFrames").onclick = () => {
    if (state.slicer && state.slicer.selection.length) {
      // slicer: export the picked frames in order
      let delay = 0;
      state.slicer.selection.forEach((pi, oi) => {
        const c = state.slicer.pieces[pi].canvas;
        setTimeout(() => downloadCanvas(c, `m4ster-slice-frame${oi}.png`), delay);
        delay += 350;
      });
      return;
    }
    if (!state.rows.length) return;
    let delay = 0;
    state.rows.forEach(r => {
      r.order.forEach((fi, oi) => {
        setTimeout(() => downloadCanvas(r.frames[fi], `m4ster-${r.name}-frame${oi}.png`), delay);
        delay += 350;
      });
    });
  };
}

function enableExport(on) {
  ["#dlSheet", "#dlJson", "#dlFrames", "#dlAnim", "#dlBundle", "#dlGodot", "#dlUnity"].forEach(s => { const el = $(s); if (el) el.disabled = !on; });
}

/* ================= v6.10: engine export packs =================
 * One click per engine. Godot gets a real SpriteFrames .tres (plain text,
 * generated exactly). Unity gets the sheet pre-sliced via a hand-authored
 * .meta plus an Editor builder script that creates the .anim clips inside
 * Unity — clips reference sprites by name at editor time, so there is no
 * GUID guessing (the failure mode of shipping raw .anim YAML). */

/* --- stored (uncompressed) ZIP writer: local headers + central dir --- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}
async function fileBytes(data) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data && data.toBlob) { // canvas
    const blob = await new Promise(r => data.toBlob(r, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("zip: unsupported file data");
}
async function downloadZip(zipName, files) {
  const chunks = [], central = [];
  let offset = 0;
  const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const bytes = await fileBytes(f.data);
    const crc = crc32(bytes);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0x21), ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(name.length), ...u16(0), ...name
    ]);
    chunks.push(local, bytes);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0x21), ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...name
    ]));
    offset += local.length + bytes.length;
  }
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; }
  chunks.push(new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length),
    ...u16(central.length), ...u32(cdSize), ...u32(offset), ...u16(0)
  ]));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  downloadBytes(out, zipName, "application/zip");
}

/* --- shared: flatten manifest animations to [{name, fps, loop, rects}] --- */
function manifestAnims(manifest) {
  return Object.entries(manifest.animations).map(([name, a]) => ({
    name,
    fps: a.fps || 8,
    loop: a.loop !== false,
    rects: (manifest.frameLayout.rows[name] || {}).rects || []
  })).filter(a => a.rects.length);
}
const safeName = s => String(s).replace(/[^a-zA-Z0-9_-]+/g, "_");

/* --- Godot: SpriteFrames .tres (Godot 4, Rect2 origin is top-left, y down
 * — exactly how our manifest stores rects, so no conversion) --- */
function godotTres(manifest, pngName) {
  const subs = [], animChunks = [];
  let si = 0;
  for (const a of manifestAnims(manifest)) {
    const frames = a.rects.map(r => {
      si++;
      subs.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${si}"]\natlas = ExtResource("1")\nregion = Rect2(${r.x}, ${r.y}, ${r.w}, ${r.h})`);
      return `{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_${si}")\n}`;
    });
    animChunks.push(`{\n"frames": [${frames.join(", ")}],\n"loop": ${a.loop},\n"name": &"${safeName(a.name)}",\n"speed": ${a.fps.toFixed(1)}\n}`);
  }
  return `[gd_resource type="SpriteFrames" format=3]\n\n` +
    `[ext_resource type="Texture2D" path="res://${pngName}" id="1"]\n\n` +
    subs.join("\n\n") + `\n\n[resource]\nanimations = [${animChunks.join(", ")}]\n`;
}

/* --- Unity: sidecar JSON the builder script reads --- */
function unitySidecar(manifest, pngName) {
  return JSON.stringify({
    tool: "m4ster FrameLab",
    texture: pngName,
    width: manifest.sheetWidth,
    height: manifest.sheetHeight,
    animations: manifestAnims(manifest).map(a => ({
      name: safeName(a.name), fps: a.fps, loop: a.loop, rects: a.rects
    }))
  }, null, 2);
}

/* --- Unity: pre-sliced .png.meta (bonus path — the builder script re-does
 * the slicing from the sidecar anyway, so a Unity version that regenerates
 * this file loses nothing). Unity rects are bottom-up: y flips. --- */
function unityMeta(manifest, guid) {
  const H = manifest.sheetHeight;
  const hex = n => Array.from({ length: n }, () => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");
  const sprites = [], idTable = [], nameTable = [];
  let idx = 0;
  for (const a of manifestAnims(manifest)) {
    a.rects.forEach((r, i) => {
      const nm = `${safeName(a.name)}_${i}`;
      const internalId = 21300000 + idx * 2;
      const spriteID = hex(32);
      sprites.push(
`    - serializedVersion: 2
      name: ${nm}
      rect:
        serializedVersion: 2
        x: ${r.x}
        y: ${H - r.y - r.h}
        width: ${r.w}
        height: ${r.h}
      alignment: 0
      pivot: {x: 0.5, y: 0}
      border: {x: 0, y: 0, z: 0, w: 0}
      outline: []
      customData:
      physicsShape: []
      bones: []
      spriteID: ${spriteID}
      internalID: ${internalId}
      vertices: []
      indices:
      edges: []
      weights: []`);
      idTable.push(`  - first:\n      213: ${internalId}\n    second: ${nm}`);
      nameTable.push(`      ${nm}: ${internalId}`);
      idx++;
    });
  }
  return `fileFormatVersion: 2
guid: ${guid}
TextureImporter:
  internalIDToNameTable:
${idTable.join("\n")}
  externalObjects: {}
  serializedVersion: 12
  mipmaps:
    mipMapMode: 0
    enableMipMap: 0
    sRGBTexture: 1
    linearTexture: 0
    fadeOut: 0
    borderMipMap: 0
    mipMapsPreserveCoverage: 0
    alphaTestReferenceValue: 0.5
    mipMapFadeDistanceStart: 1
    mipMapFadeDistanceEnd: 3
  bumpmap:
    convertToNormalMap: 0
    externalNormalMap: 0
    heightScale: 0.25
    normalMapFilter: 0
  isReadable: 0
  streamingMipmaps: 0
  streamingMipmapsPriority: 0
  vTOnly: 0
  ignoreMipmapLimit: 0
  grayScaleToAlpha: 0
  generateCubemap: 6
  cubemapConvolution: 0
  seamlessCubemap: 0
  textureFormat: 1
  maxTextureSize: 2048
  textureSettings:
    serializedVersion: 2
    filterMode: 0
    aniso: 1
    mipBias: 0
    wrapU: 1
    wrapV: 1
  nPOTScale: 0
  lightmap: 0
  compressionQuality: 50
  spriteMode: 2
  spriteExtrude: 1
  spriteMeshType: 1
  alignment: 0
  spritePivot: {x: 0.5, y: 0.5}
  spritePixelsToUnits: 100
  spriteBorder: {x: 0, y: 0, z: 0, w: 0}
  spriteGenerateFallbackPhysicsShape: 1
  alphaUsage: 1
  alphaIsTransparency: 1
  spriteTessellationDetail: -1
  textureType: 8
  textureShape: 1
  singleChannelComponent: 0
  flipbookRows: 1
  flipbookColumns: 1
  maxTextureSizeSet: 0
  compressionQualitySet: 0
  textureFormatSet: 0
  ignoreMipmapLimitSet: 0
  applyGammaDecoding: 0
  swizzle: 0
  cookieLightType: 0
  platformSettings:
  - serializedVersion: 3
    buildTarget: DefaultTexturePlatform
    maxTextureSize: 2048
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 1
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
    ignorePlatformSupport: 0
    androidETC2FallbackOverride: 0
    forceMaximumCompressionQuality_Bakery: 0
  spriteSheet:
    serializedVersion: 2
    sprites:
${sprites.join("\n")}
    nameFileIdTable:
${nameTable.join("\n")}
  mipmapLimitGroupName:
  pSDRemoveMatte: 0
  userData:
  assetBundleName:
  assetBundleVariant:
`;
}

/* --- Unity: Editor builder script (plain text asset, written like any
 * editor tool: menu click -> slice from sidecar -> build clips by name) --- */
const UNITY_BUILDER_CS = `// FrameLabAnimBuilder.cs
// Generated by m4ster FrameLab (https://m4ster-framelab.vercel.app).
// Drop this file into any Editor folder in your Unity project, keep it next
// to the FrameLab pack (sheet PNG + framelab-unity.json), then run:
//   FrameLab > Build Animation Clips
// It slices the sheet from the sidecar data and creates one .anim clip per
// animation, plus a ready AnimatorController. Sprites are resolved by name
// inside the editor, so references can never arrive broken.

using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public static class FrameLabAnimBuilder
{
    [System.Serializable]
    private class RectJ { public int x; public int y; public int w; public int h; }

    [System.Serializable]
    private class AnimJ { public string name; public float fps; public bool loop; public RectJ[] rects; }

    [System.Serializable]
    private class PackJ { public string texture; public int width; public int height; public AnimJ[] animations; }

    [MenuItem("FrameLab/Build Animation Clips")]
    public static void Build()
    {
        string jsonPath = FindSidecar();
        if (jsonPath == null)
        {
            EditorUtility.DisplayDialog("FrameLab", "framelab-unity.json not found in the project.", "OK");
            return;
        }

        string dir = Path.GetDirectoryName(jsonPath).Replace("\\\\", "/");
        var pack = JsonUtility.FromJson<PackJ>(File.ReadAllText(jsonPath));
        string texPath = dir + "/" + pack.texture;
        var importer = AssetImporter.GetAtPath(texPath) as TextureImporter;
        if (importer == null)
        {
            EditorUtility.DisplayDialog("FrameLab", "Sheet texture not found next to the sidecar: " + texPath, "OK");
            return;
        }

        // Slice the sheet exactly as the sidecar says. Unity rects are
        // bottom-up, FrameLab rects are top-down, so y flips here.
        importer.textureType = TextureImporterType.Sprite;
        importer.spriteImportMode = SpriteImportMode.Multiple;
        importer.filterMode = FilterMode.Point;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        var metas = new List<SpriteMetaData>();
        foreach (var anim in pack.animations)
        {
            for (int i = 0; i < anim.rects.Length; i++)
            {
                var r = anim.rects[i];
                metas.Add(new SpriteMetaData
                {
                    name = anim.name + "_" + i,
                    rect = new Rect(r.x, pack.height - r.y - r.h, r.w, r.h),
                    alignment = (int)SpriteAlignment.Custom,
                    pivot = new Vector2(0.5f, 0f)
                });
            }
        }
        importer.spritesheet = metas.ToArray();
        importer.SaveAndReimport();

        var sprites = new Dictionary<string, Sprite>();
        foreach (var obj in AssetDatabase.LoadAllAssetsAtPath(texPath))
        {
            var spr = obj as Sprite;
            if (spr != null) sprites[spr.name] = spr;
        }

        string animDir = dir + "/Animations";
        if (!AssetDatabase.IsValidFolder(animDir))
            AssetDatabase.CreateFolder(dir, "Animations");

        string controllerPath = animDir + "/FrameLab.controller";
        if (File.Exists(controllerPath)) AssetDatabase.DeleteAsset(controllerPath);
        var controller = AnimatorController.CreateAnimatorControllerAtPath(controllerPath);
        var stateMachine = controller.layers[0].stateMachine;
        AnimatorState firstState = null;

        foreach (var anim in pack.animations)
        {
            var keys = new List<ObjectReferenceKeyframe>();
            for (int i = 0; i < anim.rects.Length; i++)
            {
                Sprite spr;
                if (!sprites.TryGetValue(anim.name + "_" + i, out spr)) continue;
                keys.Add(new ObjectReferenceKeyframe { time = i / anim.fps, value = spr });
            }
            if (keys.Count == 0) continue;
            // terminal keyframe: hold the last sprite for its full slot
            keys.Add(new ObjectReferenceKeyframe
            {
                time = anim.rects.Length / anim.fps,
                value = keys[keys.Count - 1].value
            });

            var clip = new AnimationClip { frameRate = anim.fps };
            var settings = AnimationUtility.GetAnimationClipSettings(clip);
            settings.loopTime = anim.loop;
            AnimationUtility.SetAnimationClipSettings(clip, settings);
            var binding = new EditorCurveBinding
            {
                type = typeof(SpriteRenderer),
                path = "",
                propertyName = "m_Sprite"
            };
            AnimationUtility.SetObjectReferenceCurve(clip, binding, keys.ToArray());
            string clipPath = animDir + "/" + anim.name + ".anim";
            if (File.Exists(clipPath)) AssetDatabase.DeleteAsset(clipPath);
            AssetDatabase.CreateAsset(clip, clipPath);

            var state = stateMachine.AddState(anim.name);
            state.motion = clip;
            if (firstState == null) firstState = state;
        }
        if (firstState != null) stateMachine.defaultState = firstState;

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        EditorUtility.DisplayDialog("FrameLab",
            "Built " + pack.animations.Length + " animation clip(s) + FrameLab.controller in " + animDir, "OK");
    }

    private static string FindSidecar()
    {
        string[] guids = AssetDatabase.FindAssets("framelab-unity");
        foreach (var guid in guids)
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            if (path.EndsWith("framelab-unity.json")) return path;
        }
        return null;
    }
}
`;

const GODOT_README = `m4ster FrameLab — Godot pack
============================

Files:
- m4ster-sprite-sheet.png   the sprite sheet
- animations.tres           a Godot 4 SpriteFrames resource (every animation, fps + loop set)

Use it:
1. Copy both files into your Godot project (keep them in the same folder).
2. Add an AnimatedSprite2D node.
3. In the Inspector, set its Sprite Frames to animations.tres
   (click the Sprite Frames field > Load > pick the file).
4. Pick an animation in the editor and press play, or from code:
       $AnimatedSprite2D.play("walk")

If you move the PNG, open animations.tres in a text editor and fix the
path on the [ext_resource ...] line so it points at the PNG
(res:// = your project root).
`;

const UNITY_README = `m4ster FrameLab — Unity pack
============================

Files:
- m4ster-sprite-sheet.png        the sprite sheet (arrives pre-sliced via the .meta)
- m4ster-sprite-sheet.png.meta   texture importer data with every frame sliced
- framelab-unity.json            sidecar data (frame rects, fps, loop per animation)
- FrameLabAnimBuilder.cs         editor script that builds the .anim clips

Use it:
1. Copy all four files into your Unity project's Assets (same folder).
   Keep FrameLabAnimBuilder.cs inside a folder named "Editor".
2. In Unity, run the menu:  FrameLab > Build Animation Clips
3. You get one .anim per animation + FrameLab.controller in an
   "Animations" folder next to the sheet. Put a SpriteRenderer +
   Animator on your character, assign the controller, done.

Why a builder script? Raw .anim files reference sprites by internal IDs
that only Unity can assign. The script resolves sprites by name inside
the editor, so clips can never arrive with "Missing (Sprite)".
`;

async function downloadGodotPack() {
  if (!state.atlas) return;
  const m = state.atlas.manifest, pngName = state.atlas.pngName;
  const png = await fileBytes(state.atlas.canvas);
  await downloadZip("m4ster-framelab-godot.zip", [
    { name: pngName, data: png },
    { name: "animations.tres", data: godotTres(m, pngName) },
    { name: "README-godot.txt", data: GODOT_README }
  ]);
  stageMsg("Godot pack downloaded — unzip into your project, point an AnimatedSprite2D at animations.tres.");
}

async function downloadUnityPack() {
  if (!state.atlas) return;
  const m = state.atlas.manifest, pngName = state.atlas.pngName;
  const guid = Array.from({ length: 32 }, () => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");
  const png = await fileBytes(state.atlas.canvas);
  await downloadZip("m4ster-framelab-unity.zip", [
    { name: pngName, data: png },
    { name: pngName + ".meta", data: unityMeta(m, guid) },
    { name: "framelab-unity.json", data: unitySidecar(m, pngName) },
    { name: "FrameLabAnimBuilder.cs", data: UNITY_BUILDER_CS },
    { name: "README-unity.txt", data: UNITY_README }
  ]);
  stageMsg("Unity pack downloaded — unzip into Assets, then run FrameLab > Build Animation Clips.");
}
/* ================= procedural (offline) generators =================
 * Seeded pixel-art mode: palette-locked, selective outline, binary alpha.
 * Zero network. Deterministic: same seed -> same pixels. */

function px(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/* dark outline around the silhouette: any transparent pixel touching ink */
function selectiveOutline(canvas, color) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const mark = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] !== 0) continue;
      const n = (nx, ny) => nx >= 0 && ny >= 0 && nx < w && ny < h && d[(ny * w + nx) * 4 + 3] > 0;
      if (n(x - 1, y) || n(x + 1, y) || n(x, y - 1) || n(x, y + 1)) mark.push(i);
    }
  }
  const c = hexRGB(color);
  for (const i of mark) { d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
}

function hexRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* limb from pivot: angle 0 = down, positive swings forward. returns endpoint */
function limb(ctx, x0, y0, len, angDeg, w, color) {
  const a = (angDeg * Math.PI) / 180;
  const dx = Math.sin(a), dy = Math.cos(a);
  ctx.fillStyle = color;
  for (let i = 0; i <= len; i++) {
    ctx.fillRect(Math.round(x0 + dx * i - w / 2), Math.round(y0 + dy * i), w, 1);
  }
  return [x0 + dx * len, y0 + dy * len];
}

/* procedural palettes: 4 named sets shared by every offline generator.
 * jitter keeps repeats from looking stamped; same seed -> same pixels. */
const PROC_PALETTES = {
  classic: { skin: ["#f2c69b", "#e0a878", "#c98a5b", "#a96f45"], hue: 210, accent: 45 },
  ember:   { skin: ["#f0b489", "#d99668", "#b57a4e", "#8f5c38"], hue: 12,  accent: 48 },
  frost:   { skin: ["#f6d7b8", "#e8b98f", "#cfa06f", "#a87f52"], hue: 200, accent: 185 },
  toxic:   { skin: ["#cfe8a8", "#a8d47e", "#7fb85a", "#5c9440"], hue: 95,  accent: 300 },
  royal:   { skin: ["#f2c69b", "#e0a878", "#c98a5b", "#a96f45"], hue: 265, accent: 45 },
  shadow:  { skin: ["#b8bcc4", "#9aa0ab", "#7c828e", "#5f646e"], hue: 230, accent: 350 },
};

function procPalette(name, rng) {
  const P = PROC_PALETTES[name] || PROC_PALETTES.classic;
  const hue = (((P.hue + (((rng() * 24) | 0) - 12)) % 360) + 360) % 360;
  return {
    skin: P.skin[(rng() * P.skin.length) | 0],
    cloth: `hsl(${hue},55%,52%)`,
    clothD: `hsl(${hue},55%,36%)`,
    pants: `hsl(${(hue + 40) % 360},25%,30%)`,
    accent: `hsl(${P.accent},75%,58%)`,
    dark: "#141414",
  };
}

const SKIN = ["#f2c69b", "#e0a878", "#c98a5b", "#a96f45"]; // legacy alias, kept for compat

function procCharacter(p, stateName, seedNum) {
  const arch = p.archetype || "biped";
  if (arch === "quadruped") return procQuadruped(p, stateName, seedNum);
  if (arch === "flyer")     return procFlyer(p, stateName, seedNum);
  if (arch === "slime")     return procSlime(p, stateName, seedNum);
  if (arch === "robot")     return procRobot(p, stateName, seedNum);
  if (arch === "ghost")     return procGhost(p, stateName, seedNum);
  return procBiped(p, stateName, seedNum);
}

function procBiped(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919);
  const count = p.frames;
  const W = 32, H = 44, S = 4;
  const pal = procPalette(p.palette, rng);
  const skin = pal.skin, shirt = pal.cloth, shirtD = pal.clothD, pants = pal.pants;
  const hairC = ["#2b2b2b", "#5a3a22", "#8a5a2b", "#d8d8d8"][(rng() * 4) | 0];
  const hairStyle = (rng() * 3) | 0; // 0 flat top, 1 sideburns, 2 mohawk

  const strip = makeCanvas(W * count * S, H * S);

  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let bob = 0, legL = 0, legR = 0, armL = 8, armR = 8, lean = 0;

    if (stateName === "walk")      { legL = Math.sin(ph) * 32; legR = -Math.sin(ph) * 32; armL = -Math.sin(ph) * 26; armR = Math.sin(ph) * 26; bob = Math.abs(Math.sin(ph)); }
    else if (stateName === "run")  { legL = Math.sin(ph) * 52; legR = -Math.sin(ph) * 52; armL = -Math.sin(ph) * 45; armR = Math.sin(ph) * 45; bob = Math.abs(Math.sin(ph)) * 2; lean = 3; }
    else if (stateName === "jump") {
      const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI); // crouch -> apex -> land
      bob = Math.round(air * 4) - ((k < 0.25 || k > 0.75) ? 1 : 0);
      legL = Math.round(-15 - air * 40); legR = Math.round(10 + air * 20);
      armL = Math.round(-40 - air * 100); armR = Math.round(-60 - air * 100);
      lean = Math.round(air * 2);
    }
    else if (stateName === "attack") {
      const k = f / Math.max(1, count - 1);           // windup -> strike
      armR = -60 + k * 130; legL = 25; legR = -20; lean = k * 4; bob = 1;
    }
    else { bob = (f % 2); armL = 6 + Math.sin(ph) * 4; armR = 6 - Math.sin(ph) * 4; } // idle

    const Y = (y) => y - Math.round(bob);

    // far limbs first (darker), then body, then near limbs
    limb(ctx, 13, Y(24), 12, legR * 0.9, 4, pants);
    limb(ctx, 9, Y(15), 9, armL, 3, shirtD);
    // head + hair
    px(ctx, 11, Y(4), 10, 9, skin);
    px(ctx, 10, Y(2), 12, 4, hairC);
    if (hairStyle === 1) { px(ctx, 10, Y(5), 2, 6, hairC); px(ctx, 20, Y(5), 2, 6, hairC); }
    else if (hairStyle === 2) { px(ctx, 15, Y(0), 2, 3, hairC); }
    px(ctx, 14, Y(8), 1, 2, "#1a1a1a"); px(ctx, 17, Y(8), 1, 2, "#1a1a1a");
    // torso + belt
    px(ctx, 10 + lean * 0.2, Y(14), 12, 9, shirt);
    px(ctx, 10, Y(22), 12, 2, "#333");
    // near limbs
    const [hx, hy] = limb(ctx, 19, Y(24), 12, legL, 4, pants);
    px(ctx, hx - 2, hy, 5, 2, "#222");                       // boot
    const [ax, ay] = limb(ctx, 23, Y(15), 9, armR, 3, shirt);
    px(ctx, Math.round(ax) - 1, Math.round(ay), 3, 3, skin); // hand
    if (stateName === "attack") {
      const [sx, sy] = limb(ctx, ax, ay, 12, armR, 2, "#cfd6dd"); // sword
      if (f > 0 && f < count - 1) px(ctx, sx - 1, sy - 1, 3, 3, "#fff8c9"); // strike spark
    }

    selectiveOutline(cell, "#141414");

    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* quadruped: horizontal body, diagonal leg pairs, tail wag. faces right. */
function procQuadruped(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 101);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 44, H = 32, S = 4;
  const fur = pal.cloth, furD = pal.clothD, belly = pal.skin;
  // visible per-seed variant (drawn once per generation — same across all frames)
  const earH = 3 + ((rng() * 3) | 0);
  const tailLen = 8 + ((rng() * 5) | 0);
  const spots = rng() < 0.5;
  const strip = makeCanvas(W * count * S, H * S);
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let bob = 0, lunge = 0, headDy = 0;
    let sw = [0, 0, 0, 0]; // [frontL, frontR, backL, backR]
    if (stateName === "walk")      { const a = Math.sin(ph) * 28; sw = [a, -a, -a, a]; bob = Math.abs(Math.sin(ph)); }
    else if (stateName === "run")  { const a = Math.sin(ph) * 46; sw = [a, -a, -a, a]; bob = Math.abs(Math.sin(ph)) * 2; lunge = 1; }
    else if (stateName === "jump") {
      const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI);
      const tuck = Math.round(air * 40);
      sw = [-tuck, -tuck, tuck, tuck];
      bob = Math.round(air * 4);
      headDy = Math.round(-air * 2);
    }
    else if (stateName === "attack") { const k = f / Math.max(1, count - 1); lunge = Math.round(k * 5); headDy = Math.round(k * 4); sw = [20, 20, -15, -15]; }
    else { bob = (f % 2); headDy = Math.round(Math.sin(ph)); }
    const Y = (y) => y - Math.round(bob);
    const legX = [15, 21, 27, 33];
    limb(ctx, legX[1], Y(22), 8, sw[1] * 0.9, 3, furD);   // far legs first
    limb(ctx, legX[3], Y(22), 8, sw[3] * 0.9, 3, furD);
    limb(ctx, 10, Y(14), tailLen, -35 + Math.sin(ph * 2) * 12, 3, furD); // tail wag
    px(ctx, 12 + lunge, Y(11), 22, 10, fur);               // body
    px(ctx, 12 + lunge, Y(18), 22, 3, belly);              // belly
    px(ctx, 12 + lunge, Y(11), 22, 2, furD);               // back ridge
    if (spots) { px(ctx, 16 + lunge, Y(12), 5, 3, furD); px(ctx, 25 + lunge, Y(15), 4, 3, furD); } // spots
    px(ctx, 32 + lunge, Y(5) + headDy, 9, 9, fur);         // head
    px(ctx, 33 + lunge, Y(3) + headDy - (earH - 3), 4, earH, furD); // ear
    px(ctx, 37 + lunge, Y(8) + headDy, 2, 2, "#1a1a1a");   // eye
    px(ctx, 40 + lunge, Y(10) + headDy, 2, 2, "#1a1a1a");  // nose
    limb(ctx, legX[0], Y(22), 8, sw[0], 3, fur);          // near legs
    const [hx, hy] = limb(ctx, legX[2], Y(22), 8, sw[2], 3, fur);
    px(ctx, Math.round(hx) - 2, Math.round(hy), 5, 2, "#222");
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* flyer/bird: side view, one big flapping wing. faces right. */
function procFlyer(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 202);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 36, H = 36, S = 4;
  const body = pal.cloth, bodyD = pal.clothD;
  // visible per-seed variant (drawn once per generation — same across all frames)
  const beakC = ["#f5a623", "#e2574c", "#4dd07c", "#7c9aff"][(rng() * 4) | 0];
  const crestOn = rng() < 0.65;
  const wingLen = 12 + ((rng() * 4) | 0);
  const tailN = 2 + ((rng() * 2) | 0);
  const footC = ["#d98a2b", "#8a5a2b", "#6b7280"][(rng() * 3) | 0];
  const strip = makeCanvas(W * count * S, H * S);
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let flapSpeed = 1, flapAmp = 30, bobA = 1, lean = 0, dive = 0;
    if (stateName === "walk")        { flapSpeed = 3; flapAmp = 55; bobA = 2; }
    else if (stateName === "run")   { flapSpeed = 3; flapAmp = 65; bobA = 2; lean = 2; }
    else if (stateName === "jump")  { flapAmp = 70; bobA = 3; }
    else if (stateName === "attack") { dive = 1; flapAmp = 75; lean = 4; }
    const flap = Math.sin(ph * flapSpeed) * flapAmp;
    const bob = Math.abs(Math.sin(ph * flapSpeed)) * bobA;
    const Y = (y) => y - Math.round(bob) + (dive ? 4 : 0);
    limb(ctx, 16, Y(16), 10, -40 - flap * 0.7, 3, bodyD);  // far wing
    for (let t = 0; t < tailN; t++) limb(ctx, 10, Y(20), 8, 50 + t * 18, 3, bodyD); // tail feathers
    px(ctx, 12 + lean, Y(14), 13, 11, body);              // body
    px(ctx, 12 + lean, Y(22), 13, 3, bodyD);
    px(ctx, 23 + lean, Y(10), 8, 8, body);                // head
    px(ctx, 30 + lean, Y(12), 4, 3, beakC);               // beak
    px(ctx, 26 + lean, Y(12), 2, 2, "#1a1a1a");           // eye
    if (crestOn) px(ctx, 24 + lean, Y(7), 2, 3, pal.accent); // crest
    const [wx, wy] = limb(ctx, 17 + lean, Y(15), wingLen, -55 - flap, 4, body); // near wing
    px(ctx, Math.round(wx) - 2, Math.round(wy) - 1, 5, 3, bodyD);
    px(ctx, 16 + lean, Y(26), 3, 2, footC);               // tucked feet
    px(ctx, 21 + lean, Y(26), 3, 2, footC);
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* slime/blob: squash & stretch. the hop IS the walk cycle. */
function procSlime(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 303);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 36, H = 32, S = 4;
  const goo = pal.cloth, gooL = pal.accent;
  // visible per-seed variant (drawn once per generation — same across all frames)
  const eyeStyle = (rng() * 3) | 0;   // 0 round, 1 angry, 2 happy
  const drips = (rng() * 3) | 0;      // 0..2 side drips
  const shineDX = -2 + ((rng() * 5) | 0);
  const strip = makeCanvas(W * count * S, H * S);
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let bw = 24, bh = 18, yOff = 0, xOff = 0;
    if (stateName === "idle")      { const s = Math.sin(ph); bh += Math.round(s); bw -= Math.round(s); }
    else if (stateName === "walk") { const a = Math.abs(Math.sin(ph)); yOff = -Math.round(a * 6); bh += Math.round(a * 4); bw -= Math.round(a * 3); }
    else if (stateName === "run")  { const a = Math.abs(Math.sin(ph)); yOff = -Math.round(a * 8); bh += Math.round(a * 5); bw -= Math.round(a * 4); }
    else if (stateName === "jump") { const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI); yOff = -Math.round(air * 8); bh += Math.round(air * 5); bw -= Math.round(air * 3); }
    else if (stateName === "attack") { const k = f / Math.max(1, count - 1); bw += Math.round(k * 8); xOff = Math.round(k * 5); bh -= Math.round(k * 2); }
    const cx = 18 + xOff, baseY = 28 + yOff - bh;
    px(ctx, cx - bw / 2 + 2, baseY + 3, bw - 4, bh - 3, goo);
    px(ctx, cx - bw / 2, baseY + 6, bw, bh - 6, goo);
    px(ctx, cx - bw / 2 + 2, baseY, bw - 4, 6, gooL);
    px(ctx, cx + shineDX, baseY + 2, 3, 3, "#ffffff");
    for (let d = 0; d < drips; d++) px(ctx, cx - bw / 2 - 2 - d * 3, baseY + 8 + d * 4, 2, 4, goo); // side drips
    const ey = baseY + 8;
    if (eyeStyle === 2) { // happy ^ ^
      px(ctx, cx - 7, ey + 1, 4, 2, "#1a1a1a"); px(ctx, cx + 3, ey + 1, 4, 2, "#1a1a1a");
    } else if (eyeStyle === 1) { // angry
      px(ctx, cx - 8, ey - 2, 6, 2, "#1a1a1a"); px(ctx, cx + 2, ey - 2, 6, 2, "#1a1a1a");
      px(ctx, cx - 7, ey + 1, 4, 4, "#ffffff"); px(ctx, cx + 3, ey + 1, 4, 4, "#ffffff");
      px(ctx, cx - 6, ey + 2, 2, 2, "#1a1a1a"); px(ctx, cx + 4, ey + 2, 2, 2, "#1a1a1a");
    } else { // round
      px(ctx, cx - 7, ey, 4, 5, "#ffffff"); px(ctx, cx + 3, ey, 4, 5, "#ffffff");
      px(ctx, cx - 6, ey + 2, 2, 2, "#1a1a1a"); px(ctx, cx + 4, ey + 2, 2, 2, "#1a1a1a");
    }
    if (stateName === "attack") px(ctx, cx - 4, ey + 7, 8, 2, "#1a1a1a");
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* ghost: floating sheet body, wavy hem, never touches the ground.
 * Every state is a drift — bob, sway, stretch — instead of steps. */
function procGhost(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 607);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 36, H = 40, S = 4;
  const body = "#e9edf5", shade = "#c3ccd9";
  const glow = pal.accent;
  const eyeStyle = (rng() * 2) | 0; // 0 round dark, 1 glowing
  const strip = makeCanvas(W * count * S, H * S);
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let yOff = Math.round(Math.sin(ph) * 2), xOff = 0, stretch = 0, lean = 0;
    if (stateName === "walk")       { yOff = -2 + Math.round(Math.sin(ph) * 2); xOff = Math.round(Math.sin(ph) * 1); }
    else if (stateName === "run")   { yOff = -3 + Math.round(Math.sin(ph * 2) * 1); lean = 2; }
    else if (stateName === "jump")  { const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI); yOff = -Math.round(air * 7); stretch = Math.round(air * 3); }
    else if (stateName === "attack") { const k = f / Math.max(1, count - 1); xOff = Math.round(Math.sin(k * Math.PI) * 6); }
    const cx = 18 + xOff, top = 6 + yOff, bw = 22, bh = 24 + stretch;
    // sheet body: dome rows narrowing at the top, straight sides
    px(ctx, cx - bw / 2 + 6 + lean, top, bw - 12, 4, body);
    px(ctx, cx - bw / 2 + 3 + lean, top + 4, bw - 6, 4, body);
    px(ctx, cx - bw / 2, top + 8, bw, bh - 8, body);
    px(ctx, cx - bw / 2, top + 8, 4, bh - 8, shade); // left shading
    // wavy hem: three scallops, phase-shifted per frame so it ripples
    for (let sIdx = 0; sIdx < 3; sIdx++) {
      const hx = cx - bw / 2 + 1 + sIdx * 7;
      const dip = 2 + Math.round(Math.sin(ph + sIdx * 2.1) * 1.5);
      px(ctx, hx, top + bh, 6, dip, body);
      px(ctx, hx, top + bh, 2, dip, shade);
    }
    // stub arms — out to the sides, forward on attack
    const armY = top + 13;
    if (stateName === "attack") {
      px(ctx, cx + bw / 2 - 1, armY, 7, 3, body);
      px(ctx, cx - bw / 2 - 6, armY + 2, 7, 3, body);
    } else {
      px(ctx, cx - bw / 2 - 4, armY + Math.round(Math.sin(ph) * 1), 5, 3, body);
      px(ctx, cx + bw / 2 - 1, armY - Math.round(Math.sin(ph) * 1), 5, 3, body);
    }
    // face
    const ey = top + 11, ex = cx + lean;
    if (eyeStyle === 1) {
      px(ctx, ex - 7, ey, 4, 5, glow); px(ctx, ex + 3, ey, 4, 5, glow);
    } else {
      px(ctx, ex - 7, ey, 4, 5, "#232733"); px(ctx, ex + 3, ey, 4, 5, "#232733");
    }
    if (stateName === "attack") px(ctx, ex - 2, ey + 8, 5, 6, "#232733"); // open wail mouth
    else px(ctx, ex - 1, ey + 8, 3, 4, "#232733");
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* robot: blocky, rigid servo angles (quantized to 15°), blinking visor. */
function procRobot(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 404);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 32, H = 44, S = 4;
  const metalHue = (rng() * 360) | 0;
  const metal = `hsl(${metalHue},12%,62%)`, metalD = `hsl(${metalHue},12%,45%)`, joint = `hsl(${metalHue},10%,28%)`;
  // visible per-seed variant (drawn once per generation — same across all frames)
  const visorC = ["#ff3b30", "#34e07c", "#4da6ff", "#ffd60a"][(rng() * 4) | 0];
  const antennaOn = rng() < 0.7;
  const chestC = rng() < 0.5 ? pal.accent : visorC;
  const strip = makeCanvas(W * count * S, H * S);
  const quant = (a) => Math.round(a / 15) * 15;
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let legL = 0, legR = 0, armL = 10, armR = 10, bob = 0, cannon = false;
    if (stateName === "walk")      { legL = quant(Math.sin(ph) * 30); legR = -legL; armL = quant(-legL * 0.8); armR = quant(-legR * 0.8); bob = Math.abs(Math.sin(ph)) > 0.5 ? 1 : 0; }
    else if (stateName === "run")  { legL = quant(Math.sin(ph) * 45); legR = -legL; armL = -legL; armR = -legR; bob = 1; }
    else if (stateName === "jump") {
      const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI);
      legL = Math.round(-15 - air * 35); legR = Math.round(10 + air * 25);
      armL = Math.round(-40 - air * 80); armR = Math.round(-60 - air * 80);
      bob = Math.round(air * 4);
    }
    else if (stateName === "attack") { cannon = true; armR = 90; legL = 15; legR = -15; }
    else { armL = 8 + Math.sin(ph) * 3; armR = 8 - Math.sin(ph) * 3; }
    const Y = (y) => y - bob;
    for (const [hx, ang, col] of [[13, legL, metalD], [19, legR, metal]]) {
      const [kx, ky] = limb(ctx, hx, Y(26), 7, quant(ang), 4, joint);
      const [fx, fy] = limb(ctx, kx, ky, 7, quant(ang * 0.4), 4, col);
      px(ctx, Math.round(fx) - 2, Math.round(fy), 5, 2, "#222");
    }
    px(ctx, 10, Y(14), 12, 11, metal);
    px(ctx, 10, Y(14), 12, 2, metalD);
    px(ctx, 14, Y(18), 4, 4, chestC);
    px(ctx, 11, Y(4), 10, 8, metal);
    const visorOn = !(stateName === "idle" && f % 4 === 3);
    px(ctx, 12, Y(6), 8, 3, visorOn ? visorC : joint);
    if (antennaOn) {
      px(ctx, 15, Y(2), 2, 2, joint);
      px(ctx, 15, Y(0), 2, 2, (f % 2) ? visorC : joint);
    }
    for (const [sx, ang] of [[9, armL], [23, armR]]) {
      const [ex, ey] = limb(ctx, sx, Y(15), 7, quant(ang), 4, joint);
      limb(ctx, ex, ey, 6, quant(ang * 0.6), 4, metal);
    }
    if (cannon) {
      limb(ctx, 23, Y(15), 12, 90, 5, metalD);
      px(ctx, 30, Y(13), 4, 5, visorC);
      if (f % 2 === 0) px(ctx, 34, Y(12), 3, 7, "#fff8c9");
    }
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* wrapped drawing helper: features drawn at 9 offsets tile seamlessly */
function wrapped(ctx, s, fn) {
  for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
    ctx.save(); ctx.translate(ox, oy); fn(); ctx.restore();
  }
}

const TILE_PATTERNS = ["grass", "sand", "stone", "brick", "wood", "metal", "water", "dungeon", "lava", "snow"];

/* returns an ARRAY of canvases (water shimmers: 2 frames, everything else 1) */
function procTile(pattern, size, seedNum) {
  const frames = (pattern === "water" || pattern === "lava") ? 2 : 1;
  const out = [];
  for (let fr = 0; fr < frames; fr++) {
    const rng = mulberry32(seedNum + fr * 131);
    const S = 32;
    const base = makeCanvas(S, S);
    const ctx = base.getContext("2d");
    const R = (a, b) => a + rng() * (b - a);

    if (pattern === "grass") {
      px(ctx, 0, 0, S, S, "#4d9247");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 26; i++) px(ctx, R(0, S), R(0, S), 1, 1, rng() < 0.5 ? "#3d7a3a" : "#5fa855");
        for (let i = 0; i < 6; i++) { const x = R(2, S - 2), y = R(2, S - 2); px(ctx, x, y - 2, 1, 3, "#35702f"); px(ctx, x + 1, y - 1, 1, 2, "#35702f"); }
      });
    } else if (pattern === "sand") {
      px(ctx, 0, 0, S, S, "#d9b77c");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 30; i++) px(ctx, R(0, S), R(0, S), 1, 1, rng() < 0.5 ? "#c4a05e" : "#e8cb8f");
        for (let i = 0; i < 5; i++) { const x = R(2, S - 3), y = R(2, S - 3); px(ctx, x, y, 2, 2, "#b8935a"); px(ctx, x, y, 1, 1, "#e8cb8f"); }
      });
    } else if (pattern === "brick") {
      px(ctx, 0, 0, S, S, "#5c6068"); // mortar bed
      const bh = 8, bw = 16;
      for (let row = 0; row < S / bh; row++) {
        const off = row % 2 ? bw / 2 : 0;
        for (let cx = 0; cx < S / bw; cx++) {
          const shade = 150 + ((rng() * 30) | 0);
          ctx.fillStyle = `rgb(${shade},${shade - 25},${shade - 30})`;
          // wrapped(): bricks crossing the tile edge continue on the other
          // side — without this the right edge shows cut bricks (no wrap)
          wrapped(ctx, S, () => {
            ctx.fillRect(cx * bw + off, row * bh + 1, bw - 2, bh - 2);
          });
        }
      }
    } else if (pattern === "stone") {
      px(ctx, 0, 0, S, S, "#7d8590");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 9; i++) {
          const x = R(2, S - 2), y = R(2, S - 2), n = 3 + ((rng() * 5) | 0);
          for (let k = 0; k < n; k++) px(ctx, x + R(-3, 3), y + R(-3, 3), 2, 2, "#666e78");
        }
        for (let i = 0; i < 20; i++) px(ctx, R(0, S), R(0, S), 1, 1, "#98a1ab");
      });
    } else if (pattern === "wood") {
      px(ctx, 0, 0, S, S, "#8a5a2e");
      for (let row = 0; row < S / 8; row++) {
        const y = row * 8, shade = 128 + ((rng() * 22) | 0);
        ctx.fillStyle = `rgb(${shade},${shade - 58 | 0},${shade - 96 | 0})`;
        ctx.fillRect(0, y + 1, S, 7);
        ctx.fillStyle = "#5e3c1e";
        ctx.fillRect(0, y, S, 1);                                   // plank gap (tiles: 8 | 32)
        const jx = (row * 13 + 4) % S;                             // staggered joint
        ctx.fillRect(jx, y + 1, 1, 7);
        wrapped(ctx, S, () => {
          for (let i = 0; i < 5; i++) px(ctx, R(0, S), y + 2 + R(0, 5), 3, 1, "#6e4522"); // grain
        });
      }
    } else if (pattern === "metal") {
      px(ctx, 0, 0, S, S, "#6b7280");
      for (let py = 0; py < S; py += 16) {
        for (let pxx = 0; pxx < S; pxx += 16) {
          ctx.fillStyle = "#4b5563";
          ctx.fillRect(pxx, py, 16, 1); ctx.fillRect(pxx, py, 1, 16);
          ctx.fillStyle = "#9aa3ad";
          ctx.fillRect(pxx + 1, py + 1, 14, 1);                     // top highlight
          wrapped(ctx, S, () => {
            for (const [rx, ry] of [[3, 3], [12, 3], [3, 12], [12, 12]]) {
              px(ctx, pxx + rx, py + ry, 2, 2, "#3f4750");
              px(ctx, pxx + rx, py + ry, 1, 1, "#9aa3ad");
            }
          });
        }
      }
    } else if (pattern === "water") {
      px(ctx, 0, 0, S, S, "#2b6cb0");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 7; i++) {                              // deep bands
          const y = R(0, S);
          for (let x = 0; x < S; x += 2) px(ctx, x, y + Math.sin(x / 4) * 1.5, 2, 2, "#1e4e8a");
        }
        for (let i = 0; i < 10; i++) {                             // shimmer dashes drift per frame
          const x = (R(0, S) + fr * 8) % S, y = R(0, S);
          px(ctx, x, y, 3, 1, "#7dd3fc"); px(ctx, x + 1, y - 1, 1, 1, "#e0f2fe");
        }
      });
    } else if (pattern === "lava") {
      px(ctx, 0, 0, S, S, "#2e2320");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 10; i++) px(ctx, R(0, S), R(0, S), R(2, 5), R(2, 4), "#241a17"); // basalt blotches
        // glowing cracks: short random walks; frame 2 burns brighter
        const hot = fr === 1 ? "#ffd23f" : "#ff7b1c";
        for (let i = 0; i < 4; i++) {
          let x = R(0, S), y = R(0, S);
          for (let k = 0; k < 9; k++) {
            px(ctx, x, y, 2, 1, "#ff9a3c");
            px(ctx, x, y, 1, 1, hot);
            x += R(-3, 3); y += R(-2, 2);
          }
        }
        for (let i = 0; i < 6; i++) px(ctx, R(0, S), R(0, S), 1, 1, "#57443a");
      });
    } else if (pattern === "snow") {
      px(ctx, 0, 0, S, S, "#e8eef5");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 7; i++) px(ctx, R(0, S), R(0, S), R(3, 6), R(1, 2), "#f7fafc"); // soft drifts
        for (let i = 0; i < 9; i++) px(ctx, R(0, S), R(0, S), R(2, 4), 1, "#ccd9e6");          // shadowed dips
        for (let i = 0; i < 12; i++) px(ctx, R(0, S), R(0, S), 1, 1, "#ffffff");               // sparkle
      });
    } else { // dungeon
      px(ctx, 0, 0, S, S, "#3b404d");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 4; i++) {
          let x = R(0, S), y = R(0, S);
          for (let k = 0; k < 8; k++) { px(ctx, x, y, 1, 1, "#22262f"); x += R(-3, 3); y += R(-3, 3); }
        }
        for (let i = 0; i < 14; i++) px(ctx, R(0, S), R(0, S), 1, 1, "#4c5364");
      });
    }

    const up = makeCanvas(size, size);
    const uctx = up.getContext("2d");
    uctx.imageSmoothingEnabled = false;
    uctx.drawImage(base, 0, 0, size, size);
    out.push(up);
  }
  return out;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function procUI(kind, count, seedNum) {
  const rng = mulberry32(seedNum);
  const hue = (rng() * 360) | 0;
  const small = ["icon", "coin", "gem", "heart", "star"].includes(kind);
  const W = kind === "panel" ? 176 : kind === "health" ? 160 : small ? 64 : 132;
  const H = kind === "panel" ? 128 : kind === "health" ? 48 : small ? 64 : 48;
  const strip = makeCanvas(W * count, H);

  for (let v = 0; v < count; v++) {
    const ctx = strip.getContext("2d");
    ctx.save();
    ctx.translate(v * W, 0);
    const lift = v === 1 ? 8 : v === 2 ? -10 : 0;   // hover lighter, pressed darker
    const dy = v === 2 ? 2 : 0;

    if (kind === "button") {
      const base = `hsl(${hue},55%,${50 + lift}%)`, dark = `hsl(${hue},60%,${30 + lift}%)`;
      ctx.save(); ctx.translate(0, dy);
      rr(ctx, 2, 2, W - 4, H - 4, 12);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `hsl(${hue},60%,${62 + lift}%)`); g.addColorStop(1, base);
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = dark; ctx.stroke();
      rr(ctx, 8, 7, W - 16, 8, 4); ctx.fillStyle = "rgba(255,255,255,.28)"; ctx.fill();
      // glyph: chevron
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 5; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(W / 2 - 12, H / 2 - 7); ctx.lineTo(W / 2 + 2, H / 2); ctx.lineTo(W / 2 - 12, H / 2 + 7); ctx.stroke();
      ctx.restore();
    } else if (kind === "icon") {
      const pick = (seedNum + v) % 4;
      ctx.translate(0, dy);
      rr(ctx, 2, 2, W - 4, H - 4, 14);
      ctx.fillStyle = `hsl(${hue},40%,${22 + lift}%)`; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = `hsl(${hue},70%,${55 + lift}%)`; ctx.stroke();
      ctx.fillStyle = `hsl(${hue},75%,${62 + lift}%)`;
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 5; ctx.lineCap = "round";
      const c = W / 2;
      if (pick === 0) {          // sword
        ctx.beginPath(); ctx.moveTo(c - 12, c + 12); ctx.lineTo(c + 10, c - 10); ctx.stroke();
        ctx.fillRect(c - 14, c + 6, 16, 5); ctx.fillRect(c - 4, c + 8, 5, 12);
      } else if (pick === 1) {   // shield
        ctx.beginPath(); ctx.moveTo(c, c - 16); ctx.lineTo(c + 13, c - 8); ctx.lineTo(c + 13, c + 6);
        ctx.lineTo(c, c + 16); ctx.lineTo(c - 13, c + 6); ctx.lineTo(c - 13, c - 8); ctx.closePath(); ctx.fill();
      } else if (pick === 2) {   // star
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 7 : 16;
          ctx[i ? "lineTo" : "moveTo"](c + Math.cos(a) * r, c + Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill();
      } else {                   // potion
        ctx.fillRect(c - 4, c - 16, 8, 8);
        ctx.beginPath(); ctx.moveTo(c - 11, c + 14); ctx.lineTo(c - 6, c - 8); ctx.lineTo(c + 6, c - 8); ctx.lineTo(c + 11, c + 14); ctx.closePath(); ctx.fill();
      }
    } else if (kind === "coin") {
      // spin illusion: horizontal squash oscillates 1 -> 0 -> 1
      const t = count === 1 ? 0 : v / (count - 1);
      const squash = Math.abs(Math.cos(t * Math.PI));
      const rx = 4 + 20 * squash, ry = 24, c = W / 2;
      ctx.beginPath(); ctx.ellipse(c, H / 2, rx, ry, 0, 0, 7);
      ctx.fillStyle = "#f5c542"; ctx.fill();
      ctx.beginPath(); ctx.ellipse(c, H / 2, rx * 0.66, ry * 0.66, 0, 0, 7);
      ctx.fillStyle = "#d99a26"; ctx.fill();
      if (squash > 0.4) { ctx.fillStyle = "#ffe9a8"; ctx.fillRect(c - rx * 0.4, H / 2 - 14, 5, 10); }
    } else if (kind === "gem") {
      const c = W / 2, cy = H / 2;
      ctx.beginPath();
      ctx.moveTo(c - 18, cy - 6); ctx.lineTo(c - 8, cy - 16); ctx.lineTo(c + 8, cy - 16);
      ctx.lineTo(c + 18, cy - 6); ctx.lineTo(c, cy + 16); ctx.closePath();
      ctx.fillStyle = `hsl(${hue},80%,${55 + lift}%)`; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,.4)";
      ctx.beginPath(); ctx.moveTo(c - 18, cy - 6); ctx.lineTo(c + 18, cy - 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c, cy - 16); ctx.lineTo(c, cy + 16); ctx.stroke();
      if (v % 2 === 0) { ctx.fillStyle = "#ffffff"; ctx.fillRect(c + 8, cy - 14, 6, 2); ctx.fillRect(c + 10, cy - 16, 2, 6); }
    } else if (kind === "heart") {
      const beat = 1 + (v % 2) * 0.14;
      const c = W / 2, cy = H / 2 + 2, r = 11 * beat;
      ctx.fillStyle = v === 2 ? "#b91c1c" : "#e53e3e";
      ctx.beginPath(); ctx.arc(c - r * 0.72, cy - r * 0.35, r * 0.78, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(c + r * 0.72, cy - r * 0.35, r * 0.78, 0, 7); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(c - r * 1.35, cy); ctx.lineTo(c + r * 1.35, cy); ctx.lineTo(c, cy + r * 1.5);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.beginPath(); ctx.arc(c - r * 0.72, cy - r * 0.5, r * 0.22, 0, 7); ctx.fill();
    } else if (kind === "star") {
      const c = W / 2, cy = H / 2, lit = v % 2 === 0;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? 8 : 19;
        ctx[i ? "lineTo" : "moveTo"](c + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.fillStyle = lit ? "#ffd23f" : "#d9a821"; ctx.fill();
      ctx.strokeStyle = "#8a5a00"; ctx.lineWidth = 2; ctx.stroke();
      if (lit) { ctx.fillStyle = "#ffffff"; ctx.fillRect(c + 8, cy - 14, 5, 2); ctx.fillRect(c + 10, cy - 16, 2, 5); }
    } else if (kind === "health") {
      // variants drain the bar: full -> low, green -> red
      const frac = count === 1 ? 1 : 1 - (v / (count - 1)) * 0.9;
      const bx = 6, by = 12, bw = W - 12, bh = H - 24;
      rr(ctx, bx, by, bw, bh, 8);
      ctx.fillStyle = "#1a1a1a"; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = "#444"; ctx.stroke();
      const fw = Math.max(6, (bw - 8) * frac);
      rr(ctx, bx + 4, by + 4, fw, bh - 8, 5);
      ctx.fillStyle = frac > 0.55 ? "#4ade80" : frac > 0.28 ? "#facc15" : "#ef4444";
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,.35)";
      for (let sxi = 1; sxi < 5; sxi++) ctx.fillRect(bx + (bw * sxi) / 5, by + 4, 2, bh - 8);
    } else { // panel
      ctx.translate(0, dy);
      rr(ctx, 2, 2, W - 4, H - 4, 16);
      ctx.fillStyle = `hsl(${hue},30%,${20 + lift}%)`; ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = `hsl(${hue},60%,${48 + lift}%)`; ctx.stroke();
      rr(ctx, 12, 12, W - 24, H - 24, 10);
      ctx.fillStyle = `hsl(${hue},25%,${14 + lift}%)`; ctx.fill();
      ctx.fillStyle = `hsl(${hue},70%,60%)`;
      for (const [rx, ry] of [[10, 10], [W - 10, 10], [10, H - 10], [W - 10, H - 10]]) {
        ctx.beginPath(); ctx.arc(rx, ry, 3, 0, 7); ctx.fill();
      }
    }
    ctx.restore();
  }
  return strip;
}

function procEffect(type, frames, seedNum) {
  const rng = mulberry32(seedNum);
  const S = 56;
  const strip = makeCanvas(S * frames, S);
  const cx = S / 2, cy = S / 2;

  for (let f = 0; f < frames; f++) {
    const ctx = strip.getContext("2d");
    ctx.save(); ctx.translate(f * S, 0);
    const t = frames === 1 ? 0 : f / (frames - 1);

    if (type === "explosion") {
      for (let i = 0; i < 42; i++) {
        const a = rng() * Math.PI * 2, sp = 0.35 + rng() * 0.75;
        const x = cx + Math.cos(a) * sp * t * 26, y = cy + Math.sin(a) * sp * t * 26;
        const sz = Math.max(1, (1 - t) * 5 * (0.5 + rng() * 0.5));
        ctx.fillStyle = t < 0.2 ? "#ffffff" : t < 0.45 ? "#ffd23f" : t < 0.7 ? "#ff7b1c" : t < 0.88 ? "#b3402a" : "#5c5c5c";
        ctx.globalAlpha = 1 - t * 0.55;
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
      const core = Math.max(1, (1 - t) * 14);
      ctx.fillStyle = "#fff3c4"; ctx.fillRect(cx - core / 2, cy - core / 2, core, core);
    } else if (type === "particles") {
      for (let i = 0; i < 26; i++) {
        const a = rng() * Math.PI * 2, sp = 0.4 + rng() * 0.8;
        const x = cx + Math.cos(a) * sp * t * 24, y = cy + Math.sin(a) * sp * t * 20 + t * t * 22;
        ctx.fillStyle = `hsl(${(rng() * 360) | 0},85%,60%)`;
        ctx.globalAlpha = 1 - t * 0.7;
        const sz = 2 + rng() * 3;
        ctx.fillRect(x, y, sz, sz);
      }
      ctx.globalAlpha = 1;
    } else if (type === "power-up") {
      for (let k = 0; k < 3; k++) {
        const r = 4 + t * 22 - k * 8;
        if (r <= 0) continue;
        ctx.strokeStyle = "#b8f53d";
        ctx.globalAlpha = (0.25 + 0.75 * (1 - t)) * (1 - k / 3);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 0.25 + 0.75 * Math.sin(t * Math.PI);
      ctx.fillStyle = "#ffffff";
      for (let i = 0; i < 5; i++) {
        const x = cx + (rng() - 0.5) * 36, y = cy + (rng() - 0.5) * 36;
        ctx.fillRect(x - 3, y - 1, 7, 2); ctx.fillRect(x - 1, y - 3, 2, 7);
      }
      ctx.globalAlpha = 1;
    } else if (type === "smoke") {
      for (let i = 0; i < 16; i++) {
        const life = (t + i / 16) % 1;                       // staggered puffs
        const y = cy + 18 - life * 40;
        const x = cx + Math.sin(life * 5 + i) * 8 + (rng() - 0.5) * 10;
        const sz = 4 + life * 12;
        ctx.fillStyle = "#9aa0a8";
        ctx.globalAlpha = 0.5 * (1 - life);
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
    } else if (type === "sparkle") {
      for (let i = 0; i < 14; i++) {
        const phz = (t * 2 + i * 0.37) % 1;
        const sz = Math.max(0, Math.sin(phz * Math.PI)) * 7;
        if (sz < 0.8) continue;
        const x = cx + (rng() - 0.5) * 44, y = cy + (rng() - 0.5) * 44;
        ctx.fillStyle = ["#ffffff", "#fef08a", "#bae6fd"][(rng() * 3) | 0];
        ctx.globalAlpha = 0.95;
        ctx.fillRect(x - sz / 2, y - 1, sz, 2);
        ctx.fillRect(x - 1, y - sz / 2, 2, sz);
      }
      ctx.globalAlpha = 1;
    } else if (type === "fire") {
      for (let i = 0; i < 26; i++) {
        const fx = cx + (rng() - 0.5) * 30;
        const maxH = 30 * (1 - Math.abs(fx - cx) / 22);
        const flick = 0.75 + 0.25 * Math.sin(t * 9 + i * 2.3);
        const hgt = Math.max(2, maxH * flick);
        const yTop = cy + 20 - hgt;
        const heat = hgt / 32;
        ctx.fillStyle = heat < 0.35 ? "#fff7cc" : heat < 0.6 ? "#ffd23f" : heat < 0.85 ? "#ff7b1c" : "#d63c1e";
        ctx.fillRect(fx - 2, yTop, 4, hgt);
      }
      for (let i = 0; i < 6; i++) {                          // rising embers
        const ey = cy + 18 - (((t * 1.4 + i / 6) % 1) * 44);
        ctx.fillStyle = "#ffb020";
        ctx.fillRect(cx + (rng() - 0.5) * 26, ey, 2, 2);
      }
    } else if (type === "ring") {
      for (let k = 0; k < 2; k++) {
        const rt = (t + k * 0.5) % 1;
        ctx.strokeStyle = k ? "#c084fc" : "#7df9ff";
        ctx.globalAlpha = 0.9 * (1 - rt);
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, 4 + rt * 24, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = Math.max(0, 1 - t * 3);              // core flash
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(cx - 3, cy - 3, 6, 6);
      ctx.globalAlpha = 1;
    } else if (type === "slash") {
      const ang = -70 + t * 140;                             // sweep across
      ctx.strokeStyle = "#e0f2fe"; ctx.lineWidth = 7; ctx.lineCap = "round";
      ctx.globalAlpha = 0.95;
      ctx.beginPath(); ctx.arc(cx, cy, 20, (ang - 28) * Math.PI / 180, (ang + 28) * Math.PI / 180); ctx.stroke();
      ctx.strokeStyle = "#7dd3fc"; ctx.lineWidth = 3;         // motion trail
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(cx, cy, 20, (ang - 60) * Math.PI / 180, (ang - 10) * Math.PI / 180); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (type === "heal") {
      // rising plus-signs + motes, breathing alpha: fade in, float up, fade out
      const glowA = Math.sin(t * Math.PI);
      for (let i = 0; i < 5; i++) {
        const x = cx + (rng() - 0.5) * 30, y = cy + 16 - t * 30 - rng() * 8;
        const s = 2 + ((rng() * 2) | 0);
        ctx.fillStyle = rng() > 0.4 ? "#3ddc84" : "#baffd9";
        ctx.globalAlpha = 0.35 + glowA * 0.65;
        ctx.fillRect(x - s, y - 1, s * 2 + 1, 2);
        ctx.fillRect(x - 1, y - s, 2, s * 2 + 1);
      }
      for (let i = 0; i < 12; i++) {
        const x = cx + (rng() - 0.5) * 36, y = cy + 18 - t * 34 - rng() * 6;
        ctx.fillStyle = "#eafff3";
        ctx.globalAlpha = glowA * (0.4 + rng() * 0.5);
        ctx.fillRect(x, y, 2, 2);
      }
      ctx.globalAlpha = 1;
    } else if (type === "portal") {
      // two dot-rings rotating opposite ways, swelling then settling
      const swell = Math.sin(Math.min(1, t * 1.15) * Math.PI);
      for (let ringI = 0; ringI < 2; ringI++) {
        const radius = 7 + ringI * 6 + swell * 4;
        const dots = 14 + ringI * 6;
        const dir = ringI === 0 ? 1 : -1;
        for (let i = 0; i < dots; i++) {
          const a = (i / dots) * Math.PI * 2 + dir * t * Math.PI * 3 + ringI;
          const x = cx + Math.cos(a) * radius, y = cy + Math.sin(a) * radius * 0.92;
          ctx.fillStyle = ringI === 0 ? "#c084fc" : "#7df9ff";
          ctx.globalAlpha = 0.55 + swell * 0.45;
          const sz = ringI === 0 ? 3 : 2;
          ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        }
      }
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
      ctx.globalAlpha = 1;
    } else { // magic
      for (let i = 0; i < 30; i++) {
        const sway = Math.sin(t * 6 + i) * 5;
        const x = cx + (rng() - 0.5) * 34 + sway, y = cy + 20 - t * 40 - rng() * 8;
        ctx.fillStyle = ["#7df9ff", "#c084fc", "#ffffff"][(rng() * 3) | 0];
        ctx.globalAlpha = 0.9 - t * 0.5;
        const sz = 2 + rng() * 2;
        ctx.fillRect(x, y, sz, sz);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  return strip;
}

/* ================= pipeline runner ================= */

async function genTileAI(prompt, size) {
  const bmp = await aiGenerateImage(prompt, 512, 512, (msg) => {
    setStep("row", "active", `tile gen — ${msg}`);
  });
  const full = makeCanvas(bmp.width, bmp.height);
  full.getContext("2d").drawImage(bmp, 0, 0);
  const out = makeCanvas(size, size);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(full, 0, 0, size, size);
  return out;
}

/* ---------------- v6.9: one still in, motion out ----------------
 * Asking an image model for a whole pose strip is how characters end up
 * sliced across frames. So in still mode the model draws exactly ONE
 * character; every animation row is then derived from that single drawing
 * with deterministic transforms — the character can never be cut, merged,
 * or redesigned between frames. Breathe (idle) is the same trick the
 * procedural engine uses: squash & stretch anchored at the feet. */

function buildStillPrompt(p) {
  const key = keyName();
  const flatBg = `solid flat single-color ${key} background filling the ENTIRE image edge to edge, ` +
    `absolutely no gradient, no shading, no vignette, no border, no frame, no scenery, ` +
    `no floor, no backdrop details, no decorative shape or splash behind the character — ` +
    `the character stands directly on the plain background`;
  return `2D game character sprite, ${describe("brave knight")}, ${p.style} style, ${(p.archetype || "biped")} body plan, ` +
    `ONE single character only, standing in a relaxed neutral pose, ${p.view} view, ` +
    `full body visible, feet on the same ground line, generous empty space on all sides, ` +
    `clean flat colors, bold readable silhouette, ` +
    flatBg + `, no shadows, no outline glow, no text, no watermark, game asset`;
}

/* crop a keyed canvas to its visible content, then re-pad evenly so motion
 * (lunges, falls) has headroom inside the cell */
function trimToContent(src, padFrac) {
  const w = src.width, h = src.height;
  const px = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > 12) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) fail("the AI still came back empty after keying — try another model or prompt.");
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const padX = Math.round(cw * padFrac), padY = Math.round(ch * padFrac);
  const out = makeCanvas(cw + padX * 2, ch + padY * 2);
  out.getContext("2d").drawImage(src, x0, y0, cw, ch, padX, padY, cw, ch);
  return out;
}

/* derive one animation row from the single still. Anchor is the feet
 * (bottom-center): squash, bob, lunge and fall all pivot there, so the
 * ground line never drifts. */
function animateStill(frame, sname, count) {
  /* a falling body sweeps sideways by its own height — give the death row
   * a square cell so the fall never clips at the frame edge */
  if (sname === "death" && frame.width < frame.height) {
    const S = frame.height;
    const sq = makeCanvas(S, S);
    sq.getContext("2d").drawImage(frame, (S - frame.width) / 2, S - frame.height);
    frame = sq;
  }
  const W = frame.width, H = frame.height, TAU = Math.PI * 2;
  const frames = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / count;
    const ph = t * TAU;
    let sx = 1, sy = 1, dx = 0, dy = 0, rot = 0;
    if (sname === "walk") {
      dy = -H * (0.034 * Math.abs(Math.sin(ph)) + 0.012 * Math.sin(2 * ph));
      rot = 0.05 * Math.sin(ph) + 0.016 * Math.sin(2 * ph + 1.3) + 0.012 * Math.cos(ph);
      sy = 1 + 0.02 * Math.sin(2 * ph + 0.6);
    } else if (sname === "run") {
      dy = -H * (0.055 * Math.abs(Math.sin(ph)) + 0.018 * Math.sin(2 * ph));
      rot = 0.06 + 0.05 * Math.sin(ph) + 0.02 * Math.sin(2 * ph + 1.1) + 0.014 * Math.cos(ph);
      sy = 1 + 0.028 * Math.sin(2 * ph + 0.6);
    } else if (sname === "jump") {
      const a = Math.sin(Math.PI * t);
      dy = -H * 0.20 * a;
      sy = 1 + 0.08 * a; sx = 1 - 0.04 * a;
    } else if (sname === "attack") {
      const a = Math.sin(Math.PI * Math.min(1, t * 1.35));
      dx = W * 0.14 * a; rot = 0.07 * a; sy = 1 - 0.03 * a;
    } else if (sname === "hurt") {
      const decay = 1 - t;
      dx = W * 0.03 * Math.sin(ph * 3) * decay;
      rot = 0.05 * Math.sin(ph * 3) * decay;
    } else if (sname === "death") {
      const a = t * t;
      rot = -1.45 * a; dy = H * 0.16 * a;
      sx = 1 - 0.10 * a; sy = 1 - 0.25 * a;
    } else { /* idle + anything else: breathe — two mixed frequencies plus a
     * phase-shifted bob and sway, so no two frames in the loop ever land on
     * the same pose (a lone sine repeats its values in pairs and the row
     * reads as copies) */
      sy = 1 + 0.045 * Math.sin(ph) + 0.015 * Math.sin(2 * ph + 0.7);
      sx = 1 - 0.02 * Math.sin(ph + 0.4);
      dy = -H * 0.014 * (0.5 + 0.5 * Math.sin(ph - 0.9));
      rot = 0.012 * Math.sin(ph + 0.5);
    }
    const c = makeCanvas(W, H);
    const ctx = c.getContext("2d");
    ctx.translate(W / 2 + dx, H + dy);
    ctx.rotate(rot);
    ctx.scale(sx, sy);
    ctx.drawImage(frame, -W / 2, -H);
    frames.push(c);
  }
  return frames;
}

function pushRow(name, frames, extra = {}) {
  const row = Object.assign(
    { name, frames, order: frames.map((_, i) => i), fps: 8, loop: true },
    extra
  );
  state.rows.push(row);
  state.originals.push(frames.slice());
  if (window.renderAssets) renderAssets();
}

/* status bars (v6.15): the RGB separators change colour with the pipeline —
 * rainbow while working, green on done, amber when a decision is needed,
 * red on failure. One body class drives every separator via --rgb-grad. */
function setStatusBar(s) {
  document.body.classList.remove("status-done", "status-warn", "status-error");
  if (s) document.body.classList.add("status-" + s);
}

async function runPipeline() {
  if (state.busy) return;
  setBusy(true);
  setStatusBar("");
  resetSteps();
  hideRetry();
  enableExport(false);
  state.rows = []; state.originals = []; state.atlas = null;
  state.revision = Date.now().toString(36);
  renderFramesUI();
  $("#previewMeta").textContent = "";

  const cat = state.category, p = readParams();
  const seed = (Math.random() * 1e9) | 0;

  try {
    setStep("prompt", "active");
    stageMsg("building prompt…");

    if (cat === "character") {
      if (!p.states.length) fail("select at least one animation state.");
      /* v6.9 still mode: ONE AI drawing up front, every state row derived
       * from it below — the model never gets to slice a pose strip. */
      const stillMode = state.source === "ai" && state.aiStyle === "still";
      let stillCell = null;
      if (stillMode) {
        const sPrompt = buildStillPrompt(p);
        showPromptPeek(sPrompt);
        stageMsg(`prompt [still]: ${sPrompt}`);
        setStep("prompt", "done");
        setStep("row", "active", "drawing ONE character still…");
        const bmp = await aiGenerateImage(sPrompt, 1024, 1024, (msg) => {
          setStep("row", "active", `still — ${msg}`);
        });
        const rawStill = makeCanvas(bmp.width, bmp.height);
        rawStill.getContext("2d").drawImage(bmp, 0, 0);
        showStage(rawStill, `still: raw ${bmp.width}×${bmp.height} — one drawing, every row comes from this`);
        setStep("row", "done");
        setStep("alpha", "active", "flood keying the background…");
        let keyedStill = floodKey(rawStill);
        if (hollowCenter(keyedStill) || clearedFrac(keyedStill) < 0.08) {
          // two ways keying fails: it leaked into the subject (hollow
          // middle) or it removed almost nothing (backdrop still glued on,
          // frames would bob as one rectangle). Retry with the flat
          // selected key colour; if that fails both checks too, the still
          // genuinely can't be separated — say so, don't ship scraps.
          stageMsg("first keying pass didn't separate cleanly — retrying with the flat key colour…", "warn");
          const alt = chromaKey(rawStill, state.key);
          if (!hollowCenter(alt) && clearedFrac(alt) >= 0.08) keyedStill = alt;
          else fail("Couldn't separate this character from its background — it would animate as a whole picture, not a sprite. Pick AI Horde · Deliberate or Pollinations · FLUX (harder edges), or use the AI strip mode.");
        }
        showStage(keyedStill, "still: background keyed out");
        setStep("alpha", "done");
        checkKeyCoverage(keyedStill);
        setStep("extract", "active", "lifting the character out…");
        const stillFrame = extractFramesRobust(keyedStill, 1, { align: "bottom" }).frames[0];
        stillCell = trimToContent(keepLargestBlob(stillFrame), 0.16);
        setStep("extract", "done", "one clean still — animating it in-house");
      }
      for (const sname of p.states) {
        if (stillMode) {
          setStep("row", "active", `animating [${sname}] from the still…`);
          const frames = animateStill(stillCell, sname, p.frames);
          pushRow(sname, frames, {
            fps: STATE_FPS[sname] || 8,
            loop: !["death", "jump", "attack", "hurt"].includes(sname),
            stillAnimated: true
          });
          setStep("row", "done", `[${sname}] animated from the still`);
          continue;
        }
        const prompt = buildPrompt(cat, p, sname, state.strict);
        showPromptPeek(prompt);
        stageMsg(`prompt [${sname}]: ${prompt}`);
        setStep("prompt", "done");
        setStep("row", "active", `row gen [${sname}] — one AI call, ${p.frames} poses on flat ${keyName()}…`);
        let strip;
        if (state.source === "ai") strip = await genRowAI(prompt, p.frames, 384, sname);
        else strip = procCharacter(p, sname, seed);
        showStage(strip, `row [${sname}]: raw ${strip.width}×${strip.height}`);
        setStep("row", "done");
        setStep("alpha", "active", "chroma key + despill (soft edges)…");
        const keyed = chromaKey(strip, state.key);
        showStage(keyed, `row [${sname}]: background keyed out`);
        setStep("alpha", "done");
        checkKeyCoverage(keyed);
        setStep("extract", "active", `extracting ${p.frames} poses (content-based)…`);
        const exC = extractFramesRobust(keyed, p.frames, { align: "bottom" });
        const slicedC = noteExtraction(exC, p.frames, "poses");
        pushRow(sname, exC.frames, { fps: STATE_FPS[sname] || 8, loop: true, slotSliced: slicedC });
        setStep("prompt", "active");
      }
    } else if (cat === "tile") {
      const prompt = buildPrompt(cat, p, undefined, state.strict);
      showPromptPeek(prompt);
      stageMsg("prompt: " + prompt);
      setStep("prompt", "done");
      setStep("row", "active", "generating tile…");
      let tileFrames;
      if (state.source === "ai") tileFrames = [await genTileAI(prompt, p.size)];
      else tileFrames = procTile(p.pattern, p.size, seed);
      showStage(tileFrames[0], `tile: ${p.size}×${p.size}${tileFrames.length > 1 ? ` × ${tileFrames.length} frames (animated)` : ""}, edge-to-edge (no keying)`);
      setStep("row", "done"); setStep("alpha", "done"); setStep("extract", "done");
      pushRow("tile", tileFrames, { fps: tileFrames.length > 1 ? 4 : 0, loop: tileFrames.length > 1, tileable: true });
    } else if (cat === "ui") {
      const prompt = buildPrompt(cat, p, undefined, state.strict);
      showPromptPeek(prompt);
      stageMsg("prompt: " + prompt);
      setStep("prompt", "done");
      setStep("row", "active", `generating ${p.states} UI variant(s)…`);
      let strip;
      if (state.source === "ai") strip = await genRowAI(prompt, p.states, 256, p.kind);
      else strip = procUI(p.kind, p.states, seed);
      showStage(strip, `UI row: raw ${strip.width}×${strip.height}`);
      setStep("row", "done");
      setStep("alpha", "active", "chroma key + despill…");
      const keyed = chromaKey(strip, state.key);
      showStage(keyed, "UI row: keyed");
      setStep("alpha", "done");
      checkKeyCoverage(keyed);
      setStep("extract", "active", `extracting ${p.states} variant(s)…`);
      const exU = extractFramesRobust(keyed, p.states, { align: "center" });
      const slicedU = noteExtraction(exU, p.states, "variants");
      pushRow(p.kind, exU.frames, { fps: 0, loop: false, slotSliced: slicedU });
    } else {
      const prompt = buildPrompt(cat, p, undefined, state.strict);
      showPromptPeek(prompt);
      stageMsg("prompt: " + prompt);
      setStep("prompt", "done");
      setStep("row", "active", `generating ${p.frames}-frame ${p.type}…`);
      let strip;
      if (state.source === "ai") strip = await genRowAI(prompt, p.frames, 384, p.type);
      else strip = procEffect(p.type, p.frames, seed);
      showStage(strip, `effect row: raw ${strip.width}×${strip.height}`);
      setStep("row", "done");
      setStep("alpha", "active", "chroma key + despill…");
      const keyed = chromaKey(strip, state.key);
      showStage(keyed, "effect row: keyed");
      setStep("alpha", "done");
      checkKeyCoverage(keyed);
      setStep("extract", "active", `extracting ${p.frames} frames…`);
      const exE = extractFramesRobust(keyed, p.frames, { align: "center" });
      const slicedE = noteExtraction(exE, p.frames, "frames");
      pushRow(p.type, exE.frames, { fps: 12, loop: true, slotSliced: slicedE });
    }

    setStep("atlas", "active", "packing rows → sprite sheet + manifest…");
    state.atlas = buildAtlas(state.rows);
    showStage(state.atlas.canvas, `atlas ${state.atlas.canvas.width}×${state.atlas.canvas.height} — one row per state, absolute rects in manifest`);
    setStep("atlas", "done");
    setStep("done", "done", `done — ${state.rows.length} row(s), rev ${state.revision}. originals untouched; ◀ ▶ only rewrites manifest order.`);

    renderFramesUI();
    startPreview();
    enableExport(true);
    setStatusBar("done");
  } catch (e) {
    const active = document.querySelector("#stepper li.active");
    if (active) { active.classList.remove("active"); active.classList.add("error"); }
    if (/AI_RATE_LIMITED/.test(e.message)) {
      // honest, actionable, no stale pixels: clear the stage, amber message,
      // keep both recovery buttons (strict retry + one-click procedural)
      clearStage();
      const msg = e.message.replace(/^AI_RATE_LIMITED:\s*/, "");
      setStep("row", "warn");
      stageMsg(msg, "warn");
      showRetry(msg);
      setStatusBar("warn");
    } else {
      stageMsg("FAILED: " + e.message, true);
      showRetry("Extraction found nothing usable. Retry with a stricter prompt, lower the frame count, or pick a different background key.");
      setStatusBar("error");
    }
  } finally {
    setBusy(false);
  }
}

/* ================= v6.5: image → pixel art (pure pixel pipeline, DOM-free) =================
 * Every function below operates on plain {data:Uint8ClampedArray, w, h} pixel
 * buffers — no canvas, no DOM — so the whole pipeline unit-tests in node.
 * Alpha is preserved throughout: quantization and dithering touch RGB only;
 * fully transparent pixels stay fully transparent. */

/* box-average downscale: deterministic, identical in browser and node */
function pxDownscaleData(src, dw, dh) {
  const data = src.data, sw = src.w, sh = src.h;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * sw + xx) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++;
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { data: out, w: dw, h: dh };
}

/* median-cut: px = array of [r,g,b]; returns palette of ≤ maxColors [r,g,b] */
function pxMedianCut(px, maxColors) {
  if (!px.length || maxColors < 1) return [];
  const rangeOf = (box) => {
    const mn = [255, 255, 255], mx = [0, 0, 0];
    for (const p of box) for (let c = 0; c < 3; c++) {
      if (p[c] < mn[c]) mn[c] = p[c];
      if (p[c] > mx[c]) mx[c] = p[c];
    }
    return { mn, mx };
  };
  const boxes = [px.slice()];
  while (boxes.length < maxColors) {
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.length < 2) continue;
      const { mn, mx } = rangeOf(b);
      const range = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
      const score = range * Math.log2(b.length + 1);
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    const { mn, mx } = rangeOf(box);
    let ch = 0;
    if (mx[1] - mn[1] > mx[ch] - mn[ch]) ch = 1;
    if (mx[2] - mn[2] > mx[ch] - mn[ch]) ch = 2;
    box.sort((a, b2) => a[ch] - b2[ch]);
    const mid = Math.floor(box.length / 2);
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map(b => {
    let r = 0, g = 0, bl = 0;
    for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
    const n = b.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}

function pxNearestColor(palette, r, g, b) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d = (p[0] - r) * (p[0] - r) + (p[1] - g) * (p[1] - g) + (p[2] - b) * (p[2] - b);
    if (d < bd) { bd = d; bi = i; }
  }
  return palette[bi];
}

/* quantize RGB to ≤ maxColors; maxColors 0 = full color (copy). Alpha untouched. */
function pxQuantize(src, maxColors) {
  const data = src.data, w = src.w, h = src.h;
  const out = new Uint8ClampedArray(data.length);
  if (!maxColors || maxColors >= 256) { out.set(data); return { data: out, w, h }; }
  const opaque = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8) opaque.push([data[i], data[i + 1], data[i + 2]]);
  }
  const palette = pxMedianCut(opaque, maxColors);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a <= 8 || !palette.length) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; continue; }
    const c = pxNearestColor(palette, data[i], data[i + 1], data[i + 2]);
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = a;
  }
  return { data: out, w, h };
}

/* Floyd–Steinberg dithering over a quantized buffer. RGB only; alpha preserved. */
function pxDitherFS(src, maxColors) {
  const data = src.data, w = src.w, h = src.h;
  const f = new Float32Array(data);
  const opaque = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8) opaque.push([data[i], data[i + 1], data[i + 2]]);
  }
  const palette = pxMedianCut(opaque, maxColors);
  const out = new Uint8ClampedArray(data.length);
  const spread = (x, y, er, dx, dy, fct) => {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
    const ni = (ny * w + nx) * 4;
    if (data[ni + 3] <= 8) return;
    f[ni] += er[0] * fct; f[ni + 1] += er[1] * fct; f[ni + 2] += er[2] * fct;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = data[i + 3];
      if (a <= 8 || !palette.length) { out[i] = out[i + 1] = out[i + 2] = 0; out[i + 3] = 0; continue; }
      const oldR = f[i], oldG = f[i + 1], oldB = f[i + 2];
      const nc = pxNearestColor(palette, oldR, oldG, oldB);
      out[i] = nc[0]; out[i + 1] = nc[1]; out[i + 2] = nc[2]; out[i + 3] = a;
      const er = [oldR - nc[0], oldG - nc[1], oldB - nc[2]];
      spread(x, y, er, 1, 0, 7 / 16); spread(x, y, er, -1, 1, 3 / 16);
      spread(x, y, er, 0, 1, 5 / 16); spread(x, y, er, 1, 1, 1 / 16);
    }
  }
  return { data: out, w, h };
}

/* nearest-neighbor upscale — crisp pixels, never blurry */
function pxUpscaleNearest(src, scale) {
  const data = src.data, w = src.w, h = src.h;
  const W = w * scale, H = h * scale;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < W; x++) {
      const sx = Math.floor(x / scale);
      const si = (sy * w + sx) * 4, oi = (y * W + x) * 4;
      out[oi] = data[si]; out[oi + 1] = data[si + 1]; out[oi + 2] = data[si + 2]; out[oi + 3] = data[si + 3];
    }
  }
  return { data: out, w: W, h: H };
}

/* full pipeline: downscale → quantize (or dither). colors 0 = full color. */
function pxConvert(src, opts) {
  const small = pxDownscaleData(src, opts.w, opts.h);
  if (!opts.colors) return small;
  return opts.dither ? pxDitherFS(small, opts.colors) : pxQuantize(small, opts.colors);
}

/* ---------- v6.5: pixel-art converter wiring (browser side) ---------- */

function pxState() {
  if (!state.pixelart) {
    const d = CATEGORY_DEFAULTS.pixelart;
    state.pixelart = { src: null, imgW: 0, imgH: 0, w: d.w, h: d.h, colors: d.colors, dither: false, scale: 8, grid: false, tile: 32, out: null };
  }
  return state.pixelart;
}

function pxColorLabel(n) {
  return n === 0 ? "full color" : n + " colors";
}

/* standalone tools own the panel: in the pixelart/slicer lanes the wizard
 * framing drops — steps 1-2 hide, the options group carries the tool's own
 * header (no step number), and a back button returns to the generator. */
function syncToolChrome() {
  const tool = state.category === "pixelart" ? "Pixel Converter"
             : state.category === "slicer" ? "Sprite Slicer" : null;
  document.querySelectorAll(".ctl-group").forEach(g => {
    g.classList.toggle("tool-hidden", !!tool && g.id !== "ctlStep3");
  });
  const num = document.getElementById("ctlNum3");
  const lbl = document.getElementById("ctlStepLbl3");
  const ttl = document.getElementById("ctlTitle3");
  if (num) num.textContent = tool ? "\u{1F9F0}" : "3";
  if (lbl) lbl.textContent = tool ? "Standalone tool" : "Step 3";
  if (ttl) ttl.textContent = tool || "Options";
  const back = document.getElementById("toolBack");
  if (back) back.hidden = !tool;
}

function syncPixelMode() {
  const on = state.category === "pixelart";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-pixelart", on);
  if (stage) stage.classList.toggle("mode-pixelart", on);
  document.body.classList.toggle("mode-pixelart", on);
  const side = $("#pixelSide");
  if (side) side.hidden = !(on && state.pixelart && state.pixelart.src);
  syncToolChrome();
}

function pxRender() {
  const P = pxState();
  const side = $("#pixelSide");
  if (!P.src) { if (side) side.hidden = true; return; }
  const t0 = performance.now();
  P.out = pxConvert(P.src, { w: P.w, h: P.h, colors: P.colors, dither: P.dither });
  const ms = Math.round(performance.now() - t0);

  const oc = $("#pxOrig"), pc = $("#pxOut");
  oc.width = P.imgW; oc.height = P.imgH;
  const octx = oc.getContext("2d");
  const tmp = document.createElement("canvas");
  tmp.width = P.src.w; tmp.height = P.src.h;
  tmp.getContext("2d").putImageData(new ImageData(P.src.data, P.src.w, P.src.h), 0, 0);
  octx.drawImage(tmp, 0, 0);
  oc.style.maxWidth = "100%";

  pc.width = P.w; pc.height = P.h;
  const pctx = pc.getContext("2d");
  pctx.putImageData(new ImageData(P.out.data, P.out.w, P.out.h), 0, 0);
  pc.style.width = Math.min(P.w * P.scale, 420) + "px";
  // tile grid overlay (visual aid only — never baked into P.out or downloads)
  let tileInfo = "";
  if (P.grid && P.tile >= 8) {
    pctx.strokeStyle = "rgba(255,255,255,.45)";
    pctx.lineWidth = 1;
    pctx.beginPath();
    for (let gx = P.tile; gx < P.w; gx += P.tile) { pctx.moveTo(gx + .5, 0); pctx.lineTo(gx + .5, P.h); }
    for (let gy = P.tile; gy < P.h; gy += P.tile) { pctx.moveTo(0, gy + .5); pctx.lineTo(P.w, gy + .5); }
    pctx.stroke();
    tileInfo = ` · ${Math.ceil(P.w / P.tile)}×${Math.ceil(P.h / P.tile)} tiles`;
  }
  const tc = $("#pxTileCount");
  if (tc) tc.textContent = tileInfo.replace(" · ", "");

  $("#pxOrigCap").textContent = `original · ${P.imgW} × ${P.imgH}`;
  $("#pxOutCap").textContent = `pixel art · ${P.w} × ${P.h} · ${pxColorLabel(P.colors)}${P.dither ? " · dithered" : ""}${tileInfo} · ${ms}ms`;
  side.hidden = false;
}

function pxDownloadArt() {
  const P = state.pixelart;
  if (!P || !P.out) { stageMsg("Upload an image first.", true); return; }
  const big = pxUpscaleNearest(P.out, 8); // crisp ×8 nearest-neighbor export
  const cv = document.createElement("canvas");
  cv.width = big.w; cv.height = big.h;
  cv.getContext("2d").putImageData(new ImageData(big.data, big.w, big.h), 0, 0);
  downloadCanvas(cv, `m4ster-pixel-art-${P.w}x${P.h}-${P.colors || "full"}c.png`);
}

function wirePixelArt() {
  const P = pxState();
  const clampWH = (v) => Math.max(8, Math.min(1024, Math.round(v) || 64));

  const syncOrigBtn = () => {
    const ob = $("#pxOrigBtn");
    if (ob && P.imgW) ob.textContent = `Original ${P.imgW}×${P.imgH}`;
  };
  syncOrigBtn();

  $("#pxPick").onclick = () => $("#pxFile").click();
  $("#pxFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const cv = document.createElement("canvas");
      cv.width = bmp.width; cv.height = bmp.height;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(bmp, 0, 0);
      const id = cx.getImageData(0, 0, bmp.width, bmp.height);
      P.src = { data: id.data, w: bmp.width, h: bmp.height };
      P.imgW = bmp.width; P.imgH = bmp.height;
      if (bmp.close) bmp.close();
      syncOrigBtn();
      stageMsg(`loaded ${f.name} — ${bmp.width}×${bmp.height}`);
    } catch (err) {
      stageMsg("couldn't read that image — try a PNG or JPG.", true);
      return;
    }
    pxRender();
    e.target.value = "";
  };

  document.querySelectorAll("#pxDims .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#pxDims .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      if (b.id === "pxOrigBtn") {
        if (!P.src) { stageMsg("Upload an image first.", true); return; }
        P.w = clampWH(P.imgW); P.h = clampWH(P.imgH);
      } else {
        P.w = P.h = parseInt(b.dataset.px, 10);
      }
      $("#pxW").value = P.w; $("#pxH").value = P.h;
      pxRender();
    };
  });
  const wh = () => {
    P.w = clampWH(parseInt($("#pxW").value, 10));
    P.h = clampWH(parseInt($("#pxH").value, 10));
    $("#pxW").value = P.w; $("#pxH").value = P.h;
    document.querySelectorAll("#pxDims .seg-btn").forEach(x => x.classList.toggle("active", parseInt(x.dataset.px, 10) === P.w && P.w === P.h));
    pxRender();
  };
  $("#pxW").onchange = wh; $("#pxH").onchange = wh;
  $("#pxColors").onchange = (e) => { P.colors = parseInt(e.target.value, 10); pxRender(); };
  $("#pxDither").onchange = (e) => { P.dither = e.target.checked; pxRender(); };
  $("#pxGrid").onchange = (e) => { P.grid = e.target.checked; pxRender(); };
  $("#pxTile").onchange = (e) => { P.tile = parseInt(e.target.value, 10); pxRender(); };
  $("#pxScale").oninput = (e) => {
    P.scale = parseInt(e.target.value, 10);
    $("#pxScaleVal").textContent = "×" + P.scale;
    const pc = $("#pxOut");
    if (P.out && pc.width) pc.style.width = Math.min(P.w * P.scale, 420) + "px";
  };
  $("#pxDownload").onclick = pxDownloadArt;
  syncPixelMode();
}

/* ================= v6.6: dedicated sprite slicer =================
 * One proper slicer (supersedes the v5 splitter): upload a sheet, see a
 * live grid overlay on the sheet, tune rows/cols/margin/padding/offset,
 * or auto-detect pieces. Click cells in order to pick frames, animated
 * preview, export sheet PNG + manifest JSON.
 *
 * Grid math (Unity-sprite-editor style):
 *   cellW = (W - 2*margin - (cols-1)*pad) / cols
 *   x(c)  = margin + ox + c * (cellW + pad)
 * (same for the rows). Fractional rects are kept until cut time so odd
 * sheet sizes never drop a pixel. */

function detectPieces(img, bg) {
  const w = img.width, h = img.height;
  const data = img.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const isContent = contentTest(data, w, h, bg);
  const visited = new Uint8Array(w * h);
  const comps = [];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (visited[idx] || !isContent(x, y)) continue;
      let x0 = x, x1 = x, y0 = y, y1 = y, area = 0, sx = 0, sy = 0;
      stack.push(idx); visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % w, cy = (cur / w) | 0;
        area++; sx += cx; sy += cy;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        if (cx > 0)     { const n = cur - 1; if (!visited[n] && isContent(cx - 1, cy)) { visited[n] = 1; stack.push(n); } }
        if (cx < w - 1) { const n = cur + 1; if (!visited[n] && isContent(cx + 1, cy)) { visited[n] = 1; stack.push(n); } }
        if (cy > 0)     { const n = cur - w; if (!visited[n] && isContent(cx, cy - 1)) { visited[n] = 1; stack.push(n); } }
        if (cy < h - 1) { const n = cur + w; if (!visited[n] && isContent(cx, cy + 1)) { visited[n] = 1; stack.push(n); } }
      }
      comps.push({ x0, x1, y0, y1, area, cx: sx / area, cy: sy / area });
    }
  }
  let total = 0;
  for (const c of comps) total += c.area;
  if (total === 0) return [];
  const kept = comps.filter(c => c.area >= Math.max(60, total * 0.0015));
  // reading order: group into horizontal bands, sort bands top-down, items left-right
  const bands = [];
  for (const c of kept) {
    const bandH = Math.max(8, (c.y1 - c.y0) / 2);
    let band = bands.find(bd => Math.abs(bd.cy - c.cy) < bandH);
    if (!band) { band = { cy: c.cy, items: [] }; bands.push(band); }
    band.items.push(c);
    band.cy = band.items.reduce((s, i) => s + i.cy, 0) / band.items.length;
  }
  bands.sort((a, b) => a.cy - b.cy);
  const ordered = [];
  for (const b of bands) {
    b.items.sort((a, b2) => a.cx - b2.cx);
    ordered.push(...b.items);
  }
  const pad = 2;
  return ordered.map(c => {
    const x0 = Math.max(0, c.x0 - pad), y0 = Math.max(0, c.y0 - pad);
    const x1 = Math.min(w - 1, c.x1 + pad), y1 = Math.min(h - 1, c.y1 + pad);
    const cell = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
    cell.getContext("2d").drawImage(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, x1 - x0 + 1, y1 - y0 + 1);
    return cell;
  });
}

/* normalize a piece into a shared cell, bottom-centered (stable feet for walk cycles) */
function placeBottomCenter(piece, cw, ch) {
  const cell = makeCanvas(cw, ch);
  const dx = Math.round((cw - piece.width) / 2);
  const dy = Math.max(0, Math.round(ch - piece.height - ch * 0.03));
  cell.getContext("2d").drawImage(piece, dx, dy);
  return cell;
}

/* what counts as ink vs empty background for trim + auto-detect. bg: transparent | black | white (chroma is pre-keyed to transparent) */
function contentTest(data, w, h, bg) {
  if (bg === "black") {
    return (x, y) => {
      const o = (y * w + x) * 4;
      return data[o + 3] > 12 && Math.max(data[o], data[o + 1], data[o + 2]) > 28;
    };
  }
  if (bg === "white") {
    return (x, y) => {
      const o = (y * w + x) * 4;
      return data[o + 3] > 12 && Math.min(data[o], data[o + 1], data[o + 2]) < 227;
    };
  }
  return (x, y) => data[(y * w + x) * 4 + 3] > 12;
}

/* canvas copy */
function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

/* punch the selected background to transparent, in place */
function knockoutBg(canvas, bg) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const isContent = contentTest(img.data, w, h, bg);
  const d = img.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (!isContent(x, y)) d[(y * w + x) * 4 + 3] = 0;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* crop to the content bbox (+2px pad). Returns null when the cell is empty. */
function trimToContent(cell, bg) {
  const w = cell.width, h = cell.height;
  const data = cell.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const isContent = contentTest(data, w, h, bg);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (isContent(x, y)) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  if (x1 < x0) return null;
  const pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext("2d").drawImage(cell, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}

/* even grid rects with margin / padding / offset, row-major order.
 * Pure math — no DOM — so it unit-tests cleanly. */
function slicerGridRects(w, h, rows, cols, o) {
  o = o || {};
  const margin = Math.max(0, +o.margin || 0), pad = Math.max(0, +o.pad || 0);
  const ox = +o.ox || 0, oy = +o.oy || 0;
  rows = Math.max(1, Math.round(rows)); cols = Math.max(1, Math.round(cols));
  const cw = (w - margin * 2 - (cols - 1) * pad) / cols;
  const ch = (h - margin * 2 - (rows - 1) * pad) / rows;
  const rects = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      rects.push({
        x: margin + ox + c * (cw + pad),
        y: margin + oy + r * (ch + pad),
        w: cw, h: ch,
      });
  return rects;
}

/* cut each rect out of the sheet. Start floored, end ceiled (like v5) so
 * coverage is exact and no pixel is ever dropped to rounding. */
function slicerCutCells(sheet, rects) {
  const W = sheet.width, H = sheet.height;
  return rects.map(rc => {
    const x0 = Math.max(0, Math.floor(rc.x)), y0 = Math.max(0, Math.floor(rc.y));
    const x1 = Math.min(W, Math.ceil(rc.x + rc.w)), y1 = Math.min(H, Math.ceil(rc.y + rc.h));
    const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
    const cell = makeCanvas(cw, ch);
    cell.getContext("2d").drawImage(sheet, x0, y0, cw, ch, 0, 0, cw, ch);
    return cell;
  });
}

/* ---------------- slicer state + wiring ---------------- */

function slState() {
  if (!state.slicer) {
    const d = CATEGORY_DEFAULTS.slicer;
    state.slicer = {
      sheet: null, imgW: 0, imgH: 0,
      rows: d.rows, cols: d.cols, mode: d.mode, bg: d.bg, knockout: d.knockout,
      margin: d.margin, pad: d.pad, ox: d.ox, oy: d.oy,
      pieces: [], selection: [],
      fps: d.fps, playback: d.playback,
    };
  }
  return state.slicer;
}

function syncSlicerMode() {
  const on = state.category === "slicer";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-slicer", on);
  if (stage) stage.classList.toggle("mode-slicer", on);
  document.body.classList.toggle("mode-slicer", on);
  if (!on) {
    // leaving the lane: hide the piece picker (the pipeline owns the stage)
    const grid = $("#splitGrid"), head = $("#splitHead");
    if (grid) grid.hidden = true;
    if (head) head.hidden = true;
  }
  syncToolChrome();
}

/* draw the sheet + live grid overlay on the stage canvas */
function slicerOverlay() {
  const S = slState();
  const st = $("#stage");
  if (!st) return;
  if (!S.sheet) { clearStage(); return; }
  st.width = S.imgW; st.height = S.imgH;
  const ctx = st.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(S.sheet, 0, 0);
  const ro = $("#slReadout");
  if (S.mode === "grid") {
    const rects = slicerGridRects(S.imgW, S.imgH, S.rows, S.cols, S);
    let accent = "#f97316";
    try { accent = getComputedStyle(document.documentElement).getPropertyValue("--violet").trim() || accent; } catch (e) {}
    ctx.strokeStyle = accent; ctx.fillStyle = accent;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1, Math.min(S.imgW, S.imgH) / 400);
    const fs = Math.max(10, Math.min(S.imgW, S.imgH) / 24);
    ctx.font = `${fs}px monospace`;
    rects.forEach((rc, i) => {
      ctx.strokeRect(rc.x + 0.5, rc.y + 0.5, Math.max(1, rc.w - 1), Math.max(1, rc.h - 1));
      ctx.fillText(String(i + 1), rc.x + 4, rc.y + fs);
    });
    ctx.globalAlpha = 1;
    if (ro) ro.innerHTML = `sheet <b>${S.imgW} &times; ${S.imgH}</b> &rarr; ${S.rows}&times;${S.cols} = ${rects.length} cells &middot; <b>${Math.round(rects[0].w)} &times; ${Math.round(rects[0].h)} px</b> per cell`;
  } else {
    if (ro) ro.innerHTML = `sheet <b>${S.imgW} &times; ${S.imgH}</b> &middot; auto-detect: <b>${S.pieces.length}</b> piece(s) found`;
  }
  stageMsg("");
}

/* main slice: normalize background -> cut pieces -> number them */
function runSlicer() {
  const S = slState();
  if (!S.sheet) { stageMsg("Upload a sprite sheet first.", true); return; }
  // normalize: chroma -> keyed copy; black/white -> knockout copy (optional);
  // trim + detect then work on plain transparency
  let work = copyCanvas(S.sheet);
  let effBg = S.bg;
  if (S.bg === "chroma") { work = chromaKey(work, state.key); effBg = "transparent"; }
  else if (S.knockout && S.bg !== "transparent") { knockoutBg(work, S.bg); effBg = "transparent"; }

  let pieces;
  if (S.mode === "grid") {
    const rects = slicerGridRects(S.imgW, S.imgH, S.rows, S.cols, S);
    pieces = slicerCutCells(work, rects).map((cell, i) => {
      const t = trimToContent(cell, effBg);
      return { canvas: t, empty: !t, rect: rects[i] };
    });
  } else {
    pieces = detectPieces(work, effBg).map(c => ({ canvas: c, empty: false, rect: null }));
  }
  const usable = pieces.filter(p => !p.empty);
  S.pieces = pieces;
  S.selection = S.selection.filter(i => i < pieces.length && !pieces[i].empty);
  slicerOverlay();
  renderSlicerPieces();
  slicerPreview();
  updateSlicerExport();
  if (!usable.length) {
    stageMsg(`slicer found no usable pieces (sheet ${S.imgW}\u00d7${S.imgH}, grid ${S.rows}\u00d7${S.cols}) — try a different background, or fewer rows/cols.`, true);
    return;
  }
  const empty = pieces.length - usable.length;
  stageMsg(`sliced ${pieces.length} piece(s), ${usable.length} usable${empty ? ` (${empty} empty)` : ""} — click pieces in order`);
}

/* numbered piece picker: click in order, click again to deselect (renumbers) */
function renderSlicerPieces() {
  const S = state.slicer;
  const grid = $("#splitGrid"), head = $("#splitHead");
  const on = !!(S && S.sheet && S.pieces.length);
  if (grid) grid.hidden = !on;
  if (head) head.hidden = !on;
  if (!on || !S) return;
  grid.innerHTML = "";
  $("#splitMeta").textContent = `· ${S.pieces.length} pieces, ${S.selection.length} picked`;
  S.pieces.forEach((p, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "piece-card" + (p.empty ? " empty" : "");
    card.disabled = !!p.empty;
    card.setAttribute("aria-label", `piece ${i + 1}${p.empty ? " (empty)" : ""}`);
    const orderIdx = S.selection.indexOf(i);
    if (orderIdx >= 0) card.classList.add("picked");
    const badges = document.createElement("span");
    badges.innerHTML = `<span class="pnum">${i + 1}</span>` +
      (orderIdx >= 0 ? `<span class="porder">${orderIdx + 1}</span>` : "");
    card.appendChild(badges);
    if (p.canvas) {
      const cv = document.createElement("canvas");
      const sc = Math.min(56 / p.canvas.width, 56 / p.canvas.height, 1);
      cv.width = Math.max(1, Math.round(p.canvas.width * sc));
      cv.height = Math.max(1, Math.round(p.canvas.height * sc));
      cv.getContext("2d").drawImage(p.canvas, 0, 0, cv.width, cv.height);
      card.appendChild(cv);
    } else {
      const em = document.createElement("span");
      em.className = "pempty";
      em.textContent = "—";
      card.appendChild(em);
    }
    card.addEventListener("click", () => slicerPick(i));
    grid.appendChild(card);
  });
}

function slicerPick(i) {
  const S = state.slicer;
  if (!S || S.pieces[i].empty) return;
  const at = S.selection.indexOf(i);
  if (at >= 0) S.selection.splice(at, 1);
  else S.selection.push(i);
  renderSlicerPieces();
  slicerPreview();
  updateSlicerExport();
}

let slicerRAF = 0, slicerT = 0, slicerDir = 1;
function slicerPreview() {
  cancelAnimationFrame(slicerRAF);
  cancelAnimationFrame(previewRAF);
  const S = state.slicer;
  const pc = $("#preview");
  if (!pc) return;
  const pctx = pc.getContext("2d");
  pctx.imageSmoothingEnabled = false;
  const sel = $("#previewState");
  sel.innerHTML = "";
  const o = document.createElement("option");
  o.value = 0; o.textContent = "slice animation";
  sel.appendChild(o);
  sel.disabled = true;
  slicerT = 0; slicerDir = 1;
  pctx.clearRect(0, 0, pc.width, pc.height);
  if (!S || !S.selection.length) {
    $("#previewMeta").textContent = (S && S.sheet) ? "· pick frames above" : "";
    return;
  }
  let last = performance.now();
  function tick(now) {
    slicerRAF = requestAnimationFrame(tick);
    const fr = S.selection.map(j => S.pieces[j].canvas);
    if (!fr.length) return;
    const fps = S.fps || 8;
    if (now - last < 1000 / fps) return;
    last = now;
    if (S.playback === "once") { if (slicerT < fr.length - 1) slicerT++; }
    else if (S.playback === "pingpong") {
      slicerT += slicerDir;
      if (slicerT >= fr.length - 1) { slicerT = fr.length - 1; slicerDir = -1; }
      if (slicerT <= 0) { slicerT = 0; slicerDir = 1; }
    }
    else slicerT = (slicerT + 1) % fr.length;
    let cw = 0, ch = 0;
    for (const f of fr) { cw = Math.max(cw, f.width); ch = Math.max(ch, f.height); }
    const sc = Math.min(pc.width / cw, pc.height / ch, 8);
    const dw = Math.max(1, Math.round(cw * sc)), dh = Math.max(1, Math.round(ch * sc));
    const ox = (pc.width - dw) / 2, oy = (pc.height - dh) / 2;
    pctx.clearRect(0, 0, pc.width, pc.height);
    const f = fr[slicerT];
    const fw = Math.max(1, Math.round(f.width * sc)), fh = Math.max(1, Math.round(f.height * sc));
    pctx.drawImage(f, ox + Math.round((dw - fw) / 2), oy + dh - fh, fw, fh);
    $("#previewMeta").textContent = `· slice · frame ${slicerT + 1}/${fr.length}`;
  }
  tick(last);
}

/* pack ONLY the picked frames into a one-row animation sheet + manifest */
function buildSlicerAtlas() {
  const S = state.slicer;
  const sel = S.selection.map(i => S.pieces[i].canvas);
  if (!sel.length) fail("pick at least one frame first — click pieces in order.");
  let cw = 0, ch = 0;
  for (const f of sel) { cw = Math.max(cw, f.width); ch = Math.max(ch, f.height); }
  const norm = sel.map(f => placeBottomCenter(f, cw, ch));
  const pad = 2;
  const sheet = makeCanvas(cw * norm.length + pad * 2, ch + pad * 2);
  const sctx = sheet.getContext("2d");
  const rects = [];
  norm.forEach((f, i) => {
    const x = pad + i * cw;
    sctx.drawImage(f, x, pad);
    rects.push({ x, y: pad, w: cw, h: ch });
  });
  const manifest = {
    tool: BRAND.tool,
    version: "2.2.0",
    engine: "slicer",
    runRevision: state.revision,
    atlas: "m4ster-split-animation.png",
    sheetWidth: sheet.width,
    sheetHeight: sheet.height,
    sliceSource: {
      mode: S.mode, bg: S.bg, grid: [S.rows, S.cols],
      margin: S.margin, pad: S.pad, offset: [S.ox, S.oy],
      sheetW: S.imgW, sheetH: S.imgH,
    },
    frameLayout: { padding: pad, rows: { anim: { row: 0, cellWidth: cw, cellHeight: ch, rects } } },
    animations: {
      anim: {
        row: 0, frames: norm.length, fps: S.fps, loop: S.playback !== "once",
        playback: S.playback,
        durationsMs: norm.map(() => Math.round(1000 / S.fps)),
        frameOrder: S.selection.slice(),
      },
    },
  };
  return { canvas: sheet, manifest, pngName: "m4ster-split-animation.png", jsonName: "m4ster-split-animation.json" };
}

function updateSlicerExport() {
  const n = state.slicer ? state.slicer.selection.length : 0;
  const on = n > 0;
  ["#slDownload", "#slCells"].forEach(sl => { const el = $(sl); if (el) el.disabled = !on; });
  state.atlas = on ? buildSlicerAtlas() : null;
  slicerOverlay();
}

function slicerDownload() {
  const S = state.slicer;
  if (!S || !S.selection.length) { stageMsg("pick at least one frame first.", true); return; }
  const a = buildSlicerAtlas();
  downloadCanvas(a.canvas, a.pngName);
  setTimeout(() => downloadJSON(a.manifest, a.jsonName), 400);
}

function slicerDownloadCells() {
  const S = state.slicer;
  if (!S || !S.selection.length) return;
  let delay = 0;
  S.selection.forEach((pi, oi) => {
    const c = S.pieces[pi].canvas;
    setTimeout(() => downloadCanvas(c, `m4ster-slice-frame${oi}.png`), delay);
    delay += 350;
  });
}

/* ---------------- slicer control wiring ---------------- */

function wireSlicer() {
  const S = slState();

  $("#slPick").onclick = () => $("#slFile").click();
  $("#slFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const bw = bmp.width, bh = bmp.height; // read BEFORE close(): dims go 0 after
      const cv = makeCanvas(bw, bh);
      cv.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      S.sheet = cv; S.imgW = bw; S.imgH = bh;
      S.pieces = []; S.selection = [];
      stageMsg(`loaded ${f.name} — ${bmp.width}×${bmp.height}, slicing…`);
      runSlicer();
    } catch (err) {
      stageMsg("couldn't read that image — try a PNG or JPG.", true);
    }
    e.target.value = "";
  };

  document.querySelectorAll("#slModeSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#slModeSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      S.mode = b.dataset.mode;
      $("#slGridRow").hidden = S.mode !== "grid";
      runSlicer();
    };
  });

  // sliders: live overlay while dragging, re-slice on release
  const bindRange = (id, valId, key) => {
    const el = $(id);
    el.oninput = () => { S[key] = +el.value; $(valId).textContent = el.value; slicerOverlay(); };
    el.onchange = () => { S[key] = +el.value; runSlicer(); };
  };
  bindRange("#slRows", "#slRowsVal", "rows");
  bindRange("#slCols", "#slColsVal", "cols");

  [["slMargin", "margin"], ["slPad", "pad"], ["slOx", "ox"], ["slOy", "oy"]].forEach(([id, key]) => {
    $("#" + id).onchange = (e) => {
      S[key] = Math.max(0, Math.round(+e.target.value || 0));
      e.target.value = S[key];
      slicerOverlay();
      runSlicer();
    };
  });

  document.querySelectorAll("#slBgSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#slBgSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      S.bg = b.dataset.bg;
      runSlicer();
    };
  });
  $("#slKnockout").onchange = (e) => { S.knockout = e.target.checked; runSlicer(); };

  $("#slFps").onchange = (e) => { S.fps = +e.target.value || 8; slicerT = 0; };
  document.querySelectorAll("#slPlaybackSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#slPlaybackSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      S.playback = b.dataset.playback;
      slicerT = 0; slicerDir = 1;
    };
  });

  $("#slSelectAll").onclick = () => {
    if (!S.pieces.length) return;
    S.selection = S.pieces.map((p, i) => i).filter(i => !S.pieces[i].empty);
    renderSlicerPieces(); slicerPreview(); updateSlicerExport();
  };
  $("#slClear").onclick = () => {
    S.selection = [];
    renderSlicerPieces(); slicerPreview(); updateSlicerExport();
  };
  $("#slReslice").onclick = runSlicer;
  $("#slDownload").onclick = slicerDownload;
  $("#slCells").onclick = slicerDownloadCells;
  syncSlicerMode();
}

/* ================= wiring ================= */

function init() {
  renderParams();
  wireStudio();
  wireFlip();
  wire3DLab();
  syncStudio();
  wireExport();
  syncPixelMode();
  syncSlicerMode();

  const toolBackBtn = document.getElementById("toolBack");
  if (toolBackBtn) toolBackBtn.onclick = () => {
    const t = document.querySelector('.tab[data-cat="character"]');
    if (t) t.click();
  };

  document.querySelectorAll(".tab").forEach(t => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      document.querySelectorAll(".tool-card").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      state.category = t.dataset.cat;
      cancelAnimationFrame(slicerRAF);
      renderParams();
      syncPixelMode();
      syncSlicerMode();
      syncAiModelUI();
    };
  });

  document.querySelectorAll("#sourceSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#sourceSeg .seg-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.source = b.dataset.src;
      syncAiModelUI();
    };
  });

  /* v6.8: AI model switcher wiring */
  try {
    const savedModel = localStorage.getItem(LS_AI_MODEL);
    if (savedModel && AI_PROVIDERS[savedModel]) state.aiModel = savedModel;
  } catch (e) {}
  const aiSel = document.getElementById("aiModel");
  if (aiSel) {
    aiSel.addEventListener("change", () => {
      state.aiModel = aiSel.value;
      try { localStorage.setItem(LS_AI_MODEL, state.aiModel); } catch (e) {}
      syncAiModelUI();
    });
  }
  wireModelPicker("aiModelBtn", "aiModel");
  wireAssets();
  const aiKeyInput = document.getElementById("aiKey");
  if (aiKeyInput) {
    aiKeyInput.addEventListener("input", () => {
      const p = AI_PROVIDERS[state.aiModel];
      if (!p || !p.keyField) return;
      const keys = aiKeys();
      keys[p.keyField] = aiKeyInput.value.trim();
      try { localStorage.setItem(LS_AI_KEYS, JSON.stringify(keys)); } catch (e) {}
    });
  }
  /* character panel picks are stashed on every change so a tab hop or a
   * gallery open never silently resets the states the user checked */
  const paramsBox = $("#params");
  if (paramsBox) paramsBox.addEventListener("change", () => {
    if (state.category !== "character" || !paramsBox.querySelector("#pFrames")) return;
    state.charStash = {
      states: [...paramsBox.querySelectorAll("#stateRow input:checked")].map(i => i.dataset.state),
      frames: clampInt(paramsBox.querySelector("#pFrames").value, 2, 12, 4),
      archetype: paramsBox.querySelector("#pArch") ? paramsBox.querySelector("#pArch").value : "biped",
      palette: paramsBox.querySelector("#pPal") ? paramsBox.querySelector("#pPal").value : "classic"
    };
  });

  /* v6.9: character animation style (still vs strip) */
  try {
    if (localStorage.getItem("m4ster.aiStyle") === "strip") state.aiStyle = "strip";
  } catch (e) {}
  document.querySelectorAll("#aiStyleSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      state.aiStyle = b.dataset.style;
      try { localStorage.setItem("m4ster.aiStyle", state.aiStyle); } catch (e) {}
      syncAiModelUI();
    };
  });
  syncAiModelUI();

  document.querySelectorAll("#keyRow .key").forEach(k => {
    k.onclick = () => {
      document.querySelectorAll("#keyRow .key").forEach(x => x.classList.remove("active"));
      k.classList.add("active");
      const [r, g, b] = k.dataset.key.split(",").map(Number);
      state.key = { r, g, b };
    };
  });

  const startFresh = () => { state.strict = false; hideRetry(); runPipeline(); };
  $("#generate").onclick = startFresh;
  $("#generateMobile").onclick = startFresh;
  $("#retryBtn").onclick = () => { state.strict = true; hideRetry(); runPipeline(); };
  $("#procBtn").onclick = () => {
    // one-click escape hatch: drop to the offline generator and re-run
    state.source = "procedural";
    document.querySelectorAll("#sourceSeg .seg-btn").forEach(x => x.classList.toggle("active", x.dataset.src === "procedural"));
    syncAiModelUI();
    state.strict = false;
    hideRetry();
    runPipeline();
  };
}

document.addEventListener("DOMContentLoaded", init);

/* ============ v3 "alive": themes + aura (Customize, tracker's spirit) ============
 * Isolated IIFE: theme switcher (6 swatches, data-theme + CSS vars, live, no
 * reload, localStorage) + animated background aura (toggle + intensity).
 * Doesn't touch the generation pipeline. */
(function () {
  "use strict";
  /* Forest (green) first: it is the default theme, the first swatch in
   * the picker, and the fallback for any unknown saved value. */
  var THEMES = [
    { id: "forest",    name: "Forest",      swatch: "#22c55e" },
    { id: "ember",     name: "Ember",       swatch: "#f97316" },
    { id: "violet",    name: "Violet dusk", swatch: "#8b5cf6" },
    { id: "midnight",  name: "Midnight",    swatch: "#0c66e4" },
    { id: "ocean",     name: "Ocean",       swatch: "#0ea5e9" },
    { id: "porcelain", name: "Porcelain",   swatch: "#e2e8f0" },
  ];
  var LS_THEME = "msg_theme_v1", LS_AURA = "msg_aura_v1";

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function themeById(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return THEMES[0];
  }

  function applyTheme(id, save) {
    var t = themeById(id);
    document.documentElement.setAttribute("data-theme", t.id);
    if (save !== false) lsSet(LS_THEME, t.id);
    document.querySelectorAll("#swatches .swatch").forEach(function (b) {
      var on = b.dataset.theme === t.id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var nm = document.getElementById("swatchName");
    if (nm) nm.textContent = t.name;
  }

  function readAura() {
    var d = { enabled: true, intensity: 72 };
    try {
      var raw = lsGet(LS_AURA);
      if (raw) {
        var p = JSON.parse(raw);
        if (typeof p.enabled === "boolean") d.enabled = p.enabled;
        if (isFinite(p.intensity)) d.intensity = Math.min(100, Math.max(10, +p.intensity));
      }
    } catch (e) {}
    return d;
  }
  function applyAura() {
    var a = readAura();
    var el = document.getElementById("aura");
    if (el) el.classList.toggle("off", !a.enabled);
    document.documentElement.style.setProperty("--aura-intensity", (a.intensity / 100).toFixed(2));
    var tg = document.getElementById("auraToggle");
    if (tg) tg.setAttribute("aria-checked", a.enabled ? "true" : "false");
    var rg = document.getElementById("auraIntensity");
    if (rg) rg.value = String(a.intensity);
  }
  function saveAura(patch) {
    var a = readAura();
    for (var k in patch) a[k] = patch[k];
    lsSet(LS_AURA, JSON.stringify(a));
    applyAura();
  }

  /* ---------- v6.8: RGB separators (m4ster standard) ---------- */
  var LS_RGB = "m4ster.rgb";
  function readRGB() {
    var d = { enabled: true, speed: 7, breathe: false, rainbow: false };
    try {
      var raw = lsGet(LS_RGB);
      if (raw) {
        var p = JSON.parse(raw);
        if (typeof p.enabled === "boolean") d.enabled = p.enabled;
        if (isFinite(p.speed)) d.speed = Math.min(20, Math.max(2, +p.speed));
        if (typeof p.breathe === "boolean") d.breathe = p.breathe;
        if (typeof p.rainbow === "boolean") d.rainbow = p.rainbow;
      }
    } catch (e) {}
    return d;
  }
  function applyRGB() {
    var r = readRGB();
    document.body.classList.toggle("no-rgb", !r.enabled);
    document.body.classList.toggle("rgb-breathe", r.breathe);
    document.body.classList.toggle("rgb-rainbow", r.rainbow);
    document.documentElement.style.setProperty("--rgb-speed", r.speed + "s");
    var tg = document.getElementById("rgbToggle");
    if (tg) tg.setAttribute("aria-checked", r.enabled ? "true" : "false");
    var sp = document.getElementById("rgbSpeed");
    if (sp) sp.value = String(r.speed);
    var br = document.getElementById("rgbBreathe");
    if (br) br.setAttribute("aria-checked", r.breathe ? "true" : "false");
    var rb = document.getElementById("rgbRainbow");
    if (rb) rb.setAttribute("aria-checked", r.rainbow ? "true" : "false");
  }
  function saveRGB(patch) {
    var r = readRGB();
    for (var k in patch) r[k] = patch[k];
    lsSet(LS_RGB, JSON.stringify(r));
    applyRGB();
  }

  function initCustomize() {
    var btn = document.getElementById("customizeBtn");
    var pop = document.getElementById("customizePop");
    if (!btn || !pop) return;

    var wrap = document.getElementById("swatches");
    THEMES.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "swatch";
      b.type = "button";
      b.dataset.theme = t.id;
      b.title = t.name;
      b.setAttribute("aria-label", "Theme: " + t.name);
      b.style.setProperty("--sw", t.swatch);
      b.onclick = function () { applyTheme(t.id); };
      wrap.appendChild(b);
    });
    var nm = document.createElement("div");
    nm.className = "swatch-name";
    nm.id = "swatchName";
    wrap.appendChild(nm);

    var open = false;
    var setOpen = function (v) {
      open = v;
      pop.hidden = !v;
      btn.setAttribute("aria-expanded", v ? "true" : "false");
    };
    btn.addEventListener("click", function (e) { e.stopPropagation(); setOpen(!open); });
    document.addEventListener("click", function (e) {
      if (open && !pop.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (open && e.key === "Escape") setOpen(false);
    });

    document.getElementById("auraToggle").addEventListener("click", function () {
      saveAura({ enabled: !readAura().enabled });
    });
    document.getElementById("auraIntensity").addEventListener("input", function (e) {
      saveAura({ intensity: +e.target.value });
    });
    document.getElementById("rgbToggle").addEventListener("click", function () {
      saveRGB({ enabled: !readRGB().enabled });
    });
    document.getElementById("rgbSpeed").addEventListener("input", function (e) {
      saveRGB({ speed: +e.target.value });
    });
    document.getElementById("rgbBreathe").addEventListener("click", function () {
      saveRGB({ breathe: !readRGB().breathe });
    });
    document.getElementById("rgbRainbow").addEventListener("click", function () {
      saveRGB({ rainbow: !readRGB().rainbow });
    });
    document.getElementById("custSave").addEventListener("click", function () {
      /* all settings already persist on change — this force-saves the full
       * snapshot (theme + aura + rgb) and confirms visually */
      try {
        lsSet(LS_THEME, document.documentElement.getAttribute("data-theme") || "forest");
        saveAura(readAura());
        saveRGB(readRGB());
      } catch (e) {}
      var tick = document.getElementById("saveTick");
      if (tick) {
        tick.classList.add("show");
        setTimeout(function () { tick.classList.remove("show"); }, 1400);
      }
    });

    applyTheme(lsGet(LS_THEME) || "forest", false);
    applyAura();
    applyRGB();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCustomize);
  } else {
    initCustomize();
  }
})();

/* ================= v6 "THE MIXTURE" =================
 * Seele: prompt-first hero + category cards. Ludo: animated gallery cards,
 * motion presets, export bundle (PNG + GIF + JSON). PixelLab: pixel-art
 * polish (facing flip). Design refs: scroll-reveal entrances, living
 * background parallax, responsive type scale, focus-visible polish.
 * Everything below is additive — v1-v5 behavior is untouched. */

const BRAND = {
  name: "m4ster FrameLab",
  tool: "m4ster-framelab",
  tagline: "For the gamers, by the gamers",
};

state.flipX = false;         // character facing: false = right, true = left (non-destructive view)
/* (v6.6: slicer playback lives on state.slicer.fps/.playback; slicerT/slicerDir below) */

/* ---------- facing flip: non-destructive view transform, like curation ---------- */
function drawFrameAt(ctx, frame, x, y) {
  if (!state.flipX) { ctx.drawImage(frame, x, y); return; }
  ctx.save();
  ctx.translate(x + frame.width, y);
  ctx.scale(-1, 1);
  ctx.drawImage(frame, 0, 0);
  ctx.restore();
}

function flippedCopy(c) {
  const o = makeCanvas(c.width, c.height);
  const x = o.getContext("2d");
  x.translate(c.width, 0); x.scale(-1, 1);
  x.drawImage(c, 0, 0);
  return o;
}

/* ---------- GIF encoder (export bundle) ----------
 * Minimal GIF89a writer: global 256-color table (index 0 = transparent),
 * per-frame GCE + LZW image data, NETSCAPE infinite loop. Pixel art
 * compresses well; frames are normalized bottom-center before encoding. */
function downloadBytes(u8, filename, mime) {
  const blob = new Blob([u8], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, nextCode = eoi + 1;
  const dict = new Map();
  const out = [];
  let buf = 0, bits = 0;
  const emit = (code) => {
    buf |= code << bits; bits += codeSize;
    while (bits >= 8) { out.push(buf & 255); buf >>= 8; bits -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 256 + k;
    if (dict.has(key)) { prefix = dict.get(key); continue; }
    emit(prefix);
    if (nextCode < 4096) {
      dict.set(key, nextCode++);
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear); dict.clear(); nextCode = eoi + 1; codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) out.push(buf & 255);
  const blocks = [];
  for (let i = 0; i < out.length; i += 255) blocks.push(out.slice(i, Math.min(i + 255, out.length)));
  return blocks;
}

function encodeGIF(frames, fps) {
  if (!frames.length) fail("no frames to encode");
  const src = frames.map(f => state.flipX ? flippedCopy(f) : f);
  let W = 0, H = 0;
  for (const f of src) { W = Math.max(W, f.width); H = Math.max(H, f.height); }
  W = Math.min(512, W); H = Math.min(512, H);
  const norm = src.map(f => {
    const c = makeCanvas(W, H);
    const x = c.getContext("2d");
    const s = Math.min(W / f.width, H / f.height, 1);
    const dw = Math.max(1, Math.round(f.width * s)), dh = Math.max(1, Math.round(f.height * s));
    x.imageSmoothingEnabled = false;
    x.drawImage(f, Math.round((W - dw) / 2), H - dh, dw, dh); // bottom-center: stable feet
    return x.getImageData(0, 0, W, H).data;
  });
  // palette: index 0 = transparent, then the 255 most-frequent colors
  const freq = new Map();
  for (const px of norm) {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] <= 12) continue;
      const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      freq.set(key, (freq.get(key) || 0) + 1);
    }
  }
  const colors = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 255).map(e => e[0]);
  const table = new Uint8Array(256 * 3);
  const lut = new Map();
  colors.forEach((c, i) => {
    lut.set(c, i + 1);
    table[(i + 1) * 3] = (c >> 16) & 255;
    table[(i + 1) * 3 + 1] = (c >> 8) & 255;
    table[(i + 1) * 3 + 2] = c & 255;
  });
  const nearest = (r, g, b) => {
    let best = 1, bd = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const dr = r - ((c >> 16) & 255), dg = g - ((c >> 8) & 255), db = b - (c & 255);
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i + 1; }
    }
    return best;
  };
  const bytes = [];
  const pushStr = s => { for (const ch of s) bytes.push(ch.charCodeAt(0)); };
  const w16 = n => bytes.push(n & 255, (n >> 8) & 255);
  pushStr("GIF89a");
  w16(W); w16(H);
  bytes.push(0xF7, 0, 0); // GCT flag + 8-bit resolution + 256-entry table
  for (const b of table) bytes.push(b);
  bytes.push(0x21, 0xFF, 0x0B); // NETSCAPE infinite loop
  pushStr("NETSCAPE2.0");
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);
  const delay = Math.max(2, Math.round(100 / (fps || 8)));
  for (const px of norm) {
    const idx = new Array(W * H);
    for (let p = 0, i = 0; p < px.length; p += 4, i++) {
      if (px[p + 3] <= 12) { idx[i] = 0; continue; }
      const key = (px[p] << 16) | (px[p + 1] << 8) | px[p + 2];
      idx[i] = lut.has(key) ? lut.get(key) : nearest(px[p], px[p + 1], px[p + 2]);
    }
    bytes.push(0x21, 0xF9, 0x04, 0x09, delay & 255, (delay >> 8) & 255, 0x00, 0x00); // GCE: disposal 2, transparent idx 0
    bytes.push(0x2C, 0x00, 0x00, 0x00, 0x00);
    w16(W); w16(H);
    bytes.push(0x00, 0x08); // no local table, LZW min code size 8
    for (const blk of lzwEncode(idx, 8)) { bytes.push(blk.length); for (const b of blk) bytes.push(b); }
    bytes.push(0x00);
  }
  bytes.push(0x3B);
  return new Uint8Array(bytes);
}

/* ---------- animated gallery (Ludo card anatomy: moving preview,
 * STYLE · FRAME COUNT label, prompt underneath, click opens it in the lab) ---------- */
function sliceStrip(strip, count) {
  const fw = Math.max(1, Math.round(strip.width / count));
  const out = [];
  for (let i = 0; i < count; i++) {
    const c = makeCanvas(fw, strip.height);
    c.getContext("2d").drawImage(strip, i * fw, 0, fw, strip.height, 0, 0, fw, strip.height);
    out.push(c);
  }
  return out;
}

const GALLERY = [
  { style: "PIXEL HERO", n: 4, prompt: "pixel hero walk cycle, side view",
    build: () => sliceStrip(procCharacter({ archetype: "biped", palette: "classic", frames: 4 }, "walk", 4242), 4),
    gen: { cat: "character", src: "procedural", states: ["walk"], frames: 4, archetype: "biped" } },
  { style: "ROBOT", n: 4, prompt: "idle robot, blinking visor",
    build: () => sliceStrip(procCharacter({ archetype: "robot", palette: "classic", frames: 4 }, "idle", 777), 4),
    gen: { cat: "character", src: "procedural", states: ["idle"], frames: 4, archetype: "robot" } },
  { style: "SLIME", n: 4, prompt: "slime hop, squash and stretch",
    build: () => sliceStrip(procCharacter({ archetype: "slime", palette: "toxic", frames: 4 }, "jump", 31337), 4),
    gen: { cat: "character", src: "procedural", states: ["jump"], frames: 4, archetype: "slime" } },
  { style: "FLYER", n: 4, prompt: "bird flapping, side view",
    build: () => sliceStrip(procCharacter({ archetype: "flyer", palette: "classic", frames: 4 }, "walk", 9001), 4),
    gen: { cat: "character", src: "procedural", states: ["walk"], frames: 4, archetype: "flyer" } },
  { style: "EFFECT", n: 8, prompt: "fiery explosion, ignition to smoke",
    build: () => sliceStrip(procEffect("explosion", 8, 555), 8),
    gen: { cat: "effect", src: "procedural", type: "explosion", frames: 8 } },
  { style: "EFFECT", n: 8, prompt: "campfire flames, seamless loop",
    build: () => sliceStrip(procEffect("fire", 8, 888), 8),
    gen: { cat: "effect", src: "procedural", type: "fire", frames: 8 } },
  { style: "UI", n: 4, prompt: "spinning gold coin",
    build: () => sliceStrip(procUI("coin", 4, 1212), 4),
    gen: { cat: "ui", src: "procedural", kind: "coin", states: 4 } },
  { style: "TILE", n: 2, prompt: "animated water tile",
    build: () => procTile("water", 64, 3434),
    gen: { cat: "tile", src: "procedural", pattern: "water", size: 64 } },
];

/* one shared rAF drives every showcase canvas (gallery + presets) — cheaper
 * than a loop per card, paused when the tab hides or reduced-motion is on. */
const showcaseAnims = [];
let showcaseRAF = 0;
const reduceMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

function drawShowcaseFrame(a) {
  const ctx = a.cv.getContext("2d");
  const f = a.frames[a.idx % a.frames.length];
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, a.cv.width, a.cv.height);
  const s = Math.min(a.cv.width / f.width, a.cv.height / f.height);
  const dw = Math.max(1, Math.floor(f.width * s)), dh = Math.max(1, Math.floor(f.height * s));
  ctx.drawImage(f, Math.floor((a.cv.width - dw) / 2), Math.floor((a.cv.height - dh) / 2), dw, dh);
}

function showcaseAdd(cv, frames, fps) {
  const a = { cv, frames, fps: fps || 8, idx: 0, last: 0 };
  drawShowcaseFrame(a);
  showcaseAnims.push(a);
}

function showcaseLoop(now) {
  showcaseRAF = requestAnimationFrame(showcaseLoop);
  for (const a of showcaseAnims) {
    if (now - a.last < 1000 / a.fps) continue;
    a.last = now;
    a.idx = (a.idx + 1) % a.frames.length;
    drawShowcaseFrame(a);
  }
}

function showcaseStart() {
  if (reduceMotion() || showcaseRAF) return;
  showcaseRAF = requestAnimationFrame(showcaseLoop);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { cancelAnimationFrame(showcaseRAF); showcaseRAF = 0; }
  else showcaseStart();
});

function renderGallery() {
  const grid = $("#galleryGrid");
  if (!grid) return;
  grid.innerHTML = "";
  GALLERY.forEach((g, gi) => {
    const card = document.createElement("article");
    card.className = "gcard reveal";
    card.style.setProperty("--d", ((gi % 4) * 0.07).toFixed(2) + "s");
    const cv = document.createElement("canvas");
    cv.width = 160; cv.height = 160;
    cv.className = "gcanvas";
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", g.style + " animation preview");
    const lab = document.createElement("div");
    lab.className = "glabel";
    const b = document.createElement("b"); b.textContent = g.style;
    const sp = document.createElement("span"); sp.textContent = ` · ${g.n} FRAMES`;
    lab.append(b, sp);
    const pr = document.createElement("p");
    pr.className = "gprompt";
    pr.textContent = "\u201C" + g.prompt + "\u201D";
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "gopen";
    btn.textContent = "Open in lab \u2192";
    btn.setAttribute("aria-label", `Open ${g.prompt} in the lab`);
    btn.onclick = () => applyGalleryConfig(g);
    card.append(cv, lab, pr, btn);
    grid.appendChild(card);
    try {
      const frames = g.build();
      if (frames.length) showcaseAdd(cv, frames, g.n > 4 ? 10 : 8);
    } catch (e) { /* one broken card never breaks the page */ }
  });
}

function applyGalleryConfig(item) {
  const g = item.gen || {};
  const tab = document.querySelector(`.tab[data-cat="${g.cat}"]`);
  if (tab) tab.click(); // re-renders params to defaults
  if (g.src && g.src !== "upload") {
    const srcBtn = document.querySelector(`#sourceSeg .seg-btn[data-src="${g.src}"]`);
    if (srcBtn) srcBtn.click();
  }
  if (g.cat === "character") {
    document.querySelectorAll("#stateRow input").forEach(i => { i.checked = (g.states || []).includes(i.dataset.state); });
    if (g.frames) $("#pFrames").value = g.frames;
    if (g.archetype) $("#pArch").value = g.archetype;
  } else if (g.cat === "effect") {
    if (g.type) $("#pType").value = g.type;
    if (g.frames) $("#pFrames").value = g.frames;
  } else if (g.cat === "tile") {
    if (g.pattern) $("#pPattern").value = g.pattern;
    if (g.size) $("#pSize").value = String(g.size);
  } else if (g.cat === "ui") {
    if (g.kind) $("#pKind").value = g.kind;
    if (g.states) $("#pStates").value = g.states;
  }
  if (item.prompt) $("#prompt").value = item.prompt;
  document.getElementById("tool").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => { if (!state.busy) runPipeline(); }, 450);
}

/* ---------- motion presets (Ludo pattern): named motions with live previews.
 * Clicking one drives procedural characters (sets the state + regenerates)
 * or split animations (sets fps + playback mode). ---------- */
const MOTION_PRESETS = [
  { id: "idle",   label: "Idle",   fps: 6,  playback: "pingpong" },
  { id: "walk",   label: "Walk",   fps: 8,  playback: "loop" },
  { id: "run",    label: "Run",    fps: 10, playback: "loop" },
  { id: "jump",   label: "Jump",   fps: 8,  playback: "once" },
  { id: "attack", label: "Attack", fps: 10, playback: "once" },
];

function renderPresets() {
  const row = $("#presetRow");
  if (!row) return;
  row.innerHTML = "";
  MOTION_PRESETS.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-chip reveal";
    btn.dataset.preset = p.id;
    btn.style.setProperty("--d", (i * 0.05).toFixed(2) + "s");
    btn.setAttribute("aria-label", `Apply ${p.label} motion, ${p.fps} frames per second`);
    const cv = document.createElement("canvas");
    cv.width = 64; cv.height = 64; cv.className = "pcanvas";
    cv.setAttribute("aria-hidden", "true");
    const lb = document.createElement("span");
    lb.className = "plabel";
    lb.innerHTML = `${p.label}<small>${p.fps}fps</small>`;
    btn.append(cv, lb);
    btn.onclick = () => applyPreset(p);
    row.appendChild(btn);
    try {
      const frames = sliceStrip(procCharacter({ archetype: "biped", palette: "classic", frames: 4 }, p.id, 20240 + i), 4);
      showcaseAdd(cv, frames, p.fps);
    } catch (e) { /* never break the page */ }
  });
}

function applyPreset(p) {
  document.querySelectorAll(".preset-chip").forEach(c => c.classList.toggle("active", c.dataset.preset === p.id));
  if (state.slicer && state.slicer.sheet && state.slicer.pieces.length) {
    state.slicer.fps = p.fps; state.slicer.playback = p.playback;
    slicerT = 0; slicerDir = 1;
    const fs = $("#slFps"); if (fs) fs.value = String(p.fps);
    document.querySelectorAll("#slPlaybackSeg .seg-btn").forEach(x => x.classList.toggle("active", x.dataset.playback === p.playback));
    slicerPreview();
    stageMsg(`preset "${p.label}" → slice playback: ${p.fps}fps, ${p.playback}`);
    return;
  }
  if (state.category === "character") {
    const boxes = document.querySelectorAll("#stateRow input");
    if (!boxes.length) return;
    boxes.forEach(i => { i.checked = i.dataset.state === p.id; });
    const fsel = $("#previewFps");
    if (fsel) fsel.value = String(p.fps);
    document.getElementById("tool").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => { if (!state.busy) runPipeline(); }, 450);
  } else {
    stageMsg(`preset "${p.label}" drives characters + split animations — switch to the Character tab or upload a sheet.`, "warn");
  }
}

/* ---------- export bundle: PNG + GIF + JSON in one click ---------- */
function currentExportFrames() {
  if (state.slicer && state.slicer.selection.length) return state.slicer.selection.map(i => state.slicer.pieces[i].canvas);
  const r = state.rows[previewRow];
  return r ? r.order.map(fi => r.frames[fi]) : [];
}

function currentExportFps() {
  if (state.slicer && state.slicer.sheet && state.slicer.fps) return state.slicer.fps;
  const sel = +((($("#previewFps") || {}).value) || 8);
  const r = state.rows[previewRow];
  return (r && r.fps) || sel;
}

function initV6() {
  renderGallery();
  renderPresets();
  showcaseStart();

  /* logo = home: clicking the brand mark returns to the top (hero, first screen) */
  const brandHome = document.getElementById("brandHome");
  if (brandHome) {
    brandHome.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
    });
  }

  /* prompt-first hero: type, hit MAKE IT, land in the lab generating */
  const heroGo = () => {
    const hp = $("#heroPrompt");
    const t = hp ? hp.value.trim() : "";
    if (t) $("#prompt").value = t;
    const tool = document.getElementById("tool");
    if (tool) tool.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => { if (!state.busy) runPipeline(); }, 450);
  };
  const heroBtn = $("#heroGenerate"), heroPrompt = $("#heroPrompt");
  if (heroBtn) heroBtn.onclick = heroGo;
  if (heroPrompt) heroPrompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) heroGo();
  });

  /* category cards: pick a lane, land in the lab */
  document.querySelectorAll(".cat-card").forEach(c => {
    c.onclick = () => {
      const cat = c.dataset.cat;
      const tab = document.querySelector(`.tab[data-cat="${cat}"]`);
      if (tab) tab.click();
      document.getElementById("tool").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });

  /* tool cards: standalone utilities — same category machinery as the
   * tabs, but they live OUTSIDE the generation flow */
  document.querySelectorAll(".tool-card").forEach(c => {
    c.onclick = () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      document.querySelectorAll(".tool-card").forEach(x => x.classList.remove("active"));
      c.classList.add("active");
      state.category = c.dataset.cat;
      cancelAnimationFrame(slicerRAF);
      renderParams();
      syncPixelMode();
      syncSlicerMode();
      syncAiModelUI();
      document.getElementById("tool").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });

  /* facing flip (delegated: renderParams re-renders #params on tab switch) */
  const paramsBox = $("#params");
  if (paramsBox) paramsBox.addEventListener("click", (e) => {
    const b = e.target.closest("[data-flip]");
    if (!b) return;
    document.querySelectorAll("#pFlipSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
    state.flipX = b.dataset.flip === "1";
    if (state.rows.length && state.atlas) {
      state.atlas = buildAtlas(state.rows);
      renderFramesUI();
      startPreview();
      showStage(state.atlas.canvas, "atlas rebuilt — facing " + (state.flipX ? "left" : "right"));
    } else if (state.slicer && state.slicer.sheet) {
      slicerPreview();
      updateSlicerExport();
    }
  });

  /* one-click bundle: sheet PNG + animated GIF preview + manifest JSON.
   * v6.1: staggered ~400ms apart so no download gets swallowed by the browser. */
  const dlBundle = $("#dlBundle");
  if (dlBundle) dlBundle.onclick = () => {
    if (!state.atlas) return;
    const frames = currentExportFrames();
    const fps = currentExportFps();
    downloadCanvas(state.atlas.canvas, state.atlas.pngName); // t+0: PNG sheet
    if (frames.length) {
      setTimeout(() => {
        try {
          const gif = encodeGIF(frames, fps);
          downloadBytes(gif, state.atlas.pngName.replace(/\.png$/, "") + "-preview.gif", "image/gif");
        } catch (e) { stageMsg("GIF encode failed: " + e.message, true); }
      }, 400); // t+400: animated GIF
    }
    setTimeout(() => downloadJSON(state.atlas.manifest, state.atlas.jsonName), 800); // t+800: manifest JSON
  };

/* ---------- v6.1: scroll-reveal entrances, progressive-enhanced.
 * Default state is VISIBLE — .reveal only hides when JS adds .js to <html>,
 * and the observer flips .in. If the observer never fires, content still shows.
 * Observes EVERY .reveal/.reveal-pop (gallery cards + preset chips included —
 * v6 left them unobserved and they never painted). */
const REVEAL_SELECTOR = ".reveal, .reveal-pop";
function initReveals(doc) {
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }
  }, { threshold: 0.1 });
  doc.querySelectorAll(REVEAL_SELECTOR).forEach((el, i) => {
    if (!el.style.getPropertyValue("--d")) {
      el.style.setProperty("--d", Math.min(0.45, (i % 7) * 0.06).toFixed(2) + "s");
    }
    io.observe(el);
  });
  return io;
}

/* entrance choreography: hero + category cards pop, everything else rises */
function initEntrances(doc) {
  doc.querySelectorAll(".hero-inner, .cat-card").forEach(el => el.classList.add("reveal-pop"));
  doc.querySelectorAll(".section-title, #tool .panel, .foot > span").forEach(el => {
    if (!el.classList.contains("reveal") && !el.classList.contains("reveal-pop")) el.classList.add("reveal");
  });
  return initReveals(doc);
}

  /* entrance choreography: hero + category cards pop, everything else rises */
  initEntrances(document);

  /* living background: scroll parallax on the aura (transform-only, cheap) */
  const aura = $("#aura");
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking || reduceMotion() || !aura) return;
    ticking = true;
    requestAnimationFrame(() => {
      aura.style.transform = `translate3d(0, ${Math.round(window.scrollY * 0.06)}px, 0)`;
      ticking = false;
    });
  }, { passive: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initV6);
} else {
  initV6();
}

/* ---------- v6.5: m4ster signature cursor (orb) + aura parallax ----------
 * Desktop/fine-pointer only; skipped entirely on touch + reduced-motion.
 * Orb glow is theme-accent via CSS (--violet). Download/export/generate
 * CTAs trigger the signature pulse-ring state. */
(function () {
  "use strict";
  if (!window.matchMedia) return;
  var fine = window.matchMedia("(pointer: fine)").matches;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || reduced) return;

  var orb = document.createElement("div");
  orb.className = "cursor-orb";
  orb.setAttribute("aria-hidden", "true");
  document.body.appendChild(orb);
  /* v6.9.1: the native cursor stays visible until the orb has actually
   * tracked the pointer once (see mousemove below). Hiding it at load
   * left users with NO cursor at all whenever the orb never moved. */

  /* v6.8: cursor glow trail (5IN1 GridGlow idea) — canvas overlay paints
   * fading theme-colored glow spots where the cursor travels. */
  var trail = document.createElement("canvas");
  trail.id = "cursor-trail";
  trail.setAttribute("aria-hidden", "true");
  document.body.appendChild(trail);
  var tctx = trail.getContext("2d");
  var spots = [];
  var TR_LIFE = 900, TR_MAX = 50, TR_GAP = 18, trLast = 0;
  function sizeTrail() {
    trail.width = Math.max(1, window.innerWidth);
    trail.height = Math.max(1, window.innerHeight);
  }
  sizeTrail();
  window.addEventListener("resize", sizeTrail);
  var themeGlow = "34,197,94"; /* forest green default; synced from --violet below */
  function syncThemeGlow(){
    try{
      var v = getComputedStyle(document.documentElement).getPropertyValue("--violet").trim();
      var m = v.match(/^#([0-9a-f]{6})$/i);
      if(m){ var n = parseInt(m[1], 16); themeGlow = ((n>>16)&255) + "," + ((n>>8)&255) + "," + (n&255); }
    }catch(e){}
  }
  syncThemeGlow();
  try{ new MutationObserver(syncThemeGlow).observe(document.documentElement, {attributes:true, attributeFilter:["data-theme"]}); }catch(e){}
  function drawTrail(now) {
    tctx.clearRect(0, 0, trail.width, trail.height);
    for (var i = spots.length - 1; i >= 0; i--) {
      var s = spots[i], age = now - s.born;
      if (age > TR_LIFE) { spots.splice(i, 1); continue; }
      var k = 1 - age / TR_LIFE, r = 90 * (0.5 + 0.5 * k);
      var g = tctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      g.addColorStop(0, "rgba(" + themeGlow + "," + (0.28 * k).toFixed(3) + ")");
      g.addColorStop(1, "rgba(" + themeGlow + ",0)");
      tctx.fillStyle = g;
      tctx.beginPath(); tctx.arc(s.x, s.y, r, 0, 6.2832); tctx.fill();
    }
  }

  var tx = -100, ty = -100, x = -100, y = -100; /* target / lerped orb pos */
  /* page runs at 115% CSS zoom: mouse client coords are viewport space but the
   * orb lives inside the zoomed document, so divide by the effective zoom to
   * land the orb exactly on the pointer (else it drifts down-right). */
  var Z = 1;
  function measureZoom() {
    /* getBoundingClientRect on <html> can't reveal CSS zoom (root always
     * matches the viewport) — use a 100px probe div: its rendered width
     * IS affected by the inherited zoom */
    try {
      var d = document.createElement("div");
      d.style.cssText = "position:absolute;left:0;top:0;width:100px;height:10px;visibility:hidden;pointer-events:none;";
      document.body.appendChild(d);
      var z = d.getBoundingClientRect().width / 100;
      d.remove();
      if (z > 0.5 && z < 4) Z = z;
    } catch (e) {}
  }
  measureZoom();
  window.addEventListener("resize", measureZoom);
  var ax = 0, ay = 0;                            /* lerped aura parallax -1..1 */
  var HOVER = "a, button, input, select, textarea, .gcard, .cat-card, .preset-chip, " +
              ".swatch, .tab, .seg-btn, .stepper li, .icon-btn, .frame-card, " +
              ".key, label, summary, [role=button]";
  var CTA = "#dlBundle, #dlSheet, #dlJson, #dlFrames, #dlAnim, #dlGodot, #dlUnity, " +
            "#generate, #heroGenerate, #generateMobile";

  var orbLive = false;
  document.addEventListener("mousemove", function (e) {
    tx = e.clientX / Z; ty = e.clientY / Z;
    if (!orbLive) {
      orbLive = true;
      x = tx; y = ty; /* snap onto the pointer on first move — no glide-in from off-screen */
      orb.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0)";
      document.documentElement.classList.add("has-orb");
    }
    var now = performance.now();
    if (now - trLast >= TR_GAP) {
      trLast = now;
      spots.push({ x: e.clientX, y: e.clientY, born: now });
      if (spots.length > TR_MAX) spots.splice(0, spots.length - TR_MAX);
    }
  }, { passive: true });
  document.addEventListener("mouseout", function (e) {
    if (!e.relatedTarget) orb.style.opacity = "0";
  });
  document.addEventListener("mouseover", function (e) {
    if (orb.style.opacity === "0") orb.style.opacity = "";
  });

  function closest(el, sel) {
    while (el && el !== document.documentElement) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentNode;
    }
    return null;
  }

  document.addEventListener("mouseover", function (e) {
    var cta = closest(e.target, CTA);
    var hov = cta || closest(e.target, HOVER);
    orb.classList.toggle("is-cta", !!(cta && !cta.disabled));
    orb.classList.toggle("is-hover", !!(hov && !hov.disabled && !(cta && !cta.disabled)));
  }, { passive: true });

  var auraEl = document.getElementById("aura");
  var lastT = "", lastA = "";
  (function tick() {
    try {
    /* tight follow (was 0.22 — felt floaty) + snap when converged, so the
     * loop writes nothing once the orb settles instead of micro-lerping */
    var dx = tx - x, dy = ty - y;
    if (dx * dx + dy * dy < 0.01) { x = tx; y = ty; }
    else { x += dx * 0.45; y += dy * 0.45; }
    var k = x.toFixed(1) + "," + y.toFixed(1);
    if (k !== lastT) {
      orb.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0)";
      lastT = k;
    }
    /* aura parallax: direct composited transform on the aura layer, written
     * only when it changed — the old :root var write forced a full style
     * recalc every frame, which was the jank */
    var nx = (tx / window.innerWidth - 0.5) * 2;
    var ny = (ty / window.innerHeight - 0.5) * 2;
    ax += (nx - ax) * 0.08; ay += (ny - ay) * 0.08;
    var ak = (ax * 1.5).toFixed(2) + "," + (ay * 1.5).toFixed(2);
    if (ak !== lastA && auraEl) {
      auraEl.style.transform = "translate3d(" + (ax * 1.5).toFixed(2) + "vmax," + (ay * 1.5).toFixed(2) + "vmax,0)";
      lastA = ak;
    }
    /* cursor glow trail (5IN1 GridGlow): fading spots, drawn only while moving */
    if (tctx && spots.length) drawTrail(performance.now());
    else if (tctx && trail.width) tctx.clearRect(0, 0, trail.width, trail.height);
    } finally { requestAnimationFrame(tick); /* a trail failure must never freeze the orb */ }
  })();
})();

/* v6.9: PWA — register SW, Install App button (Download section only).
 * Button shows on beforeinstallprompt, hides after install or 6s timeout,
 * and never shows when already running as installed PWA (standalone). */
(function () {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
  var btn = document.getElementById("installApp");
  if (!btn) return;
  var isStandalone = window.matchMedia("(display-mode: standalone)").matches ||
                     window.navigator.standalone === true;
  if (isStandalone) return; /* installed — already fullscreen, no button */
  var deferred = null, hideTimer = null;
  function hide() { btn.hidden = true; if (hideTimer) clearTimeout(hideTimer); }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
    hideTimer = setTimeout(hide, 6000); /* auto-hide if ignored */
  });
  btn.addEventListener("click", function () {
    if (!deferred) { hide(); return; }
    deferred.prompt();
    deferred.userChoice.then(function () { hide(); deferred = null; });
  });
  window.addEventListener("appinstalled", hide);
})();

/* ---------------- TEST BUILD: AI studio cards + 2D/3D flip ----------------
 * The competitor flow (describe -> action cards -> style cards -> perspective
 * -> frames) rebuilt on OUR pipeline: the cards drive the exact same
 * #pStyle / #pView / #pFrames / state-checkbox inputs readParams() already
 * reads, so generation, keying, slicing and exports are untouched. */
const STUDIO_STYLES = [
  { label: "Clean 2D", icon: "\u{1F7E6}", phrase: "flat 2D game sprite, absolutely no 3D, no 3D render, no volumetric lighting, solid flat colors, crisp edges" },
  { label: "Pixel Retro", icon: "\u{1F47E}", phrase: "retro pixel art, visible square pixels, limited 16-color palette, 16-bit game sprite, absolutely no 3D, no smooth 3D shading" },
  { label: "Pixel HD", icon: "\u{1F5A5}\u{FE0F}", phrase: "crisp high-detail pixel art, clean pixel clusters, rich harmonious palette, absolutely no 3D, no smooth shading" },
  { label: "Anime Cel", icon: "\u{26E9}\u{FE0F}", phrase: "anime cel-shaded 2D, clean line art, flat cel colors, absolutely no 3D" },
  { label: "Cartoon", icon: "\u{1F3AC}", phrase: "2D cartoon, flat colors, bold outlines, hand-drawn animation cel style, absolutely no 3D" },
  { label: "Cartoon Smooth", icon: "\u{1F36D}", phrase: "smooth 2D cartoon, soft rounded shapes, flat colors, bold outlines, absolutely no 3D" },
  { label: "Comic Bold", icon: "\u{1F4A5}", phrase: "bold comic book 2D, heavy ink outlines, flat vivid colors, absolutely no 3D" },
  { label: "Dark Fantasy", icon: "\u{1F52E}", phrase: "dark fantasy 2D game art, flat painterly 2D illustration, moody lighting, absolutely no 3D render" },
  { label: "Chibi Cute", icon: "\u{1F43B}", phrase: "chibi 2D, big head small body, cute proportions, flat colors, bold outlines, absolutely no 3D" },
  { label: "Cyberpunk", icon: "\u{1F916}", phrase: "cyberpunk 2D game art, neon rim light, flat colors, dark backdrop mood, absolutely no 3D render" },
  { label: "Watercolor", icon: "\u{1F3A8}", phrase: "2D watercolor illustration, soft pigment edges, readable game sprite silhouette, absolutely no 3D" },
  { label: "Flat Minimal", icon: "\u{1F4D0}", phrase: "flat minimal 2D vector style, simple geometric shapes, solid colors, absolutely no 3D" },
  { label: "Sketch Pencil", icon: "\u{270F}\u{FE0F}", phrase: "2D pencil sketch game art, hand-drawn graphite lines, light flat color wash, absolutely no 3D" }
];
function styleOptionsHtml() {
  return STUDIO_STYLES.map(st => `<option value="${st.phrase}">${st.label.toLowerCase()}</option>`).join("");
}

function syncStudio() {
  const panel = document.getElementById("studioPanel");
  if (!panel) return;
  const show = state.source === "ai" && state.category === "character";
  panel.hidden = !show;
  /* the cards replace the classic fields they mirror — hide the duplicates
   * while the studio is up, restore them for procedural / other categories */
  const dup = show ? "none" : "";
  const hideDup = (el) => { if (el) el.style.display = dup; };
  hideDup(document.querySelector("#pStyle")?.closest(".pfield"));
  hideDup(document.querySelector("#pView")?.closest(".pfield"));
  hideDup(document.querySelector("#pFrames")?.closest(".pfield"));
  hideDup(document.getElementById("stateRow"));
  hideDup(document.getElementById("stateCostNote")?.closest(".field-label"));
  if (!show) return;
  const sel = document.getElementById("pStyle");
  panel.querySelectorAll("#styleGrid .pick-card").forEach(c =>
    c.classList.toggle("active", !!sel && c.dataset.phrase === sel.value));
  const view = document.getElementById("pView");
  panel.querySelectorAll("#perspGrid .pick-card").forEach(c =>
    c.classList.toggle("active", !!view && c.dataset.view === view.value));
  panel.querySelectorAll("#actGrid .pick-card").forEach(c => {
    const box = document.querySelector(`#stateRow input[data-state="${c.dataset.state}"]`);
    c.classList.toggle("active", !!box && box.checked);
  });
  const fr = document.getElementById("pFrames");
  const frVal = document.getElementById("frVal");
  if (fr && frVal) frVal.textContent = fr.value;
}

function wireStudio() {
  const grid = document.getElementById("styleGrid");
  if (grid && !grid.children.length) {
    grid.innerHTML = STUDIO_STYLES.map(st =>
      `<button type="button" class="pick-card" data-phrase="${st.phrase}"><span class="pc-icon">${st.icon}</span><span class="pc-label">${st.label}</span></button>`).join("");
  }
  const panel = document.getElementById("studioPanel");
  if (!panel || panel.dataset.wired) return;
  panel.dataset.wired = "1";
  panel.addEventListener("click", (e) => {
    const card = e.target.closest(".pick-card");
    if (card) {
      if (card.dataset.phrase) {
        const sel = document.getElementById("pStyle");
        if (sel) sel.value = card.dataset.phrase;
      } else if (card.dataset.view) {
        const v = document.getElementById("pView");
        if (v) v.value = card.dataset.view;
      } else if (card.dataset.state) {
        const box = document.querySelector(`#stateRow input[data-state="${card.dataset.state}"]`);
        if (box) box.click();
      }
      syncStudio();
      return;
    }
    if (e.target.id === "frMinus" || e.target.id === "frPlus") {
      const fr = document.getElementById("pFrames");
      if (fr) {
        const d = e.target.id === "frPlus" ? 1 : -1;
        fr.value = String(Math.min(12, Math.max(2, (parseInt(fr.value, 10) || 4) + d)));
      }
      syncStudio();
    }
    if (e.target.id === "procBtn") {
      const tab = document.querySelector('.tool-card[data-cat="slicer"]');
      if (tab) tab.click();
      setTimeout(() => { const b = document.getElementById("slPick"); if (b) b.click(); }, 90);
    }
  });
}

/* the hub flip: 2D sprites now, 3D mesh next — same top bar, same rules */
function applyDim(dim) {
  const is3d = dim === "3d";
  document.body.classList.toggle("dim-3d", is3d);
  const lab3d = document.getElementById("lab3d");
  if (lab3d) lab3d.hidden = !is3d;
  const tool = document.getElementById("tool");
  if (tool) tool.style.display = is3d ? "none" : "";
  const mb = document.querySelector(".mobile-bar");
  if (mb) mb.style.display = is3d ? "none" : "";
  const f2 = document.getElementById("flip2d"), f3 = document.getElementById("flip3d");
  if (f2) f2.classList.toggle("active", !is3d);
  if (f3) f3.classList.toggle("active", is3d);
  try { localStorage.setItem("m4ster.dim", is3d ? "3d" : "2d"); } catch (e) {}
}
function wireFlip() {
  const f2 = document.getElementById("flip2d"), f3 = document.getElementById("flip3d");
  if (f2) f2.addEventListener("click", () => applyDim("2d"));
  if (f3) f3.addEventListener("click", () => applyDim("3d"));
  let saved = "2d";
  try { saved = localStorage.getItem("m4ster.dim") || "2d"; } catch (e) {}
  if (saved === "3d") applyDim("3d");
}

/* ============ 3D LAB — image → mesh on free HF Spaces (test build) ========
 * The providers were proven end-to-end in the provider lab
 * (~/workspace/framelab-provider-lab/results-3d-round1.json + round2):
 * no HF token, no cookies, real GLB out. Stable Fast 3D speaks Gradio 4
 * at the space root; InstantMesh and TRELLIS.2 speak Gradio 5/6 under
 * /gradio_api. Chain order inside each provider is mandatory — the
 * spaces hold gr.State server-side per session_hash, and skipping a step
 * fails server-side. ZeroGPU quota errors are switch signals in AUTO:
 * the free GPU budget is per-IP and shared, so a busy budget on one
 * space says nothing about the next. An optional HF token (the SAME one
 * the 2D side stores for HF FLUX — localStorage "m4ster.aiKeys", JSON
 * property "huggingface", see aiKeyFor) lifts that quota: when saved, it
 * rides every request below as an Authorization header. It is read once
 * at run start into M3_TOKEN — never logged, never sent anywhere else. */
const M3_PROVIDERS = {
  sf3d: { name: "Stable Fast 3D", host: "https://stabilityai-stable-fast-3d.hf.space", base: "" },
  trellis2: { name: "TRELLIS.2", host: "https://microsoft-trellis-2.hf.space", base: "/gradio_api" },
  instantmesh: { name: "InstantMesh", host: "https://tencentarc-instantmesh.hf.space", base: "/gradio_api" },
  trellis: { name: "TRELLIS (community)", host: "https://trellis-community-trellis.hf.space", base: "/gradio_api" },
  "hunyuan-mini": { name: "Hunyuan3D-2 Mini Turbo", host: "https://tencent-hunyuan3d-2mini-turbo.hf.space", base: "" }
};
const M3_TIMEOUT_MS = 4 * 60 * 1000; /* per provider, whole chain */
let M3_TOKEN = "";
function m3AuthHeaders() {
  return M3_TOKEN ? { "Authorization": "Bearer " + M3_TOKEN } : {};
}

function m3Session() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function m3FileUrl(prov, fd) {
  if (!fd) return null;
  if (fd.url && /^https?:/.test(fd.url)) return fd.url;
  if (fd.url) return prov.host + (fd.url.charAt(0) === "/" ? fd.url : prov.base + "/file=" + fd.url);
  if (fd.path) return prov.host + prov.base + "/file=" + fd.path;
  return null;
}
function m3TimeoutErr() {
  return new Error("timed out after 4 minutes — the free GPU queue is backed up. Wait a bit and retry.");
}
/* fetch with a deadline; an abort becomes a clear timeout error */
async function m3Fetch(url, opts, deadline) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
  try {
    const o = Object.assign({}, opts, { signal: ctrl.signal });
    if (M3_TOKEN) o.headers = Object.assign({}, opts.headers || {}, m3AuthHeaders());
    return await fetch(url, o);
  } catch (e) {
    if (e && e.name === "AbortError") throw m3TimeoutErr();
    if (e instanceof TypeError && !(opts && opts._retried) && Date.now() < deadline - 3000) {
      await new Promise((r) => setTimeout(r, 1500));
      return m3Fetch(url, Object.assign({}, opts, { _retried: true }), deadline);
    }
    throw e;
  } finally { clearTimeout(timer); }
}
async function m3Upload(prov, file, deadline) {
  const form = new FormData();
  /* field name MUST be "files" — "files[]" silently returns [] */
  form.append("files", file, file.name || "image.png");
  const res = await m3Fetch(prov.host + prov.base + "/upload", { method: "POST", body: form }, deadline);
  if (!res.ok) throw new Error("image upload failed (HTTP " + res.status + ")");
  const paths = await res.json();
  if (!Array.isArray(paths) || !paths[0]) throw new Error("image upload returned no file path");
  return paths[0];
}
function m3FileData(prov, path, file) {
  return {
    path: path,
    url: prov.host + prov.base + "/file=" + path,
    orig_name: file.name || "image.png",
    mime_type: file.type || "image/png",
    is_stream: false
  };
}
/* join the Gradio queue, then read the SSE stream until process_completed.
 * Resolves with the call's output data array; throws loud on any failure. */
async function m3Call(prov, session, fnIndex, data, deadline) {
  const join = await m3Fetch(prov.host + prov.base + "/queue/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fn_index: fnIndex, data: data, session_hash: session })
  }, deadline);
  if (!join.ok) throw new Error("couldn't join the free queue (HTTP " + join.status + ")");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
  try {
    const res = await fetch(prov.host + prov.base + "/queue/data?session_hash=" + encodeURIComponent(session), { signal: ctrl.signal, headers: m3AuthHeaders() });
    if (!res.ok || !res.body) throw new Error("queue stream failed (HTTP " + res.status + ")");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.indexOf("data:") !== 0) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (evt.msg === "process_completed") {
          const out = evt.output || {};
          if (evt.success === false || out.error || !out.data) {
            throw new Error(String(out.error || evt.error || "the provider reported a failure"));
          }
          return out.data;
        }
        if (evt.msg === "process_error") {
          throw new Error(String(evt.error || "the provider reported an error"));
        }
      }
    }
    throw new Error("the queue stream ended before the mesh finished");
  } catch (e) {
    if (e && e.name === "AbortError") throw m3TimeoutErr();
    throw e;
  } finally { clearTimeout(timer); }
}
async function m3FetchBlob(url, deadline) {
  const res = await m3Fetch(url, {}, deadline);
  if (!res.ok) throw new Error("mesh download failed (HTTP " + res.status + ")");
  return res.blob();
}

/* Stable Fast 3D: check bg → (remove bg) → run. fn 5 eats server-side state
 * populated by the earlier steps, so the order cannot be shortcut. */
async function m3RunSF3D(file, say) {
  const prov = M3_PROVIDERS.sf3d, session = m3Session();
  const deadline = Date.now() + M3_TIMEOUT_MS;
  say("Stable Fast 3D — uploading your image…");
  const fd = m3FileData(prov, await m3Upload(prov, file, deadline), file);
  say("Stable Fast 3D — checking the background…");
  const step1 = await m3Call(prov, session, 4, [fd, 0.85], deadline);
  const btn = step1 && step1[0];
  const btnVal = btn && typeof btn === "object" ? btn.value : btn;
  if (btnVal === "Remove Background") {
    say("Stable Fast 3D — removing the background…");
    await m3Call(prov, session, 5, ["Remove Background", fd, null, 0.85, "None", -1, 1024], deadline);
  }
  say("Stable Fast 3D — building your mesh (usually ~10 seconds)…");
  const step3 = await m3Call(prov, session, 5, ["Run", fd, null, 0.85, "None", -1, 1024], deadline);
  const upd = step3 && step3[4];
  const glbFd = upd && typeof upd === "object" && "value" in upd ? upd.value : upd;
  const url = m3FileUrl(prov, glbFd);
  if (!url) throw new Error("Stable Fast 3D finished but returned no mesh file");
  say("Stable Fast 3D — downloading your mesh…");
  return { glb: await m3FetchBlob(url, deadline), obj: null };
}

/* InstantMesh: preprocess → multiview → make3d. The raw multiview state
 * serializes as null over the API, so make3d gets the returned show image
 * (output[1] of generate_mvs) — the proven path from the lab round. */
async function m3RunInstantMesh(file, say) {
  const prov = M3_PROVIDERS.instantmesh, session = m3Session();
  const deadline = Date.now() + M3_TIMEOUT_MS;
  say("InstantMesh — uploading your image…");
  const fd = m3FileData(prov, await m3Upload(prov, file, deadline), file);
  say("InstantMesh — preparing the image…");
  const pre = await m3Call(prov, session, 2, [fd, true], deadline);
  const processed = pre && pre[0];
  if (!processed) throw new Error("InstantMesh preprocessing returned no image");
  say("InstantMesh — dreaming up six views of your subject…");
  const mvs = await m3Call(prov, session, 3, [processed, 75, 42], deadline);
  const showImg = mvs && mvs[1];
  if (!showImg) throw new Error("InstantMesh returned no multiview image");
  say("InstantMesh — building your mesh…");
  const made = await m3Call(prov, session, 4, [showImg], deadline);
  const objFd = made && made[0], glbFd = made && made[1];
  const glbUrl = m3FileUrl(prov, glbFd);
  if (!glbUrl) throw new Error("InstantMesh finished but returned no mesh file");
  say("InstantMesh — downloading your mesh…");
  const glb = await m3FetchBlob(glbUrl, deadline);
  let obj = null;
  const objUrl = m3FileUrl(prov, objFd);
  if (objUrl) { try { obj = await m3FetchBlob(objUrl, deadline); } catch (e) { obj = null; } }
  return { glb: glb, obj: obj };
}

/* TRELLIS.2: start session → preprocess → image_to_3d → extract_glb.
 * The 3D state stays server-side per session (extract_glb takes null for
 * it). image_to_3d runs the UI defaults at Resolution "1024". File
 * outputs may arrive wrapped as {value: FileData, __type__: "update"} —
 * unwrap before use, same trap as SF3D's GLB output. */
async function m3RunTrellis2(file, say) {
  const prov = M3_PROVIDERS.trellis2, session = m3Session();
  const deadline = Date.now() + M3_TIMEOUT_MS;
  say("TRELLIS.2 — starting a session on the free GPU…");
  await m3Call(prov, session, 2, [], deadline);
  say("TRELLIS.2 — uploading your image…");
  const fd = m3FileData(prov, await m3Upload(prov, file, deadline), file);
  say("TRELLIS.2 — removing the background…");
  const pre = await m3Call(prov, session, 4, [fd], deadline);
  const processed = pre && pre[0];
  if (!processed) throw new Error("TRELLIS.2 preprocessing returned no image");
  say("TRELLIS.2 — building your textured mesh (usually ~1 minute)…");
  await m3Call(prov, session, 7, [processed, 0, "1024", 7.5, 0.7, 12, 5.0, 7.5, 0.5, 12, 3.0, 1.0, 0.0, 12, 3.0], deadline);
  say("TRELLIS.2 — packing the GLB…");
  const made = await m3Call(prov, session, 9, [null, 300000, (typeof window !== "undefined" && window.M3_TEXSIZE) || 2048], deadline);
  const rawFd = made && made[0];
  const glbFd = rawFd && typeof rawFd === "object" && "value" in rawFd ? rawFd.value : rawFd;
  const url = m3FileUrl(prov, glbFd);
  if (!url) throw new Error("TRELLIS.2 finished but returned no mesh file");
  say("TRELLIS.2 — downloading your mesh…");
  return { glb: await m3FetchBlob(url, deadline), obj: null };
}

/* TRELLIS (community space, trellis-community/TRELLIS): start session →
 * preprocess → ONE call, generate_and_extract_glb. The endpoint map was
 * verified live against the space's /config on 2026-10-20 (RUNNING on
 * ZeroGPU, Gradio 5.34): fn 4 start_session (fires on app load), fn 8
 * preprocess_image (fires on image upload), fn 11 generate_and_extract_glb
 * — inputs are the UI defaults read off that config, in order:
 * [image, multi-image gallery, session state, seed, sparse-structure
 * guidance, sparse steps, SLAT guidance, SLAT steps, multi-image
 * algorithm, simplify, texture size]. The session state stays
 * server-side per session_hash, so it goes in as null. The GLB lands in
 * output[2] (the Model3D component); output[3] is the Download button —
 * both may arrive {value: FileData, __type__: "update"} wrapped, the
 * same trap as TRELLIS.2's output, so unwrap before use. */
async function m3RunTrellis(file, say) {
  const prov = M3_PROVIDERS.trellis, session = m3Session();
  const deadline = Date.now() + M3_TIMEOUT_MS;
  say("TRELLIS (community) — starting a session on the free GPU…");
  await m3Call(prov, session, 4, [], deadline);
  say("TRELLIS (community) — uploading your image…");
  const fd = m3FileData(prov, await m3Upload(prov, file, deadline), file);
  say("TRELLIS (community) — removing the background…");
  const pre = await m3Call(prov, session, 8, [fd], deadline);
  const processed = pre && pre[0];
  if (!processed) throw new Error("TRELLIS (community) preprocessing returned no image");
  say("TRELLIS (community) — building your mesh (usually ~1 minute)…");
  const made = await m3Call(prov, session, 11, [processed, [], null, 0, 7.5, 12, 3.0, 12, "stochastic", 0.95, 1024], deadline);
  const unwrap = (v) => v && typeof v === "object" && "value" in v ? v.value : v;
  const glbFd = unwrap(made && made[2]) || unwrap(made && made[3]);
  const url = m3FileUrl(prov, glbFd);
  if (!url) throw new Error("TRELLIS (community) finished but returned no mesh file");
  say("TRELLIS (community) — downloading your mesh…");
  return { glb: await m3FetchBlob(url, deadline), obj: null };
}

/* Hunyuan3D-2 Mini Turbo: ONE call, shape_generation (fn 4). Gradio 4
 * at the space root, like SF3D. The 13 inputs are the UI defaults for
 * the distilled Turbo mode: [text prompt (null — image mode), image,
 * four multiview slots (null — single image), steps 5, guidance 5.0,
 * seed 1234, octree 256, remove background true, chunks 8000,
 * randomize seed true]. SHAPE ONLY: the mesh comes out untextured —
 * the space's own texture stage fails on its side (PyMeshLabException,
 * lab round 3), so there is no second call to make. The GLB arrives in
 * output[0], a bare FileData in the proven run — but the sibling 2.1
 * space wrapped outputs as {value: FileData}, so unwrap defensively.
 * Lab ops note: the first upload once timed out while the space was
 * cold-starting; upload is a non-GPU path, so retry it ONCE on a
 * network/timeout error before calling the provider failed. */
async function m3RunHunyuanMini(file, say) {
  const prov = M3_PROVIDERS["hunyuan-mini"], session = m3Session();
  const deadline = Date.now() + M3_TIMEOUT_MS;
  say("Hunyuan3D-2 Mini Turbo — uploading your image…");
  let upPath;
  try {
    upPath = await m3Upload(prov, file, deadline);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    if (!(e instanceof TypeError) && !/timed out|network/i.test(msg)) throw e;
    say("Hunyuan3D-2 Mini Turbo — the upload hit a snag (the space may be waking up) — retrying it once…");
    upPath = await m3Upload(prov, file, deadline);
  }
  const fd = m3FileData(prov, upPath, file);
  say("Hunyuan3D-2 Mini Turbo — building your mesh (usually ~15 seconds)…");
  const made = await m3Call(prov, session, 4, [null, fd, null, null, null, null, 5, 5.0, 1234, 256, true, 8000, true], deadline);
  const rawFd = made && made[0];
  const glbFd = rawFd && typeof rawFd === "object" && "value" in rawFd ? rawFd.value : rawFd;
  const url = m3FileUrl(prov, glbFd);
  if (!url) throw new Error("Hunyuan3D-2 Mini Turbo finished but returned no mesh file");
  say("Hunyuan3D-2 Mini Turbo — downloading your mesh…");
  return { glb: await m3FetchBlob(url, deadline), obj: null };
}

function wire3DLab() {
  const fileInput = document.getElementById("m3File");
  wireModelPicker("m3ModelBtn", "m3Provider");
  if (!fileInput) return;
  const drop = document.getElementById("m3Drop");
  const thumb = document.getElementById("m3Thumb");
  const dropText = document.getElementById("m3DropText");
  const provSel = document.getElementById("m3Provider");
  const tokenInput = document.getElementById("m3Token");
  const useChar = document.getElementById("m3UseChar");
  const viewer = document.getElementById("m3Viewer");
  const go = document.getElementById("m3Go");
  const status = document.getElementById("m3Status");
  const result = document.getElementById("m3Result");
  const glbLink = document.getElementById("m3Glb");
  const objLink = document.getElementById("m3Obj");
  const glbSize = document.getElementById("m3GlbSize");
  const objSize = document.getElementById("m3ObjSize");
  const resultNote = document.getElementById("m3ResultNote");
  let file = null, running = false, objUrls = [];

  const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const shortErr = (e) => {
    const m = e && e.message ? String(e.message) : String(e);
    return m.length > 140 ? m.slice(0, 140) + "…" : m;
  };
  /* ZeroGPU quota refusals ("quota" / "GPU duration" in the message) mean
   * the shared free GPU budget is busy right now — a switch signal in
   * AUTO, not a dead end. */
  const isQuotaErr = (e) => /quota|gpu duration/i.test(e && e.message ? String(e.message) : String(e));
  function say(t, isErr) {
    status.textContent = t;
    status.classList.toggle("err", !!isErr);
  }
  window.M3_SET_SOURCE = function (f) { setFile(f); };
  function setFile(f) {
    if (!f) return;
    if (!/^image\//.test(f.type || "")) { say("That's not an image — pick a PNG or JPG.", true); return; }
    file = f;
    m3SrcName = f.name || "mesh";
    thumb.src = URL.createObjectURL(f);
    thumb.hidden = false;
    dropText.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = f.name;
    const span = document.createElement("span");
    span.className = "dim";
    span.textContent = fmtSize(f.size) + " — click or drop to change it";
    dropText.appendChild(strong);
    dropText.appendChild(document.createElement("br"));
    dropText.appendChild(span);
    go.disabled = running;
    result.hidden = true;
    hideGlbPreview();
    m3StudioReset();
    say("Ready — hit Generate. Free, as always.");
  }
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => setFile(fileInput.files && fileInput.files[0]));
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });

  /* optional HF token — same storage, same shape, same save-on-type
   * behavior as the 2D side's key field: localStorage "m4ster.aiKeys",
   * JSON property "huggingface". One token serves both sides of the hub. */
  if (tokenInput) {
    tokenInput.value = aiKeys().huggingface || "";
    tokenInput.addEventListener("input", () => {
      const keys = aiKeys();
      keys.huggingface = tokenInput.value.trim();
      try { localStorage.setItem(LS_AI_KEYS, JSON.stringify(keys)); } catch (e) {}
    });
  }

  /* bridge: the latest 2D result (state.rows[0].frames[0] — a canvas in
   * this build) becomes the 3D panel's image, through the exact same
   * setFile path as an upload, so thumbnail + Generate behave identically */
  if (useChar) useChar.addEventListener("click", async () => {
    const frame = state.rows && state.rows[0] && state.rows[0].frames && state.rows[0].frames[0];
    if (!frame) {
      say("No 2D character yet — generate a 2D character first (flip to 2D · Sprites, make one, then come back and use it here).", true);
      return;
    }
    try {
      let blob = null;
      if (typeof frame.toBlob === "function") {
        blob = await new Promise((res) => frame.toBlob(res, "image/png"));
      }
      if (!blob) {
        const c = makeCanvas(frame.width, frame.height);
        c.getContext("2d").drawImage(frame, 0, 0);
        blob = await new Promise((res) => c.toBlob(res, "image/png"));
      }
      if (!blob) throw new Error("the frame could not be read");
      setFile(new File([blob], "character.png", { type: "image/png" }));
      say("Your 2D character is loaded — hit GENERATE MESH.");
    } catch (e) {
      say("Couldn't load your 2D character (" + shortErr(e) + ") — upload the image instead.", true);
    }
  });

  /* ===== Meshy-style 3D Studio (TEST build) =====
   * The stage is a real three.js engine scene: Lit / Clay / Wireframe
   * render modes, real face/vertex stats parsed from the loaded GLB, a
   * degenerate-triangle printability check, environment controls and
   * camera presets. If the three.js CDN or WebGL fails, the preview
   * falls back to <model-viewer> — and a preview failure never fails
   * the generation itself; the download always stands. */
  const M3_MODEL_DESCS = {
    auto: "AUTO rides the whole roster: Stable Fast 3D first, then TRELLIS.2, InstantMesh, TRELLIS, Hunyuan Mini — switching itself if one fails.",
    sf3d: "Stable Fast 3D — Stability AI. Fast, textured GLB, usually ~10 seconds.",
    trellis2: "TRELLIS.2 — textured, highest detail of the roster, about a minute.",
    instantmesh: "InstantMesh — Tencent ARC. Dense multi-view mesh, GLB + OBJ out.",
    trellis: "TRELLIS (community) — the original Microsoft model, one single call.",
    "hunyuan-mini": "Hunyuan3D-2 Mini Turbo — fastest shape (~15s). Shape only: the mesh comes out untextured."
  };
  let m3three = null;        // { THREE, scene, camera, renderer, controls, model, clayMat, wireMat, homePos, homeTarget, raf }
  let m3Mode = "lit";
  let m3ChanMode = null;
  let m3SkipAssetReg = false;
  let m3SrcName = "";

  function m3FmtN(n) { return n.toLocaleString("en-US"); }

  async function m3InitThree() {
    if (m3three) return m3three;
    const THREE = await import("three");
    const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
    const wrap = document.getElementById("m3CanvasWrap");
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.domElement.className = "m3-three-canvas";
    wrap.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 500);
    camera.position.set(1.6, 1.1, 2.2);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2.5, 4, 2);
    scene.add(key);
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.6;
    const gizmoScene = new THREE.Scene();
    gizmoScene.add(new THREE.AxesHelper(1));
    const gizmoCam = new THREE.PerspectiveCamera(38, 1, 0.1, 20);
    m3three = { THREE, GLTFLoader, scene, camera, renderer, controls, key,
      clayMat: new THREE.MeshStandardMaterial({ color: 0xb9b9be, roughness: 0.85, metalness: 0.0 }),
      wireMat: new THREE.MeshBasicMaterial({ color: 0xa6f750, wireframe: true }),
      normalMat: new THREE.MeshNormalMaterial(),
      metalMat: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 1.0, roughness: 0.32 }),
      greyMat: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.15, roughness: 0.55 }),
      goldMat: new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 1.0, roughness: 0.3 }),
      cyanMat: new THREE.MeshStandardMaterial({ color: 0x35c4d8, metalness: 0.55, roughness: 0.35 }),
      gizmoScene, gizmoCam,
      zoomGoal: 0, model: null, homePos: null, homeTarget: null, raf: 0, anim: null, animHome: null, maxDim: 1, baseMesh: null };
    /* smooth wheel zoom: the wheel only moves a goal distance and the
     * tick eases toward it — flood-proof against smooth-scroll wheels
     * and trackpads, where OrbitControls' fixed 5%-per-event dolly
     * teleports. Only the canvas itself is hijacked; popups and pinch
     * behave natively. */
    wrap.addEventListener("wheel", (e) => {
      if (!m3three || !m3three.model || e.target !== renderer.domElement) return;
      e.preventDefault();
      e.stopPropagation();
      const c = m3three.controls;
      const cur = m3three.camera.position.distanceTo(c.target);
      if (!m3three.zoomGoal) m3three.zoomGoal = cur;
      const step = Math.max(-1, Math.min(1, e.deltaY / 100));
      m3three.zoomGoal = Math.max(c.minDistance, Math.min(c.maxDistance, m3three.zoomGoal * (1 + step * 0.14)));
    }, { capture: true, passive: false });
    const tick = () => {
      m3three.raf = requestAnimationFrame(tick);
      if (!wrap.offsetParent) return; // stage hidden — idle cheap
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (w && h && (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()) || camera.aspect !== w / h)) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      if (m3three.zoomGoal) {
        const off = m3three.camera.position.clone().sub(m3three.controls.target);
        const cur = off.length();
        const nd = cur + (m3three.zoomGoal - cur) * 0.18;
        if (Math.abs(m3three.zoomGoal - nd) < m3three.zoomGoal * 0.003) { off.setLength(m3three.zoomGoal); m3three.zoomGoal = 0; }
        else off.setLength(nd);
        m3three.camera.position.copy(m3three.controls.target).add(off);
      }
      controls.update();
      m3AnimTick();
      renderer.render(scene, camera);
      if (m3three.model && w > 280 && h > 220) {
        const gs = 84;
        const dir = camera.position.clone().sub(controls.target).normalize();
        gizmoCam.position.copy(dir.multiplyScalar(3.1));
        gizmoCam.up.copy(camera.up);
        gizmoCam.lookAt(0, 0, 0);
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.setScissorTest(true);
        renderer.setScissor(w - gs - 10, h - gs - 10, gs, gs);
        renderer.setViewport(w - gs - 10, h - gs - 10, gs, gs);
        renderer.render(gizmoScene, gizmoCam);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
        renderer.autoClear = true;
      }
    };
    tick();
    return m3three;
  }

  function m3ApplyMode() {
    if (!m3three) return;
    const s = m3three;
    if (m3ChanMode) {
      s.scene.overrideMaterial = null;
      m3ApplyChanMode();
    } else {
      m3RestoreMats();
      const map = { clay: s.clayMat, wire: s.wireMat, normal: s.normalMat, metal: s.metalMat, grey: s.greyMat, gold: s.goldMat, cyan: s.cyanMat };
      s.scene.overrideMaterial = map[m3Mode] || null;
    }
    ["Lit", "Clay", "Wire", "Normal"].forEach((m) => {
      const b = document.getElementById("m3Mode" + m);
      if (b) b.classList.toggle("active", !m3ChanMode && m3Mode === m.toLowerCase());
    });
    document.querySelectorAll("#m3RenderDock .m3-sphere").forEach((b) => {
      const rm = b.getAttribute("data-rmode");
      b.classList.toggle("active", m3ChanMode ? rm === m3ChanMode : rm === m3Mode);
    });
  }

  function m3FrameModel() {
    const s = m3three;
    if (!s || !s.model) return;
    const box = new s.THREE.Box3().setFromObject(s.model);
    const center = box.getCenter(new s.THREE.Vector3());
    const size = box.getSize(new s.THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    s.maxDim = maxDim;
    s.model.position.sub(center); // center at origin
    const dist = maxDim * 2.1;
    s.homePos = new s.THREE.Vector3(dist * 0.62, dist * 0.42, dist * 0.78);
    s.homeTarget = new s.THREE.Vector3(0, 0, 0);
    s.camera.position.copy(s.homePos);
    s.controls.target.copy(s.homeTarget);
    s.camera.near = maxDim / 100;
    s.camera.far = maxDim * 100;
    s.camera.updateProjectionMatrix();
    /* zoom stops — without them a fast wheel/pinch dollies the camera
     * INSIDE the mesh (faces cull, the model "vanishes") or out past the
     * far plane. Reproduced in the lab 2026-10-20: framed mesh 36.7%
     * opaque -> 0% at both zoom extremes. */
    s.controls.minDistance = maxDim * 0.45;
    s.controls.maxDistance = maxDim * 7;
    s.zoomGoal = 0;
    s.controls.update();
  }

  function m3MeshStats(root, THREE) {
    let verts = 0, faces = 0, degenerate = 0, openEdges = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry;
      const pos = g.attributes && g.attributes.position;
      if (!pos) return;
      verts += pos.count;
      const idx = g.index;
      const triCount = idx ? idx.count / 3 : pos.count / 3;
      faces += triCount;
      const read = (i, out) => {
        const vi = idx ? idx.getX(i) : i;
        out.fromBufferAttribute(pos, vi);
      };
      const cap = Math.min(triCount, 400000);
      for (let t = 0; t < cap; t++) {
        read(t * 3, a); read(t * 3 + 1, b); read(t * 3 + 2, c);
        ab.subVectors(b, a); ac.subVectors(c, a);
        if (ab.cross(ac).lengthSq() < 1e-14) degenerate++;
      }
      if (triCount > cap) degenerate = Math.round(degenerate * (triCount / cap));
      const edgeCount = new Map();
      const ek = (p, q) => (p < q ? p + "_" + q : q + "_" + p);
      const triN = Math.min(triCount, 400000);
      for (let t = 0; t < triN; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        [ek(i0, i1), ek(i1, i2), ek(i2, i0)].forEach((k) => edgeCount.set(k, (edgeCount.get(k) || 0) + 1));
      }
      let oe = 0;
      edgeCount.forEach((n) => { if (n === 1) oe++; });
      if (triCount > triN) oe = Math.round(oe * (triCount / triN));
      openEdges += oe;
    });
    return { verts, faces: Math.round(faces), degenerate, openEdges };
  }

  async function showGlbPreview(url) {
    const empty = document.getElementById("m3StageEmpty");
    if (empty) empty.hidden = true;
    try {
      const s = await m3InitThree();
      const loader = new s.GLTFLoader();
      const gltf = await loader.loadAsync(url);
      if (s.model) { s.scene.remove(s.model); }
      s.model = gltf.scene;
      s.scene.add(s.model);
      s.anim = null; s.animHome = null;
      if (s.baseMesh) { s.scene.remove(s.baseMesh); s.baseMesh = null; }
      m3ApplyMode();
      m3FrameModel();
      try {
        s.renderer.render(s.scene, s.camera);
        const snap = s.renderer.domElement.toDataURL("image/png");
        fetch(url).then((r) => r.blob()).then((b) => {
          if (!m3SkipAssetReg) {
            window.M3_ASSET_LIST = window.M3_ASSET_LIST || [];
            window.M3_ASSET_LIST.push({ name: (m3SrcName || "mesh").replace(/\.[a-z0-9]+$/i, "") + " — mesh", url: URL.createObjectURL(b), objUrl: null, thumb: snap });
            if (window.renderAssets) renderAssets();
          }
          m3SkipAssetReg = false;
        }).catch(() => {});
      } catch (e) { /* snapshot is a bonus; the mesh itself already succeeded */ }
      const st = m3MeshStats(s.model, s.THREE);
      window.M3_LAST_STATS = st;
      const statsEl = document.getElementById("m3Stats");
      document.getElementById("m3StatFaces").textContent = m3FmtN(st.faces);
      document.getElementById("m3StatVerts").textContent = m3FmtN(st.verts);
      if (statsEl) statsEl.hidden = false;
      const printEl = document.getElementById("m3Print");
      const pv = document.getElementById("m3PrintVal");
      if (st.degenerate > 0) { pv.innerHTML = '<span class="m3-print-badge">' + m3FmtN(st.degenerate) + '</span> degenerate tris'; }
      else { pv.textContent = "✓ clean mesh"; }
      if (printEl) printEl.hidden = false;
      const po = document.getElementById("m3PrintOpen");
      if (po) po.textContent = st.openEdges > 0 ? m3FmtN(st.openEdges) + " — shell not watertight" : "0 — watertight \u2713";
      const pdg = document.getElementById("m3PrintDegen");
      if (pdg) pdg.textContent = m3FmtN(st.degenerate);
      m3WireBridge(url);
      const expNameEl = document.getElementById("m3ExpName");
      if (expNameEl) expNameEl.value = (m3SrcName || "framelab-mesh").replace(/\.[a-z0-9]+$/i, "");
      if (viewer) viewer.hidden = true;
    } catch (e) {
      /* fallback: model-viewer */
      try {
        await import("https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js");
        if (viewer) { viewer.src = url; viewer.hidden = false; }
      } catch (e2) { if (viewer) viewer.hidden = true; }
    }
  }
  function hideGlbPreview() {
    if (m3three && m3three.model) { m3three.scene.remove(m3three.model); m3three.model = null; }
    const statsEl = document.getElementById("m3Stats");
    if (statsEl) statsEl.hidden = true;
    const printEl = document.getElementById("m3Print");
    if (printEl) printEl.hidden = true;
    if (viewer) { viewer.hidden = true; viewer.removeAttribute("src"); }
  }
  function m3StudioReset() {
    const empty = document.getElementById("m3StageEmpty");
    if (empty) empty.hidden = false;
  }

  /* --- rail wiring --- */
  if (provSel) provSel.addEventListener("change", () => {
    const d = document.getElementById("m3ModelDesc");
    if (d) d.textContent = M3_MODEL_DESCS[provSel.value] || "";
    const cl = document.getElementById("m3CostLine");
    if (cl) cl.textContent = provSel.value === "trellis2" ? "~1 min · Free" : provSel.value === "hunyuan-mini" ? "~15 sec · Free" : provSel.value === "sf3d" ? "~10 sec · Free" : "Free · no signup · no keys";
  });

  function m3FlipTo2D(message) {
    const btn = document.querySelector('.flip-btn[data-dim="2d"]') || document.getElementById("flip2d");
    if (btn) btn.click();
    if (message) say(message);
  }
  /* mode tabs switch the rail's mode in place — they never teleport or
   * scroll the user. The chain panel sits directly under the tabs and
   * only exists in Text mode; the image-only inputs hide while it's up.
   * The one-click chain does the 2D hop by itself when it runs. */
  const tabImage = document.getElementById("m3TabImage");
  const tabText = document.getElementById("m3TabText");
  function m3SetMode(text) {
    if (tabImage) { tabImage.classList.toggle("active", !text); tabImage.setAttribute("aria-selected", String(!text)); }
    if (tabText) { tabText.classList.toggle("active", text); tabText.setAttribute("aria-selected", String(text)); }
    const rail = document.querySelector(".m3-rail");
    if (rail) rail.classList.toggle("text-mode", text);
    if (text) {
      const inp = document.getElementById("m3ChainInput");
      if (inp) setTimeout(() => inp.focus({ preventScroll: true }), 60);
      const cs = document.getElementById("m3ChainStatus");
      if (cs && !cs.textContent) cs.textContent = "One click: the hub draws it, then builds the mesh itself.";
    }
  }
  if (tabText) tabText.addEventListener("click", () => m3SetMode(true));
  if (tabImage) tabImage.addEventListener("click", () => m3SetMode(false));
  const hintGen = document.getElementById("m3HintGen");
  if (hintGen) hintGen.addEventListener("click", () => m3FlipTo2D("Make the image on the 2D side first — then flip back and mesh it."));

  const topoNote = document.getElementById("m3TopoNote");
  const topoD = document.getElementById("m3TopoDetail");
  const topoS = document.getElementById("m3TopoSmart");
  function m3SetTopo(smart) {
    window.M3_SMART_TOPO = smart;
    if (topoD) topoD.classList.toggle("active", !smart);
    if (topoS) topoS.classList.toggle("active", smart);
    if (topoNote) topoNote.textContent = smart
      ? "Smart Topology — cleaner, lighter mesh for games & mobile. AUTO leads with InstantMesh."
      : "High Detail — full-density mesh from the model.";
  }
  if (topoD) topoD.addEventListener("click", () => m3SetTopo(false));
  if (topoS) topoS.addEventListener("click", () => m3SetTopo(true));

  const mvBtn = document.getElementById("m3MultiView");
  if (mvBtn) mvBtn.addEventListener("click", () => {
    const on = mvBtn.getAttribute("aria-checked") !== "true";
    mvBtn.setAttribute("aria-checked", String(on));
    mvBtn.classList.toggle("on", on);
    window.M3_MULTIVIEW = on;
    say(on ? "Multi-view ON — AUTO will lead with InstantMesh's multi-view pipeline." : "Multi-view OFF.");
  });

  document.querySelectorAll(".m3-res .m3-seg-btn").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".m3-res .m3-seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    window.M3_TEXSIZE = parseInt(b.getAttribute("data-tex"), 10) || 2048;
  }));
  window.M3_TEXSIZE = 1024;

  /* sample slots: the visitor's own recent 2D generations */
  function m3FillSamples() {
    const box = document.getElementById("m3Samples");
    const row = document.getElementById("m3SamplesRow");
    if (!box || !row || typeof state === "undefined" || !state.rows) return;
    row.innerHTML = "";
    let n = 0;
    state.rows.forEach((r) => {
      if (n >= 3 || !r.frames || !r.frames[0]) return;
      const cv = r.frames[0];
      const img = document.createElement("img");
      try { img.src = cv.toDataURL("image/png"); } catch (e) { return; }
      img.alt = "Your 2D generation";
      img.className = "m3-sample";
      img.title = "Use this image for 3D";
      img.addEventListener("click", () => {
        cv.toBlob((blob) => {
          if (blob) setFile(new File([blob], "my-2d-generation.png", { type: "image/png" }));
        }, "image/png");
      });
      row.appendChild(img);
      n++;
    });
    box.hidden = n === 0;
  }
  const lab3dEl = document.getElementById("lab3d");
  if (lab3dEl && "MutationObserver" in window) {
    new MutationObserver(() => { if (!lab3dEl.hidden) m3FillSamples(); }).observe(lab3dEl, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* --- stage wiring --- */
  const preset = document.getElementById("m3ViewPreset");
  if (preset) preset.addEventListener("change", () => {
    if (!m3three || !m3three.model) return;
    const s = m3three, v = preset.value;
    if (v === "turntable") { s.controls.autoRotate = true; m3FrameModel(); }
    else if (v === "top") {
      const d = s.homePos ? s.homePos.length() : 3;
      s.camera.position.set(0, d, 0.001); s.controls.target.set(0, 0, 0); s.controls.update();
    } else if (v === "front") {
      const d = s.homePos ? s.homePos.length() : 3;
      s.camera.position.set(0, d * 0.18, d); s.controls.target.set(0, 0, 0); s.controls.update();
    } else { s.controls.autoRotate = true; m3FrameModel(); }
    const rot = document.getElementById("m3EnvRotate");
    if (rot) { rot.classList.toggle("on", s.controls.autoRotate); rot.setAttribute("aria-checked", String(s.controls.autoRotate)); }
  });
  /* ===== P6: print-lab hooks — split, base, edit, scene export ===== */
  async function m3ExportObject(rootObj, filename) {
    const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
    const exporter = new GLTFExporter();
    const buf = await exporter.parseAsync(rootObj, { binary: true });
    const blob = new Blob([buf], { type: "model/gltf-binary" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 6000);
  }
  function m3FilteredGroup(keepFn) {
    const s = m3three, THREE = s.THREE;
    const grp = new THREE.Group();
    const box = new THREE.Box3().setFromObject(s.model);
    const midY = (box.min.y + box.max.y) / 2;
    let meshIdx = -1;
    const wp = new THREE.Vector3();
    s.model.updateMatrixWorld(true);
    s.model.traverse((o) => {
      if (!o.isMesh) return;
      meshIdx++;
      const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
      const pos = src.attributes.position;
      const nor = src.attributes.normal;
      const uv = src.attributes.uv;
      const triCount = pos.count / 3;
      const P = [], N = [], U = [];
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cen = new THREE.Vector3();
      const q = new THREE.Quaternion();
      o.getWorldQuaternion(q);
      for (let t = 0; t < triCount; t++) {
        a.fromBufferAttribute(pos, t * 3).applyMatrix4(o.matrixWorld);
        b.fromBufferAttribute(pos, t * 3 + 1).applyMatrix4(o.matrixWorld);
        c.fromBufferAttribute(pos, t * 3 + 2).applyMatrix4(o.matrixWorld);
        cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        if (!keepFn(cen, midY, meshIdx)) continue;
        [a, b, c].forEach((v) => P.push(v.x, v.y, v.z));
        if (nor) {
          for (let k = 0; k < 3; k++) {
            wp.fromBufferAttribute(nor, t * 3 + k).applyQuaternion(q);
            N.push(wp.x, wp.y, wp.z);
          }
        }
        if (uv) {
          for (let k = 0; k < 3; k++) U.push(uv.getX(t * 3 + k), uv.getY(t * 3 + k));
        }
      }
      if (!P.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
      if (N.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
      else g.computeVertexNormals();
      if (U.length) g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
      const mat = o.userData._om || o.material;
      const mesh = new THREE.Mesh(g, Array.isArray(mat) ? mat[0] : mat);
      grp.add(mesh);
    });
    return grp;
  }
  /* ===== format exports: OBJ + FBX from the loaded mesh =====
   * The popup's OBJ option used to depend on the provider handing back
   * an OBJ file (only InstantMesh does) and silently served the GLB
   * otherwise; FBX did not exist at all. Both now export the mesh that
   * is actually loaded in the viewer, baked to world space through
   * m3FilteredGroup — every provider's mesh, every format. FBX is an
   * ASCII 7.4 writer (geometry + material color; GLB keeps textures). */
  function m3DownloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 6000);
  }
  async function m3ExportOBJ(filename) {
    if (!m3three || !m3three.model) return false;
    const { OBJExporter } = await import("three/addons/exporters/OBJExporter.js");
    const text = new OBJExporter().parse(m3FilteredGroup(() => true));
    m3DownloadBlob(new Blob([text], { type: "text/plain" }), filename);
    return true;
  }
  function m3FBXText(grp) {
    const f6 = (n) => { const v = Math.abs(n) < 1e-9 ? 0 : n; return v.toFixed(6); };
    const meshes = [];
    grp.traverse((o) => { if (o.isMesh) meshes.push(o); });
    let id = 200000000;
    const nextId = () => (id += 137);
    const geoBlocks = [], matBlocks = [], modelBlocks = [], conns = [];
    meshes.forEach((m, mi) => {
      const g = m.geometry;
      const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
      const vcount = pos.count;
      const verts = [], pvi = [], nors = [], uvs = [];
      for (let i = 0; i < vcount; i++) verts.push(f6(pos.getX(i)), f6(pos.getY(i)), f6(pos.getZ(i)));
      for (let t = 0; t < vcount; t += 3) pvi.push(t, t + 1, -(t + 2) - 1);
      if (nor) for (let i = 0; i < vcount; i++) nors.push(f6(nor.getX(i)), f6(nor.getY(i)), f6(nor.getZ(i)));
      if (uv) for (let i = 0; i < vcount; i++) uvs.push(f6(uv.getX(i)), f6(uv.getY(i)));
      const gid = nextId(), matId = nextId(), modId = nextId();
      const name = "mesh" + mi;
      let gb = "  Geometry: " + gid + ', "Geometry::' + name + '", "Mesh" {\n' +
        "    Vertices: *" + verts.length + " {\n      a: " + verts.join(",") + "\n    }\n" +
        "    PolygonVertexIndex: *" + pvi.length + " {\n      a: " + pvi.join(",") + "\n    }\n";
      if (nors.length) gb += "    LayerElementNormal: 0 {\n      Version: 101\n      Name: \"\"\n" +
        '      MappingInformationType: "ByPolygonVertex"\n      ReferenceInformationType: "Direct"\n' +
        "      Normals: *" + nors.length + " {\n        a: " + nors.join(",") + "\n      }\n    }\n";
      if (uvs.length) gb += "    LayerElementUV: 0 {\n      Version: 101\n      Name: \"map1\"\n" +
        '      MappingInformationType: "ByPolygonVertex"\n      ReferenceInformationType: "Direct"\n' +
        "      UV: *" + uvs.length + " {\n        a: " + uvs.join(",") + "\n      }\n    }\n";
      gb += "    LayerElementMaterial: 0 {\n      Version: 101\n      Name: \"\"\n" +
        '      MappingInformationType: "AllSame"\n      ReferenceInformationType: "IndexToDirect"\n' +
        "      Materials: *1 {\n        a: 0\n      }\n    }\n    Layer: 0 {\n      Version: 100\n";
      if (nors.length) gb += '      LayerElement: {\n        Type: "LayerElementNormal"\n        TypedIndex: 0\n      }\n';
      gb += '      LayerElement: {\n        Type: "LayerElementMaterial"\n        TypedIndex: 0\n      }\n';
      if (uvs.length) gb += '      LayerElement: {\n        Type: "LayerElementUV"\n        TypedIndex: 0\n      }\n';
      gb += "    }\n  }";
      geoBlocks.push(gb);
      const col = (m.material && m.material.color) ? m.material.color : { r: 0.8, g: 0.8, b: 0.8 };
      matBlocks.push("  Material: " + matId + ', "Material::' + name + '", "" {\n    Version: 102\n    ShadingModel: "phong"\n    MultiLayer: 0\n    Properties70: {\n' +
        '      P: "DiffuseColor", "ColorRGB", "Color", "",' + f6(col.r) + "," + f6(col.g) + "," + f6(col.b) + "\n" +
        '      P: "SpecularColor", "ColorRGB", "Color", "",0.200000,0.200000,0.200000\n' +
        '      P: "ShininessExponent", "double", "Number", "",20.000000\n    }\n  }');
      modelBlocks.push("  Model: " + modId + ', "Model::' + name + '", "Mesh" {\n    Version: 232\n    Properties70: {\n' +
        '      P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0\n' +
        '      P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0\n' +
        '      P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1\n    }\n    Shading: T\n    Culling: "CullingOff"\n  }');
      conns.push('  C: "OO",' + gid + "," + modId + '\n  C: "OO",' + matId + "," + modId + '\n  C: "OO",' + modId + ",0");
    });
    const total = geoBlocks.length + matBlocks.length + modelBlocks.length;
    return "; FBX 7.4.0 project file\n; Exported by m4ster FrameLab — geometry + color; use GLB for textures\n; ----------------------------------------------------\n" +
      "FBXHeaderExtension: {\n  FBXHeaderVersion: 1003\n  FBXVersion: 7400\n  Creator: \"m4ster FrameLab\"\n}\n" +
      "GlobalSettings: {\n  Version: 1000\n  Properties70: {\n" +
      '    P: "UpAxis", "int", "Integer", "",2\n    P: "UpAxisSign", "int", "Integer", "",1\n' +
      '    P: "FrontAxis", "int", "Integer", "",1\n    P: "FrontAxisSign", "int", "Integer", "",-1\n' +
      '    P: "CoordAxis", "int", "Integer", "",0\n    P: "CoordAxisSign", "int", "Integer", "",1\n' +
      '    P: "UnitScaleFactor", "double", "Number", "",1\n  }\n}\n' +
      "Definitions: {\n  Version: 100\n  Count: " + (total + 1) + "\n" +
      '  ObjectType: "GlobalSettings" {\n    Count: 1\n  }\n' +
      '  ObjectType: "Geometry" {\n    Count: ' + geoBlocks.length + "\n  }\n" +
      '  ObjectType: "Material" {\n    Count: ' + matBlocks.length + "\n  }\n" +
      '  ObjectType: "Model" {\n    Count: ' + modelBlocks.length + "\n  }\n}\n" +
      "Objects: {\n" + geoBlocks.join("\n") + "\n" + matBlocks.join("\n") + "\n" + modelBlocks.join("\n") + "\n}\n" +
      "Connections: {\n" + conns.join("\n") + "\n}\n";
  }
  async function m3ExportFBX(filename) {
    if (!m3three || !m3three.model) return false;
    const text = m3FBXText(m3FilteredGroup(() => true));
    m3DownloadBlob(new Blob([text], { type: "text/plain" }), filename);
    return true;
  }
  window.M3_EXPORT_FMT = async function (fmt, filename) {
    if (fmt === "obj") return m3ExportOBJ(filename);
    if (fmt === "fbx") return m3ExportFBX(filename);
    return false;
  };
  window.M3_MESH_COUNT = function () {
    if (!m3three || !m3three.model) return 0;
    let n = 0;
    m3three.model.traverse((o) => { if (o.isMesh) n++; });
    return n;
  };
  window.M3_SPLIT = async function (mode) {
    if (!m3three || !m3three.model) return false;
    const base = (m3SrcName || "framelab-mesh").replace(/\.[a-z0-9]+$/i, "");
    if (mode === "top" || mode === "bottom") {
      const grp = m3FilteredGroup((cen, midY) => (mode === "top" ? cen.y >= midY : cen.y < midY));
      if (!grp.children.length) return false;
      await m3ExportObject(grp, base + "-" + mode + ".glb");
      return true;
    }
    if (mode === "parts") {
      const total = window.M3_MESH_COUNT();
      if (total < 2) return false;
      for (let i = 0; i < Math.min(total, 8); i++) {
        const idx = i;
        const grp = m3FilteredGroup((cen, midY, mi) => mi === idx);
        if (grp.children.length) await m3ExportObject(grp, base + "-part" + (idx + 1) + ".glb");
      }
      return true;
    }
    return false;
  };
  window.M3_ADD_BASE = function (shape) {
    if (!m3three || !m3three.model) return false;
    const s = m3three, THREE = s.THREE;
    if (s.baseMesh) { s.scene.remove(s.baseMesh); s.baseMesh = null; }
    const box = new THREE.Box3().setFromObject(s.model);
    const size = box.getSize(new THREE.Vector3());
    const h = Math.max(size.y * 0.05, (s.maxDim || 1) * 0.03);
    const r = Math.max(size.x, size.z) * 0.58;
    let geo;
    if (shape === "square") geo = new THREE.BoxGeometry(r * 1.7, h, r * 1.7);
    else if (shape === "hex") geo = new THREE.CylinderGeometry(r, r * 1.04, h, 6);
    else geo = new THREE.CylinderGeometry(r, r * 1.04, h, 48);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.6, metalness: 0.2 });
    s.baseMesh = new THREE.Mesh(geo, mat);
    s.baseMesh.position.set((box.min.x + box.max.x) / 2, box.min.y - h * 0.32, (box.min.z + box.max.z) / 2);
    s.scene.add(s.baseMesh);
    return true;
  };
  window.M3_REMOVE_BASE = function () {
    if (!m3three || !m3three.baseMesh) return;
    m3three.scene.remove(m3three.baseMesh);
    m3three.baseMesh = null;
  };
  window.M3_EXPORT_WITH_BASE = async function () {
    if (!m3three || !m3three.model || !m3three.baseMesh) return false;
    const s = m3three, THREE = s.THREE;
    const grp = new THREE.Group();
    grp.add(s.model.clone(true));
    grp.add(s.baseMesh.clone());
    const base = (m3SrcName || "framelab-mesh").replace(/\.[a-z0-9]+$/i, "");
    await m3ExportObject(grp, base + "-with-base.glb");
    return true;
  };
  window.M3_EDIT = function (action) {
    if (!m3three || !m3three.model) return false;
    const s = m3three;
    window.M3_STOP_MOTION();
    if (action === "mirror") s.model.scale.x *= -1;
    else if (action === "rotate") s.model.rotation.y += Math.PI / 2;
    else if (action === "reset") {
      s.model.rotation.set(0, 0, 0);
      s.model.scale.set(Math.abs(s.model.scale.x) > 0 ? 1 : 1, 1, 1);
      s.model.scale.x = 1;
    }
    s.animHome = { pos: s.model.position.clone(), rot: s.model.rotation.clone(), scl: s.model.scale.clone() };
    return true;
  };

  /* ===== P5: procedural motion engine (Animate panel) ===== */
  const M3_MOTIONS = {
    sway:    { loop: true,  fn: (t) => ({ rz: Math.sin(t * 1.6) * 0.05, dy: Math.sin(t * 3.2) * 0.012 }) },
    dance:   { loop: true,  fn: (t) => ({ dy: Math.abs(Math.sin(t * 6)) * 0.12, rz: Math.sin(t * 6) * 0.14, ry: Math.sin(t * 3) * 0.5 }) },
    nod:     { loop: true,  fn: (t) => ({ rx: Math.sin(t * 5) * 0.18 }) },
    shake:   { loop: true,  fn: (t) => ({ ry: Math.sin(t * 6) * 0.3 }) },
    alert:   { loop: true,  fn: (t) => ({ rz: Math.sin(t * 26) * 0.03, dy: Math.abs(Math.sin(t * 13)) * 0.03 }) },
    wave:    { loop: true,  fn: (t) => ({ rz: Math.sin(t * 7) * 0.16, dy: Math.sin(t * 3.5) * 0.02 }) },
    victory: { loop: true,  fn: (t) => ({ dy: Math.abs(Math.sin(t * 7)) * 0.16, ry: Math.sin(t * 3.5) * 0.3 }) },
    arise:   { loop: false, dur: 1.6, fn: (t, p) => { const e = 1 - Math.pow(1 - p, 3); return { dy: -0.3 * (1 - e), sc: 0.6 + 0.4 * e }; } },
    attack:  { loop: false, dur: 0.7, fn: (t, p) => { const s2 = Math.sin(p * Math.PI); return { dz: s2 * 0.35, rx: -s2 * 0.2 }; } },
    behit:   { loop: false, dur: 0.9, fn: (t, p) => { const s2 = Math.sin(p * Math.PI); return { dy: s2 * 0.5, rx: s2 * 0.5 }; } },
    spin:    { loop: false, dur: 1.0, fn: (t, p) => ({ ry: p * Math.PI * 2 }) },
    bow:     { loop: false, dur: 1.4, fn: (t, p) => ({ rx: Math.sin(p * Math.PI) * 0.55 }) },
    jump:    { loop: false, dur: 0.8, fn: (t, p) => ({ dy: Math.sin(p * Math.PI) * 0.4 }) }
  };
  function m3AnimRestore() {
    const s = m3three;
    if (!s || !s.model || !s.animHome) return;
    s.model.position.copy(s.animHome.pos);
    s.model.rotation.copy(s.animHome.rot);
    s.model.scale.copy(s.animHome.scl);
  }
  function m3AnimTick() {
    const s = m3three;
    if (!s || !s.model || !s.anim) return;
    const m = M3_MOTIONS[s.anim.name];
    if (!m) { s.anim = null; return; }
    const t = (Date.now() - s.anim.t0) / 1000;
    const p = m.loop ? 0 : t / m.dur;
    if (!m.loop && p >= 1) {
      m3AnimRestore();
      s.anim = null;
      if (window.M3_ON_MOTION_END) window.M3_ON_MOTION_END();
      return;
    }
    const o = m.fn(t, Math.min(p, 1)) || {};
    const h = s.animHome, u = s.maxDim || 1;
    s.model.position.set(h.pos.x, h.pos.y + (o.dy || 0) * u, h.pos.z + (o.dz || 0) * u);
    s.model.rotation.set(h.rot.x + (o.rx || 0), h.rot.y + (o.ry || 0), h.rot.z + (o.rz || 0));
    const sc = o.sc || 1;
    s.model.scale.set(h.scl.x * sc, h.scl.y * sc, h.scl.z * sc);
  }
  window.M3_HAS_MODEL = function () { return !!(m3three && m3three.model); };
  window.M3_PLAY_MOTION = function (name) {
    if (!m3three || !m3three.model || !M3_MOTIONS[name]) return false;
    const s = m3three;
    if (!s.animHome) s.animHome = { pos: s.model.position.clone(), rot: s.model.rotation.clone(), scl: s.model.scale.clone() };
    s.anim = { name: name, t0: Date.now() };
    return true;
  };
  window.M3_STOP_MOTION = function () {
    if (!m3three) return;
    m3AnimRestore();
    m3three.anim = null;
  };

  /* ===== P4b: Tripo viewer batch — render dock, export popup, engine
     bridge, snapshot, texture toggle, uploaded-model viewing ===== */
  function m3SetRenderMode(mode) {
    if (mode === "metalmap" || mode === "roughmap") { m3ChanMode = mode; }
    else { m3ChanMode = null; m3Mode = mode; }
    m3ApplyMode();
  }
  function m3RestoreMats() {
    if (!m3three || !m3three.model) return;
    m3three.model.traverse((o) => {
      if (o.isMesh && o.userData._om) o.material = o.userData._om;
    });
  }
  function m3ApplyChanMode() {
    const s = m3three;
    if (!s || !s.model) return;
    let found = false;
    s.model.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData._om) o.userData._om = o.material;
      const src = o.userData._om;
      const tex = src && !Array.isArray(src) ? (m3ChanMode === "metalmap" ? src.metalnessMap : src.roughnessMap) : null;
      if (tex) found = true;
      o.material = new s.THREE.MeshBasicMaterial({ map: tex || null, color: tex ? 0xffffff : 0x23232a });
    });
    if (!found) {
      const note = document.getElementById("m3ResultNote");
      if (note) note.textContent = "This GLB carries no " + (m3ChanMode === "metalmap" ? "metallic" : "roughness") + " map, so that channel view is empty — the Normal view works on any mesh.";
    }
  }
  function m3ToggleTextures() {
    if (!m3three || !m3three.model) return;
    m3TexOff = !m3TexOff;
    m3three.model.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData._om) o.userData._om = o.material;
      const mats = Array.isArray(o.userData._om) ? o.userData._om : [o.userData._om];
      mats.forEach((mm) => {
        if (!mm || !("map" in mm)) return;
        if (m3TexOff) { if (mm.userData._map === undefined) mm.userData._map = mm.map; mm.map = null; }
        else if (mm.userData._map !== undefined) { mm.map = mm.userData._map; }
        mm.needsUpdate = true;
      });
    });
    const b = document.getElementById("m3RdTex");
    if (b) b.classList.toggle("active", m3TexOff);
  }
  let m3TexOff = false;
  const M3_ENGINES = [
    ["Unity", "Drag the .glb into your Assets folder — Unity 2022.2+ imports glTF directly."],
    ["Unreal Engine", "Import into the Content Browser with the glTF importer — PBR materials come across."],
    ["Godot 4", "Drop the .glb into the project folder — it imports as a ready scene."],
    ["Blender", "File > Import > glTF 2.0 — geometry, materials and textures intact."],
    ["3ds Max", "File > Import and pick the .glb (2023+ reads glTF natively)."],
    ["Maya", "Use the glTF plugin, or hop through Blender for a clean FBX."]
  ];
  function m3WireBridge(url) {
    const list = document.getElementById("m3BridgeList");
    if (!list) return;
    const base = (m3SrcName || "framelab-mesh").replace(/\.[a-z0-9]+$/i, "");
    list.innerHTML = "";
    M3_ENGINES.forEach(([name, tip]) => {
      const row = document.createElement("div");
      row.className = "m3-bridge-row";
      const nm = document.createElement("strong"); nm.textContent = name;
      const tp = document.createElement("span"); tp.textContent = tip;
      const a = document.createElement("a");
      a.className = "m3-bridge-dl";
      a.href = url;
      a.setAttribute("download", base + "-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "") + ".glb");
      a.textContent = "\u2b07 GLB";
      row.appendChild(nm); row.appendChild(tp); row.appendChild(a);
      list.appendChild(row);
    });
  }
  window.M3_LOAD_GLB = function (url, name) {
    const flip = document.getElementById("flip3d");
    if (flip) flip.click();
    m3SrcName = name || "uploaded-model.glb";
    m3SkipAssetReg = true;
    const res = document.getElementById("m3Result");
    if (res) res.hidden = false;
    if (glbLink) { glbLink.href = url; glbLink.setAttribute("download", m3SrcName); }
    if (objLink) objLink.hidden = true;
    showGlbPreview(url);
    const note = document.getElementById("m3ResultNote");
    if (note) note.textContent = "Viewing your uploaded model — orbit it, read its real stats, swap materials, export it back any time.";
    const stage = document.getElementById("m3Stage");
    if (stage) stage.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const rdEnv = document.getElementById("m3RdEnv");
  if (rdEnv) rdEnv.addEventListener("click", () => { const b = document.getElementById("m3EnvBtn"); if (b) b.click(); });
  const rdSnap = document.getElementById("m3RdSnap");
  if (rdSnap) rdSnap.addEventListener("click", () => {
    if (!m3three) return;
    m3three.renderer.render(m3three.scene, m3three.camera);
    m3three.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "framelab-view.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/png");
  });
  const rdTex = document.getElementById("m3RdTex");
  if (rdTex) rdTex.addEventListener("click", m3ToggleTextures);
  const rdHelp = document.getElementById("m3RdHelp");
  const helpPop = document.getElementById("m3HelpPop");
  if (rdHelp && helpPop) rdHelp.addEventListener("click", () => { helpPop.hidden = !helpPop.hidden; });
  document.querySelectorAll("#m3RenderDock .m3-sphere").forEach((b) => {
    b.addEventListener("click", () => m3SetRenderMode(b.getAttribute("data-rmode")));
  });
  const expPop = document.getElementById("m3ExpPop");
  const expBtn = document.getElementById("m3ExportBtn");
  if (expBtn && expPop) expBtn.addEventListener("click", () => {
    const tex = document.getElementById("m3ExpTex");
    if (tex) tex.textContent = window.M3_TEXSIZE === 4096 ? "Ultra 4K" : window.M3_TEXSIZE === 2048 ? "Ultra 2K" : "Standard 1024";
    const fmt = document.getElementById("m3ExpFmt");
    if (fmt) {
      const objOpt = fmt.querySelector('option[value="obj"]');
      if (objOpt) { objOpt.disabled = !objLink || objLink.hidden; if (objOpt.disabled && fmt.value === "obj") fmt.value = "glb"; }
    }
    expPop.hidden = !expPop.hidden;
    const bp = document.getElementById("m3BridgePop");
    if (bp && !expPop.hidden) bp.hidden = true;
  });
  const expGo = document.getElementById("m3ExpGo");
  if (expGo) expGo.addEventListener("click", () => {
    const nameEl = document.getElementById("m3ExpName");
    const fmtEl = document.getElementById("m3ExpFmt");
    const base = (((nameEl && nameEl.value.trim()) || "framelab-mesh").replace(/[^\w\- ]+/g, "").trim()) || "framelab-mesh";
    if (fmtEl && (fmtEl.value === "obj" || fmtEl.value === "fbx") && window.M3_EXPORT_FMT) {
      const fv = fmtEl.value;
      window.M3_EXPORT_FMT(fv, base + "." + fv).then((ok) => {
        if (!ok && glbLink) { glbLink.setAttribute("download", base + ".glb"); glbLink.click(); }
      });
      if (expPop) expPop.hidden = true;
      return;
    }
    const useObj = !!(fmtEl && fmtEl.value === "obj" && objLink && !objLink.hidden);
    const link = useObj ? objLink : glbLink;
    if (link) { link.setAttribute("download", base + (useObj ? ".obj" : ".glb")); link.click(); }
    if (expPop) expPop.hidden = true;
  });
  const bridgeBtn = document.getElementById("m3BridgeBtn");
  const bridgePop = document.getElementById("m3BridgePop");
  if (bridgeBtn && bridgePop) bridgeBtn.addEventListener("click", () => {
    bridgePop.hidden = !bridgePop.hidden;
    if (!bridgePop.hidden && expPop) expPop.hidden = true;
  });
  const genLink = document.getElementById("m3DropGenLink");
  if (genLink) genLink.addEventListener("click", (e) => {
    e.stopPropagation();
    const f = document.getElementById("flip2d");
    if (f) f.click();
  });

  [["m3ModeLit", "lit"], ["m3ModeClay", "clay"], ["m3ModeWire", "wire"], ["m3ModeNormal", "normal"]].forEach(([id, mode]) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", () => { m3ChanMode = null; m3Mode = mode; m3ApplyMode(); });
  });
  const envBtn = document.getElementById("m3EnvBtn");
  const envPop = document.getElementById("m3EnvPop");
  if (envBtn && envPop) envBtn.addEventListener("click", () => { envPop.hidden = !envPop.hidden; });
  const envStrength = document.getElementById("m3EnvStrength");
  if (envStrength) envStrength.addEventListener("input", () => {
    if (!m3three) return;
    const v = parseInt(envStrength.value, 10) / 100;
    m3three.renderer.toneMappingExposure = v;
    m3three.scene.traverse((o) => {
      if (o.isMesh && o.material && "envMapIntensity" in o.material) o.material.envMapIntensity = v;
    });
    if (m3three.clayMat) m3three.clayMat.envMapIntensity = v;
  });
  const envHdri = document.getElementById("m3EnvHdri");
  if (envHdri) envHdri.addEventListener("change", () => {
    if (!m3three) return;
    const s = m3three, wrap = document.getElementById("m3CanvasWrap");
    if (envHdri.value === "studio") { s.key.intensity = 2.4; s.key.color.set(0xffffff); if (wrap) wrap.style.background = "radial-gradient(120% 100% at 50% 30%, #26282f, #141519)"; }
    else if (envHdri.value === "dusk") { s.key.intensity = 1.5; s.key.color.set(0xffc38a); if (wrap) wrap.style.background = "radial-gradient(120% 100% at 50% 30%, #2b2119, #171310)"; }
    else { s.key.intensity = 1.6; s.key.color.set(0xffffff); if (wrap) wrap.style.background = ""; }
  });
  const envRotate = document.getElementById("m3EnvRotate");
  if (envRotate) envRotate.addEventListener("click", () => {
    const on = envRotate.getAttribute("aria-checked") !== "true";
    envRotate.setAttribute("aria-checked", String(on));
    envRotate.classList.toggle("on", on);
    if (m3three) m3three.controls.autoRotate = on;
    if (viewer) { if (on) viewer.setAttribute("auto-rotate", ""); else viewer.removeAttribute("auto-rotate"); }
  });
  const envBg = document.getElementById("m3EnvBg");
  if (envBg) envBg.addEventListener("click", () => {
    const on = envBg.getAttribute("aria-checked") !== "true";
    envBg.setAttribute("aria-checked", String(on));
    envBg.classList.toggle("on", on);
    const wrap = document.getElementById("m3CanvasWrap");
    if (wrap) wrap.classList.toggle("nobg", !on);
  });
  const shareBtn = document.getElementById("m3ShareBtn");
  if (shareBtn) shareBtn.addEventListener("click", async () => {
    const data = { title: document.title, text: "Free 2D + 3D AI hub — m4ster FrameLab TEST", url: location.href };
    try {
      if (navigator.share) { await navigator.share(data); return; }
      await navigator.clipboard.writeText(location.href);
      say("Link copied — share it anywhere.");
    } catch (e) { /* user cancelled the share sheet */ }
  });
  const reuseBtn = document.getElementById("m3ReuseBtn");
  if (reuseBtn) reuseBtn.addEventListener("click", () => {
    const rail = document.querySelector(".m3-rail");
    if (rail) rail.scrollIntoView({ behavior: "smooth", block: "start" });
    say("Same image, same model — tweak anything and hit Generate again.");
  });
  [["m3DockAnimate", "Animate"], ["m3DockPrint", "Print"]].forEach(([id, name]) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", () => {
      const target = document.getElementById(name === "Animate" ? "labAnimate" : "labPrint");
      if (target) { target.scrollIntoView({ behavior: "smooth", block: "start" }); }
      else say(name + " panel lands in the next drop of this build — the viewer comes first.");
    });
  });

  async function runOne(id) {
    if (id === "sf3d") return m3RunSF3D(file, say);
    if (id === "trellis2") return m3RunTrellis2(file, say);
    if (id === "trellis") return m3RunTrellis(file, say);
    if (id === "hunyuan-mini") return m3RunHunyuanMini(file, say);
    return m3RunInstantMesh(file, say);
  }

  go.addEventListener("click", async () => {
    if (!file || running) return;
    running = true;
    go.disabled = true;
    go.textContent = "WORKING…";
    result.hidden = true;
    hideGlbPreview();
    objUrls.forEach((u) => URL.revokeObjectURL(u));
    objUrls = [];
    const mode = provSel.value;
    /* the optional token is read once, here, at run start — every
     * request this run makes then carries it (see m3AuthHeaders) */
    M3_TOKEN = aiKeyFor("hf-flux");
    const t0 = Date.now();
    try {
      let out, usedName, usedId;
      if (mode === "auto") {
        /* AUTO chain: fast SF3D → textured TRELLIS.2 → InstantMesh →
         * TRELLIS (community) → Hunyuan3D-2 Mini Turbo (shape-only).
         * Any failure switches to the next with an announcement; a
         * ZeroGPU quota refusal is announced as a busy GPU budget. */
        const chain = (window.M3_MULTIVIEW || window.M3_SMART_TOPO) ? ["instantmesh", "sf3d", "trellis2", "trellis", "hunyuan-mini"] : ["sf3d", "trellis2", "instantmesh", "trellis", "hunyuan-mini"];
        let lastErr = null;
        const triedErrs = [];
        for (let i = 0; i < chain.length; i++) {
          try {
            out = await runOne(chain[i]);
            usedName = M3_PROVIDERS[chain[i]].name;
            usedId = chain[i];
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            triedErrs.push(M3_PROVIDERS[chain[i]].name + " (" + shortErr(e) + ")");
            if (i + 1 < chain.length) {
              const curName = M3_PROVIDERS[chain[i]].name, nextName = M3_PROVIDERS[chain[i + 1]].name;
              if (isQuotaErr(e)) {
                say(curName + " — the free GPU budget is busy right now (" + shortErr(e) + ") — switching to " + nextName + "…");
              } else {
                say(curName + " couldn't do it (" + shortErr(e) + ") — switching to " + nextName + ", same as the 2D hub does…");
              }
              /* hold the announcement for a beat — otherwise the next
               * provider's first status overwrites it before it paints */
              await new Promise((r) => setTimeout(r, 900));
            }
          }
        }
        if (!out) { const er = lastErr || new Error("no provider ran"); er.triedErrs = triedErrs; throw er; }
      } else {
        out = await runOne(mode);
        usedName = M3_PROVIDERS[mode].name;
        usedId = mode;
      }
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      const glbUrl = URL.createObjectURL(out.glb);
      objUrls.push(glbUrl);
      glbLink.href = glbUrl;
      glbSize.textContent = "· " + fmtSize(out.glb.size);
      if (out.obj) {
        const objUrl = URL.createObjectURL(out.obj);
        objUrls.push(objUrl);
        objLink.href = objUrl;
        objSize.textContent = "· " + fmtSize(out.obj.size);
        objLink.hidden = false;
      } else {
        objLink.hidden = true;
      }
      resultNote.textContent = "Made by " + usedName + " in ~" + secs + "s, free. GLB drops straight into Unity / Unreal / Godot." +
        (usedId === "hunyuan-mini"
          ? " Note: Hunyuan3D-2 Mini Turbo is shape-only — this mesh is untextured (plain surface, no colors baked in), ready for your own materials."
          : "");
      result.hidden = false;
      say("Done — your mesh is ready below. ⬇");
      showGlbPreview(glbUrl);
    } catch (e) {
      let em = shortErr(e);
      if (!/[.!?]$/.test(em)) em += ".";
      if (mode === "auto" && e && e.triedErrs && e.triedErrs.length) {
        say("All five free 3D providers failed — " + e.triedErrs.join(" · ") + ". No fake mesh, no charge — give the free GPUs a minute and try again.", true);
      } else {
        say((mode === "auto" ? "All five free 3D providers failed: " : "That provider failed: ") +
          em + " No fake mesh, no charge — give the free GPUs a minute and try again.", true);
      }
    } finally {
      running = false;
      go.disabled = !file;
      go.textContent = "✨ Generate";
    }
  });
}

/* ============ step wizard (test build, 2026-10-20) ============
 * The 5 ctl-groups become pages inside ONE frame: clickable progress dots
 * on top, Back / Next at the bottom, Generate only on the last step.
 * Auto-off while pixelart / slicer mode owns the panel (body class watch —
 * every entry point into those modes flips it). */
(function () {
  var aside = document.querySelector(".controls");
  if (!aside) return;
  var groups = Array.prototype.slice.call(aside.querySelectorAll(".ctl-group"));
  var top = document.getElementById("wizTop");
  var dotsEl = document.getElementById("wizDots");
  var countEl = document.getElementById("wizCount");
  var btns = document.getElementById("wizBtns");
  var back = document.getElementById("wizBack");
  var next = document.getElementById("wizNext");
  if (!groups.length || !dotsEl || !back || !next) return;
  var cur = 0, dots = [];
  groups.forEach(function (_, i) {
    var d = document.createElement("button");
    d.type = "button";
    d.className = "wiz-dot";
    d.setAttribute("aria-label", "Go to step " + (i + 1));
    d.addEventListener("click", function () { go(i); });
    dotsEl.appendChild(d);
    dots.push(d);
  });
  function wizardOn() {
    return !(document.body.classList.contains("mode-pixelart") ||
             document.body.classList.contains("mode-slicer"));
  }
  function render() {
    var on = wizardOn();
    aside.classList.toggle("wizard", on);
    aside.classList.toggle("wiz-last", on && cur === groups.length - 1);
    if (top) top.hidden = !on;
    if (btns) btns.hidden = !on;
    groups.forEach(function (g, i) { g.classList.toggle("wiz-on", !on || i === cur); });
    dots.forEach(function (d, i) {
      d.classList.toggle("now", i === cur);
      d.classList.toggle("done", i < cur);
    });
    if (countEl) countEl.textContent = "Step " + (cur + 1) + " of " + groups.length;
    back.disabled = cur === 0;
    next.style.visibility = cur === groups.length - 1 ? "hidden" : "visible";
  }
  function go(i) {
    cur = Math.max(0, Math.min(groups.length - 1, i));
    render();
  }
  back.addEventListener("click", function () { go(cur - 1); });
  next.addEventListener("click", function () { go(cur + 1); });
  new MutationObserver(render).observe(document.body, {
    attributes: true, attributeFilter: ["class"]
  });
  render();
})();

/* ============ test build: Fresh from the Lab — pop in as it scrolls into view ============ */
(function () {
  var el = document.getElementById("freshLab");
  if (!el) return;
  if (!("IntersectionObserver" in window)) { el.classList.add("in"); return; }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) { el.classList.add("in"); io.disconnect(); }
    });
  }, { threshold: 0.12 });
  io.observe(el);
})();

/* ===== P5: Animate panel wiring ===== */
document.addEventListener("DOMContentLoaded", function () {
  const sec = document.getElementById("labAnimate");
  if (!sec) return;
  const PRESETS = [
    ["sway", "Idle Sway", "gentle breathing loop"],
    ["dance", "All Night Dance", "bounce + groove loop"],
    ["nod", "Agree Gesture", "yes nod loop"],
    ["shake", "Disagree Shake", "no shake loop"],
    ["alert", "Alert", "startled tremble loop"],
    ["wave", "Wave", "hello sway loop"],
    ["victory", "Victory Bounce", "celebration loop"],
    ["arise", "Arise", "rise up, one-shot"],
    ["attack", "Attack", "forward lunge, one-shot"],
    ["behit", "BeHit FlyUp", "knockback, one-shot"],
    ["spin", "Spin", "full turn, one-shot"],
    ["bow", "Bow", "deep bow, one-shot"],
    ["jump", "Jump", "hop, one-shot"]
  ];
  const grid = document.getElementById("laGrid");
  const status = document.getElementById("laStatus");
  const mine = document.getElementById("laMine");
  let current = null;
  function say(msg) { if (status) status.textContent = msg; }
  function clearActive() {
    current = null;
    grid.querySelectorAll(".la-preset").forEach((b) => b.classList.remove("active"));
  }
  function logMine(key, name) {
    const empty = document.getElementById("laMineEmpty");
    if (empty) empty.remove();
    if (mine.querySelector('[data-k="' + key + '"]')) return;
    const chip = document.createElement("span");
    chip.className = "la-mine-chip";
    chip.setAttribute("data-k", key);
    chip.appendChild(document.createTextNode(name));
    const rb = document.createElement("button");
    rb.type = "button";
    rb.textContent = "Replay";
    rb.addEventListener("click", () => play(key, name));
    chip.appendChild(rb);
    mine.appendChild(chip);
  }
  function play(key, name) {
    if (!window.M3_PLAY_MOTION) { say("The 3D viewer is not ready yet."); return; }
    if (!window.M3_HAS_MODEL || !window.M3_HAS_MODEL()) {
      say("No mesh loaded yet — generate one in the 3D studio above, or upload a GLB in My Assets, then hit a motion.");
      const st = document.getElementById("m3Stage");
      if (st) st.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (current === key) {
      window.M3_STOP_MOTION();
      clearActive();
      say("Stopped.");
      return;
    }
    if (window.M3_PLAY_MOTION(key)) {
      clearActive();
      current = key;
      const btn = grid.querySelector('[data-k="' + key + '"]');
      if (btn) btn.classList.add("active");
      logMine(key, name);
      say("Playing: " + name + " — watch the viewer. Click it again to stop.");
      const st = document.getElementById("m3Stage");
      if (st) st.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  window.M3_ON_MOTION_END = function () { clearActive(); say("Motion finished."); };
  PRESETS.forEach(([key, name, tag]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "la-preset";
    b.setAttribute("data-k", key);
    b.setAttribute("data-name", name.toLowerCase());
    const st = document.createElement("strong"); st.textContent = name;
    const sp = document.createElement("span"); sp.textContent = tag;
    b.appendChild(st); b.appendChild(sp);
    b.addEventListener("click", () => play(key, name));
    grid.appendChild(b);
  });
  const search = document.getElementById("laSearch");
  if (search) search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    grid.querySelectorAll(".la-preset").forEach((b) => {
      b.style.display = !q || b.getAttribute("data-name").includes(q) ? "" : "none";
    });
  });
  const rig = document.getElementById("laRigBtn");
  if (rig) rig.addEventListener("click", () => play("sway", "Idle Sway"));
  const T2M = [
    [/dance|groove|party/, "dance", "All Night Dance"],
    [/spin|turn|twirl/, "spin", "Spin"],
    [/jump|hop|leap/, "jump", "Jump"],
    [/wave|hello|hi\b|greet/, "wave", "Wave"],
    [/bow/, "bow", "Bow"],
    [/agree|yes|nod/, "nod", "Agree Gesture"],
    [/disagree|no\b|shake/, "shake", "Disagree Shake"],
    [/alert|startle|scare/, "alert", "Alert"],
    [/attack|fight|punch|lunge/, "attack", "Attack"],
    [/hit|knock|fly/, "behit", "BeHit FlyUp"],
    [/arise|rise|stand|spawn/, "arise", "Arise"],
    [/victory|win|celebrat|champion/, "victory", "Victory Bounce"],
    [/idle|sway|breathe|stand/, "sway", "Idle Sway"]
  ];
  const t2mBtn = document.getElementById("laT2mBtn");
  const t2mIn = document.getElementById("laT2mInput");
  const t2mStatus = document.getElementById("laT2mStatus");
  function runT2M() {
    const text = (t2mIn.value || "").toLowerCase();
    if (!text.trim()) { t2mStatus.textContent = "Type a motion first — try \u201cvictory dance\u201d."; return; }
    for (const [re, key, name] of T2M) {
      if (re.test(text)) { t2mStatus.textContent = "Matched: " + name; play(key, name); return; }
    }
    t2mStatus.textContent = "That motion is not in the free library yet. Try: dance, spin, jump, wave, bow, agree, attack, victory, idle.";
  }
  if (t2mBtn) t2mBtn.addEventListener("click", runT2M);
  if (t2mIn) t2mIn.addEventListener("keydown", (e) => { if (e.key === "Enter") runT2M(); });
  const vidBtn = document.getElementById("laVidBtn");
  const vidFile = document.getElementById("laVidFile");
  const vidPrev = document.getElementById("laVidPrev");
  if (vidBtn && vidFile) {
    vidBtn.addEventListener("click", () => vidFile.click());
    vidFile.addEventListener("change", () => {
      const f = vidFile.files && vidFile.files[0];
      if (f && vidPrev) { vidPrev.src = URL.createObjectURL(f); vidPrev.hidden = false; }
      vidFile.value = "";
    });
  }
  // visibility follows the 2D/3D flip, like the studio itself
  const f3 = document.getElementById("flip3d");
  const f2 = document.getElementById("flip2d");
  if (f3) f3.addEventListener("click", () => { sec.hidden = false; });
  if (f2) f2.addEventListener("click", () => { sec.hidden = true; if (window.M3_STOP_MOTION) window.M3_STOP_MOTION(); clearActive(); });
  const dock = document.getElementById("m3DockAnimate");
  if (dock) dock.addEventListener("click", () => { sec.hidden = false; });
});

/* ===== P6: Print & Post-Processing panel wiring ===== */
document.addEventListener("DOMContentLoaded", function () {
  const sec = document.getElementById("labPrint");
  if (!sec) return;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  function hasModel() { return !!(window.M3_HAS_MODEL && window.M3_HAS_MODEL()); }
  function needModel(el) { if (el) el.textContent = "No mesh loaded yet — generate one in the studio or upload a GLB in My Assets first."; }
  function refreshCheck() {
    const st = window.M3_LAST_STATS;
    if (!st) return;
    $("ppFaces").textContent = fmt(st.faces);
    $("ppVerts").textContent = fmt(st.verts);
    $("ppOpen").textContent = fmt(st.openEdges);
    $("ppDegen").textContent = fmt(st.degenerate);
    const v = $("ppVerdict");
    if (st.openEdges === 0 && st.degenerate === 0) v.textContent = "Watertight and clean — this one drops straight into a slicer.";
    else if (st.openEdges === 0) v.textContent = "Watertight shell. " + fmt(st.degenerate) + " degenerate triangles — most slicers ignore or auto-fix those.";
    else v.textContent = fmt(st.openEdges) + " open edges: the shell is not watertight. Bambu Studio / PrusaSlicer will offer a one-click repair — expect a cleanup pass before a clean print.";
    const pc = $("ppSplitParts");
    if (pc && window.M3_MESH_COUNT) {
      const n = window.M3_MESH_COUNT();
      pc.textContent = "⬇ Each part (" + n + ")";
      pc.disabled = n < 2;
    }
  }
  setInterval(() => { if (!sec.hidden) refreshCheck(); }, 1200);
  async function doSplit(mode, el) {
    if (!hasModel()) { needModel(el); return; }
    el.textContent = "Building the split GLB…";
    try {
      const ok = await window.M3_SPLIT(mode);
      el.textContent = ok ? "Split GLB downloaded." : "That split came out empty — try the other half.";
    } catch (e) { el.textContent = "Split failed in the browser: " + (e && e.message ? e.message : e); }
  }
  $("ppSplitTop").addEventListener("click", () => doSplit("top", $("ppSplitStatus")));
  $("ppSplitBottom").addEventListener("click", () => doSplit("bottom", $("ppSplitStatus")));
  $("ppSplitParts").addEventListener("click", () => doSplit("parts", $("ppSplitStatus")));
  // multi-color quantize
  let lastHex = [];
  function sourceImage(cb) {
    const thumb = document.getElementById("m3Thumb");
    if (thumb && thumb.src && !thumb.hidden) { const im = new Image(); im.onload = () => cb(im); im.src = thumb.src; return; }
    if (window.state && state.rows && state.rows.length && state.rows[0].frames && state.rows[0].frames[0]) { cb(state.rows[0].frames[0]); return; }
    cb(null);
  }
  $("ppQuantBtn").addEventListener("click", () => {
    const stEl = $("ppQuantStatus");
    sourceImage((img) => {
      if (!img) { stEl.textContent = "No source image yet — drop an image in the 3D studio or generate a 2D sprite first."; return; }
      const W = 200, H = Math.max(1, Math.round(W * (img.height / img.width)));
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const cx = cv.getContext("2d"); cx.drawImage(img, 0, 0, W, H);
      const data = cx.getImageData(0, 0, W, H).data;
      const pts = [];
      for (let i = 0; i < data.length; i += 16) { if (data[i + 3] > 120) pts.push([data[i], data[i + 1], data[i + 2]]); }
      if (pts.length < 20) { stEl.textContent = "That image is mostly transparent — nothing to quantize."; return; }
      const K = 5;
      let cents = [];
      for (let k = 0; k < K; k++) cents.push(pts[Math.floor((k + 0.5) * pts.length / K)].slice());
      const assign = new Array(pts.length).fill(0);
      for (let iter = 0; iter < 10; iter++) {
        for (let i = 0; i < pts.length; i++) {
          let best = 0, bd = 1e18;
          for (let k = 0; k < K; k++) {
            const dr = pts[i][0] - cents[k][0], dg = pts[i][1] - cents[k][1], db = pts[i][2] - cents[k][2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bd) { bd = d; best = k; }
          }
          assign[i] = best;
        }
        const sums = cents.map(() => [0, 0, 0, 0]);
        pts.forEach((p, i) => { const a = assign[i]; sums[a][0] += p[0]; sums[a][1] += p[1]; sums[a][2] += p[2]; sums[a][3]++; });
        cents = cents.map((c, k) => (sums[k][3] ? [sums[k][0] / sums[k][3], sums[k][1] / sums[k][3], sums[k][2] / sums[k][3]] : c));
      }
      const counts = cents.map(() => 0);
      assign.forEach((a) => counts[a]++);
      const order = cents.map((c, k) => k).sort((a, b) => counts[b] - counts[a]);
      const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
      lastHex = order.map((k) => hex(cents[k]));
      const pal = $("ppPalette");
      pal.innerHTML = "";
      order.forEach((k) => {
        const d = document.createElement("div");
        d.className = "pp-swatch";
        const sw = document.createElement("i"); sw.style.background = hex(cents[k]);
        const tx = document.createElement("span");
        tx.textContent = hex(cents[k]) + " · " + Math.round(counts[k] / pts.length * 100) + "%";
        d.appendChild(sw); d.appendChild(tx); pal.appendChild(d);
      });
      const out = $("ppQuantCanvas");
      const ow = 330, oh = Math.max(1, Math.round(ow * (img.height / img.width)));
      out.width = ow; out.height = oh;
      const ox = out.getContext("2d");
      ox.drawImage(img, 0, 0, ow, oh);
      const od = ox.getImageData(0, 0, ow, oh);
      for (let i = 0; i < od.data.length; i += 4) {
        if (od.data[i + 3] < 120) continue;
        let best = 0, bd = 1e18;
        for (let k = 0; k < K; k++) {
          const dr = od.data[i] - cents[k][0], dg = od.data[i + 1] - cents[k][1], db = od.data[i + 2] - cents[k][2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bd) { bd = d; best = k; }
        }
        od.data[i] = cents[best][0]; od.data[i + 1] = cents[best][1]; od.data[i + 2] = cents[best][2];
      }
      ox.putImageData(od, 0, 0);
      out.hidden = false;
      $("ppQuantDl").hidden = false;
      $("ppHexCopy").hidden = false;
      stEl.textContent = "Palette built — 5 filaments cover the whole image. Biggest color first.";
    });
  });
  $("ppQuantDl").addEventListener("click", () => {
    const out = $("ppQuantCanvas");
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = "framelab-palette.png";
    a.click();
  });
  $("ppHexCopy").addEventListener("click", () => {
    if (navigator.clipboard) navigator.clipboard.writeText(lastHex.join(", "));
    $("ppQuantStatus").textContent = "Hex codes copied: " + lastHex.join(", ");
  });
  // base
  sec.querySelectorAll("[data-base]").forEach((b) => {
    b.addEventListener("click", () => {
      const stEl = $("ppBaseStatus");
      if (!hasModel()) { needModel(stEl); return; }
      if (window.M3_ADD_BASE(b.getAttribute("data-base"))) {
        stEl.textContent = "Base added under the model — check the viewer. Export it with the button below.";
        const st = document.getElementById("m3Stage");
        if (st) st.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });
  $("ppBaseRemove").addEventListener("click", () => { window.M3_REMOVE_BASE(); $("ppBaseStatus").textContent = "Base removed."; });
  $("ppBaseExport").addEventListener("click", async () => {
    const stEl = $("ppBaseStatus");
    if (!hasModel()) { needModel(stEl); return; }
    stEl.textContent = "Baking the base into a GLB…";
    try {
      const ok = await window.M3_EXPORT_WITH_BASE();
      stEl.textContent = ok ? "GLB with base downloaded." : "Add a base first, then export.";
    } catch (e) { stEl.textContent = "Export failed: " + (e && e.message ? e.message : e); }
  });
  // edit
  function doEdit(action, msg) {
    const stEl = $("ppEditStatus");
    if (!hasModel()) { needModel(stEl); return; }
    if (window.M3_EDIT(action)) stEl.textContent = msg;
  }
  $("ppMirror").addEventListener("click", () => doEdit("mirror", "Mirrored on X."));
  $("ppRotY").addEventListener("click", () => doEdit("rotate", "Rotated 90°."));
  $("ppEditReset").addEventListener("click", () => doEdit("reset", "Transform reset."));
  // send to printer
  $("ppSendDl").addEventListener("click", () => {
    const link = document.getElementById("m3Glb");
    const stEl = $("ppSendStatus");
    if (link && link.href && !link.href.endsWith("#")) { link.click(); stEl.textContent = "GLB downloaded — drop it into your slicer."; }
    else stEl.textContent = "No mesh yet — generate one in the studio first, then this button grabs it.";
  });
  // visibility follows the flip, like Animate
  const f3 = document.getElementById("flip3d");
  const f2 = document.getElementById("flip2d");
  if (f3) f3.addEventListener("click", () => { sec.hidden = false; refreshCheck(); });
  if (f2) f2.addEventListener("click", () => { sec.hidden = true; });
  const dock = document.getElementById("m3DockPrint");
  if (dock) dock.addEventListener("click", () => { sec.hidden = false; refreshCheck(); });
});

/* ===== P7: Skills, agent chips, text-to-3D chain ===== */
document.addEventListener("DOMContentLoaded", function () {
  const $ = (id) => document.getElementById(id);
  function rows() { return (typeof state !== "undefined" && state && state.rows) ? state.rows : []; }
  function flip3() { const f = $("flip3d"); if (f) f.click(); }
  function scrollTo(id) { const el = $(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }

  /* --- Text to 3D: fully independent, inside the studio ---
   * The studio draws the image itself through the same free AI API the
   * 2D side uses — the 2D wizard is never opened, flipped to, or
   * borrowed, and its rows are never touched. Steps live in the panel:
   * 1 Describe, 2 Draw, 3 Build mesh. */
  function t3dStep(n) {
    const box = $("m3TSteps");
    if (!box) return;
    box.querySelectorAll("span").forEach((sp) => {
      const k = parseInt(sp.getAttribute("data-s"), 10);
      sp.classList.toggle("on", k === n);
      sp.classList.toggle("done", k < n);
    });
  }
  function t3dStatus(t) { const cs = $("m3ChainStatus"); if (cs) cs.textContent = t; }
  window.M3_TEXT_TO_3D = async function (promptText) {
    if (window.M3_T3D_RUNNING) { t3dStatus("Already drawing one — give it a moment."); return; }
    const text = (promptText || "").trim();
    if (!text) { t3dStatus("Describe the model first."); return; }
    window.M3_T3D_RUNNING = true;
    const btn = $("m3ChainBtn");
    if (btn) btn.disabled = true;
    try {
      /* faces die on Smart: it routes AUTO to InstantMesh first. Text
       * prompts are characters and detailed objects — build them on
       * High Detail. The toggle is right there to switch to Smart. */
      if (window.M3_SMART_TOPO) { const hd = $("m3TopoDetail"); if (hd) hd.click(); }
      t3dStep(2);
      const shaped = text + ", full body, entire figure visible with empty margin around it, head large and clearly detailed, standing straight facing the camera, plain solid white background, studio product photography, sharp focus, no text";
      let bmp = null;
      try {
        bmp = await aiGenerateWith("space-flux", shaped, 1024, 1024, (st) => t3dStatus("Step 2 of 3 — drawing… " + st));
      } catch (fluxErr) {
        bmp = await aiGenerateImage(shaped, 512, 512, (st) => t3dStatus("Step 2 of 3 — drawing… " + st));
      }
      if (!bmp) throw new Error("the image step came back empty — the free queue may have eaten it, try once more.");
      const cv = document.createElement("canvas");
      cv.width = bmp.width || 512; cv.height = bmp.height || 512;
      cv.getContext("2d").drawImage(bmp, 0, 0);
      const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
      if (!blob) throw new Error("could not package the drawn image.");
      const thumb = $("m3ChainThumb");
      if (thumb) { thumb.src = cv.toDataURL("image/png"); thumb.hidden = false; }
      t3dStep(3);
      t3dStatus("Step 3 of 3 — drawn right here in the studio. Building your mesh…");
      if (window.M3_SET_SOURCE) window.M3_SET_SOURCE(new File([blob], "text-to-3d.png", { type: "image/png" }));
      setTimeout(() => { const go = $("m3Go"); if (go && !go.disabled) go.click(); }, 600);
    } catch (e) {
      t3dStep(1);
      t3dStatus("Text to 3D stopped: " + String((e && e.message) || e).slice(0, 220));
    } finally {
      window.M3_T3D_RUNNING = false;
      if (btn) btn.disabled = false;
    }
  };
  /* Skills enter through the studio: land on the 3D side, switch the
   * rail to Text mode, fill the prompt, run the same independent flow. */
  window.M3_ARM_CHAIN = function (promptText) {
    flip3();
    const tt = $("m3TabText");
    if (tt) tt.click();
    const inp = $("m3ChainInput");
    if (inp) inp.value = promptText;
    const sk = $("skStatus");
    if (sk) sk.textContent = "Skill running in the 3D studio — image first, mesh right after, all automatic.";
    scrollTo("lab3d");
    window.M3_TEXT_TO_3D(promptText);
  };
  const chainBtn = $("m3ChainBtn");
  if (chainBtn) chainBtn.addEventListener("click", () => {
    const inp = $("m3ChainInput");
    const text = inp && inp.value.trim();
    if (!text) { t3dStatus("Describe the model first."); return; }
    window.M3_TEXT_TO_3D(text);
  });

  /* image-mode steps: 1 Image, 2 Model, 3 Generate — the studio's own,
   * independent of the 2D wizard's five steps. Polled from real state:
   * a source thumb / enabled Generate means step 1 is done; a loaded
   * model means all three are. */
  setInterval(() => {
    const box = $("m3ISteps");
    if (!box) return;
    const go = $("m3Go");
    const thumb = $("m3Thumb");
    const hasSrc = (thumb && !thumb.hidden) || (go && !go.disabled);
    const hasModel = !!(window.M3_HAS_MODEL && window.M3_HAS_MODEL());
    const cur = hasModel ? 4 : hasSrc ? 2 : 1;
    box.querySelectorAll("span").forEach((sp) => {
      const k = parseInt(sp.getAttribute("data-s"), 10);
      sp.classList.toggle("on", k === cur);
      sp.classList.toggle("done", k < cur);
    });
  }, 800);

  /* --- skills --- */
  const SKILLS = [
    ["&#129528;", "Chibi Figure", "A palm-sized chibi collectible of your character — big head, tiny body, vinyl-toy finish.", "cute chibi figurine of a hero character, big head, small body, vinyl toy style, full body, centered, plain background"],
    ["&#128126;", "Low-Poly Cartoon Buddy", "A game-ready low-poly friend, flat colors and clean shapes — built for game jams.", "low-poly cartoon animal buddy character, flat colors, simple shapes, game asset, full body, centered, plain background"],
    ["&#127963;", "Marble Statue", "A museum-grade marble bust — heroes, pets, or your own portrait in stone.", "classical marble statue bust of a noble warrior, museum sculpture, white marble, dramatic light, plain background"],
    ["&#128054;", "Pet Memorial", "A noble little statue of a very good dog. Edit the prompt with your pet's breed and pose.", "noble dog statue sitting proudly, bronze memorial sculpture style, full body, centered, plain background"],
    ["&#129513;", "Brick Figure", "A minifig-style toy version of anyone — chunky, glossy, collectible.", "plastic brick minifigure character, glossy toy photography style, full body, centered, plain background"],
    ["&#127968;", "First Home Miniature", "Your place as a tiny architectural model — desk-worthy and weirdly emotional.", "miniature architectural scale model of a cozy house, isometric, detailed tiny model, plain background"]
  ];
  const grid = $("skGrid");
  if (grid) {
    SKILLS.forEach(([art, name, tag, prompt]) => {
      const card = document.createElement("div");
      card.className = "sk-card";
      const a = document.createElement("div"); a.className = "sk-art"; a.innerHTML = art;
      const st = document.createElement("strong"); st.textContent = name;
      const p = document.createElement("p"); p.textContent = tag;
      const b = document.createElement("button");
      b.type = "button"; b.textContent = "✨ Make this";
      b.addEventListener("click", () => window.M3_ARM_CHAIN(prompt));
      card.appendChild(a); card.appendChild(st); card.appendChild(p); card.appendChild(b);
      grid.appendChild(card);
    });
  }

  /* --- agent chips: shortcuts into real controls --- */
  const chips = $("agentChips");
  if (chips) chips.addEventListener("click", (e) => {
    const b = e.target.closest("[data-chip]");
    if (!b) return;
    const kind = b.getAttribute("data-chip");
    if (kind === "img3d") { flip3(); scrollTo("m3Stage"); }
    else if (kind === "batch") {
      const sec = $("labAssets");
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "center" });
      const cb = $("assetsBatch");
      if (cb && !cb.checked) cb.click();
    } else if (kind === "rig") {
      flip3();
      const sec = $("labAnimate");
      if (sec) { sec.hidden = false; sec.scrollIntoView({ behavior: "smooth", block: "center" }); }
      const rig = $("laRigBtn");
      if (rig) setTimeout(() => rig.click(), 350);
    } else if (kind === "remesh") { flip3(); const t = $("m3TopoSmart"); if (t) t.click(); scrollTo("lab3d"); }
    else if (kind === "tex2k" || kind === "tex4k") {
      flip3();
      const btn = document.querySelector('.m3-res [data-tex="' + (kind === "tex2k" ? "2048" : "4096") + '"]');
      if (btn) btn.click();
      scrollTo("lab3d");
    } else if (kind === "mv") { flip3(); const mv = $("m3MultiView"); if (mv) mv.click(); scrollTo("lab3d"); }
  });
});

/* ===== featured slider: arrows + auto-advance (portfolio GIF-player pattern) ===== */
document.addEventListener("DOMContentLoaded", function () {
  const grid = document.getElementById("galleryGrid");
  if (!grid) return;
  const step = () => { const c = grid.querySelector(".gcard"); return c ? c.getBoundingClientRect().width + 12 : 260; };
  const go = (d) => {
    const max = grid.scrollWidth - grid.clientWidth - 4;
    let x = grid.scrollLeft + d * step();
    if (x > max) x = 0;
    if (x < 0) x = max;
    grid.scrollTo({ left: x, behavior: "smooth" });
  };
  const prev = document.getElementById("galPrev"), next = document.getElementById("galNext");
  if (prev) prev.addEventListener("click", () => go(-1));
  if (next) next.addEventListener("click", () => go(1));
  let hold = false;
  ["pointerenter", "pointerdown", "touchstart"].forEach((ev) => grid.addEventListener(ev, () => { hold = true; }, { passive: true }));
  grid.addEventListener("pointerleave", () => { hold = false; });
  setInterval(() => { if (!hold && !document.hidden && grid.children.length > 1) go(1); }, 4200);
});


/* ---- m4ster layout tools (MML), ported from the portfolio 2026-10-21.
 * Frames = this page's main sections. He adjusts, Publish copies the
 * layout JSON, and it gets baked back in as window.MML_DEFAULT. ---- */
(function(){
  var LS='mml-layout-v2';
  var $=function(s,r){return (r||document).querySelector(s)};
  var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
  var body=document.body, editing=false, drag=null, toastT=null;

  function load(){try{return JSON.parse(localStorage.getItem(LS))||{}}catch(e){return{}}}
  function posOf(b){
    var m=/translate\(([-\d.]+)px,\s*([-\d.]+)px\)(?:\s*rotate\(([-\d.]+)deg\))?(?:\s*scale\(([-\d.]+)\))?/.exec(b.style.transform||'');
    return m?{x:Math.round(+m[1]),y:Math.round(+m[2]),r:+(m[3]||0),s:+(m[4]||1)}:{x:0,y:0,r:0,s:1};
  }
  function setTransform(b,x,y,s,r){
    r=r||0;
    b.style.transform='translate('+x+'px,'+y+'px)'+(r?' rotate('+r+'deg)':'')+' scale('+s+')';
    var rot=b.querySelector(':scope > .mml-rotate');
    if(rot)rot.style.transform='scale('+(1/s)+')'+(r?' rotate('+(-r)+'deg)':'');
    placeOv(b);
  }
  function ovEl(){var o=document.getElementById('mmlOverlay');if(!o){o=document.createElement('div');o.id='mmlOverlay';document.body.appendChild(o);}return o;}
  function placeOv(b){
    if(!b._hz)return;
    var r=b.getBoundingClientRect();
    if(!r.width&&!r.height){b._hz.style.display='none';(b._dots||[]).forEach(function(d){d.style.display='none'});return;}
    var L=r.left+(window.scrollX||0),T=r.top+(window.scrollY||0);
    b._hz.style.display='';b._hz.style.left=(L+r.width/2)+'px';b._hz.style.top=(T+2)+'px';
    var cs={nw:[L,T],ne:[L+r.width,T],sw:[L,T+r.height],se:[L+r.width,T+r.height]};
    (b._dots||[]).forEach(function(d){d.style.display='';var p=cs[d._corner];if(p){d.style.left=(p[0]-9)+'px';d.style.top=(p[1]-9)+'px';}});
  }
  function setScale(b,x,y,s){var p=posOf(b);setTransform(b,x,y,s,p.r||0);}
  function addFrame(){
    var panel=document.querySelector('.panel[data-pos="0"]');
    var z=panel?panel.querySelector('[data-mml-zone]'):null;
    if(!z)z=document.querySelector('[data-mml-zone="lab"]');
    if(!z){toast('No place to add a frame');return}
    var sec=document.createElement('section');
    sec.setAttribute('data-mml','custom-'+Date.now());
    sec.className='mml-custom';
    sec.innerHTML='<h3 data-mml-edit>New frame</h3><p data-mml-edit>Tap the text to edit it. Drag the handle to place it anywhere.</p>';
    z.appendChild(sec);
    buildHandles();commit();
    if(sec.scrollIntoView)sec.scrollIntoView({block:'nearest'});
    toast('Frame added — drag it anywhere');
  }
  function collect(){
    var prev=load(),m3=document.body.classList.contains('dim-3d');
    var d={pos:m3?Object.assign({},prev.pos||{}):{},pos3:m3?{}:Object.assign({},prev.pos3||{}),pinned:[],custom:[],alive:[]};
    var act=m3?d.pos3:d.pos;
    $$('[data-mml]').forEach(function(b){
      var id=b.getAttribute('data-mml'),p=posOf(b);
      d.alive.push(id);
      if(b.getClientRects().length&&(p.x||p.y||p.s!==1||p.r))act[id]=p;
      if(id.indexOf('custom-')===0||id.indexOf('sep-')===0){
        var clone=b.cloneNode(true);
        clone.querySelectorAll('.mml-handle').forEach(function(h){h.remove()});
        clone.querySelectorAll('[data-mml-edit]').forEach(function(el){el.removeAttribute('contenteditable')});
        var zb=b.parentNode,zid=zb&&zb.getAttribute?zb.getAttribute('data-mml-zone'):null;
        d.custom.push({id:id,zone:zid,html:clone.outerHTML});
      }
    });
    d.pinned=$$('[data-mml].mml-pinned').map(function(b){return b.getAttribute('data-mml')});
    return d;
  }
  function save(){try{localStorage.setItem(LS,JSON.stringify(collect()))}catch(e){}}

  /* ---- undo/redo history: every layout change pushes a snapshot ---- */
  var hist=[],histIdx=-1,graveHtml={},graveSpot={};
  function snapStr(){return JSON.stringify(collect());}
  function commit(){
    save();
    var s=snapStr();
    if(histIdx>=0&&hist[histIdx]===s){updateHistBtns();return;}
    hist=hist.slice(0,histIdx+1);hist.push(s);
    if(hist.length>60)hist.shift();
    histIdx=hist.length-1;updateHistBtns();
  }
  function seedHist(){if(hist.length)return;hist=[snapStr()];histIdx=0;updateHistBtns();}
  function cleanRestored(el){
    if(!el||el.nodeType!==1)return el;
    el.querySelectorAll(':scope > .mml-handle,:scope > .mml-resize,:scope > .mml-rotate').forEach(function(h){h.remove()});
    el.querySelectorAll('[data-mml-edit]').forEach(function(x){if(editing)x.contentEditable='true';else x.removeAttribute('contenteditable')});
    return el;
  }
  function restore(d){
    try{localStorage.setItem(LS,JSON.stringify(d))}catch(e){}
    var keepC={};(d.custom||[]).forEach(function(c){keepC[c.id]=c;});
    $$('[data-mml]').forEach(function(b){
      var id=b.getAttribute('data-mml');
      if((id.indexOf('custom-')===0||id.indexOf('sep-')===0)&&!keepC[id])b.remove();
    });
    (d.custom||[]).forEach(function(c){
      if(document.querySelector('[data-mml="'+c.id+'"]'))return;
      var z=(c.zone&&document.querySelector('[data-mml-zone="'+c.zone+'"]'))||document.querySelector('[data-mml-zone="lab"]');
      if(!z)return;
      var tmp=document.createElement('div');tmp.innerHTML=c.html;
      if(tmp.firstChild)z.appendChild(cleanRestored(tmp.firstChild));
    });
    (d.alive||[]).forEach(function(id){
      if(document.querySelector('[data-mml="'+id+'"]'))return;
      if(!graveHtml[id])return;
      var spot=graveSpot[id]||{};
      var tmp=document.createElement('div');tmp.innerHTML=graveHtml[id];
      var el=cleanRestored(tmp.firstChild);if(!el)return;
      if(spot.parent&&spot.parent.isConnected){
        if(spot.next&&spot.next.parentNode===spot.parent)spot.parent.insertBefore(el,spot.next);
        else spot.parent.appendChild(el);
      }else{var z=document.querySelector('[data-mml-zone="lab"]');if(z)z.appendChild(el);}
    });
    buildHandles();
    $$('[data-mml]').forEach(function(b){
      var id=b.getAttribute('data-mml'),pp=(d.pos||{})[id];
      if(pp)setTransform(b,pp.x,pp.y,pp.s||1,pp.r||0);else if(b.style.transform)b.style.transform='';
      b.classList.toggle('mml-pinned',(d.pinned||[]).indexOf(id)>-1);
    });
  }
  function undoHist(){
    if(histIdx<=0){toast('Nothing to undo');return;}
    histIdx--;restore(JSON.parse(hist[histIdx]));updateHistBtns();toast('Undone');
  }
  function redoHist(){
    if(histIdx>=hist.length-1){toast('Nothing to redo');return;}
    histIdx++;restore(JSON.parse(hist[histIdx]));updateHistBtns();toast('Redone');
  }
  function updateHistBtns(){
    var u=document.querySelector('#mmlToolbar [data-act="undo"]'),r=document.querySelector('#mmlToolbar [data-act="redo"]');
    if(u){var on=histIdx>0;u.disabled=!on;u.style.opacity=on?1:.4;}
    if(r){var on2=histIdx>=0&&histIdx<hist.length-1;r.disabled=!on2;r.style.opacity=on2?1:.4;}
  }
  function bp(){return window.innerWidth<=700?'mobile':'desktop';}
  /* Saved-layout repair: every frame's x is clamped inside the viewport
     (desktop too, not just mobile), so a layout dragged off-screen
     self-heals on the next load instead of staying cut off forever. */
  function clampToViewport(){
    if(editing)return;
    $$('[data-mml]').forEach(function(b){
      var hid=b.closest('.panel[data-pos]');
      if(hid&&hid.getAttribute('data-pos')!=='0')return;
      var r=b.getBoundingClientRect();
      if(!r.width)return;
      var dx=0;
      if(r.left<0)dx=-r.left;
      else if(r.right>window.innerWidth)dx=window.innerWidth-r.right;
      if(dx){
        var p=posOf(b);
        var k=r.width/((b.offsetWidth||r.width)*(p.s||1));if(!isFinite(k)||k<=0)k=1;
        setTransform(b,p.x+dx/k,p.y,p.s,p.r);
      }
    });
  }
  /* ---- live equalizer: no frame ever overlaps the one above it.
     Runs after every apply() and on resize (debounced). Gaps stay equal
     (18px desktop / 16px mobile) at ANY width, in either mode, for the
     baked default AND for a saved layout. Never runs while editing, so
     it never fights a drag. Frames stack in DOM order (not saved-top
     order), so a scrambled saved layout self-repairs on load instead
     of preserving the scramble. ---- */
  var eqT=null;
  function equalize(){
    if(editing)return;
    var G=bp()==='mobile'?16:18;
    var frames=$$('[data-mml]').filter(function(b){
      if(!b.getClientRects().length)return false;
      var r=b.getBoundingClientRect();
      return r.width>0&&r.height>0;
    });
    if(frames.length<2)return;
    /* .reveal animates transform over .55s, so a rect read mid-flight is
       stale and setTransform glides instead of landing. Kill transitions
       first (in-flight ones snap to their end state), force a reflow,
       then measure: rects are exact and moves land instantly. */
    var saved=[];
    frames.forEach(function(b){saved.push([b,b.style.transition]);b.style.transition='none';});
    void document.body.offsetHeight;
    var items=frames.map(function(b,idx){
      var r=b.getBoundingClientRect();
      return {b:b,dom:idx,top:r.top+(window.scrollY||0),bottom:r.bottom+(window.scrollY||0),w:r.width,offW:b.offsetWidth||r.width};
    });
    items.sort(function(a,b){return a.dom-b.dom;});
    /* Floor: no frame may hide under the sticky top bar. A saved layout
       with one frame dragged far above the page used to drag the whole
       stack off-screen with it (the anchor never moves, the rest stack
       under it). Clamp every sub-floor frame down to the floor, then
       re-sort in DOM order and stack as usual. */
    var tb0=document.querySelector('.topbar');
    /* Document floor: the topbar's height. A frame's document top must
       never sit above it (unreachable above the page top). It is NOT
       scrollY + height: on a scrolled load that would shove the whole
       stack down to the restored scroll position and leave the page top
       a void. The topbar is sticky, so its viewport bottom IS its height. */
     var floor=(tb0?Math.ceil(tb0.getBoundingClientRect().bottom):(bp()==='mobile'?107:67));
    items.forEach(function(it){
      if(it.top<floor){
        var p=posOf(it.b);
        var k=it.w/((it.offW||it.w)*(p.s||1));if(!isFinite(k)||k<=0)k=1;
        var dy=(floor-it.top)/k;
        setTransform(it.b,p.x,Math.round(p.y+dy),p.s,p.r);
        it.bottom+=floor-it.top;it.top=floor;
      }
    });
    items.sort(function(a,b){return a.dom-b.dom;});
    /* Anchor: the first frame in DOM order starts at the floor. A saved
       layout with the first frame dragged far down would otherwise leave
       a hole at the top of the page (the old top-sort hid this, because
       the topmost frame always anchored the stack). */
    var first=items[0];
    if(first.top>floor+G){
      var p0=posOf(first.b);
      var k0=first.w/((first.offW||first.w)*(p0.s||1));if(!isFinite(k0)||k0<=0)k0=1;
      setTransform(first.b,p0.x,Math.round(p0.y-(first.top-floor)/k0),p0.s,p0.r);
      first.bottom-=first.top-floor;first.top=floor;
    }
    var prevBottom=items[0].bottom;
    for(var i=1;i<items.length;i++){
      var it=items[i],need=prevBottom+G-it.top;
      /* Two-way: push down onto overlaps AND pull up out of empty holes,
         so gaps come out EQUAL (not just >= G) at every width. Safe: the
         frame lands exactly G below the previous bottom, never on it. */
      if(need>0.5||need<-2){
        var p=posOf(it.b);
        var k=it.w/((it.offW||it.w)*(p.s||1));if(!isFinite(k)||k<=0)k=1;
        setTransform(it.b,p.x,Math.round(p.y+need/k),p.s,p.r);
        it.top+=need;it.bottom+=need; /* exact: move already applied, never re-read mid-flight */
      }
      if(it.bottom>prevBottom)prevBottom=it.bottom;
    }
    requestAnimationFrame(function(){saved.forEach(function(s){s[0].style.transition=s[1];});});
  }
  function equalizeSoon(ms){clearTimeout(eqT);eqT=setTimeout(equalize,ms||500);}
  /* Re-run whenever content reflows (webfonts, images, dynamic panels):
     the first equalize can measure fallback-font heights; this catches
     the real heights once they land. Self-terminating: a no-op run
     changes nothing, so no further observer callbacks fire. */
  if(window.ResizeObserver){
    try{
      var eqRO=new ResizeObserver(function(){equalizeSoon(250);});
      if(document.body)eqRO.observe(document.body);
    }catch(e){}
  }
  if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){equalizeSoon(300);});}
  window.addEventListener('orientationchange',function(){setTimeout(clampToViewport,350);});
  function apply(){
    var d=load();
    if(!d||!Object.keys(d).length){
      try{var defs=window.MML_DEFAULT||{};if(defs[bp()])d=defs[bp()];}catch(e){}
    }
    (d.custom||[]).forEach(function(c){
      if(document.querySelector('[data-mml="'+c.id+'"]'))return;
      var z=(c.zone&&document.querySelector('[data-mml-zone="'+c.zone+'"]'))||document.querySelector('[data-mml-zone="lab"]');
      if(!z)return;
      var tmp=document.createElement('div');tmp.innerHTML=c.html;
      if(tmp.firstChild)z.appendChild(tmp.firstChild);
    });
    var m3=document.body.classList.contains('dim-3d');
    var posMap=m3?Object.assign({},d.pos||{},d.pos3||{}):Object.assign({},d.pos3||{},d.pos||{});
    Object.keys(posMap).forEach(function(id){
      var b=document.querySelector('[data-mml="'+id+'"]');
      if(b){var pp=posMap[id];setTransform(b,pp.x,pp.y,pp.s||1,pp.r||0);}
    });
    (d.pinned||[]).forEach(function(id){
      var b=document.querySelector('[data-mml="'+id+'"]'); if(b)b.classList.add('mml-pinned');
    });
    clampToViewport();
    equalize();
    equalizeSoon(600);
  }
  function toast(msg){
    var t=$('#mmlToast');
    if(!t){t=document.createElement('div');t.id='mmlToast';t.className='mml-toast';body.appendChild(t);}
    t.textContent=msg; t.classList.add('show');
    clearTimeout(toastT); toastT=setTimeout(function(){t.classList.remove('show')},1800);
  }
  function label(b){var h=b.querySelector('h1,h2,h3,h4');return (h?h.textContent:'frame').trim().slice(0,26)}

  function buildHandles(root){
    $$('[data-mml]',root||document).forEach(function(b){
      if(b._hz)return;
      var hidPanel=b.closest('.panel[data-pos]');
      if(hidPanel&&hidPanel.getAttribute('data-pos')!=='0')return;
      b.style.position='relative';
      b.classList.add('in');
      var h=document.createElement('div');
      h.className='mml-handle';
      h.innerHTML='<span class="mml-grip" title="Drag to move">\u22EE\u22EE</span><span></span><button class="mml-rotate-btn" type="button" title="Rotate">&#x21BB;</button><button class="mml-pin" type="button" title="Pin / unpin">&#x1F4CC;</button><button class="mml-del" type="button" title="Delete frame"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c0c8d4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>';
      h.children[1].textContent=label(b);
      ovEl().appendChild(h);b._hz=h;
      h.querySelector('.mml-pin').addEventListener('click',function(e){
        e.stopPropagation();e.preventDefault();
        b.classList.toggle('mml-pinned');commit();
        toast(b.classList.contains('mml-pinned')?'Pinned \u2014 locked in place':'Unpinned \u2014 draggable');
      });
      h.querySelector('.mml-rotate-btn').addEventListener('pointerdown',function(e){
        e.stopPropagation();e.preventDefault();
        startRotate(e,b);
      });
      h.querySelector('.mml-del').addEventListener('click',function(e){
        e.stopPropagation();e.preventDefault();
        deleteFrame(b);
      });
      h.addEventListener('pointerdown',function(e){
        if(e.target.closest('.mml-pin'))return;
        startDrag(e,b);
      });
      h.addEventListener('dblclick',function(e){
        if(e.target.closest('.mml-pin'))return;
        b.style.transform='';commit();toast('Position cleared');
      });
            if(!b._dots){
        b._dots=[];
        ['nw','ne','sw','se'].forEach(function(c){
          var rh=document.createElement('div');
          rh.className='mml-resize '+c;
          rh._corner=c;
          ovEl().appendChild(rh);b._dots.push(rh);
          rh.addEventListener('pointerdown',function(e){e.stopPropagation();e.preventDefault();startResize(e,b)});
        });
      }
      var p0=posOf(b);if(p0.s!==1||p0.r)setTransform(b,p0.x,p0.y,p0.s,p0.r);
      placeOv(b);
    });
  }
  function dropHandles(){var o=document.getElementById('mmlOverlay');if(o)o.remove();$$('[data-mml]').forEach(function(b){b._hz=null;b._dots=null;if(!b.closest('.mml-always'))b.style.position=''})}

  function kOf(el){var r=el.getBoundingClientRect();var w=el.offsetWidth||0;var k=w?r.width/w:1;return (isFinite(k)&&k>0)?k:1;}
  function showGuide(ori,pos){
    var id='mmlGuide'+ori,g=document.getElementById(id);
    if(!g){g=document.createElement('div');g.id=id;g.className='mml-guide '+ori;document.body.appendChild(g);}
    var kg=kOf(g);if(ori==='v')g.style.left=(pos/kg)+'px';else g.style.top=(pos/kg)+'px';
    g.style.display='block';
  }
  function hideGuide(ori){
    var g=document.getElementById('mmlGuide'+ori);
    if(g)g.style.display='none';
  }
  function startDrag(e,b){
    if(b.classList.contains('mml-pinned')){toast('Unpin it first to move it');return}
    e.preventDefault();
    var sx=e.clientX,sy=e.clientY,active=false;
    var cur=posOf(b);
    var br0=b.getBoundingClientRect();
    var kF=br0.width/((b.offsetWidth||br0.width)*(cur.s||1));if(!isFinite(kF)||kF<=0)kF=1;
    function mv(ev){
      if(!active){
        if(Math.hypot(ev.clientX-sx,ev.clientY-sy)<6)return;
        active=true;drag={el:b};
        b.classList.add('mml-dragging');
      }
      var nx=cur.x+(ev.clientX-sx)/kF,ny=cur.y+(ev.clientY-sy)/kF;
      // alignment guides: snap to centers of other frames
      var br=b.getBoundingClientRect();
      var bcx=br.left+br.width/2,bcy=br.top+br.height/2;
      var snapX=null,snapY=null;
      $$('[data-mml]').forEach(function(o){
        if(o===b||!o.offsetParent)return;
        var r=o.getBoundingClientRect();
        var ocx=r.left+r.width/2,ocy=r.top+r.height/2;
        if(Math.abs(bcx-ocx)<6)snapX=nx+(ocx-bcx)/kF;
        if(Math.abs(bcy-ocy)<6)snapY=ny+(ocy-bcy)/kF;
      });
      if(snapX!==null){nx=snapX;showGuide('v',bcx);}
      else hideGuide('v');
      if(snapY!==null){ny=snapY;showGuide('h',bcy);}
      else hideGuide('h');
      var tb1=document.querySelector('.topbar');
      var floorV=tb1?Math.ceil(tb1.getBoundingClientRect().bottom):(bp()==='mobile'?107:67);
      var newTop=br.top+(ny-cur.y)*kF;
      if(newTop<floorV)ny=cur.y+(floorV-br.top)/kF;
      setScale(b,nx,ny,cur.s);
    }
    function up(){
      window.removeEventListener('pointermove',mv);
      window.removeEventListener('pointerup',up);
      window.removeEventListener('pointercancel',up);
      if(!active)return;
      b.classList.remove('mml-dragging');
      hideGuide('v');hideGuide('h');
      drag=null;commit();
      toast('Placed \u2014 layout saved');
    }
    window.addEventListener('pointermove',mv);
    window.addEventListener('pointerup',up);
    window.addEventListener('pointercancel',up);
  }

  function startResize(e,b){
    if(b.classList.contains('mml-pinned')){toast('Unpin it first to resize it');return}
    var r=b.getBoundingClientRect();
    var cx=r.left+r.width/2,cy=r.top+r.height/2;
    var sx=e.clientX,sy=e.clientY,active=false;
    var startDist=Math.max(20,Math.hypot(sx-cx,sy-cy));
    var cur=posOf(b),startS=cur.s;
    function mv(ev){
      if(!active){
        if(Math.hypot(ev.clientX-sx,ev.clientY-sy)<6)return;
        active=true;
      }
      var d=Math.max(20,Math.hypot(ev.clientX-cx,ev.clientY-cy));
      var ns=Math.min(3,Math.max(0.3,startS*d/startDist));
      setScale(b,cur.x,cur.y,ns);
    }
    function up(){
      window.removeEventListener('pointermove',mv);
      window.removeEventListener('pointerup',up);
      window.removeEventListener('pointercancel',up);
      if(!active)return;
      commit();toast('Resized — layout saved');
    }
    window.addEventListener('pointermove',mv);
    window.addEventListener('pointerup',up);
    window.addEventListener('pointercancel',up);
  }

  function startRotate(e,b){
    if(b.classList.contains('mml-pinned')){toast('Unpin it first to rotate it');return}
    e.preventDefault();
    var r=b.getBoundingClientRect();
    var cx=r.left+r.width/2, cy=r.top+r.height/2;
    var cur=posOf(b), startR=cur.r||0;
    var startAng=Math.atan2(e.clientY-cy, e.clientX-cx)*180/Math.PI;
    var label=document.createElement('div');
    label.className='mml-deg-label';
    document.body.appendChild(label);
    label.style.display='block';
    var kL=kOf(label);
    function updateLabel(deg, x, y){
      var norm=((Math.round(deg)%360)+360)%360;
      label.textContent=norm+'\u00B0';
      label.style.left=((x+16)/kL)+'px';
      label.style.top=((y-10)/kL)+'px';
      label.style.display='block';
    }
    function mv(ev){
      var ang=Math.atan2(ev.clientY-cy, ev.clientX-cx)*180/Math.PI;
      var deg=startR+(ang-startAng);
      var snapped=Math.round(deg/15)*15;
      if(Math.abs(deg-snapped)<3)deg=snapped;
      setTransform(b,cur.x,cur.y,cur.s,Math.round(deg*10)/10);
      updateLabel(deg, ev.clientX, ev.clientY);
    }
    function up(){
      window.removeEventListener('pointermove',mv);
      window.removeEventListener('pointerup',up);
      window.removeEventListener('pointercancel',up);
      if(label.parentNode)label.parentNode.removeChild(label);
      commit();toast('Rotated \u2014 layout saved');
    }
    window.addEventListener('pointermove',mv);
    window.addEventListener('pointerup',up);
    window.addEventListener('pointercancel',up);
    updateLabel(startR, e.clientX, e.clientY);
  }

  function deleteFrame(b){
    var id=b.getAttribute('data-mml');
    if(id.indexOf('custom-')!==0&&id.indexOf('sep-')!==0){
      graveHtml[id]=b.outerHTML;
      graveSpot[id]={parent:b.parentNode,next:b.nextSibling};
    }
    if(b._hz)b._hz.remove();(b._dots||[]).forEach(function(d){d.remove()});b._hz=null;b._dots=null;
    b.parentNode.removeChild(b);
    commit();
    toast('Frame deleted \u2014 Ctrl+Z or Undo to restore');
  }

  function spawnRGB(){
    var panel=document.querySelector('.panel[data-pos="0"]');
    var z=panel?panel.querySelector('[data-mml-zone]'):null;
    if(!z)z=document.querySelector('[data-mml-zone="lab"]');
    if(!z)z=document.querySelector('#mmlZone')||document.body;
    var d=document.createElement('div');
    d.className='rgb-sep';
    d.setAttribute('data-mml','sep-'+Date.now());
    d.style.margin='20px 0';
    z.appendChild(d);
    buildHandles();commit();
    if(d.scrollIntoView)d.scrollIntoView({block:'nearest'});
    toast('Separator added \u2014 drag it anywhere');
  }

  function buildToolbar(){
    if($('#mmlToolbar'))return;
    var t=document.createElement('div');
    t.className='mml-toolbar';t.id='mmlToolbar';
    t.innerHTML='<span class="mml-grip" style="cursor:grab" title="Drag to move">⋮⋮</span><span class="mml-ttitle" title="Drag to move">Toolbar</span><button class="mml-pin" type="button" data-act="pin" title="Pin toolbar">&#x1F4CC;</button><button type="button" data-act="add">+ Frame</button><button type="button" data-act="addrgb" title="Add separator">+ Line</button><button type="button" data-act="copy">Copy layout</button><button type="button" data-act="publish" class="primary">Publish</button><button type="button" data-act="undo" style="opacity:.4" title="Undo last move (Ctrl+Z)">\u21A9 Undo</button><button type="button" data-act="redo" style="opacity:.4" title="Redo (Ctrl+Shift+Z)">\u21AA Redo</button><button type="button" data-act="reset">Reset</button><button type="button" data-act="done" class="primary">Done</button>';
    body.appendChild(t);
    t.addEventListener('click',function(e){
      var a=e.target&&e.target.getAttribute&&e.target.getAttribute('data-act');if(!a)return;
      if(a==='done')setEditing(false);
      else if(a==='pin'){t.classList.toggle('mml-pinned');saveTb();toast(t.classList.contains('mml-pinned')?'Toolbar pinned':'Toolbar unpinned');}
      else if(a==='add')addFrame();
      else if(a==='addrgb')spawnRGB();
      else if(a==='undo'){undoHist();}
      else if(a==='redo'){redoHist();}
      else if(a==='reset'){try{localStorage.removeItem(LS);localStorage.removeItem('mml-toolbar-v1');localStorage.removeItem('mml-fab-v1')}catch(_){} location.reload();}
      else if(a==='copy'){
        save();
        var txt='';
        try{txt=localStorage.getItem(LS)||''}catch(_){}
        copyText(txt);
        toast('Layout copied — send it to me and I’ll bake it into the site');
      }
      else if(a==='publish'){
        save();
        var txt='';
        try{txt=localStorage.getItem(LS)||''}catch(_){}
        copyText(txt);
        toast('Published ('+bp()+') copied — send it to me, every visitor sees YOUR layout');
      }
    });
    restoreTb(t);
    t.addEventListener('pointerdown',function(e){
      if(e.target.closest('button'))return;
      if(t.classList.contains('mml-pinned')){toast('Unpin the toolbar to move it');return}
      e.preventDefault();
      var r=t.getBoundingClientRect();
      var kT=kOf(t);
      t.style.left=(r.left/kT)+'px';t.style.top=(r.top/kT)+'px';t.style.transform='none';t.style.bottom='auto';
      var dx=e.clientX-r.left,dy=e.clientY-r.top,rw=r.width,rh=r.height;
      function mv(ev){
        var vx=Math.min(Math.max(ev.clientX-dx,8),window.innerWidth-rw-8);
        var vy=Math.min(Math.max(ev.clientY-dy,8),window.innerHeight-rh-8);
        t.style.left=(vx/kT)+'px';
        t.style.top=(vy/kT)+'px';
      }
      function up(){window.removeEventListener('pointermove',mv);window.removeEventListener('pointerup',up);saveTb();}
      window.addEventListener('pointermove',mv);window.addEventListener('pointerup',up);
    });
  }
  function saveTb(){
    var t=$('#mmlToolbar');if(!t)return;
    try{localStorage.setItem('mml-toolbar-v1',JSON.stringify({left:t.style.left||'',top:t.style.top||'',pinned:t.classList.contains('mml-pinned')}))}catch(e){}
  }
  function restoreTb(t){
    var d=null;try{d=JSON.parse(localStorage.getItem('mml-toolbar-v1'))}catch(e){}
    if(!d)return;
    if(d.left&&d.top){t.style.left=d.left;t.style.top=d.top;t.style.transform='none';t.style.bottom='auto';}
    if(d.pinned)t.classList.add('mml-pinned');
  }
  function dropToolbar(){var t=$('#mmlToolbar');if(t)t.remove()}
  function copyText(txt){
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).catch(function(){fallback()});}
    else fallback();
    function fallback(){
      var ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';
      body.appendChild(ta);ta.select();
      try{document.execCommand('copy')}catch(e){}
      ta.remove();
    }
  }

  new MutationObserver(function(){apply();}).observe(document.body,{attributes:true,attributeFilter:['class']});
  function setEditing(on){
    editing=on;document.body.classList.toggle('mml-editing',!!on);
    /* body.classList.toggle('mml-on',on); REMOVED - white screen */
    if(on){buildHandles();buildToolbar();seedHist();pokeToolbar();toast('Tools on — drag frames anywhere, pin to lock');
      $$('[data-mml-edit]').forEach(function(el){el.contentEditable='true'});}
    else{save();dropHandles();dropToolbar();
      $$('[data-mml-edit]').forEach(function(el){el.removeAttribute('contenteditable')});}
    syncFab();
  }
  var idleT=null,lastPoke=0;
  function pokeToolbar(){
    var t=document.getElementById('mmlToolbar');if(!t)return;
    t.classList.remove('mml-idle');
    clearTimeout(idleT);
    idleT=setTimeout(function(){var x=document.getElementById('mmlToolbar');if(x)x.classList.add('mml-idle')},6000);
  }
  function buildFab(){
    if(document.getElementById('mmlFab'))return;
    var f=document.createElement('button');
    f.id='mmlFab';f.className='mml-fab';f.type='button';f.title='Layout tools';f.setAttribute('aria-label','Toggle layout tools');
    f.textContent='✎';
    var fabMoved=false;
    f.addEventListener('pointerdown',function(e){
      e.preventDefault();
      var sx=e.clientX,sy=e.clientY,moved=false;
      var r=f.getBoundingClientRect();
      var kFb=kOf(f);
      var dx=e.clientX-r.left,dy=e.clientY-r.top,rw=r.width,rh=r.height;
      function mv(ev){
        if(!moved&&Math.hypot(ev.clientX-sx,ev.clientY-sy)<6)return;
        moved=true;fabMoved=true;
        var vx=Math.min(Math.max(ev.clientX-dx,8),window.innerWidth-rw-8);
        var vy=Math.min(Math.max(ev.clientY-dy,8),window.innerHeight-rh-8);
        f.style.left=(vx/kFb)+'px';
        f.style.top=(vy/kFb)+'px';
        f.style.bottom='auto';f.style.right='auto';
      }
      function up(){
        window.removeEventListener('pointermove',mv);
        window.removeEventListener('pointerup',up);
        if(moved)saveFab();
      }
      window.addEventListener('pointermove',mv);
      window.addEventListener('pointerup',up);
    });
    f.addEventListener('click',function(){
      if(fabMoved){fabMoved=false;return}
      setEditing(!editing);
    });
    document.body.appendChild(f);
    restoreFab();
  }
  function saveFab(){
    var f=document.getElementById('mmlFab');if(!f)return;
    try{localStorage.setItem('mml-fab-v1',JSON.stringify({left:f.style.left||'',top:f.style.top||''}))}catch(e){}
  }
  function clampFab(){
    var f=document.getElementById('mmlFab');if(!f)return;
    var r=f.getBoundingClientRect();
    var m=10,changed=false;
    if(r.right>window.innerWidth-m){f.style.left=(window.innerWidth-m-r.width)+'px';f.style.right='auto';changed=true;}
    if(r.bottom>window.innerHeight-m){f.style.top=(window.innerHeight-m-r.height)+'px';f.style.bottom='auto';changed=true;}
    if(r.left<m){f.style.left=m+'px';changed=true;}
    if(r.top<m){f.style.top=m+'px';changed=true;}
    if(changed)saveFab();
  }
  function restoreFab(){
    var f=document.getElementById('mmlFab');if(!f)return;
    var d=null;try{d=JSON.parse(localStorage.getItem('mml-fab-v1'))}catch(e){}
    if(!d||!d.left||!d.top)return;
    f.style.left=d.left;f.style.top=d.top;f.style.bottom='auto';f.style.right='auto';
    clampFab();
  }
  window.addEventListener('resize',function(){clampFab();});
  window.addEventListener('resize',function(){clampToViewport();equalizeSoon(350);});
  window.addEventListener('load',function(){equalizeSoon(400);});
  function syncFab(){
    var f=document.getElementById('mmlFab');if(!f)return;
    f.textContent=editing?'✕':'✎';
    f.title=editing?'Close layout tools':'Open layout tools';
  }
  /* Footer "Reset layout" button: clears the saved layout (and the
     toolbar/fab prefs) and reloads, so a scrambled layout is one tap away
     from the default arrangement. */
  var resetBtn=document.getElementById('resetLayoutBtn');
  if(resetBtn)resetBtn.addEventListener('click',function(){
    try{localStorage.removeItem(LS);localStorage.removeItem('mml-toolbar-v1');localStorage.removeItem('mml-fab-v1');}catch(_){}
    location.reload();
  });
  document.addEventListener('keydown',function(e){
    var tag=(e.target&&e.target.tagName)||'';
    if(tag==='INPUT'||tag==='TEXTAREA')return;
    if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.code==='KeyE'){e.preventDefault();setEditing(!editing);}
  });
  document.addEventListener('keydown',function(e){
    if(!editing)return;
    var t=e.target;
    if(t&&(t.isContentEditable||t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'))return;
    if(!(e.ctrlKey||e.metaKey))return;
    var k=(e.key||'').toLowerCase();
    if(k==='z'&&!e.shiftKey){e.preventDefault();undoHist();}
    else if(k==='y'||(k==='z'&&e.shiftKey)){e.preventDefault();redoHist();}
    if(e.code==='Escape'&&editing)setEditing(false);
  });
  document.addEventListener('tabswitch',function(){if(editing)buildHandles();});
  buildFab();
  var pg=document.querySelector('.mml-always'); if(pg)buildHandles(pg);
  var pgR=document.getElementById('pgReset');
  if(pgR)pgR.addEventListener('click',function(){
    $$('[data-mml^="pg-"]').forEach(function(b){
      b.style.transform='';b.style.position='';
      b.classList.remove('mml-pinned');
      var h=b.querySelector(':scope > .mml-handle .mml-pin');
      if(h)h.textContent='📌';
    });
    try{
      var order=JSON.parse(localStorage.getItem(LSK)||'[]');
      order=order.filter(function(o){return o.id.indexOf('pg-')!==0});
      localStorage.setItem(LSK,JSON.stringify(order));
    }catch(e){}
    buildHandles(pg);
    toast('Demo reset');
  });
  var dr=document.getElementById('mmlDemoReset');
  if(dr)dr.addEventListener('click',function(){
    $$('[data-mml^="demo-"]').forEach(function(b){b.style.transform='';b.classList.remove('mml-pinned')});
    save();toast('Playground reset');
  });
  ['pointerdown','pointermove'].forEach(function(ev){
    document.addEventListener(ev,function(){
      if(!editing)return;
      var n=Date.now();if(n-lastPoke<1500)return;lastPoke=n;pokeToolbar();
    },true);
  });
  window.addEventListener('resize',function(){
    var t=document.getElementById('mmlToolbar');if(!t||!t.style.left)return;
    var r=t.getBoundingClientRect();
    t.style.left=Math.max(8,Math.min(parseFloat(t.style.left),window.innerWidth-r.width-8))+'px';
    t.style.top=Math.max(8,Math.min(parseFloat(t.style.top),window.innerHeight-r.height-8))+'px';
    saveTb();
  });
  apply();
  if(/(?:\?|&|#)edit(?:=1)?(?:&|$)/.test(location.href))setEditing(true);
})();
