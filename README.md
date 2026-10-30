# m4ster FrameLab

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Live site](https://img.shields.io/badge/live-m4ster--framelab.vercel.app-blue)](https://m4ster-framelab.vercel.app)

![FrameLab — free 2D sprites and 3D meshes in your browser](assets/framelab-hero.gif)

**For the gamers, by the gamers.**

Free, open-source, unlimited 2D sprite + 3D mesh studio. No signup, no credit
card, no payments — ever. The procedural generator, the pixel converter
and the slicer run 100% in your browser, offline. AI generation does not:
your prompts (and any image you send for 3D) go to the provider you pick —
AI Horde's community GPUs, a free Hugging Face Space, or Pollinations.
No API keys needed for the free lanes. If you paste in your own free key,
it lives only in your browser's localStorage and is sent only to that
provider — never to us, because there is no server on our side.
(Repo renamed to `m4ster-framelab` on 2026-10-22 — the old `m4ster-sprite-gen` URL redirects here.)

Type what you want in the big prompt box and hit **MAKE IT** — or pick a
category card, a motion preset, or a gallery piece. You get a packed sprite
sheet PNG plus an atlas manifest JSON your game can read directly.

## See it in action

![2D wizard — describe it, get a sprite sheet](assets/framelab-2d-wizard.gif)

![Text to 3D — words straight to a mesh](assets/framelab-3d-mesh.gif)

## v8.3 — Cutout Lab: AI background removal, in your browser

A new standalone tool next to the Slicer, Pixel Converter and DragLab:
drop in any photo and Cutout Lab removes its background — the AI runs
100% in your browser (onnxruntime-web, WebGPU when available, WASM
otherwise). The model downloads once (about 4.4 MB) and is cached;
photos never leave the device. No uploads, no login, no server. Cut and
feather sliders refine the edge live, then export a transparent PNG.
Model credit: U-2-Net (`u2netp`) via the rembg project — Apache-2.0.

## v8.1 — Text to 3D goes direct

The Text tab no longer draws a 2D image first. Your words go straight to
TRELLIS.2 Text-to-3D (free HF Space) and the mesh loads into the stage.
Steps are just 1 Describe, 2 Build mesh. The 2D side is never touched.
Promoted from the test build, where it ran live since 2026-10-22.

## v8.0 — FULL HUB PROMOTION

Everything the test build proved is now production:

- **2D**: the full AI Horde roster (~20 ranked models incl. Ghibli, Pixel,
  RealVisXL), **HF Space FLUX.1-schnell** (`space-flux`) — anonymous stills in
  ~5s at 1024px with near-perfect flat key backgrounds — plus the existing
  Pollinations / HF Inference key slots.
- **3D**: five providers — SF3D, TRELLIS.2, InstantMesh, TRELLIS, and
  **Hunyuan3D-2 Mini Turbo** (fastest shape, ~15s, untextured), with the
  optional free HF token tier and in-browser GLB preview.
- **The Labs**: Animate (rig, text-to-motion, video-to-animation), My Assets
  library, 3D Print panel (mesh health: non-manifold + degenerate counts,
  Split to Print), and Skills — plus the expanded 2D→3D bridge.
- Service worker is now network-first for code (no more stale builds).

Still 100% free: no paywall, no login, no signup. Optional provider keys are
yours, stored only in your browser's localStorage.


## v7.0 — THE HUB

FrameLab is now the hub it was always meant to be: one site, a **2D ⇄ 3D
flip** in the top bar, and free open models on both sides.

- **2D side** — everything from v6.17 plus the AI Studio (action, style
  and perspective cards that drive the generator), a step wizard with
  progress dots, and **AUTO mode**: if a model hits a limit the hub
  switches to the next free one itself.
- **3D Lab (new)** — image → real 3D mesh. Drop an image (or use
  *“Use my 2D character”* to mesh the sprite you just made), pick a
  provider, get a **GLB** that drops straight into Unity / Unreal /
  Godot — previewed in the browser before you download. Providers:
  Stable Fast 3D, InstantMesh, TRELLIS.2 and TRELLIS, all free on
  Hugging Face Spaces; AUTO walks the whole chain when one fails. The
  spaces run on shared free GPUs (ZeroGPU), so an *optional* free
  Hugging Face token raises your quota — stored only in your browser,
  same as every other key here. Still no signup for FrameLab itself,
  no paywall, ever.
- Carries forward: the v6.17 Tools section (Pixel Converter + Sprite
  Slicer), the v6.17.1 slicer wiring fix, the mobile topbar wrap.

## v6.17.1 — slicer wiring fix

A bare-id selector in the slicer's control wiring (`$("slMargin")` for
`$("#slMargin")`) threw on every Slicer open, silently killing the mode
sync and the margin/padding/offset/knockout/fps bindings behind it. The
core upload path bound earlier, so slicing still worked — the layout
mode and half the controls didn't. Fixed and verified end-to-end.

## v6.17 — tools are tools

Pixel Art and Slicer are utilities, not generation types — they're out of
Step 1 ("What are you making?" is Character / Tile / Effect / UI only) and
into their own **Tools** section under the category cards: Pixel Converter
and Sprite Slicer, one tap each, same machinery underneath.

## v6.16 — the lab, redesigned as steps

Frontend only — the pipeline is untouched. The controls now read as a
path: **Step 1** what you're making, **Step 2** source & model (moved up
from the bottom, where it was buried), **Step 3** options (rebuilt as a
labelled grid — states as even chips, frames/style, view/facing and
archetype/palette as proper pairs), **Step 4** describe it, **Step 5**
background key — joined by a rail line, with one unified button scale
throughout. The boosted-prompt debug panel is gone (boosting still
happens, silently). Frames + animation preview now live in one
**Visualizer** panel with a proper filmstrip. Separators changed too:
by default they wear the **active theme's colours** (Ember in, orange
lines everywhere); the full rainbow is a "Rainbow flow" switch in
Customize, alongside the existing on/off, speed and breathing controls.
Status colours (green/amber/red) still override while generating.

## v6.15 — status bars

The RGB separators now report the pipeline state: rainbow while working,
green when a generation finishes, amber when a recovery decision is on the
table, red on failure. Top bar, marquee, footer and the phone's sticky
generate bar all switch together off one CSS variable.

## v6.14 — model list cut to what works

Two providers removed (see the switcher notes below): Sana and OpenRouter.
AI Horde · Deliberate is the default now, and a saved preference for a
removed model falls back to it automatically.

## v6.13 — every frame actually moves

Still + Alive looping motion (idle, walk, run) was built on a lone sine
wave, whose values repeat in pairs — a 6-frame row was really 3 poses shown
twice, at an amplitude too small to see. The loops now mix two frequencies
with phase-shifted bob and sway, so no two frames in a row share a pose and
the motion reads clearly in the preview.

## v6.12 — transparent, honest, simpler

AI still keying rebuilt: the background flood now runs with a drift cap that
adapts to the backdrop, so soft renders no longer lose the character and
gradient backdrops no longer stay glued on (no more whole-picture bobbing) —
and a largest-blob pass strips watermarks and stray marks from the frame. If
a still genuinely can't be separated, the app says so instead of shipping
scraps. State checkboxes are sticky: only the states you check get generated,
and the picks survive tab hops. Export box simplified — bundle, Godot and
Unity up front, the rest under "More exports".

## v6.11 — bigger procedural library

The offline generator grows: a **ghost** archetype (floating sheet body,
rippling wavy hem, drift-based motion for every state, glowing-eye variant),
two new palettes (**royal**, **shadow**), two new tile patterns (**lava** —
animated, its cracks burn brighter on frame two — and **snow**), and two
new effects (**heal** and **portal**). Procedural mode now covers
6 archetypes, 6 palettes, 10 tile patterns, 11 effects and 8 UI kinds —
still 100% offline, still deterministic per seed.

## v6.10 — one-click engine packs

Two new export buttons, each a single ZIP built in the browser:

- **Export for Godot** — the sprite sheet PNG + `animations.tres`, a real
  Godot 4 `SpriteFrames` resource with every animation, fps and loop flag
  set. Drop both files in a project, point an `AnimatedSprite2D` at the
  `.tres`, press play.
- **Export for Unity** — the sheet PNG with a pre-sliced `.png.meta`, a
  `framelab-unity.json` sidecar, and `FrameLabAnimBuilder.cs`. Drop the
  pack in Assets (script inside an `Editor` folder), run
  **FrameLab > Build Animation Clips**, and get one `.anim` per animation
  plus a ready AnimatorController. The builder resolves sprites by name
  inside the editor — the reliable route, since raw `.anim` YAML
  references internal sprite IDs that only Unity can assign.

## v6.9 — Still + Alive: one drawing in, every animation out

Asking an image model for a whole pose strip is how characters end up
sliced across frames. So character generation now defaults to **Still +
Alive**: the model draws exactly ONE character, and FrameLab derives every
animation row from that single drawing with deterministic transforms
anchored at the feet — breathe (squash & stretch) for idle, bob + rock for
walk/run, an arc for jump, a lunge for attack, a decaying shake for hurt,
and a full fall for death. The character can never be cut, merged, or
redesigned between frames, and the whole run costs ONE AI call.

Background removal for stills uses **flood keying** — region-growing from
the image borders — because models rarely honour the exact key colour
(magenta comes back dusty pink, or cream with a vignette). The classic
multi-pose strip flow is still available as "AI strip" in the same panel.

Also fixed: anonymous AI Horde jobs are capped at 512×512 pixels total —
requests are now fitted under that cap instead of being refused (403),
and Horde calls carry a negative prompt against vignettes, borders, and
decorative backdrops.

## v6.8 — AI model switcher

Swap the image model like you swap models in a chat app. Every provider
honours one contract — prompt + size in, one image out — and declares what
it needs up front; a model that can't run says so instead of quietly
downgrading you.

- **Free, no key** — AI Horde · Deliberate (default) / Juggernaut XL /
  Stable Diffusion (community GPUs, real model choice, queue-based)
- **Free key, paste once** — Pollinations · FLUX (key from
  enter.pollinations.ai), Hugging Face · FLUX.1 schnell (free HF token)

Removed in v6.14: Pollinations · Sana (soft, washed-out renders that
ignored the brief) and OpenRouter (pay-per-image — a free tool doesn't
need a paid lane).

Keys are stored only in your browser's localStorage and are sent only to
the provider you picked. NVIDIA NIM was evaluated and skipped: its image
endpoint sends no CORS headers, so a browser app can't call it directly.

## v6.6 — dedicated sprite Slicer

The sheet slicer is now a first-class lane, not a buried panel — Unity
sprite-editor style, 100% offline:

- **Live grid overlay** — upload a sheet and see the cut lines drawn right
  on it: numbered cells, cell-size readout (e.g. "80 × 110 px per cell").
  Rows/cols sliders (1–32) redraw the overlay live as you drag.
- **Margin / padding / offset** — sheet borders and cell spacing, like a
  real sprite editor.
- **Auto-detect** — content-based blob detection as the alternative to grid.
- **Numbered piece picker** — click cells in order (order badges, click
  again to deselect and renumber). Empty cells are flagged, not clickable.
- **Animated preview** — picked frames play with fps + loop / once /
  ping-pong, bottom-aligned so walk cycles don't jitter.
- **Background knockout** — alpha, black, white, or your chroma key counts
  as "empty"; optional knockout punches it to transparent.
- **Export** — one button: animation sheet PNG + manifest JSON (v2.2.0,
  `engine: "slicer"`); individual cell PNGs too.

## v6.5 — image → pixel art converter

Upload any image and convert it to pixel art at the dimensions you choose —
side-by-side original vs pixel art. 100% offline,
zero dependencies, your image never leaves the browser.

- **Output sizes** — presets 16 / 32 / 48 / 64 / 96 / 128px, or custom W×H (8–256).
- **Color control** — 2 / 4 / 8 / 16 / 32 / 256 colors via median-cut quantization, or full color.
- **Floyd–Steinberg dithering** toggle for smooth gradients at low color counts.
- **Transparency preserved** — alpha is never quantized; transparent stays transparent.
- **Crisp preview** — nearest-neighbor upscale only, never blurry; adjustable ×2–×16.
- **One-button export** — pixel-art PNG at a crisp ×8 nearest-neighbor upscale.

## v6.1 — "ALIVE" + reveal fix

- **Fixed: gallery + preset chips now paint.** The v6 scroll-reveal never
  observed the gallery cards or motion preset chips, leaving them stuck at
  `opacity: 0` (blank void under "Fresh from the lab"). The reveal system is
  now progressive-enhanced: default state is visible, reveal only *adds*
  animation — if the observer never fires, content still shows.
- **Living logo** — the pixel M4 mark breathes: glow pulse + gentle float,
  CSS-only (transform/opacity), synced to the aura's calm rhythm. Rests
  under `prefers-reduced-motion`.
- **Entrance choreography** — hero pops in, category cards stagger-pop,
  gallery cards cascade. All under 600ms, skipped under
  `prefers-reduced-motion`.
- **Export bundle stagger** — PNG → GIF → JSON now fire ~400ms apart so
  the browser can't swallow any of the three downloads.

## v6 — "THE MIXTURE"

Ideas borrowed from the best sprite tools, integrated into one app — no login, no
paywall, everything below free forever:

- **Prompt-first hero** — one big "What will you make today?" prompt box.
  Type → MAKE IT → the lab generates.
- **Category cards** — Character / Tile / Effect / UI / Splitter as visual
  cards under the hero. One tap picks a lane and drops you in the lab.
- **Animated gallery** — "Fresh from the lab": moving animated preview
  cards (moving preview, STYLE · FRAME COUNT, prompt underneath). Every card is a live procedural render — click one to open
  that exact setup in the lab.
- **Motion presets** — idle / walk / run / jump / attack with tiny live
  animated previews. One click drives procedural characters (sets the state
  and regenerates) or split animations (sets fps + playback mode:
  loop / once / ping-pong).
- **Export bundle** — one button downloads **sprite-sheet PNG + animated
  GIF preview + manifest JSON** (v2.2.0). Individual PNG/JSON/frames
  buttons remain.
- **Facing flip** — character direction toggle (→ right / ← left), applied
  to preview, atlas, frames, and GIF — non-destructive, like curation.
- **Living UI** — scroll-reveal entrances, scroll parallax on the
  background aura, responsive display type, focus-visible polish.
- **Fully responsive** — phone (stacked, horizontal snap gallery, sticky
  generate bar), tablet, desktop — genuinely different layouts.

## v5 — Sheet Splitter

*(Superseded by the v6.6 dedicated Slicer lane — same engine, proper tool.)*

Upload a whole sprite sheet and the app no longer treats it as one blob:
grid or auto-detect split, background knockout, numbered piece picker,
animated preview, PNG + manifest JSON export.

## v4 — reliability + procedural variety

- **AI retry with backoff** — Pollinations rate-limits anonymous bursts
  (HTTP 402/429). The app now retries 3× (immediate, +3s, +9s) with the
  attempt shown in the pipeline stepper ("Row gen — retry 2/3…"). If all
  retries fail you get an honest amber message (not a dead red error), the
  stale strip is cleared, and the retry bar offers **Retry with stricter
  prompt** plus one-click **Use Procedural instead**.
- **Procedural character archetypes** — biped, quadruped, flyer/bird (real
  wing-flap frames), slime (squash & stretch hops), robot (rigid servo
  angles, blinking visor) — each with 4 palettes (classic, ember, frost,
  toxic) and a ↻ re-roll shuffle button.
- **More tiles** — grass, sand, stone, brick, wood planks, metal plates,
  dungeon, plus animated 2-frame water. All wrap seamlessly (brick's
  edge-clipping bug fixed).
- **More UI elements** — button, icon, panel, plus spinning coin, gem,
  beating heart, twinkling star, and a draining health bar.
- **More effects** — explosion, fire, smoke, sparkle, magic ring, slash
  arc, particles, power-up, magic.

## v3 — "alive" edition

- **Theme switcher** — 6 themes in the tracker's Customize spirit (Violet
  dusk, Midnight, Ocean, Ember, Forest, Porcelain). Swaps CSS variables
  live, no reload, choice persists in `localStorage`.
- **Animated background aura** — three slow-drifting, theme-aware glow
  orbs behind the app (transform/opacity only, never janks the canvas
  pipeline), plus a subtle vignette. Toggle + intensity slider in the
  Customize popover; `prefers-reduced-motion` disables the drift.
- **Alive micro-interactions** — glowing primary button with hover lift,
  satisfying tick-pop on completed pipeline steps, hover lifts on
  cards/tabs, smooth theme transitions. Tasteful, not a rave.

## v2

- **M4-styled UI** — same design language as the portfolio and tracker
  (violet accent, cards, chips), sticky blurred top bar.
- **Dedicated phone layout** — stacked thumb-first flow with a sticky
  bottom Generate button; PC keeps the wide two-panel tool layout.
- **Prompt booster** — one-word prompts ("Zombie") are auto-expanded with
  style / view / palette guidance before hitting the AI. The exact prompt
  sent is shown under "prompt sent to AI" (collapsible).
- **Flat-background enforcement** — stronger prompt language plus a
  key-coverage sanity check: if the model returns a gradient/wash instead
  of a flat key, you get an amber warning + retry instead of silent garbage.
- **Hi-res strips** — AI rows now request ≥1024px wide so frames carry
  usable detail.
- **Slot-slice fallback** — when blob recovery can't find N poses (merged
  strip), the pipeline cuts even slots and continues with an amber warning
  instead of dying. Frames are flagged `slotSliced` in the manifest.
- **Retry with stricter prompt** — one tap re-runs with hard isolation
  instructions appended.

## Live

**https://m4ster-framelab.vercel.app**

## What it generates

| Category | Output |
|---|---|
| **Character** | idle / walk / run / jump / attack states, N frames each — 6 archetypes (biped, quadruped, flyer, slime, robot, ghost) × 6 palettes |
| **Tile** | seamless tileable textures (grass, sand, stone, brick, wood, metal, water, dungeon), with a 3×3 wrap preview |
| **UI** | buttons, icons, panels, coins, gems, hearts, stars, health bars |
| **Effect** | explosions, fire, smoke, sparkles, magic rings, slash arcs, particles, power-ups, magic — frame sequences |

## How it generates (the pipeline)

Every generation walks six visible steps in the UI:

1. **Prompt** — one prompt per animation state, asking for a horizontal
   row-strip of poses on a flat chroma background, one pose per invisible slot.
2. **Row gen** — the image source. **AI** uses whichever model is picked
   in the model switcher (AI Horde, HF Space, Pollinations, Hugging Face);
   **Procedural** is a seeded offline pixel-art generator; **Upload** accepts
   your own strip (any image in, frames out).
3. **Alpha cleanup** — chroma key with a color-distance threshold, plus
   despill with soft alpha on anti-aliased edges so silhouettes stay clean
   instead of getting chewed into a hard cut.
4. **Frame extract** — content-based: flood-fill connected components, take
   the N biggest as pose seeds, sort left-to-right, fit into cells
   (aspect-preserving, never upscaled, feet bottom-aligned). If N poses can't
   be recovered it falls back to **even slot slicing** with an amber warning
   (frames flagged `slotSliced` in the manifest) instead of dying — loud fail
   remains only when the strip has no usable ink at all.
5. **Atlas pack** — one state per row, frames left-to-right, plus a manifest
   JSON with absolute frame rects, per-state fps/durations, and loop flags.
   Your game reads the rects; it never recomputes them.
6. **Done** — animated preview, reorder frames (non-destructive: originals
   are kept untouched, reorder only rewrites manifest order), and export.

Everything after the image call is deterministic: same input pixels give the
same output pixels, every time.

## Export

- `m4ster-sprite-sheet.png` — the packed atlas
- `m4ster-sprite-atlas.json` — manifest (frame rects, fps, durations, loop flags, run revision)
- **Bundle** — one button: sheet PNG + animated GIF preview + manifest JSON (v2.2.0)
- individual frame PNGs (click any frame thumbnail, or bulk download)
- **Splitter:** `m4ster-split-animation.png` + `m4ster-split-animation.json`
  (manifest v2.2.0, `engine: "splitter"`) — one button downloads both

## Using exports in engines

The manifest JSON carries absolute frame rects (`frameLayout.rows.<name>.rects`
as `{x, y, w, h}`) plus per-animation `fps`, `durationsMs`, and `loop`.
Your game reads the rects — never recomputes them.

**Unity** — import the PNG into `Assets/`, select it → Texture Type:
Sprite (2D and UI) → Sprite Mode: Multiple → Apply → open Sprite Editor →
Slice → Grid By Cell Size (or Automatic) → Slice → Apply. Drag sprites into
the scene; match animation order to the manifest's `frameOrder`.

**Godot 4** — import the PNG; in an `AnimatedSprite2D` add a `SpriteFrames`
resource → "Add frames from sprite sheet" (set H/V frames to the atlas
grid). Or in code: `var t := AtlasTexture.new(); t.atlas = load("sheet.png");`
`t.region = Rect2(x, y, w, h)` ← rects straight from the manifest JSON.

**Unreal (Paper 2D)** — import the PNG → right-click → Sprite Actions →
Extract Sprites (grid mode) → select the sprites → right-click → Create
Flipbook → set Frames Per Second from the manifest `fps`. Drop the flipbook
into a Paper Flipbook component; `loop` comes from the manifest too.

## Run it locally

It's a static site — no build step, no dependencies:

```bash
npx serve .
# or
python3 -m http.server
```

## Tech

Vanilla HTML/CSS/JS + Canvas API. Zero frameworks, zero build, zero tracking.

## License

MIT — see [LICENSE](LICENSE).
