# AGENTS.md

## Project scope

This repository contains the independent Construction Modeling Engine (CME).

## Boundaries

- Keep CME independent from `dcr-sales-hub` while it is under development.
- Treat `railing-prototype` as a reference only; do not modify it from this repository.
- Build tools as isolated modules under `src/tools/` that share services from `src/core/`.
- Avoid dependencies on routes, global styles, or project-specific state from DCR Sales Hub.

## Development

- Add automated tests under `tests/` or beside source modules when appropriate.
- Keep project data and calculation outputs structured and serializable.
- Document new tools and architecture decisions in `README.md`.
