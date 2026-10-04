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

  if (window.__LIGHTER_EXPORTER_ACTIVE__) {
    alert("Lighter Trade Exporter is already running!");
    return;
  }
  window.__LIGHTER_EXPORTER_ACTIVE__ = true;

  const isRh = host.includes("rh") || host.includes("robinhood");
  const defaultNetwork = isRh ? "rh" : "mainnet";
  // Robinhood DEX API is hosted on api.rh.lighter.xyz, mainnet on mainnet.zklighter.elliot.ai
  const apiBase = isRh
    ? "https://api.rh.lighter.xyz/api/v1"
    : "https://mainnet.zklighter.elliot.ai/api/v1";

  // Safety ceiling: prevent runaway pagination and browser tab memory overflow (OOM)
  const ROW_CAP = 150000;
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

  // 3. Build Floating Dark HUD Modal
  const hud = document.createElement("div");
  hud.id = "lighter-trade-exporter-hud";
  hud.style.cssText =
    "position:fixed;bottom:20px;right:20px;width:320px;background:#121417;border:1px solid #1f2328;border-radius:6px;padding:12px 14px;box-shadow:0 12px 32px rgba(0,0,0,0.8);z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;color:#f0f6fc;font-size:11px;line-height:1.4;box-sizing:border-box;";

  hud.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #1f2328;padding-bottom:8px;">
      <span style="font-size:11px;font-weight:700;letter-spacing:0.5px;color:#fff;text-transform:uppercase;">Lighter Trade Exporter</span>
      <button id="lte-close-btn" style="background:transparent;border:0;color:#6e7681;cursor:pointer;font-size:14px;padding:0;margin-left:auto;line-height:1;">✕</button>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 6px 0;font-family:monospace;font-size:11px;">
      <div>
        <span style="color:#6e7681;">Account:</span>
        <span id="lte-account-val" style="font-weight:bold;color:#fff;">Detecting...</span>
        <span style="color:#6e7681;">• ${isRh ? "RH" : "Mainnet"}</span>
      </div>
      <span id="lte-auth-badge" style="color:#d29922;font-size:10px;font-weight:600;">Checking auth...</span>
    </div>

    <div id="lte-progress-bar-wrap" style="display:none;margin-bottom:8px;background:#21262d;border-radius:2px;height:4px;overflow:hidden;">
      <div id="lte-progress-bar" style="background:#2ea043;height:100%;width:0%;transition:width 0.2s;"></div>
    </div>

    <div id="lte-status" style="font-size:11px;color:#8b949e;margin-bottom:8px;font-family:monospace;min-height:15px;line-height:1.4;">
      Connecting to session in browser...
    </div>

    <div style="display:flex;gap:6px;">
      <button id="lte-start-btn" style="flex:1;background:#238636;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-weight:600;font-size:11px;cursor:pointer;transition:background 0.15s;opacity:0.6;" disabled>
        Initializing...
      </button>
      <button id="lte-stop-btn" style="display:none;background:#da3633;color:#fff;border:0;border-radius:4px;padding:6px 12px;font-weight:600;font-size:11px;cursor:pointer;">
        Stop
      </button>
    </div>
  `;

  document.body.appendChild(hud);

  const startBtn = hud.querySelector("#lte-start-btn");
  const stopBtn = hud.querySelector("#lte-stop-btn");
  const closeBtn = hud.querySelector("#lte-close-btn");
  const statusDiv = hud.querySelector("#lte-status");
  const progressWrap = hud.querySelector("#lte-progress-bar-wrap");
  const progressBar = hud.querySelector("#lte-progress-bar");
  const accountValSpan = hud.querySelector("#lte-account-val");
  const authBadgeSpan = hud.querySelector("#lte-auth-badge");

  let isRunning = false;
  let isCancelled = false;

  closeBtn.addEventListener("click", function () {
    isCancelled = true;
    hud.remove();
    window.__LIGHTER_EXPORTER_ACTIVE__ = false;
  });

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

    if (detectedAuth) {
      authBadgeSpan.textContent = "● Ready";
      authBadgeSpan.style.color = "#2ea043";
      statusDiv.style.color = "#8b949e";
      statusDiv.textContent = "Ready to export trades for Account #" + detectedAccount;
      startBtn.textContent = "Export Trade History";
      startBtn.style.background = "#238636";
      startBtn.style.opacity = "1";
      startBtn.disabled = false;
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
      startBtn.textContent = "Re-scan Session";
      startBtn.style.background = "#d29922";
      startBtn.style.opacity = "1";
      startBtn.disabled = false;
    }
  }

  // Initial async resolution
  refreshCredentials();

  // 4. Fetch with Exponential Backoff Retry and 429 Rate Limit cooldown
  async function fetchWithRetry(url, options) {
    for (let attempt = 0; ; attempt++) {
      if (isCancelled) throw new Error("Export cancelled by user");
      let res;
      try {
        res = await fetch(url, options);
      } catch (err) {
        if (attempt < 3 && !isCancelled) {
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

  // 5. Slimming / Payload Trimming: keep only fields required by checker
  function slimTrade(t) {
    const res = {
      trade_id: t.trade_id,
      trade_id_str: t.trade_id_str || String(t.trade_id),
      tx_hash: t.tx_hash || "",
      type: t.type || "trade",
      market_id: t.market_id,
      market_kind: t.market_kind || "perps",
      size: t.size,
      price: t.price,
      usd_amount: t.usd_amount,
      ask_account_id: t.ask_account_id,
      bid_account_id: t.bid_account_id,
      is_maker_ask: Boolean(t.is_maker_ask),
      block_height: t.block_height,
      timestamp: t.timestamp,
      taker_fee: t.taker_fee ?? 0,
      maker_fee: t.maker_fee ?? 0,
    };
    if (t.ask_id !== undefined) res.ask_id = t.ask_id;
    if (t.ask_id_str !== undefined) res.ask_id_str = t.ask_id_str;
    if (t.bid_id !== undefined) res.bid_id = t.bid_id;
    if (t.bid_id_str !== undefined) res.bid_id_str = t.bid_id_str;
    if (t.ask_client_id !== undefined) res.ask_client_id = t.ask_client_id;
    if (t.bid_client_id !== undefined) res.bid_client_id = t.bid_client_id;
    if (t.transaction_time !== undefined) res.transaction_time = t.transaction_time;
    if (t.ask_account_pnl !== undefined && t.ask_account_pnl !== null) {
      res.ask_account_pnl = t.ask_account_pnl;
    }
    if (t.bid_account_pnl !== undefined && t.bid_account_pnl !== null) {
      res.bid_account_pnl = t.bid_account_pnl;
    }
    return res;
  }

  startBtn.addEventListener("click", async function () {
    if (isRunning) return;

    if (!detectedAccount || !detectedAuth) {
      statusDiv.textContent = "Re-scanning session credentials...";
      await refreshCredentials();
      if (!detectedAccount || !detectedAuth) return;
    }

    const acc = detectedAccount;
    const auth = detectedAuth;

    isRunning = true;
    isCancelled = false;
    startBtn.disabled = true;
    startBtn.style.opacity = "0.6";
    stopBtn.style.display = "block";
    progressWrap.style.display = "block";
    progressBar.style.width = "5%";
    statusDiv.style.color = "#58a6ff";
    statusDiv.textContent = "Connecting to " + apiBase + "...";

    const allTrades = [];
    const seenIds = new Set();
    let cursor = "";
    let page = 0;
    const startTime = Date.now();

    try {
      while (!isCancelled && allTrades.length < ROW_CAP) {
        page++;
        let url =
          apiBase +
          "/trades?market_type=all&account_index=" +
          encodeURIComponent(acc) +
          "&sort_by=timestamp&sort_dir=desc&ask_filter=-1&role=all&type=all&limit=100&aggregate=false";
        if (cursor) url += "&cursor=" + encodeURIComponent(cursor);

        const headers = {
          Accept: "application/json",
          Authorization: auth,
          PreferAuthServer: "true",
        };
        // Forward AWS WAF token cookie if present
        if (document.cookie && document.cookie.includes("aws-waf-token=")) {
          const m = document.cookie.match(/aws-waf-token=([^;]+)/);
          if (m && m[1]) headers["x-aws-waf-token"] = m[1];
        }

        statusDiv.textContent =
          "Fetching page " + page + " (" + allTrades.length.toLocaleString() + " trades so far)...";
        progressBar.style.width = Math.min(95, 5 + page * 12) + "%";

        const res = await fetchWithRetry(url, { headers, credentials: "omit" });
        const data = await res.json();
        if (data.code !== 200 && data.code !== undefined && data.code !== 0) {
          throw new Error(data.message || "API Error code: " + data.code);
        }

        const trades = data.trades || [];
        if (trades.length === 0) break;

        let newInPage = 0;
        for (let i = 0; i < trades.length; i++) {
          const t = trades[i];
          const idKey = t.trade_id_str || String(t.trade_id);
          if (!seenIds.has(idKey)) {
            seenIds.add(idKey);
            allTrades.push(slimTrade(t));
            newInPage++;
            if (allTrades.length >= ROW_CAP) break;
          }
        }

        if (!data.next_cursor || data.next_cursor === cursor || newInPage === 0) {
          break;
        }

        cursor = data.next_cursor;
      }

      progressBar.style.width = "100%";
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const isTruncated = allTrades.length >= ROW_CAP && Boolean(cursor);

      if (allTrades.length === 0) {
        statusDiv.style.color = "#d29922";
        statusDiv.textContent = "No trades found for Account #" + acc + ".";
      } else {
        // Build export payload with metadata, truncation status, and slimmed rows
        const exportPayload = {
          version: "1.0",
          exported_at: new Date().toISOString(),
          exported_at_unix: Date.now(),
          network: defaultNetwork,
          network_name: isRh ? "Robinhood Chain (RH)" : "Lighter Mainnet (Core)",
          account_index: Number(acc),
          total_trades: allTrades.length,
          truncated: isTruncated,
          row_cap: ROW_CAP,
          trades: allTrades,
        };

        // Trigger file download (compact format for large files > 5000 rows to prevent high memory usage)
        const isLarge = exportPayload.total_trades > 5000;
        const jsonStr = isLarge ? JSON.stringify(exportPayload) : JSON.stringify(exportPayload, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const dateStr = new Date().toISOString().slice(0, 10);
        a.href = dlUrl;
        a.download = "lighter-trades-" + defaultNetwork + "-acc" + acc + "-" + dateStr + ".json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(dlUrl);

        if (isTruncated) {
          statusDiv.style.color = "#d29922";
          statusDiv.textContent =
            "Capped at " +
            ROW_CAP.toLocaleString() +
            " trades (" +
            durationSec +
            "s). Earliest history truncated.";
        } else {
          statusDiv.style.color = "#2ea043";
          statusDiv.textContent =
            allTrades.length.toLocaleString() +
            " trades exported (" +
            durationSec +
            "s). File downloaded.";
        }
      }
    } catch (err) {
      console.error("[Lighter Exporter]", err);
      statusDiv.style.color = "#f85149";
      statusDiv.textContent = "Error: " + (err.message || String(err));
    } finally {
      isRunning = false;
      startBtn.disabled = false;
      startBtn.style.opacity = "1";
      startBtn.textContent = "Export Again";
      stopBtn.style.display = "none";
    }
  });
})();
