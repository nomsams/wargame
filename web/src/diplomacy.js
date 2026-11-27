const TREATY_LIMIT = 120;
export const SUPPLY_SURCHARGE = 0.2;

export function allianceBetween(state, a, b) {
  return state.diplomacy?.alliances.find((pact) => pact.members.includes(a) && pact.members.includes(b) && a !== b);
}

export function friendlyFaction(state, a, b) {
  return Boolean(a && b && (a === b || allianceBetween(state, a, b)));
}

export function forceInCountry(country, faction) {
  return country && (country.owner === faction ? country.units : country.visitors?.[faction]);
}

export function newDiplomacy() {
  return { alliances: [], offers: [], requests: [] };
}

export function validDiplomacy(value, factionNames, countryNames) {
  if (!value || !["alliances", "offers", "requests"].every((key) => Array.isArray(value[key]) && value[key].length <= TREATY_LIMIT)) return false;
  const validPair = (a, b) => a !== b && factionNames.has(a) && factionNames.has(b);
  return value.alliances.every((pact) => Array.isArray(pact?.members) && pact.members.length === 2
      && validPair(...pact.members) && typeof pact.locked === "boolean")
    && value.offers.every((offer) => offer && validPair(offer.from, offer.to))
    && value.requests.every((request) => request && validPair(request.from, request.to) && countryNames.has(request.target)
      && Number.isSafeInteger(request.expires));
}

export function isSupplied(data, state, faction, countryName) {
  if (!state.diplomacy) return true;
  const friendly = (name) => {
    const country = state.countries[name];
    return country && country.nukedUntil <= state.year && friendlyFaction(state, faction, country.owner);
  };
  if (!friendly(countryName)) return false;
  const headquarters = new Set(data.factions.filter(({ factionName, capitalCountry }) =>
    friendlyFaction(state, faction, factionName) && state.countries[capitalCountry]?.owner === factionName).map(({ capitalCountry }) => capitalCountry));
  const board = new Map(data.countries.map((entry) => [entry.name, entry]));
  const openPorts = data.countries.filter((entry) => {
    if (!entry.hasSeaBorder || !friendly(entry.name)) return false;
    const port = state.countries[entry.name];
    const escorts = port.units.ships + Object.values(port.visitors || {}).reduce((sum, force) => sum + force.ships, 0);
    const blockaders = entry.adjoiningCountries.reduce((total, name) => {
      const neighbor = state.countries[name];
      return total + (board.get(name)?.hasSeaBorder && neighbor?.owner && !friendly(name) ? neighbor.units.ships : 0);
    }, 0);
    return escorts > blockaders;
  }).map(({ name }) => name);
  const openPortSet = new Set(openPorts);
  const visited = new Set([countryName]);
  const pending = [countryName];
  let traversedSea = false;
  for (const name of pending) {
    if (headquarters.has(name)) return true;
    const neighbors = [...(board.get(name)?.adjoiningCountries || [])];
    if (!traversedSea && openPortSet.has(name)) {
      neighbors.push(...openPorts);
      traversedSea = true;
    }
    for (const next of neighbors) {
      if (visited.has(next) || !friendly(next)) continue;
      visited.add(next);
      pending.push(next);
    }
  }
  return false;
}
