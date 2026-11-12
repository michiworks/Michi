# Michi Frontend

The frontend workspace contains Michi's React and Vite renderer. Shared protocol
code lives in `../shared`, backend APIs in `../backend`, and the runtime
integrations in `../runtime` (`michi-runtime`; Pi stays in
`../backend/src/agents/pi`).

Run frontend commands from the repository root:

```bash
npm run frontend:dev
npm test -w frontend
npm run typecheck -w frontend
```

Generated production assets are written to `frontend/build/`.
