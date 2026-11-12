// Frame for every /settings/* page. The menu lives in the shell; pages use the full width (spec 2026-11-12: no max-width).
export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return <>{children}</>;
}
