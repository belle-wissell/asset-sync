# Asset Sync

Command-line tool that keeps data and assets in sync for offline apps. You provide the JSON URLs and which fields hold asset URLs, and it gives you a folder of data and assets your app can read offline.

## Key features

- Local content is only updated after each source downloads successfully. If a file download fails, the source is skipped, leaving the existing content in place.
- Asset files are renamed to logically follow JSON structure, and JSON data is automatically rewritten to point to the correct asset files.
- Works as a per-project dependency during development, and can be scheduled to run nightly by the OS on a kiosk machine, keeping content up-to-date and allowing kiosk apps to run offline.

## Installation & usage

### As a project dependency

Install it into whichever project needs synced assets, and add an npm script pointing at it:

```bash
npm install --save-dev @belle-wissell/asset-sync
```

```json
{
  "scripts": {
    "assets:sync": "asset-sync"
  }
}
```

```bash
npm run assets:sync
```

If no config is found, a starter `asset-sync.config.json` is written in the project root. Update that file to point to your data sources, then run it again to sync. Each project keeps its own config — commit it or gitignore it, whichever fits that project.

### On a kiosk machine (scheduled nightly)

There are a number of ways to make this work, but one option is to install the package globally.

```bash
npm install -g @belle-wissell/asset-sync@1.0.0
```

Put `asset-sync.config.json` in a dedicated folder, e.g. `C:\kiosk\asset-sync.config.json`, and schedule `asset-sync` to run nightly with the OS scheduler. Since the default config resolves relative to the current working directory (not to wherever the package is installed), the scheduled job must either run with its working directory set to that folder, or pass an explicit absolute `--config` path:

```text
# Windows Task Scheduler
Program:   asset-sync
Arguments: --config C:\kiosk\asset-sync.config.json
Start in:  C:\kiosk
```

```bash
# cron, with an explicit config path
0 3 * * * /usr/local/bin/asset-sync --config c:/kiosk/asset-sync.config.json
```

### Options

- `-c, --config <file>` — Config file to read (default: `asset-sync.config.json` in the current directory). Must already exist; only the default is scaffolded when missing.
- `-j, --json-only` — Skip assets, JSON only. Refreshes the JSON files without touching the assets already on disk.
- `-n, --concurrency <n>` — Parallel downloads (default: `8`)
- `--dry-run` — Report without writing. Reports exactly what would be fetched and written, without requesting a single asset or touching your disk.
- `-h, --help` — Show help message
- `-v, --version` — Show version

## Configuration

An `asset-sync.config.json` file in the project root (current working directory) controls how content is downloaded.

### Config

| Key         | Default    |                                                                                                    |
|-------------|------------|----------------------------------------------------------------------------------------------------|
| `outputDir` | *required* | Shared folder for every source. Absolute, starting with `~`, or relative to the current directory. |
| `sources`   | *required* | List of sources, each a JSON endpoint to sync  (see below)                                         |

### Source (an entry in `sources`)

| Key          | Default    |                                                                               |
|--------------|------------|-------------------------------------------------------------------------------|
| `url`        | *required* | JSON endpoint to fetch                                                        |
| `outputFile` | *required* | Name for the downloaded JSON                                                  |
| `assets`     | *none*     | Enables asset downloading for this source. Omit it to download the JSON only. |

### `assets` (on a source, once present)

| Key            | Default    |                                              |
|----------------|------------|----------------------------------------------|
| `outputFolder` | *required* | Name of the folder for the downloaded assets |
| `fields`       | *none*     | Fields in the JSON holding asset URLs        |

### Example

```json
{
  "outputDir": "c:/kiosk",
  "sources": [
    {
      "url": "https://example.com/api/categories",
      "outputFile": "categories.json"
    },
    {
      "url": "https://example.com/api/stories",
      "outputFile": "stories.json",
      "assets": {
        "outputFolder": "story-assets",
        "fields": ["stories.img"]
      }
    }
  ]
}
```

The above `asset-sync.config.json` file will output files like this:

```text
c:/kiosk/                    ← outputDir
├─ categories.json           ← outputFile
├─ stories.json              ← outputFile
└─ story-assets/             ← assets.outputFolder
   └─ stories-1-img.jpg      ← assets.fields
   └─ stories-2-img.jpg      ← assets.fields
   └─ stories-3-img.jpg      ← assets.fields


```

## Handling assets

### Targeting URLs with `assets.fields`

Each string in `assets.fields` digs down through the JSON one field at a time, separated by `.`, until it reaches a URL. Fields along the way may be objects or arrays; the final field may be a URL string or an array of URL strings.

So this `fields` array captures every image and video URL in the JSON below:

```json
"fields": [
  "settings.background.img",
  "stories.img",
  "stories.vid",
  "otherImgs"
]
```

```json
{
  "settings": {
    "background": {
      "enabled": true,
      "img": "http://example.com/bg-image.png",
      "opacity": 0.75
    }
  },
  "stories": [
    {
      "title": "First story",
      "img": "http://example.com/some-image.jpg"
    },
    {
      "title": "Second story",
      "img": "http://example.com/example.jpg",
      "vid": "http://example.com/sample-vid-asdf.mp4"
    }
  ],
  "otherImgs": [
    "http://example.com/filename_a.jpg",
    "http://example.com/filename_b.jpg"
  ]
}
```

Arrays are stepped through automatically, so you never name them in a field path — you name the fields *inside* them. That holds for the whole document too: if the endpoint returns a bare array, the field path is just `"imagePath"`, with nothing in front of it:

```json
[
  { "imagePath": "http://example.com/image.jpg" },
  { "imagePath": "http://example.com/other.jpg" }
]
```

```json
"fields": ["imagePath"]
```

### Naming downloaded files

Downloaded files are named after the field path that found them, with array items numbered from 1:

```text
assets/settings-background-img.png
assets/stories-1-img.jpg
assets/stories-2-img.jpg
assets/stories-2-vid.mp4
assets/otherImgs-1.jpg
assets/otherImgs-2.jpg
assets/1-imagePath.jpg
assets/2-imagePath.jpg
```

File extensions come from the asset's final URL after redirects, falling back to its content type. Missing fields are skipped, and a URL referenced more than once is downloaded only once.

### How the JSON is rewritten

The endpoint returns a story with an asset URL on the internet:

```json
{
  "stories": [
    {
      "id": "uniqueId",
      "img": "https://cdn.example.com/x7f2.jpg"
    }
  ]
}
```

The downloaded `c:/kiosk/stories.json` points at the copy on disk instead:

```json
{
  "stories": [
    {
      "id": "uniqueId",
      "img": "story-assets/stories-1-img.jpg"
    }
  ]
}
```

That path is always **relative to the JSON file**, and since the assets are a sibling folder, it is just `assets.outputFolder` plus the file name.
