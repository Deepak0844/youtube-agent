import { z } from "zod";
import { base, copy, LIMITS } from "./common";

export const NODE_KINDS = ["laptop", "resolver", "root", "tld", "rack"] as const;
const nodeId = z.string().regex(/^[a-z0-9_-]{1,16}$/, "must be 1-16 chars of a-z, 0-9, _ or -");

export const schema = z
  .object({
    ...base,
    kind: z.literal("network"),
    nodes: z
      .array(z.object({ id: nodeId, type: z.enum(NODE_KINDS), label: copy(LIMITS.nodeLabel) }))
      .min(2, "must have at least 2 nodes")
      .max(LIMITS.networkNodes, `must have at most ${LIMITS.networkNodes} nodes`),
    // Links animate in list order; a link with a packet label sends a packet along it.
    links: z
      .array(z.object({ from: nodeId, to: nodeId, packet: copy(LIMITS.packetLabel).optional() }))
      .min(1)
      .max(LIMITS.networkLinks, `must have at most ${LIMITS.networkLinks} links`),
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    s.nodes.forEach((n, i) => {
      if (ids.has(n.id)) ctx.addIssue({ code: "custom", path: ["nodes", i, "id"], message: `duplicate node id '${n.id}'` });
      ids.add(n.id);
    });
    s.links.forEach((l, i) => {
      for (const end of ["from", "to"] as const)
        if (!ids.has(l[end])) ctx.addIssue({ code: "custom", path: ["links", i, end], message: `no node with id '${l[end]}'` });
      if (l.from === l.to) ctx.addIssue({ code: "custom", path: ["links", i, "to"], message: "must differ from 'from'" });
    });
  });

export const describe = `kind "network": nodes[] (2-${LIMITS.networkNodes}), each {id (a-z0-9_-, max 16), type (${NODE_KINDS.join("|")}), label (max ${LIMITS.nodeLabel} chars)}; links[] (1-${LIMITS.networkLinks}), each {from, to (node ids), packet (optional label, packet label max ${LIMITS.packetLabel} chars; sends an animated packet)}. Nodes are laid out top to bottom.`;
