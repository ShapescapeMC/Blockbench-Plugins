//import * as blockbenchTypes from "blockbench-types";
(function () {
	var import_button;

	// Import required modules
	const path = require("path");
	const fs = require("fs");

	// Get the directory path of the current project
	function getDirectoryPath() {
		return path.dirname(Project.export_path);
	}

	// Scan the specified directory and its subdirectories for animation and PNG files
	function scanDirectory(directoryPath) {
		const animationFiles = [];
		const pngFiles = [];

		// Function to find the nearest _scope.json in the directory and its parent directories
		function findScopeFile(dir) {
			const scopeFilePath = path.join(dir, "_scope.json");
			if (fs.existsSync(scopeFilePath)) {
				return dir;
			} else if (path.basename(dir) == "_shared") {
				return dir;
			} else {
				const parentDir = path.dirname(dir);

				if (parentDir !== dir) {
					return findScopeFile(parentDir);
				} else {
					// Reached the root directory without finding _scope.json
					return null;
				}
			}
		}

		// Find the directory with _scope.json
		const startDir = findScopeFile(directoryPath);

		if (startDir) {
			if (path.basename(startDir) != "_shared") {
				// Start scanning from the directory with _scope.json
				scanFilesInDirAndChildren(startDir);
				if (path.dirname(startDir) != "system_template") {
					fs.access(
						path.join(path.dirname(startDir) + "/_shared"),
						fs.constants.F_OK,
						(err) => {
							if (err) {
								console.log("[SYSTEM AUTOLOAD] System has no _shared folder.");
								return;
							}

							scanFilesInDirAndChildren();
						},
					);
				}
			} else {
				// Start scanning from the directory with _scope.json
				scanFilesInDirAndChildren(startDir);
			}
		} else {
			console.log(
				"File is not in a _shared folder and the _scope.json file was not found in the current or parent directories.",
			);
		}

		// Recursively scan files in a directory
		function scanFilesInDirAndChildren(dir) {
			const files = fs.readdirSync(dir);

			for (const file of files) {
				const filePath = path.join(dir, file);
				const stat = fs.statSync(filePath);

				if (stat.isDirectory()) {
					// Recursively scan subdirectories
					scanFilesInDirAndChildren(filePath);
				} else {
					// Check the file ending and add to the appropriate list
					if (file.endsWith("animation.json")) {
						animationFiles.push(filePath);
					} else if (file.endsWith(".png")) {
						pngFiles.push(filePath);
					} else if (file.endsWith(".tga")) {
						pngFiles.push(filePath);
					}
				}
			}
		}

		// Return the collected animation and PNG files
		return {
			animationFiles,
			pngFiles,
		};
	}

	// Import a texture from the specified path and handle the loading callback
	function importTextureFromPath(path) {
		console.log("[SYSTEM AUTOLOAD] Loading Texture from: \n", path);
		new Texture().fromPath(path).add(false); // Create a new Texture object from the specified path

		Canvas.updateLayeredTextures();
	}

	function getAnimationsFromFile(filePath) {
		try {
			// Read the JSON file
			const data = fs.readFileSync(filePath);

			// Parse JSON data
			const jsonData = JSON.parse(data);

			// Check if animations property exists
			if (jsonData.hasOwnProperty("animations")) {
				// Return the names of objects in animations
				return Object.keys(jsonData.animations);
			} else {
				console.log("No 'animations' property found in the JSON file.");
				return [];
			}
		} catch (error) {
			console.error("Error reading JSON file:", error);
			return [];
		}
	}

	function importAnimationFromPath(animation_path) {
		console.log("[SYSTEM AUTOLOAD] Loading Animation from: \n", animation_path);
		// getting a list of the current animations loaded
		let currentAnimations = [];
		for (let i = 1; i <= Project.animations.length; i++) {
			currentAnimations.push(Project.animations[i - 1]["name"]);
		}

		// getting a list of all the animations in the new file to load
		let newAnimations = getAnimationsFromFile(animation_path);

		// create a list with animations that I do want to import
		let animationsToImport = newAnimations.filter(
			(item) => !currentAnimations.includes(item),
		);

		Blockbench.read(animation_path, { readtype: "text" }, function (file) {
			Animator.loadFile(file[0], animationsToImport);
		});
	}

	// Import files from the directory and subdirectories
	function importAllFiles() {
		dirPath = getDirectoryPath();
		//console.log("[SYSTEM AUTOLOAD] Directory Path: ", dirPath);

		const importFiles = scanDirectory(dirPath);
		console.log("[SYSTEM AUTOLOAD] Files to Import: ", importFiles);

		// Iterate through the PNG files and import each texture
		for (const filePath of importFiles.pngFiles)
			importTextureFromPath(filePath);

		// Iterate through the Animtion files and import each animation
		for (const filePath of importFiles.animationFiles)
			importAnimationFromPath(filePath);
	}

	// Import files from the directory and subdirectories
	function importRelevantFiles() {
		let dirPath = getDirectoryPath();
		//console.log("[SYSTEM AUTOLOAD] Directory Path: ", dirPath);

		const importFiles = scanDirectory(dirPath);
		console.log("[SYSTEM AUTOLOAD] Files to Import: ", importFiles);

		let world_type = `${Format.category}/${Format.id}`;

		// Iterate through the PNG files and import each texture based on type
		if (world_type == "minecraft/bedrock") {
			for (const filePath of importFiles.pngFiles.filter((path) =>
				path.endsWith(".attachable.png"),
			))
				importTextureFromPath(filePath);
			for (const filePath of importFiles.pngFiles.filter((path) =>
				path.endsWith(".entity.png"),
			))
				importTextureFromPath(filePath);
			for (const filePath of importFiles.pngFiles.filter((path) =>
				path.endsWith(".attachable.tga"),
			))
				importTextureFromPath(filePath);
			for (const filePath of importFiles.pngFiles.filter((path) =>
				path.endsWith(".entity.tga"),
			))
				importTextureFromPath(filePath);
		} else if (world_type == "minecraft/bedrock_block") {
			for (const filePath of importFiles.pngFiles.filter((path) =>
				path.endsWith(".block.png"),
			))
				importTextureFromPath(filePath);
			for (const filePath of importFiles.pngFiles.filter((path) =>
				path.endsWith(".block.tga"),
			))
				importTextureFromPath(filePath);
		} else {
			for (const filePath of importFiles.pngFiles)
				importTextureFromPath(filePath);
		}

		// Iterate through the Animtion files and import each animation
		for (const filePath of importFiles.animationFiles)
			importAnimationFromPath(filePath);
	}

	// Register the plugin
	BBPlugin.register("system_template_file_loader", {
		title: "System Template File Loader",
		author: "Shapescape",
		icon: "fas.fa-truck-ramp-box",
		description:
			"Adding a button which loads animation and png files from same directory/subdirectories of the loaded geometry file.",
		version: "3.0.0",
		variant: "desktop",
		onload() {
			import_button_1 = new Action("load_all_from_system", {
				name: "Load Relevant Files From System",
				description:
					"Loads animations and textures that have the file ending .block.png and .block.tga if the model is a block and .entity.png and .entity.tga if the model is an entity from directory and subdirectories into the project.",
				icon: "fas.fa-paste",
				click: function () {
					importRelevantFiles();
				},
			});

			// Add the import button to the menu bar
			MenuBar.addAction(import_button_1, "file.import.3");

			// Create an import button action
			import_button_0 = new Action("load_all_from_system", {
				name: "Load All Files From System",
				description:
					"Loads animations and all textures from directory and subdirectories into the project.",
				icon: "fas.fa-paste",
				click: function () {
					importAllFiles();
				},
			});

			// Add the import button to the menu bar
			MenuBar.addAction(import_button_0, "file.import.4");
		},
		onunload() {
			// Delete the import button when unloading the plugin
			import_button_0.delete();
			import_button_1.delete();
		},
	});
})();
