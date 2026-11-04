# Livemaster

Livemaster is a browser-based audio testing workspace for WAV mixes. Administrators can adjust a three-band EQ, compressor and limiter; compare processed and bypassed audio with a one-click A/B switch; audition simplified listening-environment profiles; save shared processing presets; and export the selected signal as a new WAV file. The interface is in Swedish, with a dark mixing-console faceplate and a warm vintage-style EQ section.

## Architecture

- React, TypeScript and Vite frontend.
- Azure Static Web Apps with its integrated Azure Functions API.
- Static Web Apps Microsoft Entra ID sign-in. Every preset and audio-file API operation checks the trusted Static Web Apps principal against `GLOBAL_ADMIN_EMAILS`.
- Azure Table Storage stores shared processing presets and WAV-file metadata.
- A private Azure Blob Storage container stores the WAV files. Files are served only through the authenticated API; storage URLs and credentials are never sent to the browser.
- Bicep provisions Azure Static Web Apps, Storage Account and Application Insights. GitHub Actions deploy the app and infrastructure using OIDC.

The managed Functions API uses the server-side `STORAGE_CONNECTION_STRING` configured by Bicep. Shared-key access is enabled for the Storage Account to support this integration. Do not expose or commit the key.

WAV files are decoded and processed in the browser. Selecting a file does not upload it; choose **Spara i Azure** to store it privately and open it later from another device. Uploads are limited to 80 MB. EQ, compression, limiting and WAV export use the Web Audio API. The device profiles are simplified frequency-response simulations, not measured models of specific speakers or headphones.

## Local development

Prerequisites: Node.js 22+, npm, Azure Functions Core Tools v4, and Azurite.

1. Install frontend and API dependencies:

   ```powershell
   npm ci
   Set-Location api
   npm ci
   Set-Location ..
   ```

2. Install and start Azurite if needed:

   ```powershell
   npm install --global azurite
   azurite --silent --location .azurite
   ```

3. In a second terminal, create local Functions settings and start the API:

   ```powershell
   Copy-Item api/local.settings.example.json api/local.settings.json
   Set-Location api
   npm run build
   func start
   ```

4. In another terminal, start the frontend:

   ```powershell
   npm run dev
   ```

Sign in locally with an address listed in `GLOBAL_ADMIN_EMAILS` in `api/local.settings.json` (the example uses `admin@local.test`). The development-only identity header is disabled in production. For local storage testing, change `STORAGE_MODE` to `table` and set `STORAGE_CONNECTION_STRING` in the untracked local settings file. Memory-mode data is lost when the Functions process restarts.

Build checks:

```powershell
npm run build
Set-Location api
npm run build
```

## Deploy to Azure

### Configure Azure and GitHub

- Create an Azure resource group.
- Create an Entra app registration/service principal for infrastructure deployment and grant it Contributor on the resource group.
- Configure its GitHub OIDC federated credential with issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, and subject `repo:<OWNER>/livemaster:ref:refs/heads/main`.
- Add repository secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, and `SWA_DEPLOYMENT_TOKEN` (after the first infrastructure deployment).
- Add repository variables: `AZURE_RESOURCE_GROUP` and `GLOBAL_ADMIN_EMAILS` (comma-separated sign-in email addresses). `NAME_PREFIX` is optional and defaults to `livemaster`.

The Azure login workflow uses OIDC; do not create an Entra client secret.

### Deploy infrastructure

Push an `infra/**` change to `main`, or run **Deploy infrastructure** in Actions. To deploy from a local Azure CLI session:

```powershell
az login
az deployment group create `
  --resource-group <resource-group> `
  --template-file infra/main.bicep `
  --parameters namePrefix=livemaster globalAdminEmails=<admin-email>
```

Use the resulting `staticWebAppName` output to retrieve the deployment token:

```powershell
az staticwebapp secrets list --name <static-web-app-name> --resource-group <resource-group> --query properties.apiKey --output tsv
```

Save it as the GitHub `SWA_DEPLOYMENT_TOKEN` secret. Push an application change to `main` (or run **Build and deploy application**) to publish the site and API. Sign in with an address listed in `GLOBAL_ADMIN_EMAILS`. The built-in `aad` provider is used.

## API and access

- `GET /api/me` reports the current sign-in state and whether the email is a configured administrator.
- `GET /api/presets`, `POST /api/presets`, `PUT /api/presets/{id}`, and `DELETE /api/presets/{id}` manage shared processing presets.
- `GET /api/tracks` lists saved WAV metadata; `POST /api/tracks` stores a WAV; `GET /api/tracks/{id}` streams it from private storage; and `DELETE /api/tracks/{id}` removes it.
- Every `/api/presets` and `/api/tracks` operation requires an authenticated email in `GLOBAL_ADMIN_EMAILS`. The API never trusts client-supplied identity for authorization.
- WAV uploads are limited to 80 MB and checked for valid RIFF/WAVE format and audio chunks. Files are stored in the private `audio-tracks` Blob container, with names and metadata in the `AudioTracks` table.
- Presets are validated on the server and stored in the `AudioPresets` table.

Static Web Apps managed Functions use a server-side Storage connection string. Browser code only calls the API and never receives storage credentials or direct Blob URLs.
