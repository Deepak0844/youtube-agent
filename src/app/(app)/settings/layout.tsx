// Frame for every /settings/* page. The nav lives in the shell; this only gives settings pages one readable column.
export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return <div className="max-w-4xl">{children}</div>;
}
