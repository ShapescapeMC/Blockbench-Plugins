/**
 * Block Grid Modeler — Blockbench plugin (Shapescape)
 *
 * A modelling tool for models built from whole blocks. Point at a face of
 * the model and click: in Add mode a new cube is placed against that face,
 * in Cut out mode a cube is placed just inside it, inflated a little so it
 * marks the part to cut away. New cubes always sit on the model's block
 * grid, at the size picked in the tool bar (4 to 64 units, 16 being one
 * block), and are named in capitals after what they do (ADD, CUTOUT), so
 * a build script can find them.
 */
(function () {
	'use strict';

	const DEFAULTS = {
		mode: 'add',          // 'add' or 'cutout'
		size: 16,             // cube size in model units, 16 = one block
		add_name: 'ADD',      // name given to cubes made in Add mode
		cutout_name: 'CUTOUT', // name given to cubes made in Cut out mode
		cutout_inflate: 0.025 // how much cut-out cubes are inflated
	};
	const STORAGE_KEY = 'block_grid_modeler_settings';
	const SIZES = [4, 8, 16, 32, 64];
	const ADD_COLOR = '#3ddc84';
	const CUTOUT_COLOR = '#d7263d';

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
	 * The grid cell to fill for a click at model point `point` on a face
	 * facing `normal`: the cell just outside the face for 'add', just inside
	 * it for 'cutout'. Cells are `size` units wide, on the block grid.
	 * Returns { from, to }.
	 */
	function targetCell(point, normal, size, mode, centred) {
		const off = gridOffset(centred);
		const side = mode === 'cutout' ? -1 : 1;
		const from = [0, 0, 0], to = [0, 0, 0];
		for (let a = 0; a < 3; a++) {
			// step half a cell off the face, so the point lands inside the wanted cell
			const q = point[a] + normal[a] * side * size / 2;
			from[a] = Math.floor((q - off[a]) / size + 1e-9) * size + off[a];
			to[a] = from[a] + size;
		}
		return { from, to };
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { targetCell, gridOffset, FACE_NORMALS, DEFAULTS };
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

	let tool, modeSelect, sizeSelect, toolbar, settingsAction, styleNode;
	let preview = null, previewMaterials = null;

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
		return targetCell(hit.point, hit.normal, Number(settings.size) || 16, settings.mode, centred);
	}

	/* --- hover preview --- */

	function clearPreview() {
		if (!preview) return;
		if (preview.parent) preview.parent.remove(preview);
		preview.geometry.dispose();
		preview = null;
	}

	/** Shows a wire box where the next cube would go, in the space of the cube being pointed at. */
	function showPreview(hit) {
		clearPreview();
		if (!hit) return;
		const cell = cellFor(hit);
		if (!previewMaterials) {
			previewMaterials = {
				add: new THREE.LineBasicMaterial({ color: ADD_COLOR, depthTest: false, transparent: true }),
				cutout: new THREE.LineBasicMaterial({ color: CUTOUT_COLOR, depthTest: false, transparent: true })
			};
		}
		const grow = settings.mode === 'cutout' ? Number(settings.cutout_inflate) || 0 : 0;
		const size = [0, 1, 2].map(a => cell.to[a] - cell.from[a] + grow * 2);
		const box = new THREE.BoxGeometry(size[0], size[1], size[2]);
		preview = new THREE.LineSegments(new THREE.EdgesGeometry(box), previewMaterials[settings.mode === 'cutout' ? 'cutout' : 'add']);
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

	function placeCube(hit) {
		const cell = cellFor(hit);
		const cutout = settings.mode === 'cutout';
		const name = String((cutout ? settings.cutout_name : settings.add_name) || (cutout ? 'CUTOUT' : 'ADD')).toUpperCase();
		if (sameCubeExists(name, cell.from, cell.to)) {
			Blockbench.showQuickMessage(`A ${name} cube is already there`);
			return;
		}
		const source = hit.cube;
		const parent = source.parent instanceof Group ? source.parent : null;

		Undo.initEdit({ outliner: true, elements: [], selection: true });
		const cube = new Cube({
			name,
			from: cell.from.slice(),
			to: cell.to.slice(),
			// keep the pivot of the cube it was placed against, so it moves with the same bone
			origin: source.origin.slice(),
			inflate: cutout ? Number(settings.cutout_inflate) || 0 : 0,
			box_uv: source.box_uv,
			autouv: source.autouv
		}).init();
		if (parent) {
			cube.addTo(parent);
			cube.scope = parent.scope;
		}
		// same texture as the face clicked on, on every face
		const texture = source.faces[hit.face] && source.faces[hit.face].texture;
		for (const key in cube.faces) {
			if (texture !== undefined) cube.faces[key].texture = texture;
		}
		if (!cube.box_uv) cube.mapAutoUV();

		unselectAllElements();
		cube.select();
		Canvas.updateView({ elements: [cube], element_aspects: { transform: true, geometry: true, faces: true }, selection: true });
		Undo.finishEdit(cutout ? 'Add cut-out cube' : 'Add block cube', { outliner: true, elements: [cube], selection: true });
		Blockbench.dispatchEvent('add_cube', { object: cube });
	}

	/* --- settings --- */

	function openSettings() {
		new Dialog({
			id: 'block_grid_modeler_settings',
			title: 'Block Grid Modeler',
			width: 400,
			form: {
				add_name: { label: 'Name for added cubes', type: 'text', value: settings.add_name },
				cutout_name: { label: 'Name for cut-out cubes', type: 'text', value: settings.cutout_name },
				cutout_inflate: { label: 'Cut-out inflate', type: 'number', value: settings.cutout_inflate, step: 0.005, min: 0, max: 1 },
				_info: { type: 'info', text: 'Names are always written in capitals. Change them to whatever your build script looks for.' }
			},
			onConfirm(result) {
				settings.add_name = String(result.add_name || DEFAULTS.add_name).toUpperCase();
				settings.cutout_name = String(result.cutout_name || DEFAULTS.cutout_name).toUpperCase();
				settings.cutout_inflate = Math.max(0, Number(result.cutout_inflate) || 0);
				saveSettings();
			}
		}).show();
	}

	Plugin.register('block_grid_modeler', {
		title: 'Block Grid Modeler',
		author: 'Shapescape',
		description: 'Add and cut out cubes on the model\'s block grid with a click, named for your build script.',
		icon: 'view_in_ar',
		version: '0.1.0',
		min_version: '5.0.0',
		variant: 'both',
		onload() {
			styleNode = Blockbench.addCSS(`
				[toolbar_item="block_grid_cube"] .icon, [menu_item="block_grid_cube"] > .icon,
				[menu_item="block_grid_modeler_settings"] > .icon { color: ${CUTOUT_COLOR} !important; }
			`);

			modeSelect = new BarSelect('block_grid_cube_mode', {
				name: 'Mode',
				value: settings.mode,
				options: {
					add: { name: 'Add', icon: 'add_box' },
					cutout: { name: 'Cut out', icon: 'indeterminate_check_box' }
				},
				onChange() {
					settings.mode = this.value;
					saveSettings();
					clearPreview();
				}
			});
			sizeSelect = new BarSelect('block_grid_cube_size', {
				name: 'Cube size',
				value: String(settings.size),
				options: Object.fromEntries(SIZES.map(s => [String(s), s === 16 ? '16 (1 block)' : `${s}`])),
				onChange() {
					settings.size = Number(this.value) || 16;
					saveSettings();
					clearPreview();
				}
			});
			toolbar = new Toolbar('block_grid_cube', {
				children: ['block_grid_cube_mode', 'block_grid_cube_size']
			});

			tool = new Tool('block_grid_cube', {
				name: 'Block Grid Cube',
				description: 'Click a face to add a cube on the block grid, or to cut one out',
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
					showPreview(hitOnCube(data));
				},
				onCanvasClick(data) {
					const hit = hitOnCube(data);
					if (hit) placeCube(hit);
				},
				onSelect() {
					// the bar keeps the last choice even if the tool was set elsewhere
					modeSelect.set(settings.mode);
					sizeSelect.set(String(settings.size));
				},
				onUnselect() {
					clearPreview();
				}
			});
			try { Toolbox.add(tool); } catch (e) {}

			settingsAction = new Action('block_grid_modeler_settings', {
				name: 'Block Grid Modeler Settings',
				icon: 'tune',
				click: openSettings
			});
			MenuBar.addAction(settingsAction, 'tools');
		},
		onunload() {
			clearPreview();
			if (previewMaterials) { previewMaterials.add.dispose(); previewMaterials.cutout.dispose(); }
			if (tool) tool.delete();
			if (toolbar && toolbar.node) toolbar.node.remove();
			if (typeof Toolbars !== 'undefined') delete Toolbars.block_grid_cube;
			if (modeSelect) modeSelect.delete();
			if (sizeSelect) sizeSelect.delete();
			if (settingsAction) settingsAction.delete();
			if (styleNode && styleNode.delete) styleNode.delete();
		}
	});
})();
