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

/* one friendly line for any thrown error: network, timeout and abort
 * failures get plain words instead of raw exception text; anything
 * else keeps its own message, capped so a long string can never
 * flood a status line. */
function humanErr(e) {
  const m = e && e.message ? String(e.message) : String(e);
  if (/failed to fetch|networkerror|network error|load failed/i.test(m)) return "couldn't be reached (network)";
  if (/timed out|timeout/i.test(m)) return "timed out";
  if (/aborted|aborterror/i.test(m)) return "was stopped";
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
}

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
  draglab: null,           // v8.2 DragLab warp: { src:{data,w,h}, imgW, imgH, points:[{px,py,qx,qy}], name, mode, brush, brushUndo, brushKind, brushSize, brushStrength } (brush = v8.6 liquify grid)
  cutout: null,            // v8.3 Cutout Lab AI bg removal: { src:{data,w,h}, imgW, imgH, matte, threshold, feather, busy, name }
  upscale: null,           // v8.4 Upscale Lab AI enlargement: { src, srcCv, imgW, imgH, out, outKind, mode, pxScale, pxAlgo, exportScale, compare, busy, name }
  atlasPack: null,         // v8.5 Atlas Packer: { items:[{name,cv,data}], packed, pad, extrude, pot, labels, format } — state.atlas is the generator's own sheet, hence the longer key
  normalmap: null,         // v8.7 Normal Map Lab: { src:{data,w,h}, imgW, imgH, name, view, strength, smooth, alphaMode, wrap, flipY, maps, light }
  tiler: null,             // v8.8 Seamless Tiler: { src:{data,w,h}, full:{data,w,h}, imgW, imgH, name, view, strength, healed, healedCv }
  palette: null,           // v8.9 Palette Lab: { src:{data,w,h}, imgW, imgH, name, work:{data,w,h}, colors:[{r,g,b,count}], fromIdx, toHex, tolerance, undo:[] }
  gif: null,               // v8.10 GIF Sheet: { frames:[{data,duration}], frameW, frameH, name, cols, autoCols } — composited frames at logical-screen size
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
  draglab:   {},
  cutout:    {},
  upscale:   {},
  atlas:     {},
  normalmap: {},
  tiler:     {},
  palette:   {},
  gif:       {},
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
      <div class="field-label">Pixel Converter <span class="dim">(100% offline)</span></div><div class="row"><button type="button" class="btn-ghost" id="pxPick" style="text-align:center">Upload image</button><input type="file" id="pxFile" accept="image/*" hidden></div><div class="field-label">Output size</div><div class="px-dims" id="pxDims">
        ${[16, 32, 48, 64, 96, 128].map(s => `<button type="button" class="seg-btn${s === px.w ? " active" : ""}" data-px="${s}">${s}</button>`).join("")}
        <button type="button" class="seg-btn" id="pxOrigBtn" title="use the uploaded image's original dimensions">Original</button>
      </div><div class="row" style="margin-top:8px"><span class="dim">W</span><input type="number" class="num" id="pxW" min="8" max="1024" value="${px.w}"><span class="dim">H</span><input type="number" class="num" id="pxH" min="8" max="1024" value="${px.h}"></div><div class="field-label">Tile grid <span class="dim">(tilemap overlay)</span></div><div class="row"><label class="chk"><input type="checkbox" id="pxGrid"${px.grid ? " checked" : ""}> show grid</label><select id="pxTile" aria-label="tile size">${[8, 16, 24, 32, 48, 64].map(t => `<option value="${t}"${t === px.tile ? " selected" : ""}>${t}px tiles</option>`).join("")}</select><span class="dim" id="pxTileCount"></span></div><div class="field-label">Colors</div><div class="row"><select id="pxColors" class="grow">
          ${[[2, "2 colors"], [4, "4 colors"], [8, "8 colors"], [16, "16 colors"], [32, "32 colors"], [256, "256 colors"], [0, "Full color"]].map(([v, lbl]) => `<option value="${v}"${v === px.colors ? " selected" : ""}>${lbl}</option>`).join("")}
        </select></div><label class="chk"><input type="checkbox" id="pxDither"${px.dither ? " checked" : ""}> dithering <span class="dim">(Floyd&ndash;Steinberg)</span></label><div class="row" style="margin-top:8px"><span class="dim">preview</span><input type="range" id="pxScale" min="2" max="16" value="${px.scale}" class="grow" aria-label="preview scale"><span class="dim" id="pxScaleVal">&times;${px.scale}</span></div><button type="button" class="btn-ghost px-download" id="pxDownload">Export pixel art</button><div class="dim">Upload any image — it never leaves your browser.</div>`;
    wirePixelArt();
  } else if (cat === "slicer") {
    const sl = slState();
    box.innerHTML = `
      <div class="field-label">Sprite Slicer <span class="dim">(100% offline)</span></div><div class="row"><button type="button" class="btn-ghost" id="slPick" style="text-align:center">Upload sheet</button><input type="file" id="slFile" accept="image/*" hidden></div><div class="field-label">Mode</div><div class="seg" id="slModeSeg"><button type="button" class="seg-btn${sl.mode === "grid" ? " active" : ""}" data-mode="grid">Grid</button><button type="button" class="seg-btn${sl.mode === "auto" ? " active" : ""}" data-mode="auto">Auto-detect</button></div><div id="slGridRow"${sl.mode === "grid" ? "" : " hidden"}><div class="sl-row"><span class="dim">rows</span><input type="range" id="slRows" min="1" max="32" value="${sl.rows}" aria-label="grid rows"><span class="sl-val" id="slRowsVal">${sl.rows}</span></div><div class="sl-row"><span class="dim">cols</span><input type="range" id="slCols" min="1" max="32" value="${sl.cols}" aria-label="grid columns"><span class="sl-val" id="slColsVal">${sl.cols}</span></div><div class="sl-grid4"><label>margin<input type="number" class="num" id="slMargin" min="0" max="200" value="${sl.margin}"></label><label>padding<input type="number" class="num" id="slPad" min="0" max="200" value="${sl.pad}"></label><label>offset x<input type="number" class="num" id="slOx" min="0" max="500" value="${sl.ox}"></label><label>offset y<input type="number" class="num" id="slOy" min="0" max="500" value="${sl.oy}"></label></div></div><div class="sl-readout" id="slReadout">Upload a sheet to start</div><div class="field-label">Background <span class="dim">(treated as empty)</span></div><div class="seg cols4" id="slBgSeg">
        ${[["transparent", "Alpha"], ["black", "Black"], ["white", "White"], ["chroma", "Key"]].map(([v, lbl]) => `<button type="button" class="seg-btn${v === sl.bg ? " active" : ""}" data-bg="${v}">${lbl}</button>`).join("")}
      </div><label class="knock-row"><input type="checkbox" id="slKnockout"${sl.knockout ? " checked" : ""}> Knockout bg &rarr; transparent</label><div class="sl-pick-row"><button type="button" class="btn-ghost" id="slSelectAll">Select all</button><button type="button" class="btn-ghost" id="slClear">Clear</button><button type="button" class="btn-ghost" id="slReslice">Re-slice</button></div><div class="sl-hint">Click pieces in order &mdash; 1st = frame 1. Empty cells flagged.</div><div class="field-label">Playback</div><div class="row"><span class="dim">fps</span><select id="slFps">${[6, 8, 12, 24].map(f => `<option value="${f}"${f === sl.fps ? " selected" : ""}>${f} fps</option>`).join("")}</select></div><div class="seg" id="slPlaybackSeg" style="margin-top:8px">
        ${[["loop", "Loop"], ["once", "Once"], ["pingpong", "Ping-pong"]].map(([v, lbl]) => `<button type="button" class="seg-btn${v === sl.playback ? " active" : ""}" data-playback="${v}">${lbl}</button>`).join("")}
      </div><button type="button" class="btn-ghost sl-download" id="slDownload" disabled>Export animation <span class="dim">PNG + JSON</span></button><button type="button" class="btn-ghost sl-download" id="slCells" disabled>Export cells <span class="dim">individual PNGs</span></button><div class="dim">100% offline.</div>`;
    wireSlicer();
  } else if (cat === "draglab") {
    const D = dlState();
    box.innerHTML = `
      <div class="field-label">DragLab <span class="dim">(100% offline)</span></div>
      <p class="dim" style="margin:2px 0 8px">DragLab — pull any photo into shape. Click, drag, done. Runs 100% in your browser: no AI model, no uploads, no login.</p>
      <div class="seg" id="dlModeSeg" style="grid-template-columns:repeat(2,minmax(0,1fr))"><button type="button" class="seg-btn${D.mode === "points" ? " active" : ""}" data-dlmode="points">Points</button><button type="button" class="seg-btn${D.mode === "brush" ? " active" : ""}" data-dlmode="brush">Brush</button></div>
      <div class="row"><button type="button" class="btn-ghost" id="dlSample" style="text-align:center">Try the sample</button><button type="button" class="btn-ghost" id="dlPick" style="text-align:center">Upload photo</button><input type="file" id="dlFile" accept="image/*" hidden></div>
      <div id="dlPointsCtl"${D.mode === "brush" ? " hidden" : ""}>
        <div class="row" style="margin-top:8px"><button type="button" class="btn-ghost" id="dlUndo">Undo point</button><button type="button" class="btn-ghost" id="dlReset">Reset</button></div>
        <div class="dim" style="margin-top:8px">Click the photo to add a point, drag it to pull the picture. Right-click a point to remove it.</div>
      </div>
      <div id="dlBrushCtl"${D.mode === "brush" ? "" : " hidden"}>
        <div class="field-label">Liquify brush</div>
        <div class="seg cols4" id="dlBrushSeg">
          ${[["push", "Push"], ["pinch", "Pinch"], ["bloat", "Bloat"], ["twirl", "Twirl"]].map(([v, lbl]) => `<button type="button" class="seg-btn${v === D.brushKind ? " active" : ""}" data-brush="${v}">${lbl}</button>`).join("")}
        </div>
        <div class="sl-row"><span class="dim">size</span><input type="range" id="dlBrushSize" min="16" max="160" step="4" value="${D.brushSize}" aria-label="brush size"><span class="sl-val" id="dlBrushSizeVal">${D.brushSize}px</span></div>
        <div class="sl-row"><span class="dim">strength</span><input type="range" id="dlBrushStrength" min="0" max="100" value="${D.brushStrength}" aria-label="brush strength"><span class="sl-val" id="dlBrushStrengthVal">${D.brushStrength}%</span></div>
        <div class="row" style="margin-top:8px"><button type="button" class="btn-ghost" id="dlBrushUndo">Undo stroke</button><button type="button" class="btn-ghost" id="dlResetB">Reset</button></div>
        <div class="dim" style="margin-top:8px">Paint straight on the photo: push it along, pinch it in, bloat it out, twirl it round. Points and brush work stack — switch modes freely.</div>
      </div>
      <button type="button" class="btn-ghost dl-download" id="dlExport" disabled>Export PNG</button>`;
    wireDraglab();
  } else if (cat === "cutout") {
    const co = coState();
    box.innerHTML = `
      <div class="field-label">Cutout Lab <span class="dim">(AI, in your browser)</span></div>
      <p class="dim" style="margin:2px 0 8px">Cutout Lab — AI background removal that runs in your browser. The model downloads once (about 4.4 MB); your photos never leave your device. No uploads, no login.</p>
      <div class="row"><button type="button" class="btn-ghost" id="coSample" style="text-align:center">Try the sample</button><button type="button" class="btn-ghost" id="coPick" style="text-align:center">Upload photo</button><input type="file" id="coFile" accept="image/*" hidden></div>
      <button type="button" class="btn-ghost co-download" id="coRun">Remove background</button>
      <div class="field-label">Edge cleanup <span class="dim">(live — no re-run)</span></div>
      <div class="sl-row"><span class="dim">cut</span><input type="range" id="coThreshold" min="0" max="100" value="${co.threshold}" aria-label="background cut threshold"><span class="sl-val" id="coThresholdVal">${co.threshold}</span></div>
      <div class="sl-row"><span class="dim">feather</span><input type="range" id="coFeather" min="0" max="24" value="${co.feather}" aria-label="edge feather"><span class="sl-val" id="coFeatherVal">${co.feather}px</span></div>
      <button type="button" class="btn-ghost co-download" id="coExport" disabled>Export PNG</button>
      <div class="dim" style="margin-top:8px">Model: U-2-Net (u2netp) via the rembg project — Apache-2.0. Runs on your GPU when it can, CPU otherwise.</div>`;
    wireCutout();
  } else if (cat === "upscale") {
    const up = upState();
    box.innerHTML = `
      <div class="field-label">Upscale Lab <span class="dim">(AI, in your browser)</span></div>
      <p class="dim" style="margin:2px 0 8px">Upscale Lab — AI enlargement in your browser. Model downloads once (about 5 MB); photos never leave your device. For photos/art — pixel art stays crisp with the Pixel Converter instead.</p>
      <div class="row"><button type="button" class="btn-ghost" id="upSample" style="text-align:center">Try the sample</button><button type="button" class="btn-ghost" id="upPick" style="text-align:center">Upload image</button><input type="file" id="upFile" accept="image/*" hidden></div>
      <div class="field-label">Mode</div>
      <div class="seg" id="upModeSeg"><button type="button" class="seg-btn${up.mode === "ai" ? " active" : ""}" data-upmode="ai">AI &times;4</button><button type="button" class="seg-btn${up.mode === "pixel" ? " active" : ""}" data-upmode="pixel">Pixel</button></div>
      <div id="upAiRow"${up.mode === "ai" ? "" : " hidden"}>
        <button type="button" class="btn-ghost up-download" id="upRun">Upscale &times;4</button>
        <div class="row" style="margin-top:8px"><span class="dim">export size</span><select id="upExportScale" class="grow"><option value="4"${up.exportScale === 4 ? " selected" : ""}>&times;4 — full result</option><option value="2"${up.exportScale === 2 ? " selected" : ""}>&times;2 — half size</option></select></div>
      </div>
      <div id="upPixelRow"${up.mode === "pixel" ? "" : " hidden"}>
        <div class="row"><span class="dim">scale</span><select id="upPxScale">${[2, 3, 4].map(s => `<option value="${s}"${s === up.pxScale ? " selected" : ""}>&times;${s}</option>`).join("")}</select><span class="dim">filter</span><select id="upPxAlgo" class="grow"><option value="nearest"${up.pxAlgo === "nearest" ? " selected" : ""}>Nearest — crisp</option><option value="epx"${up.pxAlgo === "epx" ? " selected" : ""}>EPX — smooth</option></select></div>
        <button type="button" class="btn-ghost up-download" id="upPxApply">Enlarge</button>
        <div class="dim" style="margin-top:8px">Pixel mode is instant and 100% offline — no model. EPX works at &times;2 and &times;4.</div>
      </div>
      <button type="button" class="btn-ghost up-download" id="upExport" disabled>Export PNG</button>
      <div class="dim" style="margin-top:8px">Model: Real-ESRGAN (realesr-general-x4v3) — BSD-3-Clause. Runs on your GPU when it can, CPU otherwise.</div>`;
    wireUpscale();
  } else if (cat === "atlas") {
    const at = atState();
    box.innerHTML = `
      <div class="field-label">Atlas Packer <span class="dim">(100% offline)</span></div>
      <p class="dim" style="margin:2px 0 8px">Atlas Packer — turn loose frames into one game-ready sprite sheet. Runs 100% in your browser.</p>
      <div class="row"><button type="button" class="btn-ghost" id="atPick" style="text-align:center">Add images</button><input type="file" id="atFile" accept="image/*" multiple hidden><button type="button" class="btn-ghost" id="atClear">Clear</button></div>
      <div class="sl-row"><span class="dim">padding</span><input type="range" id="atPad" min="0" max="8" value="${at.pad}" aria-label="padding between sprites"><span class="sl-val" id="atPadVal">${at.pad}px</span></div>
      <label class="chk"><input type="checkbox" id="atExtrude"${at.extrude ? " checked" : ""}> extrude edges <span class="dim">(stops texture bleeding)</span></label>
      <label class="chk"><input type="checkbox" id="atPot"${at.pot ? " checked" : ""}> power-of-two size</label>
      <label class="chk"><input type="checkbox" id="atLabels"${at.labels ? " checked" : ""}> outline + names on preview</label>
      <button type="button" class="btn-ghost at-download" id="atPack">Pack</button>
      <div class="field-label">Manifest format</div>
      <div class="row"><select id="atFormat" class="grow"><option value="json"${at.format === "json" ? " selected" : ""}>JSON — TexturePacker hash</option><option value="unity"${at.format === "unity" ? " selected" : ""}>Unity — .tpsheet</option><option value="godot"${at.format === "godot" ? " selected" : ""}>Godot — .tpsheet</option></select></div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn-ghost" id="atExportPng" disabled>Export PNG</button><button type="button" class="btn-ghost" id="atExportManifest" disabled>Export manifest</button></div>
      <div class="dim" style="margin-top:8px">Identical frames are packed once and listed under every name in the manifest.</div>`;
    wireAtlas();
  } else if (cat === "normalmap") {
    const N = nmState();
    box.innerHTML = `
      <div class="field-label">Normal Map Lab <span class="dim">(100% offline)</span></div>
      <p class="dim" style="margin:2px 0 8px">Normal Map Lab — turn a flat sprite into a lit one. Normal, AO and specular maps in your browser; wrap-aware so textures stay seamless.</p>
      <div class="row"><button type="button" class="btn-ghost" id="nmSample" style="text-align:center">Try the sample</button><button type="button" class="btn-ghost" id="nmPick" style="text-align:center">Upload image</button><input type="file" id="nmFile" accept="image/*" hidden></div>
      <div class="field-label">Map</div>
      <div class="seg cols4" id="nmViewSeg">
        ${[["normal", "Normal"], ["lit", "Lit"], ["ao", "AO"], ["spec", "Spec"]].map(([v, lbl]) => `<button type="button" class="seg-btn${v === N.view ? " active" : ""}" data-nmview="${v}">${lbl}</button>`).join("")}
      </div>
      <div class="field-label">Height from</div>
      <div class="seg" id="nmHeightSeg" style="grid-template-columns:repeat(2,minmax(0,1fr))"><button type="button" class="seg-btn${N.alphaMode ? "" : " active"}" data-nmheight="lum">Brightness</button><button type="button" class="seg-btn${N.alphaMode ? " active" : ""}" data-nmheight="alpha">Alpha silhouette</button></div>
      <div class="sl-row"><span class="dim">strength</span><input type="range" id="nmStrength" min="0" max="200" value="${N.strength}" aria-label="normal strength"><span class="sl-val" id="nmStrengthVal">${N.strength}%</span></div>
      <div class="sl-row"><span class="dim">smooth</span><input type="range" id="nmSmooth" min="0" max="6" value="${N.smooth}" aria-label="height smoothing"><span class="sl-val" id="nmSmoothVal">${N.smooth}px</span></div>
      <label class="chk"><input type="checkbox" id="nmWrap"${N.wrap ? " checked" : ""}> wrap edges <span class="dim">(tileable textures stay seamless)</span></label>
      <div class="field-label">Green channel</div>
      <div class="seg" id="nmFlipSeg" style="grid-template-columns:repeat(2,minmax(0,1fr))"><button type="button" class="seg-btn${N.flipY ? "" : " active"}" data-nmflip="gl">OpenGL (Y+)</button><button type="button" class="seg-btn${N.flipY ? " active" : ""}" data-nmflip="dx">DirectX (Y&minus;)</button></div>
      <button type="button" class="btn-ghost nm-download" id="nmExport" disabled>Export PNG</button>
      <div class="dim" style="margin-top:8px">Unity and Godot both read the normal map directly; pick DirectX (Y&minus;) if your lighting looks upside-down.</div>`;
    wireNormalmap();
  } else if (cat === "tiler") {
    const T = tlState();
    box.innerHTML = `
      <div class="field-label">Seamless Tiler <span class="dim">(100% offline)</span></div>
      <p class="dim" style="margin:2px 0 8px">Seamless Tiler — make any texture repeat without visible seams. Best on organic and soft textures; hard geometric patterns will still show.</p>
      <div class="row"><button type="button" class="btn-ghost" id="tlSample" style="text-align:center">Try the sample</button><button type="button" class="btn-ghost" id="tlPick" style="text-align:center">Upload texture</button><input type="file" id="tlFile" accept="image/*" hidden></div>
      <div class="field-label">View</div>
      <div class="seg" id="tlViewSeg" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        ${[["single", "Single"], ["offset", "Offset"], ["grid", "3\u00D73"]].map(([v, lbl]) => `<button type="button" class="seg-btn${v === T.view ? " active" : ""}" data-tlview="${v}">${lbl}</button>`).join("")}
      </div>
      <div class="sl-row"><span class="dim">heal</span><input type="range" id="tlStrength" min="0" max="100" value="${T.strength}" aria-label="seam heal strength"><span class="sl-val" id="tlStrengthVal">${T.strength}%</span></div>
      <button type="button" class="btn-ghost tl-download" id="tlExport" disabled>Export PNG</button>
      <div class="dim" style="margin-top:8px">Offset shifts the texture by half, so the seams land in the middle where you can see them. Heal blends the edges together until the 3&times;3 preview repeats clean. Export is the healed texture at full size.</div>`;
    wireTiler();
  } else if (cat === "palette") {
    const P = plState();
    box.innerHTML = `
      <div class="field-label">Palette Lab <span class="dim">(100% offline)</span></div>
      <p class="dim" style="margin:2px 0 8px">Palette Lab — pull a sprite's colors out, swap them, spin off recolor variants for teams, tiers and skins. All in your browser.</p>
      <div class="row"><button type="button" class="btn-ghost" id="plSample" style="text-align:center">Try the sample</button><button type="button" class="btn-ghost" id="plPick" style="text-align:center">Upload sprite</button><input type="file" id="plFile" accept="image/*" hidden></div>
      <div class="field-label">Colors <span class="dim">(click one to pick it)</span></div>
      <div class="pl-swatches" id="plSwatches"><span class="dim">no sprite loaded yet</span></div>
      <div class="field-label">Swap</div>
      <div class="row"><span class="pl-fromchip" id="plFromChip"></span><span class="dim" id="plFromHex">pick a color above</span><span class="dim">&rarr;</span><input type="color" id="plTo" value="${P.toHex}" aria-label="swap to this color"><button type="button" class="btn-ghost" id="plApply">Apply swap</button></div>
      <div class="sl-row"><span class="dim">tolerance</span><input type="range" id="plTol" min="0" max="64" value="${P.tolerance}" aria-label="swap tolerance"><span class="sl-val" id="plTolVal">${P.tolerance}</span></div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn-ghost" id="plUndo">Undo</button></div>
      <div class="field-label">Variants <span class="dim">(palette hue spins)</span></div>
      <div class="pl-variants" id="plVariants"><span class="dim">load a sprite first</span></div>
      <button type="button" class="btn-ghost pl-download" id="plExport" disabled>Export PNG</button>
      <div class="row" style="margin-top:8px"><button type="button" class="btn-ghost" id="plGpl" disabled>Palette .gpl</button><button type="button" class="btn-ghost" id="plJson" disabled>Palette .json</button></div>
      <div class="dim" style="margin-top:8px">Transparent pixels are never touched. Tolerance feathers the swap at the edges, so anti-aliased outlines don't fringe.</div>`;
    wirePalette();
  } else if (cat === "gif") {
    const G = gfState();
    box.innerHTML = `
      <div class="field-label">GIF Sheet <span class="dim">(100% offline)</span></div>
      <p class="dim" style="margin:2px 0 8px">GIF Sheet — turn an animated GIF into a sprite sheet, frames and timings included. Decoded right in your browser; nothing is uploaded.</p>
      <div class="row"><button type="button" class="btn-ghost" id="gfSample" style="text-align:center">Try the sample</button><button type="button" class="btn-ghost" id="gfPick" style="text-align:center">Upload GIF</button><input type="file" id="gfFile" accept="image/gif,.gif" hidden></div>
      <div class="field-label">Sheet layout</div>
      <div class="row"><label class="dim"><input type="checkbox" id="gfAuto" ${G.autoCols ? "checked" : ""}> auto columns</label><span class="dim">columns</span><input type="number" class="num" id="gfCols" min="1" max="64" value="${G.cols}" ${G.autoCols ? "disabled" : ""}></div>
      <div class="dim" style="margin-top:4px">Auto lays the frames out near-square. The JSON export carries every frame's rect and duration in ms, ready for an engine.</div>
      <button type="button" class="btn-ghost gf-download" id="gfExport" disabled>Export PNG</button>
      <button type="button" class="btn-ghost" id="gfJson" style="width:100%;margin-top:8px;text-align:center" disabled>Export JSON manifest</button>`;
    wireGif();
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
    draglab: "not used — upload a photo instead",
    cutout: "not used — upload a photo instead",
    upscale: "not used — upload an image instead",
    atlas: "not used — drop images in instead",
    normalmap: "not used — drop an image in instead",
    tiler: "not used — drop a texture in instead",
    palette: "not used — drop a sprite in instead",
    gif: "not used — drop a GIF in instead",
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
  mpHealth(); /* warm the health cache — the skip below only ever reads
   * data that is already fresh; it never waits on this fetch */
  for (let i = 0; i < chain.length; i++) {
    const mid = chain[i];
    /* a Horde model with zero workers online cannot answer at all —
     * when fresh health data says so, skip it up front instead of
     * burning a queue wait on it */
    const hp = AI_PROVIDERS[mid];
    const hh = hp && hp.hordeModel ? mpCachedHealth(hp.hordeModel) : null;
    if (hh && hh.workers === 0) {
      lastErr = new Error(AI_MODEL_NAMES[mid] + " has no workers online right now");
      if (chain[i + 1]) {
        onStatus(`auto: ${AI_MODEL_NAMES[mid]} has no workers online — skipping to ${AI_MODEL_NAMES[chain[i + 1]]}…`);
        setStatusBar("warn");
      }
      continue;
    }
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
/* ===== Horde health board + favourite models (HUB roadmap Phase 5) =====
 * Health: GET https://aihorde.net/api/v2/status/models is public and
 * keyless — one entry per model: {name, count (workers online), queued,
 * eta (average wait, seconds)}. Cached for 60s; the model popup kicks a
 * refresh when it opens and re-renders its rows when data lands. No data
 * (or a failed fetch) renders nothing extra — the board never invents
 * numbers. Rows join to providers through AI_PROVIDERS[id].hordeModel. */
const MP_HEALTH = { at: 0, map: null, pending: false };
const MP_HEALTH_TTL = 60 * 1000;
function mpHealthMapFrom(list) {
  const map = {};
  if (!Array.isArray(list)) return map;
  list.forEach((m) => {
    if (!m || typeof m.name !== "string") return;
    map[m.name] = {
      workers: typeof m.count === "number" ? m.count : 0,
      eta: typeof m.eta === "number" ? m.eta : 0
    };
  });
  return map;
}
function mpCachedHealth(hordeModel) {
  if (!MP_HEALTH.map || Date.now() - MP_HEALTH.at > MP_HEALTH_TTL) return null;
  return MP_HEALTH.map[hordeModel] || null;
}
let mpRerender = null; // wireModelPicker sets this while its popup is open
function mpHealth() {
  if (MP_HEALTH.pending) return;
  if (MP_HEALTH.map && Date.now() - MP_HEALTH.at <= MP_HEALTH_TTL) return;
  MP_HEALTH.pending = true;
  fetch("https://aihorde.net/api/v2/status/models")
    .then((r) => { if (!r.ok) throw new Error("health HTTP " + r.status); return r.json(); })
    .then((list) => {
      MP_HEALTH.map = mpHealthMapFrom(list);
      MP_HEALTH.at = Date.now();
      if (mpOpenFor && mpRerender) mpRerender();
    })
    .catch(() => { MP_HEALTH.at = Date.now(); /* stay silent — the next open after the TTL retries */ })
    .finally(() => { MP_HEALTH.pending = false; });
}

/* Favourites: pinned provider ids, shared by both pickers (they render
 * through the same popup). Stored as a JSON array of ids in localStorage
 * under "m4ster.aiFavs"; every read is defensive, like the rest of the
 * file's storage reads. */
const AI_FAVS_KEY = "m4ster.aiFavs";
function aiFavsParse(json) {
  try {
    const v = JSON.parse(json || "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === "string");
  } catch (e) { return []; }
}
function aiFavsToggleIn(favs, id) {
  const out = favs.slice();
  const i = out.indexOf(id);
  if (i >= 0) out.splice(i, 1); else out.push(id);
  return out;
}
function aiFavsLoad() {
  try { return aiFavsParse(localStorage.getItem(AI_FAVS_KEY)); }
  catch (e) { return []; }
}
function aiFavsToggle(id) {
  const next = aiFavsToggleIn(aiFavsLoad(), id);
  try { localStorage.setItem(AI_FAVS_KEY, JSON.stringify(next)); } catch (e) {}
  return next;
}

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
  /* live Horde health rides along when fresh data exists — 3D provider
   * ids are not in AI_PROVIDERS, so their rows get null and render
   * exactly as before */
  const hprov = AI_PROVIDERS[opt.value];
  const health = hprov && hprov.hordeModel ? mpCachedHealth(hprov.hordeModel) : null;
  return { value: opt.value, name: name, source: source, desc: desc, chip: chip, health: health };
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
  /* pinned models get a Favourites section at the top — the same rows
   * also stay in their normal sections below */
  const favs = aiFavsLoad();
  if (favs.length) {
    const favRows = [];
    favs.forEach((id) => {
      let found = null;
      Array.prototype.forEach.call(sel.options, (opt) => { if (opt.value === id) found = opt; });
      if (found) favRows.push(mpParseOption(found, ""));
    });
    if (favRows.length) secs.unshift({ label: "★ Favourites", rows: favRows });
  }
  return secs;
}
let mpOpenFor = null; // { btn, sel } while the popup is open
function mpClose() {
  const pop = document.getElementById("mpPop");
  if (pop) pop.hidden = true;
  if (mpOpenFor) mpOpenFor.btn.setAttribute("aria-expanded", "false");
  mpOpenFor = null;
  mpRerender = null;
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
    const renderList = () => {
      const favs = aiFavsLoad();
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
          if (r.health) {
            const hs = document.createElement("span");
            hs.className = "mp-health";
            const dot = document.createElement("span");
            dot.className = "mp-dot " + (r.health.workers >= 3 ? "ok" : r.health.workers >= 1 ? "warn" : "off");
            hs.appendChild(dot);
            const htx = document.createElement("span");
            htx.textContent = (r.health.workers === 1 ? "1 worker" : r.health.workers + " workers") +
              " · " + (r.health.eta > 0 ? "~" + Math.round(r.health.eta) + "s wait" : "ready now");
            hs.appendChild(htx);
            nm.appendChild(hs);
          }
          main.appendChild(nm);
          if (r.desc) {
            const ds = document.createElement("span");
            ds.className = "mp-rdesc";
            ds.textContent = r.desc;
            main.appendChild(ds);
          }
          const star = document.createElement("span");
          const pinned = favs.indexOf(r.value) >= 0;
          star.className = "mp-star" + (pinned ? " on" : "");
          star.textContent = pinned ? "★" : "☆";
          star.setAttribute("role", "button");
          star.setAttribute("aria-pressed", String(pinned));
          star.setAttribute("aria-label", pinned ? "Unpin " + r.name + " from favourites" : "Pin " + r.name + " to favourites");
          star.title = pinned ? "Unpin from favourites" : "Pin to favourites";
          star.addEventListener("click", (ev) => {
            ev.stopPropagation(); /* a pin is not a pick: no select, no close */
            aiFavsToggle(r.value);
            renderList();
          });
          const ck = document.createElement("span");
          ck.className = "mp-check";
          ck.textContent = r.value === sel.value ? "✓" : "";
          row.appendChild(ic);
          row.appendChild(main);
          row.appendChild(star);
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
    };
    renderList();
    mpRerender = renderList;
    mpHealth(); /* opening the popup refreshes the health board; fresh data re-renders the rows */
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
  document.querySelectorAll(".generate").forEach(x => {
    x.disabled = b;
    if (x.dataset.label === undefined) x.dataset.label = x.textContent;
    x.textContent = b ? "GENERATING…" : x.dataset.label;
  });
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

/* perf: both preview loops draw into the same #preview canvas. An
 * IntersectionObserver parks whichever loop is live while the canvas is
 * covered by another mode or scrolled off-screen, and resumes it when it
 * comes back — the drawn frames themselves are unchanged. previewGen
 * keeps a parked loop's resume from reviving after the other loop (or a
 * restart of the same one) has taken over the canvas. */
let previewVisible = true, previewResume = null, previewGen = 0, previewWatching = false;
function watchPreviewCanvas(pc) {
  if (previewWatching || !pc || !("IntersectionObserver" in window)) return;
  previewWatching = true;
  new IntersectionObserver((entries) => {
    for (const e of entries) {
      previewVisible = e.isIntersecting;
      if (previewVisible && previewResume) { const r = previewResume; previewResume = null; r(); }
    }
  }).observe(pc);
}

function startPreview() {
  cancelAnimationFrame(previewRAF);
  cancelAnimationFrame(slicerRAF);
  const pvGen = ++previewGen;
  previewResume = null;
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
  /* perf: element refs resolved once per loop instead of DOM queries on
   * every tick */
  const fpsEl = $("#previewFps"), metaEl = $("#previewMeta");
  watchPreviewCanvas(pc);
  let last = performance.now();

  function tick(now) {
    if (!previewVisible) {   // covered / off-screen: park until the observer resumes us
      previewRAF = 0;
      previewResume = () => { if (pvGen === previewGen) tick(performance.now()); };
      return;
    }
    previewRAF = requestAnimationFrame(tick);
    const r = state.rows[previewRow];
    if (!r) return;
    const fps = +fpsEl.value || 8;
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
      metaEl.textContent = `· ${r.name} · 3×3 tile check`;
    } else {
      const s = Math.min(pc.width / f.width, pc.height / f.height, 8);
      const dw = Math.max(1, Math.round(f.width * s)), dh = Math.max(1, Math.round(f.height * s));
      pctx.save();
      if (state.flipX) { pctx.translate(pc.width, 0); pctx.scale(-1, 1); }
      pctx.drawImage(f, (pc.width - dw) / 2, (pc.height - dh) / 2, dw, dh);
      pctx.restore();
      metaEl.textContent = `· ${r.name} · frame ${previewT + 1}/${r.order.length}`;
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
  if (godotBtn) godotBtn.onclick = () => { downloadGodotPack().catch(e => stageMsg("Godot export failed: " + humanErr(e), true)); };
  const unityBtn = $("#dlUnity");
  if (unityBtn) unityBtn.onclick = () => { downloadUnityPack().catch(e => stageMsg("Unity export failed: " + humanErr(e), true)); };
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

const MESH_README = `m4ster FrameLab — mesh import guide
====================================

What you downloaded
-------------------
Your mesh comes out of the 3D studio as a GLB (glTF binary) — one file
with the geometry, materials and textures embedded. From the viewer you
can also re-export the loaded mesh as OBJ or FBX:

- GLB   the full package. Textures travel inside the file. This is the
        one to keep and the one every engine below reads directly.
- OBJ   geometry-first: vertices, normals, UVs. No embedded textures —
        treat it as the shape, and texture it in your engine.
- FBX   geometry + vertex color, re-exported from the loaded mesh.
        Handy for tools that prefer FBX; for textures, GLB still wins.

Start from the GLB unless a tool in your pipeline insists otherwise.

Unity (2022.2 or newer)
-----------------------
1. Drag the .glb straight into your project's Assets folder — Unity
   imports glTF natively and builds the materials for you.
2. Drag the imported model into the scene.
3. If it arrives huge or tiny, select the import in the Project view
   and set its scale on the Model tab, or scale the scene object —
   generated meshes do not share one fixed real-world size.
Older Unity versions: import a free glTF importer package, or open the
GLB in Blender and export FBX.

Unreal Engine
-------------
1. In the Content Browser: Import, and pick the .glb. The built-in
   glTF importer brings geometry and PBR materials across.
2. Leave "Import Uniform Scale" at 1 first and check the mesh in the
   viewport; adjust the scale on the import dialog or the actor if the
   proportions look off against your level.
3. Textures land as regular Texture2D assets next to the mesh.

Godot 4
-------
1. Copy the .glb into your project folder (in the FileSystem dock or
   on disk). Godot imports it automatically as a scene.
2. Drag the imported scene into your tree — it arrives as a node with
   the mesh and materials ready.
3. Rescale the node if needed; Godot's unit is the metre, generated
   meshes are not guaranteed to be true to it.

Blender
-------
1. File > Import > glTF 2.0 (.glb/.gltf), pick the file.
2. Geometry, materials and textures come across intact — the cleanest
   place to clean up, retopologise or re-export to anything else
   (FBX for older engines, for example).

Scale and orientation
---------------------
glTF is Y-up and right-handed, and every engine above converts on
import, so the model should stand upright with no work from you. Two
things genuinely vary between generated meshes:

- Absolute size. One model's "1 unit" is not another's. Check the
  bounding box against a known reference (a 2 m doorway, a character)
  and set the import scale once.
- Pivot. The origin sits wherever the generator centred the shape,
  usually the middle of the model. If a game object needs its feet on
  the ground, offset it in the engine or move the origin in Blender.

Textures
--------
GLB carries its PBR textures inside the file — base color, and where
the model produced them, normal / roughness / metallic maps. They
import with the mesh everywhere above; there is nothing to relink.

One exception: meshes made by Hunyuan3D-2 Mini Turbo (including the
direct Text to 3D route) are SHAPE ONLY. That provider builds geometry
with no texture stage, so the mesh arrives as a plain surface in a
neutral material. That is expected, not a broken export — assign your
own materials, or vertex-paint it, and it is game-ready.

Troubleshooting
---------------
- Mesh imports but looks plain grey: it is a shape-only result (see
  above) or the engine skipped material import — re-import the GLB and
  keep the material options on.
- Mesh is enormous or microscopic: import scale — see Scale above.
- Mesh is dark or inside-out in the engine: open it in Blender, select
  all faces in Edit Mode, Mesh > Normals > Recalculate Outside, then
  re-export.
- A tool refuses the GLB: open it in Blender (it reads every GLB) and
  export FBX or OBJ from there.
- Textures exist but look soft: the provider generated them at its own
  fixed resolution — pick the Ultra 2K / 4K resolution in the studio
  before generating when the model supports it.
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
      stageMsg("FAILED: " + humanErr(e), true);
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
             : state.category === "slicer" ? "Sprite Slicer"
             : state.category === "draglab" ? "DragLab"
             : state.category === "cutout" ? "Cutout Lab"
             : state.category === "upscale" ? "Upscale Lab"
             : state.category === "atlas" ? "Atlas Packer"
             : state.category === "normalmap" ? "Normal Map Lab"
             : state.category === "tiler" ? "Seamless Tiler"
             : state.category === "palette" ? "Palette Lab"
             : state.category === "gif" ? "GIF Sheet" : null;
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

/* the pixel side panel shows whenever the Pixel Converter lane is
 * open: the two figures once an image is loaded, a hint line until
 * then (the same empty-state pattern the Slicer readout uses) */
function pxSyncSide() {
  const side = $("#pixelSide");
  if (!side) return;
  const on = state.category === "pixelart";
  const has = !!(state.pixelart && state.pixelart.src);
  side.hidden = !on;
  side.querySelectorAll(".px-fig").forEach(f => { f.hidden = !has; });
  const e = $("#pxEmpty");
  if (e) e.hidden = has;
}

function syncPixelMode() {
  const on = state.category === "pixelart";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-pixelart", on);
  if (stage) stage.classList.toggle("mode-pixelart", on);
  document.body.classList.toggle("mode-pixelart", on);
  pxSyncSide();
  syncToolChrome();
}

function pxRender() {
  const P = pxState();
  if (!P.src) { pxSyncSide(); return; }
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
  pxSyncSide();
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
  const pvGen = ++previewGen;
  previewResume = null;
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
  const metaEl = $("#previewMeta");
  watchPreviewCanvas(pc);
  /* perf: the frame array + max dims used to be rebuilt on EVERY rAF
   * tick (60x/sec to draw at 8fps). They only change when the selection
   * or the sliced pieces change, so cache them behind a cheap signature
   * check; fps/playback are plain fields and still read live each tick. */
  let cacheFr = null, cacheCw = 0, cacheCh = 0, cacheSel = null, cachePieces = null;
  function slicerFrames() {
    const selNow = S.selection;
    if (cacheFr && cachePieces === S.pieces && cacheSel.length === selNow.length
        && cacheSel.every((v, i) => v === selNow[i])) return cacheFr;
    cacheFr = selNow.map(j => S.pieces[j].canvas);
    cacheSel = selNow.slice();
    cachePieces = S.pieces;
    cacheCw = 0; cacheCh = 0;
    for (const f of cacheFr) { cacheCw = Math.max(cacheCw, f.width); cacheCh = Math.max(cacheCh, f.height); }
    return cacheFr;
  }
  let last = performance.now();
  function tick(now) {
    if (!previewVisible) {   // covered / off-screen: park until the observer resumes us
      slicerRAF = 0;
      previewResume = () => { if (pvGen === previewGen) tick(performance.now()); };
      return;
    }
    slicerRAF = requestAnimationFrame(tick);
    const fr = slicerFrames();
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
    const cw = cacheCw, ch = cacheCh;
    const sc = Math.min(pc.width / cw, pc.height / ch, 8);
    const dw = Math.max(1, Math.round(cw * sc)), dh = Math.max(1, Math.round(ch * sc));
    const ox = (pc.width - dw) / 2, oy = (pc.height - dh) / 2;
    pctx.clearRect(0, 0, pc.width, pc.height);
    const f = fr[slicerT];
    const fw = Math.max(1, Math.round(f.width * sc)), fh = Math.max(1, Math.round(f.height * sc));
    pctx.drawImage(f, ox + Math.round((dw - fw) / 2), oy + dh - fh, fw, fh);
    metaEl.textContent = `· slice · frame ${slicerT + 1}/${fr.length}`;
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

/* ================= v8.2: DragLab — point-drag photo warp =================
 * FrameLab's own warp tool: click a photo to drop points, drag them, and
 * the picture pulls along. The math is Moving Least Squares (similarity
 * flavour, Schaefer et al. 2006) — a classic image-deformation recipe,
 * implemented here from scratch. No model, no server, no upload: the
 * photo never leaves the visitor's browser. */

function dlState() {
  if (!state.draglab) {
    state.draglab = {
      src: null, srcCv: null, imgW: 0, imgH: 0, points: [], name: "photo",
      // v8.6 liquify brushes: mode picks which controls the panel shows;
      // brush is a coarse grid of forward offsets painted by the brushes
      // (null until the first dab); brushUndo holds per-stroke snapshots.
      mode: "points", brush: null, brushUndo: [],
      brushKind: "push", brushSize: 64, brushStrength: 60,
    };
  }
  return state.draglab;
}

function syncDraglabMode() {
  const on = state.category === "draglab";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-draglab", on);
  if (stage) stage.classList.toggle("mode-draglab", on);
  document.body.classList.toggle("mode-draglab", on);
  const sec = $("#draglab");
  if (sec) sec.hidden = !on;
  syncToolChrome();
}

/* Moving Least Squares, similarity flavour — as an inverse map.
 * For an OUTPUT pixel (x, y) this finds where it came from in the source.
 * Each point has a home (px, py) and a dragged-to spot (qx, qy); swapping
 * the two turns the forward deformation into a backward lookup, which is
 * what a renderer needs (no holes in the output). */
/* perf: the warp math below writes into caller-owned scratch arrays
 * instead of allocating a fresh [x, y] (and weights array) per grid node
 * — same arithmetic, same order, zero per-node garbage. */
let _dlW = [];                 // MLS weights scratch, grown to fit the point count
const _dlM = [0, 0];           // dlInvMap scratch: point-warp result
const _dlO = [0, 0];           // dlInvMap scratch: brush offset

function dlMapPoint(x, y, pts, out) {
  const n = pts.length;
  if (n === 0) { out[0] = x; out[1] = y; return; }
  if (n === 1) {
    // a single point can only translate the whole picture
    out[0] = x + pts[0].px - pts[0].qx; out[1] = y + pts[0].py - pts[0].qy; return;
  }
  // weights: closer points pull harder (1 / distance^2)
  if (_dlW.length < n) _dlW = new Array(n);
  const w = _dlW;
  let wSum = 0, pCx = 0, pCy = 0, qCx = 0, qCy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x - pts[i].qx, dy = y - pts[i].qy;
    const d2 = dx * dx + dy * dy;
    if (d2 < 0.01) { out[0] = pts[i].px; out[1] = pts[i].py; return; } // right on a point: exact home
    w[i] = 1 / d2;
    wSum += w[i];
    pCx += w[i] * pts[i].px; pCy += w[i] * pts[i].py;
    qCx += w[i] * pts[i].qx; qCy += w[i] * pts[i].qy;
  }
  pCx /= wSum; pCy /= wSum; qCx /= wSum; qCy /= wSum;
  // best-fit similarity (uniform scale + rotation) from the dragged
  // frame back to the home frame, in least-squares terms
  let mu = 0, a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const qx = pts[i].qx - qCx, qy = pts[i].qy - qCy;
    const px = pts[i].px - pCx, py = pts[i].py - pCy;
    mu += w[i] * (qx * qx + qy * qy);
    a += w[i] * (qx * px + qy * py);
    b += w[i] * (qx * py - qy * px);
  }
  if (mu < 1e-9) { out[0] = x + pCx - qCx; out[1] = y + pCy - qCy; return; } // all points stacked: translate
  a /= mu; b /= mu;
  const vx = x - qCx, vy = y - qCy;
  out[0] = pCx + a * vx - b * vy; out[1] = pCy + b * vx + a * vy;
}

/* bilinear sample of the source pixels at (sx, sy), written to od[o..o+3] */
function dlSample(sd, W, H, sx, sy, od, o) {
  if (sx < 0) sx = 0; else if (sx > W - 1) sx = W - 1;
  if (sy < 0) sy = 0; else if (sy > H - 1) sy = H - 1;
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const x1 = x0 + 1 < W ? x0 + 1 : x0;
  const y1 = y0 + 1 < H ? y0 + 1 : y0;
  const fx = sx - x0, fy = sy - y0;
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4;
  const i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
    const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
    od[o + c] = top * (1 - fy) + bot * fy;
  }
}

/* ================= v8.6: DragLab liquify brushes =================
 * A second way to push the SAME warp. Where points store a handful of
 * drag pairs for the MLS solve, the brushes paint a persistent grid of
 * small forward offsets (in photo pixels) on the renderer's own coarse
 * grid. dlInvMap below composes the two into ONE backward lookup, so
 * there is still exactly one render path — and points + brush strokes
 * happily stack on the same photo. */

/* the brush grid for the current photo, made on first use. Node (gx, gy)
 * sits at photo position (gx*step, gy*step) — the same nodes dlRenderWarp
 * evaluates — and (ox, oy) says how far that node's content has been
 * pushed. peak caches the largest offset so the renderer can skip the
 * warp entirely when nothing has been painted. */
function dlBrushGrid() {
  const D = dlState();
  if (!D.src) return null;
  const W = D.src.w, H = D.src.h;
  const step = Math.max(1, Math.round(Math.max(W, H) / 300));
  const gw = Math.floor(W / step) + 1, gh = Math.floor(H / step) + 1;
  if (D.brush && D.brush.step === step && D.brush.gw === gw && D.brush.gh === gh) return D.brush;
  D.brush = { step, gw, gh, ox: new Float32Array(gw * gh), oy: new Float32Array(gw * gh), peak: 0, ver: 0 };
  D.brushUndo = [];
  return D.brush;
}

/* bilinear read of the brush offsets at an arbitrary photo position,
 * written into out[0..1] (perf: no per-node allocation) */
function dlBrushOffsetAt(grid, x, y, out) {
  const gw = grid.gw, gh = grid.gh;
  if (gw < 2 || gh < 2) { out[0] = 0; out[1] = 0; return; }
  const gxf = x / grid.step, gyf = y / grid.step;
  const gx0 = Math.max(0, Math.min(Math.floor(gxf), gw - 2)), fx = gxf - gx0;
  const gy0 = Math.max(0, Math.min(Math.floor(gyf), gh - 2)), fy = gyf - gy0;
  const i00 = gy0 * gw + gx0, i10 = i00 + 1, i01 = i00 + gw, i11 = i01 + 1;
  out[0] = (grid.ox[i00] * (1 - fx) + grid.ox[i10] * fx) * (1 - fy)
         + (grid.ox[i01] * (1 - fx) + grid.ox[i11] * fx) * fy;
  out[1] = (grid.oy[i00] * (1 - fx) + grid.oy[i10] * fx) * (1 - fy)
         + (grid.oy[i01] * (1 - fx) + grid.oy[i11] * fx) * fy;
}

/* paint one brush dab into the grid. (dx, dy) is how far the pointer
 * travelled for this dab — only Push uses it. Every dab is weighted by a
 * cosine falloff: full strength at the centre, easing to exactly zero at
 * the rim, so strokes blend with no hard edge. strength runs 0..1. */
function dlBrushDab(grid, cx, cy, radius, strength, kind, dx, dy) {
  if (!grid || radius <= 0 || strength <= 0) return;
  const step = grid.step, gw = grid.gw, gh = grid.gh;
  const gxA = Math.max(0, Math.floor((cx - radius) / step)), gxB = Math.min(gw - 1, Math.ceil((cx + radius) / step));
  const gyA = Math.max(0, Math.floor((cy - radius) / step)), gyB = Math.min(gh - 1, Math.ceil((cy + radius) / step));
  let peak2 = grid.peak * grid.peak, touched = false;
  for (let gy = gyA; gy <= gyB; gy++) {
    for (let gx = gxA; gx <= gxB; gx++) {
      const vx = gx * step - cx, vy = gy * step - cy;
      const d = Math.hypot(vx, vy);
      if (d >= radius) continue;
      const f = (1 + Math.cos(Math.PI * d / radius)) / 2;
      let ax = 0, ay = 0;
      if (kind === "push") {           // content follows the stroke
        ax = dx * strength * f; ay = dy * strength * f;
      } else if (kind === "pinch") {   // content pulled toward the centre
        ax = -vx * 0.3 * strength * f; ay = -vy * 0.3 * strength * f;
      } else if (kind === "bloat") {   // content pushed away from the centre
        ax = vx * 0.3 * strength * f; ay = vy * 0.3 * strength * f;
      } else if (kind === "twirl") {   // content rotated around the centre
        ax = -vy * 0.25 * strength * f; ay = vx * 0.25 * strength * f;
      }
      if (!ax && !ay) continue;
      const i = gy * gw + gx;
      grid.ox[i] += ax; grid.oy[i] += ay;
      touched = true;
      /* perf: squared-distance pre-check — sqrt only for a node that can
       * actually beat the peak (peak is only ever a > 0 gate, so this is
       * the same decision Math.hypot would make) */
      const m2 = grid.ox[i] * grid.ox[i] + grid.oy[i] * grid.oy[i];
      if (m2 > peak2) { grid.peak = Math.sqrt(m2); peak2 = m2; }
    }
  }
  if (touched) grid.ver++;   // warp-cache signature: brush contents changed
}

/* stroke snapshots for Undo: the grid is small (a few hundred nodes a
 * side at most), so a plain copy per stroke is cheap */
function dlBrushSnap(grid) {
  return { ox: grid.ox.slice(), oy: grid.oy.slice(), peak: grid.peak };
}
function dlBrushRestore(grid, snap) {
  grid.ox.set(snap.ox); grid.oy.set(snap.oy); grid.peak = snap.peak;
  grid.ver++;   // contents changed under the same grid object
}

/* THE backward lookup the renderer uses: first the point warp (MLS),
 * then the brush field — a dab moved content from home to home+offset,
 * so the lookup steps back by the offset painted at the spot the point
 * warp landed on. With no brush painted this is dlMapPoint untouched. */
function dlInvMap(x, y, pts, brush, out) {
  dlMapPoint(x, y, pts, _dlM);
  if (!brush || brush.peak <= 0) { out[0] = _dlM[0]; out[1] = _dlM[1]; return; }
  dlBrushOffsetAt(brush, _dlM[0], _dlM[1], _dlO);
  out[0] = _dlM[0] - _dlO[0]; out[1] = _dlM[1] - _dlO[1];
}

/* perf: warp scratch buffers (grid maps + output ImageData), allocated
 * once per (W, H, step) and reused every render — every byte is fully
 * rewritten on each pass, so reuse changes nothing in the output. */
let _dlWarpBuf = null;

function dlWarpBuffers(ctx, W, H, step, gw, gh) {
  if (_dlWarpBuf && _dlWarpBuf.w === W && _dlWarpBuf.h === H && _dlWarpBuf.step === step) return _dlWarpBuf;
  _dlWarpBuf = {
    w: W, h: H, step,
    mapX: new Float32Array(gw * gh), mapY: new Float32Array(gw * gh),
    img: ctx.createImageData(W, H),
  };
  return _dlWarpBuf;
}

/* draw the warped photo into ctx (points are NOT drawn here, so Export
 * reuses this as-is). The backward map is evaluated on a coarse grid and
 * interpolated — per-pixel MLS at full size would drag too slowly. */
function dlRenderWarp(ctx) {
  const D = dlState();
  const src = D.src, pts = D.points;
  const W = src.w, H = src.h;
  const displaced = pts.some(p => p.qx !== p.px || p.qy !== p.py);
  const brushOn = !!(D.brush && D.brush.peak > 0);
  if ((!pts.length || !displaced) && !brushOn) { ctx.drawImage(D.srcCv, 0, 0); return; }
  const step = Math.max(1, Math.round(Math.max(W, H) / 300));
  const gw = Math.floor(W / step) + 1, gh = Math.floor(H / step) + 1;
  const buf = dlWarpBuffers(ctx, W, H, step, gw, gh);
  const mapX = buf.mapX, mapY = buf.mapY;
  const node = [0, 0];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      dlInvMap(gx * step, gy * step, pts, D.brush, node);
      mapX[gy * gw + gx] = node[0];
      mapY[gy * gw + gx] = node[1];
    }
  }
  const out = buf.img;
  const od = out.data, sd = src.data;
  for (let y = 0; y < H; y++) {
    const gyf = y / step;
    const gy0 = Math.min(Math.floor(gyf), gh - 2), fy = gyf - gy0;
    const row0 = gy0 * gw, row1 = row0 + gw;
    for (let x = 0; x < W; x++) {
      const gxf = x / step;
      const gx0 = Math.min(Math.floor(gxf), gw - 2), fx = gxf - gx0;
      const i00 = row0 + gx0, i10 = i00 + 1, i01 = row1 + gx0, i11 = i01 + 1;
      const sx = (mapX[i00] * (1 - fx) + mapX[i10] * fx) * (1 - fy)
               + (mapX[i01] * (1 - fx) + mapX[i11] * fx) * fy;
      const sy = (mapY[i00] * (1 - fx) + mapY[i10] * fx) * (1 - fy)
               + (mapY[i01] * (1 - fx) + mapY[i11] * fx) * fy;
      dlSample(sd, W, H, sx, sy, od, (y * W + x) * 4);
    }
  }
  ctx.putImageData(out, 0, 0);
}

/* perf: the theme accent (--violet) is read once and cached — the old
 * code paid a getComputedStyle on every single draw. Invalidated by a
 * data-theme MutationObserver, the same pattern the cursor trail uses. */
let _dlAccent = null;
function dlAccent() {
  if (_dlAccent) return _dlAccent;
  let accent = "#22c55e";
  try { accent = getComputedStyle(document.documentElement).getPropertyValue("--violet").trim() || accent; } catch (e) {}
  _dlAccent = accent;
  return accent;
}
try {
  new MutationObserver(() => { _dlAccent = null; })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
} catch (e) {}

/* numbered dots over the photo; a dragged point keeps a tether + ghost
 * at its home spot so the pull reads clearly */
function dlDrawPoints(ctx) {
  const D = dlState();
  const accent = dlAccent();
  const s = Math.max(6, Math.min(D.src.w, D.src.h) / 58);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  D.points.forEach((p, i) => {
    if (p.qx !== p.px || p.qy !== p.py) {
      ctx.strokeStyle = accent; ctx.globalAlpha = 0.55;
      ctx.lineWidth = Math.max(1, s / 4);
      ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.qx, p.qy); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(255,255,255,.8)";
      ctx.beginPath(); ctx.arc(p.px, p.py, s * 0.35, 0, 7); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(p.qx, p.qy, s, 0, 7);
    ctx.fillStyle = accent; ctx.fill();
    ctx.lineWidth = Math.max(1.5, s / 3); ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "700 " + Math.round(s * 1.05) + "px system-ui, sans-serif";
    ctx.fillText(String(i + 1), p.qx, p.qy + 0.5);
  });
  ctx.restore();
}

/* the brush cursor: a plain ring at the current brush size, drawn over
 * the photo while the pointer hovers in Brush mode (the OS cursor is
 * hidden over the canvas then, so the ring IS the cursor) */
let dlHover = null;   // pointer position over the canvas, photo coords

function dlDrawBrushCursor(ctx) {
  const D = dlState();
  if (D.mode !== "brush" || !dlHover || !D.src) return;
  const accent = dlAccent();
  ctx.save();
  ctx.beginPath(); ctx.arc(dlHover.x, dlHover.y, D.brushSize, 0, 7);
  ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.lineWidth = 3.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(dlHover.x, dlHover.y, D.brushSize, 0, 7);
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

/* perf: warp bitmap cache. Rendering the warp is the expensive part of
 * a draw (inverse map + full resample); the points and brush ring on top
 * are cheap. The rendered warp is kept on an offscreen canvas keyed by a
 * signature of everything dlRenderWarp reads — the source photo, every
 * point's home/dragged coords, and the brush grid's contents version.
 * A draw whose signature matches just blits the cached bitmap, so a
 * Brush-mode hover (ring moves, warp inputs untouched) costs no warp. */
let _dlWarpCache = null;   // { cv, sig, src }

function dlWarpSig(D) {
  let sig = D.src.w + "x" + D.src.h + "|";
  for (let i = 0; i < D.points.length; i++) {
    const p = D.points[i];
    sig += p.px + "," + p.py + "," + p.qx + "," + p.qy + ";";
  }
  sig += "|" + (D.brush ? D.brush.ver + "/" + D.brush.peak : "-");
  return sig;
}

function dlDraw() {
  const D = dlState();
  const cv = $("#dlCanvas");
  if (!cv || !D.src) return;
  const ctx = cv.getContext("2d");
  const sig = dlWarpSig(D);
  if (!_dlWarpCache) _dlWarpCache = { cv: document.createElement("canvas"), sig: "", src: null };
  if (_dlWarpCache.sig !== sig || _dlWarpCache.src !== D.src) {
    const cc = _dlWarpCache.cv;
    if (cc.width !== D.src.w || cc.height !== D.src.h) { cc.width = D.src.w; cc.height = D.src.h; }
    dlRenderWarp(cc.getContext("2d"));
    _dlWarpCache.sig = sig;
    _dlWarpCache.src = D.src;
  }
  ctx.drawImage(_dlWarpCache.cv, 0, 0);
  dlDrawPoints(ctx);
  dlDrawBrushCursor(ctx);
  const ro = $("#dlReadout");
  if (ro) {
    let tail;
    if (D.mode === "brush") {
      const kindName = D.brushKind.charAt(0).toUpperCase() + D.brushKind.slice(1);
      tail = " · brush: " + kindName
        + (D.brush && D.brush.peak > 0 ? " · liquified" : " · drag on the photo to paint")
        + (D.points.length ? " · " + D.points.length + (D.points.length === 1 ? " point" : " points") : "");
    } else {
      tail = D.points.length
        ? " · " + D.points.length + (D.points.length === 1 ? " point" : " points")
        : " · no points yet — click the photo";
      if (D.brush && D.brush.peak > 0) tail += " · liquified";
    }
    ro.textContent = D.name + " · " + D.src.w + " × " + D.src.h + tail;
  }
}

let dlDrawQueued = false;
function dlQueueDraw() {
  if (dlDrawQueued) return;
  dlDrawQueued = true;
  requestAnimationFrame(() => { dlDrawQueued = false; dlDraw(); });
}

/* the built-in test card: graph paper (so the warp is easy to see) plus
 * a big simple face to pull around — drawn in code, zero downloads */
function dlMakeSample() {
  const w = 480, h = 360;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const c = cv.getContext("2d");
  c.fillStyle = "#f6f2e4"; c.fillRect(0, 0, w, h);
  c.strokeStyle = "rgba(70,90,130,.20)"; c.lineWidth = 1;
  c.beginPath();
  for (let x = 0; x <= w; x += 24) { c.moveTo(x + .5, 0); c.lineTo(x + .5, h); }
  for (let y = 0; y <= h; y += 24) { c.moveTo(0, y + .5); c.lineTo(w, y + .5); }
  c.stroke();
  const cx = 240, cy = 186, r = 104;
  c.lineWidth = 5; c.strokeStyle = "#5b4632";
  // ears
  c.fillStyle = "#ffd9a0";
  c.beginPath(); c.arc(cx - r, cy + 4, 20, 0, 7); c.fill(); c.stroke();
  c.beginPath(); c.arc(cx + r, cy + 4, 20, 0, 7); c.fill(); c.stroke();
  // head
  c.beginPath(); c.arc(cx, cy, r, 0, 7); c.fill(); c.stroke();
  // hair cap
  c.fillStyle = "#8a5a24";
  c.beginPath(); c.arc(cx, cy - 4, r, Math.PI * 1.06, Math.PI * 1.94); c.closePath(); c.fill();
  // eyes
  [[cx - 38, cy - 14], [cx + 38, cy - 14]].forEach(([ex, ey]) => {
    c.fillStyle = "#fff";
    c.lineWidth = 3;
    c.beginPath(); c.arc(ex, ey, 15, 0, 7); c.fill(); c.stroke();
    c.fillStyle = "#33302a";
    c.beginPath(); c.arc(ex, ey, 6.5, 0, 7); c.fill();
    c.fillStyle = "#fff";
    c.beginPath(); c.arc(ex + 2, ey - 2, 2, 0, 7); c.fill();
  });
  // brows
  c.strokeStyle = "#5b4632"; c.lineWidth = 4; c.lineCap = "round";
  c.beginPath(); c.moveTo(cx - 52, cy - 40); c.lineTo(cx - 24, cy - 44); c.stroke();
  c.beginPath(); c.moveTo(cx + 24, cy - 44); c.lineTo(cx + 52, cy - 40); c.stroke();
  // nose + cheeks + smile
  c.lineWidth = 3.5;
  c.beginPath(); c.moveTo(cx, cy); c.quadraticCurveTo(cx + 6, cy + 10, cx - 2, cy + 16); c.stroke();
  c.fillStyle = "rgba(244,110,110,.45)";
  c.beginPath(); c.arc(cx - 56, cy + 30, 13, 0, 7); c.fill();
  c.beginPath(); c.arc(cx + 56, cy + 30, 13, 0, 7); c.fill();
  c.strokeStyle = "#5b4632"; c.lineWidth = 5;
  c.beginPath(); c.arc(cx, cy + 22, 44, Math.PI * 0.18, Math.PI * 0.82); c.stroke();
  c.fillStyle = "#5b4632";
  c.font = "700 19px system-ui, sans-serif";
  c.textAlign = "center";
  c.fillText("pull my cheeks!", cx, 338);
  return cv;
}

/* bring an image in (file, paste, drop or the sample) and make it the
 * working photo. Working size is capped at 640px on the long edge so
 * dragging stays smooth; the original dimensions are kept for the label. */
function dlLoadSource(img, name) {
  const D = dlState();
  const scale = Math.min(1, 640 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx2 = cv.getContext("2d", { willReadFrequently: true });
  cx2.drawImage(img, 0, 0, w, h);
  const id = cx2.getImageData(0, 0, w, h);
  D.src = { data: id.data, w, h };
  D.srcCv = cv;
  D.imgW = img.width; D.imgH = img.height;
  D.points = [];
  D.brush = null;          // the offset grid was painted for the old photo
  D.brushUndo = [];
  D.name = name || "photo";
  if (img.close) img.close();
  const view = $("#dlCanvas");
  if (view) { view.width = w; view.height = h; }
  const empty = $("#dlEmpty");
  if (empty) empty.hidden = true;
  const dlExp = $("#dlExport");
  if (dlExp) dlExp.disabled = false;
  dlDraw();
}

async function dlLoadFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    dlLoadSource(bmp, file.name || "photo");
  } catch (err) {
    const ro = $("#dlReadout");
    if (ro) ro.textContent = "couldn't read that image — try a PNG or JPG.";
  }
}

function dlExportPNG() {
  const D = dlState();
  if (!D.src) {
    const ro = $("#dlReadout");
    if (ro) ro.textContent = "Load a photo or the sample first.";
    return;
  }
  const cv = document.createElement("canvas");
  cv.width = D.src.w; cv.height = D.src.h;
  dlRenderWarp(cv.getContext("2d"));
  downloadCanvas(cv, "m4ster-draglab-" + D.src.w + "x" + D.src.h + ".png");
}

/* ---------------- DragLab wiring ---------------- */

let dlDrag = null;        // index of the point being dragged, or null
let dlStroke = null;      // brush stroke in flight: { x, y } last dab spot
let dlStaticWired = false;

/* walk a brush stroke from its last spot to (x, y), stamping dabs about
 * a quarter radius apart so fast strokes stay smooth instead of dotted.
 * Push dabs carry the per-step pointer travel; the other brushes just
 * stamp at each step. */
function dlBrushStrokeTo(x, y) {
  const D = dlState();
  const grid = dlBrushGrid();
  if (!grid || !dlStroke) return;
  const strength = D.brushStrength / 100;
  const dx = x - dlStroke.x, dy = y - dlStroke.y;
  const dist = Math.hypot(dx, dy);
  const spacing = Math.max(2, D.brushSize * 0.25);
  const n = Math.max(1, Math.ceil(dist / spacing));
  for (let i = 1; i <= n; i++) {
    dlBrushDab(grid, dlStroke.x + dx * i / n, dlStroke.y + dy * i / n,
      D.brushSize, strength, D.brushKind, dx / n, dy / n);
  }
  dlStroke.x = x; dlStroke.y = y;
}

function dlCanvasPos(e) {
  const cv = $("#dlCanvas");
  const r = cv.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * cv.width / r.width,
    y: (e.clientY - r.top) * cv.height / r.height,
  };
}

function dlHitPoint(x, y) {
  const D = dlState();
  if (!D.src) return -1;
  const tol = Math.max(12, Math.min(D.src.w, D.src.h) / 26);
  let best = -1, bestD = tol;
  D.points.forEach((p, i) => {
    const d = Math.hypot(p.qx - x, p.qy - y);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function dlWireCanvas() {
  const cv = $("#dlCanvas");
  if (!cv) return;
  cv.addEventListener("pointerdown", (e) => {
    const D = dlState();
    if (!D.src || e.button === 2) return;
    const pos = dlCanvasPos(e);
    if (D.mode === "brush") {
      // a stroke starts: snapshot the grid for Undo (capped — the oldest
      // strokes fall off), stamp one dab so a plain click still paints
      // with Pinch/Bloat/Twirl, and remember where the stroke is
      const grid = dlBrushGrid();
      if (!grid) return;
      D.brushUndo.push(dlBrushSnap(grid));
      if (D.brushUndo.length > 20) D.brushUndo.shift();
      dlStroke = { x: pos.x, y: pos.y };
      dlBrushDab(grid, pos.x, pos.y, D.brushSize, D.brushStrength / 100, D.brushKind, 0, 0);
      dlHover = pos;
      try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      dlDraw();          // paint the first dab now (see the point note below)
      e.preventDefault();
      return;
    }
    let idx = dlHitPoint(pos.x, pos.y);
    const isNew = idx < 0;
    if (isNew) {
      D.points.push({ px: pos.x, py: pos.y, qx: pos.x, qy: pos.y });
      idx = D.points.length - 1;
    }
    dlDrag = idx;
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    // No long-press-to-remove: a press that pauses before moving (a user
    // thinking, a slow drag start, automation driving the page) must
    // never eat the point mid-gesture — that timer once killed every
    // slow drag before it started: the point vanished, the drag went
    // nowhere and the readout fell back to "no points yet". Points are
    // removed by right-click instead (see contextmenu below).
    dlDraw();          // paint the grabbed/new point now, even if rAF is throttled
    e.preventDefault();
  });
  cv.addEventListener("pointermove", (e) => {
    const D = dlState();
    if (D.mode === "brush") {
      // the ring cursor tracks the pointer even between strokes; during
      // a stroke the same moves stamp dabs along the way
      if (D.src) dlHover = dlCanvasPos(e);
      if (dlStroke && D.src) { dlBrushStrokeTo(dlHover.x, dlHover.y); dlQueueDraw(); }
      else if (D.src) dlQueueDraw();
      return;
    }
    if (dlDrag === null) return;
    const p = D.points[dlDrag];
    if (!p) { dlDrag = null; return; }
    const pos = dlCanvasPos(e);
    const mx = D.src.w / 4, my = D.src.h / 4; // a little room past the edges
    p.qx = Math.max(-mx, Math.min(D.src.w + mx, pos.x));
    p.qy = Math.max(-my, Math.min(D.src.h + my, pos.y));
    dlQueueDraw();
  });
  const endDrag = () => {
    const hadStroke = !!dlStroke;
    dlStroke = null;
    if (dlDrag === null && !hadStroke) return;
    dlDrag = null;
    dlDraw();          // final warp painted on release, rAF or no rAF
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);
  cv.addEventListener("pointerleave", () => {
    if (dlHover !== null) { dlHover = null; dlQueueDraw(); }
  });
  cv.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const D = dlState();
    if (!D.src || D.mode === "brush") return; // right-click deletes points in Points mode only
    const pos = dlCanvasPos(e);
    const idx = dlHitPoint(pos.x, pos.y);
    if (idx >= 0) { D.points.splice(idx, 1); dlQueueDraw(); }
  });
  // drag & drop onto the stage box
  const box = $("#dlStageBox");
  if (box) {
    ["dragenter", "dragover"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.add("dl-over");
    }));
    ["dragleave", "drop"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.remove("dl-over");
    }));
    box.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) dlLoadFile(f);
    });
  }
  // paste an image while the DragLab lane is open
  document.addEventListener("paste", (e) => {
    if (state.category !== "draglab") return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) { dlLoadFile(f); e.preventDefault(); }
        return;
      }
    }
  });
}

/* Reset is shared by both modes: points AND brush paint both clear —
 * Reset means "back to the photo I loaded", whichever tools touched it */
function dlResetAll() {
  const D = dlState();
  D.points = [];
  D.brush = null;
  D.brushUndo = [];
  dlQueueDraw();
}

/* keep the panel honest about the current mode: the right control block
 * visible, the right buttons lit, the canvas cursor matching */
function dlSyncBrushUI() {
  const D = dlState();
  const brush = D.mode === "brush";
  const pc = $("#dlPointsCtl"), bc = $("#dlBrushCtl");
  if (pc) pc.hidden = brush;
  if (bc) bc.hidden = !brush;
  document.querySelectorAll("#dlModeSeg .seg-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.dlmode === D.mode));
  document.querySelectorAll("#dlBrushSeg .seg-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.brush === D.brushKind));
  const size = $("#dlBrushSize"), sizeVal = $("#dlBrushSizeVal");
  if (size) { size.value = D.brushSize; if (sizeVal) sizeVal.textContent = D.brushSize + "px"; }
  const str = $("#dlBrushStrength"), strVal = $("#dlBrushStrengthVal");
  if (str) { str.value = D.brushStrength; if (strVal) strVal.textContent = D.brushStrength + "%"; }
  const cv = $("#dlCanvas");
  if (cv) cv.classList.toggle("dl-brush", brush);
  const hint = $("#dlStageHint");
  if (hint) hint.textContent = brush
    ? "Drag on the photo to liquify it — push, pinch, bloat or twirl."
    : "Click to add a point, drag it to pull the picture.";
}

function wireDraglab() {
  $("#dlSample").onclick = () => dlLoadSource(dlMakeSample(), "sample face");
  $("#dlPick").onclick = () => $("#dlFile").click();
  $("#dlFile").onchange = (e) => {
    dlLoadFile(e.target.files[0]);
    e.target.value = "";
  };
  $("#dlUndo").onclick = () => {
    const D = dlState();
    if (D.points.length) { D.points.pop(); dlQueueDraw(); }
  };
  $("#dlReset").onclick = dlResetAll;
  const resetB = $("#dlResetB");
  if (resetB) resetB.onclick = dlResetAll;
  $("#dlExport").onclick = dlExportPNG;
  $("#dlExport").disabled = !dlState().src;
  document.querySelectorAll("#dlModeSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      const D = dlState();
      if (D.mode === b.dataset.dlmode) return;
      D.mode = b.dataset.dlmode;   // switching modes never wipes the other mode's work
      dlSyncBrushUI();
      dlDraw();
    };
  });
  document.querySelectorAll("#dlBrushSeg .seg-btn").forEach(b => {
    b.onclick = () => { dlState().brushKind = b.dataset.brush; dlSyncBrushUI(); };
  });
  const size = $("#dlBrushSize");
  if (size) size.oninput = () => {
    const D = dlState();
    D.brushSize = +size.value;
    const v = $("#dlBrushSizeVal"); if (v) v.textContent = D.brushSize + "px";
    dlQueueDraw();   // the ring cursor resizes with the slider
  };
  const str = $("#dlBrushStrength");
  if (str) str.oninput = () => {
    const D = dlState();
    D.brushStrength = +str.value;
    const v = $("#dlBrushStrengthVal"); if (v) v.textContent = D.brushStrength + "%";
  };
  const undoStroke = $("#dlBrushUndo");
  if (undoStroke) undoStroke.onclick = () => {
    const D = dlState();
    const snap = D.brushUndo.pop();
    if (snap && D.brush) { dlBrushRestore(D.brush, snap); dlQueueDraw(); }
  };
  if (!dlStaticWired) {
    dlStaticWired = true;
    dlWireCanvas();
  }
  dlSyncBrushUI();
  syncDraglabMode();
}

/* ================= v8.3: shared in-browser AI runtime =================
 * One lazy loader for onnxruntime-web (MIT) plus a session factory, so
 * every AI lane (Cutout Lab today, the AI Upscaler next) rides the same
 * plumbing. The runtime script comes from the jsDelivr CDN and is only
 * fetched the first time an AI tool actually runs — the normal page load
 * never pays for it. Sessions live in a Web Worker so a heavy model can
 * never freeze the page; if workers are unavailable the session is made
 * on the page thread instead. Model bytes are cached in Cache Storage
 * after the first download, so repeat runs skip the download entirely. */

const AI_ORT_SRC = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js";
const AI_ORT_DIR = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const AI_MODEL_CACHE = "framelab-ai-models-v1";

let aiOrtPromise = null;
function aiLoadOrt() {
  if (window.ort) return Promise.resolve(window.ort);
  if (aiOrtPromise) return aiOrtPromise;
  aiOrtPromise = new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = AI_ORT_SRC;
    tag.async = true;
    tag.onload = () => {
      if (window.ort) {
        try { window.ort.env.wasm.wasmPaths = AI_ORT_DIR; } catch (e) {}
        resolve(window.ort);
      } else {
        aiOrtPromise = null;
        reject(new Error("AI runtime arrived empty"));
      }
    };
    tag.onerror = () => {
      aiOrtPromise = null;
      reject(new Error("couldn't load the AI runtime — check your connection"));
    };
    document.head.appendChild(tag);
  });
  return aiOrtPromise;
}

/* fetch a model file once, then serve it from Cache Storage forever.
 * onProgress(fraction) fires during the network download only. */
async function aiFetchModel(modelUrl, onProgress) {
  try {
    const cache = await caches.open(AI_MODEL_CACHE);
    const hit = await cache.match(modelUrl);
    if (hit) {
      if (onProgress) onProgress(1);
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch (e) { /* no Cache Storage — plain fetch below */ }
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error("model download failed (HTTP " + res.status + ")");
  const total = parseInt(res.headers.get("Content-Length") || "0", 10);
  let bytes;
  if (res.body && typeof res.body.getReader === "function" && total > 0) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      got += part.value.length;
      if (onProgress) onProgress(Math.min(1, got / total));
    }
    bytes = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
    if (onProgress) onProgress(1);
  }
  try {
    const cache = await caches.open(AI_MODEL_CACHE);
    await cache.put(modelUrl, new Response(bytes.slice()));
  } catch (e) { /* caching is a bonus, not a requirement */ }
  return bytes;
}

/* The inference worker's source, kept as a string so the site stays a
 * static file drop (no extra worker file to deploy). The worker owns the
 * ort sessions — one per model URL — and answers two messages:
 *   { type:"init", ortSrc, wasmDir, modelUrl, cacheName }
 *   { type:"run",  modelUrl, feeds:{ name:{ data, dims } } }
 * Download progress comes back as { type:"progress", value }. */
function aiWorkerSource() {
  return `
"use strict";
var sessions = {};
function fetchModel(url, cacheName, say) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(url).then(function (hit) {
      if (hit) {
        say(1);
        return hit.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
      }
      return fetch(url).then(function (res) {
        if (!res.ok) throw new Error("model download failed (HTTP " + res.status + ")");
        var total = parseInt(res.headers.get("Content-Length") || "0", 10);
        var store = function (bytes) {
          return cache.put(url, new Response(bytes.slice())).catch(function () {}).then(function () { return bytes; });
        };
        if (res.body && res.body.getReader && total > 0) {
          var reader = res.body.getReader();
          var chunks = [], got = 0;
          var pump = function () {
            return reader.read().then(function (part) {
              if (part.done) {
                var bytes = new Uint8Array(got), off = 0;
                chunks.forEach(function (c) { bytes.set(c, off); off += c.length; });
                return store(bytes);
              }
              chunks.push(part.value); got += part.value.length;
              say(Math.min(1, got / total));
              return pump();
            });
          };
          return pump();
        }
        return res.arrayBuffer().then(function (ab) { say(1); return store(new Uint8Array(ab)); });
      });
    });
  }).catch(function (err) {
    if (err && /model download failed/.test(err.message)) throw err;
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("model download failed (HTTP " + res.status + ")");
      return res.arrayBuffer().then(function (ab) { say(1); return new Uint8Array(ab); });
    });
  });
}
function makeSession(bytes) {
  var attempts = [];
  if (typeof navigator !== "undefined" && navigator.gpu) attempts.push(["webgpu", "wasm"]);
  attempts.push(["wasm"]);
  var chain = Promise.reject(new Error("no execution provider tried"));
  attempts.forEach(function (eps) {
    chain = chain.catch(function () {
      return ort.InferenceSession.create(bytes, { executionProviders: eps }).then(function (session) {
        return { session: session, backend: eps[0] === "webgpu" ? "WebGPU" : "CPU" };
      });
    });
  });
  return chain;
}
self.onmessage = function (e) {
  var msg = e.data;
  var fail = function (err) {
    postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  };
  if (msg.type === "init") {
    if (sessions[msg.modelUrl]) {
      var s0 = sessions[msg.modelUrl];
      postMessage({ id: msg.id, ok: true, backend: s0.backend, inputNames: s0.session.inputNames, outputNames: s0.session.outputNames });
      return;
    }
    importScripts(msg.ortSrc);
    try { ort.env.wasm.wasmPaths = msg.wasmDir; } catch (err) {}
    fetchModel(msg.modelUrl, msg.cacheName, function (v) {
      postMessage({ type: "progress", value: v, modelUrl: msg.modelUrl });
    }).then(makeSession).then(function (made) {
      sessions[msg.modelUrl] = made;
      postMessage({ id: msg.id, ok: true, backend: made.backend, inputNames: made.session.inputNames, outputNames: made.session.outputNames });
    }).catch(fail);
  } else if (msg.type === "run") {
    var entry = sessions[msg.modelUrl];
    if (!entry) { fail(new Error("AI session not ready")); return; }
    var feeds = {};
    Object.keys(msg.feeds).forEach(function (name) {
      var f = msg.feeds[name];
      feeds[name] = new ort.Tensor("float32", f.data, f.dims);
    });
    entry.session.run(feeds).then(function (out) {
      var results = {}, transfers = [];
      Object.keys(out).forEach(function (name) {
        results[name] = { data: out[name].data, dims: out[name].dims };
        if (out[name].data && out[name].data.buffer) transfers.push(out[name].data.buffer);
      });
      postMessage({ id: msg.id, ok: true, results: results }, transfers);
    }).catch(fail);
  }
};
`;
}

let aiWorkerState = null;
function aiBootWorker() {
  if (aiWorkerState) return aiWorkerState;
  const blob = new Blob([aiWorkerSource()], { type: "text/javascript" });
  const worker = new Worker(URL.createObjectURL(blob));
  const st = { worker, seq: 0, pending: new Map(), progressCbs: new Map() };
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "progress") {
      /* progress belongs to ONE model's download — route it to that
       * session's callback only, so overlapping loads (Cutout starting
       * while Upscale downloads) never steal each other's bar */
      const cb = msg.modelUrl ? st.progressCbs.get(msg.modelUrl) : null;
      if (cb) cb(msg.value);
      return;
    }
    const p = st.pending.get(msg.id);
    if (!p) return;
    st.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || "AI worker error"));
  };
  worker.onerror = () => {
    for (const p of st.pending.values()) p.reject(new Error("AI worker crashed"));
    st.pending.clear();
    if (aiWorkerState === st) aiWorkerState = null;
  };
  aiWorkerState = st;
  return st;
}

function aiWorkerSend(st, msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++st.seq;
    st.pending.set(id, { resolve, reject });
    st.worker.postMessage({ ...msg, id }, transfer || []);
  });
}

/* aiLoadSession(modelUrl, onProgress) → Promise<{
 *   backend, inputNames, outputNames,
 *   run(feeds) → Promise<{ name: { data, dims } }>
 * }>
 * Sessions are cached per model URL; a failed load is NOT cached, so the
 * next call retries cleanly. */
const aiSessions = {};
function aiLoadSession(modelUrl, onProgress) {
  if (aiSessions[modelUrl]) return aiSessions[modelUrl];
  const absUrl = new URL(modelUrl, location.href).href;
  const promise = (async () => {
    try {
      const st = aiBootWorker();
      if (onProgress) st.progressCbs.set(absUrl, onProgress);
      let ready;
      try {
        ready = await aiWorkerSend(st, {
          type: "init", ortSrc: AI_ORT_SRC, wasmDir: AI_ORT_DIR,
          modelUrl: absUrl, cacheName: AI_MODEL_CACHE,
        });
      } finally {
        if (onProgress && st.progressCbs.get(absUrl) === onProgress) st.progressCbs.delete(absUrl);
      }
      return {
        backend: ready.backend,
        inputNames: ready.inputNames,
        outputNames: ready.outputNames,
        run: (feeds) => {
          const transfers = [];
          for (const name of Object.keys(feeds)) {
            const d = feeds[name].data;
            if (d && d.buffer) transfers.push(d.buffer);
          }
          return aiWorkerSend(st, { type: "run", modelUrl: absUrl, feeds }, transfers)
            .then((res) => res.results);
        },
      };
    } catch (workerErr) {
      /* fallback: session on the page thread (no Worker support) */
      const ort = await aiLoadOrt();
      const bytes = await aiFetchModel(absUrl, onProgress);
      let session = null, backend = "CPU";
      const attempts = [];
      if (typeof navigator !== "undefined" && navigator.gpu) attempts.push(["webgpu", "wasm"]);
      attempts.push(["wasm"]);
      for (const eps of attempts) {
        try {
          session = await ort.InferenceSession.create(bytes, { executionProviders: eps });
          backend = eps[0] === "webgpu" ? "WebGPU" : "CPU";
          break;
        } catch (e) { session = null; }
      }
      if (!session) throw workerErr;
      return {
        backend,
        inputNames: session.inputNames,
        outputNames: session.outputNames,
        run: async (feeds) => {
          const tensors = {};
          for (const name of Object.keys(feeds)) {
            tensors[name] = new ort.Tensor("float32", feeds[name].data, feeds[name].dims);
          }
          const out = await session.run(tensors);
          const results = {};
          for (const name of Object.keys(out)) {
            results[name] = { data: out[name].data, dims: out[name].dims };
          }
          return results;
        },
      };
    }
  })();
  aiSessions[modelUrl] = promise;
  promise.catch(() => { delete aiSessions[modelUrl]; });
  return promise;
}

/* ================= v8.3: Cutout Lab — AI background removal =================
 * FrameLab's own cutout tool. A small AI segmentation model (u2netp from
 * the U-2-Net project, Apache-2.0, distributed via the rembg project)
 * runs entirely on the visitor's device through the shared AI runtime
 * above: the photo never leaves the browser, there is no server and no
 * login. Inference runs once per photo and caches a matte; the cut /
 * feather sliders then re-composite from that matte instantly, with no
 * further model runs. */

const CUTOUT_MODEL_URL = "assets/models/u2netp.onnx";
const CO_SIZE = 320; // the model's fixed input frame
const CO_MEAN = [0.485, 0.456, 0.406];
const CO_STD = [0.229, 0.224, 0.225];

function coState() {
  if (!state.cutout) {
    state.cutout = {
      src: null, srcCv: null, imgW: 0, imgH: 0, name: "photo",
      matte: null, threshold: 50, feather: 2, busy: false,
    };
  }
  return state.cutout;
}

function syncCutoutMode() {
  const on = state.category === "cutout";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-cutout", on);
  if (stage) stage.classList.toggle("mode-cutout", on);
  document.body.classList.toggle("mode-cutout", on);
  const sec = $("#cutout");
  if (sec) sec.hidden = !on;
  syncToolChrome();
}

/* build the model's input tensor from a 320×320 RGBA frame: CHW order,
 * 0..1 range, ImageNet normalization — the U-2-Net recipe. Pure math. */
function coBuildTensor(px) {
  const n = CO_SIZE * CO_SIZE;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * n + i] = (px[i * 4 + c] / 255 - CO_MEAN[c]) / CO_STD[c];
    }
  }
  return out;
}

/* the model returns several maps; the first is the fused saliency map.
 * Min-max normalize it into the full 0..255 range (the rembg recipe):
 * the map's own min becomes 0 and its max becomes 255, so even a faint
 * map spans the whole range before the cut / feather sliders threshold
 * it. A flat map (max == min) stays all-zero. The matte is carried in
 * 0..255 from here on. Pure math. */
function coNormalizeMatte(raw) {
  const out = new Float32Array(raw.length);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < mn) mn = raw[i];
    if (raw[i] > mx) mx = raw[i];
  }
  const range = mx - mn;
  if (!(range > 1e-6)) return out; // flat map — nothing stands out
  for (let i = 0; i < raw.length; i++) out[i] = ((raw[i] - mn) / range) * 255;
  return out;
}

/* apply a matte (one 0..255 value per pixel) to source pixels.
 * threshold (0..100) sets the cut point; feather (0..24) widens the
 * soft band around it. Returns fresh RGBA bytes — the source is never
 * modified. Pure math: the sliders re-run this on every input event
 * without touching the model. */
function coComposite(srcData, matte, threshold, feather) {
  const out = new Uint8ClampedArray(srcData);
  const t = threshold / 100;
  const soft = feather <= 0 ? 0 : 0.02 + (feather / 24) * 0.23;
  for (let i = 0; i < matte.length; i++) {
    const m = matte[i] / 255;
    let a;
    if (soft <= 0) {
      a = m >= t ? 1 : 0;
    } else {
      a = (m - t) / (2 * soft) + 0.5;
      if (a < 0) a = 0; else if (a > 1) a = 1;
    }
    out[i * 4 + 3] = Math.round(srcData[i * 4 + 3] * a);
  }
  return out;
}

/* stretch the 320×320 matte onto the working frame with canvas
 * smoothing — the bilinear pass doubles as a first edge softener */
function coUpsampleMatte(matte, w, h) {
  const small = document.createElement("canvas");
  small.width = CO_SIZE; small.height = CO_SIZE;
  const sctx = small.getContext("2d");
  const id = sctx.createImageData(CO_SIZE, CO_SIZE);
  for (let i = 0; i < matte.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(matte[i])));
    id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(id, 0, 0);
  const big = document.createElement("canvas");
  big.width = w; big.height = h;
  const bctx = big.getContext("2d", { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(small, 0, 0, w, h);
  const px = bctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4]; // stays 0..255
  return out;
}

function coStatus(msg) {
  const ro = $("#coReadout");
  if (ro) ro.textContent = msg;
}

function coDraw() {
  const C = coState();
  const cv = $("#coCanvas");
  if (!cv || !C.src) return;
  const ctx = cv.getContext("2d");
  if (!C.matte) {
    ctx.drawImage(C.srcCv, 0, 0);
    coStatus(C.name + " · " + C.src.w + " × " + C.src.h + " · ready — hit Remove background");
    return;
  }
  const out = coComposite(C.src.data, C.matte, C.threshold, C.feather);
  ctx.putImageData(new ImageData(out, C.src.w, C.src.h), 0, 0);
  coStatus(C.name + " · " + C.src.w + " × " + C.src.h + " · background removed — tune cut / feather, then Export PNG");
}

/* the built-in test card: a chunky robot on a simple scene — bold solid
 * shapes with hard edges, so the subject pops from the backdrop and the
 * cutout is easy to judge. Drawn in code, zero downloads. */
function coMakeSample() {
  const w = 480, h = 360;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const c = cv.getContext("2d");
  // sky, sun, hills, ground
  const sky = c.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#7db3e8"); sky.addColorStop(1, "#dceefb");
  c.fillStyle = sky; c.fillRect(0, 0, w, h);
  c.fillStyle = "#ffd94d";
  c.beginPath(); c.arc(410, 56, 29, 0, 7); c.fill();
  c.fillStyle = "#93cf72";
  c.beginPath(); c.arc(56, 388, 190, 0, 7); c.fill();
  c.beginPath(); c.arc(436, 400, 215, 0, 7); c.fill();
  c.fillStyle = "#79ba58"; c.fillRect(0, 320, w, 40);
  c.fillStyle = "#22303c";
  c.font = "700 20px system-ui, sans-serif";
  c.fillText("beep boop!", 24, 42);
  // robot — legs + feet
  c.fillStyle = "#3d4b5c";
  c.fillRect(208, 262, 24, 44); c.fillRect(248, 262, 24, 44);
  c.fillStyle = "#222a33";
  c.fillRect(200, 300, 40, 13); c.fillRect(240, 300, 40, 13);
  // arms + hands
  c.fillStyle = "#3d4b5c";
  c.fillRect(158, 172, 24, 74); c.fillRect(298, 172, 24, 74);
  c.fillStyle = "#f2b13d";
  c.beginPath(); c.arc(170, 254, 13, 0, 7); c.fill();
  c.beginPath(); c.arc(310, 254, 13, 0, 7); c.fill();
  // body + chest light
  c.fillStyle = "#e2543e"; c.fillRect(186, 164, 108, 104);
  c.fillStyle = "#ffd94d"; c.fillRect(214, 192, 52, 42);
  c.fillStyle = "#22303c"; c.fillRect(232, 206, 16, 14);
  // neck + head + antenna
  c.fillStyle = "#3d4b5c"; c.fillRect(227, 146, 26, 20);
  c.strokeStyle = "#22303c"; c.lineWidth = 5;
  c.beginPath(); c.moveTo(240, 62); c.lineTo(240, 82); c.stroke();
  c.fillStyle = "#e2543e";
  c.beginPath(); c.arc(240, 54, 9, 0, 7); c.fill();
  c.fillStyle = "#9fb4c7"; c.fillRect(188, 82, 104, 66);
  c.strokeRect(188, 82, 104, 66);
  c.strokeRect(186, 164, 108, 104);
  // eyes + mouth
  [[218, 110], [262, 110]].forEach(([ex, ey]) => {
    c.fillStyle = "#fff";
    c.beginPath(); c.arc(ex, ey, 11, 0, 7); c.fill();
    c.fillStyle = "#22303c";
    c.beginPath(); c.arc(ex, ey, 5, 0, 7); c.fill();
  });
  c.fillRect(222, 130, 36, 6);
  return cv;
}

/* bring an image in (file, paste, drop or the sample) and make it the
 * working photo. Working size is capped at 1024px on the long edge —
 * plenty for a matte composite, and the sliders stay instant. */
function coLoadSource(img, name) {
  const C = coState();
  const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx2 = cv.getContext("2d", { willReadFrequently: true });
  cx2.drawImage(img, 0, 0, w, h);
  const id = cx2.getImageData(0, 0, w, h);
  C.src = { data: id.data, w, h };
  C.srcCv = cv;
  C.imgW = img.width; C.imgH = img.height;
  C.matte = null;
  C.name = name || "photo";
  if (img.close) img.close();
  const view = $("#coCanvas");
  if (view) { view.width = w; view.height = h; }
  const empty = $("#coEmpty");
  if (empty) empty.hidden = true;
  const coExp = $("#coExport");
  if (coExp) coExp.disabled = true;
  coDraw();
}

async function coLoadFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    coLoadSource(bmp, file.name || "photo");
  } catch (err) {
    coStatus("couldn't read that image — try a PNG or JPG.");
  }
}

function coSetBusy(b) {
  const C = coState();
  C.busy = b;
  const run = $("#coRun");
  if (run) {
    run.disabled = b;
    run.textContent = b ? "Working…" : "Remove background";
  }
}

async function coRun() {
  const C = coState();
  if (!C.src) { coStatus("Load a photo or the sample first."); return; }
  if (C.busy) return;
  coSetBusy(true);
  try {
    coStatus("Downloading model once… (about 4.4 MB)");
    const session = await aiLoadSession(CUTOUT_MODEL_URL, (p) => {
      if (p < 1) coStatus("Downloading model once… " + Math.round(p * 100) + "%");
    });
    coStatus("Removing background… (" + session.backend + ")");
    /* the model eats a square 320×320 frame — the aspect squash is fine
     * for a saliency matte; it is stretched back onto the real frame */
    const small = document.createElement("canvas");
    small.width = CO_SIZE; small.height = CO_SIZE;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(C.srcCv, 0, 0, CO_SIZE, CO_SIZE);
    const tensor = coBuildTensor(sctx.getImageData(0, 0, CO_SIZE, CO_SIZE).data);
    const feeds = {};
    feeds[session.inputNames[0]] = { data: tensor, dims: [1, 3, CO_SIZE, CO_SIZE] };
    const results = await session.run(feeds);
    const raw = results[session.outputNames[0]];
    if (!raw || !raw.data) throw new Error("the model returned nothing");
    let matte = coNormalizeMatte(raw.data);
    if (matte.length === CO_SIZE * CO_SIZE) {
      matte = coUpsampleMatte(matte, C.src.w, C.src.h);
    }
    C.matte = matte;
    coDraw();
    const coExp2 = $("#coExport");
    if (coExp2) coExp2.disabled = false;
  } catch (err) {
    coStatus("Cutout failed: " + humanErr(err));
  }
  coSetBusy(false);
}

function coExportPNG() {
  const C = coState();
  if (!C.src) { coStatus("Load a photo or the sample first."); return; }
  if (!C.matte) { coStatus("Remove the background first."); return; }
  const cv = document.createElement("canvas");
  cv.width = C.src.w; cv.height = C.src.h;
  const out = coComposite(C.src.data, C.matte, C.threshold, C.feather);
  cv.getContext("2d").putImageData(new ImageData(out, C.src.w, C.src.h), 0, 0);
  downloadCanvas(cv, "m4ster-cutout-" + C.src.w + "x" + C.src.h + ".png");
}

/* ---------------- Cutout Lab wiring ---------------- */

let coStaticWired = false;

function coWireStage() {
  // drag & drop onto the stage box
  const box = $("#coStageBox");
  if (box) {
    ["dragenter", "dragover"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.add("co-over");
    }));
    ["dragleave", "drop"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.remove("co-over");
    }));
    box.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) coLoadFile(f);
    });
  }
  // paste an image while the Cutout lane is open
  document.addEventListener("paste", (e) => {
    if (state.category !== "cutout") return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) { coLoadFile(f); e.preventDefault(); }
        return;
      }
    }
  });
}

function wireCutout() {
  $("#coSample").onclick = () => coLoadSource(coMakeSample(), "sample robot");
  $("#coPick").onclick = () => $("#coFile").click();
  $("#coFile").onchange = (e) => {
    coLoadFile(e.target.files[0]);
    e.target.value = "";
  };
  $("#coRun").onclick = coRun;
  $("#coExport").onclick = coExportPNG;
  $("#coExport").disabled = !coState().matte;
  const th = $("#coThreshold"), fe = $("#coFeather");
  if (th) th.oninput = () => {
    const C = coState();
    C.threshold = +th.value;
    const v = $("#coThresholdVal");
    if (v) v.textContent = th.value;
    if (C.matte) coDraw();
  };
  if (fe) fe.oninput = () => {
    const C = coState();
    C.feather = +fe.value;
    const v = $("#coFeatherVal");
    if (v) v.textContent = fe.value + "px";
    if (C.matte) coDraw();
  };
  if (!coStaticWired) {
    coStaticWired = true;
    coWireStage();
  }
  syncCutoutMode();
}

/* ================= v8.4: Upscale Lab — AI enlargement =================
 * FrameLab's own upscaler. A compact super-resolution model
 * (realesr-general-x4v3 from the Real-ESRGAN project, BSD-3-Clause)
 * runs entirely on the visitor's device through the shared AI runtime
 * above: the image never leaves the browser, there is no server and no
 * login. The model eats a fixed 128×128 frame and returns 512×512, so
 * bigger images run as overlapping tiles whose outputs are blended
 * with a feathered running average — no visible seams. A non-AI Pixel
 * mode (nearest-neighbour plus a hand-rolled EPX filter) covers pixel
 * art, which AI upscalers only smear. */

const UPSCALE_MODEL_URL = "assets/models/realesr-x4v3.onnx";
const UP_TILE = 128;  // the model's fixed input frame
const UP_SCALE = 4;   // the model's fixed enlargement
const UP_HALO = 16;   // input px of neighbour context blended per tile
const UP_CAP = 1024;  // working cap on the long edge, same as Cutout

function upState() {
  if (!state.upscale) {
    state.upscale = {
      src: null, srcCv: null, imgW: 0, imgH: 0, name: "image",
      out: null, outKind: "", mode: "ai",
      pxScale: 2, pxAlgo: "nearest", exportScale: 4,
      compare: 50, busy: false, cancel: false,
    };
  }
  return state.upscale;
}

function syncUpscaleMode() {
  const on = state.category === "upscale";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-upscale", on);
  if (stage) stage.classList.toggle("mode-upscale", on);
  document.body.classList.toggle("mode-upscale", on);
  const sec = $("#upscale");
  if (sec) sec.hidden = !on;
  syncToolChrome();
}

/* ---- tiling math (pure) ----
 * Cores partition the image exactly; each tile's 128×128 window is its
 * core grown by UP_HALO of context on every side. Windows may start
 * negative or run past the far edge — extraction replicates the edge
 * pixels into the overhang. */
function upTilePlan(w, h) {
  const step = UP_TILE - 2 * UP_HALO;
  const tiles = [];
  for (let cy = 0; cy < h; cy += step) {
    for (let cx = 0; cx < w; cx += step) {
      tiles.push({
        cx, cy,
        cw: Math.min(step, w - cx), ch: Math.min(step, h - cy),
        sx: cx - UP_HALO, sy: cy - UP_HALO,
      });
    }
  }
  return tiles;
}

/* blend weight along one axis at source-space position g for a window
 * starting at `start`: 1 deep inside, ramping to 0 across 2×HALO at an
 * edge that has a neighbour; an edge on the image border keeps 1. */
function upAxisWeight(start, imgSize, g) {
  const F = 2 * UP_HALO;
  let a = 1;
  if (start > 0) a = Math.min(a, (g - start) / F);
  if (start + UP_TILE < imgSize) a = Math.min(a, (start + UP_TILE - g) / F);
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/* a tile's blend weight at one source-space point. Pure math. */
function upTileWeight(tile, w, h, gx, gy) {
  return upAxisWeight(tile.sx, w, gx) * upAxisWeight(tile.sy, h, gy);
}

/* the same weights sampled across one output tile (512 values per
 * axis) — the blend loop uses these instead of recomputing per pixel.
 * Identical values to upTileWeight by construction. Pure math. */
function upTileWeights1D(tile, w, h) {
  const OT = UP_TILE * UP_SCALE;
  const wx = new Float32Array(OT), wy = new Float32Array(OT);
  for (let o = 0; o < OT; o++) {
    wx[o] = upAxisWeight(tile.sx, w, tile.sx + o / UP_SCALE);
    wy[o] = upAxisWeight(tile.sy, h, tile.sy + o / UP_SCALE);
  }
  return { wx, wy };
}

function upClamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/* build the model's input tensor from a 128×128 RGBA frame: CHW
 * order, 0..1 range, no normalization — the Real-ESRGAN recipe. */
function upBuildTensor(px) {
  const n = UP_TILE * UP_TILE;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[c * n + i] = px[i * 4 + c] / 255;
  }
  return out;
}

/* replicate the valid rect's edge pixels over the rest of a square
 * tile buffer (the part of the window that hangs past the image).
 * Source pixels are only ever read from inside the valid rect, which
 * is never written — so one in-place pass is exact. Pure math. */
function upFillEdges(data, size, vx0, vy0, vw, vh) {
  const vx1 = vx0 + vw - 1, vy1 = vy0 + vh - 1;
  for (let y = 0; y < size; y++) {
    const sy = y < vy0 ? vy0 : y > vy1 ? vy1 : y;
    for (let x = 0; x < size; x++) {
      if (x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1) continue;
      const sx = x < vx0 ? vx0 : x > vx1 ? vx1 : x;
      const s = (sy * size + sx) * 4, d = (y * size + x) * 4;
      data[d] = data[s]; data[d + 1] = data[s + 1];
      data[d + 2] = data[s + 2]; data[d + 3] = data[s + 3];
    }
  }
}

/* EPX / Scale2×: every pixel becomes a 2×2 block; a corner borrows a
 * neighbour's colour when the two neighbours along that edge agree
 * and the opposite ones differ, which turns jagged diagonals into
 * smooth ones. Colour equality is on the packed RGBA value, edges
 * replicate. Hand-rolled — no library. Pure math. */
function upEpxPass(data, w, h) {
  const ow = w * 2;
  const out = new Uint8ClampedArray(ow * h * 2 * 4);
  const src = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const dst = new Uint32Array(out.buffer);
  const at = (x, y) => src[
    Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const P = at(x, y), A = at(x, y - 1), B = at(x - 1, y),
            C = at(x + 1, y), D = at(x, y + 1);
      const o = (y * 2) * ow + x * 2;
      dst[o]            = (B === A && B !== D && A !== C) ? A : P;
      dst[o + 1]        = (A === C && A !== B && C !== D) ? C : P;
      dst[o + ow]       = (B === D && B !== A && D !== C) ? B : P;
      dst[o + ow + 1]   = (D === C && D !== B && C !== A) ? C : P;
    }
  }
  return out;
}

/* ---- stage + drawing ---- */

function upStatus(msg) {
  const ro = $("#upReadout");
  if (ro) ro.textContent = msg;
}

function upProgress(frac) {
  const row = $("#upProgressRow"), bar = $("#upProgressBar");
  if (!row || !bar) return;
  if (frac === null || frac === undefined) {
    row.hidden = true;
    bar.style.width = "0%";
    return;
  }
  row.hidden = false;
  bar.style.width = Math.round(frac * 100) + "%";
}

function upDraw(note) {
  const U = upState();
  const cv = $("#upCanvas");
  if (!cv || !U.src) return;
  const ctx = cv.getContext("2d");
  if (!U.out) {
    if (cv.width !== U.src.w) cv.width = U.src.w;
    if (cv.height !== U.src.h) cv.height = U.src.h;
    ctx.drawImage(U.srcCv, 0, 0);
    const row0 = $("#upCompareRow");
    if (row0) row0.hidden = true;
    upStatus(U.name + " · " + U.src.w + " × " + U.src.h + " · ready — hit " +
      (U.mode === "ai" ? "Upscale ×4" : "Enlarge"));
    return;
  }
  const ow = U.out.width, oh = U.out.height;
  if (cv.width !== ow) cv.width = ow;
  if (cv.height !== oh) cv.height = oh;
  ctx.drawImage(U.out, 0, 0);
  /* before/after: the original covers the left `compare`% of the frame */
  const split = Math.round(ow * U.compare / 100);
  if (split > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, split, oh);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(U.srcCv, 0, 0, ow, oh);
    ctx.restore();
    if (split < ow) {
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.fillRect(split - 1, 0, 2, oh);
    }
  }
  const row = $("#upCompareRow");
  if (row) row.hidden = false;
  upStatus(U.name + " · " + U.src.w + " × " + U.src.h + " → " + ow + " × " + oh +
    (U.outKind === "ai" ? " · AI ×4" : " · pixel ×" + (ow / U.src.w)) +
    " — drag the slider to compare" + (note ? " · " + note : ""));
}

/* the sample: the Cutout robot card shrunk to a small photo first, so
 * the ×4 has visible work to do. Drawn in code, zero downloads. */
function upMakeSample() {
  const big = coMakeSample();
  const cv = document.createElement("canvas");
  cv.width = 192; cv.height = 144;
  const c = cv.getContext("2d");
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  c.drawImage(big, 0, 0, cv.width, cv.height);
  return cv;
}

/* bring an image in (file, paste, drop or the sample). Working size
 * is capped at 1024px on the long edge, same as Cutout Lab. */
function upLoadSource(img, name) {
  const U = upState();
  if (U.busy) return;
  const scale = Math.min(1, UP_CAP / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx2 = cv.getContext("2d", { willReadFrequently: true });
  cx2.drawImage(img, 0, 0, w, h);
  U.src = { w, h };
  U.srcCv = cv;
  U.imgW = img.width; U.imgH = img.height;
  U.out = null; U.outKind = "";
  U.name = name || "image";
  if (img.close) img.close();
  const view = $("#upCanvas");
  if (view) { view.width = w; view.height = h; }
  const empty = $("#upEmpty");
  if (empty) empty.hidden = true;
  const upExp = $("#upExport");
  if (upExp) upExp.disabled = true;
  upProgress(null);
  upDraw();
}

async function upLoadFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    upLoadSource(bmp, file.name || "image");
  } catch (err) {
    upStatus("couldn't read that image — try a PNG or JPG.");
  }
}

/* ---- AI run ---- */

function upSetBusy(b) {
  const U = upState();
  U.busy = b;
  const run = $("#upRun");
  if (run) run.textContent = b ? "Cancel" : "Upscale ×4";
}

/* draw one tile's 128×128 window out of the source into tctx; the
 * part of the window that hangs past the image is filled by
 * replicating the nearest edge pixels. */
function upExtractTile(U, tile, tctx) {
  const w = U.src.w, h = U.src.h;
  const dx0 = Math.max(0, -tile.sx), dy0 = Math.max(0, -tile.sy);
  const sx0 = Math.max(0, tile.sx), sy0 = Math.max(0, tile.sy);
  const vw = Math.min(UP_TILE - dx0, w - sx0), vh = Math.min(UP_TILE - dy0, h - sy0);
  tctx.clearRect(0, 0, UP_TILE, UP_TILE);
  tctx.drawImage(U.srcCv, sx0, sy0, vw, vh, dx0, dy0, vw, vh);
  if (dx0 > 0 || dy0 > 0 || vw < UP_TILE || vh < UP_TILE) {
    const id = tctx.getImageData(0, 0, UP_TILE, UP_TILE);
    upFillEdges(id.data, UP_TILE, dx0, dy0, vw, vh);
    tctx.putImageData(id, 0, 0);
  }
}

/* blend one finished output tile (CHW floats, 512×512) into the
 * result with the feathered running average:
 * out = (out·W + tile·a) / (W + a), W += a — every result pixel is a
 * convex mix of the tiles that cover it, so seams can't darken or
 * gap. Alpha is handled separately by the caller (the model is
 * RGB-only); px alpha bytes are left untouched here. */
function upBlendTile(px, wsum, ow, oh, tile, w, h, data) {
  const OT = UP_TILE * UP_SCALE;
  const n = OT * OT;
  const wts = upTileWeights1D(tile, w, h);
  const bx = tile.sx * UP_SCALE, by = tile.sy * UP_SCALE;
  const x0 = Math.max(0, bx), y0 = Math.max(0, by);
  const x1 = Math.min(ow, bx + OT), y1 = Math.min(oh, by + OT);
  for (let Y = y0; Y < y1; Y++) {
    const oy = Y - by;
    const wyv = wts.wy[oy];
    if (wyv <= 0) continue;
    for (let X = x0; X < x1; X++) {
      const a = wts.wx[X - bx] * wyv;
      if (a <= 0) continue;
      const i = Y * ow + X, j = i * 4, t = oy * OT + (X - bx);
      const W = wsum[i], nw = W + a;
      px[j]     = (px[j]     * W + upClamp01(data[t])         * 255 * a) / nw;
      px[j + 1] = (px[j + 1] * W + upClamp01(data[n + t])     * 255 * a) / nw;
      px[j + 2] = (px[j + 2] * W + upClamp01(data[2 * n + t]) * 255 * a) / nw;
      wsum[i] = nw;
    }
  }
}

async function upRun() {
  const U = upState();
  if (U.busy) { U.cancel = true; return; } // the run button doubles as Cancel
  if (!U.src) { upStatus("Load an image or the sample first."); return; }
  upSetBusy(true);
  U.cancel = false;
  try {
    upStatus("Downloading model once… (about 5 MB)");
    const session = await aiLoadSession(UPSCALE_MODEL_URL, (p) => {
      if (p < 1) upStatus("Downloading model once… " + Math.round(p * 100) + "%");
    });
    const w = U.src.w, h = U.src.h;
    const ow = w * UP_SCALE, oh = h * UP_SCALE;
    const plan = upTilePlan(w, h);
    const outCv = document.createElement("canvas");
    outCv.width = ow; outCv.height = oh;
    const octx = outCv.getContext("2d", { willReadFrequently: true });
    const id = octx.createImageData(ow, oh);
    const wsum = new Float32Array(ow * oh);
    /* the model is RGB-only — alpha rides a plain smooth ×4 pass */
    const aCv = document.createElement("canvas");
    aCv.width = ow; aCv.height = oh;
    const actx = aCv.getContext("2d", { willReadFrequently: true });
    actx.imageSmoothingEnabled = true;
    actx.imageSmoothingQuality = "high";
    actx.drawImage(U.srcCv, 0, 0, ow, oh);
    const aPx = actx.getImageData(0, 0, ow, oh).data;
    const tileCv = document.createElement("canvas");
    tileCv.width = UP_TILE; tileCv.height = UP_TILE;
    const tctx = tileCv.getContext("2d", { willReadFrequently: true });
    let doneTiles = 0;
    for (const tile of plan) {
      if (U.cancel) throw new Error("cancelled");
      upExtractTile(U, tile, tctx);
      const tensor = upBuildTensor(tctx.getImageData(0, 0, UP_TILE, UP_TILE).data);
      const feeds = {};
      feeds[session.inputNames[0]] = { data: tensor, dims: [1, 3, UP_TILE, UP_TILE] };
      const results = await session.run(feeds);
      const raw = results[session.outputNames[0]];
      if (!raw || !raw.data) throw new Error("the model returned nothing");
      upBlendTile(id.data, wsum, ow, oh, tile, w, h, raw.data);
      doneTiles++;
      upProgress(doneTiles / plan.length);
      upStatus("Upscaling… tile " + doneTiles + " of " + plan.length + " (" + session.backend + ")");
    }
    for (let i = 0; i < ow * oh; i++) id.data[i * 4 + 3] = aPx[i * 4 + 3];
    octx.putImageData(id, 0, 0);
    U.out = outCv;
    U.outKind = "ai";
    upProgress(null);
    upDraw();
    const upExp2 = $("#upExport");
    if (upExp2) upExp2.disabled = false;
  } catch (err) {
    upProgress(null);
    upStatus(err && err.message === "cancelled"
      ? "Upscale cancelled."
      : "Upscale failed: " + humanErr(err));
  }
  upSetBusy(false);
}

/* ---- Pixel mode run ---- */

function upPixelRun() {
  const U = upState();
  if (!U.src) { upStatus("Load an image or the sample first."); return; }
  const s = U.pxScale;
  let cv, note = "";
  if (U.pxAlgo === "epx" && (s === 2 || s === 4)) {
    const sctx = U.srcCv.getContext("2d", { willReadFrequently: true });
    let cur = sctx.getImageData(0, 0, U.src.w, U.src.h);
    const passes = s === 4 ? 2 : 1;
    for (let p = 0; p < passes; p++) {
      const out = upEpxPass(cur.data, cur.width, cur.height);
      cur = new ImageData(out, cur.width * 2, cur.height * 2);
    }
    cv = document.createElement("canvas");
    cv.width = cur.width; cv.height = cur.height;
    cv.getContext("2d").putImageData(cur, 0, 0);
  } else {
    if (U.pxAlgo === "epx") note = "EPX works at ×2 and ×4 — nearest used for ×3";
    cv = document.createElement("canvas");
    cv.width = U.src.w * s; cv.height = U.src.h * s;
    const c = cv.getContext("2d");
    c.imageSmoothingEnabled = false;
    c.drawImage(U.srcCv, 0, 0, cv.width, cv.height);
  }
  U.out = cv;
  U.outKind = "pixel";
  upDraw(note);
  const upExp3 = $("#upExport");
  if (upExp3) upExp3.disabled = false;
}

function upExportPNG() {
  const U = upState();
  if (U.busy) return;
  if (!U.out) { upStatus("Nothing to export yet — upscale something first."); return; }
  let cv = U.out;
  if (U.outKind === "ai" && U.exportScale === 2) {
    const half = document.createElement("canvas");
    half.width = Math.max(1, Math.round(cv.width / 2));
    half.height = Math.max(1, Math.round(cv.height / 2));
    const hc = half.getContext("2d");
    hc.imageSmoothingEnabled = true;
    hc.imageSmoothingQuality = "high";
    hc.drawImage(cv, 0, 0, half.width, half.height);
    cv = half;
  }
  downloadCanvas(cv, "m4ster-upscale-" + cv.width + "x" + cv.height + ".png");
}

/* ---------------- Upscale Lab wiring ---------------- */

let upStaticWired = false;

function upWireStage() {
  // drag & drop onto the stage box
  const box = $("#upStageBox");
  if (box) {
    ["dragenter", "dragover"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.add("up-over");
    }));
    ["dragleave", "drop"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.remove("up-over");
    }));
    box.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) upLoadFile(f);
    });
  }
  // paste an image while the Upscale lane is open
  document.addEventListener("paste", (e) => {
    if (state.category !== "upscale") return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) { upLoadFile(f); e.preventDefault(); }
        return;
      }
    }
  });
}

function wireUpscale() {
  $("#upSample").onclick = () => upLoadSource(upMakeSample(), "sample robot (small)");
  $("#upPick").onclick = () => $("#upFile").click();
  $("#upFile").onchange = (e) => {
    upLoadFile(e.target.files[0]);
    e.target.value = "";
  };
  $("#upRun").onclick = upRun;
  $("#upExport").onclick = upExportPNG;
  $("#upExport").disabled = !upState().out;
  $("#upPxApply").onclick = () => { if (!upState().busy) upPixelRun(); };
  document.querySelectorAll("#upModeSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      const U = upState();
      U.mode = b.dataset.upmode;
      document.querySelectorAll("#upModeSeg .seg-btn").forEach(x =>
        x.classList.toggle("active", x === b));
      const ai = $("#upAiRow"), px = $("#upPixelRow");
      if (ai) ai.hidden = U.mode !== "ai";
      if (px) px.hidden = U.mode !== "pixel";
      if (U.src && !U.out) upDraw();
    };
  });
  const es = $("#upExportScale");
  if (es) es.onchange = () => { upState().exportScale = +es.value; };
  const ps = $("#upPxScale");
  if (ps) ps.onchange = () => { upState().pxScale = +ps.value; };
  const pa = $("#upPxAlgo");
  if (pa) pa.onchange = () => { upState().pxAlgo = pa.value; };
  const cmp = $("#upCompare");
  if (cmp) cmp.oninput = () => {
    const U = upState();
    U.compare = +cmp.value;
    if (U.out) upDraw();
  };
  if (!upStaticWired) {
    upStaticWired = true;
    upWireStage();
  }
  if (upState().busy) upSetBusy(true);
  syncUpscaleMode();
}

/* ================= v8.5: Atlas Packer — loose frames → one sheet =================
 * The inverse of the Slicer: drop in many loose sprite images and get
 * back ONE packed atlas PNG plus an engine-ready manifest. Pure JS —
 * no models, no server, no login; everything runs in the visitor's
 * browser. Packing is a hand-rolled MaxRects packer. Sprites are
 * trimmed of their transparent borders before packing, and every
 * manifest format records the trim, so engines restore each original
 * frame exactly. Identical frames are packed once and listed under
 * every name they arrived with. */

const AT_PNG_NAME = "m4ster-atlas.png";

function atState() {
  if (!state.atlasPack) {
    state.atlasPack = {
      items: [],      // [{ name, cv, data }] — every image the user added
      packed: null,   // { canvas, frames, w, h, used } after a Pack
      pad: 2, extrude: true, pot: false, labels: false,
      format: "json",
    };
  }
  return state.atlasPack;
}

function syncAtlasMode() {
  const on = state.category === "atlas";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-atlas", on);
  if (stage) stage.classList.toggle("mode-atlas", on);
  document.body.classList.toggle("mode-atlas", on);
  const sec = $("#atlas");
  if (sec) sec.hidden = !on;
  syncToolChrome();
}

function atStatus(msg) {
  const ro = $("#atReadout");
  if (ro) ro.textContent = msg;
}

/* ---- pure helpers: hash, trim, power of two ---- */

/* a short stable hash of a pixel buffer (~2000 samples spread over
 * the whole image, seeded with the dimensions). Identical frames
 * hash the same, which is all dedupe needs — a freak collision would
 * merge two near-identical frames, never crash. */
function atPixelHash(data, w, h) {
  let h1 = 0x811c9dc5 ^ (w | 0), h2 = 0x01000193 ^ (h | 0);
  const step = Math.max(1, Math.floor(data.length / 2048));
  for (let i = 0; i < data.length; i += step) {
    h1 = Math.imul(h1 ^ data[i], 0x01000193);
    h2 = Math.imul(h2 + data[i], 0x85ebca6b);
  }
  return data.length + ":" + (h1 >>> 0).toString(36) + ":" + (h2 >>> 0).toString(36);
}

/* the bounding box of the non-transparent pixels of an RGBA buffer,
 * or null when the image is fully transparent. Pure math. */
function atTrimBox(data, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* smallest power of two >= n. Pure math. */
function atNextPot(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/* ---- MaxRects packing (pure) ----
 * Keep a list of free rectangles. Each sprite takes the free rect
 * with the least wasted area (best-area-fit; ties go to the tighter
 * short side), then every free rect it overlaps is split around it
 * and rects contained in others are pruned. Sprites pack as their
 * trimmed size plus padding on every side — the padding lives in the
 * footprint, never in the recorded frame rect. */

function atRectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/* is b fully inside a? */
function atRectContains(a, b) {
  return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
}

/* split free rect f around placed rect p: up to four leftovers. */
function atSplitFree(f, p) {
  const out = [];
  if (p.x > f.x) out.push({ x: f.x, y: f.y, w: p.x - f.x, h: f.h });
  if (p.x + p.w < f.x + f.w) out.push({ x: p.x + p.w, y: f.y, w: f.x + f.w - (p.x + p.w), h: f.h });
  if (p.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: p.y - f.y });
  if (p.y + p.h < f.y + f.h) out.push({ x: f.x, y: p.y + p.h, w: f.w, h: f.y + f.h - (p.y + p.h) });
  return out.filter(r => r.w > 0 && r.h > 0);
}

/* drop free rects that another free rect fully covers (an exact
 * duplicate counts as covered by its earlier twin). */
function atPruneFree(list) {
  return list.filter((f, i) => !list.some((g, j) => {
    if (i === j || !atRectContains(g, f)) return false;
    const ga = g.w * g.h, fa = f.w * f.h;
    return ga > fa || j < i;
  }));
}

/* place every rect, in the given order, into a binW × binH bin.
 * Returns the placements [{ x, y, w, h, ref }] or null when one
 * rect fits nowhere. */
function atTryPack(rects, binW, binH) {
  let free = [{ x: 0, y: 0, w: binW, h: binH }];
  const placed = [];
  for (const r of rects) {
    let best = null, bestWaste = Infinity, bestShort = Infinity;
    for (const f of free) {
      if (r.w > f.w || r.h > f.h) continue;
      const waste = f.w * f.h - r.w * r.h;
      const short = Math.min(f.w - r.w, f.h - r.h);
      if (waste < bestWaste || (waste === bestWaste && short < bestShort)) {
        best = f; bestWaste = waste; bestShort = short;
      }
    }
    if (!best) return null;
    const p = { x: best.x, y: best.y, w: r.w, h: r.h, ref: r.ref };
    placed.push(p);
    const next = [];
    for (const f of free) {
      if (!atRectsOverlap(f, p)) { next.push(f); continue; }
      for (const s of atSplitFree(f, p)) next.push(s);
    }
    free = atPruneFree(next);
  }
  return placed;
}

/* pack the unique sprites (tallest first). The bin starts near the
 * square root of the total area and doubles its shorter side until
 * everything fits; the result is then cropped to the used extent
 * (and rounded up to powers of two when `pot` is set — rounding only
 * ever grows the bin, so placements stay valid). */
function atPackUnique(uniques, pad, pot) {
  const rects = uniques.map(u => ({ w: u.tw + pad * 2, h: u.th + pad * 2, ref: u }));
  rects.sort((a, b) => b.h - a.h || b.w - a.w);
  let totalArea = 0, maxW = 0, maxH = 0;
  for (const r of rects) {
    totalArea += r.w * r.h;
    if (r.w > maxW) maxW = r.w;
    if (r.h > maxH) maxH = r.h;
  }
  const side = Math.max(16, Math.ceil(Math.sqrt(totalArea)));
  let binW = Math.max(side, maxW), binH = Math.max(side, maxH);
  let placed = null;
  for (let tries = 0; tries < 64 && !placed; tries++) {
    placed = atTryPack(rects, binW, binH);
    if (!placed) { if (binW <= binH) binW *= 2; else binH *= 2; }
  }
  if (!placed) return null;
  let usedW = 0, usedH = 0;
  for (const p of placed) {
    if (p.x + p.w > usedW) usedW = p.x + p.w;
    if (p.y + p.h > usedH) usedH = p.y + p.h;
  }
  return {
    placed,
    w: pot ? atNextPot(usedW) : usedW,
    h: pot ? atNextPot(usedH) : usedH,
  };
}

/* ---- stage drawing ---- */

/* paint the packed sheet onto a fresh canvas: each unique sprite
 * once, plus — when extrude is on and there is padding to hold it —
 * a 1px ring that repeats the sprite's edge pixels, so GPU filtering
 * at the frame border samples the sprite itself, not its neighbour.
 * The ring stays inside the sprite's padded footprint, which never
 * overlaps another sprite. */
function atRenderSheet(A) {
  const P = A.packed;
  const cv = document.createElement("canvas");
  cv.width = P.w; cv.height = P.h;
  const ctx = cv.getContext("2d");
  for (const fr of P.frames) {
    const u = fr.u, sx = u.trim.x, sy = u.trim.y;
    ctx.drawImage(u.cv, sx, sy, fr.w, fr.h, fr.x, fr.y, fr.w, fr.h);
    if (A.extrude && A.pad > 0) {
      const x = fr.x, y = fr.y, w = fr.w, h = fr.h;
      ctx.drawImage(u.cv, sx, sy, 1, h, x - 1, y, 1, h);                 // left column
      ctx.drawImage(u.cv, sx + w - 1, sy, 1, h, x + w, y, 1, h);         // right column
      ctx.drawImage(u.cv, sx, sy, w, 1, x, y - 1, w, 1);                 // top row
      ctx.drawImage(u.cv, sx, sy + h - 1, w, 1, x, y + h, w, 1);         // bottom row
      ctx.drawImage(u.cv, sx, sy, 1, 1, x - 1, y - 1, 1, 1);             // corners
      ctx.drawImage(u.cv, sx + w - 1, sy, 1, 1, x + w, y - 1, 1, 1);
      ctx.drawImage(u.cv, sx, sy + h - 1, 1, 1, x - 1, y + h, 1, 1);
      ctx.drawImage(u.cv, sx + w - 1, sy + h - 1, 1, 1, x + w, y + h, 1, 1);
    }
  }
  return cv;
}

function atDraw() {
  const A = atState();
  const view = $("#atCanvas");
  const empty = $("#atEmpty");
  if (!view) return;
  const ctx = view.getContext("2d");
  if (!A.items.length) {
    view.width = 480; view.height = 360;
    ctx.clearRect(0, 0, view.width, view.height);
    if (empty) empty.hidden = false;
    atStatus("");
    return;
  }
  if (empty) empty.hidden = true;
  if (!A.packed) {
    const first = A.items[0];
    view.width = first.cv.width; view.height = first.cv.height;
    ctx.drawImage(first.cv, 0, 0);
    atStatus(A.items.length + " sprite" + (A.items.length === 1 ? "" : "s") + " loaded — hit Pack.");
    return;
  }
  const P = A.packed;
  view.width = P.w; view.height = P.h;
  ctx.drawImage(P.canvas, 0, 0);
  if (A.labels) {
    /* preview-only overlay — the exported PNG stays clean */
    ctx.font = "10px sans-serif";
    for (const fr of P.frames) {
      ctx.strokeStyle = "rgba(255,255,255,.65)";
      ctx.lineWidth = 1;
      ctx.strokeRect(fr.x + .5, fr.y + .5, Math.max(0, fr.w - 1), Math.max(0, fr.h - 1));
      if (fr.w >= 28 && fr.h >= 14) {
        const label = fr.u.names[0];
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,.55)";
        ctx.fillRect(fr.x + 1, fr.y + 1, tw + 6, 13);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, fr.x + 4, fr.y + 11);
      }
    }
  }
  const pct = Math.round(P.used / (P.w * P.h) * 100);
  atStatus(A.items.length + " sprites · " + P.frames.length + " unique · atlas " +
    P.w + " × " + P.h + " · " + pct + "% filled" +
    (P.skipped ? " · " + P.skipped + " fully transparent, skipped" : ""));
}

/* ---- image intake ---- */

function atAddImage(img, name) {
  const A = atState();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const data = cx.getImageData(0, 0, cv.width, cv.height).data;
  A.items.push({ name: name || "image", cv, data });
  if (img.close) img.close();
  A.packed = null;
  const atExpP = $("#atExportPng"), atExpM = $("#atExportManifest");
  if (atExpP) atExpP.disabled = true;
  if (atExpM) atExpM.disabled = true;
  atDraw();
}

async function atLoadFiles(files) {
  const list = [...(files || [])].filter(f => !f.type || f.type.indexOf("image/") === 0);
  if (!list.length) return;
  let added = 0;
  for (const f of list) {
    try {
      const bmp = await createImageBitmap(f);
      atAddImage(bmp, (f.name || "image").replace(/\.[a-z0-9]+$/i, ""));
      added++;
    } catch (err) { /* one unreadable file — skip it, keep the rest */ }
  }
  if (added) atStatus(atState().items.length + " sprites loaded — hit Pack.");
  else atStatus("couldn't read those files — try PNG or JPG images.");
}

/* ---- the Pack action: trim, dedupe, pack, paint ---- */

function atPack() {
  const A = atState();
  if (!A.items.length) { atStatus("Add some images first."); return; }
  const byHash = new Map();
  const uniques = [];
  let skipped = 0;
  for (const it of A.items) {
    const hash = atPixelHash(it.data, it.cv.width, it.cv.height);
    const u0 = byHash.get(hash);
    if (u0) { u0.names.push(it.name); continue; }
    const trim = atTrimBox(it.data, it.cv.width, it.cv.height);
    if (!trim) { skipped++; continue; }
    const u = { cv: it.cv, trim, tw: trim.w, th: trim.h, names: [it.name] };
    byHash.set(hash, u);
    uniques.push(u);
  }
  if (!uniques.length) { atStatus("every image was fully transparent — nothing to pack."); return; }
  const res = atPackUnique(uniques, A.pad, A.pot);
  if (!res) { atStatus("packing failed — try fewer or smaller sprites."); return; }
  const frames = res.placed.map(p => ({
    u: p.ref, x: p.x + A.pad, y: p.y + A.pad, w: p.ref.tw, h: p.ref.th,
  }));
  const used = uniques.reduce((s, u) => s + u.tw * u.th, 0);
  A.packed = { canvas: null, frames, w: res.w, h: res.h, used, skipped };
  A.packed.canvas = atRenderSheet(A);
  atDraw();
  const atExpP2 = $("#atExportPng"), atExpM2 = $("#atExportManifest");
  if (atExpP2) atExpP2.disabled = false;
  if (atExpM2) atExpM2.disabled = false;
}

/* ---- manifests (pure string builders) ---- */

/* one entry per sprite NAME — duplicates share their packed rect,
 * and a name that arrives twice gets a " 2", " 3"… suffix so no
 * manifest entry can silently overwrite another. */
function atFrameList(A) {
  const out = [];
  const seen = new Map();
  for (const fr of A.packed.frames) {
    for (const name of fr.u.names) {
      const n = (seen.get(name) || 0) + 1;
      seen.set(name, n);
      out.push({ name: n === 1 ? name : name + " " + n, fr });
    }
  }
  return out;
}

/* TexturePacker JSON (hash format): frame rect + the trim record
 * (spriteSourceSize / sourceSize) engines use to restore the
 * original sprite. Frame keys carry the .png extension, TexturePacker
 * style. */
function atBuildJSON(A) {
  const frames = {};
  for (const e of atFrameList(A)) {
    const fr = e.fr, u = fr.u;
    frames[e.name + ".png"] = {
      frame: { x: fr.x, y: fr.y, w: fr.w, h: fr.h },
      rotated: false,
      trimmed: u.trim.x !== 0 || u.trim.y !== 0 || u.tw !== u.cv.width || u.th !== u.cv.height,
      spriteSourceSize: { x: u.trim.x, y: u.trim.y, w: u.tw, h: u.th },
      sourceSize: { w: u.cv.width, h: u.cv.height },
      pivot: { x: 0.5, y: 0.5 },
    };
  }
  return {
    frames,
    meta: {
      app: "m4ster FrameLab — Atlas Packer",
      version: "1.0",
      image: AT_PNG_NAME,
      format: "RGBA8888",
      size: { w: A.packed.w, h: A.packed.h },
      scale: "1",
    },
  };
}

/* .tpsheet (TexturePacker 40300) for the Unity and Godot importers.
 * Sprite line: name;x;y;w;h;pivotX;pivotY;0;0;0;0 — the pivot is a
 * normalised offset from the frame centre (±2 scale), computed so
 * the ORIGINAL untrimmed sprite's centre stays the pivot: trimming
 * shifts the pivot instead of losing it. */
function atTpsheet(A, godot) {
  const P = A.packed;
  const lines = [
    "#",
    "# Sprite sheet data for " + (godot ? "Godot" : "Unity") + " — packed by m4ster FrameLab (Atlas Packer).",
    "#",
    ":format=40300",
    ":texture=" + AT_PNG_NAME,
    ":size=" + P.w + "x" + P.h,
    ":pivotpoints=enabled",
    ":borders=disabled",
    "",
  ];
  for (const e of atFrameList(A)) {
    const fr = e.fr, u = fr.u;
    const px = ((u.cv.width / 2 - u.trim.x) - fr.w / 2) / fr.w * 2;
    const py = (((u.trim.y + fr.h) - u.cv.height / 2) - fr.h / 2) / fr.h * 2;
    lines.push([e.name, fr.x, fr.y, fr.w, fr.h,
      px.toFixed(6), py.toFixed(6), 0, 0, 0, 0].join(";"));
  }
  return lines.join("\n") + "\n";
}

function atExportPNG() {
  const A = atState();
  if (!A.packed) { atStatus("Pack something first."); return; }
  downloadCanvas(A.packed.canvas, AT_PNG_NAME);
}

function atExportManifest() {
  const A = atState();
  if (!A.packed) { atStatus("Pack something first."); return; }
  if (A.format === "json") downloadJSON(atBuildJSON(A), "m4ster-atlas.json");
  else downloadBytes(new TextEncoder().encode(atTpsheet(A, A.format === "godot")), "m4ster-atlas.tpsheet", "text/plain");
}

/* ---------------- Atlas Packer wiring ---------------- */

let atStaticWired = false;

function atWireStage() {
  // drag & drop onto the stage box — many files at once
  const box = $("#atStageBox");
  if (box) {
    ["dragenter", "dragover"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.add("at-over");
    }));
    ["dragleave", "drop"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.remove("at-over");
    }));
    box.addEventListener("drop", (e) => {
      const fs = e.dataTransfer && e.dataTransfer.files;
      if (fs && fs.length) atLoadFiles(fs);
    });
  }
  // paste images while the Atlas lane is open
  document.addEventListener("paste", (e) => {
    if (state.category !== "atlas") return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { atLoadFiles(files); e.preventDefault(); }
  });
}

function wireAtlas() {
  const A = atState();
  $("#atPick").onclick = () => $("#atFile").click();
  $("#atFile").onchange = (e) => {
    atLoadFiles(e.target.files);
    e.target.value = "";
  };
  $("#atClear").onclick = () => {
    A.items = [];
    A.packed = null;
    const atExpP3 = $("#atExportPng"), atExpM3 = $("#atExportManifest");
    if (atExpP3) atExpP3.disabled = true;
    if (atExpM3) atExpM3.disabled = true;
    atDraw();
  };
  $("#atPack").onclick = atPack;
  $("#atExportPng").onclick = atExportPNG;
  $("#atExportManifest").onclick = atExportManifest;
  $("#atExportPng").disabled = $("#atExportManifest").disabled = !atState().packed;
  const repack = () => { if (A.packed) atPack(); };
  const pad = $("#atPad");
  if (pad) pad.oninput = () => {
    A.pad = +pad.value;
    const v = $("#atPadVal");
    if (v) v.textContent = pad.value + "px";
    repack();
  };
  const ex = $("#atExtrude");
  if (ex) ex.onchange = () => { A.extrude = ex.checked; repack(); };
  const pot = $("#atPot");
  if (pot) pot.onchange = () => { A.pot = pot.checked; repack(); };
  const lb = $("#atLabels");
  if (lb) lb.onchange = () => { A.labels = lb.checked; atDraw(); };
  const fmt = $("#atFormat");
  if (fmt) fmt.onchange = () => { A.format = fmt.value; };
  if (!atStaticWired) {
    atStaticWired = true;
    atWireStage();
  }
  if (A.items.length) atDraw();
  syncAtlasMode();
}

/* ================= v8.7: Normal Map Lab — flat sprite → lit sprite =================
 * Drop in a flat sprite or texture and get back the maps a 2D engine
 * needs for dynamic lighting: a tangent-space normal map, an ambient
 * occlusion map and a specular map, all derived from one height field.
 * The height comes from the image brightness, or from its alpha
 * channel in silhouette mode (a cutout sprite gets a bevelled edge).
 * Sampling wraps around the edges, so tileable textures stay seamless.
 * Pure JS — no models, no server, no login. */

const NM_CAP = 1024;  // working cap on the long edge, same as Cutout Lab

function nmState() {
  if (!state.normalmap) {
    state.normalmap = {
      src: null,        // { data, w, h } working pixels (<= NM_CAP)
      imgW: 0, imgH: 0, // original dimensions, for the readout
      name: "image",
      view: "normal",   // normal | lit | ao | spec — what the stage shows
      strength: 100,    // normal strength, percent (100 -> slope x2)
      smooth: 1,        // height-field blur radius, px
      alphaMode: false, // height from alpha (silhouette) instead of brightness
      wrap: true,       // wrap-aware sampling (seamless tiles)
      flipY: false,     // false = OpenGL (Y+), true = DirectX (Y-)
      maps: null,       // { normal, ao, spec } canvases + raw buffers
      light: { x: 90, y: 80 },  // lit-preview light spot, canvas coords
    };
  }
  return state.normalmap;
}

function syncNormalmapMode() {
  const on = state.category === "normalmap";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-normalmap", on);
  if (stage) stage.classList.toggle("mode-normalmap", on);
  document.body.classList.toggle("mode-normalmap", on);
  const sec = $("#normalmap");
  if (sec) sec.hidden = !on;
  syncToolChrome();
}

function nmStatus(msg) {
  const ro = $("#nmReadout");
  if (ro) ro.textContent = msg;
}

/* ---- pure math: height field, blur, and the three maps ---- */

/* sample the height field at (x, y). With wrap on, coordinates wrap
 * around the edges (the left edge reads the right side) — that is
 * what keeps a tileable texture seamless. Without it, edges clamp. */
function nmSampleH(hf, w, h, x, y, wrap) {
  if (wrap) {
    x = ((x % w) + w) % w;
    y = ((y % h) + h) % h;
  } else {
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
  }
  return hf[y * w + x];
}

/* the height field: one 0..1 height per pixel, from brightness —
 * or from the alpha channel in silhouette mode, where a sprite's
 * shape itself becomes the relief. */
function nmHeightField(data, w, h, alphaMode) {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = i * 4;
    out[i] = alphaMode
      ? data[a + 3] / 255
      : (0.2126 * data[a] + 0.7152 * data[a + 1] + 0.0722 * data[a + 2]) / 255;
  }
  return out;
}

/* one box-blur pass over the height field (rows or columns) using
 * prefix sums, so the cost stays flat whatever the radius. Sampling
 * follows the same wrap/clamp rule as everything else. */
function nmBlurPass(src, w, h, radius, wrap, horizontal) {
  const n = horizontal ? w : h;      // length of one line
  const lines = horizontal ? h : w;  // how many lines
  const win = 2 * radius + 1;
  const ext = new Float64Array(n + 2 * radius + 1);  // prefix sums, line extended by radius each side
  const out = new Float32Array(src.length);
  for (let line = 0; line < lines; line++) {
    ext[0] = 0;
    for (let t = 0; t < n + 2 * radius; t++) {
      let idx = t - radius;
      if (wrap) idx = ((idx % n) + n) % n;
      else idx = Math.max(0, Math.min(n - 1, idx));
      ext[t + 1] = ext[t] + (horizontal ? src[line * w + idx] : src[idx * w + line]);
    }
    for (let i = 0; i < n; i++) {
      const v = (ext[i + win] - ext[i]) / win;
      if (horizontal) out[line * w + i] = v; else out[i * w + line] = v;
    }
  }
  return out;
}

/* blur the height field by radius px (0 = untouched): a horizontal
 * pass then a vertical one. Two passes of the wide AO blur below are
 * what make its falloff soft instead of boxy. */
function nmBlurHeight(hf, w, h, radius, wrap) {
  if (radius <= 0 || hf.length === 0) return hf;
  return nmBlurPass(nmBlurPass(hf, w, h, radius, wrap, true), w, h, radius, wrap, false);
}

/* Sobel gradients over the height field -> tangent-space normals.
 * strength scales the slope (0 = a perfectly flat, neutral map).
 * flipY flips ONLY the green channel: OpenGL (Y+) vs DirectX (Y-). */
function nmNormalMap(hf, w, h, strength, wrap, flipY) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = nmSampleH(hf, w, h, x - 1, y - 1, wrap), tc = nmSampleH(hf, w, h, x, y - 1, wrap), tr = nmSampleH(hf, w, h, x + 1, y - 1, wrap);
      const ml = nmSampleH(hf, w, h, x - 1, y, wrap), mr = nmSampleH(hf, w, h, x + 1, y, wrap);
      const bl = nmSampleH(hf, w, h, x - 1, y + 1, wrap), bc = nmSampleH(hf, w, h, x, y + 1, wrap), br = nmSampleH(hf, w, h, x + 1, y + 1, wrap);
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);  // height rising to the right
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);  // height rising downward (image rows)
      let nx = -gx * strength;
      let ny = (flipY ? -gy : gy) * strength;
      const len = Math.hypot(nx, ny, 1) || 1;
      nx /= len; ny /= len;
      const nz = 1 / len;
      const a = (y * w + x) * 4;
      out[a] = Math.round((nx * 0.5 + 0.5) * 255);
      out[a + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[a + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[a + 3] = 255;
    }
  }
  return out;
}

/* ambient occlusion, kept simple and honest: blur the height field
 * wide, then darken any pixel that sits BELOW its blurred
 * neighbourhood — grooves and crevices trap light, raised areas and
 * flat fields stay fully bright. Greyscale RGBA. */
function nmAoMap(hf, w, h, wrap) {
  const r = Math.max(2, Math.round(Math.min(w, h) / 16));
  const soft = nmBlurHeight(nmBlurHeight(hf, w, h, r, wrap), w, h, r, wrap);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const below = Math.max(0, soft[i] - hf[i]);
    const v = Math.round(255 * Math.max(0, 1 - below * 4));
    const a = i * 4;
    out[a] = v; out[a + 1] = v; out[a + 2] = v; out[a + 3] = 255;
  }
  return out;
}

/* specular (smoothness) map: higher ground reads as smoother and
 * shinier, low ground as rough. Greyscale RGBA. */
function nmSpecMap(hf, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(255 * (0.2 + 0.8 * hf[i]));
    const a = i * 4;
    out[a] = v; out[a + 1] = v; out[a + 2] = v; out[a + 3] = 255;
  }
  return out;
}

/* the lit preview: shade the source image with its normal map under
 * one light at (lx, ly) — diffuse falloff plus a specular glint
 * weighted by the specular map. ySign bridges the green-channel
 * convention: OpenGL normals store "up" as +green while image rows
 * run downward. Pure per-pixel math. */
function nmShadeLit(src, nrm, spec, w, h, lx, ly, ySign) {
  const out = new Uint8ClampedArray(src.length);
  const lz = Math.max(w, h) * 0.75;  // light height above the picture
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (y * w + x) * 4;
      let dx = lx - x, dy = (ly - y) * ySign, dz = lz;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      const nx = nrm[a] / 255 * 2 - 1, ny = nrm[a + 1] / 255 * 2 - 1, nz = nrm[a + 2] / 255 * 2 - 1;
      const diff = Math.max(0, nx * dx + ny * dy + nz * dz);
      let hx = dx, hy = dy, hz = dz + 1;  // half-vector: view is straight down +z
      const hl = Math.hypot(hx, hy, hz) || 1;
      hx /= hl; hy /= hl; hz /= hl;
      const ndh = Math.max(0, nx * hx + ny * hy + nz * hz);
      const sp = Math.pow(ndh, 24) * (spec[a] / 255) * 0.7;
      const shade = 0.3 + 0.7 * diff;
      out[a] = Math.min(255, src[a] * shade + sp * 255);
      out[a + 1] = Math.min(255, src[a + 1] * shade + sp * 255);
      out[a + 2] = Math.min(255, src[a + 2] * shade + sp * 255);
      out[a + 3] = src[a + 3];
    }
  }
  return out;
}

/* ---- DOM side: canvases, loading, drawing, export ---- */

function nmCanvasFrom(buf, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").putImageData(new ImageData(buf, w, h), 0, 0);
  return cv;
}

/* rebuild all three maps from the current settings, then redraw.
 * The normal map keeps the sprite's own alpha, so a cutout sprite's
 * normal map keeps its shape in the engine. */
function nmRecompute() {
  const N = nmState();
  if (!N.src) return;
  const { data, w, h } = N.src;
  let hf = nmHeightField(data, w, h, N.alphaMode);
  hf = nmBlurHeight(hf, w, h, N.smooth, N.wrap);
  const nrm = nmNormalMap(hf, w, h, N.strength / 50, N.wrap, N.flipY);
  for (let i = 0; i < w * h; i++) nrm[i * 4 + 3] = data[i * 4 + 3];
  const spec = nmSpecMap(hf, w, h);
  N.maps = {
    normal: nmCanvasFrom(nrm, w, h),
    ao: nmCanvasFrom(nmAoMap(hf, w, h, N.wrap), w, h),
    spec: nmCanvasFrom(spec, w, h),
    nrmData: nrm, specData: spec,
  };
  nmDraw();
}

function nmDraw() {
  const N = nmState();
  const view = $("#nmCanvas");
  if (!view || !N.src || !N.maps) return;
  const { w, h } = N.src;
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  const ctx = view.getContext("2d");
  if (N.view === "lit") {
    const lit = nmShadeLit(N.src.data, N.maps.nrmData, N.maps.specData, w, h,
      N.light.x, N.light.y, N.flipY ? 1 : -1);
    ctx.putImageData(new ImageData(lit, w, h), 0, 0);
  } else {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(N.maps[N.view], 0, 0);
  }
  const names = { normal: "normal map", lit: "lit preview", ao: "AO map", spec: "specular map" };
  nmStatus(N.name + " · " + w + " × " + h + " · " + names[N.view] +
    (N.view === "normal" ? (N.flipY ? " · DirectX (Y−)" : " · OpenGL (Y+)") : ""));
}

/* the sample: a greyscale medallion with clear relief — a shaded rim,
 * a beaded edge, a domed disc and an embossed star — drawn on
 * transparency, so both height modes have something to bite on. */
function nmMakeSample() {
  const s = 256, cv = document.createElement("canvas");
  cv.width = s; cv.height = s;
  const c = cv.getContext("2d");
  const cx = s / 2, cy = s / 2;
  const rim = c.createRadialGradient(cx - 30, cy - 30, 20, cx, cy, 118);
  rim.addColorStop(0, "#f4f4f4"); rim.addColorStop(0.55, "#9a9a9a");
  rim.addColorStop(0.85, "#4a4a4a"); rim.addColorStop(1, "#2e2e2e");
  c.fillStyle = rim;
  c.beginPath(); c.arc(cx, cy, 116, 0, Math.PI * 2); c.fill();
  c.fillStyle = "#cfcfcf";
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2;
    c.beginPath(); c.arc(cx + Math.cos(a) * 100, cy + Math.sin(a) * 100, 7, 0, Math.PI * 2); c.fill();
  }
  const disc = c.createRadialGradient(cx - 24, cy - 24, 8, cx, cy, 88);
  disc.addColorStop(0, "#e8e8e8"); disc.addColorStop(1, "#6a6a6a");
  c.fillStyle = disc;
  c.beginPath(); c.arc(cx, cy, 86, 0, Math.PI * 2); c.fill();
  c.fillStyle = "#f8f8f8";
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const r = i % 2 === 0 ? 52 : 22;
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath(); c.fill();
  return cv;
}

/* bring an image in (file, paste, drop or the sample) and make it
 * the working image, capped at NM_CAP on the long edge so slider
 * changes stay live. */
function nmLoadSource(img, name) {
  const N = nmState();
  const scale = Math.min(1, NM_CAP / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx2 = cv.getContext("2d", { willReadFrequently: true });
  cx2.drawImage(img, 0, 0, w, h);
  const id = cx2.getImageData(0, 0, w, h);
  N.src = { data: id.data, w, h };
  N.imgW = img.width; N.imgH = img.height;
  N.name = name || "image";
  N.light = { x: Math.round(w * 0.35), y: Math.round(h * 0.3) };
  if (img.close) img.close();
  const view = $("#nmCanvas");
  if (view) { view.width = w; view.height = h; }
  const empty = $("#nmEmpty");
  if (empty) empty.hidden = true;
  nmRecompute();
  const nmExp = $("#nmExport");
  if (nmExp) nmExp.disabled = !(N.src && N.maps);
}

async function nmLoadFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    nmLoadSource(bmp, file.name || "image");
  } catch (err) {
    nmStatus("couldn't read that image — try a PNG or JPG.");
  }
}

function nmExportPNG() {
  const N = nmState();
  if (!N.src || !N.maps) { nmStatus("Load an image or the sample first."); return; }
  const { w, h } = N.src;
  if (N.view === "lit") {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const lit = nmShadeLit(N.src.data, N.maps.nrmData, N.maps.specData, w, h,
      N.light.x, N.light.y, N.flipY ? 1 : -1);
    cv.getContext("2d").putImageData(new ImageData(lit, w, h), 0, 0);
    downloadCanvas(cv, "m4ster-normalmap-lit-" + w + "x" + h + ".png");
    return;
  }
  downloadCanvas(N.maps[N.view], "m4ster-normalmap-" + N.view + "-" + w + "x" + h + ".png");
}

/* ---------------- Normal Map Lab wiring ---------------- */

let nmStaticWired = false;
let nmLitQueued = false;

function nmWireStage() {
  const box = $("#nmStageBox");
  if (box) {
    ["dragenter", "dragover"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.add("nm-over");
    }));
    ["dragleave", "drop"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.remove("nm-over");
    }));
    box.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) nmLoadFile(f);
    });
  }
  // paste an image while the Normal Map lane is open
  document.addEventListener("paste", (e) => {
    if (state.category !== "normalmap") return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) { nmLoadFile(f); e.preventDefault(); break; }
      }
    }
  });
  // in Lit view the light follows the pointer over the picture
  const cv = $("#nmCanvas");
  if (cv) cv.addEventListener("pointermove", (e) => {
    const N = nmState();
    if (!N.src || N.view !== "lit") return;
    const r = cv.getBoundingClientRect();
    N.light = {
      x: (e.clientX - r.left) * cv.width / r.width,
      y: (e.clientY - r.top) * cv.height / r.height,
    };
    if (!nmLitQueued) {
      nmLitQueued = true;
      requestAnimationFrame(() => {
        nmLitQueued = false;
        if (nmState().view === "lit") nmDraw();
      });
    }
  });
}

function wireNormalmap() {
  const N = nmState();
  $("#nmSample").onclick = () => nmLoadSource(nmMakeSample(), "sample medallion");
  $("#nmPick").onclick = () => $("#nmFile").click();
  $("#nmFile").onchange = (e) => {
    nmLoadFile(e.target.files[0]);
    e.target.value = "";
  };
  document.querySelectorAll("#nmViewSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      N.view = b.dataset.nmview;
      document.querySelectorAll("#nmViewSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      nmDraw();
    };
  });
  document.querySelectorAll("#nmHeightSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      N.alphaMode = b.dataset.nmheight === "alpha";
      document.querySelectorAll("#nmHeightSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      nmRecompute();
    };
  });
  document.querySelectorAll("#nmFlipSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      N.flipY = b.dataset.nmflip === "dx";
      document.querySelectorAll("#nmFlipSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      nmRecompute();
    };
  });
  const st = $("#nmStrength");
  if (st) st.oninput = () => {
    N.strength = +st.value;
    const v = $("#nmStrengthVal");
    if (v) v.textContent = st.value + "%";
    nmRecompute();
  };
  const sm = $("#nmSmooth");
  if (sm) sm.oninput = () => {
    N.smooth = +sm.value;
    const v = $("#nmSmoothVal");
    if (v) v.textContent = sm.value + "px";
    nmRecompute();
  };
  const wr = $("#nmWrap");
  if (wr) wr.onchange = () => { N.wrap = wr.checked; nmRecompute(); };
  $("#nmExport").onclick = nmExportPNG;
  $("#nmExport").disabled = !(nmState().src && nmState().maps);
  if (!nmStaticWired) {
    nmStaticWired = true;
    nmWireStage();
  }
  if (N.src) nmDraw();
  syncNormalmapMode();
}

/* ================= v8.8: Seamless Tiler — texture in, repeat out =================
 * Make any texture tileable and prove it live. The Offset view rolls
 * the texture by half on both axes, so the wrap edges land in the
 * middle where the seams are easy to see. The heal cross-fades the
 * edge bands: inside a band, every pixel blends toward the pixel
 * mirrored from the opposite edge, and the blend peaks at exactly
 * one half on the outermost line — so the first and last columns
 * land on the very same value and the wrap step disappears. The 3x3
 * view repeats the healed texture so any leftover seam shows at
 * once. Pure JS — no models, no server, no login. */

const TL_CAP = 1024;  // working cap on the long edge, same as Normal Map Lab

function tlState() {
  if (!state.tiler) {
    state.tiler = {
      src: null,        // { data, w, h } pristine working pixels (<= TL_CAP)
      full: null,       // { data, w, h } pristine pixels at original size, for export
      imgW: 0, imgH: 0, // original dimensions, for the readout
      name: "texture",
      view: "single",   // single | offset | grid — what the stage shows
      strength: 60,     // heal strength, percent of the widest band
      healed: null,     // healed RGBA buffer at working size
      healedCv: null,   // the same, as a canvas, for the 3x3 draw
    };
  }
  return state.tiler;
}

function syncTilerMode() {
  const on = state.category === "tiler";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-tiler", on);
  if (stage) stage.classList.toggle("mode-tiler", on);
  document.body.classList.toggle("mode-tiler", on);
  const sec = $("#tiler");
  if (sec) sec.hidden = !on;
  syncToolChrome();
}

function tlStatus(msg) {
  const ro = $("#tlReadout");
  if (ro) ro.textContent = msg;
}

/* ---- pure math: the heal and the offset roll ---- */

/* how wide the cross-fade band is along one axis: the strength
 * slider spends itself on up to a quarter of that dimension, so
 * 100% heals the outer 25% on every side and 0% heals nothing. */
function tlBand(len, strength) {
  return Math.round(len * 0.25 * strength / 100);
}

/* one axis of the heal, in place: inside the two edge bands, blend
 * each pixel toward the pixel mirrored from the opposite edge —
 * pixel i trades with pixel len-1-i, so both edges move toward each
 * other and meet exactly halfway on the outermost line (t = 0.5
 * there), which is what makes the wrap continuous. Pairs are written
 * together so neither side reads a half-blended partner. */
function tlHealAxis(buf, w, h, band, horizontal) {
  const len = horizontal ? w : h;    // length of one line
  const lines = horizontal ? h : w;  // how many lines
  for (let line = 0; line < lines; line++) {
    for (let i = 0; i < band && i < len / 2; i++) {
      const t = 0.5 * (1 - i / band);  // 0.5 at the edge, fading inward
      const j = len - 1 - i;           // the mirrored pixel, opposite edge
      const a = (horizontal ? line * w + i : i * w + line) * 4;
      const b = (horizontal ? line * w + j : j * w + line) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const va = buf[a + ch], vb = buf[b + ch];
        buf[a + ch] = va * (1 - t) + vb * t;
        buf[b + ch] = vb * (1 - t) + va * t;
      }
    }
  }
}

/* heal a texture: a horizontal pass, then a vertical one on the
 * result. The vertical pass blends whole columns toward each other,
 * and because the horizontal pass already made every row wrap-clean,
 * equal columns stay equal — the second pass cannot reopen the
 * first seam. Always computed from the pristine source, so dragging
 * the slider back and forth never compounds the blend. */
function tlHeal(data, w, h, strength) {
  const out = new Uint8ClampedArray(data);
  const bw = tlBand(w, strength), bh = tlBand(h, strength);
  if (bw > 0) tlHealAxis(out, w, h, bw, true);
  if (bh > 0) tlHealAxis(out, w, h, bh, false);
  return out;
}

/* the offset view: roll the texture by half on both axes. The wrap
 * edges land in the middle, where a seam cannot hide. */
function tlOffset(data, w, h) {
  const out = new Uint8ClampedArray(data.length);
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (y * w + x) * 4;
      const b = (((y + hh) % h) * w + ((x + hw) % w)) * 4;
      out[a] = data[b]; out[a + 1] = data[b + 1];
      out[a + 2] = data[b + 2]; out[a + 3] = data[b + 3];
    }
  }
  return out;
}

/* ---- DOM side: canvases, loading, drawing, export ---- */

function tlCanvasFrom(buf, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").putImageData(new ImageData(buf, w, h), 0, 0);
  return cv;
}

/* recompute the heal from the pristine source at the current
 * strength, then redraw — the slider stays live because the source
 * is never the healed output. */
function tlRecompute() {
  const T = tlState();
  if (!T.src) return;
  const { data, w, h } = T.src;
  T.healed = tlHeal(data, w, h, T.strength);
  T.healedCv = tlCanvasFrom(T.healed, w, h);
  tlDraw();
}

function tlDraw() {
  const T = tlState();
  const view = $("#tlCanvas");
  if (!view || !T.src || !T.healed) return;
  const { w, h } = T.src;
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  const ctx = view.getContext("2d");
  if (T.view === "offset") {
    ctx.putImageData(new ImageData(tlOffset(T.healed, w, h), w, h), 0, 0);
  } else if (T.view === "grid") {
    const tw = w / 3, th = h / 3;
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) ctx.drawImage(T.healedCv, gx * tw, gy * th, tw, th);
    }
  } else {
    ctx.drawImage(T.healedCv, 0, 0);
  }
  const names = { single: "healed texture", offset: "offset view — seams in the middle", grid: "3 × 3 repeat" };
  tlStatus(T.name + " · " + T.imgW + " × " + T.imgH + " · heal " + T.strength + "% · " + names[T.view]);
}

/* the sample: a stone-ish texture that deliberately does NOT tile —
 * warm sand on the left runs into cool slate on the right, the top
 * sits in shadow and the bottom in light, and soft blotches are
 * clipped by the edges, so every seam is obvious before the heal. */
function tlMakeSample() {
  const s = 256, cv = document.createElement("canvas");
  cv.width = s; cv.height = s;
  const c = cv.getContext("2d");
  const across = c.createLinearGradient(0, 0, s, 0);
  across.addColorStop(0, "#977950"); across.addColorStop(0.5, "#7d7461"); across.addColorStop(1, "#4e6472");
  c.fillStyle = across;
  c.fillRect(0, 0, s, s);
  const down = c.createLinearGradient(0, 0, 0, s);
  down.addColorStop(0, "rgba(30,26,20,0.45)"); down.addColorStop(0.5, "rgba(0,0,0,0)"); down.addColorStop(1, "rgba(240,235,220,0.35)");
  c.fillStyle = down;
  c.fillRect(0, 0, s, s);
  const tones = ["#8a6f4d", "#5d7263", "#a08b62", "#54626e", "#77644a", "#687d6d"];
  for (let i = 0; i < 46; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 12 + Math.random() * 42;
    const rg = c.createRadialGradient(x, y, 1, x, y, r);
    const col = tones[i % tones.length];
    rg.addColorStop(0, col + "cc"); rg.addColorStop(1, col + "00");
    c.fillStyle = rg;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  for (let i = 0; i < 900; i++) {
    c.fillStyle = Math.random() < 0.5 ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.14)";
    c.fillRect(Math.random() * s, Math.random() * s, 2, 2);
  }
  return cv;
}

/* bring a texture in (file, paste, drop or the sample). The
 * original pixels are kept whole for the export; the working copy
 * is capped at TL_CAP so the heal slider stays live. The heal only
 * ever reads the pristine pixels, never its own output. */
function tlLoadSource(img, name) {
  const T = tlState();
  const fc = document.createElement("canvas");
  fc.width = img.width; fc.height = img.height;
  const fx = fc.getContext("2d", { willReadFrequently: true });
  fx.drawImage(img, 0, 0);
  const fid = fx.getImageData(0, 0, fc.width, fc.height);
  T.full = { data: fid.data, w: fc.width, h: fc.height };
  T.imgW = img.width; T.imgH = img.height;
  const scale = Math.min(1, TL_CAP / Math.max(img.width, img.height));
  if (scale < 1) {
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const cx2 = cv.getContext("2d", { willReadFrequently: true });
    cx2.drawImage(img, 0, 0, w, h);
    const id = cx2.getImageData(0, 0, w, h);
    T.src = { data: id.data, w, h };
  } else {
    T.src = T.full;
  }
  T.name = name || "texture";
  if (img.close) img.close();
  const view = $("#tlCanvas");
  if (view) { view.width = T.src.w; view.height = T.src.h; }
  const empty = $("#tlEmpty");
  if (empty) empty.hidden = true;
  tlRecompute();
  const tlExp = $("#tlExport");
  if (tlExp) tlExp.disabled = false;
}

async function tlLoadFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    tlLoadSource(bmp, file.name || "texture");
  } catch (err) {
    tlStatus("couldn't read that image — try a PNG or JPG.");
  }
}

/* export the healed texture at the original resolution: the same
 * heal, run once over the full-size pristine pixels. */
function tlExportPNG() {
  const T = tlState();
  if (!T.full) { tlStatus("Load a texture or the sample first."); return; }
  const { data, w, h } = T.full;
  const cv = tlCanvasFrom(tlHeal(data, w, h, T.strength), w, h);
  downloadCanvas(cv, "m4ster-seamless-" + w + "x" + h + ".png");
}

/* ---------------- Seamless Tiler wiring ---------------- */

let tlStaticWired = false;

function tlWireStage() {
  const box = $("#tlStageBox");
  if (box) {
    ["dragenter", "dragover"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.add("tl-over");
    }));
    ["dragleave", "drop"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.remove("tl-over");
    }));
    box.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) tlLoadFile(f);
    });
  }
  // paste an image while the Tiler lane is open
  document.addEventListener("paste", (e) => {
    if (state.category !== "tiler") return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) { tlLoadFile(f); e.preventDefault(); break; }
      }
    }
  });
}

function wireTiler() {
  const T = tlState();
  $("#tlSample").onclick = () => tlLoadSource(tlMakeSample(), "sample stone");
  $("#tlPick").onclick = () => $("#tlFile").click();
  $("#tlFile").onchange = (e) => {
    tlLoadFile(e.target.files[0]);
    e.target.value = "";
  };
  document.querySelectorAll("#tlViewSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      T.view = b.dataset.tlview;
      document.querySelectorAll("#tlViewSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      tlDraw();
    };
  });
  const st = $("#tlStrength");
  if (st) st.oninput = () => {
    T.strength = +st.value;
    const v = $("#tlStrengthVal");
    if (v) v.textContent = st.value + "%";
    tlRecompute();
  };
  $("#tlExport").onclick = tlExportPNG;
  $("#tlExport").disabled = !tlState().full;
  if (!tlStaticWired) {
    tlStaticWired = true;
    tlWireStage();
  }
  if (T.src) tlDraw();
  syncTilerMode();
}

/* ================= v8.9: Palette Lab — colors out, swaps, variants =================
 * Pull the palette out of any sprite, swap colors, and spin off
 * recolor variants (team colors, enemy tiers, skins). Extraction
 * counts the exact colors first — real sprites use few enough that
 * they usually get their true palette back untouched — and only
 * photos fall through to a median-cut quantize capped at 16. A swap
 * replaces the picked color (a Tolerance slider feathers the
 * replacement across nearby shades, so anti-aliased edges don't
 * fringe), and the variant chips rotate the PALETTE's hues and
 * repaint the sprite through it, so flat colors stay flat. Fully
 * transparent pixels are ignored by the palette and never modified
 * by anything. Pure JS — no models, no server, no login. */

const PL_CAP = 1024;      // working cap on the long edge, same as Normal Map Lab
const PL_MAX_COLORS = 16; // a sprite palette, not a photo histogram

function plState() {
  if (!state.palette) {
    state.palette = {
      src: null,        // { data, w, h } pristine working pixels (<= PL_CAP)
      imgW: 0, imgH: 0, // original dimensions, for the readout
      name: "sprite",
      work: null,       // { data, w, h } current pixels, after swaps/variants
      colors: [],       // extracted palette: [{ r, g, b, count }] most-used first
      fromIdx: -1,      // palette index picked as the swap source (-1 = none)
      toHex: "#3fa7ff", // swap target, from the color input
      tolerance: 0,     // 0-64 RGB-distance allowance around the picked color
      undo: [],         // stack of earlier work buffers (newest last)
    };
  }
  return state.palette;
}

function syncPaletteMode() {
  const on = state.category === "palette";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-palette", on);
  if (stage) stage.classList.toggle("mode-palette", on);
  document.body.classList.toggle("mode-palette", on);
  const sec = $("#palette");
  if (sec) sec.hidden = !on;
  syncToolChrome();
}

function plStatus(msg) {
  const ro = $("#plReadout");
  if (ro) ro.textContent = msg;
}

/* ---- color helpers ---- */

function plHex(c) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

function plParseHex(str) {
  const n = parseInt(String(str).replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* RGB -> HSL with h in degrees [0,360), s and l in [0,1] */
function plRgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function plHslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const pick = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(pick(h + 1 / 3) * 255),
    g: Math.round(pick(h) * 255),
    b: Math.round(pick(h - 1 / 3) * 255),
  };
}

/* rotate one color's hue by deg degrees; greys and pure black/white
 * have no hue to spin, so they map to themselves. */
function plRotateHue(c, deg) {
  const hsl = plRgbToHsl(c.r, c.g, c.b);
  if (hsl.s === 0) return { r: c.r, g: c.g, b: c.b };
  const rgb = plHslToRgb(hsl.h + deg, hsl.s, hsl.l);
  return { r: rgb.r, g: rgb.g, b: rgb.b };
}

/* ---- palette extraction ---- */

/* count every visible color exactly. Fully transparent pixels are
 * skipped — their RGB is meaningless padding in most files. */
function plCountColors(data) {
  const map = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const hit = map.get(key);
    if (hit) hit.count++;
    else map.set(key, { r: data[i], g: data[i + 1], b: data[i + 2], count: 1 });
  }
  return [...map.values()];
}

/* the channel span of one median-cut box, and which channel is widest */
function plBoxRange(box) {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (const c of box) {
    if (c.r < rMin) rMin = c.r; if (c.r > rMax) rMax = c.r;
    if (c.g < gMin) gMin = c.g; if (c.g > gMax) gMax = c.g;
    if (c.b < bMin) bMin = c.b; if (c.b > bMax) bMax = c.b;
  }
  const spans = [rMax - rMin, gMax - gMin, bMax - bMin];
  let chan = 0;
  if (spans[1] > spans[chan]) chan = 1;
  if (spans[2] > spans[chan]) chan = 2;
  return { range: spans[chan], chan };
}

/* one box -> one palette color: the count-weighted average, so the
 * representative sits where the pixels actually are. */
function plBoxColor(box) {
  let r = 0, g = 0, b = 0, count = 0;
  for (const c of box) {
    r += c.r * c.count; g += c.g * c.count; b += c.b * c.count;
    count += c.count;
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), count };
}

/* median-cut quantize: keep splitting the widest box at its pixel
 * median until the cap is reached. Deterministic — same input,
 * same palette, every time. */
function plMedianCut(colors, maxColors) {
  const CH = ["r", "g", "b"];
  const boxes = [colors.slice()];
  while (boxes.length < maxColors) {
    let pick = -1, pickRange = 0, pickChan = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const { range, chan } = plBoxRange(box);
      if (range > pickRange) { pickRange = range; pick = i; pickChan = chan; }
    });
    if (pick < 0) break;  // nothing left that can split
    const box = boxes.splice(pick, 1)[0];
    box.sort((a, b) => a[CH[pickChan]] - b[CH[pickChan]]);
    let total = 0;
    for (const c of box) total += c.count;
    let acc = 0, k = 0;
    while (k < box.length - 1 && acc < total / 2) { acc += box[k].count; k++; }
    boxes.push(box.slice(0, k), box.slice(k));
  }
  return boxes.map(plBoxColor).sort((a, b) => b.count - a.count);
}

/* the palette of a pixel buffer, most-used color first. Sprites
 * with <= maxColors visible colors get them back EXACTLY — counts
 * and all; only richer images go through median-cut. */
function plExtractPalette(data, maxColors) {
  const counted = plCountColors(data);
  if (counted.length <= maxColors) {
    return counted.sort((a, b) => b.count - a.count);
  }
  return plMedianCut(counted, maxColors);
}

/* ---- the two recolors ---- */

/* swap `from` for `to`. Tolerance 0 = exact matches only. Above 0,
 * pixels within tolerance swap fully, and a feather band one
 * tolerance wide beyond that blends toward `to`, fading with
 * distance — anti-aliased edges follow the swap instead of
 * fringing. Alpha is never written; clear pixels are skipped. */
function plSwapColors(data, from, to, tolerance) {
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const dr = data[i] - from.r, dg = data[i + 1] - from.g, db = data[i + 2] - from.b;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (tolerance === 0) {
      if (d === 0) { out[i] = to.r; out[i + 1] = to.g; out[i + 2] = to.b; }
    } else if (d <= tolerance) {
      out[i] = to.r; out[i + 1] = to.g; out[i + 2] = to.b;
    } else if (d < tolerance * 2) {
      const f = 1 - (d - tolerance) / tolerance;  // 1 at the core rim, 0 at the feather edge
      out[i]     = data[i]     + (to.r - data[i])     * f;
      out[i + 1] = data[i + 1] + (to.g - data[i + 1]) * f;
      out[i + 2] = data[i + 2] + (to.b - data[i + 2]) * f;
    }
  }
  return out;
}

/* index of the palette color nearest to (r,g,b), plain RGB distance */
function plNearestIdx(colors, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < colors.length; i++) {
    const dr = r - colors[i].r, dg = g - colors[i].g, db = b - colors[i].b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* spin every palette hue by deg and repaint through the palette:
 * each pixel keeps its offset from its nearest palette color, so
 * anti-aliasing shades ride along — but two pixels wearing the
 * same palette color always land on the same new color, and flat
 * areas stay exactly flat. Not a whole-image hue filter. */
function plVariantColors(data, colors, deg) {
  const out = new Uint8ClampedArray(data);
  if (!colors.length) return out;
  const spun = colors.map(c => plRotateHue(c, deg));
  const cache = new Map();  // packed rgb -> palette index; sprites repeat colors a lot
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = (r << 16) | (g << 8) | b;
    let idx = cache.get(key);
    if (idx === undefined) { idx = plNearestIdx(colors, r, g, b); cache.set(key, idx); }
    const base = colors[idx], rot = spun[idx];
    out[i]     = r + (rot.r - base.r);
    out[i + 1] = g + (rot.g - base.g);
    out[i + 2] = b + (rot.b - base.b);
  }
  return out;
}

/* the palette as GIMP .gpl text — one "R G B #hex" line per color */
function plGplText(colors, name) {
  const lines = ["GIMP Palette", "Name: FrameLab Palette — " + name, "Columns: 4", "#"];
  for (const c of colors) lines.push(c.r + " " + c.g + " " + c.b + " " + plHex(c));
  return lines.join("\n") + "\n";
}

/* ---- DOM side: canvases, loading, drawing, export ---- */

function plCanvasFrom(buf, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").putImageData(new ImageData(buf, w, h), 0, 0);
  return cv;
}

/* re-extract the palette from the working pixels — after every op
 * the swatches must describe the sprite as it NOW is. */
function plExtract() {
  const P = plState();
  P.colors = P.work ? plExtractPalette(P.work.data, PL_MAX_COLORS) : [];
  if (P.fromIdx >= P.colors.length) P.fromIdx = -1;
}

function plDraw() {
  const P = plState();
  const view = $("#plCanvas");
  if (!view || !P.work) return;
  const { data, w, h } = P.work;
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  view.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  plStatus(P.name + " · " + P.imgW + " × " + P.imgH + " · " + P.colors.length +
    (P.colors.length === 1 ? " color" : " colors"));
}

/* repaint the panel's palette bits (swatches, swap source, variant
 * chips) from state — called after loads, ops and panel re-renders,
 * because renderParams rebuilds the panel HTML on every lane hop. */
function plPaintPanel() {
  const P = plState();
  const sw = $("#plSwatches");
  if (sw) {
    if (!P.colors.length) {
      sw.innerHTML = `<span class="dim">no sprite loaded yet</span>`;
    } else {
      sw.innerHTML = P.colors.map((c, i) =>
        `<button type="button" class="pl-swatch${i === P.fromIdx ? " active" : ""}" data-pli="${i}" title="swap from ${plHex(c)}"><span class="pl-dot" style="background:${plHex(c)}"></span><span>${plHex(c)}</span><span class="dim">${c.count}</span></button>`
      ).join("");
      sw.querySelectorAll(".pl-swatch").forEach(b => {
        b.onclick = () => {
          P.fromIdx = +b.dataset.pli;
          plPaintPanel();
        };
      });
    }
  }
  const chip = $("#plFromChip");
  const hex = $("#plFromHex");
  const from = P.fromIdx >= 0 ? P.colors[P.fromIdx] : null;
  if (chip) chip.style.background = from ? plHex(from) : "";
  if (hex) hex.textContent = from ? plHex(from) : "pick a color above";
  const undo = $("#plUndo");
  if (undo) undo.disabled = !P.undo.length;
  const va = $("#plVariants");
  if (va) {
    if (!P.colors.length) {
      va.innerHTML = `<span class="dim">load a sprite first</span>`;
    } else {
      va.innerHTML = [60, 120, 180, 240, 300].map(deg => {
        const stops = P.colors.slice(0, 4).map(c => plHex(plRotateHue(c, deg))).join(", ");
        return `<button type="button" class="pl-variant" data-pldeg="${deg}" style="background:linear-gradient(90deg, ${stops})" title="spin the palette hues by ${deg} degrees">+${deg}°</button>`;
      }).join("");
      va.querySelectorAll(".pl-variant").forEach(b => {
        b.onclick = () => plApplyVariant(+b.dataset.pldeg);
      });
    }
  }
}

/* remember the current pixels so an op can be taken back */
function plPushUndo() {
  const P = plState();
  P.undo.push(new Uint8ClampedArray(P.work.data));
  if (P.undo.length > 10) P.undo.shift();
}

function plAfterOp() {
  plExtract();
  plDraw();
  plPaintPanel();
  const P = plState();
  const plExp = $("#plExport"), plG = $("#plGpl"), plJ = $("#plJson");
  if (plExp) plExp.disabled = !P.work;
  if (plG) plG.disabled = !P.colors.length;
  if (plJ) plJ.disabled = !P.colors.length;
}

function plApplySwap() {
  const P = plState();
  if (!P.work) { plStatus("Load a sprite or the sample first."); return; }
  const from = P.colors[P.fromIdx];
  if (!from) { plStatus("Pick a color from the palette first."); return; }
  plPushUndo();
  P.work = { data: plSwapColors(P.work.data, from, plParseHex(P.toHex), P.tolerance), w: P.work.w, h: P.work.h };
  plAfterOp();
}

function plApplyVariant(deg) {
  const P = plState();
  if (!P.work) { plStatus("Load a sprite or the sample first."); return; }
  plPushUndo();
  P.work = { data: plVariantColors(P.work.data, P.colors, deg), w: P.work.w, h: P.work.h };
  plAfterOp();
}

function plUndoOp() {
  const P = plState();
  const prev = P.undo.pop();
  if (!prev) return;
  P.work = { data: prev, w: P.work.w, h: P.work.h };
  plAfterOp();
}

/* the sample: a little knight drawn pixel by pixel from a char map,
 * so his palette is exact — a dozen colors including a cheek-shadow
 * blend tone, plus two half-alpha pixels softening the chin (the "a" cells
 * wear the skin color at half alpha, like real anti-aliasing). */
function plMakeSample() {
  const INK = {
    H: [185, 197, 208, 255],  // helmet steel
    D: [119, 130, 142, 255],  // steel shade
    P: [216, 64, 64, 255],    // plume red
    S: [242, 193, 132, 255],  // skin
    C: [217, 168, 105, 255],  // cheek shadow (blend tone)
    E: [38, 34, 43, 255],     // eyes
    T: [58, 111, 216, 255],   // tunic blue
    U: [42, 79, 158, 255],    // tunic shade
    G: [242, 197, 49, 255],   // gold trim
    B: [122, 74, 38, 255],    // belt brown
    K: [55, 48, 43, 255],     // boots
    W: [230, 237, 244, 255],  // sword blade
    a: [242, 193, 132, 128],  // AA edge: skin at half alpha
  };
  const MAP = [
    "........................",
    ".........PPPP...........",
    "........PPPPPP..........",
    ".........PPPP...........",
    ".......HHHHHHHH.........",
    "......HHHHHHHHHH........",
    "......HDHHHHHHDH........",
    "......HHHHHHHHHH........",
    ".......SSSSSSSS.........",
    ".......SESSESSS.........",
    ".......SSSSSSSS.........",
    "........SCSSS...........",
    "........SSSS............",
    ".......aSSSSa......W....",
    ".....TTTTTTTTTT...WW....",
    "....TTTTTTTTTTTT.WW.....",
    "....UTTTGGGGTTTU.W......",
    "....UTTTGGGGTTTU........",
    ".....TTBBBBBBTT.........",
    ".....TTTTTTTTTT.........",
    "......TTT..TTT..........",
    "......UUU..UUU..........",
    ".....KKKK..KKKK.........",
    "........................",
  ];
  const w = 24, h = MAP.length, scale = 6;
  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const sx = small.getContext("2d");
  const id = sx.createImageData(w, h);
  MAP.forEach((row, y) => {
    const line = (row + ".".repeat(w)).slice(0, w);
    for (let x = 0; x < w; x++) {
      const ink = INK[line[x]];
      if (!ink) continue;
      const i = (y * w + x) * 4;
      id.data[i] = ink[0]; id.data[i + 1] = ink[1]; id.data[i + 2] = ink[2]; id.data[i + 3] = ink[3];
    }
  });
  sx.putImageData(id, 0, 0);
  const cv = document.createElement("canvas");
  cv.width = w * scale; cv.height = h * scale;
  const cx = cv.getContext("2d");
  cx.imageSmoothingEnabled = false;
  cx.drawImage(small, 0, 0, cv.width, cv.height);
  return cv;
}

/* bring a sprite in (file, paste, drop or the sample). Working
 * pixels are capped at PL_CAP; palette ops are per-pixel, so the
 * export is the working size — the readout always shows the
 * original dimensions too. A new image resets swaps, variants
 * and the undo stack: yesterday's colors are not today's. */
function plLoadSource(img, name) {
  const P = plState();
  const scale = Math.min(1, PL_CAP / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(img, 0, 0, w, h);
  const id = cx.getImageData(0, 0, w, h);
  P.src = { data: id.data, w, h };
  P.imgW = img.width; P.imgH = img.height;
  P.name = name || "sprite";
  P.work = { data: new Uint8ClampedArray(id.data), w, h };
  P.undo = [];
  P.fromIdx = -1;
  if (img.close) img.close();
  const view = $("#plCanvas");
  if (view) { view.width = w; view.height = h; }
  const empty = $("#plEmpty");
  if (empty) empty.hidden = true;
  plExtract();
  plDraw();
  plPaintPanel();
  const plExp2 = $("#plExport"), plG2 = $("#plGpl"), plJ2 = $("#plJson");
  if (plExp2) plExp2.disabled = !P.work;
  if (plG2) plG2.disabled = !P.colors.length;
  if (plJ2) plJ2.disabled = !P.colors.length;
}

async function plLoadFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    plLoadSource(bmp, file.name || "sprite");
  } catch (err) {
    plStatus("couldn't read that image — try a PNG or JPG.");
  }
}

function plExportPNG() {
  const P = plState();
  if (!P.work) { plStatus("Load a sprite or the sample first."); return; }
  downloadCanvas(plCanvasFrom(P.work.data, P.work.w, P.work.h),
    "m4ster-palette-" + P.work.w + "x" + P.work.h + ".png");
}

function plExportGpl() {
  const P = plState();
  if (!P.colors.length) { plStatus("Load a sprite or the sample first."); return; }
  downloadBytes(new TextEncoder().encode(plGplText(P.colors, P.name)), "m4ster-palette.gpl", "text/plain");
}

function plExportJson() {
  const P = plState();
  if (!P.colors.length) { plStatus("Load a sprite or the sample first."); return; }
  downloadJSON({
    name: P.name,
    colors: P.colors.map(c => ({ hex: plHex(c), r: c.r, g: c.g, b: c.b, count: c.count })),
  }, "m4ster-palette.json");
}

/* ---------------- Palette Lab wiring ---------------- */

let plStaticWired = false;

function plWireStage() {
  const box = $("#plStageBox");
  if (box) {
    ["dragenter", "dragover"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.add("pl-over");
    }));
    ["dragleave", "drop"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.remove("pl-over");
    }));
    box.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) plLoadFile(f);
    });
  }
  // paste an image while the Palette lane is open
  document.addEventListener("paste", (e) => {
    if (state.category !== "palette") return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) { plLoadFile(f); e.preventDefault(); break; }
      }
    }
  });
}

function wirePalette() {
  const P = plState();
  $("#plSample").onclick = () => plLoadSource(plMakeSample(), "sample knight");
  $("#plPick").onclick = () => $("#plFile").click();
  $("#plFile").onchange = (e) => {
    plLoadFile(e.target.files[0]);
    e.target.value = "";
  };
  const to = $("#plTo");
  if (to) to.oninput = () => { P.toHex = to.value; };
  const tol = $("#plTol");
  if (tol) tol.oninput = () => {
    P.tolerance = +tol.value;
    const v = $("#plTolVal");
    if (v) v.textContent = tol.value;
  };
  $("#plApply").onclick = plApplySwap;
  $("#plUndo").onclick = plUndoOp;
  $("#plExport").onclick = plExportPNG;
  $("#plGpl").onclick = plExportGpl;
  $("#plJson").onclick = plExportJson;
  $("#plExport").disabled = !plState().work;
  $("#plGpl").disabled = $("#plJson").disabled = !plState().colors.length;
  if (!plStaticWired) {
    plStaticWired = true;
    plWireStage();
  }
  plPaintPanel();
  if (P.work) plDraw();
  syncPaletteMode();
}

/* ================= v8.10: GIF Sheet =================
 * Turn an animated GIF into a sprite sheet: every frame decoded
 * and composited, laid out in a grid, exported as one PNG plus a
 * JSON manifest with each frame's rect and duration.
 *
 * The decoder below is written from the GIF89a spec by hand — no
 * library — because the whole point of this site is that the work
 * happens in your browser. It handles the parts real GIFs use:
 * global and local color tables, transparency, interlacing, frame
 * delays, and the disposal rules that say what happens to the
 * canvas between frames. */

function gfState() {
  if (!state.gif) {
    state.gif = {
      frames: [],      // composited frames: [{ data, duration }] at logical-screen size
      frameW: 0, frameH: 0, // the GIF's logical screen = one sheet cell
      name: "animation",
      cols: 4,         // manual column count (used when autoCols is off)
      autoCols: true,  // auto = the near-square grid
    };
  }
  return state.gif;
}

function syncGifMode() {
  const on = state.category === "gif";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-gif", on);
  if (stage) stage.classList.toggle("mode-gif", on);
  document.body.classList.toggle("mode-gif", on);
  const sec = $("#gif");
  if (sec) sec.hidden = !on;
  syncToolChrome();
}

function gfStatus(msg) {
  const ro = $("#gfReadout");
  if (ro) ro.textContent = msg;
}

/* ---- the decoder ---- */

/* a cursor over the file's bytes: read one byte, a little-endian
 * 16-bit word, or a run of bytes, without repeating index math.
 * Reading past the end yields undefined/NaN, which the parser
 * treats as "file over" — truncated GIFs stop cleanly. */
function gfReader(bytes) {
  let pos = 0;
  return {
    byte() { return bytes[pos++]; },
    word() { const v = bytes[pos] | (bytes[pos + 1] << 8); pos += 2; return v; },
    take(n) { const out = bytes.subarray(pos, pos + n); pos += n; return out; },
    skip(n) { pos += n; },
  };
}

/* a color table is 3 bytes per color (red, green, blue); its size
 * rides in flag bits as 2^(n+1) colors */
function gfReadPalette(rd, sizeCode) {
  const count = 2 << sizeCode;          // sizeCode 0..7 -> 2..256 colors
  const raw = rd.take(count * 3);
  const pal = new Array(count);
  for (let i = 0; i < count; i++) {
    pal[i] = [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]];
  }
  return pal;
}

/* several GIF chunks are stored as "sub-blocks": a length byte,
 * that many bytes, repeat — ended by a zero length. Skip one run. */
function gfSkipBlocks(rd) {
  for (;;) {
    const n = rd.byte();
    if (!n) return;
    rd.skip(n);
  }
}

/* GIF's flavor of LZW. Codes are packed LSB-first into the data
 * sub-blocks and widen from (minCodeSize + 1) bits up to 12 bits as
 * the dictionary grows. Two codes are special: "clear" resets the
 * dictionary, "end" stops the stream. The output is one palette
 * index per pixel, in stored row order. */
function gfLzwDecode(minCodeSize, chunks, expected) {
  // glue the size-prefixed sub-blocks into one flat byte array
  let total = 0;
  for (const c of chunks) total += c.length;
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.length; }

  const clear = 1 << minCodeSize;       // e.g. min 8 -> clear = 256
  const endCode = clear + 1;
  const out = new Uint8Array(expected);
  let outLen = 0;

  let dict = null;                      // code -> array of indices
  let codeSize = 0, nextCode = 0;
  function resetDict() {
    dict = [];
    for (let i = 0; i < clear; i++) dict.push([i]);
    dict.push(null, null);              // the clear + end slots
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  }
  resetDict();

  let bitPos = 0;
  const totalBits = data.length * 8;
  function readCode() {
    if (bitPos + codeSize > totalBits) return -1;
    let v = 0;
    for (let i = 0; i < codeSize; i++) {
      const bit = (data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1;
      v |= bit << i;
    }
    bitPos += codeSize;
    return v;
  }

  let prev = null;                      // the previous code's string
  while (outLen < expected) {
    const code = readCode();
    if (code === -1 || code === endCode) break;
    if (code === clear) { resetDict(); prev = null; continue; }
    let entry;
    if (dict[code]) {
      entry = dict[code];
    } else if (code === nextCode && prev) {
      // the famous special case: the string is prev + prev's first
      entry = prev.concat(prev[0]);
    } else {
      break;                            // corrupt stream — keep what we have
    }
    for (let i = 0; i < entry.length && outLen < expected; i++) out[outLen++] = entry[i];
    if (prev && nextCode < 4096) {
      dict[nextCode++] = prev.concat(entry[0]);
      // the next code in the stream may be as large as the next
      // free dictionary slot — the moment that slot outgrows the
      // current width, the codes that follow are written one bit
      // wider, so widen in step (12 bits is the format's ceiling)
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out.subarray(0, outLen);
}

/* interlaced GIFs store their rows in four passes — rows 0, 8, 16…,
 * then 4, 12, 20…, then 2, 6, 10…, then the odd rows. Given the
 * stored row number, hand back the real row it belongs to. */
function gfInterlaceRow(stored, height) {
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  let row = stored;
  for (let p = 0; p < passes.length; p++) {
    const start = passes[p][0], step = passes[p][1];
    const count = Math.ceil((height - start) / step);
    if (row < count) return start + row * step;
    row -= count;
  }
  return stored;
}

/* decode a whole GIF. Returns { w, h, frames } where every frame is
 * fully composited onto the logical screen — what you'd see if the
 * animation played — with its display duration in ms. Throws an
 * Error with a short message when the bytes aren't a usable GIF. */
function gfDecode(bytes) {
  if (bytes.length < 13 ||
      bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) {  // "GIF"
    throw new Error("not a GIF file");
  }
  const rd = gfReader(bytes);
  rd.skip(6);                                   // "GIF87a" / "GIF89a"
  const W = rd.word(), H = rd.word();           // logical screen size
  if (!(W > 0) || !(H > 0) || W > 8192 || H > 8192) {
    throw new Error("that GIF's header looks wrong");
  }
  const packed = rd.byte();
  rd.skip(1);                                   // background color index
  rd.skip(1);                                   // aspect ratio (unused)
  const gct = (packed & 0x80) ? gfReadPalette(rd, packed & 0x07) : null;

  const canvas = new Uint8ClampedArray(W * H * 4);  // starts transparent
  const frames = [];
  let gce = null;        // graphic control waiting for the next image
  let snapshot = null;   // canvas copy a disposal-3 frame restores to

  for (;;) {
    const tag = rd.byte();
    if (tag === 0x3B || tag === undefined) break;   // ";" trailer, or EOF
    if (tag === 0x21) {                             // extension block
      const label = rd.byte();
      if (label === 0xF9) {                         // graphic control
        rd.byte();                                  // block size (always 4)
        const p = rd.byte();
        const delayCs = rd.word();
        const transIndex = rd.byte();
        rd.byte();                                  // block terminator
        gce = {
          disposal: (p >> 2) & 7,
          transparent: (p & 1) ? transIndex : -1,
          // a stored delay of 0 (or 1) is a lie every browser
          // ignores — they all play it as 100ms, so we report 100
          duration: delayCs < 2 ? 100 : delayCs * 10,
        };
      } else {
        gfSkipBlocks(rd);   // comments, app data (loop count), plain text…
      }
      continue;
    }
    if (tag !== 0x2C) break;                        // unknown byte — bail out

    // image descriptor: where this frame sits on the logical screen
    const fx = rd.word(), fy = rd.word(), fw = rd.word(), fh = rd.word();
    const ipacked = rd.byte();
    let palette = gct;
    if (ipacked & 0x80) palette = gfReadPalette(rd, ipacked & 0x07);
    const interlaced = (ipacked & 0x40) !== 0;
    const minCode = rd.byte();
    const chunks = [];
    for (;;) {
      const n = rd.byte();
      if (!n) break;
      chunks.push(rd.take(n));
    }
    if (!palette || !(fw > 0) || !(fh > 0) || fw * fh > 16777216) break;
    const indices = gfLzwDecode(minCode, chunks, fw * fh);

    const disposal = gce ? gce.disposal : 0;
    const transIndex = gce ? gce.transparent : -1;
    // disposal 3 ("restore to previous") needs the canvas as it was
    // BEFORE this frame — snapshot before painting, not after
    if (disposal === 3) snapshot = canvas.slice();

    // paint the frame's pixels. A pixel whose index is the frame's
    // transparent index leaves the canvas underneath untouched.
    for (let row = 0; row < fh; row++) {
      const y = fy + (interlaced ? gfInterlaceRow(row, fh) : row);
      if (y >= H) continue;
      for (let x = 0; x < fw; x++) {
        const px = fx + x;
        if (px >= W) continue;
        const idx = indices[row * fw + x];
        if (idx === undefined || idx === transIndex) continue;
        const col = palette[idx];
        if (!col) continue;
        const o = (y * W + px) * 4;
        canvas[o] = col[0]; canvas[o + 1] = col[1]; canvas[o + 2] = col[2]; canvas[o + 3] = 255;
      }
    }

    frames.push({ data: canvas.slice(), duration: gce ? gce.duration : 100 });

    // …then dispose of this frame, ready for the next one
    if (disposal === 2) {
      // restore the frame's rect to the background. The spec says
      // "background color", but browsers composite GIFs over
      // transparency — and a sprite sheet wants the alpha — so the
      // rect goes back to fully transparent.
      for (let y = fy; y < fy + fh && y < H; y++) {
        for (let x = fx; x < fx + fw && x < W; x++) {
          const o = (y * W + x) * 4;
          canvas[o] = canvas[o + 1] = canvas[o + 2] = canvas[o + 3] = 0;
        }
      }
    } else if (disposal === 3 && snapshot) {
      canvas.set(snapshot);
    }
    gce = null;
  }

  if (!frames.length) throw new Error("no frames found in that GIF");
  return { w: W, h: H, frames };
}

/* grid math for the sheet, shared by the preview, both exports and
 * the readout — what you see is what you download. Auto columns =
 * the near-square grid (same rule as the Atlas packer). */
function gfLayout(count, frameW, frameH, cols, autoCols) {
  const c = autoCols ? Math.max(1, Math.ceil(Math.sqrt(count))) : Math.max(1, cols | 0);
  const rows = Math.max(1, Math.ceil(count / c));
  return { cols: c, rows, sheetW: c * frameW, sheetH: rows * frameH };
}

/* lay every composited frame into one sheet canvas */
function gfSheetCanvas() {
  const G = gfState();
  const lay = gfLayout(G.frames.length, G.frameW, G.frameH, G.cols, G.autoCols);
  const cv = document.createElement("canvas");
  cv.width = lay.sheetW; cv.height = lay.sheetH;
  const cx = cv.getContext("2d");
  G.frames.forEach((f, i) => {
    const cell = document.createElement("canvas");
    cell.width = G.frameW; cell.height = G.frameH;
    cell.getContext("2d").putImageData(new ImageData(f.data, G.frameW, G.frameH), 0, 0);
    cx.drawImage(cell, (i % lay.cols) * G.frameW, Math.floor(i / lay.cols) * G.frameH);
  });
  return { cv, lay };
}

function gfDraw() {
  const G = gfState();
  const view = $("#gfCanvas");
  if (!view || !G.frames.length) return;
  const built = gfSheetCanvas();
  view.width = built.lay.sheetW;
  view.height = built.lay.sheetH;
  view.getContext("2d").drawImage(built.cv, 0, 0);
  gfStatus(G.frames.length + (G.frames.length === 1 ? " frame" : " frames") +
    " · " + G.frameW + "x" + G.frameH + " each · sheet " +
    built.lay.sheetW + "x" + built.lay.sheetH);
}

/* bring a GIF in (file, paste, drop or the sample). A new GIF
 * replaces the old sheet wholesale — frames from two animations
 * never mix. */
function gfLoadBytes(buf, name) {
  const G = gfState();
  let decoded;
  try {
    decoded = gfDecode(new Uint8Array(buf));
  } catch (err) {
    gfStatus("couldn't decode that GIF — " + humanErr(err) + ".");
    return;
  }
  G.frames = decoded.frames;
  G.frameW = decoded.w; G.frameH = decoded.h;
  G.name = name || "animation";
  const empty = $("#gfEmpty");
  if (empty) empty.hidden = true;
  const gfExp = $("#gfExport"), gfJ = $("#gfJson");
  if (gfExp) gfExp.disabled = false;
  if (gfJ) gfJ.disabled = false;
  gfDraw();
}

async function gfLoadFile(file) {
  if (!file) return;
  try {
    gfLoadBytes(await file.arrayBuffer(), (file.name || "animation").replace(/\.gif$/i, ""));
  } catch (err) {
    gfStatus("couldn't read that file.");
  }
}

/* the sample bounces in a separate file next to the AI models — it
 * ships with the site, so a miss here means the deploy is behind,
 * not that the visitor did anything wrong */
async function gfLoadSample() {
  try {
    const res = await fetch("assets/samples/sample-bounce.gif");
    if (!res.ok) throw new Error("missing");
    gfLoadBytes(await res.arrayBuffer(), "sample bounce");
  } catch (err) {
    gfStatus("the sample GIF isn't on the server yet — drop any animated GIF here instead.");
  }
}

function gfExportPNG() {
  const G = gfState();
  if (!G.frames.length) { gfStatus("Load a GIF or the sample first."); return; }
  const built = gfSheetCanvas();
  downloadCanvas(built.cv, "m4ster-gifsheet-" + built.lay.sheetW + "x" + built.lay.sheetH + ".png");
}

function gfExportJSON() {
  const G = gfState();
  if (!G.frames.length) { gfStatus("Load a GIF or the sample first."); return; }
  const lay = gfLayout(G.frames.length, G.frameW, G.frameH, G.cols, G.autoCols);
  downloadJSON({
    frames: G.frames.map((f, i) => ({
      x: (i % lay.cols) * G.frameW,
      y: Math.floor(i / lay.cols) * G.frameH,
      w: G.frameW, h: G.frameH,
      duration: f.duration,
    })),
    meta: {
      frameCount: G.frames.length,
      frameSize: { w: G.frameW, h: G.frameH },
      sheetSize: { w: lay.sheetW, h: lay.sheetH },
    },
  }, "m4ster-gifsheet.json");
}

/* ---------------- GIF Sheet wiring ---------------- */

let gfStaticWired = false;

function gfWireStage() {
  const box = $("#gfStageBox");
  if (box) {
    ["dragenter", "dragover"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.add("gf-over");
    }));
    ["dragleave", "drop"].forEach(ev => box.addEventListener(ev, (e) => {
      e.preventDefault();
      box.classList.remove("gf-over");
    }));
    box.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) gfLoadFile(f);
    });
  }
  // paste a GIF while the GIF Sheet lane is open
  document.addEventListener("paste", (e) => {
    if (state.category !== "gif") return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) { gfLoadFile(f); e.preventDefault(); break; }
      }
    }
  });
}

function wireGif() {
  const G = gfState();
  $("#gfSample").onclick = gfLoadSample;
  $("#gfPick").onclick = () => $("#gfFile").click();
  $("#gfFile").onchange = (e) => {
    gfLoadFile(e.target.files[0]);
    e.target.value = "";
  };
  const auto = $("#gfAuto");
  if (auto) auto.onchange = () => {
    G.autoCols = auto.checked;
    const c = $("#gfCols");
    if (c) c.disabled = G.autoCols;
    gfDraw();
  };
  const cols = $("#gfCols");
  if (cols) cols.onchange = () => {
    G.cols = Math.max(1, Math.min(64, +cols.value || 1));
    cols.value = G.cols;
    gfDraw();
  };
  $("#gfExport").onclick = gfExportPNG;
  $("#gfJson").onclick = gfExportJSON;
  $("#gfExport").disabled = $("#gfJson").disabled = !gfState().frames.length;
  if (!gfStaticWired) {
    gfStaticWired = true;
    gfWireStage();
  }
  if (G.frames.length) gfDraw();
  syncGifMode();
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
  syncDraglabMode();
  syncCutoutMode();
  syncUpscaleMode();
  syncAtlasMode();
  syncNormalmapMode();
  syncTilerMode();
  syncPaletteMode();
  syncGifMode();

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
      syncDraglabMode();
      syncCutoutMode();
      syncUpscaleMode();
      syncAtlasMode();
      syncNormalmapMode();
      syncTilerMode();
      syncPaletteMode();
      syncGifMode();
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
  $("#procBtnRetry").onclick = () => {
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

    /* master Animations switch: flips the .anim-off class the head
     * script set from this same key, persists "1" = on / "0" = off, and
     * starts/stops the showcase loop to match (the trail + aura loops
     * read the class live). aria-checked drives the switch visual,
     * exactly like the sibling switches. */
    var animBtn = document.getElementById("animToggle");
    var applyAnim = function () {
      if (animBtn) animBtn.setAttribute("aria-checked", animationsOn() ? "true" : "false");
    };
    if (animBtn) animBtn.addEventListener("click", function () {
      var off = document.documentElement.classList.toggle("anim-off");
      lsSet("m4ster.animations", off ? "0" : "1");
      applyAnim();
      if (off) showcaseStop(); else showcaseStart();
    });
    applyAnim();

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
        lsSet("m4ster.animations", animationsOn() ? "1" : "0");
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

/* master Animations switch (Customize): the head script puts .anim-off on
 * <html> unless localStorage "m4ster.animations" === "1", so animations
 * are OFF by default and this returns false. Decorative loops (cursor
 * trail, showcase, aura parallax) check it; content playback never does. */
function animationsOn() {
  return !document.documentElement.classList.contains("anim-off");
}

function drawShowcaseFrame(a) {
  const ctx = a.ctx || (a.ctx = a.cv.getContext("2d"));   // cached at add time below
  const f = a.frames[a.idx % a.frames.length];
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, a.cv.width, a.cv.height);
  const s = Math.min(a.cv.width / f.width, a.cv.height / f.height);
  const dw = Math.max(1, Math.floor(f.width * s)), dh = Math.max(1, Math.floor(f.height * s));
  ctx.drawImage(f, Math.floor((a.cv.width - dw) / 2), Math.floor((a.cv.height - dh) / 2), dw, dh);
}

/* perf: one IntersectionObserver watches every showcase canvas (they live
 * in separate sections — gallery + presets — so per-canvas is the honest
 * gate); the shared loop idles to a stop while none of them is on screen
 * and restarts the moment one scrolls back into view. */
let showcaseIO = null;
function showcaseWatch(a) {
  if (!("IntersectionObserver" in window)) { a.visible = true; return; }
  if (!showcaseIO) {
    showcaseIO = new IntersectionObserver((entries) => {
      let any = false;
      for (const e of entries) {
        const anim = showcaseAnims.find((x) => x.cv === e.target);
        if (anim) anim.visible = e.isIntersecting;
        if (e.isIntersecting) any = true;
      }
      if (any) showcaseStart();
    });
  }
  showcaseIO.observe(a.cv);
}

function showcaseAdd(cv, frames, fps) {
  const a = { cv, ctx: cv.getContext("2d"), frames, fps: fps || 8, idx: 0, last: 0, visible: true };
  drawShowcaseFrame(a);
  showcaseAnims.push(a);
  showcaseWatch(a);
  showcaseStart();   // no-op while animations are off / reduced-motion / already running
}

function showcaseLoop(now) {
  let anyVisible = false;
  try {
    for (const a of showcaseAnims) {
      if (a.visible === false) continue;
      anyVisible = true;
      if (now - a.last < 1000 / a.fps) continue;
      a.last = now;
      a.idx = (a.idx + 1) % a.frames.length;
      drawShowcaseFrame(a);
    }
  } finally {
    /* nothing on screen: park the loop instead of redrawing blind — the
     * observer restarts it via showcaseStart when a canvas reappears */
    showcaseRAF = anyVisible ? requestAnimationFrame(showcaseLoop) : 0;
  }
}

function showcaseStart() {
  if (reduceMotion() || showcaseRAF || !animationsOn()) return;
  showcaseRAF = requestAnimationFrame(showcaseLoop);
}

function showcaseStop() {
  if (showcaseRAF) cancelAnimationFrame(showcaseRAF);
  showcaseRAF = 0;
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
      syncDraglabMode();
      syncCutoutMode();
      syncUpscaleMode();
      syncAtlasMode();
      syncNormalmapMode();
      syncTilerMode();
      syncPaletteMode();
      syncGifMode();
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
        } catch (e) { stageMsg("GIF encode failed: " + humanErr(e), true); }
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
    if (ticking || reduceMotion() || !animationsOn() || !aura) return;
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
  /* perf: the trail glow is pre-rendered ONCE into a sprite at the max
   * radius (90px) instead of building a fresh radial gradient per spot
   * per frame. The sprite's stops are exactly the ones the per-spot
   * gradient used at k = 1 — stop 0 "rgba(glow,0.280)", stop 1
   * "rgba(glow,0)" — and each spot's fade is applied with globalAlpha = k
   * while the sprite is drawn scaled to the spot's radius, which is the
   * same falloff the old gradient produced. Repainted on theme change. */
  var TR_MAX_R = 90;
  var trailSprite = document.createElement("canvas");
  trailSprite.width = trailSprite.height = TR_MAX_R * 2;
  var trailSpriteCtx = trailSprite.getContext("2d");
  function paintTrailSprite() {
    if (!trailSpriteCtx) return;
    trailSpriteCtx.clearRect(0, 0, TR_MAX_R * 2, TR_MAX_R * 2);
    var g = trailSpriteCtx.createRadialGradient(TR_MAX_R, TR_MAX_R, 0, TR_MAX_R, TR_MAX_R, TR_MAX_R);
    g.addColorStop(0, "rgba(" + themeGlow + "," + (0.28 * 1).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + themeGlow + ",0)");
    trailSpriteCtx.fillStyle = g;
    trailSpriteCtx.fillRect(0, 0, TR_MAX_R * 2, TR_MAX_R * 2);
  }
  function syncThemeGlow(){
    try{
      var v = getComputedStyle(document.documentElement).getPropertyValue("--violet").trim();
      var m = v.match(/^#([0-9a-f]{6})$/i);
      if(m){ var n = parseInt(m[1], 16); themeGlow = ((n>>16)&255) + "," + ((n>>8)&255) + "," + (n&255); }
    }catch(e){}
    paintTrailSprite();
  }
  syncThemeGlow();
  try{ new MutationObserver(syncThemeGlow).observe(document.documentElement, {attributes:true, attributeFilter:["data-theme"]}); }catch(e){}
  function drawTrail(now) {
    tctx.clearRect(0, 0, trail.width, trail.height);
    for (var i = spots.length - 1; i >= 0; i--) {
      var s = spots[i], age = now - s.born;
      if (age > TR_LIFE) { spots.splice(i, 1); continue; }
      var k = 1 - age / TR_LIFE, r = 90 * (0.5 + 0.5 * k);
      tctx.globalAlpha = k;
      tctx.drawImage(trailSprite, s.x - r, s.y - r, r * 2, r * 2);
    }
    tctx.globalAlpha = 1;
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
    if (animationsOn() && now - trLast >= TR_GAP) {   // no trail spots while animations are off
      trLast = now;
      spots.push({ x: e.clientX, y: e.clientY, born: now });
      if (spots.length > TR_MAX) spots.splice(0, spots.length - TR_MAX);
    }
    pokeTick();   // wake the orb loop if it parked itself while idle
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
  /* perf: the loop parks itself once nothing it drives can change any
   * more — orb settled on the pointer, aura parallax converged, no live
   * trail spots. A parked frame would have written nothing anyway (the
   * old loop only re-cleared an already-clear trail canvas), so parking
   * is invisible; the next pointermove (or a return to the tab) re-arms
   * it via pokeTick. */
  var tickLive = false;
  function pokeTick() {
    if (tickLive) return;
    tickLive = true;
    requestAnimationFrame(runTick);
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) pokeTick();
  });
  function runTick() {
    var again = false;
    try { again = tickFrame(); }
    catch (e) { again = true; /* a trail failure must never freeze the orb */ }
    if (again) requestAnimationFrame(runTick);
    else tickLive = false;
  }
  function tickFrame() {
    if (document.hidden) return true;   // hidden tab: stay armed, do no work
    /* tight follow (was 0.22 — felt floaty) + snap when converged, so the
     * loop writes nothing once the orb settles instead of micro-lerping */
    var dx = tx - x, dy = ty - y;
    if (dx * dx + dy * dy < 0.01) { x = tx; y = ty; }
    else { x += dx * 0.45; y += dy * 0.45; }
    var k = x.toFixed(1) + "," + y.toFixed(1);
    var orbMoved = k !== lastT;
    if (orbMoved) {
      orb.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0)";
      lastT = k;
    }
    /* aura parallax: direct composited transform on the aura layer, written
     * only when it changed — the old :root var write forced a full style
     * recalc every frame, which was the jank. Frozen while animations are
     * off (the site rests still); the lerp resumes untouched when back on. */
    var anim = animationsOn();
    var auraMoved = false;
    if (anim) {
      var nx = (tx / window.innerWidth - 0.5) * 2;
      var ny = (ty / window.innerHeight - 0.5) * 2;
      ax += (nx - ax) * 0.08; ay += (ny - ay) * 0.08;
      var ak = (ax * 1.5).toFixed(2) + "," + (ay * 1.5).toFixed(2);
      auraMoved = ak !== lastA;
      if (auraMoved && auraEl) {
        auraEl.style.transform = "translate3d(" + (ax * 1.5).toFixed(2) + "vmax," + (ay * 1.5).toFixed(2) + "vmax,0)";
        lastA = ak;
      }
    }
    /* cursor glow trail (5IN1 GridGlow): fading spots, drawn only while moving */
    if (!anim && spots.length) spots.length = 0;   // toggled off mid-trail: spots die at once
    if (tctx && spots.length) drawTrail(performance.now());
    else if (tctx && trail.width) tctx.clearRect(0, 0, trail.width, trail.height);
    return orbMoved || auraMoved || spots.length > 0;
  }
  pokeTick();
})();

/* v6.9: PWA — Install App button (Download section only). The service
 * worker itself is registered once by the guarded block in index.html
 * (updateViaCache "none" + one-time reload on controller change). */
(function () {
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
/* Upload prep: phone photos arrive at 3–5 MB and every provider in the
 * chain re-uploads the file from scratch, so one big photo costs that
 * upload up to five times. Anything over the gate is redrawn once, here,
 * at at most 1024px on the long edge — plenty for image-to-3D — and the
 * whole chain then shares the small copy. Pure decision helpers first,
 * so the gate math is testable without a DOM. */
const M3_UPLOAD_MAX_BYTES = 900 * 1024;
const M3_UPLOAD_MAX_EDGE = 1024;
function m3ShrinkDecision(size, width, height) {
  return size > M3_UPLOAD_MAX_BYTES || width > M3_UPLOAD_MAX_EDGE || height > M3_UPLOAD_MAX_EDGE;
}
function m3ShrinkTarget(width, height) {
  const scale = Math.min(1, M3_UPLOAD_MAX_EDGE / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}
async function m3PrepareImage(file) {
  try {
    if (!file || !/^image\//.test(file.type || "")) return file;
    let src = null, srcUrl = null, w = 0, h = 0;
    if (typeof createImageBitmap === "function") {
      try { src = await createImageBitmap(file); w = src.width; h = src.height; }
      catch (e) { src = null; }
    }
    if (!src) {
      srcUrl = URL.createObjectURL(file);
      src = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("could not read that image"));
        img.src = srcUrl;
      });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    const cleanup = () => {
      if (srcUrl) URL.revokeObjectURL(srcUrl);
      if (src && src.close) src.close();
    };
    if (!w || !h || !m3ShrinkDecision(file.size, w, h)) { cleanup(); return file; }
    const t = m3ShrinkTarget(w, h);
    const cv = document.createElement("canvas");
    cv.width = t.w; cv.height = t.h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, t.w, t.h);
    cleanup();
    /* a transparent source must stay PNG; a flat photo goes out as JPEG,
     * which is far smaller for the same pixels */
    let hasAlpha = false;
    try {
      const px = ctx.getImageData(0, 0, t.w, t.h).data;
      for (let i = 3; i < px.length; i += 4) { if (px[i] < 250) { hasAlpha = true; break; } }
    } catch (e) { hasAlpha = true; }
    const type = hasAlpha ? "image/png" : "image/jpeg";
    const blob = await new Promise((res) => cv.toBlob(res, type, type === "image/jpeg" ? 0.87 : undefined));
    if (!blob) return file;
    const base = (file.name || "image").replace(/\.[a-z0-9]+$/i, "");
    return new File([blob], base + (type === "image/png" ? ".png" : ".jpg"), { type: type });
  } catch (e) {
    return file; /* any surprise anywhere: the original goes up untouched */
  }
}
/* join the Gradio queue, then read the SSE stream until process_completed.
 * Resolves with the call's output data array; throws loud on any failure.
 * Optional onEvent({position, eta}) fires on queue "estimation" events —
 * position is 1-based (rank + 1), eta is seconds; either may be null when
 * the provider does not send it. */
async function m3Call(prov, session, fnIndex, data, deadline, onEvent) {
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
        if (evt.msg === "estimation" && onEvent) {
          const pos = typeof evt.queue_position === "number" ? evt.queue_position
            : typeof evt.rank === "number" ? evt.rank + 1 : null;
          const eta = typeof evt.rank_eta === "number" ? evt.rank_eta
            : typeof evt.eta === "number" ? evt.eta : null;
          if (pos !== null || eta !== null) {
            try { onEvent({ position: pos, eta: eta }); } catch (e) { /* a status callback must never break the run */ }
          }
        }
      }
    }
    throw new Error("the queue stream ended before the mesh finished");
  } catch (e) {
    if (e && e.name === "AbortError") throw m3TimeoutErr();
    throw e;
  } finally { clearTimeout(timer); }
}
/* queue-position reporter for m3Call's onEvent: speaks at most once per
 * 5 seconds, and only when the position actually changed. Providers that
 * never send estimation events simply never trigger it. */
function m3QueueSay(say, name) {
  let lastAt = 0, lastPos = null;
  return function (q) {
    if (!q || q.position === null || q.position === undefined) return;
    if (q.position === lastPos) return;
    const now = Date.now();
    if (now - lastAt < 5000) return;
    lastAt = now;
    lastPos = q.position;
    let t = name + " — in the free queue — #" + q.position + " in line";
    if (q.eta !== null && q.eta !== undefined && isFinite(q.eta) && q.eta > 0) {
      t += ", roughly ~" + Math.max(1, Math.round(q.eta)) + "s";
    }
    say(t + "…");
  };
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
  const onQ = m3QueueSay(say, prov.name);
  say("Stable Fast 3D — uploading your image…");
  const fd = m3FileData(prov, await m3Upload(prov, file, deadline), file);
  say("Stable Fast 3D — checking the background…");
  const step1 = await m3Call(prov, session, 4, [fd, 0.85], deadline, onQ);
  const btn = step1 && step1[0];
  const btnVal = btn && typeof btn === "object" ? btn.value : btn;
  if (btnVal === "Remove Background") {
    say("Stable Fast 3D — removing the background…");
    await m3Call(prov, session, 5, ["Remove Background", fd, null, 0.85, "None", -1, 1024], deadline, onQ);
  }
  say("Stable Fast 3D — building your mesh (usually ~10 seconds)…");
  const step3 = await m3Call(prov, session, 5, ["Run", fd, null, 0.85, "None", -1, 1024], deadline, onQ);
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
  const onQ = m3QueueSay(say, prov.name);
  say("InstantMesh — uploading your image…");
  const fd = m3FileData(prov, await m3Upload(prov, file, deadline), file);
  say("InstantMesh — preparing the image…");
  const pre = await m3Call(prov, session, 2, [fd, true], deadline, onQ);
  const processed = pre && pre[0];
  if (!processed) throw new Error("InstantMesh preprocessing returned no image");
  say("InstantMesh — dreaming up six views of your subject…");
  const mvs = await m3Call(prov, session, 3, [processed, 75, 42], deadline, onQ);
  const showImg = mvs && mvs[1];
  if (!showImg) throw new Error("InstantMesh returned no multiview image");
  say("InstantMesh — building your mesh…");
  const made = await m3Call(prov, session, 4, [showImg], deadline, onQ);
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
  const onQ = m3QueueSay(say, prov.name);
  say("TRELLIS.2 — starting a session on the free GPU…");
  await m3Call(prov, session, 2, [], deadline, onQ);
  say("TRELLIS.2 — uploading your image…");
  const fd = m3FileData(prov, await m3Upload(prov, file, deadline), file);
  say("TRELLIS.2 — removing the background…");
  const pre = await m3Call(prov, session, 4, [fd], deadline, onQ);
  const processed = pre && pre[0];
  if (!processed) throw new Error("TRELLIS.2 preprocessing returned no image");
  say("TRELLIS.2 — building your textured mesh (usually ~1 minute)…");
  await m3Call(prov, session, 7, [processed, 0, "1024", 7.5, 0.7, 12, 5.0, 7.5, 0.5, 12, 3.0, 1.0, 0.0, 12, 3.0], deadline, onQ);
  say("TRELLIS.2 — packing the GLB…");
  const made = await m3Call(prov, session, 9, [null, 300000, (typeof window !== "undefined" && window.M3_TEXSIZE) || 2048], deadline, onQ);
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
  const onQ = m3QueueSay(say, prov.name);
  say("TRELLIS (community) — starting a session on the free GPU…");
  await m3Call(prov, session, 4, [], deadline, onQ);
  say("TRELLIS (community) — uploading your image…");
  const fd = m3FileData(prov, await m3Upload(prov, file, deadline), file);
  say("TRELLIS (community) — removing the background…");
  const pre = await m3Call(prov, session, 8, [fd], deadline, onQ);
  const processed = pre && pre[0];
  if (!processed) throw new Error("TRELLIS (community) preprocessing returned no image");
  say("TRELLIS (community) — building your mesh (usually ~1 minute)…");
  const made = await m3Call(prov, session, 11, [processed, [], null, 0, 7.5, 12, 3.0, 12, "stochastic", 0.95, 1024], deadline, onQ);
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
  const onQ = m3QueueSay(say, prov.name);
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
  const made = await m3Call(prov, session, 4, [null, fd, null, null, null, null, 5, 5.0, 1234, 256, true, 8000, true], deadline, onQ);
  const rawFd = made && made[0];
  const glbFd = rawFd && typeof rawFd === "object" && "value" in rawFd ? rawFd.value : rawFd;
  const url = m3FileUrl(prov, glbFd);
  if (!url) throw new Error("Hunyuan3D-2 Mini Turbo finished but returned no mesh file");
  say("Hunyuan3D-2 Mini Turbo — downloading your mesh…");
  return { glb: await m3FetchBlob(url, deadline), obj: null };
}

/* True text→mesh on the same Mini Turbo call: the prompt goes in slot 0
 * and every image slot stays null, so no image is drawn or uploaded at
 * all — the model builds the shape from the words alone. Same output
 * shape as image mode (GLB in output[0], same {value} unwrap), and the
 * same caveat: SHAPE ONLY, the mesh comes out untextured. (The full
 * Hunyuan3D-2 space was trialled for this on 2026-10-30 and cannot
 * serve it — its deployment answers "Text to 3D is disable", so the
 * mini space is the only direct route.) */
async function m3RunHunyuanText(prompt, say) {
  const prov = M3_PROVIDERS["hunyuan-mini"], session = m3Session();
  const deadline = Date.now() + M3_TIMEOUT_MS;
  const onQ = m3QueueSay(say, prov.name);
  say("Hunyuan3D-2 Mini Turbo — building your mesh straight from your words (shape only, untextured)…");
  const made = await m3Call(prov, session, 4, [prompt, null, null, null, null, null, 5, 5.0, 1234, 256, true, 8000, true], deadline, onQ);
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
  const shortErr = (e) => humanErr(e);
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
    /* perf: per-frame scratch vectors for the zoom easing + gizmo pass —
     * the tick used to clone() two fresh Vector3s every frame */
    const _m3ZoomOff = new THREE.Vector3();
    const _m3GizmoDir = new THREE.Vector3();
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
        const off = _m3ZoomOff.copy(m3three.camera.position).sub(m3three.controls.target);
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
        const dir = _m3GizmoDir.copy(camera.position).sub(controls.target).normalize();
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
      if (cs && !cs.textContent) cs.textContent = "One click: your words go straight to a text-to-3D model. Direct meshes are shape-only (untextured).";
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
  const bridgeGuide = document.getElementById("m3BridgeGuide");
  if (bridgeGuide) bridgeGuide.addEventListener("click", () => {
    downloadBytes(new TextEncoder().encode(MESH_README), "framelab-mesh-import-guide.txt", "text/plain");
  });
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

  async function runOne(id, f) {
    const useFile = f || file;
    if (id === "sf3d") return m3RunSF3D(useFile, say);
    if (id === "trellis2") return m3RunTrellis2(useFile, say);
    if (id === "trellis") return m3RunTrellis(useFile, say);
    if (id === "hunyuan-mini") return m3RunHunyuanMini(useFile, say);
    return m3RunInstantMesh(useFile, say);
  }

  /* one presentation path for every finished mesh — download links,
   * sizes, the result note, the viewer — whoever built the mesh */
  function presentResult(out, usedName, usedId, secs) {
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
  }
  /* the Text to 3D direct route lands here — same reset the Generate
   * button does at run start, then the shared presentation */
  window.M3_SHOW_RESULT = function (out, usedName, usedId, secs) {
    result.hidden = true;
    hideGlbPreview();
    objUrls.forEach((u) => URL.revokeObjectURL(u));
    objUrls = [];
    presentResult(out, usedName, usedId, secs);
  };

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
      /* shrink a big photo ONCE, before the chain starts: every provider
       * — and every AUTO fallback after it — uploads this same copy */
      const runFile = await m3PrepareImage(file);
      if (runFile !== file) {
        say("Big photo — shrunk a copy first so the upload is fast. Every model gets the smaller file.");
        /* hold the note for a beat, like the chain announcements below */
        await new Promise((r) => setTimeout(r, 900));
      }
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
            out = await runOne(chain[i], runFile);
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
        out = await runOne(mode, runFile);
        usedName = M3_PROVIDERS[mode].name;
        usedId = mode;
      }
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      presentResult(out, usedName, usedId, secs);
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
             document.body.classList.contains("mode-slicer") ||
             document.body.classList.contains("mode-draglab") ||
             document.body.classList.contains("mode-cutout") ||
             document.body.classList.contains("mode-upscale") ||
             document.body.classList.contains("mode-atlas") ||
             document.body.classList.contains("mode-normalmap") ||
             document.body.classList.contains("mode-tiler") ||
             document.body.classList.contains("mode-palette") ||
             document.body.classList.contains("mode-gif"));
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
    } catch (e) { el.textContent = "Split failed in the browser: " + humanErr(e); }
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
    } catch (e) { stEl.textContent = "Export failed: " + humanErr(e); }
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
   * First the direct route: the prompt goes straight to Hunyuan3D-2's
   * text-to-3D call and the mesh lands in the studio viewer — no image
   * is drawn at all, and the mesh is shape-only (untextured). Only if
   * the direct route cannot answer does the classic route run: the
   * studio draws the image itself through the same free AI API the 2D
   * side uses, then builds the mesh from it. Either way the 2D wizard
   * is never opened, flipped to, or borrowed, and its rows are never
   * touched. Steps live in the panel: 1 Describe, 2 Build mesh. */
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
    const t0 = Date.now();
    try {
      /* faces die on Smart: it routes AUTO to InstantMesh first. Text
       * prompts are characters and detailed objects — build them on
       * High Detail. The toggle is right there to switch to Smart. */
      if (window.M3_SMART_TOPO) { const hd = $("m3TopoDetail"); if (hd) hd.click(); }
      t3dStep(2);
      /* same token rule as the Generate button: the saved HF token (if
       * any) is read once at run start and rides the direct calls */
      try { M3_TOKEN = (aiKeys().huggingface || "").trim(); } catch (e) {}
      try {
        const direct = await m3RunHunyuanText(text, (t) => t3dStatus(t));
        const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
        if (window.M3_SHOW_RESULT) window.M3_SHOW_RESULT(direct, "Hunyuan3D-2 Mini Turbo", "hunyuan-mini", secs);
        t3dStep(3);
        t3dStatus("Done — built straight from your words by Hunyuan3D-2 Mini Turbo. Shape only: the mesh is untextured, ready for your own materials.");
        return;
      } catch (directErr) {
        t3dStatus("The direct text-to-mesh route could not answer (" + humanErr(directErr).slice(0, 120) + ") — falling back: drawing an image from your words first, then building the mesh from it…");
        /* hold the note for a beat so it can be read before the
         * fallback's own statuses take over the line */
        await new Promise((r) => setTimeout(r, 1200));
      }
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
      t3dStatus("Text to 3D stopped: " + humanErr(e));
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
    if (sk) sk.textContent = "Skill running in the 3D studio — words straight to a mesh, all automatic.";
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
    if (document.hidden) return;
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
