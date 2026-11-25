import {
  CardinalDir,
  CipherSymbol,
  DoorId,
  HarpColor,
  ItemDef,
  ItemId,
  PuzzleId,
  WorldPuzzleStates,
} from './types.js';

export const ITEMS: Record<ItemId, ItemDef> = {
  // === ONE-AND-DONE KEYS (consumed immediately upon unlocking) ===
  key_study: {
    id: 'key_study',
    name: 'Brass Study Key',
    shortName: 'Study Key',
    category: 'key',
    icon: '🗝️',
    description:
      'An ornate brass warded key engraved "ALCHEMIST\'S STUDY". Single-use — locks permanently into the study latch upon turning.',
    consumable: true,
  },
  key_conservatory: {
    id: 'key_conservatory',
    name: 'Conservatory Glass Key',
    shortName: 'Glass Key',
    category: 'key',
    icon: '🔑',
    description:
      'A filigree key inlaid with emerald glass. Unlocks the Botanical Conservatory door once and stays seated in the lock.',
    consumable: true,
  },
  key_skylift: {
    id: 'key_skylift',
    name: 'Sky-Lift Brass Key',
    shortName: 'Sky-Lift Key',
    category: 'key',
    icon: '🗝️',
    description:
      'A heavy hexagonal master key for the Observatory Sky-Lift gate. Single-use — consumed when engaged.',
    consumable: true,
  },

  // === REUSABLE PERSISTENT TOOLS ===
  tool_uv_lamp: {
    id: 'tool_uv_lamp',
    name: 'Aether UV Lantern',
    shortName: 'UV Lamp',
    category: 'tool',
    icon: '🔦',
    description:
      'A brass violet-spectrum lantern (press [F] to toggle). Reveals Master Vance\'s invisible luminous ink. Reusable indefinitely.',
    consumable: false,
  },
  tool_prism: {
    id: 'tool_prism',
    name: 'Pocket Brass Prism',
    shortName: 'Brass Prism',
    category: 'tool',
    icon: '💎',
    description:
      'A precision-cut optical quartz prism mounted in a folding brass gimbal. Aligns and channels sunbeams. Reusable.',
    consumable: false,
  },

  // === PUZZLE COMPONENT ===
  item_gear_18t: {
    id: 'item_gear_18t',
    name: '18-Tooth Brass Gear',
    shortName: '18T Gear',
    category: 'part',
    icon: '⚙️',
    description:
      'A finely machined 18-tooth spur gear stamped "VANCE FOUNDRY". Needed for the Clockwork Workshop gear train.',
    consumable: true,
  },

  // === 4 RESONANCE CORES (FOR THE GRAND SOLSTICE GATE) ===
  core_sun: {
    id: 'core_sun',
    name: 'Sun Resonance Core',
    shortName: 'Sun Core',
    category: 'core',
    icon: '☀️',
    description:
      'Radiant amber crystal harvested from the Botanical Conservatory Glass Lotus. One of four cores for the Solstice Gate.',
    consumable: true,
  },
  core_gear: {
    id: 'core_gear',
    name: 'Gear Resonance Core',
    shortName: 'Gear Core',
    category: 'core',
    icon: '⚙️',
    description:
      'Humming brass-and-copper core freshly forged in the Clockwork Workshop. One of four cores for the Solstice Gate.',
    consumable: true,
  },
  core_star: {
    id: 'core_star',
    name: 'Star Resonance Core',
    shortName: 'Star Core',
    category: 'core',
    icon: '✨',
    description:
      'Deep sapphire celestial core unlocked from the Planetary Orrery. One of four cores for the Solstice Gate.',
    consumable: true,
  },
  core_wind: {
    id: 'core_wind',
    name: 'Wind Resonance Core',
    shortName: 'Wind Core',
    category: 'core',
    icon: '🌀',
    description:
      'Singing turquoise core awakened by harmonizing the Sky-Deck Wind-Harp and Terrace Stones. One of four cores.',
    consumable: true,
  },
};

// Which one-and-done key unlocks which door
export const DOOR_KEY_REQUIREMENTS: Partial<Record<DoorId, ItemId>> = {
  study_door: 'key_study',
  conservatory_door: 'key_conservatory',
  skylift_door: 'key_skylift',
};

// === AUTHORITATIVE PUZZLE SOLUTIONS (100% Self-Contained Logic) ===
export const SOLUTIONS = {
  // P1: 09:35 (all digits distinct, AB between 01..11 with A+B=9 => 09; CD multiple of 7 > 30 with C+D=8 => 35)
  p1_clock: [0, 9, 3, 5] as [number, number, number, number],

  // P2: Tea Parlor Split-Booth Cipher (North Mural 3x3 grid)
  p2_cipher: ['moon', 'bell', 'gear', 'star'] as [
    CipherSymbol,
    CipherSymbol,
    CipherSymbol,
    CipherSymbol,
  ],

  // P3: Tea Balance Apothecary (Amber+Jade=15, Amber=Jade+3 => 9,6; Rose=2*Mint, Total=33 => 12,6)
  p3_tea: { amber: 9, jade: 6, rose: 12, mint: 6 },

  // P4: UV Invisible Ink Frames (Tiny->Large: Acrostic=7, Hidden word=3, Ladder rungs=8, Alchemy flasks=5)
  p4_safe: [7, 3, 8, 5] as [number, number, number, number],

  // P5: Harmonic Pipe Organ (no adjacent consecutive, slot3=1, slot5=3, slot4>slot2, slot1 even) => [2,4,1,5,3]
  p5_organ: [2, 4, 1, 5, 3] as [number, number, number, number, number],

  // P6: Courtyard Sundial (Hour*Azimuth=24, both even, Hour>Azimuth, Day=Hour+Azimuth=10) => 6, 4, 10
  p6_sundial: { hour: 6, azimuth: 4, day: 10 },

  // P7: Courtyard Light-Beam Mirrors (discrete 0..7 angles where beam hits M1->M2->M3->Receptor)
  // Angle index 0..7 corresponds to mirror facing yaw step
  p7_mirrors: [5, 6, 2] as [number, number, number],

  // P8: Conservatory Dual-Bank Irrigation
  // H1=10*(A1+A2)=50, H2=10*(A2+A3)=40, H3=10*(A1+A3)=50 => A=[3,2,2]
  // G1=10*(B1+B2)=60, G2=10*(B2+B3)=50, G3=10*(B1+B3)=30 => B=[2,4,1]
  p8_valvesA: [3, 2, 2] as [number, number, number],
  p8_valvesB: [2, 4, 1] as [number, number, number],
  p8_targetsH: [50, 40, 50] as [number, number, number],
  p8_targetsG: [60, 50, 30] as [number, number, number],

  // P9: Workshop Gear Train (Speed = 720 / Teeth; Targets 30, 40, 20 RPM => 24T, 18T, 36T)
  p9_gears: ['24', '18', '36'] as [string, string, string],

  // P11: Planetary Orrery (Sun=2, Mars=Sun+3=5, Sea=opp Sun=6, Sum=21 => Moon=8)
  p11_orrery: { sun: 2, mars: 5, moon: 8, sea: 6 },

  // P12: Sky-Deck Wind-Harp & Terrace Relay (4-step sequence carved under the terrace arch)
  p12_sequence: ['azure', 'amber', 'violet', 'emerald'] as [
    HarpColor,
    HarpColor,
    HarpColor,
    HarpColor,
  ],

  // P13: Grand Solstice Gate Finale Pedestal Cardinals (from the 4 wing plaques)
  p13_cardinals: {
    sun: 'E' as CardinalDir,
    gear: 'S' as CardinalDir,
    star: 'N' as CardinalDir,
    wind: 'W' as CardinalDir,
  },
};

export const CIPHER_SYMBOLS: { id: CipherSymbol; label: string; glyph: string }[] = [
  { id: 'sun', label: 'Sun', glyph: '☀' },
  { id: 'leaf', label: 'Leaf', glyph: '🌿' },
  { id: 'gear', label: 'Gear', glyph: '⚙' },
  { id: 'moon', label: 'Moon', glyph: '🌙' },
  { id: 'bell', label: 'Bell', glyph: '🔔' },
  { id: 'drop', label: 'Drop', glyph: '💧' },
  { id: 'star', label: 'Star', glyph: '★' },
  { id: 'key', label: 'Key', glyph: '🗝' },
  { id: 'feather', label: 'Feather', glyph: '🪶' },
];

// Compute live irrigation gauges from valve positions
export function computeIrrigationGauges(
  valvesA: [number, number, number],
  valvesB: [number, number, number],
): { gaugesAtA: [number, number, number]; gaugesAtB: [number, number, number] } {
  // Bank A's valves control Bank B's gauges (H1, H2, H3)
  const gaugesAtB: [number, number, number] = [
    10 * (valvesA[0] + valvesA[1]),
    10 * (valvesA[1] + valvesA[2]),
    10 * (valvesA[0] + valvesA[2]),
  ];
  // Bank B's valves control Bank A's gauges (G1, G2, G3)
  const gaugesAtA: [number, number, number] = [
    10 * (valvesB[0] + valvesB[1]),
    10 * (valvesB[1] + valvesB[2]),
    10 * (valvesB[0] + valvesB[2]),
  ];
  return { gaugesAtA, gaugesAtB };
}

export function isPipeOrganValid(pipes: [number, number, number, number, number]): boolean {
  const s = SOLUTIONS.p5_organ;
  return pipes.every((v, i) => v === s[i]);
}

export function computeGearSpeeds(
  slots: [string | null, string | null, string | null],
): [number | null, number | null, number | null] {
  // Power flows serially from the 60 RPM 12T motor through Shaft 1 -> Shaft 2 -> Shaft 3.
  // A mounted gear after an empty shaft is not touching any driven gear, so it stands still (0 RPM).
  let driven = true;
  return slots.map((teeth) => {
    if (!teeth) {
      driven = false;
      return null;
    }
    if (!driven) return 0;
    const n = Number(teeth);
    if (!n) {
      driven = false;
      return 0;
    }
    return Math.round((720 / n) * 10) / 10;
  }) as [number | null, number | null, number | null];
}

// Readable in-world plaques, letters, and murals (automatically saved to Notebook when inspected!)
export interface ClueDefinition {
  id: string;
  title: string;
  zone: string;
  body: string;
}

export const WORLD_CLUES: Record<string, ClueDefinition> = {
  clue_welcome_ledger: {
    id: 'clue_welcome_ledger',
    title: "Master Vance's Welcome Ledger",
    zone: 'Grand Foyer',
    body: `Welcome, Apprentices.
Recover the four Resonance Cores across the estate to unseal the Grand Solstice Gate in the northern Sky-Garden.

THE AWAKENING CLOCK:
My Grandfather Clock wakes the manor when set to my favorite morning hour:
  • For the HOUR, count the golden rays woven around the Foyer sun rug.
  • For the MINUTES, search the Foyer credenza drawers for my stopped pocket watch.

Once the clock chimes, pull the twin entry levers together.`,
  },

  clue_foyer_pocket_watch: {
    id: 'clue_foyer_pocket_watch',
    title: 'Stopped Brass Pocket Watch',
    zone: 'Grand Foyer (Credenza Drawer)',
    body: `TUCKED INSIDE THE VELVET-LINED DRAWER:
The short hour hand has snapped cleanly off, but the slender blued-steel minute hand is jammed solidly at 35 minutes past the hour (:35).`,
  },

  clue_tea_north_mural: {
    id: 'clue_tea_north_mural',
    title: 'North Booth Botanical Mural',
    zone: 'Tea Parlor (North Booth)',
    body: `BOTANICAL GRID (Visible only from the North Booth):
  Row A:  [A1: ☀ Sun]    [A2: 🌿 Leaf]  [A3: ⚙ Gear]
  Row B:  [B1: 🌙 Moon]  [B2: 🔔 Bell]  [B3: 💧 Drop]
  Row C:  [C1: ★ Star]   [C2: 🗝 Key]   [C3: 🪶 Feather]

CALL THESE FOUR DIALS THROUGH THE GLASS:
  • I:  Directly South of Sun  (☀ ↓)
  • II: Exact center of the grid  (⊕)
  • III: From Key, 1 East then 2 North  (🗝 → ↑ ↑)
  • IV: Corner opposite the Gear  (⚙ ↙)`,
  },

  clue_tea_balance_plaque: {
    id: 'clue_tea_balance_plaque',
    title: 'Apothecary Tea Blend',
    zone: 'Tea Parlor (South Booth)',
    body: `THE MORNING BLEND (Watch the brass balance lamps as you weigh):
  • Amber + Jade = 15g  (Amber is 3g heavier)
  • Rose = twice Mint
  • All four canisters = 33g total`,
  },

  clue_core_sun_cardinal: {
    id: 'clue_core_sun_cardinal',
    title: 'Solstice Plaque I — Sun Core',
    zone: 'Tea Parlor Drawer',
    body: `ENGRAVED ON THE BRASS SUN MEDALLION:
"At the Grand Solstice Gate in the Sky-Garden, turn the SUN Resonance Pedestal toward the rising dawn: EAST (E)."`,
  },

  clue_uv_frames_note: {
    id: 'clue_uv_frames_note',
    title: 'Study Safe Engraving',
    zone: "Alchemist's Study",
    body: `ENGRAVED ABOVE THE WALL SAFE:
"Four blank frames hang in my Study, written in Aether Ink invisible to ordinary sight. Shine the UV Lantern ([F]) upon each canvas, then enter their four digits in order from SMALLEST frame to LARGEST frame."`,
  },

  clue_uv_frame_0: {
    id: 'clue_uv_frame_0',
    title: 'UV Frame #1 (Tiny Frame)',
    zone: "Alchemist's Study",
    body: `REVEALED IN VIOLET AETHER INK (Size 1 — Smallest):
"First letters spell the digit: Soft Embers Vanish Every Night."`,
  },
  clue_uv_frame_1: {
    id: 'clue_uv_frame_1',
    title: 'UV Frame #2 (Small Frame)',
    zone: "Alchemist's Study",
    body: `REVEALED IN VIOLET AETHER INK (Size 2):
"A number hides unbroken across two words: BENEATH REEDS, GOLD SLEEPS."`,
  },
  clue_uv_frame_2: {
    id: 'clue_uv_frame_2',
    title: 'UV Frame #3 (Medium Frame)',
    zone: "Alchemist's Study",
    body: `REVEALED IN VIOLET AETHER INK (Size 3):
"Look to the rolling library ladder — count every wooden rung from floor to top."`,
  },
  clue_uv_frame_3: {
    id: 'clue_uv_frame_3',
    title: 'UV Frame #4 (Large Frame)',
    zone: "Alchemist's Study",
    body: `REVEALED IN VIOLET AETHER INK (Size 4 — Largest):
"Above the writing desk, count the glowing alchemical flasks lined along the walnut shelf."`,
  },

  clue_organ_rules: {
    id: 'clue_organ_rules',
    title: 'Harmonic Pipe Organ Rules',
    zone: "Alchemist's Study",
    body: `ARRANGE THE 5 BRASS PIPES (Lengths 1 through 5, Left to Right):
  1. No two adjacent pipes may have consecutive lengths (e.g., 2 cannot sit beside 1 or 3).
  2. Slot 3 holds the shortest pipe (Length 1).
  3. Slot 4 is taller than Slot 2.
  4. Slot 1 is an even length (2 or 4), and Slot 5 is Length 3.`,
  },

  clue_core_gear_cardinal: {
    id: 'clue_core_gear_cardinal',
    title: 'Solstice Plaque II — Gear Core',
    zone: "Alchemist's Study Organ",
    body: `ENGRAVED BESIDE THE 18-TOOTH GEAR:
"At the Grand Solstice Gate in the Sky-Garden, turn the GEAR Resonance Pedestal toward the noon warmth: SOUTH (S)."`,
  },

  clue_sundial_tablet: {
    id: 'clue_sundial_tablet',
    title: 'Equinox Sundial Stone Tablet',
    zone: 'Sunlit Courtyard',
    body: `THE THREE SUNDIAL RINGS (Search the estate — no guesswork needed):
  • HOUR:     Sketched on a brass card inside the Study desk drawer.
  • AZIMUTH:  Engraved on the brass rim of the Courtyard fountain basin.
  • DAY:      Tucked inside a loose crimson almanac on the Study bookcase.`,
  },

  clue_study_drawer_sketch: {
    id: 'clue_study_drawer_sketch',
    title: 'Sundial Brass Sketch (Study Drawer)',
    zone: "Alchemist's Study (Desk Drawer)",
    body: `A CHARCOAL & GOLD-LEAF SKETCH TUCKED IN THE DESK DRAWER:
"Courtyard Equinox Sundial — set the outer HOUR ring to VI (6)."`,
  },

  clue_fountain_rim: {
    id: 'clue_fountain_rim',
    title: 'Fountain Basin Engraving',
    zone: 'Sunlit Courtyard (Fountain Rim)',
    body: `ETCHED INTO THE MARBLE & BRASS FOUNTAIN RIM:
"Four sunlit quadrants around the fountain — Courtyard Sundial AZIMUTH = 4."`,
  },

  clue_study_secret_book: {
    id: 'clue_study_secret_book',
    title: 'Hollow Almanac (Study Bookcase)',
    zone: "Alchemist's Study (Bookcase)",
    body: `SLIPPED INSIDE THE HOLLOWED-OUT ALMANAC:
"Solstice Equinox — set the Courtyard Sundial DAY ring to 10."`,
  },

  clue_mirror_plaque: {
    id: 'clue_mirror_plaque',
    title: 'Solar Relay Notice',
    zone: 'Sunlit Courtyard',
    body: `COURTYARD LIGHT RELAY (2-Player Cooperation):
  1. Place the Pocket Brass Prism into the Sun-Emitter by the North Courtyard Arch.
  2. Rotate Mirrors 1, 2, and 3 so the golden sunbeam bounces into the Botanical Conservatory's Roof Prism Receptor (West Wall).
  3. Mirror 2's spring clutch requires one apprentice to stand on the Courtyard Sun-Pad (near the fountain's south-east corner) while the other aligns the mirrors! Once the beam hits the Conservatory Receptor, the clutch latches permanently.`,
  },

  clue_irrigation_plaque: {
    id: 'clue_irrigation_plaque',
    title: 'Cross-Wired Irrigation Schematic',
    zone: 'Botanical Conservatory',
    body: `GLASSHOUSE IRRIGATION PIPING (2-Player Cooperation):
The brass pipes run UNDERNEATH the koi pond:
  • North Bank's valves (A1, A2, A3) control the South Bank's gauges!
  • South Bank's valves (B1, B2, B3) control the North Bank's gauges!
  • Each gauge sums TWO valves (10 PSI per turn).

Work together across the pond to bring ALL SIX gauges to their green target lines simultaneously!`,
  },

  clue_workshop_blueprint: {
    id: 'clue_workshop_blueprint',
    title: 'Workshop Gear-Train Blueprint',
    zone: 'Clockwork Workshop',
    body: `VANCE GEAR-TRAIN SPECIFICATION:
The fixed Input Motor turns a 12-tooth gear at 60 RPM.
In a single-plane meshing gear train, every shaft's speed follows:
    Shaft RPM = 720 ÷ (Number of Teeth)

Mount three gears on Shafts 1, 2, and 3 to hit these exact speeds:
  • Shaft 1 Target: 30 RPM
  • Shaft 2 Target: 40 RPM  (Note: the missing 18T gear is hidden in the Study!)
  • Shaft 3 Target: 20 RPM

Once running, pull the North-East and South-East Foundry Levers simultaneously THREE TIMES to forge the Gear Core!`,
  },

  clue_orrery_ledger: {
    id: 'clue_orrery_ledger',
    title: 'Observatory Orrery Ledger',
    zone: 'Starlight Observatory Deck',
    body: `PLANETARY ORRERY ALIGNMENT (8-Point Brass Compass, 1 to 8 clockwise):
  1. All four planets occupy DIFFERENT numbers (1 through 8).
  2. Sun-Gold sits directly at Position 2.
  3. Mars-Copper is exactly 3 steps clockwise from Sun-Gold.
  4. Sea-Cobalt sits directly opposite Sun-Gold (4 steps around the 8-point ring).
  5. Moon-Silver sits exactly 2 steps counter-clockwise from Sun-Gold.`,
  },

  clue_core_star_cardinal: {
    id: 'clue_core_star_cardinal',
    title: 'Solstice Plaque III — Star Core',
    zone: 'Starlight Observatory Deck',
    body: `ENGRAVED INSIDE THE ORRERY DOME:
"At the Grand Solstice Gate in the Sky-Garden, turn the STAR Resonance Pedestal toward the pole star: NORTH (N)."`,
  },

  clue_terrace_arch: {
    id: 'clue_terrace_arch',
    title: 'Under-Arch Resonance Relief',
    zone: 'Sky-Garden Terrace (Ground Level)',
    body: `CARVED ON THE UNDERSIDE OF THE OBSERVATORY ARCH (Only visible from the ground!):
Stand on each Resonance Stone below in order while your partner above plucks the matching Wind-Harp Chime:

    Step 1:  AZURE   (Blue Stone / Azure Chime)
    Step 2:  AMBER   (Gold Stone / Amber Chime)
    Step 3:  VIOLET  (Purple Stone / Violet Chime)
    Step 4:  EMERALD (Green Stone / Emerald Chime)`,
  },

  clue_core_wind_cardinal: {
    id: 'clue_core_wind_cardinal',
    title: 'Solstice Plaque IV — Wind Core',
    zone: 'Sky-Garden Wind Spire',
    body: `ENGRAVED ON THE WIND SPIRE:
"At the Grand Solstice Gate in the Sky-Garden, turn the WIND Resonance Pedestal toward the evening breeze: WEST (W)."`,
  },
};

// Progressive 3-Tier Hints for EVERY puzzle (awarded by the Clockwork Oracle Hint Minigame!)
export interface PuzzleHintTrack {
  puzzleId: PuzzleId;
  title: string;
  order: number;
  tiers: [string, string, string];
}

export const PUZZLE_HINTS: PuzzleHintTrack[] = [
  {
    puzzleId: 'p1_foyer_clock',
    title: 'Grand Foyer Awakening Clock',
    order: 1,
    tiers: [
      'Read Master Vance\'s Welcome Ledger on the Foyer lectern, then look closely around the Foyer itself.',
      'Count the golden triangular rays woven around the Foyer rug for the Hour, and open the Foyer credenza drawer to inspect the stopped pocket watch for the Minutes.',
      'There are 9 golden rays on the Foyer rug and the pocket watch is stopped at :35 — set the clock to 09:35.',
    ],
  },
  {
    puzzleId: 'p1_twin_levers',
    title: 'Foyer Twin Courtyard Levers',
    order: 2,
    tiers: [
      'Now that the clock has energized the conduits, look to the left and right walls beside the big North Courtyard Double Doors.',
      'One apprentice must stand at the Left Lever and the other at the Right Lever — count down 3-2-1 and pull them within 2.5 seconds of each other!',
      'Have Player 1 pull the Left Entry Lever and Player 2 pull the Right Entry Lever simultaneously (within 2.5s) to unseal the Courtyard and release the Brass Study Key.',
    ],
  },
  {
    puzzleId: 'p2_tea_cipher',
    title: 'Tea Parlor Split-Booth Cipher',
    order: 3,
    tiers: [
      'Enter the East Tea Parlor. One apprentice stands on the glowing Brass Floor Plate in the Foyer to hold open the North Booth grille so the other can walk inside and read the wall mural through the glass.',
      'Trace the 4 directions on the North Booth\'s 3×3 Botanical Grid: South of Sun is B1; exact center is B2; from Key (C2) go 1 East (C3) then 2 North (A3); diagonally opposite Gear (A3) is C1.',
      'Set the South Booth Cipher Dials to: Moon (🌙), Bell (🔔), Gear (⚙), Star (★) to unlock the UV Lamp!',
    ],
  },
  {
    puzzleId: 'p3_tea_balance',
    title: 'Apothecary Tea Balance Scale',
    order: 4,
    tiers: [
      'Read the Tea Blend plaque in the South Tea Parlor and use your Brass Calculator ([C]). Start by finding Amber and Jade: two numbers adding to 15 that differ by 3.',
      'Amber = 9g and Jade = 6g (9+6=15). Since all four weigh 33g, Rose + Mint = 18g, and Rose = 2 × Mint.',
      'Set the canisters to: Amber = 9g, Jade = 6g, Rose = 12g, Mint = 6g.',
    ],
  },
  {
    puzzleId: 'p4_uv_safe',
    title: 'Study UV Invisible-Ink Safe',
    order: 5,
    tiers: [
      'Unlock the West Study Door with the Brass Study Key. Equip the UV Lamp ([F]) from the Tea Parlor and shine it directly at the four blank picture frames on the Study walls.',
      'Order the four frames from smallest to largest: Tiny is an acrostic (first letters spell a number), Small hides a number spanning two words ("beneaTH REEds"), Medium counts the rolling ladder rungs, and Large counts the glowing flasks above the desk.',
      'Enter 7 - 3 - 8 - 5 into the Study Wall Safe to claim the Conservatory Glass Key and Pocket Brass Prism.',
    ],
  },
  {
    puzzleId: 'p5_pipe_organ',
    title: 'Harmonic Brass Pipe Organ',
    order: 6,
    tiers: [
      'Read the Organ Rules on the Study desk. Start by placing the fixed lengths: Slot 3 = 1, Slot 5 = 3. Remember no adjacent slots can differ by 1!',
      'Since Length 2 cannot sit next to Slot 3 (Length 1), Length 2 MUST go in Slot 1! And Length 4 cannot sit next to Slot 5 (Length 3), so Length 4 must go in Slot 2.',
      'Arrange the 5 brass pipes from left to right as: [2, 4, 1, 5, 3].',
    ],
  },
  {
    puzzleId: 'p6_sundial',
    title: 'Courtyard Equinox Sundial',
    order: 7,
    tiers: [
      'Read the Stone Tablet beside the Courtyard Sundial — its three settings are hidden around the Courtyard and back inside the Alchemist\'s Study.',
      'Open the desk drawer in the Alchemist\'s Study for the Hour sketch (6), inspect the Courtyard Fountain brass rim for Azimuth (4), and pull the loose book on the Study bookcase for Day (10).',
      'Set the Courtyard Sundial rings to: Hour = 6, Azimuth = 4, Day = 10 to unlock the Clockwork Workshop.',
    ],
  },
  {
    puzzleId: 'p7_light_relay',
    title: 'Courtyard Solar Beam Mirror Relay',
    order: 8,
    tiers: [
      'First insert the Pocket Brass Prism (from the Study Safe) into the Sun-Emitter on the North Courtyard Arch. Then align the 3 brass mirrors to bounce the golden beam into the Conservatory Roof Receptor on the West wall.',
      'Mirror 2 drifts unless one apprentice stands on the glowing Sun-Pad near the fountain\'s south-east corner! Hold the pad while your partner rotates Mirrors 1, 2, and 3.',
      'While one player holds the Courtyard Sun-Pad, rotate Mirror 1 to notch 5, Mirror 2 to notch 6, and Mirror 3 to notch 2 so the beam locks into the Conservatory!',
    ],
  },
  {
    puzzleId: 'p8_irrigation',
    title: 'Conservatory Cross-Wired Irrigation',
    order: 9,
    tiers: [
      'Unlock the Botanical Conservatory with the Glass Key. Stand at opposite sides of the koi pond: North Bank valves control South Bank gauges, and South Bank valves control North Bank gauges!',
      'Test turning one valve at a time and have your partner call out which two gauges rise by 10 PSI. For Bank A (targets 50, 40, 50 at Bank B), sum all three equations: 2(A1+A2+A3)=14 so A1+A2+A3=7.',
      'Set North Bank Valves (A1, A2, A3) to [3, 2, 2] and South Bank Valves (B1, B2, B3) to [2, 4, 1].',
    ],
  },
  {
    puzzleId: 'p9_gear_train',
    title: 'Workshop Clockwork Gear-Train',
    order: 10,
    tiers: [
      'Check the Workshop Blueprint: Shaft RPM = 720 ÷ Teeth. Use your Brass Calculator ([C]) to find which gear tooth counts produce 30, 40, and 20 RPM. (Make sure you got the 18T gear from the Study Pipe Organ!)',
      '720 ÷ 30 = 24 teeth; 720 ÷ 40 = 18 teeth; 720 ÷ 20 = 36 teeth.',
      'Mount gears on the Workshop Bench as: Shaft 1 = 24T, Shaft 2 = 18T, Shaft 3 = 36T.',
    ],
  },
  {
    puzzleId: 'p10_foundry_sync',
    title: 'Synchronized Foundry Forging',
    order: 11,
    tiers: [
      'Once the Gear-Train is spinning, look for the two glowing Brass Bellows Levers at the North-East and South-East corners of the Clockwork Workshop.',
      'Have each apprentice stand by one lever and pull them at the exact same moment (within 2 seconds). Repeat 3 times to finish forging the Gear Core!',
      'Pull the North-East and South-East Foundry Levers together 3 times in sync to forge and claim the Gear Resonance Core.',
    ],
  },
  {
    puzzleId: 'p11_orrery',
    title: 'Observatory Planetary Orrery',
    order: 12,
    tiers: [
      'Use the Sky-Lift Key (from the Workshop) on the North-East Courtyard Lift Gate, then head up to the Observatory Sky-Deck. Read the Orrery Ledger carefully.',
      'Start with Sun-Gold at 2. Step 3 clockwise for Mars-Copper (5), go directly across the 8-point ring for Sea-Cobalt (6), and step 2 counter-clockwise from 2 (2 → 1 → 8) for Moon-Silver!',
      'Set the Orrery planets to: Sun-Gold = 2, Mars-Copper = 5, Moon-Silver = 8, Sea-Cobalt = 6.',
    ],
  },
  {
    puzzleId: 'p12_wind_harp',
    title: 'Sky-Deck Wind-Harp & Terrace Relay',
    order: 13,
    tiers: [
      'One apprentice goes up to the Observatory Deck (Wind-Harp Chimes) while the other goes down to the northern Sky-Garden Terrace. Look at the carving on the UNDERSIDE of the stone arch from the ground!',
      'For each of the 4 steps, the Terrace player stands on the matching colored Resonance Stone while the Observatory player plucks that color on the Wind-Harp.',
      'Harmonize in exact order: 1. AZURE -> 2. AMBER -> 3. VIOLET -> 4. EMERALD.',
    ],
  },
  {
    puzzleId: 'p13_solstice_gate',
    title: 'The Grand Solstice Gate Finale',
    order: 14,
    tiers: [
      'Bring all 4 Resonance Cores (Sun, Gear, Star, Wind) to the pedestals before the Grand Solstice Gate in the Sky-Garden. Check your Field Notebook ([N]) for the four cardinal directions found across the estate!',
      'Rotate the four Core Pedestals to: Sun = EAST, Gear = SOUTH, Star = NORTH, Wind = WEST.',
      'Insert all 4 Cores, set Sun=E, Gear=S, Star=N, Wind=W, then stand on BOTH glowing Twin Solstice Pads in front of the gate together to open the Grand Solstice Gate!',
    ],
  },
];

export function createInitialPuzzleStates(): WorldPuzzleStates {
  return {
    clockDigits: [1, 2, 0, 0],
    foyerLeverLeftAt: 0,
    foyerLeverLeftBy: null,
    foyerLeverRightAt: 0,
    foyerLeverRightBy: null,

    teaCipherDials: ['sun', 'sun', 'sun', 'sun'],
    foyerPlatePressedBy: [],

    teaWeights: { amber: 5, jade: 5, rose: 5, mint: 5 },

    uvRevealedFrames: [],
    studySafeDigits: [0, 0, 0, 0],

    organPipes: [1, 2, 3, 4, 5],

    sundial: { hour: 12, azimuth: 1, day: 1 },

    prismInserted: false,
    mirrorAngles: [0, 0, 0],
    mirror2ClutchHeldBy: [],
    mirror2Latched: false,

    valvesA: [0, 0, 0],
    valvesB: [0, 0, 0],

    gearSlots: [null, null, null],

    foundryStage: 0,
    foundryLeverNorthAt: 0,
    foundryLeverNorthBy: null,
    foundryLeverSouthAt: 0,
    foundryLeverSouthBy: null,

    orrery: { sun: 1, mars: 1, moon: 1, sea: 1 },

    windHarpStep: 0,
    terracePadOccupied: { amber: [], emerald: [], azure: [], violet: [] },

    gateCoresInserted: { sun: false, gear: false, star: false, wind: false },
    gateDials: { sun: 'N', gear: 'N', star: 'N', wind: 'N' },
    finalePadLeftBy: [],
    finalePadRightBy: [],
  };
}
