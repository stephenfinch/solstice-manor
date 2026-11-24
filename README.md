# ☀️ Solstice Manor — 2-Player Cooperative LAN Escape Room

A sunlit, cozy, non-scary **first-person 3D browser escape room** built for **two players over LAN** (or two browser tabs on one machine). Explore interconnected indoor studies, glass conservatories, clockwork workshops, an upper observatory sky-deck, and open-air courtyards to recover the four Resonance Cores and open the **Grand Solstice Gate**.

## Trailer

https://github.com/user-attachments/assets/25bb9b76-ea25-465c-a69e-a83dc0f83346

*(Direct file: [solstice-manor-trailer.mp4](./solstice-manor-trailer.mp4))*

## Quick Start (LAN Multiplayer)

```bash
npm install
npm start
```

The server binds to `0.0.0.0:3000` and prints both your **Local URL** and your machine's **LAN URL** (e.g., `http://192.168.x.x:3000`):
1. **Player 1** opens the URL in any modern browser, enters an apprentice name, and clicks **Create New Estate Session**.
2. **Player 2** (on another computer on the same Wi-Fi/LAN) opens the displayed **LAN URL**, enters the 4-letter room code (or clicks the auto-discovered session under *Active Sessions on This LAN*), and joins!

*(You can also run `npm test` to execute the full automated 13-puzzle and live WebSocket multiplayer test suite.)*

## Controls

| Key | Action |
|---|---|
| **WASD / Arrows** | Walk around (hold **Shift** to brisk-walk) |
| **Mouse** | First-person look (click 3D canvas to lock mouse) |
| **E / Left-Click** | Interact, inspect plaques, open puzzle mechanisms, pick up items |
| **F** | Toggle **Aether UV Lantern** (reusable tool once acquired) |
| **Q / Middle-Click** | Drop a 3D **Coop Beacon Ping** visible to your partner |
| **1 – 9** | Select inventory item |
| **N** | Open **Field Notebook** (auto-logged clues, Oracle hints, live shared scratchpad) |
| **C** | Open **Brass Arithmometer** (in-game calculator) |
| **H** | Open **The Clockwork Oracle** (2-player coop Hint Minigame) |
| **M** | Mute / unmute spatial soundscape |
| **Esc** | Release cursor or close active panel |

## Core Features

- **Seamless Indoor + Outdoor 3D Estate**: Grand Foyer, Split-Window Tea Parlor, Alchemist's Study, Sunlit Fountain Courtyard, Botanical Conservatory, Clockwork Workshop, Starlight Observatory Sky-Deck, and Sky-Garden Terrace.
- **100% Self-Contained Logic & 2-Player Cooperation**: 13 interconnected puzzles (~1 hour average playthrough) with zero external trivia — featuring split-booth glass communication, floor counterweight plates, synchronized dual levers, a 3D courtyard solar beam mirror relay, cross-wired koi pond irrigation valves, gear-train engineering, a planetary orrery, and a vertical balcony-to-terrace wind-harp relay.
- **One-and-Done Keys & Reusable Tools**: Every key (`Study Key`, `Glass Key`, `Sky-Lift Key`) is consumed immediately upon unlocking its matching door. Tools (`Aether UV Lantern`, `Pocket Brass Prism`, `Field Notebook`, `Brass Calculator`) stay available indefinitely.
- **The Clockwork Oracle (Hint Minigame)**: Unlimited progressive 3-tier hints earned via a 35-second real-time 2-player cooperative **Aether-Gear Catch & Crank** minigame followed by an exciting **3-Casket Fate Draw** (exact **2/3** chance of winning a clue!). Starts unlocked at game start, with a **10-minute cooldown** between plays.
- **Procedural Spatial Web Audio**: Zero-dependency Web Audio API engine with zone-crossfaded ambients (ticking clocks, hearth crackle, outdoor breeze, spatially attenuated bubbling fountain, songbirds, wind chimes, conservatory koi pond, workshop clockwork, observatory star-pad) and floor-material-aware footsteps.
