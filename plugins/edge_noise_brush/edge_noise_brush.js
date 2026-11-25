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
		noise_seed: 1,
		noise_preset: '',     // noise preset name, '' = random noise
		highlight_preset: '', // line preset names, '' = plain solid line
		shadow_preset: '',
		preset_options: {}    // 'kind/name' -> options for that preset
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

	function scaleOf(v) {
		return Math.max(1, Math.min(8, Math.round(Number(v) || 1)));
	}

	/** Column of a preset at position u along an edge, with the pattern stretched by `length`. */
	function presetColumn(u, phase, period, length) {
		const full = period * length;
		return Math.floor((((u + phase) % full) + full) % full / length);
	}

	/**
	 * Applies a learned preset to edges perpendicular to axis (dx, dy).
	 * target: [r, g, b] to grow that colour only, or null for both tones.
	 * opt: { depth, length } scales the pattern across and along the edge.
	 */
	function presetPass(s, dx, dy, P, target, opt) {
		const thr = s.threshold;
		const depth = scaleOf(opt && opt.depth), length = scaleOf(opt && opt.length);
		const reach = P.height * depth;
		const phase = (s.seed | 0);

		// Is the preset bright at column u, at row r relative to the edge?
		// r < 0 is the bright side of the original edge, r >= 0 the dark side.
		function brightAt(u, r, base) {
			const y = base * depth + r;
			if (y < 0) return true;
			if (y >= reach) return false;
			return P.bits[Math.floor(y / depth) * P.period + presetColumn(u, phase, P.period, length)] === 1;
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
	 * Learns a line pattern from a preset image: a line drawn over a plain
	 * background, running either way, with gaps and changes in thickness. The
	 * line is the opaque pixels if there are transparent ones, otherwise the
	 * less common of the two tones.
	 *
	 * Returns bits[row * period + x] = 1 where the line is, normalised to run
	 * horizontally. Row 0 is the row nearest the edge.
	 */
	/**
	 * Separates something drawn over a plain background: the opaque pixels if
	 * there are transparent ones, otherwise the less common of the two tones.
	 * Returns a mask, 1 where the drawing is, or null if there is no contrast.
	 */
	function foregroundMask(data, w, h) {
		const n = w * h;
		let transparent = 0;
		for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 128) transparent++;
		const mask = new Uint8Array(n);
		if (transparent > 0 && transparent < n) {
			for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
			return mask;
		}
		let lo = Infinity, hi = -Infinity;
		for (let i = 0; i < n; i++) { const l = lumAt(data, i); lo = Math.min(lo, l); hi = Math.max(hi, l); }
		if (!(hi - lo > 1)) return null;
		let split = (lo + hi) / 2;
		for (let iter = 0; iter < 8; iter++) {
			let sa = 0, ca = 0, sb = 0, cb = 0;
			for (let i = 0; i < n; i++) { const l = lumAt(data, i); if (l > split) { sa += l; ca++; } else { sb += l; cb++; } }
			if (!ca || !cb) break;
			split = (sa / ca + sb / cb) / 2;
		}
		let brightCount = 0;
		for (let i = 0; i < n; i++) if (lumAt(data, i) > split) brightCount++;
		const fgIsBright = brightCount <= n - brightCount;
		for (let i = 0; i < n; i++) mask[i] = (lumAt(data, i) > split) === fgIsBright ? 1 : 0;
		return mask;
	}

	function parseLinePreset(data, w, h) {
		const n = w * h;
		let line = foregroundMask(data, w, h);
		if (!line) throw 'The image needs a line drawn over a plain background.';

		let minX = w, maxX = -1, minY = h, maxY = -1;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			if (!line[y * w + x]) continue;
			minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
		}
		if (maxX < 0) throw 'The image needs a line drawn over a plain background.';
		let W = w, top = minY, bottom = maxY;
		// a line taller than it is wide runs up and down: turn it on its side
		if (maxY - minY > maxX - minX) {
			const t = new Uint8Array(n);
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[x * h + y] = line[y * w + x];
			line = t; W = h; top = minX; bottom = maxX;
		}
		const rows = bottom - top + 1;
		const bits = new Uint8Array(W * rows);
		for (let y = 0; y < rows; y++) for (let x = 0; x < W; x++) bits[y * W + x] = line[(y + top) * W + x];
		return { period: W, rows, bits };
	}

	// Thickest line the highlight and shadow brushes look through to find the edge behind it.
	const MAX_SEE_THROUGH = 8;

	/**
	 * Finds the edge seen from pixel (x, y) looking along (sx, sy), for the
	 * highlight and shadow brushes. Returns { d, bright } or null: d is how
	 * many pixels lie between this pixel and the edge (0 = touching it), and
	 * bright is whether this pixel is on the brighter side.
	 *
	 * A thin line that is brighter or darker than the tones on both sides of
	 * it, such as a highlight or shadow drawn earlier, is looked through: it
	 * counts as part of the brighter side if it is brighter than both, and of
	 * the darker side if it is darker than both. So a shadow brushed over a
	 * highlight lands next to the highlight, not around it, and brushing a
	 * line again does not thicken it.
	 */
	function lineEdge(src, w, h, x, y, sx, sy, reach, thr) {
		const k = scan(src, w, h, x, y, sx, sy, reach, thr);
		if (k < 0) return null;
		const lp = lumAt(src, y * w + x);
		const qx = x + sx * k, qy = y + sy * k;
		const lq = lumAt(src, qy * w + qx);
		const normal = { d: k - 1, bright: lp > lq };

		// length of the run of q's tone, and the tone after it
		let run = 1, la = null;
		for (; run <= MAX_SEE_THROUGH; run++) {
			const rx = x + sx * (k + run), ry = y + sy * (k + run);
			if (rx < 0 || ry < 0 || rx >= w || ry >= h) break;
			const ri = ry * w + rx;
			if (src[ri * 4 + 3] === 0) break;
			const lr = lumAt(src, ri);
			if (Math.abs(lr - lq) > thr) { la = lr; break; }
		}

		// Looking across a thin line between this tone and another one.
		if (la !== null && Math.abs(la - lp) > thr) {
			const lineBright = lq > lp && lq > la, lineDark = lq < lp && lq < la;
			if (!lineBright && !lineDark) return normal;
			const pBright = lp > la;
			// the line sits on this pixel's side of the edge if it belongs to the same side
			return { d: lineBright === pBright ? k - 1 + run : k - 1, bright: pBright };
		}

		// Otherwise this pixel may be looking along a line, at its end. If,
		// across, the run is a thin line between two other tones, it belongs to
		// one of them: no edge if that is this pixel's own tone, an edge if this
		// pixel is the other tone. A finger of one region poking into another
		// runs on into its region instead, and stays an ordinary edge.
		const line = thinLine(src, w, h, qx, qy, sy, sx, lq, thr);
		if (!line) return normal;
		if (Math.abs(lp - line.own) <= thr) return null;
		if (Math.abs(lp - line.other) <= thr) return { d: k - 1, bright: lp > line.own };
		return normal;
	}

	/**
	 * Is the pixel at (x, y), of luminance l, part of a run at most
	 * MAX_SEE_THROUGH thick along (sx, sy), lying between two different tones
	 * and lighter or darker than both? Returns { own, other }: the luminance of
	 * the side the line belongs to (the brighter one for a light line, the
	 * darker one for a dark line) and of the other side. Otherwise null.
	 */
	function thinLine(src, w, h, x, y, sx, sy, l, thr) {
		const end = (dir) => {
			for (let k = 1; k <= MAX_SEE_THROUGH + 1; k++) {
				const rx = x + dir * sx * k, ry = y + dir * sy * k;
				if (rx < 0 || ry < 0 || rx >= w || ry >= h) return null;
				const ri = ry * w + rx;
				if (src[ri * 4 + 3] === 0) return null;
				const lr = lumAt(src, ri);
				if (Math.abs(lr - l) > thr) return { k, l: lr };
			}
			return null;
		};
		const a = end(-1), b = end(1);
		if (!a || !b || a.k + b.k - 1 > MAX_SEE_THROUGH) return null;
		if (Math.abs(a.l - b.l) <= thr) return null;
		const hi = Math.max(a.l, b.l), lo = Math.min(a.l, b.l);
		if (l > hi) return { own: hi, other: lo };
		if (l < lo) return { own: lo, other: hi };
		return null;
	}

	/** A plain unbroken one pixel line, used when no line preset is selected. */
	const SOLID_LINE = { period: 1, rows: 1, bits: new Uint8Array([1]) };

	/**
	 * Draws a line of `color` along the edges between two tones, following the
	 * edge's outline, on the side opt.side ('bright' or 'dark') of it.
	 * opt: { thickness, length, offset, side, flip }.
	 * Works on horizontal and vertical edges in one go, reading only the input.
	 */
	function linePass(s, P, opt, color) {
		const thr = s.threshold;
		const thickness = scaleOf(opt.thickness), length = scaleOf(opt.length);
		const offset = Math.max(0, Math.min(16, Math.round(Number(opt.offset) || 0)));
		const onBright = opt.side === 'bright';
		const span = P.rows * thickness;
		const reach = offset + span;
		const phase = (s.seed | 0);
		const axes = [];
		if (s.horizontal) axes.push([0, 1]);
		if (s.vertical) axes.push([1, 0]);

		function lineAt(u, r) {
			if (r < 0 || r >= span) return false;
			let row = Math.floor(r / thickness);
			if (opt.flip) row = P.rows - 1 - row;
			return P.bits[row * P.period + presetColumn(u, phase, P.period, length)] === 1;
		}

		return {
			reach: reach + 2 * (MAX_SEE_THROUGH + 1),
			run(src, out, w, h, x0, y0, x1, y1) {
				const [cr, cg, cb] = color;
				for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
					const i = y * w + x;
					if (src[i * 4 + 3] === 0) continue;
					let paint = false;
					for (const [dx, dy] of axes) {
						const u = dx === 0 ? x : y;
						const back = lineEdge(src, w, h, x, y, -dx, -dy, reach, thr);
						const fwd = lineEdge(src, w, h, x, y, dx, dy, reach, thr);
						const order = [back, fwd].filter(Boolean).sort((a, b) => a.d - b.d);
						for (const edge of order) {
							// only edges where this pixel is on the chosen side
							if (edge.bright !== onBright) continue;
							paint = lineAt(u, edge.d - offset);
							break;
						}
						if (paint) break;
					}
					if (paint) {
						out[i * 4] = cr; out[i * 4 + 1] = cg; out[i * 4 + 2] = cb; out[i * 4 + 3] = 255;
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
	function edgeLayer(input, s, target, preset, level, presetOpt) {
		const sl = level ? Object.assign({}, s, { seed: (s.seed | 0) + level * 1013 }) : s;
		const make = (dx, dy, salt) => preset ? presetPass(sl, dx, dy, preset, target, presetOpt)
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
	function processImage(src, w, h, s, target, preset, levels, presetOpt) {
		let layer = sourceLayer(new Uint8ClampedArray(src), w, h);
		for (let l = 0; l < (levels || 1); l++) layer = edgeLayer(layer, s, target, preset, l, presetOpt);
		layer.ensure(0, 0, w - 1, h - 1);
		return layer.data;
	}

	/** Lazy result of the highlight or shadow line brush on top of input. */
	function lineLayer(input, s, P, opt, color) {
		return passLayer(input, linePass(s, P || SOLID_LINE, opt, color), 1, 1);
	}

	/** Whole-image result of the line brush, for previews and tests. */
	function processLines(src, w, h, s, P, opt, color) {
		const layer = lineLayer(sourceLayer(new Uint8ClampedArray(src), w, h), s, P, opt, color);
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

	/**
	 * Learns a noise pattern from a preset image: specks or clumps drawn over a
	 * plain background. Each clump (pixels touching side by side) is kept
	 * whole, so the brush shows or hides entire clumps rather than breaking
	 * them up.
	 */
	function parseNoisePreset(data, w, h) {
		const mask = foregroundMask(data, w, h);
		if (!mask || !mask.some(v => v)) throw 'The image needs noise drawn over a plain background.';
		const clump = new Int32Array(w * h).fill(-1);
		let count = 0;
		const stack = [];
		for (let start = 0; start < w * h; start++) {
			if (!mask[start] || clump[start] >= 0) continue;
			clump[start] = count;
			stack.push(start);
			while (stack.length) {
				const i = stack.pop(), x = i % w, y = (i - x) / w;
				for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const j = ny * w + nx;
					if (mask[j] && clump[j] < 0) { clump[j] = count; stack.push(j); }
				}
			}
			count++;
		}
		return { w, h, clump, count };
	}

	/**
	 * Threshold for a pixel with a noise preset: the preset is tiled over the
	 * texture, every clump in every tile gets its own random threshold, and
	 * pixels outside the clumps never fill. opt: { scale, shuffle }, where
	 * shuffle starts each tile at a random point and mirrors some, to hide the
	 * repeat.
	 */
	function noisePresetThreshold(x, y, P, opt, s) {
		const seed = (s.noise_seed | 0) * 31 + 11;
		const scale = scaleOf(opt && opt.scale);
		const X = Math.floor(x / scale), Y = Math.floor(y / scale);
		const tx = Math.floor(X / P.w), ty = Math.floor(Y / P.h);
		let lx = X - tx * P.w, ly = Y - ty * P.h;
		if (opt && opt.shuffle) {
			lx = (lx + Math.floor(hash(tx, ty, 31, seed) * P.w)) % P.w;
			ly = (ly + Math.floor(hash(tx, ty, 32, seed) * P.h)) % P.h;
			if (hash(tx, ty, 33, seed) < 0.5) lx = P.w - 1 - lx;
		}
		const c = P.clump[ly * P.w + lx];
		if (c < 0) return 2;
		return hash(c, tx * 7919 + ty, 34, seed);
	}

	/** Coverage one pass of the brush gives a pixel at distance d (0 = centre, 1 = edge). */
	function noiseCoverage(s, d, localOpacity) {
		const density = Math.max(0, Math.min(1, s.noise_density / 100));
		const falloff = Math.max(0, Math.min(1, s.noise_falloff / 100));
		const dd = Math.max(0, Math.min(1, d));
		return density * (1 - falloff * dd * dd) * localOpacity;
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { processImage, processLines, parsePreset, parseLinePreset, parseNoisePreset, noisePresetThreshold, sourceLayer, edgeLayer, noiseThreshold, noiseCoverage, DEFAULTS };
	}
	if (typeof Plugin === 'undefined') return;


	/* ---------- Blockbench integration ---------- */

	let settings = Object.assign({}, DEFAULTS, { preset_options: {} });
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		for (const key in DEFAULTS) if (key in stored) settings[key] = stored[key];
		if (!settings.preset_options || typeof settings.preset_options !== 'object') settings.preset_options = {};
	} catch (e) {}
	function saveSettings() {
		try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
	}

	const MODES = {
		edge: { name: 'Edge Noise Brush', icon: 'grain' },
		noise: { name: 'Noise Brush', icon: 'blur_on' },
		highlight: { name: 'Highlight Brush', icon: 'light_mode' },
		shadow: { name: 'Shadow Brush', icon: 'dark_mode' }
	};
	// Brush modes that use presets, and where their presets live.
	const KINDS = {
		edge: { folder: 'edges', setting: 'preset', builtin: 'Random steps', builtin_icon: 'shuffle', title: 'Edge Noise Preset' },
		highlight: { folder: 'highlights', setting: 'highlight_preset', builtin: 'Solid line', builtin_icon: 'horizontal_rule', title: 'Highlight Preset' },
		shadow: { folder: 'shadows', setting: 'shadow_preset', builtin: 'Solid line', builtin_icon: 'horizontal_rule', title: 'Shadow Preset' },
		noise: { folder: 'noise', setting: 'noise_preset', builtin: 'Random noise', builtin_icon: 'blur_on', title: 'Noise Preset' }
	};
	const OPTION_DEFAULTS = {
		edge: { depth: 1, length: 1 },
		highlight: { thickness: 1, length: 1, offset: 0, side: 'bright', flip: false },
		shadow: { thickness: 1, length: 1, offset: 0, side: 'dark', flip: false },
		noise: { scale: 1, shuffle: true }
	};

	// Every icon the plugin adds is drawn in this colour.
	const ICON_COLOR = '#d7263d';

	/** An icon node in the plugin's colour. */
	function coloredIcon(name) {
		const node = Blockbench.getIconNode(name);
		node.classList.add('edge_noise_icon');
		return node;
	}

	let activeMode = null;   // null = normal brush, or a key of MODES
	let cache = null;        // per-stroke state, rebuilt at stroke start
	let settingsAction, panel;
	let original = null;
	const listeners = [];
	const STROKE_STEP = 3;   // px the brush moves before the stroke direction is known
	const REENTRY_GAP = 3;   // brush steps a pixel must be left alone before a return counts as a new pass

	const clearCache = () => { cache = null; };

	/* --- presets --- */

	// kind -> [{ name, url (data URL), parsed, error }]
	const presets = { edge: [], highlight: [], shadow: [], noise: [] };
	// kind -> subfolder paths inside that brush's preset folder, including empty ones
	const presetFolders = { edge: [], highlight: [], shadow: [], noise: [] };
	let presetFs = null, presetRoot = null, path = null;

	function presetFolder(kind) {
		if (!presetRoot) {
			if (typeof SystemInfo === 'undefined' || !SystemInfo.user_data_directory) return null;
			path = path || requireNativeModule('path');
			presetRoot = path.join(SystemInfo.user_data_directory, PRESET_FOLDER);
		}
		const sub = kind ? KINDS[kind].folder : '';
		return sub ? path.join(presetRoot, sub) : presetRoot;
	}

	/** Scoped file system for the preset folder, asking for permission if needed. */
	function getPresetFs(ask) {
		if (presetFs) return presetFs;
		if (!isApp || typeof requireNativeModule !== 'function') return null;
		const root = presetFolder(null);
		if (!root) return null;
		presetFs = requireNativeModule('fs', {
			scope: root,
			message: 'Stores Edge Noise Brush presets in their own folder.',
			show_permission_dialog: !!ask
		}) || null;
		if (presetFs) {
			for (const kind in KINDS) {
				const dir = presetFolder(kind);
				if (!presetFs.existsSync(dir)) presetFs.mkdirSync(dir, { recursive: true });
			}
			// Edge presets used to sit loose in the main folder: move them into their own.
			try {
				for (const file of presetFs.readdirSync(root)) {
					if (!/\.png$/i.test(file)) continue;
					const to = path.join(presetFolder('edge'), file);
					if (!presetFs.existsSync(to)) presetFs.renameSync(path.join(root, file), to);
				}
			} catch (e) {
				console.warn('Edge Noise Brush: could not move old edge presets', e);
			}
		}
		return presetFs;
	}

	const MAX_FOLDER_DEPTH = 4;

	/**
	 * Lists the PNGs in a brush's preset folder and its subfolders. Names are
	 * paths relative to it without the extension, such as "stone/rough".
	 */
	function listPresetFiles(fs, dir, prefix, depth, files, folders) {
		let entries = [];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const rel = prefix ? prefix + '/' + entry.name : entry.name;
			if (entry.isDirectory()) {
				if (depth >= MAX_FOLDER_DEPTH || entry.name.startsWith('.')) continue;
				folders.push(rel);
				listPresetFiles(fs, path.join(dir, entry.name), rel, depth + 1, files, folders);
			} else if (/\.png$/i.test(entry.name)) {
				files.push(rel.replace(/\.png$/i, ''));
			}
		}
	}

	/** Cleans up a "folder/name" path typed by the user. Returns '' if nothing usable is left. */
	function cleanPresetPath(value) {
		return String(value || '').split(/[\\/]+/)
			.map(part => part.replace(/[:*?"<>|]/g, '').trim().replace(/^\.+/, ''))
			.filter(Boolean)
			.slice(0, MAX_FOLDER_DEPTH + 1)
			.join('/');
	}

	const folderOf = (name) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
	const baseName = (name) => name.slice(name.lastIndexOf('/') + 1);

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

	async function makePreset(kind, name, url) {
		const preset = { name, url, parsed: null, error: '' };
		try {
			const img = await loadImageData(url);
			const parse = kind === 'edge' ? parsePreset : kind === 'noise' ? parseNoisePreset : parseLinePreset;
			preset.parsed = parse(img.data, img.width, img.height);
		} catch (e) {
			preset.error = String(e);
		}
		return preset;
	}

	const webKey = (kind) => kind === 'edge' ? WEB_PRESETS_KEY : WEB_PRESETS_KEY + '_' + kind;
	function readWebPresets(kind) {
		try {
			const list = JSON.parse(localStorage.getItem(webKey(kind)) || '[]');
			return Array.isArray(list) ? list.filter(p => p && typeof p.name === 'string' && typeof p.data === 'string') : [];
		} catch (e) { return []; }
	}

	async function reloadPresets(ask) {
		const fs = getPresetFs(ask);
		for (const kind in KINDS) {
			const list = [];
			const folders = [];
			if (fs) {
				const dir = presetFolder(kind);
				const files = [];
				listPresetFiles(fs, dir, '', 1, files, folders);
				for (const name of files) {
					const b64 = fs.readFileSync(path.join(dir, ...name.split('/')) + '.png', 'base64');
					list.push(await makePreset(kind, name, 'data:image/png;base64,' + b64));
				}
			} else if (!isApp) {
				for (const p of readWebPresets(kind)) {
					list.push(await makePreset(kind, p.name, p.data));
					if (folderOf(p.name) && !folders.includes(folderOf(p.name))) folders.push(folderOf(p.name));
				}
				folders.sort();
			}
			presets[kind] = list;
			presetFolders[kind] = folders;
			const key = KINDS[kind].setting;
			if (settings[key] && !list.find(p => p.name === settings[key])) settings[key] = '';
		}
		clearCache();
		refreshPanel();
	}

	function savePresetImage(kind, name, dataUrl) {
		name = cleanPresetPath(name);
		if (!name) return null;
		const fs = getPresetFs(true);
		if (fs) {
			const b64 = dataUrl.split(',')[1];
			const bin = atob(b64), bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const file = path.join(presetFolder(kind), ...name.split('/')) + '.png';
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, bytes);
		} else if (!isApp) {
			const list = readWebPresets(kind).filter(p => p.name !== name);
			list.push({ name, data: dataUrl });
			try { localStorage.setItem(webKey(kind), JSON.stringify(list)); } catch (e) {
				Blockbench.showMessageBox({ title: 'Edge Noise Brush', message: 'Not enough browser storage to save this preset.' });
				return null;
			}
		} else {
			return null;
		}
		return name;
	}

	function deletePreset(kind, name) {
		const fs = getPresetFs(true);
		if (fs) {
			try { fs.unlinkSync(path.join(presetFolder(kind), ...name.split('/')) + '.png'); } catch (e) {}
		} else if (!isApp) {
			try { localStorage.setItem(webKey(kind), JSON.stringify(readWebPresets(kind).filter(p => p.name !== name))); } catch (e) {}
		}
		delete settings.preset_options[kind + '/' + name];
		if (settings[KINDS[kind].setting] === name) settings[KINDS[kind].setting] = '';
		saveSettings();
		reloadPresets(false);
	}

	// The folder new presets go to unless picked otherwise: the last one used, per brush.
	const lastFolder = { edge: '', highlight: '', shadow: '', noise: '' };

	/**
	 * Asks where to save a preset: its name (when `name` is given) and which
	 * folder of the brush's presets, with an option to make a new folder.
	 * Calls back with the folder path and the name.
	 */
	function askPresetPlace(kind, title, name, callback) {
		const folders = presetFolders[kind];
		const current = folderOf(selectedPresetName(kind));
		const start = folders.includes(lastFolder[kind]) ? lastFolder[kind] : folders.includes(current) ? current : '';
		const options = { '': 'No folder' };
		for (const f of folders) options[f] = f;
		options['__new__'] = 'New folder…';
		const form = {};
		if (name !== null) form.name = { label: 'Name', type: 'text', value: name };
		form.folder = { label: 'Folder', type: 'select', options, value: start };
		form.new_folder = { label: 'New folder', type: 'text', value: '', placeholder: 'stone or stone/rough',
			condition: (result) => result.folder === '__new__' };
		new Dialog({
			id: 'edge_noise_preset_place',
			title,
			width: 400,
			form,
			onConfirm(result) {
				const folder = cleanPresetPath(result.folder === '__new__' ? result.new_folder : result.folder);
				lastFolder[kind] = folder;
				callback(folder, result.name);
			}
		}).show();
	}

	function importPresets(kind) {
		Blockbench.import({
			resource_id: 'edge_noise_preset',
			extensions: ['png'],
			type: KINDS[kind].title,
			readtype: 'image',
			multiple: true
		}, (files) => {
			askPresetPlace(kind, `Add ${files.length === 1 ? 'preset' : files.length + ' presets'} to`, null, async (folder) => {
				let last = null;
				for (const file of files) {
					const name = file.name.replace(/\.png$/i, '');
					last = savePresetImage(kind, folder ? folder + '/' + name : name, file.content) || last;
				}
				await reloadPresets(false);
				if (last) selectPreset(kind, last);
			});
		});
	}

	/** Makes an empty folder for a brush's presets. */
	function createPresetFolder(kind) {
		Blockbench.textPrompt('New preset folder', '', async (value) => {
			const folder = cleanPresetPath(value);
			const fs = getPresetFs(true);
			if (!folder || !fs) return;
			fs.mkdirSync(path.join(presetFolder(kind), ...folder.split('/')), { recursive: true });
			lastFolder[kind] = folder;
			await reloadPresets(false);
		}, { placeholder: 'stone or stone/rough' });
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
	function saveTextureAsPreset(kind) {
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
		const what = KINDS[kind].title.toLowerCase();
		const title = rect ? `New ${what} from selected area (${rect.w}×${rect.h})` : `New ${what} from whole texture`;
		askPresetPlace(kind, title, base, async (folder, name) => {
			name = cleanPresetPath(name);
			if (!name) return;
			const saved = savePresetImage(kind, folder ? folder + '/' + name : name, canvas.toDataURL('image/png'));
			await reloadPresets(false);
			if (saved) selectPreset(kind, saved);
		});
	}

	function openPresetFolder(kind) {
		const dir = presetFolder(kind);
		if (!dir || !getPresetFs(true)) return;
		const shell = requireNativeModule('shell', { message: 'Opens the Edge Noise Brush preset folder.' });
		if (shell) shell.openPath(dir);
	}

	function selectedPresetName(kind) {
		return settings[KINDS[kind].setting] || '';
	}

	function selectedPreset(kind) {
		const name = selectedPresetName(kind);
		const p = name && presets[kind].find(p => p.name === name);
		return p && p.parsed ? p.parsed : null;
	}

	function selectPreset(kind, name) {
		settings[KINDS[kind].setting] = name || '';
		saveSettings();
		clearCache();
		refreshPanel();
	}

	/** Options for a preset ('' = the built-in one), filled in with defaults. */
	function presetOptions(kind, name) {
		const stored = settings.preset_options[kind + '/' + (name || '')] || {};
		return Object.assign({}, OPTION_DEFAULTS[kind], stored);
	}

	function setPresetOption(kind, name, key, value) {
		const id = kind + '/' + (name || '');
		const opt = Object.assign({}, settings.preset_options[id] || {});
		if (key === 'side') opt.side = value === 'bright' ? 'bright' : 'dark';
		else if (key === 'flip' || key === 'shuffle') opt[key] = !!value;
		else {
			const max = key === 'offset' ? 16 : 8, min = key === 'offset' ? 0 : 1;
			const v = Math.round(Number(value));
			if (!isFinite(v)) return;
			opt[key] = Math.max(min, Math.min(max, v));
		}
		settings.preset_options[id] = opt;
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

	/** Starts the per-stroke state for a texture, with a snapshot of it where the mode needs one. */
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
		if (mode === 'noise') {
			cache.coverage = new Float32Array(w * h);   // coverage of the current pass
			cache.remaining = new Float32Array(w * h).fill(1); // what earlier passes left uncovered
			cache.original = new Map();                 // pixel colour before the stroke touched it
			cache.noisePreset = selectedPreset('noise');
			cache.noiseOpt = presetOptions('noise', cache.noisePreset ? selectedPresetName('noise') : '');
			return;
		}
		const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;   // already a fresh copy
		cache.source = sourceLayer(data, w, h);
		const name = selectedPresetName(mode);
		if (mode === 'edge') {
			cache.target = settings.use_brush_color ? color : null;
			cache.preset = selectedPreset('edge');
			cache.presetOpt = presetOptions('edge', cache.preset ? name : '');
			cache.levels = { both: [cache.source], h: [cache.source], v: [cache.source] };
		} else {
			const P = selectedPreset(mode);
			cache.line = lineLayer(cache.source, settings, P, presetOptions(mode, P ? name : ''), color);
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
			levels.push(edgeLayer(levels[levels.length - 1], s, cache.target, cache.preset, levels.length - 1, cache.presetOpt));
		}
		return levels[level];
	}

	/** Blends the current pixel towards the worked-out result at that pixel. */
	function blendTowards(layer, x, y, px, alpha, opts) {
		layer.ensure(x, y, x, y);
		const o = layer.data, j = (y * cache.w + x) * 4;
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

	function edgePixel(x, y, px, alpha, opts) {
		const i = y * cache.w + x;
		if (isNewPass(i) && settings.grow_on_repeat) {
			cache.passes[i] = Math.min(Math.max(0, settings.max_growth | 0), cache.passes[i] + 1);
		}
		return blendTowards(edgeResult(1 + cache.passes[i]), x, y, px, alpha, opts);
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
		const threshold = cache.noisePreset
			? noisePresetThreshold(x, y, cache.noisePreset, cache.noiseOpt, settings)
			: noiseThreshold(x, y, settings);
		if (threshold >= filled) return px;

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
			if (!color && activeMode !== 'edge') return px;
			startCache(texture, color, activeMode);
		}
		trackBrush(opts);
		if (x < 0 || y < 0 || x >= cache.w || y >= cache.h) return px;
		if (activeMode === 'noise') return noisePixel(x, y, px, alpha, opts);
		if (activeMode === 'edge') return edgePixel(x, y, px, alpha, opts);
		return blendTowards(cache.line, x, y, px, alpha, opts);
	}

	function setMode(mode) {
		activeMode = mode || null;
		clearCache();
		const brush = BarItems.brush_tool;
		if (brush && brush.setIcon) brush.setIcon(activeMode ? MODES[activeMode].icon : original.icon);
		// colours the Brush tool's icon wherever it shows while one of these modes is on
		document.body.classList.toggle('edge_noise_brush_active', !!activeMode);
		// first use of a preset brush: ask for the preset folder
		if (activeMode && KINDS[activeMode] && isApp && !presetFs) reloadPresets(true);
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

	// A sample edge with a step in it, to show what a brush does.
	function sampleEdge() {
		const w = 32, h = 16, d = new Uint8ClampedArray(w * h * 4);
		const edge = (x) => x < 12 ? 9 : x < 20 ? 6 : 8;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const v = y < edge(x) ? 150 : 60;
			d.set([v, v, v, 255], (y * w + x) * 4);
		}
		return { d, w, h };
	}

	function sampleUrl(kind) {
		const { d, w, h } = sampleEdge();
		const name = selectedPresetName(kind);
		const P = selectedPreset(kind);
		const opt = presetOptions(kind, P ? name : '');
		if (kind === 'edge') {
			const target = settings.use_brush_color ? [150, 150, 150] : null;
			return imageToUrl(processImage(d, w, h, settings, target, P, 1, opt), w, h);
		}
		const col = getBrushColor(null) || (kind === 'highlight' ? [230, 230, 230] : [20, 20, 20]);
		return imageToUrl(processLines(d, w, h, settings, P, opt, col), w, h);
	}

	// One dab and three dabs of the noise brush on a flat surface.
	function noiseSampleUrl() {
		const P = selectedPreset('noise');
		const opt = presetOptions('noise', P ? selectedPresetName('noise') : '');
		const threshold = (x, y) => P ? noisePresetThreshold(x, y, P, opt, settings) : noiseThreshold(x, y, settings);
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
				if (threshold(tx, y) < filled) d.set([col[0], col[1], col[2], 255], (y * w + tx) * 4);
			}
		}
		return imageToUrl(d, w, h);
	}

	const PREVIEW_MAX_PIXELS = 512 * 512;
	function texturePreviewUrl(kind) {
		const texture = currentTexture();
		if (!texture || !texture.canvas || !texture.canvas.width) return '';
		const c = texture.canvas, w = c.width, h = c.height;
		if (w * h > PREVIEW_MAX_PIXELS) return 'too_large';
		const data = c.getContext('2d').getImageData(0, 0, w, h).data;
		const color = getBrushColor(null);
		const P = selectedPreset(kind);
		const opt = presetOptions(kind, P ? selectedPresetName(kind) : '');
		if (kind === 'edge') {
			return imageToUrl(processImage(data, w, h, settings, settings.use_brush_color ? color : null, P, 1, opt), w, h);
		}
		if (!color) return '';
		return imageToUrl(processLines(data, w, h, settings, P, opt, color), w, h);
	}

	let refreshTimer = null;
	function refreshPanel(delay) {
		if (!panel || !panel.vue) return;
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			const vue = panel.vue;
			const mode = activeMode;
			vue.mode = mode;
			vue.is_app = isApp;
			vue.noise = {
				density: settings.noise_density, falloff: settings.noise_falloff,
				grain: settings.noise_grain, seed: settings.noise_seed
			};
			if (!mode) return;
			try {
				const kind = mode;
				const name = selectedPresetName(kind);
				const p = presets[kind].find(p => p.name === name);
				vue.builtin = KINDS[kind].builtin;
				vue.builtin_icon = KINDS[kind].builtin_icon;
				vue.presets = presets[kind].map(p => ({ name: p.name, url: p.url, error: p.error }));
				// presets grouped by folder: loose ones first, then each folder, empty ones too
				const groups = [{ folder: '', items: [] }];
				for (const f of presetFolders[kind]) groups.push({ folder: f, items: [] });
				for (const p of presets[kind]) {
					const f = folderOf(p.name);
					let g = groups.find(g => g.folder === f);
					if (!g) { g = { folder: f, items: [] }; groups.push(g); }
					g.items.push({ name: p.name, label: baseName(p.name), url: p.url, error: p.error });
				}
				vue.groups = groups;
				vue.selected = name;
				vue.options = presetOptions(kind, p ? name : '');
				vue.preview_url = p ? p.url : '';
				if (kind === 'noise') {
					vue.sample_url = noiseSampleUrl();
					vue.texture_url = '';
					return;
				}
				vue.sample_url = sampleUrl(kind);
				const url = texturePreviewUrl(kind);
				vue.texture_too_large = url === 'too_large';
				vue.texture_url = url === 'too_large' ? '' : url;
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
				_e: { type: 'info', text: 'Edges, for the edge, highlight and shadow brushes:' },
				horizontal: { label: 'Horizontal edges', type: 'checkbox', value: s.horizontal },
				vertical: { label: 'Vertical edges', type: 'checkbox', value: s.vertical },
				follow_stroke: { label: 'Follow stroke direction', type: 'checkbox', value: s.follow_stroke,
					description: 'Edge Noise Brush only. Strokes going up or down only break up vertical edges, with the pattern turned to run along them. Sideways strokes only break up horizontal edges.' },
				threshold: { label: 'Edge threshold', type: 'number', value: s.threshold, min: 1, max: 255 },
				seed: { label: 'Seed', type: 'number', value: s.seed, min: 0, max: 99999 }
			},
			onConfirm(result) {
				for (const key in result) if (key in DEFAULTS && key !== 'preset_options') settings[key] = result[key];
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
						builtin: '',
						builtin_icon: '',
						presets: [],
						groups: [],
						collapsed: {},
						selected: '',
						options: {},
						preview_url: '',
						sample_url: '',
						texture_url: '',
						texture_too_large: false,
						noise: { density: 0, falloff: 0, grain: 1, seed: 1 }
					};
				},
				computed: {
					selected_error() {
						const p = this.presets.find(p => p.name === this.selected);
						return p ? p.error : '';
					},
					is_line() { return this.mode === 'highlight' || this.mode === 'shadow'; },
					show_options() { return this.is_line || ((this.mode === 'edge' || this.mode === 'noise') && !!this.selected); }
				},
				methods: {
					select(name) { selectPreset(this.mode, name); },
					remove(name) {
						const kind = this.mode;
						Blockbench.showMessageBox({
							title: 'Delete preset',
							message: `Delete the preset "${name}"?`,
							buttons: ['dialog.confirm', 'dialog.cancel']
						}, (button) => { if (button === 0) deletePreset(kind, name); });
					},
					importPresets() { importPresets(this.mode); },
					saveTextureAsPreset() { saveTextureAsPreset(this.mode); },
					openPresetFolder() { openPresetFolder(this.mode); },
					createPresetFolder() { createPresetFolder(this.mode); },
					toggleFolder(folder) {
						this.collapsed = Object.assign({}, this.collapsed, { [this.mode + '/' + folder]: !this.collapsed[this.mode + '/' + folder] });
					},
					isCollapsed(folder) { return !!this.collapsed[this.mode + '/' + folder]; },
					reload() { reloadPresets(true); },
					openSettings,
					refresh() { refreshPanel(); },
					setNoise(key, event) { setNoiseSetting(key, event.target.value); },
					setOption(key, value) { setPresetOption(this.mode, this.selected, key, value); }
				},
				template: `
					<div class="edge_noise_panel">
						<template v-if="mode">
							<div class="edge_noise_bar">
								<div class="tool" title="Add presets from PNG files" @click="importPresets()"><i class="material-icons">add_photo_alternate</i></div>
								<div class="tool" title="New preset from the selected area of the texture (the whole texture if nothing is selected)" @click="saveTextureAsPreset()"><i class="material-icons">highlight_alt</i></div>
								<div class="tool" v-if="is_app" title="New folder for presets" @click="createPresetFolder()"><i class="material-icons">create_new_folder</i></div>
								<div class="tool" v-if="is_app" title="Open preset folder" @click="openPresetFolder()"><i class="material-icons">folder_open</i></div>
								<div class="tool" title="Reload presets" @click="reload()"><i class="material-icons">refresh</i></div>
								<div class="tool" v-if="mode !== 'noise'" title="Brush settings" @click="openSettings()"><i class="material-icons">tune</i></div>
							</div>
							<ul class="edge_noise_list">
								<li :class="{selected: selected === ''}" @click="select('')">
									<i class="material-icons">{{ builtin_icon }}</i><span>{{ builtin }}</span>
								</li>
								<template v-for="g in groups">
									<li v-if="g.folder" :key="'folder:' + g.folder" class="edge_noise_folder" @click="toggleFolder(g.folder)" :title="isCollapsed(g.folder) ? 'Show presets' : 'Hide presets'">
										<i class="material-icons">{{ isCollapsed(g.folder) ? 'folder' : 'folder_open' }}</i><span>{{ g.folder }}</span>
										<span class="edge_noise_count">{{ g.items.length }}</span>
									</li>
									<template v-if="!g.folder || !isCollapsed(g.folder)">
										<li v-for="p in g.items" :key="p.name" :class="{selected: selected === p.name, broken: !!p.error, nested: !!g.folder}" @click="select(p.name)" :title="p.error || p.name">
											<img :src="p.url"><span>{{ p.label }}</span>
											<i class="material-icons edge_noise_delete" title="Delete preset" @click.stop="remove(p.name)">delete</i>
										</li>
									</template>
								</template>
							</ul>
							<p class="edge_noise_hint" v-if="!presets.length && mode === 'edge'">
								No presets yet. Select an area of a texture showing the edge you want and click the selection button above, or add a PNG with a bright side and a dark side.
							</p>
							<p class="edge_noise_hint" v-if="!presets.length && is_line">
								No presets yet. Draw a line with the gaps and thickness you want over a plain background, select it and click the selection button above, or add it as a PNG.
							</p>
							<p class="edge_noise_hint" v-if="!presets.length && mode === 'noise'">
								No presets yet. Draw the specks and clumps you want over a plain background, select them and click the selection button above, or add them as a PNG.
							</p>
							<p class="edge_noise_error" v-if="selected_error">{{ selected_error }}</p>

							<template v-if="show_options">
								<template v-if="mode === 'edge'">
									<div class="edge_noise_slider" title="How far the steps reach into the neighbouring tone. 2 doubles every step.">
										<span>Depth</span>
										<input type="range" min="1" max="8" :value="options.depth" @change="setOption('depth', $event.target.value)">
										<span class="edge_noise_value">×{{ options.depth }}</span>
									</div>
								</template>
								<template v-else-if="mode === 'noise'">
									<div class="edge_noise_slider" title="Draws every pixel of the preset this many pixels wide and tall.">
										<span>Scale</span>
										<input type="range" min="1" max="8" :value="options.scale" @change="setOption('scale', $event.target.value)">
										<span class="edge_noise_value">×{{ options.scale }}</span>
									</div>
									<div class="edge_noise_slider" title="Starts each repeat of the preset at a random point, and mirrors some, so the pattern does not show a grid.">
										<span>Shuffle</span>
										<input type="checkbox" :checked="options.shuffle" @change="setOption('shuffle', $event.target.checked)">
									</div>
								</template>
								<template v-else>
									<div class="edge_noise_slider" title="How thick the line is drawn. 2 makes every pixel of the preset two pixels deep.">
										<span>Thickness</span>
										<input type="range" min="1" max="8" :value="options.thickness" @change="setOption('thickness', $event.target.value)">
										<span class="edge_noise_value">×{{ options.thickness }}</span>
									</div>
									<div class="edge_noise_slider" title="How many pixels between the edge and the line.">
										<span>Distance</span>
										<input type="range" min="0" max="16" :value="options.offset" @change="setOption('offset', $event.target.value)">
										<span class="edge_noise_value">{{ options.offset }}px</span>
									</div>
									<div class="edge_noise_slider">
										<span>Side</span>
										<select :value="options.side" @change="setOption('side', $event.target.value)">
											<option value="bright">Brighter tone</option>
											<option value="dark">Darker tone</option>
										</select>
									</div>
									<div class="edge_noise_slider" v-if="selected" title="Use the bottom of the preset against the edge instead of the top.">
										<span>Flip</span>
										<input type="checkbox" :checked="options.flip" @change="setOption('flip', $event.target.checked)">
									</div>
								</template>
								<div class="edge_noise_slider" v-if="selected && mode !== 'noise'" title="Stretches the pattern along the edge. 2 makes every pixel of the preset two pixels long.">
									<span>Length</span>
									<input type="range" min="1" max="8" :value="options.length" @change="setOption('length', $event.target.value)">
									<span class="edge_noise_value">×{{ options.length }}</span>
								</div>
							</template>

							<template v-if="mode === 'noise'">
								<div class="edge_noise_slider" title="How full the middle of the brush gets on the first pass.">
									<span>Density</span>
									<input type="range" min="0" max="100" :value="noise.density" @change="setNoise('noise_density', $event)">
									<span class="edge_noise_value">{{ noise.density }}%</span>
								</div>
								<div class="edge_noise_slider" title="How much thinner the noise gets towards the edge of the brush.">
									<span>Falloff</span>
									<input type="range" min="0" max="100" :value="noise.falloff" @change="setNoise('noise_falloff', $event)">
									<span class="edge_noise_value">{{ noise.falloff }}%</span>
								</div>
								<div class="edge_noise_slider" v-if="!selected" title="Size of the clumps of random noise.">
									<span>Grain</span>
									<input type="range" min="1" max="8" :value="noise.grain" @change="setNoise('noise_grain', $event)">
									<span class="edge_noise_value">{{ noise.grain }}px</span>
								</div>
								<div class="edge_noise_slider">
									<span>Seed</span>
									<input type="number" min="0" max="99999" :value="noise.seed" @change="setNoise('noise_seed', $event)">
								</div>
							</template>

							<template v-if="preview_url">
								<label>Preset</label>
								<img class="edge_noise_preview" :src="preview_url">
							</template>
							<template v-if="mode === 'noise'">
								<label>One pass and three passes, in the brush colour</label>
								<img class="edge_noise_preview" v-if="sample_url" :src="sample_url">
								<p class="edge_noise_hint">{{ selected ? 'Density decides how many clumps of the preset show, each one whole.' : 'Density is how full the middle of the brush gets on the first pass.' }} Falloff thins it out towards the edge of the brush. Go back over a spot without letting go to fill it in further.</p>
							</template>
							<template v-else>
								<label>On a sample edge</label>
								<img class="edge_noise_preview" v-if="sample_url" :src="sample_url">
								<label>Selected texture with this brush <i class="material-icons edge_noise_refresh" title="Refresh" @click="refresh()">refresh</i></label>
								<img class="edge_noise_preview" v-if="texture_url" :src="texture_url">
								<p class="edge_noise_hint" v-else-if="texture_too_large">This texture is too large to preview.</p>
								<p class="edge_noise_hint" v-else>Select a texture to preview it here.</p>
							</template>
						</template>
					</div>
				`
			}
		});
	}

	const css = `
		.edge_noise_icon,
		.edge_noise_panel i.material-icons,
		body.edge_noise_brush_active [toolbar_item="brush_tool"] .icon:not(.action_more_options),
		[menu_item="edge_noise_brush_settings"] > .icon,
		.panel_handle[panel_id="edge_noise_brush"] .icon {
			color: ${ICON_COLOR} !important;
		}
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
		.edge_noise_list li.nested { padding-left: 22px; }
		.edge_noise_folder { color: var(--color-subtle_text); }
		.edge_noise_count { flex: 0 0 auto !important; font-size: 0.85em; opacity: 0.7; }
		.edge_noise_delete { opacity: 0; }
		.edge_noise_list li:hover .edge_noise_delete { opacity: 0.7; }
		.edge_noise_panel label { display: flex; align-items: center; gap: 4px; margin-top: 6px; color: var(--color-subtle_text); }
		.edge_noise_refresh { cursor: pointer; font-size: 16px; }
		.edge_noise_preview { display: block; width: 100%; max-height: 320px; object-fit: contain; image-rendering: pixelated;
			background: repeating-conic-gradient(#8885 0% 25%, transparent 0% 50%) 50% / 12px 12px; }
		.edge_noise_hint { color: var(--color-subtle_text); font-size: 0.9em; }
		.edge_noise_error { color: var(--color-close); font-size: 0.9em; }
		.edge_noise_slider { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
		.edge_noise_slider > span:first-child { width: 64px; flex-shrink: 0; }
		.edge_noise_slider input[type=range] { flex: 1; min-width: 0; }
		.edge_noise_slider input[type=number] { width: 90px; }
		.edge_noise_slider select { flex: 1; }
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
					icon: () => coloredIcon(MODES[mode].icon),
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
		description: 'Brush modes for pixel art edges: break edges into steps, add highlight and shadow lines along them, and scatter noise, all following your own presets.',
		icon: 'grain',
		version: '0.9.1',
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
			document.body.classList.remove('edge_noise_brush_active');
			if (panel) panel.delete();
			if (settingsAction) settingsAction.delete();
			if (styleNode && styleNode.delete) styleNode.delete();
		}
	});
})();
