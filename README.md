
### MV2 -> 3
- **MV2 deprecation**: Chrome is deprecating background pages/event pages used in MV2.
- **Privacy constraints**: Blocking `webRequest` listeners are discouraged; MV3 prefers `declarativeNetRequest` (DNR).
- **Reliability**: Needed handling when the local relay (proxy) starts/stops while the browser is running.

### Changes
- **Background → Service Worker**
  - MV2: `ts/background.js` registered `webRequest.onBeforeRequest` and did sync XHR to the relay.
  - MV3: `ts/service_worker.js` is the background service worker. It configures DNR rules and manages health checks/state.

- **webRequest (blocking) → declarativeNetRequest**
  - Redirects for Twitch HLS/VOD requests are implemented as DNR rules.
  - Ad blocking for `amazon-adsystem.com` is a DNR dynamic rule.

- **Proactive health checks and instant rule flips**
  - Periodic healthcheck via `chrome.alarms` against `${relay}/stat/`.
  - Immediate re-evaluation on Twitch navigations (including SPA route changes) via `chrome.webNavigation` listeners.
  - When offline, install explicit "allow" rules to bypass any stale redirects; when online, install session redirect rules.

- **User notifications (toast)**
  - Content script `ts/content.js` displays toasts via `browser.runtime.onMessage`.
  - The service worker sends an error message to Twitch tabs when the relay is offline, deduplicated by `lastRelayOnline` state.

### Files and responsibilities
- `manifest.json`
  - `manifest_version: 3`
  - `background.service_worker: ts/service_worker.js`
  - `permissions`: `storage`, `declarativeNetRequest`, `alarms`, `tabs`, `activeTab`, `webNavigation`
  - `host_permissions`: Twitch domains, `usher.ttvnw.net`, and localhost (`http://localhost/*`, `http://127.0.0.1/*`).
  - `content_scripts`: inject `assets/browser-polyfill.js` and `ts/content.js` on Twitch pages.

- `ts/service_worker.js` (MV3)
  - Builds DNR rules for live and VOD redirects (session rules) and ad-block (dynamic rule).
  - Normalizes relay base address from storage.
  - Periodically checks relay health and toggles rules.
  - Reacts to Twitch navigations (`onBeforeNavigate`, `onHistoryStateUpdated`) to refresh rules immediately.
  - Sends a toast message to Twitch tabs when transitioning to offline, with retry and a broadcast fallback.

- `ts/background.js` (legacy MV2)
  - Kept in the repository for reference/other platforms. Not used by Chrome MV3.
  - Previously performed synchronous XHR to fetch and inline M3U8 responses and blocked ad hosts via `webRequest`.

- `ts/content.js`
  - Receives messages and shows toasts (bottom-center). Used for the offline warning.

### Redirect logic in MV3 (DNR)
- Live HLS:
  - Match: `^https://usher\.ttvnw\.net/api/channel/hls/([^/?]+)\.m3u8(\?.*)?$`
  - Redirect: `<base>/live/\1\2`

- VOD HLS:
  - Match: `^https://usher\.ttvnw\.net/vod/([^/?]+)\.m3u8(\?.*)?$`
  - Redirect: `<base>/vod/\1\2`

- Ads block:
  - Match: `^https?://([^.]+\.)?amazon-adsystem\.com/.*`
  - Action: `block`

- Allow-bypass when offline:
  - Same HLS/VOD matchers with `action: allow` and high priority, to ensure Twitch uses the original URL when relay is down.

### Health and rule application flow
- On install/startup:
  - Remove any old dynamic redirect rules from prior versions.
  - Add/update the ad-block dynamic rule.
  - Remove session redirect rules (avoid stale redirects from prior sessions).
  - Check relay health; if online, add session redirects; if offline, add allow-bypass rules.
- On storage `address` change:
  - Re-evaluate health for the new base and re-apply rules.
- On alarm tick (every minute):
  - Re-check health and re-apply rules.
- On Twitch navigation/route changes:
  - Re-check health and re-apply rules immediately for a snappy experience.

### Permissions required in MV3
- `declarativeNetRequest`: to install redirect/block/allow rules.
- `webNavigation`: to react to Twitch navigations and SPA route changes.
- `alarms`: for periodic relay health checks; the SW may sleep when idle.
- `tabs`/`activeTab`: to send messages to the active or specific Twitch tab for toasts.
- `host_permissions`: Twitch domains and relay host (`localhost`/`127.0.0.1`).


### Notes and limitations
- MV3 service worker can be suspended by the browser when idle; periodic alarms and navigation listeners are used to promptly re-apply state.
- DNR rule counts are limited; used a small, fixed set of rule IDs for predictability.
- The legacy MV2 background script remains for reference but is not used on Chrome MV3 builds.
