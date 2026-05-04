const REFRESH_SECONDS = 60;
const PARTY_COLORS = {
  BJP: "#f58220",
  AITC: "#00a86b",
  TMC: "#00a86b",
  INC: "#1f77b4"
};

let countdown = REFRESH_SECONDS;
let latestData = null;
let previousSignature = "";
let searchTerm = "";

const $ = (id) => document.getElementById(id);

function fmt(value) {
  return Number(value || 0).toLocaleString("en-IN");
}

function partyColor(party) {
  return party?.color || PARTY_COLORS[party?.shortName] || "#68707d";
}

function safePartyName(party) {
  if (!party) return "Awaiting data";
  return party.shortName && party.shortName !== party.party ? party.shortName : party.party;
}

function setText(id, value) {
  $(id).textContent = value;
}

function signature(data) {
  return JSON.stringify({
    parties: data.summary.parties.map((party) => [party.shortName, party.won, party.leading, party.total]),
    updated: data.pageLastUpdated
  });
}

function updateStatus(data) {
  const isLive = data.portalStatus === "live";
  setText("feedStatus", isLive ? "Live" : data.portalStatus === "source-blocked" ? "ECI blocked on host" : data.portalStatus === "waiting" ? "Waiting for ECI" : "Feed error");
  setText("lastUpdated", data.pageLastUpdated || data.statusKnown || data.message || "Checking official portal");
  setText("majorityLabel", `${data.state.majority} of ${data.state.totalSeats}`);
  setText("knownLabel", `${fmt(data.summary.highlights.knownSeats)} known, ${fmt(data.summary.highlights.declaredSeats)} declared`);
  $("sourceLink").href = data.source.party || data.source.portal || "https://results.eci.gov.in/";
}

function updateDuel(data) {
  const { bjp, tmc, othersTotal, majority, knownSeats, totalSeats } = data.summary.highlights;
  setText("bjpTotal", fmt(bjp?.total));
  setText("bjpDetail", `${fmt(bjp?.won)} won, ${fmt(bjp?.leading)} leading`);
  setText("tmcTotal", fmt(tmc?.total));
  setText("tmcDetail", `${fmt(tmc?.won)} won, ${fmt(tmc?.leading)} leading`);
  setText("othersTotal", fmt(othersTotal));

  const leader = [bjp, tmc].filter(Boolean).sort((a, b) => b.total - a.total)[0];
  if (!leader || knownSeats === 0) {
    setText(
      "narrative",
      data.portalStatus === "source-blocked"
        ? "ECI pages are reachable from a local computer, but Vercel's cloud server is not receiving them. The public site needs a different data relay for live results."
        : "The dashboard is waiting for the West Bengal results pages to become available on ECI."
    );
    return;
  }

  const second = leader === bjp ? tmc : bjp;
  const gap = leader.total - (second?.total || 0);
  const majorityGap = majority - leader.total;
  const declaredPart = data.summary.highlights.declaredSeats
    ? `${fmt(data.summary.highlights.declaredSeats)} declared`
    : `${fmt(knownSeats)} trends known`;

  setText(
    "narrative",
    leader.total >= majority
      ? `${safePartyName(leader)} is at or above the majority mark with ${fmt(leader.total)} seats. ${declaredPart} out of ${fmt(totalSeats)} seats.`
      : `${safePartyName(leader)} leads by ${fmt(gap)} seats and needs ${fmt(Math.max(majorityGap, 0))} more to reach majority. ${declaredPart} out of ${fmt(totalSeats)} seats.`
  );
}

function renderSeatBars(data) {
  const totalSeats = data.state.totalSeats;
  const bars = data.summary.parties
    .filter((party) => party.total > 0)
    .map((party) => {
      const width = Math.max((party.total / totalSeats) * 100, 0);
      return `<div class="seat-bar" title="${party.party}: ${party.total}" style="width:${width}%;background:${partyColor(party)}"></div>`;
    })
    .join("");

  const unknown = Math.max(totalSeats - data.summary.highlights.knownSeats, 0);
  const unknownBar = unknown
    ? `<div class="seat-bar" title="Unknown: ${unknown}" style="width:${(unknown / totalSeats) * 100}%;background:#d8dee7"></div>`
    : "";
  $("seatBars").innerHTML = bars + unknownBar;
}

function renderPartyList(data) {
  const totalSeats = data.state.totalSeats;
  const rows = data.summary.parties.map((party) => {
    const pct = Math.min((party.total / totalSeats) * 100, 100);
    return `
      <div class="party-row">
        <div class="party-name">
          <span class="swatch" style="background:${partyColor(party)}"></span>
          <span>${party.party}</span>
        </div>
        <strong>${fmt(party.total)}</strong>
        <div class="party-track">
          <div class="party-fill" style="width:${pct}%;background:${partyColor(party)}"></div>
        </div>
      </div>
    `;
  }).join("");

  $("partyList").innerHTML = rows || `<p class="narrative">${latestData?.message || "No party tally yet."}</p>`;
}

function renderSeatGrid(data) {
  const byNumber = new Map(data.constituencies.map((row) => [row.number, row]));
  const partyColors = new Map(data.summary.parties.map((party) => [party.party, partyColor(party)]));
  const shortColors = new Map(data.summary.parties.map((party) => [party.shortName, partyColor(party)]));
  const dots = [];

  for (let index = 1; index <= data.state.totalSeats; index += 1) {
    const row = byNumber.get(index);
    const color = row ? partyColors.get(row.leadingParty) || shortColors.get(row.leadingParty) || "#68707d" : "#d8dee7";
    const label = row ? `${row.constituency}: ${row.leadingParty}, margin ${fmt(row.margin)}` : `Seat ${index}: awaiting data`;
    dots.push(`<span class="seat-dot" title="${label}" style="background:${color}"></span>`);
  }

  $("seatGrid").innerHTML = dots.join("");
}

function partyPill(name, parties) {
  const party = parties.find((item) => item.party === name || item.shortName === name);
  return `<span class="party-pill" style="background:${partyColor(party)}">${name || "NA"}</span>`;
}

function filteredConstituencies(data) {
  if (!searchTerm) return data.constituencies;
  const needle = searchTerm.toLowerCase();
  return data.constituencies.filter((row) => [
    row.constituency,
    row.leadingCandidate,
    row.leadingParty,
    row.trailingCandidate,
    row.trailingParty,
    row.status
  ].join(" ").toLowerCase().includes(needle));
}

function renderConstituencies(data) {
  const rows = filteredConstituencies(data);
  $("constituencyRows").innerHTML = rows.map((row) => `
    <tr>
      <td><strong>${row.constituency}</strong><br><span class="label">AC ${row.number}</span></td>
      <td>${row.leadingCandidate}</td>
      <td>${partyPill(row.leadingParty, data.summary.parties)}</td>
      <td>${row.trailingCandidate}<br><span class="label">${row.trailingParty}</span></td>
      <td>${fmt(row.margin)}</td>
      <td>${row.round}</td>
      <td>${row.status}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">${data.message || "No constituencies found yet."}</td></tr>`;
}

function renderCloseSeats(data) {
  $("closeSeats").innerHTML = data.summary.closeSeats.map((row) => `
    <div class="close-seat">
      <strong>${row.constituency}</strong>
      <span>${row.leadingParty} leads by ${fmt(row.margin)} after ${row.round}</span>
    </div>
  `).join("") || `<p class="narrative">Close-seat list will appear once constituency margins are published.</p>`;
}

function render(data) {
  latestData = data;
  updateStatus(data);
  updateDuel(data);
  renderSeatBars(data);
  renderPartyList(data);
  renderSeatGrid(data);
  renderConstituencies(data);
  renderCloseSeats(data);

  const nextSignature = signature(data);
  if (previousSignature && previousSignature !== nextSignature) {
    document.body.classList.remove("pulse");
    requestAnimationFrame(() => document.body.classList.add("pulse"));
  }
  previousSignature = nextSignature;
}

async function refresh() {
  setText("feedStatus", "Checking");
  try {
    const response = await fetch(`/api/results?t=${Date.now()}`, { cache: "no-store" });
    render(await response.json());
  } catch (error) {
    setText("feedStatus", "Feed error");
    setText("lastUpdated", error.message);
  } finally {
    countdown = REFRESH_SECONDS;
  }
}

$("refreshNow").addEventListener("click", refresh);
$("searchBox").addEventListener("input", (event) => {
  searchTerm = event.target.value;
  if (latestData) renderConstituencies(latestData);
});

setInterval(() => {
  countdown -= 1;
  if (countdown <= 0) refresh();
  setText("nextRefresh", `${countdown}s`);
}, 1000);

refresh();
