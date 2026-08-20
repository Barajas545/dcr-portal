# Tools

Each folder is an isolated intelligent construction object on the CME roadmap. Tool modules may use shared services from `src/core/` but must not depend on other applications, routes, global styles, or project-specific state.

Most of these folders are still placeholders awaiting a Product Lab specification, and no
construction behaviour should be added to those without that approval.

`beam/`, `joist-group/` and `post-footing/` are the exceptions: the owner lifted the gate on
2026-08-20 for a port of the previous drawing tool, on the condition that they match it exactly
and invent no engineering. Each carries its own README recording the quantities and their
source lines. Anything beyond counting — spans, sizing, footing design — still needs a spec.

