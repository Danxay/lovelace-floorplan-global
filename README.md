# Apartment Floorplan Global

HACS dashboard package for the apartment floorplan widget.

## What this repo contains

- `dist/floorplan-global.js` — runtime module with anti-flash fixes and config mode
- `dist/widget_spec.json` — source of truth for opacity tuning and point metadata
- `dist/base.png` and `dist/*.png` — floorplan assets
- `dist/apartment-floorplan-dashboard.yaml` — full dashboard YAML bundle for Home Assistant Raw configuration editor
- `dist/floorplan-card.yaml` — single-card snippet if you want to embed the floorplan into an existing dashboard

## Required dependencies

Install these from HACS before using the dashboard bundle:

- `button-card`
- `config-template-card`

For shared config mode across all users, also install and configure the companion integration repo:

- `floorplan-global-backend`

## Installation

1. Add this repository to HACS as a `Dashboard` repository.
2. Download the repository in HACS.
3. Make sure HACS added the `floorplan-global.js` resource. If it did not, add it manually as a Lovelace resource:
   - URL: `/hacsfiles/lovelace-floorplan-global/floorplan-global.js`
   - Type: `JavaScript module`
4. Create a new dashboard in Home Assistant.
5. Open the dashboard Raw configuration editor.
6. Paste `dist/apartment-floorplan-dashboard.yaml`.
7. Set `Show in sidebar` if you want the floorplan as a dedicated sidebar entry.

## Config mode permissions

The gear-based config mode is intentionally admin-only:

- it writes shared overrides for the whole Home Assistant instance
- it may create or update helper light groups for multi-entity points

## Important repo naming note

The generated YAML in this repo uses asset URLs under:

`/hacsfiles/lovelace-floorplan-global/...`

Keep the GitHub repository name aligned with `lovelace-floorplan-global` or regenerate the bundle with a different slug in `hacs/build_hacs_floorplan.js`.

## Regenerating from source

This repository is generated from the source widget under `../floorplan`.

From the monorepo root run:

```bash
node hacs/build_hacs_floorplan.js
```
