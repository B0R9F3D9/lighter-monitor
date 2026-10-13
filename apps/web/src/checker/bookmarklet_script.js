/* oxlint-disable no-underscore-dangle, no-unmodified-loop-condition, unicorn/consistent-function-scoping */
(function () {
  // 1. Wrong tab check: verify the user is actually on a Lighter website
  const host = window.location.hostname || "";
  const isLighterHost =
    host.endsWith("lighter.xyz") || host.includes("robinhood") || host.includes("lighter");
  if (!isLighterHost) {
    const where = host || "this local page";
    alert(
      "Wrong tab — this ran on " +
        where +
        ".\n\n" +
        "A bookmarklet acts on the page you are currently viewing.\n" +
        "Please switch to your Lighter tab (e.g. app.lighter.xyz or robinhoodchain.lighter.xyz), then click the bookmark.",
    );
    return;
  }

  // 2. Clean up any existing instance or HUD element
  const prevHud = document.getElementById("lighter-trade-exporter-hud");
  if (prevHud) {
    try {
      prevHud.remove();
    } catch {}
  }
  delete window.__LIGHTER_EXPORTER_ACTIVE__;
  window.__LIGHTER_EXPORTER_ACTIVE__ = true;

  const isRh = host.includes("rh") || host.includes("robinhood");
  const defaultNetwork = isRh ? "rh" : "mainnet";
  // Robinhood DEX API is hosted on api.rh.lighter.xyz, mainnet on mainnet.zklighter.elliot.ai
  const apiBase = isRh
    ? "https://api.rh.lighter.xyz/api/v1"
    : "https://mainnet.zklighter.elliot.ai/api/v1";

  // Safety ceiling: prevent runaway pagination and browser tab memory overflow (OOM)
  const ROW_CAP = 150000;
  const PAGE_LIMIT = 100;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let detectedAuth = "";
  let detectedAccount = "";
  let detectedApiKeyIndex = 0;

  // 2. Comprehensive credential & account resolution
  function detectAccountIndex() {
    try {
      // Priority A: lastAccountIndex from localStorage
      const lastAcc = localStorage.getItem("lastAccountIndex");
      if (lastAcc) {
        try {
          const parsed = JSON.parse(lastAcc);
          if (parsed !== null && parsed !== undefined && String(parsed).trim() !== "") {
            return String(parsed);
          }
        } catch {
          if (/^\d+$/.test(lastAcc)) return lastAcc;
        }
      }

      // Priority B: overriddenAccountIndex
      const ovrAcc = localStorage.getItem("overriddenAccountIndex");
      if (ovrAcc) {
        try {
          const parsed = JSON.parse(ovrAcc);
          if (parsed !== null && parsed !== undefined) return String(parsed);
        } catch {
          if (/^\d+$/.test(ovrAcc)) return ovrAcc;
        }
      }

      // Priority C: signature_v5 keys (contains account index as top-level keys)
      const sigV5 = localStorage.getItem("signature_v5");
      if (sigV5) {
        try {
          const parsed = JSON.parse(sigV5);
          if (parsed && typeof parsed === "object") {
            const keys = Object.keys(parsed).filter((k) => /^\d+$/.test(k));
            if (keys.length > 0) return keys[0];
          }
        } catch {}
      }

      // Priority D: Scan storage for account index
      for (const storage of [window.localStorage, window.sessionStorage]) {
        if (!storage) continue;
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (!k) continue;
          const v = storage.getItem(k);
          if (!v) continue;
          const lowerK = k.toLowerCase();
          if (
            (lowerK.includes("account_index") || lowerK.includes("accountindex")) &&
            /^\d+$/.test(v)
          ) {
            return v;
          }
          if (v.startsWith("{") || v.startsWith("[")) {
            try {
              const p = JSON.parse(v);
              if (p?.account_index && /^\d+$/.test(String(p.account_index)))
                return String(p.account_index);
              if (p?.accountIndex && /^\d+$/.test(String(p.accountIndex)))
                return String(p.accountIndex);
              if (p?.index && typeof p.index === "number") return String(p.index);
            } catch {}
          }
        }
      }

      // Priority E: DOM heuristics (e.g. Account #31704 or #31704)
      const domText = document.body ? document.body.innerText || "" : "";
      const m = domText.match(/Account\s*#?\s*(\d{2,9})/i) || domText.match(/#(\d{4,9})/);
      if (m && m[1]) return m[1];
    } catch (e) {
      console.warn("[Lighter Exporter] detectAccountIndex error:", e);
    }
    return "";
  }

  function detectApiKeyIndex() {
    try {
      const stored = localStorage.getItem("apiKeyIndex");
      if (stored) {
        const p = JSON.parse(stored);
        if (typeof p === "number" && !isNaN(p)) return p;
      }
    } catch {}
    return 0; // Default desktop apiKeyIndex is 0
  }

  async function resolveAuthToken(accountIndex, apiKeyIndex) {
    const accNum = Number(accountIndex);
    const keyIdx = Number(apiKeyIndex || 0);

    // Strategy 1: Direct window._createAuthToken (provided by Lighter Go WebAssembly)
    if (typeof window._createAuthToken === "function") {
      try {
        const raw = window._createAuthToken(accNum, keyIdx);
        const res = typeof raw === "function" ? await raw() : await raw;
        if (res && typeof res === "object") {
          if (res.token) return res.token;
          if (res.error) console.warn("[Lighter Exporter] _createAuthToken error:", res.error);
        } else if (typeof res === "string" && res) {
          return res;
        }
      } catch (e) {
        console.warn("[Lighter Exporter] Direct _createAuthToken failed:", e);
      }
    }

    // Strategy 2: If WASM client not initialized, initialize via window._createClient from signature_v5
    if (
      typeof window._createClient === "function" &&
      typeof window._createAuthToken === "function"
    ) {
      try {
        const sigRaw = localStorage.getItem("signature_v5");
        if (sigRaw) {
          const sigData = JSON.parse(sigRaw);
          const accData =
            sigData[accountIndex] || sigData[String(accountIndex)] || Object.values(sigData)[0];
          const seedObj = accData?.seed
            ? accData
            : accData?.[keyIdx] || accData?.legacy || Object.values(accData || {})[0];

          if (seedObj && seedObj.seed) {
            const chainId = isRh ? 466324 : 300;
            const initRaw = window._createClient(seedObj.seed, chainId, accNum, 0, keyIdx, true);
            if (typeof initRaw === "function") await initRaw();
            else await initRaw;

            // Retry _createAuthToken after client initialization
            const raw = window._createAuthToken(accNum, keyIdx);
            const res = typeof raw === "function" ? await raw() : await raw;
            if (res && typeof res === "object" && res.token) return res.token;
            if (typeof res === "string" && res) return res;
          }
        }
      } catch (e) {
        console.warn("[Lighter Exporter] _createClient initialization failed:", e);
      }
    }

    // Strategy 3: Check localStorage auth_token
    const directAuth = localStorage.getItem("auth_token");
    if (directAuth) return directAuth;

    // Strategy 4: Storage scan for canonical Lighter token formats
    for (const storage of [window.localStorage, window.sessionStorage]) {
      if (!storage) continue;
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k) continue;
        const v = storage.getItem(k);
        if (!v) continue;
        if (/^\d+:\d+:\d+:[a-fA-F0-9]+$/.test(v) || /^ro:\d+:[^:]+:\d+:[a-fA-F0-9]+$/.test(v)) {
          return v;
        }
        if (v.startsWith("{")) {
          try {
            const p = JSON.parse(v);
            if (p?.token && typeof p.token === "string") return p.token;
            if (p?.authToken && typeof p.authToken === "string") return p.authToken;
            if (p?.auth && typeof p.auth === "string") return p.auth;
          } catch {}
        }
      }
    }

    return "";
  }

  // 3. Week and Campaign calculation helper (Friday 00:00:00.000 UTC snapshot boundaries)
  function getWeekRange(nowMs) {
    const now = nowMs || Date.now();
    const MS_PER_DAY = 86400000;
    const MS_PER_WEEK = 7 * MS_PER_DAY;
    const PROMO_START_MS = 1786320000000; // Date.parse("2026-08-10T00:00:00.000Z")
    const W1_END_MS = 1787270400000; // Date.parse("2026-08-21T00:00:00.000Z")

    let curStart = PROMO_START_MS;
    let curEnd = W1_END_MS;
    for (let w = 1; w <= 20; w++) {
      if (now >= curStart && now < curEnd) {
        const prevStart = w === 1 ? null : w === 2 ? PROMO_START_MS : curStart - MS_PER_WEEK;
        const prevEnd = w === 1 ? null : curStart;
        return {
          thisWeekStart: curStart,
          thisWeekEnd: curEnd,
          weekNumber: w,
          prevWeekStart: prevStart,
          prevWeekEnd: prevEnd,
          prevWeekNumber: w > 1 ? w - 1 : null,
        };
      }
      curStart = curEnd;
      curEnd = curStart + MS_PER_WEEK;
    }

    const d = new Date(now);
    const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 5 = Fri, 6 = Sat
    const daysSinceFriday = (day - 5 + 7) % 7;
    const thisFridayStart = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - daysSinceFriday,
      0,
      0,
      0,
      0,
    );
    return {
      thisWeekStart: thisFridayStart,
      thisWeekEnd: thisFridayStart + MS_PER_WEEK,
      weekNumber: null,
      prevWeekStart: thisFridayStart - MS_PER_WEEK,
      prevWeekEnd: thisFridayStart,
      prevWeekNumber: null,
    };
  }

  // 4. Build Floating Dark HUD Modal
  const hud = document.createElement("div");
  hud.id = "lighter-trade-exporter-hud";
  hud.style.cssText =
    "position:fixed;bottom:20px;right:20px;width:330px;background:#121417;border:1px solid #1f2328;border-radius:6px;padding:12px 14px;box-shadow:0 12px 32px rgba(0,0,0,0.8);z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;color:#f0f6fc;font-size:11px;line-height:1.4;box-sizing:border-box;";

  hud.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #1f2328;padding-bottom:8px;">
      <span style="font-size:11px;font-weight:700;letter-spacing:0.5px;color:#fff;text-transform:uppercase;">Lighter Trade Exporter</span>
      <button id="lte-close-btn" style="background:transparent;border:0;color:#6e7681;cursor:pointer;font-size:14px;padding:0;margin-left:auto;line-height:1;" title="Close and unload exporter (Esc)">✕</button>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 6px 0;font-family:monospace;font-size:11px;">
      <div>
        <span style="color:#6e7681;">Account:</span>
        <span id="lte-account-val" style="font-weight:bold;color:#fff;">Detecting...</span>
        <span style="color:#6e7681;">• ${isRh ? "RH" : "Mainnet"}</span>
      </div>
      <span id="lte-auth-badge" style="color:#d29922;font-size:10px;font-weight:600;">Checking auth...</span>
    </div>

    <label id="lte-funding-wrap" style="display:inline-flex;align-items:center;gap:6px;margin:6px 0 8px 0;cursor:pointer;user-select:none;font-size:11px;color:#c9d1d9;">
      <input type="checkbox" id="lte-funding-chk" checked style="accent-color:#238636;cursor:pointer;margin:0;width:12px;height:12px;">
      <span>Include funding</span>
    </label>

    <div id="lte-progress-bar-wrap" style="display:none;margin-bottom:8px;background:#21262d;border-radius:2px;height:4px;overflow:hidden;">
      <div id="lte-progress-bar" style="background:#2ea043;height:100%;width:0%;transition:width 0.2s;"></div>
    </div>

    <div id="lte-status" style="font-size:11px;color:#8b949e;margin-bottom:8px;font-family:monospace;min-height:15px;line-height:1.4;">
      Connecting to session in browser...
    </div>

    <div id="lte-btn-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      <button id="lte-this-week-btn" style="background:#238636;color:#fff;border:0;border-radius:4px;padding:6px 6px;font-weight:600;font-size:11px;cursor:pointer;transition:background 0.15s,opacity 0.15s;opacity:0.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;" disabled title="Export trades for this week (starts Friday 00:00 UTC)">
        This Week (Fri)
      </button>
      <button id="lte-prev-week-btn" style="background:#238636;color:#fff;border:0;border-radius:4px;padding:6px 6px;font-weight:600;font-size:11px;cursor:pointer;transition:background 0.15s,opacity 0.15s;opacity:0.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;" disabled title="Export trades for previous week (Fri to Fri 00:00 UTC)">
        Prev Week
      </button>
      <button id="lte-last24h-btn" style="background:#238636;color:#fff;border:0;border-radius:4px;padding:6px 6px;font-weight:600;font-size:11px;cursor:pointer;transition:background 0.15s,opacity 0.15s;opacity:0.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;" disabled title="Export trades for the last 24 hours">
        Last 24 Hours
      </button>
      <button id="lte-last100-btn" style="background:#238636;color:#fff;border:0;border-radius:4px;padding:6px 6px;font-weight:600;font-size:11px;cursor:pointer;transition:background 0.15s,opacity 0.15s;opacity:0.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;" disabled title="Export only the last 100 trades">
        Export Last 100
      </button>
      <button id="lte-start-btn" style="grid-column:span 2;background:#238636;color:#fff;border:0;border-radius:4px;padding:6px 8px;font-weight:600;font-size:11px;cursor:pointer;transition:background 0.15s,opacity 0.15s;opacity:0.6;white-space:nowrap;text-align:center;" disabled title="Export complete trade history (up to 150,000)">
        Export All History
      </button>
    </div>

    <button id="lte-stop-btn" style="display:none;width:100%;background:#da3633;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-weight:600;font-size:11px;cursor:pointer;text-align:center;">
      Stop Export
    </button>
  `;

  document.body.appendChild(hud);

  const btnGrid = hud.querySelector("#lte-btn-grid");
  const thisWeekBtn = hud.querySelector("#lte-this-week-btn");
  const prevWeekBtn = hud.querySelector("#lte-prev-week-btn");
  const last24hBtn = hud.querySelector("#lte-last24h-btn");
  const last100Btn = hud.querySelector("#lte-last100-btn");
  const startBtn = hud.querySelector("#lte-start-btn");
  const stopBtn = hud.querySelector("#lte-stop-btn");
  const closeBtn = hud.querySelector("#lte-close-btn");
  const statusDiv = hud.querySelector("#lte-status");
  const progressWrap = hud.querySelector("#lte-progress-bar-wrap");
  const progressBar = hud.querySelector("#lte-progress-bar");
  const accountValSpan = hud.querySelector("#lte-account-val");
  const authBadgeSpan = hud.querySelector("#lte-auth-badge");
  const fundingWrap = hud.querySelector("#lte-funding-wrap");
  const fundingChk = hud.querySelector("#lte-funding-chk");

  const actionButtons = [thisWeekBtn, prevWeekBtn, last24hBtn, last100Btn, startBtn];
  for (const btn of actionButtons) {
    btn.addEventListener("mouseenter", () => {
      if (!btn.disabled && !isRunning) btn.style.background = "#2ea043";
    });
    btn.addEventListener("mouseleave", () => {
      if (!btn.disabled && !isRunning) {
        btn.style.background = btn === startBtn && !detectedAuth ? "#d29922" : "#238636";
      }
    });
  }

  stopBtn.addEventListener("mouseenter", () => {
    stopBtn.style.background = "#b62324";
  });
  stopBtn.addEventListener("mouseleave", () => {
    stopBtn.style.background = "#da3633";
  });

  let isRunning = false;
  let isCancelled = false;
  let isClosed = false;
  let abortController = new AbortController();

  function destroyHud() {
    isClosed = true;
    isCancelled = true;
    try {
      abortController.abort();
    } catch {}
    window.removeEventListener("keydown", onKeyDown);
    try {
      hud.remove();
    } catch {}
    const oldHud = document.getElementById("lighter-trade-exporter-hud");
    if (oldHud) {
      try {
        oldHud.remove();
      } catch {}
    }
    delete window.__LIGHTER_EXPORTER_ACTIVE__;
    window.__LIGHTER_EXPORTER_ACTIVE__ = false;
  }

  closeBtn.addEventListener("click", destroyHud);

  function onKeyDown(e) {
    if (e.key === "Escape" && !isClosed) {
      destroyHud();
    }
  }
  window.addEventListener("keydown", onKeyDown);

  stopBtn.addEventListener("click", function () {
    isCancelled = true;
    statusDiv.style.color = "#d29922";
    statusDiv.textContent = "Cancelling... saving collected trades.";
  });

  async function refreshCredentials() {
    detectedAccount = detectAccountIndex();
    detectedApiKeyIndex = detectApiKeyIndex();

    if (detectedAccount) {
      accountValSpan.textContent = "#" + detectedAccount;
      accountValSpan.style.color = "#fff";
      detectedAuth = await resolveAuthToken(detectedAccount, detectedApiKeyIndex);
    } else {
      accountValSpan.textContent = "--";
      accountValSpan.style.color = "#f85149";
      detectedAuth = "";
    }

    const wInfo = getWeekRange();

    if (detectedAuth) {
      authBadgeSpan.textContent = "● Ready";
      authBadgeSpan.style.color = "#2ea043";
      statusDiv.style.color = "#8b949e";
      statusDiv.textContent = "Ready to export trades for Account #" + detectedAccount;

      if (wInfo.weekNumber) {
        thisWeekBtn.textContent = "This Week (W" + wInfo.weekNumber + ")";
        thisWeekBtn.title =
          "Export trades for this week (W" + wInfo.weekNumber + ", starts Friday 00:00 UTC)";
        if (wInfo.prevWeekNumber) {
          prevWeekBtn.textContent = "Prev Week (W" + wInfo.prevWeekNumber + ")";
          prevWeekBtn.title =
            "Export trades for previous week (W" +
            wInfo.prevWeekNumber +
            ", Friday to Friday 00:00 UTC)";
        }
      } else {
        thisWeekBtn.textContent = "This Week (Fri)";
        thisWeekBtn.title = "Export trades for current week (starts Friday 00:00 UTC)";
        prevWeekBtn.textContent = "Prev Week";
        prevWeekBtn.title = "Export trades for previous week (Friday to Friday 00:00 UTC)";
      }

      startBtn.textContent = "Export All History";
      for (const btn of actionButtons) {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.background = "#238636";
      }
    } else {
      authBadgeSpan.textContent = "● Key Missing";
      authBadgeSpan.style.color = "#f85149";
      statusDiv.style.color = "#f85149";
      if (!detectedAccount) {
        statusDiv.textContent = "Account not found. Connect wallet on Lighter and re-scan.";
      } else {
        statusDiv.textContent =
          "API key not found. Refresh tab (F5) or place an order to unlock session.";
      }

      for (const btn of [thisWeekBtn, prevWeekBtn, last24hBtn, last100Btn]) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }
      startBtn.textContent = "Re-scan Session";
      startBtn.style.background = "#d29922";
      startBtn.style.opacity = "1";
      startBtn.disabled = false;
    }
  }

  // Initial async resolution
  refreshCredentials();

  function getWafToken() {
    try {
      if (document.cookie && document.cookie.includes("aws-waf-token=")) {
        const m = document.cookie.match(/aws-waf-token=([^;]+)/);
        return m && m[1] ? m[1] : "";
      }
    } catch {}
    return "";
  }

  // 4. Fetch with Exponential Backoff Retry and 429 Rate Limit cooldown
  async function fetchWithRetry(url, options) {
    for (let attempt = 0; ; attempt++) {
      if (isCancelled || isClosed) throw new Error("Export cancelled by user");
      let res;
      try {
        res = await fetch(url, {
          ...options,
          signal: abortController.signal,
        });
      } catch (err) {
        if (isCancelled || isClosed || err?.name === "AbortError") {
          throw new Error("Export cancelled by user", { cause: err });
        }
        if (attempt < 3 && !isCancelled && !isClosed) {
          statusDiv.style.color = "#d29922";
          statusDiv.textContent =
            "Network glitch, retrying in " + ((attempt + 1) * 0.8).toFixed(1) + "s...";
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw new Error(
          "Network error connecting to Lighter API: " +
            (err && typeof err === "object" && "message" in err ? err.message : String(err)),
          { cause: err },
        );
      }

      if (res.status === 429 && attempt < 3 && !isCancelled) {
        statusDiv.style.color = "#d29922";
        statusDiv.textContent =
          "Rate limited by Lighter (429), cooling down " +
          ((attempt + 1) * 1.5).toFixed(1) +
          "s...";
        await sleep(1500 * (attempt + 1));
        continue;
      }

      if (res.status === 403 && attempt < 2 && !isCancelled) {
        const freshWaf = getWafToken();
        if (freshWaf && freshWaf !== (options.headers && options.headers["x-aws-waf-token"])) {
          if (options.headers) options.headers["x-aws-waf-token"] = freshWaf;
          statusDiv.style.color = "#d29922";
          statusDiv.textContent = "WAF token refreshed, retrying...";
          await sleep(600);
          continue;
        }
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "Authentication failed (HTTP " +
            res.status +
            "). Session token might have expired. Refresh your tab and re-run.",
        );
      }

      if (!res.ok) {
        if (attempt < 3 && res.status >= 500 && !isCancelled) {
          statusDiv.style.color = "#d29922";
          statusDiv.textContent = "Lighter server error (" + res.status + "), retrying...";
          await sleep(1000 * (attempt + 1));
          continue;
        }
        const errText = await res.text().catch(() => "");
        throw new Error("HTTP " + res.status + (errText ? ": " + errText.slice(0, 100) : ""));
      }

      return res;
    }
  }

  // 5. Slimming / Payload Trimming: keep only fields required by checker (monomorphic shape for V8)
  function slimTrade(t) {
    const tid = t.trade_id;
    const askId = t.ask_id;
    const bidId = t.bid_id;

    return {
      trade_id: tid,
      trade_id_str: t.trade_id_str || (tid != null ? "" + tid : ""),
      tx_hash: t.tx_hash || "",
      type: t.type || "trade",
      market_id: t.market_id,
      market_kind: t.market_kind || "perps",
      size: t.size,
      price: t.price,
      usd_amount: t.usd_amount,
      ask_account_id: t.ask_account_id,
      bid_account_id: t.bid_account_id,
      is_maker_ask: !!t.is_maker_ask,
      block_height: t.block_height,
      timestamp: t.timestamp,
      taker_fee: t.taker_fee ?? 0,
      maker_fee: t.maker_fee ?? 0,
      ask_id: askId ?? 0,
      ask_id_str: t.ask_id_str || (askId != null ? "" + askId : ""),
      bid_id: bidId ?? 0,
      bid_id_str: t.bid_id_str || (bidId != null ? "" + bidId : ""),
      ask_client_id: t.ask_client_id ?? 0,
      bid_client_id: t.bid_client_id ?? 0,
      transaction_time: t.transaction_time ?? 0,
      ask_account_pnl: t.ask_account_pnl ?? null,
      bid_account_pnl: t.bid_account_pnl ?? null,
    };
  }

  async function runExport(options) {
    if (isRunning) return;

    if (!detectedAccount || !detectedAuth) {
      statusDiv.textContent = "Re-scanning session credentials...";
      await refreshCredentials();
      if (!detectedAccount || !detectedAuth) return;
    }

    const opts =
      typeof options === "number"
        ? { targetCap: options, mode: options === 100 ? "last100" : "all" }
        : options || {};
    const targetCap = opts.targetCap || ROW_CAP;
    const sinceTimestampMs = opts.sinceTimestampMs || null;
    const untilTimestampMs = opts.untilTimestampMs || null;
    const mode = opts.mode || (targetCap === 100 ? "last100" : "all");
    const modeLabel = opts.modeLabel || (mode === "last100" ? "Last 100" : "All Trades");
    const isLimit100 = mode === "last100";
    const includeFunding = Boolean(fundingChk && fundingChk.checked);
    const acc = detectedAccount;
    const auth = detectedAuth;

    isRunning = true;
    isCancelled = false;
    abortController = new AbortController();

    btnGrid.style.display = "none";
    stopBtn.style.display = "block";
    if (fundingChk) fundingChk.disabled = true;
    if (fundingWrap) {
      fundingWrap.style.opacity = "0.6";
      fundingWrap.style.cursor = "default";
    }

    progressWrap.style.display = "block";
    progressBar.style.width = isLimit100 ? "10%" : "4%";
    statusDiv.style.color = "#58a6ff";
    statusDiv.textContent = isLimit100
      ? "Fetching last 100 trades..."
      : "Connecting to " + apiBase + " (" + modeLabel + ")...";

    // 1. Precomputed URL bases without cursor to eliminate repeated concatenations in loop
    const urlBase =
      apiBase +
      "/trades?market_type=all&account_index=" +
      encodeURIComponent(acc) +
      "&sort_by=timestamp&sort_dir=desc&ask_filter=-1&role=all&type=all&limit=" +
      PAGE_LIMIT +
      "&aggregate=false";
    const urlWithCursorBase = urlBase + "&cursor=";

    // 2. Preallocated reusable request headers & options (zero GC churn per page)
    const reqHeaders = {
      Accept: "application/json",
      Authorization: auth,
      PreferAuthServer: "true",
    };
    const wafToken = getWafToken();
    if (wafToken) {
      reqHeaders["x-aws-waf-token"] = wafToken;
    }
    const fetchOptions = {
      headers: reqHeaders,
      credentials: "omit",
      signal: abortController.signal,
    };

    // 3. Chunked streaming to Blob: index 0 reserved for JSON metadata header
    const tradeChunks = [""];
    const seenIds = new Set();
    let totalTradesCount = 0;
    let cursor = "";
    let page = 0;
    const startTime = Date.now();
    let lastUiUpdate = 0;
    let hasMoreAfterCap = false;

    // 4. Prefetch Pipeline: launch page 1 immediately
    let currentFetchPromise = fetchWithRetry(urlBase, fetchOptions).catch((err) => {
      if (isCancelled || isClosed || totalTradesCount >= targetCap) return null;
      throw err;
    });

    try {
      while (!isCancelled && !isClosed && currentFetchPromise && totalTradesCount < targetCap) {
        page++;

        // Await in-flight network response
        const res = await currentFetchPromise;
        if (!res || isCancelled || isClosed) break;

        const data = await res.json();
        if (data.code !== 200 && data.code !== undefined && data.code !== 0) {
          throw new Error(data.message || "API Error code: " + data.code);
        }

        const trades = data.trades || [];
        if (trades.length === 0) {
          currentFetchPromise = null;
          break;
        }

        let reachedTradeCutoff = false;
        const pageSlimmed = [];

        for (let i = 0; i < trades.length; i++) {
          const t = trades[i];
          const rawTs = t.timestamp;
          const tMs = rawTs ? (rawTs < 1e11 ? rawTs * 1000 : rawTs) : 0;

          // If filtering until a timestamp (e.g. prev-week before this Friday 00:00 UTC):
          if (untilTimestampMs && tMs >= untilTimestampMs) {
            continue; // Trade is newer than target window, keep paginating backwards
          }

          // If filtering since a timestamp (e.g. this-week since Friday 00:00 UTC):
          if (sinceTimestampMs && tMs < sinceTimestampMs) {
            reachedTradeCutoff = true;
            break; // Since trades are sorted descending, all subsequent trades will be older
          }

          const id = +t.trade_id;
          if (!seenIds.has(id)) {
            seenIds.add(id);
            pageSlimmed.push(slimTrade(t));
            if (totalTradesCount + pageSlimmed.length >= targetCap) {
              if (data.next_cursor || cursor) hasMoreAfterCap = true;
              break;
            }
          }
        }

        if (pageSlimmed.length > 0) {
          // Zero-copy array parts: push comma separately to avoid 15KB string allocation
          const chunkStr = JSON.stringify(pageSlimmed).slice(1, -1);
          if (totalTradesCount > 0) {
            tradeChunks.push(",");
          }
          tradeChunks.push(chunkStr);
          totalTradesCount += pageSlimmed.length;
        }

        // Overlapped Network I/O: prefetch next page only if cutoff not hit and more trades needed
        const nextCursor = data.next_cursor;
        if (
          !reachedTradeCutoff &&
          nextCursor &&
          nextCursor !== cursor &&
          !isCancelled &&
          !isClosed &&
          totalTradesCount < targetCap
        ) {
          cursor = nextCursor;
          currentFetchPromise = fetchWithRetry(
            urlWithCursorBase + encodeURIComponent(nextCursor),
            fetchOptions,
          ).catch((err) => {
            if (isCancelled || isClosed || totalTradesCount >= targetCap) return null;
            throw err;
          });
        } else {
          if (nextCursor && nextCursor !== cursor && !reachedTradeCutoff) {
            hasMoreAfterCap = true;
          }
          currentFetchPromise = null;
        }

        // UI Throttling: Phase 1 (Trades) occupies 0% -> (includeFunding ? 48% : 88%)
        const now = Date.now();
        if (now - lastUiUpdate > 200) {
          lastUiUpdate = now;
          const maxPercent = includeFunding ? 48 : 88;
          const estProgress = isLimit100
            ? Math.min(maxPercent, Math.round((totalTradesCount / 100) * 44) + 4)
            : Math.min(maxPercent, 4 + Math.round((1 - Math.exp(-page / 6)) * (maxPercent - 4)));
          progressBar.style.width = estProgress + "%";
          statusDiv.textContent = isLimit100
            ? "Fetching trades: " + totalTradesCount + "/100..."
            : "Fetching trades: page " +
              page +
              " (" +
              totalTradesCount.toLocaleString() +
              " trades)...";
        }

        if (reachedTradeCutoff) break;
      }

      // Immediately release Set memory before finalizing export
      seenIds.clear();

      if (isClosed || isCancelled) {
        tradeChunks.length = 0;
        return;
      }

      if (totalTradesCount === 0) {
        tradeChunks.length = 0;
        progressBar.style.width = "100%";
        statusDiv.style.color = "#d29922";
        statusDiv.textContent = isCancelled
          ? "Export cancelled."
          : "No trades found for Account #" + acc + " (" + modeLabel + ").";
      } else {
        let accountPositions = null;
        let accountFunding = null;
        const fundingRecords = [];

        if (includeFunding) {
          progressBar.style.width = "50%";
          statusDiv.style.color = "#8b949e";
          statusDiv.textContent =
            "Trades fetched (" +
            totalTradesCount.toLocaleString() +
            "). Fetching position funding history...";

          // Fetch account positions and funding summary
          try {
            const accRes = await fetch(apiBase + "/account?by=index&value=" + acc, {
              signal: abortController.signal,
            });
            if (accRes.ok) {
              const accData = await accRes.json();
              const accObj = accData?.account || accData?.sub_accounts?.[0] || accData;
              if (accObj?.positions && Array.isArray(accObj.positions)) {
                accountPositions = accObj.positions;
                let totFund = 0;
                const byMarket = {};
                for (const p of accountPositions) {
                  const sym = String(
                    p.symbol || p.market_symbol || p.market_id || "",
                  ).toUpperCase();
                  const paid = Number(p.total_funding_paid_out) || 0;
                  totFund += paid;
                  if (sym) {
                    byMarket[sym] = (byMarket[sym] || 0) + paid;
                  }
                }
                accountFunding = {
                  totalFundingUsd: totFund,
                  byMarketUsd: byMarket,
                  positions: accountPositions,
                };
              }
            }
          } catch {}

          // Fetch hourly position funding history (requires auth)
          // Phase 2 (Funding): advances smoothly from 50% up to 96%
          try {
            let fundCursor = "";
            let fundPage = 0;
            const maxFundPages = 50; // up to 5,000 hourly funding records
            while (fundPage < maxFundPages && !isCancelled && !isClosed) {
              fundPage++;
              const fundUrl =
                apiBase +
                "/positionFunding?account_index=" +
                acc +
                "&limit=100" +
                (fundCursor ? "&cursor=" + encodeURIComponent(fundCursor) : "");
              const fRes = await fetchWithRetry(fundUrl, fetchOptions).catch(() => null);
              if (!fRes || !fRes.ok || isCancelled || isClosed) break;
              const fData = await fRes.json().catch(() => null);
              if (!fData || (fData.code !== 200 && fData.code !== 0 && fData.code !== undefined))
                break;
              const list = fData.position_fundings || fData.data || fData.funding_history || [];
              if (!Array.isArray(list) || list.length === 0) break;

              let reachedFundingCutoff = false;
              for (let i = 0; i < list.length; i++) {
                const item = list[i];
                const rawFTs = item.timestamp;
                const fTs = rawFTs ? (rawFTs < 1e11 ? rawFTs * 1000 : rawFTs) : 0;
                if (sinceTimestampMs && fTs && fTs < sinceTimestampMs) {
                  reachedFundingCutoff = true;
                  continue;
                }
                if (untilTimestampMs && fTs && fTs >= untilTimestampMs) {
                  continue;
                }
                fundingRecords.push(item);
              }

              const fundProgress = Math.min(
                96,
                50 + Math.round((1 - Math.exp(-fundPage / 6)) * 46),
              );
              progressBar.style.width = fundProgress + "%";
              statusDiv.textContent =
                "Fetching funding: page " +
                fundPage +
                " (" +
                fundingRecords.length.toLocaleString() +
                " records)...";

              if (reachedFundingCutoff) break;

              const nextCur = fData.next_cursor || fData.cursor;
              if (!nextCur || nextCur === fundCursor) break;
              fundCursor = nextCur;
            }
          } catch (e) {
            if (!isCancelled && !isClosed) {
              console.warn("[Lighter Exporter] positionFunding fetch error:", e);
            }
          }
        } else {
          progressBar.style.width = "92%";
          statusDiv.style.color = "#8b949e";
          statusDiv.textContent =
            "Trades fetched (" +
            totalTradesCount.toLocaleString() +
            "). Packaging JSON (funding skipped)...";
        }

        if (isClosed || isCancelled) {
          tradeChunks.length = 0;
          return;
        }

        progressBar.style.width = "98%";
        statusDiv.textContent = "Packaging JSON export file...";

        // Zero-copy Blob assembly: header placed at index 0 without running massive JSON.stringify
        const isTruncated = totalTradesCount >= targetCap && (hasMoreAfterCap || Boolean(cursor));
        const headerJson =
          JSON.stringify({
            version: "1.0",
            exported_at: new Date().toISOString(),
            exported_at_unix: Date.now(),
            network: defaultNetwork,
            network_name: isRh ? "Robinhood Chain (RH)" : "Lighter Mainnet (Core)",
            account_index: Number(acc),
            total_trades: totalTradesCount,
            truncated: isTruncated,
            row_cap: targetCap,
            filter_mode: mode,
            filter_since_ms: sinceTimestampMs || undefined,
            filter_until_ms: untilTimestampMs || undefined,
            week_number: opts.weekNumber || undefined,
            positions: accountPositions || undefined,
            funding: accountFunding || undefined,
            funding_history: fundingRecords.length > 0 ? fundingRecords : undefined,
          }).slice(0, -1) + ',"trades":[';

        tradeChunks[0] = headerJson;
        tradeChunks.push("]}");

        const blob = new Blob(tradeChunks, {
          type: "application/json;charset=utf-8",
        });

        // Release references to chunk strings immediately
        tradeChunks.length = 0;

        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const dateStr = new Date().toISOString().slice(0, 10);
        a.href = dlUrl;
        const fileSuffix = opts.fileSuffix || (isLimit100 ? "-last100-" : "-");
        a.download =
          "lighter-trades-" + defaultNetwork + "-acc" + acc + fileSuffix + dateStr + ".json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(dlUrl), 15000);

        progressBar.style.width = "100%";
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
        statusDiv.style.color = "#2ea043";

        const fundCountStr =
          fundingRecords.length > 0
            ? " & " + fundingRecords.length.toLocaleString() + " funding records"
            : includeFunding
              ? ""
              : " (funding skipped)";

        if (isLimit100) {
          statusDiv.textContent =
            totalTradesCount.toLocaleString() +
            " recent trades" +
            fundCountStr +
            " exported (" +
            durationSec +
            "s). File downloaded.";
        } else if (isTruncated) {
          statusDiv.style.color = "#d29922";
          statusDiv.textContent =
            "Capped at " +
            ROW_CAP.toLocaleString() +
            " trades (" +
            durationSec +
            "s). Earliest history truncated.";
        } else {
          statusDiv.textContent =
            totalTradesCount.toLocaleString() +
            " trades" +
            fundCountStr +
            " exported (" +
            durationSec +
            "s). File downloaded.";
        }
      }
    } catch (err) {
      if (!isClosed) {
        console.error("[Lighter Exporter]", err);
        statusDiv.style.color = "#f85149";
        statusDiv.textContent = "Error: " + (err.message || String(err));
      }
    } finally {
      isRunning = false;
      isCancelled = false;
      seenIds.clear();
      tradeChunks.length = 0;
      if (!isClosed) {
        btnGrid.style.display = "grid";
        stopBtn.style.display = "none";
        if (fundingChk) fundingChk.disabled = false;
        if (fundingWrap) {
          fundingWrap.style.opacity = "1";
          fundingWrap.style.cursor = "pointer";
        }
        await refreshCredentials();
      }
    }
  }

  startBtn.addEventListener("click", async function () {
    if (isRunning) return;
    if (!detectedAccount || !detectedAuth) {
      statusDiv.textContent = "Re-scanning session credentials...";
      await refreshCredentials();
      if (!detectedAccount || !detectedAuth) return;
    }
    await runExport({
      targetCap: ROW_CAP,
      sinceTimestampMs: null,
      untilTimestampMs: null,
      mode: "all",
      modeLabel: "All Trades",
      fileSuffix: "-",
    });
  });

  thisWeekBtn.addEventListener("click", async function () {
    if (isRunning) return;
    if (!detectedAccount || !detectedAuth) {
      statusDiv.textContent = "Re-scanning session credentials...";
      await refreshCredentials();
      if (!detectedAccount || !detectedAuth) return;
    }
    const wInfo = getWeekRange();
    const label = wInfo.weekNumber ? "Week " + wInfo.weekNumber : "This Week";
    await runExport({
      targetCap: ROW_CAP,
      sinceTimestampMs: wInfo.thisWeekStart,
      untilTimestampMs: null,
      mode: "this-week",
      modeLabel: "This Week (" + label + ")",
      fileSuffix: "-this-week" + (wInfo.weekNumber ? "-w" + wInfo.weekNumber : "") + "-",
      weekNumber: wInfo.weekNumber,
    });
  });

  prevWeekBtn.addEventListener("click", async function () {
    if (isRunning) return;
    if (!detectedAccount || !detectedAuth) {
      statusDiv.textContent = "Re-scanning session credentials...";
      await refreshCredentials();
      if (!detectedAccount || !detectedAuth) return;
    }
    const wInfo = getWeekRange();
    const label = wInfo.prevWeekNumber ? "Week " + wInfo.prevWeekNumber : "Previous Week";
    await runExport({
      targetCap: ROW_CAP,
      sinceTimestampMs: wInfo.prevWeekStart,
      untilTimestampMs: wInfo.prevWeekEnd,
      mode: "prev-week",
      modeLabel: "Prev Week (" + label + ")",
      fileSuffix: "-prev-week" + (wInfo.prevWeekNumber ? "-w" + wInfo.prevWeekNumber : "") + "-",
      weekNumber: wInfo.prevWeekNumber,
    });
  });

  last24hBtn.addEventListener("click", async function () {
    if (isRunning) return;
    if (!detectedAccount || !detectedAuth) {
      statusDiv.textContent = "Re-scanning session credentials...";
      await refreshCredentials();
      if (!detectedAccount || !detectedAuth) return;
    }
    await runExport({
      targetCap: ROW_CAP,
      sinceTimestampMs: Date.now() - 24 * 3600 * 1000,
      untilTimestampMs: null,
      mode: "24h",
      modeLabel: "Last 24 Hours",
      fileSuffix: "-24h-",
    });
  });

  last100Btn.addEventListener("click", async function () {
    if (isRunning) return;
    if (!detectedAccount || !detectedAuth) {
      statusDiv.textContent = "Re-scanning session credentials...";
      await refreshCredentials();
      if (!detectedAccount || !detectedAuth) return;
    }
    await runExport({
      targetCap: 100,
      sinceTimestampMs: null,
      untilTimestampMs: null,
      mode: "last100",
      modeLabel: "Last 100 Trades",
      fileSuffix: "-last100-",
    });
  });
})();
