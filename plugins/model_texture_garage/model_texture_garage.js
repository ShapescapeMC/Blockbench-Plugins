/**
 * Model & Texture Garage — Blockbench plugin (Shapescape)
 *
 * Tools for pixel art models built from blocks, in one plugin.
 *
 * Texturing, as modes of the normal Brush tool, picked from its dropdown:
 * - Edge Noise Brush: breaks straight edges between two tones into steps,
 *   randomly or following presets learned from your own textures.
 * - Noise Brush: scatters the brush colour over a surface, from presets or
 *   random, densest in the middle of the brush.
 * - Highlight and Shadow Brushes: draw lines along edges, following every
 *   step, with breaks and thickness from line presets.
 * - Block Grid Brush: fills whole block cells on the model's block grid.
 * Plus a Texture Reference panel to pick colours from a zoomed view.
 *
 * Modelling, in the Edit tab:
 * - Block Grid Cube tool: click a face to add a cube on the block grid, or
 *   to cut one out or mark one hollow, named ADD, CUTOUT or HOLLOW.
 * - BlockPatcher: turns those cubes into real geometry (cuts, added cubes,
 *   see-through hollows), merges cubes, drops hidden faces and lays out the
 *   UV, in a preview tab where you can restore what went wrong, then confirm.
 * - Organize UV: lays out the UV again without touching the geometry.
 *
 * Alt picks a colour with every brush, as with the normal brush. Presets
 * live in the "edge_noise_presets" folder in Blockbench's user data folder.
 */
(function () {
	'use strict';

	// Each part of the plugin pushes its { onload, onunload } here.
	const parts = [];

	/* ======================= texturing: brush modes ======================= */

	(function () {
		'use strict';

		const DEFAULTS = {
			threshold: 2,        // how different two pixels must be (largest channel difference) to count as an edge
			roughness: 60,       // % of segments that get pushed in or out
			step_depth: 1,       // max px a segment moves
			segment_length: 7,   // max segment length along the edge in px
			horizontal: true,    // break up horizontal edges
			vertical: true,      // break up vertical edges
			use_brush_color: true, // older versions' switch, read once into grow_mode
			grow_mode: 'brush',   // which tone the edge brush grows: 'brush' colour, the tone where the stroke 'start's, or 'both'
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
			preset_options: {},   // 'kind/name' -> options for that preset
			references: [],       // saved areas for the Texture Reference panel
			reference_selected: '', // id of the reference shown, '' = the whole selected texture
			settings_version: 2,
			grid_size: 16,        // Block Grid Brush cell size in texture pixels, or 'auto' for the model's own block size
			grid_follow_model: true, // line cells up with the model's block grid rather than the texture's corner
			grid_show: true,      // draw the block grid on the model while the Block Grid Brush is selected
			grid_show_modes: {},  // the same for the other brushes: mode -> true to show it there too
			edge_on_grid: false,  // Edge Noise Brush: only break up the block-grid line nearest the brush
			edge_line_place: 'center' // where the noise sits on that line: 'center', 'inner' (the block painted in) or 'outer' (the block next to it)
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

		/**
		 * How different two pixels are: the largest difference in any colour
		 * channel. Catches faint edges between close shades, and edges between
		 * colours of the same brightness.
		 */
		function toneDiff(d, i, j) {
			return Math.max(Math.abs(d[i * 4] - d[j * 4]), Math.abs(d[i * 4 + 1] - d[j * 4 + 1]), Math.abs(d[i * 4 + 2] - d[j * 4 + 2]));
		}

		/** Distance k (1..max) to the first pixel of a different tone, or -1. */
		function scan(d, w, h, x, y, sx, sy, max, thr) {
			const p = y * w + x;
			for (let k = 1; k <= max; k++) {
				const qx = x + sx * k, qy = y + sy * k;
				if (qx < 0 || qy < 0 || qx >= w || qy >= h) return -1;
				const qi = qy * w + qx;
				if (d[qi * 4 + 3] === 0) return -1;
				if (toneDiff(d, qi, p) > thr) return k;
			}
			return -1;
		}

		/**
		 * How close a pixel must be to the brush colour to count as it. Never wider
		 * than the edge threshold: a pixel more different than that is another tone,
		 * so the brush colour can grow into it even when the two are close shades.
		 */
		function targetTolerance(s) {
			return Math.min(Number(s.color_tolerance) || 0, Number(s.threshold) || 0);
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
					const isTarget = colorMatcher(src, target, targetTolerance(s));
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
								if (toneDiff(src, qi, i) > thr) break;   // a third tone in between
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

		/** The largest group of side-by-side touching pixels with mask value v, as a mask. */
		function largestRegion(mask, w, h, v) {
			const label = new Int32Array(w * h).fill(-1);
			let best = -1, bestSize = 0, count = 0;
			const stack = [];
			for (let start = 0; start < w * h; start++) {
				if (mask[start] !== v || label[start] >= 0) continue;
				let size = 0;
				label[start] = count;
				stack.push(start);
				while (stack.length) {
					const i = stack.pop(), x = i % w, y = (i - x) / w;
					size++;
					if (x > 0 && mask[i - 1] === v && label[i - 1] < 0) { label[i - 1] = count; stack.push(i - 1); }
					if (x < w - 1 && mask[i + 1] === v && label[i + 1] < 0) { label[i + 1] = count; stack.push(i + 1); }
					if (y > 0 && mask[i - w] === v && label[i - w] < 0) { label[i - w] = count; stack.push(i - w); }
					if (y < h - 1 && mask[i + w] === v && label[i + w] < 0) { label[i + w] = count; stack.push(i + w); }
				}
				if (size > bestSize) { bestSize = size; best = count; }
				count++;
			}
			const out = new Uint8Array(w * h);
			for (let i = 0; i < w * h; i++) if (label[i] === best && best >= 0) out[i] = 1;
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

			// orientation: the two sides lie above and below each other for an edge
			// running across, and side by side for one running up and down
			let bx = 0, by = 0, bn = 0, dxs = 0, dys = 0, dn = 0;
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				if (bright[y * w + x]) { bx += x; by += y; bn++; } else { dxs += x; dys += y; dn++; }
			}
			const apartY = bn && dn ? Math.abs(by / bn - dys / dn) / h : 0;
			const apartX = bn && dn ? Math.abs(bx / bn - dxs / dn) / w : 0;
			let W = w, H = h;
			if (apartX > apartY) {
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

			// The edge is where the main bright region meets the main dark region.
			// Stray specks away from it are left out, so they cannot stretch the band.
			const mainBright = largestRegion(bright, W, H, 1), mainDark = largestRegion(bright, W, H, 0);
			const firstDark = new Int32Array(W), lastBright = new Int32Array(W);
			let anyBright = false, anyDark = false;
			for (let x = 0; x < W; x++) {
				let fd = H, lb = -1;
				for (let y = 0; y < H; y++) {
					const i = y * W + x;
					if (mainBright[i]) { lb = y; anyBright = true; }
					if (mainDark[i]) { if (fd === H) fd = y; anyDark = true; }
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
					const isTarget = target ? colorMatcher(src, target, targetTolerance(s)) : null;
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
			const pi = y * w + x, lp = lumAt(src, pi);
			const qx = x + sx * k, qy = y + sy * k;
			const qi = qy * w + qx, lq = lumAt(src, qi);
			const normal = { d: k - 1, bright: lp > lq };

			// length of the run of q's tone, and the pixel after it
			let run = 1, ai = -1;
			for (; run <= MAX_SEE_THROUGH; run++) {
				const rx = x + sx * (k + run), ry = y + sy * (k + run);
				if (rx < 0 || ry < 0 || rx >= w || ry >= h) break;
				const ri = ry * w + rx;
				if (src[ri * 4 + 3] === 0) break;
				if (toneDiff(src, ri, qi) > thr) { ai = ri; break; }
			}

			// Looking across a thin line between this tone and another one.
			if (ai >= 0 && toneDiff(src, ai, pi) > thr) {
				const la = lumAt(src, ai);
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
			const line = thinLine(src, w, h, qx, qy, sy, sx, thr);
			if (!line) return normal;
			if (toneDiff(src, pi, line.own) <= thr) return null;
			if (toneDiff(src, pi, line.other) <= thr) return { d: k - 1, bright: lp > lumAt(src, line.own) };
			return normal;
		}

		/**
		 * Is the pixel at (x, y) part of a run at most MAX_SEE_THROUGH thick along
		 * (sx, sy), lying between two different tones and lighter or darker than
		 * both? Returns { own, other }: a pixel of the side the line belongs to
		 * (the brighter one for a light line, the darker one for a dark line) and
		 * a pixel of the other side. Otherwise null.
		 */
		function thinLine(src, w, h, x, y, sx, sy, thr) {
			const ci = y * w + x;
			const end = (dir) => {
				for (let k = 1; k <= MAX_SEE_THROUGH + 1; k++) {
					const rx = x + dir * sx * k, ry = y + dir * sy * k;
					if (rx < 0 || ry < 0 || rx >= w || ry >= h) return null;
					const ri = ry * w + rx;
					if (src[ri * 4 + 3] === 0) return null;
					if (toneDiff(src, ri, ci) > thr) return { k, i: ri, l: lumAt(src, ri) };
				}
				return null;
			};
			const a = end(-1), b = end(1);
			if (!a || !b || a.k + b.k - 1 > MAX_SEE_THROUGH) return null;
			if (toneDiff(src, a.i, b.i) <= thr) return null;
			const l = lumAt(src, ci);
			const [hi, lo] = a.l > b.l ? [a, b] : [b, a];
			if (l > hi.l) return { own: hi.i, other: lo.i };
			if (l < lo.l) return { own: lo.i, other: hi.i };
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

		/* --- block grid brush --- */

		// For each cube face: which model axis runs along the texture's u and v,
		// which end of the cube the start of the UV rectangle sits at, and which
		// way the axis runs. Matches Blockbench's own automatic UV layout.
		const FACE_AXES = {
			north: { u: [0, 'to', -1], v: [1, 'to', -1] },
			south: { u: [0, 'from', 1], v: [1, 'to', -1] },
			west: { u: [2, 'from', 1], v: [1, 'to', -1] },
			east: { u: [2, 'to', -1], v: [1, 'to', -1] },
			up: { u: [0, 'from', 1], v: [2, 'from', 1] },
			down: { u: [0, 'from', 1], v: [2, 'to', -1] }
		};

		/**
		 * The block grid of a cube face in texture pixels, along one texture axis.
		 * Returns { anchor, block }: a pixel position where a block edge falls,
		 * and how many pixels one block (16 model units) takes up on this face.
		 * axis is 'u' or 'v'; uv is the face's [u1, v1, u2, v2]; factor converts
		 * UV units to texture pixels; offset is where block edges sit on that
		 * model axis (8 on centred grids for x and z, otherwise 0).
		 */
		function faceGridAxis(cube, faceKey, uv, axis, factor, offset, turned) {
			const info = FACE_AXES[faceKey] && FACE_AXES[faceKey][axis];
			if (!info) return null;
			// a face turned by 180 degrees starts at the other end and runs the other way
			const modelAxis = info[0];
			const startEnd = turned ? (info[1] === 'to' ? 'from' : 'to') : info[1];
			const dir = turned ? -info[2] : info[2];
			const extent = cube.to[modelAxis] - cube.from[modelAxis];
			const a = axis === 'u' ? uv[0] : uv[1], b = axis === 'u' ? uv[2] : uv[3];
			if (!extent || a === b) return null;
			const start = startEnd === 'to' ? cube.to[modelAxis] : cube.from[modelAxis];
			const unitsPerUV = extent / (b - a);       // signed: negative for mirrored UVs
			// the nearest block edge at or before the start of the face
			const edge = Math.floor((start - offset) / 16) * 16 + offset;
			const uvAtEdge = a + (edge - start) / (dir * unitsPerUV);
			return { anchor: uvAtEdge * factor, block: Math.abs(16 / unitsPerUV) * factor };
		}

		// Which side of the cube each face is on: [model axis, 'from' or 'to', outward direction].
		const FACE_PLANES = {
			north: [2, 'from', -1], south: [2, 'to', 1], west: [0, 'from', -1],
			east: [0, 'to', 1], down: [1, 'from', -1], up: [1, 'to', 1]
		};

		/**
		 * Line segments showing the Block Grid Brush's cells on a cube, in model
		 * coordinates: a flat list of [x, y, z] pairs. Lines sit on each face at
		 * the same places the brush puts cell edges, a hair outside the surface.
		 * spacing(faceKey, modelAxis) gives the cell size in model units along
		 * that axis of that face, or 0 to skip it. offset(modelAxis) is where
		 * block edges sit (8 on centred grids for x and z).
		 */
		function gridLines(cube, faceKeys, spacing, offset, lift) {
			const points = [];
			const MAX_LINES = 256;
			for (const faceKey of faceKeys) {
				const axes = FACE_AXES[faceKey], plane = FACE_PLANES[faceKey];
				if (!axes || !plane) continue;
				const [n, end, out] = plane;
				const depth = cube[end][n] + out * lift;
				const along = [axes.u[0], axes.v[0]];
				for (const a of along) {
					const b = along[0] === a ? along[1] : along[0];
					const step = spacing(faceKey, a);
					if (!(step > 0)) continue;
					const from = cube.from[a], to = cube.to[a];
					const off = offset(a);
					let p = Math.floor((from - off) / 16) * 16 + off;
					let count = 0;
					for (; p < to - 1e-6 && count < MAX_LINES; p += step) {
						if (p <= from + 1e-6) continue;
						const p1 = [0, 0, 0], p2 = [0, 0, 0];
						p1[a] = p2[a] = p;
						p1[b] = cube.from[b]; p2[b] = cube.to[b];
						p1[n] = p2[n] = depth;
						points.push(p1, p2);
						count++;
					}
				}
			}
			return points;
		}

		/**
		 * The model coordinate at texture pixel position px along a face's u or v
		 * axis: the reverse of faceGridAxis. Returns { axis, value } with the
		 * model axis it lies on, or null.
		 */
		function facePixelToModel(cube, faceKey, uv, axis, px, factor, turned) {
			const info = FACE_AXES[faceKey] && FACE_AXES[faceKey][axis];
			if (!info) return null;
			const modelAxis = info[0];
			const startEnd = turned ? (info[1] === 'to' ? 'from' : 'to') : info[1];
			const dir = turned ? -info[2] : info[2];
			const extent = cube.to[modelAxis] - cube.from[modelAxis];
			const a = axis === 'u' ? uv[0] : uv[1], b = axis === 'u' ? uv[2] : uv[3];
			if (!extent || a === b) return null;
			const start = startEnd === 'to' ? cube.to[modelAxis] : cube.from[modelAxis];
			return { axis: modelAxis, value: start + dir * (px / factor - a) * (extent / (b - a)) };
		}

		/**
		 * The grid line nearest to (x, y) in texture pixels. grid is { x, y } of
		 * { anchor, cell }; only: 'x' for lines running up and down (at a fixed
		 * x), 'y' for lines running across, or null for whichever is nearer.
		 * Returns { axis, pos, dist }: pos is the pixel boundary the line sits on.
		 */
		function nearestGridLine(x, y, grid, only) {
			const pick = (axis, p) => {
				const g = grid[axis];
				const k = Math.round((p - g.anchor) / g.cell);
				const pos = Math.round(g.anchor + k * g.cell);
				return { axis, pos, dist: Math.abs(p - pos) };
			};
			// brush positions are pixel centres; a line sits between two pixels
			const lx = pick('x', x + 0.5), ly = pick('y', y + 0.5);
			if (only === 'x') return lx;
			if (only === 'y') return ly;
			return lx.dist <= ly.dist ? lx : ly;
		}

		/**
		 * Whether a pixel at signed distance d from a block line (d > 0 inside the
		 * block being painted, d < 0 in the block next to it, in pixels from the
		 * line to the pixel's centre) is in the band the noise may change.
		 * place: 'center' (both sides), 'inner' or 'outer'.
		 */
		function inLineBand(d, reach, place) {
			if (place === 'inner') return d > 0 && d <= reach;
			if (place === 'outer') return d < 0 && -d <= reach;
			return Math.abs(d) <= reach;
		}

		/** The band of inLineBand as pixel positions [lo, hi] across the line at pos. */
		function lineBandPixels(pos, side, reach, place) {
			if (place === 'inner') return side > 0 ? [pos, pos + reach] : [pos - reach, pos];
			if (place === 'outer') return side > 0 ? [pos - reach, pos] : [pos, pos + reach];
			return [pos - reach, pos + reach];
		}

		/**
		 * The cells to fill for a brush dab at (x, y) of size `size`, given the grid
		 * along each axis ({ anchor, cell }). Returns [{ x, y, w, h, key }].
		 */
		function gridCells(x, y, size, gx, gy) {
			const r = Math.max(0, (size - 1) / 2);
			const cells = [];
			const i0 = Math.floor((x - r - gx.anchor) / gx.cell), i1 = Math.floor((x + r - gx.anchor) / gx.cell);
			const j0 = Math.floor((y - r - gy.anchor) / gy.cell), j1 = Math.floor((y + r - gy.anchor) / gy.cell);
			for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
				const cx = gx.anchor + i * gx.cell, cy = gy.anchor + j * gy.cell;
				cells.push({ x: Math.round(cx), y: Math.round(cy), w: Math.round(cx + gx.cell) - Math.round(cx), h: Math.round(cy + gy.cell) - Math.round(cy), key: i + ',' + j });
			}
			return cells;
		}

		if (typeof module !== 'undefined' && module.exports) {
			Object.assign(module.exports, { inLineBand, lineBandPixels, faceGridAxis, facePixelToModel, nearestGridLine, gridCells, gridLines, processImage, processLines, parsePreset, parseLinePreset, parseNoisePreset, noisePresetThreshold, sourceLayer, edgeLayer, noiseThreshold, noiseCoverage, DEFAULTS });
		}
		if (typeof Plugin === 'undefined') return;


		/* ---------- Blockbench integration ---------- */

		let settings = Object.assign({}, DEFAULTS, { preset_options: {} });
		try {
			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
			for (const key in DEFAULTS) if (key in stored) settings[key] = stored[key];
			if (!settings.preset_options || typeof settings.preset_options !== 'object') settings.preset_options = {};
			if (!settings.grid_show_modes || typeof settings.grid_show_modes !== 'object') settings.grid_show_modes = {};
			if (!('grow_mode' in stored) && stored.use_brush_color === false) settings.grow_mode = 'both';
			if (!['brush', 'start', 'both'].includes(settings.grow_mode)) settings.grow_mode = 'brush';
			// version 2 compares tones by colour channel and lowered the edge threshold
			// default from 4 to 2: move the old default along with it
			if (!stored.settings_version || stored.settings_version < 2) {
				if (settings.threshold === 4) settings.threshold = DEFAULTS.threshold;
				settings.settings_version = 2;
				localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
			}
		} catch (e) {}
		function saveSettings() {
			try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
		}

		const MODES = {
			edge: { name: 'Edge Noise Brush', icon: 'grain' },
			noise: { name: 'Noise Brush', icon: 'blur_on' },
			grid: { name: 'Block Grid Brush', icon: 'grid_on' },
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
		function startCache(texture, color, mode, opts) {
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
				cache.target = null;
				if (settings.grow_mode === 'brush') cache.target = color;
				if (settings.grow_mode === 'start') {
					// the tone under the brush where the stroke starts
					const sx = Math.floor(opts && opts.x), sy = Math.floor(opts && opts.y);
					const si = (sy * w + sx) * 4;
					cache.target = sx >= 0 && sy >= 0 && sx < w && sy < h && data[si + 3] ? [data[si], data[si + 1], data[si + 2]] : color;
				}
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
			// on a block line only edges along that line count: across lines run 'h', up-and-down lines 'v'
			const mode = cache.gridLine ? (cache.gridLine.axis === 'y' ? 'h' : 'v')
				: settings.follow_stroke && cache.dir ? cache.dir : 'both';
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
			if (settings.edge_on_grid) {
				updateGridLine(opts);
				const line = cache.gridLine;
				if (!line) return px;
				// only the band along the line that the steps can reach, on the chosen side of it
				const reach = lineReach() * (1 + cache.passes[i]);
				const d = ((line.axis === 'x' ? x : y) + 0.5 - line.pos) * cache.gridSide;   // > 0: inside the block painted in
				if (!inLineBand(d, reach, settings.edge_line_place)) return px;
			}
			if (isNewPass(i) && settings.grow_on_repeat) {
				cache.passes[i] = Math.min(Math.max(0, settings.max_growth | 0), cache.passes[i] + 1);
			}
			return blendTowards(edgeResult(1 + cache.passes[i]), x, y, px, alpha, opts);
		}

		/**
		 * Picks the block-grid line the brush is drawing on, once per brush step:
		 * the nearest one, running the way the stroke goes once that is known.
		 */
		function updateGridLine(opts) {
			if (typeof opts.x !== 'number') return;
			if (cache.gridLineAt === cache.dabX + ',' + cache.dabY + ',' + cache.dir) return;
			cache.gridLineAt = cache.dabX + ',' + cache.dabY + ',' + cache.dir;
			const grid = currentGrid(cache.texture);
			// sideways strokes follow lines running across, up-and-down strokes lines running up and down
			const only = cache.dir === 'h' ? 'y' : cache.dir === 'v' ? 'x' : (cache.gridLine ? cache.gridLine.axis : null);
			const line = nearestGridLine(opts.x, opts.y, grid, only);
			const prev = cache.gridLine;
			const across = line.axis === 'x' ? opts.x : opts.y, along = line.axis === 'x' ? opts.y : opts.x;
			if (!prev || prev.axis !== line.axis || prev.pos !== line.pos) {
				cache.gridLine = line;
				// which side of the line is "inside": the block the brush is in when the line is picked
				cache.gridSide = across + 0.5 >= line.pos ? 1 : -1;
			}
			// the block along the line the brush is next to
			const g = grid[line.axis === 'x' ? 'y' : 'x'];
			const segment = Math.floor((along + 0.5 - g.anchor) / g.cell);
			const key = line.axis + line.pos + '/' + cache.gridSide + '/' + segment;
			if (key !== cache.gridMarkKey) {
				cache.gridMarkKey = key;
				markGridLine(line, cache.texture, {
					side: cache.gridSide,
					from: g.anchor + segment * g.cell, to: g.anchor + (segment + 1) * g.cell,
					reach: lineReach()
				});
			}
		}

		/** How far the edge steps reach from the line, in pixels, before any growth. */
		function lineReach() {
			return lineReachFor(cache.preset, cache.presetOpt);
		}

		function lineReachFor(preset, presetOpt) {
			return preset ? preset.height * Math.max(1, Number(presetOpt && presetOpt.depth) || 1)
				: Math.max(1, settings.step_depth | 0);
		}

		/**
		 * While hovering with the Edge Noise Brush on block lines, highlights the
		 * stretch of line the brush would work on, so it shows before painting and
		 * goes away when the cursor leaves the model.
		 */
		let hoverLineKey = null;
		function hoverGridLine(data) {
			const element = data && data.type === 'element' && data.element;
			const faceKey = data && data.face;
			const face = element && element.faces && element.faces[faceKey];
			const hit = data && data.intersects && data.intersects[0];
			const texture = face && typeof face.getTexture === 'function' && face.getTexture();
			if (!texture || !hit || !hit.uv || typeof Painter.getCanvasToolPixelCoords !== 'function') {
				clearLineMarker();
				return;
			}
			const [x, y] = Painter.getCanvasToolPixelCoords(hit.uv, texture);
			const grid = currentGrid(texture, element, faceKey);
			const line = nearestGridLine(x, y, grid, null);
			const across = line.axis === 'x' ? x : y, along = line.axis === 'x' ? y : x;
			const side = across + 0.5 >= line.pos ? 1 : -1;
			const g = grid[line.axis === 'x' ? 'y' : 'x'];
			const segment = Math.floor((along + 0.5 - g.anchor) / g.cell);
			const key = [element.uuid, faceKey, line.axis, line.pos, side, segment, settings.edge_line_place].join('/');
			if (key === hoverLineKey && lineMarker) return;
			const preset = selectedPreset('edge');
			const reach = lineReachFor(preset, presetOptions('edge', preset ? selectedPresetName('edge') : ''));
			markGridLine(line, texture, { side, from: g.anchor + segment * g.cell, to: g.anchor + (segment + 1) * g.cell, reach }, element, faceKey);
			hoverLineKey = key;
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
				startCache(texture, color, activeMode, opts);
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
			updateGridOverlay();
			clearLineMarker();
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
				const target = settings.grow_mode === 'both' ? null : [150, 150, 150];
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
				return imageToUrl(processImage(data, w, h, settings, settings.grow_mode === 'both' ? null : color, P, 1, opt), w, h);
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
				vue.grow_mode = settings.grow_mode;
				vue.noise = {
					density: settings.noise_density, falloff: settings.noise_falloff,
					grain: settings.noise_grain, seed: settings.noise_seed
				};
				vue.grid = {
					size: String(settings.grid_size), follow: settings.grid_follow_model, show: settings.grid_show,
					show_here: !!settings.grid_show_modes[mode],
					edge_on_grid: settings.edge_on_grid,
					edge_line_place: settings.edge_line_place
				};
				if (!mode || mode === 'grid') return;
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
					grow_mode: { label: 'Grows', type: 'select', value: s.grow_mode, options: {
						brush: 'Brush colour', start: 'Colour where the stroke starts', both: 'Both tones' } },
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


		/* --- texture reference panel --- */

		let referencePanel;

		/** The texture a reference points at, found by its id or, failing that, its name. */
		function referenceTexture(ref) {
			if (typeof Texture === 'undefined') return null;
			if (!ref) return currentTexture();
			return Texture.all.find(t => t.uuid === ref.texture_uuid) || Texture.all.find(t => t.name === ref.texture_name) || null;
		}

		function selectedReference() {
			return settings.references.find(r => r.id === settings.reference_selected) || null;
		}

		function saveReferences() {
			saveSettings();
			if (referencePanel && referencePanel.vue) referencePanel.vue.sync();
		}

		/** Saves the area selected with the selection tool, or the whole texture, as a reference. */
		function addReference() {
			const texture = currentTexture();
			if (!texture || !texture.canvas) {
				Blockbench.showQuickMessage('Select a texture first');
				return;
			}
			const rect = textureSelectionRect(texture) || { x: 0, y: 0, w: texture.canvas.width, h: texture.canvas.height };
			const base = texture.name.replace(/\.png$/i, '') + ` ${rect.w}×${rect.h}`;
			Blockbench.textPrompt('New reference', base, (name) => {
				const ref = {
					id: 'ref' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
					name: String(name || base).trim() || base,
					texture_uuid: texture.uuid, texture_name: texture.name,
					x: rect.x, y: rect.y, w: rect.w, h: rect.h
				};
				settings.references.push(ref);
				settings.reference_selected = ref.id;
				saveReferences();
			});
		}

		function renameReference() {
			const ref = selectedReference();
			if (!ref) return;
			Blockbench.textPrompt('Rename reference', ref.name, (name) => {
				if (!String(name || '').trim()) return;
				ref.name = String(name).trim();
				saveReferences();
			});
		}

		function deleteReference() {
			const ref = selectedReference();
			if (!ref) return;
			settings.references = settings.references.filter(r => r !== ref);
			settings.reference_selected = '';
			saveReferences();
		}

		function pickReferenceColor(texture, x, y, secondary) {
			if (!texture || !texture.canvas || typeof ColorPanel === 'undefined') return;
			const c = texture.canvas;
			if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
			const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
			if (d[3] === 0) return;
			const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
			ColorPanel.set(hex, secondary);
		}

		// cells already filled in the current stroke, so a dab going over one again does not stack opacity
		let gridFilled = new Set();

		/** The grid to paint on for the face under the brush: { x: {anchor, cell}, y: {anchor, cell} }. */
		function currentGrid(texture, onElement, onFace) {
			const fixed = Number(settings.grid_size);
			const auto = settings.grid_size === 'auto' || !(fixed > 0);
			let gx = null, gy = null;
			// the face given, or else the face the painter is on
			const element = onElement || (typeof Painter !== 'undefined' && Painter.current && Painter.current.element);
			const faceKey = onElement ? onFace : Painter.current && Painter.current.face;
			const face = element && element.faces && element.faces[faceKey];
			if (settings.grid_follow_model && face && element.from && element.to && Array.isArray(face.uv) && FACE_AXES[faceKey]) {
				const rot = face.rotation || 0;
				const fx = texture.width / texture.getUVWidth(), fy = texture.display_height / texture.getUVHeight();
				const centred = typeof Format !== 'undefined' && Format.centered_grid;
				// on centred grids block edges sit at +-8 on x and z
				const off = (axis) => centred && FACE_AXES[faceKey][axis][0] !== 1 ? 8 : 0;
				if (rot === 0 || rot === 180) {
					gx = faceGridAxis(element, faceKey, face.uv, 'u', fx, off('u'), rot === 180);
					gy = faceGridAxis(element, faceKey, face.uv, 'v', fy, off('v'), rot === 180);
				} else {
					// turned by 90 or 270 degrees: start the grid at the face's corner
					gx = { anchor: Math.min(face.uv[0], face.uv[2]) * fx, block: 16 };
					gy = { anchor: Math.min(face.uv[1], face.uv[3]) * fy, block: 16 };
				}
			}
			const cellFor = (g) => auto ? (g ? g.block : 16) : fixed;
			return {
				x: { anchor: gx ? gx.anchor : 0, cell: Math.max(1, cellFor(gx)) },
				y: { anchor: gy ? gy.anchor : 0, cell: Math.max(1, cellFor(gy)) }
			};
		}

		/** Block Grid Brush: fills every block cell the brush touches with the brush colour. */
		function gridDraw({ ctx, x, y, size, texture, event }) {
			if (!ctx || !texture) return;
			const grid = currentGrid(texture);
			const secondary = typeof Keybinds !== 'undefined' && Keybinds.extra && Keybinds.extra.paint_secondary_color
				&& Keybinds.extra.paint_secondary_color.keybind.isTriggered(event);
			const color = toRGB(ColorPanel.get(secondary));
			if (!color) return;
			// Blockbench's own settings (this plugin's are called settings too)
			const bbSettings = window.settings;
			const range = bbSettings && bbSettings.opacity_range && bbSettings.opacity_range.value == '255' ? 255 : 100;
			const opacity = Math.max(0, Math.min(1, BarItems.slider_brush_opacity.get() / range));
			ctx.save();
			ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${opacity})`;
			if (Painter.lock_alpha) ctx.globalCompositeOperation = 'source-atop';
			const faceKey = (Painter.current && Painter.current.element ? Painter.current.element.uuid : '') + '/' + (Painter.current && Painter.current.face);
			for (const cell of gridCells(x, y, size, grid.x, grid.y)) {
				const key = faceKey + '/' + cell.key;
				if (gridFilled.has(key)) continue;
				gridFilled.add(key);
				ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
			}
			ctx.restore();
		}

		function setGridSetting(key, value) {
			if (key === 'grid_size') settings.grid_size = value === 'auto' ? 'auto' : Math.max(1, Math.min(256, Math.round(Number(value)) || 16));
			if (key === 'grid_follow_model') settings.grid_follow_model = !!value;
			if (key === 'grid_show') settings.grid_show = !!value;
			if (key === 'edge_on_grid') {
				settings.edge_on_grid = !!value;
				// switching it on ticks Block grid once, so the lines show; unticking that hides them again
				if (value) settings.grid_show_modes = Object.assign({}, settings.grid_show_modes, { edge: true });
				clearCache();
				if (!value) clearLineMarker();
			}
			if (key === 'edge_line_place' && ['center', 'inner', 'outer'].includes(value)) { settings.edge_line_place = value; clearCache(); clearLineMarker(); }
			if (key === 'grid_show_here' && activeMode) settings.grid_show_modes = Object.assign({}, settings.grid_show_modes, { [activeMode]: !!value });
			saveSettings();
			refreshPanel();
			updateGridOverlay();
		}

		/* --- block grid shown on the model --- */

		let gridOverlay = [];       // line objects added to cube meshes
		let gridMaterial = null;
		let gridTimer = null;

		function clearGridOverlay() {
			for (const lines of gridOverlay) {
				if (lines.parent) lines.parent.remove(lines);
				lines.geometry.dispose();
			}
			gridOverlay = [];
		}

		/** Whether the grid should show: Block Grid Brush active, Brush tool in hand, Paint mode. */
		function gridOverlayWanted() {
			if (!activeMode) return false;
			const shown = activeMode === 'grid' ? settings.grid_show : settings.grid_show_modes[activeMode];
			if (!shown) return false;
			if (typeof Modes !== 'undefined' && !Modes.paint) return false;
			const brush = BarItems.brush_tool;
			// holding Alt swaps to the colour picker for a moment: keep the grid up
			return typeof Toolbox !== 'undefined' && (Toolbox.selected === brush || Toolbox.original === brush);
		}

		function buildGridOverlay() {
			clearGridOverlay();
			if (!gridOverlayWanted() || typeof Cube === 'undefined' || typeof THREE === 'undefined') return;
			if (!gridMaterial) {
				gridMaterial = new THREE.LineBasicMaterial({ color: ICON_COLOR, transparent: true, opacity: 0.85 });
			}
			const centred = typeof Format !== 'undefined' && Format.centered_grid;
			const fixed = Number(settings.grid_size);
			const auto = settings.grid_size === 'auto' || !(fixed > 0);
			const offset = (axis) => centred && axis !== 1 ? 8 : 0;
			for (const cube of Cube.all) {
				if (!cube.mesh || cube.visibility === false) continue;
				const faceKeys = Object.keys(FACE_AXES).filter(key => {
					const face = cube.faces[key];
					// skip disabled faces, and faces turned by 90 or 270 degrees, which the brush does not line up either
					return face && face.texture !== null && !(face.rotation === 90 || face.rotation === 270);
				});
				const spacing = (faceKey, axis) => {
					// without snapping, cells start at the texture's corner and do not follow the model
					// (only for the Block Grid Brush itself: the others just show the model's blocks)
					if (activeMode === 'grid' && !settings.grid_follow_model) return 0;
					if (auto) return 16;
					// a fixed cell size in pixels: how many model units that is on this face
					const face = cube.faces[faceKey];
					const tex = face.getTexture && face.getTexture();
					const isU = FACE_AXES[faceKey].u[0] === axis;
					const factor = tex ? (isU ? tex.width / tex.getUVWidth() : tex.display_height / tex.getUVHeight()) : 1;
					const uvSpan = Math.abs(isU ? face.uv[2] - face.uv[0] : face.uv[3] - face.uv[1]);
					const extent = cube.to[axis] - cube.from[axis];
					if (!uvSpan || !extent) return 0;
					return fixed / (uvSpan * factor / extent);
				};
				const points = gridLines(cube, faceKeys, spacing, offset, 0.02);
				if (!points.length) continue;
				const flat = new Float32Array(points.length * 3);
				points.forEach((p, i) => {
					flat[i * 3] = p[0] - cube.origin[0];
					flat[i * 3 + 1] = p[1] - cube.origin[1];
					flat[i * 3 + 2] = p[2] - cube.origin[2];
				});
				const geometry = new THREE.BufferGeometry();
				geometry.setAttribute('position', new THREE.BufferAttribute(flat, 3));
				const lines = new THREE.LineSegments(geometry, gridMaterial);
				lines.name = 'edge_noise_block_grid';
				lines.renderOrder = 2;
				cube.mesh.add(lines);
				gridOverlay.push(lines);
			}
		}

		/* --- the block line the Edge Noise Brush is drawing on --- */

		let lineMarker = null;
		let markerMaterial = null;
		const MARKER_COLOR = '#ffd23f';

		function clearLineMarker() {
			hoverLineKey = null;
			if (!lineMarker) return;
			if (lineMarker.parent) lineMarker.parent.remove(lineMarker);
			lineMarker.geometry.dispose();
			lineMarker = null;
		}

		/**
		 * Highlights where the noise goes: the stretch of the chosen line beside
		 * the block the brush is in, as wide as the band the steps can reach on
		 * the chosen side. band: { side, from, to, reach } in texture pixels.
		 */
		function markGridLine(line, texture, band, onElement, onFace) {
			clearLineMarker();
			if (typeof THREE === 'undefined' || !texture || !band) return;
			const cube = onElement || (Painter.current && Painter.current.element);
			const faceKey = onElement ? onFace : Painter.current && Painter.current.face;
			const face = cube && cube.faces && cube.faces[faceKey];
			const plane = FACE_PLANES[faceKey];
			if (!face || !cube.mesh || !plane || !cube.from || !(face.rotation === 0 || face.rotation === 180 || !face.rotation)) return;
			const fx = texture.width / texture.getUVWidth(), fy = texture.display_height / texture.getUVHeight();
			const turned = face.rotation === 180;
			const acrossUV = line.axis === 'x' ? 'u' : 'v', alongUV = line.axis === 'x' ? 'v' : 'u';
			const factor = (uv) => uv === 'u' ? fx : fy;
			const model = (uv, px) => facePixelToModel(cube, faceKey, face.uv, uv, px, factor(uv), turned);
			// the band across the line, in pixels, for where the noise sits
			const [b0, b1] = lineBandPixels(line.pos, band.side, band.reach, settings.edge_line_place);
			const a0 = model(acrossUV, b0), a1 = model(acrossUV, b1);
			const l0 = model(alongUV, band.from), l1 = model(alongUV, band.to);
			if (!a0 || !a1 || !l0 || !l1) return;
			const [n, end, out] = plane;
			const clampTo = (axis, v) => Math.max(cube.from[axis], Math.min(cube.to[axis], v));
			const size = [0, 0, 0], centre = [0, 0, 0];
			const acrossLo = Math.min(a0.value, a1.value), acrossHi = Math.max(a0.value, a1.value);
			size[a0.axis] = Math.max(0.35, acrossHi - acrossLo); centre[a0.axis] = (acrossLo + acrossHi) / 2;
			const alongLo = clampTo(l0.axis, Math.min(l0.value, l1.value)), alongHi = clampTo(l0.axis, Math.max(l0.value, l1.value));
			size[l0.axis] = Math.max(0.35, alongHi - alongLo); centre[l0.axis] = (alongLo + alongHi) / 2;
			size[n] = 0.06; centre[n] = cube[end][n] + out * 0.05;
			if (!markerMaterial) markerMaterial = new THREE.MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.35, depthWrite: false });
			lineMarker = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), markerMaterial);
			lineMarker.name = 'edge_noise_block_line';
			lineMarker.position.set(centre[0] - cube.origin[0], centre[1] - cube.origin[1], centre[2] - cube.origin[2]);
			lineMarker.renderOrder = 3;
			cube.mesh.add(lineMarker);
		}

		/** Rebuilds the grid shortly, once a burst of changes has settled. */
		function updateGridOverlay() {
			clearTimeout(gridTimer);
			gridTimer = setTimeout(buildGridOverlay, 50);
		}

		function createReferencePanel() {
			referencePanel = new Panel('edge_noise_reference', {
				name: 'Texture Reference',
				icon: 'center_focus_strong',
				growable: true,
				resizable: true,
				default_side: 'right',
				condition: () => Modes.paint,
				default_position: {
					slot: 'right_bar',
					float_position: [0, 0],
					float_size: [320, 360],
					height: 360
				},
				component: {
					data() {
						return { refs: [], selected: '', hover: '', missing: false };
					},
					mounted() {
						// the view: centre of the view in texture pixels, and screen pixels per texture pixel
						this.view = null;
						this.observer = new ResizeObserver(() => this.render());
						this.observer.observe(this.$refs.box);
						this.sync();
					},
					beforeDestroy() {
						if (this.observer) this.observer.disconnect();
					},
					methods: {
						sync() {
							this.refs = settings.references.map(r => ({ id: r.id, name: r.name }));
							this.selected = selectedReference() ? settings.reference_selected : '';
							this.view = null;
							this.render();
						},
						select(id) {
							settings.reference_selected = id;
							saveSettings();
							this.sync();
						},
						addReference, renameReference, deleteReference,
						area() {
							const ref = selectedReference();
							const texture = referenceTexture(ref);
							if (!texture || !texture.canvas || !texture.canvas.width) return null;
							const rect = ref ? ref : { x: 0, y: 0, w: texture.canvas.width, h: texture.canvas.height };
							return { texture, rect };
						},
						resetView() {
							const a = this.area();
							const box = this.$refs.box;
							if (!a || !box) return;
							const W = box.clientWidth || 1, H = box.clientHeight || 1;
							const zoom = Math.max(0.05, Math.min(W / a.rect.w, H / a.rect.h));
							this.view = { cx: a.rect.x + a.rect.w / 2, cy: a.rect.y + a.rect.h / 2, zoom };
							this.render();
						},
						render() {
							const canvas = this.$refs.canvas, box = this.$refs.box;
							if (!canvas || !box) return;
							const W = Math.max(1, box.clientWidth), H = Math.max(1, box.clientHeight);
							if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
							const ctx = canvas.getContext('2d');
							ctx.setTransform(1, 0, 0, 1, 0, 0);
							ctx.clearRect(0, 0, W, H);
							const a = this.area();
							this.missing = !a;
							if (!a) return;
							if (!this.view) { this.resetView(); return; }
							const { cx, cy, zoom } = this.view;
							ctx.imageSmoothingEnabled = false;
							ctx.setTransform(zoom, 0, 0, zoom, W / 2 - cx * zoom, H / 2 - cy * zoom);
							ctx.drawImage(a.texture.canvas, 0, 0);
							ctx.setTransform(1, 0, 0, 1, 0, 0);
							const toScreen = (x, y) => [W / 2 + (x - cx) * zoom, H / 2 + (y - cy) * zoom];
							// pixel grid when zoomed in far enough
							if (zoom >= 10) {
								ctx.strokeStyle = 'rgba(128, 128, 128, 0.25)';
								ctx.lineWidth = 1;
								ctx.beginPath();
								const x0 = Math.floor(cx - W / 2 / zoom), x1 = Math.ceil(cx + W / 2 / zoom);
								const y0 = Math.floor(cy - H / 2 / zoom), y1 = Math.ceil(cy + H / 2 / zoom);
								for (let x = x0; x <= x1; x++) { const [sx] = toScreen(x, 0); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, H); }
								for (let y = y0; y <= y1; y++) { const [, sy] = toScreen(0, y); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(W, Math.round(sy) + 0.5); }
								ctx.stroke();
							}
							// the saved area, so it is easy to find again after panning
							const [rx, ry] = toScreen(a.rect.x, a.rect.y);
							ctx.strokeStyle = ICON_COLOR;
							ctx.lineWidth = 1;
							ctx.strokeRect(Math.round(rx) + 0.5, Math.round(ry) + 0.5, Math.round(a.rect.w * zoom), Math.round(a.rect.h * zoom));
						},
						texturePixel(event) {
							const canvas = this.$refs.canvas;
							if (!canvas || !this.view) return null;
							const b = canvas.getBoundingClientRect();
							const { cx, cy, zoom } = this.view;
							return {
								x: Math.floor(cx + (event.clientX - b.left - canvas.width / 2) / zoom),
								y: Math.floor(cy + (event.clientY - b.top - canvas.height / 2) / zoom)
							};
						},
						onWheel(event) {
							if (!this.view) return;
							const canvas = this.$refs.canvas, b = canvas.getBoundingClientRect();
							const mx = event.clientX - b.left - canvas.width / 2, my = event.clientY - b.top - canvas.height / 2;
							const v = this.view;
							const zoom = Math.max(0.05, Math.min(256, v.zoom * (event.deltaY < 0 ? 1.25 : 0.8)));
							// keep the pixel under the cursor in place
							v.cx += mx / v.zoom - mx / zoom;
							v.cy += my / v.zoom - my / zoom;
							v.zoom = zoom;
							this.render();
						},
						onMouseDown(event) {
							const a = this.area();
							if (!a || !this.view) return;
							if (event.button === 2) {
								const p = this.texturePixel(event);
								if (p) pickReferenceColor(a.texture, p.x, p.y, true);
								return;
							}
							const startX = event.clientX, startY = event.clientY;
							const start = { cx: this.view.cx, cy: this.view.cy };
							let dragged = event.button === 1;
							const move = (e) => {
								if (!dragged && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
								dragged = true;
								this.view.cx = start.cx - (e.clientX - startX) / this.view.zoom;
								this.view.cy = start.cy - (e.clientY - startY) / this.view.zoom;
								this.render();
							};
							const up = (e) => {
								document.removeEventListener('mousemove', move);
								document.removeEventListener('mouseup', up);
								if (!dragged && event.button === 0) {
									const p = this.texturePixel(e);
									if (p) pickReferenceColor(a.texture, p.x, p.y, false);
								}
							};
							document.addEventListener('mousemove', move);
							document.addEventListener('mouseup', up);
						},
						onMouseMove(event) {
							const a = this.area();
							const p = a && this.texturePixel(event);
							if (!p || p.x < 0 || p.y < 0 || p.x >= a.texture.canvas.width || p.y >= a.texture.canvas.height) { this.hover = ''; return; }
							const d = a.texture.canvas.getContext('2d').getImageData(p.x, p.y, 1, 1).data;
							const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
							this.hover = `${p.x}, ${p.y}   ${d[3] ? hex : 'transparent'}`;
						}
					},
					template: `
						<div class="edge_noise_ref">
							<div class="edge_noise_bar">
								<div class="tool" title="New reference from the selected area of the texture (the whole texture if nothing is selected)" @click="addReference()"><i class="material-icons">add_photo_alternate</i></div>
								<div class="tool" v-if="selected" title="Rename this reference" @click="renameReference()"><i class="material-icons">edit</i></div>
								<div class="tool" v-if="selected" title="Delete this reference" @click="deleteReference()"><i class="material-icons">delete</i></div>
								<div class="tool" title="Fit the view (or double-click the view)" @click="resetView()"><i class="material-icons">fit_screen</i></div>
							</div>
							<div class="edge_noise_ref_tabs">
								<div :class="{selected: selected === ''}" @click="select('')">Whole texture</div>
								<div v-for="r in refs" :key="r.id" :class="{selected: selected === r.id}" @click="select(r.id)" :title="r.name">{{ r.name }}</div>
							</div>
							<div class="edge_noise_ref_view" ref="box">
								<canvas ref="canvas" @wheel.prevent="onWheel" @mousedown="onMouseDown" @mousemove="onMouseMove" @mouseleave="hover = ''" @dblclick="resetView()" @contextmenu.prevent></canvas>
								<p class="edge_noise_hint" v-if="missing">The texture of this reference is not open.</p>
							</div>
							<div class="edge_noise_ref_status">{{ hover || 'Click: pick colour   Right-click: secondary   Drag: move   Scroll: zoom' }}</div>
						</div>
					`
				}
			});
		}

		function refreshReference() {
			if (referencePanel && referencePanel.vue) referencePanel.vue.render();
		}

		function createPanel() {
			panel = new Panel('edge_noise_brush', {
				name: 'Texture Garage',
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
							noise: { density: 0, falloff: 0, grain: 1, seed: 1 },
							grow_mode: 'brush',
							grid: { size: '16', follow: true, show: true, show_here: false, edge_on_grid: false, edge_line_place: 'center' }
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
						setOption(key, value) { setPresetOption(this.mode, this.selected, key, value); },
						setGrid(key, value) { setGridSetting(key, value); },
						setGrowMode(value) {
							settings.grow_mode = value;
							saveSettings();
							clearCache();
							refreshPanel();
						}
					},
					template: `
						<div class="edge_noise_panel">
							<template v-if="mode === 'grid'">
								<div class="edge_noise_slider" title="How big one cell of the grid is, in texture pixels. Auto uses the size of one block on the face you paint.">
									<span>Block size</span>
									<select :value="grid.size" @change="setGrid('grid_size', $event.target.value)">
										<option value="auto">Auto (from the model)</option>
										<option value="8">8 px</option>
										<option value="16">16 px</option>
										<option value="32">32 px</option>
										<option value="64">64 px</option>
										<option value="128">128 px</option>
									</select>
								</div>
								<div class="edge_noise_slider" title="Line the cells up with the model's block grid on the face you paint. Off: cells start at the top left corner of the texture.">
									<span>Snap to model</span>
									<input type="checkbox" :checked="grid.follow" @change="setGrid('grid_follow_model', $event.target.checked)">
								</div>
								<div class="edge_noise_slider" title="Draw the cells on the model while this brush is selected.">
									<span>Show grid</span>
									<input type="checkbox" :checked="grid.show" @change="setGrid('grid_show', $event.target.checked)">
								</div>
								<p class="edge_noise_hint">Fills every block cell the brush touches with the brush colour. Paint on the model to line the cells up with its blocks. Brush size decides how many cells one dab covers, and opacity applies once per cell in each stroke.</p>
							</template>
							<template v-if="mode && mode !== 'grid'">
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

								<div class="edge_noise_slider" v-if="mode === 'edge'" title="Only break up the block-grid line nearest the brush, in a band along it. The line is highlighted on the model while you paint.">
									<span>On block lines</span>
									<input type="checkbox" :checked="grid.edge_on_grid" @change="setGrid('edge_on_grid', $event.target.checked)">
								</div>
								<div class="edge_noise_slider" v-if="mode === 'edge' && grid.edge_on_grid" title="Where the noise goes on the line: on both sides of it, only inside the block you are painting in, or only in the block next to it. The highlight on the model shows the band.">
									<span>Noise sits</span>
									<select :value="grid.edge_line_place" @change="setGrid('edge_line_place', $event.target.value)">
										<option value="outer">Outer edge</option>
										<option value="center">Centred</option>
										<option value="inner">Inner edge</option>
									</select>
								</div>
								<div class="edge_noise_slider" v-if="mode === 'edge'" title="Which tone the brush grows into its neighbour.">
									<span>Grows</span>
									<select :value="grow_mode" @change="setGrowMode($event.target.value)">
										<option value="brush">Brush colour</option>
										<option value="start">Colour where the stroke starts</option>
										<option value="both">Both tones</option>
									</select>
								</div>

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
								<div class="edge_noise_slider edge_noise_grid_toggle" title="Draw the model's block grid in the viewport while this brush is selected.">
									<span>Block grid</span>
									<input type="checkbox" :checked="grid.show_here" @change="setGrid('grid_show_here', $event.target.checked)">
								</div>
								<div class="edge_noise_slider" v-if="grid.show_here || (mode === 'edge' && grid.edge_on_grid)" title="How big one cell of the grid is, in texture pixels. Shared with the Block Grid Brush.">
									<span>Block size</span>
									<select :value="grid.size" @change="setGrid('grid_size', $event.target.value)">
										<option value="auto">Auto (from the model)</option>
										<option value="8">8 px</option>
										<option value="16">16 px</option>
										<option value="32">32 px</option>
										<option value="64">64 px</option>
										<option value="128">128 px</option>
									</select>
								</div>
							</template>
						</div>
					`
				}
			});
		}

		const css = `
			.edge_noise_grid_toggle { margin-top: 10px; }
			.edge_noise_ref { display: flex; flex-direction: column; height: 100%; padding: 4px 8px 8px; box-sizing: border-box; }
			.edge_noise_ref_tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
			.edge_noise_ref_tabs > div { padding: 1px 8px; border-radius: 10px; background-color: var(--color-button); cursor: pointer;
				max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.edge_noise_ref_tabs > div.selected { background-color: var(--color-selected); }
			.edge_noise_ref_view { position: relative; flex: 1; min-height: 160px; overflow: hidden;
				background: repeating-conic-gradient(#8883 0% 25%, transparent 0% 50%) 50% / 16px 16px; }
			.edge_noise_ref_view canvas { position: absolute; inset: 0; cursor: crosshair; }
			.edge_noise_ref_view .edge_noise_hint { position: absolute; inset: 0; margin: auto; height: fit-content; text-align: center; }
			.edge_noise_ref_status { color: var(--color-subtle_text); font-size: 0.85em; margin-top: 4px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
			.edge_noise_ref i.material-icons,
			.panel_handle[panel_id="edge_noise_reference"] .icon { color: ${ICON_COLOR} !important; }
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
				loadBrushPreset: Painter.loadBrushPreset,
				onSelect: tool.onSelect,
				onUnselect: tool.onUnselect,
				onCanvasMouseMove: tool.onCanvasMouseMove
			};

			// hovering shows the block line the Edge Noise Brush would work on
			tool.onCanvasMouseMove = function (data) {
				if (activeMode === 'edge' && settings.edge_on_grid && !cache) hoverGridLine(data);
				else if (!cache && lineMarker) clearLineMarker();
				if (original.onCanvasMouseMove) return original.onCanvasMouseMove.apply(this, arguments);
			};

			// the block grid follows the Brush tool being picked up and put down
			tool.onSelect = function () {
				updateGridOverlay();
				if (original.onSelect) return original.onSelect.apply(this, arguments);
			};
			tool.onUnselect = function () {
				updateGridOverlay();
				clearLineMarker();
				if (original.onUnselect) return original.onUnselect.apply(this, arguments);
			};

			tool.brush.changePixel = function (px, py, pxcolor, local_opacity, opts) {
				if (activeMode) return changePixel(px, py, pxcolor, local_opacity, opts);
				return original.changePixel.apply(this, arguments);
			};
			// the Block Grid Brush paints whole cells itself, the painter's per-pixel pass is skipped
			Object.defineProperty(tool.brush, 'draw', {
				configurable: true,
				get() { return activeMode === 'grid' ? gridDraw : undefined; }
			});
			tool.brush.onStrokeStart = function () {
				gridFilled = new Set();
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
				delete tool.brush.draw;
				tool.onSelect = original.onSelect;
				tool.onUnselect = original.onUnselect;
				tool.onCanvasMouseMove = original.onCanvasMouseMove;
				if (tool.side_menu && original.structure) tool.side_menu.structure = original.structure;
				if (tool.setIcon) tool.setIcon(original.icon);
			}
			Painter.loadBrushPreset = original.loadBrushPreset;
			original = null;
		}

		parts.push({
			onload() {
				styleNode = Blockbench.addCSS(css);
				hookBrushTool();
				createPanel();
				createReferencePanel();

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
				// the block grid follows the model, the mode and the textures
				for (const event of ['update_view', 'finished_edit', 'undo', 'redo', 'select_mode', 'select_project', 'update_visibility']) {
					listeners.push(Blockbench.on(event, () => { if (activeMode === 'grid' || gridOverlay.length) updateGridOverlay(); }));
				}
				// the reference view follows edits and the selected texture
				for (const event of ['update_texture_selection', 'finished_edit', 'undo', 'redo', 'select_project']) {
					listeners.push(Blockbench.on(event, refreshReference));
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
				clearTimeout(gridTimer);
				clearGridOverlay();
				clearLineMarker();
				if (gridMaterial) gridMaterial.dispose();
				if (markerMaterial) markerMaterial.dispose();
				unhookBrushTool();
				document.body.classList.remove('edge_noise_brush_active');
				if (panel) panel.delete();
				if (referencePanel) referencePanel.delete();
				if (settingsAction) settingsAction.delete();
				if (styleNode && styleNode.delete) styleNode.delete();
			}
		});
	})();

	/* ======================= modelling: block grid cubes ======================= */

	(function () {
		'use strict';

		const DEFAULTS = {
			mode: 'add',            // 'add', 'cutout' or 'hollow'
			size: 16,               // cube size in model units, 16 = one block
			grid: 'size',           // the grid cubes snap to: 4 to 64 units, or 'size' for the cube size
			add_name: 'ADD',        // name given to cubes made in Add mode
			cutout_name: 'CUTOUT',  // name given to cubes made in Cut out mode
			hollow_name: 'HOLLOW',  // name given to cubes made in Hollow mode
			cutout_inflate: 0.025,  // how much cut-out and hollow cubes are inflated
			x_toggles: true,        // X switches between Add and Cut out while the tool is held
			drag_draw: true         // hold the mouse and drag to place a line of cubes
		};
		const STORAGE_KEY = 'block_grid_modeler_settings';
		const SIZES = [4, 8, 16, 32, 64];
		const MODES = {
			add: { name: 'Add', icon: 'add_box', color: '#3ddc84', inside: false, undo: 'Add block cube' },
			cutout: { name: 'Cut out', icon: 'indeterminate_check_box', color: '#d7263d', inside: true, undo: 'Add cut-out cube' },
			hollow: { name: 'Hollow', icon: 'check_box_outline_blank', color: '#4aa8ff', inside: true, undo: 'Add hollow cube' }
		};
		const TOOL_COLOR = '#d7263d';

		/* ---------- core (pure, testable) ---------- */

		// Outward direction of each cube face.
		const FACE_NORMALS = {
			north: [0, 0, -1], south: [0, 0, 1],
			west: [-1, 0, 0], east: [1, 0, 0],
			down: [0, -1, 0], up: [0, 1, 0]
		};

		/**
		 * Where block edges sit on each axis: 0, or 8 on x and z for formats with
		 * a centred grid such as Bedrock entities, where a block spans -8 to 8.
		 */
		function gridOffset(centred) {
			return centred ? [8, 0, 8] : [0, 0, 0];
		}

		/**
		 * The cube to place for a click at model point `point` on a face facing
		 * `normal`, `size` units on each side, snapped to a grid of `grid` units
		 * laid over the model's block grid (the cube size when not given).
		 *
		 * Across the face, the cube is centred on the cursor as near as the grid
		 * allows. In depth, 'add' places it against the face, outside; 'cutout'
		 * and 'hollow' place it inside, its outer side on the face: on the face
		 * itself when `facePlane` (where the clicked face sits on its axis) is
		 * given, so it is flush even where the face is not on the grid, otherwise
		 * on the grid line nearest the face. Returns { from, to }.
		 */
		function targetCell(point, normal, size, mode, centred, facePlane, grid) {
			const off = gridOffset(centred);
			const step = grid > 0 ? grid : size;
			const inside = mode === 'cutout' || mode === 'hollow';
			const snap = (v, a) => Math.round((v - off[a]) / step) * step + off[a];
			const from = [0, 0, 0], to = [0, 0, 0];
			for (let a = 0; a < 3; a++) {
				if (normal[a] !== 0) {
					const surface = inside && typeof facePlane === 'number' ? facePlane : snap(point[a], a);
					const outward = normal[a] > 0;
					// add builds out from the face, cut out and hollow reach in from it
					if (inside === outward) { to[a] = surface; from[a] = surface - size; }
					else { from[a] = surface; to[a] = surface + size; }
				} else {
					from[a] = snap(point[a] - size / 2, a);
					to[a] = from[a] + size;
				}
			}
			return { from, to };
		}

		/**
		 * The cells from cell a to cell b (both { from }), one step at a time, so
		 * a fast drag still leaves a line with no gaps. Cells are `size` apart;
		 * the axis `fixed` (the layer being drawn on) is left as it is in a.
		 * Returns a list of `from` corners, without a, ending with b.
		 */
		function cellsBetween(a, b, size, fixed) {
			const steps = [0, 1, 2].map(i => i === fixed ? 0 : Math.round((b[i] - a[i]) / size));
			const n = Math.max(Math.abs(steps[0]), Math.abs(steps[1]), Math.abs(steps[2]));
			const out = [];
			for (let k = 1; k <= n; k++) {
				out.push([0, 1, 2].map(i => i === fixed ? a[i] : a[i] + Math.round(steps[i] * k / n) * size));
			}
			return out;
		}

		/** The next mode for the X key: Add and Cut out swap; Hollow goes to Add. */
		function toggledMode(mode) {
			return mode === 'add' ? 'cutout' : 'add';
		}

		if (typeof module !== 'undefined' && module.exports) {
			Object.assign(module.exports, { targetCell, gridOffset, toggledMode, cellsBetween, FACE_NORMALS, MODELER_DEFAULTS: DEFAULTS });
		}
		if (typeof Plugin === 'undefined') return;

		/* ---------- Blockbench integration ---------- */

		let settings = Object.assign({}, DEFAULTS);
		try {
			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
			for (const key in DEFAULTS) if (key in stored) settings[key] = stored[key];
			if (!MODES[settings.mode]) settings.mode = 'add';
		} catch (e) {}
		function saveSettings() {
			try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
		}

		let tool, modeSelect, sizeSelect, gridSelect, toolbar, settingsAction, styleNode, panel;
		let preview = null, previewMaterials = {};
		const listeners = [];

		function nameFor(mode) {
			const key = mode + '_name';
			return String(settings[key] || DEFAULTS[key]).toUpperCase();
		}

		/** The model point and face direction under the cursor, or null if not over a cube. */
		function hitOnCube(data) {
			if (!data || data.type !== 'element' || !(data.element instanceof Cube) || !data.intersects || !data.intersects[0]) return null;
			const cube = data.element;
			const normal = FACE_NORMALS[data.face];
			if (!normal || !cube.mesh) return null;
			// world point -> the cube's own space -> model coordinates
			const local = cube.mesh.worldToLocal(data.intersects[0].point.clone());
			const point = [local.x + cube.origin[0], local.y + cube.origin[1], local.z + cube.origin[2]];
			return { cube, face: data.face, point, normal };
		}

		function cellFor(hit) {
			const centred = typeof Format !== 'undefined' && !!Format.centered_grid;
			// where the clicked face sits on its own axis: the top of the cube for 'up', and so on
			const a = hit.normal.findIndex(v => v !== 0);
			const facePlane = hit.normal[a] > 0 ? hit.cube.to[a] : hit.cube.from[a];
			return targetCell(hit.point, hit.normal, Number(settings.size) || 16, settings.mode, centred, facePlane, gridStep());
		}

		/** The grid step in model units: the chosen grid, or the cube size. */
		function gridStep() {
			return settings.grid === 'size' ? Number(settings.size) || 16 : Number(settings.grid) || Number(settings.size) || 16;
		}

		function setGrid(value) {
			settings.grid = value === 'size' ? 'size' : (SIZES.includes(Number(value)) ? Number(value) : 'size');
			saveSettings();
			if (gridSelect && gridSelect.value !== String(settings.grid)) gridSelect.set(String(settings.grid));
			clearPreview();
			if (lastHover) showPreview(lastHover);
			syncPanel();
		}

		/** Switches mode and keeps the tool bar, panel and preview in step. */
		function setMode(mode) {
			if (!MODES[mode]) return;
			settings.mode = mode;
			saveSettings();
			if (modeSelect && modeSelect.value !== mode) modeSelect.set(mode);
			clearPreview();
			if (lastHover) showPreview(lastHover);
			syncPanel();
		}

		function setSize(size) {
			const v = Math.max(1, Math.min(256, Math.round(Number(size)) || 16));
			settings.size = v;
			saveSettings();
			if (sizeSelect && SIZES.includes(v)) sizeSelect.set(String(v));
			clearPreview();
			if (lastHover) showPreview(lastHover);
			syncPanel();
		}

		/* --- hover preview --- */

		let lastHover = null;

		function clearPreview() {
			if (!preview) return;
			if (preview.parent) preview.parent.remove(preview);
			preview.geometry.dispose();
			preview = null;
		}

		/** Shows a wire box where the next cube would go, in the space of the cube being pointed at. */
		function showPreview(hit) {
			clearPreview();
			lastHover = hit;
			if (!hit) return;
			const cell = cellFor(hit);
			const mode = MODES[settings.mode];
			if (!previewMaterials[settings.mode]) {
				previewMaterials[settings.mode] = new THREE.LineBasicMaterial({ color: mode.color, depthTest: false, transparent: true });
			}
			const grow = mode.inside ? Number(settings.cutout_inflate) || 0 : 0;
			const size = [0, 1, 2].map(a => cell.to[a] - cell.from[a] + grow * 2);
			const box = new THREE.BoxGeometry(size[0], size[1], size[2]);
			preview = new THREE.LineSegments(new THREE.EdgesGeometry(box), previewMaterials[settings.mode]);
			box.dispose();
			preview.name = 'block_grid_modeler_preview';
			preview.renderOrder = 10;
			const c = hit.cube;
			preview.position.set(
				(cell.from[0] + cell.to[0]) / 2 - c.origin[0],
				(cell.from[1] + cell.to[1]) / 2 - c.origin[1],
				(cell.from[2] + cell.to[2]) / 2 - c.origin[2]
			);
			c.mesh.add(preview);
		}

		/* --- adding cubes --- */

		function sameCubeExists(name, from, to) {
			return Cube.all.some(c => c.name === name
				&& c.from.every((v, i) => Math.abs(v - from[i]) < 1e-6)
				&& c.to.every((v, i) => Math.abs(v - to[i]) < 1e-6));
		}

		/**
		 * Makes one cube in the cell for the current mode, next to the cube `source`
		 * that was clicked, without an undo step of its own. Returns it, or null if
		 * the same cube is already there.
		 */
		function makeCube(cell, source, faceKey) {
			const mode = MODES[settings.mode];
			const name = nameFor(settings.mode);
			if (sameCubeExists(name, cell.from, cell.to)) return null;
			const parent = source.parent instanceof Group ? source.parent : null;
			const cube = new Cube({
				name,
				from: cell.from.slice(),
				to: cell.to.slice(),
				// keep the pivot of the cube it was placed against, so it moves with the same bone
				origin: source.origin.slice(),
				inflate: mode.inside ? Number(settings.cutout_inflate) || 0 : 0,
				box_uv: source.box_uv,
				autouv: source.autouv
			}).init();
			if (parent) {
				cube.addTo(parent);
				cube.scope = parent.scope;
			}
			// same texture as the face clicked on, on every face
			const texture = source.faces[faceKey] && source.faces[faceKey].texture;
			for (const key in cube.faces) {
				if (texture !== undefined) cube.faces[key].texture = texture;
			}
			if (!cube.box_uv) cube.mapAutoUV();
			Canvas.updateView({ elements: [cube], element_aspects: { transform: true, geometry: true, faces: true } });
			return cube;
		}

		/*
		 * A placing stroke: pressing on a face places the first cube; with
		 * "Hold to draw" on, dragging keeps placing cubes on the same layer as
		 * the first one (the same depth along the face's direction), filling any
		 * gaps, until the mouse is let go. The whole stroke is one undo step.
		 */
		let stroke = null;

		function startStroke(hit) {
			const cell = cellFor(hit);
			const axis = hit.normal.findIndex(v => v !== 0);
			Undo.initEdit({ outliner: true, elements: [], selection: true });
			stroke = { source: hit.cube, face: hit.face, normal: hit.normal.join(','), axis, layer: cell.from[axis], start: cell.from.slice(), last: cell.from.slice(), cubes: [] };
			const cube = makeCube(cell, hit.cube, hit.face);
			if (cube) stroke.cubes.push(cube);
			else Blockbench.showQuickMessage(`${nameFor(settings.mode)} cube is already there`);
			window.addEventListener('mouseup', endStroke, true);
			if (!settings.drag_draw) endStroke();
		}

		function continueStroke(hit) {
			if (!stroke || !hit || hit.normal.join(',') !== stroke.normal) return;
			const size = Number(settings.size) || 16;
			const cell = cellFor(hit);
			// stay on the layer the stroke started on, and a whole cube apart from its first cube,
			// so a grid finer than the cube does not leave overlaps or slivers along the line
			cell.from[stroke.axis] = stroke.layer;
			for (let i = 0; i < 3; i++) {
				if (i !== stroke.axis) cell.from[i] = stroke.start[i] + Math.round((cell.from[i] - stroke.start[i]) / size) * size;
			}
			if (cell.from.every((v, i) => v === stroke.last[i])) return;
			for (const from of cellsBetween(stroke.last, cell.from, size, stroke.axis)) {
				const cube = makeCube({ from, to: from.map(v => v + size) }, stroke.source, stroke.face);
				if (cube) stroke.cubes.push(cube);
			}
			stroke.last = cell.from.slice();
		}

		function endStroke() {
			window.removeEventListener('mouseup', endStroke, true);
			if (!stroke) return;
			const { cubes } = stroke;
			stroke = null;
			if (!cubes.length) {
				if (typeof Undo.cancelEdit === 'function') Undo.cancelEdit(false);
				return;
			}
			unselectAllElements();
			cubes.forEach(c => c.select());
			Canvas.updateView({ elements: cubes, selection: true });
			const mode = MODES[settings.mode];
			Undo.finishEdit(cubes.length === 1 ? mode.undo : `${mode.undo} ×${cubes.length}`, { outliner: true, elements: cubes, selection: true });
			cubes.forEach(cube => Blockbench.dispatchEvent('add_cube', { object: cube }));
			syncPanel();
		}

		/**
		 * Puts the tool in the toolbox exactly once. Blockbench remembers the
		 * toolbox by tool name, and another copy of this tool (an older version,
		 * or the separate Block Grid Modeler plugin) can leave entries behind, so
		 * every entry with this name is removed first, keeping the place of the
		 * first one.
		 */
		function addToToolboxOnce(t) {
			if (typeof Toolbox === 'undefined' || !Toolbox.children) return;
			let place = -1;
			for (let i = Toolbox.children.length - 1; i >= 0; i--) {
				const item = Toolbox.children[i];
				const id = typeof item === 'string' ? item : item && item.id;
				if (id !== t.id) continue;
				place = i;
				if (item && typeof item === 'object' && item !== t && Array.isArray(item.toolbars)) {
					const j = item.toolbars.indexOf(Toolbox);
					if (j >= 0) item.toolbars.splice(j, 1);
				}
				Toolbox.children.splice(i, 1);
			}
			if (Toolbox.postload) Toolbox.postload = Toolbox.postload.filter(entry => entry[0] !== t.id);
			try { Toolbox.add(t, place >= 0 ? place : undefined); } catch (e) {}
		}

		/* --- X key --- */

		function isTyping(event) {
			const t = event.target;
			return t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
		}

		/**
		 * X switches between Add and Cut out while the tool is in hand. Caught
		 * before Blockbench sees it, where X would otherwise pick the Vertex Snap
		 * tool; with any other tool, X does what it always does.
		 */
		function onKeyDown(event) {
			if (!settings.x_toggles || !tool || Toolbox.selected !== tool) return;
			if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isTyping(event)) return;
			if (event.key !== 'x' && event.key !== 'X') return;
			event.preventDefault();
			event.stopImmediatePropagation();
			setMode(toggledMode(settings.mode));
			Blockbench.showQuickMessage(MODES[settings.mode].name, 700);
		}

		/* --- panel --- */

		function countByName() {
			const counts = {};
			for (const mode in MODES) counts[mode] = Cube.all.filter(c => c.name === nameFor(mode)).length;
			return counts;
		}

		function syncPanel() {
			if (!panel || !panel.vue) return;
			const vue = panel.vue;
			vue.mode = settings.mode;
			vue.size = Number(settings.size) || 16;
			vue.grid = String(settings.grid);
			vue.names = { add: settings.add_name, cutout: settings.cutout_name, hollow: settings.hollow_name };
			vue.inflate = settings.cutout_inflate;
			vue.x_toggles = settings.x_toggles;
			vue.drag_draw = settings.drag_draw;
			try { vue.counts = countByName(); } catch (e) {}
		}

		function createPanel() {
			panel = new Panel('block_grid_cube_panel', {
				name: 'Block Grid Cube',
				icon: 'view_in_ar',
				growable: true,
				resizable: true,
				default_side: 'right',
				condition: () => Modes.edit && tool && Toolbox.selected === tool,
				default_position: {
					slot: 'right_bar',
					float_position: [0, 0],
					float_size: [300, 360],
					height: 360
				},
				component: {
					data() {
						return {
							modes: Object.keys(MODES).map(key => ({ key, name: MODES[key].name, icon: MODES[key].icon, color: MODES[key].color })),
							sizes: SIZES,
							mode: settings.mode,
							size: Number(settings.size) || 16,
							grid: String(settings.grid),
							names: { add: settings.add_name, cutout: settings.cutout_name, hollow: settings.hollow_name },
							inflate: settings.cutout_inflate,
							x_toggles: settings.x_toggles,
							drag_draw: settings.drag_draw,
							counts: { add: 0, cutout: 0, hollow: 0 }
						};
					},
					computed: {
						custom_size() { return !this.sizes.includes(this.size); }
					},
					methods: {
						setMode(mode) { setMode(mode); },
						setSize(size) { setSize(size); },
						setGrid(value) { setGrid(value); },
						setName(mode, value) {
							settings[mode + '_name'] = String(value || DEFAULTS[mode + '_name']).toUpperCase().trim() || DEFAULTS[mode + '_name'];
							saveSettings();
							syncPanel();
						},
						setInflate(value) {
							settings.cutout_inflate = Math.max(0, Math.min(1, Number(value) || 0));
							saveSettings();
							syncPanel();
						},
						setToggle(value) {
							settings.x_toggles = !!value;
							saveSettings();
							syncPanel();
						},
						setDrag(value) {
							settings.drag_draw = !!value;
							saveSettings();
							syncPanel();
						},
						patch() {
							if (typeof BarItems !== 'undefined' && BarItems.block_patcher) BarItems.block_patcher.trigger();
						}
					},
					template: `
						<div class="bgc_panel">
							<label>Mode</label>
							<div class="bgc_buttons">
								<div v-for="m in modes" :key="m.key" class="bgc_button" :class="{selected: mode === m.key}" @click="setMode(m.key)" :title="m.name">
									<i class="material-icons" :style="{color: m.color}">{{ m.icon }}</i><span>{{ m.name }}</span>
								</div>
							</div>
							<p class="bgc_hint" v-if="x_toggles">Press X to switch between Add and Cut out.</p>

							<label>Cube size <span class="bgc_subtle">in model units, 16 is one block</span></label>
							<div class="bgc_buttons">
								<div v-for="s in sizes" :key="s" class="bgc_button bgc_size" :class="{selected: size === s}" @click="setSize(s)">{{ s }}</div>
								<input type="number" class="bgc_custom" :class="{selected: custom_size}" min="1" max="256" :value="size" @change="setSize($event.target.value)" title="Any other size">
							</div>

							<label>Grid <span class="bgc_subtle">where cubes may sit, in model units</span></label>
							<div class="bgc_buttons">
								<div class="bgc_button" :class="{selected: grid === 'size'}" @click="setGrid('size')" title="Snap to a grid as big as the cube">Cube size</div>
								<div v-for="s in sizes" :key="'g' + s" class="bgc_button bgc_size" :class="{selected: grid === String(s)}" @click="setGrid(s)">{{ s }}</div>
							</div>

							<label>Names <span class="bgc_subtle">for your build script, always in capitals</span></label>
							<div class="bgc_row" v-for="m in modes" :key="'n' + m.key">
								<i class="material-icons" :style="{color: m.color}">{{ m.icon }}</i>
								<input type="text" :value="names[m.key]" @change="setName(m.key, $event.target.value)">
								<span class="bgc_subtle" :title="'Cubes named ' + names[m.key] + ' in this model'">{{ counts[m.key] }}</span>
							</div>

							<div class="bgc_row">
								<span>Inflate</span>
								<input type="number" min="0" max="1" step="0.005" :value="inflate" @change="setInflate($event.target.value)" title="How much Cut out and Hollow cubes are inflated">
								<span class="bgc_subtle">cut out, hollow</span>
							</div>
							<div class="bgc_row">
								<input type="checkbox" :checked="x_toggles" @change="setToggle($event.target.checked)">
								<span>X switches Add and Cut out</span>
							</div>
							<div class="bgc_row" title="Hold the mouse and drag across faces to place a line of cubes on the same layer as the first one.">
								<input type="checkbox" :checked="drag_draw" @change="setDrag($event.target.checked)">
								<span>Hold to draw a line of cubes</span>
							</div>
							<label>Apply <span class="bgc_subtle">turn the cubes above into real geometry</span></label>
							<div class="bgc_buttons">
								<div class="bgc_button" @click="patch()" title="Apply ADD, CUTOUT and HOLLOW cubes, merge cubes and lay out the UV, in a preview tab you confirm">
									<i class="material-icons" style="color:#d7263d">auto_fix_high</i><span>BlockPatcher</span>
								</div>
							</div>
						</div>
					`
				}
			});
		}

		/* --- settings dialog (also under Tools) --- */

		function openSettings() {
			new Dialog({
				id: 'block_grid_modeler_settings',
				title: 'Block Grid Cube',
				width: 400,
				form: {
					add_name: { label: 'Name for added cubes', type: 'text', value: settings.add_name },
					cutout_name: { label: 'Name for cut-out cubes', type: 'text', value: settings.cutout_name },
					hollow_name: { label: 'Name for hollow cubes', type: 'text', value: settings.hollow_name },
					cutout_inflate: { label: 'Inflate (cut out, hollow)', type: 'number', value: settings.cutout_inflate, step: 0.005, min: 0, max: 1 },
					x_toggles: { label: 'X switches Add and Cut out', type: 'checkbox', value: settings.x_toggles },
					drag_draw: { label: 'Hold to draw a line of cubes', type: 'checkbox', value: settings.drag_draw },
					_info: { type: 'info', text: 'Names are always written in capitals. Change them to whatever your build script looks for.' }
				},
				onConfirm(result) {
					for (const mode in MODES) {
						settings[mode + '_name'] = String(result[mode + '_name'] || DEFAULTS[mode + '_name']).toUpperCase();
					}
					settings.cutout_inflate = Math.max(0, Number(result.cutout_inflate) || 0);
					settings.x_toggles = !!result.x_toggles;
					settings.drag_draw = !!result.drag_draw;
					saveSettings();
					syncPanel();
				}
			}).show();
		}

		parts.push({
			onload() {
				styleNode = Blockbench.addCSS(`
					[toolbar_item="block_grid_cube"] .icon, [menu_item="block_grid_cube"] > .icon,
					[menu_item="block_grid_modeler_settings"] > .icon,
					.panel_handle[panel_id="block_grid_cube_panel"] .icon { color: ${TOOL_COLOR} !important; }
					.bgc_panel { padding: 4px 8px 8px; }
					.bgc_panel > label { display: block; margin: 8px 0 4px; color: var(--color-subtle_text); }
					.bgc_subtle { color: var(--color-subtle_text); font-size: 0.85em; }
					.bgc_buttons { display: flex; flex-wrap: wrap; gap: 4px; }
					.bgc_button { display: flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 4px;
						background-color: var(--color-button); cursor: pointer; }
					.bgc_button:hover { background-color: var(--color-selected); }
					.bgc_button.selected { background-color: var(--color-accent); color: var(--color-accent_text); }
					.bgc_size { min-width: 28px; justify-content: center; }
					.bgc_custom { width: 64px; }
					.bgc_custom.selected { outline: 2px solid var(--color-accent); }
					.bgc_row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
					.bgc_row input[type=text] { flex: 1; min-width: 0; }
					.bgc_row input[type=number] { width: 80px; }
					.bgc_hint { color: var(--color-subtle_text); font-size: 0.85em; margin: 4px 0 0; }
				`);

				modeSelect = new BarSelect('block_grid_cube_mode', {
					name: 'Mode',
					value: settings.mode,
					options: Object.fromEntries(Object.keys(MODES).map(key => [key, { name: MODES[key].name, icon: MODES[key].icon }])),
					onChange() { setMode(this.value); }
				});
				sizeSelect = new BarSelect('block_grid_cube_size', {
					name: 'Cube size',
					value: String(SIZES.includes(Number(settings.size)) ? settings.size : 16),
					options: Object.fromEntries(SIZES.map(s => [String(s), s === 16 ? '16 (1 block)' : `${s}`])),
					onChange() { setSize(this.value); }
				});
				gridSelect = new BarSelect('block_grid_cube_grid', {
					name: 'Grid',
					value: String(settings.grid),
					options: Object.assign({ size: 'Grid: cube size' }, Object.fromEntries(SIZES.map(s => [String(s), `Grid: ${s}`]))),
					onChange() { setGrid(this.value); }
				});
				toolbar = new Toolbar('block_grid_cube', {
					children: ['block_grid_cube_mode', 'block_grid_cube_size', 'block_grid_cube_grid']
				});

				tool = new Tool('block_grid_cube', {
					name: 'Block Grid Cube',
					description: 'Click a face to add a cube on the block grid, cut one out or mark one hollow. X switches between Add and Cut out',
					icon: 'view_in_ar',
					category: 'tools',
					toolbar: 'block_grid_cube',
					cursor: 'crosshair',
					selectFace: false,
					selectElements: false,
					transformerMode: 'hidden',
					allowWireframe: true,
					modes: ['edit'],
					onCanvasMouseMove(data) {
						const hit = hitOnCube(data);
						if (stroke) continueStroke(hit);
						showPreview(hit);
					},
					onCanvasClick(data) {
						const hit = hitOnCube(data);
						if (hit) startStroke(hit);
					},
					onSelect() {
						modeSelect.set(settings.mode);
						if (SIZES.includes(Number(settings.size))) sizeSelect.set(String(settings.size));
						gridSelect.set(String(settings.grid));
						syncPanel();
						if (typeof updateInterfacePanels === 'function') updateInterfacePanels();
					},
					onUnselect() {
						clearPreview();
						lastHover = null;
						// the panel goes away with the tool, once the switch has happened
						setTimeout(() => { if (typeof updateInterfacePanels === 'function') updateInterfacePanels(); }, 0);
					}
				});
				addToToolboxOnce(tool);

				createPanel();
				window.addEventListener('keydown', onKeyDown, true);
				for (const event of ['finished_edit', 'undo', 'redo', 'select_project']) {
					listeners.push(Blockbench.on(event, syncPanel));
				}

				settingsAction = new Action('block_grid_modeler_settings', {
					name: 'Block Grid Cube Settings',
					icon: 'tune',
					click: openSettings
				});
				MenuBar.addAction(settingsAction, 'tools');
			},
			onunload() {
				window.removeEventListener('keydown', onKeyDown, true);
				window.removeEventListener('mouseup', endStroke, true);
				stroke = null;
				listeners.forEach(l => l && l.delete && l.delete());
				listeners.length = 0;
				clearPreview();
				for (const key in previewMaterials) previewMaterials[key].dispose();
				if (panel) panel.delete();
				if (tool) tool.delete();
				if (toolbar && toolbar.node) toolbar.node.remove();
				if (typeof Toolbars !== 'undefined') delete Toolbars.block_grid_cube;
				if (modeSelect) modeSelect.delete();
				if (sizeSelect) sizeSelect.delete();
				if (gridSelect) gridSelect.delete();
				if (settingsAction) settingsAction.delete();
				if (styleNode && styleNode.delete) styleNode.delete();
			}
		});
	})();

	/* ======================= BlockPatcher ======================= */
	(function () {
		'use strict';

		/* --- BlockPatcher core ---
		 * Works on plain data, so it runs (and is tested) outside Blockbench:
		 *   model   a .bbmodel object (elements with face texture indexes, groups, outliner, resolution)
		 *   images  one { w, h, data: RGBA } per texture index
		 * and returns the patched model and images plus what happened. Nothing here touches Blockbench.
		 */
		const BP_DEFAULTS = {
			add_name: 'ADD',
			cutout_name: 'CUTOUT',
			hollow_name: 'HOLLOW',
			wall_shade: 70,          // % brightness of new inner walls (cutout sides, hollow walls)
			retexture_add: true,     // paint ADD cubes with the pattern of the cube they attach to
			merge: 'all',            // 'all' | 'patched' (only merge where a patch changed something) | 'off'
			cull_hidden: true,       // drop faces that are fully covered by touching cubes
			uv_mode: 'all',          // 'all' repack everything by group | 'changed' keep untouched faces where they are
			padding: 0,              // pixels between packed faces
			uv_cull: false,          // Organize UV: drop hidden faces too
			uv_only: false,          // Organize UV: leave geometry alone, only lay out the UV (and drop hidden faces if cull_hidden)
		};

		const BP_FACES = ['east', 'north', 'west', 'south', 'up', 'down'];
		// outward side of each face: [model axis, sign]
		const BP_DIRS = { north: [2, -1], south: [2, 1], west: [0, -1], east: [0, 1], down: [1, -1], up: [1, 1] };
		const BP_OPPOSITE = { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' };
		// texture u / v of each face: [model axis, end of the cube the UV starts at, direction]
		// (the same table as Blockbench's automatic UV, see FACE_AXES above)
		const BP_AXES = {
			north: { u: [0, 'to', -1], v: [1, 'to', -1] },
			south: { u: [0, 'from', 1], v: [1, 'to', -1] },
			west: { u: [2, 'from', 1], v: [1, 'to', -1] },
			east: { u: [2, 'to', -1], v: [1, 'to', -1] },
			up: { u: [0, 'from', 1], v: [2, 'from', 1] },
			down: { u: [0, 'from', 1], v: [2, 'to', -1] }
		};
		const EPS = 1e-6;

		function bpUuid() {
			if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
			return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
				const r = Math.random() * 16 | 0;
				return (c === 'x' ? r : (r & 3 | 8)).toString(16);
			});
		}

		/* --- images --- */
		function newImage(w, h) { return { w, h, data: new Uint8ClampedArray(w * h * 4) }; }
		function cropImage(img, x0, y0, w, h) {
			const out = newImage(w, h);
			for (let y = 0; y < h; y++) {
				const sy = Math.min(img.h - 1, Math.max(0, y0 + y));
				for (let x = 0; x < w; x++) {
					const sx = Math.min(img.w - 1, Math.max(0, x0 + x));
					const s = (sy * img.w + sx) * 4, d = (y * w + x) * 4;
					out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = img.data[s + 3];
				}
			}
			return out;
		}
		function blit(dst, src, dx, dy) {
			for (let y = 0; y < src.h; y++) {
				const ty = dy + y;
				if (ty < 0 || ty >= dst.h) continue;
				for (let x = 0; x < src.w; x++) {
					const tx = dx + x;
					if (tx < 0 || tx >= dst.w) continue;
					const s = (y * src.w + x) * 4, d = (ty * dst.w + tx) * 4;
					dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1]; dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = src.data[s + 3];
				}
			}
		}
		function imageKey(img) {
			// cheap content hash, used to tell whether a face's pixels changed
			let h = 2166136261 >>> 0;
			for (let i = 0; i < img.data.length; i += 1) { h ^= img.data[i]; h = Math.imul(h, 16777619) >>> 0; }
			return img.w + 'x' + img.h + ':' + h;
		}

		/* --- boxes --- */
		function ext(b, a) { return b.to[a] - b.from[a]; }
		function overlapsVolume(a, b) {
			for (let i = 0; i < 3; i++) if (Math.min(a.to[i], b.to[i]) - Math.max(a.from[i], b.from[i]) <= EPS) return false;
			return true;
		}
		function overlapVolume(a, b) {
			let v = 1;
			for (let i = 0; i < 3; i++) v *= Math.max(0, Math.min(a.to[i], b.to[i]) - Math.max(a.from[i], b.from[i]));
			return v;
		}
		/** Area where two boxes touch face to face (0 if they don't). */
		function contactArea(a, b) {
			for (let k = 0; k < 3; k++) {
				if (Math.abs(a.to[k] - b.from[k]) < EPS || Math.abs(b.to[k] - a.from[k]) < EPS) {
					let area = 1;
					for (let i = 0; i < 3; i++) {
						if (i === k) continue;
						area *= Math.max(0, Math.min(a.to[i], b.to[i]) - Math.max(a.from[i], b.from[i]));
					}
					if (area > EPS) return area;
				}
			}
			return 0;
		}
		/** a minus c, as up to six boxes that fill a without c. */
		function subtractBox(a, c) {
			if (!overlapsVolume(a, c)) return [{ from: a.from.slice(), to: a.to.slice() }];
			const out = [];
			const cur = { from: a.from.slice(), to: a.to.slice() };
			for (const ax of [1, 0, 2]) {
				if (c.from[ax] > cur.from[ax] + EPS) {
					const p = { from: cur.from.slice(), to: cur.to.slice() };
					p.to[ax] = c.from[ax]; out.push(p); cur.from[ax] = c.from[ax];
				}
				if (c.to[ax] < cur.to[ax] - EPS) {
					const p = { from: cur.from.slice(), to: cur.to.slice() };
					p.from[ax] = c.to[ax]; out.push(p); cur.to[ax] = c.to[ax];
				}
			}
			return out;
		}
		function facePlane(b, d) { const [a, s] = BP_DIRS[d]; return s > 0 ? b.to[a] : b.from[a]; }
		/** The face's rectangle on its plane: [[u0,u1],[v0,v1]] in model units along the face's u/v model axes. */
		function faceRect(b, d) {
			const ax = BP_AXES[d];
			return [[b.from[ax.u[0]], b.to[ax.u[0]]], [b.from[ax.v[0]], b.to[ax.v[0]]]];
		}
		function rectIntersect(r, s) {
			const u0 = Math.max(r[0][0], s[0][0]), u1 = Math.min(r[0][1], s[0][1]);
			const v0 = Math.max(r[1][0], s[1][0]), v1 = Math.min(r[1][1], s[1][1]);
			if (u1 - u0 <= EPS || v1 - v0 <= EPS) return null;
			return [[u0, u1], [v0, v1]];
		}
		/** Does the union of rects cover r completely? */
		function rectsCover(r, rects) {
			if (!rects.length) return false;
			const us = new Set([r[0][0], r[0][1]]), vs = new Set([r[1][0], r[1][1]]);
			for (const s of rects) { us.add(s[0][0]); us.add(s[0][1]); vs.add(s[1][0]); vs.add(s[1][1]); }
			const U = [...us].filter(x => x >= r[0][0] - EPS && x <= r[0][1] + EPS).sort((a, b) => a - b);
			const V = [...vs].filter(x => x >= r[1][0] - EPS && x <= r[1][1] + EPS).sort((a, b) => a - b);
			for (let i = 0; i + 1 < U.length; i++) {
				if (U[i + 1] - U[i] <= EPS) continue;
				const cu = (U[i] + U[i + 1]) / 2;
				for (let j = 0; j + 1 < V.length; j++) {
					if (V[j + 1] - V[j] <= EPS) continue;
					const cv = (V[j] + V[j + 1]) / 2;
					if (!rects.some(s => cu > s[0][0] && cu < s[0][1] && cv > s[1][0] && cv < s[1][1])) return false;
				}
			}
			return true;
		}
		/**
		 * Pixel range of the model range [p0, p1] along one face axis of box b,
		 * for a face image with ppu pixels per model unit.
		 */
		function pxRange(b, info, p0, p1, ppu) {
			const [a, end, dir] = info;
			const start = b[end][a];
			const x0 = dir * (p0 - start) * ppu, x1 = dir * (p1 - start) * ppu;
			return [Math.round(Math.min(x0, x1)), Math.round(Math.max(x0, x1))];
		}

		/**
		 * Skyline packing: items (with w, h, group) in their order, groups kept in sequence,
		 * tallest first inside a group. Writes _x/_y on each item, returns the used height.
		 */
		function skyline(items, width, top, pad) {
			let sky = [{ x: 0, y: top, w: width }];
			let height = top;
			const groups = [];
			for (const it of items) {
				if (!groups.length || groups[groups.length - 1].group !== it.group) groups.push({ group: it.group, items: [] });
				groups[groups.length - 1].items.push(it);
			}
			for (const g of groups) {
				g.items.sort((a, b) => (b.h - a.h) || (b.w - a.w));
				for (const it of g.items) {
					const w = it.w + pad, h = it.h + pad;
					let best = null;
					for (let i = 0; i < sky.length; i++) {
						if (sky[i].x + w > width + pad) break;
						// highest skyline under [x, x + w)
						let y = 0, rest = w, j = i;
						while (rest > 0 && j < sky.length) { y = Math.max(y, sky[j].y); rest -= sky[j].w; j++; }
						if (rest > 0) continue;
						if (!best || y + h < best.y + best.h || (y + h === best.y + best.h && sky[i].x < best.x)) best = { i, x: sky[i].x, y, h };
					}
					if (!best) best = { i: 0, x: 0, y: Math.max(...sky.map(s => s.y)), h };
					it._x = best.x; it._y = best.y;
					height = Math.max(height, best.y + it.h);
					// raise the skyline under the new item
					const nx = best.x, nw = w, ny = best.y + h;
					const next = [];
					for (const seg of sky) {
						const s0 = seg.x, s1 = seg.x + seg.w;
						if (s1 <= nx || s0 >= nx + nw) { next.push(seg); continue; }
						if (s0 < nx) next.push({ x: s0, y: seg.y, w: nx - s0 });
						if (s1 > nx + nw) next.push({ x: nx + nw, y: seg.y, w: s1 - nx - nw });
					}
					next.push({ x: nx, y: ny, w: nw });
					next.sort((a, b) => a.x - b.x);
					sky = [];
					for (const seg of next) {
						const last = sky[sky.length - 1];
						if (last && last.y === seg.y && last.x + last.w === seg.x) last.w += seg.w; else sky.push(seg);
					}
				}
			}
			return { height };
		}

		/* --- faces ---
		 * A face is { img, tex, ppu: [u, v], orig } where img runs along the face's u/v axes from the
		 * corner BP_AXES names, ppu is pixels per model unit, and orig (only on untouched faces) is the
		 * original face JSON so it can stay where it was in the texture.
		 */
		function faceCorners(face) {
			const uv = face.uv;
			let c = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[0], uv[3]], [uv[2], uv[3]]];
			let r = ((face.rotation || 0) % 360 + 360) % 360;
			while (r > 0) { c = [c[2], c[0], c[3], c[1]]; r -= 90; }
			return c;
		}
		function readFace(box, d, faceJson, images, scale) {
			const img = images[faceJson.texture];
			if (!img) return null;
			const [fx, fy] = scale(faceJson.texture);
			const c = faceCorners(faceJson);
			const du = [(c[1][0] - c[0][0]) * fx, (c[1][1] - c[0][1]) * fy];
			const dv = [(c[2][0] - c[0][0]) * fx, (c[2][1] - c[0][1]) * fy];
			const ax = BP_AXES[d];
			const eu = ext(box, ax.u[0]), ev = ext(box, ax.v[0]);
			let w = Math.round(Math.abs(du[0]) + Math.abs(du[1]));
			let h = Math.round(Math.abs(dv[0]) + Math.abs(dv[1]));
			if (w < 1) w = Math.max(1, Math.round(eu));
			if (h < 1) h = Math.max(1, Math.round(ev));
			const out = newImage(w, h);
			const ox = c[0][0] * fx, oy = c[0][1] * fy;
			for (let j = 0; j < h; j++) {
				for (let i = 0; i < w; i++) {
					const s = (i + 0.5) / w, t = (j + 0.5) / h;
					let x = Math.floor(ox + s * du[0] + t * dv[0]);
					let y = Math.floor(oy + s * du[1] + t * dv[1]);
					x = Math.min(img.w - 1, Math.max(0, x)); y = Math.min(img.h - 1, Math.max(0, y));
					const si = (y * img.w + x) * 4, di = (j * w + i) * 4;
					out.data[di] = img.data[si]; out.data[di + 1] = img.data[si + 1]; out.data[di + 2] = img.data[si + 2]; out.data[di + 3] = img.data[si + 3];
				}
			}
			return { img: out, tex: faceJson.texture, ppu: [eu > EPS ? w / eu : w, ev > EPS ? h / ev : h], orig: faceJson };
		}
		/** The part of face d of box b that piece p (inside b, sharing that face's plane) covers. */
		function cropFace(face, b, p, d) {
			const ax = BP_AXES[d];
			const [x0, x1] = pxRange(b, ax.u, p.from[ax.u[0]], p.to[ax.u[0]], face.ppu[0]);
			const [y0, y1] = pxRange(b, ax.v, p.from[ax.v[0]], p.to[ax.v[0]], face.ppu[1]);
			return { img: cropImage(face.img, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)), tex: face.tex, ppu: face.ppu.slice() };
		}
		/**
		 * A new face d for box b, painted with the pattern of face srcDir of box src, lined up in
		 * model space so it continues seamlessly, and darkened by shade (1 = as is).
		 */
		function patternFace(b, d, src, srcDir, shade) {
			const f = src.faces[srcDir];
			if (!f) return null;
			const ax = BP_AXES[d];
			const w = Math.max(1, Math.round(ext(b, ax.u[0]) * f.ppu[0]));
			const h = Math.max(1, Math.round(ext(b, ax.v[0]) * f.ppu[1]));
			const out = newImage(w, h);
			let offX = 0, offY = 0;
			if (srcDir === d) {
				offX = Math.round(ax.u[2] * (b[ax.u[1]][ax.u[0]] - src[ax.u[1]][ax.u[0]]) * f.ppu[0]);
				offY = Math.round(ax.v[2] * (b[ax.v[1]][ax.v[0]] - src[ax.v[1]][ax.v[0]]) * f.ppu[1]);
			}
			// sample only opaque pixels of the source, so holes in it don't turn into holes here
			const sw = f.img.w, sh = f.img.h, sd = f.img.data;
			let fallback = null;
			for (let j = 0; j < h; j++) {
				for (let i = 0; i < w; i++) {
					let sx = ((i + offX) % sw + sw) % sw, sy = ((j + offY) % sh + sh) % sh;
					let si = (sy * sw + sx) * 4;
					if (sd[si + 3] < 255) {
						if (!fallback) fallback = averageColor(f.img);
						const di = (j * w + i) * 4;
						out.data[di] = fallback[0] * shade; out.data[di + 1] = fallback[1] * shade; out.data[di + 2] = fallback[2] * shade; out.data[di + 3] = 255;
						continue;
					}
					const di = (j * w + i) * 4;
					out.data[di] = sd[si] * shade; out.data[di + 1] = sd[si + 1] * shade; out.data[di + 2] = sd[si + 2] * shade; out.data[di + 3] = 255;
				}
			}
			return { img: out, tex: f.tex, ppu: f.ppu.slice() };
		}
		function averageColor(img) {
			let r = 0, g = 0, b = 0, n = 0;
			for (let i = 0; i < img.data.length; i += 4) {
				if (img.data[i + 3] < 128) continue;
				r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
			}
			return n ? [r / n, g / n, b / n] : [128, 128, 128];
		}
		/** Any face of box b to take a pattern from, preferring direction d. */
		function patternSource(b, d) {
			if (b.faces[d]) return d;
			let best = null, area = -1;
			for (const k of BP_FACES) {
				const f = b.faces[k];
				if (f && f.img.w * f.img.h > area) { best = k; area = f.img.w * f.img.h; }
			}
			return best;
		}
		function clearRect(face, b, d, rect) {
			const ax = BP_AXES[d];
			const [x0, x1] = pxRange(b, ax.u, rect[0][0], rect[0][1], face.ppu[0]);
			const [y0, y1] = pxRange(b, ax.v, rect[1][0], rect[1][1], face.ppu[1]);
			let changed = false;
			for (let y = Math.max(0, y0); y < Math.min(face.img.h, y1); y++) {
				for (let x = Math.max(0, x0); x < Math.min(face.img.w, x1); x++) {
					const i = (y * face.img.w + x) * 4 + 3;
					if (face.img.data[i] !== 0) { face.img.data[i] = 0; changed = true; }
				}
			}
			return changed;
		}
		function opaqueIn(face, b, d, rect) {
			const ax = BP_AXES[d];
			const [x0, x1] = pxRange(b, ax.u, rect[0][0], rect[0][1], face.ppu[0]);
			const [y0, y1] = pxRange(b, ax.v, rect[1][0], rect[1][1], face.ppu[1]);
			for (let y = Math.max(0, y0); y < Math.min(face.img.h, y1); y++) {
				for (let x = Math.max(0, x0); x < Math.min(face.img.w, x1); x++) {
					if (face.img.data[(y * face.img.w + x) * 4 + 3] < 255) return false;
				}
			}
			return true;
		}
		function opaqueFace(face) {
			for (let i = 3; i < face.img.data.length; i += 4) if (face.img.data[i] < 255) return false;
			return true;
		}
		function emptyFace(face) {
			for (let i = 3; i < face.img.data.length; i += 4) if (face.img.data[i] !== 0) return false;
			return true;
		}

		/* --- the model --- */
		function patchKind(name, s) {
			const n = String(name || '').trim();
			const test = base => base && new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[\\s._-]*\\d+)?$').test(n);
			if (test(s.add_name)) return 'add';
			if (test(s.cutout_name)) return 'cutout';
			if (test(s.hollow_name)) return 'hollow';
			return null;
		}
		function isZero(v) { return !v || (Math.abs(v[0] || 0) < EPS && Math.abs(v[1] || 0) < EPS && Math.abs(v[2] || 0) < EPS); }

		/** Parent group uuid of every node, and every group in outliner order. */
		function walkOutliner(outliner) {
			const parent = {}, groupOrder = [], nodeOrder = [];
			(function walk(list, p) {
				for (const item of list || []) {
					if (typeof item === 'string') { parent[item] = p; nodeOrder.push(item); }
					else if (item && item.uuid) {
						parent[item.uuid] = p; groupOrder.push(item.uuid); nodeOrder.push(item.uuid);
						walk(item.children || item.content, item.uuid);
					}
				}
			})(outliner, null);
			return { parent, groupOrder, nodeOrder };
		}

		/**
		 * Run BlockPatcher.
		 * opts: settings (BP_DEFAULTS), excluded: Set of patch cube uuids to leave alone,
		 * frozen: Set of cube uuids to keep exactly as they are.
		 */
		function blockPatch(model, images, opts = {}) {
			const s = Object.assign({}, BP_DEFAULTS, opts.settings || {});
			const excluded = opts.excluded || new Set();
			const frozen = opts.frozen || new Set();
			const shade = Math.max(0, Math.min(100, s.wall_shade)) / 100;
			const res = model.resolution || { width: 16, height: 16 };
			const scale = tex => {
				const img = images[tex];
				return img ? [img.w / (res.width || img.w), img.h / (res.height || img.h)] : [1, 1];
			};
			const groups = {};
			for (const g of model.groups || []) groups[g.uuid] = g;
			const { parent, groupOrder, nodeOrder } = walkOutliner(model.outliner);
			const report = { duplicates: 0, cubes_before: 0, cubes_after: 0, cutouts: 0, adds: 0, hollows: 0, merged: 0, faces_culled: 0, warnings: [] };
			const ops = [];

			// Cubes only interact with cubes that are turned the same way around the same points.
			const frameKey = el => {
				const parts = [];
				let g = parent[el.uuid];
				while (g) {
					const grp = groups[g];
					if (grp && !isZero(grp.rotation)) parts.push(grp.rotation.join(',') + '@' + (grp.origin || [0, 0, 0]).join(','));
					g = parent[g];
				}
				if (!isZero(el.rotation)) parts.push('c' + el.rotation.join(',') + '@' + (el.origin || [0, 0, 0]).join(','));
				return parts.join('|');
			};

			const others = [];   // elements BlockPatcher doesn't touch (meshes, locators, ...)
			let boxes = [];
			for (const el of model.elements || []) {
				if (el.type && el.type !== 'cube') { others.push(el); continue; }
				if (!el.from || !el.to) { others.push(el); continue; }
				report.cubes_before++;
				const kind = s.uv_only ? null : patchKind(el.name, s);
				const box = {
					uuid: el.uuid, el, from: el.from.slice(), to: el.to.slice(), name: el.name,
					group: parent[el.uuid] || null, frame: frameKey(el), kind,
					src: new Set([el.uuid]), ops: new Set(kind ? [el.uuid] : []),
					frozen: frozen.has(el.uuid) || (!kind && !isZero([el.inflate || 0, 0, 0])),
					changed: false, holey: false, faces: {}
				};
				// hollows made earlier ("HOLLOW notch", "HOLLOW into ...") are pockets, not solid
				if (!kind && s.hollow_name && String(el.name || '').trim().startsWith(s.hollow_name)) { box.hollow = true; box.frozen = true; }
				if (kind && excluded.has(el.uuid)) { box.kind = null; box.frozen = true; box.passive = true; box.excludedPatch = kind; }
				for (const d of BP_FACES) {
					const f = el.faces && el.faces[d];
					box.faces[d] = (f && f.texture !== null && f.texture !== undefined && f.texture !== false && Array.isArray(f.uv))
						? readFace(box, d, f, images, scale) : null;
				}
				// a cube you can see through somewhere can't hide what's behind or inside it
				box.holey = BP_FACES.some(d => box.faces[d] && !opaqueFace(box.faces[d]));
				boxes.push(box);
			}
			const solids = () => boxes.filter(b => !b.kind && !b.passive && !b.hollow);
			const describe = b => b.name + ' [' + b.from.join(',') + ' → ' + b.to.join(',') + ']';

			/* 1. ADD: becomes part of the cube it attaches to */
			for (const A of boxes.filter(b => b.kind === 'add')) {
				const op = { uuid: A.uuid, kind: 'add', name: A.name, status: 'applied', host: null };
				ops.push(op);
				let host = null, score = 0;
				for (const B of solids()) {
					if (B.frame !== A.frame) continue;
					const sc = overlapVolume(A, B) * 1000 + contactArea(A, B);
					if (sc > score) { score = sc; host = B; }
				}
				// the part of the ADD cube that isn't inside existing cubes
				let pieces = [{ from: A.from.slice(), to: A.to.slice() }];
				for (const B of solids()) {
					if (B.frame !== A.frame) continue;
					pieces = pieces.flatMap(p => subtractBox(p, B));
				}
				boxes = boxes.filter(b => b !== A);
				if (!pieces.length) { op.status = 'nothing'; op.note = 'already inside existing cubes'; continue; }
				if (host) op.host = host.name;
				else report.warnings.push(describe(A) + ' touches no cube, kept on its own');
				for (const p of pieces) {
					const nb = {
						uuid: null, el: host ? host.el : A.el, from: p.from, to: p.to,
						name: host ? host.name : 'cube', group: host ? host.group : A.group, frame: A.frame, kind: null,
						src: new Set([A.uuid]), ops: new Set([A.uuid]), frozen: false, changed: true, holey: false, faces: {}, added: true
					};
					for (const d of BP_FACES) {
						if (host && s.retexture_add) {
							const sd = patternSource(host, d);
							nb.faces[d] = sd ? patternFace(nb, d, host, sd, 1) : null;
						} else {
							nb.faces[d] = A.faces[d] ? cropFace(A.faces[d], A, p, d) : null;
						}
					}
					boxes.push(nb);
				}
				report.adds++;
			}

			/* 2. CUTOUT: carve real empty space */
			for (const C of boxes.filter(b => b.kind === 'cutout')) {
				const op = { uuid: C.uuid, kind: 'cutout', name: C.name, status: 'applied', host: null };
				ops.push(op);
				const hits = solids().filter(B => B.frame === C.frame && !B.frozen && overlapsVolume(B, C));
				boxes = boxes.filter(b => b !== C);
				if (!hits.length) { op.status = 'nothing'; op.note = 'cuts into nothing'; continue; }
				op.host = hits.map(b => b.name).filter((v, i, a) => a.indexOf(v) === i).join(', ');
				for (const B of hits) {
					const pieces = subtractBox(B, C);
					boxes = boxes.filter(b => b !== B);
					for (const p of pieces) {
						const nb = Object.assign({}, B, {
							uuid: null, from: p.from, to: p.to, faces: {}, changed: true,
							src: new Set(B.src), ops: new Set([...B.ops, C.uuid])
						});
						for (const d of BP_FACES) {
							const [a, sg] = BP_DIRS[d];
							const q = facePlane(p, d);
							if (Math.abs(q - facePlane(B, d)) < EPS) {
								nb.faces[d] = B.faces[d] ? cropFace(B.faces[d], B, p, d) : null;
							} else if (Math.abs((sg > 0 ? C.from[a] : C.to[a]) - q) < EPS && rectIntersect(faceRect(p, d), faceRect(C, d))) {
								// a new wall looking into the cut
								const sd = patternSource(B, d);
								nb.faces[d] = sd ? patternFace(nb, d, B, sd, shade) : null;
							} else {
								nb.faces[d] = null; // seam between two pieces of the same cube
							}
						}
						boxes.push(nb);
					}
				}
				// cubes next to the cut whose touching side had no face now show into the hole
				for (const X of solids()) {
					if (X.frame !== C.frame || X.frozen) continue;
					for (const d of BP_FACES) {
						if (X.faces[d]) continue;
						const [a, sg] = BP_DIRS[d];
						const q = facePlane(X, d);
						if (Math.abs((sg > 0 ? C.from[a] : C.to[a]) - q) >= EPS) continue;
						if (!rectIntersect(faceRect(X, d), faceRect(C, d))) continue;
						const sd = patternSource(X, d);
						if (sd) { X.faces[d] = patternFace(X, d, X, sd, shade); X.changed = true; X.ops.add(C.uuid); }
					}
				}
				report.cutouts++;
			}

			/* 3. HOLLOW: a see-through pocket made with texture instead of geometry */
			for (const H of boxes.filter(b => b.kind === 'hollow')) {
				const op = { uuid: H.uuid, kind: 'hollow', name: H.name, status: 'applied', host: null };
				ops.push(op);
				const near = solids().filter(B => B.frame === H.frame);
				const hosts = near.filter(B => overlapsVolume(B, H)).sort((a, b) => overlapVolume(b, H) - overlapVolume(a, H));
				if (!hosts.length) { op.status = 'nothing'; op.note = 'not inside any cube'; boxes = boxes.filter(b => b !== H); continue; }
				const host = hosts[0];
				op.host = host.name;
				H.kind = null; H.hollow = true; H.changed = true; H.frozen = false;
				H.name = s.hollow_name + ' into ' + host.name;
				H.group = host.group; H.el = Object.assign({}, H.el, { inflate: 0 });
				// its own faces: open where it sits flush on the surface of a host, walls everywhere else
				for (const d of BP_FACES) {
					const [a, sg] = BP_DIRS[d];
					const q = facePlane(H, d), r = faceRect(H, d);
					const onSurface = hosts.some(B => Math.abs(facePlane(B, d) - q) < EPS && rectIntersect(faceRect(B, d), r));
					let open = false;
					if (onSurface) {
						// ... unless something outside closes it off
						const cover = near.filter(B => !hosts.includes(B) && Math.abs((sg > 0 ? B.from[a] : B.to[a]) - q) < EPS)
							.map(B => rectIntersect(faceRect(B, d), r)).filter(Boolean);
						open = !rectsCover(r, cover);
					}
					if (open) H.faces[d] = null;
					else {
						const sd = patternSource(host, d);
						H.faces[d] = sd ? patternFace(H, d, host, sd, shade) : null;
					}
				}
				// everything that would show inside the pocket turns see-through
				for (const B of near) {
					if (B.frozen) continue;
					for (const d of BP_FACES) {
						const f = B.faces[d];
						if (!f) continue;
						const [a] = BP_DIRS[d];
						const q = facePlane(B, d);
						if (q < H.from[a] - EPS || q > H.to[a] + EPS) continue;
						const r = rectIntersect(faceRect(B, d), faceRect(H, d));
						if (!r) continue;
						if (clearRect(f, B, d, r)) {
							B.changed = true; B.holey = true; B.ops.add(H.uuid);
							if (emptyFace(f)) B.faces[d] = null;
						}
					}
				}
				report.hollows++;
			}
			// excluded patch cubes go back to being plain cubes for the rest of the run, untouched
			for (const b of boxes) if (b.excludedPatch) {
				ops.push({ uuid: b.uuid, kind: b.excludedPatch, name: b.name, status: 'excluded', host: null });
				b.kind = null;
			}

			/* 4. exact duplicates (same place, same look) are one cube too many */
			if (!s.uv_only) {
				const seen = new Map();
				const look = b => BP_FACES.map(d => b.faces[d] ? b.faces[d].tex + '/' + imageKey(b.faces[d].img) : '-').join('|');
				boxes = boxes.filter(b => {
					if (b.kind || b.frozen || b.hollow || b.passive) return true;
					const k = [b.group, b.frame, b.from.join(), b.to.join(), look(b)].join('#');
					const first = seen.get(k);
					if (!first) { seen.set(k, b); return true; }
					first.src = new Set([...first.src, ...b.src]); first.changed = true;
					report.duplicates = (report.duplicates || 0) + 1;
					return false;
				});
			}

			/* 4/5. merge cubes that form one box, drop faces nobody can see */
			const canMerge = b => !b.frozen && !b.hollow && !b.kind && !b.passive;
			const mergeGate = (A, B) => s.merge === 'all' || (s.merge === 'patched' && (A.changed || B.changed));
			function mergePair(A, B, k) {
				// A is below B along k
				const faces = {};
				for (const d of BP_FACES) {
					const [a, sg] = BP_DIRS[d];
					if (a === k) { faces[d] = sg > 0 ? B.faces[d] : A.faces[d]; continue; }
					const fa = A.faces[d], fb = B.faces[d];
					if (!fa && !fb) { faces[d] = null; continue; }
					if (!fa || !fb || fa.tex !== fb.tex) return null;
					if (Math.abs(fa.ppu[0] - fb.ppu[0]) > EPS || Math.abs(fa.ppu[1] - fb.ppu[1]) > EPS) return null;
					const ax = BP_AXES[d];
					const alongU = ax.u[0] === k;
					const first = (alongU ? ax.u[2] : ax.v[2]) > 0 ? fa : fb, second = first === fa ? fb : fa;
					if (alongU ? first.img.h !== second.img.h : first.img.w !== second.img.w) return null;
					const img = alongU ? newImage(first.img.w + second.img.w, first.img.h) : newImage(first.img.w, first.img.h + second.img.h);
					blit(img, first.img, 0, 0);
					blit(img, second.img, alongU ? first.img.w : 0, alongU ? 0 : first.img.h);
					faces[d] = { img, tex: fa.tex, ppu: fa.ppu.slice() };
				}
				const nb = Object.assign({}, A, {
					uuid: null, from: A.from.slice(), to: B.to.slice(), faces, changed: true,
					src: new Set([...A.src, ...B.src]), ops: new Set([...A.ops, ...B.ops])
				});
				for (let i = 0; i < 3; i++) { nb.from[i] = Math.min(A.from[i], B.from[i]); nb.to[i] = Math.max(A.to[i], B.to[i]); }
				return nb;
			}
			function mergeAll() {
				if (s.merge === 'off' || s.uv_only) return;
				let again = true;
				while (again) {
					again = false;
					for (let k = 0; k < 3; k++) {
						const o = [0, 1, 2].filter(i => i !== k);
						const key = (b, at) => [k, b.group, b.frame, b.from[o[0]], b.to[o[0]], b.from[o[1]], b.to[o[1]], at].join('|');
						const byStart = new Map();
						for (const b of boxes) if (canMerge(b)) byStart.set(key(b, b.from[k]), b);
						const gone = new Set();
						for (const A of boxes.slice()) {
							if (gone.has(A) || !canMerge(A)) continue;
							const B = byStart.get(key(A, A.to[k]));
							if (!B || B === A || gone.has(B) || !mergeGate(A, B)) continue;
							const nb = mergePair(A, B, k);
							if (!nb) continue;
							gone.add(A); gone.add(B);
							byStart.delete(key(B, B.from[k]));
							boxes = boxes.filter(b => b !== A && b !== B);
							boxes.push(nb);
							report.merged++;
							again = true;
						}
					}
				}
			}
			function cullAll() {
				if (!s.cull_hidden) return;
				const solid = boxes.filter(b => !b.kind && !b.hollow && !b.passive);
				for (const X of solid) {
					if (X.frozen) continue;
					for (const d of BP_FACES) {
						if (!X.faces[d]) continue;
						const [a, sg] = BP_DIRS[d];
						const q = facePlane(X, d), r = faceRect(X, d);
						const cover = [];
						for (const Y of solid) {
							if (Y === X || Y.frame !== X.frame) continue;
							const i = rectIntersect(r, faceRect(Y, d));
							if (!i) continue;
							if (Y.from[a] < q - EPS && Y.to[a] > q + EPS) { if (!Y.holey) cover.push(i); continue; }
							if (Math.abs((sg > 0 ? Y.from[a] : Y.to[a]) - q) >= EPS) continue;
							const yf = Y.faces[BP_OPPOSITE[d]];
							if (!yf || opaqueIn(yf, Y, BP_OPPOSITE[d], i)) cover.push(i);
						}
						if (rectsCover(r, cover)) { X.faces[d] = null; X.changed = true; report.faces_culled++; }
					}
				}
			}
			mergeAll();
			cullAll();
			mergeAll();

			/* 6. UV layout */
			const outIndex = {};
			nodeOrder.forEach((u, i) => { outIndex[u] = i; });
			const groupRank = {};
			groupOrder.forEach((u, i) => { groupRank[u] = i; });
			const firstSrcRank = b => Math.min(...[...b.src].map(u => outIndex[u] ?? 1e9));
			boxes.sort((a, b) => ((groupRank[a.group] ?? -1) - (groupRank[b.group] ?? -1)) || (firstSrcRank(a) - firstSrcRank(b)));

			// which original UV rects are used by more than one face (those can't be edited in place)
			const rectUse = new Map();
			const rectKey = f => f.tex + ':' + f.uv.map(n => Math.round(n * 1000)).sort((a, b) => a - b).join(',');
			for (const el of model.elements || []) {
				if (!el.faces) continue;
				for (const d of BP_FACES) {
					const f = el.faces[d];
					if (f && f.texture !== null && f.texture !== undefined && Array.isArray(f.uv)) {
						const k = rectKey({ tex: f.texture, uv: f.uv });
						rectUse.set(k, (rectUse.get(k) || 0) + 1);
					}
				}
			}
			// Painted pixels no face of this model uses may belong to other models sharing the texture:
			// repacking everything would drop them, so say so.
			if (s.uv_mode === 'all') {
				for (let t = 0; t < images.length; t++) {
					const img = images[t];
					if (!img) continue;
					const used = new Uint8Array(img.w * img.h);
					const [fx, fy] = scale(t);
					for (const el of model.elements || []) {
						for (const d of BP_FACES) {
							const f = el.faces && el.faces[d];
							if (!f || f.texture !== t || !Array.isArray(f.uv)) continue;
							const x0 = Math.max(0, Math.floor(Math.min(f.uv[0], f.uv[2]) * fx)), x1 = Math.min(img.w, Math.ceil(Math.max(f.uv[0], f.uv[2]) * fx));
							const y0 = Math.max(0, Math.floor(Math.min(f.uv[1], f.uv[3]) * fy)), y1 = Math.min(img.h, Math.ceil(Math.max(f.uv[1], f.uv[3]) * fy));
							for (let y = y0; y < y1; y++) used.fill(1, y * img.w + x0, y * img.w + x1);
						}
					}
					let painted = 0, unused = 0;
					for (let i = 0; i < used.length; i++) {
						if (img.data[i * 4 + 3] === 0) continue;
						painted++;
						if (!used[i]) unused++;
					}
					report.unused_pixels = (report.unused_pixels || 0) + unused;
					if (painted && unused / painted > 0.02) {
						report.warnings.push(`${Math.round(unused / painted * 100)}% of the painted pixels in texture ${t + 1} are not on any face of this model. If another model shares this texture, repacking drops its part: use "keep untouched UVs" instead.`);
					}
				}
			}
			const texCount = Math.max(images.length, 1);
			const keep = [], place = [];
			for (const b of boxes) {
				for (const d of BP_FACES) {
					const f = b.faces[d];
					if (!f) continue;
					const untouched = !b.changed && f.orig;
					if (s.uv_mode === 'changed' && f.orig && b.from.every((v, i) => v === b.el.from[i]) && b.to.every((v, i) => v === b.el.to[i]) && b.src.size === 1) {
						const k = rectKey({ tex: f.orig.texture, uv: f.orig.uv });
						if (untouched || (rectUse.get(k) || 0) <= 1) { keep.push({ b, d, f }); continue; }
					}
					place.push({ b, d, f });
				}
			}
			const outImages = [];
			const pad = Math.max(0, Math.round(s.padding || 0));
			const placed = new Map(); // face -> {x, y}
			let outW = 0, outH = 0;
			for (let t = 0; t < texCount; t++) {
				const src = images[t];
				const mine = place.filter(p => p.f.tex === t);
				const keepMine = keep.filter(k => k.f.tex === t);
				const top = s.uv_mode === 'changed' && keepMine.length && src ? src.h + pad : 0;
				// Two layouts, the smaller one wins: every cube's faces side by side in one strip (like
				// box UV, easiest to paint), or every face on its own. Both keep groups together.
				const asBlocks = [], asFaces = [];
				let cur = null;
				for (const p of mine) {
					if (!cur || cur.b !== p.b) { cur = { group: p.b.group, faces: [], w: 0, h: 0 }; asBlocks.push(cur); }
					cur.faces.push(p);
					cur.w += p.f.img.w + (cur.faces.length > 1 ? pad : 0);
					cur.h = Math.max(cur.h, p.f.img.h);
					asFaces.push({ group: p.b.group, faces: [p], w: p.f.img.w, h: p.f.img.h });
				}
				let width = Math.max(src ? src.w : 16, ...asBlocks.map(b => b.w));
				width = Math.max(16, Math.ceil(width / 16) * 16);
				const packedBlocks = skyline(asBlocks, width, top, pad);
				const packedFaces = skyline(asFaces.slice(), width, top, pad);
				const useBlocks = packedBlocks.height <= packedFaces.height * 1.05;
				const blocks = useBlocks ? asBlocks : asFaces;
				if (!useBlocks) for (const bl of asFaces) { bl.x = bl._x; bl.y = bl._y; }
				else for (const bl of asBlocks) { bl.x = bl._x; bl.y = bl._y; }
				let height = blocks.length ? (useBlocks ? packedBlocks.height : packedFaces.height) : top;
				if (s.uv_mode === 'changed' && src) height = Math.max(height, src.h);
				height = Math.max(16, Math.ceil(height / 16) * 16);
				const img = newImage(width, height);
				if (s.uv_mode === 'changed' && src) blit(img, src, 0, 0);
				for (const k of keepMine) {
					// edited in place (hollow cuts): write the face back where it was
					if (k.b.changed) writeBack(img, k, scale);
				}
				for (const bl of blocks) {
					let fx = bl.x;
					for (const p of bl.faces) {
						blit(img, p.f.img, fx, bl.y);
						placed.set(p.f, { x: fx, y: bl.y });
						fx += p.f.img.w + pad;
					}
				}
				outImages.push(img);
				outW = Math.max(outW, width); outH = Math.max(outH, height);
			}
			function writeBack(img, k, scaleFn) {
				const f = k.f, o = f.orig;
				const [fx, fy] = scaleFn(o.texture);
				const c = faceCorners(o);
				const du = [(c[1][0] - c[0][0]) * fx, (c[1][1] - c[0][1]) * fy];
				const dv = [(c[2][0] - c[0][0]) * fx, (c[2][1] - c[0][1]) * fy];
				for (let j = 0; j < f.img.h; j++) for (let i = 0; i < f.img.w; i++) {
					const sx = (i + 0.5) / f.img.w, ty = (j + 0.5) / f.img.h;
					const x = Math.floor(c[0][0] * fx + sx * du[0] + ty * dv[0]), y = Math.floor(c[0][1] * fy + sx * du[1] + ty * dv[1]);
					if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
					const si = (j * f.img.w + i) * 4, di = (y * img.w + x) * 4;
					img.data[di] = f.img.data[si]; img.data[di + 1] = f.img.data[si + 1]; img.data[di + 2] = f.img.data[si + 2]; img.data[di + 3] = f.img.data[si + 3];
				}
			}
			// all textures share the project's UV size: grow the smaller ones
			const outRes = { width: outW, height: outH };
			for (let t = 0; t < outImages.length; t++) {
				const im = outImages[t];
				if (im.w !== outW || im.h !== outH) { const big = newImage(outW, outH); blit(big, im, 0, 0); outImages[t] = big; }
			}
			// keep the UV units of the original project (a 2x texture stays 2x)
			const [sx0, sy0] = scale(0);
			outRes.width = Math.round(outW / (sx0 || 1));
			outRes.height = Math.round(outH / (sy0 || 1));

			/* 7. back to elements */
			const used = new Set();
			const provenance = {};
			const elements = [];
			for (const b of boxes) {
				let uuid = null;
				for (const u of b.src) if (!used.has(u)) { uuid = u; break; }
				if (!uuid) uuid = bpUuid();
				used.add(uuid);
				const base = b.el || {};
				const el = JSON.parse(JSON.stringify(Object.assign({}, base, { faces: undefined })));
				delete el.faces; delete el.uv_offset;
				Object.assign(el, { uuid, name: b.name, from: b.from, to: b.to, box_uv: false, autouv: 0, faces: {} });
				if (b.hollow) el.inflate = 0;
				for (const d of BP_FACES) {
					const f = b.faces[d];
					if (!f) { el.faces[d] = { uv: [0, 0, 0, 0], texture: null }; continue; }
					const k = keep.find(k => k.f === f);
					if (k) { el.faces[d] = JSON.parse(JSON.stringify(f.orig)); continue; }
					const pos = placed.get(f);
					const [fx, fy] = [outImages[f.tex].w / outRes.width, outImages[f.tex].h / outRes.height];
					el.faces[d] = { uv: [pos.x / fx, pos.y / fy, (pos.x + f.img.w) / fx, (pos.y + f.img.h) / fy], texture: f.tex };
				}
				elements.push(el);
				provenance[uuid] = { src: [...b.src], ops: [...b.ops], changed: !!b.changed, name: b.name };
			}
			report.cubes_after = elements.length;

			/* 8. outliner: same tree, cubes swapped in their groups */
			// each new cube goes where the first original cube it came from was, in its own group;
			// cubes with no such place (ADD cubes that moved group) go to the end of the group
			const anchored = new Map(), byGroupOut = new Map();
			boxes.forEach((b, i) => {
				const g = b.group || null;
				let anchor = null, best = Infinity;
				for (const u of b.src) {
					if ((parent[u] || null) === g && (outIndex[u] ?? Infinity) < best) { best = outIndex[u]; anchor = u; }
				}
				const map = anchor ? anchored : byGroupOut, key = anchor || g;
				if (!map.has(key)) map.set(key, []);
				map.get(key).push(elements[i].uuid);
			});
			const cubeIds = new Set((model.elements || []).filter(e => !(e.type && e.type !== 'cube') && e.from).map(e => e.uuid));
			function rebuild(list, g) {
				const out = [];
				for (const item of list || []) {
					if (typeof item === 'string') {
						if (!cubeIds.has(item)) out.push(item);
						else for (const u of anchored.get(item) || []) out.push(u);
					} else if (item && item.uuid) {
						const copy = Object.assign({}, item);
						copy.children = rebuild(item.children || item.content, item.uuid);
						delete copy.content;
						out.push(copy);
					}
				}
				for (const u of byGroupOut.get(g) || []) out.push(u);
				return out;
			}
			const outModel = Object.assign({}, model, {
				elements: others.concat(elements),
				outliner: rebuild(model.outliner, null),
				resolution: outRes
			});
			report.texture_before = images.map(im => im ? im.w + '×' + im.h : '-').join(', ');
			report.texture_after = outImages.map(im => im.w + '×' + im.h).join(', ');
			return { model: outModel, images: outImages, report, ops, provenance };
		}


		/* --- Blockbench side --- */
		if (typeof module !== 'undefined' && module.exports) {
			Object.assign(module.exports, { blockPatch, subtractBox, rectsCover, skyline, BP_DEFAULTS });
		}
		if (typeof Plugin === 'undefined') return;

		const BP_STORAGE = 'block_patcher_settings';
		const BP_COLOR = '#d7263d';
		const KIND_STYLE = {
			add: { icon: 'add_box', color: '#3ddc84', label: 'Add' },
			cutout: { icon: 'indeterminate_check_box', color: '#d7263d', label: 'Cut out' },
			hollow: { icon: 'check_box_outline_blank', color: '#4aa8ff', label: 'Hollow' }
		};
		const bpSettings = Object.assign({}, BP_DEFAULTS);
		try { Object.assign(bpSettings, JSON.parse(localStorage.getItem(BP_STORAGE) || '{}')); } catch (e) {}
		function saveBpSettings() {
			const copy = Object.assign({}, bpSettings);
			delete copy.add_name; delete copy.cutout_name; delete copy.hollow_name;
			try { localStorage.setItem(BP_STORAGE, JSON.stringify(copy)); } catch (e) {}
		}
		/** The names the Block Grid Cube tool gives its cubes. */
		function patchNames() {
			let m = {};
			try { m = JSON.parse(localStorage.getItem('block_grid_modeler_settings') || '{}'); } catch (e) {}
			return { add_name: m.add_name || 'ADD', cutout_name: m.cutout_name || 'CUTOUT', hollow_name: m.hollow_name || 'HOLLOW' };
		}

		let session = null;   // the open BlockPatcher run, see runBlockPatcher
		let bpPanel, bpAction, uvAction, markerTool, bpStyle;
		const bpListeners = [];

		/* images in and out of Blockbench */
		function textureImage(tex) {
			const src = tex.canvas && tex.canvas.width ? tex.canvas : tex.img;
			const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
			if (!w || !h) return null;
			const c = document.createElement('canvas');
			c.width = w; c.height = h;
			const ctx = c.getContext('2d');
			ctx.drawImage(src, 0, 0);
			const d = ctx.getImageData(0, 0, w, h);
			return { w, h, data: d.data };
		}
		function imageToDataURL(img) {
			const c = document.createElement('canvas');
			c.width = img.w; c.height = img.h;
			c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
			return c.toDataURL('image/png');
		}
		function waitFor(test, ms = 4000) {
			return new Promise(resolve => {
				const start = Date.now();
				(function tick() {
					if (test() || Date.now() - start > ms) resolve();
					else setTimeout(tick, 30);
				})();
			});
		}

		/** Patch the session's snapshot and show the result in the preview tab. */
		async function buildPreview(keepMarks = true) {
			const s = session;
			// remember where the marked parts are, to mark the same parts again after the rebuild
			const markedBoxes = [];
			if (keepMarks && s.result) {
				for (const id of s.marked) {
					const el = s.result.model.elements.find(e => e.uuid === id);
					if (el) markedBoxes.push({ from: el.from.slice(), to: el.to.slice() });
				}
			}
			const settings = Object.assign({}, bpSettings, patchNames());
			if (s.uvOnly) Object.assign(settings, { uv_only: true, cull_hidden: !!bpSettings.uv_cull });
			s.result = blockPatch(s.snapshot, s.images, { settings, excluded: s.excluded, frozen: s.frozen });
			const model = JSON.parse(JSON.stringify(Object.assign({}, s.result.model, { textures: undefined, animations: undefined })));
			model.textures = s.snapshot.textures.map((t, i) => {
				const copy = Object.assign({}, t);
				delete copy.path; delete copy.relative_path;
				copy.internal = true; copy.saved = true;
				if (s.result.images[i]) {
					copy.source = imageToDataURL(s.result.images[i]);
					copy.width = s.result.images[i].w; copy.height = s.result.images[i].h;
					copy.uv_width = model.resolution.width; copy.uv_height = model.resolution.height;
				}
				return copy;
			});
			delete model.editor_state;
			delete model.history;
			model.animations = [];

			// keep the camera where it was when the preview is rebuilt
			let cam = null;
			if (s.preview && Preview.selected) {
				cam = { pos: Preview.selected.camera.position.clone(), target: Preview.selected.controls.target.clone() };
			}
			if (s.preview && ModelProject.all.includes(s.preview)) {
				s.rebuilding = true;
				await s.preview.close(true);
				s.rebuilding = false;
			}
			Codecs.project.load(model, { path: 'BlockPatcher preview.bbmodel', no_file: true });
			s.preview = Project;
			Project.name = (s.og.name || 'model') + (s.uvOnly ? ' · Organize UV' : ' · BlockPatcher');
			Project.block_patcher_preview = true;
			Project.saved = true;
			s.marked = new Set();
			if (markedBoxes.length) {
				const same = (a, b) => [0, 1, 2].every(i => Math.abs(a.from[i] - b.from[i]) < 1e-6 && Math.abs(a.to[i] - b.to[i]) < 1e-6);
				const inside = (a, b) => [0, 1, 2].every(i => a.from[i] >= b.from[i] - 1e-6 && a.to[i] <= b.to[i] + 1e-6);
				for (const el of s.result.model.elements) {
					if (!el.from || !s.result.provenance[el.uuid]) continue;
					// the same cube, or a piece of a marked cube (merging can change how a part is split up)
					if (markedBoxes.some(m => same(el, m) || inside(el, m) || inside(m, el))) s.marked.add(el.uuid);
				}
			}
			drawMarks();
			s.lastIds = new Set(Outliner.elements.map(e => e.uuid));
			if (cam && Preview.selected) {
				Preview.selected.camera.position.copy(cam.pos);
				Preview.selected.controls.target.copy(cam.target);
			}
			if (Modes.options.edit && !Modes.edit) Modes.options.edit.select();
			updateInterfacePanels();
			syncBpPanel();
		}

		async function runBlockPatcher(uvOnly = false) {
			if (!Project) return;
			if (session && session.preview && ModelProject.all.includes(session.preview)) {
				session.preview.select();
				Blockbench.showQuickMessage((session.uvOnly ? 'Organize UV' : 'BlockPatcher') + ' preview is already open', 1500);
				return;
			}
			if (Project.block_patcher_preview) return;
			if (!Format || Format.id === 'image') return;
			const og = Project;
			const snapshot = Codecs.project.compile({ raw: true, bitmaps: true, absolute_paths: false });
			const images = Texture.all.map(textureImage);
			if (!Texture.all.length) {
				Blockbench.showMessageBox({ title: 'BlockPatcher', message: 'This model has no texture yet. BlockPatcher needs one to paint walls and lay out UVs.' });
				return;
			}
			session = { uvOnly: !!uvOnly, og, snapshot, images, excluded: new Set(), frozen: new Set(), restoreLog: [], marked: new Set(), preview: null, result: null };
			Blockbench.showQuickMessage('BlockPatcher…', 600);
			await new Promise(r => setTimeout(r, 20));
			try {
				await buildPreview();
			} catch (err) {
				console.error(err);
				session = null;
				og.select();
				Blockbench.showMessageBox({ title: 'BlockPatcher', message: 'Something went wrong: ' + err.message });
				return;
			}
			const r = session.result.report;
			if (!uvOnly && !session.result.ops.length) {
				Blockbench.showQuickMessage('No ADD, CUTOUT or HOLLOW cubes found: only merged, cleaned up and laid out UVs', 3000);
			}
		}

		/** What the marked or selected preview cubes came from: their patch cubes are skipped, their original cubes kept as they were. */
		function restore(ids) {
			const s = session;
			let n = 0;
			for (const id of ids) {
				const p = s.result.provenance[id];
				if (!p) continue;
				n++;
				const opIds = new Set(s.result.ops.map(o => o.uuid));
				const srcs = p.src.filter(src => !opIds.has(src));
				for (const op of p.ops) s.excluded.add(op);
				for (const src of srcs) s.frozen.add(src);
				s.restoreLog.push({ ops: p.ops.slice(), srcs });
			}
			return n;
		}
		async function restoreMarked(fromDelete) {
			const s = session;
			if (!s) return;
			const ids = new Set([...s.marked, ...(fromDelete || []), ...(fromDelete ? [] : Outliner.selected.map(e => e.uuid))]);
			if (!ids.size) {
				Blockbench.showQuickMessage('Mark parts with the BlockPatcher Marker first (or select them)', 2000);
				return;
			}
			const editsBefore = Undo.index;
			if (editsBefore > 0 && !(await confirmLoseEdits())) return;
			const n = restore(ids);
			if (!n) { Blockbench.showQuickMessage('Those parts were not changed by BlockPatcher', 2000); return; }
			await buildPreview(false);
			Blockbench.showQuickMessage(`Restored ${n} part${n === 1 ? '' : 's'}`, 1500);
		}
		function confirmLoseEdits(message) {
			return new Promise(resolve => {
				Blockbench.showMessageBox({
					title: 'BlockPatcher',
					message: message || 'This rebuilds the preview from your model, so changes you made by hand in the preview are lost. Continue?',
					buttons: ['Rebuild', 'Cancel']
				}, answer => resolve(answer === 0));
			});
		}
		async function rerun() {
			if (!session) return;
			if (Undo.index > 0 && !(await confirmLoseEdits())) return;
			await buildPreview();
		}

		/** Write the preview back into the original model, as one undo step. */
		async function confirmPatch() {
			const s = session;
			if (!s) return;
			if (!ModelProject.all.includes(s.og)) {
				Blockbench.showMessageBox({ title: 'BlockPatcher', message: 'The original model was closed, so there is nothing to apply this to. You can still save the preview tab on its own.' });
				return;
			}
			s.preview.select();
			if (s.marked.size) {
				// the marked parts go back to how they were, then the rest is applied
				if (Undo.index > 0 && !(await confirmLoseEdits('Your marked parts are restored by rebuilding the preview from your model, so changes you made by hand in the preview are lost. Continue?'))) return;
				const n = restore(s.marked);
				await buildPreview(false);
				s.preview.select();
				if (n) Blockbench.showQuickMessage(`Restored ${n} marked part${n === 1 ? '' : 's'}`, 1500);
			}
			const model = Codecs.project.compile({ raw: true, bitmaps: false });
			const urls = Texture.all.map(t => t.getDataURL());
			s.rebuilding = true;
			await s.preview.close(true);
			s.rebuilding = false;
			session = null;
			s.og.select();

			const oldCubes = Cube.all.slice();
			Undo.initEdit({ elements: oldCubes, outliner: true, textures: Texture.all.slice(), bitmap: true, uv_mode: true });
			oldCubes.forEach(c => c.remove());
			for (const g of model.groups || []) {
				if (!OutlinerNode.uuids[g.uuid]) new Group(g, g.uuid).init();
			}
			const added = [];
			for (const template of model.elements || []) {
				if (template.type && template.type !== 'cube') continue;
				const copy = OutlinerElement.fromSave(template, true);
				for (const face in copy.faces) {
					const t = template.faces && template.faces[face] && template.faces[face].texture;
					const tex = (t !== null && t !== undefined && t !== false) ? Texture.all[t] : null;
					copy.faces[face].texture = tex ? tex.uuid : null;
				}
				copy.init();
				added.push(copy);
			}
			Outliner.loadJSON(model.outliner);
			Project.texture_width = model.resolution.width;
			Project.texture_height = model.resolution.height;
			const waits = [];
			Texture.all.forEach((tex, i) => {
				if (!urls[i]) return;
				const probe = new Image();
				waits.push(new Promise(resolve => {
					probe.onload = () => {
						tex.fromDataURL(urls[i]);
						waitFor(() => tex.width === probe.width && tex.height === probe.height).then(resolve);
					};
					probe.onerror = resolve;
					probe.src = urls[i];
				}));
			});
			await Promise.all(waits);
			Canvas.updateAll();
			Undo.finishEdit(s.uvOnly ? 'Organize UV' : 'BlockPatcher', { elements: added, outliner: true, textures: Texture.all.slice(), bitmap: true, uv_mode: true });
			updateInterfacePanels();
			Blockbench.showQuickMessage(s.uvOnly ? 'UV organized' : `BlockPatcher applied: ${oldCubes.length} → ${added.length} cubes`, 2500);
		}
		async function cancelPatch() {
			const s = session;
			if (!s) return;
			session = null;
			if (s.preview && ModelProject.all.includes(s.preview)) {
				s.rebuilding = true;
				await s.preview.close(true);
			}
			if (ModelProject.all.includes(s.og)) s.og.select();
			updateInterfacePanels();
		}

		/* --- marker: click parts in the preview that came out wrong --- */
		const markerMeshes = new Map();
		function markerMaterial() {
			if (!markerMaterial.m) markerMaterial.m = new THREE.LineBasicMaterial({ color: 0xff2d55, depthTest: false, transparent: true });
			return markerMaterial.m;
		}
		function drawMarks() {
			for (const [, m] of markerMeshes) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); }
			markerMeshes.clear();
			if (!session || Project !== session.preview) return;
			for (const id of session.marked) {
				const el = OutlinerNode.uuids[id];
				if (!(el instanceof Cube) || !el.mesh) continue;
				const size = [0, 1, 2].map(i => Math.max(0.01, el.to[i] - el.from[i]) + 0.2);
				const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size[0], size[1], size[2]));
				const line = new THREE.LineSegments(geo, markerMaterial());
				line.renderOrder = 999;
				line.position.set(
					(el.from[0] + el.to[0]) / 2 - el.origin[0],
					(el.from[1] + el.to[1]) / 2 - el.origin[1],
					(el.from[2] + el.to[2]) / 2 - el.origin[2]
				);
				el.mesh.add(line);
				markerMeshes.set(id, line);
			}
		}
		function toggleMark(el) {
			if (!session || !el) return;
			if (session.marked.has(el.uuid)) session.marked.delete(el.uuid);
			else session.marked.add(el.uuid);
			drawMarks();
			syncBpPanel();
		}

		/* deleting a patched part in the preview puts it back the way it was */
		function onPreviewEdit() {
			const s = session;
			if (!s || s.rebuilding || Project !== s.preview) return;
			const now = new Set(Outliner.elements.map(e => e.uuid));
			const gone = [...s.lastIds].filter(id => !now.has(id) && s.result.provenance[id] && s.result.provenance[id].ops.length);
			s.lastIds = now;
			if (!gone.length) { syncBpPanel(); return; }
			// deleting a patched part marks it instead: the delete is undone, and Confirm restores it
			setTimeout(() => {
				if (session !== s || Project !== s.preview) return;
				s.rebuilding = true;
				try { Undo.undo(); } finally { s.rebuilding = false; }
				s.lastIds = new Set(Outliner.elements.map(e => e.uuid));
				for (const id of gone) s.marked.add(id);
				drawMarks();
				syncBpPanel();
				Blockbench.showQuickMessage(`Marked ${gone.length} part${gone.length === 1 ? '' : 's'} to restore on Confirm`, 1800);
			}, 0);
		}

		/* --- panel --- */
		function syncBpPanel() {
			if (!bpPanel || !bpPanel.vue) return;
			const v = bpPanel.vue;
			const s = session;
			v.active = !!(s && s.result);
			if (!v.active) return;
			const r = s.result.report;
			v.report = {
				cubes: r.cubes_before + ' → ' + r.cubes_after,
				merged: r.merged, culled: r.faces_culled, duplicates: r.duplicates,
				texture: r.texture_before + ' → ' + r.texture_after,
				warnings: r.warnings.slice()
			};
			v.ops = s.result.ops.map(o => Object.assign({}, o, KIND_STYLE[o.kind] || {}, { on: !s.excluded.has(o.uuid) }));
			v.marked = s.marked.size;
			v.restored = s.excluded.size + s.frozen.size;
			v.settings = Object.assign({}, bpSettings);
			v.uv_only = !!s.uvOnly;
			v.marker_on = !!(markerTool && Toolbox.selected === markerTool);
		}
		function createBpPanel() {
			bpPanel = new Panel('block_patcher_panel', {
				name: 'BlockPatcher',
				icon: 'auto_fix_high',
				growable: true,
				resizable: true,
				default_side: 'right',
				condition: () => !!(session && Project && Project === session.preview),
				default_position: { slot: 'right_bar', float_position: [0, 0], float_size: [320, 640], height: 640 },
				component: {
					data() {
						return { active: false, uv_only: false, report: {}, ops: [], marked: 0, restored: 0, settings: Object.assign({}, bpSettings), marker_on: false };
					},
					methods: {
						confirm() { confirmPatch(); },
						cancel() { cancelPatch(); },
						restoreMarked() { restoreMarked(); },
						marker() { if (markerTool) markerTool.select(); syncBpPanel(); },
						clearMarks() { if (session) { session.marked.clear(); drawMarks(); syncBpPanel(); } },
						resetRestores() {
							if (!session) return;
							session.excluded.clear(); session.frozen.clear(); session.restoreLog = [];
							rerun();
						},
						toggleOp(op) {
							if (!session) return;
							if (session.excluded.has(op.uuid)) {
								session.excluded.delete(op.uuid);
								// let it work on the cubes that were restored together with it again
								for (const entry of session.restoreLog.filter(e => e.ops.includes(op.uuid))) {
									for (const src of entry.srcs) session.frozen.delete(src);
								}
								session.restoreLog = session.restoreLog.filter(e => !e.ops.includes(op.uuid));
							} else session.excluded.add(op.uuid);
							rerun();
						},
						showOp(op) {
							if (!session) return;
							const ids = Object.keys(session.result.provenance).filter(id => session.result.provenance[id].ops.includes(op.uuid));
							unselectAllElements();
							ids.forEach(id => { const el = OutlinerNode.uuids[id]; if (el && el.markAsSelected) el.markAsSelected(); });
							updateSelection();
						},
						set(key, value) {
							if (key === 'cull_hidden' && session && session.uvOnly) key = 'uv_cull';
							bpSettings[key] = value;
							saveBpSettings();
							rerun();
						}
					},
					template: `
						<div class="bp_panel">
							<div class="bp_title" v-if="active">{{ uv_only ? 'Organize UV' : 'BlockPatcher' }}</div>
							<template v-if="active">
								<div class="bp_actions">
									<div class="bp_button bp_primary" @click="confirm()" :title="marked ? 'Restore the marked parts, then close the preview and put the rest into your model (one undo step)' : 'Close the preview and put this into your model (one undo step)'"><i class="material-icons">check</i><span>Confirm<template v-if="marked">, restoring {{ marked }}</template></span></div>
									<div class="bp_button" @click="cancel()" title="Close the preview, your model stays as it was"><i class="material-icons">close</i><span>Cancel</span></div>
								</div>

								<div class="bp_stats">
									<div><span>Cubes</span><b>{{ report.cubes }}</b></div>
									<div><span>Texture</span><b>{{ report.texture }}</b></div>
									<div><span>Merged</span><b>{{ report.merged }}</b></div>
									<div><span>Hidden faces dropped</span><b>{{ report.culled }}</b></div>
									<div v-if="report.duplicates"><span>Duplicate cubes</span><b>{{ report.duplicates }}</b></div>
								</div>
								<div class="bp_warning" v-for="w in report.warnings">{{ w }}</div>

								<template v-if="!uv_only">
								<label>Fix what went wrong</label>
								<div class="bp_actions">
									<div class="bp_button" :class="{selected: marker_on}" @click="marker()" title="Click parts in the preview that came out wrong"><i class="material-icons" style="color:#ff2d55">ads_click</i><span>Marker</span></div>
									<div class="bp_button" @click="restoreMarked()" title="Restore the marked (or selected) parts right away, to see the result before confirming"><i class="material-icons">restore</i><span>Restore {{ marked ? 'now' : 'selected' }}</span></div>
								</div>
								<p class="bp_hint">Click parts that came out wrong with the Marker, or delete them: they get a red box{{ marked ? ' (' + marked + ' marked)' : '' }}, and Confirm puts them back the way they were. <a v-if="marked" @click="clearMarks()">Clear marks</a> <a v-if="restored" @click="resetRestores()">Undo all restores</a></p>

								<label>Patch cubes <span class="bp_subtle">untick to skip one</span></label>
								<div class="bp_ops">
									<div class="bp_op" v-for="op in ops" :key="op.uuid" :class="{off: !op.on}">
										<input type="checkbox" :checked="op.on" @change="toggleOp(op)">
										<i class="material-icons" :style="{color: op.color}">{{ op.icon }}</i>
										<span class="bp_op_name" @click="showOp(op)" title="Select what this made">{{ op.label }}<span class="bp_subtle" v-if="op.host"> in {{ op.host }}</span></span>
										<span class="bp_subtle" v-if="op.status === 'nothing'" :title="op.note">no effect</span>
									</div>
									<p class="bp_hint" v-if="!ops.length">No ADD, CUTOUT or HOLLOW cubes in this model.</p>
								</div>
								</template>
								<p class="bp_hint" v-else>Only the UV is laid out again: every face keeps its pixels, and the geometry stays as it is.</p>

								<label>Settings</label>
								<div class="bp_row" v-if="!uv_only" title="How bright new inner walls are, compared with the surface they are cut into">
									<span>Wall shade</span><input type="range" min="20" max="100" :value="settings.wall_shade" @change="set('wall_shade', Number($event.target.value))"><span class="bp_subtle">{{ settings.wall_shade }}%</span>
								</div>
								<div class="bp_row" v-if="!uv_only">
									<span>Merge</span>
									<select :value="settings.merge" @change="set('merge', $event.target.value)">
										<option value="all">all cubes that form one box</option>
										<option value="patched">only around patches</option>
										<option value="off">off</option>
									</select>
								</div>
								<div class="bp_row">
									<span>UV</span>
									<select :value="settings.uv_mode" @change="set('uv_mode', $event.target.value)">
										<option value="all">repack everything by group</option>
										<option value="changed">keep untouched UVs, add new at the bottom</option>
									</select>
								</div>
								<div class="bp_row"><span>Padding</span><input type="number" min="0" max="8" :value="settings.padding" @change="set('padding', Number($event.target.value))"><span class="bp_subtle">px between faces</span></div>
								<div class="bp_row"><input type="checkbox" :checked="uv_only ? settings.uv_cull : settings.cull_hidden" @change="set('cull_hidden', $event.target.checked)"><span>Drop faces nobody can see</span></div>
								<div class="bp_row" v-if="!uv_only"><input type="checkbox" :checked="settings.retexture_add" @change="set('retexture_add', $event.target.checked)"><span>Paint ADD cubes like what they attach to</span></div>
							</template>
						</div>
					`
				}
			});
		}

		parts.push({
			onload() {
				bpStyle = Blockbench.addCSS(`
					[menu_item="block_patcher"] > .icon, [toolbar_item="block_patcher"] .icon,
					.panel_handle[panel_id="block_patcher_panel"] .icon { color: ${BP_COLOR} !important; }
					[toolbar_item="block_patcher_marker"] .icon, [menu_item="block_patcher_marker"] > .icon { color: #ff2d55 !important; }
					.bp_panel { padding: 4px 8px 8px; }
					.bp_title { font-weight: bold; margin-bottom: 4px; }
					[menu_item="organize_uv"] > .icon { color: ${BP_COLOR} !important; }
					.bp_panel > label { display: block; margin: 10px 0 4px; color: var(--color-subtle_text); }
					.bp_subtle { color: var(--color-subtle_text); font-size: 0.85em; }
					.bp_actions { display: flex; flex-wrap: wrap; gap: 4px; }
					.bp_button { display: flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 4px; background-color: var(--color-button); cursor: pointer; }
					.bp_button:hover { background-color: var(--color-selected); }
					.bp_button.selected, .bp_primary { background-color: var(--color-accent); color: var(--color-accent_text); }
					.bp_stats { margin-top: 8px; }
					.bp_stats > div { display: flex; justify-content: space-between; }
					.bp_stats span { color: var(--color-subtle_text); }
					.bp_warning { color: #ffb020; font-size: 0.85em; margin-top: 4px; }
					.bp_hint { color: var(--color-subtle_text); font-size: 0.85em; margin: 4px 0 0; }
					.bp_hint a { cursor: pointer; text-decoration: underline; margin-right: 6px; }
					.bp_ops { max-height: 220px; overflow-y: auto; }
					.bp_op { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
					.bp_op.off { opacity: 0.5; }
					.bp_op_name { flex: 1; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
					.bp_op_name:hover { text-decoration: underline; }
					.bp_row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
					.bp_row select { flex: 1; min-width: 0; }
					.bp_row input[type=range] { flex: 1; }
					.bp_row input[type=number] { width: 60px; }
				`);
				bpAction = new Action('block_patcher', {
					name: 'BlockPatcher',
					description: 'Apply ADD, CUTOUT and HOLLOW cubes, merge cubes and lay out the UV, in a preview tab you confirm',
					icon: 'auto_fix_high',
					condition: () => Project && !Project.block_patcher_preview && Modes.edit,
					click: runBlockPatcher
				});
				MenuBar.addAction(bpAction, 'tools');
				uvAction = new Action('organize_uv', {
					name: 'Organize UV',
					description: 'Lay out the whole UV again, bone by bone, without changing the model, in a preview tab you confirm',
					icon: 'dashboard',
					condition: () => Project && !Project.block_patcher_preview && Format && Format.id !== 'image',
					click: () => runBlockPatcher(true)
				});
				MenuBar.addAction(uvAction, 'tools');
				try { MenuBar.addAction(uvAction, 'uv'); } catch (e) {}
				markerTool = new Tool('block_patcher_marker', {
					name: 'BlockPatcher Marker',
					description: 'Click parts of the BlockPatcher preview that came out wrong, then Restore them in the BlockPatcher panel',
					icon: 'ads_click',
					category: 'tools',
					cursor: 'crosshair',
					selectFace: false,
					selectElements: false,
					transformerMode: 'hidden',
					modes: ['edit'],
					condition: () => !!(session && Project && Project === session.preview),
					onCanvasClick(data) {
						if (data && data.element) toggleMark(data.element);
					},
					onSelect() { syncBpPanel(); },
					onUnselect() { setTimeout(syncBpPanel, 0); }
				});
				// once only, even if an older copy of this plugin left an entry behind
				if (Toolbox.children) {
					for (let i = Toolbox.children.length - 1; i >= 0; i--) {
						const it = Toolbox.children[i];
						if ((typeof it === 'string' ? it : it && it.id) === 'block_patcher_marker') Toolbox.children.splice(i, 1);
					}
				}
				try { Toolbox.add(markerTool); } catch (e) {}
				createBpPanel();
				bpListeners.push(Blockbench.on('finished_edit', onPreviewEdit));
				bpListeners.push(Blockbench.on('select_project', () => { drawMarks(); syncBpPanel(); }));
				for (const ev of ['undo', 'redo']) bpListeners.push(Blockbench.on(ev, () => setTimeout(() => { if (session && Project === session.preview) { session.lastIds = new Set(Outliner.elements.map(e => e.uuid)); drawMarks(); } }, 0)));
				bpListeners.push(Blockbench.on('close_project', data => {
					if (!session || session.rebuilding) return;
					const p = data && data.project;
					if (p === session.preview) session = null;               // closed the preview tab: same as Cancel
					else if (p === session.og) Blockbench.showQuickMessage('The original model of this BlockPatcher preview was closed', 2500);
				}));
			},
			onunload() {
				bpListeners.forEach(l => l && l.delete && l.delete());
				bpListeners.length = 0;
				for (const [, m] of markerMeshes) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); }
				markerMeshes.clear();
				if (bpPanel) bpPanel.delete();
				if (markerTool) markerTool.delete();
				if (bpAction) bpAction.delete();
				if (uvAction) uvAction.delete();
				if (bpStyle && bpStyle.delete) bpStyle.delete();
				session = null;
			}
		});

	})();
	/* ===================== end BlockPatcher ===================== */

	if (typeof Plugin === 'undefined') return;

	Plugin.register('model_texture_garage', {
		title: 'Model & Texture Garage',
		author: 'Shapescape',
		description: 'Brushes for pixel art edges, highlights, shadows, noise and block cells, a colour reference panel, and a tool to add and cut out cubes on the block grid.',
		icon: 'garage',
		version: '1.8.0',
		min_version: '5.0.0',
		variant: 'both',
		onload() {
			for (const part of parts) part.onload();
		},
		onunload() {
			for (const part of parts) part.onunload();
		}
	});
})();
