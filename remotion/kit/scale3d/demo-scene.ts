import type { Scale3dScene } from "../../../src/shared/scale3d/schema";

/** The approved prototype as data: climb a crane, a crane lifts a small crane, then the skyline's big tower, back to the start. */
export const SCALE3D_DEMO: Scale3dScene = {
  version: 1,
  loop_back: true,
  ruler: { show_ticks: true },
  objects: [
    { id: "crane", kind: "tower_crane", label: "Tower crane", height_m: 79, claim: { method: "Typical free-standing tower crane under hook height, about 79 m." }, carries: "mini" },
    { id: "mini", kind: "small_crane", label: "Small crane", height_m: 18, claim: { method: "Compact mobile crane mast, about 18 m." } },
    { id: "house", kind: "house_row", label: "Houses", height_m: 9, claim: { method: "Two-storey terraced houses, about 9 m." } },
    { id: "tower", kind: "skyscraper", label: "Skyscraper", height_m: 330, claim: { source_url: "https://example.com/tower", quote: "The tower stands 330 metres tall." } },
  ],
  beats: [
    { focus: "house", duration_s: 4, label: "A street", caption: "Start at street level." },
    { focus: "crane", range_m: [0, 79], duration_s: 7, label: "Climb the crane", caption: "Now climb a tower crane." },
    { focus: "crane", range_m: [60, 79], duration_s: 4, label: "79 metres up", caption: "Seventy-nine metres up." },
    { focus: "mini", duration_s: 6, label: "Crane lifts crane", caption: "It lifts a whole other crane." },
    { focus: "tower", range_m: [0, 330], duration_s: 8, label: "The big one", caption: "But the big one dwarfs it." },
    { focus: "house", duration_s: 5, label: "Back to square one", caption: "And back to the street." },
  ],
};
