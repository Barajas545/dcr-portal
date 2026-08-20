# Construction Modeling Engine (CME) Source

Production code for CME lives here. Shared, UI-independent services belong in `core/`; intelligent construction objects belong in isolated `tools/` modules. Rendering, UI, commands, history, and data remain separate so domain behavior can evolve without project-specific dependencies.

`index.ts` is the future public package boundary. Exports should be deliberate and stable.
