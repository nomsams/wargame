export const FACTION_META = {
  "GREATER ISRAEL": { code: "GI", short: "Greater Israel", color: "#277f91", accent: "#9be8fc" },
  "IRANIAN COALITION": { code: "IC", short: "Iranian Coalition", color: "#a35f72", accent: "#ffc5d4" },
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

export const UNIT_UPGRADES = [
  { id: "advanced-assault-rifle", unitType: "troops", title: "Advanced Assault Rifle", cost: 200, image: "AdvancedAssaultRifleImage.png", effect: "attack", value: 1.25 },
  { id: "kevlar-vest", unitType: "troops", title: "Kevlar Vest", cost: 200, image: "KevlarVestImage.png", effect: "defense", value: 1.25 },
  { id: "bomber", unitType: "planes", title: "Bomber", cost: 1000, image: "BomberImage.png", effect: "bomber" },
  { id: "stealth-aircraft", unitType: "planes", title: "Stealth Aircraft", cost: 1000, image: "StealthAircraftImage.png", effect: "stealth", value: 0.6 },
  { id: "multi-warhead-missile", unitType: "missiles", title: "Multi-Warhead Missile", cost: 500, image: "MultiWarheadMissileImage.png", effect: "attack", value: 1.5 },
  { id: "explosive-device", unitType: "missiles", title: "Explosive Device", cost: 500, image: "ExplosiveDeviceImage.png", effect: "support" },
  { id: "sea-carrier", unitType: "ships", title: "Sea Carrier", cost: 400, image: "SeaCarrierImage.png", effect: "transport", value: 2 },
  { id: "advanced-battleship", unitType: "ships", title: "Advanced Battleship", cost: 400, image: "AdvancedBattleshipImage.png", effect: "attackDefense", value: 1.5 },
  { id: "advanced-training-facility", unitType: "commandos", title: "Advanced Training Facility", cost: 2000, image: "AdvancedTrainingFacilityImage.png", effect: "commandoCap", value: 300 },
  { id: "project-lazarus", unitType: "commandos", title: "Project Lazarus", cost: 2000, image: "ProjectLazarusImage.png", effect: "revive" },
];

// Medal IDs and names are recovered from -[Medal medalName] at 0x82420 in the
// archived Mach-O, which switches on medalID 0...13. Award conditions are
// implemented from the original English descriptions, which state their
// numeric requirements explicitly.
export const MEDALS = [
  { id: 0, name: "Medal Purple Heart", image: "medalPurpleHeart.png", description: "Lose a battle while attempting to conquer or defend a country." },
  { id: 1, name: "Medal Combat Readiness", image: "medalCombatReadiness.png", description: "Build 10 AWFDS, 10 supply centers and 10 country upgrades." },
  { id: 2, name: "Medal Defence Distinguished Service", image: "medalDefenceDistinguishedService.png", description: "Successfully reconquer one of your starting country after it has been taken over." },
  { id: 3, name: "Medal Army Achievement", image: "medalArmyAchievement.png", description: "Enroll 1,000,000 soldiers." },
  { id: 4, name: "Medal Navy Achievement", image: "medalNavyAchievement.png", description: "Build 1,000 ships." },
  { id: 5, name: "Medal Air Force Achievement", image: "medalAirForceAchievement.png", description: "Build 1,000 aircrafts." },
  { id: 6, name: "Medal Rocket Achievement", image: "medalRocketAchievement.png", description: "Build 1,000 missiles." },
  { id: 7, name: "Medal Expert Rifleman", image: "medalExpertRifleman.png", description: "Enroll 100 commandos." },
  { id: 8, name: "Medal Resources Service", image: "medalResourcesService.png", description: "Take control of countries producing each kind of resource available." },
  { id: 9, name: "Medal Arctic Service", image: "medalArcticService.png", description: "Take control of Greenland, Iceland, Great Siberia and Alaska." },
  { id: 10, name: "Medal Desert Service", image: "medalDesertService.png", description: "Take control of Algeria, Lybia, Tunisia and Egypt." },
  { id: 11, name: "Medal Bronze Star", image: "medalBronzeStar.png", description: "Successfully destroy an enemy faction." },
  { id: 12, name: "Medal Silver Star", image: "medalSilverStar.png", description: "Successfully destroy two enemy factions." },
  { id: 13, name: "Medal Medal of Honor", image: "medalOfHonor.png", description: "Take control of 50 countries and have 50 active AWFDS, 50 active supply centers and 50 active country upgrades built. You must have built your world upgrade." },
];
export function unitUpgradeById(id) {
  return UNIT_UPGRADES.find((upgrade) => upgrade.id === String(id));
}

export function unitUpgradesFor(unitType) {
  return UNIT_UPGRADES.filter((upgrade) => upgrade.unitType === unitType);
}

// The original screen offered a green (affordable) or red (locked) button per
// branch, so every unit type presents exactly two mutually exclusive choices.
export function unitUpgradeBranch(unitType) {
  return unitUpgradesFor(unitType);
}
// The original offered five difficulty levels, each named for an army rank
// (localized keys Super Easy / Easy / Normal / Hard / Super Hard).
export const DIFFICULTIES = [
  { id: "super-easy", title: "Super Easy", rank: "Private", reserve: 0.6, attacks: 1, threshold: 1.6 },
  { id: "easy", title: "Easy", rank: "Sergeant", reserve: 0.45, attacks: 1, threshold: 1.35 },
  { id: "normal", title: "Normal", rank: "Captain", reserve: 0.3, attacks: 2, threshold: 0.95 },
  { id: "hard", title: "Hard", rank: "Colonel", reserve: 0.15, attacks: 3, threshold: 0.8 },
  { id: "super-hard", title: "Super Hard", rank: "General", reserve: 0.05, attacks: 4, threshold: 0.65 },
];

export function difficultyById(id) {
  return DIFFICULTIES.find((difficulty) => difficulty.id === id) || DIFFICULTIES[2];
}
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
