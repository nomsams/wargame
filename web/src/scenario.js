export const REGIONAL_SCENARIO = "regional-coalitions";
const formerFaction = "THE GREAT KHALIFA";
const factions = [
  { id: "GREATER ISRAEL", capital: "SYRIA", countries: ["SYRIA", "SAUDI_ARABIA", "TURKEY"] },
  { id: "IRANIAN COALITION", capital: "IRAN", countries: ["IRAN", "IRAQ", "YEMEN"] },
];

export function scenarioData(board, scenario) {
  if (scenario !== REGIONAL_SCENARIO) return board;
  const model = board.factions.find(({ factionName }) => factionName === formerFaction);
  const assignments = new Map(factions.flatMap(({ id, countries }) => countries.map((country) => [country, id])));
  return {
    ...board,
    factions: [
      ...board.factions.filter(({ factionName }) => factionName !== formerFaction),
      ...factions.map(({ id, capital }, index) => ({
        ...model, factionName: id, capitalCountry: capital, factionInitialCash: 65,
        troopsCost: index === 0 ? 4 : 3, shipsCost: index === 0 ? 10 : 14,
        factionAvailableUpgrades: (1 << 0) | (1 << 1) | (1 << 15),
      })),
    ],
    countries: board.countries.map((country) => {
      const faction = assignments.get(country.name);
      if (faction) return {
        ...country, faction, initialTroops: 32, initialShips: country.hasSeaBorder ? 10 : 0,
        initialPlanes: country.name === "SYRIA" || country.name === "IRAN" ? 10 : 0,
        initialMissiles: 0, initialCommandos: 0,
      };
      return country.faction === formerFaction ? { ...country, faction: "", initialTroops: 14, initialShips: 0, initialPlanes: 0, initialMissiles: 0, initialCommandos: 0 } : country;
    }),
  };
}
