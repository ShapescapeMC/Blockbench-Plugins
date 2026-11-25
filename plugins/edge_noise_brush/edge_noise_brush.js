/**
 * Edge Noise Brush — Blockbench plugin (Shapescape)
 *
 * A paint tool that breaks up straight edges between two tones into steps.
 * Wherever the brush passes over an edge, the edge is cut into segments of
 * random length and each segment is pushed in or out by a pixel or two,
 * using the existing colours on either side. No new colours are added.
 *
 * Calculated from a snapshot at stroke start and deterministic per pixel,
 * so going over the same spot twice in one stroke does not stack.
 * Settings: Tools menu > Edge Noise Brush Settings.
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
		seed: 1
	};
	const STORAGE_KEY = 'edge_noise_brush_settings';

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

	/**
	 * One pass over edges perpendicular to axis (dx, dy).
	 * Returns a new pixel array.
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
	 * Brush-colour mode: only the chosen colour grows. Wherever a region of the
	 * target colour borders another tone, segments of it step outward into
	 * that tone. The other tone never eats into the target region.
	 */
	function stepPassTarget(src, w, h, s, dx, dy, salt, target) {
		const n = w * h;
		const L = lumArray(src, n);
		const out = new Uint8ClampedArray(src);
		const thr = s.threshold, tol = s.color_tolerance, seed = (s.seed | 0) + salt * 7919;
		const depth = Math.max(1, s.step_depth | 0);
		const segLen = Math.max(1, s.segment_length | 0);
		const chance = s.roughness / 100;
		const [tr, tg, tb] = target;
		const isTarget = (i) => src[i * 4 + 3] !== 0 &&
			Math.max(Math.abs(src[i * 4] - tr), Math.abs(src[i * 4 + 1] - tg), Math.abs(src[i * 4 + 2] - tb)) <= tol;

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

	/** target: [r, g, b] to grow that colour only, or null for two-way edge steps. */
	function processImage(src, w, h, s, target) {
		let img = new Uint8ClampedArray(src);
		const pass = target
			? (im, dx, dy, salt) => stepPassTarget(im, w, h, s, dx, dy, salt, target)
			: (im, dx, dy, salt) => stepPass(im, w, h, s, dx, dy, salt);
		if (s.horizontal) img = pass(img, 0, 1, 1);
		if (s.vertical) img = pass(img, 1, 0, 2);
		return img;
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { processImage, DEFAULTS };
	}
	if (typeof Plugin === 'undefined') return;

	/* ---------- Blockbench integration ---------- */

	let settings = Object.assign({}, DEFAULTS);
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		for (const key in DEFAULTS) if (key in stored) settings[key] = stored[key];
	} catch (e) {}

	let cache = null;
	let tool, settingsAction;
	const clearCache = () => { cache = null; };

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
		cache = { texture, w, h, key: String(target), out: processImage(data, w, h, settings, target) };
	}

	function changePixel(x, y, px, alpha, opts) {
		const texture = opts && opts.texture;
		if (!texture) return px;
		const target = settings.use_brush_color ? getBrushColor(opts) : null;
		if (!cache || cache.texture !== texture || cache.key !== String(target)) buildCache(texture, target);
		if (x < 0 || y < 0 || x >= cache.w || y >= cache.h) return px;
		const i = (y * cache.w + x) * 4, o = cache.out;
		if (o[i + 3] === 0) return px;
		const a = Math.max(0, Math.min(1, alpha));
		return {
			r: px.r + (o[i] - px.r) * a,
			g: px.g + (o[i + 1] - px.g) * a,
			b: px.b + (o[i + 2] - px.b) * a,
			a: px.a
		};
	}

	function openSettings() {
		const s = settings;
		new Dialog({
			id: 'edge_noise_brush_settings',
			title: 'Edge Noise Brush',
			width: 400,
			form: {
				use_brush_color: { label: 'Grow brush colour only', type: 'checkbox', value: s.use_brush_color },
				color_tolerance: { label: 'Colour tolerance', type: 'number', value: s.color_tolerance, min: 0, max: 64 },
				_0: '_',
				roughness: { label: 'Roughness %', type: 'number', value: s.roughness, min: 0, max: 100 },
				step_depth: { label: 'Max step depth (px)', type: 'number', value: s.step_depth, min: 1, max: 8 },
				segment_length: { label: 'Max segment length (px)', type: 'number', value: s.segment_length, min: 1, max: 32 },
				_a: '_',
				horizontal: { label: 'Horizontal edges', type: 'checkbox', value: s.horizontal },
				vertical: { label: 'Vertical edges', type: 'checkbox', value: s.vertical },
				threshold: { label: 'Edge threshold', type: 'number', value: s.threshold, min: 1, max: 255 },
				seed: { label: 'Seed', type: 'number', value: s.seed, min: 0, max: 99999 }
			},
			onConfirm(result) {
				Object.assign(settings, result);
				try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
				clearCache();
			}
		}).show();
	}

	Plugin.register('edge_noise_brush', {
		title: 'Edge Noise Brush',
		author: 'Shapescape',
		description: 'Paint tool that grows the selected colour into neighbouring tones in random steps.',
		icon: 'grain',
		version: '0.3.0',
		min_version: '5.0.0',
		variant: 'both',
		onload() {
			tool = new Tool('edge_noise_brush', {
				name: 'Edge Noise Brush',
				description: 'Breaks straight edges between two tones into random steps',
				icon: 'grain',
				category: 'tools',
				toolbar: 'brush',
				cursor: 'crosshair',
				selectFace: true,
				transformerMode: 'hidden',
				paintTool: true,
				allowWireframe: false,
				allowed_view_modes: ['textured', 'material'],
				modes: ['paint'],
				brush: {
					blend_modes: false,
					shapes: true,
					size: true,
					softness: true,
					opacity: true,
					offset_even_radius: true,
					floor_coordinates: true,
					changePixel,
					onStrokeEnd: clearCache
				},
				onCanvasClick(data) { Painter.startPaintToolCanvas(data, data.event); },
				onSelect() { clearCache(); if (Painter.updateNslideValues) Painter.updateNslideValues(); },
				onUnselect() { clearCache(); }
			});
			try { Toolbox.add(tool); } catch (e) {}

			settingsAction = new Action('edge_noise_brush_settings', {
				name: 'Edge Noise Brush Settings',
				icon: 'tune',
				click: openSettings
			});
			MenuBar.addAction(settingsAction, 'tools');

			// safety net: a new stroke always gets a fresh snapshot
			document.addEventListener('pointerup', clearCache, true);
		},
		onunload() {
			document.removeEventListener('pointerup', clearCache, true);
			if (tool) tool.delete();
			if (settingsAction) settingsAction.delete();
		}
	});
})();
