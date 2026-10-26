# Server container

The Dockerfile runs the existing Next.js application as a single Node process.
Electron is not required. The image includes Chromium for demo verification,
native PDF/SVG renderers, fonts, and the runtime-read agent prompts. It does not
run model weights locally.

## Build and try locally

Build for the intended host architecture. The homelab uses Linux AMD64:

```sh
docker build --platform linux/amd64 -t learnharness:local .
docker volume create learnharness-local
docker run --rm --name learnharness-local \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:3000:3000 \
  --mount source=learnharness-local,target=/var/lib/learnharness \
  learnharness:local
```

Open `http://localhost:3000`. Add provider API keys and select the strong, cheap,
and vision model slots through Settings. There are no default model choices.
ChatGPT, Copilot, and Grok subscription sign-in uses Electron-owned IPC and is
unavailable here. Provider API-key connections remain available.

The runtime runs as UID/GID 1000. The entrypoint initializes missing storage
directories as that user, with a private umask, before starting the server.
Bind mounts must already be writable by that user; it never recursively changes
ownership of existing data. Named Docker volumes inherit the image directory's
ownership on first use. Do not share the same state between running instances.

| Variable | Image default | Purpose |
| --- | --- | --- |
| `HOSTNAME` | `0.0.0.0` | Listen on the container interface |
| `PORT` | `3000` | HTTP port |
| `LH_DATA_DIR` | `/var/lib/learnharness/data` | Sessions, graph, jobs, settings, prompt overrides |
| `LH_AUTH_FILE` | `/var/lib/learnharness/auth.json` | Writable API-key record, created by Settings |
| `CHROME_PATH` | `/usr/bin/chromium` | Headless demo verification |
| `BIFROST_BASE_URL` | Unset | Server-side Bifrost gateway URL; accepts a regular HTTPS URL or cluster-internal HTTP Service URL |
| `BIFROST_API_KEY` | Unset | Optional deployment-managed Bifrost virtual key; otherwise save it through Settings |

Both data and credentials are under the same persistent volume, in separate
paths. Keys saved through Settings are private plaintext files (mode 0600), not
encrypted at rest. Existing environment API keys take precedence over saved keys.
Do not mount a read-only Kubernetes Secret over `LH_AUTH_FILE`: the Settings
writer uses atomic rename. Environment-based provider credentials are supported,
but then their lifecycle belongs to the deployment's secret management.

Do not set `LH_DESKTOP_SERVER` or `LH_DESKTOP_API_SECRET` in browser mode. Those
variables require the trusted Electron request header, not a web login.

## Bifrost gateway

Set `BIFROST_BASE_URL` on the server, for example
`http://bifrost.bifrost.svc.cluster.local:8080` inside Kubernetes, or your gateway's
HTTPS address outside the cluster. Restart the server after changing it. The
endpoint is deployment configuration; it cannot be entered or saved through the UI.
Gateway roots and URLs ending in `/openai`, `/openai/v1`, or `/v1` are accepted.

In Settings, add the **Bifrost** provider's virtual key, then select its models
for the strong, cheap, and vision slots as usual. The key uses the existing
credential file and environment precedence described above. Requests originate
from the server, so the browser needs neither cluster DNS nor a Bifrost CORS entry.

Discovery calls the gateway's native `/v1/models` endpoint with `x-bf-vk` and uses
its reported metadata. If input modalities are missing, it supplements only
those discovered models through `/api/models/parameters?model=...`, using
`supported_modalities` or an explicit `supports_vision: true`. The same virtual
key is sent, with no dashboard credentials or permission changes. If that
endpoint is restricted or unavailable, discovery still works and the models
remain text-only unless their model-list metadata advertises image input.
Existing model-list modalities take precedence. Generation uses `/openai/chat/completions`, including
streaming and tools. Models explicitly limited to other APIs are excluded.
The integration targets Bifrost v2.3.1; discovery is cached for one minute and
cleared when the key or endpoint changes. A restart reloads the catalog before
running a configured chat or background job. Connection errors appear in model
selection without hiding other providers.

Missing prices and context limits appear as unknown. No token limit or reasoning
level is invented when the gateway does not report it. Availability and virtual-key
restrictions remain governed by Bifrost; configure its providers and permissions
in the gateway before selecting a model here.

## Runtime checks

`GET /healthz` checks whether HTTP is responsive. `GET /readyz` additionally
checks local persistence paths and credential-file readability. Neither calls a
provider or requires configured models. Both are uncached, contain no secrets,
and are outside the desktop-only `/api` request guard.

The Docker build runs the existing standalone provider and server smoke gates.
The container workflow then starts the final non-root image with a disposable
volume, exercises HTTP, SSE notifications, native PDF/SVG rendering and Chromium,
and checks a saved session after restarting the same container. These checks use
no model calls or provider credentials. `scripts/smoke-container.mjs` requires
`LH_CONTAINER_SMOKE=1` and creates test data; never run it on a real instance.

Production browser access needs a trusted private network or an authentication
gateway: browser mode has one shared profile and no user-account isolation.
Use HTTPS for remote microphone/dictation. Agents' file paths refer to files
inside the server container, not files on the browser device. Model requests and
research still contact external services.

The server's streams must pass through any proxy without buffering. A browser
disconnect does not cancel its active turn, but replacing the container ends
in-flight work; only already-persisted records survive. Schedule upgrades between
sessions. Multiple replicas require a separate storage and coordination design.

## Image publishing

`.github/workflows/container.yml` verifies Linux AMD64 images on pull requests
and main pushes. After verification, it publishes
`ghcr.io/baruchavi/learnharness:sha-<full-source-commit>` only from `main` in
`baruchavi/learnharness`. The owner approved public source and a public image,
with application access restricted separately through Tailscale.
Other repositories, PRs, and non-main manual runs
cannot publish through this workflow.

The workflow verifies the existing package has the approved public visibility
before and after publishing. Anyone can pull the image without registry
credentials; this does not grant access to a running application or its data.
The image contains application code and dependencies, not learning records or
provider keys. GitHub Actions still authenticates to push updates.

The public fork can retain an `upstream` Git remote for updates. Learning data,
keys, and private cluster manifests stay outside the public repository and image.
The publishing workflow does not deploy to Kubernetes.

Kubernetes manifests, activation instructions, Tailscale access policy preflight,
resource budgets, and backup guidance are maintained only in
`homelab-gitops/apps/learnharness/README.md`.
