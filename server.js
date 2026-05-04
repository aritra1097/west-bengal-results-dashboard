import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ECI_BASE = "https://results.eci.gov.in";
const WEST_BENGAL = {
  stateCode: "S25",
  stateName: "West Bengal",
  totalSeats: 294,
  majority: 148
};

const LIVE_FOLDER_CANDIDATES = [
  "ResultAcGenMay2026",
  "ResultAcGen2026",
  "ResultAcMay2026",
  "AcResultGenMay2026"
];

let cache = {
  timestamp: 0,
  data: null
};

const CACHE_MS = 25_000;
const APP_VERSION = "2026-05-04-eci-live-diagnostics";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function decodeHtml(value = "") {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function textContent(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  return (node.children || []).map(textContent).join(" ");
}

function cleanText(nodeOrText) {
  return decodeHtml(typeof nodeOrText === "string" ? nodeOrText : textContent(nodeOrText));
}

function cleanPartyName(value) {
  const cleaned = decodeHtml(value)
    .replace(/\bi\s*Party Wise State Trends[\s\S]*$/i, "")
    .replace(/\s*Leading In\s*:.*$/i, "")
    .trim();
  return /^Party Wise State Trends$/i.test(cleaned) ? "" : cleaned;
}

function numberFrom(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+/);
  return match ? Number(match[0]) : 0;
}

function parseHtml(html) {
  const root = { tag: "root", children: [] };
  const stack = [root];
  const tokenRe = /<!--[\s\S]*?-->|<!doctype[\s\S]*?>|<\/?([a-zA-Z0-9]+)(?:\s[^>]*)?>|([^<]+)/gi;
  let match;

  while ((match = tokenRe.exec(html))) {
    if (match[2]) {
      stack.at(-1).children.push(match[2]);
      continue;
    }

    const raw = match[0];
    const tag = match[1]?.toLowerCase();
    if (!tag) continue;

    if (raw.startsWith("</")) {
      while (stack.length > 1) {
        const node = stack.pop();
        if (node.tag === tag) break;
      }
      continue;
    }

    const node = { tag, raw, children: [] };
    stack.at(-1).children.push(node);
    if (!raw.endsWith("/>") && !["br", "hr", "img", "input", "meta", "link"].includes(tag)) {
      stack.push(node);
    }
  }

  return root;
}

function descendants(node, tag) {
  const found = [];
  const visit = (current) => {
    if (!current || typeof current === "string") return;
    if (current.tag === tag) found.push(current);
    for (const child of current.children || []) visit(child);
  };
  visit(node);
  return found;
}

function rowsForTable(table) {
  const rows = [];
  const visit = (node) => {
    if (!node || typeof node === "string") return;
    if (node !== table && node.tag === "table") return;
    if (node.tag === "tr") {
      rows.push(node);
      return;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(table);
  return rows;
}

function cellsForRow(row) {
  const cells = [];
  const visit = (node) => {
    if (!node || typeof node === "string") return;
    if (node.tag === "table") return;
    if (node.tag === "td" || node.tag === "th") {
      cells.push(node);
      return;
    }
    for (const child of node.children || []) visit(child);
  };
  for (const child of row.children || []) visit(child);
  return cells;
}

function hrefsFrom(html) {
  return [...html.matchAll(/href=['"]([^'"]+)['"]/gi)].map((match) => match[1]);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
      "cache-control": "no-cache",
      "pragma": "no-cache",
      "referer": `${ECI_BASE}/`,
      "user-agent": "Mozilla/5.0 West Bengal results dashboard"
    }
  });

  const text = await response.text();
  if (!response.ok || /<h1>\s*Not Found\s*<\/h1>/i.test(text)) {
    const error = new Error(`ECI returned ${response.status} for ${url}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  return text;
}

async function tryFetchText(url) {
  try {
    return await fetchText(url);
  } catch {
    return null;
  }
}

function resolveEciUrl(pathOrUrl) {
  return new URL(pathOrUrl, ECI_BASE + "/").href;
}

async function discoverFolders() {
  const homeHtml = await tryFetchText(`${ECI_BASE}/`);
  const folders = new Set();

  if (homeHtml) {
    for (const href of hrefsFrom(homeHtml)) {
      const match = href.match(/(ResultAc[^/"']+|AcResult[^/"']+)/i);
      if (match) folders.add(match[1]);
    }
  }

  for (const folder of LIVE_FOLDER_CANDIDATES) folders.add(folder);
  return { folders: [...folders], homeHtml };
}

async function findLiveFolder() {
  const { folders, homeHtml } = await discoverFolders();
  const diagnostics = [];

  for (const folder of folders) {
    const baseUrl = `${ECI_BASE}/${folder}/`;
    const partyUrl = `${baseUrl}partywiseresult-${WEST_BENGAL.stateCode}.htm`;
    const stateUrl = `${baseUrl}statewise${WEST_BENGAL.stateCode}1.htm`;
    const indexUrl = `${baseUrl}index.htm`;
    const partyHtml = await tryFetchText(partyUrl);
    diagnostics.push({
      folder,
      party: partyHtml ? "ok" : "missing",
      partyHasWestBengal: Boolean(partyHtml && /West Bengal/i.test(partyHtml))
    });

    if (partyHtml && /West Bengal/i.test(partyHtml)) {
      return { folder, baseUrl, partyUrl, partyHtml, indexUrl, discoveredFolders: folders, diagnostics };
    }

    const stateHtml = await tryFetchText(stateUrl);
    diagnostics.at(-1).state = stateHtml ? "ok" : "missing";
    diagnostics.at(-1).stateHasTable = Boolean(stateHtml && /Status Known For|Constituency/i.test(stateHtml));
    if (stateHtml && /Status Known For|Constituency/i.test(stateHtml)) {
      return { folder, baseUrl, partyUrl, partyHtml, stateHtml, indexUrl, discoveredFolders: folders, diagnostics };
    }

    const indexHtml = await tryFetchText(indexUrl);
    diagnostics.at(-1).index = indexHtml ? "ok" : "missing";
    diagnostics.at(-1).indexHasWestBengal = Boolean(indexHtml && /West Bengal/i.test(indexHtml));
    if (indexHtml && /West Bengal/i.test(indexHtml)) {
      return { folder, baseUrl, partyUrl, partyHtml: null, indexUrl, indexHtml, discoveredFolders: folders, diagnostics };
    }
  }

  return { folder: null, baseUrl: null, partyUrl: null, homeHtml, discoveredFolders: folders, diagnostics };
}

function parsePartySummary(html) {
  const root = parseHtml(html);
  const tables = descendants(root, "table");
  let selected = null;

  for (const table of tables) {
    const firstRows = rowsForTable(table).slice(0, 4);
    const headerText = firstRows.map((row) => cellsForRow(row).map(cleanText).join("|")).join("|").toLowerCase();
    if (headerText.includes("party") && headerText.includes("won") && headerText.includes("leading") && headerText.includes("total")) {
      selected = table;
      break;
    }
  }

  if (!selected) return [];

  return rowsForTable(selected)
    .map((row) => cellsForRow(row).map(cleanText))
    .filter((cells) => cells.length >= 4)
    .map((cells) => {
      const party = cells[0];
      const [fullName, shortNameFromDash] = party.split(/\s+-\s+(?=[^-]+$)/);
      return {
        party: party === "Total" ? "Total" : fullName.trim(),
        shortName: party === "Total" ? "Total" : (shortNameFromDash || fullName).trim(),
        won: numberFrom(cells[1]),
        leading: numberFrom(cells[2]),
        total: numberFrom(cells[3])
      };
    })
    .filter((row) => row.party && !/^party$/i.test(row.party));
}

function parseLastUpdated(html) {
  const match = html.match(/Last Updated at\s*([^<]+)/i);
  return match ? decodeHtml(`Last Updated at ${match[1]}`) : null;
}

function parseStatusKnown(html) {
  const match = html.match(/Status Known For\s*([^<]+)/i);
  return match ? decodeHtml(`Status Known For ${match[1]}`) : null;
}

function constituencyPageUrls(baseUrl, firstHtml) {
  const urls = new Set([`${baseUrl}statewise${WEST_BENGAL.stateCode}1.htm`]);
  for (const href of hrefsFrom(firstHtml)) {
    if (href.includes(`statewise${WEST_BENGAL.stateCode}`)) {
      urls.add(resolveEciUrl(new URL(href, baseUrl).href));
    }
  }
  return [...urls].sort((a, b) => {
    const an = numberFrom(a.match(/statewiseS25(\d+)\.htm/i)?.[1] || 1);
    const bn = numberFrom(b.match(/statewiseS25(\d+)\.htm/i)?.[1] || 1);
    return an - bn;
  });
}

function parseConstituencies(html) {
  const root = parseHtml(html);
  const tables = descendants(root, "table");
  let selected = null;

  for (const table of tables) {
    const headerText = rowsForTable(table).slice(0, 3).map((row) => cellsForRow(row).map(cleanText).join("|")).join("|").toLowerCase();
    if (headerText.includes("constituency") && headerText.includes("leading candidate") && headerText.includes("margin")) {
      selected = table;
      break;
    }
  }

  if (!selected) return [];

  return rowsForTable(selected)
    .map((row) => cellsForRow(row).map(cleanText))
    .filter((cells) => cells.length >= 9 && !/^constituency$/i.test(cells[0]) && !/^status known/i.test(cells[0]))
    .map((cells) => ({
      constituency: cells[0],
      number: numberFrom(cells[1]),
      leadingCandidate: cells[2],
      leadingParty: cleanPartyName(cells[3]),
      trailingCandidate: cells[4],
      trailingParty: cleanPartyName(cells[5]),
      margin: numberFrom(cells[6]),
      round: cells[7],
      status: cells[8]
    }))
    .filter((row) => row.constituency && row.number);
}

async function fetchConstituencies(baseUrl, seededFirstHtml = null) {
  const firstUrl = `${baseUrl}statewise${WEST_BENGAL.stateCode}1.htm`;
  const firstHtml = seededFirstHtml || await tryFetchText(firstUrl);
  if (!firstHtml) return { rows: [], statusKnown: null, lastUpdated: null, sourceUrls: [] };

  const urls = constituencyPageUrls(baseUrl, firstHtml);
  const pages = await Promise.all(urls.map(async (url, index) => ({
    url,
    html: index === 0 ? firstHtml : await tryFetchText(url)
  })));

  return {
    rows: pages.flatMap((page) => page.html ? parseConstituencies(page.html) : []),
    statusKnown: parseStatusKnown(firstHtml),
    lastUpdated: parseLastUpdated(firstHtml),
    sourceUrls: urls
  };
}

async function fetchLiveJson(baseUrl) {
  const jsonUrl = `${baseUrl}election-json-${WEST_BENGAL.stateCode}-live.json`;
  const text = await tryFetchText(jsonUrl);
  if (!text) return { colors: {}, sourceUrl: jsonUrl };

  try {
    const parsed = JSON.parse(text);
    const rows = parsed?.[WEST_BENGAL.stateCode]?.chartData || [];
    const colors = {};
    for (const row of rows) {
      if (row[0] && row[4]) colors[row[0]] = row[4];
    }
    return { colors, sourceUrl: jsonUrl };
  } catch {
    return { colors: {}, sourceUrl: jsonUrl };
  }
}

function partyColor(shortName, fullName, colorMap) {
  const key = shortName || fullName;
  const explicit = colorMap[key] || colorMap[fullName];
  if (explicit) return explicit;
  if (/BJP|Bharatiya Janata/i.test(`${shortName} ${fullName}`)) return "#f58220";
  if (/AITC|TMC|Trinamool/i.test(`${shortName} ${fullName}`)) return "#00a86b";
  if (/Congress|INC/i.test(`${shortName} ${fullName}`)) return "#1f77b4";
  if (/CPI|Forward Bloc|RSP|Left/i.test(`${shortName} ${fullName}`)) return "#c81912";
  return "#68707d";
}

function summarizeDashboard(parties, constituencies, colors) {
  const realParties = parties.filter((party) => party.shortName !== "Total");
  const totalRow = parties.find((party) => party.shortName === "Total");
  const knownSeats = totalRow?.total || realParties.reduce((sum, party) => sum + party.total, 0);
  const declaredSeats = totalRow?.won || realParties.reduce((sum, party) => sum + party.won, 0);
  const leadingSeats = totalRow?.leading || realParties.reduce((sum, party) => sum + party.leading, 0);
  const bjp = realParties.find((party) => /BJP|Bharatiya Janata/i.test(`${party.shortName} ${party.party}`)) || null;
  const tmc = realParties.find((party) => /AITC|TMC|Trinamool/i.test(`${party.shortName} ${party.party}`)) || null;
  const othersTotal = realParties
    .filter((party) => party !== bjp && party !== tmc)
    .reduce((sum, party) => sum + party.total, 0);

  const decoratedParties = realParties
    .map((party) => ({ ...party, color: partyColor(party.shortName, party.party, colors) }))
    .sort((a, b) => b.total - a.total || b.won - a.won);

  const closeSeats = constituencies
    .filter((row) => row.margin > 0)
    .sort((a, b) => a.margin - b.margin)
    .slice(0, 10);

  const declaredConstituencies = constituencies.filter((row) => /declared|won/i.test(row.status)).length;

  return {
    parties: decoratedParties,
    highlights: {
      bjp,
      tmc,
      othersTotal,
      knownSeats,
      declaredSeats,
      leadingSeats,
      declaredConstituencies,
      unknownSeats: Math.max(WEST_BENGAL.totalSeats - knownSeats, 0),
      majority: WEST_BENGAL.majority,
      totalSeats: WEST_BENGAL.totalSeats
    },
    closeSeats
  };
}

async function loadResults() {
  const found = await findLiveFolder();
  const now = new Date().toISOString();

  if (!found.folder || !found.baseUrl) {
    return {
      ok: false,
      version: APP_VERSION,
      state: WEST_BENGAL,
      generatedAt: now,
      portalStatus: "waiting",
      message: "The ECI results folder for West Bengal is not live yet. The dashboard will keep checking the official portal.",
      discoveredFolders: found.discoveredFolders,
      diagnostics: found.diagnostics,
      source: {
        portal: `${ECI_BASE}/`,
        party: null,
        constituencies: [],
        json: null
      },
      summary: summarizeDashboard([], [], {}),
      constituencies: []
    };
  }

  const [constituencyData, liveJson] = await Promise.all([
    fetchConstituencies(found.baseUrl, found.stateHtml),
    fetchLiveJson(found.baseUrl)
  ]);
  const partyHtml = found.partyHtml || await tryFetchText(found.partyUrl) || found.stateHtml || "";
  const parties = parsePartySummary(partyHtml);
  const summary = summarizeDashboard(parties, constituencyData.rows, liveJson.colors);

  return {
    ok: true,
    version: APP_VERSION,
    state: WEST_BENGAL,
    generatedAt: now,
    portalStatus: "live",
    folder: found.folder,
    pageLastUpdated: parseLastUpdated(partyHtml) || constituencyData.lastUpdated,
    statusKnown: parseStatusKnown(partyHtml) || constituencyData.statusKnown,
    source: {
      portal: `${ECI_BASE}/`,
      party: found.partyUrl,
      constituencies: constituencyData.sourceUrls,
      json: liveJson.sourceUrl
    },
    summary,
    constituencies: constituencyData.rows
  };
}

export async function resultsPayload() {
  if (cache.data && Date.now() - cache.timestamp < CACHE_MS) {
    return { ...cache.data, cache: { hit: true, ageSeconds: Math.round((Date.now() - cache.timestamp) / 1000) } };
  }

  try {
    const data = await loadResults();
    cache = { timestamp: Date.now(), data };
    return { ...data, cache: { hit: false, ageSeconds: 0 } };
  } catch (error) {
    return {
      ok: false,
      version: APP_VERSION,
      state: WEST_BENGAL,
      generatedAt: new Date().toISOString(),
      portalStatus: "error",
      message: error.message,
      source: { portal: `${ECI_BASE}/` },
      summary: summarizeDashboard([], [], {}),
      constituencies: []
    };
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/api/results") {
      const payload = await resultsPayload();
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate"
      });
      response.end(JSON.stringify(payload));
      return;
    }

    await serveStatic(request, response);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`West Bengal results dashboard running at http://${HOST}:${PORT}`);
  });
}
