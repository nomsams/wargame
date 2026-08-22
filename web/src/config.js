export const FACTION_META = {
  "UNITED STATES OF AMERICA": { code: "USA", short: "U.S.A.", color: "#214f9d", accent: "#81b7ff", flag: "USAFlag.png" },
  "EUROPEAN DEMOCRATIC FEDERATION": { code: "EDF", short: "E.D.F.", color: "#62466f", accent: "#d6a8e8", flag: "EDFFlag.png" },
  "THE GREAT REICH": { code: "TGR", short: "The Great Reich", color: "#666d72", accent: "#d5dde2", flag: "TGRFlag.png" },
  "UNION OF SOVIET SOCIALIST REPUBLICS": { code: "USSR", short: "U.S.S.R.", color: "#a3222a", accent: "#ff8b80", flag: "USSRFlag.png" },
  "THE GREAT KHALIFA": { code: "TGK", short: "The Great Khalifa", color: "#1d7a41", accent: "#8fe0a2", flag: "TGKFlag.png" },
  "EMPIRE OF THE SUN": { code: "EOS", short: "Empire of the Sun", color: "#d88716", accent: "#ffd06c", flag: "EOSFlag.png" },
};

export const UNIT_TYPES = {
  troops: { label: "Troops", singular: "troop", initialKey: "initialTroops", costKey: "troopsCost", attackKey: "troopsAttackStrength", defenseKey: "troopsDefenseStrength", icon: "troopsTabButton.png" },
  ships: { label: "Ships", singular: "ship", initialKey: "initialShips", costKey: "shipsCost", attackKey: "shipsAttackStrength", defenseKey: "shipsDefenseStrength", icon: "shipsTabButton.png" },
  planes: { label: "Planes", singular: "plane", initialKey: "initialPlanes", costKey: "planesCost", attackKey: "planesAttackStrength", defenseKey: "planesDefenseStrength", icon: "planesTabButton.png" },
  missiles: { label: "Missiles", singular: "missile", initialKey: "initialMissiles", costKey: "missilesCost", attackKey: "missilesAttackStrength", defenseKey: "missilesDefenseStrength", icon: "missilesTabButton.png" },
  commandos: { label: "Commandos", singular: "commando", initialKey: "initialCommandos", costKey: "commandosCost", attackKey: "commandosAttackStrength", defenseKey: "commandosDefenseStrength", icon: "commandosTabButton.png" },
};

export const RESOURCE_NAMES = ["Petroleum", "Heavy Industry", "Finance", "Agriculture", "Ore", "Fishing"];
export const RESOURCE_IMAGES = ["resourcePetroleum.png", "resourceHeavyIndustry.png", "resourceFinance.png", "resourceAgriculture.png", "resourceOre.png", "resourceFishing.png"];

export const CONTINENT_NAMES = {
  0: "Africa",
  1: "America",
  2: "Asia",
  3: "Oceania",
  4: "Europe",
};

export const UPGRADES = [
  { id: 0, title: "Air Water Field Defense System", short: "AWFDS", cost: 50, scope: "country", image: "AWFDSImage.png" },
  { id: 1, title: "Supply Center", cost: 100, scope: "country", image: "SupplyCenterImage.png" },
  { id: 3, title: "Spezial Polizei", cost: 30, scope: "country", image: "SpezialPolizeiImage.png" },
  { id: 4, title: "Conversion", cost: 30, scope: "country", image: "ConversionImage.png" },
  { id: 5, title: "Propaganda", cost: 30, scope: "country", image: "PropagandaImage.png" },
  { id: 6, title: "Capitalism", cost: 30, scope: "country", image: "CapitalismImage.png" },
  { id: 7, title: "Member Of The Federation", cost: 30, scope: "country", image: "MemberOfTheFederationImage.png" },
  { id: 8, title: "Shintoism", cost: 30, scope: "country", image: "ShintoismImage.png" },
  { id: 9, title: "Blitzkrieg", cost: 300, scope: "world", image: "BlitzkriegImage.png" },
  { id: 10, title: "Jihad", cost: 500, scope: "world", image: "JihadImage.png" },
  { id: 11, title: "Red Army", cost: 500, scope: "world", image: "RedArmyImage.png" },
  { id: 12, title: "Manhattan Project", cost: 1000, scope: "world", image: "ManhattanProjectImage.png" },
  { id: 13, title: "00 Agents", cost: 300, scope: "world", image: "00AgentsImage.png" },
  { id: 14, title: "Quick Learner", cost: 500, scope: "world", image: "QuickLearnerImage.png" },
  { id: 15, title: "Power Plant", cost: 30, scope: "country", image: "PowerPlantImage.png" },
  { id: 16, title: "Mechwarrior", cost: 3000, scope: "world", image: "MechwarriorImage.png" },
  { id: 17, title: "Rail Gun", cost: 4000, scope: "world", image: "RailGunImage.png" },
  { id: 18, title: "Army Of Allah", cost: 3000, scope: "world", image: "ArmyOfAllahImage.png" },
  { id: 19, title: "Great Soviet", cost: 3000, scope: "world", image: "GreatSovietImage.png" },
  { id: 20, title: "Grand Marshal", cost: 2000, scope: "world", image: "GrandMarshalImage.png" },
  { id: 21, title: "Jack Of All Trades", cost: 3000, scope: "world", image: "JackOfAllTradesImage.png" },
];

export const OBJECTIVES = {
  domination: { title: "World Domination", description: "Control every habitable country on the map." },
  destroyer: { title: "World Destroyer", description: "Eliminate every rival faction; neutral countries may remain." },
  supremacy: { title: "Strategic Supremacy", description: "Control 45 countries and hold at least $5,000." },
};

export const SPY_ACTIONS = {
  intelligence: { title: "Intelligence", cost: 40, description: "Reveal the full garrison and infrastructure of an enemy country." },
  bribery: { title: "Bribery", cost: 100, description: "Reduce an enemy country's defence by 50% until the end of the year." },
  hit: { title: "Hit", cost: 300, upgrade: 13, description: "Deactivate a rival general's combat bonus for one full year." },
};

export function upgradeById(id) {
  return UPGRADES.find((upgrade) => upgrade.id === Number(id));
}

export function factionCanBuild(faction, upgradeId) {
  return Boolean(faction.factionAvailableUpgrades & (1 << Number(upgradeId)));
}
