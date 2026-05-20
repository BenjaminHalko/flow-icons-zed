<h1 align="center">
  <img src="https://raw.githubusercontent.com/thang-nm/Flow-Icons/main/logo.png" width="160" alt="Flow Icons"/><br/>
  <a href="https://flow-icons.pages.dev">Flow Icons</a>
</h1>

<p align="center">
  🌼 Flow Icons ported to Zed
</p>

![Flow Icons Preview](https://raw.githubusercontent.com/thang-nm/Flow-Icons/main/preview.png)

## Installation

Download the Extension using:

```bash
git clone https://github.com/BenjaminHalko/flow-icons-zed.git
```

Inside ZED, install the extension using the "Install Dev Extension" button

## Premium Icons

If you want to use the premium icon set, then you will need to run the script to fetch the icons

```bash
node update-icons.cjs <FLOW_ICONS_LICENSE>
```

## Customization

You can customize which icons appear for files and folders by creating a `config.json` in the repo root, and then running `update-icons`

| Setting | Purpose |
| --- | --- |
| `folderColor` | Default folder color: `gray`, `blue`, `brown`, `green`, `lime`, `orange`, `pink`, `purple`, `red`, `sky`, `teal`, `yellow` |
| `specificFolders` | If `false`, all directories use the default folder icon (no per-name icons like `src`, `tests`, `components`) |
| `filesReplacements` | Swap one file icon for another, typically an `-alt` variant: `{ "rust": "rust-alt", "kotlin": "kotlin-alt" }` |
| `foldersReplacements` | Swap one folder icon for another: `{ "components": "react-components" }` |
| `filesAssociations` | Map extensions or filenames to icons (Material-Icons syntax: `*.tss`, `tailwind.css`, `src/index.js`). Empty string removes an association |
| `foldersAssociations` | Map folder names to icons: `{ "store": "resource" }`. Empty string removes |
