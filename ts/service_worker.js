/* MV3 service worker: install dynamic DNR rules to redirect Twitch HLS/VOD
   requests to a user-configured relay, and block Amazon ad requests. */

const DEFAULT_ADDRESS = "http://localhost:9595";
const HEALTH_PATH = "/stat/";
const HEALTHCHECK_ALARM = "relay-healthcheck";
const HEALTHCHECK_PERIOD_MINUTES = 1; // keep small; SW sleeps when idle

// Dynamic (persistent) rule IDs
const DYNAMIC_RULE_IDS = {
  AMAZON_ADS_BLOCK: 1003,
};

// Dynamic allow-bypass rules to defeat any stale redirects
const DYNAMIC_ALLOW_IDS = {
  LIVE_ALLOW: 3001,
  VOD_ALLOW: 3002,
};

// Session (non-persistent) rule IDs for redirects
const SESSION_RULE_IDS = {
  LIVE_REDIRECT: 2001,
  VOD_REDIRECT: 2002,
};

// Track last known relay online state to avoid spamming notifications
let lastRelayOnline = null; // null | boolean

/** Build dynamic DNR rules based on the configured base address. */
function buildRedirectSessionRules(baseAddress) {
  const base = normalizeBase(baseAddress);

  /**
   * Matches: https://usher.ttvnw.net/api/channel/hls/<id>.m3u8[?<query>]
   * Redirects: <base>/live/<id>[?<query>]
   */
  const liveRule = {
    id: SESSION_RULE_IDS.LIVE_REDIRECT,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: `${base}/live/\\1\\2`,
      },
    },
    condition: {
      regexFilter:
        "^https://usher\\.ttvnw\\.net/api/channel/hls/([^/?]+)\\.m3u8(\\?.*)?$",
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  };

  /**
   * Matches: https://usher.ttvnw.net/vod/<id>.m3u8[?<query>]
   * Redirects: <base>/vod/<id>[?<query>]
   */
  const vodRule = {
    id: SESSION_RULE_IDS.VOD_REDIRECT,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution: `${base}/vod/\\1\\2`,
      },
    },
    condition: {
      regexFilter: "^https://usher\\.ttvnw\\.net/vod/([^/?]+)\\.m3u8(\\?.*)?$",
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  };

  return [liveRule, vodRule];
}

function normalizeBase(input) {
  let base = input || DEFAULT_ADDRESS;
  if (!/^https?:/i.test(base)) base = `http://${base}`;
  // Remove trailing slash
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

async function addOrUpdateAdsBlockDynamicRule() {
  /** Block Amazon ad host requests. */
  const adsBlockRule = {
    id: DYNAMIC_RULE_IDS.AMAZON_ADS_BLOCK,
    priority: 1,
    action: { type: "block" },
    condition: {
      regexFilter: "^https?://([^.]+\\.)?amazon-adsystem\\.com/.*",
    },
  };
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [DYNAMIC_RULE_IDS.AMAZON_ADS_BLOCK],
      addRules: [adsBlockRule],
    });
  } catch (error) {
    console.error("Failed to set ads block rule:", error);
  }
}

async function setAllowBypassRules(enabled) {
  const liveAllow = {
    id: DYNAMIC_ALLOW_IDS.LIVE_ALLOW,
    priority: 100, // higher than redirect rule priority
    action: { type: "allow" },
    condition: {
      regexFilter:
        "^https://usher\\.ttvnw\\.net/api/channel/hls/([^/?]+)\\.m3u8(\\?.*)?$",
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  };
  const vodAllow = {
    id: DYNAMIC_ALLOW_IDS.VOD_ALLOW,
    priority: 100,
    action: { type: "allow" },
    condition: {
      regexFilter: "^https://usher\\.ttvnw\\.net/vod/([^/?]+)\\.m3u8(\\?.*)?$",
      resourceTypes: ["xmlhttprequest", "media", "other"],
    },
  };
  const removeRuleIds = Object.values(DYNAMIC_ALLOW_IDS);
  const addRules = enabled ? [liveAllow, vodAllow] : [];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules,
    });
  } catch (error) {
    console.error("Failed to update allow-bypass rules:", error);
  }
}

async function addRedirectSessionRules(baseAddress) {
  const rules = buildRedirectSessionRules(baseAddress);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: Object.values(SESSION_RULE_IDS),
      addRules: rules,
    });
  } catch (error) {
    console.error("Failed to add session redirect rules:", error);
  }
}

async function removeRedirectSessionRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: Object.values(SESSION_RULE_IDS),
      addRules: [],
    });
  } catch (error) {
    console.error("Failed to remove session redirect rules:", error);
  }
}

// Cleanup: remove any old dynamic redirect rules from prior versions
async function removeOldDynamicRedirectRules() {
  const oldIds = [1001, 1002];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldIds,
      addRules: [],
    });
  } catch (_) {}
}

async function applyRulesFromStorage() {
  try {
    const { address = DEFAULT_ADDRESS } = await chrome.storage.sync.get([
      "address",
    ]);
    await addOrUpdateAdsBlockDynamicRule();
    // Always clear session redirects first to avoid stale redirects after restart
    await removeRedirectSessionRules();
    // Apply redirects only if relay is online
    const online = await isRelayOnline(address);
    await applyOnlineState(online, address);
  } catch (error) {
    console.error("Failed to read storage/apply rules:", error);
  }
}

async function isRelayOnline(address) {
  const base = normalizeBase(address);
  const url = `${base}${HEALTH_PATH}`;
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) return false;
    // Try to read JSON { online: boolean } if provided
    try {
      const data = await res.json();
      if (typeof data?.online === "boolean") return data.online;
    } catch (_) {
      // Not JSON, consider any 200 as online
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Initialize on startup/installation
chrome.runtime.onInstalled.addListener(() => {
  // Ensure no stale dynamic redirect rules exist
  removeOldDynamicRedirectRules();
  applyRulesFromStorage();
  // Start periodic health checks
  chrome.alarms.create(HEALTHCHECK_ALARM, { periodInMinutes: HEALTHCHECK_PERIOD_MINUTES });
});
if (chrome.runtime.onStartup && chrome.runtime.onStartup.addListener) {
  chrome.runtime.onStartup.addListener(() => {
    removeOldDynamicRedirectRules();
    applyRulesFromStorage();
    chrome.alarms.create(HEALTHCHECK_ALARM, { periodInMinutes: HEALTHCHECK_PERIOD_MINUTES });
  });
}

// React to address changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.address) {
    const next = changes.address.newValue || DEFAULT_ADDRESS;
    // Re-evaluate based on new address health
    isRelayOnline(next).then(async (online) => {
      await removeRedirectSessionRules();
      await applyOnlineState(online, next);
    });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEALTHCHECK_ALARM) return;
  try {
    const { address = DEFAULT_ADDRESS } = await chrome.storage.sync.get(["address"]);
    const online = await isRelayOnline(address);
    await removeRedirectSessionRules();
    await applyOnlineState(online, address);
  } catch (e) {
    // ignore
  }
});

// Note: No webNavigation listeners; fallback relies on periodic health checks
// React immediately to Twitch navigations (including SPA route changes)
// so rules flip quickly when the relay starts/stops without needing a browser restart.
async function refreshRulesNow(context) {
  try {
    const { address = DEFAULT_ADDRESS } = await chrome.storage.sync.get(["address"]);
    const online = await isRelayOnline(address);
    await removeRedirectSessionRules();
    await applyOnlineState(online, address, context);
  } catch (_) {}
}

function isTwitchNavigation(url) {
  return (
    /^https:\/\/([^.]+\.)?twitch\.tv\//.test(url || "") ||
    /^https:\/\/usher\.ttvnw\.net\//.test(url || "")
  );
}

if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    // Only react for top-frame navigations for Twitch
    if (details.frameId !== 0) return;
    if (!isTwitchNavigation(details.url)) return;
    refreshRulesNow({ tabId: details.tabId, url: details.url });
  });
}

if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    if (!isTwitchNavigation(details.url)) return;
    refreshRulesNow({ tabId: details.tabId, url: details.url });
  });
}

async function applyOnlineState(online, address, context) {
  if (online) {
    await setAllowBypassRules(false);
    await addRedirectSessionRules(address);
  } else {
    await setAllowBypassRules(true);
    // Notify user if transitioning to offline (or unknown->offline)
    if (lastRelayOnline !== false) {
      sendOfflineMessage(context);
    }
  }
  lastRelayOnline = online;
}

async function sendOfflineMessage(context) {
  try {
    const payload = {
      maybeFake: false,
      message: "Proxy error, you will see ads. Is the server running?",
    };
    if (context && typeof context.tabId === "number" && typeof context.url === "string") {
      if (!/^https:\/\/([^.]+\.)?twitch\.tv\//.test(context.url)) return;
      try {
        await chrome.tabs.sendMessage(context.tabId, payload);
      } catch (_) {
        // Retry shortly in case the content script hasn't loaded yet
        setTimeout(() => {
          chrome.tabs.sendMessage(context.tabId, payload).catch(() => {});
        }, 500);
      }
      return;
    }
    // Broadcast to all Twitch tabs
    const tabs = await chrome.tabs.query({ url: ["https://*.twitch.tv/*"] });
    for (const t of tabs) {
      if (!t.id || typeof t.url !== "string") continue;
      try {
        await chrome.tabs.sendMessage(t.id, payload);
      } catch (_) {
        // Best-effort, ignore
      }
    }
  } catch (_) {}
}

// Also notify after a tab finishes loading Twitch while offline,
// in case the transition notification happened before the content script loaded.
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    try {
      if (changeInfo.status !== "complete") return;
      const url = typeof tab?.url === "string" ? tab.url : "";
      if (!isTwitchNavigation(url)) return;
      if (lastRelayOnline === false) {
        sendOfflineMessage({ tabId, url });
      }
    } catch (_) {}
  });
}

