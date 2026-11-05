// Shared measurements of the tunnel example (metres). COPY THE IDEA: one place for the numbers every part agrees on, so the machine,
// the lining, the track and the station always meet. Street level is y = 0 and the cut face is the plane z = 0 (the viewer is on +z).
export const YA = -12; // tunnel axis height
export const BORE = 4.25; // radius of the hole the cutter digs
export const SH_O = 4.2, SH_I = 4.0; // shield skin outer / inner radius
export const LIN_O = 3.98, LIN_I = 3.4; // concrete lining outer / inner radius
export const SEA = -29; // water level beyond the cut
export const BOTTOM = -70; // bottom of the ground block
export const ST0 = -62, ST1 = -36; // station box, x range
export const XMIN = -170; // far end of the finished tunnel
export const STATION_TOP = -3.0; // ceiling of the station box
export const HOLE_BOTTOM = YA - BORE; // floor of the dug hole
export const RING_LEN = 1.5, RING_GAP = 0.07; // one lining ring = 1.5 m long, gap between rings
export const RAIL_Z = [-0.3, -1.7]; // two rails; the train runs on z = -1.0
export const RAIL_Y = YA - 2.4; // height of the rail head (top of the track bed)

/** Catalogue ids the tunnel example uses. The host resolves them through a ModelResolver. */
export const TUNNEL_MODELS = {
  worker: "pp_worker_yg2b", woman: "pp_woman_casual_jpkr", man: "pp_man_hmnu",
  car1: "pp_sports_car_1mkm", car2: "pp_suv_xsmt", car3: "pp_car_unqq", police: "pp_police_car_bwwn",
  house1: "pp_town_house_imvk", house2: "pp_house_roqi", bld: "pp_building_qohh",
  tree1: "pp_tree_qztx", tree2: "pp_tree_2paa", cone: "pp_traffic_cone_lax8", barrier: "pp_traffic_barrier_cm3a",
  crane: "pp_crane_17ab", lamp: "pp_lamp_round_floor_8lid", bench: "pp_bench_jlxj", container: "pp_shipping_container_dqxr",
  rock: "pp_rock_rtlr", ship: "pp_sail_ship_cizo", boat: "pp_boat_5uel",
} as const;
export type TunnelModel = keyof typeof TUNNEL_MODELS;
