/**
 * Edge Noise Brush — Blockbench plugin (Shapescape)
 *
 * Adds two modes to the normal Brush tool, picked from its dropdown:
 *
 * Edge Noise Brush: breaks up straight edges between two tones into steps,
 * using only the colours already on either side. The steps are random or
 * learned from a preset: a PNG with a bright side and a dark side meeting at
 * the jagged edge you want. Presets live in the "edge_noise_presets" folder
 * in Blockbench's user data folder. Going back over a spot in the same stroke
 * grows the brush colour further.
 *
 * Noise Brush: scatters the brush colour over any surface, densest in the
 * middle of the brush and thinning out towards its edge. Going back over a
 * spot in the same stroke fills it in further.
 *
 * Alt picks a colour, as with the normal brush. A panel on the right shows
 * the presets and previews.
 */
(function () {
	'use strict';

	const DEFAULTS = {
		threshold: 4,        // min luminance difference that counts as an edge
		roughness: 60,       // % of segments that get pushed in or out
		step_depth: 1,       // max px a segment moves
		segment_length: 7,   // max segment length along the edge in px
		horizontal: true,    // break up horizontal edges
		vertical: true,      // break up vertical edges
		use_brush_color: true, // only grow the selected paint colour
		color_tolerance: 6,  // how close a pixel must be to the paint colour (0-255 per channel)
		seed: 1,
		follow_stroke: true, // strokes going up/down only break vertical edges, sideways only horizontal
		grow_on_repeat: true, // going back over a spot in one stroke grows it again
		max_growth: 6,       // how many extra growth steps one stroke can add
		preset: '',          // preset name, '' = random steps
		noise_density: 35,   // % of pixels filled in the middle of the brush on the first pass
		noise_falloff: 70,   // % the density drops from the middle to the edge of the brush
		noise_grain: 1,      // size of the noise clumps in px
		noise_seed: 1
	};
	const STORAGE_KEY = 'edge_noise_brush_settings';
	const WEB_PRESETS_KEY = 'edge_noise_brush_presets';
	const PRESET_FOLDER = 'edge_noise_presets';
	const TILE = 16;

	/* ---------- core (pure, testable) ---------- */

	function hash(a, b, c, seed) {
		let h = (seed | 0) ^ Math.imul(a | 0, 0x27d4eb2d);
		h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
		h ^= Math.imul(b | 0, 0x165667b1);
		h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
		h ^= Math.imul(c | 0, 0x9e3779b1);
		h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
		h ^= h >>> 15;
		return (h >>> 0) / 4294967296;
	}

	function lumAt(d, i) {
		return 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
	}

	/** Distance k (1..max) to the first pixel of a different tone, or -1. */
	function scan(d, w, h, x, y, sx, sy, max, thr) {
		const base = lumAt(d, y * w + x);
		for (let k = 1; k <= max; k++) {
			const qx = x + sx * k, qy = y + sy * k;
			if (qx < 0 || qy < 0 || qx >= w || qy >= h) return -1;
			const qi = qy * w + qx;
			if (d[qi * 4 + 3] === 0) return -1;
			if (Math.abs(lumAt(d, qi) - base) > thr) return k;
		}
		return -1;
	}

	function colorMatcher(src, target, tol) {
		const [tr, tg, tb] = target;
		return (i) => src[i * 4 + 3] !== 0 &&
			Math.max(Math.abs(src[i * 4] - tr), Math.abs(src[i * 4 + 1] - tg), Math.abs(src[i * 4 + 2] - tb)) <= tol;
	}

	function copyPixel(src, q, out, i) {
		out[i * 4] = src[q * 4]; out[i * 4 + 1] = src[q * 4 + 1];
		out[i * 4 + 2] = src[q * 4 + 2]; out[i * 4 + 3] = src[q * 4 + 3];
	}

	/*
	 * Every pass below reads its input only along one axis, up to its reach,
	 * so it can run on any rectangle of the image on its own. Each returns
	 * { reach, run(src, out, w, h, x0, y0, x1, y1) }, where run writes the
	 * changed pixels of that rectangle into out.
	 */

	/** Random steps, both tones, on edges perpendicular to axis (dx, dy). */
	function randomPass(s, dx, dy, salt) {
		const thr = s.threshold, seed = (s.seed | 0) + salt * 7919;
		const depth = Math.max(1, s.step_depth | 0);
		const segLen = Math.max(1, s.segment_length | 0);
		const chance = s.roughness / 100;

		// Offset of the edge segment containing u, for the edge at position t0.
		// > 0: the tone before the edge extends past it. < 0: the tone after it extends back.
		function offset(u, t0) {
			const shift = Math.floor(hash(t0, 1, 0, seed) * segLen);
			const cell = Math.floor((u + shift) / segLen);
			const local = u + shift - cell * segLen;
			let sub = 0;
			if (segLen >= 4 && hash(cell, t0, 2, seed) < 0.6) {
				const split = 2 + Math.floor(hash(cell, t0, 3, seed) * (segLen - 3));
				sub = local < split ? 0 : 1;
			}
			if (hash(cell * 2 + sub, t0, 4, seed) >= chance) return 0;
			const mag = 1 + Math.floor(hash(cell * 2 + sub, t0, 5, seed) * depth);
			return hash(cell * 2 + sub, t0, 6, seed) < 0.5 ? mag : -mag;
		}

		return {
			reach: depth,
			run(src, out, w, h, x0, y0, x1, y1) {
				for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
					const i = y * w + x;
					if (src[i * 4 + 3] === 0) continue;
					const t = x * dx + y * dy;
					const u = dx === 0 ? x : y;

					const kBack = scan(src, w, h, x, y, -dx, -dy, depth, thr);
					if (kBack > 0) {
						// p is after an edge; first pixel after the edge is at t - (kBack - 1)
						if (offset(u, t - (kBack - 1)) >= kBack) copyPixel(src, (y - dy * kBack) * w + (x - dx * kBack), out, i);
						continue;
					}
					const kFwd = scan(src, w, h, x, y, dx, dy, depth, thr);
					if (kFwd > 0 && offset(u, t + kFwd) <= -kFwd) copyPixel(src, (y + dy * kFwd) * w + (x + dx * kFwd), out, i);
				}
			}
		};
	}

	/**
	 * Random steps, brush-colour mode: only the chosen colour grows. Wherever a
	 * region of the target colour borders another tone, segments of it step
	 * outward into that tone. The other tone never eats into the target region.
	 */
	function randomTargetPass(s, dx, dy, salt, target) {
		const thr = s.threshold, seed = (s.seed | 0) + salt * 7919;
		const depth = Math.max(1, s.step_depth | 0);
		const segLen = Math.max(1, s.segment_length | 0);
		const chance = s.roughness / 100;

		// How far the target region grows at segment u of edge key e (0 = not at all).
		function growth(u, e) {
			const shift = Math.floor(hash(e, 1, 0, seed) * segLen);
			const cell = Math.floor((u + shift) / segLen);
			const local = u + shift - cell * segLen;
			let sub = 0;
			if (segLen >= 4 && hash(cell, e, 2, seed) < 0.6) {
				const split = 2 + Math.floor(hash(cell, e, 3, seed) * (segLen - 3));
				sub = local < split ? 0 : 1;
			}
			const id = cell * 2 + sub;
			if (hash(id, e, 4, seed) >= chance) return 0;
			return 1 + Math.floor(hash(id, e, 5, seed) * depth);
		}

		return {
			reach: depth,
			run(src, out, w, h, x0, y0, x1, y1) {
				const isTarget = colorMatcher(src, target, s.color_tolerance);
				for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
					const i = y * w + x;
					if (src[i * 4 + 3] === 0 || isTarget(i)) continue;
					const t = x * dx + y * dy;
					const u = dx === 0 ? x : y;
					const li = lumAt(src, i);

					for (const side of [-1, 1]) {
						let found = -1;
						for (let k = 1; k <= depth; k++) {
							const qx = x + side * dx * k, qy = y + side * dy * k;
							if (qx < 0 || qy < 0 || qx >= w || qy >= h) break;
							const qi = qy * w + qx;
							if (src[qi * 4 + 3] === 0) break;
							if (isTarget(qi)) { found = k; break; }
							if (Math.abs(lumAt(src, qi) - li) > thr) break;   // a third tone in between
						}
						if (found < 0) continue;
						// edge key: position of the first non-target pixel next to the edge, plus side
						const e = (t + side * (found - 1)) * 2 + (side > 0 ? 1 : 0);
						if (growth(u, e) >= found) {
							copyPixel(src, (y + side * dy * found) * w + (x + side * dx * found), out, i);
							break;
						}
					}
				}
			}
		};
	}

	/**
	 * Learns the edge pattern from a preset image: a bright side and a dark side
	 * meeting at a jagged edge. The edge may run either way and either side may
	 * be the bright one. Transparent pixels count as the dark side.
	 *
	 * Returns the edge as a mask band, normalised to bright-on-top and running
	 * horizontally: bits[y * period + x] = 1 where the band is bright. Rows
	 * above the band are all bright, rows below it all dark.
	 */
	function parsePreset(data, w, h) {
		const n = w * h;
		const opaque = (i) => data[i * 4 + 3] >= 128;

		// split into two tones: 2-means on luminance
		let lo = Infinity, hi = -Infinity;
		for (let i = 0; i < n; i++) if (opaque(i)) { const l = lumAt(data, i); lo = Math.min(lo, l); hi = Math.max(hi, l); }
		if (!(hi - lo > 1)) throw 'The image needs a bright side and a dark side.';
		let split = (lo + hi) / 2;
		for (let iter = 0; iter < 8; iter++) {
			let sa = 0, ca = 0, sb = 0, cb = 0;
			for (let i = 0; i < n; i++) {
				if (!opaque(i)) continue;
				const l = lumAt(data, i);
				if (l > split) { sa += l; ca++; } else { sb += l; cb++; }
			}
			if (!ca || !cb) break;
			split = (sa / ca + sb / cb) / 2;
		}
		let bright = new Uint8Array(n);
		for (let i = 0; i < n; i++) bright[i] = opaque(i) && lumAt(data, i) > split ? 1 : 0;

		// orientation: a horizontal edge gives many changes down the columns
		let downChanges = 0, acrossChanges = 0;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			if (y + 1 < h && bright[y * w + x] !== bright[(y + 1) * w + x]) downChanges++;
			if (x + 1 < w && bright[y * w + x] !== bright[y * w + x + 1]) acrossChanges++;
		}
		let W = w, H = h;
		if (acrossChanges > downChanges) {
			const t = new Uint8Array(n);
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[x * h + y] = bright[y * w + x];
			bright = t; W = h; H = w;
		}
		// bright side on top
		let top = 0, bottom = 0;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			if (!bright[y * W + x]) continue;
			if (y < H / 2) top++; else bottom++;
		}
		if (bottom > top) {
			const f = new Uint8Array(W * H);
			for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[(H - 1 - y) * W + x] = bright[y * W + x];
			bright = f;
		}

		// the band of rows the edge moves through
		const firstDark = new Int32Array(W), lastBright = new Int32Array(W);
		let anyBright = false, anyDark = false;
		for (let x = 0; x < W; x++) {
			let fd = H, lb = -1;
			for (let y = 0; y < H; y++) {
				if (bright[y * W + x]) { lb = y; anyBright = true; }
				else { if (fd === H) fd = y; anyDark = true; }
			}
			firstDark[x] = fd; lastBright[x] = lb;
		}
		if (!anyBright || !anyDark) throw 'The image needs a bright side and a dark side.';
		let bandTop = H, bandBottom = -1;
		for (let x = 0; x < W; x++) { bandTop = Math.min(bandTop, firstDark[x]); bandBottom = Math.max(bandBottom, lastBright[x]); }
		const bandH = Math.max(0, bandBottom - bandTop + 1);
		const bits = new Uint8Array(W * bandH);
		for (let y = 0; y < bandH; y++) for (let x = 0; x < W; x++) bits[y * W + x] = bright[(y + bandTop) * W + x];

		const sorted = Array.from(firstDark).sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)] - bandTop;
		return {
			period: W,
			height: bandH,
			bits,
			// where the original straight edge sits in the band, per mode:
			base_both: Math.max(0, Math.min(bandH, median)),  // edge moves both ways
			base_bright: 0,                                   // only the bright side grows
			base_dark: bandH                                  // only the dark side grows
		};
	}

	/**
	 * Applies a learned preset to edges perpendicular to axis (dx, dy).
	 * target: [r, g, b] to grow that colour only, or null for both tones.
	 */
	function presetPass(s, dx, dy, P, target) {
		const thr = s.threshold;
		const reach = P.height;
		const phase = (s.seed | 0);

		// Is the preset bright at column u, at row r relative to the edge?
		// r < 0 is the bright side of the original edge, r >= 0 the dark side.
		function brightAt(u, r, base) {
			const y = base + r;
			if (y < 0) return true;
			if (y >= P.height) return false;
			const x = (((u + phase) % P.period) + P.period) % P.period;
			return P.bits[y * P.period + x] === 1;
		}

		return {
			reach,
			run(src, out, w, h, x0, y0, x1, y1) {
				if (!reach) return;
				const isTarget = target ? colorMatcher(src, target, s.color_tolerance) : null;
				for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
					const i = y * w + x;
					if (src[i * 4 + 3] === 0) continue;
					if (isTarget && isTarget(i)) continue;
					const u = dx === 0 ? x : y;

					const kBack = scan(src, w, h, x, y, -dx, -dy, reach, thr);
					const kFwd = scan(src, w, h, x, y, dx, dy, reach, thr);
					// nearest edge first
					let first = 0, second = 0;
					if (kBack > 0 && (kFwd <= 0 || kBack <= kFwd)) { first = -1; second = kFwd > 0 ? 1 : 0; }
					else if (kFwd > 0) { first = 1; second = kBack > 0 ? -1 : 0; }

					for (const side of [first, second]) {
						if (!side) break;
						const k = side < 0 ? kBack : kFwd;
						const q = (y + side * dy * k) * w + (x + side * dx * k);
						if (isTarget && !isTarget(q)) continue;
						const pBright = lumAt(src, i) > lumAt(src, q);
						// in brush-colour mode the target side keeps its ground
						const base = isTarget ? (pBright ? P.base_dark : P.base_bright) : P.base_both;
						const r = pBright ? -k : k - 1;
						if (brightAt(u, r, base) !== pBright) copyPixel(src, q, out, i);
						break;
					}
				}
			}
		};
	}

	/**
	 * A lazily computed image: tiles are only worked out when something asks
	 * for them, so a stroke only pays for the area it touches.
	 */
	function sourceLayer(data, w, h) {
		return { w, h, data, ensure() {} };
	}

	function passLayer(input, pass, dx, dy) {
		const w = input.w, h = input.h;
		const tw = Math.ceil(w / TILE), th = Math.ceil(h / TILE);
		const done = new Uint8Array(tw * th);
		const data = new Uint8ClampedArray(w * h * 4);
		const r = pass.reach;
		return {
			w, h, data,
			ensure(x0, y0, x1, y1) {
				const tx0 = Math.max(0, Math.floor(x0 / TILE)), ty0 = Math.max(0, Math.floor(y0 / TILE));
				const tx1 = Math.min(tw - 1, Math.floor(x1 / TILE)), ty1 = Math.min(th - 1, Math.floor(y1 / TILE));
				for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
					if (done[ty * tw + tx]) continue;
					done[ty * tw + tx] = 1;
					const rx0 = tx * TILE, ry0 = ty * TILE;
					const rx1 = Math.min(w, rx0 + TILE) - 1, ry1 = Math.min(h, ry0 + TILE) - 1;
					input.ensure(rx0 - dx * r, ry0 - dy * r, rx1 + dx * r, ry1 + dy * r);
					for (let y = ry0; y <= ry1; y++) data.set(input.data.subarray((y * w + rx0) * 4, (y * w + rx1 + 1) * 4), (y * w + rx0) * 4);
					pass.run(input.data, data, w, h, rx0, ry0, rx1, ry1);
				}
			}
		};
	}

	/**
	 * Builds the lazy result of one application of the brush on top of input.
	 * level 0 is the first application; higher levels vary the pattern so
	 * repeated growth does not just repeat the same steps.
	 */
	function edgeLayer(input, s, target, preset, level) {
		const sl = level ? Object.assign({}, s, { seed: (s.seed | 0) + level * 1013 }) : s;
		const make = (dx, dy, salt) => preset ? presetPass(sl, dx, dy, preset, target)
			: target ? randomTargetPass(sl, dx, dy, salt, target)
			: randomPass(sl, dx, dy, salt);
		let layer = input;
		if (s.horizontal) layer = passLayer(layer, make(0, 1, 1), 0, 1);
		if (s.vertical) layer = passLayer(layer, make(1, 0, 2), 1, 0);
		return layer;
	}

	/**
	 * Whole-image result, for previews and tests.
	 * target: [r, g, b] to grow that colour only, or null for both tones.
	 * preset: result of parsePreset, or null for random steps.
	 * levels: how many times to apply it (1 = once).
	 */
	function processImage(src, w, h, s, target, preset, levels) {
		let layer = sourceLayer(new Uint8ClampedArray(src), w, h);
		for (let l = 0; l < (levels || 1); l++) layer = edgeLayer(layer, s, target, preset, l);
		layer.ensure(0, 0, w - 1, h - 1);
		return layer.data;
	}

	/* --- noise brush --- */

	function smoothNoise(x, y, cell, seed) {
		const gx = x / cell, gy = y / cell;
		const ix = Math.floor(gx), iy = Math.floor(gy);
		let fx = gx - ix, fy = gy - iy;
		fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
		const a = hash(ix, iy, 11, seed), b = hash(ix + 1, iy, 11, seed);
		const c = hash(ix, iy + 1, 11, seed), d = hash(ix + 1, iy + 1, 11, seed);
		return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
	}

	/**
	 * Per-pixel threshold in 0..1: a pixel is filled once the brush coverage
	 * there passes it. Fixed per pixel, so more coverage only ever adds pixels.
	 */
	function noiseThreshold(x, y, s) {
		const seed = (s.noise_seed | 0) * 31 + 7;
		const g = Math.max(1, s.noise_grain | 0);
		const white = hash(x, y, 13, seed);
		if (g <= 1) return white;
		// stretch the smooth noise back towards an even spread, then roughen its edges
		const v = (smoothNoise(x, y, g, seed) - 0.5) * 1.8 + 0.5;
		return Math.max(0, Math.min(1, v * 0.8 + white * 0.2));
	}

	/** Coverage one pass of the brush gives a pixel at distance d (0 = centre, 1 = edge). */
	function noiseCoverage(s, d, localOpacity) {
		const density = Math.max(0, Math.min(1, s.noise_density / 100));
		const falloff = Math.max(0, Math.min(1, s.noise_falloff / 100));
		const dd = Math.max(0, Math.min(1, d));
		return density * (1 - falloff * dd * dd) * localOpacity;
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { processImage, parsePreset, sourceLayer, edgeLayer, noiseThreshold, noiseCoverage, DEFAULTS };
	}
	if (typeof Plugin === 'undefined') return;

	/* ---------- Blockbench integration ---------- */

	let settings = Object.assign({}, DEFAULTS);
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		for (const key in DEFAULTS) if (key in stored) settings[key] = stored[key];
	} catch (e) {}
	function saveSettings() {
		try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
	}

	const MODES = {
		edge: { name: 'Edge Noise Brush', icon: 'grain' },
		noise: { name: 'Noise Brush', icon: 'blur_on' }
	};
	let activeMode = null;   // null = normal brush, 'edge' or 'noise'
	let cache = null;        // per-stroke state, rebuilt at stroke start
	let settingsAction, panel;
	let original = null;
	const listeners = [];
	const STROKE_STEP = 3;   // px the brush moves before the stroke direction is known
	const REENTRY_GAP = 3;   // brush steps a pixel must be left alone before a return counts as a new pass

	const clearCache = () => { cache = null; };

	/* --- presets --- */

	// { name, url (data URL), parsed, error }
	let presets = [];
	let presetFs = null, presetDir = null, path = null;

	function presetFolder() {
		if (presetDir) return presetDir;
		if (typeof SystemInfo === 'undefined' || !SystemInfo.user_data_directory) return null;
		path = path || requireNativeModule('path');
		presetDir = path.join(SystemInfo.user_data_directory, PRESET_FOLDER);
		return presetDir;
	}

	/** Scoped file system for the preset folder, asking for permission if needed. */
	function getPresetFs(ask) {
		if (presetFs) return presetFs;
		if (!isApp || typeof requireNativeModule !== 'function') return null;
		const dir = presetFolder();
		if (!dir) return null;
		presetFs = requireNativeModule('fs', {
			scope: dir,
			message: 'Stores Edge Noise Brush presets in their own folder.',
			show_permission_dialog: !!ask
		}) || null;
		if (presetFs && !presetFs.existsSync(dir)) presetFs.mkdirSync(dir, { recursive: true });
		return presetFs;
	}

	function loadImageData(url) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const c = document.createElement('canvas');
				c.width = img.naturalWidth; c.height = img.naturalHeight;
				const ctx = c.getContext('2d');
				ctx.drawImage(img, 0, 0);
				resolve(ctx.getImageData(0, 0, c.width, c.height));
			};
			img.onerror = () => reject('Could not read the image.');
			img.src = url;
		});
	}

	async function makePreset(name, url) {
		const preset = { name, url, parsed: null, error: '' };
		try {
			const img = await loadImageData(url);
			preset.parsed = parsePreset(img.data, img.width, img.height);
		} catch (e) {
			preset.error = String(e);
		}
		return preset;
	}

	function readWebPresets() {
		try {
			const list = JSON.parse(localStorage.getItem(WEB_PRESETS_KEY) || '[]');
			return Array.isArray(list) ? list.filter(p => p && typeof p.name === 'string' && typeof p.data === 'string') : [];
		} catch (e) { return []; }
	}

	async function reloadPresets(ask) {
		const list = [];
		const fs = getPresetFs(ask);
		if (fs) {
			let files = [];
			try { files = fs.readdirSync(presetDir).filter(f => /\.png$/i.test(f)).sort(); } catch (e) {}
			for (const file of files) {
				const b64 = fs.readFileSync(path.join(presetDir, file), 'base64');
				list.push(await makePreset(file.replace(/\.png$/i, ''), 'data:image/png;base64,' + b64));
			}
		} else if (!isApp) {
			for (const p of readWebPresets()) list.push(await makePreset(p.name, p.data));
		}
		presets = list;
		if (settings.preset && !presets.find(p => p.name === settings.preset)) settings.preset = '';
		clearCache();
		refreshPanel();
	}

	function savePresetImage(name, dataUrl) {
		name = String(name).replace(/[\\/:*?"<>|]/g, '').trim();
		if (!name) return null;
		const fs = getPresetFs(true);
		if (fs) {
			const b64 = dataUrl.split(',')[1];
			const bin = atob(b64), bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			fs.writeFileSync(path.join(presetDir, name + '.png'), bytes);
		} else if (!isApp) {
			const list = readWebPresets().filter(p => p.name !== name);
			list.push({ name, data: dataUrl });
			try { localStorage.setItem(WEB_PRESETS_KEY, JSON.stringify(list)); } catch (e) {
				Blockbench.showMessageBox({ title: 'Edge Noise Brush', message: 'Not enough browser storage to save this preset.' });
				return null;
			}
		} else {
			return null;
		}
		return name;
	}

	function deletePreset(name) {
		const fs = getPresetFs(true);
		if (fs) {
			try { fs.unlinkSync(path.join(presetDir, name + '.png')); } catch (e) {}
		} else if (!isApp) {
			try { localStorage.setItem(WEB_PRESETS_KEY, JSON.stringify(readWebPresets().filter(p => p.name !== name))); } catch (e) {}
		}
		if (settings.preset === name) { settings.preset = ''; saveSettings(); }
		reloadPresets(false);
	}

	function importPresets() {
		Blockbench.import({
			resource_id: 'edge_noise_preset',
			extensions: ['png'],
			type: 'Edge Noise Preset',
			readtype: 'image',
			multiple: true
		}, async (files) => {
			let last = null;
			for (const file of files) {
				last = savePresetImage(file.name.replace(/\.png$/i, ''), file.content) || last;
			}
			await reloadPresets(false);
			if (last) selectPreset(last);
		});
	}

	/** The area of the texture selected with the selection tool, or null. */
	function textureSelectionRect(texture) {
		const sel = texture && texture.selection;
		if (!sel || !sel.is_custom || typeof sel.getBoundingRect !== 'function') return null;
		const r = sel.getBoundingRect();
		if (!r || !(r.width > 0) || !(r.height > 0)) return null;
		return { x: r.start_x, y: r.start_y, w: r.width, h: r.height };
	}

	/** Saves the selected area of the texture as a preset, or the whole texture if nothing is selected. */
	function saveTextureAsPreset() {
		const texture = currentTexture();
		if (!texture || !texture.canvas) {
			Blockbench.showQuickMessage('Select a texture first');
			return;
		}
		const rect = textureSelectionRect(texture);
		let canvas = texture.canvas;
		if (rect) {
			canvas = document.createElement('canvas');
			canvas.width = rect.w; canvas.height = rect.h;
			canvas.getContext('2d').drawImage(texture.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
		}
		const base = texture.name.replace(/\.png$/i, '') + (rect ? '_area' : '');
		Blockbench.textPrompt(rect ? `Preset from selected area (${rect.w}×${rect.h})` : 'Preset from whole texture', base, async (name) => {
			const saved = savePresetImage(name, canvas.toDataURL('image/png'));
			await reloadPresets(false);
			if (saved) selectPreset(saved);
		});
	}

	function openPresetFolder() {
		const dir = presetFolder();
		if (!dir || !getPresetFs(true)) return;
		const shell = requireNativeModule('shell', { message: 'Opens the Edge Noise Brush preset folder.' });
		if (shell) shell.openPath(dir);
	}

	function selectedPreset() {
		const p = settings.preset && presets.find(p => p.name === settings.preset);
		return p && p.parsed ? p.parsed : null;
	}

	function selectPreset(name) {
		settings.preset = name || '';
		saveSettings();
		clearCache();
		refreshPanel();
	}

	/* --- painting --- */

	function getCanvas(texture) {
		if (typeof texture.getActiveCanvas === 'function') {
			const c = texture.getActiveCanvas();
			if (c instanceof HTMLCanvasElement) return c;
			if (c && c.canvas instanceof HTMLCanvasElement) return c.canvas;
		}
		if (texture.layers_enabled && texture.selected_layer && texture.selected_layer.canvas) return texture.selected_layer.canvas;
		return texture.canvas;
	}

	function toRGB(c) {
		if (!c) return null;
		if (typeof c === 'string') {
			const m = c.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
			return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
		}
		if (typeof c.toRgb === 'function') { const o = c.toRgb(); return [o.r, o.g, o.b]; }
		if (typeof c.r === 'number') return [c.r, c.g, c.b];
		return null;
	}

	function getBrushColor(opts) {
		let c = toRGB(opts && opts.color);
		if (!c && typeof ColorPanel !== 'undefined' && ColorPanel.get) c = toRGB(ColorPanel.get());
		return c;
	}

	function sameColor(a, b) {
		if (!a || !b) return a === b;
		return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
	}

	/** Starts the per-stroke state for a texture. The edge brush also takes a snapshot of it. */
	function startCache(texture, color, mode) {
		const canvas = getCanvas(texture);
		const w = canvas.width, h = canvas.height;
		cache = {
			mode, texture, w, h, color,
			dab: 0, dabX: null, dabY: null,       // brush steps so far, and where the last one was
			dirX: null, dirY: null, dir: null,    // stroke direction
			lastDab: new Int32Array(w * h).fill(-1000),
			passes: new Uint8Array(w * h)         // how many times the brush came back over each pixel
		};
		if (mode === 'edge') {
			const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
			cache.target = settings.use_brush_color ? color : null;
			cache.preset = selectedPreset();
			cache.source = sourceLayer(data, w, h);   // getImageData already returns a fresh copy
			cache.levels = { both: [cache.source], h: [cache.source], v: [cache.source] };
		} else {
			cache.coverage = new Float32Array(w * h);   // coverage of the current pass
			cache.remaining = new Float32Array(w * h).fill(1); // what earlier passes left uncovered
			cache.original = new Map();                 // pixel colour before the stroke touched it
		}
	}

	/** Counts brush steps and works out which way the stroke is heading. */
	function trackBrush(opts) {
		if (typeof opts.x !== 'number' || typeof opts.y !== 'number') return;
		if (opts.x !== cache.dabX || opts.y !== cache.dabY) {
			cache.dab++;
			cache.dabX = opts.x; cache.dabY = opts.y;
		}
		if (cache.dirX === null) { cache.dirX = opts.x; cache.dirY = opts.y; return; }
		const mx = Math.abs(opts.x - cache.dirX), my = Math.abs(opts.y - cache.dirY);
		if (Math.max(mx, my) < STROKE_STEP) return;
		cache.dir = my > mx ? 'v' : 'h';
		cache.dirX = opts.x; cache.dirY = opts.y;
	}

	/** True when the brush has come back to pixel i after leaving it. */
	function isNewPass(i) {
		const last = cache.lastDab[i];
		cache.lastDab[i] = cache.dab;
		return last >= 0 && cache.dab - last > REENTRY_GAP;
	}

	/** The edge result after `level` applications, for the current stroke direction. */
	function edgeResult(level) {
		const mode = settings.follow_stroke && cache.dir ? cache.dir : 'both';
		const levels = cache.levels[mode];
		while (levels.length <= level) {
			const s = mode === 'both' ? settings : Object.assign({}, settings, {
				horizontal: mode === 'h' && settings.horizontal,
				vertical: mode === 'v' && settings.vertical
			});
			levels.push(edgeLayer(levels[levels.length - 1], s, cache.target, cache.preset, levels.length - 1));
		}
		return levels[level];
	}

	function edgePixel(x, y, px, alpha, opts) {
		const i = y * cache.w + x;
		if (isNewPass(i) && settings.grow_on_repeat) {
			cache.passes[i] = Math.min(Math.max(0, settings.max_growth | 0), cache.passes[i] + 1);
		}
		const layer = edgeResult(1 + cache.passes[i]);
		layer.ensure(x, y, x, y);
		const o = layer.data, j = i * 4;
		if (o[j + 3] === 0) return px;
		const opacity = typeof opts.opacity === 'number' ? opts.opacity : 1;
		const a = Math.max(0, Math.min(1, alpha * opacity));
		return {
			r: px.r + (o[j] - px.r) * a,
			g: px.g + (o[j + 1] - px.g) * a,
			b: px.b + (o[j + 2] - px.b) * a,
			a: px.a
		};
	}

	function noisePixel(x, y, px, alpha, opts) {
		const i = y * cache.w + x;
		if (!cache.original.has(i)) cache.original.set(i, { r: px.r, g: px.g, b: px.b, a: px.a });
		if (isNewPass(i)) {
			cache.remaining[i] *= 1 - cache.coverage[i];
			cache.coverage[i] = 0;
		}
		let d = 0;
		if (typeof opts.x === 'number' && opts.size > 1) {
			d = Math.hypot(x + 0.5 - opts.x, y + 0.5 - opts.y) / (opts.size / 2);
		}
		const c = noiseCoverage(settings, d, Math.max(0, Math.min(1, alpha)));
		if (c > cache.coverage[i]) cache.coverage[i] = c;
		const filled = 1 - cache.remaining[i] * (1 - cache.coverage[i]);
		if (noiseThreshold(x, y, settings) >= filled) return px;

		const orig = cache.original.get(i), col = cache.color;
		const opacity = typeof opts.opacity === 'number' ? Math.max(0, Math.min(1, opts.opacity)) : 1;
		return {
			r: orig.r + (col[0] - orig.r) * opacity,
			g: orig.g + (col[1] - orig.g) * opacity,
			b: orig.b + (col[2] - orig.b) * opacity,
			a: orig.a + (1 - orig.a) * opacity
		};
	}

	function changePixel(x, y, px, alpha, opts) {
		const texture = opts && opts.texture;
		if (!texture) return px;
		if (typeof Painter !== 'undefined' && Painter.lock_alpha && px.a === 0) return px;
		const color = getBrushColor(opts);
		if (!cache || cache.mode !== activeMode || cache.texture !== texture || !sameColor(cache.color, color)) {
			if (!color && activeMode === 'noise') return px;
			startCache(texture, color, activeMode);
		}
		trackBrush(opts);
		if (x < 0 || y < 0 || x >= cache.w || y >= cache.h) return px;
		return activeMode === 'noise' ? noisePixel(x, y, px, alpha, opts) : edgePixel(x, y, px, alpha, opts);
	}

	function setMode(mode) {
		activeMode = mode || null;
		clearCache();
		const brush = BarItems.brush_tool;
		if (brush && brush.setIcon) brush.setIcon(activeMode ? MODES[activeMode].icon : original.icon);
		if (activeMode === 'edge' && !presets.length) reloadPresets(true);
		if (typeof updateInterfacePanels === 'function') updateInterfacePanels();
		refreshPanel();
	}

	/* --- panel --- */

	function currentTexture() {
		if (typeof Texture === 'undefined') return null;
		return Texture.selected || (Texture.getDefault && Texture.getDefault()) || null;
	}

	function imageToUrl(data, w, h) {
		const c = document.createElement('canvas');
		c.width = w; c.height = h;
		c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
		return c.toDataURL();
	}

	// A sample edge, so random mode has something to show.
	function randomSampleUrl() {
		const w = 32, h = 16, d = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const v = y < h / 2 ? 214 : 70;
			d.set([v, v, v, 255], (y * w + x) * 4);
		}
		const s = Object.assign({}, settings, { horizontal: true, vertical: false });
		return imageToUrl(processImage(d, w, h, s, null, null), w, h);
	}

	// One dab and three dabs of the noise brush on a flat surface.
	function noiseSampleUrl() {
		const size = 40, w = size * 2 + 4, h = size, d = new Uint8ClampedArray(w * h * 4);
		const col = getBrushColor(null) || [255, 255, 255];
		const bg = (col[0] + col[1] + col[2]) / 3 > 128 ? 60 : 190;
		for (let i = 0; i < w * h; i++) d.set([bg, bg, bg, 255], i * 4);
		for (const [ox, passes] of [[0, 1], [size + 4, 3]]) {
			for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
				const dist = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
				if (dist > 1) continue;
				const c = noiseCoverage(settings, dist, 1);
				const filled = 1 - Math.pow(1 - c, passes);
				const tx = x + ox;
				if (noiseThreshold(tx, y, settings) < filled) d.set([col[0], col[1], col[2], 255], (y * w + tx) * 4);
			}
		}
		return imageToUrl(d, w, h);
	}

	const PREVIEW_MAX_PIXELS = 512 * 512;
	function texturePreviewUrl() {
		const texture = currentTexture();
		if (!texture || !texture.canvas || !texture.canvas.width) return '';
		const c = texture.canvas, w = c.width, h = c.height;
		if (w * h > PREVIEW_MAX_PIXELS) return 'too_large';
		const data = c.getContext('2d').getImageData(0, 0, w, h).data;
		const target = settings.use_brush_color ? getBrushColor(null) : null;
		return imageToUrl(processImage(data, w, h, settings, target, selectedPreset()), w, h);
	}

	let refreshTimer = null;
	function refreshPanel(delay) {
		if (!panel || !panel.vue) return;
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			const vue = panel.vue;
			vue.mode = activeMode;
			vue.presets = presets.map(p => ({ name: p.name, url: p.url, error: p.error }));
			vue.selected = settings.preset;
			vue.is_app = isApp;
			vue.noise = {
				density: settings.noise_density, falloff: settings.noise_falloff,
				grain: settings.noise_grain, seed: settings.noise_seed
			};
			if (!activeMode) return;
			try {
				if (activeMode === 'noise') {
					vue.preview_url = noiseSampleUrl();
				} else {
					const p = presets.find(p => p.name === settings.preset);
					vue.preview_url = p ? p.url : randomSampleUrl();
					const url = texturePreviewUrl();
					vue.texture_too_large = url === 'too_large';
					vue.texture_url = url === 'too_large' ? '' : url;
				}
			} catch (e) {
				console.warn('Edge Noise Brush preview failed', e);
			}
		}, delay == null ? 60 : delay);
	}

	function openSettings() {
		const s = settings;
		new Dialog({
			id: 'edge_noise_brush_settings',
			title: 'Edge Noise Brush',
			width: 440,
			form: {
				use_brush_color: { label: 'Grow brush colour only', type: 'checkbox', value: s.use_brush_color },
				color_tolerance: { label: 'Colour tolerance', type: 'number', value: s.color_tolerance, min: 0, max: 64 },
				grow_on_repeat: { label: 'Grow on repeated passes', type: 'checkbox', value: s.grow_on_repeat,
					description: 'Going back over a spot without letting go grows it another step.' },
				max_growth: { label: 'Max extra growth per stroke', type: 'number', value: s.max_growth, min: 0, max: 16 },
				_0: '_',
				_r: { type: 'info', text: 'Random steps only (ignored when a preset is selected):' },
				roughness: { label: 'Roughness %', type: 'number', value: s.roughness, min: 0, max: 100 },
				step_depth: { label: 'Max step depth (px)', type: 'number', value: s.step_depth, min: 1, max: 8 },
				segment_length: { label: 'Max segment length (px)', type: 'number', value: s.segment_length, min: 1, max: 32 },
				_a: '_',
				horizontal: { label: 'Horizontal edges', type: 'checkbox', value: s.horizontal },
				vertical: { label: 'Vertical edges', type: 'checkbox', value: s.vertical },
				follow_stroke: { label: 'Follow stroke direction', type: 'checkbox', value: s.follow_stroke,
					description: 'Strokes going up or down only break up vertical edges, with the pattern turned to run along them. Sideways strokes only break up horizontal edges.' },
				threshold: { label: 'Edge threshold', type: 'number', value: s.threshold, min: 1, max: 255 },
				seed: { label: 'Seed', type: 'number', value: s.seed, min: 0, max: 99999 }
			},
			onConfirm(result) {
				for (const key in result) if (key in DEFAULTS) settings[key] = result[key];
				saveSettings();
				clearCache();
				refreshPanel();
			}
		}).show();
	}

	function setNoiseSetting(key, value) {
		const limits = { noise_density: [0, 100], noise_falloff: [0, 100], noise_grain: [1, 8], noise_seed: [0, 99999] };
		const [lo, hi] = limits[key];
		const v = Math.round(Number(value));
		if (!isFinite(v)) return;
		settings[key] = Math.max(lo, Math.min(hi, v));
		saveSettings();
		clearCache();
		refreshPanel();
	}

	function createPanel() {
		panel = new Panel('edge_noise_brush', {
			name: 'Edge Noise Brush',
			icon: 'grain',
			growable: true,
			resizable: true,
			default_side: 'right',
			condition: () => Modes.paint && !!activeMode,
			default_position: {
				slot: 'right_bar',
				float_position: [0, 0],
				float_size: [300, 400],
				height: 400
			},
			component: {
				data() {
					return {
						mode: null,
						is_app: isApp,
						presets: [],
						selected: '',
						preview_url: '',
						texture_url: '',
						texture_too_large: false,
						noise: { density: 0, falloff: 0, grain: 1, seed: 1 }
					};
				},
				computed: {
					selected_error() {
						const p = this.presets.find(p => p.name === this.selected);
						return p ? p.error : '';
					}
				},
				methods: {
					select(name) { selectPreset(name); },
					remove(name) {
						Blockbench.showMessageBox({
							title: 'Delete preset',
							message: `Delete the preset "${name}"?`,
							buttons: ['dialog.confirm', 'dialog.cancel']
						}, (button) => { if (button === 0) deletePreset(name); });
					},
					importPresets,
					saveTextureAsPreset,
					openPresetFolder,
					reload() { reloadPresets(true); },
					openSettings,
					refresh() { refreshPanel(); },
					setNoise(key, event) { setNoiseSetting(key, event.target.value); }
				},
				template: `
					<div class="edge_noise_panel">
						<template v-if="mode === 'edge'">
							<div class="edge_noise_bar">
								<div class="tool" title="Add presets from PNG files" @click="importPresets()"><i class="material-icons">add_photo_alternate</i></div>
								<div class="tool" title="Save the selected area of the texture as a preset (the whole texture if nothing is selected)" @click="saveTextureAsPreset()"><i class="material-icons">highlight_alt</i></div>
								<div class="tool" v-if="is_app" title="Open preset folder" @click="openPresetFolder()"><i class="material-icons">folder_open</i></div>
								<div class="tool" title="Reload presets" @click="reload()"><i class="material-icons">refresh</i></div>
								<div class="tool" title="Brush settings" @click="openSettings()"><i class="material-icons">tune</i></div>
							</div>
							<ul class="edge_noise_list">
								<li :class="{selected: selected === ''}" @click="select('')">
									<i class="material-icons">shuffle</i><span>Random steps</span>
								</li>
								<li v-for="p in presets" :key="p.name" :class="{selected: selected === p.name, broken: !!p.error}" @click="select(p.name)" :title="p.error || p.name">
									<img :src="p.url"><span>{{ p.name }}</span>
									<i class="material-icons edge_noise_delete" title="Delete preset" @click.stop="remove(p.name)">delete</i>
								</li>
							</ul>
							<p class="edge_noise_hint" v-if="!presets.length">
								No presets yet. Select an area of a texture showing the edge you want and click the selection button above, or add a PNG with a bright side and a dark side.
							</p>
							<p class="edge_noise_error" v-if="selected_error">{{ selected_error }}</p>
							<label>{{ selected ? 'Preset' : 'Random steps sample' }}</label>
							<img class="edge_noise_preview" v-if="preview_url" :src="preview_url">
							<label>Selected texture with this brush <i class="material-icons edge_noise_refresh" title="Refresh" @click="refresh()">refresh</i></label>
							<img class="edge_noise_preview" v-if="texture_url" :src="texture_url">
							<p class="edge_noise_hint" v-else-if="texture_too_large">This texture is too large to preview.</p>
							<p class="edge_noise_hint" v-else>Select a texture to preview it here.</p>
						</template>
						<template v-if="mode === 'noise'">
							<div class="edge_noise_slider">
								<span>Density</span>
								<input type="range" min="0" max="100" :value="noise.density" @change="setNoise('noise_density', $event)">
								<span class="edge_noise_value">{{ noise.density }}%</span>
							</div>
							<div class="edge_noise_slider">
								<span>Falloff</span>
								<input type="range" min="0" max="100" :value="noise.falloff" @change="setNoise('noise_falloff', $event)">
								<span class="edge_noise_value">{{ noise.falloff }}%</span>
							</div>
							<div class="edge_noise_slider">
								<span>Grain</span>
								<input type="range" min="1" max="8" :value="noise.grain" @change="setNoise('noise_grain', $event)">
								<span class="edge_noise_value">{{ noise.grain }}px</span>
							</div>
							<div class="edge_noise_slider">
								<span>Seed</span>
								<input type="number" min="0" max="99999" :value="noise.seed" @change="setNoise('noise_seed', $event)">
							</div>
							<label>One pass and three passes, in the brush colour</label>
							<img class="edge_noise_preview" v-if="preview_url" :src="preview_url">
							<p class="edge_noise_hint">Density is how full the middle of the brush gets on the first pass. Falloff thins it out towards the edge of the brush. Go back over a spot without letting go to fill it in further.</p>
						</template>
					</div>
				`
			}
		});
	}

	const css = `
		.edge_noise_panel { padding: 4px 8px 8px; }
		.edge_noise_bar { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: 4px; }
		.edge_noise_list { max-height: 180px; overflow-y: auto; margin-bottom: 6px; }
		.edge_noise_list li { display: flex; align-items: center; gap: 6px; padding: 2px 4px; cursor: pointer; }
		.edge_noise_list li:hover { background-color: var(--color-button); }
		.edge_noise_list li.selected { background-color: var(--color-selected); }
		.edge_noise_list li.broken span { color: var(--color-close); }
		.edge_noise_list li img { width: 24px; height: 24px; object-fit: contain; image-rendering: pixelated; flex-shrink: 0; }
		.edge_noise_list li > i:first-child { width: 24px; text-align: center; }
		.edge_noise_list li span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.edge_noise_delete { opacity: 0; }
		.edge_noise_list li:hover .edge_noise_delete { opacity: 0.7; }
		.edge_noise_panel label { display: flex; align-items: center; gap: 4px; margin-top: 6px; color: var(--color-subtle_text); }
		.edge_noise_refresh { cursor: pointer; font-size: 16px; }
		.edge_noise_preview { display: block; width: 100%; max-height: 320px; object-fit: contain; image-rendering: pixelated;
			background: repeating-conic-gradient(#8885 0% 25%, transparent 0% 50%) 50% / 12px 12px; }
		.edge_noise_hint { color: var(--color-subtle_text); font-size: 0.9em; }
		.edge_noise_error { color: var(--color-close); font-size: 0.9em; }
		.edge_noise_slider { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
		.edge_noise_slider > span:first-child { width: 56px; flex-shrink: 0; }
		.edge_noise_slider input[type=range] { flex: 1; min-width: 0; }
		.edge_noise_slider input[type=number] { width: 90px; }
		.edge_noise_value { width: 40px; text-align: right; color: var(--color-subtle_text); }
	`;
	let styleNode;

	/* --- hooking into the Brush tool --- */

	function hookBrushTool() {
		const tool = BarItems.brush_tool;
		const menu = tool.side_menu;
		original = {
			icon: tool.icon || 'fa-paint-brush',
			changePixel: tool.brush.changePixel,
			onStrokeStart: tool.brush.onStrokeStart,
			onStrokeEnd: tool.brush.onStrokeEnd,
			structure: menu && menu.structure,
			loadBrushPreset: Painter.loadBrushPreset
		};

		tool.brush.changePixel = function (px, py, pxcolor, local_opacity, opts) {
			if (activeMode) return changePixel(px, py, pxcolor, local_opacity, opts);
			return original.changePixel.apply(this, arguments);
		};
		tool.brush.onStrokeStart = function () {
			if (activeMode) clearCache();
			if (original.onStrokeStart) return original.onStrokeStart.apply(this, arguments);
		};
		tool.brush.onStrokeEnd = function () {
			if (activeMode) { clearCache(); refreshPanel(400); }
			if (original.onStrokeEnd) return original.onStrokeEnd.apply(this, arguments);
		};

		// any other brush preset switches back to the normal brush
		Painter.loadBrushPreset = function () {
			if (activeMode) setMode(null);
			return original.loadBrushPreset.apply(this, arguments);
		};

		if (menu && original.structure) {
			const base = original.structure;
			menu.structure = function () {
				const list = typeof base === 'function' ? base.apply(this, arguments) : base.slice();
				const entries = Object.keys(MODES).map(mode => ({
					id: 'edge_noise_brush_' + mode,
					name: MODES[mode].name,
					icon: MODES[mode].icon,
					click() {
						tool.select();
						setMode(mode);
					}
				}));
				const settingsIndex = list.findIndex(item => item && item.id === 'brush_settings');
				const insertAt = settingsIndex > 0 && list[settingsIndex - 1] === '_' ? settingsIndex - 1 : list.length;
				list.splice(insertAt, 0, ...entries);
				return list;
			};
		}
	}

	function unhookBrushTool() {
		if (!original) return;
		const tool = BarItems.brush_tool;
		if (tool) {
			tool.brush.changePixel = original.changePixel;
			tool.brush.onStrokeStart = original.onStrokeStart;
			tool.brush.onStrokeEnd = original.onStrokeEnd;
			if (tool.side_menu && original.structure) tool.side_menu.structure = original.structure;
			if (tool.setIcon) tool.setIcon(original.icon);
		}
		Painter.loadBrushPreset = original.loadBrushPreset;
		original = null;
	}

	Plugin.register('edge_noise_brush', {
		title: 'Edge Noise Brush',
		author: 'Shapescape',
		description: 'Brush modes that break straight edges between two tones into steps, randomly or following your own presets, and scatter noise over a surface.',
		icon: 'grain',
		version: '0.6.0',
		min_version: '5.0.0',
		variant: 'both',
		onload() {
			styleNode = Blockbench.addCSS(css);
			hookBrushTool();
			createPanel();

			settingsAction = new Action('edge_noise_brush_settings', {
				name: 'Edge Noise Brush Settings',
				icon: 'tune',
				click: openSettings
			});
			MenuBar.addAction(settingsAction, 'tools');

			// previews follow the texture and colour, but never mid-stroke
			const refreshIfActive = () => { if (activeMode) refreshPanel(400); };
			for (const event of ['update_texture_selection', 'finished_edit', 'change_color', 'select_mode']) {
				listeners.push(Blockbench.on(event, refreshIfActive));
			}
			// safety net: a new stroke always gets a fresh snapshot
			document.addEventListener('pointerup', clearCache, true);

			// load presets quietly if the folder was already allowed
			reloadPresets(false);
		},
		onunload() {
			document.removeEventListener('pointerup', clearCache, true);
			listeners.forEach(l => l && l.delete && l.delete());
			listeners.length = 0;
			unhookBrushTool();
			if (panel) panel.delete();
			if (settingsAction) settingsAction.delete();
			if (styleNode && styleNode.delete) styleNode.delete();
		}
	});
})();
