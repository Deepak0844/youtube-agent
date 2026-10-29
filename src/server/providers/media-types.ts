// What a stored media file records about itself. `quoted` is true when priceMicroUsd is our quote, false when the provider reported it.
export type MediaArtifact = {
  path: string;
  bytes: number;
  sha256: string;
  durationS?: number;
  width?: number;
  height?: number;
  provenance: {
    provider: string;
    model?: string;
    params: Record<string, unknown>;
    priceMicroUsd: number;
    quoted: boolean;
    licence?: string;
    sourceUrl?: string;
    attribution?: string;
  };
};
