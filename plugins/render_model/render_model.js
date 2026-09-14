"use strict";
(function () {
	const PLUGIN_ID = "render_model";
	const STORAGE_KEY = "render_model_settings";

	const path = typeof require === "function" ? require("path") : null;
	let fs;

	let render_action;
	// The animation list the open dialog was built from, so the anim_<n> form
	// keys can be resolved back to animations on confirm.
	let dialog_animations = [];

	function joinPath(dir, file) {
		if (path) return path.join(dir, file);
		return dir.replace(/[\\/]+$/, "") + "/" + file;
	}

	function ensureFs() {
		fs ??= requireNativeModule("fs", {
			message: "Required to write the rendered images into the output folder.",
		});
		return !!fs;
	}

	function clamp(value, min, max) {
		return Math.max(min, Math.min(max, value));
	}

	function bytesToBase64(bytes) {
		let binary = "";
		const chunk_size = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk_size) {
			binary += String.fromCharCode.apply(
				null,
				bytes.subarray(i, i + chunk_size),
			);
		}
		return btoa(binary);
	}

	// Each run gets its own folder. An existing name is never reused or written
	// into, it gets a _1, _2 and so on instead.
	function makeRunFolder(parent, name) {
		let target = joinPath(parent, name);
		let counter = 0;
		while (fs.existsSync(target)) {
			counter++;
			target = joinPath(parent, name + "_" + counter);
		}
		fs.mkdirSync(target, { recursive: true });
		return target;
	}

	function writeBase64(file_path, base64) {
		fs.writeFileSync(file_path, base64, "base64");
	}

	// ----- stored settings -----
	function loadSettings() {
		try {
			return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
		} catch (err) {
			return {};
		}
	}

	function saveSettings(form) {
		const data = Object.assign({}, form);
		delete data.prefix;
		// Animation picks are keyed by project-specific ids, so they are not worth
		// carrying into the next model.
		delete data.anim_main;
		delete data.anim_overlay;
		delete data.gif_animations;
		data.background = colorToHex(form.background);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
		} catch (err) {
			console.warn("Model Render: could not store settings", err);
		}
	}

	function colorToHex(value) {
		if (!value) return null;
		if (typeof value === "string") return value;
		if (typeof value.toHexString === "function") return value.toHexString();
		return null;
	}

	// ----- camera directions -----
	// Every direction is a unit vector pointing from the model to the camera.
	function forwardVector() {
		switch (typeof Format !== "undefined" && Format.forward_direction) {
			case "+x":
				return new THREE.Vector3(1, 0, 0);
			case "-x":
				return new THREE.Vector3(-1, 0, 0);
			case "+z":
				return new THREE.Vector3(0, 0, 1);
			case "-z":
			default:
				return new THREE.Vector3(0, 0, -1);
		}
	}

	const UP = new THREE.Vector3(0, 1, 0);
	// atan(1 / sqrt(2)), the camera pitch of a true isometric view.
	const ISO_PITCH = Math.atan(Math.SQRT1_2);

	function tilt(flat_direction, pitch) {
		return new THREE.Vector3()
			.copy(flat_direction)
			.normalize()
			.multiplyScalar(Math.cos(pitch))
			.addScaledVector(UP, Math.sin(pitch))
			.normalize();
	}

	function turntableDirections(steps, pitch_degrees) {
		const forward = forwardVector();
		const pitch = Math.degToRad(clamp(pitch_degrees, -89, 89));
		const directions = [];
		for (let i = 0; i < steps; i++) {
			const yaw = (i / steps) * Math.PI * 2;
			directions.push(tilt(forward.clone().applyAxisAngle(UP, yaw), pitch));
		}
		return directions;
	}

	function collectStills(form) {
		const forward = forwardVector();
		const right = new THREE.Vector3().crossVectors(UP, forward).normalize();
		const angles = [];

		// Only the fixed views have a place in a sheet. Turntable stills and the
		// current view are always written as separate images.
		function add(name, vector, sheetable) {
			angles.push({
				name,
				direction: vector.clone().normalize(),
				sheetable: !!sheetable,
			});
		}

		if (form.sides) {
			add("front", forward, true);
			add("back", forward.clone().negate(), true);
			add("right", right, true);
			add("left", right.clone().negate(), true);
		}
		if (form.top_bottom) {
			add("top", UP, true);
			add("bottom", UP.clone().negate(), true);
		}
		if (form.isometric) {
			add("iso_front_right", tilt(forward.clone().add(right), ISO_PITCH), true);
			add("iso_front_left", tilt(forward.clone().sub(right), ISO_PITCH), true);
			add("iso_back_right", tilt(forward.clone().negate().add(right), ISO_PITCH), true);
			add("iso_back_left", tilt(forward.clone().negate().sub(right), ISO_PITCH), true);
		}
		if (form.turntable) {
			const steps = clamp(Math.round(form.turntable), 2, 64);
			const digits = String(steps - 1).length;
			turntableDirections(steps, form.turntable_pitch ?? 30).forEach(
				(direction, i) => {
					add("turn_" + String(i).padStart(digits, "0"), direction, false);
				},
			);
		}
		if (form.current_view) {
			angles.push({ name: "view", copy_viewport: true });
		}
		return angles;
	}

	const TILE_LABELS = {
		front: "Front",
		right: "Right",
		back: "Back",
		left: "Left",
		top: "Top",
		bottom: "Bottom",
		iso_front_left: "Front left",
		iso_front_right: "Front right",
		iso_back_left: "Back left",
		iso_back_right: "Back right",
	};

	function stillsToSheets(form) {
		return form.stills_export === "sheets" || form.stills_export === "both";
	}

	// Rows read left to right, top to bottom. Four views always sit two over
	// two, and the sides read as one rotation: front, right, back, left.
	function stillSheetLayouts(form) {
		if (!stillsToSheets(form)) return [];
		const sheets = [];
		if (form.sides && form.top_bottom && form.sheet_six === "combined") {
			sheets.push({
				name: "all_views",
				label: "all views sheet",
				rows: [
					["front", "right", "top"],
					["back", "left", "bottom"],
				],
			});
		} else {
			if (form.sides) {
				sheets.push({
					name: "sides",
					label: "sides sheet",
					rows: [
						["front", "right"],
						["back", "left"],
					],
				});
			}
			if (form.top_bottom) {
				sheets.push({
					name: "top_bottom",
					label: "top and bottom sheet",
					rows: [["top", "bottom"]],
				});
			}
		}
		if (form.isometric) {
			sheets.push({
				name: "isometric",
				label: "isometric sheet",
				rows: [
					["iso_front_left", "iso_front_right"],
					["iso_back_left", "iso_back_right"],
				],
			});
		}
		return sheets;
	}

	function directionByName(name) {
		const forward = forwardVector();
		const right = new THREE.Vector3().crossVectors(UP, forward).normalize();
		switch (name) {
			case "front":
				return forward;
			case "back":
				return forward.clone().negate();
			case "right":
				return right;
			case "left":
				return right.clone().negate();
			case "top":
				return UP.clone();
			case "bottom":
				return UP.clone().negate();
			case "iso_front_left":
				return tilt(forward.clone().sub(right), ISO_PITCH);
			case "iso_back_right":
				return tilt(forward.clone().negate().add(right), ISO_PITCH);
			case "iso_back_left":
				return tilt(forward.clone().negate().sub(right), ISO_PITCH);
			case "iso_front_right":
			default:
				return tilt(forward.clone().add(right), ISO_PITCH);
		}
	}

	// ----- animations -----
	function listAnimations() {
		if (typeof Animation === "undefined" || !Animation.all) return [];
		return Animation.all.slice();
	}

	function selectedAnimations(record) {
		if (!record) return [];
		return dialog_animations.filter((animation) => record[animation.uuid]);
	}

	function overlayAnimations(form) {
		return selectedAnimations(form.anim_overlay);
	}

	// The checkbox keeps its saved value even when a project has no animations
	// and the checkbox is hidden, so its value alone cannot gate anything.
	function animationsEnabled(form) {
		return dialog_animations.length > 0 && !!form.animations;
	}

	// Each group is one output: the first entry is the base animation and the
	// rest play on top of it, the way Blockbench stacks them in the viewport.
	function animationGroups(form) {
		if (!animationsEnabled(form)) return [];
		const mains = selectedAnimations(form.anim_main);
		const overlays = overlayAnimations(form);

		if (!mains.length) {
			return overlays.length ? [overlays.slice()] : [];
		}
		if (form.anim_export === "layered") {
			return [dedupeAnimations(mains.concat(overlays))];
		}
		return mains.map((main) => dedupeAnimations([main].concat(overlays)));
	}

	function animationsToGifs(form) {
		const mode = form.anim_export || "separate";
		return mode === "separate" || mode === "layered" || mode === "both";
	}

	function animationsToSheet(form) {
		return form.anim_export === "sheet" || form.anim_export === "both";
	}

	function dedupeAnimations(list) {
		const seen = new Set();
		return list.filter((animation) => {
			if (seen.has(animation.uuid)) return false;
			seen.add(animation.uuid);
			return true;
		});
	}

	function safeName(name) {
		return String(name || "animation")
			.replace(/^animation\./, "")
			.replace(/[^a-zA-Z0-9_.-]+/g, "_");
	}

	function resolveTurntableAnimations(form) {
		if (!form.gif) return [];
		return selectedAnimations(form.gif_animations);
	}

	function groupFrameCount(group, fps) {
		return Math.max(1, Math.round(longestLength(group) * fps));
	}

	// Blockbench stacks every animation whose `playing` flag is set, so layering
	// is a matter of setting the flag on more than one.
	function setPlayingAnimations(animations) {
		if (typeof AnimationItem !== "undefined" && AnimationItem.all) {
			AnimationItem.all.forEach((item) => {
				if (item.playing) item.playing = false;
			});
		}
		animations.forEach((animation) => {
			animation.playing = true;
		});
	}

	function poseAnimations(animations, time) {
		if (!animations.length) return;
		// select() rebinds the timeline but clears the other playing flags, so the
		// flags have to be set afterwards.
		animations[0].select();
		setPlayingAnimations(animations);
		Timeline.setTime(time);
		Animator.preview();
	}

	function longestLength(animations) {
		let longest = 0;
		animations.forEach((animation) => {
			longest = Math.max(longest, animation.length || 1);
		});
		return longest || 1;
	}

	function enterAnimateMode() {
		const previous_mode = Mode.selected && Mode.selected.id;
		if (!Animator.open && Modes.options.animate) {
			Modes.options.animate.select();
		}
		return previous_mode;
	}

	function restoreMode(previous_mode, previous_animation) {
		Timeline.setTime(0);
		Animator.showDefaultPose();
		if (previous_animation) previous_animation.select();
		if (previous_mode && Modes.options[previous_mode] && Mode.selected.id !== previous_mode) {
			Modes.options[previous_mode].select();
		}
	}

	// Animated limbs reach outside the rest pose, so the frame has to account for
	// every pose the run will render.
	function unionAnimationBounds(groups, fps, base_box) {
		const box = base_box.clone();
		groups.forEach((group) => {
			if (!group.length) return;
			const length = longestLength(group);
			const count = Math.max(1, Math.round(length * fps));
			for (let i = 0; i < count; i++) {
				poseAnimations(group, (i / fps) % length);
				const frame_box = getModelBounds();
				if (frame_box) box.union(frame_box);
			}
		});
		Timeline.setTime(0);
		Animator.showDefaultPose();
		return box;
	}

	// ----- sizes -----
	// The largest edge any single render may have. Supersampling multiplies the
	// render size, so it is capped against this too.
	const MAX_RENDER_SIZE = 4096;
	const SIZE_PRESETS = ["512", "1024", "2048", "4096"];

	function parseSizeList(text) {
		const sizes = [];
		String(text || "")
			.split(",")
			.forEach((chunk) => {
				const trimmed = chunk.trim().toLowerCase();
				if (!trimmed) return;
				const parts = trimmed.split(/[x*]/);
				const width = parseInt(parts[0], 10);
				const height = parts.length > 1 ? parseInt(parts[1], 10) : width;
				if (!width || !height || width < 1 || height < 1) return;
				sizes.push({
					width: clamp(width, 1, MAX_RENDER_SIZE),
					height: clamp(height, 1, MAX_RENDER_SIZE),
					label: parts.length > 1 ? width + "x" + height : String(width),
				});
			});
		return sizes;
	}

	function collectSizes(form) {
		const chosen = form.size_presets || {};
		const sizes = [];
		SIZE_PRESETS.forEach((preset) => {
			if (!chosen[preset]) return;
			const value = parseInt(preset, 10);
			sizes.push({ width: value, height: value, label: preset });
		});
		parseSizeList(form.sizes_extra).forEach((size) => {
			if (sizes.some((existing) => existing.label === size.label)) return;
			sizes.push(size);
		});
		return sizes;
	}

	function smoothness(value) {
		return clamp(parseInt(value, 10) || 20, 1, 50);
	}

	function gifFrameCount(form) {
		if (!form.gif) return 0;
		const seconds = clamp(form.gif_seconds || 3, 0.2, 30);
		return clamp(
			Math.round(seconds * smoothness(form.gif_smoothness)),
			2,
			300,
		);
	}

	// ----- model bounds -----
	function getModelBounds() {
		const box = new THREE.Box3();
		let found = false;
		Outliner.elements.forEach((element) => {
			const mesh = element.mesh;
			if (!mesh || !mesh.geometry) return;
			if (element.visibility === false) return;
			if (
				typeof element.getTypeBehavior === "function" &&
				element.getTypeBehavior("hide_in_screenshot")
			) {
				return;
			}
			mesh.updateMatrixWorld(true);
			box.expandByObject(mesh);
			found = true;
		});
		if (!found || box.isEmpty()) return null;
		return box;
	}

	function boxCorners(box) {
		const corners = [];
		for (let x = 0; x < 2; x++) {
			for (let y = 0; y < 2; y++) {
				for (let z = 0; z < 2; z++) {
					corners.push(
						new THREE.Vector3(
							x ? box.max.x : box.min.x,
							y ? box.max.y : box.min.y,
							z ? box.max.z : box.min.z,
						),
					);
				}
			}
		}
		return corners;
	}

	// ----- size reference figure -----
	// Blockbench only ships a player reference inside Display Mode, which entity
	// formats never enter, so this builds a plain player-proportioned stand-in.
	const PLAYER_PARTS = [
		{ size: [8, 8, 8], at: [0, 28, 0] },
		{ size: [8, 12, 4], at: [0, 18, 0] },
		{ size: [4, 12, 4], at: [-6, 18, 0] },
		{ size: [4, 12, 4], at: [6, 18, 0] },
		{ size: [4, 12, 4], at: [-2, 6, 0] },
		{ size: [4, 12, 4], at: [2, 6, 0] },
	];

	// 128/255 rather than a flat 0.5. GIF transparency is one bit and the cutoff
	// sits at 128, so a value that rounds down would make the figure vanish.
	const REFERENCE_OPACITY = 128 / 255;

	function buildReferenceFigure(color) {
		const group = new THREE.Group();
		const material = new THREE.MeshBasicMaterial({
			color: color || 0x9aa7b4,
			transparent: true,
			opacity: REFERENCE_OPACITY,
			// Blend with whatever is behind instead of hiding it.
			depthWrite: false,
		});
		group.userData.material = material;
		PLAYER_PARTS.forEach((part) => {
			const geometry = new THREE.BoxGeometry(
				part.size[0],
				part.size[1],
				part.size[2],
			);
			const mesh = new THREE.Mesh(geometry, material);
			mesh.position.set(part.at[0], part.at[1], part.at[2]);
			group.add(mesh);
		});
		return group;
	}

	function disposeReferenceFigure(group) {
		group.children.forEach((mesh) => mesh.geometry.dispose());
		if (group.userData.material) group.userData.material.dispose();
	}

	function projectRange(box, axis) {
		let min = Infinity;
		let max = -Infinity;
		boxCorners(box).forEach((corner) => {
			const value = corner.dot(axis);
			min = Math.min(min, value);
			max = Math.max(max, value);
		});
		return [min, max];
	}

	// Stand the figure next to the model, feet level with its lowest point.
	function placeReferenceFigure(group, box) {
		const forward = forwardVector();
		const axis = new THREE.Vector3().crossVectors(UP, forward).normalize();
		Canvas.scene.updateMatrixWorld(true);
		const figure_box = new THREE.Box3().setFromObject(group);
		const gap = 4;

		const model_range = projectRange(box, axis);
		const figure_range = projectRange(figure_box, axis);
		group.position.addScaledVector(
			axis,
			model_range[1] + gap - figure_range[0],
		);
		group.position.y += box.min.y - figure_box.min.y;
		Canvas.scene.updateMatrixWorld(true);
	}

	// ----- camera -----
	function aimCamera(preview, direction, box) {
		const center = box.getCenter(new THREE.Vector3());
		const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
		const distance = Math.max(512, radius * 4);
		const camera = preview.camera;

		camera.position.copy(center).addScaledVector(direction, distance);
		preview.controls.target.copy(center);
		camera.lookAt(center);
		camera.updateMatrixWorld(true);
		return camera;
	}

	// How far the model reaches sideways and vertically in camera space, in model
	// units. Independent of resolution, so one measurement drives every size.
	function measureExtent(preview, direction, box) {
		const camera = aimCamera(preview, direction, box);
		let max_x = 0;
		let max_y = 0;
		boxCorners(box).forEach((corner) => {
			corner.applyMatrix4(camera.matrixWorldInverse);
			max_x = Math.max(max_x, Math.abs(corner.x));
			max_y = Math.max(max_y, Math.abs(corner.y));
		});
		return [max_x, max_y];
	}

	// One scale for the whole run, so the model never changes size between
	// angles, between sizes, or between the frames of a turntable.
	function measureRun(preview, directions, box) {
		let max_x = 0.0001;
		let max_y = 0.0001;
		directions.forEach((direction) => {
			const extent = measureExtent(preview, direction, box);
			max_x = Math.max(max_x, extent[0]);
			max_y = Math.max(max_y, extent[1]);
		});
		return [max_x, max_y];
	}

	function applyZoom(camera, extent, options) {
		if (options.fit) {
			const padding = 1 - clamp(options.padding, 0, 45) / 100;
			camera.zoom =
				Math.min(camera.right / extent[0], camera.top / extent[1]) * padding;
		} else {
			const frame_height = Math.max(options.frame_height || 32, 0.1);
			camera.zoom = camera.top / (frame_height / 2);
		}
		camera.updateProjectionMatrix();
	}

	// ----- rendering -----
	function captureCanvas(preview, size, options) {
		const canvas = document.createElement("canvas");
		canvas.width = size.width;
		canvas.height = size.height;
		const ctx = canvas.getContext("2d");

		if (options.background) {
			ctx.fillStyle = options.background;
			ctx.fillRect(0, 0, size.width, size.height);
		}
		ctx.imageSmoothingEnabled = !!options.supersample;
		if (options.supersample) ctx.imageSmoothingQuality = "high";
		ctx.drawImage(preview.canvas, 0, 0, size.width, size.height);
		return canvas;
	}

	function renderFrame(angle, size, options) {
		const preview = Screencam.NoAAPreview;
		const longest = Math.max(size.width, size.height);
		const factor = options.supersample
			? clamp(Math.floor(MAX_RENDER_SIZE / longest), 1, 4)
			: 1;

		// Projection must be settled before resizing: the orthographic frustum is
		// derived from the render size.
		preview.setProjectionMode(
			angle.copy_viewport ? Preview.selected.isOrtho : true,
		);
		preview.resize(size.width * factor, size.height * factor);
		preview.camera.layers.set(0);

		if (angle.copy_viewport) {
			preview.copyView(Preview.selected);
		} else {
			const camera = aimCamera(preview, angle.direction, options.box);
			applyZoom(camera, options.extent, options);
		}

		let canvas;
		Canvas.withoutGizmos(() => {
			preview.render();
			canvas = captureCanvas(preview, size, options);
		});
		return canvas;
	}

	// ----- sheets -----
	const LABEL_BAND = "#e8ebee";
	const LABEL_TEXT = "#1d2226";
	const LABEL_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

	// A browser canvas cannot be created past these, so a sheet this large would
	// come out blank rather than slow. Everything below them is allowed.
	const MAX_CANVAS_EDGE = 32767;
	const MAX_CANVAS_AREA = 268435456;

	// Most compact grid for a list: up to three in a row, then close to square.
	function gridRows(items) {
		if (!items.length) return [];
		const cols =
			items.length <= 3 ? items.length : Math.ceil(Math.sqrt(items.length));
		const rows = [];
		for (let i = 0; i < items.length; i += cols) {
			rows.push(items.slice(i, i + cols));
		}
		return rows;
	}

	function sheetMetrics(size, labels) {
		const gap = Math.max(2, Math.round(Math.min(size.width, size.height) * 0.02));
		const label_height = labels
			? Math.max(14, Math.round(size.height * 0.09))
			: 0;
		return {
			gap,
			label_height,
			cell_height: label_height + size.height,
		};
	}

	function sheetDimensions(rows, size, labels) {
		const metrics = sheetMetrics(size, labels);
		const cols = Math.max(...rows.map((row) => row.length));
		return {
			width: cols * size.width + (cols + 1) * metrics.gap,
			height: rows.length * metrics.cell_height + (rows.length + 1) * metrics.gap,
		};
	}

	function exceedsCanvas(dimensions) {
		return (
			dimensions.width > MAX_CANVAS_EDGE ||
			dimensions.height > MAX_CANVAS_EDGE ||
			dimensions.width * dimensions.height > MAX_CANVAS_AREA
		);
	}

	function drawLabel(ctx, text, x, y, width, height) {
		ctx.fillStyle = LABEL_BAND;
		ctx.fillRect(x, y, width, height);

		const max_width = width * 0.92;
		let font_size = Math.round(height * 0.58);
		ctx.font = "600 " + font_size + "px " + LABEL_FONT;
		const measured = ctx.measureText(text).width;
		if (measured > max_width) {
			font_size = Math.max(8, Math.floor((font_size * max_width) / measured));
			ctx.font = "600 " + font_size + "px " + LABEL_FONT;
		}

		// Still too wide at the smallest size: cut it and show that it was cut.
		let shown = text;
		if (ctx.measureText(shown).width > max_width) {
			while (
				shown.length > 1 &&
				ctx.measureText(shown + "\u2026").width > max_width
			) {
				shown = shown.slice(0, -1);
			}
			shown += "\u2026";
		}

		ctx.fillStyle = LABEL_TEXT;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(shown, x + width / 2, y + height / 2);
	}

	// rows: arrays of { label, canvas }, each canvas one tile at `size`. A row
	// shorter than the widest one is centred under it.
	function composeSheet(rows, size, options) {
		const metrics = sheetMetrics(size, options.labels);
		const dimensions = sheetDimensions(rows, size, options.labels);
		const cols = Math.max(...rows.map((row) => row.length));

		const canvas = document.createElement("canvas");
		canvas.width = dimensions.width;
		canvas.height = dimensions.height;
		const ctx = canvas.getContext("2d");

		if (options.background) {
			ctx.fillStyle = options.background;
			ctx.fillRect(0, 0, dimensions.width, dimensions.height);
		}

		rows.forEach((row, r) => {
			const offset = (cols - row.length) / 2;
			row.forEach((cell, c) => {
				const x = Math.round(
					metrics.gap + (c + offset) * (size.width + metrics.gap),
				);
				const y = metrics.gap + r * (metrics.cell_height + metrics.gap);
				if (metrics.label_height) {
					drawLabel(ctx, cell.label, x, y, size.width, metrics.label_height);
				}
				ctx.drawImage(cell.canvas, x, y + metrics.label_height);
			});
		});
		return canvas;
	}

	// Sheets planned for a run, with their pixel size at each output size.
	function plannedSheets(form, sizes, group_count) {
		const labels = form.sheet_labels !== false;
		const planned = [];
		stillSheetLayouts(form).forEach((layout) => {
			sizes.forEach((size) => {
				planned.push({
					label: layout.label,
					size,
					dimensions: sheetDimensions(layout.rows, size, labels),
					animated: false,
				});
			});
		});
		if (animationsToSheet(form) && group_count) {
			const rows = gridRows(new Array(group_count).fill(0));
			sizes.forEach((size) => {
				planned.push({
					label: "animation sheet",
					size,
					dimensions: sheetDimensions(rows, size, labels),
					animated: true,
				});
			});
		}
		return planned;
	}

	// ----- gif -----
	// Alpha at or above this counts as opaque. GIF transparency is one bit.
	const ALPHA_CUTOFF = 128;

	// A generic quantiser matches each pixel to its nearest palette colour and
	// ignores alpha, so an opaque black pixel lands on the transparent entry and
	// punches a hole in the frame. Model renders are flat colour, so build the
	// palette from the exact colours instead and keep index 0 for transparency
	// alone. Falls back to quantising only when a frame needs over 256 colours.
	function buildFrame(canvas, transparent) {
		const width = canvas.width;
		const height = canvas.height;
		const data = canvas
			.getContext("2d")
			.getImageData(0, 0, width, height).data;
		const pixels = width * height;
		const index = new Uint8Array(pixels);
		const palette = transparent ? [[0, 0, 0]] : [];
		const lookup = new Map();

		for (let i = 0; i < pixels; i++) {
			const offset = i * 4;
			if (transparent && data[offset + 3] < ALPHA_CUTOFF) {
				index[i] = 0;
				continue;
			}
			const r = data[offset];
			const g = data[offset + 1];
			const b = data[offset + 2];
			const key = (r << 16) | (g << 8) | b;
			let slot = lookup.get(key);
			if (slot === undefined) {
				if (palette.length >= 256) {
					return quantizeFrame(data, pixels, transparent);
				}
				slot = palette.length;
				palette.push([r, g, b]);
				lookup.set(key, slot);
			}
			index[i] = slot;
		}
		return { index, palette };
	}

	function quantizeFrame(data, pixels, transparent) {
		const opaque = new Uint8ClampedArray(data);
		if (transparent) {
			for (let i = 0; i < pixels; i++) {
				opaque[i * 4 + 3] = 255;
			}
		}
		// Quantise with every pixel opaque, then reserve index 0 afterwards, so
		// no real colour can be mistaken for the transparent entry.
		const format = "rgb565";
		const quantized = GIFEnc.quantize(opaque, transparent ? 255 : 256, {
			format,
		});
		const mapped = GIFEnc.applyPalette(opaque, quantized, format);
		const shift = transparent ? 1 : 0;
		const index = new Uint8Array(pixels);
		for (let i = 0; i < pixels; i++) {
			if (transparent && data[i * 4 + 3] < ALPHA_CUTOFF) {
				index[i] = 0;
				continue;
			}
			index[i] = mapped[i] + shift;
		}
		const palette = quantized.map((color) => [color[0], color[1], color[2]]);
		return {
			index,
			palette: transparent ? [[0, 0, 0]].concat(palette) : palette,
		};
	}

	// Frames are written as they are rendered rather than collected first. A 4K
	// turntable would otherwise hold gigabytes of canvases before encoding.
	function startGif() {
		if (typeof GIFEnc === "undefined") {
			throw new Error("this Blockbench build has no GIF encoder");
		}
		return GIFEnc.GIFEncoder();
	}

	function addGifFrame(gif, canvas, delay, transparent) {
		const frame = buildFrame(canvas, transparent);
		gif.writeFrame(frame.index, canvas.width, canvas.height, {
			palette: frame.palette,
			delay,
			transparent,
		});
	}

	function finishGif(gif) {
		gif.finish();
		return gif.bytesView();
	}

	function frameDelay(fps) {
		// gifenc stores delays in hundredths of a second.
		return Math.max(Math.round(1000 / fps / 10) * 10, 20);
	}

	// ----- the run -----
	async function runRender(form) {
		if (!Project) {
			Blockbench.notification("Model Render", "Open a model first.");
			return;
		}
		if (!ensureFs()) return;

		const stills = collectStills(form);
		const gif_frames = gifFrameCount(form);
		const anim_groups = animationGroups(form);
		if (!stills.length && !gif_frames && !anim_groups.length) {
			Blockbench.notification("Model Render", "Select at least one angle.");
			return;
		}

		const sizes = collectSizes(form);
		if (!sizes.length) {
			Blockbench.notification("Model Render", "Pick at least one image size.");
			return;
		}

		const parent_folder = form.output_folder;
		if (!parent_folder) {
			Blockbench.notification("Model Render", "Choose an output folder.");
			return;
		}
		if (!fs.existsSync(parent_folder)) {
			fs.mkdirSync(parent_folder, { recursive: true });
		}

		const box = getModelBounds();
		if (!box) {
			Blockbench.notification(
				"Model Render",
				"The model has nothing visible to render.",
			);
			return;
		}

		const too_large = plannedSheets(form, sizes, anim_groups.length).find(
			(sheet) => exceedsCanvas(sheet.dimensions),
		);
		if (too_large) {
			Blockbench.notification(
				"Model Render",
				"The " +
					too_large.label +
					" would be " +
					too_large.dimensions.width +
					" by " +
					too_large.dimensions.height +
					" pixels at " +
					too_large.size.label +
					", which is more than Blockbench can draw. Pick a smaller size" +
					(too_large.animated ? " or fewer animations." : "."),
			);
			return;
		}

		// Created last, so a run that fails a check leaves no empty folder behind.
		const prefix = (form.prefix || Project.name || "model").trim();
		const folder = makeRunFolder(parent_folder, safeName(prefix));

		const anim_fps = smoothness(form.anim_smoothness);
		const gif_fps = smoothness(form.gif_smoothness);
		const gif_animations = resolveTurntableAnimations(form);
		const posed_groups = anim_groups.concat(
			gif_animations.length ? [gif_animations] : [],
		);

		const previous_animation =
			typeof Animation !== "undefined" ? Animation.selected : null;
		let previous_mode = null;
		let bounds = box;
		if (posed_groups.length) {
			previous_mode = enterAnimateMode();
			bounds = unionAnimationBounds(
				posed_groups,
				Math.max(anim_fps, gif_fps),
				box,
			);
		}

		let reference = null;
		if (form.reference) {
			reference = buildReferenceFigure();
			Canvas.scene.add(reference);
			placeReferenceFigure(reference, bounds);
			bounds = bounds
				.clone()
				.union(new THREE.Box3().setFromObject(reference));
		}

		const preview = Screencam.NoAAPreview;
		preview.setProjectionMode(true);

		const gif_directions = gif_frames
			? turntableDirections(gif_frames, form.gif_pitch ?? 30)
			: [];
		const measured = stills
			.filter((angle) => !angle.copy_viewport)
			.map((angle) => angle.direction)
			.concat(gif_directions);

		const anim_angle =
			form.anim_angle === "view"
				? { copy_viewport: true }
				: { direction: directionByName(form.anim_angle) };
		if (anim_groups.length && !anim_angle.copy_viewport) {
			measured.push(anim_angle.direction);
		}

		const options = {
			box: bounds,
			extent: measured.length ? measureRun(preview, measured, bounds) : [1, 1],
			fit: form.fit,
			padding: form.padding,
			frame_height: form.frame_height,
			supersample: form.supersample,
			background: colorToHex(form.background),
			labels: form.sheet_labels !== false,
		};

		const still_sheets = stillSheetLayouts(form);
		const separate_sheetable = form.stills_export !== "sheets";
		const anim_gifs = animationsToGifs(form);
		const anim_sheet = animationsToSheet(form) && anim_groups.length > 0;

		const animation_frames = anim_groups.reduce(
			(sum, group) => sum + groupFrameCount(group, anim_fps),
			0,
		);
		const sheet_frames = anim_sheet
			? Math.max(...anim_groups.map((group) => groupFrameCount(group, anim_fps)))
			: 0;
		const total =
			sizes.length *
			(stills.length +
				gif_directions.length +
				(anim_sheet ? sheet_frames : animation_frames));
		let done = 0;
		const written = [];

		function tick() {
			done++;
			Blockbench.setProgress(done / Math.max(total, 1));
			return new Promise((resolve) => setTimeout(resolve, 0));
		}

		function suffix(size) {
			return sizes.length > 1 ? "_" + size.label : "";
		}

		const previous_shading = settings.shading.value;
		if (
			typeof form.shading === "boolean" &&
			form.shading !== previous_shading
		) {
			settings.shading.set(form.shading);
		}

		try {
			Blockbench.setStatusBarText("Rendering " + prefix);

			for (const size of sizes) {
				// Tiles are held only until every sheet that uses them is written,
				// so at most six full-size views are in memory at once.
				const tiles = {};
				const pending = still_sheets.slice();

				for (const angle of stills) {
					const canvas = renderFrame(angle, size, options);

					if (!angle.sheetable || separate_sheetable) {
						const file_name =
							prefix + "_" + angle.name + suffix(size) + ".png";
						writeBase64(
							joinPath(folder, file_name),
							canvas.toDataURL().split(";base64,").pop(),
						);
						written.push(file_name);
					}

					if (angle.sheetable && pending.length) {
						tiles[angle.name] = canvas;
						for (let i = pending.length - 1; i >= 0; i--) {
							const layout = pending[i];
							const keys = layout.rows.flat();
							if (!keys.every((key) => tiles[key])) continue;

							const sheet = composeSheet(
								layout.rows.map((row) =>
									row.map((key) => ({
										label: TILE_LABELS[key],
										canvas: tiles[key],
									})),
								),
								size,
								options,
							);
							const file_name =
								prefix + "_sheet_" + layout.name + suffix(size) + ".png";
							writeBase64(
								joinPath(folder, file_name),
								sheet.toDataURL().split(";base64,").pop(),
							);
							written.push(file_name);

							pending.splice(i, 1);
							keys.forEach((key) => {
								const still_needed = pending.some((other) =>
									other.rows.flat().includes(key),
								);
								if (!still_needed) delete tiles[key];
							});
						}
					}
					await tick();
				}

				if (gif_directions.length) {
					const transparent = !options.background;
					const delay = frameDelay(gif_fps);
					const gif = startGif();
					const spin_length = gif_animations.length
						? longestLength(gif_animations)
						: 0;
					for (let i = 0; i < gif_directions.length; i++) {
						if (spin_length) {
							poseAnimations(gif_animations, (i / gif_fps) % spin_length);
						}
						addGifFrame(
							gif,
							renderFrame({ direction: gif_directions[i] }, size, options),
							delay,
							transparent,
						);
						await tick();
					}
					const file_name = prefix + "_turntable" + suffix(size) + ".gif";
					writeBase64(
						joinPath(folder, file_name),
						bytesToBase64(finishGif(gif)),
					);
					written.push(file_name);
				}

				if (anim_sheet) {
					const transparent = !options.background;
					const delay = frameDelay(anim_fps);
					const lengths = anim_groups.map((group) => longestLength(group));
					const counts = anim_groups.map((group) =>
						groupFrameCount(group, anim_fps),
					);
					const names = anim_groups.map((group) => safeName(group[0].name));
					const group_gifs = anim_gifs ? anim_groups.map(() => startGif()) : null;
					const sheet_gif = startGif();

					// One pass renders every tile once per frame. The sheet runs as long as
					// its longest animation and shorter ones loop inside it, while each
					// animation's own GIF stops at its own length.
					for (let i = 0; i < sheet_frames; i++) {
						const cells = [];
						anim_groups.forEach((group, g) => {
							poseAnimations(group, (i / anim_fps) % lengths[g]);
							const tile = renderFrame(anim_angle, size, options);
							if (group_gifs && i < counts[g]) {
								addGifFrame(group_gifs[g], tile, delay, transparent);
							}
							cells.push({ label: names[g], canvas: tile });
						});
						addGifFrame(
							sheet_gif,
							composeSheet(gridRows(cells), size, options),
							delay,
							transparent,
						);
						await tick();
					}

					if (group_gifs) {
						group_gifs.forEach((gif, g) => {
							const file_name = prefix + "_" + names[g] + suffix(size) + ".gif";
							writeBase64(
								joinPath(folder, file_name),
								bytesToBase64(finishGif(gif)),
							);
							written.push(file_name);
						});
					}
					const sheet_name = prefix + "_sheet_animations" + suffix(size) + ".gif";
					writeBase64(
						joinPath(folder, sheet_name),
						bytesToBase64(finishGif(sheet_gif)),
					);
					written.push(sheet_name);
				} else if (anim_gifs) {
					for (const group of anim_groups) {
						const length = longestLength(group);
						const count = groupFrameCount(group, anim_fps);
						const transparent = !options.background;
						const delay = frameDelay(anim_fps);
						const gif = startGif();
						for (let i = 0; i < count; i++) {
							poseAnimations(group, (i / anim_fps) % length);
							addGifFrame(
								gif,
								renderFrame(anim_angle, size, options),
								delay,
								transparent,
							);
							await tick();
						}
						// With overlays the base animation still names the file. Only a
						// fully layered run has no single base to name it after.
						const label =
							form.anim_export === "layered" && group.length > 1
								? "animations"
								: safeName(group[0].name);
						const file_name = prefix + "_" + label + suffix(size) + ".gif";
						writeBase64(
							joinPath(folder, file_name),
							bytesToBase64(finishGif(gif)),
						);
						written.push(file_name);
					}
				}
			}
		} finally {
			if (reference) {
				Canvas.scene.remove(reference);
				disposeReferenceFigure(reference);
			}
			if (posed_groups.length) {
				restoreMode(previous_mode, previous_animation);
			}
			if (settings.shading.value !== previous_shading) {
				settings.shading.set(previous_shading);
			}
			Blockbench.setProgress();
			Blockbench.setStatusBarText();
		}

		Blockbench.notification(
			"Model Render",
			"Wrote " + written.length + " files to " + folder,
		);
		console.log("Model Render wrote:", written);
	}

	// ----- dialog -----
	const SMOOTHNESS_OPTIONS = {
		10: "Rough (10 per second)",
		15: "Normal (15 per second)",
		20: "Smooth (20 per second)",
		30: "Very smooth (30 per second)",
	};

	const CAMERA_OPTIONS = {
		iso_front_right: "Isometric, front right",
		iso_front_left: "Isometric, front left",
		front: "Front",
		back: "Back",
		left: "Left side",
		right: "Right side",
		top: "Top",
		view: "Whatever the viewport shows now",
	};

	function describeRun(form) {
		const sizes = collectSizes(form);
		const stills = collectStills(form);
		const sheetable = stills.filter((angle) => angle.sheetable).length;
		const images =
			stills.length - sheetable + (form.stills_export === "sheets" ? 0 : sheetable);
		const still_sheets = sheetable ? stillSheetLayouts(form).length : 0;
		const gif_frames = gifFrameCount(form);
		const groups = animationGroups(form);
		const overlays = animationsEnabled(form) ? overlayAnimations(form).length : 0;
		const anim_gifs = animationsToGifs(form) ? groups.length : 0;
		const anim_sheet = animationsToSheet(form) && groups.length > 0;
		const per_size =
			images + still_sheets + (gif_frames ? 1 : 0) + anim_gifs + (anim_sheet ? 1 : 0);

		if (!per_size) return "Nothing selected yet.";
		if (!sizes.length) return "Pick at least one image size.";

		const parts = [];
		if (images) parts.push(images + (images === 1 ? " image" : " images"));
		if (still_sheets) {
			parts.push(still_sheets + (still_sheets === 1 ? " sheet" : " sheets"));
		}
		if (gif_frames) {
			const seconds = clamp(form.gif_seconds || 3, 0.2, 30);
			const spinning = resolveTurntableAnimations(form).length;
			parts.push(
				"a turntable GIF of " +
					gif_frames +
					" frames over " +
					seconds +
					" seconds" +
					(spinning
						? " while " +
							spinning +
							(spinning === 1 ? " animation plays" : " animations play")
						: ""),
			);
		}
		if (anim_gifs) {
			let text =
				anim_gifs + (anim_gifs === 1 ? " animation GIF" : " animation GIFs");
			if (overlays && form.anim_export !== "layered") {
				text +=
					" with " +
					overlays +
					(overlays === 1 ? " overlay" : " overlays") +
					" on top of each";
			}
			parts.push(text);
		}
		if (anim_sheet) {
			parts.push(
				"an animation sheet of " +
					groups.length +
					(groups.length === 1 ? " animation" : " animations"),
			);
		}

		const total = per_size * sizes.length;
		let text =
			"**" +
			total +
			(total === 1 ? " file** at " : " files** at ") +
			sizes.map((size) => size.label).join(", ") +
			": " +
			parts.join(", ") +
			".";

		const largest = Math.max.apply(
			null,
			sizes.map((size) => Math.max(size.width, size.height)),
		);
		if ((gif_frames || anim_gifs || anim_sheet) && largest > 1024) {
			text +=
				" GIFs at " +
				largest +
				" pixels will be very large files and slow to write.";
		}

		// Sheets are never shrunk. Past the canvas ceiling the run stops, and a
		// very large animation sheet only earns a warning.
		const sheets = plannedSheets(form, sizes, groups.length);
		const blocked = sheets.find((sheet) => exceedsCanvas(sheet.dimensions));
		if (blocked) {
			text +=
				" **The " +
				blocked.label +
				" would be " +
				blocked.dimensions.width +
				" by " +
				blocked.dimensions.height +
				" at " +
				blocked.size.label +
				", which is more than Blockbench can draw, so the run will stop.**";
		} else {
			const heavy = sheets
				.filter((sheet) => sheet.animated)
				.find(
					(sheet) =>
						Math.max(sheet.dimensions.width, sheet.dimensions.height) > 4096,
				);
			if (heavy) {
				text +=
					" The animation sheet will be " +
					heavy.dimensions.width +
					" by " +
					heavy.dimensions.height +
					" at " +
					heavy.size.label +
					". This may freeze Blockbench.";
			}
		}
		return text;
	}

	function joinNames(names) {
		if (names.length <= 1) return names.join("");
		return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
	}

	function shortList(names) {
		if (names.length <= 3) return joinNames(names);
		return names.slice(0, 2).join(", ") + " and " + (names.length - 2) + " more";
	}

	// Spells out what the animation Export as choice will write, using the
	// animations actually ticked, so nobody has to guess what the options mean.
	function describeAnimationExport(form) {
		const mains = selectedAnimations(form.anim_main).map((a) => safeName(a.name));
		const overlays = overlayAnimations(form).map((a) => safeName(a.name));

		if (!mains.length && !overlays.length) {
			return "Tick at least one animation under Render these.";
		}
		if (!mains.length) {
			return (
				"Nothing is ticked under Render these, so " +
				joinNames(overlays) +
				" play together in one GIF."
			);
		}

		const count = mains.length;
		const on_top = overlays.length
			? ", with " + shortList(overlays) + " playing on top"
			: "";

		switch (form.anim_export) {
			case "layered": {
				const all = dedupeAnimations(
					selectedAnimations(form.anim_main).concat(overlayAnimations(form)),
				).map((a) => safeName(a.name));
				return all.length === 1
					? "Makes one GIF of " + all[0] + "."
					: "Makes one GIF where " +
							shortList(all) +
							" all play at the same time on the one model.";
			}
			case "sheet":
				return count === 1
					? "Makes one GIF with " + mains[0] + " in a single tile, named above" + on_top + "."
					: "Makes one GIF with " +
							shortList(mains) +
							" side by side, each named above" +
							(overlays.length ? on_top + " of each" : "") +
							".";
			case "both":
				return (
					"Makes " +
					(count === 1 ? "a GIF of " + mains[0] : "a separate GIF for each of " + shortList(mains)) +
					on_top +
					", plus one GIF with " +
					(count === 1 ? "it in a named tile." : "them side by side, each named above.")
				);
			case "separate":
			default:
				return count === 1
					? "Makes one GIF of " + mains[0] + on_top + "."
					: "Makes " +
							count +
							" GIFs, one for each of " +
							shortList(mains) +
							on_top +
							".";
		}
	}

	// Info lines are built once, so the only way to change their text later is
	// to reach into the element. Failures are ignored: the dialog still works.
	function setInfoText(dialog, key, text) {
		try {
			const node = dialog.form.form_data[key].bar.querySelector(".small_text");
			if (!node) return;
			node.innerHTML = typeof pureMarked === "function" ? pureMarked(text) : text;
		} catch (err) {
			// No live text for this line.
		}
	}

	function updateSummary(dialog, form) {
		setInfoText(dialog, "summary", describeRun(form));
		setInfoText(dialog, "anim_export_explain", describeAnimationExport(form));
	}

	// Settings saved by an older version may name sizes that are no longer
	// offered, which would leave the dialog with nothing selected.
	function storedSizePresets(stored) {
		const saved = stored.size_presets;
		if (saved && SIZE_PRESETS.some((preset) => saved[preset])) return saved;
		return { 512: true };
	}

	// The Combine dropdown was replaced by Export as. Carry a saved "layered"
	// choice across so nobody's setup silently changes.
	function storedAnimExport(stored) {
		if (stored.anim_export) return stored.anim_export;
		return stored.anim_mode === "layered" ? "layered" : "separate";
	}

	function buildDialog() {
		const stored = loadSettings();
		dialog_animations = listAnimations();
		const default_folder =
			stored.output_folder ||
			(Project && Project.export_path && path
				? path.dirname(Project.export_path)
				: "");

		const animation_options = {};
		const all_animations_on = {};
		const no_animations_on = {};
		dialog_animations.forEach((animation) => {
			animation_options[animation.uuid] = safeName(animation.name);
			all_animations_on[animation.uuid] = true;
			no_animations_on[animation.uuid] = false;
		});

		const form_fields = {
			stills_header: {
				type: "info",
				text: "**Still images.** One PNG per angle you tick. Sides, top and bottom, and isometric views can also be grouped into sheets, with each view's name above it.",
				full_width: true,
			},
			sides: {
				type: "checkbox",
				label: "Four sides",
				value: stored.sides ?? true,
			},
			top_bottom: {
				type: "checkbox",
				label: "Top and bottom",
				value: stored.top_bottom ?? false,
			},
			isometric: {
				type: "checkbox",
				label: "Isometric corners",
				value: stored.isometric ?? true,
			},
			stills_export: {
				type: "select",
				label: "Export as",
				value: stored.stills_export || "separate",
				options: {
					separate: "Separate images",
					sheets: "Sheets",
					both: "Both",
				},
				condition: (form) => form.sides || form.top_bottom || form.isometric,
			},
			sheet_six: {
				type: "select",
				label: "Sheet layout",
				value: stored.sheet_six || "separate",
				options: {
					separate: "Sides, top/bottom apart",
					combined: "All six together",
				},
				condition: (form) =>
					form.sides && form.top_bottom && form.stills_export !== "separate",
			},
			current_view: {
				type: "checkbox",
				label: "Current view",
				value: stored.current_view ?? false,
			},
			turntable: {
				type: "number",
				label: "Views around model",
				value: stored.turntable || 8,
				min: 2,
				max: 64,
				step: 1,
				toggle_enabled: true,
				toggle_default: !!stored.turntable,
				description: "8 gives one view every 45 degrees.",
			},
			turntable_pitch: {
				type: "number",
				label: "Camera height",
				value: stored.turntable_pitch ?? 30,
				min: -89,
				max: 89,
				condition: (form) => !!form.turntable,
			},
			_1: "_",
			gif_header: {
				type: "info",
				text: "**Turntable GIF.** One full spin, looping. Camera height is in degrees, where 0 is level with the model and 90 is directly above it.",
				full_width: true,
			},
			gif: {
				type: "checkbox",
				label: "Make a turntable GIF",
				value: stored.gif ?? false,
			},
			gif_seconds: {
				type: "number",
				label: "Seconds per spin",
				value: stored.gif_seconds ?? 3,
				min: 0.2,
				max: 30,
				step: 0.5,
				condition: (form) => form.gif,
			},
			gif_smoothness: {
				type: "select",
				label: "Smoothness",
				value: String(stored.gif_smoothness || 20),
				options: SMOOTHNESS_OPTIONS,
				condition: (form) => form.gif,
			},
			gif_pitch: {
				type: "number",
				label: "Camera height",
				value: stored.gif_pitch ?? 30,
				min: -89,
				max: 89,
				condition: (form) => form.gif,
			},
			gif_animations: {
				type: "inline_multi_select",
				label: "Play while spinning",
				value: no_animations_on,
				options: animation_options,
				full_width: true,
				condition: (form) => form.gif && dialog_animations.length > 0,
			},
			gif_sync: {
				type: "buttons",
				label: "",
				buttons: ["Match spin to animation length"],
				full_width: true,
				condition: (form) => form.gif && dialog_animations.length > 0,
				click() {
					const chosen = selectedAnimations(
						Dialog.open.getFormResult().gif_animations,
					);
					if (!chosen.length) return;
					Dialog.open.setFormValues({
						gif_seconds: Math.round(longestLength(chosen) * 10) / 10,
					});
				},
			},
			_2: "_",
			animations_header: {
				type: "info",
				text: "**Animation GIFs.** One looping GIF per animation, each as long as the animation itself. Anything set to layer on top plays at the same time as every one of them. A sheet puts them side by side in one GIF, each named above.",
				full_width: true,
				condition: () => dialog_animations.length > 0,
			},
			animations_empty: {
				type: "info",
				text: "**Animation GIFs.** This model has no animations loaded, so there is nothing to render here. Import its animation file in Blockbench, or load it with the System Template File Loader, then open this dialog again.",
				full_width: true,
				condition: () => dialog_animations.length === 0,
			},
			animations: {
				type: "checkbox",
				label: "Make animation GIFs",
				value: stored.animations ?? false,
				condition: () => dialog_animations.length > 0,
			},
			anim_main: {
				type: "inline_multi_select",
				label: "Render these",
				value: all_animations_on,
				options: animation_options,
				full_width: true,
				condition: (form) => animationsEnabled(form),
			},
			anim_overlay: {
				type: "inline_multi_select",
				label: "Layer on top",
				value: no_animations_on,
				options: animation_options,
				full_width: true,
				condition: (form) => animationsEnabled(form),
			},
			anim_export: {
				type: "select",
				label: "Export as",
				value: storedAnimExport(stored),
				options: {
					separate: "Separate GIFs",
					layered: "One GIF, played together",
					sheet: "One sheet, side by side",
					both: "Separate GIFs and a sheet",
				},
				condition: (form) => animationsEnabled(form),
			},
			anim_export_explain: {
				type: "info",
				text: "",
				full_width: true,
				condition: (form) => animationsEnabled(form),
			},
			anim_smoothness: {
				type: "select",
				label: "Smoothness",
				value: String(stored.anim_smoothness || 20),
				options: SMOOTHNESS_OPTIONS,
				condition: (form) => animationsEnabled(form),
			},
			anim_angle: {
				type: "select",
				label: "Camera angle",
				value: stored.anim_angle || "iso_front_right",
				options: CAMERA_OPTIONS,
				condition: (form) => animationsEnabled(form),
			},
			_3: "_",
			size_header: {
				type: "info",
				text: "**Image size.** Everything above is written once per size.",
				full_width: true,
			},
			size_presets: {
				type: "inline_multi_select",
				label: "Size",
				value: storedSizePresets(stored),
				full_width: true,
				options: {
					512: "512",
					1024: "1024",
					2048: "2048",
					4096: "4096 (4K)",
				},
			},
			sizes_extra: {
				type: "text",
				label: "Custom sizes",
				value: stored.sizes_extra || "",
				placeholder: "256, 320x180",
				description: "Comma separated. Square unless you write 320x180.",
			},
			supersample: {
				type: "checkbox",
				label: "Smooth edges",
				value: stored.supersample ?? false,
				description: "Leave off for crisp pixel art.",
			},
			sheet_labels: {
				type: "checkbox",
				label: "Sheet labels",
				value: stored.sheet_labels ?? true,
				condition: (form) =>
					(stillsToSheets(form) &&
						(form.sides || form.top_bottom || form.isometric)) ||
					(animationsEnabled(form) && animationsToSheet(form)),
				description: "The view or animation name above each tile.",
			},
			shading: {
				type: "checkbox",
				label: "Shading",
				value: stored.shading ?? settings.shading.value,
			},
			reference: {
				type: "checkbox",
				label: "Player for scale",
				value: stored.reference ?? false,
				description:
					"A half transparent player-sized figure standing to one side. It never changes how the model itself is scaled.",
			},
			background: {
				type: "color",
				label: "Background",
				value: stored.background || "#ffffff",
				toggle_enabled: true,
				toggle_default: !!stored.background,
				description: "Off means a see-through background.",
			},
			_4: "_",
			fit: {
				type: "checkbox",
				label: "Fit to frame",
				value: stored.fit ?? true,
				description: "One scale for every angle and every pose in the run.",
			},
			padding: {
				type: "number",
				label: "Padding %",
				value: stored.padding ?? 5,
				min: 0,
				max: 45,
				condition: (form) => form.fit,
			},
			frame_height: {
				type: "number",
				label: "Frame height",
				value: stored.frame_height ?? 32,
				min: 1,
				max: 2000,
				condition: (form) => !form.fit,
				description: "In model units. 16 is one block.",
			},
			_5: "_",
			output_folder: {
				type: "folder",
				label: "Save into",
				value: default_folder,
			},
			prefix: {
				type: "text",
				label: "File prefix",
				value: (Project && Project.name) || "model",
			},
			summary: {
				type: "info",
				text: "Nothing selected yet.",
				full_width: true,
			},
		};

		// The tick-all buttons sit directly under the list they act on, which the
		// static field list cannot express, so the form is assembled here.
		const form = {};
		Object.keys(form_fields).forEach((key) => {
			form[key] = form_fields[key];
			if (key !== "anim_main" || dialog_animations.length < 2) return;
			form.anim_main_all = {
				type: "buttons",
				label: "",
				buttons: ["Render all", "Render none"],
				full_width: true,
				condition: (data) => animationsEnabled(data),
				click(index) {
					Dialog.open.setFormValues({
						anim_main: index === 0 ? all_animations_on : no_animations_on,
					});
				},
			};
		});

		return new Dialog({
			id: "render_model",
			title: "Render Model",
			width: 620,
			form,
			onFormChange(form_result) {
				updateSummary(this, form_result);
			},
			onConfirm(form_result) {
				saveSettings(form_result);
				this.hide();
				runRender(form_result).catch((err) => {
					Blockbench.setProgress();
					Blockbench.setStatusBarText();
					console.error(err);
					Blockbench.notification("Model Render", "Failed: " + err.message);
				});
			},
			onCancel() {
				this.hide();
			},
		});
	}

	// ----- main -----
	Plugin.register(PLUGIN_ID, {
		title: "Render Model",
		author: "Shapescape",
		description:
			"Renders the open model from preset camera angles at one or more resolutions, with an optional turntable GIF.",
		icon: "photo_camera",
		version: "2.2.0",
		min_version: "5.0.0",
		variant: "desktop",
		onload() {
			render_action = new Action({
				id: "render_model_dialog",
				name: "Render Model...",
				icon: "photo_camera",
				category: "view",
				condition: () => !!Project,
				click() {
					const dialog = buildDialog();
					dialog.show();
					// Seed the summary so it is right before the first edit.
					updateSummary(dialog, dialog.getFormResult());
				},
			});
			MenuBar.addAction(render_action, "view");
		},
		onunload() {
			render_action.delete();
		},
		onuninstall() {
			render_action.delete();
		},
	});
})();
