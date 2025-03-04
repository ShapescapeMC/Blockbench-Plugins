"use strict";
(function () {
	class Config {
		constructor() {
			this.export_path;
			this.width;
			this.height;

			this.home = require("os").homedir();
			this.path_config_folder = this.home + "//.batch";
			console.log(this.path_config_folder);
			this.path_jobs_folder = this.path_config_folder + "//jobs";
			this.path_config_file = this.path_config_folder + "//cfg.json";
		}
		setFromFormData(formData) {
			this.export_path = formData.export_path;
			this.width = formData.width;
			this.height = formData.height;
		}
		load() {
			if (!fs.existsSync(this.path_config_folder)) {
				fs.mkdirSync(this.path_config_folder);
			}

			if (!fs.existsSync(this.path_jobs_folder)) {
				fs.mkdirSync(this.path_jobs_folder);
			}

			if (!fs.existsSync(this.path_config_file)) {
				var cfg_default = {
					export_path: this.home + "//.batch//export",
					width: 64,
					height: 64,
				};

				var json = JSON.stringify(cfg_default);
				fs.writeFileSync(this.path_config_file, json);

				this.export_path = this.home + "//.batch//export";
				if (!fs.existsSync(this.export_path)) {
					fs.mkdirSync(this.export_path);
				}

				this.width = 64;
				this.height = 64;
			} else {
				var d = JSON.parse(fs.readFileSync(this.path_config_file, "utf8"));
				this.export_path = d.export_path;
				this.width = d.width;
				this.height = d.height;
			}
		}
		write() {
			var json = JSON.stringify({
				export_path: this.export_path,
				width: this.width,
				height: this.height,
			});
			fs.writeFileSync(this.path_config_file, json);
		}
	}

	class JobData {
		constructor() {
			this.name;
			this.model;
			this.position;
			this.target;
			this.zoom;
			this.ortho;
			this.static = [];
			this.layers = [];
			this.texLay0 = [];
			this.texLay1 = [];
			this.texLay2 = [];
			this.textureDef;
			this.MAX = 1;
			this.CURRENT_JOB = 0;
			this.loaded = false;
		}
		fromFormData(formData) {
			this.name = formData.name;
			this.model = formData.model;
			this.static = [];
			this.layers = [];

			if (typeof formData.static0 !== "underfined" && formData.static0 !== "") {
				this.static.push(formData.static0);
			}
			if (typeof formData.static1 !== "underfined" && formData.static0 !== "") {
				this.static.push(formData.static1);
			}
			if (typeof formData.static2 !== "underfined" && formData.static0 !== "") {
				this.static.push(formData.static2);
			}

			if (typeof formData.layer0 !== "underfined" && formData.layer0 !== "") {
				this.layers.push(formData.layer0);
			}
			if (typeof formData.layer1 !== "underfined" && formData.layer1 !== "") {
				this.layers.push(formData.layer1);
			}
			if (typeof formData.layer2 !== "underfined" && formData.layer2 !== "") {
				this.layers.push(formData.layer2);
			}

			if (formData.useCameraPos == true) {
				debugger;
				this.position = Preview.selected.camera.position.toArray();
				this.target = Preview.selected.controls.target.toArray();
				this.zoom = Preview.selected.camera.zoom;
				this.ortho = Preview.selected.isOrtho;
			}
		}
		saveCameraData() {
			this.position = Preview.selected.camera.position.toArray();
			this.target = Preview.selected.controls.target.toArray();
			this.zoom = Preview.selected.camera.zoom;
			this.ortho = Preview.selected.isOrtho;
		}
		write(location) {
			var json = JSON.stringify({
				name: this.name,
				model: this.model,
				static: this.static,
				layers: this.layers,
				position: this.position === null ? undefined : this.position,
				target: this.target === null ? undefined : this.target,
				zoom: this.zoom == null ? undefined : this.zoom,
				ortho: this.ortho == null ? undefined : this.ortho,
			});
			fs.writeFileSync(location + "//" + this.name + ".json", json);
		}
		load(json) {
			this.name = json.name;
			this.model = json.model;
			this.static = json.static;
			this.layers = json.layers;
			this.cameraPosition = json.position;
			this.target = json.target;
			this.zoom = json.zoom;
			this.ortho = json.ortho;
		}
		generateLayers() {
			// this should be better :D
			this.textureDef = new Array(3);
			var t_static = [...this.static];
			var t_layers = [...this.layers];
			for (var i = 0; i < this.textureDef.length; i++) {
				this.textureDef[i] = new Array();

				// populate textureDef[i]
				if (t_static[0] != null) {
					this.textureDef[i].push(t_static[0]);
					t_static.shift();
					continue;
				}

				if (t_layers[0] != null) {
					let files = fs.readdirSync(t_layers[0]);
					for (var c = 0; c < files.length; c++) {
						if (files[c].endsWith(".png")) {
							this.textureDef[i].push(path.join(t_layers[0], files[c]));
						}
					}
					t_layers.shift();
					continue;
				}
			}

			// calculate max number of itterations
			this.calculateLayers();
		}
		calculateLayers() {
			for (var i = 0; i < this.textureDef.length; i++) {
				if (this.textureDef[i].length != 0) {
					this.MAX *= this.textureDef[i].length;
				}
			}
		}
		getIndex(value) {
			let beep = new Array(this.textureDef.length);
			let boop = 0;

			for (let j = this.textureDef.length; j > 0; j--) {
				if (j === 1) {
					beep[j - 1] = value % this.textureDef[j - 1].length;
					break;
				}
				boop = this.getFloor(j - 1);
				beep[j - 1] = Math.floor(value / boop);
				if (value - beep[j - 1] * boop >= 0) {
					value -= beep[j - 1] * boop;
				}
			}
			return beep;
		}
		getFloor(value) {
			if (value === 0) {
				return this.textureDef[0].length;
			}
			let floor = 1;
			for (let i = 0; i < value; i++) {
				floor *= this.textureDef[i].length;
			}
			return floor;
		}
		getOutputName() {
			let name = [];
			name.push("spawn_egg_" + this.name);
			let index = this.getIndex(this.CURRENT_JOB);

			for (let i = 0; i < index.length; i++) {
				if (this.textureDef[i].length > 1) {
					let nm = path.basename(this.textureDef[i][index[i]], ".png");
					name.push("_" + nm);
				}
			}
			return name.join("");
		}
		loadNextJob() {
			if (this.CURRENT_JOB < this.MAX) {
				let vals = this.getIndex(this.CURRENT_JOB);
				// loop over vals to load the correct textures

				// need to remove this load if the current job has already loaded it, causing issues.

				if (this.loaded == false) {
					let options = {
						readtype: "text",
					};
					let model = null;
					Blockbench.read(this.model, options, function (files) {
						model = files;
					});

					loadModelFile(model[0]);
					this.loaded = true;
				}

				for (let i = 0; i < vals.length; i++) {
					debugger;
					let t = this.textureDef[i];
					if (t[0] != null) {
						loadedTextures[i] = new Texture()
							.fromPath(this.textureDef[i][vals[i]])
							.add(false)
							.fillParticle();
					}
				}
				loadedTextures[0].render_mode = "layered";
				Canvas.updateLayeredTextures();

				return true;
			} else {
				return false;
			}
		}
	}

	const path = require("path");
	const fs = require("fs");

	// defaults
	var config;
	var testData;
	var batch_config_action;
	var batch_register_job;
	var batch_process_jobs;
	var batch_simple_mass_register_job;

	// list of job data
	var job_data = [];
	var jobCount;
	var textureCount;
	var currentJob;

	var outputMap;
	var loadedTextures = new Array(3);
	var preview;

	var tex4;
	var tex5;
	var cntr = 0;

	var cameraPosition = [];

	function setCenter() {
		let center = new THREE.Vector3().fromArray(getSelectionCenter());
		center.add(scene.position);
		let difference = new THREE.Vector3()
			.copy(preview.controls.target)
			.sub(center);
		difference.divideScalar(1);

		let i = 0;
		let interval = setInterval(() => {
			preview.controls.target.sub(difference);

			if (preview.angle != null) {
				preview.camera.position.sub(difference);
			}
			i++;
			if (i == 1) clearInterval(interval);
		}, 16.66);
	}

	function setupDefaultConfig() {
		debugger;
		console.log("beep");

		config = new Config();
		config.load();
	}

	function executeJobs() {
		jobCount = 0;
		outputMap = new Map();
		currentJob = job_data[0];
		runJob();
	}

	function runJob() {
		if (jobCount < job_data.length) {
			let done = currentJob.loadNextJob();
			if (done == false) {
				// exported everything!
				if (jobCount + 1 == job_data.length) {
					for (let [key, value] of outputMap) {
						fs.writeFileSync(
							config.export_path + "//" + key + ".png",
							value,
							{ encoding: "base64" },
							function (err) {
								console.log("Exported " + key);
							},
						);
					}
					job_data = [];
					Blockbench.notification(
						"Batch Export",
						"Finished exporting " + outputMap.size + " jobs.",
					);
				} else {
					jobCount++;
					currentJob = job_data[jobCount];
					done = currentJob.loadNextJob();
				}
			}

			if (done == true) {
				setTimeout(() => {
					captureScreenshot();
				}, 200);
			}
		}
	}

	function captureScreenshot() {
		if (typeof currentJob.cameraPosition !== "undefined") {
			var preset = {
				name: currentJob.name,
				id: currentJob.name + "_id",
				projection: currentJob.ortho == true ? "orthographic" : "perspective",
				position: currentJob.cameraPosition,
				target: currentJob.target,
				zoom: currentJob.zoom,
			};

			Preview.selected.loadAnglePreset(preset);
		} else {
			setCenter();
		}

		Canvas.updateLayeredTextures();

		var options = {
			crop: false,
			width: config.width,
			height: config.height,
		};

		var name = currentJob.getOutputName();
		preview.screenshot(options, function (img) {
			var base64Image = img.split(";base64,").pop();
			outputMap.set(name, base64Image);
			console.log("Exported " + name);
		});

		currentJob.CURRENT_JOB++;

		setTimeout(() => {
			clean();
		}, 100);
	}

	function clean() {
		// unload last textures
		for (let i = 0; i < loadedTextures.length; i++) {
			// kinda hacky
			if (typeof loadedTextures[i] === "undefined") {
			} else {
				loadedTextures[i].remove(true);
			}
		}

		debugger;

		setTimeout(() => {
			runJob();
		}, 100);
	}

	// Mass matching
	function matchSimpleFiles(formData) {
		let geos = fs.readdirSync(formData.geo);
		let textures = fs.readdirSync(formData.textures);
		let counter = 0;

		for (let i = 0; i < geos.length; i++) {
			let geo = geos[i];
			let geoName = path.basename(geo, ".geo.json");
			let tex;
			let texName;

			for (let j = 0; j < textures.length; j++) {
				tex = textures[j];
				texName = path.basename(tex, ".png");

				if (geoName === texName) {
					let jb = new JobData();
					jb.name = geoName;
					jb.model = path.join(formData.geo, geo);
					jb.static.push(path.join(formData.textures, tex));
					jb.generateLayers();

					// save camera locations
					if (formData.useCameraPos) {
						jb.saveCameraData();
					}

					jb.write(config.path_jobs_folder);

					job_data.push(jb);
					counter++;
					break;
				}
			}
		}

		Blockbench.notification(
			"Simple Mass Register",
			"Found and matched " + counter + " entities.",
		);
	}

	// ----- dialogs -----
	function loadRunJobsDialog() {
		let vals = fs.readdirSync(config.path_jobs_folder);
		preview = Preview.selected;

		for (let i = 0; i < vals.length; i++) {
			let data = JSON.parse(
				fs.readFileSync(path.join(config.path_jobs_folder, vals[i]), "utf8"),
			);
			let obj = new JobData();
			obj.load(data);
			obj.generateLayers();

			job_data.push(obj);
		}
		var dialog = new Dialog({
			id: "batch_screenshot_process_jobs",
			title: "Batch Process Jobs",
			form: {
				number: {
					lable: "Count",
					type: "number",
					value: vals.length,
				},
			},
			onConfirm: function (formData) {
				// full load, and process
				// execute job
				executeJobs();
			},
			onCancel: function (formData) {
				job_data = [];
				this.hide();
			},
		});
		return dialog;
	}

	function loadConfigDialog() {
		var dialog = new Dialog({
			id: "batch_screenshot_config",
			title: "Batch Screenshot Config",
			form: {
				export_path: {
					lable: "Export Path",
					type: "folder",
					value: config.export_path,
				},
				width: {
					lable: "Width",
					type: "number",
					value: config.width,
				},
				height: {
					lable: "Height",
					type: "number",
					value: config.height,
				},
			},
			onConfirm: function (formData) {
				config.setFromFormData(formData);
				config.write();
				this.hide();
			},
			onCancel: function (formData) {
				this.hide();
			},
		});
		return dialog;
	}

	function loadRegisterJobDialog() {
		var dialog = new Dialog({
			id: "batch_screenshot_register_job",
			title: "Register Job",
			form: {
				name: {
					label: "Name",
					type: "text",
				},
				model: {
					label: "Model",
					type: "file",
					extensions: ["json"],
				},
				useCameraPos: {
					label: "Use Camera Position",
					type: "checkbox",
					value: false,
				},
				static0: {
					label: "Static Layer 1",
					type: "file",
					extensions: ["png"],
				},
				static1: {
					label: "Static Layer 2",
					type: "file",
					extensions: ["png"],
				},
				static2: {
					label: "Static Layer 3",
					type: "file",
					extensions: ["png"],
				},
				layer0: {
					label: "Layer 1",
					type: "folder",
				},
				layer1: {
					label: "Layer 2",
					type: "folder",
				},
				layer2: {
					label: "Layer 3",
					type: "folder",
				},
			},
			onConfirm: function (formData) {
				debugger;
				var job = new JobData();
				job.fromFormData(formData);
				job.write(config.path_jobs_folder);
				this.hide();
			},
			onCancel: function (formData) {
				this.hide();
			},
		});
		return dialog;
	}

	function loadSimpleMassRegisterDialog() {
		var dialog = new Dialog({
			id: "batch_simple_mass_register_job",
			title: "Simple Mass Register",
			lines: [
				"<p>Matches geo file names to a single texture by <b>File name</b></p>",
			],
			form: {
				geo: {
					label: "Geo Folder",
					type: "folder",
				},
				textures: {
					label: "Texture Folder",
					type: "folder",
				},
				useCameraPos: {
					label: "Use Camera Position",
					type: "checkbox",
					value: false,
				},
			},
			onConfirm: function (formData) {
				matchSimpleFiles(formData);
				this.hide();
			},
			onCancel: function (formData) {
				this.hide();
			},
		});
		return dialog;
	}

	// ----- MAIN ----
	Plugin.register("batch_screenshots", {
		title: "Batch Screenshot",
		author: "Shapescape",
		description:
			"Creates screenshots of a batch of models based on a set of rules.",
		icon: "camera_enhance",
		version: "1.0.0",
		variant: "desktop",
		onload() {
			setupDefaultConfig();

			batch_config_action = new Action({
				id: "batch_screenshot_config",
				name: "Batch: config",
				icon: "settings",
				category: "filter",
				click: function (ev) {
					loadConfigDialog().show();
				},
			});

			batch_register_job = new Action({
				id: "batch_screenshot_register_job",
				name: "Batch: Register job",
				icon: "add",
				category: "filter",
				click: function (ev) {
					loadRegisterJobDialog().show();
				},
			});

			batch_process_jobs = new Action({
				id: "batch_screenshot_process_jobs",
				name: "Batch: Process jobs",
				icon: "bar_chart",
				category: "filter",
				click: function (ev) {
					loadRunJobsDialog().show();
				},
			});

			batch_simple_mass_register_job = new Action({
				id: "batch_simple_mass_register_job",
				name: "Batch: Simple Mass Register",
				icon: "add",
				category: "filter",
				click: function (ev) {
					loadSimpleMassRegisterDialog().show();
				},
			});

			MenuBar.addAction(batch_config_action, "filter");
			MenuBar.addAction(batch_register_job, "filter");
			MenuBar.addAction(batch_process_jobs, "filter");
			MenuBar.addAction(batch_simple_mass_register_job, "filter");
		},
		onunload() {
			batch_config_action.delete();
			batch_register_job.delete();
			batch_process_jobs.delete();
			batch_simple_mass_register_job.delete();
		},
		onuninstall() {
			batch_config_action.delete();
			batch_register_job.delete();
			batch_process_jobs.delete();
			batch_simple_mass_register_job.delete();
		},
	});
})();
