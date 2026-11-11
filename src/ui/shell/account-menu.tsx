"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { CircleUser } from "lucide-react";
import { cn, fade, focusRing } from "../lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../primitives/dropdown-menu";
import { applyTheme, parseTheme, readTheme, type ThemeChoice } from "../theme";

/** Account menu: the Account page, the theme choice and Sign out. `signOut` is the logout server action, passed from the server layout. */
export function AccountMenu({ signOut }: { signOut: () => Promise<void> }) {
  const form = useRef<HTMLFormElement>(null);
  const [theme, setTheme] = useState<ThemeChoice>("system");
  return (
    <>
      <form ref={form} action={signOut} hidden />
      <DropdownMenu onOpenChange={(open) => open && setTheme(readTheme())}>
        <DropdownMenuTrigger
          aria-label="Account"
          className={cn("flex size-11 items-center justify-center rounded-control text-muted hover:text-text md:size-9", fade, focusRing)}
        >
          <CircleUser size={20} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href="/settings/account">Account</Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(v) => {
              const t = parseTheme(v);
              applyTheme(t);
              setTheme(t);
            }}
          >
            <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => form.current?.requestSubmit()}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
