// Placeholder mark until the product name is final (Doc 10): the Cut strip in miniature, four stages, the third held.
// Drawn, not a letter in a box and not a play button.
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden focusable="false" className="shrink-0">
      <rect x="0" y="9" width="4" height="4" rx="1" fill="currentColor" />
      <rect x="6" y="9" width="4" height="4" rx="1" fill="currentColor" />
      <rect x="12" y="7" width="4" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="18" y="9" width="4" height="4" rx="1" fill="currentColor" opacity=".45" />
    </svg>
  );
}
