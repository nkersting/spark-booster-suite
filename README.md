# Tree-Based Immersive Presentations — On-Prem Install

Free, self-hosted build. No sign-in, no license key, no access code: start the server and open the app in a browser.

## Requirements

- Node.js 18 or newer (20 LTS recommended) — https://nodejs.org
- npm (comes with Node.js)
- Git (optional, to clone the repository)

## Install

```bash
git clone <your-repo-url> presentations
cd presentations
npm install
```

## Run

```bash
npm start
```

This builds the app and serves it at **http://localhost:5000**. Open that address in your browser and the app appears right away.

### Development mode (live reload)

```bash
npx vite --port 5000
```

### Make it reachable from other machines on your network

```bash
npm run build
npx vite preview --port 5000 --strictPort --host 0.0.0.0
```

Then open `http://<server-ip>:5000` from any machine on the network.

### Serve the built files with any web server

`npm run build` writes a static site to `dist/`. You can serve it with nginx, Apache, IIS, etc. Configure the server so unknown paths return `index.html` (single-page app fallback), e.g. for nginx:

```nginx
server {
  listen 5000;
  root /path/to/presentations/dist;
  location / { try_files $uri /index.html; }
}
```

## Your own presentation content

1. Create your own `knowledge.json` (an LLM can draft it from the example in `data/`) and put its images in a folder under `public/examples/<YourProject>/`.
2. Reference images with a leading `/`, e.g. `/examples/MyProject/photo.png`.
3. Load it from the app, or copy it to `public/data/knowledge.json` to make it the default.
4. Rebuild (`npm start`) after changing files in `public/`.

In Chrome or Edge you can also open a local data folder directly from the app.

### Knowledge file format

Generated and saved files use **schema 1.0**, as defined by `migrate_schema.py`:

- `document`: UUID, title, description, language and metadata.
- `graph`: `rootNodeId`, a `nodes` array with UUIDs and `content`, and `edges` keyed by source UUID then target UUID.
- `extensions.rendererSpecificProperties`: rendering settings such as `space`.
- Content items store image/media paths in `properties.icon`, text in `properties.title` and `properties.notes`, and links in `properties.source_url`.

Both `public/data/knowledge.json` and `data/knowledge.json` have been converted. Existing nodes/connections files remain loadable; saving writes schema 1.0.

To convert an existing nodes/connections file yourself (Python 3 required):

```bash
python3 migrate_schema.py old-knowledge.json -o knowledge.json
```

The default edge format preserves weight, relation and note attributes. Optional node positions, hints and renderer settings are preserved too.

## Notes

- AI topic generation and museum collection search use online services, so they need an internet connection. Everything else (viewing, editing, 2D/3D navigation, PowerPoint import) runs locally.
- Port in use? Change `5000` in the `start` script in `package.json`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `npm install` fails | Update Node.js to 18+ and delete `node_modules` and `package-lock.json`, then retry |
| Blank page after refresh on nginx/Apache | Add the `index.html` fallback shown above |
| Port 5000 busy (macOS AirPlay uses it) | Turn off AirPlay Receiver in System Settings, or pick another port |
