/**
 * Edge Noise Brush — Blockbench plugin (Shapescape)
 *
 * A mode of the normal Brush tool that breaks up straight edges between two
 * tones into steps. Pick it from the Brush tool's dropdown. Wherever the
 * brush passes over an edge, the edge is cut into steps using the existing
 * colours on either side. No new colours are added. Alt picks a colour, as
 * with the normal brush.
 *
 * The step pattern is either random (driven by the settings) or learned from
 * a preset: a PNG with a bright side and a dark side meeting at the jagged
 * edge you want. Presets live in the "edge_noise_presets" folder in
 * Blockbench's user data folder, and the panel on the right shows the
 * selected preset and the selected texture with it applied.
 *
 * Calculated from a snapshot at stroke start and deterministic per pixel,
 * so going over the same spot twice in one stroke does not stack.
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
		preset: ''           // preset name, '' = random steps
	};
	const STORAGE_KEY = 'edge_noise_brush_settings';
	const WEB_PRESETS_KEY = 'edge_noise_brush_presets';
	const PRESET_FOLDER = 'edge_noise_presets';

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

	function lumArray(d, n) {
		const L = new Float32Array(n);
		for (let i = 0; i < n; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
		return L;
	}

	/** Distance k (1..max) to the first pixel of a different tone, or -1. */
	function scan(L, d, w, h, x, y, sx, sy, max, thr) {
		const base = L[y * w + x];
		for (let k = 1; k <= max; k++) {
			const qx = x + sx * k, qy = y + sy * k;
			if (qx < 0 || qy < 0 || qx >= w || qy >= h) return -1;
			const qi = qy * w + qx;
			if (d[qi * 4 + 3] === 0) return -1;
			if (Math.abs(L[qi] - base) > thr) return k;
		}
		return -1;
	}

	function colorMatcher(src, target, tol) {
		const [tr, tg, tb] = target;
		return (i) => src[i * 4 + 3] !== 0 &&
			Math.max(Math.abs(src[i * 4] - tr), Math.abs(src[i * 4 + 1] - tg), Math.abs(src[i * 4 + 2] - tb)) <= tol;
	}

	/**
	 * Random steps, both tones. One pass over edges perpendicular to axis (dx, dy).
	 */
	function stepPass(src, w, h, s, dx, dy, salt) {
		const n = w * h;
		const L = lumArray(src, n);
		const out = new Uint8ClampedArray(src);
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

		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (src[i * 4 + 3] === 0) continue;
			const t = x * dx + y * dy;
			const u = dx === 0 ? x : y;

			const kBack = scan(L, src, w, h, x, y, -dx, -dy, depth, thr);
			if (kBack > 0) {
				// p is after an edge; first pixel after the edge is at t - (kBack - 1)
				if (offset(u, t - (kBack - 1)) >= kBack) {
					const q = (y - dy * kBack) * w + (x - dx * kBack);
					out.set(src.subarray(q * 4, q * 4 + 4), i * 4);
				}
				continue;
			}
			const kFwd = scan(L, src, w, h, x, y, dx, dy, depth, thr);
			if (kFwd > 0 && offset(u, t + kFwd) <= -kFwd) {
				const q = (y + dy * kFwd) * w + (x + dx * kFwd);
				out.set(src.subarray(q * 4, q * 4 + 4), i * 4);
			}
		}
		return out;
	}

	/**
	 * Random steps, brush-colour mode: only the chosen colour grows. Wherever a
	 * region of the target colour borders another tone, segments of it step
	 * outward into that tone. The other tone never eats into the target region.
	 */
	function stepPassTarget(src, w, h, s, dx, dy, salt, target) {
		const n = w * h;
		const L = lumArray(src, n);
		const out = new Uint8ClampedArray(src);
		const thr = s.threshold, seed = (s.seed | 0) + salt * 7919;
		const depth = Math.max(1, s.step_depth | 0);
		const segLen = Math.max(1, s.segment_length | 0);
		const chance = s.roughness / 100;
		const isTarget = colorMatcher(src, target, s.color_tolerance);

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

		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (src[i * 4 + 3] === 0 || isTarget(i)) continue;
			const t = x * dx + y * dy;
			const u = dx === 0 ? x : y;

			for (const side of [-1, 1]) {
				let found = -1;
				for (let k = 1; k <= depth; k++) {
					const qx = x + side * dx * k, qy = y + side * dy * k;
					if (qx < 0 || qy < 0 || qx >= w || qy >= h) break;
					const qi = qy * w + qx;
					if (src[qi * 4 + 3] === 0) break;
					if (isTarget(qi)) { found = k; break; }
					if (Math.abs(L[qi] - L[i]) > thr) break;   // a third tone in between
				}
				if (found < 0) continue;
				// edge key: position of the first non-target pixel next to the edge, plus side
				const e = (t + side * (found - 1)) * 2 + (side > 0 ? 1 : 0);
				if (growth(u, e) >= found) {
					const q = (y + side * dy * found) * w + (x + side * dx * found);
					out.set(src.subarray(q * 4, q * 4 + 4), i * 4);
					break;
				}
			}
		}
		return out;
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
		const L = lumArray(data, n);
		const opaque = (i) => data[i * 4 + 3] >= 128;

		// split into two tones: 2-means on luminance
		let lo = Infinity, hi = -Infinity;
		for (let i = 0; i < n; i++) if (opaque(i)) { lo = Math.min(lo, L[i]); hi = Math.max(hi, L[i]); }
		if (!(hi - lo > 1)) throw 'The image needs a bright side and a dark side.';
		let split = (lo + hi) / 2;
		for (let iter = 0; iter < 8; iter++) {
			let sa = 0, ca = 0, sb = 0, cb = 0;
			for (let i = 0; i < n; i++) {
				if (!opaque(i)) continue;
				if (L[i] > split) { sa += L[i]; ca++; } else { sb += L[i]; cb++; }
			}
			if (!ca || !cb) break;
			split = (sa / ca + sb / cb) / 2;
		}
		let bright = new Uint8Array(n);
		for (let i = 0; i < n; i++) bright[i] = opaque(i) && L[i] > split ? 1 : 0;

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
	function presetPass(src, w, h, s, dx, dy, P, target) {
		const n = w * h;
		const L = lumArray(src, n);
		const out = new Uint8ClampedArray(src);
		const thr = s.threshold;
		const reach = P.height;
		if (!reach) return out;
		const isTarget = target ? colorMatcher(src, target, s.color_tolerance) : null;
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

		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (src[i * 4 + 3] === 0) continue;
			if (isTarget && isTarget(i)) continue;
			const u = dx === 0 ? x : y;

			const kBack = scan(L, src, w, h, x, y, -dx, -dy, reach, thr);
			const kFwd = scan(L, src, w, h, x, y, dx, dy, reach, thr);
			// nearest edge first
			const sides = [];
			if (kBack > 0) sides.push([kBack, -1]);
			if (kFwd > 0) sides.push([kFwd, 1]);
			sides.sort((a, b) => a[0] - b[0]);

			for (const [k, side] of sides) {
				const q = (y + side * dy * k) * w + (x + side * dx * k);
				let pBright, base;
				if (isTarget) {
					if (!isTarget(q)) continue;
					pBright = L[i] > L[q];
					base = pBright ? P.base_dark : P.base_bright;   // the target side keeps its ground
				} else {
					pBright = L[i] > L[q];
					base = P.base_both;
				}
				const r = pBright ? -k : k - 1;
				if (brightAt(u, r, base) !== pBright) out.set(src.subarray(q * 4, q * 4 + 4), i * 4);
				break;
			}
		}
		return out;
	}

	/**
	 * target: [r, g, b] to grow that colour only, or null for both tones.
	 * preset: result of parsePreset, or null for random steps.
	 */
	function processImage(src, w, h, s, target, preset) {
		let img = new Uint8ClampedArray(src);
		let pass;
		if (preset) pass = (im, dx, dy) => presetPass(im, w, h, s, dx, dy, preset, target);
		else if (target) pass = (im, dx, dy, salt) => stepPassTarget(im, w, h, s, dx, dy, salt, target);
		else pass = (im, dx, dy, salt) => stepPass(im, w, h, s, dx, dy, salt);
		if (s.horizontal) img = pass(img, 0, 1, 1);
		if (s.vertical) img = pass(img, 1, 0, 2);
		return img;
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { processImage, parsePreset, DEFAULTS };
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

	let active = false;
	let cache = null;
	let settingsAction, panel;
	let original = null;
	const listeners = [];
	// direction of the current stroke: null until it has moved a few pixels, then 'h' or 'v'
	let stroke = { x: null, y: null, dir: null };
	const STROKE_STEP = 3;
	const clearCache = () => { cache = null; stroke = { x: null, y: null, dir: null }; };

	function trackStroke(opts) {
		if (typeof opts.x !== 'number' || typeof opts.y !== 'number') return;
		if (stroke.x === null) { stroke.x = opts.x; stroke.y = opts.y; return; }
		const mx = Math.abs(opts.x - stroke.x), my = Math.abs(opts.y - stroke.y);
		if (Math.max(mx, my) < STROKE_STEP) return;
		stroke.dir = my > mx ? 'v' : 'h';
		stroke.x = opts.x; stroke.y = opts.y;
	}

	/** Which edges to break up right now: 'both', 'h' or 'v'. */
	function strokeMode() {
		return settings.follow_stroke && stroke.dir ? stroke.dir : 'both';
	}

	/* --- presets --- */

	// name -> { name, url (data URL), parsed, error }
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

	function saveTextureAsPreset() {
		const texture = currentTexture();
		if (!texture) {
			Blockbench.showQuickMessage('Select a texture first');
			return;
		}
		Blockbench.textPrompt('Preset name', texture.name.replace(/\.png$/i, ''), async (name) => {
			const saved = savePresetImage(name, texture.canvas.toDataURL('image/png'));
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

	function buildCache(texture, target) {
		const canvas = getCanvas(texture);
		const w = canvas.width, h = canvas.height;
		const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
		cache = { texture, w, h, key: String(target), target, src: new Uint8ClampedArray(data), outs: {} };
	}

	// Results from the stroke-start snapshot, worked out once per direction.
	function cachedResult(mode) {
		if (!cache.outs[mode]) {
			const s = mode === 'both' ? settings : Object.assign({}, settings, {
				horizontal: mode === 'h' && settings.horizontal,
				vertical: mode === 'v' && settings.vertical
			});
			cache.outs[mode] = processImage(cache.src, cache.w, cache.h, s, cache.target, selectedPreset());
		}
		return cache.outs[mode];
	}

	function changePixel(x, y, px, alpha, opts) {
		const texture = opts && opts.texture;
		if (!texture) return px;
		const target = settings.use_brush_color ? getBrushColor(opts) : null;
		if (!cache || cache.texture !== texture || cache.key !== String(target)) buildCache(texture, target);
		trackStroke(opts);
		if (x < 0 || y < 0 || x >= cache.w || y >= cache.h) return px;
		const i = (y * cache.w + x) * 4, o = cachedResult(strokeMode());
		if (o[i + 3] === 0) return px;
		const opacity = typeof opts.opacity === 'number' ? opts.opacity : 1;
		const a = Math.max(0, Math.min(1, alpha * opacity));
		return {
			r: px.r + (o[i] - px.r) * a,
			g: px.g + (o[i + 1] - px.g) * a,
			b: px.b + (o[i + 2] - px.b) * a,
			a: px.a
		};
	}

	function setActive(value) {
		active = !!value;
		clearCache();
		const brush = BarItems.brush_tool;
		if (brush && brush.setIcon) brush.setIcon(active ? 'grain' : original.icon);
		if (active && !presets.length) reloadPresets(true);
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

	function texturePreviewUrl() {
		const texture = currentTexture();
		if (!texture || !texture.canvas || !texture.canvas.width) return '';
		const c = texture.canvas, w = c.width, h = c.height;
		if (w * h > 1024 * 1024) return '';
		const data = c.getContext('2d').getImageData(0, 0, w, h).data;
		const target = settings.use_brush_color ? getBrushColor(null) : null;
		return imageToUrl(processImage(data, w, h, settings, target, selectedPreset()), w, h);
	}

	let refreshTimer = null;
	function refreshPanel() {
		if (!panel || !panel.vue) return;
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			const vue = panel.vue;
			vue.active = active;
			vue.presets = presets.map(p => ({ name: p.name, url: p.url, error: p.error }));
			vue.selected = settings.preset;
			vue.is_app = isApp;
			if (!active) return;
			try {
				const p = presets.find(p => p.name === settings.preset);
				vue.preview_url = p ? p.url : randomSampleUrl();
				vue.texture_url = texturePreviewUrl();
			} catch (e) {
				console.warn('Edge Noise Brush preview failed', e);
			}
		}, 60);
	}

	function openSettings() {
		const s = settings;
		new Dialog({
			id: 'edge_noise_brush_settings',
			title: 'Edge Noise Brush',
			width: 420,
			form: {
				use_brush_color: { label: 'Grow brush colour only', type: 'checkbox', value: s.use_brush_color },
				color_tolerance: { label: 'Colour tolerance', type: 'number', value: s.color_tolerance, min: 0, max: 64 },
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

	function createPanel() {
		panel = new Panel('edge_noise_brush', {
			name: 'Edge Noise Brush',
			icon: 'grain',
			growable: true,
			resizable: true,
			default_side: 'right',
			condition: () => Modes.paint && active,
			default_position: {
				slot: 'right_bar',
				float_position: [0, 0],
				float_size: [300, 400],
				height: 400
			},
			component: {
				data() {
					return {
						active: false,
						is_app: isApp,
						presets: [],
						selected: '',
						preview_url: '',
						texture_url: ''
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
					refresh() { refreshPanel(); }
				},
				template: `
					<div class="edge_noise_panel">
						<div class="edge_noise_bar">
							<div class="tool" title="Add presets from PNG files" @click="importPresets()"><i class="material-icons">add_photo_alternate</i></div>
							<div class="tool" title="Save the selected texture as a preset" @click="saveTextureAsPreset()"><i class="material-icons">save</i></div>
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
							No presets yet. Add a PNG with a bright side and a dark side meeting at the edge you want.
						</p>
						<p class="edge_noise_error" v-if="selected_error">{{ selected_error }}</p>
						<label>{{ selected ? 'Preset' : 'Random steps sample' }}</label>
						<img class="edge_noise_preview" v-if="preview_url" :src="preview_url">
						<label>Selected texture with this brush <i class="material-icons edge_noise_refresh" title="Refresh" @click="refresh()">refresh</i></label>
						<img class="edge_noise_preview" v-if="texture_url" :src="texture_url">
						<p class="edge_noise_hint" v-else>Select a texture to preview it here.</p>
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
			if (active) return changePixel(px, py, pxcolor, local_opacity, opts);
			return original.changePixel.apply(this, arguments);
		};
		tool.brush.onStrokeStart = function () {
			if (active) clearCache();
			if (original.onStrokeStart) return original.onStrokeStart.apply(this, arguments);
		};
		tool.brush.onStrokeEnd = function () {
			if (active) { clearCache(); refreshPanel(); }
			if (original.onStrokeEnd) return original.onStrokeEnd.apply(this, arguments);
		};

		// any other brush preset switches back to the normal brush
		Painter.loadBrushPreset = function () {
			if (active) setActive(false);
			return original.loadBrushPreset.apply(this, arguments);
		};

		if (menu && original.structure) {
			const base = original.structure;
			menu.structure = function () {
				const list = typeof base === 'function' ? base.apply(this, arguments) : base.slice();
				const entry = {
					id: 'edge_noise_brush',
					name: 'Edge Noise Brush',
					icon: 'grain',
					click() {
						tool.select();
						setActive(true);
					}
				};
				const settingsIndex = list.findIndex(item => item && item.id === 'brush_settings');
				const insertAt = settingsIndex > 0 && list[settingsIndex - 1] === '_' ? settingsIndex - 1 : list.length;
				list.splice(insertAt, 0, entry);
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
		description: 'Brush mode that breaks straight edges between two tones into steps, randomly or following your own presets.',
		icon: 'grain',
		version: '0.5.0',
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

			const refreshIfActive = () => { if (active) refreshPanel(); };
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
