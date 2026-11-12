// Re-mounts on every navigation inside the app, so each new page fades in (UI redesign: nothing should snap).
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="ui-page min-w-0">{children}</div>;
}
