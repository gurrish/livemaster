# Copilot instructions

## Project overview

Livemaster is an administrator-only browser audio testing workspace. Administrators load WAV files, adjust EQ, compression and limiting, compare simplified listening-environment profiles, save shared presets and export processed WAV files. The interface is exclusively Swedish.

The frontend is React, TypeScript and Vite. The backend is an Azure Functions API integrated with Azure Static Web Apps. Azure Table Storage holds presets and audio-file metadata; WAV bytes are stored in a private Azure Blob container. Azure resources use Bicep and GitHub Actions deploy with OIDC.

## Project structure

- `src/App.tsx`: administrator access gate and audio workspace.
- `src/lib/audio.ts`: Web Audio API processing graph and WAV rendering.
- `src/lib/api.ts`: typed API calls for viewer, presets and WAV tracks.
- `src/types.ts`: audio settings, environments, presets, tracks and viewer types.
- `api/src/domain.ts`: Zod schemas and server-side types.
- `api/src/index.ts`: HTTP API, trusted Static Web Apps identity parsing and admin authorization.
- `api/src/repository.ts`: in-memory development repository and Azure Table/Blob persistence.
- `infra/`: Bicep entry point and resource modules.
- `.github/workflows/`: application and infrastructure build/deploy workflows.
- `README.md`: local setup, audio workflow, API and deployment documentation.

## Code conventions

- Use TypeScript and preserve strict type checking. Avoid `any` and unsafe casts.
- All visible UI text, accessibility labels, validation messages and page metadata must be in Swedish.
- Validate API inputs with Zod. Return actionable client errors and log unexpected failures.
- Keep persistence behind the `Repository` interface and implement both memory and Azure-backed behavior.
- Validate uploaded WAV size and RIFF/WAVE signature server-side. Store bytes only in the private `audio-tracks` Blob container; never return storage URLs or credentials to the browser.
- Keep shared preset fields, server schemas, frontend types and README documentation in sync.
- Only accounts whose trusted email is listed in `GLOBAL_ADMIN_EMAILS` may access preset or WAV APIs. `x-dev-user-email` is accepted only when `DEV_AUTH=true` and `NODE_ENV` is not `production`.
- Environment simulations are illustrative frequency profiles, not measured emulations. Do not describe them as accurate models of specific devices.

## Build and validation

- Frontend: `npm ci` then `npm run build` from the repository root.
- Functions API: `npm ci` then `npm run build` from `api/`.
- Infrastructure: `az bicep build --file infra/main.bicep`.
- Run `git diff --check` before finishing.
- Keep root and API lockfiles committed when dependencies change. Do not commit generated build output, local Functions settings, secrets, or Azure credentials.

## Infrastructure and deployment

- Define Azure resources in Bicep under `infra/`.
- Keep Static Web Apps integrated Functions and GitHub OIDC federation; do not add a client-secret requirement.
- The Functions app uses a server-side Storage connection string for Table and private Blob access. Never put credentials in frontend code, repository files, workflow arguments, or responses.
- Infrastructure is not necessarily deployed just because Bicep templates exist; state deployment status explicitly.
