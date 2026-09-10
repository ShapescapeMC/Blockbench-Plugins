(installation)=
# Installation

## Steps

### 1. Install the plugin

#### From a file

1. Clone this repository.
2. Open Blockbench.
3. Go to `File -> Plugins... -> Load Plugin from File`. Navigate to `plugins/render_model` in the cloned repository and select `render_model.js`.
4. To confirm the plugin installed correctly, go to `File -> Plugins...`. Under the "Installed" section you should see `Render Model`.

### 2. Open it

Open a model, then go to `View -> Render Model...`.

## Requirements

- Blockbench 5.0 or newer.
- The desktop app. The plugin writes files to disk, so it does not run in the web version.

The first run asks for file system permission, which Blockbench 5 requires before a plugin can write images.
