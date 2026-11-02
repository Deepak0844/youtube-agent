"use client";
// Client-only, lazy: the kit and the Player load only when a page that shows them renders (never in other pages' bundles).
import dynamic from "next/dynamic";

const hole = <div aria-hidden className="h-96 w-full max-w-[320px] animate-pulse rounded-card bg-surface" />;

export const LazyPreviewStage = dynamic(() => import("./kit-preview").then((m) => m.PreviewStage), { ssr: false, loading: () => hole });
export const LazyKitSamples = dynamic(() => import("./kit-preview").then((m) => m.KitSamples), { ssr: false, loading: () => hole });
