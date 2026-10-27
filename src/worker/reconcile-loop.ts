// A single-flight maintenance loop. stop() prevents another tick and drains the current one.
export function startReconcileLoop(opts: { run(): Promise<void>; intervalMs?: number; log(message: string): void }) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = opts.run().catch(() => opts.log("reconcile failed; will retry")).finally(() => { pending = undefined; });
  };
  tick();
  const timer = setInterval(tick, opts.intervalMs ?? 15_000);
  return { async stop() { stopped = true; clearInterval(timer); await pending; } };
}
