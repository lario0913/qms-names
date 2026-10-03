/* QMS Names frontend. Plain JS, no build step. Needs vendor/ethers.umd.min.js loaded first. */
(function () {
  "use strict";
  const { ethers } = window;

  /* ------------------------------------------------------------------ config */
  const CFG = {
    chainId: 19480,
    chainHex: "0x4c18",
    rpc: "https://rpc.testnet.qms.finance",
    explorer: "https://testnet.qmsscan.io",
    faucet: "https://faucet.testnet.qms.finance",
    contract: "0x21f5c1A44170F8396b95887b433515fc87898A38",
    deployBlock: 16800, // a little before the deploy block (16813)
    confs: 6, // QMS testnet has no finality yet, so we count confirmations
  };
  const YEAR = 365 * 86400;
  const DAY = 86400;
  const GRACE = 30 * DAY;

  const ABI = [
    "function available(string) view returns (bool)",
    "function expiresAt(string) view returns (uint256)",
    "function rentPrice(string,uint256) view returns (uint256)",
    "function resolve(string) view returns (address)",
    "function text(string,string) view returns (string)",
    "function nameOf(address) view returns (string)",
    "function ownerOf(uint256) view returns (address)",
    "function makeCommitment(string,address,bytes32) pure returns (bytes32)",
    "function commitments(bytes32) view returns (uint256)",
    "function price3() view returns (uint256)",
    "function price4() view returns (uint256)",
    "function price5Plus() view returns (uint256)",
    "function commit(bytes32)",
    "function register(string,address,uint256,bytes32) payable returns (uint256)",
    "function renew(string,uint256) payable",
    "function setAddr(string,address)",
    "function setText(string,string,string)",
    "function setPrimaryName(string)",
    "function transferFrom(address,address,uint256)",
    "event NameRegistered(uint256 indexed id,string label,address indexed owner,uint256 expires)",
    "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
    "error InvalidLabel()",
    "error NameNotAvailable()",
    "error NameExpired()",
    "error NameNotRenewable()",
    "error CommitmentNotFound()",
    "error CommitmentTooNew()",
    "error CommitmentTooOld()",
    "error CommitmentAlreadyExists()",
    "error DurationTooShort()",
    "error DurationTooLong()",
    "error InsufficientPayment(uint256 required,uint256 sent)",
    "error NotNameController()",
    "error NotNameOwner()",
    "error TransferFailed()",
    "error ZeroAddress()",
  ];

  const ERR_TEXT = {
    InvalidLabel: "That name isn't valid.",
    NameNotAvailable: "That name was just taken.",
    NameExpired: "That name has expired.",
    NameNotRenewable: "This name expired too long ago to renew. It can be registered again.",
    CommitmentNotFound: "No pending registration found. Start again.",
    CommitmentTooNew: "Too early. Wait a few more seconds and try again.",
    CommitmentTooOld: "The pending registration expired. Start again.",
    CommitmentAlreadyExists: "A registration for this name is already pending.",
    DurationTooShort: "Choose a longer period.",
    DurationTooLong: "Choose a shorter period (max 10 years from today).",
    InsufficientPayment: "Not enough QMS to cover the price.",
    NotNameController: "Your account can't change this name.",
    NotNameOwner: "Only the owner can do that.",
    ZeroAddress: "Enter a valid address.",
  };

  /* ------------------------------------------------------------------ chain access */
  const ro = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId, { staticNetwork: true });
  const rc = new ethers.Contract(CFG.contract, ABI, ro);
  const state = { account: null, signer: null, chainOk: false, primary: "" };

  /* ------------------------------------------------------------------ helpers */
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowSec = () => Math.floor(Date.now() / 1000);
  const idOf = (label) => BigInt(ethers.id(label));
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

  function fmtQ(wei) {
    let s = ethers.formatEther(wei);
    if (s.includes(".")) s = s.replace(/\.?0+$/, "");
    return s + " QMS";
  }
  function fmtDate(sec) {
    return new Date(Number(sec) * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function checkLabel(l) {
    if (l.length < 3) return "Names need at least 3 characters.";
    if (l.length > 63) return "Names can be at most 63 characters.";
    if (!/^[a-z0-9-]+$/.test(l)) return "Use only a to z, 0 to 9 and hyphens.";
    if (l.startsWith("-") || l.endsWith("-")) return "A name can't start or end with a hyphen.";
    return null;
  }
  function statusOf(exp) {
    const n = nowSec();
    if (!exp) return "open";
    if (n <= exp) return exp - n < 30 * DAY ? "soon" : "active";
    if (n <= exp + GRACE) return "grace";
    return "open";
  }
  function statusTag(st, exp) {
    if (st === "active") return `<span class="tag ok">Active until ${fmtDate(exp)}</span>`;
    if (st === "soon") return `<span class="tag warn">Expires ${fmtDate(exp)}</span>`;
    if (st === "grace") return `<span class="tag bad">Expired, renew by ${fmtDate(exp + GRACE)}</span>`;
    return `<span class="tag">Available</span>`;
  }

  let toastTimer;
  function toast(msg, kind) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (kind === "bad" ? " bad" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 4500);
  }

  function niceError(e) {
    if (e && (e.code === "ACTION_REJECTED" || e.code === 4001 || e.info?.error?.code === 4001)) return "Cancelled in your wallet.";
    let name = e?.revert?.name;
    if (!name && e?.data) {
      try { name = rc.interface.parseError(e.data)?.name; } catch (_) {}
    }
    if (name && ERR_TEXT[name]) return ERR_TEXT[name];
    if (/insufficient funds/i.test(e?.message || "")) return "Not enough QMS for the price plus gas. Get more from the faucet.";
    return e?.shortMessage || e?.message || "Something went wrong.";
  }

  /* ------------------------------------------------------------------ wallet */
  const net = { chainId: CFG.chainHex, chainName: "QMS Testnet", nativeCurrency: { name: "QMS", symbol: "QMS", decimals: 18 }, rpcUrls: [CFG.rpc], blockExplorerUrls: [CFG.explorer] };

  async function refreshWallet() {
    if (!window.ethereum) return;
    try {
      const bp = new ethers.BrowserProvider(window.ethereum);
      const accts = await bp.send("eth_accounts", []);
      if (!accts.length) { state.account = null; state.signer = null; state.chainOk = false; state.primary = ""; return; }
      state.signer = await bp.getSigner();
      state.account = ethers.getAddress(accts[0]);
      const cid = await bp.send("eth_chainId", []);
      state.chainOk = parseInt(cid, 16) === CFG.chainId;
      state.primary = await rc.nameOf(state.account).catch(() => "");
    } catch (_) {
      state.account = null; state.signer = null; state.chainOk = false; state.primary = "";
    }
  }

  async function connect() {
    if (!window.ethereum) { openNoWallet(); return false; }
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
    } catch (e) { toast(niceError(e), "bad"); return false; }
    await refreshWallet();
    if (!state.chainOk) await switchChain();
    renderHeader();
    return !!state.account;
  }

  async function switchChain() {
    if (!window.ethereum) return false;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG.chainHex }] });
    } catch (e) {
      try {
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [net] });
      } catch (e2) { toast(niceError(e2), "bad"); }
    }
    await refreshWallet();
    renderHeader();
    return state.chainOk;
  }

  async function requireWallet() {
    if (!state.account) await connect();
    if (state.account && !state.chainOk) await switchChain();
    return !!(state.account && state.chainOk);
  }

  const writer = () => new ethers.Contract(CFG.contract, ABI, state.signer);

  function openNoWallet() {
    openSheet(`
      <h2>No wallet found</h2>
      <p>To register a name you need a wallet. On a phone, open this page inside your wallet app's browser (MetaMask, Rabby, Trust and others have one).</p>
      <button class="btn block" id="copylink">Copy page link</button>`);
    $("#copylink").onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch (_) { toast("Copy the address from your browser bar", "bad"); }
    };
  }

  function renderHeader() {
    const b = $("#connect");
    $("#mylink").hidden = !state.account;
    b.textContent = state.account ? state.primary || short(state.account) : "Connect wallet";
    b.title = state.account || "";
    b.onclick = state.account ? () => { location.hash = "#/my"; } : connect;
    const ban = $("#banner");
    if (state.account && !state.chainOk) {
      ban.hidden = false;
      ban.innerHTML = `<span>Your wallet is on a different network.</span><button class="btn small" id="swbtn">Switch to QMS Testnet</button>`;
      $("#swbtn").onclick = switchChain;
    } else ban.hidden = true;
  }

  /* ------------------------------------------------------------------ sheet */
  let sheetTimers = [];
  function openSheet(html) {
    $("#sheet").innerHTML = `<button class="x" data-close aria-label="Close">×</button>` + html;
    $("#sheetwrap").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    sheetTimers.forEach(clearInterval);
    sheetTimers = [];
    $("#sheetwrap").hidden = true;
    document.body.style.overflow = "";
  }
  document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  /* ------------------------------------------------------------------ transactions */
  async function trackConfs(blockNumber, el) {
    for (;;) {
      if (!el.isConnected) return;
      try {
        const head = await ro.getBlockNumber();
        const n = Math.max(1, Math.min(CFG.confs, head - blockNumber + 1));
        el.innerHTML = n >= CFG.confs ? `Confirmed (${n}/${CFG.confs})` : `<span class="spin"></span> Confirming ${n}/${CFG.confs}`;
        if (n >= CFG.confs) return;
      } catch (_) {}
      await sleep(5000);
    }
  }

  /* ------------------------------------------------------------------ router */
  const view = () => $("#view");
  function route() {
    closeSheet();
    const h = location.hash.slice(1) || "/";
    window.scrollTo(0, 0);
    if (h === "/my") return viewMy();
    if (h === "/developers") return viewDevelopers();
    const m = h.match(/^\/name\/([a-z0-9-]+)$/);
    if (m) return viewName(m[1]);
    return viewHome();
  }

  /* ------------------------------------------------------------------ home */
  let pricesCache = null;
  async function getPrices() {
    if (!pricesCache) pricesCache = await Promise.all([rc.price3(), rc.price4(), rc.price5Plus()]);
    return pricesCache;
  }

  function viewHome() {
    view().innerHTML = `
      <section class="hero">
        <h1>Claim your name on QMS</h1>
        <p class="mu">One readable name instead of a long address.</p>
        <label class="claim">
          <input id="q" type="text" inputmode="text" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="yourname" aria-label="Name to search">
          <span class="tld" aria-hidden="true">.qms</span>
        </label>
        <div id="result"></div>
      </section>`;
    const q = $("#q");
    let timer, seq = 0;
    const run = () => { clearTimeout(timer); timer = setTimeout(() => check(q.value, ++seq), 300); };
    q.addEventListener("input", () => { if (q.value.trim()) $("#result").innerHTML = `<span class="spin"></span>`; run(); });
    q.focus({ preventScroll: true });
    renderPriceList();

    async function renderPriceList() {
      try {
        const [p3, p4, p5] = await getPrices();
        if (q.value.trim()) return;
        $("#result").innerHTML = `
          <p class="mu">Prices per year</p>
          <div class="prices">
            <div class="price-row"><span>3 letters</span><b>${fmtQ(p3)}</b></div>
            <div class="price-row"><span>4 letters</span><b>${fmtQ(p4)}</b></div>
            <div class="price-row"><span>5 or more</span><b>${fmtQ(p5)}</b></div>
          </div>
          <p class="note" style="margin-top:18px">Building an app? <a href="#/developers">Show .qms names in it</a>.</p>`;
      } catch (_) { $("#result").innerHTML = `<p class="mu">Couldn't reach the network. Check your connection and reload.</p>`; }
    }

    let current = 0;
    async function check(raw, mySeq) {
      current = mySeq;
      const label = raw.trim().toLowerCase().replace(/\.qms$/, "");
      const out = $("#result");
      if (!label) return renderPriceList();
      const bad = checkLabel(label);
      if (bad) { out.innerHTML = `<div class="verdict"><span class="dot"></span><span>${esc(bad)}</span></div>`; return; }
      try {
        const [exp, avail] = await Promise.all([rc.expiresAt(label), rc.available(label)]);
        if (mySeq !== current) return;
        const e = Number(exp);
        if (avail) {
          const price = await rc.rentPrice(label, YEAR);
          if (mySeq !== current) return;
          out.innerHTML = `
            <div class="verdict ok"><span class="dot"></span><span class="nm">${esc(label)}.qms is available</span></div>
            <p class="sub">${fmtQ(price)} for the first year</p>
            <button class="btn block" id="go">Register ${esc(label)}.qms</button>`;
          $("#go").onclick = () => openRegister(label);
        } else {
          const st = statusOf(e);
          const note = st === "grace" ? `Expired. The owner can renew until ${fmtDate(e + GRACE)}.` : `Registered until ${fmtDate(e)}.`;
          out.innerHTML = `
            <div class="verdict ${st === "grace" ? "warn" : "bad"}"><span class="dot"></span><span class="nm">${esc(label)}.qms is taken</span></div>
            <p class="sub">${note}</p>
            <a class="btn ghost" href="#/name/${esc(label)}">View name</a>`;
        }
      } catch (err) {
        if (mySeq === current) out.innerHTML = `<p class="err">Couldn't check that name. ${esc(niceError(err))}</p>`;
      }
    }
  }

  /* ------------------------------------------------------------------ register flow */
  async function openRegister(label) {
    if (!(await requireWallet())) return;
    const acct = state.account;
    const key = `qmsnames:${acct.toLowerCase()}:${label}`;
    const S = { years: 1, step: "choose", secret: null, ts: 0, price: 0n, err: "", busy: false };
    const YEARS = [1, 2, 3, 5, 10];

    // Resume a pending commitment saved from an earlier visit.
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const h = await rc.makeCommitment(label, acct, saved);
        const ts = Number(await rc.commitments(h));
        if (ts && nowSec() < ts + DAY) { S.secret = saved; S.ts = ts; S.step = "wait"; }
        else localStorage.removeItem(key);
      }
    } catch (_) {}

    async function loadPrice() { S.price = await rc.rentPrice(label, S.years * YEAR); }
    try { await loadPrice(); } catch (e) { toast(niceError(e), "bad"); return; }

    const stepsHtml = () => {
      const order = ["choose", "wait", "ready", "done"];
      const idx = Math.max(0, order.indexOf(S.step === "committing" ? "choose" : S.step === "registering" ? "ready" : S.step));
      const rows = [["Start registration", 0], ["Wait about a minute", 1], ["Confirm and pay", 2]];
      return `<ol class="steps">${rows.map(([t, i]) => `<li class="${S.step === "done" || i < idx ? "done" : i === idx ? "now" : ""}"><span class="mk">${S.step === "done" || i < idx ? "✓" : i + 1}</span>${t}</li>`).join("")}</ol>`;
    };
    const pills = () => `<div class="pills" role="group" aria-label="Registration period">${YEARS.map((y) => `<button class="pill" data-y="${y}" aria-pressed="${y === S.years}" ${S.busy || S.step === "committing" || S.step === "registering" ? "disabled" : ""}>${y} ${y === 1 ? "year" : "years"}</button>`).join("")}</div>`;
    const totalHtml = () => `<div class="total"><span class="mu">Total</span><b>${fmtQ(S.price)}</b></div>`;

    function render() {
      let body = "";
      if (S.step === "done") {
        body = `
          <h2>${esc(label)}.qms is yours</h2>
          <p class="mu" id="confs"><span class="spin"></span> Confirming 1/${CFG.confs}</p>
          <div class="btnrow">
            <button class="btn" id="mkprimary">Use as my primary name</button>
            <a class="btn ghost" href="#/name/${esc(label)}">View name</a>
          </div>
          <p class="note">Your primary name is what apps show for your address.</p>`;
      } else {
        const btn =
          S.step === "choose" ? `<button class="btn block" id="act">Start registration</button>` :
          S.step === "committing" ? `<button class="btn block" disabled><span class="spin"></span> Waiting for wallet</button>` :
          S.step === "wait" ? `<div class="bar"><i id="barfill"></i></div><button class="btn block" disabled id="act">Ready in <span id="cd">60</span>s</button>` :
          S.step === "ready" ? `<button class="btn block" id="act">Register for ${fmtQ(S.price)}</button>` :
          `<button class="btn block" disabled><span class="spin"></span> Registering</button>`;
        body = `
          <h2>Register ${esc(label)}.qms</h2>
          ${stepsHtml()}${pills()}${totalHtml()}${btn}
          ${S.err ? `<p class="err">${esc(S.err)}</p>` : ""}
          <p class="note">The short wait stops others from grabbing your name while your registration is in flight.</p>`;
      }
      $("#sheet").innerHTML = `<button class="x" data-close aria-label="Close">×</button>` + body;
      $("#sheet").querySelectorAll(".pill").forEach((p) => (p.onclick = async () => { S.years = Number(p.dataset.y); S.err = ""; await loadPrice(); render(); }));
      const act = $("#act");
      if (S.step === "choose") act.onclick = doCommit;
      if (S.step === "ready") act.onclick = doRegister;
      if (S.step === "wait") startCountdown();
      if (S.step === "done") {
        trackConfs(S.block, $("#confs"));
        $("#mkprimary").onclick = async () => {
          try { const tx = await writer().setPrimaryName(label); await tx.wait(1); await refreshWallet(); renderHeader(); toast("Primary name set"); $("#mkprimary").disabled = true; }
          catch (e) { toast(niceError(e), "bad"); }
        };
      }
    }

    function startCountdown() {
      const total = 65;
      const tick = () => {
        const left = Math.max(0, S.ts + total - nowSec());
        const cd = $("#cd"), fill = $("#barfill");
        if (!cd) return;
        cd.textContent = left;
        if (fill) fill.style.width = Math.min(100, ((total - left) / total) * 100) + "%";
        if (left <= 0) { sheetTimers.forEach(clearInterval); sheetTimers = []; S.step = "ready"; render(); }
      };
      tick();
      sheetTimers.push(setInterval(tick, 1000));
    }

    async function doCommit() {
      S.err = "";
      try {
        S.secret = ethers.hexlify(ethers.randomBytes(32));
        const h = await rc.makeCommitment(label, acct, S.secret);
        localStorage.setItem(key, S.secret);
        S.step = "committing"; render();
        const tx = await writer().commit(h);
        const rcpt = await tx.wait(1);
        const blk = await ro.getBlock(rcpt.blockNumber);
        S.ts = blk.timestamp; S.step = "wait"; render();
      } catch (e) {
        localStorage.removeItem(key);
        S.step = "choose"; S.err = niceError(e); render();
      }
    }

    async function doRegister() {
      S.err = "";
      try {
        const price = await rc.rentPrice(label, S.years * YEAR);
        S.step = "registering"; render();
        const tx = await writer().register(label, acct, S.years * YEAR, S.secret, { value: price });
        const rcpt = await tx.wait(1);
        localStorage.removeItem(key);
        S.block = rcpt.blockNumber; S.step = "done"; render();
      } catch (e) {
        S.step = "ready"; S.err = niceError(e);
        if (/too early/i.test(S.err)) { S.ts = nowSec() - 55; S.step = "wait"; }
        render();
      }
    }

    openSheet("");
    render();
  }

  /* ------------------------------------------------------------------ name page */
  const TEXT_KEYS = [["url", "Website"], ["description", "About"], ["com.twitter", "X / Twitter"], ["com.github", "GitHub"]];

  async function viewName(label) {
    view().innerHTML = `<a class="back" href="#/">← Search</a><div class="empty"><span class="spin"></span></div>`;
    try {
      const [exp, avail] = await Promise.all([rc.expiresAt(label), rc.available(label)]);
      const e = Number(exp);
      const st = statusOf(e);
      let owner = null, addr = null, primary = null, texts = [];
      if (e && nowSec() <= e) {
        [owner, addr] = await Promise.all([rc.ownerOf(idOf(label)).catch(() => null), rc.resolve(label).catch(() => null)]);
        texts = await Promise.all(TEXT_KEYS.map(async ([k, n]) => [k, n, await rc.text(label, k).catch(() => "")]));
        if (owner) primary = await rc.nameOf(owner).catch(() => "");
      }
      const isOwner = same(owner, state.account);
      const zero = ethers.ZeroAddress;
      const addrHtml = addr && addr !== zero ? `<span class="mono">${esc(addr)}</span>` : `<span class="mu">Not set</span>`;
      const recs = texts.filter(([, , v]) => v);
      const linkify = (v) => (/^https:\/\//i.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>` : esc(v));

      view().innerHTML = `
        <a class="back" href="#/">← Search</a>
        <h1 style="word-break:break-all">${esc(label)}.qms</h1>
        <p>${statusTag(st, e)}</p>
        ${st === "open" ? `
          <p class="mu">This name is available.</p>
          <button class="btn" id="reg">Register ${esc(label)}.qms</button>` : `
        <div class="panel">
          <div class="kv"><span class="k">Owner</span><span class="v">${owner ? `<span class="mono">${esc(owner)}</span>${same(primary, label + ".qms") ? " (primary)" : ""}` : `<span class="mu">Expired</span>`}</span></div>
          <div class="kv"><span class="k">Points to</span><span class="v">${st === "grace" ? `<span class="mu">Paused</span>` : addrHtml}</span></div>
          ${recs.map(([, n, v]) => `<div class="kv"><span class="k">${esc(n)}</span><span class="v">${linkify(v)}</span></div>`).join("")}
        </div>
        <div class="btnrow" id="acts">
          <button class="btn ghost" id="renew">Renew</button>
          ${isOwner ? `
          <button class="btn ghost" id="setaddr">Change address</button>
          <button class="btn ghost" id="settext">Edit records</button>
          <button class="btn ghost" id="setprim">Make primary</button>
          <button class="btn ghost" id="xfer">Transfer</button>` : ""}
        </div>
        <p class="note">Anyone can renew a name. Only the owner can change it.</p>`}
      `;
      const again = () => viewName(label);
      if (st === "open") $("#reg").onclick = () => openRegister(label);
      else {
        $("#renew").onclick = () => openRenew(label, e, again);
        if (isOwner) {
          $("#setaddr").onclick = () => openForm({ title: "Change address", label: "New address", ph: "0x…", submit: "Save address", validate: (v) => (ethers.isAddress(v) ? null : "Enter a valid address."), run: (c, v) => c.setAddr(label, v) }, again);
          $("#setprim").onclick = async () => { if (!(await requireWallet())) return; try { toast("Confirm in your wallet"); const tx = await writer().setPrimaryName(label); await tx.wait(1); await refreshWallet(); renderHeader(); toast("Primary name set"); again(); } catch (er) { toast(niceError(er), "bad"); } };
          $("#xfer").onclick = () => openForm({ title: `Transfer ${label}.qms`, label: "Send to address", ph: "0x…", submit: "Transfer name", note: "The new owner gets the name. Its address and records reset.", validate: (v) => (ethers.isAddress(v) ? null : "Enter a valid address."), run: (c, v) => c.transferFrom(state.account, v, idOf(label)) }, () => { location.hash = "#/my"; });
          $("#settext").onclick = () => openTextForm(label, again);
        }
      }
    } catch (err) {
      view().innerHTML = `<a class="back" href="#/">← Search</a><p class="err">Couldn't load this name. ${esc(niceError(err))}</p>`;
    }
  }

  async function openRenew(label, exp, done) {
    if (!(await requireWallet())) return;
    let years = 1;
    const YEARS = [1, 2, 3, 5];
    let price = await rc.rentPrice(label, YEAR);
    async function render(err) {
      openSheet(`
        <h2>Renew ${esc(label)}.qms</h2>
        <div class="pills">${YEARS.map((y) => `<button class="pill" data-y="${y}" aria-pressed="${y === years}">${y} ${y === 1 ? "year" : "years"}</button>`).join("")}</div>
        <div class="total"><span class="mu">Total</span><b>${fmtQ(price)}</b></div>
        <button class="btn block" id="go">Renew</button>
        ${err ? `<p class="err">${esc(err)}</p>` : ""}`);
      $("#sheet").querySelectorAll(".pill").forEach((p) => (p.onclick = async () => { years = Number(p.dataset.y); price = await rc.rentPrice(label, years * YEAR); render(); }));
      $("#go").onclick = async () => {
        $("#go").disabled = true; $("#go").innerHTML = `<span class="spin"></span> Waiting for wallet`;
        try {
          const tx = await writer().renew(label, years * YEAR, { value: price });
          await tx.wait(1);
          closeSheet(); toast("Renewed"); done();
        } catch (e) { render(niceError(e)); }
      };
    }
    render();
  }

  function openForm(o, done) {
    (async () => {
      if (!(await requireWallet())) return;
      openSheet(`
        <h2>${esc(o.title)}</h2>
        <label class="field"><span>${esc(o.label)}</span><input id="fv" type="text" placeholder="${esc(o.ph || "")}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
        ${o.note ? `<p class="note">${esc(o.note)}</p>` : ""}
        <p class="err" id="ferr" hidden></p>
        <button class="btn block" id="go">${esc(o.submit)}</button>`);
      $("#go").onclick = async () => {
        const v = $("#fv").value.trim();
        const bad = o.validate(v);
        const er = $("#ferr");
        if (bad) { er.textContent = bad; er.hidden = false; return; }
        er.hidden = true;
        $("#go").disabled = true; $("#go").innerHTML = `<span class="spin"></span> Waiting for wallet`;
        try {
          const tx = await o.run(writer(), v);
          await tx.wait(1);
          closeSheet(); toast("Done"); done();
        } catch (e) { er.textContent = niceError(e); er.hidden = false; $("#go").disabled = false; $("#go").textContent = o.submit; }
      };
    })();
  }

  async function openTextForm(label, done) {
    if (!(await requireWallet())) return;
    openSheet(`
      <h2>Edit records</h2>
      <p class="note">Pick a field and save a value. Each save is one transaction.</p>
      <div class="pills" id="keys">${TEXT_KEYS.map(([k, n], i) => `<button class="pill" data-k="${k}" aria-pressed="${i === 0}">${n}</button>`).join("")}</div>
      <label class="field"><span id="klabel">Website</span><input id="fv" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://"></label>
      <p class="err" id="ferr" hidden></p>
      <button class="btn block" id="go">Save record</button>`);
    let key = TEXT_KEYS[0][0];
    const load = async () => { $("#fv").value = await rc.text(label, key).catch(() => ""); };
    load();
    $("#keys").querySelectorAll(".pill").forEach((p) => (p.onclick = () => {
      key = p.dataset.k;
      $("#keys").querySelectorAll(".pill").forEach((q) => q.setAttribute("aria-pressed", String(q === p)));
      $("#klabel").textContent = p.textContent;
      load();
    }));
    $("#go").onclick = async () => {
      const er = $("#ferr");
      $("#go").disabled = true; $("#go").innerHTML = `<span class="spin"></span> Waiting for wallet`;
      try {
        const tx = await writer().setText(label, key, $("#fv").value.trim());
        await tx.wait(1);
        closeSheet(); toast("Record saved"); done();
      } catch (e) { er.textContent = niceError(e); er.hidden = false; $("#go").disabled = false; $("#go").textContent = "Save record"; }
    };
  }

  /* ------------------------------------------------------------------ my names */
  async function logsChunked(topics) {
    const head = await ro.getBlockNumber();
    const out = [];
    for (let from = CFG.deployBlock; from <= head; from += 9000) {
      const to = Math.min(from + 8999, head);
      out.push(...(await ro.getLogs({ address: CFG.contract, fromBlock: from, toBlock: to, topics })));
    }
    return out;
  }

  async function viewMy() {
    view().innerHTML = `<h1>My names</h1><div class="empty"><span class="spin"></span></div>`;
    if (!state.account) {
      view().innerHTML = `<h1>My names</h1><p class="mu">Connect your wallet to see the names you own.</p><button class="btn" id="c">Connect wallet</button>`;
      $("#c").onclick = async () => { if (await connect()) viewMy(); };
      return;
    }
    try {
      const iface = rc.interface;
      const [tLogs, rLogs] = await Promise.all([
        logsChunked([iface.getEvent("Transfer").topicHash]),
        logsChunked([iface.getEvent("NameRegistered").topicHash]),
      ]);
      const labels = new Map();
      for (const l of rLogs) { const p = iface.parseLog(l); labels.set(p.args.id.toString(), p.args.label); }
      const holder = new Map();
      for (const l of tLogs) { const p = iface.parseLog(l); holder.set(p.args.tokenId.toString(), p.args.to); }
      const mine = [...holder.entries()].filter(([id, to]) => same(to, state.account) && labels.has(id)).map(([id]) => labels.get(id));
      const rows = await Promise.all(mine.map(async (lb) => ({ lb, exp: Number(await rc.expiresAt(lb)) })));
      const live = rows.filter((r) => statusOf(r.exp) !== "open").sort((a, b) => a.exp - b.exp);
      const primary = await rc.nameOf(state.account).catch(() => "");

      view().innerHTML = `
        <h1>My names</h1>
        <p class="mu">${primary ? `Primary name: <b>${esc(primary)}</b>` : "No primary name set yet."}</p>
        ${live.length ? `<div class="list">${live.map((r) => `
          <a class="item" href="#/name/${esc(r.lb)}">
            <span><span class="nm">${esc(r.lb)}.qms</span><br><span class="meta">${r.exp * 1000 > Date.now() ? "Until " + fmtDate(r.exp) : "Expired, renew by " + fmtDate(r.exp + GRACE)}</span></span>
            ${statusTag(statusOf(r.exp), r.exp).replace(/Active until [^<]*|Expires [^<]*/, (m) => (m.startsWith("Active") ? "Active" : "Soon"))}
          </a>`).join("")}</div>` : `<div class="empty">You don't own any names yet.<div class="btnrow"><a class="btn" href="#/">Find a name</a></div></div>`}`;
    } catch (err) {
      view().innerHTML = `<h1>My names</h1><p class="err">Couldn't load your names. ${esc(niceError(err))}</p>`;
    }
  }

  /* ------------------------------------------------------------------ developers */
  const DEV = { npm: "https://www.npmjs.com/package/qms-names", repo: "https://github.com/lario0913/useqmsnames" };
  const codeBlock = (code) => `<div class="code"><pre><code>${esc(code)}</code></pre><button class="copy" type="button" data-copy="${esc(code)}">Copy</button></div>`;
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); } catch (_) { toast("Select the text and copy it", "bad"); }
  });

  function viewDevelopers() {
    const example = `import { createQmsNames } from "qms-names";

const qms = createQmsNames();

await qms.resolve("alice.qms");  // "0x…" or null
await qms.displayName(address);  // "alice.qms", or a short address`;
    view().innerHTML = `
      <div class="dev">
        <a class="back" href="#/">← Names</a>
        <h1>Add .qms names to your app</h1>
        <p class="mu">Show alice.qms instead of 0x… in three lines of code.</p>
        <h2>Install</h2>
        ${codeBlock("npm install qms-names ethers")}
        <h2>Use it</h2>
        ${codeBlock(example)}
        <h2>Try it live</h2>
        <p class="mu">Enter a name or an address. This reads QMS Testnet right now.</p>
        <div class="demo"><input id="dq" type="text" placeholder="larioo.qms or 0x…" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Name or address"><button class="btn" id="dgo" type="button">Look up</button></div>
        <div class="out" id="dout" aria-live="polite"></div>
        <h2>Links</h2>
        <div class="panel">
          <div class="kv"><span class="k">npm</span><span class="v"><a href="${DEV.npm}" target="_blank" rel="noopener">qms-names</a></span></div>
          <div class="kv"><span class="k">Source</span><span class="v"><a href="${DEV.repo}" target="_blank" rel="noopener">GitHub</a></span></div>
          <div class="kv"><span class="k">Contract</span><span class="v"><a class="mono" href="${CFG.explorer}/address/${CFG.contract}" target="_blank" rel="noopener">${short(CFG.contract)}</a></span></div>
        </div>
        <h2>Not using ethers?</h2>
        <p class="mu">Call the contract directly from any library: <span class="mono">nameOf(address)</span> returns an address's primary name, and <span class="mono">resolve(label)</span> returns the address for a name.</p>
        <div class="panel">
          <div class="kv"><span class="k">Chain ID</span><span class="v">${CFG.chainId}</span></div>
          <div class="kv"><span class="k">RPC</span><span class="v mono">${CFG.rpc}</span></div>
        </div>
      </div>`;
    const inp = $("#dq"), out = $("#dout");
    async function run() {
      const v = inp.value.trim();
      if (!v) return;
      out.innerHTML = `<span class="spin"></span>`;
      try {
        if (ethers.isAddress(v)) {
          const n = await rc.nameOf(v);
          out.innerHTML = n ? `<span class="mono">${esc(short(ethers.getAddress(v)))}</span> → <b>${esc(n)}</b>` : "No primary name set for this address.";
        } else {
          const label = v.toLowerCase().replace(/\.qms$/, "");
          const bad = checkLabel(label);
          if (bad) { out.textContent = bad; return; }
          const a = await rc.resolve(label);
          out.innerHTML = a === ethers.ZeroAddress ? `<b>${esc(label)}.qms</b> isn't registered, or has expired.` : `<b>${esc(label)}.qms</b> → <span class="mono">${esc(a)}</span>`;
        }
      } catch (err) { out.textContent = "Couldn't reach the network. " + niceError(err); }
    }
    $("#dgo").onclick = run;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  }

  /* ------------------------------------------------------------------ boot */
  async function boot() {
    $("#contractlink").href = `${CFG.explorer}/address/${CFG.contract}`;
    await refreshWallet();
    renderHeader();
    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on("accountsChanged", async () => { await refreshWallet(); renderHeader(); route(); });
      window.ethereum.on("chainChanged", async () => { await refreshWallet(); renderHeader(); });
    }
    window.addEventListener("hashchange", route);
    route();
  }
  boot();
})();
