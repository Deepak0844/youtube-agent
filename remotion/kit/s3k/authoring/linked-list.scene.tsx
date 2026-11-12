// EXAMPLE D (an idea, no models): a doubly linked list. COPY for any abstract topic (data structures, algorithms, networks, how data flows):
// big simple parts on the "studio" backdrop, laid out to fill the TALL frame (a staircase, not a long row), arrow() for every link so the
// direction reads, label() tags that name the parts (head, next, prev, null, values), one idea per beat in time order, and shots that
// change size and angle between beats while the whole hero stays in the frame.
import React, { useMemo } from "react";
import * as THREE from "three";
import { CameraRig, Finish, Hero, World, arrow, box, glideTimes, glow, label, ramp, smooth, std, useT } from "s3k";
import type { SceneProps } from "s3k";

const N = 4, W = 3.2, H = 1.8, D = 1.4, STEP_X = 1.6, STEP_Y = 3.2, BOTTOM = 1.6;
const VALUES = ["12", "7", "31", "5"];
const nodeAt = (i: number) => new THREE.Vector3(-((N - 1) * STEP_X) / 2 + i * STEP_X, BOTTOM + (N - 1 - i) * STEP_Y, 0);
const FOCUS = { min: [-6, 0, -3] as [number, number, number], max: [6, 13.5, 3] as [number, number, number] };
const HERO_BOX = { min: [-5, 0.4, -0.8] as [number, number, number], max: [5.6, 12.6, 0.8] as [number, number, number] }; // includes the tags

export default function Scene({ durationS }: SceneProps) {
  const t = useT();
  const parts = useMemo(() => {
    const hero = new THREE.Group(), tags = new THREE.Group();
    const body = std("#e9eef8", { roughness: 0.45 }), nextBox = std("#2ec5d3", { roughness: 0.4 }), prevBox = std("#f2994a", { roughness: 0.4 });
    const nextMat = glow("#36e0f0", 2.2), prevMat = glow("#ffa64d", 2.2);
    const nodes: THREE.Group[] = [], values: THREE.Sprite[] = [];
    for (let i = 0; i < N; i++) {
      const g = new THREE.Group();
      g.position.copy(nodeAt(i));
      box(0.8, H, D, prevBox, -W / 2 + 0.4, 0, 0, g); // prev slot (left)
      box(W - 1.6, H, D, body, 0, 0, 0, g); // data slot (middle)
      box(0.8, H, D, nextBox, W / 2 - 0.4, 0, 0, g); // next slot (right)
      hero.add(g);
      nodes.push(g);
      const v = label(VALUES[i] ?? "", { size: 0.9 });
      v.position.copy(nodeAt(i)).add(new THREE.Vector3(0, 0, D / 2 + 0.05));
      tags.add(v);
      values.push(v);
    }
    // A link grows from its start: the arrow is built at the origin of a pivot that sits on the start point, then the pivot is scaled.
    const link = (a: THREE.Vector3, b: THREE.Vector3, mat: THREE.Material) => {
      const pivot = new THREE.Group();
      pivot.position.copy(a);
      arrow(new THREE.Vector3(0, 0, 0), b.clone().sub(a), 0.13, mat, pivot);
      hero.add(pivot);
      return pivot;
    };
    const next: THREE.Group[] = [], prev: THREE.Group[] = [];
    for (let i = 0; i < N - 1; i++) {
      const a = nodeAt(i), b = nodeAt(i + 1);
      next.push(link(new THREE.Vector3(a.x + W / 2 - 0.4, a.y - H / 2, 0.3), new THREE.Vector3(b.x + W / 2 - 0.4, b.y + H / 2 + 0.05, 0.3), nextMat));
      prev.push(link(new THREE.Vector3(b.x - W / 2 + 0.4, b.y + H / 2, -0.3), new THREE.Vector3(a.x - W / 2 + 0.4, a.y - H / 2 - 0.05, -0.3), prevMat));
    }
    const last = nodeAt(N - 1);
    const nullLink = link(new THREE.Vector3(last.x + W / 2, last.y, 0), new THREE.Vector3(last.x + W / 2 + 0.9, last.y, 0), nextMat);
    const tag = (text: string, at: THREE.Vector3, size = 0.95) => { const s = label(text, { size }); s.position.copy(at); tags.add(s); return s; };
    const first = nodeAt(0);
    const head = tag("head", new THREE.Vector3(first.x - 1.3, first.y + H / 2 + 0.8, 0));
    const nul = tag("null", new THREE.Vector3(last.x + W / 2 + 0.6, last.y - H / 2 - 0.7, 0));
    const nextTag = tag("next", new THREE.Vector3(nodeAt(1).x + W / 2 + 1.0, nodeAt(1).y + H / 2 + 0.7, 0));
    const prevTag = tag("prev", new THREE.Vector3(nodeAt(1).x - W / 2 - 1.0, nodeAt(1).y + H / 2 + 0.7, 0));
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.35, 24, 16), glow("#fff6c2", 3));
    hero.add(marker);
    return { hero, tags, nodes, values, next, prev, nullLink, head, nul, nextTag, prevTag, marker };
  }, []);

  // One idea per stretch of the film (fractions of the length, so it fits any narration).
  const at = (f: number) => f * durationS;
  parts.nodes.forEach((g, i) => g.scale.setScalar(Math.max(0.001, smooth(ramp(t, at(0.02 + i * 0.03), at(0.06 + i * 0.03))))));
  parts.values.forEach((v, i) => { v.visible = t > at(0.06 + i * 0.03); });
  parts.head.visible = t > at(0.12);
  parts.next.forEach((p, i) => p.scale.setScalar(Math.max(0.001, smooth(ramp(t, at(0.16 + i * 0.05), at(0.21 + i * 0.05))))));
  parts.nextTag.visible = t > at(0.2);
  parts.nullLink.scale.setScalar(Math.max(0.001, smooth(ramp(t, at(0.31), at(0.34)))));
  parts.nul.visible = t > at(0.34);
  parts.prev.forEach((p, i) => p.scale.setScalar(Math.max(0.001, smooth(ramp(t, at(0.52 + i * 0.05), at(0.57 + i * 0.05))))));
  parts.prevTag.visible = t > at(0.56);
  // The marker walks down the next links (0.36..0.5), then back up the prev links (0.7..0.84).
  const down = ramp(t, at(0.36), at(0.5)) * (N - 1), up = ramp(t, at(0.7), at(0.84)) * (N - 1);
  const pos = t < at(0.7) ? down : N - 1 - up;
  const k = Math.min(N - 2, Math.floor(pos)), u = smooth(pos - k);
  const a = nodeAt(k), b = nodeAt(k + 1);
  parts.marker.position.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u + H / 2 + 0.45, 0);
  parts.marker.visible = t > at(0.36);

  const shots = useMemo(() => {
    const [t0 = 0, t1 = 1, t2 = 2, t3 = 3] = glideTimes(4, durationS);
    return [
      { t: t0, frame: { box: HERO_BOX, yawDeg: 0, pitchDeg: 6 } },
      { t: t1, frame: { box: HERO_BOX, yawDeg: 26, pitchDeg: 10, distanceMul: 1.3 } },
      { t: t2, frame: { box: HERO_BOX, yawDeg: -24, pitchDeg: 4 } },
      { t: t3, frame: { box: HERO_BOX, yawDeg: 8, pitchDeg: 12, distanceMul: 1.45 } },
    ];
  }, [durationS]);
  return (
    <>
      <World focus={FOCUS} preset="studio" ground={{ y: 0, kind: "plain", color: "#141b2e" }} sea={false} />
      <Hero><primitive object={parts.hero} /></Hero>
      <primitive object={parts.tags} />
      <CameraRig shots={shots} floor={1.2} />
      <Finish />
    </>
  );
}
