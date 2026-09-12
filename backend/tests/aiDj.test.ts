import { describe, expect, it } from "vitest";
import { LocalStationProvider } from "../src/services/aiDj.js";

describe("AI station provider", () => {
  it("holds when automation has an active track and no queued tracks", async () => {
    const provider = new LocalStationProvider();
    const d = await provider.decide({
      stationId: "station",
      nowPlaying: { state: "playing", media_asset_id: "track" },
      queue: [],
      audience: { listeners: 20 },
      recentEvents: [],
      config: {},
    });
    expect(d.actionType).toBe("hold");
    expect(d.confidence).toBeGreaterThan(0.9);
  });

  it("does not invent a track when the station is already healthy", async () => {
    const provider = new LocalStationProvider();
    const d = await provider.decide({
      stationId: "station",
      nowPlaying: { state: "playing", media_asset_id: "track" },
      queue: [{ media_asset_id: "next" }],
      audience: { listeners: 20 },
      recentEvents: [],
      config: {},
    });
    expect(d.actionType).toBe("hold");
  });
});
